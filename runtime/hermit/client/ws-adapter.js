/**
 * WEB / REMOTE-DESKTOP adapter: hermit.vws.v2 over a standard browser WebSocket (RAMWS kit R12, R13, R21, R30).
 * v2: terminal bytes are binary messages (7-byte header, no base64); the client grants BYTE CREDITS so the server
 * can never overrun the browser (classic WebSocket has no backpressure of its own); the server epoch is remembered
 * so that a reconnect after a server restart is reported as SESSION_RESET with the exact number of inputs whose
 * outcome is unknown. Nothing is replayed automatically.
 * One WebSocket per terminal tab. No preload bridge, no Node API, no custom headers (browsers cannot set them):
 * admission uses a one-use ticket cookie obtained with the in-memory bearer credential.
 *
 * Recovery contract (resume=false): a reconnect is a NEW session on a NEW socket with FRESH authentication.
 * Raw keystrokes are never replayed. Input whose acknowledgement was not seen is reported as OUTCOME UNKNOWN.
 */
(function (root) {
  'use strict';
  const V = root.HermitVWS;
  const C = V.codec;

  function randomId() { const b = new Uint8Array(12); root.crypto.getRandomValues(b); return C.b64url(b); }

  /** Build one binary INPUT message: [kind=1][uint48 seq][bytes]. */
  function inputMessage(seq, part) { const m = new Uint8Array(7 + part.length); C.writeDataHeaderRaw(m, 1, seq); m.set(part, 7); return m; }
  /** Split UTF-8 bytes into chunks of <= max bytes. A multi-byte character may straddle chunks; the worker decodes as a stream. */
  function chunkBytes(bytes, max) { const out = []; for (let o = 0; o < bytes.length; o += max) out.push(bytes.subarray(o, Math.min(bytes.length, o + max))); return out; }

  /** Full-jitter exponential backoff: uniform(0, min(cap, base * 2^attempt)). One timer at a time. */
  function backoffMs(attempt, rnd, base, cap) { return Math.floor((rnd || Math.random)() * Math.min(cap || 30000, (base || 500) * Math.pow(2, attempt))); }

  function WsTransport(options) {
    const o = Object.assign({ base: '', getToken: async () => null, WebSocketImpl: root.WebSocket, fetchImpl: root.fetch && root.fetch.bind(root), autoReconnect: true, maxAttempts: 8 }, options || {});
    const data = V.emitter(), exit = V.emitter(), state = V.emitter();
    const barrier = V.openBarrier((sessionId, chunk) => data.emit({ sessionId, chunk }));
    const tabs = new Map(); // local tab id -> connection record
    let seq = 0, codec = null, config = null;

    async function init() {
      if (codec) return;
      const get = async (p) => { const r = await o.fetchImpl(o.base + p, { credentials: 'same-origin', cache: 'no-store' }); if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`); return r.json(); };
      const [schema, meta, cfg] = await Promise.all([get('/protocol/envelope.schema.json'), get('/protocol/protocol-meta.json'), get('/config.json')]);
      if (cfg.protocol !== C.PROTOCOL) throw new Error('protocol mismatch');
      codec = C.createCodec(schema, meta); config = cfg;
    }

    async function ticket() {
      if (config.auth === 'none') { const r = await o.fetchImpl(o.base + config.ticketPath, { method: 'POST', credentials: 'same-origin' }); if (!r.ok) throw Object.assign(new Error('ticket refused'), { status: r.status }); return; }
      const token = await o.getToken();
      if (!token) throw Object.assign(new Error('sign-in required'), { status: 401 });
      const r = await o.fetchImpl(o.base + config.ticketPath, { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { Authorization: 'Bearer ' + token } });
      if (!r.ok) throw Object.assign(new Error(r.status === 401 ? 'credential rejected' : `ticket refused (HTTP ${r.status})`), { status: r.status });
    }

    function wsUrl() {
      const b = o.base || root.location.origin;
      return b.replace(/^http/, 'ws') + config.wsPath;
    }

    function connect(tab) {
      return new Promise((resolve, reject) => {
        const ws = new o.WebSocketImpl(wsUrl(), [C.PROTOCOL]);
        const rec = tab.conn = { ws, sid: null, epoch: null, inSeq: 0, executedSeq: 0, acceptedSeq: 0, lastOut: 0, consumedBytes: 0, creditBytes: 0, creditedAt: 0, sinceCredit: 0, decoder: new TextDecoder('utf-8'), opened: false, exited: false, openRid: randomId(), helloSeen: false, window: 0 };
        ws.binaryType = 'arraybuffer';
        const fail = (e) => { if (!rec.opened) reject(e); };
        const send = (msg) => { if (ws.readyState === 1) ws.send(codec.encode(msg, 'client_to_server')); };
        rec.send = send;
        ws.onopen = () => { /* wait for hello before session.open */ };
        ws.onerror = () => fail(new Error('connection failed'));
        ws.onclose = (ev) => {
          if (rec.ackTimer) clearTimeout(rec.ackTimer);
          if (!rec.opened) return fail(Object.assign(new Error(`closed before open (${ev.code})`), { closeCode: ev.code }));
          if (tab.conn !== rec) return;                      // fenced: an old socket cannot touch a newer generation
          onDisconnected(tab, rec, ev);
        };
        ws.onmessage = (ev) => {
          if (tab.conn !== rec) return;
          if (typeof ev.data !== 'string') {                                               // binary OUTPUT: [2][uint48 seq][bytes]
            let d;
            try { d = codec.decodeData(new Uint8Array(ev.data), 'server_to_client'); } catch (e) { return protoErr(); }
            if (!rec.opened) return;
            if (d.seq !== rec.lastOut + 1) barrier.push(tab.id, `\r\n\x1b[1;33m[output gap: expected #${rec.lastOut + 1}, received #${d.seq}]\x1b[0m\r\n`);
            rec.lastOut = d.seq; rec.consumedBytes += d.payload.length; rec.sinceCredit++;
            const text = rec.decoder.decode(d.payload, { stream: true });                 // chunk boundaries may split a character
            if (text) barrier.push(tab.id, text);
            // Credit renewal: cumulative, bounded by the server's window, never more often than needed.
            if (rec.consumedBytes - rec.creditedAt >= rec.window / 4 || rec.creditBytes - rec.consumedBytes < rec.window / 2 || rec.sinceCredit >= 128) credit(rec);
            return;
          }
          let m;
          const protoErr = () => { state.emit({ sessionId: tab.id, state: 'protocol-error', detail: 'server sent an invalid message; disconnecting' }); try { ws.close(1002, 'bad message'); } catch (_) { /* noop */ } };
          try { ({ msg: m } = codec.decode(ev.data, 'server_to_client')); } catch (e) { return protoErr(); }
          switch (m.type) {
            case 'hello': {
              if (rec.helloSeen) return; rec.helloSeen = true; rec.limits = m.payload.limits; rec.serverEpoch = m.payload.serverEpoch;
              rec.window = Math.min(m.payload.limits.maxCreditWindowBytes, o.creditWindowBytes || 1048576); rec.creditBytes = rec.window;
              const payload = { cols: tab.cols, rows: tab.rows, mode: 'virtual', creditBytes: rec.window };
              if (tab.previous) payload.previous = tab.previous;                                // what this tab believes it had before the link dropped
              return send({ v: 2, type: 'session.open', rid: rec.openRid, payload });
            }
            case 'session.reset':
              if (m.rid !== rec.openRid) return;
              barrier.push(tab.id, `\r\n\x1b[1;33m[SESSION_RESET: ${m.payload.reason === 'process_restart' ? 'the server restarted (new epoch)' : 'the previous session no longer exists'}. ` +
                (m.payload.outcome === 'OUTCOME_UNKNOWN' ? `${m.payload.pendingInputs} input message(s) had no acknowledgement: their outcome is UNKNOWN and they were NOT re-sent.` : 'No input was pending.') + ']\x1b[0m\r\n');
              state.emit({ sessionId: tab.id, state: 'reset', detail: m.payload.reason, outcome: m.payload.outcome });
              return;
            case 'session.opened':
              if (m.rid !== rec.openRid || rec.opened) return;
              rec.sid = m.sid; rec.epoch = m.epoch; rec.opened = true; tab.attempt = 0; tab.previous = null;
              return resolve(rec);
            case 'input.ack':
              if (m.sid !== rec.sid) return;
              rec.acceptedSeq = Math.max(rec.acceptedSeq, m.payload.acceptedSeq); rec.executedSeq = Math.max(rec.executedSeq, m.payload.executedSeq);
              return;
            case 'request.ack': return;
            case 'heartbeat.ping': return send({ v: 2, type: 'heartbeat.pong', rid: m.rid, payload: { nonce: m.payload.nonce } });
            case 'service.draining': return state.emit({ sessionId: tab.id, state: 'draining', detail: `service is restarting (${m.payload.reason}); this session will end` });
            case 'session.exit':
              if (m.sid !== rec.sid || rec.exited) return;
              rec.exited = true; rec.exitInfo = m.payload; return;
            case 'error': {
              return state.emit({ sessionId: tab.id, state: 'error', detail: `${m.payload.code}: ${m.payload.message}`, code: m.payload.code, retryable: m.payload.retryable });
            }
            default: return;
          }
        };
      });
    }

    function credit(rec) {
      if (!rec.sid || rec.ws.readyState !== 1) return;
      rec.creditBytes = rec.consumedBytes + rec.window; rec.creditedAt = rec.consumedBytes; rec.sinceCredit = 0;
      rec.send({ v: 2, type: 'flow.credit', sid: rec.sid, epoch: rec.epoch, payload: { consumedSeq: rec.lastOut, creditBytes: rec.creditBytes } });
    }

    function onDisconnected(tab, rec, ev) {
      const unknown = Math.max(0, rec.inSeq - rec.executedSeq);          // inputs sent but not known to have COMPLETED
      tab.previous = rec.sid ? { sid: rec.sid, epoch: rec.epoch, pendingInputs: Math.min(1000000, unknown) } : null;
      if (rec.exited || tab.closing) {                       // orderly end
        tabs.delete(tab.id);
        return exit.emit({ sessionId: tab.id, code: rec.exitInfo ? rec.exitInfo.code : 0, reason: rec.exitInfo ? rec.exitInfo.reason : 'closed' });
      }
      // Transport lost without a session.exit. Say exactly what is and is not known.
      let note = `\r\n\x1b[1;33m[connection lost (code ${ev.code})]\x1b[0m\r\n`;
      if (unknown) note += `\x1b[33m[${unknown} input message(s) were accepted but not known to have completed: their outcome is UNKNOWN. Nothing will be re-sent automatically.]\x1b[0m\r\n`;
      data.emit({ sessionId: tab.id, chunk: note });
      const retryable = o.autoReconnect && ![1008, 1002, 1003, 1007, 1009].includes(ev.code) && tab.attempt < o.maxAttempts;
      if (!retryable) { tabs.delete(tab.id); return exit.emit({ sessionId: tab.id, code: 70, reason: 'connection_lost' }); }
      scheduleReconnect(tab);
    }

    function scheduleReconnect(tab) {
      if (tab.timer) return;                                  // exactly one timer
      const delay = backoffMs(tab.attempt++, o.random);
      state.emit({ sessionId: tab.id, state: 'reconnecting', detail: `reconnecting in ${(delay / 1000).toFixed(1)} s (attempt ${tab.attempt})`, delayMs: delay });
      tab.timer = setTimeout(async () => {
        tab.timer = null;
        if (tab.closing) return;
        try {
          await ticket();                                     // fresh authentication, every time
          await connect(tab);
          data.emit({ sessionId: tab.id, chunk: '\x1b[1;36m[reconnected: this is a NEW session. Scrollback above is history; running commands were not resumed.]\x1b[0m\r\n' });
          state.emit({ sessionId: tab.id, state: 'active', detail: 'new session' });
        } catch (e) {
          if (e.status === 401 || e.status === 403) { state.emit({ sessionId: tab.id, state: 'auth-required', detail: e.message }); tabs.delete(tab.id); return exit.emit({ sessionId: tab.id, code: 77, reason: 'auth_required' }); }
          if (tab.attempt >= o.maxAttempts) { tabs.delete(tab.id); return exit.emit({ sessionId: tab.id, code: 70, reason: 'connection_lost' }); }
          scheduleReconnect(tab);
        }
      }, delay);
    }

    function sendInput(tab, bytes) {
      const rec = tab.conn;
      if (!rec || !rec.opened || rec.ws.readyState !== 1) { state.emit({ sessionId: tab.id, state: 'input-dropped', detail: 'not connected: input was NOT sent' }); return; }
      const max = (rec.limits && rec.limits.inputBytes) || 8192;
      for (const part of chunkBytes(bytes, max)) { if (rec.ws.readyState === 1) rec.ws.send(inputMessage(++rec.inSeq, part)); }
    }

    return {
      capabilities: { browserPane: false, windowControls: false, fabricHub: false, remote: true },
      init,
      async open(opts) {
        await init();
        const g = V.clampGeometry(opts && opts.cols, opts && opts.rows);
        const tab = { id: 'w' + (++seq), cols: g.cols, rows: g.rows, attempt: 0, conn: null, closing: false, timer: null, resizeTimer: null };
        barrier.hold(tab.id);
        await ticket();
        try { await connect(tab); } catch (e) { barrier.drop(tab.id); throw e; }
        tabs.set(tab.id, tab);
        return { sessionId: tab.id };
      },
      start(sessionId) { barrier.release(sessionId); state.emit({ sessionId, state: 'active' }); },
      write(sessionId, s) { const tab = tabs.get(sessionId); if (tab) sendInput(tab, C.utf8(String(s))); },
      resize(sessionId, cols, rows) {
        const tab = tabs.get(sessionId); if (!tab) return;
        const g = V.clampGeometry(cols, rows); tab.cols = g.cols; tab.rows = g.rows;
        if (tab.resizeTimer) return;                          // coalesce: only the newest geometry matters
        tab.resizeTimer = setTimeout(() => { tab.resizeTimer = null; const rec = tab.conn; if (rec && rec.opened && rec.ws.readyState === 1) rec.send({ v: 2, type: 'terminal.resize', rid: randomId(), sid: rec.sid, epoch: rec.epoch, payload: { cols: tab.cols, rows: tab.rows } }); }, 60);
      },
      signal(sessionId, sig) { const tab = tabs.get(sessionId); const rec = tab && tab.conn; if (rec && rec.opened && sig === 'SIGINT') rec.send({ v: 2, type: 'terminal.signal', rid: randomId(), sid: rec.sid, epoch: rec.epoch, payload: { signal: 'SIGINT' } }); },
      async close(sessionId) {
        const tab = tabs.get(sessionId); if (!tab) return;
        tab.closing = true; if (tab.timer) { clearTimeout(tab.timer); tab.timer = null; }     // explicit close cancels retries
        const rec = tab.conn;
        if (rec && rec.opened && rec.ws.readyState === 1) rec.send({ v: 2, type: 'session.close', rid: randomId(), sid: rec.sid, epoch: rec.epoch, payload: { reason: 'user' } });
        else { tabs.delete(sessionId); exit.emit({ sessionId, code: 0, reason: 'closed' }); }
      },
      async status(sessionId) {
        const tab = tabs.get(sessionId); if (!tab) return null;
        const rec = tab.conn;
        return { sessionId, cwd: '', cols: tab.cols, rows: tab.rows, busy: false, nodes: [], dfRoot: null, photon: { url: null, token: false }, remote: true,
          connection: rec && rec.ws.readyState === 1 ? 'connected' : 'disconnected', unacknowledgedInputs: rec ? Math.max(0, rec.inSeq - rec.executedSeq) : 0, creditRemaining: rec ? rec.creditBytes - rec.consumedBytes : 0, epoch: rec ? rec.epoch : null, fabric: !!(config && config.capabilities.fabric) };
      },
      onData: data.on, onExit: exit.on, onState: state.on,
      _debug: { tabs, backoffMs, chunkBytes }
    };
  }
  root.HermitVWS = Object.assign(V, { WsTransport, backoffMs, chunkBytes });
})(typeof self !== 'undefined' ? self : globalThis);
