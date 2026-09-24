'use strict';

/**
 * HERMIT — renderer controller (LK/Vexa shell)
 * ---------------------------------------------------------------------------
 * Owns the frameless chrome: session tabs, the bracket-framed terminal viewport,
 * the browser pane dock, the live status bar and the DF fabric hub widget.
 * Each tab is an independent SPIRAL session with its own Screen + Parser; the
 * single CanvasRenderer paints whichever tab is active.
 *
 * Sandboxed: window.HermitVT (VT engine) plus ONE TerminalTransport object
 * (client/transport.js). The transport is the Electron IPC adapter in the LOCAL
 * desktop profile and the WebSocket adapter in the WEB profile; this controller
 * no longer touches window.spiral directly (series F01 / I031). No Node APIs.
 */

(function () {
  const { Screen, Parser, CanvasRenderer } = window.HermitVT;
  /** @type {object} TerminalTransport — installed by client/boot.js before this script runs. */
  const T = window.HermitTransport;
  const CAPS = T.capabilities || {};
  const A11Y = window.HermitVWS && window.HermitVWS.accessibility ? window.HermitVWS.accessibility() : { announce() {}, mirror() {} };

  const $ = (id) => document.getElementById(id);
  const canvas = $('screen');
  const termEl = $('terminal');
  const appEl = $('app');
  const tabsEl = $('tabs');
  const tabAdd = $('tab-add');
  const frameTitle = $('frame-title');
  const scrollHint = $('scrollhint');

  /* ─────────────────────────── sessions / tabs ─────────────────────────── */

  /** @type {Map<string, {id:string, screen:Screen, parser:Parser, title:string, el:HTMLElement, busy:boolean}>} */
  const tabs = new Map();
  let active = null;
  let tabSeq = 0;

  const painter = new CanvasRenderer(canvas, new Screen(80, 24));
  let needsRender = true;

  function scheduleRender() { needsRender = true; }
  (function frame() {
    if (needsRender) { painter.render(); needsRender = false; }
    requestAnimationFrame(frame);
  })();
  setInterval(() => { painter.cursorOn = !painter.cursorOn; scheduleRender(); }, 530);

  function currentGeometry() {
    const rect = termEl.getBoundingClientRect();
    const cs = getComputedStyle(termEl);
    const w = rect.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const h = rect.height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    const g = painter.fit(Math.max(10, w), Math.max(10, h));
    // Finite, integral, policy-bounded geometry BEFORE any allocation or transport call (F05 / I035).
    return window.HermitVWS.clampGeometry(g.cols, g.rows);
  }

  async function openTab(focus = true) {
    const { cols, rows } = currentGeometry();
    const screen = new Screen(cols, rows);
    const parser = new Parser(screen);
    const n = ++tabSeq;

    let res;
    try { res = await T.open({ cols, rows }); }
    catch (err) {
      // Boot failure is visible, never a blank terminal (I033).
      painter.screen = screen;
      parser.write(`\x1b[1;31m[could not open a session: ${String(err && err.message || err).replace(/[\x00-\x1f]/g, ' ')}]\x1b[0m\r\n`);
      A11Y.announce('Could not open a terminal session. ' + (err && err.message || ''));
      scheduleRender();
      if (window.HermitVWS.onOpenFailed) window.HermitVWS.onOpenFailed(err, () => openTab(focus));
      return null;
    }
    const id = res.sessionId;

    const el = document.createElement('button');
    el.className = 'tab';
    el.innerHTML = `<span class="idx">${String(n).padStart(2, '0')}</span><span class="name">session</span><span class="close" title="Close">✕</span>`;
    el.addEventListener('click', (e) => {
      if (e.target.classList.contains('close')) { closeTab(id); return; }
      activate(id);
    });
    tabsEl.insertBefore(el, tabAdd);

    const tab = { id, n, screen, parser, title: 'session', el, busy: false };
    tabs.set(id, tab);

    screen.onTitle = (t) => { tab.title = t || 'session'; el.querySelector('.name').textContent = tab.title; if (active === id) frameTitle.textContent = `SPIRAL // ${tab.title}`; };
    screen.onBell = () => { if (active === id) flashBell(); };

    if (focus || !active) activate(id);
    // Open barrier: the tab is registered and its parser exists; only now may output flow (F10 / I033).
    T.start(id);
    return tab;
  }

  function activate(id) {
    const tab = tabs.get(id);
    if (!tab) return;
    active = id;
    for (const t of tabs.values()) t.el.classList.toggle('active', t.id === id);
    painter.screen = tab.screen;
    painter.scrollToBottom();
    frameTitle.textContent = `SPIRAL // ${tab.title}`;
    relayout();
    canvas.focus();
  }

  async function closeTab(id) {
    const tab = tabs.get(id);
    if (!tab) return;
    try { await T.close(id); } catch { /* already gone */ }
    tab.el.remove();
    tabs.delete(id);
    if (active === id) {
      const next = [...tabs.keys()].pop();
      if (next) activate(next); else openTab(true);
    }
  }

  tabAdd.addEventListener('click', () => openTab(true));

  /* ─────────────────────────── sizing ─────────────────────────── */

  function relayout() {
    const { cols, rows } = currentGeometry();
    for (const t of tabs.values()) {
      if (cols !== t.screen.cols || rows !== t.screen.rows) {
        t.screen.resize(cols, rows);
        if (!t.closed) T.resize(t.id, cols, rows);
      }
    }
    $('st-geom').textContent = `${cols}×${rows}`;
    scheduleRender();
  }
  new ResizeObserver(() => relayout()).observe(termEl);

  function flashBell() {
    termEl.classList.add('bell');
    setTimeout(() => termEl.classList.remove('bell'), 140);
  }

  /* ─────────────────────────── input ─────────────────────────── */

  function send(data) {
    const tab = active && tabs.get(active);
    if (!tab || tab.closed) return;        // input to an ended session is not silently queued anywhere
    T.write(active, data);
  }

  const CSI = '\x1b[';
  function encodeKey(e) {
    const k = e.key;
    if (e.ctrlKey && !e.altKey && k.length === 1) {
      const c = k.toLowerCase().charCodeAt(0);
      if (c >= 97 && c <= 122) return String.fromCharCode(c - 96);
      if (k === ' ') return '\x00';
    }
    switch (k) {
      case 'Enter': return '\r';
      case 'Backspace': return '\x7f';
      case 'Tab': return '\t';
      case 'Escape': return '\x1b';
      case 'ArrowUp': return CSI + 'A';
      case 'ArrowDown': return CSI + 'B';
      case 'ArrowRight': return CSI + 'C';
      case 'ArrowLeft': return CSI + 'D';
      case 'Home': return CSI + 'H';
      case 'End': painter.scrollToBottom(); updateScrollHint(); return CSI + 'F';
      case 'Delete': return CSI + '3~';
      case 'PageUp': painter.scrollBy(painter.screen.rows - 1); updateScrollHint(); scheduleRender(); return null;
      case 'PageDown': painter.scrollBy(-(painter.screen.rows - 1)); updateScrollHint(); scheduleRender(); return null;
      default:
        if (k.length === 1 && !e.metaKey && !e.ctrlKey) return k;
        return null;
    }
  }

  document.addEventListener('keydown', (e) => {
    if (e.target && e.target.tagName === 'INPUT') return;
    if (e.isComposing || e.keyCode === 229) return; // IME composition in progress: text arrives on compositionend
    // chrome shortcuts
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 't') { e.preventDefault(); openTab(true); return; }
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'w') { e.preventDefault(); if (active) closeTab(active); return; }
    if (e.ctrlKey && e.key === 'Tab') {
      e.preventDefault();
      const ids = [...tabs.keys()]; const i = ids.indexOf(active);
      activate(ids[(i + (e.shiftKey ? -1 : 1) + ids.length) % ids.length]); return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'c' && window.getSelection().toString()) return;
    const data = encodeKey(e);
    if (data !== null) { e.preventDefault(); painter.scrollToBottom(); updateScrollHint(); send(data); }
  });

  // IME / dead keys / mobile keyboards: committed text is sent once, on compositionend.
  document.addEventListener('compositionend', (e) => {
    if (e.target && e.target.tagName === 'INPUT') return;
    if (e.data) { painter.scrollToBottom(); send(e.data); }
    if (e.target && 'value' in e.target) e.target.value = '';
  });

  document.addEventListener('paste', (e) => {
    if (e.target && e.target.tagName === 'INPUT') return;
    const text = (e.clipboardData || window.clipboardData).getData('text');
    // Bounded paste: the transport chunks to its message limit; an absurd clipboard is refused, not truncated silently.
    if (text && text.length > 262144) { e.preventDefault(); flashBell(); A11Y.announce('Paste refused: larger than 256 KB.'); return; }
    if (text) { e.preventDefault(); send(text.replace(/\r?\n/g, '\r')); }
  });

  termEl.addEventListener('wheel', (e) => {
    painter.scrollBy(e.deltaY > 0 ? -3 : 3);
    updateScrollHint();
    scheduleRender();
    e.preventDefault();
  }, { passive: false });

  function updateScrollHint() { scrollHint.hidden = painter.scrollOffset === 0; }

  // Text entry surface: a visually hidden textarea holds focus so that IME composition, dead keys,
  // on-screen/mobile keyboards and programmatic text insertion all reach the terminal (I035).
  const ime = $('ime');
  const focusInput = () => { if (ime) ime.focus({ preventScroll: true }); else canvas.focus(); };
  canvas.focus = focusInput;
  termEl.addEventListener('mousedown', (e) => { e.preventDefault(); focusInput(); });
  canvas.tabIndex = -1;
  if (ime) ime.addEventListener('input', (e) => {
    if (e.isComposing) return;                 // committed on compositionend
    const v = ime.value; ime.value = '';
    if (v) { painter.scrollToBottom(); updateScrollHint(); send(v.replace(/\r?\n/g, '\r')); }
  });

  /* ─────────────────────────── window controls ─────────────────────────── */

  if (!CAPS.windowControls) { const wc = document.querySelector('.wincontrols'); if (wc) wc.hidden = true; }
  if (window.hermitWin && CAPS.windowControls) {
    $('win-min').addEventListener('click', () => window.hermitWin.minimize());
    $('win-max').addEventListener('click', async () => {
      const max = await window.hermitWin.maximize();
      $('win-max').innerHTML = max ? '&#x2750;' : '&#x25A1;';
    });
    $('win-close').addEventListener('click', () => window.hermitWin.close());
  }

  /* ─────────────────────────── browser pane ─────────────────────────── */

  const urlInput = $('url');
  const btnToggle = $('btn-browser');
  let browserVisible = false;
  // The browser pane is a LOCAL desktop capability. In the WEB profile it is reported as unavailable,
  // never emulated, and a remote session can never drive it (I042).
  const HAS_BROWSER = !!(CAPS.browserPane && window.hermitBrowser);
  if (!HAS_BROWSER) { const om = document.querySelector('.omni'); if (om) om.hidden = true; }

  async function showBrowser(url) {
    appEl.classList.add('split');
    await window.hermitBrowser.setDock({ xPct: 0.5, yPct: 0.0, wPct: 0.5, hPct: 1.0 });
    await window.hermitBrowser.show(url || urlInput.value || 'about:blank');
    browserVisible = true; btnToggle.classList.add('on'); relayout();
  }
  async function hideBrowser() {
    await window.hermitBrowser.hide();
    appEl.classList.remove('split');
    browserVisible = false; btnToggle.classList.remove('on'); relayout();
  }
  if (HAS_BROWSER) btnToggle.addEventListener('click', () => (browserVisible ? hideBrowser() : showBrowser()));
  if (HAS_BROWSER) urlInput.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      if (!browserVisible) await showBrowser(urlInput.value);
      else await window.hermitBrowser.navigate(urlInput.value);
    }
  });

  async function pollBrowser() {
    try {
      const st = await window.hermitBrowser.state();
      if (st.visible && !browserVisible) { appEl.classList.add('split'); browserVisible = true; btnToggle.classList.add('on'); relayout(); }
      if (!st.visible && browserVisible) { appEl.classList.remove('split'); browserVisible = false; btnToggle.classList.remove('on'); relayout(); }
      if (st.url && document.activeElement !== urlInput) urlInput.value = st.url;
      if (st.engine) $('browser-title').textContent = `${st.engine} // browser`;
    } catch { /* ignore */ }
  }
  if (HAS_BROWSER) setInterval(pollBrowser, 800);

  /* ─────────────────────────── status bar + hub ─────────────────────────── */

  const hub = $('hub');
  async function pollStatus() {
    if (!active) return;
    let st;
    try { st = await T.status(active); } catch { return; }
    if (!st) return;
    $('st-session').innerHTML = '<i class="k">session</i> ';
    $('st-session').appendChild(document.createTextNode(String(st.sessionId)));
    $('st-cwd').textContent = st.remote ? st.connection + (st.unacknowledgedInputs ? ` · ${st.unacknowledgedInputs} unacked` : '') : st.cwd;
    if (st.remote) { hub.style.display = 'none'; $('st-nodes').textContent = st.fabric ? 'fabric: on' : 'fabric: off'; $('st-dfroot').textContent = 'remote'; $('st-photon').style.display = 'none'; const tabR = tabs.get(active); if (tabR) tabR.busy = false; return; }
    const tab = tabs.get(active);
    if (tab) { tab.busy = st.busy; tab.el.classList.toggle('busy', st.busy); }

    // DF fabric hub
    const built = st.nodes.filter((n) => n.built).length;
    const present = st.nodes.filter((n) => n.present).length;
    hub.classList.toggle('unbound', !st.dfRoot);
    for (const n of st.nodes) {
      const el = hub.querySelector(`[data-node="${n.key}"]`);
      if (!el) continue;
      el.classList.toggle('present', n.present);
      el.classList.toggle('built', n.built);
      el.setAttribute('title', `${n.node} — ${!n.present ? 'absent' : n.built ? 'built' : 'not built'}`);
    }
    $('st-nodes').textContent = st.dfRoot ? `${built}/${present} built` : '—/4';
    const df = $('st-dfroot');
    df.textContent = st.dfRoot ? 'df: ' + shorten(st.dfRoot, 34) : 'df: unbound';
    df.title = st.dfRoot || 'bind with: df use <path>';

    // photon
    const ph = $('st-photon');
    ph.classList.toggle('on', !!(st.photon && st.photon.url && st.photon.token));
    ph.classList.toggle('warn', !!(st.photon && st.photon.url && !st.photon.token));
    ph.innerHTML = `<span class="pdot"></span> photon${st.photon && st.photon.url ? ' · ' + shorten(st.photon.url.replace(/^https?:\/\//, ''), 22) : ''}`;
  }
  setInterval(pollStatus, 1000);

  function shorten(s, n) { return s.length > n ? '…' + s.slice(-(n - 1)) : s; }

  /* ─────────────────────────── streams / boot ─────────────────────────── */

  let mirrorTimer = null;
  function scheduleMirror() {
    if (mirrorTimer) return;
    mirrorTimer = setTimeout(() => { mirrorTimer = null; const tab = active && tabs.get(active); if (tab) A11Y.mirror(tab.screen); }, 400);
  }

  T.onData(({ sessionId, chunk }) => {
    const tab = tabs.get(sessionId);
    if (!tab) return;
    tab.parser.write(chunk);
    if (sessionId === active) { painter.scrollToBottom(); updateScrollHint(); scheduleRender(); scheduleMirror(); }
  });
  T.onExit(({ sessionId, code, reason }) => {
    const tab = tabs.get(sessionId);
    if (!tab) return;
    tab.closed = true;
    const why = reason && reason !== 'closed' ? ` · ${String(reason).replace(/[^a-z_]/gi, '')}` : '';
    tab.parser.write(`\r\n\x1b[2m[session closed${why}${code ? ' · exit ' + (code | 0) : ''}]\x1b[0m\r\n`);
    tab.el.classList.add('closed');
    A11Y.announce('Terminal session closed' + (reason ? ': ' + reason : ''));
    if (sessionId === active) scheduleRender();
  });
  if (T.onState) T.onState(({ sessionId, state, detail }) => {
    const tab = tabs.get(sessionId);
    const chip = $('st-conn');
    if (chip && sessionId === active) { chip.textContent = state; chip.dataset.state = state; chip.title = detail || ''; }
    if (tab) tab.el.classList.toggle('reconnecting', state === 'reconnecting');
    if (state !== 'active') A11Y.announce(`Connection ${state}${detail ? ': ' + detail : ''}`);
    if (tab && detail && (state === 'error' || state === 'draining' || state === 'input-dropped' || state === 'reconnecting')) {
      tab.parser.write(`\r\n\x1b[33m[${state}: ${String(detail).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 200)}]\x1b[0m\r\n`);
      if (sessionId === active) scheduleRender();
    }
  });

  (async function boot() {
    relayout();
    await openTab(true);
    pollStatus();
  })();
})();
