'use strict';
/**
 * Origin policy (series I012). Two independent decisions:
 *   checkWsOrigin  — server-side admission check for the WebSocket handshake. Browsers do
 *                    not apply CORS to WebSockets; a native peer can forge Origin, so a
 *                    matching Origin NEVER substitutes for identity.
 *   corsHeaders    — ordinary HTTP CORS for the JSON API (ticket endpoint) only.
 * Matching is exact on the serialized origin. No wildcards, suffixes or regexes.
 */
function sameOriginOf(req, cfg) {
  const host = req.headers.host;
  if (!host) return null;
  const proto = (String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' || req.socket.encrypted) ? 'https' : 'http';
  return `${proto}://${host}`;
}
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/i;
/** With open (loopback-dev) identity, a rebinding page must not be able to name this listener: Host must be a loopback literal. */
function hostAcceptable(req, cfg) { return cfg.auth !== 'none-loopback-dev' || LOOPBACK_HOST.test(String(req.headers.host || '')); }

function allowed(origin, req, cfg) {
  if (typeof origin !== 'string' || origin === 'null' || origin.length > 300) return false;
  if (!hostAcceptable(req, cfg)) return false;
  if (cfg.origins.includes(origin)) return true;
  // Same-origin page served by this gateway is always acceptable.
  return cfg.serveStatic && origin === sameOriginOf(req, cfg);
}
function checkWsOrigin(req, cfg) {
  const origin = req.headers.origin;
  if (!hostAcceptable(req, cfg)) return { ok: false };
  if (origin === undefined) return cfg.allowNoOrigin ? { ok: true, origin: null } : { ok: false };
  return allowed(origin, req, cfg) ? { ok: true, origin } : { ok: false };
}
function corsHeaders(req, cfg) {
  const origin = req.headers.origin;
  if (!hostAcceptable(req, cfg)) return { ok: false, headers: {}, origin: origin || null };
  if (origin === undefined) return { ok: true, headers: {} , origin: null };
  if (!allowed(origin, req, cfg)) return { ok: false, headers: { Vary: 'Origin' }, origin };
  return { ok: true, origin, headers: { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true', Vary: 'Origin' } };
}
module.exports = { checkWsOrigin, corsHeaders, sameOriginOf, hostAcceptable };
