'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { load, publicConfig, ConfigError } = require('../../gateway/config');
const { createLogger, safePath } = require('../../gateway/log');
const base = { VWS_PRINCIPALS_FILE: '/x/p.json' };

test('PORT: absent -> 10000; valid kept; malformed or out-of-range PRESENT value is an error, never defaulted', () => {
  assert.strictEqual(load(base).port, 10000); assert.strictEqual(load({ ...base, PORT: '8080' }).port, 8080); assert.strictEqual(load({ ...base, PORT: '65535' }).port, 65535);
  for (const bad of ['0', '65536', '80x', ' 80', '-1', '1e3', '0x50', '080', '８０']) assert.throws(() => load({ ...base, PORT: bad }), ConfigError, bad);
});
test('bind address defaults to all interfaces; loopback-dev auth is refused off loopback; static-file needs a principals file', () => {
  assert.strictEqual(load(base).host, '0.0.0.0');
  assert.throws(() => load({ VWS_AUTH: 'none-loopback-dev' }), /loopback/); assert.ok(load({ VWS_AUTH: 'none-loopback-dev', VWS_HOST: '127.0.0.1' }));
  assert.throws(() => load({}), /VWS_PRINCIPALS_FILE/); assert.throws(() => load({ ...base, VWS_AUTH: 'oidc' }), /VWS_AUTH/);
});
test('origins must be bare exact origins; booleans and integers are strict; dependent settings are checked', () => {
  assert.deepStrictEqual(load({ ...base, VWS_ALLOWED_ORIGINS: 'https://a.example, http://localhost:3000' }).origins, ['https://a.example', 'http://localhost:3000']);
  for (const bad of ['*', 'https://a.example/path', 'a.example', 'ftp://a.example', 'https://*.example']) assert.throws(() => load({ ...base, VWS_ALLOWED_ORIGINS: bad }), ConfigError, bad);
  assert.throws(() => load({ ...base, VWS_FABRIC: 'yes' }), ConfigError); assert.throws(() => load({ ...base, VWS_FABRIC: '1' }), /DF_ROOT/);
  assert.throws(() => load({ ...base, VWS_SNAPSHOTS: '1' }), /LOCAL_VOLATILE/); assert.throws(() => load({ ...base, VWS_PROFILE: 'DURABLE_HYBRID' }), /not implemented/); assert.throws(() => load({ ...base, VWS_WORKER_BACKEND: 'fiber' }), /thread or process/); assert.throws(() => load({ ...base, VWS_MAX_SESSIONS: '0' }), ConfigError);
  assert.throws(() => load({ ...base, VWS_HEARTBEAT_MS: '1000', VWS_HEARTBEAT_WINDOW_MS: '5000' }), /HEARTBEAT/);
  assert.ok(Object.isFrozen(load(base)));
});
test('public configuration is an explicit allowlist (no paths, files, limits internals or environment)', () => {
  const pub = publicConfig(load({ ...base, VWS_FABRIC: '1', DF_ROOT: '/srv/secret-df' }));
  assert.deepStrictEqual(Object.keys(pub).sort(), ['auth', 'capabilities', 'creditWindowBytes', 'heartbeatMs', 'profile', 'protocol', 'ticketPath', 'wsPath']);
  assert.ok(!JSON.stringify(pub).includes('secret-df')); assert.strictEqual(pub.capabilities.fabric, true);
});
test('logger: single-line JSON, secret-like fields dropped, newlines neutralised, query strings removed from paths', () => {
  const lines = []; const log = createLogger('debug', (l) => lines.push(l));
  log.info('x', { token: 't', cookie: 'c', authorization: 'a', ticket: 'k', payload: 'p', data: 'd', secretKey: 's', reason: 'line1\nline2', conn: 'abc' });
  const rec = JSON.parse(lines[0]); assert.deepStrictEqual(Object.keys(rec).sort(), ['conn', 'event', 'level', 'reason', 'ts']); assert.strictEqual(rec.reason, 'line1 line2'); assert.strictEqual(lines[0].includes('\n'), false);
  assert.strictEqual(safePath('/ws/terminal?ticket=SECRET'), '/ws/terminal');
  createLogger('silent', (l) => lines.push(l)).error('y'); assert.strictEqual(lines.length, 1);
});
