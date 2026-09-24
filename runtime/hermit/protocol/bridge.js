'use strict';
/**
 * Local gateway <-> worker bridge framing (series I027).
 * ---------------------------------------------------------------------------
 * Record = uint32 big-endian body length + exactly that many UTF-8 JSON bytes.
 *   - body length 1..65536; zero-length and oversize are protocol errors,
 *     detected from the 4 header bytes BEFORE any body allocation
 *   - handles split headers, split bodies and many records per read
 *   - assembly deadline for a partially received record
 *   - end(): distinguishes clean idle EOF from a truncated record
 * Records are validated against protocol/bridge.schema.json; unknown record
 * types or properties are rejected (no ad hoc JSON across the boundary).
 */
const fs = require('node:fs');
const path = require('node:path');
const { strictParse, check, CodecError } = require('./codec');

const MAX_BODY = 65536;
const ASSEMBLY_MS = 5000;
const schema = JSON.parse(fs.readFileSync(path.join(__dirname, 'bridge.schema.json'), 'utf8'));

function validateRecord(rec, direction) {
  if (rec === null || typeof rec !== 'object' || Array.isArray(rec) || typeof rec.t !== 'string') throw new CodecError('BRIDGE_BAD_RECORD', 'record.t missing');
  const s = schema[direction] && schema[direction][rec.t];
  if (!s) throw new CodecError('BRIDGE_BAD_RECORD', `record type not allowed ${direction}: ${String(rec.t).slice(0, 24)}`);
  const err = check(rec, s, '$');
  if (err) throw new CodecError('BRIDGE_BAD_RECORD', err);
  return rec;
}

function encodeRecord(rec, direction) {
  validateRecord(rec, direction);
  const body = Buffer.from(JSON.stringify(rec), 'utf8');
  if (body.length === 0 || body.length > MAX_BODY) throw new CodecError('BRIDGE_LIMIT', `record body ${body.length} bytes`);
  const out = Buffer.allocUnsafe(4 + body.length);
  out.writeUInt32BE(body.length, 0);
  body.copy(out, 4);
  return out;
}

class FrameDecoder {
  /**
   * @param {object} o
   * @param {string} o.direction          schema direction of INCOMING records
   * @param {(rec:object)=>void} o.onRecord
   * @param {(err:Error)=>void} o.onError  fatal; the decoder stops consuming afterwards
   */
  constructor(o) {
    this.direction = o.direction;
    this.onRecord = o.onRecord;
    this.onError = o.onError;
    this.assemblyMs = o.assemblyMs || ASSEMBLY_MS;
    this.header = Buffer.allocUnsafe(4);
    this.headerFill = 0;
    this.body = null;
    this.bodyFill = 0;
    this.failed = false;
    this.paused = false;
    this.timer = null;
    this.records = 0;
  }
  _fail(code, msg) {
    if (this.failed) return;
    this.failed = true;
    this._clear();
    this.body = null;
    this.onError(new CodecError(code, msg));
  }
  /** The reader deliberately stopped consuming (backpressure): a half-received record is NOT a stalled peer. */
  pause() { this.paused = true; this._clear(); }
  resume() { this.paused = false; if (this.body !== null || this.headerFill > 0) this._arm(); }
  _arm() { if (this.paused) return; if (!this.timer) { this.timer = setTimeout(() => this._fail('BRIDGE_ASSEMBLY_TIMEOUT', 'partial record exceeded assembly deadline'), this.assemblyMs); if (this.timer.unref) this.timer.unref(); } }
  _clear() { if (this.timer) { clearTimeout(this.timer); this.timer = null; } }

  push(chunk) {
    let off = 0;
    while (off < chunk.length && !this.failed) {
      if (this.body === null) {
        const take = Math.min(4 - this.headerFill, chunk.length - off);
        chunk.copy(this.header, this.headerFill, off, off + take);
        this.headerFill += take; off += take;
        if (this.headerFill < 4) { this._arm(); break; }
        const len = this.header.readUInt32BE(0);
        if (len === 0) return this._fail('BRIDGE_ZERO_LENGTH', 'zero-length record');
        if (len > MAX_BODY) return this._fail('BRIDGE_LIMIT', `declared body ${len} > ${MAX_BODY}`);
        this.body = Buffer.allocUnsafe(len); // bounded: len <= 65536, checked before allocation
        this.bodyFill = 0;
        this._arm();
      } else {
        const take = Math.min(this.body.length - this.bodyFill, chunk.length - off);
        chunk.copy(this.body, this.bodyFill, off, off + take);
        this.bodyFill += take; off += take;
        if (this.bodyFill < this.body.length) break;
        const body = this.body;
        this.body = null; this.headerFill = 0; this._clear();
        let rec;
        try {
          rec = validateRecord(strictParse(new TextDecoder('utf-8', { fatal: true }).decode(body)), this.direction);
        } catch (e) {
          return this._fail(e.code || 'BRIDGE_BAD_RECORD', e.message);
        }
        this.records++;
        try { this.onRecord(rec); } catch (e) { return this._fail('BRIDGE_HANDLER', e.message); }
      }
    }
  }
  /** @returns {'clean'|'truncated'} */
  end() {
    this._clear();
    return (this.body === null && this.headerFill === 0) ? 'clean' : 'truncated';
  }
}

module.exports = { FrameDecoder, encodeRecord, validateRecord, MAX_BODY, ASSEMBLY_MS };
