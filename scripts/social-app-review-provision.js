"use strict";

// Operator-only data provisioning. Never imported by the web runtime.
// This utility creates no schema, roles, policies, connections or publications.
const crypto = require("node:crypto");
const {
  SOCIAL_OWNER_ROLE,
  SOCIAL_MIGRATOR_ROLE,
  assertNoAmbientPostgresEnvironment,
  databaseTargetFingerprint,
  loadMigrationPostgresConfig
} = require("../src/persistence/postgres/config");
const {
  ADVISORY_LOCK_ID,
  createMigrationRunner,
  readManifest
} = require("../src/persistence/postgres/migrations");
const {
  createPostgresPool,
  closePostgresPool,
  withTransaction
} = require("../src/persistence/postgres/pool");
const {
  PAID_STAGING_PUBLIC_TARGET
} = require("../src/persistence/postgres/staging-provisioner");
const { APP_REVIEW_LOGIN } = require("../src/social/app-review-policy");
const {
  deriveSocialIdentity,
  parseIdentityConfig
} = require("../src/social/identity");

const REVIEW_LOGIN = APP_REVIEW_LOGIN;
const REVIEW_NAME = "IA4Tube — Meta App Review";
const REVIEW_ORIGIN = "https://ia4tube-api-staging-checkpoint-a.onrender.com";
const FORBIDDEN_LOGINS = Object.freeze([
  "ia4tube_empresas_staging",
  "999000000000005"
]);
const TARGET_FINGERPRINT = databaseTargetFingerprint(new URL(
  `postgresql://${PAID_STAGING_PUBLIC_TARGET.migrationLogin}@` +
  `${PAID_STAGING_PUBLIC_TARGET.host}:${PAID_STAGING_PUBLIC_TARGET.port}/` +
  PAID_STAGING_PUBLIC_TARGET.database
));
const SAFE_CODE = /^app_review_provision_[a-z0-9_]+$/;

function fail(suffix) {
  const error = new Error("Provisionamento isolado de App Review recusado.");
  error.code = `app_review_provision_${suffix}`;
  throw error;
}

function deriveReviewIdentity(env) {
  const configuration = parseIdentityConfig(env);
  try {
    const derive = (login) => deriveSocialIdentity({
      namespaceUuid: configuration.namespaceUuid,
      derivationKey: configuration.key,
      derivationVersion: configuration.derivationVersion,
      legacyCompanyId: login,
      legacyUserId: login
    });
    const identity = derive(REVIEW_LOGIN);
    if (FORBIDDEN_LOGINS.some((login) => derive(login).companyId === identity.companyId)) {
      fail("protected_company_collision");
    }
    return Object.freeze({
      ...identity,
      loginKeyDigest: crypto.createHash("sha256")
        .update("ia4tube-meta-app-review-login-v1\0", "utf8")
        .update(REVIEW_LOGIN, "utf8")
        .digest("hex")
    });
  } finally {
    configuration.key.fill(0);
  }
}

function exactApproval(companyId) {
  return `PROVISION_META_APP_REVIEW:${PAID_STAGING_PUBLIC_TARGET.environmentId}:` +
    `${TARGET_FINGERPRINT}:${companyId}`;
}

function loadProvisionConfig(env = process.env) {
  assertNoAmbientPostgresEnvironment(env, "app_review_provision_ambient_postgres_forbidden");
  if (
    env.ENVIRONMENT !== "staging" ||
    env.PUBLIC_API_BASE_URL !== REVIEW_ORIGIN ||
    env.SOCIAL_EXTERNAL_CONNECTION_ENABLED !== "false" ||
    env.SOCIAL_EXTERNAL_PUBLICATION_ENABLED !== "false" ||
    env.META_APP_REVIEW_WINDOW_ENABLED !== "false" ||
    env.REAL_REVIEWER_UI_ENABLED !== "true"
  ) fail("environment_or_gates_invalid");
  if (env.DATABASE_URL !== undefined && String(env.DATABASE_URL).trim()) {
    fail("runtime_credential_forbidden");
  }
  const mode = env.META_APP_REVIEW_PROVISION_MODE || "inspect";
  if (!["inspect", "provision"].includes(mode)) fail("mode_invalid");
  const database = loadMigrationPostgresConfig(env);
  const target = PAID_STAGING_PUBLIC_TARGET;
  if (
    database.target.environment !== "staging" ||
    database.target.environmentId !== target.environmentId ||
    database.target.host !== target.host ||
    database.target.port !== target.port ||
    database.target.database !== target.database ||
    database.target.username !== target.migrationLogin ||
    database.targetFingerprint !== TARGET_FINGERPRINT ||
    database.ownerRole !== SOCIAL_OWNER_ROLE ||
    database.migratorRole !== SOCIAL_MIGRATOR_ROLE ||
    database.pool.max !== 1 || database.pool.min !== 0 ||
    database.pool.ssl?.rejectUnauthorized !== true
  ) fail("target_invalid");
  const identity = deriveReviewIdentity(env);
  if (
    env.META_APP_REVIEW_COMPANY_ID !== undefined &&
    env.META_APP_REVIEW_COMPANY_ID !== identity.companyId
  ) fail("configured_company_mismatch");
  if (mode === "provision" && (
    env.META_APP_REVIEW_PROVISION_APPROVED !== exactApproval(identity.companyId) ||
    env.META_APP_REVIEW_LOGIN_VERIFIED !== "true"
  )) fail("approval_or_login_missing");
  return Object.freeze({ database, identity, mode });
}

async function readIdentity(client, identity) {
  const company = await client.query(
    "SELECT id,name,status,identity_derivation_version " +
    "FROM ia4tube_social.companies WHERE id=$1",
    [identity.companyId]
  );
  const users = await client.query(
    "SELECT company_id,id,login_key_digest,(password_hash IS NULL) AS password_absent,status,auth_version " +
    "FROM ia4tube_social.users WHERE company_id=$1",
    [identity.companyId]
  );
  const memberships = await client.query(
    "SELECT company_id,user_id,role,status " +
    "FROM ia4tube_social.company_memberships WHERE company_id=$1",
    [identity.companyId]
  );
  const counts = [company, users, memberships].map((result) => result.rowCount);
  if (counts.some((count) => ![0, 1].includes(count))) fail("identity_cardinality");
  const c = company.rows[0];
  const u = users.rows[0];
  const m = memberships.rows[0];
  if (c && (
    c.id !== identity.companyId || c.name !== REVIEW_NAME || c.status !== "active" ||
    c.identity_derivation_version !== identity.derivationVersion
  )) fail("company_drift");
  if (u && (
    u.company_id !== identity.companyId || u.id !== identity.userId ||
    u.login_key_digest !== identity.loginKeyDigest || u.password_absent !== true ||
    u.status !== "active" || Number(u.auth_version) !== 1
  )) fail("user_drift");
  if (m && (
    m.company_id !== identity.companyId || m.user_id !== identity.userId ||
    m.role !== "owner" || m.status !== "active"
  )) fail("membership_drift");
  return counts.reduce((sum, count) => sum + count, 0);
}

async function requireUnusedTenant(client, identity) {
  // Fixed table names only; no identifiers originate in operator/browser input.
  for (const table of [
    "social_connections", "social_publications", "social_oauth_transactions",
    "social_encrypted_credentials", "social_idempotency_operations"
  ]) {
    const result = await client.query(
      `SELECT EXISTS (SELECT 1 FROM ia4tube_social.${table} WHERE company_id=$1) AS present`,
      [identity.companyId]
    );
    if (result.rowCount !== 1 || result.rows[0]?.present !== false) {
      fail("tenant_not_unused");
    }
  }
}

async function provisionData(client, config) {
  const identity = config.identity;
  await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [ADVISORY_LOCK_ID]);
  await requireUnusedTenant(client, identity);
  const existing = await readIdentity(client, identity);
  if (config.mode === "inspect") {
    return Object.freeze({ inserted: 0, existing, ready: existing === 3 });
  }
  let inserted = 0;
  const inserts = [
    ["INSERT INTO ia4tube_social.companies (id,name,status,identity_derivation_version) " +
      "VALUES ($1,$2,'active',$3) ON CONFLICT DO NOTHING RETURNING id",
    [identity.companyId, REVIEW_NAME, identity.derivationVersion]],
    ["INSERT INTO ia4tube_social.users (company_id,id,login_key_digest,password_hash,status,auth_version) " +
      "VALUES ($1,$2,$3,NULL,'active',1) ON CONFLICT DO NOTHING RETURNING id",
    [identity.companyId, identity.userId, identity.loginKeyDigest]],
    ["INSERT INTO ia4tube_social.company_memberships (company_id,user_id,role,status) " +
      "VALUES ($1,$2,'owner','active') ON CONFLICT DO NOTHING RETURNING user_id",
    [identity.companyId, identity.userId]]
  ];
  for (const [sql, parameters] of inserts) {
    const result = await client.query(sql, parameters);
    if (![0, 1].includes(result.rowCount)) fail("insert_cardinality");
    inserted += result.rowCount;
  }
  if (await readIdentity(client, identity) !== 3) fail("identity_incomplete");
  await requireUnusedTenant(client, identity);
  return Object.freeze({ inserted, existing, ready: true });
}

async function provisionAppReview(options = {}) {
  const config = loadProvisionConfig(options.env || process.env);
  const createPool = options.createPool || createPostgresPool;
  const createRunner = options.createRunner || createMigrationRunner;
  const transact = options.transact || withTransaction;
  const closePool = options.closePool || closePostgresPool;
  let pool;
  try {
    pool = createPool(config.database.pool);
    const runner = createRunner({
      pool,
      ownerRole: config.database.ownerRole,
      migratorRole: config.database.migratorRole,
      target: config.database.target
    });
    // Validation is read-only; deliberately no apply/up/down invocation.
    const status = await runner.validate();
    const count = readManifest().length;
    if (
      status?.valid !== true || status.pending !== 0 || status.applied !== count ||
      !Array.isArray(status.migrations) || status.migrations.length !== count ||
      status.migrations.some((entry) => entry.state !== "applied")
    ) fail("schema_not_current");
    const outcome = await transact(pool, (client) => provisionData(client, config), {
      role: SOCIAL_OWNER_ROLE,
      companyId: config.identity.companyId
    });
    return Object.freeze({
      ok: true,
      mode: config.mode,
      login: REVIEW_LOGIN,
      companyId: config.identity.companyId,
      userId: config.identity.userId,
      identityRowsInserted: outcome.inserted,
      identityRowsAlreadyExact: outcome.existing,
      identityReady: outcome.ready,
      socialConnectionAbsent: true,
      socialPublicationAbsent: true,
      gate4Touched: false,
      externalOperationsExecuted: false,
      schemaChanged: false
    });
  } finally {
    if (pool) await closePool(pool);
  }
}

async function main({
  argv = process.argv.slice(2), env = process.env,
  stdout = process.stdout, stderr = process.stderr,
  provision = provisionAppReview
} = {}) {
  if (!Array.isArray(argv) || argv.length !== 0) {
    stderr.write('{"ok":false,"code":"app_review_provision_argv_forbidden"}\n');
    return 2;
  }
  try {
    const result = await provision({ env });
    stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    const code = SAFE_CODE.test(String(error?.code || ""))
      ? error.code : "app_review_provision_failed";
    stderr.write(`${JSON.stringify({ ok: false, code })}\n`);
    return 1;
  }
}

if (require.main === module) main().then((code) => { process.exitCode = code; });

module.exports = {
  REVIEW_LOGIN, REVIEW_NAME, REVIEW_ORIGIN, TARGET_FINGERPRINT,
  deriveReviewIdentity, exactApproval, loadProvisionConfig, provisionAppReview, main
};
