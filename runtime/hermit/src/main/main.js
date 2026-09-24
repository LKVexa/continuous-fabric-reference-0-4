'use strict';

/**
 * HERMIT — main process
 * ---------------------------------------------------------------------------
 * Owns the application window, hosts the embedded browser pane (a BrowserView
 * layered over the renderer), and bridges the renderer to the SPIRAL backend
 * kernel over IPC.
 *
 * Process model:
 *
 *   ┌────────────────────────────────────────────────────────────┐
 *   │ main process (Node)                                         │
 *   │   ├─ SpiralKernel   ── owns VFS, registry, sessions        │
 *   │   ├─ BrowserPane    ── BrowserView hosting VB-JA21 v9.8.7   │
 *   │   └─ IPC router      ── spiral:*  /  browser:*  channels    │
 *   └──────────────┬─────────────────────────────────────────────┘
 *                  │  contextBridge (preload.js)
 *   ┌──────────────┴─────────────────────────────────────────────┐
 *   │ renderer (sandboxed)                                        │
 *   │   ├─ VT engine (parser + screen + canvas renderer)         │
 *   │   └─ line discipline / input handling                      │
 *   └────────────────────────────────────────────────────────────┘
 *
 * The kernel emits raw byte streams (including ANSI/VT escape sequences); the
 * renderer's VT engine interprets them. That keeps the display contract identical
 * to a real PTY: the backend speaks ANSI, the frontend renders it.
 */

const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

const { SpiralKernel } = require('./spiral/kernel');
const { BrowserPane } = require('./browser-pane');
const guard = require('./ipc-guard');

const RENDERER_FILE = path.join(__dirname, '..', 'renderer', 'index.html');
const ownership = guard.createOwnership();

const IS_DEV = process.argv.includes('--dev');

/** @type {BrowserWindow|null} */
let win = null;
/** @type {SpiralKernel} */
let kernel = null;
/** @type {BrowserPane} */
let browserPane = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 720,
    minHeight: 420,
    backgroundColor: '#0c0f13',
    show: false,
    title: 'HERMIT — LK/Vexa',
    autoHideMenuBar: true,
    // LK/Vexa house chrome: frameless window, custom titlebar drawn by the renderer.
    frame: false,
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });

  win.loadFile(RENDERER_FILE);

  // The application window never navigates away from its own page and never opens child windows.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const wcId = win.webContents.id;
  win.webContents.on('destroyed', () => { for (const sid of ownership.releaseAll(wcId)) kernel && kernel.closeSession(sid); });

  win.once('ready-to-show', () => {
    win.show();
    if (IS_DEV) win.webContents.openDevTools({ mode: 'detach' });
  });

  browserPane = new BrowserPane(win);

  win.on('resize', () => browserPane.reflow());
  win.on('closed', () => {
    win = null;
    browserPane = null;
  });
}

/* --------------------------------------------------------------------------
 * SPIRAL <-> renderer wiring
 * ------------------------------------------------------------------------ */

function bootKernel() {
  kernel = new SpiralKernel({
    hostBridge: {
      // Commands running inside SPIRAL can drive the host through these hooks.
      openBrowser: (url) => browserPane && browserPane.show(url),
      closeBrowser: () => browserPane && browserPane.hide(),
      navigateBrowser: (url) => browserPane && browserPane.navigate(url),
      browserState: () => (browserPane ? browserPane.state() : { visible: false }),
      setTitle: (t) => win && win.setTitle(t ? `HERMIT — ${t}` : 'HERMIT'),
      version: () => app.getVersion()
    }
  });

  // Stream kernel output only to the renderer that owns the session (I041).
  kernel.on('data', ({ sessionId, chunk }) => {
    if (win && !win.isDestroyed() && ownership.owns(sessionId, win.webContents.id)) {
      win.webContents.send('spiral:data', { sessionId, chunk });
    }
  });
  kernel.on('exit', ({ sessionId, code, reason }) => {
    const mine = win && !win.isDestroyed() && ownership.owns(sessionId, win.webContents.id);
    ownership.release(sessionId);
    if (mine) win.webContents.send('spiral:exit', { sessionId, code, reason });
  });
}

function registerIpc() {
  /**
   * Every channel goes through one gate: trusted sender -> exact payload shape -> session ownership.
   * A rejected message is dropped (and logged once per channel in dev); it never reaches the kernel.
   */
  const gate = (channel, fn, { session = false } = {}) => (evt, payload) => {
    if (!guard.trustedSender(evt, win, RENDERER_FILE)) { if (IS_DEV) console.warn('[HERMIT] ipc: untrusted sender on', channel); return undefined; }
    if (!guard.validPayload(channel, payload)) { if (IS_DEV) console.warn('[HERMIT] ipc: invalid payload on', channel); return undefined; }
    if (session && !ownership.owns(guard.sessionIdOf(channel, payload), evt.sender.id)) return undefined;
    return fn(payload, evt);
  };
  const handle = (channel, fn, o) => ipcMain.handle(channel, gate(channel, fn, o));
  const on = (channel, fn, o) => ipcMain.on(channel, gate(channel, fn, o));

  // --- SPIRAL session lifecycle ---
  handle('spiral:open', (opts, evt) => {
    const res = kernel.openSession({ cols: opts.cols, rows: opts.rows, deferStart: opts.deferStart === true });
    ownership.claim(res.sessionId, evt.sender.id);
    return res;
  });
  on('spiral:start', (sessionId) => kernel.startSession(sessionId), { session: true });   // open barrier release (F10)
  handle('spiral:close', (sessionId) => kernel.closeSession(sessionId), { session: true });
  handle('spiral:resize', ({ sessionId, cols, rows }) => kernel.resize(sessionId, cols, rows), { session: true });
  on('spiral:input', ({ sessionId, data }) => kernel.write(sessionId, data), { session: true });
  on('spiral:signal', ({ sessionId, signal }) => kernel.signal(sessionId, signal), { session: true });
  handle('spiral:status', (sessionId) => kernel.status(sessionId), { session: true });

  // --- frameless window controls (custom titlebar) ---
  handle('win:minimize', () => win && win.minimize());
  handle('win:maximize', () => {
    if (!win) return false;
    if (win.isMaximized()) win.unmaximize(); else win.maximize();
    return win.isMaximized();
  });
  handle('win:close', () => win && win.close());
  handle('win:isMaximized', () => !!(win && win.isMaximized()));

  // --- Browser pane control from the UI chrome. Desktop capability of the owning renderer only. ---
  handle('browser:show', (url) => browserPane && browserPane.show(url));
  handle('browser:hide', () => browserPane && browserPane.hide());
  handle('browser:navigate', (url) => browserPane && browserPane.navigate(url));
  handle('browser:bounds', (bounds) => browserPane && browserPane.setDock(bounds));
  handle('browser:state', () => (browserPane ? browserPane.state() : { visible: false }));
}

/* --------------------------------------------------------------------------
 * app lifecycle
 * ------------------------------------------------------------------------ */

app.whenReady().then(() => {
  bootKernel();
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
