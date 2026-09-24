'use strict';

/**
 * HERMIT — BrowserPane
 * ---------------------------------------------------------------------------
 * A dockable web surface layered over the terminal. It hosts the VB-JA21
 * v9.8.7 browser bundle when present, and otherwise falls back to a plain
 * Electron BrowserView so the pane is always functional.
 *
 * ── Integration contract (VB-JA21 v9.8.7) ──────────────────────────────────
 * Drop your browser build into  vendor/browser/  with an entry that exports an
 * adapter conforming to ./browser-adapter.js  (see that file for the interface
 * and a working reference implementation). The pane auto-detects it at runtime;
 * no code changes here are required.
 */

const path = require('node:path');
const fs = require('node:fs');
const { BrowserView } = require('electron');

const DEFAULT_DOCK = { xPct: 0.5, yPct: 0.0, wPct: 0.5, hPct: 1.0 };

class BrowserPane {
  /** @param {import('electron').BrowserWindow} win */
  constructor(win) {
    this.win = win;
    this.view = null;
    this.visible = false;
    this.dock = { ...DEFAULT_DOCK };
    this.currentUrl = 'about:blank';
    this.adapter = this._loadAdapter();
  }

  /* ---- adapter discovery ------------------------------------------------- */

  _loadAdapter() {
    // 1) A vendored bundle takes priority. Packaged builds place `vendor/browser` under
    //    <resources>/browser (electron-builder extraResources), development keeps it in the repo (F14 / I043).
    const candidates = [];
    if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'browser', 'index.js'));
    candidates.push(path.join(__dirname, '..', '..', 'vendor', 'browser', 'index.js'));
    for (const vendored of candidates) {
      try {
        if (!fs.existsSync(vendored)) continue;
        const mod = require(vendored);
        const make = mod.createAdapter || mod.default || mod;
        if (typeof make !== 'function') continue;
        const adapter = make();
        if (adapter && typeof adapter.attach === 'function' && typeof adapter.navigate === 'function' && typeof adapter.resolveUrl === 'function') {
          this.engineSource = vendored;
          return adapter;
        }
      } catch (err) {
        console.warn('[HERMIT] vendored browser adapter failed to load:', err.message);
      }
    }
    // 2) Built-in fallback adapter. Its name says what it is: no VB-JA21 engine is claimed (F15).
    const { createFallbackAdapter } = require('./browser-adapter');
    this.engineSource = 'builtin-fallback';
    return createFallbackAdapter();
  }

  /* ---- geometry ---------------------------------------------------------- */

  reflow() {
    if (!this.view || !this.visible) return;
    const [w, h] = this.win.getContentSize();
    this.view.setBounds({
      x: Math.round(w * this.dock.xPct),
      y: Math.round(h * this.dock.yPct),
      width: Math.round(w * this.dock.wPct),
      height: Math.round(h * this.dock.hPct)
    });
  }

  setDock(bounds) {
    this.dock = { ...DEFAULT_DOCK, ...(bounds || {}) };
    this.reflow();
    return this.state();
  }

  /* ---- lifecycle --------------------------------------------------------- */

  _ensureView() {
    if (this.view) return;
    this.view = new BrowserView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        partition: 'persist:hermit-browser'
      }
    });
    this.adapter.attach(this.view, {
      onNavigate: (url) => { this.currentUrl = url; }
    });
  }

  show(url) {
    this._ensureView();
    this.win.setBrowserView(this.view);
    this.visible = true;
    this.reflow();
    if (url) this.navigate(url);
    return this.state();
  }

  hide() {
    if (this.view) this.win.removeBrowserView(this.view);
    this.visible = false;
    return this.state();
  }

  navigate(url) {
    this._ensureView();
    const { isAllowedUrl } = require('./nav-policy');
    const target = this.adapter.resolveUrl(url);
    // The pane enforces the policy even if a vendored adapter resolves more liberally.
    if (!isAllowedUrl(target, this.adapter.internalSchemes || [])) return { ...this.state(), refused: true };
    this.currentUrl = target;
    this.adapter.navigate(target);
    return this.state();
  }

  state() {
    return {
      visible: this.visible,
      url: this.currentUrl,
      engine: this.adapter.name,
      engineSource: this.engineSource === 'builtin-fallback' ? 'builtin-fallback' : 'vendored',
      dock: this.dock
    };
  }
}

module.exports = { BrowserPane };
