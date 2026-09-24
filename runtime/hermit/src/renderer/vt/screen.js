'use strict';

/**
 * VT engine — Screen buffer
 * ---------------------------------------------------------------------------
 * A grid of styled cells plus cursor, pen (current SGR attributes), scroll
 * region, tab stops and a bounded scrollback ring. The parser drives this via
 * a small, explicit method surface; the canvas renderer reads `rows`, `cursor`
 * and the dirty set to paint.
 *
 * Colors on a cell:
 *   null            -> default (theme) color
 *   0..255          -> palette index (16 ANSI + 216 cube + 24 grays)
 *   [r,g,b]         -> truecolor
 */

const MAX_SCROLLBACK = 5000;
// Total retained scrollback cells (rows x cols at capture time). Bounds memory when a very wide
// screen scrolls; enforced on BOTH the scroll path and the resize path (series F08 / I035).
const MAX_SCROLLBACK_CELLS = 2000000;
const MAX_COLS = 400, MAX_ROWS = 200;
/** Remote output controls every CSI count: clamp to the only range that can change the result. */
function clampCount(n, max) { n = Number(n); if (!Number.isFinite(n) || n < 1) n = 1; return Math.min(Math.floor(n), max); }

function blankCell(pen) {
  return {
    ch: ' ',
    fg: pen ? pen.fg : null,
    bg: pen ? pen.bg : null,
    bold: pen ? pen.bold : false,
    dim: pen ? pen.dim : false,
    italic: pen ? pen.italic : false,
    underline: pen ? pen.underline : false,
    inverse: pen ? pen.inverse : false,
    strike: pen ? pen.strike : false,
    hidden: pen ? pen.hidden : false
  };
}

class Screen {
  constructor(cols, rows) {
    this.cols = Math.min(MAX_COLS, Math.max(1, cols | 0));
    this.rows = Math.min(MAX_ROWS, Math.max(1, rows | 0));
    this.scrollbackCells = 0;
    this.cursor = { x: 0, y: 0, visible: true };
    this.saved = null;
    this.pen = this._defaultPen();
    this.scrollTop = 0;
    this.scrollBottom = this.rows - 1;
    this.scrollback = [];
    this.tabs = new Set();
    this.dirty = new Set();
    this.wrapNext = false;    // deferred wrap (DEC autowrap)
    this.onTitle = null;
    this.onBell = null;
    this._initGrid();
    this._resetTabs();
    this.markAllDirty();
  }

  _defaultPen() {
    return { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false, strike: false, hidden: false };
  }

  _initGrid() {
    this.grid = [];
    for (let y = 0; y < this.rows; y++) this.grid.push(this._blankRow());
  }
  _blankRow() {
    const row = new Array(this.cols);
    for (let x = 0; x < this.cols; x++) row[x] = blankCell(null);
    return row;
  }
  _resetTabs() {
    this.tabs.clear();
    for (let x = 0; x < this.cols; x += 8) this.tabs.add(x);
  }

  markDirty(y) { if (y >= 0 && y < this.rows) this.dirty.add(y); }
  markAllDirty() { for (let y = 0; y < this.rows; y++) this.dirty.add(y); }

  /* ---- printing -------------------------------------------------------- */

  print(str) {
    for (const ch of str) this._putChar(ch);
  }

  _putChar(ch) {
    if (this.wrapNext) {
      this.cursor.x = 0;
      this._lineFeedScroll();
      this.wrapNext = false;
    }
    const cell = blankCell(this.pen);
    cell.ch = ch;
    this.grid[this.cursor.y][this.cursor.x] = cell;
    this.markDirty(this.cursor.y);
    if (this.cursor.x + 1 >= this.cols) {
      this.wrapNext = true; // defer until next printable
    } else {
      this.cursor.x++;
    }
  }

  /* ---- C0 controls ----------------------------------------------------- */

  bell() { if (this.onBell) this.onBell(); }
  carriageReturn() { this.cursor.x = 0; this.wrapNext = false; }
  backspace() { if (this.cursor.x > 0) this.cursor.x--; this.wrapNext = false; }
  tab() {
    let x = this.cursor.x + 1;
    while (x < this.cols && !this.tabs.has(x)) x++;
    this.cursor.x = Math.min(x, this.cols - 1);
    this.wrapNext = false;
  }
  lineFeed() { this._lineFeedScroll(); this.wrapNext = false; }
  nextLine() { this.carriageReturn(); this._lineFeedScroll(); }

  _lineFeedScroll() {
    if (this.cursor.y === this.scrollBottom) this.scrollUp(1);
    else if (this.cursor.y < this.rows - 1) this.cursor.y++;
  }

  /* ---- cursor movement (1-based args from CSI) ------------------------- */

  cursorUp(n = 1) { this.cursor.y = Math.max(this.scrollTop, this.cursor.y - (n || 1)); this.wrapNext = false; }
  cursorDown(n = 1) { this.cursor.y = Math.min(this.scrollBottom, this.cursor.y + (n || 1)); this.wrapNext = false; }
  cursorForward(n = 1) { this.cursor.x = Math.min(this.cols - 1, this.cursor.x + (n || 1)); this.wrapNext = false; }
  cursorBack(n = 1) { this.cursor.x = Math.max(0, this.cursor.x - (n || 1)); this.wrapNext = false; }
  cursorCol(n = 1) { this.cursor.x = Math.min(this.cols - 1, Math.max(0, (n || 1) - 1)); this.wrapNext = false; }
  cursorRow(n = 1) { this.cursor.y = Math.min(this.rows - 1, Math.max(0, (n || 1) - 1)); this.wrapNext = false; }
  cursorPos(row = 1, col = 1) {
    this.cursor.y = Math.min(this.rows - 1, Math.max(0, (row || 1) - 1));
    this.cursor.x = Math.min(this.cols - 1, Math.max(0, (col || 1) - 1));
    this.wrapNext = false;
  }
  cursorNextLine(n = 1) { this.cursorDown(n); this.cursor.x = 0; }
  cursorPrevLine(n = 1) { this.cursorUp(n); this.cursor.x = 0; }

  saveCursor() { this.saved = { x: this.cursor.x, y: this.cursor.y, pen: { ...this.pen } }; }
  restoreCursor() {
    if (this.saved) {
      this.cursor.x = this.saved.x; this.cursor.y = this.saved.y;
      this.pen = { ...this.saved.pen };
    }
  }
  setCursorVisible(v) { this.cursor.visible = !!v; }

  /* ---- erase ----------------------------------------------------------- */

  eraseInLine(mode = 0) {
    const row = this.grid[this.cursor.y];
    if (mode === 0) for (let x = this.cursor.x; x < this.cols; x++) row[x] = blankCell(this.pen);
    else if (mode === 1) for (let x = 0; x <= this.cursor.x; x++) row[x] = blankCell(this.pen);
    else for (let x = 0; x < this.cols; x++) row[x] = blankCell(this.pen);
    this.markDirty(this.cursor.y);
  }

  eraseInDisplay(mode = 0) {
    if (mode === 0) {
      this.eraseInLine(0);
      for (let y = this.cursor.y + 1; y < this.rows; y++) { this.grid[y] = this._blankRow(); this.markDirty(y); }
    } else if (mode === 1) {
      this.eraseInLine(1);
      for (let y = 0; y < this.cursor.y; y++) { this.grid[y] = this._blankRow(); this.markDirty(y); }
    } else {
      // 2 = whole screen; 3 = screen + scrollback
      if (mode === 3) this.scrollback = [];
      for (let y = 0; y < this.rows; y++) { this.grid[y] = this._blankRow(); this.markDirty(y); }
    }
  }

  eraseChars(n = 1) {
    n = clampCount(n, this.cols);
    const row = this.grid[this.cursor.y];
    for (let i = 0; i < n && this.cursor.x + i < this.cols; i++) row[this.cursor.x + i] = blankCell(this.pen);
    this.markDirty(this.cursor.y);
  }

  /* ---- insert / delete ------------------------------------------------- */

  _pushScrollback(row) {
    this.scrollback.push(row);
    this.scrollbackCells += row.length;
    while (this.scrollback.length > MAX_SCROLLBACK || this.scrollbackCells > MAX_SCROLLBACK_CELLS) {
      this.scrollbackCells -= this.scrollback.shift().length;
    }
  }

  insertChars(n = 1) {
    n = clampCount(n, this.cols);
    const row = this.grid[this.cursor.y];
    for (let i = 0; i < n; i++) { row.splice(this.cursor.x, 0, blankCell(this.pen)); row.pop(); }
    this.markDirty(this.cursor.y);
  }
  deleteChars(n = 1) {
    n = clampCount(n, this.cols);
    const row = this.grid[this.cursor.y];
    for (let i = 0; i < n; i++) { row.splice(this.cursor.x, 1); row.push(blankCell(this.pen)); }
    this.markDirty(this.cursor.y);
  }
  insertLines(n = 1) {
    if (this.cursor.y < this.scrollTop || this.cursor.y > this.scrollBottom) return;
    n = clampCount(n, this.rows);
    for (let i = 0; i < n; i++) {
      this.grid.splice(this.scrollBottom, 1);
      this.grid.splice(this.cursor.y, 0, this._blankRow());
    }
    this._markRange(this.cursor.y, this.scrollBottom);
  }
  deleteLines(n = 1) {
    if (this.cursor.y < this.scrollTop || this.cursor.y > this.scrollBottom) return;
    n = clampCount(n, this.rows);
    for (let i = 0; i < n; i++) {
      this.grid.splice(this.cursor.y, 1);
      this.grid.splice(this.scrollBottom, 0, this._blankRow());
    }
    this._markRange(this.cursor.y, this.scrollBottom);
  }

  /* ---- scrolling ------------------------------------------------------- */

  scrollUp(n = 1) {
    n = clampCount(n, this.rows);
    for (let i = 0; i < n; i++) {
      const removed = this.grid.splice(this.scrollTop, 1)[0];
      if (this.scrollTop === 0) this._pushScrollback(removed);
      this.grid.splice(this.scrollBottom, 0, this._blankRow());
    }
    this._markRange(this.scrollTop, this.scrollBottom);
  }
  scrollDown(n = 1) {
    n = clampCount(n, this.rows);
    for (let i = 0; i < n; i++) {
      this.grid.splice(this.scrollBottom, 1);
      this.grid.splice(this.scrollTop, 0, this._blankRow());
    }
    this._markRange(this.scrollTop, this.scrollBottom);
  }
  index() { this._lineFeedScroll(); }
  reverseIndex() {
    if (this.cursor.y === this.scrollTop) this.scrollDown(1);
    else if (this.cursor.y > 0) this.cursor.y--;
  }
  setScrollRegion(top, bottom) {
    top = (top || 1) - 1;
    bottom = (bottom || this.rows) - 1;
    if (top < bottom && bottom < this.rows) {
      this.scrollTop = Math.max(0, top);
      this.scrollBottom = Math.min(this.rows - 1, bottom);
      this.cursor.x = 0; this.cursor.y = this.scrollTop;
    }
  }

  _markRange(a, b) { for (let y = a; y <= b; y++) this.markDirty(y); }

  /* ---- SGR (colors & attributes) --------------------------------------- */

  setSGR(params) {
    if (!params.length) params = [0];
    for (let i = 0; i < params.length; i++) {
      const p = params[i];
      switch (true) {
        case p === 0: this.pen = this._defaultPen(); break;
        case p === 1: this.pen.bold = true; break;
        case p === 2: this.pen.dim = true; break;
        case p === 3: this.pen.italic = true; break;
        case p === 4: this.pen.underline = true; break;
        case p === 7: this.pen.inverse = true; break;
        case p === 8: this.pen.hidden = true; break;
        case p === 9: this.pen.strike = true; break;
        case p === 22: this.pen.bold = false; this.pen.dim = false; break;
        case p === 23: this.pen.italic = false; break;
        case p === 24: this.pen.underline = false; break;
        case p === 27: this.pen.inverse = false; break;
        case p === 28: this.pen.hidden = false; break;
        case p === 29: this.pen.strike = false; break;
        case p >= 30 && p <= 37: this.pen.fg = p - 30; break;
        case p === 38: i = this._extendedColor(params, i, 'fg'); break;
        case p === 39: this.pen.fg = null; break;
        case p >= 40 && p <= 47: this.pen.bg = p - 40; break;
        case p === 48: i = this._extendedColor(params, i, 'bg'); break;
        case p === 49: this.pen.bg = null; break;
        case p >= 90 && p <= 97: this.pen.fg = p - 90 + 8; break;
        case p >= 100 && p <= 107: this.pen.bg = p - 100 + 8; break;
        default: break;
      }
    }
  }

  _extendedColor(params, i, which) {
    const mode = params[i + 1];
    if (mode === 5) { this.pen[which] = params[i + 2]; return i + 2; }
    if (mode === 2) { this.pen[which] = [params[i + 2] || 0, params[i + 3] || 0, params[i + 4] || 0]; return i + 4; }
    return i;
  }

  /* ---- modes ----------------------------------------------------------- */

  setMode(params, priv) {
    for (const p of params) {
      if (priv && p === 25) this.setCursorVisible(true);
    }
  }
  resetMode(params, priv) {
    for (const p of params) {
      if (priv && p === 25) this.setCursorVisible(false);
    }
  }

  /* ---- full reset & resize -------------------------------------------- */

  reset() {
    this.pen = this._defaultPen();
    this.cursor = { x: 0, y: 0, visible: true };
    this.scrollTop = 0; this.scrollBottom = this.rows - 1;
    this._initGrid();
    this._resetTabs();
    this.markAllDirty();
  }

  resize(cols, rows) {
    cols = Math.min(MAX_COLS, Math.max(1, cols | 0)); rows = Math.min(MAX_ROWS, Math.max(1, rows | 0));
    // rows
    if (rows < this.rows) {
      const remove = this.rows - rows;
      for (let i = 0; i < remove; i++) {
        const top = this.grid.shift();
        this._pushScrollback(top); // same bound as the scroll path (F08)
      }
    } else if (rows > this.rows) {
      for (let i = 0; i < rows - this.rows; i++) this.grid.push(this._blankRow());
    }
    this.rows = rows;
    // cols
    for (let y = 0; y < this.rows; y++) {
      const row = this.grid[y];
      if (cols < this.cols) row.length = cols;
      else for (let x = this.cols; x < cols; x++) row[x] = blankCell(null);
    }
    this.cols = cols;
    this.scrollTop = 0; this.scrollBottom = this.rows - 1;
    this.cursor.x = Math.min(this.cursor.x, cols - 1);
    this.cursor.y = Math.min(this.cursor.y, rows - 1);
    this._resetTabs();
    this.markAllDirty();
  }
}

// Exposed as a browser global (renderer is sandboxed; no CommonJS here).
window.HermitVT = Object.assign(window.HermitVT || {}, { Screen, blankCell, MAX_SCROLLBACK, MAX_SCROLLBACK_CELLS });
