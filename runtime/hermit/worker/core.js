'use strict';
/**
 * Transport-neutral headless SPIRAL session (kit R22, R23). One instance = one virtual session.
 * Hosts: worker/host.js (separate process, framed pipe) and worker/thread.js (worker thread, MessagePort with
 * transferred ArrayBuffers). Both speak the same records; only how bytes cross the boundary differs.
 *
 *   emit(record, bytes)   record is a small plain object; `bytes` (Buffer) accompanies t:'output'
 */
const path = require('node:path');
const os = require('node:os');
const { SpiralKernel } = require('../src/main/spiral/kernel');
const { OutputGate } = require('./output-gate');
const { commandFilter, advertised } = require('./capabilities');
const { createLease } = require('./fabric-lease');

const VERSION = require('../package.json').version;

function readConfig(env) {
  const int = (name, def, lo, hi) => { const v = Number(env[name]); return Number.isInteger(v) && v >= lo && v <= hi ? v : def; };
  return {
    fabric: env.VWS_W_FABRIC === '1' && !!env.VWS_W_DF_ROOT,
    dfRoot: env.VWS_W_DF_ROOT ? path.resolve(env.VWS_W_DF_ROOT) : null,
    allowBuild: env.VWS_W_FABRIC_BUILD === '1',
    slots: int('VWS_W_FABRIC_SLOTS', 2, 1, 8),
    leaseDir: env.VWS_W_LEASE_DIR || path.join(os.tmpdir(), 'hermit-vws-fabric-lease'),
    python: env.VWS_W_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
    vfsBytes: int('VWS_W_VFS_BYTES', 4194304, 4096, 268435456),
    vfsNodes: int('VWS_W_VFS_NODES', 1000, 16, 100000),
    captureBytes: int('VWS_W_CAPTURE_BYTES', 1048576, 1024, 67108864),
    pendingBytes: int('VWS_W_PENDING_BYTES', 2097152, 65536, 67108864),
    historyEntries: int('VWS_W_HISTORY_ENTRIES', 500, 10, 100000),
    childEnv: (() => { const e = {}; for (const k of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'SYSTEMROOT', 'JAVA_HOME', 'PATHEXT', 'COMSPEC']) if (env[k] !== undefined) e[k] = env[k]; e.PYTHONDONTWRITEBYTECODE = '1'; return e; })()
  };
}

function createWorkerSession({ env, emit, onFinished, diag }) {
  const cfg = readConfig(env);
  let kernel = null, sessionId = null, finished = false, closingReason = null, lastInputSeq = 0, sinkFull = false;
  const utf8In = new (require('node:string_decoder').StringDecoder)('utf8');

  const gate = new OutputGate({
    chunkBytes: 16384, maxPendingBytes: cfg.pendingBytes,
    send: (buf) => { const ok = emit({ t: 'output' }, buf); if (ok === false) sinkFull = true; return ok; },
    onOverflow: () => { const s = kernel && kernel.sessions.get(sessionId); if (s && s.running) s.running.abort('OUTPUT_OVERFLOW'); else gate.clearOverflow(); }
  });

  function buildKernel() {
    const host = { version: () => VERSION, flow: gate };
    if (cfg.fabric) host.fabricPolicy = { remote: true, root: cfg.dfRoot, allowBuild: cfg.allowBuild, python: cfg.python, env: cfg.childEnv, deadlineMs: { run: 180000, verify: 900000, build: 900000 }, acquire: createLease({ dir: cfg.leaseDir, slots: cfg.slots }) };
    const k = new SpiralKernel({ hostBridge: host, limits: { captureBytes: cfg.captureBytes, historyEntries: cfg.historyEntries }, vfsLimits: { maxBytes: cfg.vfsBytes, maxNodes: cfg.vfsNodes }, commandFilter: commandFilter({ fabric: cfg.fabric }) });
    require('../../../lib/terminal-command').install(k, env);
    k.on('data', (e) => { if (e.sessionId === sessionId) gate.write(e.chunk); });
    k.on('command-complete', (e) => { if (e.sessionId === sessionId && !finished) emit({ t: 'executed', upto: lastInputSeq, code: Math.max(0, Math.min(255, e.code | 0)) }); });
    k.on('exit', (e) => { if (e.sessionId === sessionId) finish(e.code, e.reason === 'logout' ? 'logout' : (closingReason || 'closed')); });
    return k;
  }

  function finish(code, reason) {
    if (finished) return; finished = true;
    gate.setRemotePaused(false); if (gate.queue.length && !gate.sinkFull) gate._pump();
    const done = () => { emit({ t: 'exit', code: Math.max(0, Math.min(255, code | 0)), reason }); onFinished(); };
    setTimeout(done, gate.queue.length ? 200 : 0);
  }

  /** Current usage of the quotas this session was admitted with (observations for the gateway's ledger view). */
  function usage() {
    const s = kernel && kernel.sessions.get(sessionId); const v = kernel ? kernel.vfs.usage() : { bytes: 0, nodes: 0 };
    let hist = 0; if (s) for (const h of s.history) hist += h.length * 2;
    return { vfsBytes: v.bytes, vfsNodes: v.nodes, historyBytes: hist, pendingOutBytes: gate.pendingBytes, overflows: gate.stats.overflows };
  }

  function handle(rec, bytes) {
    switch (rec.t) {
      case 'open': {
        if (sessionId) return diag('warn', 'duplicate open ignored');
        kernel = buildKernel();
        const opened = kernel.openSession({ cols: rec.cols, rows: rec.rows, deferStart: true });
        sessionId = opened.sessionId;
        emit({ t: 'opened', cols: opened.cols, rows: opened.rows, restored: false });   // ordered before any output (open barrier)
        kernel.startSession(sessionId);
        return undefined;
      }
      case 'input':
        if (!sessionId) return undefined;
        if (Number.isSafeInteger(rec.seq) && rec.seq > lastInputSeq) lastInputSeq = rec.seq;
        try { kernel.write(sessionId, utf8In.write(bytes)); } catch (e) { diag('warn', `input handler: ${e && e.message}`); }
        return undefined;
      case 'resize': if (sessionId) kernel.resize(sessionId, rec.cols, rec.rows); return undefined;
      case 'signal': if (sessionId) kernel.signal(sessionId, rec.signal); return undefined;
      case 'pause': gate.setRemotePaused(true); return undefined;
      case 'consumed': gate.consumed(rec.bytes); return undefined;
      case 'resume': gate.setRemotePaused(false); return undefined;
      case 'ping': { const s = kernel && kernel.sessions.get(sessionId); return void emit({ t: 'pong', nonce: rec.nonce, busy: !!(s && s.running), usage: usage() }); }
      case 'close': closingReason = rec.reason; if (sessionId && kernel.closeSession(sessionId, rec.reason)) return undefined; return finish(0, rec.reason);
      default: return undefined;
    }
  }
  return { handle, finish, sinkDrained: () => { sinkFull = false; gate.sinkDrained(); }, gate, cfg, ready: () => emit({ t: 'ready', pid: process.pid, version: VERSION, capabilities: advertised({ fabric: cfg.fabric }) }),
    shutdown: (reason) => { closingReason = reason; if (sessionId && kernel.closeSession(sessionId, reason)) return; finish(0, reason); } };
}

module.exports = { createWorkerSession, readConfig, VERSION };
