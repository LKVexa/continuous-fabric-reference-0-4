'use strict';

/**
 * SPIRAL — Interactive line reader (readline discipline)
 * ---------------------------------------------------------------------------
 * A backend-side line editor. It consumes the raw key stream from the renderer
 * and emits ANSI/VT sequences to redraw the input line, exactly as a real shell
 * would over a PTY. This is what gives the terminal its cursor movement, history
 * recall, kill-ring editing and completion — and it exercises the renderer's VT
 * engine end to end.
 *
 * The renderer forwards keys as their conventional byte encodings:
 *   printable      -> the character(s)
 *   Enter          -> "\r"
 *   Backspace      -> "\x7f"
 *   Ctrl-<X>       -> the corresponding control byte
 *   Arrows/Home/…  -> CSI / SS3 sequences ("\x1b[A", "\x1bOD", "\x1b[3~", …)
 */

const ESC = '\x1b';
const CSI = '\x1b[';

/** Visible width of a string, ignoring SGR/ANSI escape sequences. */
function visibleWidth(s) {
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').length;
}

class LineReader {
  /**
   * @param {object} io
   * @param {(s:string)=>void} io.write      emit bytes to the terminal
   * @param {string}           io.prompt     prompt string (may contain SGR)
   * @param {string[]}         io.history    shared history array (mutated by kernel)
   * @param {(buf:string,cur:number)=>{replace:string,cursor:number}|null} io.completer
   */
  constructor(io) {
    this.write = io.write;
    this.prompt = io.prompt || '';
    this.history = io.history || [];
    this.completer = io.completer || null;
    this.maxChars = Number.isFinite(io.maxChars) ? io.maxChars : 4096;
    this.done = false;

    this.buf = '';
    this.cur = 0;
    this.escBuf = '';
    this.histIndex = this.history.length; // one past the end == "current line"
    this.savedLine = '';
    this.lastTab = false;

    this._resolve = null;
    this.promise = new Promise((res) => { this._resolve = res; });
  }

  start() {
    this.write(this.prompt);
    return this.promise;
  }

  _finish(value) {
    this.done = true;
    if (this._resolve) {
      const r = this._resolve;
      this._resolve = null;
      r(value);
    }
  }

  /* ---- rendering ------------------------------------------------------- */

  _repaint() {
    // Clear the whole line, rewrite prompt + buffer, then reposition cursor.
    this.write('\r' + CSI + '2K' + this.prompt + this.buf);
    const col = visibleWidth(this.prompt) + this.cur;
    this.write('\r');
    if (col > 0) this.write(CSI + col + 'C');
  }

  /* ---- input ----------------------------------------------------------- */

  /** @returns {string} unconsumed remainder (bytes after Enter/abort belong to the NEXT reader) */
  feed(data) {
    for (let i = 0; i < data.length; i++) {
      if (this.done) return data.slice(i);
      const ch = data[i];

      if (this.escBuf) {
        this.escBuf += ch;
        const consumed = this._tryEscape();
        if (consumed === 'incomplete') continue;
        if (consumed === 'flush') {
          const literal = this.escBuf;
          this.escBuf = '';
          this._insert(literal.slice(1)); // drop the lone ESC
        }
        continue;
      }

      if (ch === ESC) { this.escBuf = ESC; continue; }

      // RAMWS (kit R17/R19): a run of ordinary printable characters in one chunk (a paste, a fast typist, a
      // multi-byte character) is inserted with ONE repaint instead of one repaint per character. Same screen
      // result; O(n) instead of O(n^2) bytes emitted for an n-character paste.
      if (ch.charCodeAt(0) >= 0x20 && ch !== '\x7f') {
        let j = i + 1;
        while (j < data.length) { const c = data.charCodeAt(j); if (c < 0x20 || c === 0x7f) break; j++; }
        if (j - i > 1) { this.lastTab = false; this._insert(data.slice(i, j)); i = j - 1; continue; }
      }

      const isTab = ch === '\t';
      if (!isTab) this.lastTab = false;
      this._control(ch, isTab);
    }
    return '';
  }

  _tryEscape() {
    const s = this.escBuf;
    if (s.length > 16) return 'flush'; // bounded escape accumulation
    // Complete CSI/SS3 sequences we care about.
    const map = {
      '\x1b[A': 'up', '\x1bOA': 'up',
      '\x1b[B': 'down', '\x1bOB': 'down',
      '\x1b[C': 'right', '\x1bOC': 'right',
      '\x1b[D': 'left', '\x1bOD': 'left',
      '\x1b[H': 'home', '\x1bOH': 'home', '\x1b[1~': 'home', '\x1b[7~': 'home',
      '\x1b[F': 'end', '\x1bOF': 'end', '\x1b[4~': 'end', '\x1b[8~': 'end',
      '\x1b[3~': 'delete'
    };
    if (map[s]) { this.escBuf = ''; this._key(map[s]); return 'done'; }

    // Still possibly building a known sequence?
    const couldGrow = Object.keys(map).some((k) => k.startsWith(s));
    if (couldGrow) return 'incomplete';
    // Partial CSI awaiting final byte (e.g. "\x1b[" or "\x1b[3")
    if (/^\x1b(\[|O)[0-9;]*$/.test(s)) return 'incomplete';
    return 'flush';
  }

  _key(name) {
    switch (name) {
      case 'left': if (this.cur > 0) { this.cur--; this._repaint(); } break;
      case 'right': if (this.cur < this.buf.length) { this.cur++; this._repaint(); } break;
      case 'home': this.cur = 0; this._repaint(); break;
      case 'end': this.cur = this.buf.length; this._repaint(); break;
      case 'delete':
        if (this.cur < this.buf.length) {
          this.buf = this.buf.slice(0, this.cur) + this.buf.slice(this.cur + 1);
          this._repaint();
        }
        break;
      case 'up': this._history(-1); break;
      case 'down': this._history(1); break;
      default: break;
    }
  }

  _control(ch, isTab) {
    const code = ch.charCodeAt(0);
    switch (ch) {
      case '\r':
      case '\n':
        this.write('\r\n');
        this._finish(this.buf);
        return;
      case '\x7f': // backspace
      case '\x08':
        if (this.cur > 0) {
          this.buf = this.buf.slice(0, this.cur - 1) + this.buf.slice(this.cur);
          this.cur--;
          this._repaint();
        }
        return;
      case '\x03': // Ctrl-C
        this.write('^C\r\n');
        this.buf = ''; this.cur = 0;
        this._finish({ aborted: true });
        return;
      case '\x04': // Ctrl-D (EOF only on empty line)
        if (this.buf.length === 0) { this._finish(null); return; }
        return;
      case '\x01': this.cur = 0; this._repaint(); return;             // home
      case '\x05': this.cur = this.buf.length; this._repaint(); return; // end
      case '\x02': this._key('left'); return;
      case '\x06': this._key('right'); return;
      case '\x15': // kill to start
        this.buf = this.buf.slice(this.cur); this.cur = 0; this._repaint(); return;
      case '\x0b': // kill to end
        this.buf = this.buf.slice(0, this.cur); this._repaint(); return;
      case '\x17': this._killWord(); return; // Ctrl-W
      case '\x0c': // Ctrl-L clear screen
        this.write(CSI + '2J' + CSI + 'H'); this._repaint(); return;
      case '\t': this._complete(); return;
      default:
        if (code >= 0x20) this._insert(ch);
        return;
    }
  }

  _insert(str) {
    if (this.buf.length + str.length > this.maxChars) { this.write('\x07'); return; } // bounded line: bell, drop
    this.buf = this.buf.slice(0, this.cur) + str + this.buf.slice(this.cur);
    this.cur += str.length;
    this._repaint();
  }

  _killWord() {
    let i = this.cur;
    while (i > 0 && this.buf[i - 1] === ' ') i--;
    while (i > 0 && this.buf[i - 1] !== ' ') i--;
    this.buf = this.buf.slice(0, i) + this.buf.slice(this.cur);
    this.cur = i;
    this._repaint();
  }

  _history(dir) {
    if (!this.history.length) return;
    if (this.histIndex === this.history.length) this.savedLine = this.buf;
    const next = this.histIndex + dir;
    if (next < 0 || next > this.history.length) return;
    this.histIndex = next;
    this.buf = next === this.history.length ? this.savedLine : this.history[next];
    this.cur = this.buf.length;
    this._repaint();
  }

  _complete() {
    if (!this.completer) return;
    const res = this.completer(this.buf, this.cur);
    if (!res) return;
    if (Array.isArray(res.candidates) && res.candidates.length > 1 && this.lastTab) {
      // Second Tab: list options on a fresh line, then redraw.
      this.write('\r\n' + res.candidates.join('  ') + '\r\n');
      this._repaint();
      this.lastTab = false;
      return;
    }
    if (res.replace != null && res.replace.length <= this.maxChars) {
      this.buf = res.replace;
      this.cur = res.cursor != null ? res.cursor : res.replace.length;
      this._repaint();
    }
    this.lastTab = Array.isArray(res.candidates) && res.candidates.length > 1;
  }
}

module.exports = { LineReader, visibleWidth };
