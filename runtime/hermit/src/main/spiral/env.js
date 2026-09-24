'use strict';

/**
 * SPIRAL — Environment
 * ---------------------------------------------------------------------------
 * A scoped variable store with copy-on-write child scopes, used for both shell
 * variables and per-command environments. Values are always strings, mirroring
 * POSIX environment semantics.
 */

class Environment {
  /** @param {Record<string,string>} [seed] @param {Environment|null} [parent] */
  constructor(seed = {}, parent = null) {
    this.parent = parent;
    /** @type {Map<string,string>} */
    this.vars = new Map();
    for (const [k, v] of Object.entries(seed)) this.vars.set(k, String(v));
  }

  get(name) {
    if (this.vars.has(name)) return this.vars.get(name);
    return this.parent ? this.parent.get(name) : undefined;
  }

  set(name, value) {
    this.vars.set(name, value == null ? '' : String(value));
    return this;
  }

  unset(name) {
    return this.vars.delete(name);
  }

  has(name) {
    return this.vars.has(name) || (this.parent ? this.parent.has(name) : false);
  }

  /** Flattened view (child values shadow parent). */
  toObject() {
    const base = this.parent ? this.parent.toObject() : {};
    for (const [k, v] of this.vars) base[k] = v;
    return base;
  }

  /** A child scope for a subshell / command invocation. */
  child(seed = {}) {
    return new Environment(seed, this);
  }
}

module.exports = { Environment };
