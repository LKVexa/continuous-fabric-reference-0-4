'use strict';
/**
 * Single-use WebSocket admission tickets (series I013).
 * A browser cannot attach an Authorization header to a WebSocket, so it first
 * exchanges its bearer credential (sent in a header, never ambient) for a ticket:
 *   - 256 bits of CSPRNG, opaque, base64url
 *   - only a SHA-256 verifier is retained server-side
 *   - bound to principal + exact Origin + purpose 'ws'
 *   - short TTL (default 30 s), consumed atomically on first presentation
 *   - bounded store; delivered as an HttpOnly SameSite=Strict cookie scoped to /ws/terminal
 */
const crypto = require('node:crypto');

function createTickets({ ttlMs = 30000, max = 1024 } = {}) {
  const store = new Map(); // verifierHex -> { principal, origin, exp }
  const sweep = () => { const now = Date.now(); for (const [k, v] of store) if (v.exp <= now) store.delete(k); };
  return {
    issue(principal, origin) {
      sweep();
      if (store.size >= max) return null;
      const ticket = crypto.randomBytes(32).toString('base64url');
      store.set(crypto.createHash('sha256').update(ticket).digest('hex'), { principal, origin: origin || null, exp: Date.now() + ttlMs });
      return ticket;
    },
    /** @returns principal or null. The ticket is deleted whether or not the binding matches. */
    consume(ticket, origin) {
      if (typeof ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(ticket)) return null;
      const k = crypto.createHash('sha256').update(ticket).digest('hex');
      const rec = store.get(k);
      if (!rec) return null;
      store.delete(k);
      if (rec.exp <= Date.now()) return null;
      if ((rec.origin || null) !== (origin || null)) return null;
      return rec.principal;
    },
    size: () => { sweep(); return store.size; }
  };
}

function cookieValue(req, name) {
  const h = req.headers.cookie;
  if (typeof h !== 'string' || h.length > 4096) return null;
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

module.exports = { createTickets, cookieValue };
