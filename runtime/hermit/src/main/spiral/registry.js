'use strict';

/**
 * SPIRAL — Command Registry
 * ---------------------------------------------------------------------------
 * The extension surface. A command is a plain descriptor:
 *
 *   {
 *     name: 'ls',
 *     summary: 'list directory contents',
 *     usage: 'ls [-l] [-a] [path...]',
 *     flags: { l: 'long listing', a: 'include dotfiles' },   // for help + parsing
 *     complete?: (ctx, partial) => string[],                 // tab-completion hook
 *     run: async (ctx) => number                             // returns exit code
 *   }
 *
 * `ctx` (built by the kernel per invocation) provides:
 *   ctx.argv     string[]  raw args after the command name
 *   ctx.args     string[]  positional args (flags removed)
 *   ctx.flags    object    parsed flags (see parseFlags)
 *   ctx.stdin    Readable-ish { read(): string }
 *   ctx.stdout   { write(str) }
 *   ctx.stderr   { write(str) }
 *   ctx.env      Environment
 *   ctx.session  session handle (cwd, etc.)
 *   ctx.vfs      VFS
 *   ctx.host     host bridge (browser control, titles…)
 *   ctx.registry this registry (for help/introspection)
 *   ctx.signal   AbortSignal for the running pipeline
 *
 * Register third-party command packs with `registry.install(pack)` where a pack
 * is an array of descriptors or a `{ commands: [...] }` object.
 */

class CommandRegistry {
  constructor() {
    /** @type {Map<string, object>} */
    this.commands = new Map();
    /** @type {Map<string, string>} */
    this.aliases = new Map();
  }

  register(descriptor) {
    if (!descriptor || !descriptor.name || typeof descriptor.run !== 'function') {
      throw new Error('registry.register: descriptor needs { name, run }');
    }
    this.commands.set(descriptor.name, descriptor);
    for (const a of descriptor.aka || []) this.aliases.set(a, descriptor.name);
    return this;
  }

  install(pack) {
    const list = Array.isArray(pack) ? pack : pack && pack.commands;
    if (!Array.isArray(list)) throw new Error('registry.install: expected array or { commands: [] }');
    for (const d of list) this.register(d);
    return this;
  }

  alias(name, target) {
    this.aliases.set(name, target);
    return this;
  }

  resolve(name) {
    if (this.commands.has(name)) return this.commands.get(name);
    if (this.aliases.has(name)) return this.commands.get(this.aliases.get(name));
    return null;
  }

  has(name) {
    return this.commands.has(name) || this.aliases.has(name);
  }

  list() {
    return [...this.commands.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Names + alias names, for completion. */
  names() {
    return [...this.commands.keys(), ...this.aliases.keys()].sort();
  }
}

/**
 * Minimal getopt-style flag parser.
 *  - `-abc`     -> boolean flags a, b, c
 *  - `-o value` -> only when the flag is declared as taking a value
 *  - `--long`   -> boolean; `--key=val` -> value
 *  - `--`       -> end of options; everything after is positional
 *
 * `spec.valued` lists short flags that consume the next token as a value.
 */
function parseFlags(argv, spec = {}) {
  const valued = new Set(spec.valued || []);
  const flags = {};
  const args = [];
  let i = 0;
  let noMore = false;

  while (i < argv.length) {
    const tok = argv[i];
    if (noMore || tok === '-' || tok[0] !== '-') {
      args.push(tok);
      i++;
      continue;
    }
    if (tok === '--') { noMore = true; i++; continue; }

    if (tok.startsWith('--')) {
      const body = tok.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) flags[body.slice(0, eq)] = body.slice(eq + 1);
      else flags[body] = true;
      i++;
      continue;
    }

    // short cluster
    const chars = tok.slice(1).split('');
    for (let c = 0; c < chars.length; c++) {
      const ch = chars[c];
      if (valued.has(ch)) {
        const rest = chars.slice(c + 1).join('');
        if (rest) { flags[ch] = rest; }
        else { flags[ch] = argv[++i]; }
        break;
      } else {
        flags[ch] = true;
      }
    }
    i++;
  }
  return { flags, args };
}

module.exports = { CommandRegistry, parseFlags };
