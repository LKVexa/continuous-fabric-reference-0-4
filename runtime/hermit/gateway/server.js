#!/usr/bin/env node
'use strict';
/**
 * HERMIT virtual WebSocket gateway — Node profile (architecture decision D-001)
 * ---------------------------------------------------------------------------
 * One ingress port: health, public config, ticket API, static web client and the
 * WebSocket upgrade. Owns admission, identity, Origin policy, session mapping,
 * flow control, heartbeat, worker supervision and deadline-driven shutdown.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createCodec } = require('../protocol/codec');
const { load, publicConfig, ConfigError } = require('./config');
const { createLogger, safePath } = require('./log');
const { createIdentity, bearerFrom } = require('./auth');
const { createTickets, cookieValue } = require('./tickets');
const { checkWsOrigin, corsHeaders, hostAcceptable } = require('./origin');
const { WsConnection, checkUpgrade, acceptUpgrade, rejectUpgrade } = require('./ws');
const { Connection } = require('./connection');
const crypto = require('node:crypto');
const os = require('node:os');
const { Worker } = require('node:worker_threads');
const { Ledger, SlabPool } = require('../ram/ledger');
const { planIdentity, SCHEMA_SHA256 } = require('../ram/descriptor');
const { detectBoundary, plan } = require('../ram/allowance');
const { createObserver, readStatus } = require('../ram/residency');
const { createTraffic } = require('../ram/traffic');

const PROTOCOL = 'hermit.vws.v2';
const TICKET_COOKIE = 'vws_ticket';

function createGateway(cfg, { logSink } = {}) {
  const log = createLogger(cfg.logLevel, logSink);
  const schema = JSON.parse(fs.readFileSync(path.join(cfg.root, 'protocol/envelope.schema.json'), 'utf8'));
  const meta = JSON.parse(fs.readFileSync(path.join(cfg.root, 'protocol/protocol-meta.json'), 'utf8'));
  const codec = createCodec(schema, meta);
  const identity = createIdentity(cfg, log);
  const tickets = createTickets({ ttlMs: cfg.ticketTtlMs });
  /* ---- RAMWS memory plan (kit R06, R09, R14): computed once, enforced by the ledger, exposed in /live ---- */
  const VERSION = require('../package.json').version;
  const serverEpoch = crypto.randomBytes(16).toString('base64url');   // new on every process launch: old volatile handles die with the process
  const boundary = detectBoundary(cfg.memoryLimitBytes || 0);
  const F = cfg.fixedBaselineBytes || process.memoryUsage().rss;
  const connReservation = { parts: { reassembly: 131072, queued_out: cfg.sendQueueBytes + 1048576, bridge: 65536, metadata: 65536 } };
  connReservation.total = Object.values(connReservation.parts).reduce((a, b) => a + b, 0);
  const workerReservation = { parts: cfg.workerBackend === 'thread'
    ? { worker_runtime: cfg.workerHeapBytes + cfg.workerRuntimeOverheadBytes, vfs: cfg.vfsBytes, workspace: cfg.workerPendingBytes }
    : { worker_runtime: cfg.workerProcessBytes, vfs: cfg.vfsBytes, workspace: cfg.workerPendingBytes } };
  workerReservation.total = Object.values(workerReservation.parts).reduce((a, b) => a + b, 0);
  const s = connReservation.total + workerReservation.total;
  const memoryPlan = plan({ L: boundary.bytes, F, G: cfg.poolIdleBytes, H: cfg.headroomBytes, s, configuredSessions: cfg.maxSessions });
  const ledger = new Ledger({ globalBytes: Math.max(0, boundary.bytes - F - cfg.poolIdleBytes - cfg.headroomBytes), tenantBytes: cfg.tenantBytes || Math.max(0, boundary.bytes - F - cfg.poolIdleBytes - cfg.headroomBytes) });
  const pool = new SlabPool({ classes: [4096, 16384, 65536], maxIdleBytes: cfg.poolIdleBytes });
  const traffic = createTraffic();
  let policyGeneration = 1;
  const ram = { ledger, pool, traffic, serverEpoch, workerReservation, runtimeId: `node-${process.version}-${process.platform}-${process.arch}`,
    counters: { sessionResets: 0, workerHeapCapHits: 0, undeliveredOutputBytes: 0, memoryRefusals: 0 }, heapCap: 'UNKNOWN',
    planId: () => planIdentity({ codeVersion: VERSION, protocol: PROTOCOL, descriptorSchemaSha256: SCHEMA_SHA256, policyGeneration, backend: cfg.workerBackend, serverEpoch, profile: cfg.profile }),
    bumpPolicy: () => { policyGeneration++; } };
  const residency = createObserver(() => [process.pid, ...[...registry.conns].map((c) => c.link && c.link.pid).filter(Boolean)]);
  const startedAt = Date.now();
  const counters = { upgrades: 0, rejected: 0, tickets: 0, sessions: 0, healthProbes: 0 };
  const gatewayHooks = {}; // test seam only: lets a test substitute the Connection constructor to inject a hand-off failure

  /* ---- session registry: capacity is reserved BEFORE a worker is spawned ---- */
  const registry = {
    identity, draining: false, ready: false, sessionCap: memoryPlan.admittedSessionCap,
    conns: new Set(), reserved: new Set(),
    reserve(c) {
      if (this.reserved.has(c)) return true;
      if (this.reserved.size >= memoryPlan.admittedSessionCap) return false;
      let mine = 0; for (const x of this.reserved) if (x.principal.tenant === c.principal.tenant && x.principal.sub === c.principal.sub) mine++;
      if (mine >= cfg.maxSessionsPerPrincipal) return false;
      this.reserved.add(c); return true;
    },
    activate() { counters.sessions++; },
    release(c) { this.reserved.delete(c); },
    forget(c) { this.conns.delete(c); if (this.draining && this.conns.size === 0 && this.onEmpty) this.onEmpty(); }
  };

  /* ---- static web client: exact-key lookup, no path arithmetic on request input ---- */
  const assets = new Map();
  if (cfg.serveStatic) {
    const add = (url, file, type) => { const abs = path.join(cfg.root, file); if (fs.existsSync(abs)) assets.set(url, { abs, type }); };
    add('/', 'web/index.html', 'text/html; charset=utf-8'); add('/index.html', 'web/index.html', 'text/html; charset=utf-8');
    add('/styles.css', 'src/renderer/styles.css', 'text/css; charset=utf-8'); add('/web.css', 'web/web.css', 'text/css; charset=utf-8');
    add('/renderer.js', 'src/renderer/renderer.js', 'text/javascript; charset=utf-8');
    for (const f of ['screen.js', 'parser.js', 'renderer-canvas.js']) add('/vt/' + f, 'src/renderer/vt/' + f, 'text/javascript; charset=utf-8');
    for (const f of fs.existsSync(path.join(cfg.root, 'client')) ? fs.readdirSync(path.join(cfg.root, 'client')) : []) if (/^[a-z-]+\.js$/.test(f)) add('/client/' + f, 'client/' + f, 'text/javascript; charset=utf-8');
    add('/protocol/codec.js', 'protocol/codec.js', 'text/javascript; charset=utf-8');
    add('/protocol/envelope.schema.json', 'protocol/envelope.schema.json', 'application/json');
    add('/protocol/protocol-meta.json', 'protocol/protocol-meta.json', 'application/json');
  }
  const securityHeaders = (req) => {
    const host = req.headers.host || '';
    return {
      'Content-Security-Policy': `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://${host} wss://${host}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Resource-Policy': 'same-origin', 'X-Frame-Options': 'DENY'
    };
  };

  function json(res, status, body, headers = {}) {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
    res.end(text);
  }

  /* ---- per-address ticket rate limit (bounded map) ---- */
  // Two bounded limiters: FAILED authentications per remote address (pre-auth abuse) and issued tickets per principal.
  // Successful users behind a shared edge address are never locked out by someone else's failures... of THEIR principal;
  // the failure bucket only gates further failures-in-a-row from that address.
  const buckets = new Map();
  function bump(key, limit) {
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || now - b.at > 60000) { b = { n: 0, at: now }; buckets.delete(key); buckets.set(key, b); }
    if (buckets.size > 4096) buckets.delete(buckets.keys().next().value);   // evict the oldest entry only
    b.n++;
    return b.n <= limit;
  }
  const overLimit = (key, limit) => { const b = buckets.get(key); return !!b && Date.now() - b.at <= 60000 && b.n >= limit; };

  const server = http.createServer((req, res) => {
    const p = safePath(req.url);
    res.on('error', () => {});
    try {
      if (!hostAcceptable(req, cfg)) return json(res, 421, { error: 'misdirected request' });
      if (p === '/health') {
        counters.healthProbes++;
        // Readiness: minimal, unauthenticated, constant work, no secrets, no shell command, no redirect.
        if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method' }, { Allow: 'GET, HEAD' });
        const ok = registry.ready && !registry.draining;
        return json(res, ok ? 200 : 503, { status: ok ? 'ok' : (registry.draining ? 'draining' : 'starting') });
      }
      if (p === '/live') {
        if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method' }, { Allow: 'GET, HEAD' });
        // Bounded, payload-free, label-free telemetry (kit R27). Absent measurements are null/UNKNOWN, never zero.
        const me = readStatus(process.pid);
        return json(res, 200, { status: 'live', uptimeS: Math.floor((Date.now() - startedAt) / 1000), sessions: registry.reserved.size, connections: registry.conns.size, draining: registry.draining,
          ram: { profile: cfg.profile, serverEpoch, backend: cfg.workerBackend, heapCap: ram.heapCap, plan: memoryPlan, boundary: { source: boundary.source, weak: !!boundary.weak },
            ledger: ledger.snapshot(), reconcile: ledger.reconcile().ok, pool: pool.snapshot(), traffic: traffic.snapshot(), counters: ram.counters,
            process: { scope: 'gateway process (includes worker threads when backend=thread)', vmRssBytes: me.vmRssBytes, vmSwapBytes: me.vmSwapBytes, majorFaults: me.majorFaults, note: 'separate overlapping views; never add them' },
            physicalResidency: 'UNKNOWN unless an interval was observed with ram/residency.js; RAM-managed is a placement policy, not a residency proof' } });
      }
      if (p === '/config.json') {
        if (req.method !== 'GET') return json(res, 405, { error: 'method' }, { Allow: 'GET' });
        return json(res, 200, publicConfig(cfg));
      }
      if (p === '/api/ws-ticket') {
        const cors = corsHeaders(req, cfg);
        if (req.method === 'OPTIONS') {
          if (!cors.ok) return json(res, 403, { error: 'origin' }, cors.headers);
          res.writeHead(204, { ...cors.headers, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '600', 'Content-Length': '0' });
          return res.end();
        }
        if (req.method !== 'POST') return json(res, 405, { error: 'method' }, { Allow: 'POST, OPTIONS', ...cors.headers });
        if (!cors.ok) return json(res, 403, { error: 'origin' }, cors.headers);
        if (registry.draining) return json(res, 503, { error: 'draining' }, { 'Retry-After': '5', ...cors.headers });
        req.resume(); // body is ignored and bounded by the server's request limits
        const addrKey = 'fail:' + (req.socket.remoteAddress || '?');
        const principal = identity.open ? identity.authenticate() : identity.authenticate(bearerFrom(req));
        if (!principal) {
          if (!bump(addrKey, 60)) return json(res, 429, { error: 'rate' }, { 'Retry-After': '30', ...cors.headers });
          return json(res, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer', ...cors.headers });
        }
        if (!bump(`ok:${principal.tenant}\u0000${principal.sub}`, 60)) return json(res, 429, { error: 'rate' }, { 'Retry-After': '30', ...cors.headers });
        const t = tickets.issue(principal, cors.origin);
        if (!t) return json(res, 503, { error: 'busy' }, cors.headers);
        counters.tickets++;
        const cookie = `${TICKET_COOKIE}=${t}; Max-Age=${Math.ceil(cfg.ticketTtlMs / 1000)}; Path=/ws/terminal; HttpOnly; SameSite=Strict${cfg.secureCookies ? '; Secure' : ''}`;
        const body = { expiresInMs: cfg.ticketTtlMs };
        if (cfg.allowQueryTicket) body.ticket = t; // only when the operator has confirmed query redaction on the whole path
        return json(res, 200, body, { 'Set-Cookie': cookie, ...cors.headers });
      }
      if (p === '/ws/terminal') return json(res, 426, { error: 'upgrade required' }, { Upgrade: 'websocket' });
      const a = assets.get(p);
      if (a && (req.method === 'GET' || req.method === 'HEAD')) {
        const body = fs.readFileSync(a.abs);
        res.writeHead(200, { 'Content-Type': a.type, 'Content-Length': body.length, 'Cache-Control': 'no-cache', ...securityHeaders(req) });
        return res.end(req.method === 'HEAD' ? undefined : body);
      }
      return json(res, 404, { error: 'not found' });
    } catch (e) {
      log.error('http.handler_error', { path: p, reason: e.message });
      try { if (!res.headersSent) json(res, 500, { error: 'internal' }); else res.destroy(); } catch { /* noop */ }
    }
  });
  server.headersTimeout = cfg.handshakeTimeoutMs;
  server.requestTimeout = cfg.handshakeTimeoutMs;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 64;
  server.on('clientError', (_e, socket) => { try { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); } catch { /* noop */ } });

  /* ---- WebSocket admission: path -> draining -> Origin -> handshake -> identity -> upgrade ---- */
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    counters.upgrades++;
    // An exception anywhere in admission or hand-off must not escape into the process: the socket is
    // released, capacity is returned, and the accept path keeps serving other clients.
    try { admit(req, socket, head); }
    catch (e) {
      counters.rejected++;
      log.error('ws.admission_error', { path: safePath(req.url), reason: e && e.message });
      try { if (socket.writable && !socket.vwsUpgraded) rejectUpgrade(socket, 500, 'internal'); else socket.destroy(); } catch { /* noop */ }
    }
  });

  function admit(req, socket, head) {
    const reject = (status, reason, headers) => { counters.rejected++; log.info('ws.rejected', { status, reason, path: safePath(req.url) }); rejectUpgrade(socket, status, reason, headers); };
    const url = String(req.url);
    const q = url.indexOf('?');
    if ((q < 0 ? url : url.slice(0, q)) !== '/ws/terminal') return reject(404, 'not found');
    if (q >= 0 && !cfg.allowQueryTicket) return reject(400, 'query not accepted');
    if (registry.draining || !registry.ready) return reject(503, 'draining', { 'Retry-After': '5' });
    const o = checkWsOrigin(req, cfg);
    if (!o.ok) return reject(403, 'origin');
    const up = checkUpgrade(req, PROTOCOL);
    if (!up.ok) return reject(up.status, up.reason, up.headers);
    if (head && head.length) return reject(400, 'unexpected data');

    let principal = null; const extra = [];
    if (identity.open) principal = identity.authenticate();
    const bearer = bearerFrom(req);
    if (!principal && bearer && o.origin === null) principal = identity.authenticate(bearer);         // native client path
    if (!principal) {
      let t = cookieValue(req, TICKET_COOKIE);
      if (!t && cfg.allowQueryTicket && q >= 0) t = new URLSearchParams(url.slice(q + 1)).get('ticket');
      if (t) principal = tickets.consume(t, o.origin);
      if (t) extra.push(`Set-Cookie: ${TICKET_COOKIE}=; Max-Age=0; Path=/ws/terminal; HttpOnly; SameSite=Strict${cfg.secureCookies ? '; Secure' : ''}`);
    }
    if (!principal) return reject(401, 'unauthorized');
    if (registry.conns.size >= memoryPlan.admittedSessionCap * 2) return reject(503, 'capacity', { 'Retry-After': '10' });
    let mine = 0; for (const c of registry.conns) if (c.principal.tenant === principal.tenant && c.principal.sub === principal.sub) mine++;
    if (mine >= cfg.maxConnectionsPerPrincipal) return reject(429, 'too many connections for this principal', { 'Retry-After': '10' });

    // Budget invariant: the connection's transport reservation is admitted (session/tenant/global) BEFORE the upgrade
    // commits any buffers. A refusal is an ordinary 503 and allocates nothing.
    let account;
    try { account = ledger.admit(`conn:${crypto.randomBytes(9).toString('base64url')}`, principal.tenant, connReservation.total, connReservation.parts); }
    catch (e) { ram.counters.memoryRefusals++; return reject(503, `memory budget (${e.scope || 'ledger'})`, { 'Retry-After': '10' }); }
    acceptUpgrade(socket, up.key, PROTOCOL, extra);
    socket.vwsUpgraded = true;
    let conn = null;
    try {
      const ws = new WsConnection(socket, { maxMessageBytes: cfg.envelopeBytes, sendQueueBytes: cfg.sendQueueBytes, controlReserve: cfg.controlReserveBytes, assemblyMs: cfg.assemblyMs, account, pool, traffic });
      ws.on('transport-error', (code) => log.debug('ws.transport_error', { code }));
      conn = new (gatewayHooks.Connection || Connection)({ ws, principal, origin: o.origin, cfg, codec, log, registry, ram, account, remote: socket.remoteAddress });
      registry.conns.add(conn);
    } catch (e) {
      // Hand-off failed after the 101: nothing owns the socket yet, so release everything here.
      if (conn) { registry.release(conn); registry.conns.delete(conn); }
      account.close();
      throw e;
    }
    log.info('ws.accepted', { conn: conn.id, tenant: principal.tenant, sub: principal.sub, origin: o.origin || 'none' });
  }

  /* ---- lifecycle ---- */
  /** Is the per-session V8 heap cap really applied? A process-wide --max-old-space-size (e.g. via NODE_OPTIONS) overrides it. */
  function probeHeapCap() {
    if (cfg.workerBackend !== 'thread') return Promise.resolve('PROCESS_BACKEND_FLAG');
    return new Promise((resolve) => {
      const want = Math.floor(cfg.workerHeapBytes / 1048576);
      const w = new Worker("require('node:worker_threads').parentPort.postMessage(require('node:v8').getHeapStatistics().heap_size_limit)", { eval: true, resourceLimits: { maxOldGenerationSizeMb: want, maxYoungGenerationSizeMb: 8 } });
      w.once('message', (limit) => resolve(limit <= (want + 64) * 1048576 ? 'ENFORCED' : 'UNENFORCED')); w.once('error', () => resolve('UNKNOWN'));
    });
  }

  async function listen() {
    ram.heapCap = await probeHeapCap();
    if (ram.heapCap === 'UNENFORCED') {
      const why = 'a process-wide V8 heap flag (--max-old-space-size, usually from NODE_OPTIONS) overrides per-session worker heap caps';
      if (cfg.requireHeapCap) throw Object.assign(new Error(`per-session memory cap cannot be enforced: ${why}. Unset it, or set VWS_REQUIRE_HEAP_CAP=0 to run with the cap disclosed as UNENFORCED.`), { code: 'EHEAPCAP' });
      log.warn('ram.heap_cap_unenforced', { why });
    }
    if (!memoryPlan.fits || memoryPlan.admittedSessionCap < 1) throw Object.assign(new Error(`memory plan admits no session: L=${memoryPlan.L} F=${memoryPlan.F} G=${memoryPlan.G} H=${memoryPlan.H} s=${memoryPlan.s}`), { code: 'EMEMPLAN' });
    log.info('ram.plan', { boundary: boundary.source, L: memoryPlan.L, F: memoryPlan.F, G: memoryPlan.G, H: memoryPlan.H, s: memoryPlan.s, memoryCeiling: memoryPlan.memoryOnlySessionCeiling, sessionCap: memoryPlan.admittedSessionCap, backend: cfg.workerBackend, heapCap: ram.heapCap, serverEpoch });
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(cfg.port, cfg.host, () => { registry.ready = true; log.info('gateway.listening', { host: cfg.host, port: server.address().port, auth: identity.name, fabric: cfg.fabric, maxSessions: cfg.maxSessions }); resolve(server.address()); });
    });
  }

  let shutdownPromise = null;
  /** Deadline-driven drain (series I049): admission off -> notify -> snapshot/close -> reap -> stop listener. */
  function shutdown(reason = 'shutdown') {
    if (shutdownPromise) return shutdownPromise;
    const t0 = Date.now();
    registry.draining = true;                       // /health -> 503, tickets + upgrades refused from now on
    log.info('gateway.draining', { reason, connections: registry.conns.size, budgetMs: cfg.shutdownMs });
    shutdownPromise = new Promise((resolve) => {
      const finish = (forced) => {
        for (const c of registry.conns) { try { if (c.link) c.link.kill(); c.ws.terminate(1001, 'shutdown'); } catch { /* noop */ } }
        server.close(() => {});
        if (server.closeAllConnections) server.closeAllConnections();
        const ms = Date.now() - t0;
        log.info('gateway.stopped', { forced, drainMs: ms });
        resolve({ forced, drainMs: ms });
      };
      const hard = setTimeout(() => finish(true), cfg.shutdownMs);
      registry.onEmpty = () => { clearTimeout(hard); finish(false); };
      if (registry.conns.size === 0) return registry.onEmpty();
      const deadlineMs = Math.max(0, Math.min(300000, cfg.shutdownMs - 1000));
      for (const c of registry.conns) {
        c._control({ v: 2, type: 'service.draining', payload: { deadlineMs, reason: reason === 'deploy' ? 'deploy' : 'shutdown' } });
        c.end('shutdown', 1001, 'service draining');
      }
    });
    return shutdownPromise;
  }

  return { server, listen, shutdown, registry, tickets, counters, cfg, log, codec, hooks: gatewayHooks, ram, memoryPlan, residency, pool, ledger };
}

if (require.main === module) {
  let cfg;
  try { cfg = load(process.env); }
  catch (e) { process.stderr.write(`configuration error: ${e.message}\n`); process.exit(e instanceof ConfigError ? 78 : 1); }
  const gw = createGateway(cfg);
  // Signal handlers are registered before the listener accepts persistent work.
  let signalled = false;
  const onSignal = (sig) => { if (signalled) return; signalled = true; gw.shutdown(sig === 'SIGTERM' ? 'deploy' : 'shutdown').then((r) => process.exit(r.forced ? 1 : 0)); };
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));
  // Termination during startup: shutdown() has already set draining (every admission path refuses) and resolves at once
  // because nothing is connected; the process then exits 0 whether or not the bind completes first.
  gw.listen().catch((e) => { if (signalled) return; gw.log.error('gateway.listen_failed', { reason: e.code || e.message, detail: e.message }); process.exit(e.code === 'EHEAPCAP' || e.code === 'EMEMPLAN' ? 78 : 1); });
}

module.exports = { createGateway, PROTOCOL, TICKET_COOKIE };
