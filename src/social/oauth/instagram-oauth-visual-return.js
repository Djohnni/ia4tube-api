"use strict";

const crypto = require("node:crypto");

const RETURN_REFERENCE_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const CONNECTION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_ERROR_CODE_PATTERN = /^[a-z0-9_]{2,96}$/;

function invalidConfiguration() {
  const error = new Error("Retorno visual OAuth indisponivel.");
  error.code = "social_oauth_visual_return_invalid";
  throw error;
}

function normalizeOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    invalidConfiguration();
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname && parsed.pathname !== "/")
  ) {
    invalidConfiguration();
  }
  return parsed.origin;
}

function createInstagramOAuthVisualReturn(options = {}) {
  const publicOrigin = normalizeOrigin(options.publicOrigin);
  const clock = options.clock || Date.now;
  const randomBytes = options.randomBytes || crypto.randomBytes;
  const ttlMs = options.ttlMs || 10 * 60 * 1000;
  const maximumEntries = options.maximumEntries || 500;
  const returnPath = options.returnPath || "/app.html";
  if (
    typeof clock !== "function" ||
    typeof randomBytes !== "function" ||
    !Number.isSafeInteger(ttlMs) ||
    ttlMs < 60 * 1000 ||
    ttlMs > 30 * 60 * 1000 ||
    !Number.isSafeInteger(maximumEntries) ||
    maximumEntries < 10 ||
    maximumEntries > 5000 ||
    typeof returnPath !== "string" ||
    !returnPath.startsWith("/") ||
    returnPath.startsWith("//") ||
    returnPath.includes("?") ||
    returnPath.includes("#")
  ) {
    invalidConfiguration();
  }

  const entries = new Map();

  function now() {
    const value = Number(clock());
    if (!Number.isFinite(value) || value < 1) invalidConfiguration();
    return value;
  }

  function prune(current = now()) {
    for (const [reference, entry] of entries) {
      if (entry.expiresAt <= current) entries.delete(reference);
    }
    while (entries.size >= maximumEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  }

  function reference() {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      let bytes;
      try {
        bytes = randomBytes(24);
      } catch {
        invalidConfiguration();
      }
      if (!Buffer.isBuffer(bytes) || bytes.length !== 24) {
        if (Buffer.isBuffer(bytes)) bytes.fill(0);
        invalidConfiguration();
      }
      let value;
      try {
        value = bytes.toString("base64url");
      } finally {
        bytes.fill(0);
      }
      if (RETURN_REFERENCE_PATTERN.test(value) && !entries.has(value)) {
        return value;
      }
    }
    invalidConfiguration();
  }

  function store(value) {
    const current = now();
    prune(current);
    const opaqueReference = reference();
    entries.set(opaqueReference, Object.freeze({
      ...value,
      callbackSanitized: true,
      expiresAt: current + ttlMs
    }));
    return opaqueReference;
  }

  function recordSuccess(result) {
    if (
      !result ||
      result.ok !== true ||
      result.status !== "authorization_completed" ||
      !CONNECTION_ID_PATTERN.test(result.connectionId || "")
    ) {
      invalidConfiguration();
    }
    return store(Object.freeze({
      ok: true,
      provider: "instagram",
      status: "authorization_completed",
      connectionId: result.connectionId.toLowerCase(),
      code: null
    }));
  }

  function recordError(codeInput) {
    const code = String(codeInput || "");
    if (!SAFE_ERROR_CODE_PATTERN.test(code)) invalidConfiguration();
    const status = code === "social_oauth_state_cancelled"
      ? "authorization_cancelled"
      : code === "social_oauth_state_expired"
        ? "authorization_expired"
        : "authorization_failed";
    return store(Object.freeze({
      ok: false,
      provider: "instagram",
      status,
      connectionId: null,
      code
    }));
  }

  function get(referenceInput) {
    const opaqueReference = String(referenceInput || "");
    if (!RETURN_REFERENCE_PATTERN.test(opaqueReference)) return null;
    const current = now();
    prune(current);
    const entry = entries.get(opaqueReference);
    if (!entry || entry.expiresAt <= current) {
      entries.delete(opaqueReference);
      return null;
    }
    return Object.freeze({
      ok: entry.ok,
      provider: entry.provider,
      status: entry.status,
      connectionId: entry.connectionId,
      code: entry.code,
      callbackSanitized: true
    });
  }

  function redirectUrl(referenceInput) {
    const opaqueReference = String(referenceInput || "");
    if (!RETURN_REFERENCE_PATTERN.test(opaqueReference)) {
      invalidConfiguration();
    }
    const url = new URL(returnPath, publicOrigin);
    url.searchParams.set("review", "instagram-publishing");
    url.searchParams.set("stage", "oauth-return");
    url.searchParams.set("return_ref", opaqueReference);
    return url.toString();
  }

  function destroy() {
    entries.clear();
  }

  return Object.freeze({
    destroy,
    get,
    recordError,
    recordSuccess,
    redirectUrl
  });
}

module.exports = {
  RETURN_REFERENCE_PATTERN,
  createInstagramOAuthVisualReturn
};
