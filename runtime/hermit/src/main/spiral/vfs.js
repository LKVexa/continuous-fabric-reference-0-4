'use strict';

/**
 * SPIRAL — Virtual File System
 * ---------------------------------------------------------------------------
 * An in-memory POSIX-ish filesystem. Nodes are either directories (children map)
 * or files (string/Buffer contents). Paths are normalized with a small path
 * engine so `.`, `..`, absolute and relative forms all behave.
 *
 * The tree is intentionally self-contained (no host disk access) so the terminal
 * is a true sandbox. A host-backed provider can be layered later by implementing
 * the same read/write/stat surface.
 */

const SEP = '/';

/* --------------------------------------------------------------------------
 * path utilities
 * ------------------------------------------------------------------------ */

function splitPath(p) {
  return String(p).split(SEP).filter((seg) => seg.length > 0);
}

/** Resolve `input` against `cwd` into a normalized absolute path. */
function resolvePath(cwd, input) {
  const raw = String(input == null ? '' : input);
  const startAbs = raw.startsWith(SEP);
  const parts = startAbs ? [] : splitPath(cwd);
  for (const seg of splitPath(raw)) {
    if (seg === '.') continue;
    if (seg === '..') { parts.pop(); continue; }
    parts.push(seg);
  }
  return SEP + parts.join(SEP);
}

function basename(p) {
  const parts = splitPath(p);
  return parts.length ? parts[parts.length - 1] : '';
}

function dirname(p) {
  const parts = splitPath(p);
  parts.pop();
  return SEP + parts.join(SEP);
}

/* --------------------------------------------------------------------------
 * nodes
 * ------------------------------------------------------------------------ */

function dirNode() {
  return { type: 'dir', children: new Map(), mtime: Date.now(), mode: 0o755 };
}
function fileNode(contents = '') {
  return { type: 'file', contents, mtime: Date.now(), mode: 0o644 };
}

class VFSError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'VFSError';
  }
}

/** Content size of a file node's payload in bytes (string => UTF-8 length). */
function contentBytes(c) { return Buffer.isBuffer(c) ? c.length : Buffer.byteLength(String(c)); }

/** Byte-preserving concatenation: a Buffer on either side keeps raw bytes (series F09 / I028). */
function concatContents(a, b) {
  if (Buffer.isBuffer(a) || Buffer.isBuffer(b)) {
    return Buffer.concat([Buffer.isBuffer(a) ? a : Buffer.from(String(a), 'utf8'), Buffer.isBuffer(b) ? b : Buffer.from(String(b), 'utf8')]);
  }
  return a + b;
}

function subtreeCost(node) {
  if (node.type === 'file') return { bytes: contentBytes(node.contents), nodes: 1 };
  let bytes = 0, nodes = 1;
  for (const c of node.children.values()) { const r = subtreeCost(c); bytes += r.bytes; nodes += r.nodes; }
  return { bytes, nodes };
}

class VFS {
  /**
   * @param {object} [limits]
   * @param {number} [limits.maxBytes]  total file-content bytes (default unlimited: LOCAL profile)
   * @param {number} [limits.maxNodes]  total files + directories, root included
   */
  constructor(limits = {}) {
    this.maxBytes = Number.isFinite(limits.maxBytes) ? limits.maxBytes : Infinity;
    this.maxNodes = Number.isFinite(limits.maxNodes) ? limits.maxNodes : Infinity;
    this.usedBytes = 0;
    this.nodeCount = 1;
    this.root = dirNode();
    this._seed();
  }

  /** Reserve quota or throw before any mutation happens (atomic accounting). */
  _reserve(deltaBytes, deltaNodes) {
    if (this.usedBytes + deltaBytes > this.maxBytes) throw new VFSError('EDQUOT', `workspace byte quota exceeded (${this.maxBytes} bytes)`);
    if (this.nodeCount + deltaNodes > this.maxNodes) throw new VFSError('EDQUOT', `workspace node quota exceeded (${this.maxNodes} nodes)`);
    this.usedBytes += deltaBytes;
    this.nodeCount += deltaNodes;
  }

  usage() { return { bytes: this.usedBytes, nodes: this.nodeCount, maxBytes: this.maxBytes, maxNodes: this.maxNodes }; }

  /* ---- traversal ------------------------------------------------------- */

  _walk(absPath, { parents = false } = {}) {
    const parts = splitPath(absPath);
    let node = this.root;
    for (let i = 0; i < parts.length; i++) {
      if (node.type !== 'dir') throw new VFSError('ENOTDIR', `not a directory: ${parts[i - 1]}`);
      let next = node.children.get(parts[i]);
      if (!next) {
        if (parents) { this._reserve(0, 1); next = dirNode(); node.children.set(parts[i], next); }
        else throw new VFSError('ENOENT', `no such file or directory: ${absPath}`);
      }
      node = next;
    }
    return node;
  }

  stat(absPath) {
    const node = this._walk(absPath);
    return {
      path: absPath,
      type: node.type,
      size: node.type === 'file' ? contentBytes(node.contents) : node.children.size,
      mtime: node.mtime,
      mode: node.mode
    };
  }

  exists(absPath) {
    try { this._walk(absPath); return true; } catch { return false; }
  }

  isDir(absPath) {
    try { return this._walk(absPath).type === 'dir'; } catch { return false; }
  }

  /* ---- files ----------------------------------------------------------- */

  readFile(absPath) {
    const node = this._walk(absPath);
    if (node.type !== 'file') throw new VFSError('EISDIR', `is a directory: ${absPath}`);
    return node.contents;
  }

  writeFile(absPath, contents, { append = false } = {}) {
    const parent = this._walk(dirname(absPath));
    if (parent.type !== 'dir') throw new VFSError('ENOTDIR', `not a directory: ${dirname(absPath)}`);
    const name = basename(absPath);
    const existing = parent.children.get(name);
    if (existing && existing.type === 'dir') throw new VFSError('EISDIR', `is a directory: ${absPath}`);
    if (!Buffer.isBuffer(contents)) contents = String(contents == null ? '' : contents);
    if (existing && append && existing.type === 'file') {
      this._reserve(contentBytes(contents), 0);
      existing.contents = concatContents(existing.contents, contents);
      existing.mtime = Date.now();
    } else {
      const old = existing ? contentBytes(existing.contents) : 0;
      this._reserve(contentBytes(contents) - old, existing ? 0 : 1);
      parent.children.set(name, fileNode(contents));
    }
    return true;
  }

  /* ---- directories ----------------------------------------------------- */

  mkdir(absPath, { recursive = false } = {}) {
    if (recursive) { this._walk(absPath, { parents: true }); return true; }
    const parent = this._walk(dirname(absPath));
    if (parent.type !== 'dir') throw new VFSError('ENOTDIR', `not a directory: ${dirname(absPath)}`);
    const name = basename(absPath);
    if (parent.children.has(name)) throw new VFSError('EEXIST', `file exists: ${absPath}`);
    this._reserve(0, 1);
    parent.children.set(name, dirNode());
    return true;
  }

  readdir(absPath) {
    const node = this._walk(absPath);
    if (node.type !== 'dir') throw new VFSError('ENOTDIR', `not a directory: ${absPath}`);
    return [...node.children.entries()].map(([name, n]) => ({
      name,
      type: n.type,
      size: n.type === 'file' ? contentBytes(n.contents) : n.children.size,
      mtime: n.mtime,
      mode: n.mode
    })).sort((a, b) => a.name.localeCompare(b.name));
  }

  remove(absPath, { recursive = false } = {}) {
    if (absPath === SEP) throw new VFSError('EPERM', 'cannot remove root');
    const parent = this._walk(dirname(absPath));
    const name = basename(absPath);
    const node = parent.children.get(name);
    if (!node) throw new VFSError('ENOENT', `no such file or directory: ${absPath}`);
    if (node.type === 'dir' && node.children.size > 0 && !recursive) {
      throw new VFSError('ENOTEMPTY', `directory not empty: ${absPath}`);
    }
    const cost = subtreeCost(node);
    parent.children.delete(name);
    this.usedBytes -= cost.bytes;
    this.nodeCount -= cost.nodes;
    return true;
  }

  move(fromAbs, toAbs) {
    const node = this._walk(fromAbs);
    const destExistsDir = this.isDir(toAbs);
    const finalPath = destExistsDir ? resolvePath(toAbs, basename(fromAbs)) : toAbs;
    if (finalPath === fromAbs) return finalPath;
    if (node.type === 'dir' && (finalPath + SEP).startsWith(fromAbs + SEP)) throw new VFSError('EINVAL', 'cannot move a directory into itself');
    const destParent = this._walk(dirname(finalPath));
    if (destParent.type !== 'dir') throw new VFSError('ENOTDIR', `not a directory: ${dirname(finalPath)}`);
    const replaced = destParent.children.get(basename(finalPath));
    if (replaced) { const c = subtreeCost(replaced); this.usedBytes -= c.bytes; this.nodeCount -= c.nodes; }
    destParent.children.set(basename(finalPath), node);
    const srcParent = this._walk(dirname(fromAbs));
    srcParent.children.delete(basename(fromAbs));
    return finalPath;
  }

  /* ---- quiescent snapshot (series I038) -------------------------------- */

  /** Explicit, versioned, byte-exact serialization. Buffers and strings keep their kind. */
  exportSnapshot() {
    const enc = (node) => node.type === 'file'
      ? { k: 'f', m: node.mode, t: node.mtime, e: Buffer.isBuffer(node.contents) ? 'b64' : 'utf8', c: Buffer.isBuffer(node.contents) ? node.contents.toString('base64') : node.contents }
      : { k: 'd', m: node.mode, t: node.mtime, ch: [...node.children.entries()].map(([n, c]) => [n, enc(c)]) };
    return { v: 1, root: enc(this.root) };
  }

  /** Validate fully (shape, names, quotas) into a detached tree, then swap. Never partially applies. */
  importSnapshot(snap) {
    if (!snap || snap.v !== 1 || !snap.root || snap.root.k !== 'd') throw new VFSError('EINVAL', 'unsupported snapshot');
    let bytes = 0, nodes = 0;
    const dec = (o, depth) => {
      if (depth > 64) throw new VFSError('EINVAL', 'snapshot too deep');
      nodes++;
      if (nodes > this.maxNodes) throw new VFSError('EDQUOT', 'snapshot node quota');
      if (o && o.k === 'f') {
        if (typeof o.c !== 'string' || (o.e !== 'utf8' && o.e !== 'b64')) throw new VFSError('EINVAL', 'bad file record');
        const contents = o.e === 'b64' ? Buffer.from(o.c, 'base64') : o.c;
        bytes += contentBytes(contents);
        if (bytes > this.maxBytes) throw new VFSError('EDQUOT', 'snapshot byte quota');
        const n = fileNode(contents); n.mode = o.m | 0; n.mtime = Number(o.t) || Date.now(); return n;
      }
      if (o && o.k === 'd' && Array.isArray(o.ch)) {
        const n = dirNode(); n.mode = o.m | 0; n.mtime = Number(o.t) || Date.now();
        for (const pair of o.ch) {
          if (!Array.isArray(pair) || typeof pair[0] !== 'string' || !pair[0] || pair[0] === '.' || pair[0] === '..' || pair[0].includes(SEP) || pair[0].length > 255) throw new VFSError('EINVAL', 'bad entry name');
          if (n.children.has(pair[0])) throw new VFSError('EINVAL', 'duplicate entry');
          n.children.set(pair[0], dec(pair[1], depth + 1));
        }
        return n;
      }
      throw new VFSError('EINVAL', 'bad node record');
    };
    const root = dec(snap.root, 0);
    this.root = root; this.usedBytes = bytes; this.nodeCount = nodes;
    return this.usage();
  }

  /* ---- seed content ---------------------------------------------------- */

  _seed() {
    this.mkdir('/home', { recursive: true });
    this.mkdir('/home/operator', { recursive: true });
    this.mkdir('/etc', { recursive: true });
    this.mkdir('/var/log', { recursive: true });
    this.mkdir('/tmp', { recursive: true });
    this.writeFile('/etc/hermit.conf',
      '# HERMIT runtime configuration\nbackend = SPIRAL\nvt = internal\nbrowser = VB-JA21/9.8.7\n');
    this.writeFile('/home/operator/README',
      'Welcome to HERMIT — a virtual terminal on the SPIRAL backend.\n' +
      'Type `help` for the command index, `about` for the architecture.\n');
    this.writeFile('/home/operator/.hermitrc',
      '# sourced at session start\nexport PS1="\\u@hermit:\\w$ "\nalias ll="ls -l"\n');
  }
}

module.exports = { VFS, VFSError, resolvePath, basename, dirname, splitPath, contentBytes };
