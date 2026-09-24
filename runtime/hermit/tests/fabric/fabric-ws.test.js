'use strict';
/** Real DF nodes + fabric driven through the virtual WebSocket. Requires the five DF containers beside the candidate (TEST_DF_ROOT) and built nodes. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { startGateway, Client, DF_ROOT, sleep } = require('../helpers');
const { vetArgv } = require('../../src/main/spiral/dfabric/policy');

const present = fs.existsSync(path.join(DF_ROOT, 'DF_Fabric', 'adapter', 'dfabric', 'cli.py'));
const opts = { skip: present ? false : `DF containers not found under ${DF_ROOT}` };
let h;
test.before(async () => { if (present) h = await startGateway({ fabric: true, dfRoot: DF_ROOT, fabricBuild: false, fabricSlots: 2, maxSessionsPerPrincipal: 3 }); });
test.after(async () => { if (h) await h.stop(); });

test('policy unit: argv is rebuilt from validated parts only', () => {
  const bundles = [{ name: '01_bell_pair.pal', path: '/df/DF_Fabric/examples/01_bell_pair.pal' }];
  const pol = { allowBuild: false };
  assert.deepStrictEqual(vetArgv('fabric-run', ['01_bell_pair.pal', '--profile', 'multi_thread_deterministic', '--programs=replica,bsp', '--strict'], bundles, pol),
    ['fabric-run', '/df/DF_Fabric/examples/01_bell_pair.pal', '--profile', 'multi_thread_deterministic', '--programs', 'replica,bsp', '--strict']);
  for (const bad of [['--out', '/tmp/x'], ['--event-log=/etc/cron.d/x'], ['--nodes-root', '/'], ['--root', '/'], ['../../etc/passwd'], ['/etc/passwd.pal'], ['nope.pal'], ['01_bell_pair.pal', '01_bell_pair.pal'],
    ['--profile', 'x; rm -rf /'], ['--programs', 'replica,replica'], ['--max-workers', '99'], ['--max-workers', '1e1'], ['--strict=1'], ['--profile'], ['-o', 'x'], ['--profile', 'single_process_deterministic', '--profile', 'single_process_deterministic']]) {
    assert.throws(() => vetArgv('fabric-run', bad, bundles, pol), /./, JSON.stringify(bad));
  }
  assert.throws(() => vetArgv('fabric-build', [], bundles, pol), /disabled/);
  assert.throws(() => vetArgv('node-run', [], bundles, pol), /required/);
  assert.throws(() => vetArgv('node-verify', ['--full'], bundles, pol), /not permitted/);
  assert.throws(() => vetArgv('serve', [], bundles, pol), /not available/);
});

test('fabric status/topology/nodes/bundles render over the socket with host paths hidden', opts, async () => {
  const c = await new Client(h.url, h.tokens.alice).open(140, 50);
  const out = await c.run('df where; df nodes; df bundles; fabric topology; fabric status; echo END-MARK', 'END-MARK\r\n');
  assert.match(out, /N_SMALL/); assert.match(out, /N_XLARGE/); assert.match(out, /01_bell_pair\.pal/); assert.match(out, /Federation/); assert.match(out, /\$DF_ROOT/);
  assert.ok(!out.includes(DF_ROOT), 'absolute host path must not be shown');
  c.close();
});

test('each VM node executes a bundle through the WebSocket and returns a witness', opts, async () => {
  const c = await new Client(h.url, h.tokens.alice).open(140, 50);
  for (const node of ['small', 'medium', 'large', 'xlarge']) {
    const out = await c.run(`node ${node} run 01_bell_pair.pal --seed 0; echo NODE-DONE-${node}`, `NODE-DONE-${node}\r\n`, 120000);
    assert.match(out, /"witness"|row_sequence_witness/, node); assert.ok(!out.includes(DF_ROOT), node);
  }
  c.close();
});

test('fabric run: four nodes reach CROSS_NODE_DIFFERENTIAL_AGREEMENT over the socket; byte stream is lossless', opts, async () => {
  const c = await new Client(h.url, h.tokens.alice).open(140, 50);
  const out = await c.run('fabric run 02_ghz3.pal --programs replica,bsp --placement dynamic; echo FAB-DONE', 'FAB-DONE\r\n', 180000);
  assert.match(out, /"verdict": "CROSS_NODE_DIFFERENTIAL_AGREEMENT"/); assert.match(out, /"unanimous": true/); assert.match(out, /"network": "deny"/);
  const json = out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1).replace(/\r\n/g, '\n');
  const rec = JSON.parse(json); // the multi-kilobyte JSON survived chunking, base64 and reassembly intact
  assert.strictEqual(rec.schema, 'DF/FABRIC_RUN/1'); assert.ok(rec.source.startsWith('$DF_ROOT/'));
  c.close();
});

test('denied: host-path options, unknown bundles, df use, build (operator-disabled), photon/browser absent', opts, async () => {
  const c = await new Client(h.url, h.tokens.alice).open(140, 50);
  const out = await c.run('fabric run 01_bell_pair.pal --out /tmp/pwn.json; fabric run ../../../etc/passwd; df use /; fabric build; node small build; photon status; browser open http://x; echo DENY-DONE', 'DENY-DONE\r\n', 30000);
  assert.match(out, /--out is not permitted/); assert.match(out, /bare discovered name/); assert.match(out, /bound by the operator/); assert.match(out, /build is disabled/);
  assert.match(out, /photon: command not found/); assert.match(out, /browser: command not found/);
  assert.ok(!fs.existsSync('/tmp/pwn.json'));
  c.close();
});

test('principal without the fabric capability has no fabric commands at all', opts, async () => {
  const c = await new Client(h.url, h.tokens.nofab).open();
  const out = await c.run('fabric status; df where; node small run 01_bell_pair.pal; echo NOFAB-DONE', 'NOFAB-DONE\r\n');
  assert.strictEqual((out.match(/command not found/g) || []).length, 3);
  c.close();
});

test('Ctrl-C stops a running fabric job (exit 130) and the capacity slot is released', opts, async () => {
  const a = await new Client(h.url, h.tokens.alice).open(140, 50);
  a.input('fabric verify\r'); await a.until(() => /dfabric fabric-verify/.test(a.text()), 10000); await sleep(1500);
  a.ctl('terminal.signal', { signal: 'SIGINT' });
  const out = await a.run('echo RC-$?', /RC-\d+/, 20000);
  assert.match(out, /RC-130/);
  const leaseDir = path.join(require('node:os').tmpdir(), 'hermit-vws-fabric-lease');
  await sleep(300); assert.deepStrictEqual(fs.readdirSync(leaseDir).filter((f) => f.startsWith('slot-')), [], 'lease released after interrupt');
  a.close();
});
