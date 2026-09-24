'use strict';
/**
 * THREAD backend host: one worker THREAD per session inside the gateway process (kit R08 selected boundary, R17).
 *   - terminal bytes cross the boundary as TRANSFERRED ArrayBuffers: ownership moves, nothing is copied and the
 *     sender can no longer touch the storage (a demonstrable eliminated copy, see ram/traffic.js bridge_*_transfer)
 *   - the V8 heap of this isolate is capped by resourceLimits (enforced budget, not a hope)
 *   - the gateway can terminate() this thread even inside a synchronous CPU loop
 *   - process.env here is the allowlist the gateway passed, never the gateway's environment
 * A thread is NOT an OS security boundary; neither was the process backend a sandbox (see docs/SECURITY notes).
 */
const { parentPort, workerData } = require('node:worker_threads');
const { createWorkerSession } = require('./core');

const session = createWorkerSession({
  env: workerData.env,
  diag: (level, msg) => parentPort.postMessage({ t: 'diag', level, msg: String(msg).slice(0, 400) }),
  emit: (rec, bytes) => {
    if (!bytes) { parentPort.postMessage(rec); return true; }
    // Output chunks are fresh exact-size allocations from the OutputGate; hand the storage itself to the gateway.
    const exact = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
    const ab = exact ? bytes.buffer : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    parentPort.postMessage({ ...rec, buf: ab, copied: !exact }, [ab]);
    return true;
  },
  onFinished: () => setTimeout(() => process.exit(0), 10)
});
parentPort.on('message', (m) => session.handle(m, m.t === 'input' ? Buffer.from(m.buf) : null));
process.on('uncaughtException', (e) => { try { parentPort.postMessage({ t: 'exit', code: 70, reason: 'worker_failure' }); } catch { /* noop */ } throw e; });
session.ready();
