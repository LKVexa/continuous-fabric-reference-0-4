'use strict';
/**
 * One authenticated WebSocket connection = at most one virtual session = one supervised worker.
 * hermit.vws.v2 / RAMWS profile LOCAL_VOLATILE (kit R10-R13, R21-R23, R30).
 *
 *   CONNECTING -> AUTHENTICATED -> OPENING -> ACTIVE -> DRAINING -> CLOSED
 *
 * Every operation is admitted through an eight-field descriptor (ram/descriptor.js) built from SERVER state.
 * Every retained byte range is a lease in this connection's ledger accounts (ram/ledger.js):
 *   conn account  transport buckets  (reassembly, queued_out, inflight_out, bridge, metadata)   admitted at upgrade
 *   sess account  worker buckets     (worker_runtime, vfs, history, workspace)                  admitted at session.open
 * Output is sent only against byte credits granted by the client (classic browser WebSockets have no
 * backpressure of their own). Nothing here is written to disk; process loss loses the session by design.
 */
const crypto = require('node:crypto');
const { createThreadLink, createProcessLink } = require('./worker-link');
const { createAdmission } = require('../ram/descriptor');

const rid = () => crypto.randomBytes(12).toString('base64url');

class Connection {
  constructor({ ws, principal, origin, cfg, codec, log, registry, ram, account, remote }) {
    Object.assign(this, { ws, principal, origin, cfg, codec, log, registry, ram, account, remote });
    this.id = crypto.randomBytes(6).toString('hex');
    this.state = 'AUTHENTICATED';
    this.gen = 1;
    this.sid = null; this.epoch = ram.serverEpoch;
    this.link = null; this.linkReady = false; this.sessAccount = null;
    this.inSeq = 0; this.executedSeq = 0; this.ackedAccepted = 0; this.ackedExecuted = 0; this.ackTimer = null;
    this.outSeq = 0; this.sentBytes = 0; this.creditBytes = 0; this.consumedSeq = 0; this.consumedBytes = 0;
    this.outstanding = [];            // [{seq, cum}] sent, not yet consumed — bounded by maxOutstandingMessages
    this.pendingOut = [];             // [{bytes, lease}] produced, not yet sendable (credit or socket budget)
    this.consumedPending = 0; this.consumedTimer = null;
    this.workerPaused = false; this.pausedAt = 0; this.discardOutput = false;
    this.rids = new Set(); this.ridOrder = [];
    this.tokens = cfg.msgRate * 2; this.tokenAt = Date.now(); this.strikes = 0;
    this.timers = new Set();
    this.exitSent = false; this.closing = false; this.lastActivity = Date.now();
    this.usage = null; this.header = Buffer.allocUnsafe(7);

    this.admission = createAdmission({ principalId: `${principal.tenant}/${principal.sub}`, sessionId: this.id, serverEpoch: ram.serverEpoch, account,
      profile: cfg.profile, runtimeId: ram.runtimeId, getState: () => this.state, planId: ram.planId });

    ws.on('text', (bytes) => this._onText(bytes));
    ws.on('binary', (bytes) => this._onBinary(bytes));
    ws.on('drain', () => this._flush());
    ws.on('close', (info) => this._onSocketClose(info));

    this._control({ v: 2, type: 'hello', payload: { protocol: 'hermit.vws.v2', serverEpoch: ram.serverEpoch, profile: 'LOCAL_VOLATILE',
      limits: { envelopeBytes: cfg.envelopeBytes, inputBytes: cfg.inputBytes, outputChunkBytes: cfg.outputChunkBytes, maxCreditWindowBytes: cfg.creditWindowBytes, maxSessions: registry.sessionCap },
      capabilities: { resume: false, browserPane: false, virtualCommands: true, fabric: !!(cfg.fabric && principal.capabilities.has('fabric')) } } });
    this._after(cfg.openTimeoutMs, () => { if (this.state === 'AUTHENTICATED') this._fatal('NOT_READY', 'no session.open within the open deadline', 1008); });
    this._every(cfg.heartbeatMs, () => this._heartbeat());
    this._every(Math.min(30000, cfg.idleMs), () => {
      if (Date.now() - this.lastActivity > cfg.idleMs) this.end('expired', 1000);
      else if (!registry.identity.stillValid(principal)) { this._error('UNAUTHORIZED', 'credential revoked or expired', false); this.end('expired', 1008); }
    });
  }

  /* ---- timers, fenced by generation -------------------------------------- */
  _after(ms, fn) { const g = this.gen; const t = setTimeout(() => { this.timers.delete(t); if (g === this.gen) fn(); }, ms); if (t.unref) t.unref(); this.timers.add(t); return t; }
  _every(ms, fn) { const g = this.gen; const t = setInterval(() => { if (g === this.gen) fn(); }, ms); if (t.unref) t.unref(); this.timers.add(t); return t; }
  _clearTimers() { for (const t of this.timers) { clearTimeout(t); clearInterval(t); } this.timers.clear(); }

  /* ---- outbound control (JSON) -------------------------------------------- */
  _control(msg) {
    let text;
    try { text = this.codec.encode(msg, 'server_to_client'); }
    catch (e) { this.log.error('conn.encode_failed', { conn: this.id, type: msg.type, reason: e.message }); return false; }
    // Control traffic has reserved budget so close/error/heartbeat/acks cannot be trapped behind terminal data.
    if (!this.ws.sendText(text, { control: true })) { this.log.warn('conn.control_budget_exhausted', { conn: this.id }); this.ws.terminate(1008, 'send queue exhausted'); return false; }
    return true;
  }
  _error(code, message, retryable) { return this._control({ v: 2, type: 'error', payload: { code, message: String(message).slice(0, 256), retryable: !!retryable } }); }
  _fatal(code, message, wsCode) { this._error(code, message, false); this.end(code === 'LIMIT_EXCEEDED' ? 'quota' : 'closed', wsCode || 1008); }

  /* ---- outbound data: credits + socket budget + leases ---------------------- */
  _canSend(n) { return this.sentBytes + n <= this.creditBytes && this.outstanding.length < this.cfg.maxOutstandingMessages; }
  _flush() {
    while (this.pendingOut.length) {
      const item = this.pendingOut[0];
      if (!this._canSend(item.bytes.length)) break;
      const op = this.admission.admit(this.admission.describe('output', 'binary', [item.lease]));
      if (op.state !== 'RESERVED') { this.log.error('conn.output_rejected', { conn: this.id, reason: op.reason }); this.pendingOut.shift(); item.lease.release(); continue; }
      const seq = this.outSeq + 1;
      if (seq >= this.codec.U48_MAX) return this._fatal('LIMIT_EXCEEDED', 'output sequence exhausted', 1008);
      this.admission.execute(op);
      const head = Buffer.from(this.codec.writeDataHeader(this.header, 'output', seq));   // 7 bytes; the payload is NOT copied
      if (!this.ws.sendBinary([head, item.bytes], { lease: item.lease })) { op.state = 'RESERVED'; op.fail('socket budget'); break; } // ws retained nothing: try again on 'drain'
      this.pendingOut.shift();
      this.outSeq = seq; this.sentBytes += item.bytes.length; this.outstanding.push({ seq, cum: this.sentBytes });
      this._consumed(item.bytes.length);        // releases the worker's in-flight window for this chunk (coalesced per tick)
      this.admission.complete(op);             // drops the producer's reference; ws still holds its own until the write CALLBACK
    }
    this._flow();
  }
  /** Backpressure reaches the SPIRAL producer: pause while anything is waiting for credit or socket budget. */
  _flow() {
    if (this.closing || !this.link) return;
    const congested = this.pendingOut.length > 0;
    if (congested && !this.workerPaused) { this.workerPaused = true; this.pausedAt = Date.now(); this.link.send({ t: 'pause' }); this.link.pause(); }
    else if (!congested && this.workerPaused) { this.workerPaused = false; this.pausedAt = 0; this.wping = null; this.link.send({ t: 'resume' }); this.link.resume(); }
  }
  /** Coalesce `consumed` records: one link message per event-loop turn, so a burst of small chunks costs one postMessage, not N. */
  _consumed(n) {
    if (!this.link) return;
    this.consumedPending += n;
    if (this.consumedTimer) return;
    this.consumedTimer = setImmediate(() => { this.consumedTimer = null; const b = this.consumedPending; this.consumedPending = 0; if (b && this.link) this.link.send({ t: 'consumed', bytes: b }); });
  }
  _output(bytes, info) {
    if (this.discardOutput || (this.state !== 'ACTIVE' && this.state !== 'DRAINING')) { this.ram.counters.undeliveredOutputBytes += bytes.length; this._consumed(bytes.length); return; }
    this.ram.traffic.add(info.transferred ? 'bridge_out_transfer' : 'bridge_out_copy', bytes.length);
    let lease;
    try { lease = this.account.acquire('queued_out', bytes.length, 'terminal').activate(bytes.length); }
    catch (e) { this.ram.counters.undeliveredOutputBytes += bytes.length; this.log.warn('conn.output_budget', { conn: this.id, scope: e.scope }); this._error('LIMIT_EXCEEDED', 'output exceeded the session memory budget', false); return this.end('quota', 1008, 'memory budget'); }
    this.pendingOut.push({ bytes, lease });
    this._flush();
  }

  /* ---- inbound ------------------------------------------------------------ */
  _rate() {
    const now = Date.now();
    this.tokens = Math.min(this.cfg.msgRate * 2, this.tokens + ((now - this.tokenAt) / 1000) * this.cfg.msgRate); this.tokenAt = now;
    if (this.tokens < 1) return false; this.tokens -= 1; return true;
  }
  _strike(code, msg, retryable) { if (++this.strikes > 20) return this._fatal(code, 'too many rejected messages', 1008); return void this._error(code, msg, retryable); }

  _onBinary(view) {
    if (this.state === 'CLOSED' || this.closing) return;
    this.lastActivity = Date.now();
    if (!this._rate()) return this._strike('LIMIT_EXCEEDED', 'message rate limit', true);
    let d;
    try { d = this.codec.decodeData(view, 'client_to_server'); }
    catch (e) { return this._strike(e.code === 'LIMIT_EXCEEDED' ? 'LIMIT_EXCEEDED' : e.code === 'WRONG_DIRECTION' ? 'UNSUPPORTED' : 'BAD_MESSAGE', 'data message rejected', false); }
    if (this.state !== 'ACTIVE') return void this._error('NOT_READY', 'session is not active', true);
    if (d.seq !== this.inSeq + 1) return void this._error('BAD_MESSAGE', `input seq must be ${this.inSeq + 1}`, false);
    if (d.seq >= this.codec.U48_MAX - 1) return this._fatal('LIMIT_EXCEEDED', 'input sequence exhausted', 1008);
    if (this.link.queuedInBytes() > this.cfg.workerStdinBytes) { this._error('LIMIT_EXCEEDED', 'input is arriving faster than the session consumes it', false); return this.end('quota', 1008, 'input backlog'); }
    // `view` dies with this event. Reserve, THEN copy into storage we own (one counted copy), admit, hand to the worker.
    let lease;
    try { lease = this.account.acquire('bridge', d.payload.length, 'terminal').activate(d.payload.length); }
    catch (e) { return this._strike('LIMIT_EXCEEDED', 'input exceeded the session memory budget', true); }
    const own = Buffer.allocUnsafeSlow(d.payload.length); own.set(d.payload); this.ram.traffic.add('bridge_in_copy', own.length);
    const op = this.admission.admit(this.admission.describe('input', 'binary', [lease]));
    if (op.state !== 'RESERVED') { lease.release(); return void this._error('NOT_READY', 'input not admitted', true); }
    this.admission.execute(op);
    this.inSeq = d.seq;                                   // ACK_ACCEPTED boundary: accepted into this process's RAM, nothing more
    // Lifetime: the lease outlives this call until the link reports LOCAL completion of the hand-off.
    lease.retain();
    this.link.send({ t: 'input', seq: d.seq }, own, () => { lease.release(); });
    this.admission.complete(op);
    this._scheduleAck();
  }
  _scheduleAck(now) {
    if (now) { if (this.ackTimer) { clearTimeout(this.ackTimer); this.timers.delete(this.ackTimer); this.ackTimer = null; } return this._sendAck(); }
    if (!this.ackTimer) this.ackTimer = this._after(this.cfg.ackCoalesceMs, () => { this.ackTimer = null; this._sendAck(); });
  }
  _sendAck() {
    if (this.state !== 'ACTIVE' || (this.inSeq === this.ackedAccepted && this.executedSeq === this.ackedExecuted)) return;
    this.ackedAccepted = this.inSeq; this.ackedExecuted = this.executedSeq;
    this._control({ v: 2, type: 'input.ack', sid: this.sid, epoch: this.epoch, payload: { acceptedSeq: this.inSeq, executedSeq: this.executedSeq } });
  }

  _onText(bytes) {
    if (this.state === 'CLOSED' || this.closing) return;
    this.lastActivity = Date.now();
    if (!this._rate()) return this._strike('LIMIT_EXCEEDED', 'message rate limit', true);
    let msg;
    try { ({ msg } = this.codec.decode(bytes, 'client_to_server')); }
    catch (e) { return this._strike(e.code === 'LIMIT_EXCEEDED' ? 'LIMIT_EXCEEDED' : e.code === 'WRONG_DIRECTION' ? 'UNSUPPORTED' : 'BAD_MESSAGE', 'message rejected', false); }
    if (msg.rid !== undefined && msg.type !== 'heartbeat.pong') {
      if (this.rids.has(msg.rid)) return void this._error('BAD_MESSAGE', 'duplicate rid', false);
      this.rids.add(msg.rid); this.ridOrder.push(msg.rid); if (this.ridOrder.length > 512) this.rids.delete(this.ridOrder.shift());
    }
    if (msg.sid !== undefined) {
      if (this.sid === null || msg.sid !== this.sid) return void this._error('FORBIDDEN', 'session not available', false);
      if (msg.epoch !== this.epoch) return void this._error('STALE_EPOCH', 'stale session epoch', false);
      if (this.state !== 'ACTIVE') return void this._error('NOT_READY', 'session is not active', true);
    }
    switch (msg.type) {
      case 'session.open': return this._open(msg);
      case 'terminal.resize': case 'terminal.signal': {
        const kind = msg.type === 'terminal.resize' ? 'resize' : 'signal';
        const op = this.admission.admit(this.admission.describe(kind, 'none', []));
        if (op.state !== 'RESERVED') return void this._error('NOT_READY', `${kind} not admitted`, true);
        this.admission.execute(op);
        this.link.send(kind === 'resize' ? { t: 'resize', cols: msg.payload.cols, rows: msg.payload.rows } : { t: 'signal', signal: 'SIGINT' });
        this.admission.complete(op);
        return void this._control({ v: 2, type: 'request.ack', rid: msg.rid, sid: this.sid, epoch: this.epoch, payload: { operation: msg.type, stage: 'accepted' } });
      }
      case 'flow.credit': return this._credit(msg.payload);
      case 'session.close': return this.end(msg.payload.reason === 'logout' ? 'logout' : 'closed', 1000);
      case 'heartbeat.ping': return void this._control({ v: 2, type: 'heartbeat.pong', rid: msg.rid, payload: { nonce: msg.payload.nonce } });
      case 'heartbeat.pong': if (this.hb && msg.payload.nonce === this.hb.nonce && msg.rid === this.hb.rid) { clearTimeout(this.hb.timer); this.timers.delete(this.hb.timer); this.hb = null; } return undefined;
      default: return void this._error('UNSUPPORTED', 'unsupported message', false);
    }
  }

  /** CREDIT: cumulative, monotone, bounded window, bound to the live sid/epoch (already checked). Not a durable delivery record. */
  _credit({ consumedSeq, creditBytes }) {
    const bad = (why) => { this._error('CREDIT_VIOLATION', why, false); return this.end('closed', 1008, 'credit violation'); };
    if (consumedSeq < this.consumedSeq || consumedSeq > this.outSeq) return bad('consumedSeq outside the sent range');
    if (creditBytes < this.creditBytes) return bad('credit must not decrease');
    while (this.outstanding.length && this.outstanding[0].seq <= consumedSeq) this.consumedBytes = this.outstanding.shift().cum;
    this.consumedSeq = consumedSeq;
    if (creditBytes - this.consumedBytes > this.cfg.creditWindowBytes) return bad('credit window exceeds limits.maxCreditWindowBytes');
    this.creditBytes = creditBytes;
    this._flush();
    return undefined;
  }

  _heartbeat() {
    if (this.state === 'CLOSED' || this.hb) return;
    const hb = { rid: rid(), nonce: rid() };
    hb.timer = this._after(this.cfg.heartbeatWindowMs, () => { this.log.info('conn.heartbeat_timeout', { conn: this.id }); this.end('expired', 1008, 'heartbeat timeout'); });
    this.hb = hb;
    this._control({ v: 2, type: 'heartbeat.ping', rid: hb.rid, payload: { nonce: hb.nonce } });
  }

  /* ---- session + worker ---------------------------------------------------- */
  _open(msg) {
    if (this.state !== 'AUTHENTICATED') return void this._error('BAD_MESSAGE', 'a session is already open on this connection', false);
    if (!this.principal.capabilities.has('terminal')) return this._fatal('FORBIDDEN', 'terminal capability not granted', 1008);
    if (this.registry.draining) return this._fatal('NOT_READY', 'service is draining', 1001);
    if (msg.payload.creditBytes > this.cfg.creditWindowBytes) return this._fatal('CREDIT_VIOLATION', 'initial credit exceeds limits.maxCreditWindowBytes', 1008);
    if (!this.registry.reserve(this)) return this._fatal('LIMIT_EXCEEDED', 'session capacity reached', 1013);
    // Budget invariant: the worker's whole reservation is charged to session/tenant/global BEFORE the worker exists.
    const r = this.ram.workerReservation;
    try {
      this.sessAccount = this.ram.ledger.admit(`sess:${this.id}`, this.principal.tenant, r.total, {});
      for (const [bucket, bytes] of Object.entries(r.parts)) this.sessAccount.reserveCapacity(bucket, bytes, 'terminal');
    } catch (e) { this.registry.release(this); this.log.info('session.refused_memory', { conn: this.id, scope: e.scope }); return this._fatal('LIMIT_EXCEEDED', `memory budget refused at ${e.scope || 'ledger'}`, 1013); }

    // Volatile restart semantics (kit R30): state from another epoch or an unknown sid cannot be revived. Say so, once, first.
    const prev = msg.payload.previous;
    if (prev) {
      const reason = prev.epoch !== this.epoch ? 'process_restart' : 'session_not_found';
      this._control({ v: 2, type: 'session.reset', rid: msg.rid, payload: { reason, outcome: prev.pendingInputs > 0 ? 'OUTCOME_UNKNOWN' : 'NO_PENDING_INPUT', previousEpoch: prev.epoch, pendingInputs: prev.pendingInputs } });
      this.ram.counters.sessionResets++;
    }
    this.state = 'OPENING'; this.openRid = msg.rid; this.creditBytes = msg.payload.creditBytes;
    const cfg = this.cfg; const fabric = cfg.fabric && this.principal.capabilities.has('fabric');
    const env = { PATH: process.env.PATH || '', VWS_W_CONN: this.id, VWS_W_VFS_BYTES: String(cfg.vfsBytes), VWS_W_VFS_NODES: String(cfg.vfsNodes), VWS_W_PENDING_BYTES: String(cfg.workerPendingBytes), VWS_W_CAPTURE_BYTES: String(cfg.captureBytes), VWS_W_HISTORY_ENTRIES: String(cfg.historyEntries) };
    for (const k of ['HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'SYSTEMROOT', 'JAVA_HOME', 'PATHEXT', 'COMSPEC']) if (process.env[k] !== undefined) env[k] = process.env[k];
    if (fabric) Object.assign(env, { VWS_W_FABRIC: '1', VWS_W_DF_ROOT: cfg.dfRoot, VWS_W_FABRIC_BUILD: cfg.fabricBuild ? '1' : '0', VWS_W_FABRIC_SLOTS: String(cfg.fabricSlots) });
    if (cfg.python) env.VWS_W_PYTHON = cfg.python;
    // CFP extension: fixed internal bridge, authenticated principal, scoped capability.
    if (cfg.cfp) Object.assign(env, { CFP_BRIDGE_URL: cfg.cfp.url, CFP_BRIDGE_KEY: cfg.cfp.key, CFP_SUB: this.principal.sub, CFP_TENANT: this.principal.tenant, CFP_SUBMIT: this.principal.capabilities.has('fabric') ? '1' : '0' });
    const g = this.gen;
    const hooks = { root: cfg.root, env, heapBytes: cfg.workerHeapBytes, assemblyMs: cfg.bridgeAssemblyMs, log: this.log,
      onRecord: (rec, bytes, info) => { if (g === this.gen) this._fromWorker(rec, bytes, info); },
      onExit: (e) => { if (g === this.gen) this._workerExited(e); } };
    this.link = cfg.workerBackend === 'thread' ? createThreadLink(hooks) : createProcessLink(hooks);
    this._after(cfg.workerReadyMs, () => { if (this.state === 'OPENING') { this.log.error('worker.ready_timeout', { conn: this.id }); this._workerFailed('ready timeout'); } });
    this.pendingOpen = { cols: msg.payload.cols, rows: msg.payload.rows };
    return undefined;
  }

  _fromWorker(r, bytes, info) {
    switch (r.t) {
      case 'ready': if (this.linkReady) return; this.linkReady = true; this.link.send({ t: 'open', ...this.pendingOpen }); return;
      case 'opened':
        if (this.state !== 'OPENING') return;
        this.sid = crypto.randomBytes(18).toString('base64url');
        this.state = 'ACTIVE'; this.registry.activate(this);
        this._control({ v: 2, type: 'session.opened', rid: this.openRid, sid: this.sid, epoch: this.epoch, payload: { cols: r.cols, rows: r.rows } });
        this._every(this.cfg.workerPingMs, () => this._pingWorker());
        this.log.info('session.opened', { conn: this.id, tenant: this.principal.tenant, sub: this.principal.sub, backend: this.link.kind });
        return;
      case 'output': return this._output(bytes, info);
      case 'executed': if (r.upto > this.executedSeq && r.upto <= this.inSeq) { this.executedSeq = r.upto; this._scheduleAck(true); } return;   // ACK_EXECUTED is never delayed
      case 'pong': if (this.wping && r.nonce === this.wping.nonce) { this.wping = null; this.usage = r.usage || null; } return;
      case 'exit': this.workerExit = { code: r.code, reason: r.reason }; return;
      case 'diag': this.log.info('worker.diag', { conn: this.id, level: r.level, msg: r.msg }); return;
      default: return;
    }
  }

  _pingWorker() {
    if (!this.link || this.state !== 'ACTIVE') return;
    const now = Date.now();
    if (this.workerPaused) {
      if (now - this.pausedAt > this.cfg.maxPauseMs) { this.log.info('conn.slow_consumer', { conn: this.id, pausedMs: now - this.pausedAt }); this._error('LIMIT_EXCEEDED', 'output was not consumed within the pause budget', false); this.end('quota', 1008, 'slow consumer'); }
      if (this.link.kind === 'process') return;        // a paused pipe cannot deliver pongs; the thread link still can
    }
    if (this.wping && now - this.wping.at > this.cfg.workerStallMs) { this.log.warn('worker.unresponsive', { conn: this.id, ms: now - this.wping.at }); return this._workerFailed('unresponsive'); }
    if (!this.wping) { this.wping = { nonce: rid(), at: now }; this.link.send({ t: 'ping', nonce: this.wping.nonce }); }
  }

  _workerFailed(why) { this.workerExit = { code: 70, reason: 'worker_failure' }; if (this.link) this.link.kill(); this.log.warn('worker.failed', { conn: this.id, why }); this._finalExit(); this._closeSocket(1011, 'worker failure'); }
  _workerExited(e) {
    const link = this.link; this.link = null;
    if (!this.workerExit) this.workerExit = (this.closing && (e.ok || this.killedByUs)) ? { code: 0, reason: this.endReason || 'closed' } : { code: 70, reason: e.oom ? 'quota' : 'worker_failure' };
    if (e.oom) { this.ram.counters.workerHeapCapHits++; this._error('LIMIT_EXCEEDED', 'the session exceeded its memory cap and was ended', false); }
    if (this.workerExit.reason === 'worker_failure') this.log.warn('worker.exit_abnormal', { conn: this.id, backend: link && link.kind, detail: e.detail });
    this._finalExit();
    this._closeSocket(this.workerExit.reason === 'worker_failure' ? 1011 : (this.wsCode || (e.oom ? 1008 : 1000)), this.workerExit.reason);
  }

  /** Exactly one authoritative session.exit, ordered after all output already handed to the socket. */
  _finalExit() {
    if (this.exitSent || this.sid === null) { this._releaseSession(); return; }
    this.exitSent = true;
    const e = this.workerExit || { code: 0, reason: this.endReason || 'closed' };
    // Output still waiting for credit cannot be delivered any more: return its memory, and SAY that it was cut.
    const cut = this.pendingOut.reduce((a, x) => a + x.bytes.length, 0);
    for (const x of this.pendingOut) x.lease.release(); this.pendingOut.length = 0;
    if (cut) this.ram.counters.undeliveredOutputBytes += cut;
    this._control({ v: 2, type: 'session.exit', sid: this.sid, epoch: this.epoch, payload: { code: e.code, reason: e.reason } });
    this.log.info('session.exit', { conn: this.id, code: e.code, reason: e.reason, outSeq: this.outSeq, inSeq: this.inSeq, executedSeq: this.executedSeq, undeliveredBytes: cut });
    this._releaseSession();
  }
  _releaseSession() { if (this.consumedTimer) { clearImmediate(this.consumedTimer); this.consumedTimer = null; } this.registry.release(this); if (this.sessAccount) { const a = this.sessAccount; this.sessAccount = null; for (const l of [...a.leases.values()]) l.release(); a.close(); } }

  end(reason, wsCode, wsReason) {
    if (this.closing || this.state === 'CLOSED') return;
    this.closing = true; this.endReason = reason; this.wsCode = wsCode || 1000; this.wsReason = wsReason || reason;
    this.state = 'DRAINING';
    if (!this.link) { this._finalExit(); return this._closeSocket(this.wsCode, this.wsReason); }
    if (this.workerPaused) { this.discardOutput = true; this.workerPaused = false; this.link.resume(); }
    const bridgeReason = ['closed', 'logout', 'shutdown', 'expired', 'quota'].includes(reason) ? reason : 'closed';
    if (!this.link.send({ t: 'close', reason: bridgeReason })) { this.killedByUs = true; return void this.link.kill(); }
    this.link.stop(1500, () => { this.killedByUs = true; });
    return undefined;
  }

  _closeSocket(code, reason) { this._clearTimers(); this.ws.close(code, reason || ''); }

  _onSocketClose(info) {
    if (this.state === 'CLOSED') return;
    this.log.info('conn.closed', { conn: this.id, code: info.code, clean: info.clean, initiator: info.initiator });
    if (this.link && !this.closing) { this.closing = true; this.endReason = 'closed'; const l = this.link; if (!l.send({ t: 'close', reason: 'closed' })) l.kill(); else l.stop(1500); }
    this.state = 'CLOSED';
    this.gen++;                                           // fence every outstanding callback
    this._clearTimers();
    const cut = this.pendingOut.reduce((a, x) => a + x.bytes.length, 0); if (cut) this.ram.counters.undeliveredOutputBytes += cut;
    for (const x of this.pendingOut) x.lease.release(); this.pendingOut.length = 0; this.outstanding.length = 0;
    this._releaseSession();
    // Transport leases still in flight return in their write callbacks; the account's reservation follows the last one.
    this.account.close();
    this.registry.forget(this);
  }

  /** Bounded, payload-free view for telemetry. */
  telemetry() {
    return { state: this.state, backend: this.link ? this.link.kind : null, inSeq: this.inSeq, executedSeq: this.executedSeq, outSeq: this.outSeq, consumedSeq: this.consumedSeq,
      creditRemainingBytes: Math.max(0, this.creditBytes - this.sentBytes), pendingOutMessages: this.pendingOut.length, outstandingMessages: this.outstanding.length, inflightBytes: this.ws.queuedBytes,
      paused: this.workerPaused, transport: this.account.snapshot(), session: this.sessAccount ? this.sessAccount.snapshot() : null, workerUsage: this.usage };
  }
}

module.exports = { Connection };
