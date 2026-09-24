'use strict';
/**
 * IPC authorization for the LOCAL desktop profile (series F11 / I041). Pure functions — unit-tested
 * without Electron. main.js applies them to every `spiral:*`, `browser:*` and `win:*` message:
 *   1. the sender must be the top-level frame of OUR window, loaded from OUR renderer file
 *   2. the payload must match the channel's shape exactly (types, ranges, lengths)
 *   3. a session-scoped message must name a session that this sender opened
 */
const { pathToFileURL } = require('node:url');
const { validGeometry } = require('./spiral/kernel');

const SID = /^s[1-9][0-9]{0,8}$/;
const MAX_INPUT = 65536;

function trustedSender(event, win, rendererFile) {
  if (!event || !win || win.isDestroyed()) return false;
  if (event.sender !== win.webContents) return false;
  const frame = event.senderFrame;
  if (!frame || frame.parent) return false;                        // top-level frame only (no iframes)
  const expected = pathToFileURL(rendererFile).href;
  const url = String(frame.url || '').split('#')[0].split('?')[0];
  return url === expected;
}

const shapes = {
  'spiral:open': (p) => p && typeof p === 'object' && validGeometry(p.cols, p.rows) && (p.deferStart === undefined || typeof p.deferStart === 'boolean') && Object.keys(p).every((k) => ['cols', 'rows', 'deferStart'].includes(k)),
  'spiral:start': (p) => typeof p === 'string' && SID.test(p),
  'spiral:close': (p) => typeof p === 'string' && SID.test(p),
  'spiral:status': (p) => typeof p === 'string' && SID.test(p),
  'spiral:resize': (p) => p && typeof p === 'object' && SID.test(p.sessionId) && validGeometry(p.cols, p.rows),
  'spiral:input': (p) => p && typeof p === 'object' && SID.test(p.sessionId) && typeof p.data === 'string' && p.data.length <= MAX_INPUT,
  'spiral:signal': (p) => p && typeof p === 'object' && SID.test(p.sessionId) && p.signal === 'SIGINT',
  'browser:show': (p) => p === undefined || p === null || (typeof p === 'string' && p.length <= 2048),
  'browser:navigate': (p) => typeof p === 'string' && p.length <= 2048,
  'browser:bounds': (p) => p && typeof p === 'object' && ['xPct', 'yPct', 'wPct', 'hPct'].every((k) => typeof p[k] === 'number' && p[k] >= 0 && p[k] <= 1) && Object.keys(p).length === 4,
  'browser:hide': (p) => p === undefined, 'browser:state': (p) => p === undefined,
  'win:minimize': (p) => p === undefined, 'win:maximize': (p) => p === undefined, 'win:close': (p) => p === undefined, 'win:isMaximized': (p) => p === undefined
};
function validPayload(channel, payload) { const f = shapes[channel]; return !!f && f(payload) === true; }
function sessionIdOf(channel, payload) { return typeof payload === 'string' ? payload : (payload && payload.sessionId) || null; }

/** Session ownership: sessionId -> webContents id that opened it. */
function createOwnership() {
  const owner = new Map();
  return { claim: (sid, wcId) => owner.set(sid, wcId), owns: (sid, wcId) => owner.get(sid) === wcId, release: (sid) => owner.delete(sid), releaseAll(wcId) { const out = []; for (const [s, o] of owner) if (o === wcId) { owner.delete(s); out.push(s); } return out; }, size: () => owner.size };
}

module.exports = { trustedSender, validPayload, sessionIdOf, createOwnership, shapes, MAX_INPUT };
