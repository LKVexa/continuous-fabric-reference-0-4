'use strict';
/** Real Chromium against the real gateway: web client boot, sign-in, CSP, typing, fabric, reconnect, a11y. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { startGateway, DF_ROOT, sleep } = require('../helpers');
let chromium; try { ({ chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')); } catch { /* optional */ }
const opts = { skip: chromium ? false : 'playwright not installed', timeout: 180000 };
const SHOTS = path.join(__dirname, '..', '..', 'e', 'I055'); fs.mkdirSync(SHOTS, { recursive: true });
const screenText = (page) => page.evaluate(() => document.getElementById('a11y-screen').textContent);
async function waitText(page, re, ms = 20000) { const end = Date.now() + ms; for (;;) { const t = await screenText(page); if (re.test(t)) return t; if (Date.now() > end) throw new Error('screen never matched ' + re + '\n' + t.slice(-600)); await sleep(150); } }

test('web client in Chromium: sign-in -> terminal -> commands -> fabric run -> reconnect as NEW session', opts, async () => {
  const hasDf = fs.existsSync(path.join(DF_ROOT, 'DF_Fabric'));
  const g = await startGateway({ fabric: hasDf, dfRoot: hasDf ? DF_ROOT : null, fabricBuild: false });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  try {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    const problems = []; const wsUrls = [];
    page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
    page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
    page.on('websocket', (ws) => wsUrls.push(ws.url()));
    const res = await page.goto(g.http + '/');
    const csp = res.headers()['content-security-policy']; assert.match(csp, /default-src 'none'/); assert.match(csp, /frame-ancestors 'none'/);
    await page.waitForSelector('#signin:not([hidden])');
    await page.screenshot({ path: path.join(SHOTS, '01-signin.png') });
    await page.fill('#signin-token', 'x'.repeat(43)); await page.click('#signin button');
    await page.waitForFunction(() => /rejected/.test(document.getElementById('signin-msg').textContent));
    await page.fill('#signin-token', g.tokens.alice); await page.click('#signin button');
    await waitText(page, /HERMIT[\s\S]*›/);
    assert.strictEqual(await page.evaluate(() => document.getElementById('st-conn').textContent), 'active');
    assert.ok(wsUrls.length === 1 && !wsUrls[0].includes('?'), 'no credential or ticket in the WebSocket URL');
    assert.strictEqual(await page.evaluate(() => document.cookie), '', 'ticket cookie is HttpOnly and already cleared');
    assert.strictEqual(await page.evaluate((t) => JSON.stringify([Object.keys(localStorage), Object.keys(sessionStorage)]).includes(t) || document.documentElement.outerHTML.includes(t), g.tokens.alice), false, 'token is not persisted or placed in the DOM');
    assert.ok(await page.evaluate(() => document.querySelector('.omni').hidden && !document.querySelector('.wincontrols')), 'desktop-only chrome is absent');

    await page.click('#screen');
    await page.keyboard.type('echo héllo-✓-$USER | rev'); await page.keyboard.press('Enter');
    await waitText(page, /rotarepo-✓-olléh/);
    await page.keyboard.type('ech'); await page.keyboard.press('Tab'); await page.keyboard.type('tabbed'); await page.keyboard.press('Enter'); await waitText(page, /\ntabbed/);
    await page.keyboard.type('sleep 60'); await page.keyboard.press('Enter'); await sleep(300); await page.keyboard.press('Control+c');
    await page.keyboard.type('echo rc=$?'); await page.keyboard.press('Enter'); await waitText(page, /rc=130/);
    // paste with newlines -> multiple commands, in order
    await page.evaluate(() => { const dt = new DataTransfer(); dt.setData('text', 'echo p1\necho p2\n'); document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); });
    const t = await waitText(page, /\np2/); assert.ok(t.indexOf('\np1') < t.indexOf('\np2'));
    if (hasDf) {
      await page.keyboard.type('clear'); await page.keyboard.press('Enter');
      await page.keyboard.type('fabric run 01_bell_pair.pal --programs replica'); await page.keyboard.press('Enter');
      await waitText(page, /"verdict": "CROSS_NODE_DIFFERENTIAL_AGREEMENT"/, 120000);
      await page.screenshot({ path: path.join(SHOTS, '02-fabric-run.png') });
    }
    await page.setViewportSize({ width: 900, height: 500 }); await sleep(400);
    await page.keyboard.type('clear'); await page.keyboard.press('Enter'); await page.keyboard.type('echo geom-ok'); await page.keyboard.press('Enter'); await waitText(page, /geom-ok/);
    const geom = await page.evaluate(() => document.getElementById('st-geom').textContent); const conn = [...g.gw.registry.conns][0];
    await sleep(300); assert.match(geom, /^\d+×\d+$/);

    // transport loss (not an orderly exit): client reconnects with a fresh ticket into a NEW session and says so
    await page.evaluate(() => { window.__states = []; window.HermitTransport.onState((e) => window.__states.push(e)); });
    await page.keyboard.type('sleep 5'); await page.keyboard.press('Enter'); await sleep(300);   // one input accepted, not completed
    conn.ws.terminate(1006, 'test');
    await waitText(page, /reconnected: this is a NEW session/, 30000);
    const states = await page.evaluate(() => window.__states);
    const reset = states.find((e) => e.state === 'reset'); assert.ok(reset, JSON.stringify(states)); assert.strictEqual(reset.outcome, 'OUTCOME_UNKNOWN'); assert.strictEqual(reset.detail, 'session_not_found');
    assert.ok(states.some((e) => e.state === 'reconnecting'));
    await page.keyboard.type('echo after-reconnect'); await page.keyboard.press('Enter'); await waitText(page, /\nafter-reconnect/);
    assert.strictEqual(wsUrls.length, 2);
    const st = await page.evaluate(() => window.HermitTransport.status([...window.HermitTransport._debug.tabs.keys()][0])); assert.strictEqual(st.unacknowledgedInputs, 0); assert.ok(st.creditRemaining > 0); assert.ok(st.epoch);
    const live = await page.evaluate(() => document.getElementById('a11y-status').getAttribute('aria-live')); assert.strictEqual(live, 'polite');
    await page.screenshot({ path: path.join(SHOTS, '03-reconnected.png') });
    assert.deepStrictEqual(problems.filter((p) => !/401|Failed to load resource/.test(p)), [], 'no console errors / CSP violations');
  } finally { await browser.close(); await g.stop(); }
});
