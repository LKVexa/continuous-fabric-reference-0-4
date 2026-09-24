'use strict';
// Software attestation seam for local/operator admission (GAP-06 engineering placeholder).
// Labels are explicit: this is NOT TPM / hardware attestation. Hardware GAP-06 remains BLOCKED.
// Fail-closed when CFP_REQUIRE_ATTESTATION=1 and verification fails or material is absent.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const SCHEMA = 'CFP_SW_ATTEST/1';
const KIND = 'SOFTWARE_OPERATOR_ATTESTATION';
const HARDWARE_STATUS = 'BLOCKED_NOT_TPM';
const NODE_LABEL = 'SOFTWARE_OPERATOR_ATTESTATION_NOT_HARDWARE';

function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKeyDerB64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKeyDerB64: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
  };
}

function loadPrivateKey(pemOrDerB64) {
  if (typeof pemOrDerB64 !== 'string' || !pemOrDerB64) throw new Error('ATTESTATION_KEY_MISSING');
  if (pemOrDerB64.includes('BEGIN')) return crypto.createPrivateKey(pemOrDerB64);
  return crypto.createPrivateKey({ key: Buffer.from(pemOrDerB64, 'base64'), type: 'pkcs8', format: 'der' });
}

function loadPublicKey(pemOrDerB64) {
  if (typeof pemOrDerB64 !== 'string' || !pemOrDerB64) throw new Error('ATTESTATION_PUBKEY_MISSING');
  if (pemOrDerB64.includes('BEGIN')) return crypto.createPublicKey(pemOrDerB64);
  return crypto.createPublicKey({ key: Buffer.from(pemOrDerB64, 'base64'), type: 'spki', format: 'der' });
}

function canonicalAttestBody(body) {
  // Stable signable form; refuse gadget keys.
  const keys = Object.keys(body).sort();
  for (const k of keys) {
    if (k === '__proto__' || k === 'prototype' || k === 'constructor') throw new Error('BAD_OBJECT_KEY');
  }
  return JSON.stringify(body, keys);
}

/**
 * Create a software attestation blob + Ed25519 signature.
 * @returns {{ attestation: object, signature: string, kind: string, hardware: false, tpm: false }}
 */
function createSoftwareAttestation({ nodeId, operations, privateKeyPem, ttlMs = 3600000, clock = Date.now }) {
  if (typeof nodeId !== 'string' || !nodeId || nodeId.length > 64) throw new Error('BAD_ATTESTATION_NODE');
  if (!Array.isArray(operations) || operations.length === 0 || operations.length > 16 || operations.some(x => typeof x !== 'string')) {
    throw new Error('BAD_ATTESTATION_OPS');
  }
  const now = clock();
  const body = {
    schema: SCHEMA,
    kind: KIND,
    hardware: false,
    tpm: false,
    nodeId,
    operations: [...operations],
    issuedAt: now,
    expiresAt: now + Math.max(1000, Number(ttlMs) || 3600000),
    nonce: crypto.randomBytes(16).toString('base64url')
  };
  const payload = Buffer.from(canonicalAttestBody(body), 'utf8');
  if (payload.length > 4096) throw new Error('ATTESTATION_TOO_LARGE');
  const key = loadPrivateKey(privateKeyPem);
  const signature = crypto.sign(null, payload, key).toString('base64');
  return {
    attestation: body,
    signature,
    kind: KIND,
    hardware: false,
    tpm: false,
    label: NODE_LABEL,
    hardwareStatus: HARDWARE_STATUS
  };
}

/**
 * Verify a software attestation. Never claims hardware success.
 * @param {{ attestation: object, signature: string }} presented
 * @param {{ publicKeyPem: string, expectedNodeId?: string, allowedOps?: string[], clock?: function, require?: boolean }} opts
 */
function verifySoftwareAttestation(presented, opts = {}) {
  const requireAtt = opts.require === true || process.env.CFP_REQUIRE_ATTESTATION === '1';
  if (!presented || typeof presented !== 'object') {
    if (requireAtt) throw new Error('ATTESTATION_REQUIRED: software attestation missing (CFP_REQUIRE_ATTESTATION=1); hardware TPM still BLOCKED');
    return { ok: false, skipped: true, kind: null, hardware: false, tpm: false, label: 'OPERATOR_ENROLLED_NOT_HARDWARE_ATTESTED', hardwareStatus: HARDWARE_STATUS };
  }
  const { attestation, signature } = presented;
  if (!attestation || typeof attestation !== 'object' || typeof signature !== 'string' || !signature || signature.length > 256) {
    throw new Error('ATTESTATION_MALFORMED');
  }
  if (attestation.schema !== SCHEMA || attestation.kind !== KIND) throw new Error('ATTESTATION_SCHEMA');
  if (attestation.hardware === true || attestation.tpm === true) throw new Error('ATTESTATION_FALSE_HARDWARE_CLAIM');
  if (attestation.hardware !== false || attestation.tpm !== false) throw new Error('ATTESTATION_HARDWARE_FLAGS');
  if (typeof attestation.nodeId !== 'string' || attestation.nodeId.length > 64) throw new Error('ATTESTATION_NODE');
  if (opts.expectedNodeId && attestation.nodeId !== opts.expectedNodeId) throw new Error('ATTESTATION_NODE_MISMATCH');
  if (!Array.isArray(attestation.operations) || attestation.operations.length === 0 || attestation.operations.length > 16 || attestation.operations.some(op=>typeof op!=='string'||!op)) {
    throw new Error('ATTESTATION_OPS');
  }
  if (opts.allowedOps) {
    for (const op of attestation.operations) {
      if (!opts.allowedOps.includes(op)) throw new Error('ATTESTATION_OP_ESCALATION');
    }
  }
  const clock = opts.clock || Date.now;
  const now = clock();
  if (!Number.isSafeInteger(attestation.issuedAt) || !Number.isSafeInteger(attestation.expiresAt)) throw new Error('ATTESTATION_TIME');
  if (attestation.expiresAt <= now) throw new Error('ATTESTATION_EXPIRED');
  if (attestation.expiresAt<=attestation.issuedAt)throw new Error('ATTESTATION_TIME');
  if (attestation.issuedAt > now + 60000) throw new Error('ATTESTATION_NOT_YET_VALID');
  if (typeof attestation.nonce !== 'string' || attestation.nonce.length > 64) throw new Error('ATTESTATION_NONCE');

  let pub;
  try {
    pub = loadPublicKey(opts.publicKeyPem || process.env.CFP_ATTESTATION_PUBKEY || '');
  } catch (e) {
    if (requireAtt) throw new Error('ATTESTATION_PUBKEY_REQUIRED: set CFP_ATTESTATION_PUBKEY when CFP_REQUIRE_ATTESTATION=1');
    throw e;
  }
  const payload = Buffer.from(canonicalAttestBody({
    schema: attestation.schema,
    kind: attestation.kind,
    hardware: attestation.hardware,
    tpm: attestation.tpm,
    nodeId: attestation.nodeId,
    operations: attestation.operations,
    issuedAt: attestation.issuedAt,
    expiresAt: attestation.expiresAt,
    nonce: attestation.nonce
  }), 'utf8');
  if (payload.length > 4096) throw new Error('ATTESTATION_TOO_LARGE');
  let sigBuf;
  try { sigBuf = Buffer.from(signature, 'base64'); } catch { throw new Error('ATTESTATION_SIG_ENCODING'); }
  if (sigBuf.length !== 64) throw new Error('ATTESTATION_SIG_LENGTH');
  const ok = crypto.verify(null, payload, pub, sigBuf);
  if (!ok) throw new Error('ATTESTATION_SIGNATURE_INVALID');
  return {
    ok: true,
    skipped: false,
    kind: KIND,
    hardware: false,
    tpm: false,
    label: NODE_LABEL,
    hardwareStatus: HARDWARE_STATUS,
    nodeId: attestation.nodeId,
    operations: attestation.operations,
    expiresAt: attestation.expiresAt
  };
}

function loadAttestationMaterial(options = {}) {
  const requireAtt = options.require === true || process.env.CFP_REQUIRE_ATTESTATION === '1';
  let publicKeyPem = process.env.CFP_ATTESTATION_PUBKEY || options.publicKeyPem || null;
  let privateKeyPem = process.env.CFP_ATTESTATION_KEY || options.privateKeyPem || null;
  const pubFile = process.env.CFP_ATTESTATION_PUBKEY_FILE || options.publicKeyFile || null;
  const keyFile = process.env.CFP_ATTESTATION_KEY_FILE || options.privateKeyFile || null;
  if (!publicKeyPem && pubFile) {
    const p = path.resolve(pubFile);
    if (fs.existsSync(p)) publicKeyPem = fs.readFileSync(p, 'utf8');
  }
  if (!privateKeyPem && keyFile) {
    const p = path.resolve(keyFile);
    if (fs.existsSync(p)) privateKeyPem = fs.readFileSync(p, 'utf8');
  }
  if (options.stateDir) {
    const defPub = path.join(options.stateDir, 'attestation-pub.pem');
    const defKey = path.join(options.stateDir, 'attestation-key.pem');
    if (!publicKeyPem && fs.existsSync(defPub)) publicKeyPem = fs.readFileSync(defPub, 'utf8');
    if (!privateKeyPem && fs.existsSync(defKey)) privateKeyPem = fs.readFileSync(defKey, 'utf8');
  }
  if (requireAtt && !publicKeyPem) {
    throw new Error('ATTESTATION_PUBKEY_REQUIRED: set CFP_ATTESTATION_PUBKEY when CFP_REQUIRE_ATTESTATION=1 (software seam only; TPM BLOCKED)');
  }
  return { publicKeyPem, privateKeyPem, requireAtt, kind: KIND, hardwareStatus: HARDWARE_STATUS };
}

function writeKeyPairFiles(dir, pair = generateKeyPair()) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const pub = path.join(dir, 'attestation-pub.pem');
  const key = path.join(dir, 'attestation-key.pem');
  fs.writeFileSync(pub, pair.publicKeyPem, { mode: 0o600 });
  fs.writeFileSync(key, pair.privateKeyPem, { mode: 0o600 });
  try { fs.chmodSync(pub, 0o600); fs.chmodSync(key, 0o600); } catch {}
  return { publicKeyFile: pub, privateKeyFile: key, ...pair };
}

module.exports = {
  SCHEMA, KIND, HARDWARE_STATUS, NODE_LABEL,
  generateKeyPair, createSoftwareAttestation, verifySoftwareAttestation,
  loadAttestationMaterial, writeKeyPairFiles, loadPrivateKey, loadPublicKey
};
