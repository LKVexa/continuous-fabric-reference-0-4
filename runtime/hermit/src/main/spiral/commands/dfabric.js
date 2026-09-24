'use strict';

/**
 * SPIRAL built-ins — DF fabric control (`df`, `fabric`, `node`)
 * ---------------------------------------------------------------------------
 * Makes HERMIT the control surface for the DF container fabric:
 *   • renders the federation, topology and node roster natively (read-only,
 *     no execution) from the descriptors in the user's DF root, and
 *   • drives the real DF CLIs (node-/fabric- build/verify/run/attest) as child
 *     processes, streaming their output live into the VT.
 *
 * HERMIT ships no DF content. Point it at the containers with `df use <path>`
 * or the DF_ROOT environment variable.
 */

const path = require('node:path');
const { DFLocator, NODES } = require('../dfabric/locator');
const { runCli, PYTHON } = require('../dfabric/runner');
const { fromEnv } = require('../photon/client');
const { runComplexFabric } = require('../photon/workflow');
const { vetArgv } = require('../dfabric/policy');
const { fail, padRight } = require('./util');

/** Remote-session policy injected by the headless worker; undefined for the LOCAL desktop profile. */
function policyOf(ctx) { return (ctx.host && ctx.host.fabricPolicy) || null; }

function makeLocator(ctx) {
  const pol = policyOf(ctx);
  if (pol) {
    // Remote: exactly the operator-bound root. No env, cwd, resources or user-supplied discovery.
    const loc = new DFLocator({ fixedRoot: pol.root });
    return loc;
  }
  return new DFLocator({
    envRoot: () => ctx.env.get('DF_ROOT'),
    resourcesPath: process.resourcesPath,
    appDir: (() => { try { return path.dirname(process.execPath); } catch { return undefined; } })()
  });
}

function needRoot(ctx, loc) {
  const r = loc.root();
  if (!r) {
    ctx.stderr.write(
      '\x1b[31mdf: no DF root found.\x1b[0m Point HERMIT at your containers:\n' +
      '  \x1b[38;5;75mdf use /path/to/folder-containing-DF_Fabric\x1b[0m\n' +
      '  \x1b[2m(or set the DF_ROOT environment variable)\x1b[0m\n');
    return null;
  }
  return r;
}

/** Split argv (after the subcommand) into a leading program token + passthrough. */
function splitProgram(rest) {
  let program = null;
  const pass = [];
  for (const a of rest) {
    if (program === null && a[0] !== '-') program = a;
    else pass.push(a);
  }
  return { program, pass };
}

/* ------------------------------------------------------------------------- */

const dfCmd = {
  name: 'df',
  summary: 'DF fabric: root, nodes, bundles, docs',
  usage: 'df <where|use|nodes|bundles|spec|doctor> [...]',
  async run(ctx) {
    const loc = makeLocator(ctx);
    const sub = ctx.argv[0];

    switch (sub) {
      case undefined:
      case 'help':
        ctx.stdout.write([
          '\x1b[1mDF fabric control\x1b[0m',
          '  \x1b[38;5;79mdf where\x1b[0m              show the resolved DF root and toolchain',
          '  \x1b[38;5;79mdf use <path>\x1b[0m         bind the folder that holds DF_Fabric + nodes',
          '  \x1b[38;5;79mdf nodes\x1b[0m              the four-node roster (presence, build state)',
          '  \x1b[38;5;79mdf bundles\x1b[0m            discoverable .pal bundles',
          '  \x1b[38;5;79mdf spec <fabric|index|language>\x1b[0m  print a spec document',
          '  \x1b[38;5;79mdf doctor\x1b[0m             check python + node build state',
          '',
          '  \x1b[38;5;75mfabric\x1b[0m topology|status|run|build|verify   \x1b[2m— federation programs\x1b[0m',
          '  \x1b[38;5;75mnode\x1b[0m <small|medium|large|xlarge> run|build|verify  \x1b[2m— one node\x1b[0m',
          ''
        ].join('\n') + '\n');
        return 0;

      case 'use': {
        if (policyOf(ctx)) return fail(ctx, 'df', 'the DF root is bound by the operator for remote sessions; `df use` is a LOCAL desktop capability');
        if (!ctx.argv[1]) return fail(ctx, 'df', 'usage: df use <path>');
        const resolved = ctx.resolveHost ? ctx.resolveHost(ctx.argv[1]) : path.resolve(ctx.argv[1]);
        ctx.env.set('DF_ROOT', resolved);
        loc.setRoot(resolved);
        const r = loc.root();
        if (!r) { ctx.stdout.write(`\x1b[33mdf: set DF_ROOT=${resolved}, but no DF_Fabric/node folders found there yet\x1b[0m\n`); return 1; }
        ctx.stdout.write(`\x1b[38;5;79m✓\x1b[0m DF root bound: ${r}\n`);
        return 0;
      }

      case 'where': {
        const r = loc.root();
        ctx.stdout.write([
          `\x1b[1mDF root\x1b[0m   : ${r ? shown(ctx, r) : '\x1b[31m(not found)\x1b[0m'}`,
          `python     : ${policyOf(ctx) ? '(operator-fixed interpreter)' : PYTHON}`,
          `fabric dir : ${loc.fabricDir() ? shown(ctx, loc.fabricDir()) : '—'}`,
          ''
        ].join('\n') + '\n');
        if (!r) needRoot(ctx, loc);
        return r ? 0 : 1;
      }

      case 'nodes': {
        if (!needRoot(ctx, loc)) return 1;
        const roster = loc.roster();
        ctx.stdout.write(
          '\x1b[1m' + padRight('NODE', 10) + padRight('CONTAINER', 16) + padRight('LINEAGE', 34) + 'STATE\x1b[0m\n');
        for (const n of roster) {
          const state = !n.present ? '\x1b[31mabsent\x1b[0m'
            : n.built ? '\x1b[38;5;114mbuilt\x1b[0m' : '\x1b[33mnot built\x1b[0m';
          ctx.stdout.write(
            padRight(n.node, 10) + padRight(n.dir, 16) + padRight(n.lineage, 34) + state + '\n');
        }
        return 0;
      }

      case 'bundles': {
        if (!needRoot(ctx, loc)) return 1;
        const b = loc.bundles();
        if (!b.length) { ctx.stdout.write('\x1b[2mno .pal bundles found\x1b[0m\n'); return 0; }
        for (const x of b) ctx.stdout.write(`  \x1b[38;5;75m${padRight(x.name, 30)}\x1b[0m \x1b[2m${x.from}\x1b[0m\n`);
        return 0;
      }

      case 'spec': {
        const doc = loc.specDoc(ctx.argv[1] || 'index');
        if (!doc) { if (!needRoot(ctx, loc)) return 1; return fail(ctx, 'df', `no such spec: ${ctx.argv[1] || 'index'} (try fabric|index|language)`); }
        ctx.stdout.write(doc.text.endsWith('\n') ? doc.text : doc.text + '\n');
        return 0;
      }

      case 'doctor': {
        if (!needRoot(ctx, loc)) return 1;
        const roster = loc.roster();
        ctx.stdout.write(`python override : ${PYTHON}\n`);
        for (const n of roster) {
          ctx.stdout.write(`  ${padRight(n.node, 10)} ${n.present ? 'present' : 'ABSENT'}${n.present ? (n.built ? ', built' : ', \x1b[33mrun `node ' + n.key + ' build`\x1b[0m') : ''}\n`);
        }
        return 0;
      }

      default:
        return fail(ctx, 'df', `unknown subcommand: ${sub}`);
    }
  },
  complete(ctx, partial) {
    return ['where', 'use', 'nodes', 'bundles', 'spec', 'doctor', 'help'].filter((s) => s.startsWith(partial));
  }
};

/* ------------------------------------------------------------------------- */

const fabricCmd = {
  name: 'fabric',
  summary: 'run federation programs over all four nodes',
  usage: 'fabric <topology|status|run|build|verify|attest> [bundle] [--profile P] [--placement static|dynamic] [--programs a,b]',
  async run(ctx) {
    const loc = makeLocator(ctx);
    const sub = ctx.argv[0] || 'status';
    // Photon delegation is a LOCAL capability: a remote session must not make this host call out.
    const photon = policyOf(ctx) ? null : fromEnv(ctx.env); // bound iff VEC1_API is set

    // Prefer the Photon control plane for reads when one is bound.
    if (sub === 'topology') {
      if (photon && await photon.reachable(ctx.signal)) {
        try { ctx.stdout.write(JSON.stringify(await photon.topology(ctx.signal), null, 2) + '\n'); return 0; }
        catch (e) { ctx.stderr.write(`\x1b[2mphoton topology unavailable (${e.message}); using local descriptors\x1b[0m\n`); }
      }
      return renderTopology(ctx, loc);
    }
    if (sub === 'status') return renderStatus(ctx, loc, photon);

    // ---- run: delegate the complex request to the Photon (workflow: 2 → 1) ----
    if (sub === 'run' && photon) {
      const reachable = await photon.reachable(ctx.signal);
      if (reachable) {
        ctx.stdout.write('\x1b[38;5;79m⟳ delegating to VEC1 Photon\x1b[0m \x1b[2m(electron lifecycle → fabric proof)\x1b[0m\n');
        let res;
        try {
          res = await runComplexFabric(photon, { name: ctx.env.get('VEC1_ELECTRON') || 'hermit' },
            { stdout: ctx.stdout, stderr: ctx.stderr }, ctx.signal);
        } catch (e) {
          if (e.code === 'PHOTON_AUTH') return fail(ctx, 'fabric', 'Photon rejected (403): set the token with `photon use <url> <token>`');
          ctx.stderr.write(`\x1b[33mphoton delegation failed (${e.message}); falling back to local DF CLI\x1b[0m\n`);
          return runFabricCli(ctx, loc, sub, ctx.argv.slice(1));
        }
        // step 1b: if a specific bundle was named, run it natively on the fabric too.
        const { program } = splitProgram(ctx.argv.slice(1));
        if (program) {
          ctx.stdout.write(`\x1b[2m— named bundle ${program}: running on the fabric —\x1b[0m\n`);
          return runFabricCli(ctx, loc, 'run', ctx.argv.slice(1));
        }
        return res.verdict && String(res.verdict).includes('AGREEMENT') ? 0 : 1;
      }
      ctx.stderr.write('\x1b[33mphoton bound but unreachable; using local DF CLI\x1b[0m\n');
    }

    // ---- direct DF CLI path (no Photon) ----
    return runFabricCli(ctx, loc, sub, ctx.argv.slice(1));
  },
  complete(ctx, partial) {
    return ['topology', 'status', 'run', 'build', 'verify', 'attest'].filter((s) => s.startsWith(partial));
  }
};

/* ------------------------------------------------------------------------- */

const nodeCmd = {
  name: 'node',
  summary: 'build / verify / run a single DF node',
  usage: 'node <small|medium|large|xlarge> <run|build|verify|attest> [bundle] [--seed N] [--max-steps N]',
  async run(ctx) {
    const loc = makeLocator(ctx);
    const key = ctx.argv[0];
    const sub = ctx.argv[1];
    if (!key || !sub) return fail(ctx, 'node', 'usage: node <small|medium|large|xlarge> <run|build|verify|attest> [...]');

    const spec = loc.nodeSpec(key);
    if (!spec) return fail(ctx, 'node', `unknown node: ${key} (small|medium|large|xlarge)`);
    if (!needRoot(ctx, loc)) return 1;
    const dir = loc.nodeDir(key);
    if (!dir) return fail(ctx, 'node', `${spec.dir} not found under the DF root`);

    const cli = { run: 'node-run', build: 'node-build', verify: 'node-verify', attest: 'node-attest' }[sub];
    if (!cli) return fail(ctx, 'node', `unknown subcommand: ${sub}`);

    const rest = ctx.argv.slice(2);
    if (policyOf(ctx)) return runPoliced(ctx, loc, dir, cli, rest, `[${spec.node}] `);
    let argv = [cli];
    if (sub === 'run') {
      const { program, pass } = splitProgram(rest);
      if (!program) return fail(ctx, 'node', 'usage: node ' + key + ' run <bundle.pal> [--seed N] [--max-steps N]');
      argv.push(resolveBundle(loc, program));
      argv = argv.concat(pass);
    } else {
      argv = argv.concat(rest);
    }

    ctx.stdout.write(`\x1b[2m[${spec.node}] $ ${PYTHON} adapter/dfabric/cli.py ${argv.join(' ')}\x1b[0m\n`);
    return runCli({ cwd: dir, argv, stdout: ctx.stdout, stderr: ctx.stderr, signal: ctx.signal });
  },
  complete(ctx, partial) {
    return ['small', 'medium', 'large', 'xlarge'].filter((s) => s.startsWith(partial));
  }
};

/* ---- native renderers (read-only) --------------------------------------- */

function runFabricCli(ctx, loc, sub, rest) {
  if (!needRoot(ctx, loc)) return 1;
  const fd = loc.fabricDir();
  if (!fd) return fail(ctx, 'fabric', 'DF_Fabric not found under the DF root');
  const cli = { build: 'fabric-build', verify: 'fabric-verify', attest: 'fabric-attest', run: 'fabric-run' }[sub];
  if (!cli) return fail(ctx, 'fabric', `unknown subcommand: ${sub}`);
  if (policyOf(ctx)) return runPoliced(ctx, loc, fd, cli, rest, '');
  let argv = [cli];
  if (sub === 'run') {
    const { program, pass } = splitProgram(rest);
    if (program) argv.push(resolveBundle(loc, program));
    argv = argv.concat(pass);
  } else {
    argv = argv.concat(rest);
  }
  ctx.stdout.write(`\x1b[2m$ ${PYTHON} adapter/dfabric/cli.py ${argv.join(' ')}\x1b[0m\n`);
  return runCli({ cwd: fd, argv, stdout: ctx.stdout, stderr: ctx.stderr, signal: ctx.signal });
}

/** Show a host path to the user: verbatim locally, root-relative placeholder remotely. */
function shown(ctx, p) {
  const pol = policyOf(ctx);
  if (!pol) return p;
  return p === pol.root ? '$DF_ROOT' : p.startsWith(pol.root + path.sep) ? '$DF_ROOT' + p.slice(pol.root.length) : '(hidden)';
}

/** Remote path: validated argv, leased capacity, allowlisted env, deadline, redacted output. */
async function runPoliced(ctx, loc, cwd, cli, rest, tag) {
  const pol = policyOf(ctx);
  let argv;
  try { argv = vetArgv(cli, rest, loc.bundles(), pol); }
  catch (e) { return fail(ctx, cli.split('-')[0], e.message, 2); }
  const kind = cli.endsWith('-build') ? 'build' : cli.endsWith('-verify') ? 'verify' : 'run';
  let release;
  try { release = await pol.acquire(kind, ctx.signal); }
  catch (e) { return fail(ctx, cli.split('-')[0], e.message, e.code === 'ABORT_ERR' ? 130 : 75); }
  // Python reports resolved paths: redact the configured root AND its realpath form.
  const roots = [...new Set([pol.root, (() => { try { return require('node:fs').realpathSync(pol.root); } catch { return pol.root; } })()])].sort((a, b) => b.length - a.length);
  const redact = (t) => roots.reduce((acc, r) => acc.split(r).join('$DF_ROOT'), t);
  redact.keep = Math.max(...roots.map((r) => r.length));
  try {
    ctx.stdout.write(`\x1b[2m${tag}$ dfabric ${redact(argv.join(' '))}\x1b[0m\n`);
    return await runCli({ cwd, argv, stdout: ctx.stdout, stderr: ctx.stderr, signal: ctx.signal, env: pol.env, python: pol.python,
      deadlineMs: pol.deadlineMs[kind], redact, flow: ctx.host.flow });
  } finally { release(); }
}

function resolveBundle(loc, program) {
  // If a bare bundle name is given, resolve it to an absolute path via discovery.
  if (program.includes('/') || program.includes('\\')) return program;
  const hit = loc.bundles().find((b) => b.name === program);
  return hit ? hit.path : program;
}

function renderTopology(ctx, loc) {
  const fed = loc.fabricDescriptor('FEDERATION.json');
  const topo = loc.fabricDescriptor('TOPOLOGY.json');
  if (!fed && !topo) {
    if (!needRoot(ctx, loc)) return 1;
    return fail(ctx, 'fabric', 'topology descriptors not found (need DF_Fabric/fabric/*.json)');
  }
  ctx.stdout.write(`\x1b[1mFederation ${fed ? fed_id(fed) : 'DF0'}\x1b[0m  \x1b[2m${(fed && fed.df_release) || ''}\x1b[0m\n`);
  if (fed && Array.isArray(fed.domains)) {
    for (const d of fed.domains) {
      const desc = fed.domain_descriptions && fed.domain_descriptions[d.domain_id];
      ctx.stdout.write(`\n  \x1b[38;5;79m${d.domain_id}\x1b[0m ${desc ? '\x1b[2m' + desc.description + '\x1b[0m' : ''}\n`);
      for (const g of d.groups || []) {
        const caps = (g.capabilities || []).join(', ');
        ctx.stdout.write(`    group ${padRight(g.group_id, 8)} \x1b[2m${caps}\x1b[0m\n`);
      }
    }
  }
  if (topo && Array.isArray(topo.links)) {
    ctx.stdout.write(`\n  \x1b[1mlinks\x1b[0m \x1b[2m(${topo.links.length} classical channels, transport=local_process)\x1b[0m\n`);
    for (const l of topo.links) {
      ctx.stdout.write(`    ${padRight(l.link_id, 4)} ${padRight(l.a, 9)} \x1b[2m──\x1b[0m ${l.b}\n`);
    }
  }
  ctx.stdout.write('\n  \x1b[2mNETWORK=deny · BACKEND=none · distributed_state ≤ DISTRIBUTED_CLASSICAL_EMULATION\x1b[0m\n');
  return 0;
}

function fed_id(fed) { return fed.federation_id || (fed.domains && fed.domains[0] && fed.domains[0].federation_id) || 'DF0'; }

function renderStatus(ctx, loc, photon) {
  const r = loc.root();
  const pURL = ctx.env.get('VEC1_API');
  ctx.stdout.write(`\x1b[1mDF fabric status\x1b[0m\n  root   : ${r ? shown(ctx, r) : '\x1b[31mnot bound\x1b[0m'}\n  python : ${policyOf(ctx) ? '(operator-fixed interpreter)' : PYTHON}\n  photon : ${pURL ? pURL + (ctx.env.get('VEC1_TOKEN') ? ' \x1b[2m(token set)\x1b[0m' : ' \x1b[33m(no token)\x1b[0m') : (policyOf(ctx) ? '\x1b[2mnot available to remote sessions\x1b[0m' : '\x1b[2mnot bound — runs go to local DF CLI\x1b[0m')}\n\n`);
  if (!r) { needRoot(ctx, loc); return 1; }
  const roster = loc.roster();
  ctx.stdout.write('  ' + '\x1b[1m' + padRight('NODE', 10) + padRight('PRESENT', 9) + padRight('BUILT', 7) + 'MANIFEST sha256\x1b[0m\n');
  for (const n of roster) {
    const dig = n.manifest_sha256 ? n.manifest_sha256.slice(0, 16) + '…' : '—';
    // Pad on plain text, then colorize, so ANSI codes don't skew column widths.
    const present = padRight(n.present ? 'yes' : 'no', 9);
    const built = padRight(n.built ? 'yes' : 'no', 7);
    const presentC = present.replace('yes', '\x1b[38;5;114myes\x1b[0m').replace(/^no/, '\x1b[31mno\x1b[0m');
    ctx.stdout.write('  ' + padRight(n.node, 10) + presentC + built + dig + '\n');
  }
  const bundles = loc.bundles().length;
  ctx.stdout.write(`\n  bundles discoverable: ${bundles}\n  \x1b[2mnext: fabric topology · fabric run 01_bell_pair.pal · node small build\x1b[0m\n`);
  return 0;
}

module.exports = [dfCmd, fabricCmd, nodeCmd];
