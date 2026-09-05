"use strict";

const { canExternalConnection } = require("../app-review-policy");

const { postgresFail } = require("../../persistence/postgres/errors");
const {
  INSTAGRAM_AUTHORIZATION_ENDPOINT,
  INSTAGRAM_GRAPH_API_ORIGIN,
  INSTAGRAM_LONG_LIVED_TOKEN_ENDPOINT,
  INSTAGRAM_OAUTH_REDIRECT_URI,
  INSTAGRAM_OAUTH_SCOPES,
  INSTAGRAM_PROFESSIONAL_ACCOUNT_API_VERSION,
  INSTAGRAM_PROVIDER,
  INSTAGRAM_TOKEN_ENDPOINT,
  INSTAGRAM_USERNAME_PATTERN
} = require("./instagram-config");
const {
  createInstagramScopeEvidence,
  emitInstagramScopeEvidence
} = require("./instagram-scope-evidence");
const {
  PROFESSIONAL_ACCOUNT_DISCOVERY_FAILURE_CODES
} = require("./instagram-oauth-failure");

const INSTAGRAM_EXCHANGE_TIMEOUT_MS = 5000;
const INSTAGRAM_EXCHANGE_MAX_RESPONSE_BYTES = 32 * 1024;
const INSTAGRAM_EXCHANGE_MAX_TOKEN_BYTES = 8 * 1024;
const INSTAGRAM_EXCHANGE_MAX_CODE_LENGTH = 2048;
const INSTAGRAM_LONG_LIVED_MAX_EXPIRES_SECONDS = 60 * 24 * 60 * 60;
const INSTAGRAM_DISCOVERY_FIELDS = Object.freeze([
  "id",
  "user_id",
  "username",
  "name",
  "account_type"
]);
const INSTAGRAM_DISCOVERY_FAILURE_CODES = new Set(
  PROFESSIONAL_ACCOUNT_DISCOVERY_FAILURE_CODES
);
const INSTAGRAM_DISCOVERY_COMPONENT = "social_instagram_oauth";
const INSTAGRAM_DISCOVERY_EVENT = "provider_account_discovery_evidence";
const INSTAGRAM_DISCOVERY_STAGE = "provider_account_discovery";
const CORRELATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_METADATA_VALUE_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const SAFE_TOP_LEVEL_FIELD_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const SENSITIVE_DISCOVERY_FIELD_NAMES = new Set([
  "access_token",
  "app_secret",
  "authorization",
  "client_secret",
  "code",
  "state",
  "token"
]);
const ACCOUNT_TYPE_MAX_LENGTH = 64;
const ACCOUNT_TYPE_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const ACCOUNT_TYPE_RAW_PATTERN = /^[A-Za-z_ ]{1,64}$/;
const PROFESSIONAL_ACCOUNT_TYPE_ALIASES = Object.freeze({
  business: "business",
  creator: "creator",
  media_creator: "creator"
});
const APP_ID_PATTERN = /^[0-9]{5,32}$/;
const GRAPH_API_VERSION_PATTERN = /^v[1-9][0-9]?\.[0-9]+$/;
const INSTAGRAM_SCOPE_NAME_PATTERN = /^[a-z][a-z0-9_]{1,99}$/;
const VISIBLE_ASCII_PATTERN = /^[\x21-\x7e]+$/;
const COMPACT_STATE_PATTERN =
  /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function providerFail() {
  postgresFail(
    "social_oauth_exchange_failed",
    "Troca OAuth Instagram recusada."
  );
}

class InstagramDiscoveryError extends Error {
  constructor(code, evidence) {
    super("Descoberta de conta profissional Instagram recusada.");
    this.name = "InstagramDiscoveryError";
    this.code = code;
    this.evidence = evidence;
  }
}

function containsKnownSecret(value, forbiddenValues) {
  if (!Array.isArray(forbiddenValues) || forbiddenValues.length === 0) {
    return false;
  }
  let candidate;
  try {
    candidate = Buffer.from(value, "utf8");
    return forbiddenValues.some((secret) => {
      if (Buffer.isBuffer(secret)) {
        return secret.length > 0 && candidate.includes(secret);
      }
      return typeof secret === "string" && secret.length > 0 &&
        value.includes(secret);
    });
  } finally {
    if (candidate) candidate.fill(0);
  }
}

function safeMetadataValue(value, forbiddenValues = []) {
  if (Number.isSafeInteger(value)) return String(value);
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    !SAFE_METADATA_VALUE_PATTERN.test(value) ||
    containsKnownSecret(value, forbiddenValues)
  ) {
    return null;
  }
  return value;
}

function safeProviderCode(value) {
  if (Number.isSafeInteger(value) && value >= 0) return String(value);
  return typeof value === "string" && /^[0-9]{1,20}$/.test(value)
    ? value
    : null;
}

function safeCorrelationId(value) {
  return typeof value === "string" && CORRELATION_ID_PATTERN.test(value)
    ? value.toLowerCase()
    : null;
}

function normalizedContentType(response) {
  const raw = responseHeader(response, "content-type");
  if (typeof raw !== "string") return null;
  const mime = raw.split(";", 1)[0].trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime)
    ? mime
    : null;
}

function safeTopLevelFields(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return Object.freeze([]);
  }
  return Object.freeze(
    Object.keys(value)
      .filter(isSafeDiscoveryFieldName)
      .sort()
      .slice(0, 32)
  );
}

function isSafeDiscoveryFieldName(value) {
  return typeof value === "string" &&
    SAFE_TOP_LEVEL_FIELD_PATTERN.test(value) &&
    !SENSITIVE_DISCOVERY_FIELD_NAMES.has(value.toLowerCase());
}

function discoveryResponseFormat(value) {
  if (Array.isArray(value)) return "array";
  if (
    value &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    const hasDirectAccountFields = [
      "user_id",
      "username",
      "account_type"
    ].some((key) => Object.hasOwn(value, key));
    return Array.isArray(value.data) && !hasDirectAccountFields
      ? "data_envelope"
      : "direct_object";
  }
  if (value === null) return "null";
  return typeof value;
}

function safeDataItemCount(value) {
  return Array.isArray(value?.data) && value.data.length <= 10000
    ? value.data.length
    : null;
}

function observeAccountType(value, forbiddenValues = []) {
  const observed = value !== undefined && value !== null;
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > ACCOUNT_TYPE_MAX_LENGTH ||
    ACCOUNT_TYPE_CONTROL_PATTERN.test(value) ||
    !ACCOUNT_TYPE_RAW_PATTERN.test(value) ||
    containsKnownSecret(value, forbiddenValues)
  ) {
    return Object.freeze({
      raw: null,
      normalized: null,
      eligible: observed ? false : null
    });
  }
  const raw = value;
  const folded = raw.trim().toLowerCase();
  const normalized = Object.hasOwn(PROFESSIONAL_ACCOUNT_TYPE_ALIASES, folded)
    ? PROFESSIONAL_ACCOUNT_TYPE_ALIASES[folded]
    : null;
  return Object.freeze({
    raw,
    normalized,
    eligible: normalized !== null
  });
}

function providerErrorMetadata(decoded) {
  const source = decoded?.error && typeof decoded.error === "object" &&
    !Array.isArray(decoded.error)
    ? decoded.error
    : null;
  if (!source) {
    return Object.freeze({
      providerErrorType: null,
      providerErrorCode: null,
      providerErrorSubcode: null,
      providerTraceId: null,
      providerTransient: null
    });
  }
  return Object.freeze({
    providerErrorType: safeMetadataValue(source.type),
    providerErrorCode: safeProviderCode(source.code),
    providerErrorSubcode: safeProviderCode(
      source.error_subcode ?? source.subcode
    ),
    providerTraceId: safeMetadataValue(
      source.fbtrace_id ?? source.trace_id
    ),
    providerTransient: typeof source.is_transient === "boolean"
      ? source.is_transient
      : null
  });
}

function safeProviderRequestId(response) {
  for (const name of ["x-fb-request-id", "x-request-id"]) {
    const value = safeMetadataValue(responseHeader(response, name));
    if (value !== null) return value;
  }
  return null;
}

function safeDuration(clock, startedAt) {
  try {
    const elapsed = clock() - startedAt;
    return Number.isSafeInteger(elapsed) && elapsed >= 0 && elapsed <= 30000
      ? elapsed
      : null;
  } catch {
    return null;
  }
}

function createDiscoveryEvidence(input = {}, forbiddenValues = []) {
  const accountType = observeAccountType(
    input.accountTypeRaw,
    forbiddenValues
  );
  const accountTypeEligible = accountType.raw === null &&
    input.accountTypeEligible === false
    ? false
    : accountType.eligible;
  const failureCode = INSTAGRAM_DISCOVERY_FAILURE_CODES.has(input.failureCode)
    ? input.failureCode
    : null;
  const outcome = failureCode === null ? "succeeded" : "failed";
  const status = Number.isInteger(input.httpStatus) &&
    input.httpStatus >= 100 && input.httpStatus <= 599
    ? input.httpStatus
    : null;
  const contentType = typeof input.contentType === "string" &&
    input.contentType.length <= 128
    ? input.contentType
    : null;
  const format = typeof input.responseFormat === "string" &&
    /^[a-z_]{1,32}$/.test(input.responseFormat)
    ? input.responseFormat
    : "unavailable";
  return Object.freeze({
    component: INSTAGRAM_DISCOVERY_COMPONENT,
    event: INSTAGRAM_DISCOVERY_EVENT,
    stage: INSTAGRAM_DISCOVERY_STAGE,
    outcome,
    failureCode,
    requestStarted: input.requestStarted === true,
    responseReceived: input.responseReceived === true,
    httpStatus: status,
    contentType,
    responseFormat: format,
    topLevelFields: Object.freeze(
      Array.isArray(input.topLevelFields)
        ? input.topLevelFields
          .filter(isSafeDiscoveryFieldName)
          .slice(0, 32)
        : []
    ),
    dataItemCount: Number.isSafeInteger(input.dataItemCount) &&
      input.dataItemCount >= 0 && input.dataItemCount <= 10000
      ? input.dataItemCount
      : null,
    providerErrorType: safeMetadataValue(
      input.providerErrorType,
      forbiddenValues
    ),
    providerErrorCode: safeProviderCode(input.providerErrorCode),
    providerErrorSubcode: safeProviderCode(input.providerErrorSubcode),
    providerTraceId: safeMetadataValue(
      input.providerTraceId,
      forbiddenValues
    ),
    providerRequestId: safeMetadataValue(
      input.providerRequestId,
      forbiddenValues
    ),
    accountTypeRaw: accountType.raw,
    accountTypeNormalized: accountType.normalized,
    accountTypeEligible,
    retryable: input.retryable === true,
    correlationId: safeCorrelationId(input.correlationId),
    durationMs: Number.isSafeInteger(input.durationMs) &&
      input.durationMs >= 0 && input.durationMs <= 30000
      ? input.durationMs
      : null
  });
}

function sanitizeInstagramDiscoveryEvidence(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.component !== INSTAGRAM_DISCOVERY_COMPONENT ||
    value.event !== INSTAGRAM_DISCOVERY_EVENT ||
    value.stage !== INSTAGRAM_DISCOVERY_STAGE ||
    typeof value.requestStarted !== "boolean" ||
    typeof value.responseReceived !== "boolean" ||
    (value.responseReceived && !value.requestStarted)
  ) {
    return null;
  }
  const safe = createDiscoveryEvidence(value);
  if (
    safe.outcome !== value.outcome ||
    safe.requestStarted !== value.requestStarted ||
    safe.responseReceived !== value.responseReceived ||
    (safe.responseReceived && safe.httpStatus === null) ||
    (!safe.responseReceived && safe.httpStatus !== null) ||
    (safe.failureCode === "provider_account_discovery_request_not_sent" &&
      (safe.requestStarted || safe.responseReceived)) ||
    (safe.failureCode !== "provider_account_discovery_request_not_sent" &&
      !safe.requestStarted)
  ) {
    return null;
  }
  return safe;
}

function emitDiscoveryEvidence(logger, evidence) {
  const safe = sanitizeInstagramDiscoveryEvidence(evidence);
  if (!safe) return;
  try {
    const info = logger?.info;
    if (typeof info !== "function") return;
    const pending = info.call(logger, safe);
    if (pending && typeof pending.then === "function") {
      Promise.resolve(pending).catch(() => {});
    }
  } catch {
    // Redacted diagnostic logging must never alter the OAuth result.
  }
}

function strictRecord(value, expectedKeys) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    providerFail();
  }
  const keys = Object.keys(value);
  if (
    keys.length !== expectedKeys.length ||
    expectedKeys.some((key) => !Object.hasOwn(value, key))
  ) {
    providerFail();
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set) providerFail();
  }
  return value;
}

function boundedSecret(value, minimum, maximum) {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length < minimum ||
    value.length > maximum ||
    /[\u0000-\u0020\u007f]/.test(value)
  ) {
    providerFail();
  }
  return value;
}

function requireConfig(config) {
  if (
    !config ||
    typeof config !== "object" ||
    config.enabled !== true ||
    config.instagramEnabled !== true ||
    typeof config.externalConnectionEnabled !== "boolean" ||
    typeof config.externalPublicationEnabled !== "boolean" ||
    config.provider !== INSTAGRAM_PROVIDER ||
    config.redirectUri !== INSTAGRAM_OAUTH_REDIRECT_URI ||
    config.authorizationEndpoint !== INSTAGRAM_AUTHORIZATION_ENDPOINT ||
    config.tokenEndpoint !== INSTAGRAM_TOKEN_ENDPOINT ||
    !(
      config.expectedUsername === null ||
      (
        typeof config.expectedUsername === "string" &&
        INSTAGRAM_USERNAME_PATTERN.test(config.expectedUsername) &&
        !config.expectedUsername.includes("..")
      )
    ) ||
    !Array.isArray(config.scopes) ||
    config.scopes.length !== INSTAGRAM_OAUTH_SCOPES.length ||
    config.scopes.some(
      (scope, index) => scope !== INSTAGRAM_OAUTH_SCOPES[index]
    )
  ) {
    providerFail();
  }
  if (!APP_ID_PATTERN.test(boundedSecret(config.appId, 5, 32))) {
    providerFail();
  }
  if (!VISIBLE_ASCII_PATTERN.test(
    boundedSecret(config.appSecret, 16, 256)
  )) {
    providerFail();
  }
  if (!GRAPH_API_VERSION_PATTERN.test(
    boundedSecret(config.graphApiVersion, 4, 16)
  )) {
    providerFail();
  }
  return config;
}

function requireTransport(transport) {
  if (typeof transport === "function") return transport;
  if (transport && typeof transport.request === "function") {
    return transport.request.bind(transport);
  }
  providerFail();
}

function responseHeader(response, name) {
  if (response?.headers && typeof response.headers.get === "function") {
    const value = response.headers.get(name);
    return value === null || value === undefined ? null : String(value);
  }
  if (!response?.headers || typeof response.headers !== "object") return null;
  const normalizedName = name.toLowerCase();
  for (const [key, value] of Object.entries(response.headers)) {
    if (String(key).toLowerCase() === normalizedName) return String(value);
  }
  return null;
}

function requireContentType(response) {
  const raw = responseHeader(response, "content-type");
  if (
    typeof raw !== "string" ||
    raw.split(";", 1)[0].trim().toLowerCase() !== "application/json"
  ) {
    providerFail();
  }
}

function requireContentLength(response) {
  const raw = responseHeader(response, "content-length");
  if (raw === null) return;
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) providerFail();
  const length = Number(raw);
  if (
    !Number.isSafeInteger(length) ||
    length < 1 ||
    length > INSTAGRAM_EXCHANGE_MAX_RESPONSE_BYTES
  ) {
    providerFail();
  }
}

async function readStreamingBody(body, budget) {
  const reader = body.getReader();
  if (!reader || typeof reader.read !== "function") providerFail();
  const chunks = [];
  let total = 0;
  let completed = false;
  let cancellation;
  function cancelReader() {
    if (cancellation) return cancellation;
    try {
      cancellation = Promise.resolve(
        typeof reader.cancel === "function" ? reader.cancel() : undefined
      ).catch(() => undefined);
    } catch {
      cancellation = Promise.resolve();
    }
    return cancellation;
  }
  function abortReader() {
    void cancelReader();
  }
  if (budget.signal.aborted) {
    abortReader();
  } else {
    budget.signal.addEventListener("abort", abortReader, { once: true });
  }
  try {
    while (true) {
      const result = await budget.withinBudget(() => reader.read());
      if (!result || result.done) break;
      const chunk = Buffer.from(result.value || []);
      total += chunk.length;
      if (total > INSTAGRAM_EXCHANGE_MAX_RESPONSE_BYTES) {
        chunk.fill(0);
        void cancelReader();
        providerFail();
      }
      chunks.push(chunk);
    }
    if (total < 1) providerFail();
    completed = true;
    return Buffer.concat(chunks, total);
  } finally {
    budget.signal.removeEventListener("abort", abortReader);
    if (!completed) void cancelReader();
    for (const chunk of chunks) chunk.fill(0);
    if (typeof reader.releaseLock === "function") {
      try {
        reader.releaseLock();
      } catch {
        // Cancellation remains best-effort and the public error stays closed.
      }
    }
  }
}

async function readResponseBody(response, budget) {
  requireContentLength(response);
  let body;
  if (response?.body && typeof response.body.getReader === "function") {
    body = await readStreamingBody(response.body, budget);
  } else if (typeof response?.arrayBuffer === "function") {
    body = Buffer.from(await budget.withinBudget(
      () => response.arrayBuffer()
    ));
  } else if (
    Buffer.isBuffer(response?.body) ||
    typeof response?.body === "string"
  ) {
    body = Buffer.from(response.body);
  } else if (typeof response?.text === "function") {
    body = Buffer.from(await budget.withinBudget(
      () => response.text()
    ), "utf8");
  } else {
    providerFail();
  }
  if (
    body.length < 1 ||
    body.length > INSTAGRAM_EXCHANGE_MAX_RESPONSE_BYTES
  ) {
    body.fill(0);
    providerFail();
  }
  return body;
}

function normalizeExternalUserId(value) {
  if (Number.isSafeInteger(value) && value > 0) return String(value);
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length < 1 ||
    value.length > 200 ||
    /[\u0000-\u0020\u007f]/.test(value) ||
    !VISIBLE_ASCII_PATTERN.test(value)
  ) {
    providerFail();
  }
  return value;
}

function jsonStringEnd(source, start) {
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === "\\") {
      index += 1;
    } else if (source[index] === "\"") {
      return index;
    }
  }
  providerFail();
}

function isJsonWhitespace(value) {
  return value === " " || value === "\t" || value === "\r" || value === "\n";
}

function isJsonValueDelimiter(value) {
  return value === undefined ||
    value === "," ||
    value === "}" ||
    value === "]" ||
    isJsonWhitespace(value);
}

function preserveNumericIdentityIds(source) {
  const pieces = [];
  let cursor = 0;
  let index = 0;
  while (index < source.length) {
    if (source[index] !== "\"") {
      index += 1;
      continue;
    }
    const end = jsonStringEnd(source, index);
    let decoded;
    try {
      decoded = JSON.parse(source.slice(index, end + 1));
    } catch {
      providerFail();
    }
    if (decoded === "user_id" || decoded === "id") {
      let colon = end + 1;
      while (isJsonWhitespace(source[colon])) colon += 1;
      if (source[colon] === ":") {
        let valueStart = colon + 1;
        while (isJsonWhitespace(source[valueStart])) valueStart += 1;
        let valueEnd = valueStart;
        if (source[valueEnd] === "0") {
          valueEnd += 1;
        } else if (source[valueEnd] >= "1" && source[valueEnd] <= "9") {
          while (
            source[valueEnd] >= "0" &&
            source[valueEnd] <= "9"
          ) {
            valueEnd += 1;
          }
        }
        if (
          valueEnd > valueStart &&
          isJsonValueDelimiter(source[valueEnd])
        ) {
          pieces.push(
            source.slice(cursor, valueStart),
            `"${source.slice(valueStart, valueEnd)}"`
          );
          cursor = valueEnd;
          index = valueEnd;
          continue;
        }
      }
    }
    index = end + 1;
  }
  if (pieces.length === 0) return source;
  pieces.push(source.slice(cursor));
  return pieces.join("");
}

function parseJsonRecord(body) {
  let decoded;
  try {
    decoded = JSON.parse(preserveNumericIdentityIds(body.toString("utf8")));
  } catch {
    providerFail();
  }
  if (
    !decoded ||
    typeof decoded !== "object" ||
    Array.isArray(decoded) ||
    Object.getPrototypeOf(decoded) !== Object.prototype
  ) {
    providerFail();
  }
  return decoded;
}

function tokenBuffer(value) {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length < 1 ||
    Buffer.byteLength(value, "utf8") >
      INSTAGRAM_EXCHANGE_MAX_TOKEN_BYTES ||
    /[\u0000-\u0020\u007f]/.test(value) ||
    !VISIBLE_ASCII_PATTERN.test(value)
  ) {
    providerFail();
  }
  return Buffer.from(value, "utf8");
}

function copyAccessToken(value) {
  if (
    !Buffer.isBuffer(value) ||
    value.length < 1 ||
    value.length > INSTAGRAM_EXCHANGE_MAX_TOKEN_BYTES
  ) {
    providerFail();
  }
  const copied = Buffer.from(value);
  for (const byte of copied) {
    if (byte < 0x21 || byte > 0x7e) {
      copied.fill(0);
      providerFail();
    }
  }
  return copied;
}

function normalizeGrantedScopes(permissions) {
  let values;
  if (typeof permissions === "string") {
    if (
      permissions.length < 1 ||
      permissions.length > 2048
    ) {
      providerFail();
    }
    values = permissions.split(",");
  } else if (Array.isArray(permissions)) {
    if (permissions.length < 1 || permissions.length > 32) providerFail();
    values = permissions;
  } else {
    providerFail();
  }

  const granted = new Set();
  for (const permission of values) {
    if (typeof permission !== "string") providerFail();
    const normalized = permission.trim();
    if (
      !INSTAGRAM_SCOPE_NAME_PATTERN.test(normalized)
    ) {
      providerFail();
    }
    granted.add(normalized);
  }
  if (granted.size < 1) providerFail();
  return Object.freeze([...granted].sort());
}

function parseExchangeResponse(body, logger) {
  const decoded = parseJsonRecord(body);
  if (!Object.hasOwn(decoded, "data")) {
    const permissionsPresent = Object.hasOwn(decoded, "permissions");
    const scopeEvidence = createInstagramScopeEvidence({
      responseFormat: "flat_object",
      permissionsPresent,
      permissions: decoded.permissions
    });
    emitInstagramScopeEvidence(logger, scopeEvidence);
    const grantedScopes = permissionsPresent
      ? normalizeGrantedScopes(decoded.permissions)
      : Object.freeze([]);
    const rawToken = decoded.access_token;
    decoded.access_token = null;
    const accessToken = tokenBuffer(rawToken);
    try {
      return Object.freeze({
        legacy: true,
        accessToken,
        userId: normalizeExternalUserId(decoded.user_id),
        grantedScopes
      });
    } catch (error) {
      accessToken.fill(0);
      throw error;
    }
  }

  const candidate = Array.isArray(decoded.data) && decoded.data.length === 1 &&
    decoded.data[0] && typeof decoded.data[0] === "object" &&
    !Array.isArray(decoded.data[0])
    ? decoded.data[0]
    : null;
  const scopeEvidence = createInstagramScopeEvidence({
    responseFormat: "data_envelope",
    permissionsPresent: candidate
      ? Object.hasOwn(candidate, "permissions")
      : false,
    permissions: candidate?.permissions
  });
  emitInstagramScopeEvidence(logger, scopeEvidence);
  const envelope = strictRecord(decoded, ["data"]);
  if (!Array.isArray(envelope.data) || envelope.data.length !== 1) {
    providerFail();
  }
  const entry = strictRecord(envelope.data[0], [
    "access_token",
    "user_id",
    "permissions"
  ]);
  const rawToken = entry.access_token;
  entry.access_token = null;
  const accessToken = tokenBuffer(rawToken);
  try {
    return Object.freeze({
      legacy: false,
      accessToken,
      userId: normalizeExternalUserId(entry.user_id),
      grantedScopes: normalizeGrantedScopes(entry.permissions)
    });
  } catch (error) {
    accessToken.fill(0);
    throw error;
  }
}

function parseLongLivedTokenResponse(body) {
  const decoded = strictRecord(parseJsonRecord(body), [
    "access_token",
    "token_type",
    "expires_in"
  ]);
  const rawToken = decoded.access_token;
  decoded.access_token = null;
  const accessToken = tokenBuffer(rawToken);
  try {
    if (
      decoded.token_type !== "bearer" ||
      !Number.isSafeInteger(decoded.expires_in) ||
      decoded.expires_in < 1 ||
      decoded.expires_in > INSTAGRAM_LONG_LIVED_MAX_EXPIRES_SECONDS
    ) {
      providerFail();
    }
    return Object.freeze({
      accessToken,
      expiresIn: decoded.expires_in
    });
  } catch (error) {
    accessToken.fill(0);
    throw error;
  }
}

function normalizeInstagramUsername(value) {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length < 1 ||
    value.length > 30
  ) {
    providerFail();
  }
  const normalized = value.toLowerCase();
  if (
    !INSTAGRAM_USERNAME_PATTERN.test(normalized) ||
    normalized.includes("..")
  ) {
    providerFail();
  }
  return normalized;
}

function normalizeDisplayName(value) {
  if (value === undefined || value === null || value === "") return null;
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length < 1 ||
    value.length > 300 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    providerFail();
  }
  return value;
}

function normalizeProfessionalAccountType(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > ACCOUNT_TYPE_MAX_LENGTH ||
    ACCOUNT_TYPE_CONTROL_PATTERN.test(value)
  ) {
    providerFail();
  }
  const folded = value.trim().toLowerCase();
  if (!Object.hasOwn(PROFESSIONAL_ACCOUNT_TYPE_ALIASES, folded)) {
    providerFail();
  }
  return PROFESSIONAL_ACCOUNT_TYPE_ALIASES[folded];
}

function clearResultToken(result) {
  if (Buffer.isBuffer(result?.accessToken)) result.accessToken.fill(0);
}

function createInstagramProvider(options = {}) {
  const config = requireConfig(options.config);
  const transport = requireTransport(options.transport);
  const logger = options.logger;
  const setTimer = options.setTimeout || setTimeout;
  const clearTimer = options.clearTimeout || clearTimeout;
  const clock = options.clock || Date.now;
  const timeoutMs = options.timeoutMs === undefined
    ? INSTAGRAM_EXCHANGE_TIMEOUT_MS
    : options.timeoutMs;
  if (
    typeof setTimer !== "function" ||
    typeof clearTimer !== "function" ||
    typeof clock !== "function" ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 30000
  ) {
    providerFail();
  }

  function requireExternalConnection(context) {
    if (context === undefined && !config.appReview?.companyId) {
      if (config.externalConnectionEnabled !== true) providerFail();
      return;
    }
    try {
      if (!canExternalConnection(config, context)) providerFail();
    } catch {
      providerFail();
    }
  }

  function buildAuthorizationUrl(input = {}, context) {
    requireExternalConnection(context);
    const source = strictRecord(input, ["state"]);
    const state = boundedSecret(source.state, 32, 2048);
    if (!COMPACT_STATE_PATTERN.test(state)) providerFail();
    const url = new URL(INSTAGRAM_AUTHORIZATION_ENDPOINT);
    url.searchParams.set("enable_fb_login", "0");
    url.searchParams.set("client_id", config.appId);
    url.searchParams.set("redirect_uri", INSTAGRAM_OAUTH_REDIRECT_URI);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", INSTAGRAM_OAUTH_SCOPES.join(","));
    url.searchParams.set("state", state);
    return url.toString();
  }

  async function requestOnce(startRequest, parseResponse) {
    const controller = new AbortController();
    const timedOut = Object.freeze({ timedOut: true });
    const completed = Object.freeze({ timedOut: false });
    let settleDeadline;
    let expired = false;
    let timer;
    let timerStarted = false;
    let response;
    let body;
    const deadline = new Promise((resolve) => {
      settleDeadline = resolve;
    });
    async function withinBudget(operation) {
      if (expired || controller.signal.aborted) throw timedOut;
      const observed = Promise.resolve()
        .then(operation)
        .then(
          (value) => Object.freeze({ fulfilled: true, value }),
          (error) => Object.freeze({ fulfilled: false, error })
        );
      const outcome = await Promise.race([observed, deadline]);
      if (outcome === timedOut || expired || controller.signal.aborted) {
        throw timedOut;
      }
      if (!outcome.fulfilled) throw outcome.error;
      return outcome.value;
    }
    try {
      timer = setTimer(() => {
        expired = true;
        settleDeadline(timedOut);
        controller.abort();
      }, timeoutMs);
      timerStarted = true;
      response = await withinBudget(() => startRequest(controller.signal));
      if (
        !response ||
        !Number.isInteger(response.status) ||
        response.status !== 200
      ) {
        providerFail();
      }
      requireContentType(response);
      body = await readResponseBody(response, Object.freeze({
        signal: controller.signal,
        withinBudget
      }));
      if (expired || controller.signal.aborted) throw timedOut;
      const result = parseResponse(body);
      if (expired || controller.signal.aborted) {
        clearResultToken(result);
        throw timedOut;
      }
      return result;
    } finally {
      try {
        if (timerStarted) clearTimer(timer);
      } finally {
        timerStarted = false;
        settleDeadline(completed);
        if (body) body.fill(0);
        response = null;
      }
    }
  }

  async function requestAuthorizationCode(code) {
    const form = new URLSearchParams();
    form.set("client_id", config.appId);
    form.set("client_secret", config.appSecret);
    form.set("grant_type", "authorization_code");
    form.set("redirect_uri", INSTAGRAM_OAUTH_REDIRECT_URI);
    form.set("code", code);
    return requestOnce(
      (signal) => transport(
        INSTAGRAM_TOKEN_ENDPOINT,
        Object.freeze({
          method: "POST",
          headers: Object.freeze({
            accept: "application/json",
            "content-type": "application/x-www-form-urlencoded"
          }),
          body: form.toString(),
          signal
        })
      ),
      (body) => parseExchangeResponse(body, logger)
    );
  }

  async function exchangeCode(input = {}, context) {
    requireExternalConnection(context);
    const source = strictRecord(input, ["code"]);
    const code = boundedSecret(
      source.code,
      1,
      INSTAGRAM_EXCHANGE_MAX_CODE_LENGTH
    );
    if (!VISIBLE_ASCII_PATTERN.test(code)) providerFail();
    try {
      const exchanged = await requestAuthorizationCode(code);
      return Object.freeze({
        accessToken: exchanged.accessToken,
        userId: exchanged.userId,
        grantedScopes: exchanged.grantedScopes
      });
    } catch {
      providerFail();
    }
  }

  async function exchangeLongLivedToken(input = {}, context) {
    requireExternalConnection(context);
    const source = strictRecord(input, ["accessToken"]);
    const shortLivedToken = copyAccessToken(source.accessToken);
    let exchanged;
    try {
      exchanged = await requestOnce(
        (signal) => {
          const endpoint = new URL(INSTAGRAM_LONG_LIVED_TOKEN_ENDPOINT);
          endpoint.searchParams.set("grant_type", "ig_exchange_token");
          endpoint.searchParams.set("client_secret", config.appSecret);
          endpoint.searchParams.set(
            "access_token",
            shortLivedToken.toString("utf8")
          );
          return transport(
            endpoint.toString(),
            Object.freeze({
              method: "GET",
              headers: Object.freeze({ accept: "application/json" }),
              signal
            })
          );
        },
        parseLongLivedTokenResponse
      );
      const observedAt = clock();
      const expiresAtMilliseconds =
        observedAt + exchanged.expiresIn * 1000;
      const expiresAt = new Date(expiresAtMilliseconds);
      if (
        !Number.isSafeInteger(observedAt) ||
        observedAt < 0 ||
        !Number.isSafeInteger(expiresAtMilliseconds) ||
        expiresAtMilliseconds <= observedAt ||
        Number.isNaN(expiresAt.getTime())
      ) {
        providerFail();
      }
      return Object.freeze({
        accessToken: exchanged.accessToken,
        expiresIn: exchanged.expiresIn,
        expiresAt
      });
    } catch {
      clearResultToken(exchanged);
      providerFail();
    } finally {
      shortLivedToken.fill(0);
    }
  }

  async function discoverProfessionalAccount(input = {}, context) {
    requireExternalConnection(context);
    const hasCorrelationId = input !== null && typeof input === "object" &&
      Object.hasOwn(input, "correlationId");
    const inputKeys = hasCorrelationId
      ? ["accessToken", "userId", "correlationId"]
      : ["accessToken", "userId"];
    const source = strictRecord(input, inputKeys);
    const correlationId = source.correlationId === undefined
      ? null
      : safeCorrelationId(source.correlationId);
    if (source.correlationId !== undefined && correlationId === null) {
      providerFail();
    }
    const expectedUserId = normalizeExternalUserId(source.userId);
    const accessToken = copyAccessToken(source.accessToken);
    const controller = new AbortController();
    const timedOut = Object.freeze({ timedOut: true });
    const completed = Object.freeze({ timedOut: false });
    let settleDeadline;
    let expired = false;
    let timer;
    let timerStarted = false;
    let response;
    let body;
    let startedAt;
    let requestStarted = false;
    let responseReceived = false;
    try {
      startedAt = clock();
    } catch {
      startedAt = null;
    }
    const deadline = new Promise((resolve) => {
      settleDeadline = resolve;
    });
    async function withinBudget(operation) {
      if (expired || controller.signal.aborted) throw timedOut;
      const observed = Promise.resolve()
        .then(operation)
        .then(
          (value) => Object.freeze({ fulfilled: true, value }),
          (error) => Object.freeze({ fulfilled: false, error })
        );
      const outcome = await Promise.race([observed, deadline]);
      if (outcome === timedOut || expired || controller.signal.aborted) {
        throw timedOut;
      }
      if (!outcome.fulfilled) throw outcome.error;
      return outcome.value;
    }
    function failDiscovery(code, metadata = {}) {
      const evidence = createDiscoveryEvidence({
        ...metadata,
        requestStarted,
        responseReceived,
        failureCode: code,
        correlationId,
        durationMs: safeDuration(clock, startedAt)
      }, [accessToken, config.appSecret]);
      emitDiscoveryEvidence(logger, evidence);
      throw new InstagramDiscoveryError(code, evidence);
    }
    function responseMetadata(decoded, contentType) {
      return {
        requestStarted,
        responseReceived,
        httpStatus: response?.status,
        contentType,
        responseFormat: discoveryResponseFormat(decoded),
        topLevelFields: safeTopLevelFields(decoded),
        dataItemCount: safeDataItemCount(decoded),
        providerRequestId: safeProviderRequestId(response),
        accountTypeRaw: decoded && typeof decoded === "object" &&
          !Array.isArray(decoded)
          ? decoded.account_type
          : null
      };
    }
    try {
      try {
        timer = setTimer(() => {
          expired = true;
          settleDeadline(timedOut);
          controller.abort();
        }, timeoutMs);
        timerStarted = true;
      } catch {
        failDiscovery("provider_account_discovery_request_not_sent", {
          responseFormat: "unavailable",
          retryable: false
        });
      }

      try {
        response = await withinBudget(() => {
          const endpoint = new URL(
            `/${config.graphApiVersion}/me`,
            INSTAGRAM_GRAPH_API_ORIGIN
          );
          endpoint.searchParams.set(
            "fields",
            INSTAGRAM_DISCOVERY_FIELDS.join(",")
          );
          const requestUrl = endpoint.toString();
          const requestOptions = Object.freeze({
            method: "GET",
            headers: Object.freeze({
              accept: "application/json",
              authorization: `Bearer ${accessToken.toString("utf8")}`
            }),
            signal: controller.signal
          });
          requestStarted = true;
          return transport(requestUrl, requestOptions);
        });
        responseReceived = Number.isInteger(response?.status) &&
          response.status >= 100 && response.status <= 599;
      } catch (error) {
        if (!requestStarted) {
          failDiscovery("provider_account_discovery_request_not_sent", {
            responseFormat: "unavailable",
            retryable: false
          });
        }
        if (error === timedOut || expired || controller.signal.aborted) {
          failDiscovery("provider_account_discovery_timeout", {
            responseFormat: "unavailable",
            retryable: true
          });
        }
        failDiscovery("provider_account_discovery_transport_failed", {
          responseFormat: "unavailable",
          retryable: true
        });
      }

      if (!responseReceived) {
        failDiscovery("provider_account_discovery_transport_failed", {
          responseFormat: "unavailable",
          retryable: true
        });
      }
      const contentType = normalizedContentType(response);
      if (response.status !== 200) {
        let decoded = null;
        if (contentType === "application/json") {
          try {
            body = await readResponseBody(response, Object.freeze({
              signal: controller.signal,
              withinBudget
            }));
            decoded = JSON.parse(
              preserveNumericIdentityIds(body.toString("utf8"))
            );
          } catch {
            decoded = null;
          }
        }
        const providerError = providerErrorMetadata(decoded);
        const retryable = providerError.providerTransient === null
          ? response.status === 408 || response.status === 425 ||
            response.status === 429 || response.status >= 500
          : providerError.providerTransient;
        failDiscovery("provider_account_discovery_http_rejected", {
          ...responseMetadata(decoded, contentType),
          ...providerError,
          responseFormat: decoded === null
            ? "unavailable"
            : discoveryResponseFormat(decoded),
          retryable
        });
      }
      if (contentType !== "application/json") {
        failDiscovery("provider_account_discovery_invalid_content_type", {
          ...responseMetadata(null, contentType),
          responseFormat: "unavailable",
          retryable: false
        });
      }

      try {
        body = await readResponseBody(response, Object.freeze({
          signal: controller.signal,
          withinBudget
        }));
      } catch (error) {
        if (error === timedOut || expired || controller.signal.aborted) {
          failDiscovery("provider_account_discovery_timeout", {
            ...responseMetadata(null, contentType),
            responseFormat: "unavailable",
            retryable: true
          });
        }
        const code = error?.code === "social_oauth_exchange_failed"
          ? "provider_account_discovery_invalid_shape"
          : "provider_account_discovery_transport_failed";
        failDiscovery(code, {
          ...responseMetadata(null, contentType),
          responseFormat: "unavailable",
          retryable: code.endsWith("transport_failed")
        });
      }

      let decoded;
      try {
        decoded = JSON.parse(preserveNumericIdentityIds(body.toString("utf8")));
      } catch {
        failDiscovery("provider_account_discovery_invalid_json", {
          ...responseMetadata(null, contentType),
          responseFormat: "invalid_json",
          retryable: false
        });
      }
      const metadata = responseMetadata(decoded, contentType);
      if (
        !decoded ||
        typeof decoded !== "object" ||
        Array.isArray(decoded) ||
        Object.getPrototypeOf(decoded) !== Object.prototype ||
        metadata.responseFormat !== "direct_object"
      ) {
        failDiscovery("provider_account_discovery_invalid_shape", {
          ...metadata,
          retryable: false
        });
      }
      if (!Object.hasOwn(decoded, "user_id") ||
        decoded.user_id === null || decoded.user_id === "") {
        failDiscovery("provider_account_discovery_missing_id", {
          ...metadata,
          retryable: false
        });
      }
      let userId;
      try {
        userId = normalizeExternalUserId(decoded.user_id);
      } catch {
        failDiscovery("provider_account_discovery_invalid_shape", {
          ...metadata,
          retryable: false
        });
      }
      if (Object.hasOwn(decoded, "id")) {
        let appScopedUserId;
        try {
          appScopedUserId = normalizeExternalUserId(decoded.id);
        } catch {
          failDiscovery("provider_account_discovery_invalid_shape", {
            ...metadata,
            retryable: false
          });
        }
        if (appScopedUserId !== expectedUserId) {
          failDiscovery("provider_account_discovery_invalid_shape", {
            ...metadata,
            retryable: false
          });
        }
      } else if (userId !== expectedUserId) {
        failDiscovery("provider_account_discovery_invalid_shape", {
          ...metadata,
          retryable: false
        });
      }
      if (
        !Object.hasOwn(decoded, "username") ||
        decoded.username === null ||
        decoded.username === ""
      ) {
        failDiscovery("provider_account_discovery_missing_username", {
          ...metadata,
          retryable: false
        });
      }
      let username;
      try {
        username = normalizeInstagramUsername(decoded.username);
      } catch {
        failDiscovery("provider_account_discovery_invalid_shape", {
          ...metadata,
          retryable: false
        });
      }
      if (!Object.hasOwn(decoded, "account_type")) {
        failDiscovery("provider_account_discovery_invalid_shape", {
          ...metadata,
          retryable: false
        });
      }
      let accountType;
      try {
        accountType = normalizeProfessionalAccountType(decoded.account_type);
      } catch {
        failDiscovery("provider_account_discovery_account_ineligible", {
          ...metadata,
          accountTypeRaw: decoded.account_type,
          retryable: false
        });
      }
      let name;
      try {
        name = normalizeDisplayName(decoded.name);
      } catch {
        failDiscovery("provider_account_discovery_invalid_shape", {
          ...metadata,
          accountTypeRaw: decoded.account_type,
          retryable: false
        });
      }
      const result = Object.freeze({ userId, username, name, accountType });
      emitDiscoveryEvidence(logger, createDiscoveryEvidence({
        ...metadata,
        accountTypeRaw: decoded.account_type,
        retryable: false,
        correlationId,
        durationMs: safeDuration(clock, startedAt)
      }, [accessToken, config.appSecret]));
      return result;
    } finally {
      try {
        if (timerStarted) clearTimer(timer);
      } finally {
        timerStarted = false;
        settleDeadline(completed);
        if (body) body.fill(0);
        response = null;
        accessToken.fill(0);
      }
    }
  }

  return Object.freeze({
    provider: INSTAGRAM_PROVIDER,
    buildAuthorizationUrl,
    exchangeCode,
    exchangeLongLivedToken,
    discoverProfessionalAccount
  });
}

module.exports = {
  INSTAGRAM_AUTHORIZATION_ENDPOINT,
  INSTAGRAM_EXCHANGE_MAX_CODE_LENGTH,
  INSTAGRAM_EXCHANGE_MAX_RESPONSE_BYTES,
  INSTAGRAM_EXCHANGE_MAX_TOKEN_BYTES,
  INSTAGRAM_EXCHANGE_TIMEOUT_MS,
  INSTAGRAM_GRAPH_API_ORIGIN,
  INSTAGRAM_LONG_LIVED_MAX_EXPIRES_SECONDS,
  INSTAGRAM_LONG_LIVED_TOKEN_ENDPOINT,
  INSTAGRAM_OAUTH_REDIRECT_URI,
  INSTAGRAM_OAUTH_SCOPES,
  INSTAGRAM_PROFESSIONAL_ACCOUNT_API_VERSION,
  INSTAGRAM_PROVIDER,
  INSTAGRAM_TOKEN_ENDPOINT,
  createInstagramProvider,
  sanitizeInstagramDiscoveryEvidence
};
