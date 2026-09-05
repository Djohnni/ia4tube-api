"use strict";

const { postgresFail } = require("./errors");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_LABEL_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/;
const PROVIDER_PATTERN = /^[a-z][a-z0-9_]{0,49}$/;
const KEY_VERSION_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,49}$/;

function requireUuid(value, field = "id") {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    !UUID_PATTERN.test(value) ||
    value.toLowerCase() === "00000000-0000-0000-0000-000000000000"
  ) {
    postgresFail(`${field}_invalid`, "Identificador social recusado.");
  }
  return value.toLowerCase();
}

function requireSha256(value, field = "digest") {
  if (
    typeof value !== "string" ||
    value !== value.toLowerCase() ||
    !SHA256_PATTERN.test(value)
  ) {
    postgresFail(`${field}_invalid`, "Fingerprint social recusado.");
  }
  return value;
}

function requireSafeLabel(value, field = "label") {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    !SAFE_LABEL_PATTERN.test(value)
  ) {
    postgresFail(`${field}_invalid`, "Identificador de configuracao recusado.");
  }
  return value;
}

function requireProvider(value) {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    !PROVIDER_PATTERN.test(value)
  ) {
    postgresFail("provider_invalid", "Provedor social recusado.");
  }
  return value;
}

function requireKeyVersion(value) {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    !KEY_VERSION_PATTERN.test(value)
  ) {
    postgresFail("key_version_invalid", "Versao de chave recusada.");
  }
  return value;
}

function requirePositiveInteger(value, field = "value") {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    postgresFail(`${field}_invalid`, "Valor numerico recusado.");
  }
  return parsed;
}

module.exports = {
  PROVIDER_PATTERN,
  KEY_VERSION_PATTERN,
  SAFE_LABEL_PATTERN,
  SHA256_PATTERN,
  UUID_PATTERN,
  requirePositiveInteger,
  requireKeyVersion,
  requireProvider,
  requireSafeLabel,
  requireSha256,
  requireUuid
};
