"use strict";

const { postgresFail } = require("../../persistence/postgres/errors");
const {
  INSTAGRAM_AUTHORIZATION_ENDPOINT,
  INSTAGRAM_OAUTH_REDIRECT_URI,
  INSTAGRAM_OAUTH_SCOPES,
  INSTAGRAM_PROVIDER,
  INSTAGRAM_TOKEN_ENDPOINT
} = require("./instagram-config");

const INSTAGRAM_EXCHANGE_TIMEOUT_MS = 5000;
const INSTAGRAM_EXCHANGE_MAX_RESPONSE_BYTES = 32 * 1024;
const INSTAGRAM_EXCHANGE_MAX_TOKEN_BYTES = 8 * 1024;
const INSTAGRAM_EXCHANGE_MAX_CODE_LENGTH = 2048;
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

function parseExchangeResponse(body) {
  let decoded;
  try {
    decoded = JSON.parse(body.toString("utf8"));
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
  const rawToken = decoded.access_token;
  if (
    typeof rawToken !== "string" ||
    rawToken !== rawToken.trim() ||
    rawToken.length < 1 ||
    Buffer.byteLength(rawToken, "utf8") >
      INSTAGRAM_EXCHANGE_MAX_TOKEN_BYTES ||
    /[\u0000-\u0020\u007f]/.test(rawToken) ||
    !VISIBLE_ASCII_PATTERN.test(rawToken)
  ) {
    providerFail();
  }
  const accessToken = Buffer.from(rawToken, "utf8");
  decoded.access_token = null;
  try {
    return Object.freeze({
      accessToken,
      userId: normalizeExternalUserId(decoded.user_id)
    });
  } catch (error) {
    accessToken.fill(0);
    throw error;
  }
}

function createInstagramProvider(options = {}) {
  const config = requireConfig(options.config);
  const transport = requireTransport(options.transport);
  const setTimer = options.setTimeout || setTimeout;
  const clearTimer = options.clearTimeout || clearTimeout;
  const timeoutMs = options.timeoutMs === undefined
    ? INSTAGRAM_EXCHANGE_TIMEOUT_MS
    : options.timeoutMs;
  if (
    typeof setTimer !== "function" ||
    typeof clearTimer !== "function" ||
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

  async function requestOnce(code) {
    const controller = new AbortController();
    const form = new URLSearchParams();
    form.set("client_id", config.appId);
    form.set("client_secret", config.appSecret);
    form.set("grant_type", "authorization_code");
    form.set("redirect_uri", INSTAGRAM_OAUTH_REDIRECT_URI);
    form.set("code", code);

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
      response = await withinBudget(() => transport(
          INSTAGRAM_TOKEN_ENDPOINT,
          Object.freeze({
            method: "POST",
            headers: Object.freeze({
              accept: "application/json",
              "content-type": "application/x-www-form-urlencoded"
            }),
            body: form.toString(),
            signal: controller.signal
          })
        ));
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
      const result = parseExchangeResponse(body);
      if (expired || controller.signal.aborted) {
        result.accessToken.fill(0);
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

  async function exchangeCode(input = {}) {
    const source = strictRecord(input, ["code"]);
    const code = boundedSecret(
      source.code,
      1,
      INSTAGRAM_EXCHANGE_MAX_CODE_LENGTH
    );
    if (!VISIBLE_ASCII_PATTERN.test(code)) providerFail();
    try {
      return await requestOnce(code);
    } catch {
      providerFail();
    }
  }

  return Object.freeze({
    provider: INSTAGRAM_PROVIDER,
    buildAuthorizationUrl,
    exchangeCode
  });
}

module.exports = {
  INSTAGRAM_AUTHORIZATION_ENDPOINT,
  INSTAGRAM_EXCHANGE_MAX_CODE_LENGTH,
  INSTAGRAM_EXCHANGE_MAX_RESPONSE_BYTES,
  INSTAGRAM_EXCHANGE_MAX_TOKEN_BYTES,
  INSTAGRAM_EXCHANGE_TIMEOUT_MS,
  INSTAGRAM_OAUTH_REDIRECT_URI,
  INSTAGRAM_OAUTH_SCOPES,
  INSTAGRAM_PROVIDER,
  INSTAGRAM_TOKEN_ENDPOINT,
  createInstagramProvider
};
