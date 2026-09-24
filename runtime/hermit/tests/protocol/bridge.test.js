'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { FrameDecoder, encodeRecord, MAX_BODY } = require('../../protocol/bridge');

function dec(extra = {}) {
  const got = [], errs = [];
  const d = new FrameDecoder({ direction: 'gateway_to_worker', onRecord: (r) => got.push(r), onError: (e) => errs.push(e), ...extra });
  return { d, got, errs };
}
const A = encodeRecord({ t: 'resize', cols: 80, rows: 24 }, 'gateway_to_worker');
const B = encodeRecord({ t: 'input', seq: 1, data: Buffer.from('ls\r').toString('base64') }, 'gateway_to_worker');

test('byte-at-a-time delivery (split header + split body)', () => {
  const { d, got, errs } = dec();
  for (const b of Buffer.concat([A, B])) d.push(Buffer.from([b]));
  assert.deepStrictEqual(got.map((r) => r.t), ['resize', 'input']);
  assert.strictEqual(errs.length, 0);
  assert.strictEqual(d.end(), 'clean');
});
test('many records in one read', () => {
  const { d, got } = dec();
  d.push(Buffer.concat([A, B, A, B, A]));
  assert.strictEqual(got.length, 5);
});
test('zero-length and oversize are rejected from the header alone', () => {
  let x = dec(); x.d.push(Buffer.from([0, 0, 0, 0])); assert.strictEqual(x.errs[0].code, 'BRIDGE_ZERO_LENGTH');
  x = dec(); const h = Buffer.alloc(4); h.writeUInt32BE(MAX_BODY + 1); x.d.push(h);
  assert.strictEqual(x.errs[0].code, 'BRIDGE_LIMIT'); assert.strictEqual(x.d.body, null);
  x = dec(); x.d.push(Buffer.from([0xff, 0xff, 0xff, 0xff])); assert.strictEqual(x.errs[0].code, 'BRIDGE_LIMIT');
});
test('truncated record is distinguished from clean EOF', () => {
  const { d } = dec(); d.push(A.subarray(0, A.length - 3)); assert.strictEqual(d.end(), 'truncated');
});
test('unknown type / unknown property / wrong direction / duplicate key / bad utf8 rejected', () => {
  const frame = (s) => { const b = Buffer.from(s); const h = Buffer.alloc(4); h.writeUInt32BE(b.length); return Buffer.concat([h, b]); };
  for (const s of ['{"t":"exec","cmd":"id"}', '{"t":"resize","cols":80,"rows":24,"tenant":"x"}', '{"t":"ready","pid":1,"version":"1","capabilities":{}}', '{"t":"input","data":"AA=="}', '{"t":"pause","t":"resume"}']) {
    const x = dec(); x.d.push(frame(s)); assert.strictEqual(x.errs.length, 1, s); assert.strictEqual(x.got.length, 0);
  }
  const x = dec(); const h = Buffer.alloc(4); h.writeUInt32BE(2); x.d.push(Buffer.concat([h, Buffer.from([0xff, 0xfe])])); assert.strictEqual(x.errs.length, 1);
});
test('assembly deadline fires for a stalled partial record', async () => {
  const { d, errs } = dec({ assemblyMs: 30 });
  d.push(A.subarray(0, 6));
  await new Promise((r) => setTimeout(r, 80));
  assert.strictEqual(errs[0].code, 'BRIDGE_ASSEMBLY_TIMEOUT');
});
test('decoder stops after a fatal error', () => {
  const { d, got } = dec(); d.push(Buffer.from([0, 0, 0, 0])); d.push(A); assert.strictEqual(got.length, 0);
});
