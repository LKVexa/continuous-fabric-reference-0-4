'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const VERSION = require('../package.json').version;
const LOCK_HINT = 'run `node bin/cfp.js recover-lock <file>` after confirming the owning process has exited';
const sha = x => crypto.createHash('sha256').update(x).digest('hex');
const token = () => crypto.randomBytes(32).toString('base64url');
const id = () => crypto.randomUUID();
function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') {
    // Refuse prototype-pollution gadget keys in any operator-influenced object we hash or compare.
    for (const k of Object.keys(v)) {
      if (k === '__proto__' || k === 'prototype' || k === 'constructor') throw new Error('BAD_OBJECT_KEY');
    }
    return '{' + Object.keys(v).sort().map(k => JSON.stringify(k)+':'+canonical(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}
function timingSafeEqualString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
// Strip bearer tokens and long base64url secrets from operator-facing log lines.
function redactSecrets(text) {
  return String(text ?? '')
    .replace(/Bearer\s+[A-Za-z0-9_-]{16,}/gi, 'Bearer [REDACTED]')
    .replace(/\b[A-Za-z0-9_-]{43}\b/g, '[REDACTED_TOKEN]')
    // 64-hex master / custody key material commonly echoed in operator errors.
    .replace(/\b[0-9a-fA-F]{64}\b/g, '[REDACTED_HEX_KEY]')
    .replace(/CFP_MASTER_KEY(=|\s+)\S+/gi, 'CFP_MASTER_KEY$1[REDACTED]')
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '[REDACTED_PEM]');
}
// Exclusive-ownership lock: fails closed with an operator-readable message instead of a bare EEXIST.
function acquireLock(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let fd;
  try { fd = fs.openSync(file, 'wx', 0o600); }
  catch (e) { if (e.code === 'EEXIST') throw new Error('LOCKED: ' + file + ' exists; ' + LOCK_HINT); throw e; }
  try { try { fs.writeFileSync(fd, String(process.pid)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } } catch(error) { try { fs.unlinkSync(file); } catch {} throw error; }
  return () => { try { if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === String(process.pid)) fs.unlinkSync(file); } catch {} };
}
function atomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file+'.'+id()+'.tmp';
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    try { fs.writeFileSync(fd, JSON.stringify(value,null,2)+'\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch { /* preserve the original failure */ }
    throw error;
  }
}
/** Resolve a user-influenced path; refuse null bytes and empty strings. */
function resolveUserPath(p, label='path') {
  if (typeof p !== 'string' || !p || p.includes('\0')) throw new Error('BAD_PATH: '+label);
  return path.resolve(p);
}
function adapter(python, op, data, sourceRoot) {
  return new Promise((resolve,reject) => {
    const child = spawn(python, ['-I', '-B', path.join(__dirname,'adapters.py')], {
      windowsHide: true, stdio: ['pipe','pipe','pipe'],
      env: {...process.env, PYTHONDONTWRITEBYTECODE:'1', ...(sourceRoot ? {CFP_SOURCE_ROOT:sourceRoot} : {})}
    });
    let out='', err='', settled=false;
    const finish=(e,r)=>{if(settled)return;settled=true;clearTimeout(timer);e?reject(e):resolve(r);};
    const timer=setTimeout(()=>{child.kill();finish(new Error('adapter timeout'));},10000);
    child.on('error',e=>finish(new Error(`ADAPTER_START_FAILED: could not launch Python ${JSON.stringify(python)} (${e.code||e.message}). Set CFP_PYTHON to a working interpreter.`)));child.stdin.on('error',()=>{});
    child.stdout.on('data',b=>{out+=b;if(out.length>262144){child.kill();finish(new Error('adapter output limit'));}});
    child.stderr.on('data',b=>{err=(err+b).slice(-2000);});
    child.on('close',(code,signal)=>{
      if(settled)return;
      const status=signal?`signal ${signal}`:`exit ${code}`;
      const diagnostic=err.trim()?`\n${err.trim()}`:'';
      let r;
      try {r=out.trim()?JSON.parse(out):null;}catch { /* report process evidence below */ }
      if(r&&r.ok===false)return finish(new Error('adapter failed: '+String(r.error||'unspecified adapter error')+diagnostic));
      if(code!==0)return finish(new Error(`ADAPTER_EXIT_FAILED: Python ${JSON.stringify(python)} ended with ${status}.${diagnostic}`));
      if(!out.trim())return finish(new Error(`ADAPTER_EMPTY_OUTPUT: Python ${JSON.stringify(python)} exited successfully but returned no JSON.${diagnostic}`));
      if(!r||r.ok!==true||!Object.hasOwn(r,'result'))return finish(new Error(`ADAPTER_INVALID_OUTPUT: Python returned an invalid adapter response (${status}).${diagnostic}`));
      finish(null,r.result);
    });
    child.stdin.end(JSON.stringify({op,data}));
  });
}
const OPS = ['echo','sha256','model.evaluate','state.merge'];
function payload(op, value) {
  if (!OPS.includes(op)) throw new Error('UNSUPPORTED_OPERATION');
  if (value === undefined || value === null) throw new Error('PAYLOAD_REQUIRED');
  if (Buffer.byteLength(JSON.stringify(value))>16384) throw new Error('PAYLOAD_LIMIT');
  if (['echo','sha256'].includes(op) && typeof value!=='string') throw new Error('TEXT_REQUIRED');
  if (!['echo','sha256'].includes(op) && (!value || typeof value!=='object' || Array.isArray(value))) throw new Error('OBJECT_REQUIRED');
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const k of Object.keys(value)) {
      if (k === '__proto__' || k === 'prototype' || k === 'constructor') throw new Error('BAD_OBJECT_KEY');
    }
  }
  return value;
}
module.exports={ROOT,VERSION,sha,token,id,canonical,atomic,adapter,OPS,payload,timingSafeEqualString,acquireLock,redactSecrets,resolveUserPath};
