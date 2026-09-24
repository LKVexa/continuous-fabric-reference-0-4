'use strict';
/**
 * RAMWS reservation controller and allocation ledger (kit R09, R11, R14, R16; docs/CONTRACT.md invariants)
 * ---------------------------------------------------------------------------
 * ADAPTATION of A01 Table 8 / Equation 4 to this service. This module stores numbers about memory; it does
 * not move computation into RAM and it does not prove physical residency.
 *
 * Two views are kept apart on purpose (kit docs/MEMORY.md):
 *   physical  — distinct backing allocations this process created and still retains (pool slabs, independent
 *               buffers). Each is charged exactly once, whether idle in a pool or leased.
 *   quota     — what a session / tenant / the whole service has RESERVED. A slice of a shared slab is charged
 *               to a session's quota without adding physical bytes; an alias (view) adds a reference, not capacity.
 *
 * Admission order (Budget invariant): session -> tenant -> global are checked together and committed together;
 * a refusal changes nothing and reports which scope refused. JavaScript runs this synchronously on one thread,
 * which is the linearization point; no await may be inserted between check and commit.
 *
 * Lease lifecycle (Lifetime invariant):  RESERVED -> ACTIVE -> DRAINING -> RELEASED
 *   retain()/release() count local consumers; capacity returns only when the LAST consumer completes.
 *   A cancellation or timeout never releases by itself: the owner must still call release() once I/O settled.
 *   release() after RELEASED is a counted violation (never a second refund). A handle carries its generation;
 *   resolving a stale generation is refused (Validity invariant).
 */

const BUCKETS = Object.freeze(['receive', 'reassembly', 'queued_out', 'inflight_out', 'bridge', 'vfs', 'history', 'workspace', 'metadata', 'codec', 'worker_runtime']);

class BudgetError extends Error {
  constructor(scope, detail) { super(`budget refused at ${scope}: ${detail}`); this.name = 'BudgetError'; this.code = 'EBUDGET'; this.scope = scope; }
}
class LeaseError extends Error { constructor(code, m) { super(m); this.name = 'LeaseError'; this.code = code; } }

let ALLOC_SEQ = 0;

class Lease {
  constructor(account, bucket, capacity, owner, physical) {
    this.allocationId = `a${++ALLOC_SEQ}`;
    this.generation = account.ledger._nextGeneration();
    this.account = account; this.bucket = bucket; this.capacity = capacity; this.used = 0;
    this.owner = owner; this.physical = physical; this.refs = 1; this.state = 'RESERVED'; this.createdAt = Date.now();
  }
  get handle() { return `${this.allocationId}:${this.generation}`; }
  activate(used) { if (this.state === 'RELEASED') throw new LeaseError('ESTALE', 'lease already released'); if (used !== undefined) this.setUsed(used); this.state = 'ACTIVE'; return this; }
  setUsed(n) { if (!Number.isSafeInteger(n) || n < 0 || n > this.capacity) throw new LeaseError('EEXTENT', `used ${n} outside capacity ${this.capacity}`); this.used = n; return this; }
  /** Another local consumer (a queued view, an in-flight write) now depends on this backing storage. */
  retain() { if (this.state === 'RELEASED') throw new LeaseError('ESTALE', 'retain after release'); this.refs++; return this; }
  draining() { if (this.state !== 'RELEASED') this.state = 'DRAINING'; return this; }
  /** One consumer completed. @returns true when this was the last consumer and capacity was returned. */
  release() {
    if (this.state === 'RELEASED') { this.account.ledger.violations.duplicateRelease++; return false; }
    if (--this.refs > 0) return false;
    this.state = 'RELEASED';
    this.account._return(this);
    return true;
  }
}

class SessionAccount {
  constructor(ledger, key, tenantKey, limitBytes, bucketCaps) {
    this.ledger = ledger; this.key = key; this.tenantKey = tenantKey; this.limit = limitBytes;
    this.caps = bucketCaps; this.reserved = 0; this.byBucket = Object.create(null); this.leases = new Map();
    this.highWater = 0; this.closed = false; this.rejects = 0;
    for (const b of BUCKETS) this.byBucket[b] = 0;
  }
  /**
   * Reserve capacity BEFORE acquiring memory. Throws BudgetError with the refusing scope; on refusal nothing changed.
   * @param {string} bucket  one of BUCKETS
   * @param {number} capacity actual backing capacity in bytes (not the logical length)
   * @param {string} owner   responsible subsystem: transport | runtime | terminal
   * @param {boolean} physical true when this lease is itself a distinct backing allocation made for it
   */
  acquire(bucket, capacity, owner, physical = true) {
    const L = this.ledger;
    if (this.closed) { this.rejects++; L.rejects.closed++; throw new BudgetError('session', 'account closed'); }
    if (!BUCKETS.includes(bucket)) throw new LeaseError('EBUCKET', `unknown bucket ${bucket}`);
    if (!Number.isSafeInteger(capacity) || capacity < 0) throw new LeaseError('EEXTENT', 'capacity must be a non-negative safe integer');
    const cap = this.caps[bucket];
    // check all scopes first ...
    if (cap !== undefined && this.byBucket[bucket] + capacity > cap) { this.rejects++; L.rejects.bucket++; throw new BudgetError(`session.${bucket}`, `${this.byBucket[bucket]} + ${capacity} > ${cap}`); }
    if (this.reserved + capacity > this.limit) { this.rejects++; L.rejects.session++; throw new BudgetError('session', `${this.reserved} + ${capacity} > ${this.limit}`); }
    // ... tenant and global were charged for the WHOLE session reservation at admission, so an in-limit lease cannot exceed them.
    const lease = new Lease(this, bucket, capacity, owner, physical);
    this.reserved += capacity; this.byBucket[bucket] += capacity; this.leases.set(lease.allocationId, lease);
    if (this.reserved > this.highWater) this.highWater = this.reserved;
    if (physical) L._physical(capacity);
    L.counters.acquired++;
    return lease;
  }
  /** Capacity reservation that is enforced elsewhere (e.g. a worker's own quota): charged, never backed by a buffer here. */
  reserveCapacity(bucket, capacity, owner) { return this.acquire(bucket, capacity, owner, false).activate(0); }
  resolve(handle) {
    const [id, gen] = String(handle).split(':');
    const l = this.leases.get(id);
    if (!l || String(l.generation) !== gen || l.state === 'RELEASED') { this.ledger.violations.staleHandle++; throw new LeaseError('ESTALE', 'stale or foreign lease handle'); }
    return l;
  }
  _return(lease) {
    this.reserved -= lease.capacity; this.byBucket[lease.bucket] -= lease.capacity; this.leases.delete(lease.allocationId);
    if (lease.physical) this.ledger._physical(-lease.capacity);
    this.ledger.counters.released++;
    if (this.closed && this.leases.size === 0) this.ledger._finishClose(this);
  }
  /**
   * Close: no new leases. The session's admission reservation is returned only when every lease has completed
   * (in-flight I/O keeps its memory until it settles). @returns number of leases still outstanding.
   */
  close() {
    if (this.closed) return this.leases.size;
    this.closed = true;
    for (const l of this.leases.values()) l.draining();
    if (this.leases.size === 0) this.ledger._finishClose(this);
    return this.leases.size;
  }
  snapshot() { return { reserved: this.reserved, limit: this.limit, highWater: this.highWater, leases: this.leases.size, rejects: this.rejects, byBucket: { ...this.byBucket } }; }
}

class Ledger {
  /**
   * @param {object} o
   * @param {number} o.globalBytes  allowance for all session reservations together (L - F - G - H, see ram/allowance.js)
   * @param {number} o.tenantBytes  allowance per tenant
   */
  constructor({ globalBytes, tenantBytes }) {
    this.globalLimit = globalBytes; this.tenantLimit = tenantBytes;
    this.globalReserved = 0; this.globalHighWater = 0; this.tenants = new Map(); this.sessions = new Map();
    this.physicalBytes = 0; this.physicalHighWater = 0; this.gen = 0;
    this.counters = { admitted: 0, closed: 0, acquired: 0, released: 0 };
    this.rejects = { global: 0, tenant: 0, session: 0, bucket: 0, closed: 0 };
    this.violations = { duplicateRelease: 0, staleHandle: 0, closeWithLiveLeases: 0 };
  }
  _nextGeneration() { if (this.gen >= Number.MAX_SAFE_INTEGER - 1) throw new LeaseError('EGEN', 'generation space exhausted: restart required'); return ++this.gen; }
  _physical(delta) { this.physicalBytes += delta; if (this.physicalBytes > this.physicalHighWater) this.physicalHighWater = this.physicalBytes; }

  /** Admit a session: its WHOLE reservation is charged to tenant and global now, atomically, or nothing is. */
  admit(sessionKey, tenantKey, reservationBytes, bucketCaps = {}) {
    if (this.sessions.has(sessionKey)) throw new LeaseError('EEXIST', 'session already admitted');
    if (!Number.isSafeInteger(reservationBytes) || reservationBytes <= 0) throw new LeaseError('EEXTENT', 'reservation must be a positive safe integer');
    const t = this.tenants.get(tenantKey) || 0;
    if (t + reservationBytes > this.tenantLimit) { this.rejects.tenant++; throw new BudgetError('tenant', `${t} + ${reservationBytes} > ${this.tenantLimit}`); }
    if (this.globalReserved + reservationBytes > this.globalLimit) { this.rejects.global++; throw new BudgetError('global', `${this.globalReserved} + ${reservationBytes} > ${this.globalLimit}`); }
    this.tenants.set(tenantKey, t + reservationBytes);
    this.globalReserved += reservationBytes; if (this.globalReserved > this.globalHighWater) this.globalHighWater = this.globalReserved;
    const acct = new SessionAccount(this, sessionKey, tenantKey, reservationBytes, bucketCaps);
    this.sessions.set(sessionKey, acct); this.counters.admitted++;
    return acct;
  }
  _finishClose(acct) {
    if (!this.sessions.has(acct.key)) return;                       // exactly once
    this.sessions.delete(acct.key);
    const t = (this.tenants.get(acct.tenantKey) || 0) - acct.limit;
    if (t > 0) this.tenants.set(acct.tenantKey, t); else this.tenants.delete(acct.tenantKey);
    this.globalReserved -= acct.limit; this.counters.closed++;
  }
  /** Reconciliation (kit R14 oracle): recompute every total from the leaf leases and compare with the running counters. */
  reconcile() {
    let sumSessions = 0, sumPhysical = 0; const perTenant = new Map(); const errors = [];
    for (const a of this.sessions.values()) {
      let s = 0; const by = Object.create(null);
      for (const l of a.leases.values()) { s += l.capacity; by[l.bucket] = (by[l.bucket] || 0) + l.capacity; if (l.physical) sumPhysical += l.capacity; if (l.used > l.capacity) errors.push(`${l.handle}: used > capacity`); }
      if (s !== a.reserved) errors.push(`${a.key}: leases ${s} != reserved ${a.reserved}`);
      for (const b of BUCKETS) if ((by[b] || 0) !== a.byBucket[b]) errors.push(`${a.key}.${b}: ${by[b] || 0} != ${a.byBucket[b]}`);
      if (a.reserved > a.limit) errors.push(`${a.key}: over limit`);
      sumSessions += a.limit; perTenant.set(a.tenantKey, (perTenant.get(a.tenantKey) || 0) + a.limit);
    }
    if (sumSessions !== this.globalReserved) errors.push(`global ${this.globalReserved} != sum of session reservations ${sumSessions}`);
    for (const [k, v] of this.tenants) if ((perTenant.get(k) || 0) !== v) errors.push(`tenant ${k}: ${v} != ${perTenant.get(k) || 0}`);
    if (this.globalReserved > this.globalLimit) errors.push('global over limit');
    return { ok: errors.length === 0, errors, sumPhysicalLeased: sumPhysical };
  }
  snapshot() {
    return { globalLimit: this.globalLimit, globalReserved: this.globalReserved, globalHighWater: this.globalHighWater, tenantLimit: this.tenantLimit, tenants: this.tenants.size, sessions: this.sessions.size,
      physicalBytes: this.physicalBytes, physicalHighWater: this.physicalHighWater, counters: { ...this.counters }, rejects: { ...this.rejects }, violations: { ...this.violations } };
  }
}

/**
 * Bounded slab pool (kit R09). Size classes are fixed; idle retained capacity is capped and VISIBLE; a rent that
 * cannot be served from the pool allocates exactly the class size (never more than the largest class) and is
 * charged physically by the caller's lease. Returned buffers are zero-filled over their used range before reuse
 * so one tenant's bytes are never handed to another (this does not erase copies the runtime or OS made).
 */
class SlabPool {
  constructor({ classes = [4096, 16384, 65536], maxIdleBytes = 1048576 } = {}) {
    this.classes = classes.slice().sort((a, b) => a - b); this.maxIdleBytes = maxIdleBytes;
    this.idle = new Map(this.classes.map((c) => [c, []])); this.idleBytes = 0;
    this.stats = { rents: 0, hits: 0, allocs: 0, returns: 0, dropped: 0, oversize: 0, foreignReturn: 0, doubleReturn: 0 };
    this.out = new WeakSet();
  }
  classFor(min) { for (const c of this.classes) if (c >= min) return c; return 0; }
  /** @returns {Buffer|null} buffer whose length is the ACTUAL capacity (>= min), or null when min exceeds the largest class */
  rent(min) {
    this.stats.rents++;
    const c = this.classFor(min);
    if (!c) { this.stats.oversize++; return null; }
    const list = this.idle.get(c);
    let buf;
    if (list.length) { buf = list.pop(); this.idleBytes -= c; this.stats.hits++; } else { buf = Buffer.alloc(c); this.stats.allocs++; }
    this.out.add(buf);
    return buf;
  }
  /** Return exactly once, only after the last consumer completed. */
  giveBack(buf, used) {
    if (!this.out.has(buf)) { if (this.classes.includes(buf.length)) this.stats.doubleReturn++; else this.stats.foreignReturn++; return false; }
    this.out.delete(buf); this.stats.returns++;
    buf.fill(0, 0, Math.min(buf.length, used === undefined ? buf.length : used));
    if (this.idleBytes + buf.length > this.maxIdleBytes) { this.stats.dropped++; return true; } // let the GC have it: idle retention stays capped
    this.idle.get(buf.length).push(buf); this.idleBytes += buf.length;
    return true;
  }
  snapshot() { return { idleBytes: this.idleBytes, maxIdleBytes: this.maxIdleBytes, classes: this.classes, ...this.stats }; }
}

module.exports = { Ledger, SessionAccount, Lease, SlabPool, BudgetError, LeaseError, BUCKETS };
