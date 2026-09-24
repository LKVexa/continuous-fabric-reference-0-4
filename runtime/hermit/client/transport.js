/**
 * TerminalTransport — the one contract the HERMIT renderer depends on (series I007 / I031).
 * ---------------------------------------------------------------------------
 *   open({cols,rows})            -> Promise<{sessionId}>   reserves a session; NO output may flow yet
 *   start(sessionId)             -> void                   releases the open barrier (renderer has registered the tab)
 *   write(sessionId, string)     -> void                   keystrokes / paste (adapter chunks to the transport limit)
 *   resize(sessionId, cols, rows)-> void                   validated 2..400 x 1..200; adapter may coalesce
 *   signal(sessionId, 'SIGINT')  -> void
 *   close(sessionId)             -> Promise<void>
 *   status(sessionId)            -> Promise<object|null>
 *   onData(fn({sessionId,chunk}))   onExit(fn({sessionId,code,reason}))   onState(fn({sessionId,state,detail}))
 *   capabilities                 -> { browserPane, windowControls, fabricHub, remote }
 *
 * Two adapters implement it: IpcTransport (LOCAL desktop profile, Electron preload bridge) and
 * WsTransport (WEB / REMOTE-DESKTOP profile, hermit.vws.v1). They share tests, not privileges.
 */
(function (root) {
  'use strict';
  const GEOMETRY = Object.freeze({ minCols: 2, maxCols: 400, minRows: 1, maxRows: 200 });
  function clampGeometry(cols, rows) {
    const c = Math.min(GEOMETRY.maxCols, Math.max(GEOMETRY.minCols, Math.floor(Number(cols)) || 80));
    const r = Math.min(GEOMETRY.maxRows, Math.max(GEOMETRY.minRows, Math.floor(Number(rows)) || 24));
    return { cols: c, rows: r };
  }
  /** Tiny listener set with unsubscribe; handler exceptions never break the transport. */
  function emitter() {
    const fns = new Set();
    return { on(fn) { fns.add(fn); return () => fns.delete(fn); }, emit(v) { for (const fn of [...fns]) { try { fn(v); } catch (e) { if (root.console) root.console.error(e); } } } };
  }
  /**
   * Bounded holding queue for output that arrives before the consumer called start().
   * Overflow is reported as an explicit notice, never silently dropped.
   */
  function openBarrier(deliver, maxChars) {
    const held = new Map();
    const limit = maxChars || 262144;
    return {
      hold(id) { held.set(id, { chunks: [], size: 0, overflow: false }); },
      push(id, chunk) {
        const h = held.get(id);
        if (!h) return deliver(id, chunk);
        if (h.size + chunk.length > limit) { h.overflow = true; return; }
        h.chunks.push(chunk); h.size += chunk.length;
      },
      release(id) {
        const h = held.get(id); if (!h) return;
        held.delete(id);
        for (const c of h.chunks) deliver(id, c);
        if (h.overflow) deliver(id, '\r\n\x1b[33m[early output exceeded the holding queue and was truncated]\x1b[0m\r\n');
      },
      drop(id) { held.delete(id); }
    };
  }
  root.HermitVWS = Object.assign(root.HermitVWS || {}, { GEOMETRY, clampGeometry, emitter, openBarrier });
})(typeof self !== 'undefined' ? self : globalThis);
