#!/usr/bin/env node
'use strict';
/**
 * PROCESS backend host: one OS process per session; stdin/stdout carry only framed bridge records
 * (protocol/bridge.js: uint32-BE length + strict JSON, terminal bytes as canonical base64). Every byte crossing
 * this boundary is a distinct copy in two address spaces (kit Aliasing invariant) and is charged as such.
 */
const { FrameDecoder, encodeRecord } = require('../protocol/bridge');
const { createWorkerSession } = require('./core');

function diag(level, msg) { try { process.stderr.write(`[worker ${process.pid} conn ${process.env.VWS_W_CONN || '?'}] ${level}: ${String(msg).replace(/[\r\n]+/g, ' ').slice(0, 400)}\n`); } catch { /* noop */ } }
const send = (rec) => process.stdout.write(encodeRecord(rec, 'worker_to_gateway'));
const session = createWorkerSession({
  env: process.env, diag,
  emit: (rec, bytes) => send(bytes ? { ...rec, data: bytes.toString('base64') } : rec),
  onFinished: () => { process.stdout.end(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); }
});
process.stdout.on('drain', () => session.sinkDrained());
process.stdout.on('error', () => process.exit(0));
const decoder = new FrameDecoder({ direction: 'gateway_to_worker',
  onError: (e) => { diag('error', `bridge ${e.code}: ${e.message}`); process.exit(70); },
  onRecord: (rec) => session.handle(rec, rec.t === 'input' ? Buffer.from(rec.data, 'base64') : null) });
process.stdin.on('data', (c) => decoder.push(c));
process.stdin.on('end', () => { if (decoder.end() === 'truncated') diag('warn', 'stdin ended inside a record'); session.shutdown('closed'); });
process.on('SIGTERM', () => session.shutdown('shutdown'));
process.on('SIGINT', () => {});
process.on('uncaughtException', (e) => { diag('error', `uncaught: ${e && e.message}`); try { send({ t: 'exit', code: 70, reason: 'worker_failure' }); } catch { /* noop */ } process.exit(70); });
session.ready();
