'use strict';
// Encrypted-at-rest custody for .state secrets (tokens, grants, enrollment configs).
// AES-256-GCM via Node crypto. Key: CFP_MASTER_KEY (64 hex / base64 32B) or CFP_MASTER_KEY_FILE
// (raw 32B, 64 hex, or base64). Fail closed when CFP_REQUIRE_ENCRYPTION=1 and no key.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const SCHEMA = 'CFP_ENC/1';
const ALG = 'aes-256-gcm';
const SECRET_BASENAMES = new Set([
  'operator-login.json',
  'local-agent.json',
  'agents.json'
]);
// principals.json stays plaintext JSON for HERMIT's static-file auth reader (hashes only; no bearer secrets).

function isSecretPath(file) {
  const base = path.basename(file);
  if (SECRET_BASENAMES.has(base)) return true;
  // Enrolled agent private configs: <name>-agent.json
  if (/-agent\.json$/i.test(base) && base !== 'local-agent.json') return true;
  return false;
}

function parseKeyMaterial(raw, label) {
  if (raw == null) throw new Error('MASTER_KEY_MISSING: ' + label);
  if (Buffer.isBuffer(raw)) {
    if (raw.length === 32) return raw;
    const text = raw.toString('utf8').trim();
    return parseKeyMaterial(text, label);
  }
  const s = String(raw).trim();
  if (/^[0-9a-fA-F]{64}$/.test(s)) return Buffer.from(s, 'hex');
  try {
    const b = Buffer.from(s, 'base64');
    if (b.length === 32) return b;
  } catch {}
  throw new Error('MASTER_KEY_INVALID: expect 32 bytes as 64-hex or base64 (' + label + ')');
}

function loadMasterKey(options = {}) {
  const requireEnc = options.require === true || process.env.CFP_REQUIRE_ENCRYPTION === '1';
  if (process.env.CFP_MASTER_KEY) {
    return { key: parseKeyMaterial(process.env.CFP_MASTER_KEY, 'CFP_MASTER_KEY'), source: 'env', requireEnc };
  }
  const keyFile = process.env.CFP_MASTER_KEY_FILE || options.keyFile || null;
  if (keyFile) {
    const p = path.resolve(keyFile);
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) {
      throw new Error('MASTER_KEY_FILE_MISSING: ' + p);
    }
    return { key: parseKeyMaterial(fs.readFileSync(p), 'CFP_MASTER_KEY_FILE'), source: 'file:' + p, requireEnc };
  }
  if (options.stateDir) {
    const def = path.join(options.stateDir, 'master.key');
    if (fs.existsSync(def) && fs.statSync(def).isFile()) {
      return { key: parseKeyMaterial(fs.readFileSync(def), 'master.key'), source: 'file:' + def, requireEnc };
    }
  }
  if (requireEnc) throw new Error('MASTER_KEY_REQUIRED: set CFP_MASTER_KEY or CFP_MASTER_KEY_FILE when CFP_REQUIRE_ENCRYPTION=1');
  return { key: null, source: null, requireEnc };
}

function isEnvelope(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && value.schema === SCHEMA && value.alg === 'AES-256-GCM'
    && typeof value.iv === 'string' && typeof value.tag === 'string' && typeof value.ciphertext === 'string';
}

function encryptJson(value, key) {
  if (!key || key.length !== 32) throw new Error('MASTER_KEY_REQUIRED');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALG, key, iv);
  const plain = Buffer.from(JSON.stringify(value), 'utf8');
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    schema: SCHEMA,
    alg: 'AES-256-GCM',
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: enc.toString('base64')
  };
}

function decryptJson(envelope, key) {
  if (!isEnvelope(envelope)) throw new Error('NOT_ENCRYPTED_ENVELOPE');
  if (!key || key.length !== 32) throw new Error('MASTER_KEY_REQUIRED');
  let iv, tag, data;
  try {
    iv = Buffer.from(envelope.iv, 'base64');
    tag = Buffer.from(envelope.tag, 'base64');
    data = Buffer.from(envelope.ciphertext, 'base64');
  } catch {
    throw new Error('ENVELOPE_ENCODING');
  }
  // AES-256-GCM: 12-byte IV and 16-byte auth tag are required; refuse odd lengths fail-closed.
  if (iv.length !== 12) throw new Error('ENVELOPE_IV_LENGTH');
  if (tag.length !== 16) throw new Error('ENVELOPE_TAG_LENGTH');
  if (data.length > 8 * 1024 * 1024) throw new Error('ENVELOPE_CIPHERTEXT_LIMIT');
  const decipher = crypto.createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(data), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

function atomicWrite(file,value){return require('./common').atomic(file,value);}

/** Write a secret file encrypted when a key is available; refuse plaintext when requireEnc. */
function writeSecret(file, value, keyCtx) {
  const ctx = keyCtx || loadMasterKey({ stateDir: path.dirname(file) });
  if (ctx.key) {
    atomicWrite(file, encryptJson(value, ctx.key));
    return { encrypted: true };
  }
  if (ctx.requireEnc) throw new Error('MASTER_KEY_REQUIRED: refusing plaintext secret write');
  atomicWrite(file, value);
  return { encrypted: false };
}

/**
 * Read a secret file. Migrates plaintext to encrypted form when a key is present.
 * Refuses encrypted-without-key and plaintext-when-requireEnc.
 */
function readSecret(file, keyCtx) {
  const raw = fs.readFileSync(file, 'utf8');
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { throw new Error('SECRET_UNREADABLE: ' + file); }
  const ctx = keyCtx || loadMasterKey({ stateDir: path.dirname(file) });
  if (isEnvelope(parsed)) {
    if (!ctx.key) throw new Error('MASTER_KEY_REQUIRED: encrypted secret at ' + file);
    return decryptJson(parsed, ctx.key);
  }
  // Plaintext legacy
  if (ctx.requireEnc && !ctx.key) throw new Error('MASTER_KEY_REQUIRED: plaintext secret refused under CFP_REQUIRE_ENCRYPTION');
  if (ctx.requireEnc && ctx.key) {
    // migrate then return
    atomicWrite(file, encryptJson(parsed, ctx.key));
    return parsed;
  }
  if (ctx.key) {
    // opportunistic migrate when key present
    atomicWrite(file, encryptJson(parsed, ctx.key));
  }
  return parsed;
}

/** Ensure stateDir secrets are encrypted or refuse when required. Called at start. */
function enforceCustody(stateDir, keyCtx) {
  const ctx = keyCtx || loadMasterKey({ stateDir });
  if (!fs.existsSync(stateDir)) return { migrated: [], encrypted: !!ctx.key, requireEnc: ctx.requireEnc };
  const migrated = [];
  const entries = fs.readdirSync(stateDir);
  for (const name of entries) {
    const full = path.join(stateDir, name);
    if (!fs.statSync(full).isFile()) continue;
    if (!isSecretPath(full)) continue;
    const raw = fs.readFileSync(full, 'utf8');
    let parsed;
    try { parsed = JSON.parse(raw); } catch { throw new Error('SECRET_UNREADABLE: ' + full); }
    if (isEnvelope(parsed)) {
      if (!ctx.key) throw new Error('MASTER_KEY_REQUIRED: encrypted secret at ' + full);
      decryptJson(parsed, ctx.key); // verify decryptable
      continue;
    }
    if (ctx.requireEnc && !ctx.key) throw new Error('PLAINTEXT_SECRET_REFUSED: ' + name + ' (set CFP_MASTER_KEY)');
    if (ctx.key) {
      atomicWrite(full, encryptJson(parsed, ctx.key));
      migrated.push(name);
    } else if (ctx.requireEnc) {
      throw new Error('PLAINTEXT_SECRET_REFUSED: ' + name);
    }
  }
  return { migrated, encrypted: !!ctx.key, requireEnc: ctx.requireEnc, source: ctx.source };
}

function generateMasterKeyHex() {
  return crypto.randomBytes(32).toString('hex');
}

function writeMasterKeyFile(file, hex = generateMasterKeyHex()) {
  const key = parseKeyMaterial(hex, 'new-master-key');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const fd=fs.openSync(file,'wx',0o600);
  try {try {fs.writeFileSync(fd,key.toString('hex')+'\n');fs.fsyncSync(fd);} finally {fs.closeSync(fd);}}
  catch(error){try{fs.unlinkSync(file);}catch{}throw error;}
  return {file,hex:key.toString('hex'),key};
}

module.exports = {
  SCHEMA, isSecretPath, isEnvelope, loadMasterKey, encryptJson, decryptJson,
  writeSecret, readSecret, enforceCustody, generateMasterKeyHex, writeMasterKeyFile, parseKeyMaterial
};
