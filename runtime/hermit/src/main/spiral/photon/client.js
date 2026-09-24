'use strict';

/**
 * SPIRAL — VEC1 Photon client
 * ---------------------------------------------------------------------------
 * HERMIT delegates its heavy / complex requests to a running VEC1 "Photon"
 * (the Electron-substitute control plane), instead of doing that work in a Node
 * main process. This client speaks VEC1's loopback JSON-RPC exactly as the
 * shell's own `ui/app.js` does.
 *
 * Authoritative surface (VEC1 Design Photon v0.6.0, runtime/service.py):
 *   GET   /api/health
 *   GET   /api/status
 *   GET   /api/topology
 *   GET   /api/electrons
 *   GET   /api/electrons/<id>
 *   GET   /api/events?limit=N
 *   POST  /api/electrons                    { name, electron_id? }
 *   POST  /api/electrons/<id>/operate       { method, payload }
 *   POST  /api/electrons/<id>/clone         { name }
 *   POST  /api/fabric/diagnostic
 *   POST  /api/shutdown
 *
 * Security the client must honor:
 *   • loopback only (Host must be 127.0.0.1:<port>) — so baseUrl uses 127.0.0.1
 *   • mutations require header  X-VEC1-Token: <per-launch token>
 *     (VEC1 injects it into the page it serves as <meta name="vec1-token">;
 *      for a cross-process client, pass it via `photon use <url> <token>`)
 *   • Content-Type: application/json  and no cross-origin Origin header
 */

const TOKEN_HEADER = 'X-VEC1-Token';

class PhotonClient {
  constructor(baseUrl, token, opts = {}) {
    this.baseUrl = (baseUrl || 'http://127.0.0.1:8765').replace(/\/+$/, '');
    this.token = token || '';
    this.timeoutMs = opts.timeoutMs || 15000;
  }

  _url(path) { return this.baseUrl + path; }

  async _fetch(path, { method = 'GET', body, signal } = {}) {
    if (typeof fetch !== 'function') {
      const err = new Error('global fetch unavailable (Node 18+ / Electron required)');
      err.code = 'NO_FETCH';
      throw err;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort('timeout'), this.timeoutMs);
    if (signal) {
      if (signal.aborted) ctrl.abort();
      else signal.addEventListener('abort', () => ctrl.abort(), { once: true });
    }
    const headers = { Accept: 'application/json' };
    if (method !== 'GET') {
      headers['Content-Type'] = 'application/json';
      headers[TOKEN_HEADER] = this.token;
    }
    let res;
    try {
      res = await fetch(this._url(path), {
        method, headers,
        body: body != null ? JSON.stringify(body) : undefined,
        signal: ctrl.signal
      });
    } catch (err) {
      clearTimeout(t);
      const e = new Error(
        err.name === 'AbortError' ? 'request aborted/timed out'
          : `cannot reach Photon at ${this.baseUrl} (${err.cause ? err.cause.code || err.cause.message : err.message})`);
      e.code = 'PHOTON_OFFLINE';
      throw e;
    }
    clearTimeout(t);
    // Read raw text so 64-bit integers (e.g. fabric witnesses) survive exactly;
    // JSON.parse would round anything past 2^53. `__raw` carries the exact bytes.
    let text = '';
    try { text = await res.text(); } catch { /* ignore */ }
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    if (data && typeof data === 'object') {
      try { Object.defineProperty(data, '__raw', { value: text, enumerable: false }); } catch { /* frozen */ }
    }
    if (!res.ok) {
      const e = new Error((data && (data.detail || data.error)) || `HTTP ${res.status}`);
      e.status = res.status;
      if (res.status === 403) e.code = 'PHOTON_AUTH';
      throw e;
    }
    return data;
  }

  /* ---- reads ---------------------------------------------------------- */
  health(signal) { return this._fetch('/api/health', { signal }); }
  status(signal) { return this._fetch('/api/status', { signal }); }
  topology(signal) { return this._fetch('/api/topology', { signal }); }
  electrons(signal) { return this._fetch('/api/electrons', { signal }); }
  electron(id, signal) { return this._fetch(`/api/electrons/${encodeURIComponent(id)}`, { signal }); }
  events(limit = 40, signal) { return this._fetch(`/api/events?limit=${encodeURIComponent(limit)}`, { signal }); }

  /* ---- mutations (token-guarded) ------------------------------------- */
  create(name, signal) { return this._fetch('/api/electrons', { method: 'POST', body: { name }, signal }); }
  clone(id, name, signal) { return this._fetch(`/api/electrons/${encodeURIComponent(id)}/clone`, { method: 'POST', body: { name }, signal }); }
  operate(id, method, payload = {}, signal) {
    return this._fetch(`/api/electrons/${encodeURIComponent(id)}/operate`, { method: 'POST', body: { method, payload }, signal });
  }
  fabricDiagnostic(signal) { return this._fetch('/api/fabric/diagnostic', { method: 'POST', body: {}, signal }); }
  shutdown(signal) { return this._fetch('/api/shutdown', { method: 'POST', body: {}, signal }); }

  /** True if the Photon answers /api/health. */
  async reachable(signal) {
    try { await this.health(signal); return true; } catch { return false; }
  }
}

/** Build a client from session/host env (VEC1_API, VEC1_TOKEN). */
function fromEnv(env) {
  const url = (env && env.get && env.get('VEC1_API')) || process.env.VEC1_API || null;
  const token = (env && env.get && env.get('VEC1_TOKEN')) || process.env.VEC1_TOKEN || '';
  if (!url) return null;
  return new PhotonClient(url, token);
}

module.exports = { PhotonClient, fromEnv, TOKEN_HEADER };
