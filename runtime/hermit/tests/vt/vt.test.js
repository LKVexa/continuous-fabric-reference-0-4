'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load() {
  const ctx = { window: {} }; vm.createContext(ctx);
  for (const f of ['screen.js', 'parser.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../../src/renderer/vt', f), 'utf8'), ctx, { timeout: 2000 });
  return ctx.window.HermitVT;
}
const VT = load();
const mk = (c = 20, r = 5) => { const s = new VT.Screen(c, r); const titles = []; s.onTitle = (t) => titles.push(t); return { s, p: new VT.Parser(s), titles, row: (y) => s.grid[y].map((c) => c.ch).join('').trimEnd() }; };

test('F06 unterminated OSC retention is bounded and a truncated string is never dispatched', () => {
  const t = mk(); t.p.write('\x1b]0;' + 'a'.repeat(200000)); assert.ok(t.p.osc.length <= 4096);
  t.p.write('\x07'); assert.deepStrictEqual(t.titles, []); t.p.write('ok'); assert.strictEqual(t.row(0), 'ok');
});
test('F07 OSC: BEL and ESC \\ terminate; ESC + other byte aborts WITHOUT dispatch and the new sequence still executes', () => {
  let t = mk(); t.p.write('\x1b]0;one\x07'); t.p.write('\x1b]2;two\x1b\\'); assert.deepStrictEqual(t.titles, ['one', 'two']);
  t = mk(); t.p.write('\x1b]0;evil\x1b[31mX'); assert.deepStrictEqual(t.titles, []); assert.strictEqual(t.row(0), 'X'); assert.strictEqual(t.s.grid[0][0].fg, 1);
  t = mk(); t.p.write('\x1b]0;split'); t.p.write('\x1b'); t.p.write('\\'); assert.deepStrictEqual(t.titles, ['split']);   // ST split across chunks
});
test('titles are capped and stripped of control characters; OSC 52/8 are not implemented', () => {
  const t = mk(); t.p.write('\x1b]0;' + 'T'.repeat(1000) + '\x07'); assert.strictEqual(t.titles[0].length, 256);
  t.p.write('\x1b]52;c;aGVsbG8=\x07\x1b]8;;http://x\x07'); assert.strictEqual(t.titles.length, 1);
});
test('hostile CSI counts terminate immediately (renderer DoS): 999999999 for @ P L M S T X', () => {
  const t = mk(80, 24); const t0 = Date.now();
  for (const f of '@PLMSTX') t.p.write(`\x1b[999999999${f}`);
  t.p.write('\x1b[999999999;999999999H\x1b[999999999A\x1b[999999999C');
  assert.ok(Date.now() - t0 < 500, `took ${Date.now() - t0} ms`); assert.ok(t.s.cursor.x < 80 && t.s.cursor.y < 24);
});
test('over-long CSI parameters / intermediates abort and recover; ESC inside CSI restarts; C0 executes inside CSI', () => {
  const t = mk(); t.p.write('\x1b[' + '1;'.repeat(5000) + 'mA'); assert.ok(t.p.params.length <= 64); assert.strictEqual(t.row(0), 'A', 'the over-long sequence was swallowed, not printed, and not applied'); assert.strictEqual(t.s.grid[0][0].bold, false);
  const u = mk(); u.p.write('\x1b[3\x1b[1mZ'); assert.strictEqual(u.row(0), 'Z'); assert.strictEqual(u.s.grid[0][0].bold, true);
  const w = mk(); w.p.write('ab\x1b[1\rC'); assert.ok(w.row(0).length > 0);
});
test('parser state persists across arbitrary chunk boundaries (every split point of a mixed stream)', () => {
  const stream = 'hi\x1b[1;31mred\x1b[0m\r\n\x1b]0;title\x1b\\\x1b[2;3Hx\x1b[38;5;44mc\x1b[38;2;1;2;3mt\x1bPignored\x1b\\end';
  const ref = mk(); ref.p.write(stream); const want = JSON.stringify([ref.s.grid, ref.s.cursor, ref.titles]);
  for (let i = 1; i < stream.length; i++) { const t = mk(); t.p.write(stream.slice(0, i)); t.p.write(stream.slice(i)); assert.strictEqual(JSON.stringify([t.s.grid, t.s.cursor, t.titles]), want, `split at ${i}`); }
  const one = mk(); for (const ch of stream) one.p.write(ch); assert.strictEqual(JSON.stringify([one.s.grid, one.s.cursor, one.titles]), want);
});
test('F08 scrollback bound holds on the resize path and the scroll path; total-cell budget holds for wide screens', () => {
  const s = new VT.Screen(4, 24);
  for (let i = 0; i < Math.ceil(VT.MAX_SCROLLBACK / 23) + 5; i++) { s.resize(4, 1); s.resize(4, 24); }
  assert.ok(s.scrollback.length <= VT.MAX_SCROLLBACK, String(s.scrollback.length));
  const w = new VT.Screen(400, 10); const p = new VT.Parser(w); for (let i = 0; i < 7000; i++) p.write('x\r\n');
  assert.ok(w.scrollback.length <= VT.MAX_SCROLLBACK); assert.ok(w.scrollbackCells <= VT.MAX_SCROLLBACK_CELLS);
  assert.strictEqual(w.scrollbackCells, w.scrollback.reduce((a, r) => a + r.length, 0));
});
test('geometry is clamped before allocation (constructor and resize)', () => {
  const s = new VT.Screen(1e9, 1e9); assert.deepStrictEqual([s.cols, s.rows], [400, 200]);
  s.resize(-5, 0); assert.deepStrictEqual([s.cols, s.rows], [1, 1]); s.resize(NaN, Infinity); assert.ok(s.cols >= 1 && s.rows >= 1);
});
test('random byte soup never throws and never escapes bounds', () => {
  const t = mk(40, 10); let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const alphabet = ['\x1b', '[', ']', 'P', '\\', ';', '?', '9', '0', 'm', 'H', 'J', 'K', 'L', 'M', '@', 'r', 'S', 'T', '\x07', '\r', '\n', '\t', '\b', 'a', 'é', '✓', '\u{1F600}', '\x9b', '\x9c', '\x18'];
  for (let k = 0; k < 400; k++) { let s = ''; const n = 1 + Math.floor(rnd() * 200); for (let i = 0; i < n; i++) s += alphabet[Math.floor(rnd() * alphabet.length)]; t.p.write(s); }
  assert.ok(t.s.cursor.x >= 0 && t.s.cursor.x < 40 && t.s.cursor.y >= 0 && t.s.cursor.y < 10);
  assert.strictEqual(t.s.grid.length, 10); assert.ok(t.s.grid.every((r) => r.length === 40)); assert.ok(t.p.osc.length <= 4096 && t.p.params.length <= 64);
});
