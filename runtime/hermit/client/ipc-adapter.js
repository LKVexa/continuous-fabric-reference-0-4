/** LOCAL profile adapter: Electron preload bridge (window.spiral) behind the TerminalTransport contract. */
(function (root) {
  'use strict';
  const V = root.HermitVWS;
  function IpcTransport(bridge) {
    const data = V.emitter(), exit = V.emitter(), state = V.emitter();
    const barrier = V.openBarrier((sessionId, chunk) => data.emit({ sessionId, chunk }));
    const known = new Set();
    bridge.onData(({ sessionId, chunk }) => { if (known.has(sessionId)) barrier.push(sessionId, chunk); else early.push({ sessionId, chunk }); });
    bridge.onExit((e) => { known.delete(e.sessionId); barrier.drop(e.sessionId); exit.emit(e); });
    // Output can overtake the `open` reply on a different IPC channel (F10); keep it, bounded, until the id is known.
    const early = [];
    return {
      capabilities: { browserPane: !!root.hermitBrowser, windowControls: !!root.hermitWin, fabricHub: true, remote: false },
      async open(opts) {
        const g = V.clampGeometry(opts && opts.cols, opts && opts.rows);
        const res = await bridge.open({ cols: g.cols, rows: g.rows, deferStart: true });
        known.add(res.sessionId); barrier.hold(res.sessionId);
        for (let i = 0; i < early.length;) { if (early[i].sessionId === res.sessionId) barrier.push(res.sessionId, early.splice(i, 1)[0].chunk); else i++; }
        if (early.length > 256) early.splice(0, early.length - 256);
        return res;
      },
      start(sessionId) { barrier.release(sessionId); if (bridge.start) bridge.start(sessionId); state.emit({ sessionId, state: 'active' }); },
      write(sessionId, s) { bridge.write(sessionId, String(s)); },
      resize(sessionId, cols, rows) { const g = V.clampGeometry(cols, rows); bridge.resize(sessionId, g.cols, g.rows); },
      signal(sessionId, sig) { bridge.signal(sessionId, sig); },
      close(sessionId) { return bridge.close(sessionId); },
      status(sessionId) { return bridge.status ? bridge.status(sessionId) : Promise.resolve(null); },
      onData: data.on, onExit: exit.on, onState: state.on
    };
  }
  root.HermitVWS = Object.assign(V, { IpcTransport });
})(typeof self !== 'undefined' ? self : globalThis);
