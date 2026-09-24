'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { startGateway, Client, rawConnect, getTicketCookie, rid, sleep } = require('../helpers');

let h; test.before(async () => { h = await startGateway({}, { VWS_ALLOWED_ORIGINS: 'https://term.example' }); }); test.after(async () => { await h.stop(); });

test('no credential / wrong credential / malformed header -> 401 before upgrade', async () => {
  assert.strictEqual((await rawConnect(h.port, null)).status, 401);
  assert.strictEqual((await rawConnect(h.port, 'x'.repeat(43))).status, 401);
  assert.strictEqual((await rawConnect(h.port, null, { extra: 'Authorization: Basic YTpi\r\n' })).status, 401);
});
test('Origin: unlisted -> 403 even with a valid credential; listed origin + bearer header is NOT accepted (browser path needs a ticket)', async () => {
  assert.strictEqual((await rawConnect(h.port, h.tokens.alice, { origin: 'https://evil.example' })).status, 403);
  assert.strictEqual((await rawConnect(h.port, h.tokens.alice, { origin: 'null' })).status, 403);
  assert.strictEqual((await rawConnect(h.port, h.tokens.alice, { origin: 'https://term.example.evil.example' })).status, 403);
  assert.strictEqual((await rawConnect(h.port, h.tokens.alice, { origin: 'https://term.example' })).status, 401);
  assert.strictEqual((await rawConnect(h.port, null, { origin: 'https://term.example' })).status, 401, 'a forged allowed Origin is not identity');
});
test('ticket: issued only to an authenticated POST from an allowed origin; HttpOnly+SameSite=Strict+path-scoped; single use; origin-bound; expires', async () => {
  assert.strictEqual((await getTicketCookie(h, 'bad'.repeat(15), 'https://term.example')).status, 401);
  assert.strictEqual((await getTicketCookie(h, h.tokens.alice, 'https://evil.example')).status, 403);
  assert.strictEqual((await fetch(h.http + '/api/ws-ticket')).status, 405);
  const pre = await fetch(h.http + '/api/ws-ticket', { method: 'OPTIONS', headers: { origin: 'https://term.example' } });
  assert.strictEqual(pre.status, 204); assert.strictEqual(pre.headers.get('access-control-allow-origin'), 'https://term.example');
  assert.strictEqual((await fetch(h.http + '/api/ws-ticket', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } })).status, 403);

  const t = await getTicketCookie(h, h.tokens.alice, 'https://term.example');
  assert.strictEqual(t.status, 200); assert.match(t.raw, /HttpOnly/); assert.match(t.raw, /SameSite=Strict/); assert.match(t.raw, /Path=\/ws\/terminal/);
  assert.ok(!t.body.ticket, 'ticket value is not returned in the body unless query mode is enabled');
  // wrong origin burns the ticket
  assert.strictEqual((await rawConnect(h.port, null, { origin: 'https://term.example', extra: `Cookie: ${t.cookie}\r\n` })).status, 101);
  assert.strictEqual((await rawConnect(h.port, null, { origin: 'https://term.example', extra: `Cookie: ${t.cookie}\r\n` })).status, 401, 'replay refused');
  const t2 = await getTicketCookie(h, h.tokens.alice, 'https://term.example');
  assert.strictEqual((await rawConnect(h.port, null, { extra: `Cookie: ${t2.cookie}\r\n` })).status, 401, 'origin binding');
  assert.strictEqual((await rawConnect(h.port, null, { origin: 'https://term.example', extra: `Cookie: ${t2.cookie}\r\n` })).status, 401, 'a failed presentation still consumes the ticket');
  const g = await startGateway({ ticketTtlMs: 120 });
  try { const t3 = await getTicketCookie(g, g.tokens.alice); await sleep(200); assert.strictEqual((await rawConnect(g.port, null, { extra: `Cookie: ${t3.cookie}\r\n` })).status, 401, 'expired'); } finally { await g.stop(); }
});
test('session ids authorize nothing: another connection cannot address a live sid; unknown and foreign sids are indistinguishable', async () => {
  const a = await new Client(h.url, h.tokens.alice).open();
  const b = await new Client(h.url, h.tokens.bob).open();
  const before = a.text();
  // v2 data frames carry no sid: input is bound to the connection that authenticated, so b cannot address a's session at all.
  b.send({ v: 2, type: 'terminal.signal', rid: rid(), sid: a.sid, epoch: a.epoch, payload: { signal: 'SIGINT' } });
  b.send({ v: 2, type: 'terminal.signal', rid: rid(), sid: 'Z'.repeat(24), epoch: a.epoch, payload: { signal: 'SIGINT' } });
  await b.until(() => b.type('error').length >= 2);
  const errs = b.type('error').map((e) => [e.payload.code, e.payload.message]);
  assert.deepStrictEqual(errs[0], errs[1]); assert.strictEqual(errs[0][0], 'FORBIDDEN');
  b.send({ v: 2, type: 'session.close', rid: rid(), sid: a.sid, epoch: a.epoch, payload: { reason: 'user' } });
  await sleep(300);
  assert.strictEqual(a.text(), before, 'victim session saw no injected bytes'); assert.strictEqual(a.closed, null);
  // tenants do not share a filesystem
  await a.run('echo secret-acme > /tmp/leak; cat /tmp/leak', 'secret-acme');
  const out = await b.run('cat /tmp/leak; echo done-$?', /done-\d/);
  assert.ok(!out.includes('secret-acme')); assert.match(out, /no such file/);
  a.close(); b.close();
});
test('stale epoch, replayed rid, duplicated input seq, client-forged server message, second session.open', async () => {
  const c = await new Client(h.url, h.tokens.alice).open();
  c.send({ v: 2, type: 'terminal.signal', rid: rid(), sid: c.sid, epoch: 'x'.repeat(16), payload: { signal: 'SIGINT' } });
  await c.until(() => c.type('error').some((e) => e.payload.code === 'STALE_EPOCH'));
  const r = rid(); const m = { v: 2, type: 'terminal.resize', rid: r, sid: c.sid, epoch: c.epoch, payload: { cols: 90, rows: 30 } };
  c.send(m); c.send(m);
  await c.until(() => c.type('error').some((e) => /duplicate rid/.test(e.payload.message)));
  const seq = c.input('echo once\r'); c.input('echo once\r', { seq });                    // same seq twice: the second is refused
  await c.until(() => c.type('error').some((e) => /input seq/.test(e.payload.message)));
  c.send({ v: 2, type: 'session.exit', sid: c.sid, epoch: c.epoch, payload: { code: 0, reason: 'closed' } });
  await c.until(() => c.type('error').some((e) => e.payload.code === 'UNSUPPORTED'));
  c.send({ v: 2, type: 'session.open', rid: rid(), payload: { cols: 80, rows: 24, mode: 'virtual', creditBytes: 1 } });
  await c.until(() => c.type('error').some((e) => /already open/.test(e.payload.message)));
  await c.until(() => /once\r\n/.test(c.text())); await sleep(200);
  assert.strictEqual((c.text().match(/^once\r?$/gm) || []).length, 1, 'the duplicated input executed exactly once');
  c.close();
});
test('capacity: per-principal and global caps; refused before a worker is spawned; released on close', async () => {
  const g = await startGateway({ maxSessions: 3, maxSessionsPerPrincipal: 2 });
  try {
    const a1 = await new Client(g.url, g.tokens.alice).open(), a2 = await new Client(g.url, g.tokens.alice).open();
    const a3 = new Client(g.url, g.tokens.alice); await a3.opened; await a3.until(() => a3.serverEpoch); a3.send({ v: 2, type: 'session.open', rid: rid(), payload: { cols: 80, rows: 24, mode: 'virtual', creditBytes: 65536 } });
    await a3.until(() => a3.closed); assert.strictEqual(a3.type('error')[0].payload.code, 'LIMIT_EXCEEDED'); assert.strictEqual(a3.closed.code, 1013);
    const b1 = await new Client(g.url, g.tokens.bob).open();
    const n1 = new Client(g.url, g.tokens.nofab); await n1.opened; await n1.until(() => n1.serverEpoch); n1.send({ v: 2, type: 'session.open', rid: rid(), payload: { cols: 80, rows: 24, mode: 'virtual', creditBytes: 65536 } });
    await n1.until(() => n1.closed); assert.strictEqual(n1.type('error')[0].payload.code, 'LIMIT_EXCEEDED');
    a1.close(); await sleep(400);
    const n2 = await new Client(g.url, g.tokens.nofab).open(); assert.ok(n2.sid);
    [a2, b1, n2].forEach((c) => c.close());
  } finally { await g.stop(); }
});
test('revocation ends a live session; revoked token cannot reconnect', async () => {
  const g = await startGateway({ idleMs: 600000 });
  try {
    const c = await new Client(g.url, g.tokens.bob).open();
    const list = g.principals.map((p) => (p.sub === 'bob' ? { ...p, revoked: true } : p));
    await sleep(20); fs.writeFileSync(g.pf, JSON.stringify(list));
    assert.strictEqual((await rawConnect(g.port, g.tokens.bob)).status, 401);
    for (const conn of g.gw.registry.conns) if (!g.gw.registry.identity.stillValid(conn.principal)) { conn._error('UNAUTHORIZED', 'credential revoked or expired', false); conn.end('expired', 1008); } // same code path the 30 s sweep runs
    await c.until(() => c.closed, 5000); assert.strictEqual(c.type('session.exit')[0].payload.reason, 'expired');
  } finally { await g.stop(); }
});
test('secrets and host details never reach the shell, the protocol, or the logs', async () => {
  process.env.VWS_TEST_SECRET = 'sk-live-THIS-MUST-NOT-LEAK';
  const g = await startGateway({ logLevel: 'debug' });
  try {
    const c = await new Client(g.url, g.tokens.alice).open();
    const out = await c.run('env; echo $VWS_TEST_SECRET $PATH-end; cat /proc/self/environ; echo fin-$?', /fin-\d/);
    const produced = out.split('\r\n').filter((l) => !l.includes('›')).join('\n'); // drop the echoed command line itself
    assert.ok(!out.includes('sk-live')); assert.ok(!/VWS_|principals|vws-test-|NODE_|npm_/.test(produced), produced);
    c.close(); await sleep(200);
    const logs = g.logs.join('\n');
    assert.ok(logs.length > 0); assert.ok(!logs.includes(g.tokens.alice)); assert.ok(!logs.includes('sk-live')); assert.ok(!/vws_ticket=|Bearer /.test(logs));
  } finally { delete process.env.VWS_TEST_SECRET; await g.stop(); }
});
test('terminal-escape and command-injection text is data: no host effect', async () => {
  const c = await new Client(h.url, h.tokens.alice).open();
  const marker = `/tmp/vws-pwn-${process.pid}`;
  const out = await c.run(`echo $(touch ${marker}); echo \`touch ${marker}\`; ls ${marker}; echo inj-$?`, /inj-\d/);
  assert.ok(!fs.existsSync(marker), 'no host file was created'); assert.ok(out.includes('$(touch ' + marker + ')'), 'substitution syntax is inert text'); assert.match(out, /no such file/);
  c.close();
});
