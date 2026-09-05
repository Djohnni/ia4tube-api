"use strict";

const crypto = require("node:crypto");
const { postgresFail } = require("../persistence/postgres/errors");
const {
  requirePositiveInteger
} = require("../persistence/postgres/validation");

const VAULT_KEY_BYTES = 32;
const VAULT_KEY_DIGEST_BYTES = 16;
const VAULT_KEY_VERSION_PATTERN =
  /^v([1-9][0-9]{0,15})_([A-Za-z0-9_-]{22})$/;
const VAULT_KEY_VERSION_DOMAIN =
  "ia4tube:social-vault-key-material:v1\0";
const VAULT_KEYRING_FINGERPRINT_DOMAIN =
  "ia4tube:social-vault-keyring-fingerprint:v1\0";
const VAULT_KEYRING_FINGERPRINT_PATTERN =
  /^[A-Za-z0-9_-]{43}$/;

function requireVaultKeyMaterial(value) {
  if (!Buffer.isBuffer(value) || value.length !== VAULT_KEY_BYTES) {
    postgresFail(
      "vault_key_invalid",
      "Material criptografico do cofre recusado."
    );
  }
  return value;
}

function materialDigest(keyMaterial) {
  return crypto
    .createHash("sha256")
    .update(VAULT_KEY_VERSION_DOMAIN, "utf8")
    .update(requireVaultKeyMaterial(keyMaterial))
    .digest()
    .subarray(0, VAULT_KEY_DIGEST_BYTES)
    .toString("base64url");
}

function deriveVaultKeyVersion(generation, keyMaterial) {
  const safeGeneration = requirePositiveInteger(
    generation,
    "vault_key_generation"
  );
  return `v${safeGeneration}_${materialDigest(keyMaterial)}`;
}

function parseVaultKeyVersion(value) {
  if (typeof value !== "string" || value !== value.trim()) {
    postgresFail(
      "key_version_invalid",
      "Versao de chave recusada."
    );
  }
  const match = VAULT_KEY_VERSION_PATTERN.exec(value);
  if (!match) {
    postgresFail(
      "key_version_invalid",
      "Versao de chave recusada."
    );
  }
  const generation = requirePositiveInteger(
    match[1],
    "vault_key_generation"
  );
  if (`v${generation}_${match[2]}` !== value) {
    postgresFail(
      "key_version_invalid",
      "Versao de chave recusada."
    );
  }
  return Object.freeze({
    generation,
    digest: match[2],
    value
  });
}

function requireVaultKeyVersion(value) {
  return parseVaultKeyVersion(value).value;
}

function assertVaultKeyVersionMaterial(value, keyMaterial) {
  const parsed = parseVaultKeyVersion(value);
  const expected = deriveVaultKeyVersion(
    parsed.generation,
    keyMaterial
  );
  const actualBytes = Buffer.from(parsed.value, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  const matches =
    actualBytes.length === expectedBytes.length &&
    crypto.timingSafeEqual(actualBytes, expectedBytes);
  actualBytes.fill(0);
  expectedBytes.fill(0);
  if (!matches) {
    postgresFail(
      "vault_key_version_material_mismatch",
      "Versao e material do cofre divergentes."
    );
  }
  return parsed.value;
}

function vaultKeyringFingerprint(activeVersion, readableVersions) {
  const active = requireVaultKeyVersion(activeVersion);
  if (
    !Array.isArray(readableVersions) ||
    readableVersions.length < 1 ||
    readableVersions.length > 16
  ) {
    postgresFail(
      "vault_keyring_versions_invalid",
      "Conjunto de versoes do cofre recusado."
    );
  }
  const readable = readableVersions
    .map((version) => requireVaultKeyVersion(version))
    .sort();
  if (
    new Set(readable).size !== readable.length ||
    !readable.includes(active)
  ) {
    postgresFail(
      "vault_keyring_versions_invalid",
      "Conjunto de versoes do cofre recusado."
    );
  }
  const canonical = JSON.stringify({
    format: "ia4tube-social-vault-keyring-v1",
    active_version: active,
    readable_versions: readable
  });
  return crypto
    .createHash("sha256")
    .update(VAULT_KEYRING_FINGERPRINT_DOMAIN, "utf8")
    .update(canonical, "utf8")
    .digest("base64url");
}

function requireVaultKeyringFingerprint(value) {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    !VAULT_KEYRING_FINGERPRINT_PATTERN.test(value)
  ) {
    postgresFail(
      "vault_keyring_fingerprint_invalid",
      "Fingerprint do conjunto de chaves recusado."
    );
  }
  return value;
}

function assertVaultKeyringFingerprint(actual, expected) {
  const safeActual = requireVaultKeyringFingerprint(actual);
  const safeExpected = requireVaultKeyringFingerprint(expected);
  const actualBytes = Buffer.from(safeActual, "utf8");
  const expectedBytes = Buffer.from(safeExpected, "utf8");
  const matches = crypto.timingSafeEqual(actualBytes, expectedBytes);
  actualBytes.fill(0);
  expectedBytes.fill(0);
  if (!matches) {
    postgresFail(
      "vault_keyring_fingerprint_mismatch",
      "Conjunto de chaves do cofre divergente."
    );
  }
  return true;
}

module.exports = {
  VAULT_KEY_BYTES,
  VAULT_KEY_DIGEST_BYTES,
  VAULT_KEY_VERSION_DOMAIN,
  VAULT_KEY_VERSION_PATTERN,
  VAULT_KEYRING_FINGERPRINT_DOMAIN,
  VAULT_KEYRING_FINGERPRINT_PATTERN,
  assertVaultKeyringFingerprint,
  assertVaultKeyVersionMaterial,
  deriveVaultKeyVersion,
  parseVaultKeyVersion,
  requireVaultKeyMaterial,
  requireVaultKeyVersion,
  requireVaultKeyringFingerprint,
  vaultKeyringFingerprint
};
