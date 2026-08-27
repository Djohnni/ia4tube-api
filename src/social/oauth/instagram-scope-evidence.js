"use strict";

const { INSTAGRAM_OAUTH_SCOPES } = require("./instagram-config");

const COMPONENT = "social_instagram_oauth";
const EVENT = "provider_scope_evidence";
const RESPONSE_FORMATS = new Set([
  "flat_object",
  "data_envelope"
]);
const PERMISSIONS_FORMATS = new Set([
  "absent",
  "csv_string",
  "array",
  "unsupported"
]);

function canonicalScopeNames(value) {
  if (!Array.isArray(value)) return Object.freeze([]);
  const supplied = new Set(
    value
      .filter((scope) => typeof scope === "string")
      .map((scope) => scope.trim())
      .filter((scope) => INSTAGRAM_OAUTH_SCOPES.includes(scope))
  );
  return Object.freeze(
    INSTAGRAM_OAUTH_SCOPES.filter((scope) => supplied.has(scope))
  );
}

function permissionsShape(permissionsPresent, permissions) {
  if (!permissionsPresent) {
    return Object.freeze({ format: "absent", values: [] });
  }
  if (typeof permissions === "string") {
    return Object.freeze({
      format: "csv_string",
      values: permissions.split(",")
    });
  }
  if (Array.isArray(permissions)) {
    return Object.freeze({
      format: "array",
      values: permissions
    });
  }
  return Object.freeze({
    format: "unsupported",
    values: []
  });
}

function sanitizeInstagramScopeEvidence(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (
    value.component !== COMPONENT ||
    value.event !== EVENT ||
    !RESPONSE_FORMATS.has(value.responseFormat) ||
    !PERMISSIONS_FORMATS.has(value.permissionsFormat)
  ) {
    return null;
  }
  const hasScopeList = ["csv_string", "array"].includes(
    value.permissionsFormat
  );
  const grantedScopeNames = hasScopeList
    ? canonicalScopeNames(value.grantedScopeNames)
    : Object.freeze([]);

  return Object.freeze({
    component: COMPONENT,
    event: EVENT,
    responseFormat: value.responseFormat,
    permissionsFormat: value.permissionsFormat,
    grantedScopeNames
  });
}

function createInstagramScopeEvidence(input = {}) {
  const responseFormat = RESPONSE_FORMATS.has(input.responseFormat)
    ? input.responseFormat
    : null;
  if (!responseFormat) return null;
  const shaped = permissionsShape(
    input.permissionsPresent === true,
    input.permissions
  );
  return sanitizeInstagramScopeEvidence({
    component: COMPONENT,
    event: EVENT,
    responseFormat,
    permissionsFormat: shaped.format,
    grantedScopeNames: canonicalScopeNames(shaped.values)
  });
}

function emitInstagramScopeEvidence(logger, evidence) {
  const safe = sanitizeInstagramScopeEvidence(evidence);
  if (!safe) return;
  try {
    const info = logger?.info;
    if (typeof info !== "function") return;
    const pending = info.call(logger, safe);
    if (pending && typeof pending.then === "function") {
      Promise.resolve(pending).catch(() => {});
    }
  } catch {
    // Diagnostic logging must never alter the OAuth result.
  }
}

module.exports = {
  createInstagramScopeEvidence,
  emitInstagramScopeEvidence,
  sanitizeInstagramScopeEvidence
};
