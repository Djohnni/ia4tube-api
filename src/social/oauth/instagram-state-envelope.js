"use strict";

const crypto = require("node:crypto");
const { TextDecoder } = require("node:util");
const { postgresFail } = require("../../persistence/postgres/errors");
const {
  INSTAGRAM_OAUTH_REDIRECT_URI,
  INSTAGRAM_PRODUCTION_ORIGIN,
  INSTAGRAM_PROVIDER
} = require("./instagram-config");

const INSTAGRAM_OAUTH_STATE_VERSION = "v1";
const INSTAGRAM_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const INSTAGRAM_OAUTH_STATE_FUTURE_SKEW_MS = 30 * 1000;
const INSTAGRAM_OAUTH_STATE_MAX_LENGTH = 2048;
const INSTAGRAM_OAUTH_STATE_MAX_CIPHERTEXT_BYTES = 1400;
const INSTAGRAM_OAUTH_STATE_IV_BYTES = 12;
const INSTAGRAM_OAUTH_STATE_TAG_BYTES = 16;
const INSTAGRAM_OAUTH_STATE_CSRF_BYTES = 32;
const INSTAGRAM_OAUTH_STATE_HKDF_SALT =
  "ia4tube-social-oauth-state-v1";
const INSTAGRAM_OAUTH_STATE_HKDF_INFO =
  "instagram-oauth-state-envelope";
const INSTAGRAM_OAUTH_RETURN_PATH_IDS = Object.freeze([
  "social_connections"
]);

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEY_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$/;
const SAFE_LABEL_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const PURPOSES = new Set(["connect", "reconnect"]);
const AUTHENTICATED_STATES = new WeakSet();
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

function stateFail(code = "social_oauth_state_invalid") {
  postgresFail(code, "State OAuth Instagram recusado.");
}

function strictRecord(value, expectedKeys) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    stateFail();
  }
  const keys = Object.keys(value);
  if (
    keys.length !== expectedKeys.length ||
    expectedKeys.some((key) => !Object.hasOwn(value, key))
  ) {
    stateFail();
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set) stateFail();
  }
  return value;
}

function requireUuid(value) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) stateFail();
  return value;
}

function requireBoundedSecret(value, minimum, maximum) {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length < minimum ||
    value.length > maximum ||
    /[\u0000-\u0020\u007f]/.test(value)
  ) {
    stateFail();
  }
  return value;
}

function requireKeyVersion(value) {
  if (typeof value !== "string" || !KEY_VERSION_PATTERN.test(value)) {
    stateFail();
  }
  return value;
}

function compactKeyVersion(value) {
  return Buffer.from(requireKeyVersion(value), "utf8").toString("base64url");
}

function requirePurpose(value) {
  if (!PURPOSES.has(value)) stateFail();
  return value;
}

function requireReturnPathId(value, allowedReturnPathIds) {
  if (
    typeof value !== "string" ||
    !SAFE_LABEL_PATTERN.test(value) ||
    !allowedReturnPathIds.has(value)
  ) {
    stateFail();
  }
  return value;
}

function requireClock(clock) {
  const now = typeof clock === "function" ? clock : clock?.now;
  if (typeof now !== "function") stateFail();
  return () => {
    const value = now.call(clock);
    const milliseconds = value instanceof Date ? value.getTime() : value;
    if (
      !Number.isSafeInteger(milliseconds) ||
      milliseconds < 0
    ) {
      stateFail();
    }
    return milliseconds;
  };
}

function requireRandomBytes(randomBytes, size) {
  let value;
  try {
    value = randomBytes(size);
  } catch {
    stateFail();
  }
  if (!Buffer.isBuffer(value) || value.length !== size) {
    if (Buffer.isBuffer(value)) value.fill(0);
    stateFail();
  }
  return value;
}

function decodeBase64url(value, expectedBytes) {
  if (
    typeof value !== "string" ||
    !BASE64URL_PATTERN.test(value) ||
    value.includes("=")
  ) {
    stateFail();
  }
  const decoded = Buffer.from(value, "base64url");
  if (
    decoded.toString("base64url") !== value ||
    (expectedBytes !== undefined && decoded.length !== expectedBytes)
  ) {
    decoded.fill(0);
    stateFail();
  }
  return decoded;
}

function canonicalPayload(payload) {
  return JSON.stringify({
    version: payload.version,
    provider: payload.provider,
    purpose: payload.purpose,
    companyId: payload.companyId,
    userId: payload.userId,
    sessionJti: payload.sessionJti,
    authorizationHandle: payload.authorizationHandle,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
    returnPathId: payload.returnPathId,
    csrfNonce: payload.csrfNonce
  });
}

function canonicalAad(keyVersion, redirectUri) {
  return Buffer.from(
    JSON.stringify({
      product: "ia4tube",
      version: INSTAGRAM_OAUTH_STATE_VERSION,
      provider: INSTAGRAM_PROVIDER,
      purpose: "oauth",
      redirectUri,
      keyVersion
    }),
    "utf8"
  );
}

function normalizeAllowedReturnPaths(value) {
  const source = value === undefined
    ? INSTAGRAM_OAUTH_RETURN_PATH_IDS
    : value;
  if (
    !Array.isArray(source) ||
    source.length < 1 ||
    source.length > 8 ||
    new Set(source).size !== source.length ||
    source.some((entry) =>
      typeof entry !== "string" || !SAFE_LABEL_PATTERN.test(entry)
    )
  ) {
    stateFail();
  }
  return new Set(source);
}

function normalizeIssuedPayload(input, now, allowedReturnPathIds, randomBytes) {
  const source = strictRecord(input, [
    "purpose",
    "companyId",
    "userId",
    "sessionJti",
    "authorizationHandle",
    "returnPathId"
  ]);
  const csrfBytes = requireRandomBytes(
    randomBytes,
    INSTAGRAM_OAUTH_STATE_CSRF_BYTES
  );
  try {
    if (!Number.isSafeInteger(now + INSTAGRAM_OAUTH_STATE_TTL_MS)) {
      stateFail();
    }
    return Object.freeze({
      version: INSTAGRAM_OAUTH_STATE_VERSION,
      provider: INSTAGRAM_PROVIDER,
      purpose: requirePurpose(source.purpose),
      companyId: requireUuid(source.companyId),
      userId: requireUuid(source.userId),
      sessionJti: requireBoundedSecret(source.sessionJti, 16, 200),
      authorizationHandle: requireUuid(source.authorizationHandle),
      issuedAt: now,
      expiresAt: now + INSTAGRAM_OAUTH_STATE_TTL_MS,
      returnPathId: requireReturnPathId(
        source.returnPathId,
        allowedReturnPathIds
      ),
      csrfNonce: csrfBytes.toString("base64url")
    });
  } finally {
    csrfBytes.fill(0);
  }
}

function normalizeOpenedPayload(
  decoded,
  now,
  allowedReturnPathIds,
  allowExpired
) {
  const source = strictRecord(decoded, [
    "version",
    "provider",
    "purpose",
    "companyId",
    "userId",
    "sessionJti",
    "authorizationHandle",
    "issuedAt",
    "expiresAt",
    "returnPathId",
    "csrfNonce"
  ]);
  if (
    source.version !== INSTAGRAM_OAUTH_STATE_VERSION ||
    source.provider !== INSTAGRAM_PROVIDER ||
    !Number.isSafeInteger(source.issuedAt) ||
    !Number.isSafeInteger(source.expiresAt) ||
    source.issuedAt < 0 ||
    source.expiresAt <= source.issuedAt ||
    source.expiresAt - source.issuedAt > INSTAGRAM_OAUTH_STATE_TTL_MS ||
    source.issuedAt > now + INSTAGRAM_OAUTH_STATE_FUTURE_SKEW_MS
  ) {
    stateFail();
  }
  if (source.expiresAt <= now && !allowExpired) {
    stateFail("social_oauth_state_expired");
  }
  const csrfBytes = decodeBase64url(
    source.csrfNonce,
    INSTAGRAM_OAUTH_STATE_CSRF_BYTES
  );
  csrfBytes.fill(0);
  return Object.freeze({
    version: INSTAGRAM_OAUTH_STATE_VERSION,
    provider: INSTAGRAM_PROVIDER,
    purpose: requirePurpose(source.purpose),
    companyId: requireUuid(source.companyId),
    userId: requireUuid(source.userId),
    sessionJti: requireBoundedSecret(source.sessionJti, 16, 200),
    authorizationHandle: requireUuid(source.authorizationHandle),
    issuedAt: source.issuedAt,
    expiresAt: source.expiresAt,
    returnPathId: requireReturnPathId(
      source.returnPathId,
      allowedReturnPathIds
    ),
    csrfNonce: source.csrfNonce
  });
}

function isAuthenticatedInstagramOAuthState(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    AUTHENTICATED_STATES.has(value)
  );
}

function createInstagramOAuthStateEnvelope(options = {}) {
  if (
    !Buffer.isBuffer(options.derivationKey) ||
    options.derivationKey.length !== 32
  ) {
    stateFail();
  }
  const keyVersion = requireKeyVersion(options.keyVersion);
  const keyVersionSegment = compactKeyVersion(keyVersion);
  const expectedRedirect = options.environment === "production"
    ? `${INSTAGRAM_PRODUCTION_ORIGIN}/v1/social/oauth/callback` : INSTAGRAM_OAUTH_REDIRECT_URI;
  const redirectUri = options.redirectUri || expectedRedirect;
  if (redirectUri !== expectedRedirect) stateFail();
  const now = requireClock(options.clock || Date.now);
  const randomBytes = options.randomBytes || crypto.randomBytes;
  if (typeof randomBytes !== "function") stateFail();
  const allowedReturnPathIds = normalizeAllowedReturnPaths(
    options.allowedReturnPathIds
  );
  const derivedKey = Buffer.from(
    crypto.hkdfSync(
      "sha256",
      options.derivationKey,
      Buffer.from(INSTAGRAM_OAUTH_STATE_HKDF_SALT, "utf8"),
      Buffer.from(INSTAGRAM_OAUTH_STATE_HKDF_INFO, "utf8"),
      32
    )
  );
  let destroyed = false;

  function assertAvailable() {
    if (destroyed) stateFail();
  }

  function seal(input = {}) {
    assertAvailable();
    const payload = normalizeIssuedPayload(
      input,
      now(),
      allowedReturnPathIds,
      randomBytes
    );
    const plaintext = Buffer.from(canonicalPayload(payload), "utf8");
    if (
      plaintext.length < 1 ||
      plaintext.length > INSTAGRAM_OAUTH_STATE_MAX_CIPHERTEXT_BYTES
    ) {
      plaintext.fill(0);
      stateFail();
    }
    let iv;
    let aad;
    let ciphertext;
    let tag;
    try {
      iv = requireRandomBytes(randomBytes, INSTAGRAM_OAUTH_STATE_IV_BYTES);
      aad = canonicalAad(keyVersion, redirectUri);
      const cipher = crypto.createCipheriv("aes-256-gcm", derivedKey, iv, {
        authTagLength: INSTAGRAM_OAUTH_STATE_TAG_BYTES
      });
      cipher.setAAD(aad);
      ciphertext = Buffer.concat([
        cipher.update(plaintext),
        cipher.final()
      ]);
      tag = cipher.getAuthTag();
      const compact = [
        INSTAGRAM_OAUTH_STATE_VERSION,
        keyVersionSegment,
        iv.toString("base64url"),
        ciphertext.toString("base64url"),
        tag.toString("base64url")
      ].join(".");
      if (
        compact.length > INSTAGRAM_OAUTH_STATE_MAX_LENGTH ||
        Buffer.byteLength(compact, "utf8") >
          INSTAGRAM_OAUTH_STATE_MAX_LENGTH
      ) {
        stateFail();
      }
      return compact;
    } finally {
      plaintext.fill(0);
      if (iv) iv.fill(0);
      if (aad) aad.fill(0);
      if (ciphertext) ciphertext.fill(0);
      if (tag) tag.fill(0);
    }
  }

  function openAuthenticatedState(state, allowExpired) {
    assertAvailable();
    if (
      typeof state !== "string" ||
      state.length < 1 ||
      state.length > INSTAGRAM_OAUTH_STATE_MAX_LENGTH ||
      Buffer.byteLength(state, "utf8") > INSTAGRAM_OAUTH_STATE_MAX_LENGTH
    ) {
      stateFail();
    }
    const segments = state.split(".");
    if (
      segments.length !== 5 ||
      segments[0] !== INSTAGRAM_OAUTH_STATE_VERSION ||
      segments[1] !== keyVersionSegment
    ) {
      stateFail();
    }
    const iv = decodeBase64url(
      segments[2],
      INSTAGRAM_OAUTH_STATE_IV_BYTES
    );
    const ciphertext = decodeBase64url(segments[3]);
    const tag = decodeBase64url(
      segments[4],
      INSTAGRAM_OAUTH_STATE_TAG_BYTES
    );
    if (
      ciphertext.length < 1 ||
      ciphertext.length > INSTAGRAM_OAUTH_STATE_MAX_CIPHERTEXT_BYTES
    ) {
      iv.fill(0);
      ciphertext.fill(0);
      tag.fill(0);
      stateFail();
    }
    const aad = canonicalAad(keyVersion, redirectUri);
    let plaintext;
    try {
      try {
        const decipher = crypto.createDecipheriv(
          "aes-256-gcm",
          derivedKey,
          iv,
          { authTagLength: INSTAGRAM_OAUTH_STATE_TAG_BYTES }
        );
        decipher.setAAD(aad);
        decipher.setAuthTag(tag);
        plaintext = Buffer.concat([
          decipher.update(ciphertext),
          decipher.final()
        ]);
      } catch {
        stateFail();
      }
      let serialized;
      let decoded;
      try {
        serialized = UTF8_DECODER.decode(plaintext);
        decoded = JSON.parse(serialized);
      } catch {
        stateFail();
      }
      const payload = normalizeOpenedPayload(
        decoded,
        now(),
        allowedReturnPathIds,
        allowExpired
      );
      if (canonicalPayload(payload) !== serialized) stateFail();
      AUTHENTICATED_STATES.add(payload);
      return payload;
    } finally {
      iv.fill(0);
      ciphertext.fill(0);
      tag.fill(0);
      aad.fill(0);
      if (plaintext) plaintext.fill(0);
    }
  }

  function open(state) {
    return openAuthenticatedState(state, false);
  }

  function openForCallback(state) {
    return openAuthenticatedState(state, true);
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    derivedKey.fill(0);
  }

  return Object.freeze({ destroy, open, openForCallback, seal });
}

module.exports = {
  INSTAGRAM_OAUTH_RETURN_PATH_IDS,
  INSTAGRAM_OAUTH_STATE_CSRF_BYTES,
  INSTAGRAM_OAUTH_STATE_FUTURE_SKEW_MS,
  INSTAGRAM_OAUTH_STATE_HKDF_INFO,
  INSTAGRAM_OAUTH_STATE_HKDF_SALT,
  INSTAGRAM_OAUTH_STATE_IV_BYTES,
  INSTAGRAM_OAUTH_STATE_MAX_LENGTH,
  INSTAGRAM_OAUTH_STATE_TAG_BYTES,
  INSTAGRAM_OAUTH_STATE_TTL_MS,
  INSTAGRAM_OAUTH_STATE_VERSION,
  createInstagramOAuthStateEnvelope,
  isAuthenticatedInstagramOAuthState
};
