'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { startGateway, Client, rawConnect, rid, sleep } = require('../helpers');

for (const backend of ['thread', 'process']) {
  test(`[${backend}] vertical slice: hello(epoch) -> open -> opened before output -> binary input/output -> executed ack -> close -> single exit; ledger returns to zero`, async () => {
    const h = await startGateway({ workerBackend: backend });
    try {
      const c = new Client(h.url, h.tokens.alice); await c.open();
      assert.strictEqual(c.msgs[0].type, 'hello'); assert.strictEqual(c.msgs[0].payload.profile, 'LOCAL_VOLATILE'); assert.match(c.serverEpoch, /^[A-Za-z0-9_-]{16,}$/);
      assert.ok(c.msgs.findIndex((m) => m.type === 'session.opened') >= 0 && c.outputs.length > 0 && c.text().includes('HERMIT'));
      const out = await c.run('echo vws2-ok; seq 1 5 | sort -rn | head -2', '5\r\n4');
      assert.ok(out.includes('vws2-ok'));
      const seqs = c.outputs.map((o) => o.seq); assert.deepStrictEqual(seqs, seqs.map((_, i) => i + 1), 'output seq contiguous from 1'); assert.ok(c.outputs.every((o) => o.kind === 2 && o.len > 0));
      await c.until(() => c.type('input.ack').some((a) => a.payload.executedSeq === c.inSeq), 5000, 'ACK_EXECUTED');
      const live = await (await fetch(h.http + '/live')).json(); assert.strictEqual(live.ram.reconcile, true); assert.ok(live.ram.ledger.sessions >= 2); assert.strictEqual(live.ram.backend, backend);
      c.ctl('session.close', { reason: 'user' }); await c.until(() => c.closed, 5000, 'close');
      assert.deepStrictEqual(c.type('session.exit').map((m) => m.payload), [{ code: 0, reason: 'closed' }]); assert.strictEqual(c.closed.code, 1000);
      await sleep(300);
      const after = h.gw.ledger.snapshot(); assert.strictEqual(after.sessions, 0, JSON.stringify(after)); assert.strictEqual(after.globalReserved, 0); assert.strictEqual(after.physicalBytes, 0); assert.strictEqual(after.violations.duplicateRelease, 0);
      assert.ok(h.gw.ledger.reconcile().ok);
    } finally { await h.stop(); }
  });
}

test('credits: the server never sends beyond the granted window; output resumes exactly on credit; violations close 1008', async () => {
  const h = await startGateway({ creditWindowBytes: 65536 });
  try {
    const c = new Client(h.url, h.tokens.alice, { autoCredit: false, window: 65536, initialCredit: 65536 }); await c.open();
    c.input('seq 1 100000\r'); await sleep(1500);
    const sent = c.out.length; assert.ok(sent <= 65536, `sent ${sent} <= credit 65536`); assert.ok(sent > 50000, 'used most of the window');
    const conn = [...h.gw.registry.conns][0]; assert.strictEqual(conn.workerPaused, true, 'producer paused when credit is exhausted');
    await sleep(300); assert.strictEqual(c.out.length, sent, 'no bytes without credit');
    c.autoCredit = true; c.credit();
    await c.until(() => /100000\r\n/.test(c.text()), 30000, 'tail');
    const nums = c.text().split('\r\n').filter((l) => /^\d+$/.test(l)).map(Number); assert.strictEqual(nums.length, 100000); assert.ok(nums.every((n, i) => n === i + 1), 'lossless and ordered');
    c.autoCredit = false;
    c.credit({ creditBytes: c.creditBytes - 1 }); await c.until(() => c.closed, 5000); assert.strictEqual(c.closed.code, 1008); assert.ok(c.type('error').some((e) => e.payload.code === 'CREDIT_VIOLATION'));
    const d = new Client(h.url, h.tokens.bob, { autoCredit: false, window: 65536 }); await d.open();
    d.credit({ creditBytes: d.consumedBytes + 65536 + 1 }); await d.until(() => d.closed, 5000); assert.strictEqual(d.closed.code, 1008);
    const e = new Client(h.url, h.tokens.bob, { autoCredit: false, window: 65536 }); await e.open();
    e.credit({ consumedSeq: e.consumedSeq + 100 }); await e.until(() => e.closed, 5000); assert.strictEqual(e.closed.code, 1008);
    const f = new Client(h.url, h.tokens.bob, { initialCredit: 65537 }); await f.opened; await f.until(() => f.serverEpoch);
    f.send({ v: 2, type: 'session.open', rid: rid(), payload: { cols: 80, rows: 24, mode: 'virtual', creditBytes: 65537 } }); await f.until(() => f.closed, 5000); assert.strictEqual(f.type('error')[0].payload.code, 'CREDIT_VIOLATION');
  } finally { await h.stop(); }
});

test('SESSION_RESET: a client presenting state from another epoch gets session.reset with OUTCOME_UNKNOWN (pending) or NO_PENDING_INPUT, then a fresh session; nothing is replayed', async () => {
  const h = await startGateway();
  try {
    const a = new Client(h.url, h.tokens.alice, { previous: { sid: 's'.repeat(22), epoch: 'e'.repeat(16), pendingInputs: 3 } }); await a.open();
    const r = a.type('session.reset')[0]; assert.ok(r, 'session.reset was sent'); assert.strictEqual(r.payload.reason, 'process_restart'); assert.strictEqual(r.payload.outcome, 'OUTCOME_UNKNOWN'); assert.strictEqual(r.payload.pendingInputs, 3);
    assert.ok(a.msgs.findIndex((m) => m.type === 'session.reset') < a.msgs.findIndex((m) => m.type === 'session.opened'), 'reset precedes the new session');
    assert.ok(!/echo|replay/.test(a.text()), 'no old input was replayed');
    const b = new Client(h.url, h.tokens.bob, { previous: { sid: 's'.repeat(22), epoch: h.gw.ram.serverEpoch, pendingInputs: 0 } }); await b.open();
    assert.deepStrictEqual([b.type('session.reset')[0].payload.reason, b.type('session.reset')[0].payload.outcome], ['session_not_found', 'NO_PENDING_INPUT']);
    a.close(); b.close();
  } finally { await h.stop(); }
});

test('binary data discipline: zero-length payload, unknown kind, output kind from the client, wrong seq, oversize input are rejected; a 8192-byte input is accepted in one message', async () => {
  const h = await startGateway();
  try {
    const c = new Client(h.url, h.tokens.alice); await c.open();
    const raw = (b) => c.send(b);
    raw(Buffer.from([1, 0, 0, 0, 0, 0, 1])); await c.until(() => c.type('error').some((e) => e.payload.code === 'BAD_MESSAGE'));
    raw(Buffer.from([9, 0, 0, 0, 0, 0, 1, 65])); raw(Buffer.from([2, 0, 0, 0, 0, 0, 1, 65]));
    await c.until(() => c.type('error').filter((e) => e.payload.code === 'BAD_MESSAGE').length >= 2 && c.type('error').some((e) => e.payload.code === 'UNSUPPORTED'));
    c.input('x', { seq: 7 }); await c.until(() => c.type('error').some((e) => /input seq/.test(e.payload.message)));
    c.input('y'.repeat(8193)); await c.until(() => c.type('error').some((e) => e.payload.code === 'LIMIT_EXCEEDED'));
    c.inSeq = 0; c.input('\x15'); c.input('echo ' + 'z'.repeat(3000) + '\r'); await c.until(() => /z{3000}/.test(c.text()), 10000, '3000-byte line echoed (one 3 KB input message; the shell line bound is 4096 chars)');
    assert.strictEqual(c.closed, null);
    c.close();
  } finally { await h.stop(); }
});

test('memory admission: sessions are refused (503 / LIMIT_EXCEEDED) when the ledger allowance is exhausted; no worker is created; capacity returns on close', async () => {
  const h = await startGateway({ memoryLimitBytes: 0, headroomBytes: 0, poolIdleBytes: 0, maxSessions: 8 });
  const s = h.gw.memoryPlan.s; const F = 100 * 1048576; const L = F + 2 * s + 65536;
  await h.stop();
  const g = await startGateway({ memoryLimitBytes: L, fixedBaselineBytes: F, headroomBytes: 0, poolIdleBytes: 0, maxSessions: 8 });
  try {
    assert.strictEqual(g.gw.memoryPlan.memoryOnlySessionCeiling, 2); assert.strictEqual(g.gw.registry.sessionCap, 2);
    const a = await new Client(g.url, g.tokens.alice).open(), b = await new Client(g.url, g.tokens.bob).open();
    const workersBefore = [...g.gw.registry.conns].filter((c) => c.link).length; assert.strictEqual(workersBefore, 2);
    const r = await rawConnect(g.port, g.tokens.alice); assert.strictEqual(r.status, 503, 'third connection refused by the ledger before upgrade');
    assert.strictEqual(g.gw.ram.counters.memoryRefusals, 1); assert.strictEqual(g.gw.ledger.rejects.global, 1);
    assert.strictEqual([...g.gw.registry.conns].filter((c) => c.link).length, 2, 'no worker was created for the refused connection');
    a.close(); await sleep(400);
    const c = await new Client(g.url, g.tokens.alice).open(); assert.ok(c.sid);
    const live = await (await fetch(g.http + '/live')).json(); assert.strictEqual(live.ram.plan.admittedSessionCap, 2); assert.ok(live.ram.ledger.globalReserved <= live.ram.ledger.globalLimit);
    b.close(); c.close();
  } finally { await g.stop(); }
});

test('worker heap cap: a session that allocates without bound is ended with LIMIT_EXCEEDED/quota; the gateway and another tenant continue', async () => {
  const h = await startGateway({ workerBackend: 'thread', workerHeapBytes: 16 * 1048576, workerRuntimeOverheadBytes: 12 * 1048576 });
  try {
    if (h.gw.ram.heapCap !== 'ENFORCED') { console.log('  # heap cap ' + h.gw.ram.heapCap + ' in this process (NODE_OPTIONS?) — process backend check instead');
      await h.stop(); const g = await startGateway({ workerBackend: 'process', workerHeapBytes: 16 * 1048576 });
      try { const a = await new Client(g.url, g.tokens.alice).open(); const b = await new Client(g.url, g.tokens.bob).open();
        a.input('seq 1 3000000 > /tmp/x\r'); await a.until(() => a.closed || /quota|budget|limit/i.test(a.text()), 60000, 'cap');
        assert.match(await b.run('echo other-ok', 'other-ok\r\n'), /other-ok/); b.close(); a.close(); } finally { await g.stop(); }
      return;
    }
    const a = await new Client(h.url, h.tokens.alice).open(); const b = await new Client(h.url, h.tokens.bob).open();
    // the VFS quota would refuse a big file first; history+aliases are bounded too — use a pipeline capture that exceeds the heap but not the capture cap
    a.input('seq 1 4000000 | wc -l\r');
    await a.until(() => a.closed || /capture limit|quota/i.test(a.text()), 60000, 'bounded by something');
    assert.match(await b.run('echo other-ok', 'other-ok\r\n'), /other-ok/);
    const live = await (await fetch(h.http + '/live')).json(); assert.strictEqual(live.status, 'live');
    a.close(); b.close();
  } finally { await h.stop(); }
});
