'use strict';

/**
 * SPIRAL — Photon complex-request workflow
 * ---------------------------------------------------------------------------
 * The delegation HERMIT performs when it hands a heavy request to the VEC1
 * Photon. The order is fixed by the user's workflow: **electron lifecycle
 * first (the vecctl / VEC-electron model), then the fabric endpoint.**
 *
 *   step 2  — bring a VEC electron through its lifecycle (create/reuse →
 *             cross-target verify). This is the unit of work in the VEC model.
 *   step 1  — run the fabric proof on the control plane (/api/fabric/diagnostic)
 *             and read the CROSS_NODE_DIFFERENTIAL_AGREEMENT verdict.
 *
 * Everything is streamed to the terminal as it happens, and honors Ctrl-C via
 * the AbortSignal.
 */

function line(io, s) { io.stdout.write(s + '\n'); }
function dim(s) { return `\x1b[2m${s}\x1b[0m`; }
function ok(s) { return `\x1b[38;5;114m${s}\x1b[0m`; }
function accent(s) { return `\x1b[38;5;79m${s}\x1b[0m`; }

function verdictColor(v) {
  if (!v) return dim('—');
  if (String(v).includes('AGREEMENT') || String(v) === 'VERIFIED') return ok(v);
  return `\x1b[31m${v}\x1b[0m`;
}

/**
 * @param {import('./client').PhotonClient} client
 * @param {object} opts   { name?, verify?:boolean }
 * @param {{stdout,stderr}} io
 * @param {AbortSignal} signal
 * @returns {Promise<{electronId:string, verify:any, diagnostic:any, verdict:string}>}
 */
async function runComplexFabric(client, opts, io, signal) {
  const name = opts.name || 'hermit';

  // ---- step 2: electron lifecycle -------------------------------------
  line(io, accent('▶2') + ' electron lifecycle');
  let electronId = null;
  try {
    const list = await client.electrons(signal);
    const existing = (list.electrons || []).find((e) => e.name === name || e.id === name);
    if (existing) { electronId = existing.id || existing.electron_id; line(io, '  reuse electron ' + accent(electronId) + dim(' (' + name + ')')); }
  } catch (e) {
    if (e.code === 'PHOTON_OFFLINE' || e.code === 'NO_FETCH') throw e;
  }
  if (!electronId) {
    const created = await client.create(name, signal);
    electronId = created.id || created.electron_id || (created.electron && created.electron.id);
    line(io, '  create electron ' + accent(electronId) + dim(' (' + name + ')'));
  }

  let verify = null;
  if (opts.verify !== false) {
    try {
      verify = await client.operate(electronId, 'cross_target.verify', {}, signal);
      const token = verify && (verify.token || verify.verdict || verify.state);
      line(io, '  cross_target.verify → ' + verdictColor(token));
    } catch (e) {
      // Not every Photon build exposes this verb; continue to the fabric step.
      line(io, '  ' + dim('cross_target.verify unavailable (' + (e.status || e.code || e.message) + '), continuing'));
    }
  }

  // ---- step 1: fabric proof on the control plane ----------------------
  line(io, accent('▶1') + ' fabric proof (control plane)');
  const diag = await client.fabricDiagnostic(signal);
  const verdict = (diag && (diag.verdict || diag.token || (diag.fabric && diag.fabric.verdict))) || null;
  const rows = diag && (diag.rows || (diag.fabric && diag.fabric.rows));
  // Pull the witness from the raw bytes so the 64-bit value is exact.
  const wit = exactWitness(diag);
  line(io, '  verdict : ' + verdictColor(verdict));
  if (rows != null) line(io, '  rows    : ' + rows);
  if (wit != null) line(io, '  witness : ' + wit);

  return { electronId, verify, diagnostic: diag, verdict };
}

/** Read reference_witness exactly from the raw JSON text (avoids 2^53 rounding). */
function exactWitness(diag) {
  if (!diag) return null;
  const raw = diag.__raw;
  if (raw) {
    const m = raw.match(/"reference_witness"\s*:\s*"?(\d+)"?/);
    if (m) return m[1];
  }
  return diag.reference_witness != null ? diag.reference_witness
    : (diag.fabric && diag.fabric.reference_witness) || null;
}

module.exports = { runComplexFabric, verdictColor, exactWitness };
