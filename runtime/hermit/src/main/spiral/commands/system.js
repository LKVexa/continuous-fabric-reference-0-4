'use strict';

/** SPIRAL built-ins — shell, environment and introspection commands. */

const { fail, padRight } = require('./util');

module.exports = [
  {
    name: 'help',
    summary: 'list available commands',
    usage: 'help [command]',
    async run(ctx) {
      if (ctx.args.length) {
        const d = ctx.registry.resolve(ctx.args[0]);
        if (!d) return fail(ctx, 'help', `no such command: ${ctx.args[0]}`);
        ctx.stdout.write(
          `\x1b[1m${d.name}\x1b[0m — ${d.summary}\n\n  \x1b[2musage:\x1b[0m ${d.usage || d.name}\n`);
        if (d.aka) ctx.stdout.write(`  \x1b[2malias:\x1b[0m ${d.aka.join(', ')}\n`);
        return 0;
      }
      const cmds = ctx.registry.list();
      ctx.stdout.write('\x1b[1mHERMIT / SPIRAL — command index\x1b[0m\n\n');
      for (const d of cmds) {
        ctx.stdout.write(`  \x1b[38;5;79m${padRight(d.name, 12)}\x1b[0m ${d.summary}\n`);
      }
      ctx.stdout.write(`\n  \x1b[2m${cmds.length} commands. \`help NAME\` for details, \`about\` for architecture.\x1b[0m\n`);
      return 0;
    }
  },

  {
    name: 'man',
    summary: 'display the manual for a command',
    usage: 'man command',
    async run(ctx) {
      if (!ctx.args.length) return fail(ctx, 'man', 'what manual page do you want?');
      const d = ctx.registry.resolve(ctx.args[0]);
      if (!d) return fail(ctx, 'man', `no manual entry for ${ctx.args[0]}`);
      const bars = '─'.repeat(Math.min(60, (ctx.cols || 80) - 4));
      ctx.stdout.write(
        `\x1b[1m${d.name.toUpperCase()}(1)\x1b[0m\n${bars}\n\n` +
        `\x1b[1mNAME\x1b[0m\n    ${d.name} — ${d.summary}\n\n` +
        `\x1b[1mSYNOPSIS\x1b[0m\n    ${d.usage || d.name}\n\n`);
      if (d.parse && d.parse.valued) {
        ctx.stdout.write(`\x1b[1mOPTIONS\x1b[0m\n    value-taking flags: ${d.parse.valued.map((f) => '-' + f).join(', ')}\n\n`);
      }
      if (d.aka) ctx.stdout.write(`\x1b[1mALIASES\x1b[0m\n    ${d.aka.join(', ')}\n\n`);
      return 0;
    }
  },

  {
    name: 'about',
    summary: 'show the HERMIT / SPIRAL architecture',
    usage: 'about',
    async run(ctx) {
      const v = (ctx.host.version && ctx.host.version()) || '1.0.0';
      const W = 60;
      const row = (k, val) => {
        const body = `  ${k.padEnd(9)} : ${val}`;
        return '  │' + body + ' '.repeat(Math.max(0, W - [...body].length)) + '│';
      };
      ctx.stdout.write([
        `\x1b[1mHERMIT\x1b[0m v${v}  \x1b[2m— virtual terminal\x1b[0m  \x1b[38;5;44mLK/Vexa\x1b[0m`,
        '',
        '  \x1b[38;5;44mArchitecture\x1b[0m',
        '  ┌' + '─'.repeat(W) + '┐',
        row('renderer', 'hand-written ANSI/VT engine (parser+screen)'),
        row('ipc', 'contextBridge, sandboxed, no node in renderer'),
        row('SPIRAL', 'session kernel · VFS · registry · pipeline'),
        row('browser', 'dockable pane · VB-JA21 v9.8.7 adapter seam'),
        row('fabric', 'DF0 · four nodes · replica / pipeline / bsp'),
        row('photon', 'VEC1 control plane · loopback JSON-RPC'),
        '  └' + '─'.repeat(W) + '┘',
        '',
        '  \x1b[38;5;79mSPIRAL backend\x1b[0m carries an in-memory POSIX-ish filesystem,',
        '  an extensible command registry, a shell parser with pipes,',
        '  redirection and && / || sequencing, and a readline-grade line',
        '  editor that speaks ANSI back to the VT engine — the same',
        '  contract a real PTY uses.',
        '',
        '  \x1b[38;5;79mDF fabric\x1b[0m is wired in: `df use <path>` binds your DF containers,',
        '  `fabric topology` renders the federation, and `fabric run <bundle>`',
        '  drives replica/pipeline/bsp across the four nodes (offline).',
        '',
        '  \x1b[38;5;79mVEC1 Photon\x1b[0m is the compute backend: `photon use <url> <token>`',
        '  binds your Electron-substitute shell, and complex requests (fabric',
        '  runs) delegate to it — electron lifecycle first, then the fabric proof.',
        '',
        '  \x1b[2mTry:\x1b[0m  ls -l  ·  echo hi | rev  ·  browser open example.com  ·  fabric status',
        ''
      ].join('\n') + '\n');
      return 0;
    }
  },

  {
    name: 'clear',
    summary: 'clear the terminal screen',
    usage: 'clear',
    aka: ['cls'],
    async run(ctx) { ctx.stdout.write('\x1b[2J\x1b[3J\x1b[H'); return 0; }
  },

  {
    name: 'history',
    summary: 'show the command history',
    usage: 'history [-c]',
    async run(ctx) {
      if (ctx.flags.c) { ctx.session.history.length = 0; return 0; }
      const h = ctx.session.history;
      const w = String(h.length).length;
      ctx.stdout.write(h.map((line, i) =>
        `\x1b[2m${String(i + 1).padStart(w)}\x1b[0m  ${line}`).join('\n') + (h.length ? '\n' : ''));
      return 0;
    }
  },

  {
    name: 'env',
    summary: 'print the environment',
    usage: 'env',
    aka: ['printenv'],
    async run(ctx) {
      const o = ctx.env.toObject();
      for (const k of Object.keys(o).sort()) {
        if (k === '?') continue;
        ctx.stdout.write(`${k}=${o[k]}\n`);
      }
      return 0;
    }
  },

  {
    name: 'export',
    summary: 'set an environment variable',
    usage: 'export NAME[=value] ...',
    aka: ['set'],
    async run(ctx) {
      for (const a of ctx.args) {
        const eq = a.indexOf('=');
        if (eq >= 0) ctx.env.set(a.slice(0, eq), a.slice(eq + 1));
        else if (!ctx.env.has(a)) ctx.env.set(a, '');
      }
      return 0;
    }
  },

  {
    name: 'unset',
    summary: 'remove an environment variable',
    usage: 'unset NAME ...',
    async run(ctx) { for (const a of ctx.args) ctx.env.unset(a); return 0; }
  },

  {
    name: 'alias',
    summary: 'define or list command aliases',
    usage: 'alias [name=value ...]',
    async run(ctx) {
      if (!ctx.args.length) {
        for (const [k, v] of Object.entries(ctx.aliases)) ctx.stdout.write(`alias ${k}='${v}'\n`);
        return 0;
      }
      for (const a of ctx.args) {
        const eq = a.indexOf('=');
        if (eq < 0) { const v = ctx.aliases[a]; ctx.stdout.write(v ? `alias ${a}='${v}'\n` : ''); continue; }
        ctx.aliases[a.slice(0, eq)] = a.slice(eq + 1).replace(/^['"]|['"]$/g, '');
      }
      return 0;
    }
  },

  {
    name: 'unalias',
    summary: 'remove an alias',
    usage: 'unalias name ...',
    async run(ctx) { for (const a of ctx.args) delete ctx.aliases[a]; return 0; }
  },

  {
    name: 'which',
    summary: 'locate a command',
    usage: 'which name ...',
    aka: ['type'],
    async run(ctx) {
      let rc = 0;
      for (const a of ctx.args) {
        if (ctx.aliases[a]) ctx.stdout.write(`${a}: aliased to ${ctx.aliases[a]}\n`);
        else if (ctx.registry.has(a)) ctx.stdout.write(`${a}: spiral built-in\n`);
        else { ctx.stdout.write(`${a}: not found\n`); rc = 1; }
      }
      return rc;
    }
  },

  {
    name: 'whoami',
    summary: 'print the current user',
    usage: 'whoami',
    async run(ctx) { ctx.stdout.write((ctx.env.get('USER') || 'operator') + '\n'); return 0; }
  },

  {
    name: 'uname',
    summary: 'print system information',
    usage: 'uname [-a]',
    async run(ctx) {
      const v = (ctx.host.version && ctx.host.version()) || '1.0.0';
      if (ctx.flags.a) ctx.stdout.write(`HERMIT hermit ${v} SPIRAL x86_64 internal-VT\n`);
      else ctx.stdout.write('HERMIT\n');
      return 0;
    }
  },

  {
    name: 'date',
    summary: 'print the current date and time',
    usage: 'date',
    async run(ctx) { ctx.stdout.write(new Date().toString() + '\n'); return 0; }
  },

  {
    name: 'sysinfo',
    summary: 'terminal runtime status',
    usage: 'sysinfo',
    async run(ctx) {
      const b = ctx.host.browserState ? ctx.host.browserState() : { visible: false };
      ctx.stdout.write([
        `\x1b[1mSPIRAL runtime\x1b[0m`,
        `  session   : ${ctx.session.id}`,
        `  geometry  : ${ctx.cols}x${ctx.rows}`,
        `  cwd       : ${ctx.session.cwd}`,
        `  commands  : ${ctx.registry.list().length}`,
        `  browser   : ${b.visible ? 'visible' : 'hidden'} (${b.engine || 'n/a'})`,
        ''
      ].join('\n') + '\n');
      return 0;
    }
  },

  {
    name: 'exit',
    summary: 'close the session',
    usage: 'exit [code]',
    aka: ['logout', 'quit'],
    async run(ctx) {
      const code = parseInt(ctx.args[0], 10);
      ctx.stdout.write('logout\n');
      ctx.exit(Number.isInteger(code) ? code : 0);
      return Number.isInteger(code) ? code : 0;
    }
  }
];
