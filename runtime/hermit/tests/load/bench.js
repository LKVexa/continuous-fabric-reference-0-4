'use strict';
/**
 * Preregistered local workload (series I053). Loopback only; measures THIS machine, not a deployment.
 *   W1 keystroke echo round-trip latency   (1 session, N=300 single-byte inputs)
 *   W2 bulk output throughput              (1 session, ~5.5 MB, acknowledged)
 *   W3 concurrent sessions                 (S sessions: open latency, RSS of gateway + workers)
 * Output: JSON with units, sample counts and spread. Nothing here is a capacity claim for another host.
 */
const os = require('node:os');
const fs = require('node:fs');
const { startGateway, Client, sleep } = require('../helpers');
const pct = (a, p) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];
const rssKb = (pid) => { try { return parseInt(/VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))[1], 10); } catch { return null; } };

(async () => {
  const S = parseInt(process.env.BENCH_SESSIONS || '8', 10);
  const g = await startGateway({ maxSessions: S, maxSessionsPerPrincipal: S, msgRate: 5000 });
  const out = { scope: 'loopback, single host, in-process gateway; not a deployment measurement', node: process.version, platform: `${os.platform()} ${os.release()}`, cpus: os.cpus().length, cpuModel: os.cpus()[0] && os.cpus()[0].model, date: new Date().toISOString() };
  // W1
  const c = await new Client(g.url, g.tokens.alice).open(); const lat = [];
  for (let i = 0; i < 300; i++) { const n = c.type('terminal.output').length; const t0 = process.hrtime.bigint(); c.input('x'); await c.until(() => c.type('terminal.output').length > n, 5000); lat.push(Number(process.hrtime.bigint() - t0) / 1e6); if (i % 50 === 49) { c.input('\x15'); await sleep(20); } }
  out.W1_echo_roundtrip_ms = { samples: lat.length, p50: +pct(lat, 0.5).toFixed(3), p95: +pct(lat, 0.95).toFixed(3), p99: +pct(lat, 0.99).toFixed(3), max: +Math.max(...lat).toFixed(3) };
  c.input('\x15');
  // W2
  const before = c.out.length; const t0 = Date.now(); c.input('seq 1 400000; seq 1 400000; echo BULK-END\r');
  await c.until(() => /400000\r\nBULK-END\r\n/.test(c.out.subarray(Math.max(before, c.out.length - 96)).toString()), 120000);
  const bytes = c.out.length - before, secs = (Date.now() - t0) / 1000;
  out.W2_bulk_output = { rawBytes: bytes, seconds: +secs.toFixed(2), MiBps: +(bytes / 1048576 / secs).toFixed(2), wireExpansion: +(4 * Math.ceil(16384 / 3) / 16384).toFixed(3), note: 'base64 in JSON text frames: >= 1.333x + envelope' };
  c.close(); await sleep(300);
  // W3
  const base = process.memoryUsage().rss; const opens = []; const clients = [];
  for (let i = 0; i < S; i++) { const t = Date.now(); clients.push(await new Client(g.url, g.tokens.alice).open()); opens.push(Date.now() - t); }
  await sleep(500);
  const workers = [...g.gw.registry.conns].map((x) => x.worker && rssKb(x.worker.pid)).filter(Boolean);
  out.W3_concurrency = { sessions: S, open_ms: { p50: pct(opens, 0.5), max: Math.max(...opens) }, workerRssMiB: { samples: workers.length, min: +(Math.min(...workers) / 1024).toFixed(1), max: +(Math.max(...workers) / 1024).toFixed(1), mean: +(workers.reduce((a, b) => a + b, 0) / workers.length / 1024).toFixed(1) }, gatewayRssMiB: { before: +(base / 1048576).toFixed(1), withSessions: +(process.memoryUsage().rss / 1048576).toFixed(1) }, note: 'gateway RSS includes this benchmark harness and its ' + S + ' clients' };
  clients.forEach((x) => x.close()); await sleep(300); await g.stop();
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
