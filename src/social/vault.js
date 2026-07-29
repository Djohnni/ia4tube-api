"use strict";

const crypto = require("node:crypto");
const { postgresFail } = require("../persistence/postgres/errors");
const {
  requireKeyVersion,
  requireProvider,
  requireUuid
} = require("../persistence/postgres/validation");

const ALGORITHM = "aes-256-gcm";
const AAD_VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_KEYS = 16;
const SUBJECT_TYPES = new Set(["connection", "oauth_transaction"]);

class SocialVaultError extends Error {
  constructor(code, message = "Operacao do cofre social recusada.") {
    super(message);
    this.name = "SocialVaultError";
    this.code = code;
  }
}

function vaultFail(code) {
  throw new SocialVaultError(code);
}

function decodeKey(encoded) {
  if (
    typeof encoded !== "string" ||
    encoded.length < 43 ||
    encoded.length > 44 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
  ) {
    vaultFail("vault_key_invalid");
  }
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32 || key.toString("base64") !== encoded) {
    vaultFail("vault_key_invalid");
  }
  return key;
}

function parseVaultKeyring(env = process.env) {
  const activeVersion = requireKeyVersion(
    env.SOCIAL_VAULT_ACTIVE_KEY_VERSION
  );
  let parsed;
  try {
    parsed = JSON.parse(env.SOCIAL_VAULT_KEYS_JSON);
  } catch (error) {
    vaultFail("vault_keyring_invalid", error);
  }
  if (
    !parsed ||
    Array.isArray(parsed) ||
    typeof parsed !== "object" ||
    Object.keys(parsed).length < 1 ||
    Object.keys(parsed).length > MAX_KEYS
  ) {
    vaultFail("vault_keyring_invalid");
  }

  const keys = new Map();
  try {
    for (const [version, encoded] of Object.entries(parsed)) {
      const safeVersion = requireKeyVersion(version);
      keys.set(safeVersion, decodeKey(encoded));
    }
    if (!keys.has(activeVersion)) vaultFail("vault_active_key_missing");
    return Object.freeze({ activeVersion, keys });
  } catch (error) {
    for (const key of keys.values()) key.fill(0);
    keys.clear();
    throw error;
  }
}

function requireContext(context = {}) {
  const companyId = requireUuid(context.companyId, "company_id");
  const provider = requireProvider(context.provider);
  const credentialId = requireUuid(context.credentialId, "credential_id");
  const subjectId = requireUuid(context.subjectId, "credential_subject_id");
  const subjectType = String(context.subjectType || "");
  if (!SUBJECT_TYPES.has(subjectType)) {
    vaultFail("vault_subject_type_invalid");
  }
  const credentialType = requireProvider(context.credentialType);
  return Object.freeze({
    companyId,
    provider,
    credentialId,
    subjectType,
    subjectId,
    credentialType
  });
}

function canonicalAad(context, keyVersion) {
  const safe = requireContext(context);
  const version = requireKeyVersion(keyVersion);
  return Buffer.from(
    JSON.stringify({
      aad_version: AAD_VERSION,
      company_id: safe.companyId,
      provider: safe.provider,
      connection_id:
        safe.subjectType === "connection" ? safe.subjectId : null,
      oauth_transaction_id:
        safe.subjectType === "oauth_transaction" ? safe.subjectId : null,
      credential_id: safe.credentialId,
      credential_type: safe.credentialType,
      key_version: version
    }),
    "utf8"
  );
}

function requireEnvelope(envelope = {}) {
  if (
    !Buffer.isBuffer(envelope.ciphertext) ||
    envelope.ciphertext.length < 1 ||
    !Buffer.isBuffer(envelope.nonce) ||
    envelope.nonce.length !== NONCE_BYTES ||
    !Buffer.isBuffer(envelope.authTag) ||
    envelope.authTag.length !== TAG_BYTES ||
    envelope.aadVersion !== AAD_VERSION
  ) {
    vaultFail("vault_envelope_invalid");
  }
  return Object.freeze({
    ciphertext: Buffer.from(envelope.ciphertext),
    nonce: Buffer.from(envelope.nonce),
    authTag: Buffer.from(envelope.authTag),
    keyVersion: requireKeyVersion(envelope.keyVersion),
    aadVersion: envelope.aadVersion
  });
}

function createSocialVault(options = {}) {
  const candidate = options.keyring || parseVaultKeyring(options.env);
  const randomBytes = options.randomBytes || crypto.randomBytes;
  if (
    !candidate ||
    !(candidate.keys instanceof Map) ||
    candidate.keys.size < 1 ||
    candidate.keys.size > MAX_KEYS
  ) {
    vaultFail("vault_keyring_invalid");
  }
  const activeVersion = requireKeyVersion(candidate.activeVersion);
  const keys = new Map();
  const fingerprints = new Set();
  try {
    for (const [rawVersion, rawKey] of candidate.keys.entries()) {
      const version = requireKeyVersion(rawVersion);
      if (!Buffer.isBuffer(rawKey) || rawKey.length !== 32) {
        vaultFail("vault_key_invalid");
      }
      const fingerprint = crypto
        .createHash("sha256")
        .update(rawKey)
        .digest("hex");
      if (fingerprints.has(fingerprint)) {
        vaultFail("vault_duplicate_key_material");
      }
      fingerprints.add(fingerprint);
      keys.set(version, Buffer.from(rawKey));
    }
    if (!keys.has(activeVersion)) vaultFail("vault_active_key_missing");
  } catch (error) {
    for (const key of keys.values()) key.fill(0);
    keys.clear();
    throw error;
  }
  const keyring = Object.freeze({ activeVersion, keys });
  let destroyed = false;

  function assertAvailable() {
    if (destroyed) vaultFail("vault_destroyed");
  }

  function encrypt(plaintext, context) {
    assertAvailable();
    const keyVersion = keyring.activeVersion;
    const key = keyring.keys.get(keyVersion);
    const aad = canonicalAad(context, keyVersion);
    let input;
    try {
      input = Buffer.isBuffer(plaintext)
        ? Buffer.from(plaintext)
        : Buffer.from(String(plaintext || ""), "utf8");
      if (input.length < 1 || input.length > 1024 * 1024) {
        vaultFail("vault_plaintext_invalid");
      }
      const nonce = randomBytes(NONCE_BYTES);
      if (!Buffer.isBuffer(nonce) || nonce.length !== NONCE_BYTES) {
        vaultFail("vault_nonce_invalid");
      }
      const cipher = crypto.createCipheriv(ALGORITHM, key, nonce, {
        authTagLength: TAG_BYTES
      });
      cipher.setAAD(aad);
      const ciphertext = Buffer.concat([
        cipher.update(input),
        cipher.final()
      ]);
      const authTag = cipher.getAuthTag();
      return Object.freeze({
        ciphertext,
        nonce: Buffer.from(nonce),
        authTag,
        keyVersion,
        aadVersion: AAD_VERSION
      });
    } catch (error) {
      if (error instanceof SocialVaultError) throw error;
      vaultFail("vault_encrypt_failed", error);
    } finally {
      if (input) input.fill(0);
      aad.fill(0);
    }
  }

  function decrypt(rawEnvelope, context) {
    assertAvailable();
    const envelope = requireEnvelope(rawEnvelope);
    const key = keyring.keys.get(envelope.keyVersion);
    if (!key) vaultFail("vault_key_version_unavailable");
    const aad = canonicalAad(context, envelope.keyVersion);
    let updated;
    let final;
    try {
      const decipher = crypto.createDecipheriv(
        ALGORITHM,
        key,
        envelope.nonce,
        { authTagLength: TAG_BYTES }
      );
      decipher.setAAD(aad);
      decipher.setAuthTag(envelope.authTag);
      updated = decipher.update(envelope.ciphertext);
      final = decipher.final();
      return Buffer.concat([updated, final]);
    } catch (error) {
      vaultFail("vault_authentication_failed", error);
    } finally {
      if (updated) updated.fill(0);
      if (final) final.fill(0);
      aad.fill(0);
    }
  }

  function rotate(envelope, context) {
    assertAvailable();
    const current = requireEnvelope(envelope);
    if (current.keyVersion === keyring.activeVersion) {
      return Object.freeze({
        changed: false,
        envelope: current
      });
    }
    const plaintext = decrypt(current, context);
    try {
      return Object.freeze({
        changed: true,
        envelope: encrypt(plaintext, context)
      });
    } finally {
      plaintext.fill(0);
    }
  }

  function versions() {
    assertAvailable();
    return Object.freeze({
      active: keyring.activeVersion,
      readable: Object.freeze([...keyring.keys.keys()].sort())
    });
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    for (const key of keyring.keys.values()) key.fill(0);
    keyring.keys.clear();
  }

  return Object.freeze({ decrypt, destroy, encrypt, rotate, versions });
}

module.exports = {
  AAD_VERSION,
  ALGORITHM,
  NONCE_BYTES,
  SocialVaultError,
  TAG_BYTES,
  canonicalAad,
  createSocialVault,
  parseVaultKeyring
};
