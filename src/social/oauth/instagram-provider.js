"use strict";

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

const INSTAGRAM_EXCHANGE_TIMEOUT_MS = 5000;
const INSTAGRAM_EXCHANGE_MAX_RESPONSE_BYTES = 32 * 1024;
const INSTAGRAM_EXCHANGE_MAX_TOKEN_BYTES = 8 * 1024;
const INSTAGRAM_EXCHANGE_MAX_CODE_LENGTH = 2048;
const INSTAGRAM_LONG_LIVED_MAX_EXPIRES_SECONDS = 60 * 24 * 60 * 60;
const INSTAGRAM_DISCOVERY_FIELDS = Object.freeze([
  "user_id",
  "username",
  "name",
  "account_type"
]);
const APP_ID_PATTERN = /^[0-9]{5,32}$/;
const GRAPH_API_VERSION_PATTERN = /^v[1-9][0-9]?\.[0-9]+$/;
const VISIBLE_ASCII_PATTERN = /^[\x21-\x7e]+$/;
const COMPACT_STATE_PATTERN =
  /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function providerFail() {
  postgresFail(
    "social_oauth_exchange_failed",
    "Troca OAuth Instagram recusada."
  );
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
    config.externalConnectionEnabled !== true ||
    config.externalPublicationEnabled !== false ||
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

function preserveNumericUserIds(source) {
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
    if (decoded === "user_id") {
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
    decoded = JSON.parse(preserveNumericUserIds(body.toString("utf8")));
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
      permissions.length > 2048 ||
      permissions !== permissions.trim()
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
    if (
      typeof permission !== "string" ||
      permission !== permission.trim() ||
      !INSTAGRAM_OAUTH_SCOPES.includes(permission)
    ) {
      providerFail();
    }
    granted.add(permission);
  }
  if (granted.size < 1) providerFail();
  return Object.freeze(
    INSTAGRAM_OAUTH_SCOPES.filter((scope) => granted.has(scope))
  );
}

function parseExchangeResponse(body, logger) {
  const decoded = parseJsonRecord(body);
  if (!Object.hasOwn(decoded, "data")) {
    const scopeEvidence = createInstagramScopeEvidence({
      responseFormat: "flat_object",
      permissionsPresent: Object.hasOwn(decoded, "permissions"),
      permissions: decoded.permissions
    });
    emitInstagramScopeEvidence(logger, scopeEvidence);
    const rawToken = decoded.access_token;
    decoded.access_token = null;
    const accessToken = tokenBuffer(rawToken);
    try {
      return Object.freeze({
        legacy: true,
        accessToken,
        userId: normalizeExternalUserId(decoded.user_id)
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
  if (value === "Business") return "business";
  if (value === "Media_Creator") return "creator";
  providerFail();
}

function parseProfessionalAccountResponse(body, expectedUserId) {
  const decoded = parseJsonRecord(body);
  const userId = normalizeExternalUserId(decoded.user_id);
  if (userId !== expectedUserId) providerFail();
  return Object.freeze({
    userId,
    username: normalizeInstagramUsername(decoded.username),
    name: normalizeDisplayName(decoded.name),
    accountType: normalizeProfessionalAccountType(decoded.account_type)
  });
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

  function buildAuthorizationUrl(input = {}) {
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

  async function exchangeCode(input = {}) {
    const source = strictRecord(input, ["code"]);
    const code = boundedSecret(
      source.code,
      1,
      INSTAGRAM_EXCHANGE_MAX_CODE_LENGTH
    );
    if (!VISIBLE_ASCII_PATTERN.test(code)) providerFail();
    try {
      const exchanged = await requestAuthorizationCode(code);
      if (exchanged.legacy) {
        return Object.freeze({
          accessToken: exchanged.accessToken,
          userId: exchanged.userId
        });
      }
      return Object.freeze({
        accessToken: exchanged.accessToken,
        userId: exchanged.userId,
        grantedScopes: exchanged.grantedScopes
      });
    } catch {
      providerFail();
    }
  }

  async function exchangeLongLivedToken(input = {}) {
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

  async function discoverProfessionalAccount(input = {}) {
    const source = strictRecord(input, ["accessToken", "userId"]);
    const accessToken = copyAccessToken(source.accessToken);
    try {
      const expectedUserId = normalizeExternalUserId(source.userId);
      return await requestOnce(
        (signal) => {
          const endpoint = new URL(
            `/${config.graphApiVersion}/me`,
            INSTAGRAM_GRAPH_API_ORIGIN
          );
          endpoint.searchParams.set(
            "fields",
            INSTAGRAM_DISCOVERY_FIELDS.join(",")
          );
          return transport(
            endpoint.toString(),
            Object.freeze({
              method: "GET",
              headers: Object.freeze({
                accept: "application/json",
                authorization: `Bearer ${accessToken.toString("utf8")}`
              }),
              signal
            })
          );
        },
        (body) => parseProfessionalAccountResponse(body, expectedUserId)
      );
    } catch {
      providerFail();
    } finally {
      accessToken.fill(0);
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
  createInstagramProvider
};
