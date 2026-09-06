"use strict";

const { postgresFail } = require("./errors");

// Operator-only initial exception. This is an authorization record, NOT recovery
// evidence, a cryptographic proof of the owner, or an HTTP/runtime capability.
const INITIAL_AUTHORIZATION_ID = "11c99ba1-a051-4358-b823-ab9d9c772b45";
const INITIAL_AUTHORIZATION_SHA256 = "88b23e3672e9593a06513a0403fc7b7a503c578f5849f4448f204f38662b805e";
const INITIAL_PRODUCTION_APPROVAL = "APPLY_INITIAL_SOCIAL_MIGRATIONS_11C99BA1";
const INITIAL_TARGET = Object.freeze({
  resourceId: "dpg-dae4tmf40ujc73dr2dog-a",
  host: "dpg-dae4tmf40ujc73dr2dog-a.oregon-postgres.render.com",
  port: 5432,
  database: "ia4tube_social_production"
});
const SHA256 = /^[0-9a-f]{64}$/;
const COMMON_FIELDS = Object.freeze([
  "resourceId", "beforeCatalogSha256", "afterCatalogSha256", "executionPackageDigest",
  "initialAuthorizationId", "initialAuthorizationSha256"
]);
const STEP_FIELDS = Object.freeze([
  "expectedApplied", "migration", "migrationSha256", "fromProfile", "toProfile"
]);

function refuse(code) { postgresFail(code, "Excecao inicial de producao recusada."); }

function assertInitialProductionTarget(target, env, fingerprint) {
  if (!target || target.environment !== "production" || target.resourceId !== INITIAL_TARGET.resourceId ||
      target.host !== INITIAL_TARGET.host || String(target.port) !== String(INITIAL_TARGET.port) ||
      target.database !== INITIAL_TARGET.database ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(String(target.environmentId)) ||
      typeof target.username !== "string" || !/^[a-z][a-z0-9_]{2,62}$/.test(target.username) ||
      target.username.startsWith("pg_") ||
      ["ia4tube_social_owner", "ia4tube_social_migrator", "ia4tube_social_runtime"].includes(target.username)) {
    refuse("migration_initial_target_mismatch");
  }
  if (!SHA256.test(fingerprint) || env?.SOCIAL_MIGRATION_TARGET_FINGERPRINT !== fingerprint) {
    refuse("migration_target_not_verified");
  }
  if (target.approval !== "APPLY_SOCIAL_MIGRATIONS" || target.productionApproval !== INITIAL_PRODUCTION_APPROVAL) {
    refuse("migration_initial_not_approved");
  }
}

function validateInitialProductionRequest(request, { ledger = false } = {}) {
  const fields = ledger ? COMMON_FIELDS : [...COMMON_FIELDS, ...STEP_FIELDS];
  if (!request || Object.getPrototypeOf(request) !== Object.prototype ||
      Object.keys(request).length !== fields.length || fields.some(field => !Object.hasOwn(request, field)) ||
      Object.keys(request).some(field => !fields.includes(field))) {
    refuse("migration_initial_request_invalid");
  }
  if (request.initialAuthorizationId !== INITIAL_AUTHORIZATION_ID ||
      request.initialAuthorizationSha256 !== INITIAL_AUTHORIZATION_SHA256) {
    refuse("migration_initial_authorization_mismatch");
  }
  if (request.resourceId !== INITIAL_TARGET.resourceId ||
      ![request.beforeCatalogSha256, request.afterCatalogSha256, request.executionPackageDigest]
        .every(value => typeof value === "string" && SHA256.test(value))) {
    refuse("migration_preparation_evidence_required");
  }
  return Object.freeze({ ...request });
}

function initialRecoveryDecision() {
  return Object.freeze({
    status: "initial-owner-authorized-exception",
    authorizationId: INITIAL_AUTHORIZATION_ID,
    authorizationSha256: INITIAL_AUTHORIZATION_SHA256,
    resourceId: INITIAL_TARGET.resourceId,
    database: INITIAL_TARGET.database,
    scope: "initial-existing-production-database-migrations-0001-through-0008",
    recoveryProven: false,
    isolatedRestoreVerified: false,
    collationCompatibilityResolved: false,
    historicalOwnerTestDataRiskAccepted: true,
    deletionAuthorized: false,
    thirdPartyDataLossAuthorized: false,
    futureDataProtectionWaived: false,
    instagramExternalOperationsAuthorized: false
  });
}

module.exports = {
  INITIAL_AUTHORIZATION_ID, INITIAL_AUTHORIZATION_SHA256, INITIAL_PRODUCTION_APPROVAL,
  INITIAL_TARGET, assertInitialProductionTarget, validateInitialProductionRequest, initialRecoveryDecision
};
