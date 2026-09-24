'use strict';

/** Shared helpers for built-in commands. */

/**
 * Collect input for a filter command: if positional file args are present,
 * concatenate their VFS contents; otherwise drain stdin. Returns a string.
 */
async function gatherInput(ctx) {
  if (ctx.args.length) {
    let out = '';
    for (const a of ctx.args) {
      const p = ctx.resolve(a);
      out += ctx.vfs.readFile(p);
    }
    return out;
  }
  if (ctx.stdin && typeof ctx.stdin.readAll === 'function') {
    // static input
    if (!ctx.stdin.isTTY) return ctx.stdin.readAll();
    // interactive: read until EOF (Ctrl-D)
    let out = '';
    for (;;) {
      const line = await ctx.stdin.readLine('');
      if (line === null) break;
      out += line + '\n';
    }
    return out;
  }
  return '';
}

/** Split text into lines, preserving semantics of a trailing newline. */
function toLines(text) {
  if (text === '') return [];
  const hadTrailing = text.endsWith('\n');
  const lines = text.split('\n');
  if (hadTrailing) lines.pop();
  return lines;
}

function fail(ctx, cmd, msg, code = 1) {
  ctx.stderr.write(`\x1b[31m${cmd}: ${msg}\x1b[0m\n`);
  return code;
}

/** Pad/truncate helpers for columnar output. */
function padRight(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }
function padLeft(s, n) { s = String(s); return s.length >= n ? s : ' '.repeat(n - s.length) + s; }

/** Human-readable byte size. */
function humanSize(bytes) {
  const units = ['B', 'K', 'M', 'G', 'T'];
  let n = bytes, u = 0;
  while (n >= 1024 && u < units.length - 1) { n /= 1024; u++; }
  return (u === 0 ? n : n.toFixed(1)) + units[u];
}

module.exports = { gatherInput, toLines, fail, padRight, padLeft, humanSize };
