"use strict";

const crypto = require("crypto");

const FORMAT_VERSION = 1;
const AES_ALGORITHM = "aes-256-gcm";
const AES_KEY_BYTES = 32;
const HMAC_KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

class FcmTokenSecurityError extends Error {
  constructor(code) {
    super("Operacao de token FCM recusada por uma regra de seguranca.");
    this.name = "FcmTokenSecurityError";
    this.code = code;
  }
}

function fail(code) {
  throw new FcmTokenSecurityError(code);
}

function encodeBase64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function decodeBase64Url(value, expectedBytes, code) {
  const normalized = String(value || "").trim();
  if (!/^[A-Za-z0-9_-]+$/.test(normalized)) fail(code);

  let decoded;
  try {
    decoded = Buffer.from(normalized, "base64url");
  } catch {
    fail(code);
  }
  if (
    decoded.length !== expectedBytes ||
    encodeBase64Url(decoded) !== normalized
  ) {
    fail(code);
  }
  return decoded;
}

function parseKeyring(env, name, expectedBytes) {
  const serialized = String(env?.[name] || "").trim();
  if (!serialized) fail("fcm_token_keys_missing");

  let parsed;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    fail("fcm_token_keys_invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("fcm_token_keys_invalid");
  }

  const entries = Object.entries(parsed);
  if (entries.length < 1 || entries.length > 8) {
    fail("fcm_token_keys_invalid");
  }

  const keyring = new Map();
  for (const [keyId, encodedKey] of entries) {
    if (!KEY_ID_PATTERN.test(keyId)) fail("fcm_token_key_id_invalid");
    keyring.set(
      keyId,
      decodeBase64Url(encodedKey, expectedBytes, "fcm_token_keys_invalid")
    );
  }
  return keyring;
}

function validateToken(token) {
  const normalized = String(token || "").trim();
  if (!normalized || normalized.length > 4096) {
    fail("fcm_token_invalid");
  }
  return normalized;
}

function validateFingerprint(value) {
  return decodeBase64Url(value, 32, "fcm_token_record_invalid");
}

function validateStoredRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    fail("fcm_token_record_invalid");
  }
  if (record.format_version !== FORMAT_VERSION) {
    fail("fcm_token_format_unsupported");
  }

  const keyId = String(record.key_id || "").trim();
  if (!KEY_ID_PATTERN.test(keyId)) fail("fcm_token_record_invalid");

  const iv = decodeBase64Url(record.iv, IV_BYTES, "fcm_token_record_invalid");
  const tag = decodeBase64Url(record.tag, AUTH_TAG_BYTES, "fcm_token_record_invalid");
  const fingerprint = validateFingerprint(record.fingerprint);
  const ciphertextValue = String(record.ciphertext || "").trim();
  if (
    !ciphertextValue ||
    !/^[A-Za-z0-9_-]+$/.test(ciphertextValue) ||
    ciphertextValue.length > 8192
  ) {
    fail("fcm_token_record_invalid");
  }

  let ciphertext;
  try {
    ciphertext = Buffer.from(ciphertextValue, "base64url");
  } catch {
    fail("fcm_token_record_invalid");
  }
  if (!ciphertext.length || encodeBase64Url(ciphertext) !== ciphertextValue) {
    fail("fcm_token_record_invalid");
  }

  return {
    keyId,
    iv,
    tag,
    fingerprintEncoded: encodeBase64Url(fingerprint),
    ciphertext
  };
}

function aadForRecord({ keyId, fingerprint }) {
  return Buffer.from(
    `ia4tube:fcm-token:v${FORMAT_VERSION}:${keyId}:${fingerprint}`,
    "utf8"
  );
}

function timingSafeEncodedEqual(left, right) {
  try {
    return crypto.timingSafeEqual(
      validateFingerprint(left),
      validateFingerprint(right)
    );
  } catch {
    return false;
  }
}

function createFcmTokenCrypto({
  env = process.env,
  randomBytes = crypto.randomBytes
} = {}) {
  const activeKeyId = String(env.FCM_TOKEN_ACTIVE_KEY_ID || "").trim();
  if (!KEY_ID_PATTERN.test(activeKeyId)) {
    fail(activeKeyId ? "fcm_token_key_id_invalid" : "fcm_token_key_id_missing");
  }

  const encryptionKeys = parseKeyring(
    env,
    "FCM_TOKEN_ENCRYPTION_KEYS_JSON",
    AES_KEY_BYTES
  );
  const hmacKeys = parseKeyring(
    env,
    "FCM_TOKEN_HMAC_KEYS_JSON",
    HMAC_KEY_BYTES
  );
  if (!encryptionKeys.has(activeKeyId) || !hmacKeys.has(activeKeyId)) {
    fail("fcm_token_active_key_missing");
  }

  const encryptionKeyIds = [...encryptionKeys.keys()].sort();
  const hmacKeyIds = [...hmacKeys.keys()].sort();
  if (
    encryptionKeyIds.length !== hmacKeyIds.length ||
    encryptionKeyIds.some((keyId, index) => keyId !== hmacKeyIds[index])
  ) {
    fail("fcm_token_keyrings_mismatch");
  }
  for (const keyId of encryptionKeyIds) {
    if (crypto.timingSafeEqual(encryptionKeys.get(keyId), hmacKeys.get(keyId))) {
      fail("fcm_token_keys_not_independent");
    }
  }

  function fingerprintToken(token, keyId = activeKeyId) {
    const normalizedToken = validateToken(token);
    const key = hmacKeys.get(keyId);
    if (!key) fail("fcm_token_key_unavailable");
    return crypto
      .createHmac("sha256", key)
      .update(normalizedToken, "utf8")
      .digest("base64url");
  }

  function encryptToken(token) {
    const normalizedToken = validateToken(token);
    const key = encryptionKeys.get(activeKeyId);
    const iv = Buffer.from(randomBytes(IV_BYTES));
    if (iv.length !== IV_BYTES) fail("fcm_token_random_iv_invalid");

    const fingerprint = fingerprintToken(normalizedToken, activeKeyId);
    const cipher = crypto.createCipheriv(AES_ALGORITHM, key, iv, {
      authTagLength: AUTH_TAG_BYTES
    });
    cipher.setAAD(aadForRecord({ keyId: activeKeyId, fingerprint }));
    const ciphertext = Buffer.concat([
      cipher.update(normalizedToken, "utf8"),
      cipher.final()
    ]);

    return {
      format_version: FORMAT_VERSION,
      key_id: activeKeyId,
      iv: encodeBase64Url(iv),
      ciphertext: encodeBase64Url(ciphertext),
      tag: encodeBase64Url(cipher.getAuthTag()),
      fingerprint
    };
  }

  function decryptToken(record) {
    const validated = validateStoredRecord(record);
    const key = encryptionKeys.get(validated.keyId);
    if (!key) fail("fcm_token_key_unavailable");

    try {
      const decipher = crypto.createDecipheriv(
        AES_ALGORITHM,
        key,
        validated.iv,
        { authTagLength: AUTH_TAG_BYTES }
      );
      decipher.setAAD(aadForRecord({
        keyId: validated.keyId,
        fingerprint: validated.fingerprintEncoded
      }));
      decipher.setAuthTag(validated.tag);
      const token = validateToken(
        Buffer.concat([
          decipher.update(validated.ciphertext),
          decipher.final()
        ]).toString("utf8")
      );
      if (
        !timingSafeEncodedEqual(
          fingerprintToken(token, validated.keyId),
          validated.fingerprintEncoded
        )
      ) {
        fail("fcm_token_decrypt_failed");
      }
      return token;
    } catch (error) {
      if (error instanceof FcmTokenSecurityError) throw error;
      fail("fcm_token_decrypt_failed");
    }
  }

  function recordMatchesToken(record, token) {
    const validated = validateStoredRecord(record);
    if (!hmacKeys.has(validated.keyId)) fail("fcm_token_key_unavailable");
    return timingSafeEncodedEqual(
      fingerprintToken(token, validated.keyId),
      validated.fingerprintEncoded
    );
  }

  return Object.freeze({
    activeKeyId,
    decryptToken,
    encryptToken,
    fingerprintToken,
    recordMatchesToken,
    validateStoredRecord
  });
}

function isEncryptedFcmTokenRecord(record) {
  return Boolean(
    record &&
    typeof record === "object" &&
    !Array.isArray(record) &&
    Object.prototype.hasOwnProperty.call(record, "format_version")
  );
}

module.exports = {
  AES_KEY_BYTES,
  AUTH_TAG_BYTES,
  FcmTokenSecurityError,
  FORMAT_VERSION,
  HMAC_KEY_BYTES,
  IV_BYTES,
  createFcmTokenCrypto,
  isEncryptedFcmTokenRecord,
  timingSafeEncodedEqual,
  validateStoredRecord
};
