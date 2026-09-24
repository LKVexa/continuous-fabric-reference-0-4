'use strict';

/**
 * SPIRAL built-ins — browser control.
 * These route through the host bridge to the BrowserPane, which in turn hosts
 * the VB-JA21 v9.8.7 engine when it is vendored in.
 */

const { fail } = require('./util');

module.exports = [
  {
    name: 'browser',
    summary: 'control the embedded browser pane',
    usage: 'browser <open|go|close|info> [url]',
    aka: ['br'],
    async run(ctx) {
      const sub = ctx.args[0];
      const arg = ctx.args.slice(1).join(' ');
      const host = ctx.host;

      switch (sub) {
        case 'open': {
          if (!host.openBrowser) return fail(ctx, 'browser', 'host bridge unavailable');
          const st = host.openBrowser(arg || 'about:blank');
          ctx.stdout.write(`\x1b[38;5;79m▸\x1b[0m browser open  \x1b[2m${(st && st.url) || arg}\x1b[0m  [${(st && st.engine) || '?'}]\n`);
          return 0;
        }
        case 'go':
        case 'nav': {
          if (!arg) return fail(ctx, 'browser', 'usage: browser go <url>');
          const st = host.navigateBrowser ? host.navigateBrowser(arg) : null;
          if (st && !st.visible && host.openBrowser) host.openBrowser(arg);
          ctx.stdout.write(`\x1b[38;5;79m▸\x1b[0m navigate  \x1b[2m${(st && st.url) || arg}\x1b[0m\n`);
          return 0;
        }
        case 'close':
        case 'hide': {
          if (host.closeBrowser) host.closeBrowser();
          ctx.stdout.write('browser pane hidden\n');
          return 0;
        }
        case 'info':
        case undefined: {
          const st = host.browserState ? host.browserState() : { visible: false };
          ctx.stdout.write([
            '\x1b[1mBrowser pane\x1b[0m',
            `  engine  : ${st.engine || 'n/a'}`,
            `  visible : ${st.visible}`,
            `  url     : ${st.url || '—'}`,
            ''
          ].join('\n') + '\n');
          return 0;
        }
        default:
          return fail(ctx, 'browser', `unknown subcommand: ${sub}`);
      }
    },
    complete(ctx, partial) {
      return ['open', 'go', 'close', 'info'].filter((s) => s.startsWith(partial));
    }
  },

  {
    name: 'open',
    summary: 'open a URL in the browser pane',
    usage: 'open <url>',
    async run(ctx) {
      const url = ctx.args.join(' ') || 'about:blank';
      if (!ctx.host.openBrowser) return fail(ctx, 'open', 'host bridge unavailable');
      const st = ctx.host.openBrowser(url);
      ctx.stdout.write(`\x1b[38;5;79m▸\x1b[0m ${(st && st.url) || url}\n`);
      return 0;
    }
  }
];
