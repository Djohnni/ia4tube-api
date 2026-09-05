"use strict";

const {
  assertWebServiceDatabaseCredentialBoundary
} = require("../persistence/postgres/config");

const OFFICIAL_API_ORIGIN = "https://ia4tube-api.onrender.com";
const OFFICIAL_WEB_SERVICE_ID = "srv-d8708kd7vvec73ap1p6g";
const PREPARATION_INCOMPLETE = "social_production_preparation_incomplete";
const LEGACY_TEST_ORIGINS = new Set([
  "https://synthetic.invalid",
  "https://ia4tube.test"
]);
const CLOSED_FLAGS = Object.freeze([
  "SOCIAL_PERSISTENCE_ENABLED",
  "SOCIAL_INSTAGRAM_ENABLED",
  "SOCIAL_EXTERNAL_CONNECTION_ENABLED",
  "SOCIAL_EXTERNAL_PUBLICATION_ENABLED",
  "REAL_REVIEWER_UI_ENABLED",
  "META_APP_REVIEW_WINDOW_ENABLED",
  "REVIEW_SANDBOX_ENABLED",
  "SYNTHETIC_PROVIDER_ENABLED"
]);
const PENDING_CONTRACTS = Object.freeze([
  "production_session_v2",
  "publication_account_revision_binding",
  "production_schema_and_recovery"
]);

function refuse(code) {
  const error = new Error("Integracao social de producao indisponivel.");
  error.code = code;
  throw error;
}

function configured(value) {
  return value !== undefined && value !== null && String(value).length > 0;
}

function assertProductionPreparationBoundary(env = process.env) {
  // No environment flag or caller-supplied proof can enable this candidate.
  // The live legacy JWT is not the social JWT-v2 contract. Database structure,
  // recovery and the immutable account/revision binding are also still pending.
  for (const name of CLOSED_FLAGS) {
    const value = env[name];
    if (value === undefined || value === "" || value === "false") continue;
    if (value === "true") refuse(PREPARATION_INCOMPLETE);
    refuse("social_production_flag_invalid");
  }

  if (
    configured(env.ENVIRONMENT) &&
    env.ENVIRONMENT !== "production"
  ) {
    refuse("social_production_environment_mismatch");
  }
  if (
    configured(env.PUBLIC_API_BASE_URL) &&
    String(env.PUBLIC_API_BASE_URL).replace(/\/+$/, "") !== OFFICIAL_API_ORIGIN &&
    !(
      // Preserve only the existing offline legacy fixtures. This exception
      // cannot enable persistence, bypass a gate or impersonate Render/staging.
      env.NODE_ENV === "test" &&
      !configured(env.ENVIRONMENT) &&
      !configured(env.RENDER_SERVICE_ID) &&
      LEGACY_TEST_ORIGINS.has(env.PUBLIC_API_BASE_URL)
    )
  ) {
    refuse("social_production_origin_mismatch");
  }
  if (
    configured(env.RENDER_SERVICE_ID) &&
    env.RENDER_SERVICE_ID !== OFFICIAL_WEB_SERVICE_ID
  ) {
    refuse("social_production_service_mismatch");
  }

  // Keep the existing system-trust / no-operator-credential boundary even with
  // persistence off. This performs validation only: no pool or client is made.
  assertWebServiceDatabaseCredentialBoundary(env);
  return true;
}

function createProductionSocialIntegration(options = {}) {
  assertProductionPreparationBoundary(options.env || process.env);

  function middleware(_req, res) {
    // Mounted before the legacy 50 MB parser. No body, bearer token, tenant,
    // callback code, uploaded media or caller-supplied account is consumed.
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
    return res.status(503).json({
      ok: false,
      code: PREPARATION_INCOMPLETE,
      error: "A integracao com o Instagram ainda nao esta disponivel."
    });
  }

  return Object.freeze({
    enabled: false,
    reason: PREPARATION_INCOMPLETE,
    pendingContracts: PENDING_CONTRACTS,
    middleware
  });
}

module.exports = {
  CLOSED_FLAGS,
  OFFICIAL_API_ORIGIN,
  OFFICIAL_WEB_SERVICE_ID,
  PENDING_CONTRACTS,
  PREPARATION_INCOMPLETE,
  assertProductionPreparationBoundary,
  createProductionSocialIntegration
};
