'use strict';
/**
 * Effective memory allowance (kit R06; docs/MEMORY.md) — planning arithmetic made enforceable.
 *   L  boundary: the smallest FINITE limit that applies (explicit config, cgroup v2 memory.max, cgroup v1 limit);
 *      installed RAM is only a last resort and is labelled as such.
 *   F  fixed process baseline (gateway RSS measured at startup, or configured)
 *   G  global idle-pool allowance          H  protected headroom          s  per-session reservation
 *   ceiling = max(0, floor((L - F - G - H) / s));   admission requires F + G + N*s + H <= L
 * The ceiling is a MEMORY ceiling only, not a concurrency recommendation: the configured session cap still applies.
 */
const fs = require('node:fs');
const os = require('node:os');

function readInt(p) { try { const t = fs.readFileSync(p, 'utf8').trim(); if (t === 'max') return Infinity; const n = Number(t); return Number.isFinite(n) && n > 0 ? n : null; } catch { return null; } }

function detectBoundary(explicitBytes) {
  const candidates = [];
  if (explicitBytes) candidates.push({ source: 'config:VWS_MEMORY_LIMIT_BYTES', bytes: explicitBytes });
  const v2 = readInt('/sys/fs/cgroup/memory.max'); if (v2 !== null && v2 !== Infinity) candidates.push({ source: 'cgroup-v2:memory.max', bytes: v2 });
  const v1 = readInt('/sys/fs/cgroup/memory/memory.limit_in_bytes'); if (v1 !== null && v1 < 2 ** 60) candidates.push({ source: 'cgroup-v1:memory.limit_in_bytes', bytes: v1 });
  if (!candidates.length) candidates.push({ source: 'os.totalmem (NO container limit found: installed RAM is not an approved boundary)', bytes: os.totalmem(), weak: true });
  candidates.sort((a, b) => a.bytes - b.bytes);
  return { ...candidates[0], observed: candidates };
}

/** Per-session reservation s, built from the configured quotas (capacity reservations) — see config/limits.json. */
function sessionReservation(cfg) {
  const parts = {
    worker_runtime: cfg.workerBackend === 'thread' ? cfg.workerHeapBytes + cfg.workerRuntimeOverheadBytes : cfg.workerProcessBytes,
    vfs: cfg.vfsBytes, history: cfg.historyBytes, workspace: cfg.captureBytes + cfg.workerPendingBytes,
    reassembly: cfg.envelopeBytes, receive: 65536, queued_out: cfg.sendQueueBytes, inflight_out: cfg.inflightBytes, bridge: cfg.bridgeBytes, metadata: 98304, codec: 131072
  };
  // The worker's V8 heap cap already contains strings held by VFS/history/capture when the thread backend is used;
  // they are listed separately so each has its own quota, and the heap cap is the enforced upper bound on their sum.
  const total = Object.values(parts).reduce((a, b) => a + b, 0);
  return { parts, total };
}

function plan({ L, F, G, H, s, configuredSessions }) {
  for (const [k, v] of Object.entries({ L, F, G, H, s })) if (!Number.isSafeInteger(v) || v < 0) throw new Error(`allowance: ${k} must be a non-negative safe integer`);
  if (s === 0) throw new Error('allowance: s must be positive');
  const ceiling = Math.max(0, Math.floor((L - F - G - H) / s));
  const sessions = Math.min(configuredSessions, ceiling);
  return { L, F, G, H, s, memoryOnlySessionCeiling: ceiling, configuredSessions, admittedSessionCap: sessions, globalSessionBytes: sessions * s,
    plannedBoundaryCharge: F + G + sessions * s, chargePlusHeadroom: F + G + sessions * s + H, fits: F + G + sessions * s + H <= L };
}

module.exports = { detectBoundary, sessionReservation, plan };
