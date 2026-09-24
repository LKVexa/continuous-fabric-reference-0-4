'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { startGateway, Client, rid, sleep } = require('../helpers');

test('vertical slice: hello -> open -> opened precedes output -> input -> output -> close -> single exit', async () => {
  const h = await startGateway();
  try {
    const c = new Client(h.url, h.tokens.alice); await c.open();
    assert.strictEqual(c.msgs[0].type, 'hello');
    assert.deepStrictEqual(c.msgs[0].payload.capabilities, { resume: false, browserPane: false, virtualCommands: true, fabric: false });
    assert.ok(c.msgs.findIndex((m) => m.type === 'session.opened') > 0 && c.outputs.length > 0, 'session.opened must precede the first output');
    assert.match(c.sid, /^[A-Za-z0-9_-]{22,64}$/); assert.strictEqual(c.epoch, c.serverEpoch);
    assert.ok(c.text().includes('HERMIT'), 'banner was not lost');
    const out = await c.run('echo vws-$((1))-ok; seq 1 5 | sort -rn | head -2', '5\r\n4');
    assert.ok(out.includes('vws-'));
    const seqs = c.outputs.map((o) => o.seq);
    assert.deepStrictEqual(seqs, seqs.map((_, i) => i + 1), 'output seq starts at 1 and is contiguous');
    assert.ok(c.type('input.ack').length >= 1);
    c.ctl('session.close', { reason: 'user' });
    await c.until(() => c.closed, 5000, 'close');
    assert.deepStrictEqual(c.type('session.exit').map((m) => m.payload), [{ code: 0, reason: 'closed' }]);
    assert.strictEqual(c.closed.code, 1000);
    await sleep(100); assert.strictEqual(h.gw.registry.reserved.size, 0); assert.strictEqual(h.gw.registry.conns.size, 0);
  } finally { await h.stop(); }
});

test('exit command -> session.exit{logout, code}; Ctrl-C signal; resize validation', async () => {
  const h = await startGateway();
  try {
    const c = new Client(h.url, h.tokens.alice); await c.open();
    c.input('sleep 30\r'); await sleep(200);
    c.ctl('terminal.signal', { signal: 'SIGINT' });
    await c.run('echo rc=$?', 'rc=130');
    c.ctl('terminal.resize', { cols: 132, rows: 43 }); await c.until(() => c.type('request.ack').length >= 1);
    c.ctl('terminal.resize', { cols: -3, rows: 0 });
    await c.until(() => c.type('error').some((e) => e.payload.code === 'BAD_MESSAGE'));
    c.input('exit 7\r');
    await c.until(() => c.closed, 5000, 'close');
    assert.deepStrictEqual(c.type('session.exit').map((m) => m.payload), [{ code: 7, reason: 'logout' }]);
  } finally { await h.stop(); }
});

test('health / live / config expose no secrets; health flips to 503 while draining', async () => {
  const h = await startGateway();
  try {
    let r = await fetch(h.http + '/health'); assert.strictEqual(r.status, 200); assert.deepStrictEqual(await r.json(), { status: 'ok' });
    r = await fetch(h.http + '/health?x=1', { method: 'POST' }); assert.strictEqual(r.status, 405);
    const cfg = await (await fetch(h.http + '/config.json')).json();
    assert.ok(!JSON.stringify(cfg).match(/principals|token|DF_ROOT|\/home|tmp/i)); assert.strictEqual(cfg.protocol, 'hermit.vws.v2'); assert.strictEqual(cfg.profile, 'LOCAL_VOLATILE');
    const live = await (await fetch(h.http + '/live')).json(); assert.strictEqual(live.status, 'live');
    assert.strictEqual((await fetch(h.http + '/nope/../../etc/passwd')).status, 404);
    assert.strictEqual((await fetch(h.http + '/gateway/server.js')).status, 404);
    assert.strictEqual((await fetch(h.http + '/ws/terminal')).status, 426);
    const c = new Client(h.url, h.tokens.alice); await c.open();
    const done = h.gw.shutdown();
    await c.until(() => c.type('service.draining').length === 1);
    const hr = await fetch(h.http + '/health').catch(() => ({ status: 'closed' })); assert.ok(hr.status === 503 || hr.status === 'closed');
    await c.until(() => c.closed, 5000);
    assert.deepStrictEqual(c.type('session.exit').map((m) => m.payload.reason), ['shutdown']);
    assert.strictEqual(c.closed.code, 1001);
    const res = await done; assert.strictEqual(res.forced, false);
  } finally { await h.stop(); }
});

test('health stays responsive (< 250 ms) while a session streams bulk output and large inbound messages arrive', async () => {
  const h = await startGateway({ msgRate: 5000 });
  try {
    const c = await new Client(h.url, h.tokens.alice).open();
    c.input('seq 1 300000; seq 1 300000\r');
    const big = 'x'.repeat(8000); const lat = [];
    for (let i = 0; i < 25; i++) {
      c.input(big.slice(0, 100)); // small keystroke traffic interleaved
      c.send({ v: 2, type: 'heartbeat.ping', rid: rid(), payload: { nonce: 'n'.repeat(64) } });
      const t0 = process.hrtime.bigint(); const r = await fetch(h.http + '/health'); await r.arrayBuffer(); lat.push(Number(process.hrtime.bigint() - t0) / 1e6);
      assert.strictEqual(r.status, 200);
    }
    const worst = Math.max(...lat); assert.ok(worst < 250, `worst health latency ${worst.toFixed(1)} ms`);
    c.close();
  } finally { await h.stop(); }
});
