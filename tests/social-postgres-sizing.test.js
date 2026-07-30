"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  databaseTargetFingerprint,
  loadMigrationPostgresConfig,
  loadRuntimePostgresConfig
} = require("../src/persistence/postgres/config");
const {
  MIGRATION_CONNECTION_LIMIT
} = require("../src/persistence/postgres/login-bootstrap");
const {
  LOOPBACK_MODE,
  PAID_STAGING_TARGET,
  REMOTE_DATABASE,
  RENDER_PAID_STAGING_MODE,
  RENDER_REMOTE_MODE,
  RUNTIME_POOL_MAX,
  SIZING_APPROVAL,
  SIZING_PAID_STAGING_APPROVAL,
  SIZING_REMOTE_APPROVAL,
  SIZING_TASK_COUNT,
  SYNTHETIC_QUERY,
  fingerprint,
  runSizingHarness,
  validateSizingEnvironment
} = require("../src/persistence/postgres/sizing-harness");
const {
  main: sizingMain
} = require("../scripts/social-postgres-sizing");

const environmentId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function loopbackEnvironment(overrides = {}) {
  const target = {
    mode: LOOPBACK_MODE,
    environmentId,
    host: "localhost",
    port: "5432",
    database: "ia4tube_social_test_sizing",
    username: "ia4tube_social_runtime"
  };
  return {
    SOCIAL_POSTGRES_SIZING_APPROVED: SIZING_APPROVAL,
    SOCIAL_POSTGRES_SIZING_TARGET_MODE: LOOPBACK_MODE,
    SOCIAL_POSTGRES_SIZING_ENVIRONMENT_ID: environmentId,
    SOCIAL_POSTGRES_SIZING_DATABASE_URL:
      "postgresql://ia4tube_social_runtime:synthetic@localhost/" +
      "ia4tube_social_test_sizing?sslmode=disable",
    SOCIAL_POSTGRES_SIZING_EXPECTED_HOST: target.host,
    SOCIAL_POSTGRES_SIZING_EXPECTED_PORT: target.port,
    SOCIAL_POSTGRES_SIZING_EXPECTED_DATABASE: target.database,
    SOCIAL_POSTGRES_SIZING_EXPECTED_USERNAME: target.username,
    SOCIAL_POSTGRES_SIZING_EXPECTED_TARGET_FINGERPRINT:
      fingerprint(target),
    ...overrides
  };
}

function remoteEnvironment(overrides = {}) {
  const target = {
    mode: RENDER_REMOTE_MODE,
    environmentId,
    host: "synthetic-a.oregon-postgres.render.com",
    port: "5432",
    database: REMOTE_DATABASE,
    username: "synthetic_runtime"
  };
  return {
    SOCIAL_POSTGRES_SIZING_APPROVED: SIZING_APPROVAL,
    SOCIAL_POSTGRES_SIZING_RENDER_REMOTE_APPROVED:
      SIZING_REMOTE_APPROVAL,
    SOCIAL_POSTGRES_SIZING_TARGET_MODE: RENDER_REMOTE_MODE,
    SOCIAL_POSTGRES_SIZING_ENVIRONMENT_ID: environmentId,
    SOCIAL_POSTGRES_SIZING_DATABASE_URL:
      "postgresql://synthetic_runtime:synthetic-password@" +
      `${target.host}:${target.port}/${target.database}` +
      "?sslmode=verify-full",
    SOCIAL_POSTGRES_SIZING_EXPECTED_HOST: target.host,
    SOCIAL_POSTGRES_SIZING_EXPECTED_PORT: target.port,
    SOCIAL_POSTGRES_SIZING_EXPECTED_DATABASE: target.database,
    SOCIAL_POSTGRES_SIZING_EXPECTED_USERNAME: target.username,
    SOCIAL_POSTGRES_SIZING_EXPECTED_TARGET_FINGERPRINT:
      fingerprint(target),
    ...overrides
  };
}

function paidEnvironment(overrides = {}) {
  const target = {
    mode: RENDER_PAID_STAGING_MODE,
    environmentId: PAID_STAGING_TARGET.environmentId,
    host: PAID_STAGING_TARGET.host,
    port: PAID_STAGING_TARGET.port,
    database: PAID_STAGING_TARGET.database,
    username: PAID_STAGING_TARGET.runtimeLogin
  };
  return {
    SOCIAL_POSTGRES_SIZING_APPROVED: SIZING_APPROVAL,
    SOCIAL_POSTGRES_SIZING_RENDER_REMOTE_APPROVED:
      SIZING_PAID_STAGING_APPROVAL,
    SOCIAL_POSTGRES_SIZING_TARGET_MODE: RENDER_PAID_STAGING_MODE,
    SOCIAL_POSTGRES_SIZING_ENVIRONMENT_ID: target.environmentId,
    SOCIAL_POSTGRES_SIZING_DATABASE_URL:
      `postgresql://${target.username}:synthetic-paid-password@` +
      `${target.host}:${target.port}/${target.database}` +
      "?sslmode=verify-full",
    SOCIAL_POSTGRES_SIZING_EXPECTED_HOST: target.host,
    SOCIAL_POSTGRES_SIZING_EXPECTED_PORT: target.port,
    SOCIAL_POSTGRES_SIZING_EXPECTED_DATABASE: target.database,
    SOCIAL_POSTGRES_SIZING_EXPECTED_USERNAME: target.username,
    SOCIAL_POSTGRES_SIZING_EXPECTED_TARGET_FINGERPRINT:
      fingerprint(target),
    ...overrides
  };
}

function fakePool(options = {}) {
  const max = options.max || RUNTIME_POOL_MAX;
  const connectFailures = [...(options.connectFailures || [])];
  const waiters = [];
  let active = 0;
  let nextBackend = 100;
  const pool = {
    options: { max },
    totalCount: 0,
    waitingCount: 0,
    idleCount: 0,
    connectCalls: 0,
    async connect() {
      pool.connectCalls += 1;
      const failure = connectFailures.shift();
      if (failure) throw failure;
      if (active >= max) {
        pool.waitingCount += 1;
        await new Promise((resolve) => waiters.push(resolve));
        pool.waitingCount -= 1;
      }
      active += 1;
      pool.totalCount = Math.max(pool.totalCount, active);
      const backend = nextBackend;
      nextBackend += 1;
      let released = false;
      return {
        async query(_text, values) {
          if (typeof options.onQuery === "function") {
            return options.onQuery(_text, values, backend);
          }
          await new Promise((resolve) => setTimeout(resolve, 1));
          return {
            rowCount: 1,
            rows: [
              {
                synthetic_task: values[0],
                backend_pid: backend,
                database_name: "ia4tube_social_test_sizing",
                session_user_name: "ia4tube_social_runtime",
                version_num: 180004,
                read_only: "off",
                application_name: "ia4tube-social-runtime",
                in_recovery: false,
                tls_active: false,
                work_mem_bytes: "4194304",
                temp_buffers_bytes: "8388608",
                shared_buffers_bytes: "134217728",
                server_max_connections: 100
              }
            ]
          };
        },
        release() {
          if (released) throw new Error("double release");
          released = true;
          active -= 1;
          const waiter = waiters.shift();
          if (waiter) waiter();
        }
      };
    }
  };
  return pool;
}

test("sizing guard requires opt-in, exact synthetic target and fingerprint", () => {
  const local = validateSizingEnvironment(loopbackEnvironment());
  assert.equal(local.mode, LOOPBACK_MODE);
  assert.equal(local.database, "ia4tube_social_test_sizing");
  assert.equal(local.username, "ia4tube_social_runtime");

  const remote = validateSizingEnvironment(remoteEnvironment());
  assert.equal(remote.mode, RENDER_REMOTE_MODE);
  assert.equal(remote.database, REMOTE_DATABASE);

  const paid = validateSizingEnvironment(paidEnvironment());
  assert.equal(paid.mode, RENDER_PAID_STAGING_MODE);
  assert.equal(paid.host, PAID_STAGING_TARGET.host);
  assert.equal(paid.database, PAID_STAGING_TARGET.database);

  for (const override of [
    { SOCIAL_POSTGRES_SIZING_APPROVED: "no" },
    { SOCIAL_POSTGRES_SIZING_EXPECTED_DATABASE: "other" },
    {
      SOCIAL_POSTGRES_SIZING_EXPECTED_TARGET_FINGERPRINT: "0".repeat(64)
    },
    { DATABASE_URL: "postgresql://production.invalid/production" },
    {
      SOCIAL_MIGRATIONS_DATABASE_URL:
        "postgresql://migration:secret@localhost/database"
    }
  ]) {
    assert.throws(() =>
      validateSizingEnvironment(loopbackEnvironment(override))
    );
  }

  assert.throws(() =>
    validateSizingEnvironment(
      remoteEnvironment({
        SOCIAL_POSTGRES_SIZING_DATABASE_URL:
          "postgresql://synthetic_runtime:password@" +
          "synthetic-a.oregon-postgres.render.com/" +
          `${REMOTE_DATABASE}?sslmode=require`
      })
    )
  );

  for (const override of [
    {
      SOCIAL_POSTGRES_SIZING_RENDER_REMOTE_APPROVED:
        SIZING_REMOTE_APPROVAL
    },
    {
      SOCIAL_POSTGRES_SIZING_ENVIRONMENT_ID:
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    },
    {
      SOCIAL_POSTGRES_SIZING_EXPECTED_HOST:
        "dpg-other-a.oregon-postgres.render.com"
    },
    {
      SOCIAL_POSTGRES_SIZING_EXPECTED_DATABASE:
        "ia4tube_social_staging_other"
    },
    {
      SOCIAL_POSTGRES_SIZING_EXPECTED_USERNAME:
        "production_runtime"
    },
    {
      SOCIAL_POSTGRES_SIZING_DATABASE_URL:
        paidEnvironment().SOCIAL_POSTGRES_SIZING_DATABASE_URL.replace(
          PAID_STAGING_TARGET.runtimeLogin,
          "ia4tube_social_staging_runtime_other"
        ),
      SOCIAL_POSTGRES_SIZING_EXPECTED_USERNAME:
        "ia4tube_social_staging_runtime_other",
      SOCIAL_POSTGRES_SIZING_EXPECTED_TARGET_FINGERPRINT:
        fingerprint({
          mode: RENDER_PAID_STAGING_MODE,
          environmentId: PAID_STAGING_TARGET.environmentId,
          host: PAID_STAGING_TARGET.host,
          port: PAID_STAGING_TARGET.port,
          database: PAID_STAGING_TARGET.database,
          username: "ia4tube_social_staging_runtime_other"
        })
    },
    {
      SOCIAL_POSTGRES_SIZING_DATABASE_URL:
        paidEnvironment().SOCIAL_POSTGRES_SIZING_DATABASE_URL +
        "&application_name=forbidden"
    }
  ]) {
    assert.throws(() =>
      validateSizingEnvironment(paidEnvironment(override))
    );
  }
});

test("each migration worker uses one of two permanent connections", () => {
  assert.equal(MIGRATION_CONNECTION_LIMIT, 2);
  const runtimeUrl =
    "postgresql://ia4tube_social_runtime:password@" +
    "db.example.test/social";
  const runtimeBase = {
    SOCIAL_PERSISTENCE_ENABLED: "true",
    DATABASE_URL: runtimeUrl,
    SOCIAL_DATABASE_EXPECTED_TARGET_FINGERPRINT:
      databaseTargetFingerprint(new URL(runtimeUrl)),
    SOCIAL_DATABASE_EXPECTED_RUNTIME_LOGIN: "ia4tube_social_runtime"
  };
  const runtime = loadRuntimePostgresConfig(runtimeBase);
  assert.equal(runtime.pool.max, 3);
  assert.match(runtime.pool.options, /statement_timeout=10000/);
  assert.match(runtime.pool.options, /lock_timeout=5000/);
  assert.match(
    runtime.pool.options,
    /idle_in_transaction_session_timeout=5000/
  );
  assert.equal(
    loadRuntimePostgresConfig({
      ...runtimeBase,
      SOCIAL_DATABASE_POOL_MAX: "5"
    }).pool.max,
    5
  );
  assert.throws(() =>
    loadRuntimePostgresConfig({
      ...runtimeBase,
      SOCIAL_DATABASE_POOL_MAX: "6"
    })
  );

  const migrationUrl =
    "postgresql://ia4tube_social_migrator:migration@" +
    "db.example.test/social";
  const migration = loadMigrationPostgresConfig({
    SOCIAL_DATABASE_EXPECTED_RUNTIME_LOGIN: "ia4tube_social_runtime",
    SOCIAL_MIGRATIONS_DATABASE_URL: migrationUrl,
    SOCIAL_DATABASE_EXPECTED_TARGET_FINGERPRINT:
      databaseTargetFingerprint(new URL(migrationUrl)),
    SOCIAL_MIGRATIONS_EXPECTED_LOGIN: "ia4tube_social_migrator",
    SOCIAL_MIGRATION_ENVIRONMENT: "test",
    SOCIAL_MIGRATION_EXPECTED_ENVIRONMENT_ID: environmentId
  });
  assert.equal(migration.pool.max, 1);
  assert.match(migration.pool.options, /statement_timeout=60000/);
  assert.match(migration.pool.options, /lock_timeout=5000/);
});

test("paid sizing verifies the canonical runtime boundary before max-three load", async () => {
  let poolConfiguration;
  let roleChecks = 0;
  let schemaChecks = 0;
  let harnessCalls = 0;
  let closed = 0;
  class SyntheticPool {
    constructor(configuration) {
      poolConfiguration = configuration;
    }
    async end() {
      closed += 1;
    }
  }
  let stdout = "";
  let stderr = "";
  const status = await sizingMain(paidEnvironment(), {
    PoolClass: SyntheticPool,
    async verifyRuntimeRole(_pool, role) {
      roleChecks += 1;
      assert.equal(role, "ia4tube_social_runtime");
    },
    async verifyRuntimeSchema(_pool, role) {
      schemaChecks += 1;
      assert.equal(role, "ia4tube_social_runtime");
    },
    async runSizingHarness(options) {
      harnessCalls += 1;
      assert.equal(options.expectedDatabase, PAID_STAGING_TARGET.database);
      assert.equal(options.expectedUsername, "ia4tube_social_staging_runtime");
      assert.equal(options.expectTls, true);
      return { passed: true, connections: { configuredMax: 3 } };
    },
    stdout: { write(value) { stdout += value; } },
    stderr: { write(value) { stderr += value; } }
  });
  assert.equal(status, 0);
  assert.equal(roleChecks, 1);
  assert.equal(schemaChecks, 1);
  assert.equal(harnessCalls, 1);
  assert.equal(poolConfiguration.max, 3);
  assert.equal(closed, 1);
  assert.equal(stderr, "");
  assert.equal(JSON.parse(stdout).event, "social_postgres_sizing_complete");
});

test("paid sizing refuses load when the canonical runtime boundary fails", async () => {
  const secret = "synthetic-paid-password";
  class SyntheticPool {
    async end() {}
  }
  let stdout = "";
  let stderr = "";
  let harnessCalls = 0;
  const status = await sizingMain(paidEnvironment(), {
    PoolClass: SyntheticPool,
    async verifyRuntimeRole() {
      const error = new Error(`must-not-leak-${secret}`);
      error.code = "postgres_runtime_role_unsafe";
      throw error;
    },
    async verifyRuntimeSchema() {
      throw new Error("must-not-run");
    },
    async runSizingHarness() {
      harnessCalls += 1;
      return { passed: true };
    },
    stdout: { write(value) { stdout += value; } },
    stderr: { write(value) { stderr += value; } }
  });
  assert.equal(status, 2);
  assert.equal(harnessCalls, 0);
  assert.equal(stdout, "");
  assert.equal(stderr.includes(secret), false);
  assert.equal(
    JSON.parse(stderr).code,
    "postgres_runtime_role_unsafe"
  );
});

test("thirty synthetic tasks stay inside max three and expose aggregates only", async () => {
  const pool = fakePool();
  const result = await runSizingHarness({
    pool,
    holdMs: 5,
    expectedDatabase: "ia4tube_social_test_sizing",
    expectedUsername: "ia4tube_social_runtime",
    expectTls: false,
    processMemory: () => ({ rss: 64 * 1024 * 1024 })
  });
  assert.equal(result.passed, true);
  assert.equal(result.tasks, SIZING_TASK_COUNT);
  assert.equal(result.succeeded, SIZING_TASK_COUNT);
  assert.equal(result.failed, 0);
  assert.equal(result.connections.configuredMax, RUNTIME_POOL_MAX);
  assert.ok(result.connections.peakActive <= RUNTIME_POOL_MAX);
  assert.ok(result.connections.peakPoolTotal <= RUNTIME_POOL_MAX);
  assert.ok(result.connections.peakPoolWaiting > 0);
  assert.equal(result.connections.serverMax, 100);
  assert.equal(
    result.approximateMemoryBytes.sessionSettingPeak,
    16 * 1024 * 1024
  );
  assert.equal(
    result.approximateMemoryBytes.configuredConcurrentEstimate,
    128 * 1024 * 1024 + 16 * 1024 * 1024 * RUNTIME_POOL_MAX
  );
  assert.equal(
    JSON.stringify(result).includes("synthetic_task"),
    false
  );
  assert.equal(JSON.stringify(result).includes("backendId"), false);
});

test("connection acquisition is caught and retried with bounded backoff", async () => {
  const delays = [];
  const transient = Object.assign(new Error("must-not-leak"), {
    code: "08006"
  });
  const pool = fakePool({ connectFailures: [transient, transient] });
  const result = await runSizingHarness({
    pool,
    holdMs: 5,
    baseBackoffMs: 10,
    expectedDatabase: "ia4tube_social_test_sizing",
    expectedUsername: "ia4tube_social_runtime",
    expectTls: false,
    sleep: async (delay) => delays.push(delay),
    processMemory: () => ({ rss: 1 })
  });
  assert.equal(result.passed, true);
  assert.equal(result.failed, 0);
  assert.equal(result.retries, 2);
  assert.deepEqual(delays, [10, 10]);
  assert.equal(JSON.stringify(result).includes("must-not-leak"), false);
});

test("persistent acquisition failure is finite and redacted", async () => {
  const secretMessage = "synthetic-password-must-not-appear";
  const failures = Array.from({ length: 90 }, () =>
    Object.assign(new Error(secretMessage), { code: "08001" })
  );
  const pool = fakePool({ connectFailures: failures });
  const result = await runSizingHarness({
    pool,
    holdMs: 5,
    expectedDatabase: "ia4tube_social_test_sizing",
    expectedUsername: "ia4tube_social_runtime",
    expectTls: false,
    sleep: async () => {},
    processMemory: () => ({ rss: 1 })
  });
  assert.equal(result.passed, false);
  assert.equal(result.succeeded, 0);
  assert.equal(result.failed, SIZING_TASK_COUNT);
  assert.equal(result.retries, SIZING_TASK_COUNT * 2);
  assert.deepEqual(result.failures, { "08001": SIZING_TASK_COUNT });
  assert.equal(JSON.stringify(result).includes(secretMessage), false);
  assert.equal(pool.connectCalls, SIZING_TASK_COUNT * 3);
});

test("sizing query is synthetic, aggregate-only and never reads application tables", () => {
  assert.match(SYNTHETIC_QUERY, /current_setting\('work_mem'\)/);
  assert.match(SYNTHETIC_QUERY, /current_setting\('shared_buffers'\)/);
  assert.match(SYNTHETIC_QUERY, /pg_sleep/);
  assert.equal(/ia4tube_|social_|clientes|pedidos/i.test(SYNTHETIC_QUERY), false);
});
