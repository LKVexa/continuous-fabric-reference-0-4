'use strict';
/**
 * Residency observation (kit R07). Observes; never locks pages, never disables paging, never monopolizes RAM.
 * Views are reported SEPARATELY and must never be added together: RSS, swap, virtual size and major faults
 * overlap and have different scopes. On platforms without /proc every field is null and status is UNKNOWN —
 * a missing measurement is not zero.
 */
const fs = require('node:fs');

function readStatus(pid) {
  const out = { pid, vmRssBytes: null, vmSwapBytes: null, vmSizeBytes: null, majorFaults: null, minorFaults: null, utimeTicks: null, stimeTicks: null, threads: null };
  try {
    const st = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const kb = (k) => { const m = new RegExp(`^${k}:\\s+(\\d+) kB`, 'm').exec(st); return m ? Number(m[1]) * 1024 : null; };
    out.vmRssBytes = kb('VmRSS'); out.vmSwapBytes = kb('VmSwap'); out.vmSizeBytes = kb('VmSize');
    const th = /^Threads:\s+(\d+)/m.exec(st); out.threads = th ? Number(th[1]) : null;
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    out.minorFaults = Number(f[7]); out.majorFaults = Number(f[9]); out.utimeTicks = Number(f[11]); out.stimeTicks = Number(f[12]);
  } catch { /* not Linux or process gone: leave nulls */ }
  return out;
}

/** Observe an interval for a set of pids. */
function createObserver(getPids) {
  let start = null;
  const sample = () => ({ at: Date.now(), procs: getPids().map(readStatus) });
  return {
    begin() { start = sample(); return start; },
    end() {
      const stop = sample(); if (!start) return { status: 'UNKNOWN', reason: 'no interval started' };
      const byPid = new Map(start.procs.map((p) => [p.pid, p])); let faults = 0, swapMax = 0, known = true, compared = 0;
      for (const p of stop.procs) { const a = byPid.get(p.pid); if (!a) continue; compared++; if (p.majorFaults === null || a.majorFaults === null || p.vmSwapBytes === null) { known = false; continue; } faults += p.majorFaults - a.majorFaults; swapMax = Math.max(swapMax, p.vmSwapBytes, a.vmSwapBytes); }
      if (!known || compared === 0) return { status: 'UNKNOWN', reason: 'residency counters unavailable on this platform or for these processes', intervalMs: stop.at - start.at, start, stop };
      // "No attributable hard faults and no swapped pages in the interval" is an OBSERVATION for this interval and these processes only.
      return { status: faults === 0 && swapMax === 0 ? 'OBSERVED_RESIDENT_FOR_INTERVAL' : 'NOT_RESIDENT', majorFaultsInInterval: faults, maxSwapBytes: swapMax, intervalMs: stop.at - start.at, processes: compared,
        caveat: 'process-scope counters; says nothing about kernel socket buffers, page cache, other intervals, crash dumps or provider internals', start, stop };
    }
  };
}
module.exports = { readStatus, createObserver };
