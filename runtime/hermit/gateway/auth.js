'use strict';
/**
 * Identity-provider seam (series I011 / I014).
 * ---------------------------------------------------------------------------
 * The gateway depends only on:  authenticate(bearerToken) -> principal | null
 *   principal = { sub, tenant, capabilities:Set<string>, notAfter:number|null }
 * No issuer, audience, key material or credential is invented here. Two adapters ship:
 *   static-file        hashed bearer tokens from an operator-owned JSON file (re-read on
 *                      change, so revocation does not need a restart). Suitable for a
 *                      single-operator/self-hosted deployment, NOT a multi-tenant IdP.
 *   none-loopback-dev  one fixed local principal; refused unless bound to loopback.
 * A real OIDC/JWT adapter is a BLOCKED item until a provider is selected by the owner.
 */
const fs = require('node:fs');
const crypto = require('node:crypto');

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest();
const CAPS = new Set(['terminal', 'fabric']);

function staticFile(file, log) {
  let mtime = -1, entries = [];
  function reload() {
    let st;
    try { st = fs.statSync(file); } catch (e) { if (mtime !== -2) { log.error('auth.principals_unreadable', { reason: e.code }); mtime = -2; entries = []; } return; }
    if (st.mtimeMs === mtime) return;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(raw)) throw new Error('array expected');
      const next = [];
      for (const p of raw) {
        if (!p || typeof p.sub !== 'string' || !/^[A-Za-z0-9_.@-]{1,64}$/.test(p.sub)) throw new Error('bad sub');
        if (typeof p.tenant !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(p.tenant)) throw new Error('bad tenant');
        if (typeof p.tokenSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(p.tokenSha256)) throw new Error('bad tokenSha256');
        const caps = new Set((p.capabilities || ['terminal']).filter((c) => CAPS.has(c)));
        let notAfter = null;
        if (p.notAfter !== undefined && p.notAfter !== null) { notAfter = Date.parse(p.notAfter); if (typeof p.notAfter !== 'string' || !Number.isFinite(notAfter)) throw new Error('bad notAfter (must be an ISO-8601 date)'); } // never fail open
        next.push({ sub: p.sub, tenant: p.tenant, hash: Buffer.from(p.tokenSha256, 'hex'), capabilities: caps, revoked: p.revoked === true, notAfter });
      }
      entries = next; mtime = st.mtimeMs;
      log.info('auth.principals_loaded', { count: entries.length });
    } catch (e) { log.error('auth.principals_invalid', { reason: e.message }); entries = []; mtime = st.mtimeMs; }
  }
  reload();
  return {
    name: 'static-file',
    authenticate(token) {
      reload();
      if (typeof token !== 'string' || token.length < 32 || token.length > 512) return null;
      const h = sha256(token);
      let hit = null;
      for (const e of entries) if (crypto.timingSafeEqual(h, e.hash)) hit = e; // no early exit
      if (!hit || hit.revoked || (hit.notAfter !== null && Date.now() >= hit.notAfter)) return null;
      return { sub: hit.sub, tenant: hit.tenant, capabilities: new Set(hit.capabilities), notAfter: hit.notAfter,
        credentialHash: hit.hash.toString('hex') };
    },
    /** Still valid? Used to end live sessions after revocation/expiry. */
    stillValid(principal) {
      reload();
      // Modified for CFP 0.4.3: bind revocation to the exact authenticated credential.
      // A different live token for the same principal must not preserve this session.
      return entries.some((x) => x.hash.toString('hex') === principal.credentialHash && x.sub === principal.sub && x.tenant === principal.tenant && !x.revoked && (x.notAfter === null || Date.now() < x.notAfter) && [...principal.capabilities].every((c) => x.capabilities.has(c)));
    }
  };
}

function loopbackDev() {
  const p = { sub: 'local-dev', tenant: 'local', capabilities: new Set(['terminal', 'fabric']), notAfter: null };
  return { name: 'none-loopback-dev', authenticate: () => ({ ...p, capabilities: new Set(p.capabilities) }), stillValid: () => true, open: true };
}

function createIdentity(cfg, log) {
  return cfg.auth === 'none-loopback-dev' ? loopbackDev() : staticFile(cfg.principalsFile, log);
}

function bearerFrom(req) {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return null;
  const m = /^Bearer ([A-Za-z0-9._~+/=-]{32,512})$/.exec(h);
  return m ? m[1] : null;
}

module.exports = { createIdentity, bearerFrom };
