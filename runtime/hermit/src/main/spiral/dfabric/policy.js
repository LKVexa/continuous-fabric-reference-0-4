'use strict';
/**
 * SPIRAL — DF fabric remote-execution policy (VWS decision D-002)
 * ---------------------------------------------------------------------------
 * The LOCAL desktop profile forwards arbitrary arguments to the DF CLIs. A
 * network session must not: `--out`, `--event-log`, `--root` and `--nodes-root`
 * name host paths, and a bundle argument is a host path too.
 *
 * Under a remote policy the only process that can be started is the fixed
 * interpreter running the fixed `adapter/dfabric/cli.py` inside the operator-
 * bound DF root, with an argv that this module rebuilt from validated parts.
 * User text never reaches a shell (spawn without shell) and never becomes a path.
 */

const PROFILES = ['single_process_deterministic', 'multi_thread_deterministic', 'multi_process_deterministic', 'multi_process_throughput'];
const PROGRAMS = ['replica', 'pipeline', 'bsp'];
const BUNDLE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.pal$/;

const SPEC = {
  'fabric-run': { bundle: 'optional', flags: { '--profile': { enum: PROFILES }, '--placement': { enum: ['static', 'dynamic'] }, '--programs': { list: PROGRAMS }, '--max-workers': { int: [1, 4] }, '--strict': { bool: true } } },
  'fabric-verify': { bundle: 'none', flags: {} },
  'fabric-attest': { bundle: 'none', flags: {} },
  'fabric-build': { bundle: 'none', flags: {}, build: true },
  'node-run': { bundle: 'required', flags: { '--seed': { int: [0, 2147483647] }, '--max-steps': { int: [1, 1000000] } } },
  'node-verify': { bundle: 'none', flags: { '--skip-own-gates': { bool: true } } },
  'node-attest': { bundle: 'none', flags: {} },
  'node-build': { bundle: 'none', flags: {}, build: true }
};

class PolicyError extends Error { constructor(m) { super(m); this.code = 'EPOLICY'; } }

/**
 * Rebuild a CLI argv from user tokens.
 * @param {string} cli            e.g. 'fabric-run'
 * @param {string[]} rest         user tokens after the subcommand
 * @param {{name:string,path:string}[]} bundles   discovered bundles (the allowlist)
 * @param {{allowBuild:boolean}} policy
 * @returns {string[]} argv (cli + validated args; bundle as discovered absolute path)
 */
function vetArgv(cli, rest, bundles, policy) {
  const spec = SPEC[cli];
  if (!spec) throw new PolicyError(`'${cli}' is not available to remote sessions`);
  if (spec.build && !policy.allowBuild) throw new PolicyError('build is disabled for remote sessions by the operator');
  const argv = [cli];
  let bundle = null;
  const seen = new Set();
  for (let i = 0; i < rest.length; i++) {
    const tok = String(rest[i]);
    if (tok.length > 128) throw new PolicyError('argument too long');
    if (tok.startsWith('-')) {
      let name = tok, val = null;
      const eq = tok.indexOf('=');
      if (eq > 0) { name = tok.slice(0, eq); val = tok.slice(eq + 1); }
      const f = spec.flags[name];
      if (!f) throw new PolicyError(`option ${name.slice(0, 32)} is not permitted for remote sessions`);
      if (seen.has(name)) throw new PolicyError(`option ${name} given twice`);
      seen.add(name);
      if (f.bool) { if (val !== null) throw new PolicyError(`${name} takes no value`); argv.push(name); continue; }
      if (val === null) { val = rest[++i]; if (val === undefined) throw new PolicyError(`${name} needs a value`); val = String(val); }
      if (f.enum) { if (!f.enum.includes(val)) throw new PolicyError(`${name} must be one of: ${f.enum.join(', ')}`); }
      else if (f.list) { const parts = val.split(','); if (!parts.length || new Set(parts).size !== parts.length || !parts.every((p) => f.list.includes(p))) throw new PolicyError(`${name} must be a comma list of: ${f.list.join(', ')}`); }
      else if (f.int) { if (!/^(0|[1-9][0-9]{0,9})$/.test(val) || Number(val) < f.int[0] || Number(val) > f.int[1]) throw new PolicyError(`${name} must be an integer in ${f.int[0]}..${f.int[1]}`); }
      argv.push(name, val);
    } else {
      if (spec.bundle === 'none') throw new PolicyError('this subcommand takes no positional argument for remote sessions');
      if (bundle !== null) throw new PolicyError('only one bundle may be named');
      if (!BUNDLE_RE.test(tok)) throw new PolicyError('bundle must be a bare discovered name such as 01_bell_pair.pal (paths are not accepted)');
      const hit = bundles.find((b) => b.name === tok);
      if (!hit) throw new PolicyError(`unknown bundle: ${tok} (see 'df bundles')`);
      bundle = hit.path;
    }
  }
  if (spec.bundle === 'required' && bundle === null) throw new PolicyError('a bundle name is required');
  if (bundle !== null) argv.splice(1, 0, bundle);
  return argv;
}

module.exports = { vetArgv, PolicyError, SPEC, PROFILES, PROGRAMS, BUNDLE_RE };
