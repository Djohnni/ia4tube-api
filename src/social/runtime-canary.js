"use strict";

const {
  loadRuntimePostgresConfig
} = require("../persistence/postgres/config");
const {
  closePostgresPool,
  createPostgresPool,
  verifyRuntimeRole,
  withTransaction
} = require("../persistence/postgres/pool");
const {
  verifyRuntimeSchema
} = require("../persistence/postgres/runtime-validation");
const { postgresFail } = require("../persistence/postgres/errors");
const { requireUuid } = require("../persistence/postgres/validation");
const { createSocialRuntime } = require("./runtime");

const CANARY_APPROVAL = "RUN_SOCIAL_RUNTIME_CANARY_STAGING";
const RUNTIME_ROLE = "ia4tube_social_runtime";
const SYNTHETIC_COMPANY_PREFIX = "Synthetic Company ";
const STAGING_DATABASE_HOST =
  "dpg-d9l8u27qj5pc738k3rvg-a.oregon-postgres.render.com";
const STAGING_DATABASE_NAME = "ia4tube_social_staging";
const STAGING_ENVIRONMENT_ID =
  "f9001d31-5cb4-471b-87de-96ef7dc7bd4e";

function fail(code) {
  postgresFail(code, "Canario do runtime social recusado.");
}

function validateCanaryEnvironment(env = process.env) {
  if (
    env.SOCIAL_RUNTIME_CANARY_APPROVED !== CANARY_APPROVAL ||
    env.SOCIAL_RUNTIME_CANARY_ENVIRONMENT !== "staging" ||
    env.SOCIAL_RUNTIME_CANARY_EXPECTED_ENVIRONMENT_ID !==
      STAGING_ENVIRONMENT_ID ||
    env.SOCIAL_PERSISTENCE_ENABLED !== "true"
  ) {
    fail("social_runtime_canary_approval_missing");
  }
  if (
    env.SOCIAL_DATABASE_POOL_MAX !== undefined &&
    env.SOCIAL_DATABASE_POOL_MAX !== "3"
  ) {
    fail("social_runtime_canary_pool_must_be_three");
  }

  const companyA = requireUuid(
    env.SOCIAL_RUNTIME_CANARY_COMPANY_A_ID,
    "social_runtime_canary_company_a"
  );
  const companyB = requireUuid(
    env.SOCIAL_RUNTIME_CANARY_COMPANY_B_ID,
    "social_runtime_canary_company_b"
  );
  if (companyA === companyB) {
    fail("social_runtime_canary_companies_must_differ");
  }

  let parsed;
  let database;
  try {
    parsed = new URL(env.DATABASE_URL);
    database = decodeURIComponent(parsed.pathname.slice(1));
  } catch {
    fail("social_runtime_canary_target_invalid");
  }
  if (
    !parsed.hostname ||
    !database ||
    parsed.hostname.toLowerCase() !== STAGING_DATABASE_HOST ||
    (parsed.port || "5432") !== "5432" ||
    database !== STAGING_DATABASE_NAME
  ) {
    fail("social_runtime_canary_target_invalid");
  }
  return Object.freeze({ companyA, companyB });
}

function companyVisibilityQuery(client, targetCompanyId) {
  return client.query(
    [
      "SELECT id",
      "FROM ia4tube_social.companies",
      "WHERE id = $1",
      "  AND status = 'active'",
      "  AND left(name, $2) = $3"
    ].join("\n"),
    [
      targetCompanyId,
      SYNTHETIC_COMPANY_PREFIX.length,
      SYNTHETIC_COMPANY_PREFIX
    ]
  );
}

async function runSyntheticRuntimeCanary(options = {}) {
  const env = options.env || process.env;
  const target = validateCanaryEnvironment(env);
  const createRuntime = options.createRuntime || createSocialRuntime;
  const loadConfig = options.loadConfig || loadRuntimePostgresConfig;
  const createPool = options.createPool || createPostgresPool;
  const verifyRole = options.verifyRole || verifyRuntimeRole;
  const verifySchema = options.verifySchema || verifyRuntimeSchema;
  const transact = options.transact || withTransaction;
  const closePool = options.closePool || closePostgresPool;

  let runtime;
  let runtimeClosed = false;
  let pool;
  try {
    runtime = await createRuntime({ env, logger: options.logger });
    if (
      !runtime ||
      runtime.enabled !== true ||
      typeof runtime.close !== "function"
    ) {
      fail("social_runtime_canary_runtime_not_initialized");
    }
    await runtime.close();
    runtimeClosed = true;

    const config = loadConfig(env);
    if (!config.enabled || config.pool.max !== 3) {
      fail("social_runtime_canary_pool_must_be_three");
    }
    pool = createPool(
      Object.freeze({ ...config.pool, max: 1, min: 0 }),
      { logger: options.logger, PoolClass: options.PoolClass }
    );
    await verifyRole(pool, config.role);
    await verifySchema(pool, config.role);

    const scoped = (scope, targetCompanyId) =>
      transact(
        pool,
        (client) => companyVisibilityQuery(client, targetCompanyId),
        scope
          ? { role: RUNTIME_ROLE, companyId: scope }
          : { role: RUNTIME_ROLE }
      );

    const ownA = await scoped(target.companyA, target.companyA);
    const ownB = await scoped(target.companyB, target.companyB);
    const aFromB = await scoped(target.companyB, target.companyA);
    const bFromA = await scoped(target.companyA, target.companyB);
    const withoutScopeA = await scoped(null, target.companyA);
    const withoutScopeB = await scoped(null, target.companyB);
    if (
      ownA.rowCount !== 1 ||
      ownB.rowCount !== 1 ||
      aFromB.rowCount !== 0 ||
      bFromA.rowCount !== 0 ||
      withoutScopeA.rowCount !== 0 ||
      withoutScopeB.rowCount !== 0
    ) {
      fail("social_runtime_canary_isolation_failed");
    }

    return Object.freeze({
      ok: true,
      runtimeInitialized: true,
      runtimeConfigurationValidated: true,
      runtimePoolMaxThree: true,
      probePoolMaxOne: true,
      companyAVisibleOnlyInOwnScope: true,
      companyBVisibleOnlyInOwnScope: true,
      crossTenantDenied: true,
      unscopedDenied: true,
      databaseWrites: false,
      oauthRequested: false,
      externalPublicationRequested: false
    });
  } finally {
    let cleanupError;
    if (pool) {
      try {
        await closePool(pool);
      } catch (error) {
        cleanupError = error;
      }
    }
    if (
      runtime &&
      !runtimeClosed &&
      typeof runtime.close === "function"
    ) {
      try {
        await runtime.close();
      } catch (error) {
        cleanupError ||= error;
      }
    }
    if (cleanupError) throw cleanupError;
  }
}

module.exports = {
  CANARY_APPROVAL,
  RUNTIME_ROLE,
  STAGING_DATABASE_HOST,
  STAGING_DATABASE_NAME,
  STAGING_ENVIRONMENT_ID,
  SYNTHETIC_COMPANY_PREFIX,
  runSyntheticRuntimeCanary,
  validateCanaryEnvironment
};
