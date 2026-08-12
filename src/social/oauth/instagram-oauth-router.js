"use strict";

const express = require("express");

const CALLBACK_MAX_URL_LENGTH = 8192;
const CALLBACK_MAX_STATE_LENGTH = 2048;
const CALLBACK_MAX_CODE_LENGTH = 2048;
const CALLBACK_MAX_ERROR_LENGTH = 64;
const CALLBACK_MAX_ERROR_REASON_LENGTH = 64;
const CALLBACK_MAX_DESCRIPTION_LENGTH = 512;
const PUBLIC_ERROR_STATUS = Object.freeze({
  social_oauth_callback_invalid: 400,
  social_oauth_state_invalid: 400,
  social_oauth_state_expired: 400,
  social_oauth_state_binding_mismatch: 400,
  social_oauth_state_already_consumed: 409,
  social_oauth_state_cancelled: 400,
  social_oauth_exchange_failed: 502,
  active_connection_exists: 409,
  idempotency_conflict: 409,
  external_capability_disabled: 503,
  social_instagram_configuration_invalid: 503
});

function callbackInvalid() {
  const error = new Error("Callback OAuth Instagram recusado.");
  error.code = "social_oauth_callback_invalid";
  throw error;
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

function publicCode(error) {
  const code = String(error?.code || "");
  return Object.hasOwn(PUBLIC_ERROR_STATUS, code)
    ? code
    : "social_oauth_callback_invalid";
}

function sendClosedError(res, error) {
  const code = publicCode(error);
  return res.status(PUBLIC_ERROR_STATUS[code]).json(Object.freeze({
    ok: false,
    code
  }));
}

function createInstagramOAuthRouter(options = {}) {
  if (
    typeof options.authenticate !== "function" ||
    typeof options.getService !== "function"
  ) {
    callbackInvalid();
  }
  const router = options.router || express.Router();
  if (
    !router ||
    typeof router.post !== "function" ||
    typeof router.get !== "function"
  ) {
    callbackInvalid();
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

  router.get("/oauth/callback", noStore, async (req, res) => {
    try {
      const result = await service().callback(
        parseCallbackQuery(req.originalUrl || req.url)
      );
      return res.status(200).json(result);
    } catch (error) {
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
