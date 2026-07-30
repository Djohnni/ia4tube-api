"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  CANARY_APPROVAL,
  RUNTIME_ROLE,
  STAGING_DATABASE_HOST,
  STAGING_DATABASE_NAME,
  STAGING_ENVIRONMENT_ID,
  SYNTHETIC_COMPANY_PREFIX,
  runSyntheticRuntimeCanary,
  validateCanaryEnvironment
} = require("../src/social/runtime-canary");
const { main } = require("../scripts/social-runtime-canary");

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const SECRET_MARKER = "synthetic-canary-password-never-output";

function canaryEnvironment(overrides = {}) {
  return {
    SOCIAL_RUNTIME_CANARY_APPROVED: CANARY_APPROVAL,
    SOCIAL_RUNTIME_CANARY_ENVIRONMENT: "staging",
    SOCIAL_RUNTIME_CANARY_EXPECTED_ENVIRONMENT_ID:
      STAGING_ENVIRONMENT_ID,
    SOCIAL_RUNTIME_CANARY_COMPANY_A_ID: COMPANY_A,
    SOCIAL_RUNTIME_CANARY_COMPANY_B_ID: COMPANY_B,
    SOCIAL_PERSISTENCE_ENABLED: "true",
    SOCIAL_DATABASE_POOL_MAX: "3",
    DATABASE_URL:
      `postgresql://ia4tube_social_runtime:${SECRET_MARKER}@` +
      `${STAGING_DATABASE_HOST}:5432/${STAGING_DATABASE_NAME}` +
      "?sslmode=verify-full",
    ...overrides
  };
}

function fakeCanaryDependencies(options = {}) {
  const state = {
    runtimeCloseCalls: 0,
    poolCloseCalls: 0,
    poolConfiguration: null,
    roleChecks: 0,
    schemaChecks: 0
  };
  return {
    state,
    dependencies: {
      async createRuntime() {
        return {
          enabled: true,
          async close() {
            state.runtimeCloseCalls += 1;
          }
        };
      },
      loadConfig() {
        return {
          enabled: true,
          role: RUNTIME_ROLE,
          pool: {
            max: options.configuredPoolMax || 3,
            min: 0,
            connectionString: "redacted"
          }
        };
      },
      createPool(configuration) {
        state.poolConfiguration = configuration;
        return { syntheticPool: true };
      },
      async verifyRole() {
        state.roleChecks += 1;
      },
      async verifySchema() {
        state.schemaChecks += 1;
      },
      async transact(pool, operation, transactionOptions) {
        assert.deepEqual(pool, { syntheticPool: true });
        const scope = transactionOptions.companyId || null;
        const client = {
          async query(sql, values) {
            assert.match(sql, /ia4tube_social\.companies/);
            assert.equal(values[1], SYNTHETIC_COMPANY_PREFIX.length);
            assert.equal(values[2], SYNTHETIC_COMPANY_PREFIX);
            const target = values[0];
            const ownVisible =
              scope === target &&
              [COMPANY_A, COMPANY_B].includes(target);
            const forceCrossLeak =
              options.forceCrossLeak &&
              scope === COMPANY_B &&
              target === COMPANY_A;
            return {
              rowCount: ownVisible || forceCrossLeak ? 1 : 0,
              rows: []
            };
          }
        };
        return operation(client);
      },
      async closePool() {
        state.poolCloseCalls += 1;
      }
    }
  };
}

test("canary requires exact staging identity before initializing runtime", () => {
  for (const override of [
    { SOCIAL_RUNTIME_CANARY_APPROVED: "wrong" },
    { SOCIAL_RUNTIME_CANARY_ENVIRONMENT: "production" },
    {
      SOCIAL_RUNTIME_CANARY_EXPECTED_ENVIRONMENT_ID:
        "33333333-3333-4333-8333-333333333333"
    },
    {
      DATABASE_URL:
        "postgresql://runtime:secret@other.render.com/" +
        "ia4tube_social_staging?sslmode=verify-full"
    },
    {
      DATABASE_URL:
        `postgresql://runtime:secret@${STAGING_DATABASE_HOST}/` +
        "other_database?sslmode=verify-full"
    }
  ]) {
    assert.throws(
      () => validateCanaryEnvironment(canaryEnvironment(override))
    );
  }
});

test("read-only canary proves A/B and unscoped isolation with boolean output", async () => {
  const { state, dependencies } = fakeCanaryDependencies();
  const result = await runSyntheticRuntimeCanary({
    env: canaryEnvironment(),
    ...dependencies
  });

  assert.deepEqual(result, {
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
  assert.equal(state.runtimeCloseCalls, 1);
  assert.equal(state.poolCloseCalls, 1);
  assert.equal(state.poolConfiguration.max, 1);
  assert.equal(state.poolConfiguration.min, 0);
  assert.equal(state.roleChecks, 1);
  assert.equal(state.schemaChecks, 1);
  const output = JSON.stringify(result);
  assert.equal(output.includes(COMPANY_A), false);
  assert.equal(output.includes(COMPANY_B), false);
  assert.equal(output.includes(SECRET_MARKER), false);
});

test("canary fails closed if a cross-tenant row becomes visible", async () => {
  const { state, dependencies } = fakeCanaryDependencies({
    forceCrossLeak: true
  });
  await assert.rejects(
    runSyntheticRuntimeCanary({
      env: canaryEnvironment(),
      ...dependencies
    }),
    { code: "social_runtime_canary_isolation_failed" }
  );
  assert.equal(state.poolCloseCalls, 1);
  assert.equal(state.runtimeCloseCalls, 1);
});

test("canary refuses an operational pool above three", async () => {
  const { state, dependencies } = fakeCanaryDependencies({
    configuredPoolMax: 4
  });
  await assert.rejects(
    runSyntheticRuntimeCanary({
      env: canaryEnvironment(),
      ...dependencies
    }),
    { code: "social_runtime_canary_pool_must_be_three" }
  );
  assert.equal(state.poolCloseCalls, 0);
  assert.equal(state.runtimeCloseCalls, 1);
});

test("operator CLI emits only a safe code and never exception content", async () => {
  let stdout = "";
  let stderr = "";
  const status = await main({
    env: canaryEnvironment(),
    argv: [],
    stdout: { write(value) { stdout += value; } },
    stderr: { write(value) { stderr += value; } },
    async runCanary() {
      const error = new Error(
        `database failed with ${SECRET_MARKER}`
      );
      error.code = `unsafe ${SECRET_MARKER}`;
      throw error;
    }
  });
  assert.equal(status, 1);
  assert.equal(stdout, "");
  assert.match(stderr, /social_runtime_canary_failed/);
  assert.equal(stderr.includes(SECRET_MARKER), false);
});

test("operator CLI refuses arguments without executing the canary", async () => {
  let calls = 0;
  let stderr = "";
  const status = await main({
    argv: ["unexpected"],
    stdout: { write() {} },
    stderr: { write(value) { stderr += value; } },
    async runCanary() {
      calls += 1;
    }
  });
  assert.equal(status, 2);
  assert.equal(calls, 0);
  assert.match(stderr, /social_runtime_canary_argv_refused/);
});
