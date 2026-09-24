'use strict';

/**
 * HERMIT — Browser adapter interface + fallback implementation
 * ---------------------------------------------------------------------------
 * This is the seam where the VB-JA21 v9.8.7 browser plugs in.
 *
 * To integrate your browser, create  vendor/browser/index.js  that exports a
 * `createAdapter()` function returning an object with this shape:
 *
 *   interface BrowserAdapter {
 *     name: string;                         // engine label shown in the UI / `browser info`
 *     attach(view, hooks): void;            // wire the Electron BrowserView (or your own surface)
 *                                           //   hooks = { onNavigate(url) }
 *     resolveUrl(input: string): string;    // normalize user input -> a loadable URL
 *                                           //   (bare host -> https://, search terms -> search URL,
 *                                           //    "vbja21://..." internal routes, etc.)
 *     navigate(url: string): void;          // load a resolved URL
 *   }
 *
 * If your build cannot expose an Electron BrowserView (e.g. it renders its own
 * optical/WASM surface), have `attach` load your bootstrap page into the view
 * and forward navigation over your own channel — the contract above is all the
 * pane relies on.
 *
 * The fallback below is a fully working, dependency-free adapter so HERMIT runs
 * out of the box before VB-JA21 is dropped in.
 */

const { resolveNavigation, isAllowedUrl } = require('./nav-policy');

/** Normalize user input under the deny-by-default policy. Refused input resolves to about:blank. */
function normalize(input) {
  const r = resolveNavigation(input);
  return r.ok ? r.url : 'about:blank';
}

function createFallbackAdapter() {
  let view = null;
  let hooks = { onNavigate() {} };

  return {
    name: 'HERMIT-Fallback/Chromium',

    attach(browserView, h) {
      view = browserView;
      hooks = h || hooks;
      const wc = view.webContents;
      // window.open / target=_blank: never a new window; load in the pane only if the policy allows the URL.
      wc.setWindowOpenHandler(({ url }) => {
        if (isAllowedUrl(url)) wc.loadURL(url);
        return { action: 'deny' };
      });
      // In-page navigations and server redirects obey the same policy as typed input (F16).
      const guardNav = (e, url) => { if (!isAllowedUrl(url)) e.preventDefault(); };
      wc.on('will-navigate', guardNav);
      wc.on('will-redirect', guardNav);
      wc.on('will-attach-webview', (e) => e.preventDefault());
      // Deny-by-default permissions (camera, microphone, geolocation, notifications, clipboard-read, …).
      if (wc.session) {
        if (wc.session.setPermissionRequestHandler) wc.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
        if (wc.session.setPermissionCheckHandler) wc.session.setPermissionCheckHandler(() => false);
      }
      wc.on('did-navigate', (_e, url) => hooks.onNavigate(url));
      wc.on('did-navigate-in-page', (_e, url) => hooks.onNavigate(url));
    },

    resolveUrl: normalize,

    navigate(url) {
      if (view && isAllowedUrl(url)) view.webContents.loadURL(url);
    }
  };
}

module.exports = { createFallbackAdapter, normalize };
