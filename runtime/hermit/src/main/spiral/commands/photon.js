'use strict';

/**
 * SPIRAL built-in — `photon`
 * ---------------------------------------------------------------------------
 * Binds and drives a VEC1 Photon (the Electron-substitute control plane) that
 * HERMIT delegates its complex requests to. This is the "Photon in place of
 * Electron" seam: heavy processing leaves the terminal and runs on the Photon.
 */

const { PhotonClient, fromEnv } = require('../photon/client');
const { runComplexFabric } = require('../photon/workflow');
const { fail, padRight } = require('./util');

function client(ctx) { return fromEnv(ctx.env); }

function needPhoton(ctx) {
  const c = client(ctx);
  if (!c) {
    ctx.stderr.write(
      '\x1b[31mphoton: no Photon bound.\x1b[0m Point HERMIT at your running VEC1 shell:\n' +
      '  \x1b[38;5;75mphoton use http://127.0.0.1:<port> <X-VEC1-Token>\x1b[0m\n' +
      '  \x1b[2m(the token is printed by the VEC1 launcher / injected into its page as <meta name="vec1-token">)\x1b[0m\n');
  }
  return c;
}

module.exports = [{
  name: 'photon',
  summary: 'delegate complex requests to a VEC1 Photon',
  usage: 'photon <use|where|status|health|electrons|events|topology|diagnostic|run|shutdown> [...]',
  aka: ['ph'],
  async run(ctx) {
    const sub = ctx.argv[0] || 'status';

    if (sub === 'use') {
      const url = ctx.argv[1];
      if (!url) return fail(ctx, 'photon', 'usage: photon use <url> [token]');
      ctx.env.set('VEC1_API', url);
      if (ctx.argv[2]) ctx.env.set('VEC1_TOKEN', ctx.argv[2]);
      ctx.stdout.write(`\x1b[38;5;79m✓\x1b[0m Photon bound: ${url}${ctx.argv[2] ? ' (token set)' : ' \x1b[33m(no token — mutations will 403)\x1b[0m'}\n`);
      return 0;
    }

    if (sub === 'where') {
      const url = ctx.env.get('VEC1_API');
      ctx.stdout.write(`Photon API : ${url || '\x1b[31m(not bound)\x1b[0m'}\n` +
        `token      : ${ctx.env.get('VEC1_TOKEN') ? 'set' : '\x1b[33mnone\x1b[0m'}\n`);
      if (!url) return 1;
      const c = client(ctx);
      const up = await c.reachable(ctx.signal);
      ctx.stdout.write(`reachable  : ${up ? '\x1b[38;5;114myes\x1b[0m' : '\x1b[31mno\x1b[0m'}\n`);
      return up ? 0 : 1;
    }

    const c = needPhoton(ctx);
    if (!c) return 1;

    try {
      switch (sub) {
        case 'status': {
          const s = await c.status(ctx.signal);
          const h = await c.health(ctx.signal).catch(() => null);
          ctx.stdout.write('\x1b[1mVEC1 Photon\x1b[0m' + (h ? ` \x1b[2mv${h.version}\x1b[0m` : '') + '\n');
          ctx.stdout.write(pretty(s) + '\n');
          return 0;
        }
        case 'health': ctx.stdout.write(pretty(await c.health(ctx.signal)) + '\n'); return 0;
        case 'topology': ctx.stdout.write(pretty(await c.topology(ctx.signal)) + '\n'); return 0;
        case 'diagnostic': {
          ctx.stdout.write('\x1b[2mPOST /api/fabric/diagnostic …\x1b[0m\n');
          const d = await c.fabricDiagnostic(ctx.signal);
          ctx.stdout.write(pretty(d) + '\n');
          return 0;
        }
        case 'electrons': {
          const list = (await c.electrons(ctx.signal)).electrons || [];
          if (!list.length) { ctx.stdout.write('\x1b[2mno electrons\x1b[0m\n'); return 0; }
          ctx.stdout.write('\x1b[1m' + padRight('ID', 20) + padRight('NAME', 18) + 'STATE\x1b[0m\n');
          for (const e of list) ctx.stdout.write(padRight(e.id || e.electron_id || '?', 20) + padRight(e.name || '', 18) + (e.state || e.lifecycle || '') + '\n');
          return 0;
        }
        case 'events': {
          const n = parseInt(ctx.argv[1], 10) || 20;
          const ev = (await c.events(n, ctx.signal)).events || [];
          for (const e of ev) ctx.stdout.write(`\x1b[2m${e.ts || e.time || ''}\x1b[0m ${e.kind || e.event || ''} ${e.detail ? '\x1b[2m' + JSON.stringify(e.detail) + '\x1b[0m' : ''}\n`);
          return 0;
        }
        case 'run': {
          const name = ctx.argv[1] || 'hermit';
          const res = await runComplexFabric(c, { name }, { stdout: ctx.stdout, stderr: ctx.stderr }, ctx.signal);
          return res.verdict && String(res.verdict).includes('AGREEMENT') ? 0 : 1;
        }
        case 'shutdown': {
          await c.shutdown(ctx.signal);
          ctx.stdout.write('Photon shutdown requested\n');
          return 0;
        }
        default:
          return fail(ctx, 'photon', `unknown subcommand: ${sub}`);
      }
    } catch (e) {
      if (e.code === 'PHOTON_OFFLINE') return fail(ctx, 'photon', e.message + ' — is the VEC1 shell running?');
      if (e.code === 'PHOTON_AUTH') return fail(ctx, 'photon', 'rejected (403): set the token with `photon use <url> <token>`');
      return fail(ctx, 'photon', e.message);
    }
  },
  complete(ctx, partial) {
    return ['use', 'where', 'status', 'health', 'electrons', 'events', 'topology', 'diagnostic', 'run', 'shutdown']
      .filter((s) => s.startsWith(partial));
  }
}];

function pretty(x) { return JSON.stringify(x, null, 2); }
