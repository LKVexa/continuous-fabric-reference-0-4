'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Ledger, SlabPool, BudgetError, LeaseError } = require('../../ram/ledger');
const MiB = 1048576;

test('admission is all-or-nothing across session/tenant/global and names the refusing scope', () => {
  const L = new Ledger({ globalBytes: 5 * MiB, tenantBytes: 4 * MiB });
  L.admit('s1', 'acme', 2 * MiB); L.admit('s2', 'acme', 2 * MiB);
  assert.throws(() => L.admit('s3', 'acme', 1), (e) => e instanceof BudgetError && e.scope === 'tenant');
  assert.throws(() => L.admit('s4', 'globex', 2 * MiB), (e) => e.scope === 'global');
  const before = JSON.stringify(L.snapshot());
  assert.throws(() => L.admit('s5', 'globex', 9 * MiB)); assert.strictEqual(JSON.stringify({ ...L.snapshot(), rejects: undefined }), JSON.stringify({ ...JSON.parse(before), rejects: undefined }), 'a refusal reserves nothing');
  L.admit('s6', 'globex', 1 * MiB); assert.strictEqual(L.globalReserved, 5 * MiB); assert.ok(L.reconcile().ok);
});
test('leases: capacity (not logical length) is charged; bucket, session caps; exhaustion and oversize are refused before allocation', () => {
  const L = new Ledger({ globalBytes: 8 * MiB, tenantBytes: 8 * MiB }); const a = L.admit('s', 't', 1 * MiB, { reassembly: 256 * 1024 });
  const l = a.acquire('reassembly', 65536, 'transport').activate(10); assert.strictEqual(a.reserved, 65536); assert.strictEqual(l.used, 10);
  assert.throws(() => l.setUsed(65537), (e) => e.code === 'EEXTENT');
  assert.throws(() => a.acquire('reassembly', 256 * 1024, 'transport'), (e) => e.scope === 'session.reassembly');
  assert.throws(() => a.acquire('queued_out', 2 * MiB, 'transport'), (e) => e.scope === 'session');
  assert.throws(() => a.acquire('nope', 1, 'x'), LeaseError); assert.throws(() => a.acquire('vfs', -1, 'x'), LeaseError); assert.throws(() => a.acquire('vfs', 2 ** 60, 'x'), LeaseError);
  assert.strictEqual(L.physicalBytes, 65536); assert.strictEqual(a.rejects, 2); assert.ok(L.reconcile().ok);
});
test('Lifetime: capacity returns only after the LAST consumer; duplicate release is counted, never refunded twice', () => {
  const L = new Ledger({ globalBytes: MiB, tenantBytes: MiB }); const a = L.admit('s', 't', MiB);
  const l = a.acquire('inflight_out', 1000, 'transport').activate(1000); l.retain(); l.retain();
  assert.strictEqual(l.release(), false); assert.strictEqual(l.release(), false); assert.strictEqual(a.reserved, 1000);
  assert.strictEqual(l.release(), true); assert.strictEqual(a.reserved, 0); assert.strictEqual(L.physicalBytes, 0);
  assert.strictEqual(l.release(), false); assert.strictEqual(a.reserved, 0); assert.strictEqual(L.violations.duplicateRelease, 1);
  assert.throws(() => l.retain(), (e) => e.code === 'ESTALE');
});
test('Aliasing: a view adds a reference, not capacity; a non-physical capacity reservation adds quota but no physical bytes', () => {
  const L = new Ledger({ globalBytes: MiB, tenantBytes: MiB }); const a = L.admit('s', 't', MiB);
  const l = a.acquire('queued_out', 4096, 'transport'); l.retain(); assert.strictEqual(a.reserved, 4096); assert.strictEqual(L.physicalBytes, 4096);
  a.reserveCapacity('vfs', 65536, 'terminal'); assert.strictEqual(a.reserved, 4096 + 65536); assert.strictEqual(L.physicalBytes, 4096);
});
test('Validity: stale generation and foreign handles are refused and counted', () => {
  const L = new Ledger({ globalBytes: MiB, tenantBytes: MiB }); const a = L.admit('s', 't', MiB / 2), b = L.admit('s2', 't', MiB / 2);
  const l = a.acquire('receive', 100, 'transport'); const h = l.handle; assert.strictEqual(a.resolve(h), l);
  assert.throws(() => b.resolve(h), (e) => e.code === 'ESTALE'); assert.throws(() => a.resolve(`${l.allocationId}:${l.generation + 1}`), (e) => e.code === 'ESTALE');
  l.release(); assert.throws(() => a.resolve(h), (e) => e.code === 'ESTALE'); assert.strictEqual(L.violations.staleHandle, 3);
});
test('close: refuses new leases at once, returns the admission reservation exactly once and only after in-flight leases settle', () => {
  const L = new Ledger({ globalBytes: MiB, tenantBytes: MiB }); const a = L.admit('s', 't', MiB);
  const inflight = a.acquire('inflight_out', 5000, 'transport').activate(5000);
  assert.strictEqual(a.close(), 1); assert.strictEqual(inflight.state, 'DRAINING'); assert.throws(() => a.acquire('receive', 1, 'transport'), BudgetError);
  assert.strictEqual(L.globalReserved, MiB, 'still charged while I/O is in flight'); assert.throws(() => L.admit('next', 't', MiB), BudgetError);
  inflight.release(); assert.strictEqual(L.globalReserved, 0); a.close(); assert.strictEqual(L.counters.closed, 1);
  L.admit('next', 't', MiB); assert.ok(L.reconcile().ok);
});
test('randomized acquire/retain/release/close never breaks reconciliation and ends at zero', () => {
  const L = new Ledger({ globalBytes: 64 * MiB, tenantBytes: 16 * MiB }); let seed = 99; const rnd = (n) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
  const accts = []; const live = [];
  for (let i = 0; i < 4000; i++) {
    const op = rnd(10);
    try {
      if (op < 2) accts.push(L.admit(`s${i}`, `t${rnd(6)}`, (1 + rnd(4)) * MiB));
      else if (op < 6 && accts.length) live.push(accts[rnd(accts.length)].acquire(['receive', 'reassembly', 'queued_out', 'inflight_out', 'bridge'][rnd(5)], 1 + rnd(300000), 'transport'));
      else if (op < 7 && live.length) live[rnd(live.length)].retain();
      else if (op < 9 && live.length) { const k = rnd(live.length); if (live[k].release()) live.splice(k, 1); }
      else if (accts.length) accts.splice(rnd(accts.length), 1)[0].close();
    } catch (e) { if (!(e instanceof BudgetError) && e.code !== 'ESTALE') throw e; }
    if (i % 200 === 0) { const r = L.reconcile(); assert.ok(r.ok, r.errors.join('; ')); }
  }
  for (const a of accts) a.close(); for (const l of live) while (l.state !== 'RELEASED') l.release();
  assert.ok(L.reconcile().ok); assert.strictEqual(L.globalReserved, 0); assert.strictEqual(L.physicalBytes, 0); assert.strictEqual(L.sessions.size, 0); assert.strictEqual(L.tenants.size, 0);
});
test('slab pool: actual capacity >= request, idle retention capped and visible, zero-fill on return, double/foreign return counted, oversize refused', () => {
  const p = new SlabPool({ classes: [4096, 16384], maxIdleBytes: 16384 });
  const b = p.rent(5000); assert.strictEqual(b.length, 16384); b.write('TENANT-A-SECRET'); assert.strictEqual(p.rent(16385), null);
  assert.strictEqual(p.giveBack(b, 32), true); assert.strictEqual(p.idleBytes, 16384);
  const again = p.rent(100 + 4096); assert.strictEqual(again, b); assert.ok(again.subarray(0, 32).every((x) => x === 0), 'previous tenant bytes are gone');
  assert.strictEqual(p.giveBack(b), true); assert.strictEqual(p.giveBack(b), false); assert.strictEqual(p.stats.doubleReturn, 1);
  assert.strictEqual(p.giveBack(Buffer.alloc(10)), false); assert.strictEqual(p.stats.foreignReturn, 1);
  const c = p.rent(1), d = p.rent(1); p.giveBack(c); p.giveBack(d); assert.ok(p.idleBytes <= 16384); const s = p.snapshot(); assert.ok(s.idleBytes <= s.maxIdleBytes);
});
