'use strict';

/**
 * HERMIT — preload bridge
 * ---------------------------------------------------------------------------
 * Runs in an isolated world with node integration disabled. Exposes a narrow,
 * explicitly-enumerated surface to the renderer via contextBridge. The renderer
 * never sees `require`, `ipcRenderer`, or any Node primitive directly.
 */

const { contextBridge, ipcRenderer } = require('electron');

/** Guarded event subscription that returns an unsubscribe function. */
function on(channel, handler) {
  const wrapped = (_evt, payload) => handler(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld('spiral', {
  /* session lifecycle */
  open: (opts) => ipcRenderer.invoke('spiral:open', opts),
  start: (sessionId) => ipcRenderer.send('spiral:start', sessionId),   // releases the open barrier
  close: (sessionId) => ipcRenderer.invoke('spiral:close', sessionId),
  resize: (sessionId, cols, rows) =>
    ipcRenderer.invoke('spiral:resize', { sessionId, cols, rows }),

  /* io */
  write: (sessionId, data) => ipcRenderer.send('spiral:input', { sessionId, data }),
  signal: (sessionId, signal) => ipcRenderer.send('spiral:signal', { sessionId, signal: signal === 'INT' ? 'SIGINT' : signal }),

  /* status (cwd, geometry, DF root, photon binding, node roster) */
  status: (sessionId) => ipcRenderer.invoke('spiral:status', sessionId),

  /* streams */
  onData: (handler) => on('spiral:data', handler),
  onExit: (handler) => on('spiral:exit', handler)
});

contextBridge.exposeInMainWorld('hermitWin', {
  minimize: () => ipcRenderer.invoke('win:minimize'),
  maximize: () => ipcRenderer.invoke('win:maximize'),
  close: () => ipcRenderer.invoke('win:close'),
  isMaximized: () => ipcRenderer.invoke('win:isMaximized')
});

contextBridge.exposeInMainWorld('hermitBrowser', {
  show: (url) => ipcRenderer.invoke('browser:show', url),
  hide: () => ipcRenderer.invoke('browser:hide'),
  navigate: (url) => ipcRenderer.invoke('browser:navigate', url),
  setDock: (bounds) => ipcRenderer.invoke('browser:bounds', bounds),
  state: () => ipcRenderer.invoke('browser:state')
});
