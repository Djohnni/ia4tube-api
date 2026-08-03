"use strict";

const crypto = require("node:crypto");
const express = require("express");
const {
  createRateLimiter,
  requestIp,
  timingSafeSecretMatch
} = require("../security/runtime-security");
const {
  HTTP_CANARY_ROUTE,
  resolveHttpCanaryAvailability
} = require("./http-canary-availability");
const {
  sanitizeHttpCanaryResult,
  safeCode
} = require("./http-canary-service");

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{31,127}$/;
const DEFAULT_IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;
const DEFAULT_IDEMPOTENCY_MAX_ENTRIES = 100;

function configurationError() {
  const error = new Error("Configuracao do canario HTTP social recusada.");
  error.code = "social_http_canary_configuration_invalid";
  return error;
}

function noStore(_req, res, next) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  return next();
}

function createStrictInternalAuth(internalTokens) {
  const accepted = Object.freeze([...internalTokens]);
  return function strictInternalAuth(req, res, next) {
    if (
      req.headers.cookie ||
      req.headers.origin ||
      req.headers.referer
    ) {
      return res.status(403).json({
        ok: false,
        code: "social_http_canary_browser_auth_forbidden",
        error: "Acesso interno recusado."
      });
    }
    const authorization = req.headers.authorization;
    if (typeof authorization !== "string" || !authorization) {
      return res.status(401).json({
        ok: false,
        code: "social_http_canary_auth_required",
        error: "Autenticacao interna obrigatoria."
      });
    }
    const match = /^Bearer ([^\s]{32,4096})$/.exec(authorization);
    if (!match || !timingSafeSecretMatch(match[1], accepted)) {
      return res.status(403).json({
        ok: false,
        code: "social_http_canary_not_authorized",
        error: "Acesso interno recusado."
      });
    }
    req.socialCanaryPrincipal = crypto
      .createHash("sha256")
      .update(match[1], "utf8")
      .digest("hex");
    return next();
  };
}

function requireEmptyRequest(req, res, next) {
  const contentLength = req.headers["content-length"];
  const transferEncoding = req.headers["transfer-encoding"];
  const bodyTransportPresent =
    transferEncoding !== undefined ||
    (contentLength !== undefined && contentLength !== "0") ||
    req.body !== undefined;
  if (
    Object.keys(req.query || {}).length !== 0 ||
    bodyTransportPresent
  ) {
    return res.status(400).json({
      ok: false,
      code: "social_http_canary_input_forbidden",
      error: "O canario nao aceita dados externos."
    });
  }
  return next();
}

function createExecutionCoordinator(options = {}) {
  const clock = options.clock || Date.now;
  const ttlMs = Number(options.ttlMs || DEFAULT_IDEMPOTENCY_TTL_MS);
  const maxEntries = Number(
    options.maxEntries || DEFAULT_IDEMPOTENCY_MAX_ENTRIES
  );
  const entries = new Map();
  let activePromise = null;

  function cleanup(now = Number(clock())) {
    for (const [key, entry] of entries.entries()) {
      if (!entry || (entry.settled && entry.expiresAt <= now)) {
        entries.delete(key);
      }
    }
  }

  return function executionCoordinator(req, res, next) {
    const rawKey = req.headers["idempotency-key"];
    if (
      typeof rawKey !== "string" ||
      !IDEMPOTENCY_KEY_PATTERN.test(rawKey)
    ) {
      return res.status(400).json({
        ok: false,
        code: "social_http_canary_idempotency_key_invalid",
        error: "Chave de idempotencia obrigatoria."
      });
    }
    if (
      typeof req.socialCanaryPrincipal !== "string" ||
      !/^[0-9a-f]{64}$/.test(req.socialCanaryPrincipal)
    ) {
      return res.status(403).json({
        ok: false,
        code: "social_http_canary_not_authorized",
        error: "Acesso interno recusado."
      });
    }
    const digest = crypto
      .createHash("sha256")
      .update("ia4tube-social-http-canary-v1\0", "utf8")
      .update(req.socialCanaryPrincipal, "utf8")
      .update("\0", "utf8")
      .update(HTTP_CANARY_ROUTE, "utf8")
      .update("\0", "utf8")
      .update(String(options.commit || ""), "utf8")
      .update("\0", "utf8")
      .update(rawKey, "utf8")
      .digest("hex");
    const now = Number(clock());
    cleanup(now);
    const existing = entries.get(digest);
    if (existing) {
      return existing.promise
        .then((result) => sendResult(res, result))
        .catch((error) => sendUnexpectedFailure(res, error));
    }
    if (activePromise) {
      res.setHeader("Retry-After", "5");
      return res.status(429).json({
        ok: false,
        code: "social_http_canary_in_progress",
        error: "Ja existe um canario em execucao."
      });
    }
    if (entries.size >= maxEntries) {
      return res.status(503).json({
        ok: false,
        code: "social_http_canary_idempotency_unavailable",
        error: "Protecao temporariamente indisponivel."
      });
    }

    req.beginSocialCanaryExecution = (operation) => {
      if (activePromise) {
        const error = new Error("Canario HTTP social ja esta em execucao.");
        error.code = "social_http_canary_in_progress";
        throw error;
      }
      const promise = Promise.resolve().then(operation);
      const entry = {
        expiresAt: Number.POSITIVE_INFINITY,
        promise,
        settled: false
      };
      entries.set(digest, entry);
      activePromise = promise;
      promise.then(
        () => {
          entry.settled = true;
          entry.expiresAt = Number(clock()) + ttlMs;
          if (activePromise === promise) activePromise = null;
        },
        () => {
          entries.delete(digest);
          if (activePromise === promise) activePromise = null;
        }
      );
      return promise;
    };
    return next();
  };
}

function sendResult(res, rawResult) {
  const result = sanitizeHttpCanaryResult(rawResult);
  return res.status(result.status === "passed" ? 200 : 500).json(result);
}

function sendUnexpectedFailure(res, error) {
  const result = sanitizeHttpCanaryResult({
    runId: crypto.randomUUID(),
    status: "failed",
    errorCode: safeCode(error),
    cleanupCompleted: false,
    residualRecords: null,
    durationMs: 0
  });
  return res.status(500).json(result);
}

function createSocialHttpCanaryRouter(options = {}) {
  const env = options.env || process.env;
  const internalTokens = Array.isArray(options.internalTokens)
    ? options.internalTokens
    : [];
  const availability = resolveHttpCanaryAvailability({
    env,
    internalTokens
  });
  if (availability.invalid) throw configurationError();
  if (!availability.enabled) return null;

  const getRuntimeState = options.getRuntimeState;
  if (typeof getRuntimeState !== "function") {
    throw new TypeError("Social canary runtime provider is required.");
  }
  const router = express.Router();
  const rateLimit = createRateLimiter({
    windowMs: options.rateLimitWindowMs || 10 * 60 * 1000,
    max: options.rateLimitMax || 3,
    keyGenerator:
      options.rateLimitKeyGenerator ||
      ((req) => requestIp(req, { trustProxy: "express" })),
    store: options.rateLimitStore,
    clock: options.clock,
    code: "social_http_canary_rate_limit",
    message: "Limite do canario atingido."
  });
  const authenticate = createStrictInternalAuth(internalTokens);
  const executionCoordinator = createExecutionCoordinator({
    clock: options.clock,
    ttlMs: options.idempotencyTtlMs,
    maxEntries: options.idempotencyMaxEntries,
    commit: env.RENDER_GIT_COMMIT
  });

  router.post(
    HTTP_CANARY_ROUTE,
    noStore,
    rateLimit,
    authenticate,
    requireEmptyRequest,
    executionCoordinator,
    async (req, res) => {
      let runtimeState;
      try {
        runtimeState = getRuntimeState();
      } catch (error) {
        return sendUnexpectedFailure(res, error);
      }
      if (
        !runtimeState ||
        runtimeState.enabled !== true ||
        typeof runtimeState.runHttpCanary !== "function"
      ) {
        return res.status(503).json({
          ok: false,
          code: "social_http_canary_runtime_unavailable",
          error: "Runtime social indisponivel."
        });
      }
      try {
        const promise = req.beginSocialCanaryExecution(() =>
          runtimeState.runHttpCanary()
        );
        return sendResult(res, await promise);
      } catch (error) {
        return sendUnexpectedFailure(res, error);
      }
    }
  );
  router.all(
    HTTP_CANARY_ROUTE,
    noStore,
    rateLimit,
    authenticate,
    (_req, res) => {
      res.setHeader("Allow", "POST");
      return res.status(405).json({
        ok: false,
        code: "social_http_canary_method_not_allowed",
        error: "Metodo recusado."
      });
    }
  );
  return router;
}

module.exports = {
  DEFAULT_IDEMPOTENCY_MAX_ENTRIES,
  DEFAULT_IDEMPOTENCY_TTL_MS,
  IDEMPOTENCY_KEY_PATTERN,
  createExecutionCoordinator,
  createSocialHttpCanaryRouter,
  createStrictInternalAuth,
  requireEmptyRequest,
  sendResult
};
