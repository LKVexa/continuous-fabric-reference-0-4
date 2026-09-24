'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { strictParse } = require('../../protocol/codec');
const { Ledger } = require('../../ram/ledger');
const D = require('../../ram/descriptor');

test('kit fixtures: all 13 descriptor cases give the verdict the kit expects (parsed strictly, so 2^63 is refused rather than rounded)', () => {
  const raw = fs.readFileSync(path.join(__dirname, '../vectors/ramws/cases.json'), 'utf8');
  const names = [...raw.matchAll(/"name":\s*"([a-z_]+)"/g)].map((m) => m[1]); assert.strictEqual(names.length, 13);
  // cases.json contains an integer beyond the safe range on purpose; evaluate each case from its own text span.
  const cases = JSON.parse(raw.replace(/9223372036854775808/g, '"__OVERSIZED__"'));
  for (const c of cases) {
    const text = JSON.stringify(c.descriptor).replace(/"__OVERSIZED__"/g, '9223372036854775808');
    let ok = true; try { D.validateShape(strictParse(text)); } catch { ok = false; } // integers must be safe integers in this runtime
    assert.strictEqual(ok, c.expected_valid, c.name);
  }
});

function ctxFor(L, key = 's1', principal = 'acme/alice') {
  const account = L.admit(key, 'acme', 1 << 20); let state = 'ACTIVE'; let policy = 1;
  const ctx = { principalId: principal, sessionId: key, serverEpoch: 'epoch-A', account, profile: 'LOCAL_VOLATILE', runtimeId: 'node-test', getState: () => state,
    planId: () => D.planIdentity({ codeVersion: '2.0.0', protocol: 'hermit.vws.v2', descriptorSchemaSha256: D.SCHEMA_SHA256, policyGeneration: policy, backend: 'thread', serverEpoch: 'epoch-A', profile: 'LOCAL_VOLATILE' }) };
  return { ctx, account, setState: (s) => { state = s; }, bumpPolicy: () => { policy++; } };
}

test('lifecycle: admit -> execute -> complete releases the lease exactly once; illegal transitions throw', () => {
  const L = new Ledger({ globalBytes: 1 << 22, tenantBytes: 1 << 22 }); const { ctx, account } = ctxFor(L); const A = D.createAdmission(ctx);
  const lease = account.acquire('queued_out', 4096, 'transport').activate(100);
  const op = A.admit(A.describe('output', 'binary', [lease])); assert.strictEqual(op.state, 'RESERVED');
  assert.throws(() => A.complete(op), /illegal transition/);
  A.execute(op); A.complete(op); assert.strictEqual(op.state, 'RELEASED'); assert.strictEqual(account.reserved, 0); assert.strictEqual(lease.state, 'RELEASED');
  assert.throws(() => A.execute(op), /illegal transition/); assert.strictEqual(L.violations.duplicateRelease, 0);
});
test('Ownership/Validity: another principal, another session, stale epoch, stale plan (policy revoked), stale or foreign lease are all REJECTED with a reason', () => {
  const L = new Ledger({ globalBytes: 1 << 22, tenantBytes: 1 << 22 }); const a = ctxFor(L, 's1'), b = ctxFor(L, 's2', 'acme/bob'); const A = D.createAdmission(a.ctx), B = D.createAdmission(b.ctx);
  const la = a.account.acquire('queued_out', 1024, 'transport').activate(10);
  const good = A.describe('output', 'binary', [la]);
  assert.match(B.admit(good).reason, /EOWNER/, 'a descriptor built for alice is refused on bob\'s connection');
  const forged = B.describe('output', 'binary', []); forged.Buffers = good.Buffers; forged.Budget.reservation_bytes = 1024; assert.match(B.admit(forged).reason, /ESTALE/, 'bob cannot name alice\'s lease');
  assert.match(A.admit({ ...good, Ownership: { ...good.Ownership, server_epoch: 'epoch-OLD' } }).reason, /EEPOCH/);
  a.bumpPolicy(); assert.match(A.admit(good).reason, /EPLAN/, 'a policy change invalidates cached plans immediately');
  const fresh = A.describe('output', 'binary', [la]); assert.strictEqual(A.admit(fresh).state, 'RESERVED');
  la.release(); assert.match(A.admit(A.describe('output', 'binary', [])).state, /RESERVED/); assert.match(A.admit(fresh).reason, /ESTALE/);
});
test('state gating and formats: input only while ACTIVE; resize carries no payload; extents must lie inside the live lease; budget must equal lease capacity', () => {
  const L = new Ledger({ globalBytes: 1 << 22, tenantBytes: 1 << 22 }); const s = ctxFor(L); const A = D.createAdmission(s.ctx);
  const l = s.account.acquire('receive', 8192, 'transport').activate(50);
  s.setState('OPENING'); assert.match(A.admit(A.describe('input', 'binary', [l])).reason, /ESTATE/); s.setState('ACTIVE');
  assert.match(A.admit(A.describe('resize', 'binary', [])).reason, /EFORMAT/);
  const d = A.describe('input', 'binary', [l]); d.Buffers[0].length = 51; assert.match(A.admit(d).reason, /EEXTENT/);
  const e = A.describe('input', 'binary', [l]); e.Budget.reservation_bytes = 1; assert.match(A.admit(e).reason, /EBUDGET/);
  const r = JSON.parse(JSON.stringify(A.describe('input', 'binary', [l]))); r.Backend.executor = 'dram_cells'; assert.match(A.admit(r).reason, /ECONST/, 'RAM is never an executor (a descriptor not built by describe() gets the full structural check)');
  const t = A.describe('input', 'binary', [l]); t.Budget.reservation_bytes = t.Budget.session_limit_bytes + 1; assert.match(A.admit(t).reason, /EBUDGET/, 'trusted-shape descriptors still get the arithmetic checks');
  assert.ok(A.stats.rejected >= 5);
});
test('plan identity changes with every bound input and refuses missing parts', () => {
  const base = { codeVersion: '2', protocol: 'p', descriptorSchemaSha256: 'x', policyGeneration: 1, backend: 'thread', serverEpoch: 'e', profile: 'LOCAL_VOLATILE' };
  const id = D.planIdentity(base); for (const k of Object.keys(base)) assert.notStrictEqual(D.planIdentity({ ...base, [k]: base[k] + '1' }), id, k);
  assert.throws(() => D.planIdentity({ ...base, serverEpoch: '' }), /missing/);
});
