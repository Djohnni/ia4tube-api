"use strict";

const crypto = require("node:crypto");
const { postgresFail } = require("../persistence/postgres/errors");

const KEY_BYTES = 32;
const REQUIRED_EXTERNAL_SECRETS = Object.freeze([
  "JWT_SECRET",
  "ORDER_MEDIA_SIGNING_SECRET"
]);

function secretFail(code) {
  postgresFail(code, "Chaves sociais independentes sao obrigatorias.");
}

function digest(value) {
  return crypto.createHash("sha256").update(value).digest();
}

function constantTimeEqual(left, right) {
  const leftDigest = digest(left);
  const rightDigest = digest(right);
  try {
    return crypto.timingSafeEqual(leftDigest, rightDigest);
  } finally {
    leftDigest.fill(0);
    rightDigest.fill(0);
  }
}

function decodeCanonicalKey(value) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    return null;
  }
  const decoded = Buffer.from(value, "base64");
  if (
    decoded.length !== KEY_BYTES ||
    decoded.toString("base64") !== value
  ) {
    decoded.fill(0);
    return null;
  }
  return decoded;
}

function externalSecretCandidates(env) {
  const candidates = [];
  try {
    for (const name of REQUIRED_EXTERNAL_SECRETS) {
      const value = env[name];
      if (
        typeof value !== "string" ||
        !value ||
        value !== value.trim()
      ) {
        secretFail("social_key_separation_secret_missing");
      }
      candidates.push(Buffer.from(value, "utf8"));
      const decoded = decodeCanonicalKey(value);
      if (decoded) candidates.push(decoded);
    }
    return candidates;
  } catch (error) {
    for (const candidate of candidates) candidate.fill(0);
    throw error;
  }
}

function assertSocialSecretSeparation({
  vaultKeyring,
  identityKey,
  env = process.env
} = {}) {
  if (
    !vaultKeyring ||
    !(vaultKeyring.keys instanceof Map) ||
    !Buffer.isBuffer(identityKey) ||
    identityKey.length !== KEY_BYTES
  ) {
    secretFail("social_key_separation_inputs_invalid");
  }

  const externalCandidates = externalSecretCandidates(env);
  let duplicated = false;
  try {
    for (const vaultKey of vaultKeyring.keys.values()) {
      if (!Buffer.isBuffer(vaultKey) || vaultKey.length !== KEY_BYTES) {
        secretFail("social_key_separation_inputs_invalid");
      }
      duplicated =
        constantTimeEqual(vaultKey, identityKey) || duplicated;
      for (const candidate of externalCandidates) {
        duplicated = constantTimeEqual(vaultKey, candidate) || duplicated;
      }
    }
  } finally {
    for (const candidate of externalCandidates) candidate.fill(0);
  }

  if (duplicated) secretFail("social_key_separation_required");
  return true;
}

module.exports = {
  assertSocialSecretSeparation
};
