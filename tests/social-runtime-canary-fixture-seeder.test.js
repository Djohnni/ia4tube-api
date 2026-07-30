"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  databaseTargetFingerprint
} = require("../src/persistence/postgres/config");
const {
  SET_COMPANY_SCOPE_SQL
} = require("../src/persistence/postgres/pool");
const {
  PAID_STAGING_PUBLIC_TARGET
} = require("../src/persistence/postgres/staging-provisioner");
const {
  EXPECTED_COMPANY_COLUMNS,
  FIXTURE_IDENTITY_DERIVATION_VERSION,
  FIXTURE_NAMES,
  FIXTURE_SEED_TARGET_FINGERPRINT,
  FIXTURE_STATUS,
  exactApproval,
  loadRuntimeCanaryFixtureSeedConfig,
  seedRuntimeCanaryFixtures,
  validateFixtureSchema
} = require("../src/social/runtime-canary-fixture-seeder");
const {
  main
} = require("../scripts/social-runtime-canary-fixture-seed");

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const SECRET = "Synthetic-Migration-Password-Never-Output!";

function migrationUrl(overrides = {}) {
  const target = { ...PAID_STAGING_PUBLIC_TARGET, ...overrides };
  return (
    `postgresql://${target.migrationLogin}:${SECRET}@` +
    `${target.host}:${target.port}/${target.database}` +
    "?sslmode=verify-full"
  );
}

function environment(overrides = {}) {
  const target = PAID_STAGING_PUBLIC_TARGET;
  return {
    SOCIAL_RUNTIME_CANARY_FIXTURE_SEED_EXPECTED_ENVIRONMENT_ID:
      target.environmentId,
    SOCIAL_RUNTIME_CANARY_FIXTURE_SEED_APPROVED: exactApproval(
      target.environmentId,
      FIXTURE_SEED_TARGET_FINGERPRINT
    ),
    SOCIAL_RUNTIME_CANARY_COMPANY_A_ID: COMPANY_A,
    SOCIAL_RUNTIME_CANARY_COMPANY_B_ID: COMPANY_B,
    SOCIAL_MIGRATIONS_DATABASE_URL: migrationUrl(),
    SOCIAL_DATABASE_EXPECTED_TARGET_FINGERPRINT:
      FIXTURE_SEED_TARGET_FINGERPRINT,
    SOCIAL_DATABASE_EXPECTED_RUNTIME_LOGIN: target.runtimeLogin,
    SOCIAL_MIGRATIONS_EXPECTED_LOGIN: target.migrationLogin,
    SOCIAL_DATABASE_OWNER_ROLE: "ia4tube_social_owner",
    SOCIAL_DATABASE_MIGRATOR_ROLE: "ia4tube_social_migrator",
    SOCIAL_MIGRATION_ENVIRONMENT: "staging",
    SOCIAL_MIGRATION_EXPECTED_ENVIRONMENT_ID: target.environmentId,
    SOCIAL_MIGRATION_POOL_MAX: "1",
    ...overrides
  };
}

function appliedMigrations(count = 3) {
  return {
    valid: true,
    applied: count,
    pending: 0,
    migrations: Array.from({ length: count }, (_, index) => ({
      version: `000${index + 1}_synthetic`,
      state: "applied"
    }))
  };
}

function fakeDependencies(options = {}) {
  const state = {
    poolConfiguration: null,
    poolCloseCalls: 0,
    runnerOptions: null,
    transactionOptions: null,
    queries: [],
    rows: new Map(options.existingRows || [])
  };
  const config = loadRuntimeCanaryFixtureSeedConfig(environment());
  const client = {
    async query(text, values) {
      const sql = String(text);
      state.queries.push({ sql, values });
      if (sql === "SELECT pg_advisory_xact_lock($1::bigint)") {
        return { rowCount: 1, rows: [{ pg_advisory_xact_lock: "" }] };
      }
      if (sql === SET_COMPANY_SCOPE_SQL) {
        state.scope = values[0];
        return { rowCount: 1, rows: [{ set_config: values[0] }] };
      }
      if (sql.startsWith("SELECT id, name, status")) {
        const row = state.rows.get(values[0]);
        return row
          ? { rowCount: 1, rows: [{ ...row }] }
          : { rowCount: 0, rows: [] };
      }
      if (sql.startsWith("INSERT INTO ia4tube_social.companies")) {
        assert.equal(state.scope, values[0]);
        const row = {
          id: values[0],
          name: values[1],
          status: values[2],
          identity_derivation_version: values[3]
        };
        state.rows.set(values[0], row);
        return { rowCount: 1, rows: [{ ...row }] };
      }
      throw new Error("unexpected synthetic query");
    }
  };
  return {
    state,
    dependencies: {
      env: environment(),
      loadConfig() {
        return config;
      },
      createPool(poolConfiguration) {
        state.poolConfiguration = poolConfiguration;
        return { syntheticPool: true };
      },
      createRunner(runnerOptions) {
        state.runnerOptions = runnerOptions;
        return {
          async validate() {
            return options.migrationStatus || appliedMigrations();
          }
        };
      },
      async validateSchema() {
        return {
          valid: true,
          migrationCount:
            (options.migrationStatus || appliedMigrations()).applied,
          companyTableValidated: true,
          rlsValidated: true
        };
      },
      async transact(pool, operation, transactionOptions) {
        assert.deepEqual(pool, { syntheticPool: true });
        state.transactionOptions = transactionOptions;
        return operation(client);
      },
      async closePool() {
        state.poolCloseCalls += 1;
        if (options.closeFailure) throw options.closeFailure;
      }
    }
  };
}

function exactRow(id, name) {
  return {
    id,
    name,
    status: FIXTURE_STATUS,
    identity_derivation_version:
      FIXTURE_IDENTITY_DERIVATION_VERSION
  };
}

test("configuration is pinned to the primary paid staging target", () => {
  const config = loadRuntimeCanaryFixtureSeedConfig(environment());
  assert.equal(config.target.environment, "staging");
  assert.equal(
    config.target.environmentId,
    PAID_STAGING_PUBLIC_TARGET.environmentId
  );
  assert.equal(config.target.host, PAID_STAGING_PUBLIC_TARGET.host);
  assert.equal(
    config.target.database,
    PAID_STAGING_PUBLIC_TARGET.database
  );
  assert.equal(
    config.target.username,
    PAID_STAGING_PUBLIC_TARGET.migrationLogin
  );
  assert.equal(config.pool.max, 1);
  assert.equal(config.pool.ssl.rejectUnauthorized, true);
  assert.equal(config.companies.length, 2);
});

test("public target fingerprint is the canonical database fingerprint", () => {
  const target = PAID_STAGING_PUBLIC_TARGET;
  const parsed = new URL(
    `postgresql://${target.migrationLogin}@${target.host}:` +
      `${target.port}/${target.database}`
  );
  assert.equal(
    FIXTURE_SEED_TARGET_FINGERPRINT,
    databaseTargetFingerprint(parsed)
  );
});

test("target, login, environment and exact approval drift are refused", () => {
  const target = PAID_STAGING_PUBLIC_TARGET;
  const cases = [
    {
      SOCIAL_MIGRATIONS_DATABASE_URL: migrationUrl({
        host: "other.oregon-postgres.render.com"
      }),
      SOCIAL_DATABASE_EXPECTED_TARGET_FINGERPRINT:
        "0".repeat(64)
    },
    {
      SOCIAL_MIGRATIONS_DATABASE_URL: migrationUrl({
        database: "ia4tube_social_other"
      }),
      SOCIAL_DATABASE_EXPECTED_TARGET_FINGERPRINT:
        "0".repeat(64)
    },
    {
      SOCIAL_MIGRATIONS_DATABASE_URL:
        `postgresql://other_migration:${SECRET}@${target.host}:` +
        `${target.port}/${target.database}?sslmode=verify-full`,
      SOCIAL_MIGRATIONS_EXPECTED_LOGIN: "other_migration"
    },
    {
      SOCIAL_MIGRATION_EXPECTED_ENVIRONMENT_ID:
        "33333333-3333-4333-8333-333333333333"
    },
    {
      SOCIAL_RUNTIME_CANARY_FIXTURE_SEED_APPROVED:
        "SEED_SOCIAL_RUNTIME_CANARY_FIXTURES:wrong"
    },
    { NODE_TLS_REJECT_UNAUTHORIZED: "0" },
    { PGHOST: "ambient-host" }
  ];
  for (const overrides of cases) {
    assert.throws(
      () =>
        loadRuntimeCanaryFixtureSeedConfig(
          environment(overrides)
        )
    );
  }
});

test("seeder inserts exactly two scoped company-only fixtures", async () => {
  const { state, dependencies } = fakeDependencies();
  const result = await seedRuntimeCanaryFixtures(dependencies);

  assert.equal(state.poolConfiguration.max, 1);
  assert.equal(state.poolConfiguration.min, 0);
  assert.deepEqual(state.transactionOptions, {
    role: "ia4tube_social_owner"
  });
  assert.equal(state.poolCloseCalls, 1);
  assert.equal(
    state.queries[0].sql,
    "SELECT pg_advisory_xact_lock($1::bigint)"
  );
  assert.equal(
    state.queries.filter(
      (entry) => entry.sql === SET_COMPANY_SCOPE_SQL
    ).length,
    2
  );
  assert.equal(
    state.queries.filter((entry) =>
      entry.sql.startsWith(
        "INSERT INTO ia4tube_social.companies"
      )
    ).length,
    2
  );
  assert.deepEqual(result, {
    ok: true,
    targetValidated: true,
    migrationLoginValidated: true,
    tlsVerifyFull: true,
    poolMaxOne: true,
    schemaCurrent: true,
    migrationsCurrent: true,
    fixturesRequested: 2,
    fixturesInserted: 2,
    fixturesAlreadyExact: 0,
    driftDetected: false,
    poolClosed: true,
    usersWritten: false,
    credentialsWritten: false,
    mediaWritten: false,
    oauthRequested: false,
    externalPublicationRequested: false
  });
  const output = JSON.stringify(result);
  assert.equal(output.includes(COMPANY_A), false);
  assert.equal(output.includes(COMPANY_B), false);
  assert.equal(output.includes(SECRET), false);
});

test("exact fixtures are accepted idempotently without writes", async () => {
  const existingRows = new Map([
    [COMPANY_A, exactRow(COMPANY_A, FIXTURE_NAMES[0])],
    [COMPANY_B, exactRow(COMPANY_B, FIXTURE_NAMES[1])]
  ]);
  const { state, dependencies } = fakeDependencies({ existingRows });
  const result = await seedRuntimeCanaryFixtures(dependencies);
  assert.equal(result.fixturesInserted, 0);
  assert.equal(result.fixturesAlreadyExact, 2);
  assert.equal(
    state.queries.some((entry) =>
      entry.sql.startsWith(
        "INSERT INTO ia4tube_social.companies"
      )
    ),
    false
  );
  assert.equal(state.poolCloseCalls, 1);
});

test("existing fixture drift is refused and pool is closed", async () => {
  const existingRows = new Map([
    [
      COMPANY_A,
      {
        ...exactRow(COMPANY_A, FIXTURE_NAMES[0]),
        name: `${FIXTURE_NAMES[0]} drift`
      }
    ]
  ]);
  const { state, dependencies } = fakeDependencies({ existingRows });
  await assert.rejects(
    seedRuntimeCanaryFixtures(dependencies),
    { code: "runtime_canary_fixture_drift_detected" }
  );
  assert.equal(state.poolCloseCalls, 1);
});

test("pending migrations are refused before any fixture query", async () => {
  const status = appliedMigrations();
  status.pending = 1;
  const { state, dependencies } = fakeDependencies({
    migrationStatus: status
  });
  await assert.rejects(
    seedRuntimeCanaryFixtures(dependencies),
    { code: "runtime_canary_fixture_migrations_not_current" }
  );
  assert.equal(state.queries.length, 0);
  assert.equal(state.poolCloseCalls, 1);
});

test("pool close failure prevents a successful result", async () => {
  const { dependencies } = fakeDependencies({
    closeFailure: new Error(`close failed ${SECRET}`)
  });
  await assert.rejects(
    seedRuntimeCanaryFixtures(dependencies),
    { code: "runtime_canary_fixture_pool_close_failed" }
  );
});

test("schema validator checks current contract and exact companies RLS", async () => {
  const migrations = [
    {
      version: "0001_synthetic",
      sha256: "1".repeat(64)
    }
  ];
  const queries = [];
  const client = {
    async query(text) {
      const sql = String(text);
      queries.push(sql);
      if (sql.includes("ARRAY_AGG(attribute.attname")) {
        return {
          rowCount: 1,
          rows: [{
            object_kind: "r",
            owner_name: "ia4tube_social_owner",
            rls_enabled: true,
            rls_forced: true,
            column_names: [...EXPECTED_COMPANY_COLUMNS]
          }]
        };
      }
      if (sql.includes("FROM pg_catalog.pg_policies")) {
        return {
          rowCount: 1,
          rows: [{
            policyname: "companies_company_scope",
            permissive: "PERMISSIVE",
            roles: ["public"],
            cmd: "ALL",
            qual:
              "(id = (NULLIF(current_setting(" +
              "'ia4tube.company_id'::text, true), ''::text))::uuid)",
            with_check:
              "(id = (NULLIF(current_setting(" +
              "'ia4tube.company_id'::text, true), ''::text))::uuid)"
          }]
        };
      }
      if (sql.includes("runtime_schema_contract")) {
        return {
          rowCount: 1,
          rows: [{
            version: migrations[0].version,
            checksum_sha256: migrations[0].sha256
          }]
        };
      }
      throw new Error("unexpected schema query");
    }
  };
  const result = await validateFixtureSchema(client, {
    manifest: migrations,
    ownerRole: "ia4tube_social_owner"
  });
  assert.equal(result.valid, true);
  assert.equal(result.companyTableValidated, true);
  assert.equal(result.rlsValidated, true);
  assert.equal(
    queries.some((sql) => sql.includes("pg_catalog.pg_policies")),
    true
  );
});

test("operator output redacts URLs, IDs, passwords and unsafe errors", async () => {
  let stdout = "";
  let stderr = "";
  const successStatus = await main({
    env: environment(),
    argv: [],
    stdout: { write(value) { stdout += value; } },
    stderr: { write(value) { stderr += value; } },
    async seedFixtures() {
      return {
        ok: true,
        fixturesRequested: 2,
        fixturesInserted: 2,
        poolClosed: true
      };
    }
  });
  assert.equal(successStatus, 0);
  assert.equal(stderr, "");
  for (const secret of [
    SECRET,
    COMPANY_A,
    COMPANY_B,
    PAID_STAGING_PUBLIC_TARGET.host,
    PAID_STAGING_PUBLIC_TARGET.database
  ]) {
    assert.equal(stdout.includes(secret), false);
  }

  stdout = "";
  stderr = "";
  const errorStatus = await main({
    argv: [],
    stdout: { write(value) { stdout += value; } },
    stderr: { write(value) { stderr += value; } },
    async seedFixtures() {
      const error = new Error(
        `${SECRET} ${migrationUrl()} ${COMPANY_A}`
      );
      error.code = `unsafe ${SECRET}`;
      throw error;
    }
  });
  assert.equal(errorStatus, 1);
  assert.equal(stdout, "");
  assert.match(stderr, /runtime_canary_fixture_seed_failed/);
  assert.equal(stderr.includes(SECRET), false);
  assert.equal(stderr.includes(COMPANY_A), false);
});

test("operator refuses argv without opening a pool", async () => {
  let calls = 0;
  let stderr = "";
  const status = await main({
    argv: ["unexpected"],
    stdout: { write() {} },
    stderr: { write(value) { stderr += value; } },
    async seedFixtures() {
      calls += 1;
    }
  });
  assert.equal(status, 2);
  assert.equal(calls, 0);
  assert.match(stderr, /runtime_canary_fixture_argv_refused/);
});
