'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { SpiralKernel } = require('../../src/main/spiral/kernel');
const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));

function boot(opts = {}, open = {}) {
  const k = new SpiralKernel(opts);
  const out = []; const exits = [];
  k.on('data', (e) => out.push(e.chunk)); k.on('exit', (e) => exits.push(e));
  const { sessionId } = k.openSession({ cols: 80, rows: 24, ...open });
  return { k, id: sessionId, out, exits, text: () => out.join('') };
}

test('F05 geometry: invalid open throws, invalid resize is refused and never stored', () => {
  const k = new SpiralKernel();
  for (const [c, r] of [[-3, 0], [1, 24], [401, 24], [80, 201], [80.5, 24], [NaN, 24], ['80', 24], [Infinity, 1]]) assert.throws(() => k.openSession({ cols: c, rows: r }), RangeError);
  const { sessionId } = k.openSession({ cols: 80, rows: 24 });
  assert.strictEqual(k.resize(sessionId, -3, 0), false);
  const s = k.sessions.get(sessionId); assert.deepStrictEqual([s.cols, s.rows], [80, 24]);
  assert.strictEqual(k.resize(sessionId, 400, 200), true);
  k.closeSession(sessionId);
});
test('F04 close settles the active reader and emits exactly one exit', async () => {
  const { k, id, exits } = boot(); await tick();
  const reader = k.sessions.get(id).pending; assert.ok(reader);
  let settled = false; reader.promise.then(() => { settled = true; });
  assert.strictEqual(k.closeSession(id), true); assert.strictEqual(k.closeSession(id), false);
  await tick(20);
  assert.strictEqual(settled, true); assert.strictEqual(exits.length, 1); assert.strictEqual(k.sessions.size, 0);
});
test('close during a running command aborts it; still one exit; no late output', async () => {
  const { k, id, out, exits } = boot(); await tick();
  k.write(id, 'sleep 30\r'); await tick(30);
  assert.ok(k.sessions.get(id).running);
  k.closeSession(id); const n = out.length; await tick(40);
  assert.strictEqual(exits.length, 1); assert.strictEqual(out.length, n);
});
test('F10 open barrier: deferStart emits nothing until startSession', async () => {
  const { k, id, out } = boot({}, { deferStart: true }); await tick(30);
  assert.strictEqual(out.length, 0);
  assert.strictEqual(k.startSession(id), true); assert.strictEqual(k.startSession(id), false);
  await tick(); assert.ok(out.join('').includes('HERMIT'));
  k.closeSession(id);
});
test('exit command and Ctrl-D report logout once', async () => {
  let b = boot(); await tick(); b.k.write(b.id, 'exit 3\r'); await tick(30);
  assert.deepStrictEqual(b.exits.map((e) => [e.code, e.reason]), [[3, 'logout']]);
  b = boot(); await tick(); b.k.write(b.id, '\x04'); await tick(30);
  assert.strictEqual(b.exits.length, 1);
});
test('Ctrl-C at prompt, during command, and SIGINT signal are distinct and non-fatal', async () => {
  const { k, id, text, exits } = boot(); await tick();
  k.write(id, 'abc\x03'); await tick(); assert.ok(text().includes('^C'));
  k.write(id, 'sleep 30\r'); await tick(30); k.signal(id, 'SIGINT'); await tick(30);
  assert.strictEqual(k.sessions.get(id).running, null);
  k.signal(id, 'SIGKILL'); k.write(id, 'echo alive-$?\r'); await tick(30);
  assert.ok(text().includes('alive-130')); assert.strictEqual(exits.length, 0);
  k.closeSession(id);
});
test('type-ahead: pasted multi-line input executes every line in order', async () => {
  const { k, id, text } = boot(); await tick();
  k.write(id, 'echo one\recho two\recho three\r'); await tick(80);
  const t = text(); assert.ok(t.indexOf('one') < t.indexOf('two') && t.indexOf('two') < t.indexOf('three') && t.indexOf('three') > 0);
  k.closeSession(id);
});
test('F17 bounds: capture limit, seq limit, regex length, input line length', async () => {
  const { k, id, text } = boot({ limits: { captureBytes: 2000, seqItems: 5000, regexChars: 16, lineChars: 64 } }); await tick();
  k.write(id, 'seq 1 4000 | wc -l\r'); await tick(60); assert.ok(/capture limit/.test(text()));
  k.write(id, 'seq 1 999999999\r'); await tick(40); assert.ok(/exceeds the limit/.test(text()));
  k.write(id, 'echo x | grep aaaaaaaaaaaaaaaaaaaaaaaaaaaa\r'); await tick(40); assert.ok(/pattern longer/.test(text()));
  k.write(id, 'z'.repeat(500)); await tick(); assert.ok(k.sessions.get(id).pending.buf.length <= 64);
  k.closeSession(id);
});
test('VFS quota surfaces as a command error, not a crash', async () => {
  const { k, id, text } = boot({ vfsLimits: { maxBytes: 600, maxNodes: 14 } }); await tick();
  k.write(id, 'seq 1 400 > /tmp/a\r'); await tick(40); assert.ok(/quota/.test(text()));
  k.write(id, 'mkdir /tmp/d1 /tmp/d2 /tmp/d3 /tmp/d4 /tmp/d5\r'); await tick(40); assert.ok(/node quota/.test(text()));
  k.write(id, 'echo ok\r'); await tick(30); assert.ok(/ok/.test(text()));
  k.closeSession(id);
});
test('commandFilter removes commands from the registry', () => {
  const k = new SpiralKernel({ commandFilter: (d) => !['browser', 'open', 'photon'].includes(d.name) });
  assert.strictEqual(k.registry.resolve('photon'), null); assert.ok(k.registry.resolve('ls'));
});
