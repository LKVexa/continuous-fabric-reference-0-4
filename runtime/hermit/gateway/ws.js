'use strict';
/**
 * Minimal RFC 6455 server endpoint (zero dependencies) — series I021-I023 analog
 * ---------------------------------------------------------------------------
 * Standards-compliant WebSocket framing; `hermit.vws.v1` is an application
 * subprotocol carried in TEXT messages only. No extensions are negotiated, so
 * there is no compression state and no decompression amplification.
 *
 * Ownership: one receive path (socket 'data' -> _parse) and one send path
 * (_write -> socket.write, which is ordered) per connection; a single
 * idempotent _destroy() releases buffers, timers and the socket.
 */
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP = { CONT: 0, TEXT: 1, BIN: 2, CLOSE: 8, PING: 9, PONG: 10 };

function acceptKey(key) { return crypto.createHash('sha1').update(key + GUID).digest('base64'); }

/** Validate an HTTP upgrade request. @returns {{ok:true,key:string}|{ok:false,status:number,headers?:object,reason:string}} */
function checkUpgrade(req, protocol) {
  const h = req.headers;
  if (req.method !== 'GET') return { ok: false, status: 405, reason: 'method' };
  if (req.httpVersionMajor < 1 || (req.httpVersionMajor === 1 && req.httpVersionMinor < 1)) return { ok: false, status: 400, reason: 'http version' };
  if (String(h.upgrade || '').toLowerCase() !== 'websocket') return { ok: false, status: 400, reason: 'upgrade header' };
  if (!String(h.connection || '').toLowerCase().split(/\s*,\s*/).includes('upgrade')) return { ok: false, status: 400, reason: 'connection header' };
  if (h['sec-websocket-version'] !== '13') return { ok: false, status: 426, headers: { 'Sec-WebSocket-Version': '13' }, reason: 'version' };
  const key = h['sec-websocket-key'];
  if (typeof key !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(key)) return { ok: false, status: 400, reason: 'key' };
  const offered = String(h['sec-websocket-protocol'] || '').split(/\s*,\s*/).filter(Boolean);
  if (!offered.includes(protocol)) return { ok: false, status: 400, reason: 'subprotocol' };
  return { ok: true, key };
}

function validCloseCode(c) { return (c >= 1000 && c <= 1003) || (c >= 1007 && c <= 1014) || (c >= 3000 && c <= 4999); }

class WsConnection extends EventEmitter {
  /**
   * Events: 'text'(Buffer utf8Bytes) · 'binary'(Buffer bytes) · 'close'({code, reason, clean, initiator}) · 'drain' · 'pong'
   *
   * RAMWS memory discipline (kit R10, R11, R13, R18):
   *   - a frame that is complete inside one socket chunk is unmasked IN PLACE and delivered as a view: no copy
   *   - a frame that spans chunks is assembled into ONE exact-capacity buffer rented from the bounded slab pool
   *     (or allocated when larger than the largest class); every byte is copied once, never re-concatenated
   *   - message/fragment/age caps are decided from headers before any growth; the reassembly capacity is
   *     reserved in the connection's ledger account BEFORE the buffer is obtained; refusal closes 1009/1013
   *   - views delivered through 'text'/'binary' are valid only during the synchronous event: a consumer that
   *     needs the bytes later must copy them into storage it has reserved
   *   - every queued write holds a lease that is released in the socket write CALLBACK (local completion),
   *     not when the write was queued; destroy() settles outstanding callbacks, so nothing is released early
   */
  constructor(socket, o = {}) {
    super();
    this.socket = socket;
    this.maxMessageBytes = o.maxMessageBytes || 65536;
    this.maxFragments = o.maxFragments || 64;
    this.sendQueueBytes = o.sendQueueBytes || 524288;
    this.controlReserve = o.controlReserve || 16384;
    this.assemblyMs = o.assemblyMs || 5000;
    this.closeWaitMs = o.closeWaitMs || 3000;
    this.account = o.account || null;          // ram/ledger SessionAccount (optional: tests may run the endpoint bare)
    this.pool = o.pool || null;                // ram/ledger SlabPool
    this.traffic = o.traffic || null;          // ram/traffic
    this.hdr = Buffer.allocUnsafe(14); this.hdrFill = 0;
    this.body = null;                          // { buf, lease, pooled, need, fill, fin, op, mask }
    this.frag = null;                          // { op, parts:[{buf,len,lease,pooled}], bytes }
    this.fragTimer = null;
    this.state = 'OPEN';
    this.closeSent = false;
    this.closeTimer = null;
    this.destroyed = false;
    this.congested = false;
    this.inflight = 0;                         // bytes handed to socket.write whose callback has not fired
    this.ctrlCount = 0; this.ctrlAt = Date.now();
    this.stats = { rxBytes: 0, txBytes: 0, rxMessages: 0, txMessages: 0, inPlaceFrames: 0, assembledFrames: 0 };

    socket.setNoDelay(true);
    socket.on('data', (c) => this._onData(c));
    socket.on('drain', () => { if (this.congested && this.inflight < this.sendQueueBytes / 4) { this.congested = false; this.emit('drain'); } });
    socket.on('error', (e) => { this.emit('transport-error', (e && e.code) || 'UNKNOWN'); this._destroy(1006, `socket error ${(e && e.code) || ''}`.trim(), false, 'transport'); });
    socket.on('close', () => this._destroy(1006, 'socket closed', false, 'transport'));
    socket.on('end', () => this._destroy(1006, 'socket ended', false, 'peer'));
  }

  get queuedBytes() { return this.inflight; }

  /* ---- send ------------------------------------------------------------ */

  _head(op, n) {
    let head;
    if (n < 126) { head = Buffer.allocUnsafe(2); head[1] = n; }
    else if (n < 65536) { head = Buffer.allocUnsafe(4); head[1] = 126; head.writeUInt16BE(n, 2); }
    else { head = Buffer.allocUnsafe(10); head[1] = 127; head.writeUInt32BE(0, 2); head.writeUInt32BE(n, 6); }
    head[0] = 0x80 | op;
    return head;
  }
  /**
   * One ordered writer. `parts` are written back-to-back under cork (no concatenation copy).
   * `lease` (optional) backs the payload; it is retained here and released when the LAST part's callback fires.
   */
  _write(op, parts, lease, onDone) {
    if (this.destroyed || this.socket.destroyed) { if (onDone) onDone(new Error('closed')); return false; }
    let n = 0; for (const p of parts) n += p.length;
    const head = this._head(op, n); const total = head.length + n;
    this.stats.txBytes += total; this.inflight += total;
    if (this.traffic) this.traffic.add('tx_wire', total);
    if (lease) lease.retain();
    const settle = (err) => { this.inflight -= total; if (lease) lease.release(); if (onDone) onDone(err || null); if (this.congested && this.inflight < this.sendQueueBytes / 4 && !this.destroyed) { this.congested = false; this.emit('drain'); } };
    this.socket.cork(); this.socket.write(head);
    for (let i = 0; i < parts.length - 1; i++) this.socket.write(parts[i]);
    if (parts.length) this.socket.write(parts[parts.length - 1], settle); else this.socket.write(Buffer.alloc(0), settle);
    this.socket.uncork();
    if (this.inflight >= this.sendQueueBytes / 2) this.congested = true;
    return true;
  }
  _budget(n, control) { return this.inflight + n + 10 <= this.sendQueueBytes + (control ? this.controlReserve : 0); }
  /** @returns {boolean} false => NOT queued */
  sendText(text, { control = false } = {}) {
    if (this.state !== 'OPEN') return false;
    const payload = Buffer.from(text, 'utf8');
    if (this.traffic) this.traffic.add('tx_encode', payload.length);
    if (!this._budget(payload.length, control)) { this.congested = true; return false; }
    this.stats.txMessages++;
    return this._write(OP.TEXT, [payload], null, null);
  }
  /** Binary message from caller-owned parts (e.g. 7-byte data header + transferred payload). */
  sendBinary(parts, { lease = null, onDone = null } = {}) {
    if (this.state !== 'OPEN') return false;
    let n = 0; for (const p of parts) n += p.length;
    if (!this._budget(n, false)) { this.congested = true; return false; }
    this.stats.txMessages++;
    return this._write(OP.BIN, parts, lease, onDone);
  }
  ping(data = Buffer.alloc(0)) { if (this.state === 'OPEN') this._write(OP.PING, [data], null, null); }

  /** Start (or complete) the closing handshake. Idempotent. */
  close(code = 1000, reason = '') {
    if (this.state === 'CLOSED') return;
    if (!this.closeSent) {
      this.closeSent = true;
      const r = Buffer.from(String(reason).slice(0, 100), 'utf8');
      const p = Buffer.allocUnsafe(2 + r.length); p.writeUInt16BE(code, 0); r.copy(p, 2);
      this._write(OP.CLOSE, [p], null, null);
      this.localClose = { code, reason: String(reason) };
    }
    if (this.state === 'OPEN') {
      this.state = 'CLOSING';
      this.closeTimer = setTimeout(() => this._destroy(code, 'close handshake timeout', false, 'local'), this.closeWaitMs);
      if (this.closeTimer.unref) this.closeTimer.unref();
    }
  }
  terminate(code = 1006, reason = 'terminated') { this._destroy(code, reason, false, 'local'); }

  _fail(code, reason) {
    if (this.state === 'OPEN') { this.failInfo = { code, reason }; this.close(code, reason); }
    this._dropReceiveState();
  }

  _releasePart(p) { if (p.pooled && this.pool) this.pool.giveBack(p.buf, p.len); if (p.lease) p.lease.release(); }
  _dropReceiveState() {
    if (this.body) { this._releasePart({ buf: this.body.buf, len: this.body.fill, lease: this.body.lease, pooled: this.body.pooled }); this.body = null; }
    if (this.frag) { for (const p of this.frag.parts) this._releasePart(p); this.frag = null; }
    if (this.fragTimer) { clearTimeout(this.fragTimer); this.fragTimer = null; }
    this.hdrFill = 0;
  }

  _destroy(code, reason, clean, initiator) {
    if (this.destroyed) return;
    this.destroyed = true;
    this.state = 'CLOSED';
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this._dropReceiveState();                 // receive-side storage has no other consumer: return it now
    try { this.socket.destroy(); } catch { /* noop */ } // queued writes are settled by their callbacks (with an error): their leases return there
    this.emit('close', { code, reason, clean: !!clean, initiator });
  }

  /* ---- receive ---------------------------------------------------------- */

  _rent(n) {
    // Reserve BEFORE acquiring (Budget invariant). Capacity charged is the ACTUAL backing size (a pool class may exceed n).
    // A pooled slab is physical storage of the pool (counted once, globally, idle or not): the lease charges quota only.
    const cls = this.pool ? this.pool.classFor(n) : 0;
    const lease = this.account ? this.account.acquire('reassembly', cls || n, 'transport', !cls) : null;   // throws BudgetError -> caller closes
    let buf = cls ? this.pool.rent(n) : null; const pooled = !!buf;
    if (!buf) buf = Buffer.allocUnsafe(n);
    if (lease) lease.activate(0);
    return { buf, lease, pooled };
  }

  _onData(chunk) {
    if (this.destroyed) return;
    this.stats.rxBytes += chunk.length;
    if (this.traffic) this.traffic.add('rx_wire', chunk.length);
    let off = 0;
    while (off < chunk.length && !this.destroyed) {
      if (this.body) {                                   // continue a frame that spans chunks: one copy per byte
        const b = this.body; const take = Math.min(b.need - b.fill, chunk.length - off);
        chunk.copy(b.buf, b.fill, off, off + take); b.fill += take; off += take;
        if (this.traffic) this.traffic.add('rx_reassembly_copy', take);
        if (b.lease) b.lease.setUsed(b.fill);
        if (b.fill < b.need) return;
        this.body = null; this.stats.assembledFrames++;
        const view = b.buf.subarray(0, b.need); unmask(view, b.mask);
        this._frame(b.op, b.fin, view, { buf: b.buf, len: b.need, lease: b.lease, pooled: b.pooled });
        continue;
      }
      // ---- header (may itself be split across chunks: stitched in a 14-byte scratch) ----
      let h, hOff, avail;
      if (this.hdrFill) { const take = Math.min(14 - this.hdrFill, chunk.length - off); chunk.copy(this.hdr, this.hdrFill, off, off + take); h = this.hdr; hOff = 0; avail = this.hdrFill + take; }
      else { h = chunk; hOff = off; avail = chunk.length - off; }
      const need = (n) => { if (avail >= n) return true; if (!this.hdrFill) { chunk.copy(this.hdr, 0, off, chunk.length); } this.hdrFill = avail; off = chunk.length; return false; };
      if (!need(2)) return;
      const b0 = h[hOff], b1 = h[hOff + 1];
      const fin = (b0 & 0x80) !== 0, rsv = b0 & 0x70, op = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f, hl = 2;
      if (rsv !== 0) return this._fail(1002, 'reserved bits');
      if (!masked) return this._fail(1002, 'unmasked client frame');
      if (len === 126) { if (!need(4)) return; len = h.readUInt16BE(hOff + 2); hl = 4; if (len < 126) return this._fail(1002, 'non-minimal length'); }
      else if (len === 127) { if (!need(10)) return; const hi = h.readUInt32BE(hOff + 2), lo = h.readUInt32BE(hOff + 6); if (hi !== 0 || lo > 0x7fffffff) return this._fail(1009, 'frame too large'); len = lo; hl = 10; if (len < 65536) return this._fail(1002, 'non-minimal length'); }
      const control = op >= 8;
      if (control && (len > 125 || !fin)) return this._fail(1002, 'bad control frame');
      if (!control && len + (this.frag ? this.frag.bytes : 0) > this.maxMessageBytes) return this._fail(1009, 'message too large');
      if (!control && this.frag && this.frag.parts.length >= this.maxFragments) return this._fail(1009, 'too many fragments');
      if (!need(hl + 4)) return;
      const mask = Buffer.from([h[hOff + hl], h[hOff + hl + 1], h[hOff + hl + 2], h[hOff + hl + 3]]);
      // consume the header bytes from the chunk
      if (this.hdrFill) { off += (hl + 4) - this.hdrFill; this.hdrFill = 0; } else off += hl + 4;
      if (chunk.length - off >= len) {                   // whole payload is here: unmask in place, deliver a view, copy nothing
        const view = chunk.subarray(off, off + len); off += len; unmask(view, mask); this.stats.inPlaceFrames++;
        if (this.traffic) this.traffic.add('rx_unmask_inplace', len);
        this._frame(op, fin, view, null);
      } else {                                           // spans chunks: reserve, then obtain exact storage once
        let r; try { r = this._rent(len); } catch (e) { return this._fail(e.code === 'EBUDGET' ? 1013 : 1011, e.code === 'EBUDGET' ? 'memory budget' : 'internal'); }
        const take = chunk.length - off; chunk.copy(r.buf, 0, off, chunk.length); off = chunk.length;
        if (this.traffic) this.traffic.add('rx_reassembly_copy', take);
        if (r.lease) r.lease.setUsed(take);
        this.body = { buf: r.buf, lease: r.lease, pooled: r.pooled, need: len, fill: take, fin, op, mask };
        if (!this.fragTimer) { this.fragTimer = setTimeout(() => this._fail(1008, 'message assembly deadline'), this.assemblyMs); if (this.fragTimer.unref) this.fragTimer.unref(); }
        return;
      }
    }
  }

  /** One complete frame. `owned` describes pooled/leased storage behind `payload` (null when it is a view of the socket chunk). */
  _frame(op, fin, payload, owned) {
    const done = () => { if (owned) this._releasePart(owned); this._clearAge(); };
    if (this.state === 'CLOSING' && op !== OP.CLOSE) return done();
    switch (op) {
      case OP.TEXT: case OP.BIN:
        if (this.frag) { done(); return this._fail(1002, 'new message inside fragmented message'); }
        if (fin) { this._clearAge(); this._message(op, payload); return done(); }
        return this._keepFragment(op, payload, owned);
      case OP.CONT:
        if (!this.frag) { done(); return this._fail(1002, 'continuation without start'); }
        if (!fin) return this._keepFragment(null, payload, owned);
        {
          // Final fragment: assemble ONCE into storage reserved for the whole message.
          const f = this.frag; const total = f.bytes + payload.length; let r;
          try { r = this._rent(total); } catch (e) { done(); return this._fail(1013, 'memory budget'); }
          let o = 0; for (const p of f.parts) { p.buf.copy(r.buf, o, 0, p.len); o += p.len; } payload.copy(r.buf, o);
          if (this.traffic) this.traffic.add('rx_reassembly_copy', total);
          if (r.lease) r.lease.setUsed(total);
          for (const p of f.parts) this._releasePart(p); this.frag = null; this._clearAge(); done();
          this._message(f.op, r.buf.subarray(0, total));
          return this._releasePart({ buf: r.buf, len: total, lease: r.lease, pooled: r.pooled });
        }
      case OP.PING:
        if (++this.ctrlCount > 200) { const now = Date.now(); if (now - this.ctrlAt < 1000) { done(); return this._fail(1008, 'control frame flood'); } this.ctrlCount = 0; this.ctrlAt = now; }
        if (this.inflight + payload.length + 2 > this.sendQueueBytes + this.controlReserve) { done(); return this.terminate(1008, 'send queue exhausted'); }
        this._write(OP.PONG, [Buffer.from(payload)], null, null); return done();   // copy: the view dies with this event
      case OP.PONG: this.emit('pong', payload); return done();
      case OP.CLOSE: { const p = Buffer.from(payload); done(); return this._onClose(p); }
      default: done(); return this._fail(1002, 'unknown opcode');
    }
  }
  _clearAge() { if (this.fragTimer && !this.body && !this.frag) { clearTimeout(this.fragTimer); this.fragTimer = null; } }
  _keepFragment(op, payload, owned) {
    // A non-final fragment must outlive this event, so it needs storage of its own (a view of the socket chunk does not).
    let part = owned;
    if (!part) {
      let r; try { r = this._rent(payload.length || 1); } catch (e) { return this._fail(1013, 'memory budget'); }
      payload.copy(r.buf, 0); if (this.traffic) this.traffic.add('rx_reassembly_copy', payload.length);
      if (r.lease) r.lease.setUsed(payload.length);
      part = { buf: r.buf, len: payload.length, lease: r.lease, pooled: r.pooled };
    }
    if (!this.frag) this.frag = { op, parts: [], bytes: 0 };
    this.frag.parts.push(part); this.frag.bytes += part.len;
    if (!this.fragTimer) { this.fragTimer = setTimeout(() => this._fail(1008, 'message assembly deadline'), this.assemblyMs); if (this.fragTimer.unref) this.fragTimer.unref(); }
  }

  _message(op, bytes) {
    this.stats.rxMessages++;
    if (op === OP.BIN) return void this.emit('binary', bytes);
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return this._fail(1007, 'invalid UTF-8'); }
    this.emit('text', bytes);
  }

  _onClose(payload) {
    let code = 1005, reason = '';
    if (payload.length === 1) return this._fail(1002, 'bad close payload');
    if (payload.length >= 2) {
      code = payload.readUInt16BE(0);
      if (!validCloseCode(code)) return this._fail(1002, 'bad close code');
      try { reason = new TextDecoder('utf-8', { fatal: true }).decode(payload.subarray(2)); } catch { return this._fail(1007, 'bad close reason'); }
    }
    const weInitiated = this.closeSent;
    if (!this.closeSent) this.close(code === 1005 ? 1000 : code, '');
    const info = weInitiated ? (this.failInfo || this.localClose || { code, reason }) : { code, reason };
    this.socket.end(() => this._destroy(info.code, info.reason, true, weInitiated ? 'local' : 'peer'));
    setTimeout(() => this._destroy(info.code, info.reason, true, weInitiated ? 'local' : 'peer'), 500).unref();
  }
}

function unmask(view, mask) { for (let i = 0, n = view.length; i < n; i++) view[i] ^= mask[i & 3]; }

/** Complete the upgrade on a raw socket. */
function acceptUpgrade(socket, key, protocol, extraHeaders = []) {
  const lines = ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey(key)}`, `Sec-WebSocket-Protocol: ${protocol}`, ...extraHeaders, '', ''];
  socket.write(lines.join('\r\n'));
}

function rejectUpgrade(socket, status, reason, headers = {}) {
  const text = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 500: 'Internal Server Error', 426: 'Upgrade Required', 429: 'Too Many Requests', 503: 'Service Unavailable' }[status] || 'Error';
  const body = JSON.stringify({ error: reason });
  const h = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Connection: 'close', 'Cache-Control': 'no-store', ...headers };
  try { socket.end(`HTTP/1.1 ${status} ${text}\r\n` + Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n' + body); } catch { /* noop */ }
  setTimeout(() => { try { socket.destroy(); } catch { /* noop */ } }, 1000).unref();
}

module.exports = { WsConnection, checkUpgrade, acceptUpgrade, rejectUpgrade, acceptKey, OP, validCloseCode };
