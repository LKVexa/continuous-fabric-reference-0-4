'use strict';
const test = require('node:test');
const assert = require('node:assert');
globalThis.HermitVWS = { codec: require('../../protocol/codec') };
require('../../client/transport.js'); require('../../client/ipc-adapter.js'); require('../../client/ws-adapter.js');
const V = globalThis.HermitVWS;

test('full-jitter backoff stays within [0, min(30 s, 0.5 s * 2^attempt)) and uses the supplied randomness', () => {
  for (let a = 0; a < 12; a++) { const cap = Math.min(30000, 500 * 2 ** a); assert.strictEqual(V.backoffMs(a, () => 0), 0); assert.ok(V.backoffMs(a, () => 0.999999) < cap); assert.ok(V.backoffMs(a, () => 0.999999) >= cap - 1); }
});
test('binary input header writer agrees with the codec for boundary seqs', () => {
  const C = V.codec; for (const seq of [1, 65536, 2 ** 32, 2 ** 48 - 1]) { const a = C.writeDataHeaderRaw(new Uint8Array(7), 1, seq); assert.deepStrictEqual(Buffer.from(a), Buffer.from([1, ...Buffer.from(seq.toString(16).padStart(12, '0'), 'hex')])); }
  assert.throws(() => V.codec.writeDataHeaderRaw(new Uint8Array(7), 1, 2 ** 48));
});
test('input chunking: <= limit per chunk, byte-exact reassembly even when a multi-byte character straddles chunks', () => {
  const bytes = V.codec.utf8('é✓😀'.repeat(3000)); const parts = V.chunkBytes(bytes, 8192);
  assert.ok(parts.every((p) => p.length <= 8192)); assert.ok(parts.length > 1);
  assert.deepStrictEqual(Buffer.concat(parts.map((p) => Buffer.from(p))), Buffer.from(bytes));
  const dec = new (require('node:string_decoder').StringDecoder)('utf8'); assert.strictEqual(parts.map((p) => dec.write(Buffer.from(p))).join('') + dec.end(), 'é✓😀'.repeat(3000));
});
test('geometry clamp: finite integers inside policy for any input', () => {
  for (const [c, r] of [[-3, 0], [1e9, 1e9], [NaN, Infinity], ['x', null], [80.7, 24.2]]) { const g = V.clampGeometry(c, r); assert.ok(Number.isInteger(g.cols) && g.cols >= 2 && g.cols <= 400 && Number.isInteger(g.rows) && g.rows >= 1 && g.rows <= 200); }
});
test('IPC adapter open barrier: output that overtakes the open reply is held, delivered in order after start(), never before', async () => {
  let onData, onExit; const started = [];
  const bridge = { onData: (f) => { onData = f; }, onExit: (f) => { onExit = f; }, start: (id) => started.push(id), write() {}, resize() {}, signal() {}, close: async () => true,
    open: async (o) => { assert.strictEqual(o.deferStart, true); onData({ sessionId: 's1', chunk: 'EARLY-1 ' }); await null; onData({ sessionId: 's1', chunk: 'EARLY-2 ' }); return { sessionId: 's1' }; } };
  const t = V.IpcTransport(bridge); const got = []; t.onData((e) => got.push(e.chunk));
  const { sessionId } = await t.open({ cols: 80, rows: 24 }); onData({ sessionId, chunk: 'HELD ' });
  assert.deepStrictEqual(got, []); t.start(sessionId); onData({ sessionId, chunk: 'LIVE' });
  assert.deepStrictEqual(got, ['EARLY-1 ', 'EARLY-2 ', 'HELD ', 'LIVE']); assert.deepStrictEqual(started, ['s1']);
});
test('holding queue is bounded and overflow is announced, not silent', () => {
  const out = []; const b = V.openBarrier((id, c) => out.push(c), 10); b.hold('x'); b.push('x', '12345'); b.push('x', '1234567890'); b.release('x');
  assert.strictEqual(out[0], '12345'); assert.match(out[1], /truncated/);
});
