'use strict';
/**
 * Preregistered CPU/fidelity experiment (kit R28). Reads e/R28/experiment.frozen.json and REFUSES to run unless
 * it is marked approved+frozen. Baseline and candidate are separate gateway PROCESSES started from their own
 * directories; this harness is the only client and runs in its own process so its CPU is excluded.
 * Output: e/R28/raw.jsonl (every run), e/R28/result.json (per-launch means, cluster bootstrap CIs, gates).
 */
const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os'); const crypto = require('node:crypto'); const { spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..', '..'); const OUT = path.join(ROOT, 'e', 'R28');
const CFG = JSON.parse(fs.readFileSync(path.join(OUT, 'experiment.frozen.json'), 'utf8'));
if (!CFG.approved || CFG.status !== 'FROZEN_BEFORE_DATA') { console.error('experiment configuration is not approved+frozen; refusing to collect data'); process.exit(2); }
const BASE = process.env.BASELINE_DIR || path.resolve(ROOT, '..', 'hermit-vws');
const ABL = process.env.ABLATION || '';   // 'process-backend': candidate protocol with the process worker backend (separates protocol from backend effects)
const TAG = ABL ? `.${ABL}` : '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ticks = () => { try { return Number(fs.readFileSync('/proc/self/stat', 'utf8')); } catch { return null; } };
function cpuOf(pid) { try { const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); const f = st.slice(st.lastIndexOf(')') + 2).split(' '); return (Number(f[11]) + Number(f[12])) / 100; } catch { return 0; } }
function children(pid) { try { return fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number); } catch { return []; } }
function treeCpu(pid) { let s = cpuOf(pid); for (const c of children(pid)) s += treeCpu(c); return s; }
function faults(pid) { try { const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); const f = st.slice(st.lastIndexOf(')') + 2).split(' '); return Number(f[9]); } catch { return null; } }

// ---- two clients, one per protocol (kept minimal and equivalent) ----
function v1Client(url, token) {
  const ws = new WebSocket(url, { protocols: ['hermit.vws.v1'], headers: { authorization: 'Bearer ' + token } }); const st = { out: [], outBytes: 0, msgs: [], sid: null, epoch: 1, inSeq: 0, waiters: [], closed: false };
  const rid = () => crypto.randomBytes(12).toString('base64url'); const send = (m) => ws.readyState === 1 && ws.send(JSON.stringify(m)); const wake = () => { const w = st.waiters; st.waiters = []; w.forEach((f) => f()); };
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); st.msgs.push(m); if (m.type === 'terminal.output') { const b = Buffer.from(m.payload.data, 'base64'); st.out.push(b); st.outBytes += b.length; send({ v: 1, type: 'output.ack', sid: st.sid, epoch: 1, payload: { seq: m.payload.seq } }); } if (m.type === 'session.opened') { st.sid = m.sid; } if (m.type === 'heartbeat.ping') send({ v: 1, type: 'heartbeat.pong', rid: m.rid, payload: { nonce: m.payload.nonce } }); wake(); });
  ws.addEventListener('close', () => { st.closed = true; wake(); });
  const until = async (p, ms = 30000) => { const end = Date.now() + ms; while (!p()) { if (Date.now() > end) throw new Error('timeout'); await new Promise((r) => { st.waiters.push(r); setTimeout(r, 20); }); } };
  return { st, until, text: () => Buffer.concat(st.out).toString('utf8'),
    open: async () => { await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); }); send({ v: 1, type: 'session.open', rid: rid(), payload: { cols: 100, rows: 30, mode: 'virtual' } }); await until(() => st.sid); await until(() => /›/.test(Buffer.concat(st.out).toString())); },
    input: (s) => send({ v: 1, type: 'terminal.input', rid: rid(), sid: st.sid, epoch: 1, payload: { seq: ++st.inSeq, data: Buffer.from(s).toString('base64') } }),
    close: () => { try { ws.close(); } catch { /* noop */ } } };
}
function v2Client(url, token) {
  const ws = new WebSocket(url, { protocols: ['hermit.vws.v2'], headers: { authorization: 'Bearer ' + token } }); ws.binaryType = 'arraybuffer';
  const st = { out: [], outBytes: 0, msgs: [], sid: null, epoch: null, inSeq: 0, waiters: [], closed: false, consumedSeq: 0, consumedBytes: 0, creditedAt: 0, since: 0, window: 1048576, serverEpoch: null };
  const rid = () => crypto.randomBytes(12).toString('base64url'); const send = (m) => ws.readyState === 1 && ws.send(typeof m === 'string' || m instanceof Uint8Array ? m : JSON.stringify(m)); const wake = () => { const w = st.waiters; st.waiters = []; w.forEach((f) => f()); };
  const credit = () => { st.creditedAt = st.consumedBytes; st.since = 0; send({ v: 2, type: 'flow.credit', sid: st.sid, epoch: st.epoch, payload: { consumedSeq: st.consumedSeq, creditBytes: st.consumedBytes + st.window } }); };
  ws.addEventListener('message', (e) => {
    if (typeof e.data !== 'string') { const b = Buffer.from(e.data); const p = b.subarray(7); st.out.push(p); st.outBytes += p.length; st.consumedSeq = b.readUIntBE(1, 6); st.consumedBytes += p.length; st.since++; if (st.consumedBytes - st.creditedAt >= st.window / 4 || st.since >= 128) credit(); return wake(); }
    const m = JSON.parse(e.data); st.msgs.push(m); if (m.type === 'hello') st.serverEpoch = m.payload.serverEpoch; if (m.type === 'session.opened') { st.sid = m.sid; st.epoch = m.epoch; } if (m.type === 'heartbeat.ping') send({ v: 2, type: 'heartbeat.pong', rid: m.rid, payload: { nonce: m.payload.nonce } }); wake(); });
  ws.addEventListener('close', () => { st.closed = true; wake(); });
  const until = async (p, ms = 30000) => { const end = Date.now() + ms; while (!p()) { if (Date.now() > end) throw new Error('timeout'); await new Promise((r) => { st.waiters.push(r); setTimeout(r, 20); }); } };
  return { st, until, text: () => Buffer.concat(st.out).toString('utf8'),
    open: async () => { await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); }); await until(() => st.serverEpoch); send({ v: 2, type: 'session.open', rid: rid(), payload: { cols: 100, rows: 30, mode: 'virtual', creditBytes: st.window } }); await until(() => st.sid); await until(() => /›/.test(Buffer.concat(st.out).toString())); },
    input: (s) => { const p = Buffer.from(s); const b = Buffer.alloc(7 + p.length); b[0] = 1; b.writeUIntBE(++st.inSeq, 1, 6); p.copy(b, 7); send(new Uint8Array(b)); },
    close: () => { try { ws.close(); } catch { /* noop */ } } };
}

async function launchGateway(dir, port, extraEnv) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-')); const token = crypto.randomBytes(32).toString('base64url');
  fs.writeFileSync(path.join(dataDir, 'p.json'), JSON.stringify([{ sub: 'op', tenant: 't', tokenSha256: crypto.createHash('sha256').update(token).digest('hex'), capabilities: ['terminal'] }]));
  const env = { PATH: process.env.PATH, PORT: String(port), VWS_HOST: '127.0.0.1', VWS_PRINCIPALS_FILE: path.join(dataDir, 'p.json'), VWS_LOG: 'error', VWS_MSG_RATE: '5000', ...extraEnv };
  const p = spawn(process.execPath, ['gateway/server.js'], { cwd: dir, env, stdio: ['ignore', 'ignore', 'pipe'] }); let err = ''; p.stderr.on('data', (c) => { err += c; });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).status === 200) break; } catch { /* not yet */ } await sleep(50); }
  return { p, token, url: `ws://127.0.0.1:${port}/ws/terminal`, stop: () => new Promise((r) => { p.on('exit', r); p.kill('SIGTERM'); }), dataDir, err: () => err };
}

async function runOnce(arm, gw) {
  const c = (arm === 'baseline' ? v1Client : v2Client)(gw.url, gw.token); const r = { arm, ok: true };
  try {
    await c.open();
    // W1
    let cpu0 = treeCpu(gw.p.pid), t0 = process.hrtime.bigint(); const lat = [];
    for (let i = 0; i < 300; i++) { const n = c.st.out.length; const a = process.hrtime.bigint(); c.input('x'); await c.until(() => c.st.out.length > n, 5000); lat.push(Number(process.hrtime.bigint() - a) / 1e6); if (i % 50 === 49) { c.input('\x15'); await sleep(15); } }
    c.input('\x15'); await sleep(50);
    r.W1 = { units: 300, cpuS: treeCpu(gw.p.pid) - cpu0, wallS: Number(process.hrtime.bigint() - t0) / 1e9, p50ms: lat.slice().sort((a, b) => a - b)[150], p95ms: lat.slice().sort((a, b) => a - b)[285] };
    // W2
    cpu0 = treeCpu(gw.p.pid); t0 = process.hrtime.bigint(); const before = c.st.outBytes;
    c.input('seq 1 200000; seq 1 200000; echo BULK-END\r'); await c.until(() => /BULK-END\r\n/.test(Buffer.concat(c.st.out.slice(-3)).toString()), 120000);
    const bytes = c.st.outBytes - before; const wall = Number(process.hrtime.bigint() - t0) / 1e9;
    const nums = c.text().split('\r\n').filter((l) => /^\d+$/.test(l)).length;
    r.W2 = { rawBytes: bytes, units: bytes / 1048576, cpuS: treeCpu(gw.p.pid) - cpu0, wallS: wall, MiBps: bytes / 1048576 / wall, fidelity: nums === 400000 ? 'exact' : `lines=${nums}` };
    // W3
    cpu0 = treeCpu(gw.p.pid); t0 = process.hrtime.bigint(); const b3 = c.st.outBytes;
    c.input('echo ' + 'z'.repeat(3000)); await sleep(100); c.input('\r'); await c.until(() => /z{3000}\r\n/.test(c.text().slice(-4000)), 30000);
    r.W3 = { units: 1, cpuS: treeCpu(gw.p.pid) - cpu0, wallS: Number(process.hrtime.bigint() - t0) / 1e9, outputBytes: c.st.outBytes - b3 };
  } catch (e) { r.ok = false; r.error = e.message; }
  c.close(); await sleep(150);
  return r;
}

(async () => {
  const raw = fs.createWriteStream(path.join(OUT, `raw${TAG}.jsonl`), { flags: 'w' }); const launches = [];
  const arms = { baseline: { dir: BASE, env: {} }, candidate: { dir: ROOT, env: { VWS_WORKER_BACKEND: ABL === 'process-backend' ? 'process' : 'thread', VWS_REQUIRE_HEAP_CAP: '0' } } };
  for (let L = 0; L < CFG.independent_launches; L++) {
    const order = Math.random() < 0.5 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
    for (const arm of order) {
      const gw = await launchGateway(arms[arm].dir, 27000 + Math.floor(Math.random() * 3000), arms[arm].env);
      const f0 = faults(gw.p.pid);
      for (let w = 0; w < CFG.warmup_runs_per_launch; w++) await runOnce(arm, gw);
      const runs = [];
      for (let k = 0; k < CFG.warmed_runs_per_launch; k++) { const r = await runOnce(arm, gw); r.launch = L; r.run = k; raw.write(JSON.stringify(r) + '\n'); runs.push(r); }
      const f1 = faults(gw.p.pid);
      launches.push({ arm, launch: L, order: order.indexOf(arm), runs, majorFaultsDelta: f0 === null || f1 === null ? null : f1 - f0, stderrTail: gw.err().slice(-300) });
      await gw.stop(); fs.rmSync(gw.dataDir, { recursive: true, force: true });
      process.stderr.write(`launch ${L} ${arm}: ${runs.filter((r) => r.ok).length}/${runs.length} ok\n`);
    }
  }
  raw.end();
  // ---- analysis: per-launch means, cluster bootstrap on launch means ----
  const perUnit = { W1: (r) => r.W1.cpuS / r.W1.units, W2: (r) => r.W2.cpuS / r.W2.units, W3: (r) => r.W3.cpuS / r.W3.units };
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const launchMeans = (arm, f) => launches.filter((l) => l.arm === arm).map((l) => mean(l.runs.filter((r) => r.ok).map(f)));
  const boot = (b, c, n = 10000) => { const out = []; for (let i = 0; i < n; i++) { const bb = b.map(() => b[Math.floor(Math.random() * b.length)]), cc = c.map(() => c[Math.floor(Math.random() * c.length)]); out.push((mean(bb) - mean(cc)) / mean(bb)); } out.sort((x, y) => x - y); return { lo: out[Math.floor(n * 0.025)], hi: out[Math.floor(n * 0.975)] }; };
  const result = { schema: 'RAMWS/EXPERIMENT_RESULT/1', configuration: 'e/R28/experiment.frozen.json', host: { platform: `${os.platform()} ${os.release()}`, cpus: os.cpus().length, model: os.cpus()[0] && os.cpus()[0].model, node: process.version }, at: new Date().toISOString(), workloads: {} };
  for (const W of ['W1', 'W2', 'W3']) {
    const b = launchMeans('baseline', perUnit[W]), c = launchMeans('candidate', perUnit[W]); const ci = boot(b, c);
    result.workloads[W] = { unit: CFG.workload_identity.completed_unit, baseline_cpuS_per_unit_by_launch: b, candidate_cpuS_per_unit_by_launch: c, reduction_point: (mean(b) - mean(c)) / mean(b), reduction_ci95_cluster_bootstrap: ci, launches: b.length, gate_H2: ci.lo > CFG.cpu_reduction_lower_bound_must_exceed ? 'SUPPORTED' : 'NOT_SUPPORTED' };
  }
  const w1b = launchMeans('baseline', (r) => r.W1.p50ms), w1c = launchMeans('candidate', (r) => r.W1.p50ms); const w2b = launchMeans('baseline', (r) => r.W2.MiBps), w2c = launchMeans('candidate', (r) => r.W2.MiBps);
  result.latency = { baseline_p50ms_by_launch: w1b, candidate_p50ms_by_launch: w1c, noninferior: mean(w1c) <= 1.1 * mean(w1b) };
  result.throughput = { baseline_MiBps_by_launch: w2b, candidate_MiBps_by_launch: w2c, noninferior: mean(w2c) >= 0.9 * mean(w2b) };
  result.fidelity = { allRunsExact: launches.every((l) => l.runs.every((r) => r.ok && r.W2.fidelity === 'exact')), excluded: launches.flatMap((l) => l.runs.filter((r) => !r.ok).map((r) => ({ arm: r.arm, launch: r.launch, run: r.run, error: r.error }))) };
  result.pasteOutputBytes = { baseline: launchMeans('baseline', (r) => r.W3.outputBytes), candidate: launchMeans('candidate', (r) => r.W3.outputBytes) };
  result.residency = launches.map((l) => ({ arm: l.arm, launch: l.launch, majorFaultsDelta: l.majorFaultsDelta, scope: 'gateway process only; worker child processes of the baseline not included' }));
  result.caveats = ['single loopback host, 2 vCPU, shared with the client process; no TLS, edge or WAN', 'three launches per arm: the cluster bootstrap interval is wide by construction', 'CPU is the server process tree; the client and the OS are excluded', 'the baseline and candidate differ in protocol (v1 vs v2) AND backend (process vs thread): this measures the whole change, not one cause'];
  result.ablation = ABL || null; fs.writeFileSync(path.join(OUT, `result${TAG}.json`), JSON.stringify(result, null, 1));
  console.log(JSON.stringify({ workloads: Object.fromEntries(Object.entries(result.workloads).map(([k, v]) => [k, { reduction: +v.reduction_point.toFixed(3), ci: [+v.reduction_ci95_cluster_bootstrap.lo.toFixed(3), +v.reduction_ci95_cluster_bootstrap.hi.toFixed(3)], H2: v.gate_H2 }])), latency: result.latency.noninferior, throughput: result.throughput.noninferior, fidelity: result.fidelity.allRunsExact, paste: result.pasteOutputBytes }, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
