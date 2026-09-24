'use strict';

/**
 * VT engine — Canvas renderer
 * ---------------------------------------------------------------------------
 * Paints a Screen buffer onto a 2D canvas: background fills, glyphs with the
 * bold/dim/italic/underline/strike/inverse attributes, the block cursor, and a
 * scrollback viewport. Handles HiDPI via devicePixelRatio and computes the grid
 * geometry (cols × rows) that fits the element.
 */

/* 16 base ANSI colors — LK/Vexa house palette: graphite field, cyan core,
 * ice text; accents kept cool so the brand cyan always reads as "the signal". */
const ANSI16 = [
  '#0c0f13', '#ef6b73', '#58d6a9', '#e4c26a', '#4fb3e8', '#b98cf0', '#2fd0e4', '#c9d2da',
  '#4a535e', '#ff8189', '#7ee8c4', '#f0d48a', '#79c8f5', '#cfa9ff', '#7ee8f5', '#f2f6f9'
];

function build256() {
  const table = ANSI16.slice();
  const steps = [0, 95, 135, 175, 215, 255];
  for (let r = 0; r < 6; r++)
    for (let g = 0; g < 6; g++)
      for (let b = 0; b < 6; b++)
        table.push(rgb(steps[r], steps[g], steps[b]));
  for (let i = 0; i < 24; i++) { const v = 8 + i * 10; table.push(rgb(v, v, v)); }
  return table;
}
function rgb(r, g, b) {
  const h = (n) => n.toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

const PALETTE = build256();

const DEFAULT_THEME = {
  background: '#0c0f13',
  foreground: '#dfe6ec',
  cursor: '#2fd0e4',
  cursorText: '#0c0f13',
  fontFamily: '"Cascadia Mono","JetBrains Mono","SF Mono",Menlo,Consolas,"DejaVu Sans Mono",monospace',
  fontSize: 14,
  lineHeight: 1.4
};

class CanvasRenderer {
  constructor(canvas, screen, theme = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.screen = screen;
    this.theme = { ...DEFAULT_THEME, ...theme };
    this.dpr = window.devicePixelRatio || 1;
    this.scrollOffset = 0;     // lines scrolled up into history
    this.cursorOn = true;
    this._measure();
  }

  _measure() {
    const ctx = this.ctx;
    ctx.font = `${this.theme.fontSize}px ${this.theme.fontFamily}`;
    const m = ctx.measureText('M');
    this.cellW = Math.max(1, Math.ceil(m.width));
    this.cellH = Math.ceil(this.theme.fontSize * this.theme.lineHeight);
    this.baseline = Math.ceil(this.theme.fontSize * 0.5 + this.cellH * 0.35);
  }

  /** Fit the canvas to a pixel box; returns the resulting {cols, rows}. */
  fit(pixelW, pixelH) {
    const cols = Math.max(1, Math.floor(pixelW / this.cellW));
    const rows = Math.max(1, Math.floor(pixelH / this.cellH));
    this.canvas.width = Math.floor(cols * this.cellW * this.dpr);
    this.canvas.height = Math.floor(rows * this.cellH * this.dpr);
    this.canvas.style.width = cols * this.cellW + 'px';
    this.canvas.style.height = rows * this.cellH + 'px';
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.ctx.textBaseline = 'alphabetic';
    return { cols, rows };
  }

  setTheme(patch) { this.theme = { ...this.theme, ...patch }; this._measure(); }

  maxScroll() { return this.screen.scrollback.length; }
  scrollBy(lines) {
    this.scrollOffset = Math.max(0, Math.min(this.maxScroll(), this.scrollOffset + lines));
  }
  scrollToBottom() { this.scrollOffset = 0; }

  /* ---- color resolution ------------------------------------------------ */

  _color(val, fallback) {
    if (val == null) return fallback;
    if (Array.isArray(val)) return rgb(val[0] | 0, val[1] | 0, val[2] | 0);
    if (typeof val === 'number') return PALETTE[val] || fallback;
    return fallback;
  }

  /* ---- viewport assembly ---------------------------------------------- */

  _viewportRows() {
    const { screen } = this;
    if (this.scrollOffset <= 0) return screen.grid;
    const sb = screen.scrollback;
    const start = sb.length - this.scrollOffset;
    const fromHistory = sb.slice(start, start + screen.rows);
    if (fromHistory.length >= screen.rows) return fromHistory;
    return fromHistory.concat(screen.grid.slice(0, screen.rows - fromHistory.length));
  }

  /* ---- paint ----------------------------------------------------------- */

  render() {
    const ctx = this.ctx;
    const rows = this._viewportRows();
    const showCursor = this.scrollOffset === 0;

    // background
    ctx.fillStyle = this.theme.background;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    ctx.font = `${this.theme.fontSize}px ${this.theme.fontFamily}`;
    ctx.textBaseline = 'alphabetic';

    for (let y = 0; y < rows.length; y++) {
      const row = rows[y];
      if (!row) continue;
      const yPix = y * this.cellH;

      for (let x = 0; x < row.length; x++) {
        const cell = row[x];
        if (!cell) continue;
        const xPix = x * this.cellW;

        let fg = this._color(cell.fg, this.theme.foreground);
        let bg = this._color(cell.bg, this.theme.background);
        if (cell.inverse) { const t = fg; fg = bg; bg = t; }
        if (cell.dim && !cell.bold) fg = this._dim(fg);

        // background cell
        if (bg !== this.theme.background) {
          ctx.fillStyle = bg;
          ctx.fillRect(xPix, yPix, this.cellW, this.cellH);
        }

        if (cell.hidden || cell.ch === ' ') { this._maybeDecor(cell, xPix, yPix, fg); continue; }

        ctx.fillStyle = fg;
        let font = '';
        if (cell.italic) font += 'italic ';
        if (cell.bold) font += 'bold ';
        ctx.font = `${font}${this.theme.fontSize}px ${this.theme.fontFamily}`;
        ctx.fillText(cell.ch, xPix, yPix + this.baseline);

        this._maybeDecor(cell, xPix, yPix, fg);
      }
    }

    if (showCursor && this.screen.cursor.visible && this.cursorOn) this._drawCursor();
    else if (showCursor && this.screen.cursor.visible) this._drawCursorOutline();
  }

  _maybeDecor(cell, x, y, fg) {
    const ctx = this.ctx;
    if (cell.underline) {
      ctx.strokeStyle = fg; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, y + this.cellH - 1.5); ctx.lineTo(x + this.cellW, y + this.cellH - 1.5); ctx.stroke();
    }
    if (cell.strike) {
      ctx.strokeStyle = fg; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, y + this.cellH / 2); ctx.lineTo(x + this.cellW, y + this.cellH / 2); ctx.stroke();
    }
  }

  _drawCursor() {
    const { x, y } = this.screen.cursor;
    const xPix = x * this.cellW, yPix = y * this.cellH;
    const ctx = this.ctx;
    ctx.fillStyle = this.theme.cursor;
    ctx.fillRect(xPix, yPix, this.cellW, this.cellH);
    const cell = this.screen.grid[y] && this.screen.grid[y][x];
    if (cell && cell.ch !== ' ') {
      ctx.fillStyle = this.theme.cursorText;
      ctx.font = `${this.theme.fontSize}px ${this.theme.fontFamily}`;
      ctx.fillText(cell.ch, xPix, yPix + this.baseline);
    }
  }

  _drawCursorOutline() {
    const { x, y } = this.screen.cursor;
    const ctx = this.ctx;
    ctx.strokeStyle = this.theme.cursor; ctx.lineWidth = 1;
    ctx.strokeRect(x * this.cellW + 0.5, y * this.cellH + 0.5, this.cellW - 1, this.cellH - 1);
  }

  _dim(hex) {
    const c = hex.replace('#', '');
    const r = parseInt(c.slice(0, 2), 16), g = parseInt(c.slice(2, 4), 16), b = parseInt(c.slice(4, 6), 16);
    return rgb((r * 0.6) | 0, (g * 0.6) | 0, (b * 0.6) | 0);
  }

  /** Translate a pixel coordinate to a grid cell (for selection). */
  cellAt(px, py) {
    return { x: Math.floor(px / this.cellW), y: Math.floor(py / this.cellH) };
  }
}

window.HermitVT = Object.assign(window.HermitVT || {}, { CanvasRenderer, PALETTE, DEFAULT_THEME });
