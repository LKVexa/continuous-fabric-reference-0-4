'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const { startGateway, Client, rawConnect, rid, sleep } = require('../helpers');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const workerPid = (g) => [...g.gw.registry.conns][0].link.pid;

test('worker killed (-9) -> exactly one session.exit{worker_failure} -> close 1011; capacity released', async () => {
  const g = await startGateway({ workerBackend: 'process' });
  try {
    const c = await new Client(g.url, g.tokens.alice).open(); process.kill(workerPid(g), 'SIGKILL');
    await c.until(() => c.closed, 5000);
    assert.deepStrictEqual(c.type('session.exit').map((m) => m.payload), [{ code: 70, reason: 'worker_failure' }]); assert.strictEqual(c.closed.code, 1011);
    await sleep(100); assert.strictEqual(g.gw.registry.reserved.size, 0);
  } finally { await g.stop(); }
});
for (const backend of ['thread', 'process']) test(`[${backend}] non-cooperative CPU loop (catastrophic RegExp) cannot be cancelled in-process: the supervisor terminates only that worker; the other tenant is unaffected`, async () => {
  const g = await startGateway({ workerPingMs: 150, workerStallMs: 900, workerBackend: backend });
  try {
    const a = await new Client(g.url, g.tokens.alice).open(), b = await new Client(g.url, g.tokens.bob).open();
    const pid = backend === 'process' ? workerPid(g) : null;
    a.input("echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa! | grep '(a+)+$'\r");
    const t0 = Date.now(); await a.until(() => a.closed, 10000); const ms = Date.now() - t0;
    assert.strictEqual(a.type('session.exit')[0].payload.reason, 'worker_failure'); assert.ok(ms < 5000, `contained in ${ms} ms`);
    await sleep(100); if (pid) assert.strictEqual(alive(pid), false);
    assert.match(await b.run('echo still-here', 'still-here\r\n'), /still-here/);
    const health = await fetch(g.http + '/health'); assert.strictEqual(health.status, 200);
    b.close();
  } finally { await g.stop(); }
});
test('abrupt TCP loss: worker is stopped, session released, no orphan process', async () => {
  const g = await startGateway({ workerBackend: 'process' });
  try {
    const r = await rawConnect(g.port, g.tokens.alice);
    r.sendJson({ v: 2, type: 'session.open', rid: rid(), payload: { cols: 80, rows: 24, mode: 'virtual', creditBytes: 65536 } });
    await r.until(() => r.frames.some((f) => f.json && f.json.type === 'session.opened'));
    const pid = workerPid(g); r.socket.destroy();
    for (let i = 0; i < 40 && alive(pid); i++) await sleep(100);
    assert.strictEqual(alive(pid), false); assert.strictEqual(g.gw.registry.reserved.size, 0);
  } finally { await g.stop(); }
});
test('application heartbeat: a peer that never answers is closed 1008 within interval + window; an answering peer stays', async () => {
  const g = await startGateway({ heartbeatMs: 300, heartbeatWindowMs: 200 });
  try {
    const dead = new Client(g.url, g.tokens.alice, { pong: false }); await dead.open();
    const live = await new Client(g.url, g.tokens.bob).open();
    const t0 = Date.now(); await dead.until(() => dead.closed, 3000);
    assert.strictEqual(dead.closed.code, 1008); assert.ok(Date.now() - t0 < 1500);
    assert.strictEqual(dead.type('session.exit')[0].payload.reason, 'expired');
    await sleep(700); assert.strictEqual(live.closed, null); assert.ok(live.type('heartbeat.ping').length >= 2);
    const r = rid(); live.send({ v: 2, type: 'heartbeat.ping', rid: r, payload: { nonce: 'c'.repeat(16) } });
    await live.until(() => live.type('heartbeat.pong').some((m) => m.rid === r)); live.close();
  } finally { await g.stop(); }
});
test('no session.open within the open deadline -> NOT_READY + 1008; idle session expires', async () => {
  const g = await startGateway({ openTimeoutMs: 250 });
  try { const c = new Client(g.url, g.tokens.alice); await c.opened; await c.until(() => c.closed, 3000); assert.strictEqual(c.type('error')[0].payload.code, 'NOT_READY'); assert.strictEqual(c.closed.code, 1008); } finally { await g.stop(); }
});
test('slow consumer (no credit): worker paused, gateway memory bounded by the ledger, a fast tenant unaffected, catch-up is lossless', async () => {
  const g = await startGateway({ sendQueueBytes: 131072, creditWindowBytes: 262144 });
  try {
    const slow = new Client(g.url, g.tokens.alice, { autoCredit: false, window: 262144, initialCredit: 262144 }); await slow.open();
    const fast = await new Client(g.url, g.tokens.bob, { window: 262144 }).open();
    slow.input('seq 1 150000\r');                                  // ~1 MB of output, credit never renewed
    await sleep(1500);
    const conn = [...g.gw.registry.conns].find((c) => c.principal.sub === 'alice');
    assert.strictEqual(conn.workerPaused, true, 'worker is paused when credit is exhausted');
    assert.ok(slow.out.length <= 262144, `sent ${slow.out.length} <= credit`);
    const t = conn.telemetry(); assert.ok(t.transport.reserved <= t.transport.limit, 'transport account within its reservation'); assert.ok(g.gw.ledger.reconcile().ok);
    const before = slow.out.length; await sleep(400); assert.strictEqual(slow.out.length, before, 'flow is actually stopped');
    assert.match(await fast.run('echo fast-ok', 'fast-ok\r\n'), /fast-ok/);
    slow.autoCredit = true; slow.credit();
    await slow.until(() => /150000\r\n/.test(slow.text()), 30000, 'tail of output');
    const nums = slow.text().split('\r\n').filter((l) => /^\d+$/.test(l)).map(Number);
    assert.strictEqual(nums.length, 150000); for (let i = 0; i < nums.length; i++) if (nums[i] !== i + 1) assert.fail(`gap at ${i}`);
    slow.close(); fast.close();
  } finally { await g.stop(); }
});
test('peer that stops reading its TCP socket: gateway send queue stays within budget and the connection is contained', async () => {
  const g = await startGateway({ sendQueueBytes: 131072 });
  try {
    const r = await rawConnect(g.port, g.tokens.alice);
    r.sendJson({ v: 2, type: 'session.open', rid: rid(), payload: { cols: 80, rows: 24, mode: 'virtual', creditBytes: 1048576 } });
    await r.until(() => r.frames.some((f) => f.json && f.json.type === 'session.opened'));
    r.socket.pause();
    r.sendInput(1, 'seq 1 400000; seq 1 400000; seq 1 400000; seq 1 400000; seq 1 400000; seq 1 400000\r');
    await sleep(2500);
    const conn = [...g.gw.registry.conns][0];
    assert.ok(conn.ws.queuedBytes <= 131072 + 16384 + 65536, `socket queue ${conn.ws.queuedBytes}`);
    const t = conn.telemetry(); assert.ok(t.transport.reserved <= t.transport.limit); assert.strictEqual(conn.workerPaused, true);
    const rss = process.memoryUsage().rss; assert.ok(rss < 600 * 1024 * 1024);
    r.socket.destroy();
  } finally { await g.stop(); }
});
test('real process: SIGTERM drains within budget, notifies the client, exits 0; malformed PORT refuses to start (78)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vws-proc-')); const token = crypto.randomBytes(32).toString('base64url');
  fs.writeFileSync(path.join(dir, 'p.json'), JSON.stringify([{ sub: 'op', tenant: 't', tokenSha256: crypto.createHash('sha256').update(token).digest('hex'), capabilities: ['terminal'] }]));
  const bad = spawn(process.execPath, ['gateway/server.js'], { env: { PATH: process.env.PATH, PORT: '80x', VWS_PRINCIPALS_FILE: path.join(dir, 'p.json') } });
  assert.strictEqual(await new Promise((r) => bad.on('exit', r)), 78);
  const port = 20000 + (process.pid % 20000);
  const p = spawn(process.execPath, ['gateway/server.js'], { env: { PATH: process.env.PATH, PORT: String(port), VWS_HOST: '127.0.0.1', VWS_PRINCIPALS_FILE: path.join(dir, 'p.json'), VWS_SHUTDOWN_MS: '8000' }, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = ''; p.stderr.on('data', (c) => { err += c; });
  for (let i = 0; i < 50 && !/gateway.listening/.test(err); i++) await sleep(100);
  const c = await new Client(`ws://127.0.0.1:${port}/ws/terminal`, token).open();
  assert.strictEqual(c.msgs[0].payload.profile, 'LOCAL_VOLATILE');
  const t0 = Date.now(); p.kill('SIGTERM');
  const code = await new Promise((r) => p.on('exit', r)); const ms = Date.now() - t0;
  await c.until(() => c.closed, 3000);
  assert.strictEqual(code, 0); assert.ok(ms < 8000, `drained in ${ms} ms`);
  assert.strictEqual(c.type('service.draining').length, 1); assert.strictEqual(c.type('session.exit')[0].payload.reason, 'shutdown'); assert.strictEqual(c.closed.code, 1001);
  assert.ok(!err.includes(token)); fs.rmSync(dir, { recursive: true, force: true });
});

test('exception during hand-off after the 101 is contained: socket released, no capacity leak, next client served, error logged', async () => {
  const g = await startGateway({ logLevel: 'debug' });
  try {
    g.gw.hooks.Connection = function Boom() { throw new Error('injected hand-off failure'); };
    const r = await rawConnect(g.port, g.tokens.alice); await r.until(() => r.closed, 3000);
    assert.strictEqual(g.gw.registry.conns.size, 0); assert.strictEqual(g.gw.registry.reserved.size, 0);
    assert.ok(g.logs.some((l) => /ws.admission_error/.test(l) && /injected/.test(l)));
    delete g.gw.hooks.Connection;
    const c = await new Client(g.url, g.tokens.alice).open(); assert.match(await c.run('echo served', 'served\r\n'), /served/); c.close();
    assert.strictEqual((await fetch(g.http + '/health')).status, 200);
  } finally { await g.stop(); }
});

test('repeated and mixed termination signals run shutdown exactly once and exit 0; a signal before handlers exist terminates by default action', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vws-early-')); fs.writeFileSync(path.join(dir, 'p.json'), '[]');
  const env = (port) => ({ PATH: process.env.PATH, PORT: String(port), VWS_HOST: '127.0.0.1', VWS_PRINCIPALS_FILE: path.join(dir, 'p.json') });
  const q = spawn(process.execPath, ['gateway/server.js'], { env: env(22000 + (process.pid % 15000)), stdio: ['ignore', 'ignore', 'pipe'] });
  let err = ''; q.stderr.on('data', (c) => { err += c; });
  for (let i = 0; i < 50 && !/gateway.listening/.test(err); i++) await sleep(100);
  q.kill('SIGTERM'); q.kill('SIGTERM'); q.kill('SIGINT');
  const code = await new Promise((r) => q.on('exit', (c, sig) => r(sig || c)));
  assert.strictEqual(code, 0); assert.strictEqual((err.match(/gateway.draining/g) || []).length, 1, 'shutdown ran exactly once');
  // Immediately after spawn the runtime may not have installed handlers yet: the OS default action applies. Either way: prompt, no hang, never exit 1.
  const e = spawn(process.execPath, ['gateway/server.js'], { env: env(23000 + (process.pid % 15000)), stdio: 'ignore' });
  const t0 = Date.now(); e.kill('SIGTERM'); const early = await new Promise((r) => e.on('exit', (c, sig) => r(sig || c)));
  assert.ok(early === 0 || early === 'SIGTERM', `early exit ${early}`); assert.ok(Date.now() - t0 < 3000);
  fs.rmSync(dir, { recursive: true, force: true });
});
