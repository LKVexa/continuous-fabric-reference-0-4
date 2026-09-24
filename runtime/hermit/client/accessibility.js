/**
 * Accessible status + text mirror for the canvas terminal (series I035 / I055).
 * A canvas is opaque to assistive technology, so the page carries:
 *   #a11y-status  role=status aria-live=polite   connection / session announcements
 *   #a11y-screen  role=log                        plain-text copy of the visible rows (debounced by the caller)
 * Both are visually hidden, not display:none, so screen readers can reach them.
 */
(function (root) {
  'use strict';
  function accessibility() {
    const doc = root.document;
    const status = doc.getElementById('a11y-status');
    const screenEl = doc.getElementById('a11y-screen');
    let last = '';
    return {
      announce(text) { if (!status) return; const t = String(text).slice(0, 300); if (t === last) status.textContent = ''; last = t; status.textContent = t; },
      mirror(screen) {
        if (!screenEl || !screen || !screen.grid) return;
        const lines = [];
        for (let y = 0; y < screen.rows; y++) { let s = ''; const row = screen.grid[y]; for (let x = 0; x < row.length; x++) s += row[x].hidden ? ' ' : row[x].ch; lines.push(s.replace(/\s+$/, '')); }
        while (lines.length && lines[lines.length - 1] === '') lines.pop();
        const text = lines.join('\n');
        if (screenEl.textContent !== text) screenEl.textContent = text;
      }
    };
  }
  root.HermitVWS = Object.assign(root.HermitVWS || {}, { accessibility });
})(typeof self !== 'undefined' ? self : globalThis);
