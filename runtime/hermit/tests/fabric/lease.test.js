'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLease } = require('../../worker/fabric-lease');
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vws-lease-'));

test('N slots admit N holders; the next waits, then times out as busy; release admits it', async () => {
  const d = dir(); const acquire = createLease({ dir: d, slots: 2, waitMs: 300, pollMs: 20 });
  const r1 = await acquire('run'), r2 = await acquire('run');
  await assert.rejects(acquire('run'), /busy/);
  r1(); r1(); // idempotent
  const r3 = await acquire('verify'); r2(); r3();
  assert.deepStrictEqual(fs.readdirSync(d), []);
});
test('build is exclusive and never holds a partial set while waiting', async () => {
  const d = dir(); const acquire = createLease({ dir: d, slots: 2, waitMs: 250, pollMs: 20 });
  const r = await acquire('run');
  await assert.rejects(acquire('build'), /busy/);
  assert.strictEqual(fs.readdirSync(d).length, 1, 'the waiting builder left no slot behind');
  r(); const b = await acquire('build'); await assert.rejects(acquire('run'), /busy/); b();
});
test('abort while waiting rejects promptly; stale slot of a dead pid is reclaimed', async () => {
  const d = dir(); const acquire = createLease({ dir: d, slots: 1, waitMs: 5000, pollMs: 20 });
  const r = await acquire('run'); const ac = new AbortController(); setTimeout(() => ac.abort(), 60);
  await assert.rejects(acquire('run', ac.signal), /interrupted/); r();
  fs.mkdirSync(path.join(d, 'slot-0')); fs.writeFileSync(path.join(d, 'slot-0', 'owner'), '2147483646');
  const r2 = await acquire('run'); r2();
});
