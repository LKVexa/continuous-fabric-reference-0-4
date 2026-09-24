'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../../protocol/codec');
const root = path.join(__dirname, '..', '..');
const codec = C.createCodec(JSON.parse(fs.readFileSync(path.join(root, 'protocol/envelope.schema.json'), 'utf8')), JSON.parse(fs.readFileSync(path.join(root, 'protocol/protocol-meta.json'), 'utf8')));
const vec = (n) => JSON.parse(fs.readFileSync(path.join(root, 'tests/vectors', n), 'utf8'));

test('v2 valid control vectors are accepted (16); invalid (15) and raw-invalid (3) are rejected; wire size and UTF-8', () => {
  const v = vec('protocol-v2-valid.json'); assert.strictEqual(v.length, 16); for (const i of v) codec.decode(Buffer.from(JSON.stringify(i.message)), i.direction);
  const x = vec('protocol-v2-invalid.json'); assert.strictEqual(x.length, 15); for (const i of x) assert.throws(() => codec.decode(Buffer.from(JSON.stringify(i.message)), i.direction), C.CodecError, i.id);
  for (const i of vec('protocol-raw-invalid.json')) assert.throws(() => codec.decode(Buffer.from(i.raw), i.direction), C.CodecError, i.id);
  assert.throws(() => codec.decode(Buffer.alloc(65537, 0x20), 'client_to_server'), /too large/); assert.throws(() => codec.decode(Buffer.from([0xff]), 'client_to_server'), /UTF-8/);
});
test('strict JSON: nested duplicate key, __proto__, depth, trailing data, non-finite, leading zero', () => {
  assert.throws(() => C.strictParse('{"a":{"b":1,"b":2}}'), /duplicate/); const o = C.strictParse('{"__proto__":{"x":1}}'); assert.strictEqual(({}).x, undefined); assert.ok(Object.prototype.hasOwnProperty.call(o, '__proto__'));
  assert.throws(() => C.strictParse('[[[[[[[[[[1]]]]]]]]]]'), /deep/); assert.throws(() => C.strictParse('{} x'), /trailing/); assert.throws(() => C.strictParse('{"a":1e999}'), /non-finite/); assert.throws(() => C.strictParse('{"a":01}'));
});
test('binary data frames: header round-trip for every uint48 boundary, no payload copy, caps and direction enforced', () => {
  for (const seq of [1, 2, 255, 256, 65535, 65536, 2 ** 32 - 1, 2 ** 32, 2 ** 48 - 1]) {
    const h = codec.writeDataHeader(Buffer.alloc(7), 'output', seq); const msg = Buffer.concat([h, Buffer.from('payload')]);
    const d = codec.decodeData(msg, 'server_to_client'); assert.strictEqual(d.seq, seq); assert.strictEqual(d.kind, 'output');
    assert.strictEqual(d.payload.buffer, msg.buffer, 'payload is a view of the message, not a copy'); assert.strictEqual(d.payload.toString(), 'payload');
  }
  assert.throws(() => codec.writeDataHeader(Buffer.alloc(7), 'input', 2 ** 48), /uint48/); assert.throws(() => codec.writeDataHeader(Buffer.alloc(7), 'input', 0), /uint48/);
  assert.throws(() => codec.decodeData(Buffer.from([1, 0, 0, 0, 0, 0, 1]), 'client_to_server'), /without payload/);
  assert.throws(() => codec.decodeData(Buffer.from([1, 0, 0, 0, 0, 0, 0, 65]), 'client_to_server'), /seq/);
  assert.throws(() => codec.decodeData(Buffer.from([2, 0, 0, 0, 0, 0, 1, 65]), 'client_to_server'), /not allowed/);
  assert.throws(() => codec.decodeData(Buffer.concat([Buffer.from([1, 0, 0, 0, 0, 0, 1]), Buffer.alloc(8193)]), 'client_to_server'), /8193 > 8192/);
  codec.decodeData(Buffer.concat([Buffer.from([1, 0, 0, 0, 0, 0, 1]), Buffer.alloc(8192)]), 'client_to_server');
});
test('base64 helpers still round-trip (used by the process backend bridge only)', () => {
  for (let len = 0; len < 100; len++) { const b = new Uint8Array(len); for (let k = 0; k < len; k++) b[k] = (k * 37 + len) & 255; assert.deepStrictEqual(Buffer.from(C.b64decode(C.b64encode(b))), Buffer.from(b)); }
  assert.throws(() => C.b64decode('QR=='), /canonical/);
});
test('encode refuses invalid outbound envelopes', () => {
  assert.throws(() => codec.encode({ v: 2, type: 'hello', payload: {} }, 'server_to_client'), C.CodecError);
  assert.throws(() => codec.encode({ v: 2, type: 'flow.credit', sid: 's'.repeat(22), epoch: 'e'.repeat(16), payload: { consumedSeq: 0, creditBytes: 1 } }, 'server_to_client'), /not allowed/);
});
