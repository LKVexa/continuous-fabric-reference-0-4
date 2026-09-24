'use strict';
/**
 * Cross-process capacity lease for DF fabric work (VWS decision D-002).
 * Workers are separate processes (one per session), so the cap on concurrent
 * DF CLI executions is enforced with atomically created slot directories.
 *   run/verify : any one free slot
 *   build      : every slot (exclusive — it rewrites the nodes' build products)
 * A slot whose owner pid no longer exists is reclaimed.
 */
const fs = require('node:fs');
const path = require('node:path');

function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

function tryTake(dir, i) {
  const slot = path.join(dir, `slot-${i}`);
  try { fs.mkdirSync(slot); fs.writeFileSync(path.join(slot, 'owner'), String(process.pid)); return slot; }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let owner = NaN;
    try { owner = parseInt(fs.readFileSync(path.join(slot, 'owner'), 'utf8'), 10); } catch { /* being created */ }
    let stale = Number.isInteger(owner) && !alive(owner);
    if (!Number.isInteger(owner)) { try { stale = Date.now() - fs.statSync(slot).mtimeMs > 5000; } catch { stale = false; } }
    if (stale) { try { fs.rmSync(slot, { recursive: true, force: true }); } catch { /* raced */ } }
    return null;
  }
}
function give(slot) { try { fs.rmSync(slot, { recursive: true, force: true }); } catch { /* noop */ } }

/**
 * @returns {(kind:'run'|'verify'|'build', signal?:AbortSignal)=>Promise<()=>void>}
 */
function createLease({ dir, slots = 2, waitMs = 60000, pollMs = 150 }) {
  fs.mkdirSync(dir, { recursive: true });
  return async function acquire(kind, signal) {
    const need = kind === 'build' ? slots : 1;
    const held = [];
    const started = Date.now();
    const releaseAll = () => { while (held.length) give(held.pop()); };
    for (;;) {
      if (signal && signal.aborted) { releaseAll(); const e = new Error('interrupted while waiting for fabric capacity'); e.code = 'ABORT_ERR'; throw e; }
      for (let i = 0; i < slots && held.length < need; i++) {
        if (held.some((h) => h.endsWith(`slot-${i}`))) continue;
        const s = tryTake(dir, i);
        if (s) held.push(s);
      }
      if (held.length >= need) { let done = false; return () => { if (!done) { done = true; releaseAll(); } }; }
      if (kind === 'build') releaseAll(); // never hold a partial exclusive set while waiting (no deadlock between two builders)
      if (Date.now() - started > waitMs) { releaseAll(); const e = new Error(`fabric is busy (${slots} concurrent job limit); try again shortly`); e.code = 'EBUSY'; throw e; }
      await new Promise((r) => setTimeout(r, pollMs + Math.floor(Math.random() * pollMs)));
    }
  };
}

module.exports = { createLease };
