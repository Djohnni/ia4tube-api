"use strict";

const {
  SOCIAL_MIGRATOR_ROLE,
  SOCIAL_OWNER_ROLE,
  assertNoAmbientPostgresEnvironment,
  databaseTargetFingerprint,
  loadMigrationPostgresConfig
} = require("../persistence/postgres/config");
const { postgresFail } = require("../persistence/postgres/errors");
const {
  ADVISORY_LOCK_ID,
  createMigrationRunner,
  readManifest
} = require("../persistence/postgres/migrations");
const {
  SET_COMPANY_SCOPE_SQL,
  closePostgresPool,
  createPostgresPool,
  withTransaction
} = require("../persistence/postgres/pool");
const {
  canonicalPolicyExpression,
  validateContractRows
} = require("../persistence/postgres/runtime-validation");
const { requireUuid } = require("../persistence/postgres/validation");
const {
  PAID_STAGING_PUBLIC_TARGET
} = require("../persistence/postgres/staging-provisioner");
const {
  SYNTHETIC_COMPANY_PREFIX
} = require("./runtime-canary");

const FIXTURE_SEED_APPROVAL_PREFIX =
  "SEED_SOCIAL_RUNTIME_CANARY_FIXTURES:";
const FIXTURE_IDENTITY_DERIVATION_VERSION = "v1";
const FIXTURE_STATUS = "active";
const FIXTURE_NAMES = Object.freeze([
  `${SYNTHETIC_COMPANY_PREFIX}Runtime Canary A`,
  `${SYNTHETIC_COMPANY_PREFIX}Runtime Canary B`
]);
const EXPECTED_COMPANY_COLUMNS = Object.freeze([
  "id",
  "name",
  "status",
  "identity_derivation_version",
  "created_at",
  "updated_at"
]);
const EXPECTED_POLICY_EXPRESSION =
  "id=nullifcurrent_setting'ia4tube.company_id',true,''::uuid";

function fail(code) {
  postgresFail(code, "Fixture sintetico do canario recusado.");
}

function expectedTargetFingerprint() {
  const target = PAID_STAGING_PUBLIC_TARGET;
  return databaseTargetFingerprint(
    new URL(
      `postgresql://${target.migrationLogin}@${target.host}:` +
        `${target.port}/${target.database}`
    )
  );
}

const FIXTURE_SEED_TARGET_FINGERPRINT = expectedTargetFingerprint();

function exactApproval(environmentId, fingerprint) {
  return (
    `${FIXTURE_SEED_APPROVAL_PREFIX}${environmentId}:` +
    fingerprint
  );
}

function loadRuntimeCanaryFixtureSeedConfig(env = process.env) {
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    fail("runtime_canary_fixture_tls_disabled");
  }
  assertNoAmbientPostgresEnvironment(
    env,
    "runtime_canary_fixture_postgres_environment_override_forbidden"
  );
  const expectedEnvironmentId = requireUuid(
    env.SOCIAL_RUNTIME_CANARY_FIXTURE_SEED_EXPECTED_ENVIRONMENT_ID,
    "runtime_canary_fixture_expected_environment_id"
  );
  const companyA = requireUuid(
    env.SOCIAL_RUNTIME_CANARY_COMPANY_A_ID,
    "runtime_canary_fixture_company_a"
  );
  const companyB = requireUuid(
    env.SOCIAL_RUNTIME_CANARY_COMPANY_B_ID,
    "runtime_canary_fixture_company_b"
  );
  if (companyA === companyB) {
    fail("runtime_canary_fixture_companies_must_differ");
  }

  const migration = loadMigrationPostgresConfig(env);
  const target = PAID_STAGING_PUBLIC_TARGET;
  const fingerprint = migration.targetFingerprint;
  if (
    expectedEnvironmentId !== target.environmentId ||
    migration.target.environment !== "staging" ||
    migration.target.environmentId !== target.environmentId ||
    migration.target.host !== target.host ||
    migration.target.port !== target.port ||
    migration.target.database !== target.database ||
    migration.target.username !== target.migrationLogin ||
    migration.targetFingerprint !== FIXTURE_SEED_TARGET_FINGERPRINT ||
    migration.ownerRole !== SOCIAL_OWNER_ROLE ||
    migration.migratorRole !== SOCIAL_MIGRATOR_ROLE ||
    migration.pool.max !== 1 ||
    migration.pool.min !== 0 ||
    migration.pool.ssl?.rejectUnauthorized !== true
  ) {
    fail("runtime_canary_fixture_target_mismatch");
  }
  if (
    env.SOCIAL_RUNTIME_CANARY_FIXTURE_SEED_APPROVED !==
    exactApproval(expectedEnvironmentId, fingerprint)
  ) {
    fail("runtime_canary_fixture_approval_invalid");
  }

  return Object.freeze({
    ...migration,
    companies: Object.freeze([
      Object.freeze({ id: companyA, name: FIXTURE_NAMES[0] }),
      Object.freeze({ id: companyB, name: FIXTURE_NAMES[1] })
    ])
  });
}

function exactStringArray(value, expected) {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index])
  );
}

async function validateFixtureSchema(client, options = {}) {
  const ownerRole = options.ownerRole || SOCIAL_OWNER_ROLE;
  const manifest =
    options.manifest || readManifest(options.manifestOptions);
  const structure = await client.query(
    [
      "SELECT relation.relkind AS object_kind,",
      "  owner.rolname AS owner_name,",
      "  relation.relrowsecurity AS rls_enabled,",
      "  relation.relforcerowsecurity AS rls_forced,",
      "  ARRAY_AGG(attribute.attname ORDER BY attribute.attnum)",
      "    FILTER (WHERE attribute.attnum > 0",
      "      AND NOT attribute.attisdropped) AS column_names",
      "FROM pg_catalog.pg_class relation",
      "JOIN pg_catalog.pg_namespace namespace",
      "  ON namespace.oid = relation.relnamespace",
      "JOIN pg_catalog.pg_roles owner",
      "  ON owner.oid = relation.relowner",
      "JOIN pg_catalog.pg_attribute attribute",
      "  ON attribute.attrelid = relation.oid",
      "WHERE namespace.nspname = 'ia4tube_social'",
      "  AND relation.relname = 'companies'",
      "GROUP BY relation.relkind, owner.rolname,",
      "  relation.relrowsecurity, relation.relforcerowsecurity"
    ].join("\n")
  );
  const table = structure.rows?.[0];
  if (
    structure.rowCount !== 1 ||
    table?.object_kind !== "r" ||
    table?.owner_name !== ownerRole ||
    table?.rls_enabled !== true ||
    table?.rls_forced !== true ||
    !exactStringArray(table?.column_names, EXPECTED_COMPANY_COLUMNS)
  ) {
    fail("runtime_canary_fixture_schema_invalid");
  }

  const policyResult = await client.query(
    [
      "SELECT policyname, permissive, roles, cmd, qual, with_check",
      "FROM pg_catalog.pg_policies",
      "WHERE schemaname = 'ia4tube_social'",
      "  AND tablename = 'companies'"
    ].join("\n")
  );
  const policy = policyResult.rows?.[0];
  const policyRoles = Array.isArray(policy?.roles)
    ? policy.roles.map((entry) => String(entry).toLowerCase())
    : [];
  if (
    policyResult.rowCount !== 1 ||
    policy?.policyname !== "companies_company_scope" ||
    policy?.permissive !== "PERMISSIVE" ||
    !exactStringArray(policyRoles, ["public"]) ||
    policy?.cmd !== "ALL" ||
    canonicalPolicyExpression(policy?.qual) !==
      EXPECTED_POLICY_EXPRESSION ||
    canonicalPolicyExpression(policy?.with_check) !==
      EXPECTED_POLICY_EXPRESSION
  ) {
    fail("runtime_canary_fixture_rls_invalid");
  }

  const contract = await client.query(
    [
      "SELECT version, checksum_sha256",
      "FROM ia4tube_social.runtime_schema_contract",
      "ORDER BY version"
    ].join("\n")
  );
  validateContractRows(contract.rows, manifest);
  return Object.freeze({
    valid: true,
    migrationCount: manifest.length,
    companyTableValidated: true,
    rlsValidated: true
  });
}

function fixtureRowIsExact(row, fixture) {
  return (
    row?.id === fixture.id &&
    row?.name === fixture.name &&
    row?.status === FIXTURE_STATUS &&
    row?.identity_derivation_version ===
      FIXTURE_IDENTITY_DERIVATION_VERSION
  );
}

async function seedFixture(client, fixture) {
  await client.query(SET_COMPANY_SCOPE_SQL, [fixture.id]);
  const existing = await client.query(
    [
      "SELECT id, name, status, identity_derivation_version",
      "FROM ia4tube_social.companies",
      "WHERE id = $1"
    ].join("\n"),
    [fixture.id]
  );
  if (existing.rowCount === 1) {
    if (!fixtureRowIsExact(existing.rows?.[0], fixture)) {
      fail("runtime_canary_fixture_drift_detected");
    }
    return "existing";
  }
  if (existing.rowCount !== 0) {
    fail("runtime_canary_fixture_cardinality_invalid");
  }

  const inserted = await client.query(
    [
      "INSERT INTO ia4tube_social.companies (",
      "  id, name, status, identity_derivation_version",
      ") VALUES ($1, $2, $3, $4)",
      "RETURNING id, name, status, identity_derivation_version"
    ].join("\n"),
    [
      fixture.id,
      fixture.name,
      FIXTURE_STATUS,
      FIXTURE_IDENTITY_DERIVATION_VERSION
    ]
  );
  if (
    inserted.rowCount !== 1 ||
    !fixtureRowIsExact(inserted.rows?.[0], fixture)
  ) {
    fail("runtime_canary_fixture_insert_unconfirmed");
  }
  return "inserted";
}

async function seedRuntimeCanaryFixtures(options = {}) {
  const env = options.env || process.env;
  const loadConfig =
    options.loadConfig || loadRuntimeCanaryFixtureSeedConfig;
  const createPool = options.createPool || createPostgresPool;
  const createRunner = options.createRunner || createMigrationRunner;
  const transact = options.transact || withTransaction;
  const schemaValidator =
    options.validateSchema || validateFixtureSchema;
  const closePool = options.closePool || closePostgresPool;
  const config = loadConfig(env);

  let pool;
  let outcome;
  let operationError;
  let poolClosed = false;
  try {
    pool = createPool(
      Object.freeze({ ...config.pool, max: 1, min: 0 }),
      { logger: options.logger, PoolClass: options.PoolClass }
    );
    const runner = createRunner({
      pool,
      ownerRole: config.ownerRole,
      migratorRole: config.migratorRole,
      target: config.target,
      manifestOptions: options.manifestOptions
    });
    const migrationStatus = await runner.validate();
    if (
      migrationStatus?.valid !== true ||
      !Number.isSafeInteger(migrationStatus.applied) ||
      migrationStatus.applied < 1 ||
      migrationStatus.pending !== 0 ||
      !Array.isArray(migrationStatus.migrations) ||
      migrationStatus.migrations.length !== migrationStatus.applied ||
      migrationStatus.migrations.some(
        (entry) => entry?.state !== "applied"
      )
    ) {
      fail("runtime_canary_fixture_migrations_not_current");
    }

    outcome = await transact(
      pool,
      async (client) => {
        await client.query(
          "SELECT pg_advisory_xact_lock($1::bigint)",
          [ADVISORY_LOCK_ID]
        );
        const schema = await schemaValidator(client, {
          ownerRole: config.ownerRole,
          manifestOptions: options.manifestOptions
        });
        if (
          schema?.valid !== true ||
          schema.companyTableValidated !== true ||
          schema.rlsValidated !== true ||
          schema.migrationCount !== migrationStatus.applied
        ) {
          fail("runtime_canary_fixture_schema_invalid");
        }

        let inserted = 0;
        let alreadyExact = 0;
        for (const fixture of config.companies) {
          const state = await seedFixture(client, fixture);
          if (state === "inserted") inserted += 1;
          if (state === "existing") alreadyExact += 1;
        }
        if (
          inserted + alreadyExact !== 2 ||
          config.companies.length !== 2
        ) {
          fail("runtime_canary_fixture_count_invalid");
        }
        return Object.freeze({ inserted, alreadyExact });
      },
      { role: SOCIAL_OWNER_ROLE }
    );
  } catch (error) {
    operationError = error;
  }

  if (pool) {
    try {
      await closePool(pool);
      poolClosed = true;
    } catch (error) {
      postgresFail(
        "runtime_canary_fixture_pool_close_failed",
        "Fechamento do pool do fixture nao foi confirmado.",
        error
      );
    }
  }
  if (operationError) throw operationError;
  if (!poolClosed) {
    fail("runtime_canary_fixture_pool_close_unconfirmed");
  }

  return Object.freeze({
    ok: true,
    targetValidated: true,
    migrationLoginValidated: true,
    tlsVerifyFull: true,
    poolMaxOne: true,
    schemaCurrent: true,
    migrationsCurrent: true,
    fixturesRequested: 2,
    fixturesInserted: outcome.inserted,
    fixturesAlreadyExact: outcome.alreadyExact,
    driftDetected: false,
    poolClosed: true,
    usersWritten: false,
    credentialsWritten: false,
    mediaWritten: false,
    oauthRequested: false,
    externalPublicationRequested: false
  });
}

module.exports = {
  EXPECTED_COMPANY_COLUMNS,
  FIXTURE_IDENTITY_DERIVATION_VERSION,
  FIXTURE_NAMES,
  FIXTURE_SEED_APPROVAL_PREFIX,
  FIXTURE_SEED_TARGET_FINGERPRINT,
  FIXTURE_STATUS,
  exactApproval,
  loadRuntimeCanaryFixtureSeedConfig,
  seedRuntimeCanaryFixtures,
  validateFixtureSchema
};
