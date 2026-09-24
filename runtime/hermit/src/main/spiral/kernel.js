'use strict';

/**
 * SPIRAL — Kernel
 * ---------------------------------------------------------------------------
 * The session supervisor and shell interpreter. Each session is an independent
 * REPL: it prompts, reads a line through the interactive line reader, parses it
 * into a pipeline plan, executes the plan against the command registry and the
 * virtual filesystem, and streams the result back as ANSI/VT bytes.
 *
 * Emits:
 *   'data'  { sessionId, chunk }          output bytes destined for the renderer
 *   'exit'  { sessionId, code, reason }   a session ended (exactly once per session)
 *
 * VWS candidate repairs (series findings F04/F05/F09/F10/F17, packs I028-I030, I033):
 *   - geometry is validated before it is stored or reaches a command context
 *   - closeSession settles the active line reader, aborts the running pipeline
 *     and emits exactly one 'exit'
 *   - openSession({deferStart:true}) + startSession() form an explicit open
 *     barrier so no output can precede the consumer's registration
 *   - pipeline captures, input lines and history are bounded
 */

const { EventEmitter } = require('node:events');

const { VFS, resolvePath, basename, dirname } = require('./vfs');
const { CommandRegistry } = require('./registry');
const { Environment } = require('./env');
const { parse } = require('./pipeline');
const { LineReader } = require('./line-reader');
const { DFLocator } = require('./dfabric/locator');
const builtins = require('./commands');

let SESSION_SEQ = 0;

const GEOMETRY = Object.freeze({ minCols: 2, maxCols: 400, minRows: 1, maxRows: 200 });
const DEFAULT_LIMITS = Object.freeze({
  captureBytes: 8 * 1024 * 1024, // per pipeline stage capture (string length, UTF-16 units as a proxy)
  lineChars: 4096,               // interactive input line
  historyEntries: 1000,
  seqItems: 1000000,             // `seq` element count
  regexChars: 256,               // user-supplied RegExp source length
  regexLineChars: 16384          // longest line a user RegExp is applied to
});

function validGeometry(cols, rows) {
  return Number.isInteger(cols) && Number.isInteger(rows) &&
    cols >= GEOMETRY.minCols && cols <= GEOMETRY.maxCols && rows >= GEOMETRY.minRows && rows <= GEOMETRY.maxRows;
}

class CaptureLimitError extends Error {
  constructor(limit) { super(`pipeline capture limit exceeded (${limit} chars)`); this.code = 'ECAPTURE'; }
}

// LK/Vexa house prompt: cyan identity, ice path, cyan chevron.
// palette idx 44 = cyan core, 252 = ice, 245 = graphite text.
const DEFAULT_PS1 = '\x1b[38;5;44m\\u\x1b[38;5;245m@\\h\x1b[0m \x1b[38;5;252m\\w\x1b[0m \x1b[38;5;44m›\x1b[0m ';

/* --------------------------------------------------------------------------
 * stdin adapters
 * ------------------------------------------------------------------------ */

class StaticInput {
  constructor(text) {
    this.isTTY = false;
    this._text = String(text || '');
    this._lines = this._text.length ? this._text.split('\n') : [];
    // A trailing newline yields an empty final element; drop it.
    if (this._lines.length && this._lines[this._lines.length - 1] === '') this._lines.pop();
    this._i = 0;
    this._consumed = false;
  }
  readAll() { this._consumed = true; return this._text; }
  read() { if (this._consumed) return ''; this._consumed = true; return this._text; }
  async readLine() { return this._i < this._lines.length ? this._lines[this._i++] : null; }
}

class InteractiveInput {
  constructor(session) { this.isTTY = true; this.session = session; }
  read() { return ''; }
  readAll() { return ''; }
  async readLine(prompt = '') {
    const v = await this.session.readLine(prompt, { history: false });
    if (v === null) return null;
    if (v && typeof v === 'object' && v.aborted) return null;
    return v;
  }
}

/* --------------------------------------------------------------------------
 * kernel
 * ------------------------------------------------------------------------ */

class SpiralKernel extends EventEmitter {
  /**
   * @param {object} [o]
   * @param {object} [o.hostBridge]      capability callbacks (browser pane, version, fabricPolicy…)
   * @param {object} [o.limits]          overrides for DEFAULT_LIMITS
   * @param {object} [o.vfsLimits]       { maxBytes, maxNodes } — unlimited when omitted (LOCAL)
   * @param {(d:object)=>boolean} [o.commandFilter]  descriptors returning false are not installed
   * @param {object} [o.baseEnv]         extra/override base environment (already allowlisted by the caller)
   */
  constructor({ hostBridge = {}, limits = {}, vfsLimits = {}, commandFilter = null, baseEnv = {} } = {}) {
    super();
    this.host = hostBridge;
    this.limits = Object.assign({}, DEFAULT_LIMITS, limits);
    this.vfs = new VFS(vfsLimits);
    this.registry = new CommandRegistry();
    this.registry.install(commandFilter ? builtins.filter((d) => commandFilter(d)) : builtins);
    this.sessions = new Map();
    this.baseEnv = new Environment({
      SHELL: 'spiral',
      TERM: 'hermit-256color',
      HOME: '/home/operator',
      USER: 'operator',
      HOST: 'hermit',
      PS1: DEFAULT_PS1,
      PATH: '/bin:/usr/bin',
      '?': '0',
      ...baseEnv
    });
  }

  /* ---- session lifecycle ---------------------------------------------- */

  openSession(opts = {}) {
    const cols = opts.cols === undefined ? 80 : opts.cols;
    const rows = opts.rows === undefined ? 24 : opts.rows;
    if (!validGeometry(cols, rows)) throw new RangeError(`invalid geometry ${String(cols).slice(0, 12)}x${String(rows).slice(0, 12)}`);
    const id = `s${++SESSION_SEQ}`;
    const env = this.baseEnv.child();
    const session = {
      id,
      env,
      cwd: env.get('HOME'),
      cols,
      rows,
      history: [],
      aliases: Object.create(null), // user-chosen names: `constructor`, `__proto__`, `toString` must be ordinary keys
      alive: true,
      started: false,  // REPL launched (open barrier released)
      exited: false,   // 'exit' already emitted
      pending: null,   // active LineReader, if any
      running: null,   // AbortController while a command runs
      readLine: null   // bound below
    };
    session.readLine = (prompt, o) => this._readLine(session, prompt, o);
    this.sessions.set(id, session);
    // Open barrier: with deferStart the REPL (banner, prompt) is not launched until the
    // consumer has registered the session and calls startSession().
    if (!opts.deferStart) queueMicrotask(() => this.startSession(id));
    return { sessionId: id, cols: session.cols, rows: session.rows };
  }

  startSession(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s || s.started || !s.alive) return false;
    s.started = true;
    this._repl(s);
    return true;
  }

  /** The single exit path. Idempotent: socket close, worker stop and REPL end may all race here. */
  _finishSession(session, code, reason) {
    if (session.exited) return false;
    session.exited = true;
    session.alive = false;
    this.sessions.delete(session.id);
    const reader = session.pending;
    session.pending = null;
    if (reader) reader._finish(null);                       // settle an active prompt (F04)
    if (session.running) { try { session.running.abort('SESSION_CLOSED'); } catch { /* noop */ } }
    this.emit('exit', { sessionId: session.id, code: code | 0, reason: reason || 'closed' });
    return true;
  }

  closeSession(sessionId, reason = 'closed') {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    return this._finishSession(s, 0, reason);
  }

  resize(sessionId, cols, rows) {
    const s = this.sessions.get(sessionId);
    if (!s || !s.alive) return false;
    if (!validGeometry(cols, rows)) return false;          // F05: never store unvalidated geometry
    s.cols = cols; s.rows = rows;
    return true;
  }

  /* ---- io routing ------------------------------------------------------ */

  write(sessionId, data) {
    const s = this.sessions.get(sessionId);
    if (!s || !s.alive || typeof data !== 'string') return;
    if (s.pending) {
      const rest = s.pending.feed(data);
      if (rest) this._typeahead(s, rest);
      return;
    }
    if (s.running && data.indexOf('\x03') !== -1) { s.typeahead = ''; s.running.abort('SIGINT'); return; }
    this._typeahead(s, data);
  }

  /** Bounded type-ahead: input that arrives between prompts is kept for the next reader, never silently reordered. */
  _typeahead(session, data) {
    const room = this.limits.lineChars * 2 - (session.typeahead || '').length;
    if (room <= 0) { this._emit(session, '\x07'); return; }
    session.typeahead = (session.typeahead || '') + data.slice(0, room);
    if (data.length > room) this._emit(session, '\x07');
  }

  signal(sessionId, signal) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    if (signal !== 'SIGINT' && signal !== 'INT') return;
    s.typeahead = '';
    if (s.running) s.running.abort('SIGINT');
    else if (s.pending) s.pending.feed('\x03');
  }

  _emit(session, chunk) {
    if (session.alive) this.emit('data', { sessionId: session.id, chunk });
  }

  /* ---- REPL ------------------------------------------------------------ */

  async _repl(session) {
    this._emit(session, this._banner(session));
    while (session.alive) {
      const prompt = this._buildPrompt(session);
      let line;
      try {
        line = await session.readLine(prompt, { history: true });
      } catch {
        break;
      }
      if (line === null) { this._emit(session, 'logout\r\n'); break; } // Ctrl-D
      if (line && typeof line === 'object' && line.aborted) continue;   // Ctrl-C
      const text = line;
      if (!text.trim()) continue;
      if (session.history[session.history.length - 1] !== text) {
        session.history.push(text);
        if (session.history.length > this.limits.historyEntries) session.history.splice(0, session.history.length - this.limits.historyEntries);
      }
      try {
        await this._executeLine(session, text);
      } catch (err) {
        this._emit(session, `\x1b[31mspiral: ${err.message}\x1b[0m\r\n`);
      }
      // RAMWS ACK_EXECUTED: a command line COMPLETED under this session (exit status in $?). Emitted after its output.
      this.emit('command-complete', { sessionId: session.id, code: Number(session.env.get('?')) | 0 });
    }
    this._finishSession(session, session._exitCode || 0, 'logout');
  }

  _readLine(session, prompt, opts = {}) {
    const reader = new LineReader({
      write: (s) => this._emit(session, s),
      prompt: prompt || '',
      history: opts.history ? session.history : [],
      maxChars: this.limits.lineChars,
      completer: (buf, cur) => this._complete(session, buf, cur)
    });
    if (!session.alive) return Promise.resolve(null);
    session.pending = reader;
    if (session.typeahead) {
      queueMicrotask(() => {
        if (session.pending !== reader || !session.typeahead) return;
        const data = session.typeahead; session.typeahead = '';
        const rest = reader.feed(data);
        if (rest) this._typeahead(session, rest);
      });
    }
    return reader.start().then((v) => {
      if (session.pending === reader) session.pending = null;
      return v;
    });
  }

  /* ---- prompt ---------------------------------------------------------- */

  _buildPrompt(session) {
    const raw = session.env.get('PS1') || DEFAULT_PS1;
    return this._expandPrompt(session, raw);
  }

  _expandPrompt(session, ps1) {
    const home = session.env.get('HOME');
    let cwd = session.cwd;
    if (home && (cwd === home || cwd.startsWith(home + '/'))) cwd = '~' + cwd.slice(home.length);
    return ps1
      .replace(/\\e/g, '\x1b')
      .replace(/\\u/g, session.env.get('USER') || 'operator')
      .replace(/\\h/g, session.env.get('HOST') || 'hermit')
      .replace(/\\w/g, cwd)
      .replace(/\\W/g, basename(cwd) || '/')
      .replace(/\\n/g, '\r\n')
      .replace(/\\\$/g, session.env.get('USER') === 'root' ? '#' : '$');
  }

  _banner(session) {
    const v = (this.host.version && this.host.version()) || '1.0.0';
    const C = '\x1b[38;5;44m', G = '\x1b[38;5;240m', I = '\x1b[38;5;252m', D = '\x1b[2m', R = '\x1b[0m', B = '\x1b[1m';
    // Hub-and-spoke mark in text (graphite nodes, cyan core), mirroring the LK/Vexa logo.
    return [
      '',
      `  ${C}⌜${R}                                                        ${C}⌝${R}`,
      `        ${G}▪${R}      ${G}▪${R}      ${G}▪${R}        ${B}${I}HERMIT${R}  ${G}/${R}  ${C}${B}LK/Vexa${R}`,
      `          ${G}╲  ┆  ╱${R}              ${D}virtual terminal · v${v}${R}`,
      `        ${G}▪ ┄┄ ${R}${C}◆${R}${G} ┄┄ ▪${R}            ${D}SPIRAL backend · VT engine: internal${R}`,
      `          ${G}╱  ┆  ╲${R}              ${D}DF fabric · VEC1 Photon delegation${R}`,
      `        ${G}▪${R}      ${G}▪${R}      ${G}▪${R}`,
      `  ${C}⌞${R}                                                        ${C}⌟${R}`,
      '',
      `  ${D}Type${R} ${C}help${R} ${D}for commands ·${R} ${C}about${R} ${D}for architecture ·${R} ${C}fabric status${R} ${D}for the nodes${R}`,
      '', ''
    ].join('\r\n');
  }

  /* ---- status (for the renderer status bar / hub widget) --------------- */

  status(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) return null;
    const pol = this.host.fabricPolicy || null;
    const loc = pol ? new DFLocator({ fixedRoot: pol.root })
      : new DFLocator({ envRoot: () => s.env.get('DF_ROOT'), resourcesPath: process.resourcesPath });
    let nodes = [];
    let dfRoot = null;
    try {
      dfRoot = loc.root();
      nodes = loc.roster().map((n) => ({ key: n.key, node: n.node, present: n.present, built: n.built }));
    } catch { /* ignore */ }
    const home = s.env.get('HOME');
    let cwd = s.cwd;
    if (home && (cwd === home || cwd.startsWith(home + '/'))) cwd = '~' + cwd.slice(home.length);
    return {
      sessionId: s.id,
      cwd,
      cols: s.cols,
      rows: s.rows,
      busy: !!s.running,
      user: s.env.get('USER'),
      host: s.env.get('HOST'),
      dfRoot: pol && dfRoot ? '$DF_ROOT' : dfRoot,
      photon: pol ? { url: null, token: false } : { url: s.env.get('VEC1_API') || null, token: !!s.env.get('VEC1_TOKEN') },
      nodes,
      commands: this.registry.list().length
    };
  }

  /* ---- execution ------------------------------------------------------- */

  async _executeLine(session, line) {
    const segments = parse(line, session.env);
    let lastCode = 0;
    for (const seg of segments) {
      if (seg.op === '&&' && lastCode !== 0) continue;
      if (seg.op === '||' && lastCode === 0) continue;
      // Cooperative backpressure at pipeline boundaries: do not start producing more output while the
      // bounded output stage is congested (slow consumer). No effect in the LOCAL profile (no host.flow).
      if (this.host.flow) { await new Promise((res) => setImmediate(res)); if (this.host.flow.paused()) await new Promise((res) => this.host.flow.onDrain(res)); }
      if (!session.alive) break;
      lastCode = await this._runPipeline(session, seg.pipeline);
    }
    session.env.set('?', String(lastCode));
    return lastCode;
  }

  async _runPipeline(session, pipeline) {
    if (!pipeline.length) return 0;
    const controller = new AbortController();
    session.running = controller;
    let pipeInput = '';
    let code = 0;

    try {
      for (let k = 0; k < pipeline.length; k++) {
        const cmd = pipeline[k];
        const isLast = k === pipeline.length - 1;
        let argv = cmd.argv.slice();
        let name = argv.shift();
        if (name == null) continue;

        // alias expansion (guarded against recursion)
        const seen = new Set();
        while (name != null && session.aliases[name] && !seen.has(name)) {
          seen.add(name);
          const exp = session.aliases[name].split(/\s+/).filter(Boolean);
          name = exp.shift();
          argv = exp.concat(argv);
        }

        const descriptor = this.registry.resolve(name);
        if (!descriptor) {
          this._emit(session, `\x1b[31mspiral: ${name}: command not found\x1b[0m\r\n`);
          code = 127;
          break;
        }

        // redirects
        const outRe = cmd.redirects.find((r) => r.type === 'out' || r.type === 'append');
        const inRe = cmd.redirects.find((r) => r.type === 'in');

        // stdin
        let stdin;
        if (inRe) {
          const p = resolvePath(session.cwd, inRe.target);
          stdin = new StaticInput(this.vfs.readFile(p));
        } else if (k > 0) {
          stdin = new StaticInput(pipeInput);
        } else if (pipeline.length === 1) {
          stdin = new InteractiveInput(session);
        } else {
          stdin = new StaticInput('');
        }

        // stdout
        let capture = '';
        const limit = this.limits.captureBytes;
        const toCapture = { write: (s) => {
          s = String(s);
          if (capture.length + s.length > limit) { controller.abort('CAPTURE_LIMIT'); throw new CaptureLimitError(limit); }
          capture += s;
        } };
        const toTerminal = { write: (s) => this._emit(session, String(s).replace(/\r?\n/g, '\r\n')) };
        const stdout = outRe ? toCapture : (isLast ? toTerminal : toCapture);
        const stderr = { write: (s) => this._emit(session, String(s).replace(/\r?\n/g, '\r\n')) };

        const ctx = this._makeContext(session, descriptor, argv, { stdin, stdout, stderr, signal: controller.signal });

        try {
          const rc = await descriptor.run(ctx);
          code = Number.isInteger(rc) ? rc : 0;
        } catch (err) {
          if (err && err.code === 'ECAPTURE') { stderr.write(`\x1b[31m${name}: ${err.message}\x1b[0m\n`); code = 1; break; }
          if (controller.signal.aborted) { this._emit(session, '\r\n'); code = 130; break; }
          stderr.write(`\x1b[31m${name}: ${err.message}\x1b[0m\n`);
          code = 1;
        }

        if (controller.signal.aborted) { code = controller.signal.reason === 'CAPTURE_LIMIT' ? 1 : 130; break; }

        if (outRe) {
          const p = resolvePath(session.cwd, outRe.target);
          this.vfs.writeFile(p, capture, { append: outRe.type === 'append' });
        } else if (!isLast) {
          pipeInput = capture;
        }
      }
    } finally {
      session.running = null;
      // A producer that overflowed the bounded output stage has now stopped: output may flow again
      // (the prompt that follows must not be swallowed by the gap).
      if (this.host.flow && typeof this.host.flow.clearOverflow === 'function') this.host.flow.clearOverflow();
    }
    return code;
  }

  _makeContext(session, descriptor, argv, io) {
    const { parseFlags } = require('./registry');
    const spec = descriptor.parse || {};
    const { flags, args } = parseFlags(argv, spec);
    return {
      argv,
      args,
      flags,
      stdin: io.stdin,
      stdout: io.stdout,
      stderr: io.stderr,
      signal: io.signal,
      env: session.env,
      session,
      vfs: this.vfs,
      host: this.host,
      registry: this.registry,
      limits: this.limits,
      cwd: session.cwd,
      // convenience: resolve a path arg against the session cwd
      resolve: (p) => resolvePath(session.cwd, p),
      // convenience: change the session cwd (used by `cd`)
      chdir: (abs) => { session.cwd = abs; },
      aliases: session.aliases,
      // RAMWS: a streaming producer calls this between batches; it resolves at once unless the bounded output
      // stage is congested (slow consumer / no credit), in which case the producer waits instead of allocating.
      // Always a MACROtask so the worker's event loop can receive control records (pause/consumed) between batches.
      yield: () => new Promise((res) => setImmediate(() => { if (this.host.flow && this.host.flow.paused()) this.host.flow.onDrain(res); else res(); })),
      exit: (code) => { session.alive = false; session._exitCode = code || 0; },
      cols: session.cols,
      rows: session.rows
    };
  }

  /* ---- completion ------------------------------------------------------ */

  _complete(session, buf, cur) {
    const head = buf.slice(0, cur);
    const tokens = head.split(/\s+/);
    const token = tokens[tokens.length - 1];
    const isCommandPos = tokens.length === 1;

    let candidates;
    let replaceToken;

    if (isCommandPos) {
      candidates = this.registry.names().filter((n) => n.startsWith(token));
    } else {
      // Let a command supply its own argument completion (e.g. subcommands).
      let name = tokens[0];
      if (session.aliases[name]) name = session.aliases[name].split(/\s+/)[0];
      const d = this.registry.resolve(name);
      if (d && typeof d.complete === 'function' && tokens.length === 2) {
        try {
          const c = d.complete({ session, env: session.env }, token) || [];
          candidates = c.filter((x) => x.startsWith(token));
        } catch { candidates = []; }
      }
      if (!candidates || !candidates.length) candidates = this._pathCandidates(session, token);
    }
    if (!candidates.length) return null;

    if (candidates.length === 1) {
      replaceToken = candidates[0];
      const suffix = replaceToken.endsWith('/') ? '' : ' ';
      const newHead = head.slice(0, head.length - token.length) + replaceToken + suffix;
      return { replace: newHead + buf.slice(cur), cursor: newHead.length, candidates };
    }

    const common = commonPrefix(candidates);
    if (common.length > token.length) {
      const newHead = head.slice(0, head.length - token.length) + common;
      return { replace: newHead + buf.slice(cur), cursor: newHead.length, candidates };
    }
    return { candidates };
  }

  _pathCandidates(session, token) {
    let dirPart = token.includes('/') ? token.slice(0, token.lastIndexOf('/') + 1) : '';
    const basePart = token.slice(dirPart.length);
    const absDir = resolvePath(session.cwd, dirPart || '.');
    let entries;
    try { entries = this.vfs.readdir(absDir); } catch { return []; }
    return entries
      .filter((e) => e.name.startsWith(basePart))
      .map((e) => dirPart + e.name + (e.type === 'dir' ? '/' : ''));
  }
}

function commonPrefix(list) {
  if (!list.length) return '';
  let p = list[0];
  for (const s of list) {
    while (!s.startsWith(p)) p = p.slice(0, -1);
    if (!p) break;
  }
  return p;
}

module.exports = { SpiralKernel, validGeometry, GEOMETRY, DEFAULT_LIMITS };
