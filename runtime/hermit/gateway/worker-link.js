'use strict';
/**
 * Worker links (kit R08: fix transport and process boundaries). One interface, two explicit boundaries:
 *   ThreadLink   worker_threads + MessagePort, terminal bytes TRANSFERRED (no copy); V8 heap cap; terminate()
 *   ProcessLink  child process + framed pipe (strict JSON, base64): every byte is copied into a second address space
 * Interface: send(rec, bytes, onDone) · pause() · resume() · stop(graceMs) · kill() · events via callbacks
 *   onRecord(rec, bytes|null, info)   info.transferred / info.copied tell the traffic ledger what really happened
 *   onExit({ ok, detail })
 */
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Worker } = require('node:worker_threads');
const { FrameDecoder, encodeRecord } = require('../protocol/bridge');

function createThreadLink({ root, env, heapBytes, onRecord, onExit, log }) {
  let exited = false;
  const w = new Worker(path.join(root, 'worker', 'thread.js'), {
    workerData: { env }, env,                                        // the worker sees ONLY the allowlisted environment
    stdout: true, stderr: true,                                      // never writes into the gateway's streams
    resourceLimits: { maxOldGenerationSizeMb: Math.max(8, Math.floor(heapBytes / 1048576)), maxYoungGenerationSizeMb: 8, stackSizeMb: 2 }
  });
  let errTail = '';
  w.stderr.on('data', (c) => { errTail = (errTail + c).slice(-1024); }); w.stdout.on('data', () => {});
  const deliver = (m) => { const bytes = m.buf ? Buffer.from(m.buf) : null; const info = { transferred: !!m.buf && !m.copied, copied: !!m.copied }; if (m.buf) { delete m.buf; delete m.copied; } onRecord(m, bytes, info); };
  // MessagePort has no read-side pause. Output is never held here: every chunk goes straight to the connection, where it is
  // charged to the ledgered `queued_out` bucket (refusal ends the session with `quota`). The producer is throttled by the
  // OutputGate's in-flight accounting (gateway sends `consumed`), so what arrives while paused is bounded by that window.
  w.on('message', (m) => deliver(m));
  w.on('error', (e) => { if (!exited) { exited = true; onExit({ ok: false, detail: e.code || e.message, oom: e.code === 'ERR_WORKER_OUT_OF_MEMORY' }); } });
  w.on('exit', (code) => { if (!exited) { exited = true; onExit({ ok: code === 0, detail: `exit ${code}`, tail: errTail }); } });
  return {
    kind: 'thread', id: w.threadId,
    send(rec, bytes, onDone) {
      try {
        if (bytes) { const exact = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength; const ab = exact ? bytes.buffer : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); w.postMessage({ ...rec, buf: ab }, [ab]); } // exact-size owned buffers are TRANSFERRED; a slice would have to be copied
        else w.postMessage(rec);
        if (onDone) onDone(null); return true;
      } catch (e) { if (onDone) onDone(e); return false; }
    },
    pause() {}, resume() {},
    heldBytes: () => 0,
    queuedInBytes: () => 0,
    stop(graceMs, onForced) { const t = setTimeout(() => { if (!exited) { if (onForced) onForced(); w.terminate(); } }, graceMs); if (t.unref) t.unref(); w.once('exit', () => clearTimeout(t)); },
    kill() { return w.terminate(); }
  };
}

function createProcessLink({ root, env, heapBytes, assemblyMs, onRecord, onExit, log }) {
  let exited = false, tail = '';
  // The child gets its own enforced V8 heap cap; NODE_OPTIONS is not inherited (allowlisted env), so nothing overrides it.
  const p = spawn(process.execPath, [`--max-old-space-size=${Math.max(8, Math.floor(heapBytes / 1048576))}`, path.join(root, 'worker', 'host.js')], { env, cwd: root, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const decoder = new FrameDecoder({ direction: 'worker_to_gateway', assemblyMs,
    onRecord: (r) => { let bytes = null; if (r.t === 'output') { bytes = Buffer.from(r.data, 'base64'); delete r.data; } onRecord(r, bytes, { transferred: false, copied: true }); },
    onError: (e) => { if (!exited) { exited = true; try { p.kill('SIGKILL'); } catch { /* noop */ } onExit({ ok: false, detail: `bridge ${e.code}` }); } } });
  p.stdout.on('data', (c) => decoder.push(c));
  p.stderr.on('data', (c) => { tail = (tail + c.toString('utf8')).slice(-1024); });
  p.stdin.on('error', () => {});
  p.on('error', (e) => { if (!exited) { exited = true; onExit({ ok: false, detail: e.code || 'spawn' }); } });
  p.on('exit', (code, sig) => { if (!exited) { exited = true; onExit({ ok: code === 0 && !sig, detail: sig || `exit ${code}`, tail }); } });
  return {
    kind: 'process', id: p.pid, pid: p.pid,
    send(rec, bytes, onDone) {
      if (!p.stdin.writable) { if (onDone) onDone(new Error('closed')); return false; }
      try { p.stdin.write(encodeRecord(bytes ? { ...rec, data: bytes.toString('base64') } : rec, 'gateway_to_worker'), onDone || undefined); return true; } catch (e) { if (onDone) onDone(e); return false; }
    },
    pause() { decoder.pause(); p.stdout.pause(); }, resume() { decoder.resume(); p.stdout.resume(); },
    heldBytes: () => 0, queuedInBytes: () => p.stdin.writableLength,
    stop(graceMs, onForced) { const t = setTimeout(() => { if (!exited) { if (onForced) onForced(); try { p.kill('SIGKILL'); } catch { /* noop */ } } }, graceMs); if (t.unref) t.unref(); p.once('exit', () => clearTimeout(t)); },
    kill() { try { p.kill('SIGKILL'); } catch { /* noop */ } }
  };
}

module.exports = { createThreadLink, createProcessLink };
