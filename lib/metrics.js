'use strict';
// Local SLO scaffolding: in-process counters and latency samples for operator visibility.
// This is NOT a measured WAN/production SLO claim. Use snapshot() from `cfp status` / doctor.
const SAMPLE_CAP = 256;

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

class Metrics {
  constructor({ clock = Date.now } = {}) {
    this.clock = clock;
    this.startedAt = clock();
    this.requests = 0;
    this.errors = 0;
    this.latenciesMs = [];
    this.lastError = null;
    this.lastOkAt = null;
  }

  /** Record one command/request outcome. ok=false increments errors. */
  record(ok, latencyMs) {
    this.requests += 1;
    if (!ok) {
      this.errors += 1;
      this.lastError = this.clock();
    } else {
      this.lastOkAt = this.clock();
    }
    const ms = Number(latencyMs);
    if (Number.isFinite(ms) && ms >= 0) {
      this.latenciesMs.push(Math.round(ms));
      if (this.latenciesMs.length > SAMPLE_CAP) this.latenciesMs.shift();
    }
  }

  snapshot() {
    const sorted = this.latenciesMs.slice().sort((a, b) => a - b);
    const uptimeMs = Math.max(0, this.clock() - this.startedAt);
    return {
      schema: 'CFP_METRICS/1',
      scope: 'local_process',
      note: 'Local scaffolding only — not WAN/production SLO evidence',
      uptimeMs,
      requests: this.requests,
      errors: this.errors,
      errorRate: this.requests ? this.errors / this.requests : 0,
      latencyMs: {
        samples: sorted.length,
        min: sorted.length ? sorted[0] : null,
        max: sorted.length ? sorted[sorted.length - 1] : null,
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95)
      },
      lastOkAt: this.lastOkAt,
      lastErrorAt: this.lastError
    };
  }
}

module.exports = { Metrics, SAMPLE_CAP };
