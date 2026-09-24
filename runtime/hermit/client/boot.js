/**
 * Profile selection (series I031 / I045). Runs before renderer.js.
 *   LOCAL  : the Electron preload exposed window.spiral  -> IPC adapter
 *   WEB    : no preload bridge                            -> WebSocket adapter + in-memory sign-in
 * The bearer credential lives only in this closure: never in localStorage, a cookie, the URL or the DOM.
 */
(function (root) {
  'use strict';
  const V = root.HermitVWS;
  if (root.spiral) { root.HermitTransport = V.IpcTransport(root.spiral); return; }

  const doc = root.document;
  let token = null, waiting = null;
  const overlay = doc.getElementById('signin');
  const form = doc.getElementById('signin-form');
  const input = doc.getElementById('signin-token');
  const msg = doc.getElementById('signin-msg');

  function ask(message) {
    if (waiting) return waiting.promise;
    let resolve; const promise = new Promise((r) => { resolve = r; });
    waiting = { promise, resolve };
    if (msg) msg.textContent = message || '';
    if (overlay) { overlay.hidden = false; setTimeout(() => input && input.focus(), 0); }
    return promise;
  }
  if (form) form.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = input.value.trim(); input.value = '';
    if (!/^[A-Za-z0-9._~+/=-]{32,512}$/.test(v)) { msg.textContent = 'That does not look like an access token.'; return; }
    token = v; overlay.hidden = true;
    const w = waiting; waiting = null; if (w) w.resolve(token);
  });
  const out = doc.getElementById('signout');
  if (out) out.addEventListener('click', () => { token = null; root.location.reload(); });

  root.HermitTransport = V.WsTransport({ getToken: async () => token || ask('') });
  V.onOpenFailed = (err, retry) => {
    if (err && (err.status === 401 || err.status === 403)) { token = null; ask(err.status === 401 ? 'Access token rejected.' : 'Not permitted from this origin.').then(retry); }
  };
})(typeof self !== 'undefined' ? self : globalThis);
