'use strict';
/**
 * Gateway configuration (series I021 / I048): validated, deterministic, from the
 * environment only. A malformed value is a startup error — it is never silently
 * replaced by a default (defaults apply to ABSENT values only).
 */
const path = require('node:path');

class ConfigError extends Error {}

function intVar(env, name, def, lo, hi) {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  if (!/^(0|[1-9][0-9]{0,9})$/.test(raw)) throw new ConfigError(`${name} must be a decimal integer`);
  const v = Number(raw);
  if (v < lo || v > hi) throw new ConfigError(`${name} must be in ${lo}..${hi}`);
  return v;
}
function boolVar(env, name, def) {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  throw new ConfigError(`${name} must be 0/1/true/false`);
}
function originList(env, name) {
  const raw = env[name];
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean).map((o) => {
    let u; try { u = new URL(o); } catch { throw new ConfigError(`${name}: not a URL: ${o}`); }
    if (!/^https?:$/.test(u.protocol) || u.origin !== o.replace(/\/$/, '')) throw new ConfigError(`${name}: must be a bare origin (scheme://host[:port]): ${o}`);
    if (!/^(\[[0-9a-f:]+\]|[a-z0-9]([a-z0-9.-]*[a-z0-9])?)$/i.test(u.hostname)) throw new ConfigError(`${name}: wildcards and patterns are not supported; list exact origins: ${o}`);
    return u.origin;
  });
}

function load(env = process.env) {
  const root = path.resolve(__dirname, '..');
  const cfg = {
    root,
    port: intVar(env, 'PORT', 10000, 1, 65535),
    host: env.VWS_HOST || '0.0.0.0',
    origins: originList(env, 'VWS_ALLOWED_ORIGINS'),
    allowNoOrigin: boolVar(env, 'VWS_ALLOW_NO_ORIGIN', true),       // native clients (header auth only)
    allowQueryTicket: boolVar(env, 'VWS_ALLOW_QUERY_TICKET', false), // blocked unless the log path redacts it
    secureCookies: boolVar(env, 'VWS_SECURE_COOKIES', true),
    auth: env.VWS_AUTH || 'static-file',
    principalsFile: env.VWS_PRINCIPALS_FILE ? path.resolve(env.VWS_PRINCIPALS_FILE) : null,
    ticketTtlMs: intVar(env, 'VWS_TICKET_TTL_MS', 30000, 1000, 300000),
    maxSessions: intVar(env, 'VWS_MAX_SESSIONS', 4, 1, 256),
    maxSessionsPerPrincipal: intVar(env, 'VWS_MAX_SESSIONS_PER_PRINCIPAL', 2, 1, 256),
    envelopeBytes: 65536,
    inputBytes: 8192,
    outputChunkBytes: 16384,
    sendQueueBytes: intVar(env, 'VWS_SEND_QUEUE_BYTES', 524288, 65536, 16777216),
    controlReserveBytes: 16384,
    // ---- RAMWS (kit R02, R06, R08, R12): profile, worker boundary, memory allowance, credits ----
    profile: env.VWS_PROFILE || 'LOCAL_VOLATILE',
    workerBackend: env.VWS_WORKER_BACKEND || 'thread',
    workerHeapBytes: intVar(env, 'VWS_WORKER_HEAP_BYTES', 50331648, 8388608, 1073741824),             // enforced V8 old-generation cap per session
    workerRuntimeOverheadBytes: intVar(env, 'VWS_WORKER_OVERHEAD_BYTES', 12582912, 1048576, 268435456), // measured ~11.6 MiB per idle worker thread on the dev host
    workerProcessBytes: intVar(env, 'VWS_WORKER_PROCESS_BYTES', 67108864, 16777216, 1073741824),        // process backend: measured ~55 MiB idle RSS + allowance
    memoryLimitBytes: intVar(env, 'VWS_MEMORY_LIMIT_BYTES', 0, 0, Number.MAX_SAFE_INTEGER),              // 0 = detect (cgroup), see ram/allowance.js
    fixedBaselineBytes: intVar(env, 'VWS_FIXED_BASELINE_BYTES', 0, 0, Number.MAX_SAFE_INTEGER),          // 0 = measure this process at startup
    poolIdleBytes: intVar(env, 'VWS_POOL_IDLE_BYTES', 1048576, 0, 268435456),
    headroomBytes: intVar(env, 'VWS_HEADROOM_BYTES', 67108864, 0, Number.MAX_SAFE_INTEGER),
    tenantBytes: intVar(env, 'VWS_TENANT_BYTES', 0, 0, Number.MAX_SAFE_INTEGER),                          // 0 = same as the global allowance
    creditWindowBytes: intVar(env, 'VWS_CREDIT_WINDOW_BYTES', 1048576, 16384, 67108864),
    maxOutstandingMessages: intVar(env, 'VWS_MAX_OUTSTANDING_MESSAGES', 1024, 8, 65536),
    ackCoalesceMs: intVar(env, 'VWS_ACK_COALESCE_MS', 20, 0, 1000),
    captureBytes: intVar(env, 'VWS_CAPTURE_BYTES', 1048576, 1024, 67108864),
    historyEntries: intVar(env, 'VWS_HISTORY_ENTRIES', 500, 10, 100000),
    requireHeapCap: boolVar(env, 'VWS_REQUIRE_HEAP_CAP', true),
    openTimeoutMs: intVar(env, 'VWS_OPEN_TIMEOUT_MS', 10000, 500, 120000),
    handshakeTimeoutMs: intVar(env, 'VWS_HANDSHAKE_TIMEOUT_MS', 10000, 500, 120000),
    assemblyMs: intVar(env, 'VWS_ASSEMBLY_MS', 5000, 100, 60000),
    heartbeatMs: intVar(env, 'VWS_HEARTBEAT_MS', 20000, 200, 600000),
    heartbeatWindowMs: intVar(env, 'VWS_HEARTBEAT_WINDOW_MS', 10000, 100, 600000),
    workerPingMs: intVar(env, 'VWS_WORKER_PING_MS', 5000, 100, 600000),
    workerStallMs: intVar(env, 'VWS_WORKER_STALL_MS', 15000, 200, 600000),
    bridgeAssemblyMs: intVar(env, 'VWS_BRIDGE_ASSEMBLY_MS', 5000, 100, 60000),
    maxPauseMs: intVar(env, 'VWS_MAX_PAUSE_MS', 120000, 500, 3600000),
    workerStdinBytes: intVar(env, 'VWS_WORKER_STDIN_BYTES', 1048576, 65536, 16777216),
    workerPendingBytes: intVar(env, 'VWS_WORKER_PENDING_BYTES', 2097152, 65536, 67108864),
    maxConnectionsPerPrincipal: intVar(env, 'VWS_MAX_CONNECTIONS_PER_PRINCIPAL', 4, 1, 1024),
    workerReadyMs: intVar(env, 'VWS_WORKER_READY_MS', 8000, 200, 120000),
    idleMs: intVar(env, 'VWS_IDLE_MS', 1800000, 1000, 86400000),
    msgRate: intVar(env, 'VWS_MSG_RATE', 300, 1, 100000),            // messages per second, burst = 2x
    shutdownMs: intVar(env, 'VWS_SHUTDOWN_MS', 20000, 100, 290000),
    fabric: boolVar(env, 'VWS_FABRIC', false),
    dfRoot: env.DF_ROOT ? path.resolve(env.DF_ROOT) : null,
    fabricBuild: boolVar(env, 'VWS_FABRIC_BUILD', true),
    fabricSlots: intVar(env, 'VWS_FABRIC_SLOTS', 2, 1, 8),
    python: env.PYTHON || null,
    vfsBytes: intVar(env, 'VWS_VFS_BYTES', 4194304, 4096, 268435456),
    vfsNodes: intVar(env, 'VWS_VFS_NODES', 1000, 16, 100000),
    serveStatic: boolVar(env, 'VWS_SERVE_STATIC', true),
    logLevel: env.VWS_LOG || 'info'
  };
  if (!['static-file', 'none-loopback-dev'].includes(cfg.auth)) throw new ConfigError('VWS_AUTH must be static-file or none-loopback-dev (no identity provider is invented here; add an adapter in gateway/auth.js)');
  if (cfg.auth === 'static-file' && !cfg.principalsFile) throw new ConfigError('VWS_PRINCIPALS_FILE is required with VWS_AUTH=static-file (create one with tools/mkprincipal.js)');
  if (cfg.auth === 'none-loopback-dev' && !['127.0.0.1', '::1', 'localhost'].includes(cfg.host)) throw new ConfigError('VWS_AUTH=none-loopback-dev is only permitted with VWS_HOST on loopback');
  if (cfg.fabric && !cfg.dfRoot) throw new ConfigError('VWS_FABRIC=1 requires DF_ROOT (the folder holding DF_Fabric and the node containers)');
  // LOCAL_VOLATILE is the only implemented storage promise. The other kit profiles change that promise and need
  // their own approval, design and evidence; asking for them (or for the removed disk snapshots) is a startup error,
  // never a silent fallback (Transparency invariant).
  if (cfg.profile !== 'LOCAL_VOLATILE') throw new ConfigError(`VWS_PROFILE=${cfg.profile} is not implemented: DISTRIBUTED_VOLATILE, DURABLE_HYBRID and PIM_RESEARCH are disabled pending separate approval and evidence`);
  if (env.VWS_SNAPSHOTS === '1' || env.VWS_SNAPSHOT_DIR) throw new ConfigError('workspace snapshots write session state to disk and are not available under LOCAL_VOLATILE');
  if (!['thread', 'process'].includes(cfg.workerBackend)) throw new ConfigError('VWS_WORKER_BACKEND must be thread or process');
  if (cfg.heartbeatWindowMs > cfg.heartbeatMs) throw new ConfigError('VWS_HEARTBEAT_WINDOW_MS must not exceed VWS_HEARTBEAT_MS');
  return Object.freeze(cfg);
}

/** The ONLY configuration a browser may see (series I048). */
function publicConfig(cfg) {
  return { protocol: 'hermit.vws.v2', profile: cfg.profile, wsPath: '/ws/terminal', ticketPath: '/api/ws-ticket', auth: cfg.auth === 'none-loopback-dev' ? 'none' : 'bearer-ticket',
    capabilities: { resume: false, browserPane: false, virtualCommands: true, fabric: !!cfg.fabric },
    creditWindowBytes: cfg.creditWindowBytes, heartbeatMs: cfg.heartbeatMs };
}

module.exports = { load, publicConfig, ConfigError };
