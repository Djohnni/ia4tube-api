"use strict";

const express = require("express");
const { CONNECTION_STATES } = require("../connectors/states");

const CALLBACK_MAX_URL_LENGTH = 8192;
const CALLBACK_MAX_STATE_LENGTH = 2048;
const CALLBACK_MAX_CODE_LENGTH = 2048;
const CALLBACK_MAX_ERROR_LENGTH = 64;
const CALLBACK_MAX_ERROR_REASON_LENGTH = 64;
const CALLBACK_MAX_DESCRIPTION_LENGTH = 512;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROFESSIONAL_ACCOUNT_TYPES = new Set(["business", "creator"]);
const CONNECTION_HEALTH = new Set([
  "healthy",
  "authorization_pending",
  "reconnect_required",
  "disconnecting",
  "disconnected",
  "failed"
]);
const AUTHORIZATION_STATUSES = new Set([
  "authorization_pending",
  "authorization_processing",
  "authorization_completed",
  "authorization_cancelled",
  "authorization_expired",
  "authorization_failed"
]);
const PUBLIC_ERROR_STATUS = Object.freeze({
  social_oauth_callback_invalid: 400,
  social_oauth_state_invalid: 400,
  social_oauth_state_expired: 400,
  social_oauth_state_binding_mismatch: 400,
  social_oauth_state_already_consumed: 409,
  social_oauth_state_cancelled: 400,
  social_oauth_exchange_failed: 502,
  controlled_account_mismatch: 409,
  invalid_account_type: 422,
  permission_missing: 403,
  provider_permanent_failure: 502,
  provider_result_unknown: 502,
  provider_temporary_failure: 503,
  active_connection_exists: 409,
  idempotency_conflict: 409,
  resource_unavailable: 404,
  state_transition_invalid: 409,
  disconnect_failed: 502,
  social_context_invalid: 403,
  social_authenticated_principal_invalid: 401,
  social_connection_request_invalid: 400,
  social_connection_response_invalid: 503,
  social_connection_unavailable: 503,
  external_capability_disabled: 503,
  social_instagram_configuration_invalid: 503
});

function callbackInvalid() {
  const error = new Error("Callback OAuth Instagram recusado.");
  error.code = "social_oauth_callback_invalid";
  throw error;
}

function connectionFail(code, message) {
  const error = new Error(message || "Operacao de conexao Instagram recusada.");
  error.code = code;
  throw error;
}

function requestInvalid() {
  connectionFail(
    "social_connection_request_invalid",
    "Requisicao de conexao Instagram recusada."
  );
}

function responseInvalid() {
  connectionFail(
    "social_connection_response_invalid",
    "Resposta de conexao Instagram recusada."
  );
}

function isRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactRecord(value, expectedKeys, fail) {
  if (!isRecord(value)) fail();
  const keys = Object.keys(value);
  if (
    keys.length !== expectedKeys.length ||
    expectedKeys.some((key) => !Object.hasOwn(value, key))
  ) {
    fail();
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set) fail();
  }
  return value;
}

function boundedText(value, minimum, maximum, fail) {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length < minimum ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    fail();
  }
  return value;
}

function requestUuid(value) {
  const clean = boundedText(value, 36, 36, requestInvalid).toLowerCase();
  if (
    !UUID_PATTERN.test(clean) ||
    clean === "00000000-0000-0000-0000-000000000000"
  ) {
    requestInvalid();
  }
  return clean;
}

function responseUuid(value) {
  const clean = boundedText(value, 36, 36, responseInvalid).toLowerCase();
  if (
    !UUID_PATTERN.test(clean) ||
    clean === "00000000-0000-0000-0000-000000000000"
  ) {
    responseInvalid();
  }
  return clean;
}

function assertEmptyInput(value) {
  if (value === undefined || value === null) return;
  if (!isRecord(value) || Object.keys(value).length !== 0) requestInvalid();
}

function assertRequestSurface(req, expectedParameterKeys) {
  const params = req?.params === undefined
    ? Object.create(null)
    : req.params;
  exactRecord(params, expectedParameterKeys, requestInvalid);
  assertEmptyInput(req?.query);
  assertEmptyInput(req?.body);
  return params;
}

function verifiedClaims(req) {
  if (!isRecord(req?.user)) {
    connectionFail("social_authenticated_principal_invalid");
  }
  return req.user;
}

function coherentStateHealth(state, health) {
  return state === "connected"
    ? health === "healthy" || health === "reconnect_required"
    : health === state;
}

function normalizeNullableDate(value) {
  if (value === null) return null;
  if (typeof value !== "string") responseInvalid();
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) {
    responseInvalid();
  }
  return value;
}

function normalizeConnection(value, { optional = false } = {}) {
  if (optional && value === null) return null;
  const source = exactRecord(
    value,
    [
      "connectionId",
      "externalId",
      "connectionRevision",
      "provider",
      "username",
      "accountType",
      "state",
      "createdAt",
      "connectedAt",
      "updatedAt",
      "disconnectedAt",
      "health"
    ],
    responseInvalid
  );
  const hasAccount = source.username !== null || source.accountType !== null;
  if (
    source.provider !== "instagram" ||
    !CONNECTION_STATES.includes(source.state) ||
    !CONNECTION_HEALTH.has(source.health) ||
    !coherentStateHealth(source.state, source.health) ||
    !Number.isSafeInteger(source.connectionRevision) || source.connectionRevision < 1 ||
    ((source.username === null) !== (source.accountType === null)) ||
    ((source.externalId === null) !== !hasAccount) ||
    (hasAccount &&
      (typeof source.username !== "string" ||
        !/^@[a-zA-Z0-9._]{1,30}$/.test(source.username) ||
        typeof source.externalId !== "string" || !/^[0-9]{5,64}$/.test(source.externalId) ||
        !PROFESSIONAL_ACCOUNT_TYPES.has(source.accountType))) ||
    (source.state === "connected" && !hasAccount)
  ) {
    responseInvalid();
  }
  return Object.freeze({
    connectionId: responseUuid(source.connectionId),
    externalId: source.externalId,
    connectionRevision: source.connectionRevision,
    provider: "instagram",
    username: source.username,
    accountType: source.accountType,
    state: source.state,
    createdAt: normalizeNullableDate(source.createdAt),
    connectedAt: normalizeNullableDate(source.connectedAt),
    updatedAt: normalizeNullableDate(source.updatedAt),
    disconnectedAt: normalizeNullableDate(source.disconnectedAt),
    health: source.health
  });
}

function normalizeConnectionResult(value, options) {
  const source = exactRecord(value, ["ok", "connection"], responseInvalid);
  if (source.ok !== true) responseInvalid();
  return Object.freeze({
    ok: true,
    connection: normalizeConnection(source.connection, options)
  });
}

function normalizeAuthorizationResult(value) {
  const result = exactRecord(value, ["ok", "authorization"], responseInvalid);
  if (result.ok !== true) responseInvalid();
  const source = exactRecord(
    result.authorization,
    ["connectionId", "purpose", "status", "expiresAt"],
    responseInvalid
  );
  if (
    !["connect", "reconnect"].includes(source.purpose) ||
    !AUTHORIZATION_STATUSES.has(source.status)
  ) {
    responseInvalid();
  }
  const authorization = Object.freeze({
    connectionId: responseUuid(source.connectionId),
    provider: "instagram",
    purpose: source.purpose,
    status: source.status,
    expiresAt: normalizeNullableDate(source.expiresAt)
  });
  return Object.freeze({ ok: true, authorization });
}

function normalizeHealthResult(value) {
  const source = exactRecord(
    value,
    ["ok", "connectionId", "provider", "state", "health", "checkedAt"],
    responseInvalid
  );
  if (
    source.ok !== true ||
    source.provider !== "instagram" ||
    !CONNECTION_STATES.includes(source.state) ||
    !CONNECTION_HEALTH.has(source.health) ||
    !coherentStateHealth(source.state, source.health)
  ) {
    responseInvalid();
  }
  return Object.freeze({
    ok: true,
    connectionId: responseUuid(source.connectionId),
    provider: "instagram",
    state: source.state,
    health: source.health,
    checkedAt: normalizeNullableDate(source.checkedAt)
  });
}

function safeQueryValue(value, minimum, maximum) {
  if (
    typeof value !== "string" ||
    value.length < minimum ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    callbackInvalid();
  }
  return value;
}

function parseCallbackQuery(originalUrl) {
  if (
    typeof originalUrl !== "string" ||
    originalUrl.length < 1 ||
    originalUrl.length > CALLBACK_MAX_URL_LENGTH
  ) {
    callbackInvalid();
  }
  let parsed;
  try {
    parsed = new URL(originalUrl, "https://callback.invalid");
  } catch {
    callbackInvalid();
  }
  const allowed = new Set([
    "state",
    "code",
    "error",
    "error_reason",
    "error_description"
  ]);
  for (const key of parsed.searchParams.keys()) {
    if (!allowed.has(key) || parsed.searchParams.getAll(key).length !== 1) {
      callbackInvalid();
    }
  }
  const stateValues = parsed.searchParams.getAll("state");
  const codeValues = parsed.searchParams.getAll("code");
  const errorValues = parsed.searchParams.getAll("error");
  if (
    stateValues.length !== 1 ||
    Number(codeValues.length === 1) + Number(errorValues.length === 1) !== 1
  ) {
    callbackInvalid();
  }
  const descriptionValues = parsed.searchParams.getAll("error_description");
  const reasonValues = parsed.searchParams.getAll("error_reason");
  if (
    descriptionValues.length > 1 ||
    reasonValues.length > 1 ||
    ((descriptionValues.length === 1 || reasonValues.length === 1) &&
      errorValues.length !== 1)
  ) {
    callbackInvalid();
  }
  if (descriptionValues.length === 1) {
    safeQueryValue(
      descriptionValues[0],
      1,
      CALLBACK_MAX_DESCRIPTION_LENGTH
    );
  }
  if (reasonValues.length === 1) {
    const reason = safeQueryValue(
      reasonValues[0],
      1,
      CALLBACK_MAX_ERROR_REASON_LENGTH
    );
    if (errorValues[0] !== "access_denied" || reason !== "user_denied") {
      callbackInvalid();
    }
  }
  return Object.freeze({
    state: safeQueryValue(stateValues[0], 1, CALLBACK_MAX_STATE_LENGTH),
    code: codeValues.length === 1
      ? safeQueryValue(codeValues[0], 1, CALLBACK_MAX_CODE_LENGTH)
      : null,
    error: errorValues.length === 1
      ? safeQueryValue(errorValues[0], 1, CALLBACK_MAX_ERROR_LENGTH)
      : null
  });
}

function noStore(_req, res, next) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  return next();
}

function publicCode(error, fallback = "social_oauth_callback_invalid") {
  const code = String(error?.code || "");
  return Object.hasOwn(PUBLIC_ERROR_STATUS, code)
    ? code
    : fallback;
}

function sendClosedError(
  res,
  error,
  fallback = "social_oauth_callback_invalid"
) {
  const code = publicCode(error, fallback);
  return res.status(PUBLIC_ERROR_STATUS[code]).json(Object.freeze({
    ok: false,
    code
  }));
}

function sendConnectionError(res, error) {
  return sendClosedError(res, error, "social_connection_unavailable");
}

function createInstagramOAuthRouter(options = {}) {
  if (
    typeof options.authenticate !== "function" ||
    typeof options.getService !== "function"
  ) {
    callbackInvalid();
  }
  const router = options.router || express.Router();
  const visualReturn = options.visualReturn || null;
  if (
    !router ||
    typeof router.post !== "function" ||
    typeof router.get !== "function" ||
    typeof router.delete !== "function"
  ) {
    callbackInvalid();
  }
  if (
    visualReturn !== null &&
    (
      typeof visualReturn.recordSuccess !== "function" ||
      typeof visualReturn.recordError !== "function" ||
      typeof visualReturn.redirectUrl !== "function" ||
      typeof visualReturn.get !== "function"
    )
  ) {
    callbackInvalid();
  }

  function wantsVisualReturn(req) {
    return Boolean(
      visualReturn &&
      /(?:^|,)\s*text\/html(?:\s*;|\s*,|\s*$)/i.test(
        String(req.headers?.accept || "")
      )
    );
  }

  function redirectToVisualReturn(res, reference) {
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Location", visualReturn.redirectUrl(reference));
    return res.status(303).end();
  }

  function service() {
    const value = options.getService();
    if (
      !value ||
      typeof value.authorize !== "function" ||
      typeof value.callback !== "function"
    ) {
      const error = new Error("OAuth Instagram indisponivel.");
      error.code = "social_instagram_configuration_invalid";
      throw error;
    }
    return value;
  }

  function serviceMethod(name) {
    const value = service();
    if (typeof value[name] !== "function") {
      connectionFail("social_connection_unavailable");
    }
    return value[name].bind(value);
  }

  router.post(
    "/connections/instagram/authorization",
    noStore,
    options.authenticate,
    async (req, res) => {
      try {
        const body = req.body;
        if (
          !body ||
          typeof body !== "object" ||
          Array.isArray(body) ||
          Object.getPrototypeOf(body) !== Object.prototype ||
          Object.keys(body).length !== 1 ||
          !Object.hasOwn(body, "purpose")
        ) {
          callbackInvalid();
        }
        const result = await service().authorize({
          verifiedClaims: req.user,
          purpose: body.purpose
        });
        return res.status(201).json(result);
      } catch (error) {
        return sendClosedError(res, error);
      }
    }
  );

  router.get(
    "/connections/instagram",
    noStore,
    options.authenticate,
    async (req, res) => {
      try {
        assertRequestSurface(req, []);
        const result = normalizeConnectionResult(
          await serviceMethod("getCurrentConnection")({
            verifiedClaims: verifiedClaims(req)
          }),
          { optional: true }
        );
        return res.status(200).json(result);
      } catch (error) {
        return sendConnectionError(res, error);
      }
    }
  );

  router.get(
    "/connections/instagram/:connectionId/authorization",
    noStore,
    options.authenticate,
    async (req, res) => {
      try {
        const params = assertRequestSurface(req, ["connectionId"]);
        const connectionId = requestUuid(params.connectionId);
        const result = normalizeAuthorizationResult(
          await serviceMethod("getAuthorizationStatus")({
            verifiedClaims: verifiedClaims(req),
            connectionId
          })
        );
        return res.status(200).json(result);
      } catch (error) {
        return sendConnectionError(res, error);
      }
    }
  );

  router.get(
    "/connections/instagram/:connectionId/health",
    noStore,
    options.authenticate,
    async (req, res) => {
      try {
        const params = assertRequestSurface(req, ["connectionId"]);
        const connectionId = requestUuid(params.connectionId);
        const result = normalizeHealthResult(
          await serviceMethod("getConnectionHealth")({
            verifiedClaims: verifiedClaims(req),
            connectionId
          })
        );
        return res.status(200).json(result);
      } catch (error) {
        return sendConnectionError(res, error);
      }
    }
  );

  router.get(
    "/connections/instagram/:connectionId",
    noStore,
    options.authenticate,
    async (req, res) => {
      try {
        const params = assertRequestSurface(req, ["connectionId"]);
        const connectionId = requestUuid(params.connectionId);
        const result = normalizeConnectionResult(
          await serviceMethod("getConnection")({
            verifiedClaims: verifiedClaims(req),
            connectionId
          })
        );
        return res.status(200).json(result);
      } catch (error) {
        return sendConnectionError(res, error);
      }
    }
  );

  router.delete(
    "/connections/instagram/:connectionId",
    noStore,
    options.authenticate,
    async (req, res) => {
      try {
        const params = assertRequestSurface(req, ["connectionId"]);
        const connectionId = requestUuid(params.connectionId);
        const result = normalizeConnectionResult(
          await serviceMethod("disconnect")({
            verifiedClaims: verifiedClaims(req),
            connectionId
          })
        );
        if (
          result.connection.state !== "disconnected" ||
          result.connection.username !== null ||
          result.connection.accountType !== null || result.connection.externalId !== null
        ) {
          responseInvalid();
        }
        return res.status(200).json(result);
      } catch (error) {
        return sendConnectionError(res, error);
      }
    }
  );

  router.get("/oauth/return/:reference", noStore, (req, res) => {
    if (!visualReturn) return res.status(404).end();
    try {
      const params = exactRecord(req.params, ["reference"], requestInvalid);
      assertEmptyInput(req?.query);
      assertEmptyInput(req?.body);
      const result = visualReturn.get(params.reference);
      if (!result) {
        return res.status(404).json(Object.freeze({
          ok: false,
          code: "social_oauth_return_unavailable"
        }));
      }
      return res.status(200).json(result);
    } catch (error) {
      return sendClosedError(res, error);
    }
  });

  router.get("/oauth/callback", noStore, async (req, res) => {
    const visual = wantsVisualReturn(req);
    try {
      const result = await service().callback(
        parseCallbackQuery(req.originalUrl || req.url)
      );
      if (visual) {
        return redirectToVisualReturn(
          res,
          visualReturn.recordSuccess(result)
        );
      }
      return res.status(200).json(result);
    } catch (error) {
      if (visual) {
        try {
          return redirectToVisualReturn(
            res,
            visualReturn.recordError(publicCode(error))
          );
        } catch (visualError) {
          return sendClosedError(res, visualError);
        }
      }
      return sendClosedError(res, error);
    }
  });

  return router;
}

module.exports = {
  CALLBACK_MAX_URL_LENGTH,
  PUBLIC_ERROR_STATUS,
  createInstagramOAuthRouter,
  parseCallbackQuery,
  sendClosedError
};
