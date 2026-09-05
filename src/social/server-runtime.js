"use strict";

const { createSocialRuntime } = require("./runtime");
const { postgresFail } = require("../persistence/postgres/errors");
const {
  explicitTrue
} = require("../persistence/postgres/config");

const SHUTDOWN_TIMEOUT_MS = 10000;
const SAFE_ERROR_CODE = /^[a-z0-9_]{2,96}$/i;

function safeErrorCode(error, fallback = "social_runtime_failed") {
  const code = String(error?.code || "");
  return SAFE_ERROR_CODE.test(code) ? code : fallback;
}

function disabledServerRuntime() {
  return Object.freeze({
    enabled: false,
    instagramOAuth: null,
    instagramPublication: null,
    metaCompliance: null,
    async close() {}
  });
}

async function initializeSocialServerRuntime(options = {}) {
  const env = options.env || process.env;
  if (!explicitTrue(env.SOCIAL_PERSISTENCE_ENABLED)) {
    return disabledServerRuntime();
  }
  if (
    env.SOCIAL_DATABASE_POOL_MAX !== undefined &&
    env.SOCIAL_DATABASE_POOL_MAX !== "3"
  ) {
    postgresFail(
      "social_server_runtime_pool_must_be_three",
      "Pool do runtime social recusado."
    );
  }

  const createRuntime = options.createRuntime || createSocialRuntime;
  const runtime = await createRuntime({
    env,
    logger: options.logger,
    instagramTransport: options.instagramTransport,
    instagramPublicationTransport: options.instagramPublicationTransport,
    realReviewerEnabled: options.realReviewerEnabled,
    realReviewerMedia: options.realReviewerMedia,
    publicDirectory: options.publicDirectory,
    publicationSleep: options.publicationSleep,
    clock: options.clock,
    randomBytes: options.randomBytes,
    randomUUID: options.randomUUID,
    setTimeout: options.setTimeout,
    clearTimeout: options.clearTimeout
  });
  if (
    !runtime ||
    runtime.enabled !== true ||
    typeof runtime.close !== "function"
  ) {
    postgresFail(
      "social_server_runtime_initialization_failed",
      "Runtime social nao inicializado."
    );
  }
  if (
    runtime.instagramPublication !== null &&
    runtime.instagramPublication !== undefined &&
    (
      typeof runtime.instagramPublication.arm !== "function" ||
      typeof runtime.instagramPublication.getSummary !== "function" ||
      typeof runtime.instagramPublication.publish !== "function" ||
      typeof runtime.instagramPublication.reconcile !== "function"
    )
  ) {
    postgresFail(
      "social_server_runtime_initialization_failed",
      "Runtime social nao inicializado."
    );
  }
  if (
    runtime.instagramOAuth !== null &&
    runtime.instagramOAuth !== undefined &&
    (
      typeof runtime.instagramOAuth.authorize !== "function" ||
      typeof runtime.instagramOAuth.callback !== "function" ||
      typeof runtime.instagramOAuth.disconnect !== "function" ||
      typeof runtime.instagramOAuth.getAuthorizationStatus !== "function" ||
      typeof runtime.instagramOAuth.getConnection !== "function" ||
      typeof runtime.instagramOAuth.getConnectionHealth !== "function" ||
      typeof runtime.instagramOAuth.getCurrentConnection !== "function"
    )
  ) {
    postgresFail(
      "social_server_runtime_initialization_failed",
      "Runtime social nao inicializado."
    );
  }
  if (
    runtime.instagramReviewer !== null &&
    runtime.instagramReviewer !== undefined &&
    (
      typeof runtime.instagramReviewer.getPublication !== "function" ||
      typeof runtime.instagramReviewer.listMedia !== "function" ||
      typeof runtime.instagramReviewer.listPublications !== "function" ||
      typeof runtime.instagramReviewer.publish !== "function" ||
      typeof runtime.instagramReviewer.reconcile !== "function"
    )
  ) {
    postgresFail(
      "social_server_runtime_initialization_failed",
      "Runtime social nao inicializado."
    );
  }
  if (
    runtime.metaCompliance !== null &&
    runtime.metaCompliance !== undefined &&
    (
      typeof runtime.metaCompliance.handleDeauthorization !== "function" ||
      typeof runtime.metaCompliance.handleDataDeletion !== "function" ||
      typeof runtime.metaCompliance.getStatus !== "function"
    )
  ) {
    postgresFail(
      "social_server_runtime_initialization_failed",
      "Runtime social nao inicializado."
    );
  }

  let closed = false;
  return Object.freeze({
    enabled: true,
    instagramOAuth: runtime.instagramOAuth || null,
    instagramPublication: runtime.instagramPublication || null,
    ...(runtime.instagramReviewer
      ? { instagramReviewer: runtime.instagramReviewer }
      : {}),
    metaCompliance: runtime.metaCompliance || null,
    async close() {
      if (closed) return;
      closed = true;
      await runtime.close();
    }
  });
}

function closeHttpServer(server) {
  return new Promise((resolve, reject) => {
    try {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    } catch (error) {
      reject(error);
    }
  });
}

function installSocialRuntimeShutdown(options = {}) {
  const runtimeState = options.runtimeState;
  if (!runtimeState?.enabled) return false;

  const server = options.server;
  const processObject = options.processObject || process;
  const timeoutMs = options.timeoutMs || SHUTDOWN_TIMEOUT_MS;
  const exit =
    options.exit ||
    ((code) => {
      processObject.exit(code);
    });
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  if (
    !server ||
    typeof server.close !== "function" ||
    typeof processObject.once !== "function" ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1
  ) {
    postgresFail(
      "social_server_shutdown_configuration_invalid",
      "Encerramento do runtime social recusado."
    );
  }

  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    const forced = setTimer(() => exit(1), timeoutMs);
    if (forced && typeof forced.unref === "function") forced.unref();
    let exitCode = 0;
    try {
      await closeHttpServer(server);
    } catch {
      exitCode = 1;
    }
    try {
      await runtimeState.close();
    } catch {
      exitCode = 1;
    }
    clearTimer(forced);
    exit(exitCode);
  }

  processObject.once("SIGTERM", shutdown);
  processObject.once("SIGINT", shutdown);
  return true;
}

module.exports = {
  SHUTDOWN_TIMEOUT_MS,
  initializeSocialServerRuntime,
  installSocialRuntimeShutdown,
  safeErrorCode
};
