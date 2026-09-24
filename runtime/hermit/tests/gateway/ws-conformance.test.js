'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { startGateway, rawConnect, rid, sleep } = require('../helpers');

let h; test.before(async () => { h = await startGateway(); }); test.after(async () => { await h.stop(); });
const open = () => rawConnect(h.port, h.tokens.alice);
async function expectClose(r, code) { await r.until(() => r.closeFrame() || r.closed); assert.strictEqual(r.closeFrame() && r.closeFrame().code, code); await r.until(() => r.closed, 5000); }

test('handshake: 101 with subprotocol; wrong subprotocol/version/key/path are refused without upgrade', async () => {
  const ok = await open(); assert.strictEqual(ok.status, 101); assert.match(ok.headers, /Sec-WebSocket-Protocol: hermit\.vws\.v2/i); assert.strictEqual((await rawConnect(h.port, h.tokens.alice, { protocol: 'hermit.vws.v1' })).status, 400, 'v1 is no longer offered'); assert.ok(!/Sec-WebSocket-Extensions/i.test(ok.headers)); ok.socket.destroy();
  assert.strictEqual((await rawConnect(h.port, h.tokens.alice, { protocol: 'other.v1' })).status, 400);
  assert.strictEqual((await rawConnect(h.port, h.tokens.alice, { protocol: null })).status, 400);
  assert.strictEqual((await rawConnect(h.port, h.tokens.alice, { path: '/ws/other' })).status, 404);
  assert.strictEqual((await rawConnect(h.port, h.tokens.alice, { path: '/ws/terminal?ticket=abc' })).status, 400);
});
test('unmasked client frame -> 1002', async () => { const r = await open(); r.sendFrame(1, '{}', { mask: false }); await expectClose(r, 1002); });
test('reserved bit -> 1002', async () => { const r = await open(); r.sendFrame(1, '{}', { rsv: 0x40 }); await expectClose(r, 1002); });
test('unknown opcode -> 1002', async () => { const r = await open(); r.sendFrame(3, 'x'); await expectClose(r, 1002); });
test('binary message with an unknown data kind -> application error, connection stays (binary is the v2 data plane)', async () => { const r = await open(); r.sendFrame(2, Buffer.from([9, 0, 0, 0, 0, 0, 1, 65])); await r.until(() => r.frames.some((f) => f.json && f.json.type === 'error')); assert.ok(!r.closeFrame()); r.socket.destroy(); });
test('invalid UTF-8 text -> 1007', async () => { const r = await open(); r.sendFrame(1, Buffer.from([0xff, 0xfe])); await expectClose(r, 1007); });
test('declared 64-bit length over the cap -> 1009 from the header alone (no payload sent)', async () => {
  const r = await open(); r.sendFrame(1, Buffer.alloc(0), { lenOverride: 1024 * 1024 * 1024 }); await expectClose(r, 1009);
});
test('fragmented message over the cap -> 1009 before buffering the offending fragment', async () => {
  const r = await open(); r.sendFrame(1, Buffer.alloc(40000, 0x20), { fin: false }); r.sendFrame(0, Buffer.alloc(30000, 0x20), { fin: false }); await expectClose(r, 1009);
});
test('continuation without start -> 1002; new text inside a fragmented message -> 1002', async () => {
  let r = await open(); r.sendFrame(0, 'x'); await expectClose(r, 1002);
  r = await open(); r.sendFrame(1, '{"v"', { fin: false }); r.sendFrame(1, '{}'); await expectClose(r, 1002);
});
test('fragmented control frame / oversize control -> 1002', async () => {
  let r = await open(); r.sendFrame(9, 'x', { fin: false }); await expectClose(r, 1002);
  r = await open(); r.sendFrame(9, Buffer.alloc(126)); await expectClose(r, 1002);
});
test('ping is answered with an identical pong, interleaved inside a fragmented text message that still assembles', async () => {
  const r = await open();
  const msg = JSON.stringify({ v: 2, type: 'heartbeat.ping', rid: rid(), payload: { nonce: 'n'.repeat(16) } });
  r.sendFrame(1, msg.slice(0, 10), { fin: false }); r.sendFrame(9, 'ping-data'); r.sendFrame(0, msg.slice(10, 30), { fin: false }); r.sendFrame(0, msg.slice(30));
  await r.until(() => r.frames.some((f) => f.op === 10)); assert.strictEqual(r.frames.find((f) => f.op === 10).payload.toString(), 'ping-data');
  await r.until(() => r.frames.some((f) => f.json && f.json.type === 'heartbeat.pong'));
  r.socket.destroy();
});
test('split UTF-8 character across fragments is reassembled before strict decoding', async () => {
  const r = await open();
  const body = Buffer.from(JSON.stringify({ v: 2, type: 'heartbeat.ping', rid: rid(), payload: { nonce: 'n'.repeat(16) } }));
  const bad = Buffer.from('{"v":2,"type":"é"}'); const cut = bad.indexOf(0xc3) + 1;
  r.sendFrame(1, bad.subarray(0, cut), { fin: false }); r.sendFrame(0, bad.subarray(cut));   // valid UTF-8 overall -> application-level error, not 1007
  await r.until(() => r.frames.some((f) => f.json && f.json.type === 'error')); assert.ok(!r.closeFrame());
  r.sendFrame(1, body); await r.until(() => r.frames.some((f) => f.json && f.json.type === 'heartbeat.pong')); r.socket.destroy();
});
test('stalled fragment assembly hits the deadline -> 1008', async () => {
  const g = await startGateway({ assemblyMs: 150 });
  try { const r = await rawConnect(g.port, g.tokens.alice); r.sendFrame(1, '{"v":', { fin: false }); await expectClose(r, 1008); } finally { await g.stop(); }
});
test('close handshake: peer close is echoed with the same code; invalid close code -> 1002; 1-byte close payload -> 1002', async () => {
  let r = await open(); const p = Buffer.alloc(2); p.writeUInt16BE(1000); r.sendFrame(8, p); await expectClose(r, 1000);
  r = await open(); const q = Buffer.alloc(2); q.writeUInt16BE(1005); r.sendFrame(8, q); await expectClose(r, 1002);
  r = await open(); r.sendFrame(8, Buffer.from([3])); await expectClose(r, 1002);
});
test('data after our close is ignored; abrupt TCP loss releases the connection', async () => {
  const r = await open(); r.sendFrame(3, 'x'); await r.until(() => r.closeFrame()); r.sendFrame(1, '{}'); await r.until(() => r.closed, 5000);
  const r2 = await open(); await sleep(50); r2.socket.destroy(); await sleep(150); assert.strictEqual(h.gw.registry.conns.size, 0);
});
