'use strict';

/**
 * SPIRAL — Command-line parser
 * ---------------------------------------------------------------------------
 * Turns a raw command line into an executable plan:
 *
 *   line   := andor (";" andor)*
 *   andor  := pipeline (("&&" | "||") pipeline)*
 *   pipeline := command ("|" command)*
 *   command  := word+ redirection*
 *
 * Supports single/double quotes, backslash escapes, `$VAR` / `${VAR}` expansion
 * (double-quoted and unquoted), `~` home expansion, and the redirections
 * `>`, `>>`, `<`. Expansion happens after tokenization so quoting is honored.
 */

/* --------------------------------------------------------------------------
 * tokenizer
 * ------------------------------------------------------------------------ */

const OPERATORS = ['&&', '||', '>>', ';', '|', '>', '<'];

function tokenize(line) {
  const tokens = [];
  let i = 0;
  const n = line.length;

  while (i < n) {
    const ch = line[i];

    // whitespace
    if (ch === ' ' || ch === '\t') { i++; continue; }

    // comment to end of line
    if (ch === '#') break;

    // operators (longest match first)
    let matchedOp = null;
    for (const op of OPERATORS) {
      if (line.startsWith(op, i)) { matchedOp = op; break; }
    }
    if (matchedOp) {
      tokens.push({ type: 'op', value: matchedOp });
      i += matchedOp.length;
      continue;
    }

    // a word (possibly with embedded quotes); track whether any part was quoted
    let word = '';
    let quotedAny = false;
    while (i < n) {
      const c = line[i];
      if (c === ' ' || c === '\t' || c === '#') break;
      if (OPERATORS.some((op) => line.startsWith(op, i))) break;

      if (c === '\\') {
        word += line[i + 1] != null ? line[i + 1] : '';
        i += 2;
        continue;
      }
      if (c === "'") {
        quotedAny = true;
        i++;
        while (i < n && line[i] !== "'") { word += line[i++]; }
        i++; // closing quote
        continue;
      }
      if (c === '"') {
        quotedAny = true;
        i++;
        while (i < n && line[i] !== '"') {
          if (line[i] === '\\' && '"\\$`'.includes(line[i + 1])) {
            word += line[i + 1]; i += 2;
          } else {
            word += line[i++];
          }
        }
        i++; // closing quote
        continue;
      }
      word += c;
      i++;
    }
    tokens.push({ type: 'word', value: word, quoted: quotedAny });
  }
  return tokens;
}

/* --------------------------------------------------------------------------
 * expansion
 * ------------------------------------------------------------------------ */

function expandWord(token, env) {
  let s = token.value;

  // ~ home expansion only for a leading, unquoted tilde
  if (!token.quoted && (s === '~' || s.startsWith('~/'))) {
    const home = env.get('HOME') || '/home/operator';
    s = home + s.slice(1);
  }

  // $VAR and ${VAR}
  s = s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)|\$\?/g,
    (m, braced, bare) => {
      if (m === '$?') return String(env.get('?') ?? '0');
      const name = braced || bare;
      const v = env.get(name);
      return v == null ? '' : v;
    });

  return s;
}

/* --------------------------------------------------------------------------
 * parser
 * ------------------------------------------------------------------------ */

/**
 * @returns {Array<{op: ';'|'&&'|'||'|null, pipeline: Array<Command>}>}
 * where Command = { argv: string[], redirects: Array<{fd,type,target}> }
 */
function parse(line, env) {
  const tokens = tokenize(line);
  const segments = [];
  let current = { op: null, pipeline: [] };
  let cmd = { argv: [], redirects: [] };

  const flushCmd = () => {
    if (cmd.argv.length || cmd.redirects.length) current.pipeline.push(cmd);
    cmd = { argv: [], redirects: [] };
  };
  const flushSeg = (nextOp) => {
    flushCmd();
    if (current.pipeline.length) segments.push(current);
    current = { op: nextOp, pipeline: [] };
  };

  for (let t = 0; t < tokens.length; t++) {
    const tok = tokens[t];
    if (tok.type === 'word') {
      cmd.argv.push(expandWord(tok, env));
      continue;
    }
    // operator
    switch (tok.value) {
      case '|': flushCmd(); break;
      case ';': flushSeg(null); break;
      case '&&': flushSeg('&&'); break;
      case '||': flushSeg('||'); break;
      case '>':
      case '>>':
      case '<': {
        const next = tokens[++t];
        if (!next || next.type !== 'word') throw new Error(`syntax error near '${tok.value}'`);
        cmd.redirects.push({
          type: tok.value === '<' ? 'in' : (tok.value === '>>' ? 'append' : 'out'),
          target: expandWord(next, env)
        });
        break;
      }
      default: break;
    }
  }
  flushSeg(null);

  // Re-thread the leading op of each segment onto the *previous* segment's
  // join semantics: segment[k].op describes how it connects to segment[k-1].
  return segments;
}

module.exports = { tokenize, parse, expandWord };
