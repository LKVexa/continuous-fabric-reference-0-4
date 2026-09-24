'use strict';

/**
 * SPIRAL — DF CLI runner
 * ---------------------------------------------------------------------------
 * Spawns a DF container's Python CLI (`adapter/dfabric/cli.py`) and streams its
 * output into a terminal writer. This is the only place HERMIT executes DF code,
 * and it executes ONLY what the user points it at (`df use <path>` / DF_ROOT).
 *
 * Policy note: the DF fabric is offline by construction (NETWORK=deny,
 * BACKEND=none). The runner adds no network and passes the environment through
 * unchanged apart from an optional PYTHON override.
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const PYTHON = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');

/**
 * @param {object} o
 * @param {string} o.cwd        the container directory (has adapter/dfabric/cli.py)
 * @param {string[]} o.argv     CLI argv, e.g. ['fabric-run', 'x.pal', '--profile', ...]
 * @param {{write:(s:string)=>void}} o.stdout
 * @param {{write:(s:string)=>void}} o.stderr
 * @param {AbortSignal} o.signal
 * @param {object} [o.env]          explicit child environment (remote policy: an allowlist, never process.env)
 * @param {number} [o.deadlineMs]   hard wall-clock limit; the child is killed afterwards (exit 124)
 * @param {(s:string)=>string} [o.redact]  line-wise output transform (remote policy hides host paths)
 * @param {{paused:()=>boolean,onDrain:(fn:()=>void)=>void}} [o.flow]  output backpressure source
 * @returns {Promise<number>} exit code
 */
function runCli(o) {
  return new Promise((resolve) => {
    const cliRel = path.join('adapter', 'dfabric', 'cli.py');
    const cliAbs = path.join(o.cwd, cliRel);
    if (!fs.existsSync(cliAbs)) {
      o.stderr.write(`\x1b[31mdf: adapter CLI not found at ${cliAbs}\x1b[0m\n`);
      return resolve(127);
    }

    let child;
    try {
      child = spawn(o.python || PYTHON, ['-B', cliRel, ...o.argv], {
        cwd: o.cwd,
        env: o.env || process.env,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (err) {
      o.stderr.write(`\x1b[31mdf: cannot start ${PYTHON}: ${err.message}\x1b[0m\n`);
      return resolve(127);
    }

    const onAbort = () => { try { child.kill('SIGINT'); } catch { /* noop */ } };
    if (o.signal) {
      if (o.signal.aborted) onAbort();
      else o.signal.addEventListener('abort', onAbort, { once: true });
    }

    let deadline = null, timedOut = false;
    if (o.deadlineMs > 0) {
      deadline = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch { /* noop */ } }, o.deadlineMs);
    }

    // Streaming UTF-8 decode (multi-byte sequences may split across pipe reads), optional
    // line-wise redaction, and real backpressure: when the terminal sink is congested the
    // child's pipes are paused, so the OS pipe — not this process's heap — absorbs the stall.
    const pump = (stream, sink) => {
      const dec = new (require('node:string_decoder').StringDecoder)('utf8');
      let carry = '';
      const emit = (text) => { if (text) sink.write(o.redact ? o.redact(text) : text); };
      stream.on('data', (b) => {
        let text = carry + dec.write(b); carry = '';
        if (o.redact) { const nl = text.lastIndexOf('\n'); if (nl < 0 && text.length < 8192) { carry = text; text = ''; } else if (nl < 0) { const keep = Math.min(text.length, (o.redact.keep || 256)); carry = text.slice(text.length - keep); text = text.slice(0, text.length - keep); } else if (nl >= 0) { carry = text.slice(nl + 1); text = text.slice(0, nl + 1); } }
        emit(text);
        if (o.flow && o.flow.paused()) { stream.pause(); o.flow.onDrain(() => stream.resume()); }
      });
      stream.on('end', () => emit(carry + dec.end()));
    };
    pump(child.stdout, o.stdout);
    pump(child.stderr, o.stderr);

    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        o.stderr.write(`\x1b[31mdf: '${PYTHON}' not found on PATH — install Python 3 or set PYTHON\x1b[0m\n`);
        return resolve(127);
      }
      o.stderr.write(`\x1b[31mdf: ${err.message}\x1b[0m\n`);
      resolve(1);
    });

    child.on('close', (code, sig) => {
      if (deadline) clearTimeout(deadline);
      if (o.signal) o.signal.removeEventListener('abort', onAbort);
      if (timedOut) { o.stderr.write(`\x1b[31mdf: deadline of ${Math.round(o.deadlineMs / 1000)} s exceeded; process terminated\x1b[0m\n`); return resolve(124); }
      if (sig) { o.stderr.write(`\x1b[2m[${sig}]\x1b[0m\n`); return resolve(130); }
      resolve(code == null ? 1 : code);
    });
  });
}

module.exports = { runCli, PYTHON };
