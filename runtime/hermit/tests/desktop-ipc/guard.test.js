'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const g = require('../../src/main/ipc-guard');
const nav = require('../../src/main/nav-policy');

const file = path.resolve('/app/src/renderer/index.html');
const wc = { id: 7 }; const win = { webContents: wc, isDestroyed: () => false };
const evt = (o = {}) => ({ sender: wc, senderFrame: { url: pathToFileURL(file).href, parent: null }, ...o });

test('sender: only the top-level frame of our window, loaded from our renderer file', () => {
  assert.strictEqual(g.trustedSender(evt(), win, file), true);
  assert.strictEqual(g.trustedSender(evt({ sender: { id: 9 } }), win, file), false, 'another webContents (e.g. the browser pane)');
  assert.strictEqual(g.trustedSender(evt({ senderFrame: { url: 'https://evil.example/', parent: null } }), win, file), false);
  assert.strictEqual(g.trustedSender(evt({ senderFrame: { url: pathToFileURL(file).href, parent: {} } }), win, file), false, 'sub-frame');
  assert.strictEqual(g.trustedSender(evt({ senderFrame: { url: pathToFileURL('/app/src/renderer/other.html').href, parent: null } }), win, file), false);
  assert.strictEqual(g.trustedSender(evt({ senderFrame: null }), win, file), false);
  assert.strictEqual(g.trustedSender(evt(), { webContents: wc, isDestroyed: () => true }, file), false);
});
test('payload shapes: geometry, ids, input size, signals, dock bounds, unknown channels', () => {
  assert.ok(g.validPayload('spiral:open', { cols: 80, rows: 24, deferStart: true }));
  for (const bad of [{ cols: -3, rows: 0 }, { cols: 80, rows: 24, extra: 1 }, { cols: '80', rows: 24 }, null, 'x']) assert.ok(!g.validPayload('spiral:open', bad));
  assert.ok(g.validPayload('spiral:input', { sessionId: 's1', data: 'ls\r' })); assert.ok(!g.validPayload('spiral:input', { sessionId: 's1', data: 'x'.repeat(65537) }));
  assert.ok(!g.validPayload('spiral:input', { sessionId: '__proto__', data: '' })); assert.ok(!g.validPayload('spiral:input', { sessionId: 's1', data: Buffer.from('x') }));
  assert.ok(g.validPayload('spiral:signal', { sessionId: 's2', signal: 'SIGINT' })); assert.ok(!g.validPayload('spiral:signal', { sessionId: 's2', signal: 'SIGKILL' }));
  assert.ok(!g.validPayload('spiral:resize', { sessionId: 's1', cols: 1e9, rows: 1 }));
  assert.ok(g.validPayload('browser:bounds', { xPct: 0.5, yPct: 0, wPct: 0.5, hPct: 1 })); assert.ok(!g.validPayload('browser:bounds', { xPct: 5, yPct: 0, wPct: 0.5, hPct: 1 }));
  assert.ok(!g.validPayload('spiral:exec', {})); assert.ok(!g.validPayload('win:close', { anything: 1 }));
});
test('ownership: a renderer can only address sessions it opened; teardown releases them', () => {
  const o = g.createOwnership(); o.claim('s1', 7); o.claim('s2', 8);
  assert.ok(o.owns('s1', 7)); assert.ok(!o.owns('s2', 7)); assert.ok(!o.owns('s404', 7));
  assert.deepStrictEqual(o.releaseAll(7), ['s1']); assert.strictEqual(o.size(), 1);
});
test('navigation policy: deny by default', () => {
  for (const ok of ['https://example.com/a?b=1', 'http://localhost:3000/', 'about:blank']) assert.ok(nav.isAllowedUrl(ok), ok);
  for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,<script>1</script>', 'blob:https://x/1', 'chrome://settings', 'devtools://x', 'view-source:https://x', 'ms-msdt:/id', 'vbja21://home', 'https://user:pw@example.com/', 'about:config', 'x'.repeat(3000), '', null]) assert.ok(!nav.isAllowedUrl(bad), String(bad).slice(0, 40));
  assert.ok(nav.isAllowedUrl('vbja21://home', ['vbja21']), 'only when the vendored adapter declares it');
  assert.deepStrictEqual(nav.resolveNavigation('example.com'), { ok: true, url: 'https://example.com' });
  assert.deepStrictEqual(nav.resolveNavigation('localhost:8080/x'), { ok: true, url: 'http://localhost:8080/x' });
  assert.match(nav.resolveNavigation('how do sockets work').url, /^https:\/\/duckduckgo\.com\/\?q=how%20do/);
  assert.strictEqual(nav.resolveNavigation('file:///C:/Windows/win.ini').ok, false); assert.strictEqual(nav.resolveNavigation('JaVaScRiPt:alert(1)').ok, false);
});
