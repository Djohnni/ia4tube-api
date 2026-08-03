"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  databaseTargetFingerprint,
  loadMigrationPostgresConfig,
  loadRuntimePostgresConfig
} = require("../src/persistence/postgres/config");
const { redactString } = require("../src/security/log-redaction");
const { createSocialRuntime } = require("../src/social/runtime");

const DIAGNOSTIC_COMMIT = "d".repeat(40);
const DIAGNOSTIC_FLAG =
  "SOCIAL_DATABASE_FINGERPRINT_DIAGNOSTICS_COMMIT";
const DATABASE_HOST =
  "dpg-synthetic-a.oregon-postgres.render.com";
const DATABASE_USER = "ia4tube_social_staging_runtime";
const DATABASE_PASSWORD = "synthetic-runtime-password-never-used";
const DATABASE_URL =
  `postgresql://${DATABASE_USER}:${DATABASE_PASSWORD}@${DATABASE_HOST}` +
  "/ia4tube_social_staging?sslmode=verify-full";

function targetOf(url) {
  return databaseTargetFingerprint(new URL(url));
}

function differentFingerprint(url = DATABASE_URL) {
  const actual = targetOf(url);
  return actual === "a".repeat(64) ? "b".repeat(64) : "a".repeat(64);
}

function authorizedRenderIdentity() {
  return {
    RENDER: "true",
    RENDER_SERVICE_ID: "srv-d9itiiurnols73fsbmmg",
    RENDER_SERVICE_NAME: "ia4tube-api-staging-checkpoint-a",
    RENDER_SERVICE_TYPE: "web",
    RENDER_EXTERNAL_HOSTNAME:
      "ia4tube-api-staging-checkpoint-a.onrender.com",
    RENDER_GIT_REPO_SLUG: "Djohnni/ia4tube-api",
    RENDER_GIT_BRANCH: "social/checkpoint-2b-tls-ca-20260730",
    RENDER_GIT_COMMIT: DIAGNOSTIC_COMMIT,
    [DIAGNOSTIC_FLAG]: DIAGNOSTIC_COMMIT
  };
}

function diagnosticEnvironment(overrides = {}) {
  return {
    SOCIAL_PERSISTENCE_ENABLED: "true",
    DATABASE_URL,
    SOCIAL_DATABASE_EXPECTED_RUNTIME_LOGIN: DATABASE_USER,
    SOCIAL_DATABASE_EXPECTED_TARGET_FINGERPRINT:
      differentFingerprint(DATABASE_URL),
    ...authorizedRenderIdentity(),
    ...overrides
  };
}

async function captureErrors(action) {
  const original = console.error;
  const calls = [];
  console.error = (...args) => calls.push(args);
  try {
    return { result: await action(), calls };
  } finally {
    console.error = original;
  }
}

function parseOnlyDiagnostic(calls) {
  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 1);
  assert.equal(typeof calls[0][0], "string");
  return JSON.parse(calls[0][0]);
}

test("diagnostic is off by default and mismatch keeps the original error", async () => {
  const env = diagnosticEnvironment({ [DIAGNOSTIC_FLAG]: undefined });
  const { calls } = await captureErrors(async () => {
    assert.throws(
      () => loadRuntimePostgresConfig(env),
      { code: "social_database_expected_target_fingerprint_mismatch" }
    );
  });
  assert.deepEqual(calls, []);
});

test("authorized diagnostic emits exactly the sanitized allowlist", async () => {
  const expected = differentFingerprint();
  const actual = targetOf(DATABASE_URL);
  const { calls } = await captureErrors(async () => {
    assert.throws(
      () => loadRuntimePostgresConfig(diagnosticEnvironment()),
      { code: "social_database_expected_target_fingerprint_mismatch" }
    );
  });
  const record = parseOnlyDiagnostic(calls);

  assert.deepEqual(Object.keys(record), [
    "diagnosticsEnabled",
    "expectedFingerprintPresent",
    "expectedFingerprintLength",
    "expectedFingerprintFormatValid",
    "expectedFingerprintPrefix",
    "calculatedFingerprintLength",
    "calculatedFingerprintPrefix",
    "fingerprintsEqual",
    "databaseHostClass",
    "databaseHostHashPrefix",
    "databasePort",
    "databaseNameMatchesExpected",
    "sslmodeVerifyFullExactlyOnce",
    "channelBindingAbsent",
    "poolCreated",
    "databaseConnectionAttempted"
  ]);
  assert.deepEqual(record, {
    diagnosticsEnabled: true,
    expectedFingerprintPresent: true,
    expectedFingerprintLength: 64,
    expectedFingerprintFormatValid: true,
    expectedFingerprintPrefix: expected.slice(0, 12),
    calculatedFingerprintLength: 64,
    calculatedFingerprintPrefix: actual.slice(0, 12),
    fingerprintsEqual: false,
    databaseHostClass: "external",
    databaseHostHashPrefix: record.databaseHostHashPrefix,
    databasePort: 5432,
    databaseNameMatchesExpected: true,
    sslmodeVerifyFullExactlyOnce: true,
    channelBindingAbsent: true,
    poolCreated: false,
    databaseConnectionAttempted: false
  });
  assert.match(record.databaseHostHashPrefix, /^[0-9a-f]{12}$/);
  assert.equal(record.expectedFingerprintPrefix.length, 12);
  assert.equal(record.calculatedFingerprintPrefix.length, 12);

  const serialized = calls[0][0];
  assert.deepEqual(JSON.parse(redactString(serialized)), record);
  for (const forbidden of [
    expected,
    actual,
    DATABASE_URL,
    DATABASE_HOST,
    DATABASE_USER,
    DATABASE_PASSWORD
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("malformed expected fingerprints report shape without reproducing values", async () => {
  for (const expected of [
    "",
    "unsafe-value-that-must-not-be-reproduced",
    "A".repeat(64)
  ]) {
    const { calls } = await captureErrors(async () => {
      assert.throws(
        () =>
          loadRuntimePostgresConfig(
            diagnosticEnvironment({
              SOCIAL_DATABASE_EXPECTED_TARGET_FINGERPRINT: expected
            })
          ),
        { code: "social_database_expected_target_fingerprint_mismatch" }
      );
    });
    const record = parseOnlyDiagnostic(calls);
    assert.equal(record.expectedFingerprintPresent, expected.length > 0);
    assert.equal(record.expectedFingerprintLength, expected.length);
    assert.equal(record.expectedFingerprintFormatValid, false);
    assert.equal(record.expectedFingerprintPrefix, null);
    if (expected) assert.equal(calls[0][0].includes(expected), false);
  }
});

test("diagnostic query facts are measured without weakening URL validation", async () => {
  const variants = [
    {
      query: "sslmode=verify-full&channel_binding=require",
      sslmode: true,
      channelBindingAbsent: false
    },
    {
      query: "sslmode=verify-full&sslmode=verify-full",
      sslmode: false,
      channelBindingAbsent: true
    },
    {
      query: "SSLMODE=verify-full",
      sslmode: false,
      channelBindingAbsent: true
    }
  ];

  for (const variant of variants) {
    const url = DATABASE_URL.replace(
      "sslmode=verify-full",
      variant.query
    );
    const { calls } = await captureErrors(async () => {
      assert.throws(
        () =>
          loadRuntimePostgresConfig(
            diagnosticEnvironment({
              DATABASE_URL: url,
              SOCIAL_DATABASE_EXPECTED_TARGET_FINGERPRINT:
                differentFingerprint(url)
            })
          ),
        { code: "social_database_expected_target_fingerprint_mismatch" }
      );
    });
    const record = parseOnlyDiagnostic(calls);
    assert.equal(record.sslmodeVerifyFullExactlyOnce, variant.sslmode);
    assert.equal(
      record.channelBindingAbsent,
      variant.channelBindingAbsent
    );
  }
});

test("diagnostic classifies internal and unknown hosts without logging them", async () => {
  const variants = [
    { host: "dpg-synthetic-a", expectedClass: "internal" },
    { host: "database.example.test", expectedClass: "unknown" }
  ];
  for (const variant of variants) {
    const url = DATABASE_URL.replace(DATABASE_HOST, variant.host);
    const { calls } = await captureErrors(async () => {
      assert.throws(
        () =>
          loadRuntimePostgresConfig(
            diagnosticEnvironment({
              DATABASE_URL: url,
              SOCIAL_DATABASE_EXPECTED_TARGET_FINGERPRINT:
                differentFingerprint(url)
            })
          ),
        { code: "social_database_expected_target_fingerprint_mismatch" }
      );
    });
    const record = parseOnlyDiagnostic(calls);
    assert.equal(record.databaseHostClass, variant.expectedClass);
    assert.equal(calls[0][0].includes(variant.host), false);
  }
});

test("authorized valid configuration produces no error diagnostic", async () => {
  const url =
    "postgresql://ia4tube_social_staging_runtime:" +
    "synthetic-password@localhost/ia4tube_social_staging?sslmode=disable";
  const env = diagnosticEnvironment({
    NODE_ENV: "test",
    SOCIAL_DATABASE_ALLOW_INSECURE_LOCALHOST: "true",
    DATABASE_URL: url,
    SOCIAL_DATABASE_EXPECTED_TARGET_FINGERPRINT: targetOf(url)
  });
  const { result, calls } = await captureErrors(
    async () => loadRuntimePostgresConfig(env)
  );
  assert.equal(result.enabled, true);
  assert.deepEqual(calls, []);
});

test("active diagnostic is refused outside its exact staging commit", async () => {
  const divergentContexts = [
    { RENDER: "false" },
    { RENDER_SERVICE_ID: "srv-other" },
    { RENDER_SERVICE_NAME: "ia4tube-api" },
    { RENDER_SERVICE_TYPE: "worker" },
    { RENDER_EXTERNAL_HOSTNAME: "ia4tube-api.onrender.com" },
    { RENDER_GIT_REPO_SLUG: "other/repository" },
    { RENDER_GIT_BRANCH: "main" },
    { RENDER_GIT_COMMIT: "e".repeat(40) },
    { [DIAGNOSTIC_FLAG]: "not-a-commit" },
    { [DIAGNOSTIC_FLAG]: ` ${DIAGNOSTIC_COMMIT}` }
  ];

  for (const override of divergentContexts) {
    const { calls } = await captureErrors(async () => {
      assert.throws(
        () => loadRuntimePostgresConfig(diagnosticEnvironment(override)),
        { code: "social_database_fingerprint_diagnostic_context_refused" }
      );
    });
    assert.deepEqual(calls, []);
  }
});

test("diagnostic flag is refused by the migration-only path", async () => {
  const migrationUrl =
    "postgresql://ia4tube_social_migrator:" +
    "synthetic-password@localhost/ia4tube_social_staging";
  const { calls } = await captureErrors(async () => {
    assert.throws(
      () =>
        loadMigrationPostgresConfig({
          ...authorizedRenderIdentity(),
          SOCIAL_MIGRATIONS_DATABASE_URL: migrationUrl,
          SOCIAL_DATABASE_EXPECTED_TARGET_FINGERPRINT:
            differentFingerprint(migrationUrl)
        }),
      { code: "social_database_fingerprint_diagnostic_context_refused" }
    );
  });
  assert.deepEqual(calls, []);
});

test("fingerprint mismatch occurs before pool construction or connection", async () => {
  let poolConstructions = 0;
  class ForbiddenPool {
    constructor() {
      poolConstructions += 1;
      throw new Error("pool_must_not_be_created");
    }
  }

  const { calls } = await captureErrors(async () => {
    await assert.rejects(
      createSocialRuntime({
        env: diagnosticEnvironment(),
        PoolClass: ForbiddenPool
      }),
      { code: "social_database_expected_target_fingerprint_mismatch" }
    );
  });
  const record = parseOnlyDiagnostic(calls);
  assert.equal(poolConstructions, 0);
  assert.equal(record.poolCreated, false);
  assert.equal(record.databaseConnectionAttempted, false);
});
