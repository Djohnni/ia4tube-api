"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  APPROVAL,
  LOOPBACK_MODE,
  PostgresGateRefusal,
  REMOTE_APPROVAL,
  REMOTE_DATABASE,
  RENDER_REMOTE_MODE,
  secureConnection,
  targetFingerprint,
  validateGateEnvironment
} = require("../scripts/run-real-postgres-tests");

const ENVIRONMENT_ID = "19db4682-c76b-4f83-93cd-a66aa2bc2343";
const HOST = "dpg-social2a-a.oregon-postgres.render.com";
const PORT = "5432";
const USERS = Object.freeze([
  "gate_provisioner",
  "gate_migration",
  "gate_runtime"
]);

function encodedUrl(username, host = HOST, database = REMOTE_DATABASE) {
  return (
    `postgresql://${username}:synthetic-password@${host}:${PORT}/` +
    `${database}?sslmode=verify-full`
  );
}

function publicTarget(overrides = {}) {
  return {
    mode: RENDER_REMOTE_MODE,
    environmentId: ENVIRONMENT_ID,
    host: HOST,
    port: PORT,
    database: REMOTE_DATABASE,
    provisionerUsername: USERS[0],
    migrationUsername: USERS[1],
    runtimeUsername: USERS[2],
    ...overrides
  };
}

function remoteEnvironment(overrides = {}) {
  const target = publicTarget();
  return {
    SOCIAL_TEST_POSTGRES_APPROVED: APPROVAL,
    SOCIAL_TEST_RENDER_REMOTE_APPROVED: REMOTE_APPROVAL,
    SOCIAL_TEST_TARGET_MODE: RENDER_REMOTE_MODE,
    SOCIAL_TEST_ENVIRONMENT_ID: ENVIRONMENT_ID,
    SOCIAL_TEST_PROVISIONER_DATABASE_URL: encodedUrl(USERS[0]),
    SOCIAL_TEST_MIGRATION_DATABASE_URL: encodedUrl(USERS[1]),
    SOCIAL_TEST_RUNTIME_DATABASE_URL: encodedUrl(USERS[2]),
    SOCIAL_TEST_EXPECTED_HOST: HOST,
    SOCIAL_TEST_EXPECTED_PORT: PORT,
    SOCIAL_TEST_EXPECTED_DATABASE: REMOTE_DATABASE,
    SOCIAL_TEST_EXPECTED_PROVISIONER_USERNAME: USERS[0],
    SOCIAL_TEST_EXPECTED_MIGRATION_USERNAME: USERS[1],
    SOCIAL_TEST_EXPECTED_RUNTIME_USERNAME: USERS[2],
    SOCIAL_TEST_EXPECTED_TARGET_FINGERPRINT: targetFingerprint(target),
    ...overrides
  };
}

function loopbackEnvironment(overrides = {}) {
  const database = "ia4tube_social_test_remote_guard";
  return {
    SOCIAL_TEST_POSTGRES_APPROVED: APPROVAL,
    SOCIAL_TEST_ENVIRONMENT_ID: ENVIRONMENT_ID,
    SOCIAL_TEST_PROVISIONER_DATABASE_URL:
      `postgresql://local_provisioner@localhost:${PORT}/${database}`,
    SOCIAL_TEST_MIGRATION_DATABASE_URL:
      `postgresql://local_migration@localhost:${PORT}/${database}`,
    SOCIAL_TEST_RUNTIME_DATABASE_URL:
      `postgresql://local_runtime@localhost:${PORT}/${database}`,
    ...overrides
  };
}

function assertRefused(env, code) {
  assert.throws(
    () => validateGateEnvironment(env),
    (error) =>
      error instanceof PostgresGateRefusal &&
      error.code === code &&
      !String(error.message).includes("synthetic-password")
  );
}

test("loopback mode remains available without remote-only variables", () => {
  const configuration = validateGateEnvironment(loopbackEnvironment());
  assert.equal(configuration.mode, LOOPBACK_MODE);
  assert.equal(configuration.host, "localhost");
  assert.equal(configuration.database, "ia4tube_social_test_remote_guard");
  const connection = secureConnection(
    configuration.urls[0],
    configuration
  );
  assert.equal(connection.ssl, false);
});

test("valid synthetic Render target requires explicit TLS verification", () => {
  const configuration = validateGateEnvironment(remoteEnvironment());
  assert.equal(configuration.mode, RENDER_REMOTE_MODE);
  assert.equal(configuration.host, HOST);
  assert.equal(configuration.database, REMOTE_DATABASE);
  assert.deepEqual(
    configuration.identities.map((identity) => identity.username),
    USERS
  );

  const connection = secureConnection(
    configuration.urls[0],
    configuration
  );
  assert.equal(connection.ssl.rejectUnauthorized, true);
  assert.equal(connection.ssl.minVersion, "TLSv1.2");
  assert.equal(connection.ssl.servername, HOST);
  assert.equal(new URL(connection.connectionString).search, "");
});

test("target fingerprint is deterministic, public and identity-bound", () => {
  const first = targetFingerprint(publicTarget());
  const second = targetFingerprint(publicTarget());
  const changed = targetFingerprint(
    publicTarget({ runtimeUsername: "gate_runtime_other" })
  );
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(first, second);
  assert.notEqual(first, changed);
  assert.equal(first.includes("synthetic-password"), false);
});

test("both approvals and the external fingerprint are mandatory", () => {
  assertRefused(
    remoteEnvironment({ SOCIAL_TEST_POSTGRES_APPROVED: "wrong" }),
    "explicit_approval_missing"
  );
  assertRefused(
    remoteEnvironment({ SOCIAL_TEST_RENDER_REMOTE_APPROVED: "wrong" }),
    "remote_approval_missing"
  );
  assertRefused(
    remoteEnvironment({
      SOCIAL_TEST_EXPECTED_TARGET_FINGERPRINT: "0".repeat(64)
    }),
    "external_target_fingerprint_mismatch"
  );
});

test("expected host, database and user identities are exact", () => {
  assertRefused(
    remoteEnvironment({
      SOCIAL_TEST_EXPECTED_HOST:
        "dpg-other-a.oregon-postgres.render.com"
    }),
    "social_test_provisioner_database_url_target_mismatch"
  );
  assertRefused(
    remoteEnvironment({
      SOCIAL_TEST_EXPECTED_DATABASE: "ia4tube_social_2a_gate_other"
    }),
    "expected_target_not_disposable"
  );
  assertRefused(
    remoteEnvironment({
      SOCIAL_TEST_EXPECTED_RUNTIME_USERNAME: "gate_runtime_other"
    }),
    "database_identity_mismatch"
  );
});

test("production-like declared labels and duplicate users are refused", () => {
  assertRefused(
    remoteEnvironment({
      SOCIAL_TEST_EXPECTED_RUNTIME_USERNAME: "staging_runtime"
    }),
    "expected_target_not_disposable"
  );
  assertRefused(
    remoteEnvironment({
      SOCIAL_TEST_RUNTIME_DATABASE_URL: encodedUrl(USERS[1]).replace(
        "synthetic-password",
        "synthetic-password-other"
      ),
      SOCIAL_TEST_EXPECTED_RUNTIME_USERNAME: USERS[1]
    }),
    "database_users_must_be_distinct"
  );
});

test("TLS mode and all extra connection parameters fail closed", () => {
  const withoutTls = encodedUrl(USERS[0]).replace(
    "?sslmode=verify-full",
    ""
  );
  assertRefused(
    remoteEnvironment({
      SOCIAL_TEST_PROVISIONER_DATABASE_URL: withoutTls
    }),
    "social_test_provisioner_database_url_tls_invalid"
  );
  assertRefused(
    remoteEnvironment({
      SOCIAL_TEST_PROVISIONER_DATABASE_URL: encodedUrl(USERS[0]).replace(
        "verify-full",
        "require"
      )
    }),
    "social_test_provisioner_database_url_tls_invalid"
  );
  assertRefused(
    remoteEnvironment({
      SOCIAL_TEST_PROVISIONER_DATABASE_URL:
        `${encodedUrl(USERS[0])}&application_name=unsafe`
    }),
    "social_test_provisioner_database_url_tls_invalid"
  );
  assertRefused(
    remoteEnvironment({
      SOCIAL_TEST_PROVISIONER_DATABASE_URL:
        `${encodedUrl(USERS[0])}&sslkey=forbidden`
    }),
    "social_test_provisioner_database_url_tls_invalid"
  );
});

test("ambient TLS bypass variables are refused before URL handling", () => {
  assertRefused(
    remoteEnvironment({ NODE_TLS_REJECT_UNAUTHORIZED: "0" }),
    "node_tls_verification_disabled"
  );
  assertRefused(
    remoteEnvironment({ PGSSLMODE: "verify-full" }),
    "ambient_pgssl_configuration_refused"
  );
  assertRefused(
    remoteEnvironment({ PGSSLROOTCERT: "synthetic-path" }),
    "ambient_pgssl_configuration_refused"
  );
});

test("remote target refuses IPs and non-Render hostnames", () => {
  assertRefused(
    remoteEnvironment({ SOCIAL_TEST_EXPECTED_HOST: "127.0.0.1" }),
    "expected_target_not_disposable"
  );
  assertRefused(
    remoteEnvironment({ SOCIAL_TEST_EXPECTED_HOST: "db.example.test" }),
    "expected_target_not_disposable"
  );
});
