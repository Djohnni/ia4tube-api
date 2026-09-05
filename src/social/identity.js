"use strict";

const crypto = require("node:crypto");
const { postgresFail } = require("../persistence/postgres/errors");
const {
  requireKeyVersion,
  requireUuid
} = require("../persistence/postgres/validation");

function uuidToBytes(uuid) {
  return Buffer.from(requireUuid(uuid, "namespace_uuid").replace(/-/g, ""), "hex");
}

function bytesToUuid(bytes) {
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20)
  ].join("-");
}

function uuidV5(namespace, name) {
  if (
    typeof name !== "string" ||
    name.length < 1 ||
    name.length > 1000
  ) {
    postgresFail("legacy_identity_invalid", "Identidade legada recusada.");
  }
  const digest = crypto
    .createHash("sha1")
    .update(uuidToBytes(namespace))
    .update(Buffer.from(name, "utf8"))
    .digest()
    .subarray(0, 16);
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  return bytesToUuid(digest);
}

function requireDerivationKey(value) {
  if (!Buffer.isBuffer(value) || value.length !== 32) {
    postgresFail(
      "identity_derivation_key_invalid",
      "Chave de identidade social recusada."
    );
  }
  return value;
}

function parseIdentityConfig(env = process.env) {
  const encoded = env.SOCIAL_IDENTITY_DERIVATION_KEY;
  if (
    typeof encoded !== "string" ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
  ) {
    postgresFail(
      "identity_derivation_key_invalid",
      "Chave de identidade social recusada."
    );
  }
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32 || key.toString("base64") !== encoded) {
    key.fill(0);
    postgresFail(
      "identity_derivation_key_invalid",
      "Chave de identidade social recusada."
    );
  }
  try {
    return Object.freeze({
      namespaceUuid: requireUuid(
        env.SOCIAL_TENANT_NAMESPACE_UUID,
        "social_tenant_namespace_uuid"
      ),
      derivationVersion: requireKeyVersion(
        env.SOCIAL_IDENTITY_DERIVATION_VERSION
      ),
      key
    });
  } catch (error) {
    key.fill(0);
    throw error;
  }
}

function digestLegacyIdentity(value, key, domain) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 500 ||
    !["company", "user"].includes(domain)
  ) {
    postgresFail("legacy_identity_invalid", "Identidade legada recusada.");
  }
  return crypto
    .createHmac("sha256", requireDerivationKey(key))
    .update(`${domain}\0`, "utf8")
    .update(value, "utf8")
    .digest("hex");
}

function deriveSocialIdentity({
  namespaceUuid,
  derivationKey,
  derivationVersion,
  legacyCompanyId,
  legacyUserId
} = {}) {
  const version = requireKeyVersion(derivationVersion);
  const companyDigest = digestLegacyIdentity(
    legacyCompanyId,
    derivationKey,
    "company"
  );
  const userDigest = digestLegacyIdentity(
    legacyUserId,
    derivationKey,
    "user"
  );
  return Object.freeze({
    companyId: uuidV5(namespaceUuid, `company:${companyDigest}`),
    userId: uuidV5(namespaceUuid, `user:${companyDigest}:${userDigest}`),
    derivationVersion: version
  });
}

module.exports = {
  deriveSocialIdentity,
  parseIdentityConfig,
  uuidV5
};
