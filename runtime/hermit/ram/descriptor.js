'use strict';
/**
 * RAMWS operation descriptors and admission (kit R03, R21; docs/CONTRACT.md) — ADAPTATION of A01 Table 8 / Fig. 18.
 * ---------------------------------------------------------------------------
 * Eight fields: Operator, Buffers, Formats, Budget, Ownership, Completion, Quality, Backend.
 * Descriptors are INTERNAL. They are built by the server from authenticated connection state; no field is ever
 * taken from a client, and no descriptor is ever serialized to a client.
 *
 *   submit -> validate -> plan -> reserve/admit -> execute -> complete -> release
 *   CREATED -> VALIDATED -> RESERVED -> ACTIVE -> DRAINING -> COMPLETED -> RELEASED      (REJECTED / FAILED are terminal)
 *
 * validate() = the kit's schema (ram/descriptor.schema.json, byte-identical) + its three arithmetic relations,
 * plus what only a runtime can check: every Buffers handle resolves in the OWNER's account at the stated
 * generation, extents fit the live lease, the Ownership triple equals the authenticated connection's, and the
 * Backend plan identity equals the current one (Validity). Integers are limited to the JS safe range here; the
 * schema's 2^63-1 maximum is not representable exactly in this runtime and is therefore refused, not rounded.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { LeaseError } = require('./ledger');

const SCHEMA = JSON.parse(fs.readFileSync(path.join(__dirname, 'descriptor.schema.json'), 'utf8'));
const KEYWORDS = new Set(['$schema', '$id', 'title', 'description', 'type', 'properties', 'required', 'additionalProperties', 'items', 'minItems', 'maxItems', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'const', 'enum']);

class DescriptorError extends Error { constructor(code, m) { super(m); this.name = 'DescriptorError'; this.code = code; } }

function check(v, s, where) {
  for (const k of Object.keys(s)) if (!KEYWORDS.has(k)) throw new DescriptorError('ESCHEMA', `${where}: unsupported keyword ${k}`);
  const t = s.type;
  const ok = t === 'object' ? (v !== null && typeof v === 'object' && !Array.isArray(v)) : t === 'array' ? Array.isArray(v) : t === 'string' ? typeof v === 'string'
    : t === 'integer' ? (typeof v === 'number' && Number.isSafeInteger(v)) : t === 'boolean' ? typeof v === 'boolean' : false;
  if (!ok) throw new DescriptorError('ETYPE', `${where}: expected ${t}`);
  if ('const' in s && v !== s.const) throw new DescriptorError('ECONST', `${where}: wrong constant`);
  if (s.enum && !s.enum.includes(v)) throw new DescriptorError('EENUM', `${where}: outside enum`);
  if (t === 'object') {
    const props = s.properties || {};
    for (const r of s.required || []) if (!Object.prototype.hasOwnProperty.call(v, r)) throw new DescriptorError('EMISSING', `${where}.${r}: required`);
    for (const k of Object.keys(v)) { if (!Object.prototype.hasOwnProperty.call(props, k)) { if (s.additionalProperties === false) throw new DescriptorError('EUNKNOWN', `${where}.${k}: unknown field`); } else check(v[k], props[k], `${where}.${k}`); }
  } else if (t === 'array') {
    if (v.length < (s.minItems || 0) || (s.maxItems !== undefined && v.length > s.maxItems)) throw new DescriptorError('ECOUNT', `${where}: item count`);
    v.forEach((x, i) => check(x, s.items, `${where}[${i}]`));
  } else if (t === 'string') {
    if (v.length < (s.minLength || 0) || (s.maxLength !== undefined && v.length > s.maxLength)) throw new DescriptorError('ELENGTH', `${where}: string length`);
  } else if (t === 'integer') {
    if ((s.minimum !== undefined && v < s.minimum) || (s.maximum !== undefined && v > s.maximum)) throw new DescriptorError('ERANGE', `${where}: integer range`);
  }
}

/** Structural + arithmetic validation (parity with the kit's tools/contracts.py, stricter on integer width). */
function validateShape(d) {
  check(d, SCHEMA, '$');
  for (const b of d.Buffers) if (b.offset > b.capacity || b.length > b.capacity - b.offset) throw new DescriptorError('EEXTENT', 'buffer extent is outside declared capacity');
  if (d.Budget.reservation_bytes > d.Budget.session_limit_bytes) throw new DescriptorError('EBUDGET', 'reservation exceeds declared session limit');
  if (d.Ownership.mutability === 'immutable' && d.Buffers.some((x) => x.access === 'write')) throw new DescriptorError('EMUT', 'immutable ownership conflicts with write buffer');
  return d;
}

/**
 * Plan identity (Validity invariant): a digest over everything a cached decision depends on. Any change of code
 * version, protocol, schema, policy generation, worker backend or server epoch produces a different id, which
 * invalidates stale plans and handles without waiting for a cache to expire.
 */
function planIdentity(parts) {
  const keys = ['codeVersion', 'protocol', 'descriptorSchemaSha256', 'policyGeneration', 'backend', 'serverEpoch', 'profile'];
  for (const k of keys) if (parts[k] === undefined || parts[k] === null || parts[k] === '') throw new DescriptorError('EPLAN', `plan identity part missing: ${k}`);
  return 'plan-' + crypto.createHash('sha256').update(keys.map((k) => `${k}=${parts[k]}`).join('\n')).digest('hex').slice(0, 32);
}
const SCHEMA_SHA256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, 'descriptor.schema.json'))).digest('hex');

// Small immutable dispatch table (kit R19): operator kind -> which connection states admit it and who owns the buffers.
const OPERATORS = Object.freeze({
  receive: Object.freeze({ states: ['AUTHENTICATED', 'OPENING', 'ACTIVE', 'DRAINING'], owner: 'transport', payload: ['utf-8', 'binary'] }),
  send: Object.freeze({ states: ['AUTHENTICATED', 'OPENING', 'ACTIVE', 'DRAINING'], owner: 'transport', payload: ['utf-8', 'binary'] }),
  input: Object.freeze({ states: ['ACTIVE'], owner: 'terminal', payload: ['binary'] }),
  output: Object.freeze({ states: ['ACTIVE', 'DRAINING'], owner: 'terminal', payload: ['binary'] }),
  resize: Object.freeze({ states: ['ACTIVE'], owner: 'terminal', payload: ['none'] }),
  signal: Object.freeze({ states: ['ACTIVE'], owner: 'terminal', payload: ['none'] }),
  close: Object.freeze({ states: ['AUTHENTICATED', 'OPENING', 'ACTIVE', 'DRAINING'], owner: 'runtime', payload: ['none'] })
});

const TRUSTED_SHAPE = Symbol('ramws.trustedShape');
function markTrusted(d) { Object.defineProperty(d, TRUSTED_SHAPE, { value: true, enumerable: false }); return d; }

const ORDER = ['CREATED', 'VALIDATED', 'RESERVED', 'ACTIVE', 'DRAINING', 'COMPLETED', 'RELEASED'];

class Operation {
  constructor(descriptor, leases) { this.descriptor = descriptor; this.leases = leases; this.state = 'CREATED'; this.reason = null; }
  _to(next) { const i = ORDER.indexOf(this.state), j = ORDER.indexOf(next); if (i < 0 || j !== i + 1) throw new DescriptorError('ESTATE', `illegal transition ${this.state} -> ${next}`); this.state = next; return this; }
  fail(reason) { if (this.state !== 'RELEASED' && this.state !== 'REJECTED') { this.state = 'FAILED'; this.reason = reason; } return this; }
}

/**
 * Admission controller bound to ONE authenticated connection.
 * ctx = { principalId, sessionId, serverEpoch, account (SessionAccount), planId, profile, runtimeId, getState() }
 */
function createAdmission(ctx) {
  const stats = { admitted: 0, rejected: 0, byReason: Object.create(null) };
  function reject(op, code, msg) { op.state = 'REJECTED'; op.reason = `${code}: ${msg}`; stats.rejected++; stats.byReason[code] = (stats.byReason[code] || 0) + 1; return op; }

  /** Build the descriptor from server state (never from the peer) for leases the server already holds.
   *  Marked TRUSTED_SHAPE: its structure is fixed by this function, so admit() skips the structural schema walk
   *  (measured at ~13% of per-keystroke server CPU with the process backend, kit R28 ablation) and performs only
   *  the runtime checks a schema cannot do. Anything not built here is validated in full. */
  function describe(kind, payload, leases, mutability = 'immutable') {
    return markTrusted({
      Operator: { kind, schema_version: 'ramws.internal.v1' },
      Buffers: leases.map((l) => ({ handle: l.handle, generation: l.generation, offset: 0, length: l.used, capacity: l.capacity, access: mutability === 'immutable' ? 'read' : 'write' })),
      Formats: { payload, wire_schema: 'ramws.v1', lossless: true },
      Budget: { scope: 'session', reservation_bytes: leases.reduce((a, l) => a + l.capacity, 0), session_limit_bytes: ctx.account.limit },
      Ownership: { principal_id: ctx.principalId, session_id: ctx.sessionId, server_epoch: ctx.serverEpoch, owner: OPERATORS[kind] ? OPERATORS[kind].owner : 'runtime', mutability },
      Completion: { fence_handle: `fence-${leases.map((l) => l.allocationId).join('+') || 'none'}`, release_policy: 'last_local_consumer_complete' },
      Quality: { payload_fidelity: 'exact', ordered: true, oracle: 'protocol+terminal-reference-v1' },
      Backend: { profile: ctx.profile, executor: 'cpu', runtime_id: ctx.runtimeId, plan_id: ctx.planId() }
    });
  }

  /** validate -> reserve/admit. Returns an Operation in RESERVED, or REJECTED with an explicit reason. Never throws for peer-caused conditions. */
  function admit(descriptor) {
    const op = new Operation(descriptor, []);
    if (!descriptor[TRUSTED_SHAPE]) { try { validateShape(descriptor); } catch (e) { return reject(op, e.code || 'ESHAPE', e.message); } }
    else if (descriptor.Budget.reservation_bytes > descriptor.Budget.session_limit_bytes) return reject(op, 'EBUDGET', 'reservation exceeds declared session limit');
    const d = descriptor, spec = OPERATORS[d.Operator.kind];
    if (!spec.states.includes(ctx.getState())) return reject(op, 'ESTATE', `${d.Operator.kind} not admitted in state ${ctx.getState()}`);
    if (!spec.payload.includes(d.Formats.payload)) return reject(op, 'EFORMAT', `${d.Operator.kind} does not carry ${d.Formats.payload}`);
    if (d.Ownership.principal_id !== ctx.principalId || d.Ownership.session_id !== ctx.sessionId) return reject(op, 'EOWNER', 'descriptor is bound to another principal/session');
    if (d.Ownership.server_epoch !== ctx.serverEpoch) return reject(op, 'EEPOCH', 'stale server epoch');
    if (d.Backend.plan_id !== ctx.planId()) return reject(op, 'EPLAN', 'stale plan identity');
    if (d.Budget.session_limit_bytes !== ctx.account.limit) return reject(op, 'EBUDGET', 'declared session limit differs from the admitted account');
    let total = 0; const leases = [];
    for (const b of d.Buffers) {
      let l; try { l = ctx.account.resolve(b.handle); } catch (e) { return reject(op, e.code || 'ESTALE', e.message); }
      if (l.generation !== b.generation) return reject(op, 'ESTALE', 'generation mismatch');
      if (b.capacity !== l.capacity || b.offset + b.length > l.used) return reject(op, 'EEXTENT', 'extent outside the live lease');
      total += l.capacity; leases.push(l);
    }
    if (total !== d.Budget.reservation_bytes) return reject(op, 'EBUDGET', 'reservation does not equal the capacity of the named leases');
    op.state = 'VALIDATED'; op.leases = leases; op._to('RESERVED'); stats.admitted++;
    return op;
  }
  const execute = (op) => op._to('ACTIVE');
  const drain = (op) => op._to('DRAINING');
  /** complete -> release: each lease loses exactly the one reference this operation held. */
  function complete(op) { if (op.state === 'ACTIVE') op._to('DRAINING'); op._to('COMPLETED'); for (const l of op.leases) l.release(); return op._to('RELEASED'); }
  return { describe, admit, execute, drain, complete, stats };
}

module.exports = { validateShape, planIdentity, createAdmission, Operation, OPERATORS, DescriptorError, SCHEMA_SHA256, LeaseError, TRUSTED_SHAPE };
