'use strict';
/**
 * Worker-side bounded output stage (series I019 / I030).
 *   kernel text -> UTF-8 -> chunks of <= chunkBytes raw bytes -> bridge 'output' records
 * Chunks may split a multi-byte character; the receiving side uses a streaming
 * decoder, and byte order is preserved exactly.
 *
 * Backpressure: `pause` from the gateway or a full stdout pipe congests the gate.
 * While congested, bytes queue up to `maxPendingBytes`. A cooperative producer
 * (the DF CLI pump) stops reading its child when `paused()` is true. A producer
 * that ignores backpressure and overflows the queue is aborted and the terminal
 * receives an explicit gap marker — output is never dropped silently.
 */
class OutputGate {
  constructor({ send, chunkBytes = 16384, maxPendingBytes = 1048576, onOverflow }) {
    this.send = send;               // (Buffer) => boolean   false => sink is full
    this.chunkBytes = chunkBytes;
    this.maxPendingBytes = maxPendingBytes;
    this.onOverflow = onOverflow;
    this.queue = [];
    this.pendingBytes = 0;
    this.remotePaused = false;
    this.sinkFull = false;
    this.dropping = false;
    this.drainWaiters = [];
    this.inflight = 0;               // bytes handed to the link but not yet CONSUMED by the gateway (thread backend has no pipe to push back)
    this.stats = { bytes: 0, chunks: 0, overflows: 0, droppedBytes: 0 };
  }
  paused() { return this.remotePaused || this.sinkFull || this.pendingBytes > this.chunkBytes * 4 || this.inflight > this.maxPendingBytes / 2; }
  /** The gateway accepted these bytes into its ledgered send path (or dropped them): they no longer count against us. */
  consumed(n) { this.inflight = Math.max(0, this.inflight - n); this._pump(); }
  onDrain(fn) { if (!this.paused()) fn(); else this.drainWaiters.push(fn); }

  write(text) {
    // Exact-capacity, exclusively owned storage for the common small write, so the THREAD backend can TRANSFER it
    // (Buffer.from(string) would hand out a slice of Node's shared 8 KiB pool, which cannot change owner).
    let buf;
    if (Buffer.isBuffer(text)) buf = text;
    else { const str = String(text); const n = Buffer.byteLength(str, 'utf8'); if (n <= this.chunkBytes) { buf = Buffer.allocUnsafeSlow(n); buf.write(str, 0, 'utf8'); } else buf = Buffer.from(str, 'utf8'); }
    if (this.dropping) { this.stats.droppedBytes += buf.length; return; }
    if (this.pendingBytes + buf.length > this.maxPendingBytes) {
      this.stats.overflows++; this.stats.droppedBytes += buf.length;
      this.dropping = true;
      const marker = Buffer.from('\r\n\x1b[1;33m[output gap: producer exceeded the session output buffer; command interrupted]\x1b[0m\r\n', 'utf8');
      this.queue.push(marker); this.pendingBytes += marker.length;
      if (this.onOverflow) this.onOverflow();
      this._pump();
      return;
    }
    for (let o = 0; o < buf.length; o += this.chunkBytes) {
      let c = buf.subarray(o, Math.min(buf.length, o + this.chunkBytes));
      if (c.length !== buf.length) { const own = Buffer.allocUnsafeSlow(c.length); c.copy(own); c = own; this.stats.chunkCopyBytes = (this.stats.chunkCopyBytes || 0) + own.length; } // one counted copy per chunk of a large write
      this.queue.push(c); this.pendingBytes += c.length;
    }
    this._pump();
  }
  /** Called when the interrupted producer has stopped; output flows again. */
  clearOverflow() { this.dropping = false; }
  setRemotePaused(v) { this.remotePaused = !!v; if (!v) this._pump(); }
  sinkDrained() { this.sinkFull = false; this._pump(); }

  _pump() {
    while (this.queue.length && !this.remotePaused && !this.sinkFull) {
      const c = this.queue.shift();
      this.pendingBytes -= c.length;
      this.stats.bytes += c.length; this.stats.chunks++;
      this.inflight += c.length;
      if (this.send(c) === false) this.sinkFull = true;
      if (this.inflight > this.maxPendingBytes / 2) break;   // stop producing until the gateway reports consumption
    }
    if (!this.paused() && this.drainWaiters.length) { const w = this.drainWaiters; this.drainWaiters = []; for (const fn of w) fn(); }
  }
}
module.exports = { OutputGate };
