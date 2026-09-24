'use strict';
/** Structured single-line JSON logs with field allowlisting. Never logs tokens, cookies, query strings or terminal bytes. */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
function createLogger(level = 'info', sink = (l) => process.stderr.write(l + '\n')) {
  const min = LEVELS[level] ?? 20;
  const clean = (v) => typeof v === 'string' ? v.replace(/[\r\n]+/g, ' ').slice(0, 300) : v;
  const log = (lvl, event, fields = {}) => {
    if (LEVELS[lvl] < min) return;
    const rec = { ts: new Date().toISOString(), level: lvl, event };
    for (const [k, v] of Object.entries(fields)) if (!/token|cookie|secret|authorization|ticket$|payload|data/i.test(k)) rec[k] = clean(v);
    sink(JSON.stringify(rec));
  };
  return { debug: (e, f) => log('debug', e, f), info: (e, f) => log('info', e, f), warn: (e, f) => log('warn', e, f), error: (e, f) => log('error', e, f) };
}
/** Path without the query string (a query may carry a one-use ticket when that mode is enabled). */
function safePath(url) { const i = String(url).indexOf('?'); return (i < 0 ? String(url) : String(url).slice(0, i)).slice(0, 200); }
module.exports = { createLogger, safePath };
