'use strict';

/**
 * SPIRAL — DF fabric locator
 * ---------------------------------------------------------------------------
 * Finds the DF container set on the host filesystem and reads its descriptors.
 * HERMIT ships NONE of the DF packages — this module points at wherever the
 * user's `DF_Small / DF_Medium / DF_Large / DF_Xtra_Large / DF_Fabric` folders
 * already live and reads them in place.
 *
 * Resolution order for the DF root (the directory holding the five containers):
 *   1. an explicit path passed in (from `df use <path>`)
 *   2. session/host env  DF_ROOT
 *   3. app resources dir  <resources>/df           (if the user bundled them)
 *   4. the directory next to the app executable + /df
 *   5. the current working directory
 *
 * All reads are read-only. Nothing here spawns a process (see runner.js).
 */

const fs = require('node:fs');
const path = require('node:path');

/** Structural roster — container folder ↔ node id ↔ CLI target. */
const NODES = [
  { key: 'small', dir: 'DF_Small', node: 'N_SMALL', lineage: 'BOTTLE ROCKET 3.0.0-MODEL' },
  { key: 'medium', dir: 'DF_Medium', node: 'N_MEDIUM', lineage: 'BOTTLE ROCKET 5.0.0 (4.7.0 core)' },
  { key: 'large', dir: 'DF_Large', node: 'N_LARGE', lineage: 'BOTTLE ROCKET 4.7.0' },
  { key: 'xlarge', dir: 'DF_Xtra_Large', node: 'N_XLARGE', lineage: 'QUORUM VM 5.0.0-candidate' }
];
const NODE_ALIASES = { xl: 'xlarge', xtra: 'xlarge', xtra_large: 'xlarge', extra: 'xlarge', s: 'small', m: 'medium', l: 'large' };
const FABRIC_DIR = 'DF_Fabric';

function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }

class DFLocator {
  /**
   * @param {object} opts
   * @param {()=>string|undefined} opts.envRoot  reads DF_ROOT from the session env
   * @param {string} [opts.resourcesPath]        Electron process.resourcesPath
   * @param {string} [opts.appDir]               directory of the app executable
   */
  constructor(opts = {}) {
    this.opts = opts;
    this.override = null; // set by `df use`
  }

  setRoot(p) { if (this.opts.fixedRoot) return this.root(); this.override = p ? path.resolve(p) : null; return this.root(); }

  /** Resolve the DF root directory, or null if none looks valid. */
  root() {
    if (this.opts.fixedRoot) {
      const c = path.resolve(this.opts.fixedRoot);
      return (isDir(path.join(c, FABRIC_DIR)) || NODES.some((n) => isDir(path.join(c, n.dir)))) ? c : null;
    }
    const candidates = [];
    if (this.override) candidates.push(this.override);
    const env = this.opts.envRoot && this.opts.envRoot();
    if (env) candidates.push(env);
    if (process.env.DF_ROOT) candidates.push(process.env.DF_ROOT);
    if (this.opts.resourcesPath) candidates.push(path.join(this.opts.resourcesPath, 'df'));
    if (this.opts.appDir) candidates.push(path.join(this.opts.appDir, 'df'));
    candidates.push(process.cwd());

    for (const c of candidates) {
      if (!c) continue;
      // A valid root contains DF_Fabric or at least one node container.
      if (isDir(path.join(c, FABRIC_DIR)) || NODES.some((n) => isDir(path.join(c, n.dir)))) {
        return path.resolve(c);
      }
    }
    return null;
  }

  fabricDir() {
    const r = this.root();
    if (!r) return null;
    const d = path.join(r, FABRIC_DIR);
    return isDir(d) ? d : null;
  }

  nodeDir(key) {
    const r = this.root();
    if (!r) return null;
    const canon = NODE_ALIASES[key] || key;
    const spec = NODES.find((n) => n.key === canon);
    if (!spec) return null;
    const d = path.join(r, spec.dir);
    return isDir(d) ? d : null;
  }

  nodeSpec(key) {
    const canon = NODE_ALIASES[key] || key;
    return NODES.find((n) => n.key === canon) || null;
  }

  /** Presence + pinned-digest snapshot for each node, from the fabric descriptor. */
  roster() {
    const r = this.root();
    const fabricNodes = this.fabricDescriptor('NODES.json');
    const pinned = {};
    if (fabricNodes && Array.isArray(fabricNodes.nodes)) {
      for (const n of fabricNodes.nodes) pinned[n.node_id] = n;
    }
    return NODES.map((spec) => {
      const dir = r ? path.join(r, spec.dir) : null;
      const present = dir ? isDir(dir) : false;
      const built = present ? this._nodeBuilt(dir, spec) : false;
      return {
        ...spec,
        present,
        built,
        path: dir,
        manifest_sha256: pinned[spec.node] ? pinned[spec.node].manifest_sha256 : null,
        vm_package_dir: pinned[spec.node] ? pinned[spec.node].vm_package_dir : null
      };
    });
  }

  _nodeBuilt(dir, spec) {
    // Heuristic: the node's VM has a .build/ product once BUILD has run.
    const vmRoot = path.join(dir, 'vm');
    if (!isDir(vmRoot)) return false;
    try {
      for (const pkg of fs.readdirSync(vmRoot)) {
        if (isDir(path.join(vmRoot, pkg, '.build'))) return true;
      }
    } catch { /* ignore */ }
    return false;
  }

  /** Read a descriptor JSON from the fabric's fabric/ dir (or null). */
  fabricDescriptor(name) {
    const fd = this.fabricDir();
    if (!fd) return null;
    return readJSON(path.join(fd, 'fabric', name));
  }

  /** Discover .pal bundles across the fabric examples and each node's examples. */
  bundles() {
    const r = this.root();
    if (!r) return [];
    const found = new Map();
    const scan = (label, dir) => {
      if (!isDir(dir)) return;
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith('.pal') && !found.has(f)) found.set(f, { name: f, from: label, path: path.join(dir, f) });
      }
    };
    const fd = this.fabricDir();
    if (fd) { scan('fabric', path.join(fd, 'examples')); scan('fabric', path.join(fd, 'fabric')); }
    for (const n of NODES) scan(n.key, path.join(r, n.dir, 'examples'));
    return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Locate a spec/doc markdown by short name, from the fabric or a node. */
  specDoc(which) {
    const fd = this.fabricDir();
    const map = {
      fabric: fd && path.join(fd, 'spec', 'DF_FABRIC_SPEC.md'),
      index: fd && path.join(fd, 'DF_INDEX.md'),
      language: fd && path.join(fd, 'spec', 'DF_LANGUAGE_MAP.md')
    };
    const p = map[which];
    if (p && exists(p)) return { path: p, text: fs.readFileSync(p, 'utf8') };
    return null;
  }
}

module.exports = { DFLocator, NODES, FABRIC_DIR };
