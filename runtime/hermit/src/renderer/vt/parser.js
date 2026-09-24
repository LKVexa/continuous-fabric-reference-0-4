'use strict';

/**
 * VT engine — ANSI/VT parser (state machine)
 * ---------------------------------------------------------------------------
 * A ground/escape/CSI/OSC state machine modeled on the DEC VT500 parser. It
 * decodes a byte stream into semantic operations and dispatches them to a
 * terminal handler (the Screen, plus a couple of controller callbacks).
 *
 * Supported:
 *   C0 controls           BEL BS HT LF VT FF CR
 *   ESC                   7 8 D E M c H (and keypad/charset no-ops)
 *   CSI                   A B C D E F G ` d H f J K L M @ P X S T r m h l s u
 *   private modes         ?25 (DECTCEM cursor show/hide)
 *   OSC                   0/2 ;  window title  (terminated by BEL or ST)
 *   SGR                   0-9, 22-29, 30-37/40-47, 90-97/100-107,
 *                         38/48 (5;n palette and 2;r;g;b truecolor), 39/49
 */

const S = { GROUND: 0, ESC: 1, CSI: 2, OSC: 3, DCS: 4, OSC_ESC: 5, DCS_ESC: 6, CSI_IGNORE: 7 };

// Bounds for attacker-controlled accumulation (series F06 / I034). Remote output is untrusted.
const MAX_OSC = 4096;        // UTF-16 units retained for one OSC string; the rest is discarded
const MAX_TITLE = 256;       // title text handed to the UI
const MAX_PARAMS = 64;       // CSI parameter characters
const MAX_INTERMEDIATES = 4;
const MAX_PARAM_VALUE = 65535;

class Parser {
  /** @param {object} term  the Screen (with optional onTitle callback) */
  constructor(term) {
    this.term = term;
    this.state = S.GROUND;
    this.params = '';
    this.intermediates = '';
    this.osc = '';
    this.oscOverflow = false;
    this.printBuf = '';
  }

  reset() {
    this.state = S.GROUND;
    this.params = this.intermediates = this.osc = this.printBuf = '';
  }

  write(data) {
    for (let i = 0; i < data.length; i++) this._byte(data[i], data.charCodeAt(i));
    this._flush();
  }

  _flush() {
    if (this.printBuf) { this.term.print(this.printBuf); this.printBuf = ''; }
  }

  _byte(ch, code) {
    switch (this.state) {
      case S.GROUND: return this._ground(ch, code);
      case S.ESC: return this._esc(ch, code);
      case S.CSI: return this._csi(ch, code);
      case S.OSC: return this._oscState(ch, code);
      case S.DCS: return this._dcs(ch, code);
      case S.CSI_IGNORE:
        if (code === 0x1b) { this.state = S.ESC; this.intermediates = ''; }
        else if ((code >= 0x40 && code <= 0x7e) || code === 0x18 || code === 0x1a) this.state = S.GROUND;
        return undefined;
      case S.OSC_ESC: return this._stringEsc(ch, code, true);
      case S.DCS_ESC: return this._stringEsc(ch, code, false);
      default: return undefined;
    }
  }

  /* ---- ground ---------------------------------------------------------- */

  _ground(ch, code) {
    if (code === 0x1b) { this._flush(); this.state = S.ESC; this.intermediates = ''; return; }
    if (code === 0x9b) { this._flush(); this.state = S.CSI; this.params = ''; this.intermediates = ''; return; }
    if (code < 0x20) { this._flush(); this._c0(code); return; }
    if (code === 0x7f) return; // DEL ignored
    this.printBuf += ch;
  }

  _c0(code) {
    const t = this.term;
    switch (code) {
      case 0x07: t.bell(); break;
      case 0x08: t.backspace(); break;
      case 0x09: t.tab(); break;
      case 0x0a: case 0x0b: case 0x0c: t.lineFeed(); break;
      case 0x0d: t.carriageReturn(); break;
      default: break;
    }
  }

  /* ---- escape ---------------------------------------------------------- */

  _esc(ch, code) {
    if (code >= 0x20 && code <= 0x2f) { if (this.intermediates.length < MAX_INTERMEDIATES) this.intermediates += ch; return; } // collect, stay
    switch (ch) {
      case '[': this.state = S.CSI; this.params = ''; this.intermediates = ''; return;
      case ']': this.state = S.OSC; this.osc = ''; this.oscOverflow = false; return;
      case 'P': this.state = S.DCS; return;
      case '7': this.term.saveCursor(); break;
      case '8': this.term.restoreCursor(); break;
      case 'D': this.term.index(); break;
      case 'E': this.term.nextLine(); break;
      case 'M': this.term.reverseIndex(); break;
      case 'H': this.term.tabs && this.term.tabs.add(this.term.cursor.x); break; // HTS
      case 'c': this.term.reset(); break;
      default: break; // charset / keypad selectors: no-op
    }
    this.state = S.GROUND;
  }

  /* ---- CSI ------------------------------------------------------------- */

  _csi(ch, code) {
    if (code >= 0x30 && code <= 0x3f) {                                  // params (incl. ? ;)
      if (this.params.length >= MAX_PARAMS) { this.state = S.CSI_IGNORE; return; } // over-long: swallow through its final byte, act on nothing
      this.params += ch; return;
    }
    if (code >= 0x20 && code <= 0x2f) { if (this.intermediates.length < MAX_INTERMEDIATES) this.intermediates += ch; return; } // intermediates
    if (code === 0x1b) { this.state = S.ESC; this.intermediates = ''; return; }   // ESC restarts a sequence
    if (code === 0x18 || code === 0x1a) { this.state = S.GROUND; return; }         // CAN / SUB cancel
    if (code < 0x20) { this._c0(code); return; }                                   // C0 executes inside CSI
    if (code >= 0x40 && code <= 0x7e) { this._dispatchCsi(ch); this.state = S.GROUND; return; }
    // anything else aborts the sequence
    this.state = S.GROUND;
  }

  _numParams() {
    let str = this.params;
    const priv = str.startsWith('?');
    if (priv) str = str.slice(1);
    const parts = str.length ? str.split(';') : [];
    const nums = parts.slice(0, 32).map((p) => (p === '' ? undefined : Math.min(MAX_PARAM_VALUE, parseInt(p, 10))));
    return { nums, priv };
  }

  _dispatchCsi(final) {
    const t = this.term;
    const { nums, priv } = this._numParams();
    const p = (i, d) => (nums[i] === undefined || Number.isNaN(nums[i]) ? d : nums[i]);

    switch (final) {
      case 'A': t.cursorUp(p(0, 1)); break;
      case 'B': t.cursorDown(p(0, 1)); break;
      case 'C': t.cursorForward(p(0, 1)); break;
      case 'D': t.cursorBack(p(0, 1)); break;
      case 'E': t.cursorNextLine(p(0, 1)); break;
      case 'F': t.cursorPrevLine(p(0, 1)); break;
      case 'G': case '`': t.cursorCol(p(0, 1)); break;
      case 'd': t.cursorRow(p(0, 1)); break;
      case 'H': case 'f': t.cursorPos(p(0, 1), p(1, 1)); break;
      case 'J': t.eraseInDisplay(p(0, 0)); break;
      case 'K': t.eraseInLine(p(0, 0)); break;
      case 'L': t.insertLines(p(0, 1)); break;
      case 'M': t.deleteLines(p(0, 1)); break;
      case '@': t.insertChars(p(0, 1)); break;
      case 'P': t.deleteChars(p(0, 1)); break;
      case 'X': t.eraseChars(p(0, 1)); break;
      case 'S': t.scrollUp(p(0, 1)); break;
      case 'T': t.scrollDown(p(0, 1)); break;
      case 'r': t.setScrollRegion(p(0, 1), p(1, t.rows)); break;
      case 'm': t.setSGR(nums.map((n) => (n === undefined ? 0 : n))); break;
      case 'h': t.setMode(nums.filter((n) => n !== undefined), priv); break;
      case 'l': t.resetMode(nums.filter((n) => n !== undefined), priv); break;
      case 's': t.saveCursor(); break;
      case 'u': t.restoreCursor(); break;
      default: break;
    }
  }

  /* ---- OSC ------------------------------------------------------------- */

  _oscState(ch, code) {
    if (code === 0x07) { this._dispatchOsc(); this.state = S.GROUND; return; } // BEL
    if (code === 0x9c) { this._dispatchOsc(); this.state = S.GROUND; return; } // 8-bit ST
    if (code === 0x1b) { this.state = S.OSC_ESC; return; }                      // possible ST: decide on the NEXT byte (F07)
    if (code === 0x18 || code === 0x1a) { this.osc = ''; this.state = S.GROUND; return; } // CAN / SUB cancel
    if (this.osc.length >= MAX_OSC) { this.oscOverflow = true; return; }        // bounded: keep consuming, stop retaining
    this.osc += ch;
  }

  /** After ESC inside OSC/DCS: only `ESC \\` is a String Terminator. Anything else aborts the string
   *  WITHOUT dispatching it, and the byte is processed as the start of a new escape sequence. */
  _stringEsc(ch, code, isOsc) {
    if (ch === '\\') { if (isOsc) this._dispatchOsc(); this.state = S.GROUND; return; }
    this.osc = ''; this.oscOverflow = false;
    this.state = S.ESC; this.intermediates = '';
    this._esc(ch, code);
  }

  _dispatchOsc() {
    const s = this.osc;
    const overflow = this.oscOverflow;
    this.osc = ''; this.oscOverflow = false;
    if (overflow) return;                       // a truncated string is never acted upon
    const semi = s.indexOf(';');
    if (semi < 0) return;
    const code = s.slice(0, semi);
    const val = s.slice(semi + 1);
    // Only title updates are implemented. No clipboard (52), hyperlink (8) or colour queries: a remote
    // stream must not read or write local state. Control characters are stripped from the title.
    if ((code === '0' || code === '2') && this.term.onTitle) this.term.onTitle(val.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, MAX_TITLE));
  }

  /* ---- DCS (ignored) --------------------------------------------------- */

  _dcs(ch, code) {
    // Consume until ST (ESC \) or BEL; we don't implement device control strings.
    if (code === 0x07 || code === 0x9c || code === 0x18 || code === 0x1a) this.state = S.GROUND;
    else if (code === 0x1b) this.state = S.DCS_ESC;
  }
}

window.HermitVT = Object.assign(window.HermitVT || {}, { Parser });
