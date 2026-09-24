'use strict';
/** Regression tests for the findings of the adversarial review (docs/SECURITY.md "Review findings"). */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const net = require('node:net');
const { FrameDecoder, encodeRecord } = require('../../protocol/bridge');
const { startGateway, Client, rawConnect, rid, sleep } = require('../helpers');

test('C1 unit: a record cut in half by OUR pause does not trip the assembly deadline; a genuinely stalled peer still does', async () => {
  const rec = encodeRecord({ t: 'pong', nonce: 'n'.repeat(16), busy: false, usage: { vfsBytes: 0, vfsNodes: 0, historyBytes: 0, pendingOutBytes: 0, overflows: 0 } }, 'worker_to_gateway'); const got = [], errs = [];
  const d = new FrameDecoder({ direction: 'worker_to_gateway', assemblyMs: 60, onRecord: (r) => got.push(r), onError: (e) => errs.push(e) });
  d.push(rec.subarray(0, 9)); d.pause(); await sleep(200); assert.strictEqual(errs.length, 0);
  d.resume(); d.push(rec.subarray(9)); assert.strictEqual(got.length, 1);
  d.push(rec.subarray(0, 9)); await sleep(150); assert.strictEqual(errs[0].code, 'BRIDGE_ASSEMBLY_TIMEOUT');
});
test('C1 e2e: a consumer slower than the bridge assembly deadline keeps its session and later receives everything, gap-free', async () => {
  const g = await startGateway({ creditWindowBytes: 65536, bridgeAssemblyMs: 300, workerBackend: 'process' });
  try {
    const c = new Client(g.url, g.tokens.alice, { autoCredit: false, window: 65536, initialCredit: 65536 }); await c.open();
    c.input('seq 1 200000\r'); await sleep(2000);                       // paused ~6x longer than the assembly deadline
    assert.strictEqual(c.closed, null, 'session must survive a long pause'); assert.strictEqual(c.type('session.exit').length, 0);
    assert.strictEqual([...g.gw.registry.conns][0].workerPaused, true);
    c.autoCredit = true; c.credit();
    await c.until(() => /200000\r\n/.test(c.text()), 30000, 'tail');
    const nums = c.text().split('\r\n').filter((l) => /^\d+$/.test(l)).map(Number); assert.strictEqual(nums.length, 200000); assert.ok(nums.every((n, i) => n === i + 1));
    c.close();
  } finally { await g.stop(); }
});
test('S5: a consumer that never catches up is ended with an explicit quota exit after the pause budget', async () => {
  const g = await startGateway({ creditWindowBytes: 65536, maxPauseMs: 600, workerPingMs: 150 });
  try {
    const c = new Client(g.url, g.tokens.alice, { autoCredit: false, window: 65536, initialCredit: 65536 }); await c.open(); c.input('seq 1 200000\r');
    await c.until(() => c.closed, 8000); assert.strictEqual(c.closed.code, 1008);
    assert.ok(c.type('error').some((e) => e.payload.code === 'LIMIT_EXCEEDED')); assert.strictEqual(c.type('session.exit')[0].payload.reason, 'quota');
    await sleep(200); assert.strictEqual(g.gw.registry.reserved.size, 0);
  } finally { await g.stop(); }
});
test('S1: with open loopback-dev identity, a non-loopback Host (DNS rebinding) is refused on every route', async () => {
  const g = await startGateway({ auth: 'none-loopback-dev' });
  try {
    const raw = (host, path, extra = '') => new Promise((res) => { const s = net.connect(g.port, '127.0.0.1', () => s.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\n${extra}Connection: close\r\n\r\n`)); let b = ''; s.on('data', (c) => { b += c; }); s.on('close', () => res(parseInt(b.split(' ')[1], 10))); });
    assert.strictEqual(await raw(`127.0.0.1:${g.port}`, '/health'), 200); assert.strictEqual(await raw(`localhost:${g.port}`, '/config.json'), 200);
    assert.strictEqual(await raw(`evil.example:${g.port}`, '/health'), 421); assert.strictEqual(await raw(`evil.example:${g.port}`, '/'), 421);
    const up = 'Upgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: hermit.vws.v2\r\n';
    const wsTry = (host, origin) => new Promise((res) => { const s = net.connect(g.port, '127.0.0.1', () => s.write(`GET /ws/terminal HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\n${up}Origin: ${origin}\r\n\r\n`)); s.once('data', (c) => { res(parseInt(String(c).split(' ')[1], 10)); s.destroy(); }); });
    assert.strictEqual(await wsTry(`evil.example:${g.port}`, `http://evil.example:${g.port}`), 403, 'rebinding page: Origin == Host but Host is not loopback');
    assert.strictEqual(await wsTry(`127.0.0.1:${g.port}`, `http://127.0.0.1:${g.port}`), 101);
  } finally { await g.stop(); }
});
test('S3: one principal cannot hold every connection slot; others are still admitted', async () => {
  const g = await startGateway({ maxConnectionsPerPrincipal: 2, openTimeoutMs: 5000 });
  try {
    const a = await rawConnect(g.port, g.tokens.alice), b = await rawConnect(g.port, g.tokens.alice); assert.deepStrictEqual([a.status, b.status], [101, 101]);
    assert.strictEqual((await rawConnect(g.port, g.tokens.alice)).status, 429); assert.strictEqual((await rawConnect(g.port, g.tokens.bob)).status, 101);
    a.socket.destroy(); await sleep(150); assert.strictEqual((await rawConnect(g.port, g.tokens.alice)).status, 101);
  } finally { await g.stop(); }
});
test('S2: failed ticket attempts are limited per address without blocking a valid principal', async () => {
  const g = await startGateway();
  try {
    let last = 0; for (let i = 0; i < 65; i++) last = (await fetch(g.http + '/api/ws-ticket', { method: 'POST', headers: { authorization: 'Bearer ' + 'z'.repeat(43) } })).status;
    assert.strictEqual(last, 429);
    assert.strictEqual((await fetch(g.http + '/api/ws-ticket', { method: 'POST', headers: { authorization: 'Bearer ' + g.tokens.alice } })).status, 200, 'a valid credential from the same address is still served');
  } finally { await g.stop(); }
});
test('S4: a ping flood is closed 1008', async () => {
  const g = await startGateway();
  try { const r = await rawConnect(g.port, g.tokens.alice); for (let i = 0; i < 400; i++) r.sendFrame(9, 'x'); await r.until(() => r.closeFrame() || r.closed, 5000); assert.strictEqual(r.closeFrame().code, 1008); } finally { await g.stop(); }
});
test('S7: a malformed notAfter rejects the principals file (never fail-open); removing a capability ends sessions that hold it', async () => {
  const g = await startGateway();
  try {
    const c = await new Client(g.url, g.tokens.alice).open();
    await sleep(20); fs.writeFileSync(g.pf, JSON.stringify(g.principals.map((p) => (p.sub === 'alice' ? { ...p, capabilities: ['terminal'] } : p))));
    assert.strictEqual(g.gw.registry.identity.stillValid([...g.gw.registry.conns][0].principal), false, 'fabric was removed from a session that holds it');
    await sleep(20); fs.writeFileSync(g.pf, JSON.stringify(g.principals.map((p) => (p.sub === 'bob' ? { ...p, notAfter: 'next tuesday' } : p))));
    assert.strictEqual((await rawConnect(g.port, g.tokens.bob)).status, 401); assert.strictEqual((await rawConnect(g.port, g.tokens.alice)).status, 401, 'whole file rejected');
    assert.ok(g.logs.some((l) => /auth.principals_invalid/.test(l) && /notAfter/.test(l)));
    c.close();
  } finally { await g.stop(); }
});
test('S9: aliases named after Object.prototype members are ordinary keys; Tab completion on them does not end the session', async () => {
  const g = await startGateway();
  try {
    const c = await new Client(g.url, g.tokens.alice).open();
    await c.run('alias constructor="echo ctor-ok"; alias __proto__="echo proto-ok"; constructor; __proto__; echo A-DONE', 'A-DONE\r\n');
    assert.match(c.text(), /ctor-ok/); assert.match(c.text(), /proto-ok/);
    c.input('constructor x\t\t'); c.input('\x15toString \t\t\x15'); await sleep(300);
    assert.match(await c.run('echo still-alive', 'still-alive\r\n'), /still-alive/); assert.strictEqual(c.closed, null);
    c.close();
  } finally { await g.stop(); }
});

test('R2-1 (thread backend): a credit-starved session with a huge multi-command line cannot grow gateway memory outside the ledger', async () => {
  const g = await startGateway({ workerBackend: 'thread', creditWindowBytes: 16384, maxPauseMs: 120000 });
  try {
    const c = new Client(g.url, g.tokens.alice, { autoCredit: false, window: 16384, initialCredit: 16384 }); await c.open();
    const rss0 = process.memoryUsage().rss;
    c.input('seq 1 1000000\r'.repeat(20) + 'true\r'); await sleep(4000);
    const conn = [...g.gw.registry.conns][0]; const t = conn.telemetry();
    const grew = (process.memoryUsage().rss - rss0) / 1048576;
    assert.ok(t.transport.reserved <= t.transport.limit, 'everything retained is inside the ledger'); assert.ok(g.gw.ledger.reconcile().ok);
    assert.ok(conn.pendingOut.length <= 200, `pendingOut ${conn.pendingOut.length}`);
    assert.ok(grew < 64, `gateway RSS grew ${grew.toFixed(1)} MiB while starved`);
    assert.ok(c.closed === null || c.type('session.exit')[0].payload.reason === 'quota', 'either paused within budget or ended with an explicit quota exit');
    c.close();
  } finally { await g.stop(); }
});
test('R2-2: undelivered output is counted on abrupt close and on discard', async () => {
  const g = await startGateway({ creditWindowBytes: 65536 });
  try {
    const c = new Client(g.url, g.tokens.alice, { autoCredit: false, window: 65536, initialCredit: 65536 }); await c.open();
    c.input('seq 1 100000\r'); await sleep(800); c.ws.close(); await sleep(600);
    assert.ok(g.gw.ram.counters.undeliveredOutputBytes > 0, 'counted');
  } finally { await g.stop(); }
});
