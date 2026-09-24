'use strict';
/**
 * Browser-pane navigation policy (series F16 / I044): deny by default.
 * Allowed: https:, http:, about:blank, plus schemes a vendored adapter explicitly declares
 * (`internalSchemes`, e.g. ['vbja21']). Everything else — file:, data:, blob:, javascript:,
 * chrome:, devtools:, view-source:, custom protocol handlers — is refused for typed input,
 * window.open, in-page navigation and redirects alike.
 */
const DEFAULT_SEARCH = 'https://duckduckgo.com/?q=';
const MAX_URL = 2048;

function isAllowedUrl(url, internalSchemes = []) {
  if (typeof url !== 'string' || url.length > MAX_URL) return false;
  if (url === 'about:blank') return true;
  let u; try { u = new URL(url); } catch { return false; }
  const scheme = u.protocol.slice(0, -1).toLowerCase();
  if (scheme === 'https' || scheme === 'http') return !!u.hostname && !u.username && !u.password; // no credentials-in-URL
  return internalSchemes.map((s) => String(s).toLowerCase()).includes(scheme);
}

/** Normalize user input into a loadable URL, or report why it was refused. */
function resolveNavigation(input, internalSchemes = []) {
  const s = String(input == null ? '' : input).trim();
  if (!s) return { ok: true, url: 'about:blank' };
  if (s.length > MAX_URL) return { ok: false, reason: 'URL too long' };
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^localhost(:\d+)?(\/|$)/i.test(s) && !/^[^\s/:]+\.[^\s/:]+:\d+(\/|$)/.test(s)) {
    return isAllowedUrl(s, internalSchemes) ? { ok: true, url: s } : { ok: false, reason: `scheme not permitted: ${s.split(':')[0].slice(0, 24)}` };
  }
  let candidate;
  if (s === 'localhost' || /^localhost[:/]/i.test(s)) candidate = 'http://' + s;
  else if (/^[^\s]+\.[^\s]+$/.test(s)) candidate = 'https://' + s;
  else candidate = DEFAULT_SEARCH + encodeURIComponent(s);
  return isAllowedUrl(candidate, internalSchemes) ? { ok: true, url: candidate } : { ok: false, reason: 'not a permitted address' };
}

module.exports = { isAllowedUrl, resolveNavigation, DEFAULT_SEARCH, MAX_URL };
