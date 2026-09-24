'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { load } = require('../gateway/config');
const { createGateway } = require('../gateway/server');

const DF_ROOT = process.env.TEST_DF_ROOT || path.resolve(__dirname, '..', '..');
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const rid = () => crypto.randomBytes(12).toString('base64url');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Start an in-process gateway on an ephemeral loopback port with two tenants. */
async function startGateway(over = {}, envOver = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vws-test-'));
  const tokens = { alice: crypto.randomBytes(32).toString('base64url'), bob: crypto.randomBytes(32).toString('base64url'), nofab: crypto.randomBytes(32).toString('base64url') };
  const pf = path.join(dir, 'principals.json');
  const principals = [
    { sub: 'alice', tenant: 'acme', tokenSha256: sha(tokens.alice), capabilities: ['terminal', 'fabric'] },
    { sub: 'bob', tenant: 'globex', tokenSha256: sha(tokens.bob), capabilities: ['terminal', 'fabric'] },
    { sub: 'nofab', tenant: 'acme', tokenSha256: sha(tokens.nofab), capabilities: ['terminal'] }];
  fs.writeFileSync(pf, JSON.stringify(principals));
  const base = load({ VWS_PRINCIPALS_FILE: pf, VWS_HOST: '127.0.0.1', VWS_SECURE_COOKIES: '0', VWS_LOG: 'silent', ...envOver });
  const logs = [];
  const cfg = Object.freeze({ ...base, port: 0, requireHeapCap: false, ...over });
  const gw = createGateway({ ...cfg, logLevel: over.logLevel || 'debug' }, { logSink: (l) => logs.push(l) });
  const addr = await gw.listen();
  return { gw, cfg, port: addr.port, tokens, dir, pf, principals, logs, url: `ws://127.0.0.1:${addr.port}/ws/terminal`, http: `http://127.0.0.1:${addr.port}`,
    stop: async () => { await gw.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

/** hermit.vws.v2 protocol client over Node's built-in (undici) WebSocket — an implementation independent of gateway/ws.js. */
class Client {
  constructor(url, token, opts = {}) {
    this.msgs = []; this._chunks = []; this._outCache = null; this._textCache = null; this.outputs = []; this.waiters = []; this.closed = null; this.inSeq = 0;
    this.autoCredit = opts.autoCredit !== false && opts.autoAck !== false; this.window = opts.window || 1048576; this.initialCredit = opts.initialCredit === undefined ? this.window : opts.initialCredit;
    this.consumedSeq = 0; this.consumedBytes = 0; this.creditBytes = 0; this.previous = opts.previous || null;
    const headers = {}; if (token) headers.authorization = `Bearer ${token}`; Object.assign(headers, opts.headers || {});
    this.ws = new WebSocket(url, { protocols: opts.protocols || ['hermit.vws.v2'], headers }); this.ws.binaryType = 'arraybuffer';
    this.opened = new Promise((res, rej) => { this.ws.addEventListener('open', () => res()); this.ws.addEventListener('error', (e) => rej(new Error('ws error ' + (e.message || '')))); });
    this.ws.addEventListener('message', (e) => {
      if (typeof e.data !== 'string') {
        const b = Buffer.from(e.data); const seq = b.readUIntBE(1, 6); const payload = b.subarray(7);
        this.outputs.push({ kind: b[0], seq, len: payload.length }); this._chunks.push(payload); this._outCache = null; this._textCache = null;  // amortized O(1): a growing Buffer.concat made the CLIENT quadratic and inflated in-process latency measurements
        this.consumedSeq = seq; this.consumedBytes += payload.length;
        this.sinceCredit = (this.sinceCredit || 0) + 1;
        if (this.autoCredit && (this.consumedBytes - (this.creditedAt || 0) >= this.window / 4 || this.creditBytes - this.consumedBytes < this.window / 2 || this.sinceCredit >= 128)) this.credit();
        return this._wake();
      }
      const m = JSON.parse(e.data); this.msgs.push(m);
      if (m.type === 'hello') { this.serverEpoch = m.payload.serverEpoch; this.limits = m.payload.limits; }
      if (m.type === 'session.opened') { this.sid = m.sid; this.epoch = m.epoch; }
      if (m.type === 'heartbeat.ping' && opts.pong !== false) this.send({ v: 2, type: 'heartbeat.pong', rid: m.rid, payload: { nonce: m.payload.nonce } });
      this._wake();
    });
    this.ws.addEventListener('close', (e) => { this.closed = { code: e.code, reason: e.reason }; this._wake(); });
  }
  _wake() { const w = this.waiters; this.waiters = []; for (const f of w) f(); }
  send(m) { if (this.ws.readyState === 1) this.ws.send(typeof m === 'string' || Buffer.isBuffer(m) || m instanceof Uint8Array ? m : JSON.stringify(m)); }
  /** Grant credit: cumulative total = everything consumed so far + one window. */
  credit(over = {}) { this.creditBytes = this.consumedBytes + this.window; this.creditedAt = this.consumedBytes; this.sinceCredit = 0; this.send({ v: 2, type: 'flow.credit', sid: this.sid, epoch: this.epoch, payload: { consumedSeq: this.consumedSeq, creditBytes: this.creditBytes, ...over } }); }
  async until(pred, ms = 8000, what = 'condition') {
    const end = Date.now() + ms;
    for (;;) {
      const v = pred(); if (v) return v;
      if (Date.now() > end) throw new Error(`timeout waiting for ${what}; last=${JSON.stringify(this.msgs.slice(-3)).slice(0, 400)} closed=${JSON.stringify(this.closed)} outputs=${this.outputs.length}`);
      await new Promise((r) => { this.waiters.push(r); setTimeout(r, 50); });
    }
  }
  type(t) { return t === 'terminal.output' ? this.outputs.map((o) => ({ type: t, payload: { seq: o.seq } })) : this.msgs.filter((m) => m.type === t); }
  get out() { if (!this._outCache) { this._outCache = this._chunks.length === 1 ? this._chunks[0] : Buffer.concat(this._chunks); this._chunks = [this._outCache]; } return this._outCache; }
  text() { if (this._textCache === null) this._textCache = this.out.toString('utf8').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''); return this._textCache; }
  async open(cols = 100, rows = 30) {
    await this.opened; await this.until(() => this.serverEpoch, 5000, 'hello');
    const payload = { cols, rows, mode: 'virtual', creditBytes: this.initialCredit }; if (this.previous) payload.previous = this.previous;
    this.creditBytes = this.initialCredit;
    this.send({ v: 2, type: 'session.open', rid: rid(), payload });
    await this.until(() => this.sid, 8000, 'session.opened'); await this.until(() => /›/.test(this.text()), 8000, 'prompt'); return this;
  }
  /** Binary INPUT: [kind=1][uint48 seq][bytes] */
  input(s, o = {}) { const p = Buffer.from(s); const b = Buffer.alloc(7 + p.length); b[0] = o.kind === undefined ? 1 : o.kind; b.writeUIntBE(o.seq || ++this.inSeq, 1, 6); p.copy(b, 7); this.send(b); return this.inSeq; }
  ctl(type, payload, withRid = true) { const m = { v: 2, type, sid: this.sid, epoch: this.epoch, payload }; if (withRid) m.rid = rid(); this.send(m); return m.rid; }
  async run(cmd, marker, ms = 20000) { const before = this.text().length; this.input(cmd + '\r'); await this.until(() => (marker instanceof RegExp ? marker.test(this.text().slice(before)) : this.text().slice(before).includes(marker)), ms, `output ${marker}`); return this.text().slice(before); }
  close() { try { this.ws.close(); } catch { /* noop */ } }
}

/** Raw TCP WebSocket peer for frames a conforming client library refuses to produce. */
function rawConnect(port, token, { origin, protocol = 'hermit.vws.v2', path: p = '/ws/terminal', extra = '' } = {}) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1');
    let buf = Buffer.alloc(0), upgraded = false; const frames = []; const waiters = [];
    const api = { socket: s, frames, status: null, headers: '', closed: false,
      sendFrame(op, payload, { mask = true, fin = true, rsv = 0, lenOverride } = {}) {
        payload = Buffer.from(payload); const n = lenOverride === undefined ? payload.length : lenOverride; let head;
        if (n < 126) head = Buffer.from([0, (mask ? 0x80 : 0) | n]);
        else if (n < 65536) { head = Buffer.alloc(4); head[1] = (mask ? 0x80 : 0) | 126; head.writeUInt16BE(n, 2); }
        else { head = Buffer.alloc(10); head[1] = (mask ? 0x80 : 0) | 127; head.writeUInt32BE(Math.floor(n / 2 ** 32), 2); head.writeUInt32BE(n >>> 0, 6); }
        head[0] = (fin ? 0x80 : 0) | rsv | op;
        if (!mask) return s.write(Buffer.concat([head, payload]));
        const k = crypto.randomBytes(4); const m = Buffer.from(payload); for (let i = 0; i < m.length; i++) m[i] ^= k[i & 3];
        s.write(Buffer.concat([head, k, m]));
      },
      sendJson(o) { api.sendFrame(1, JSON.stringify(o)); },
      sendInput(seq, data) { const p = Buffer.from(data); const b = Buffer.alloc(7 + p.length); b[0] = 1; b.writeUIntBE(seq, 1, 6); p.copy(b, 7); api.sendFrame(2, b); },
      async until(pred, ms = 5000) { const end = Date.now() + ms; for (;;) { const v = pred(); if (v) return v; if (Date.now() > end) throw new Error('raw timeout ' + JSON.stringify(frames.slice(-2))); await new Promise((r) => { waiters.push(r); setTimeout(r, 40); }); } },
      closeFrame() { return frames.find((f) => f.op === 8); } };
    s.on('connect', () => {
      s.write(`GET ${p} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n` +
        (protocol ? `Sec-WebSocket-Protocol: ${protocol}\r\n` : '') + (origin ? `Origin: ${origin}\r\n` : '') + (token ? `Authorization: Bearer ${token}\r\n` : '') + extra + '\r\n');
    });
    s.on('data', (c) => {
      buf = Buffer.concat([buf, c]);
      if (!upgraded) {
        const i = buf.indexOf('\r\n\r\n'); if (i < 0) return;
        api.headers = buf.subarray(0, i).toString(); api.status = parseInt(api.headers.split(' ')[1], 10); buf = buf.subarray(i + 4); upgraded = true; resolve(api);
        if (api.status !== 101) return;
      }
      for (;;) {
        if (buf.length < 2) break; let n = buf[1] & 0x7f, off = 2;
        if (n === 126) { if (buf.length < 4) break; n = buf.readUInt16BE(2); off = 4; } else if (n === 127) { if (buf.length < 10) break; n = buf.readUInt32BE(6); off = 10; }
        if (buf.length < off + n) break;
        const payload = buf.subarray(off, off + n); const op = buf[0] & 15;
        frames.push({ op, payload: Buffer.from(payload), code: op === 8 && n >= 2 ? payload.readUInt16BE(0) : null, json: op === 1 ? JSON.parse(payload.toString()) : null, seq: op === 2 && n >= 7 ? payload.readUIntBE(1, 6) : null });
        buf = buf.subarray(off + n);
      }
      const w = waiters.splice(0); for (const f of w) f();
    });
    s.on('close', () => { api.closed = true; const w = waiters.splice(0); for (const f of w) f(); });
    s.on('error', reject);
  });
}

async function getTicketCookie(h, token, origin) {
  const res = await fetch(h.http + '/api/ws-ticket', { method: 'POST', headers: { authorization: `Bearer ${token}`, ...(origin ? { origin } : {}) } });
  const sc = res.headers.get('set-cookie');
  return { status: res.status, cookie: sc ? sc.split(';')[0] : null, raw: sc, body: await res.json().catch(() => null) };
}

module.exports = { startGateway, Client, rawConnect, getTicketCookie, rid, sleep, DF_ROOT };
