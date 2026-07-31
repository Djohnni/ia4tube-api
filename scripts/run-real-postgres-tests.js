"use strict";

const crypto = require("node:crypto");
const net = require("node:net");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  assertNoAmbientPostgresEnvironment
} = require("../src/persistence/postgres/config");
const {
  loadSystemPostgresTls
} = require("../src/persistence/postgres/tls");
const {
  PAID_STAGING_PUBLIC_TARGET
} = require(
  "../src/persistence/postgres/staging-provisioner"
);
const {
  DISPOSABLE_DATABASE_NAME
} = require(
  "../src/persistence/postgres/disposable-database-lifecycle"
);

const APPROVAL = "RUN_SOCIAL_POSTGRES_REAL_TESTS";
const REMOTE_APPROVAL = "RUN_SOCIAL_POSTGRES_RENDER_FREE_DISPOSABLE";
const PAID_STAGING_DISPOSABLE_APPROVAL =
  "RUN_SOCIAL_POSTGRES_RENDER_PAID_STAGING_DISPOSABLE";
const LOOPBACK_MODE = "loopback";
const RENDER_REMOTE_MODE = "render_free_remote";
const RENDER_PAID_STAGING_DISPOSABLE_MODE =
  "render_paid_staging_disposable";
const REMOTE_DATABASE = "ia4tube_social_2b0_gate";
const REQUIRED = [
  "SOCIAL_TEST_ENVIRONMENT_ID",
  "SOCIAL_TEST_PROVISIONER_DATABASE_URL",
  "SOCIAL_TEST_MIGRATION_DATABASE_URL",
  "SOCIAL_TEST_RUNTIME_DATABASE_URL"
];
const REMOTE_EXPECTED = [
  "SOCIAL_TEST_EXPECTED_HOST",
  "SOCIAL_TEST_EXPECTED_PORT",
  "SOCIAL_TEST_EXPECTED_DATABASE",
  "SOCIAL_TEST_EXPECTED_PROVISIONER_USERNAME",
  "SOCIAL_TEST_EXPECTED_MIGRATION_USERNAME",
  "SOCIAL_TEST_EXPECTED_RUNTIME_USERNAME",
  "SOCIAL_TEST_EXPECTED_TARGET_FINGERPRINT"
];
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const BLOCKED_LABEL =
  /(^|[-_.])(prod|production|stage|staging|live|main)([-_.]|$)/i;
const PRODUCTION_LABEL =
  /(^|[-_.])(prod|production|live|main)([-_.]|$)/i;
const CONNECTION_NAMES = [
  "SOCIAL_TEST_PROVISIONER_DATABASE_URL",
  "SOCIAL_TEST_MIGRATION_DATABASE_URL",
  "SOCIAL_TEST_RUNTIME_DATABASE_URL"
];

class PostgresGateRefusal extends Error {
  constructor(code) {
    super(code);
    this.code = code;
    this.name = "PostgresGateRefusal";
  }
}

function refuse(code) {
  throw new PostgresGateRefusal(code);
}

function requireValue(env, name) {
  const value = env[name];
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
    refuse(`${name.toLowerCase()}_missing`);
  }
  return value;
}

function decodeUrlPart(value, code) {
  try {
    return decodeURIComponent(value);
  } catch {
    refuse(code);
  }
}

function normalizedHost(parsed) {
  return parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

function parsePort(value, code) {
  if (!/^[0-9]{1,5}$/.test(String(value || ""))) refuse(code);
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) refuse(code);
  return String(port);
}

function connectionIdentity(parsed) {
  return Object.freeze({
    host: normalizedHost(parsed),
    port: parsed.port || "5432",
    database: decodeUrlPart(
      parsed.pathname.slice(1),
      "database_url_encoding_invalid"
    ),
    username: decodeUrlPart(
      parsed.username,
      "database_url_encoding_invalid"
    )
  });
}

function targetFingerprint(input) {
  const normalized = [
    "ia4tube-social-postgres-real-gate-v1",
    input.mode,
    String(input.environmentId || "").toLowerCase(),
    String(input.host || "").toLowerCase(),
    String(input.port || "5432"),
    String(input.database || ""),
    String(input.provisionerUsername || "").toLowerCase(),
    String(input.migrationUsername || "").toLowerCase(),
    String(input.runtimeUsername || "").toLowerCase(),
    input.mode === LOOPBACK_MODE ? "loopback" : "tls-verify-full",
    "disposable-empty-v1"
  ].join("/");
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

function equalFingerprint(actual, expected) {
  if (!SHA256.test(actual) || !SHA256.test(expected)) return false;
  return crypto.timingSafeEqual(
    Buffer.from(actual, "hex"),
    Buffer.from(expected, "hex")
  );
}

function parseDatabaseUrl(name, env, mode, expected) {
  const raw = requireValue(env, name);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    refuse(`${name.toLowerCase()}_invalid`);
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !parsed.username ||
    (mode !== LOOPBACK_MODE && !parsed.password) ||
    !parsed.pathname ||
    parsed.pathname === "/"
  ) {
    refuse(`${name.toLowerCase()}_invalid`);
  }

  const identity = connectionIdentity(parsed);
  if (mode === LOOPBACK_MODE) {
    if (!LOOPBACK.has(identity.host)) {
      refuse(`${name.toLowerCase()}_invalid`);
    }
  } else {
    if (
      net.isIP(identity.host) !== 0 ||
      identity.host !== expected.host ||
      !identity.host.endsWith(".render.com") ||
      identity.port !== expected.port
    ) {
      refuse(`${name.toLowerCase()}_target_mismatch`);
    }
    const keys = [...new Set([...parsed.searchParams.keys()])];
    const sslModes = parsed.searchParams.getAll("sslmode");
    if (
      keys.length !== 1 ||
      keys[0] !== "sslmode" ||
      sslModes.length !== 1 ||
      sslModes[0].toLowerCase() !== "verify-full"
    ) {
      refuse(`${name.toLowerCase()}_tls_invalid`);
    }
  }
  return Object.freeze({ parsed, raw, identity });
}

function secureConnection(raw, configuration) {
  const parsed = new URL(raw);
  for (const key of [...parsed.searchParams.keys()]) {
    parsed.searchParams.delete(key);
  }
  if (
    configuration.mode !== LOOPBACK_MODE &&
    (
      !configuration.ssl ||
      configuration.ssl.rejectUnauthorized !== true ||
      configuration.ssl.servername !== configuration.host ||
      Object.prototype.hasOwnProperty.call(configuration.ssl, "ca")
    )
  ) {
    refuse("system_trust_configuration_invalid");
  }
  return Object.freeze({
    connectionString: parsed.toString(),
    ssl:
      configuration.mode !== LOOPBACK_MODE
        ? configuration.ssl
        : false
  });
}

function validateGateEnvironment(env = process.env) {
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    refuse("node_tls_verification_disabled");
  }
  for (const [name, value] of Object.entries(env)) {
    if (/^PGSSL/i.test(name) && String(value || "").trim()) {
      refuse("ambient_pgssl_configuration_refused");
    }
  }
  try {
    assertNoAmbientPostgresEnvironment(
      env,
      "ambient_postgres_configuration_refused"
    );
  } catch (error) {
    if (
      error?.code === "ambient_postgres_configuration_refused"
    ) {
      refuse("ambient_postgres_configuration_refused");
    }
    throw error;
  }
  if (requireValue(env, "SOCIAL_TEST_POSTGRES_APPROVED") !== APPROVAL) {
    refuse("explicit_approval_missing");
  }
  for (const name of REQUIRED) requireValue(env, name);
  const environmentId = requireValue(env, "SOCIAL_TEST_ENVIRONMENT_ID")
    .toLowerCase();
  if (!UUID.test(environmentId)) refuse("environment_id_invalid");

  const mode = String(env.SOCIAL_TEST_TARGET_MODE || LOOPBACK_MODE)
    .trim()
    .toLowerCase();
  if (
    ![
      LOOPBACK_MODE,
      RENDER_REMOTE_MODE,
      RENDER_PAID_STAGING_DISPOSABLE_MODE
    ].includes(mode)
  ) {
    refuse("target_mode_invalid");
  }

  let expected = Object.freeze({});
  if (mode !== LOOPBACK_MODE) {
    const approval =
      mode === RENDER_REMOTE_MODE
        ? REMOTE_APPROVAL
        : PAID_STAGING_DISPOSABLE_APPROVAL;
    if (
      requireValue(env, "SOCIAL_TEST_RENDER_REMOTE_APPROVED") !== approval
    ) {
      refuse("remote_approval_missing");
    }
    for (const name of REMOTE_EXPECTED) requireValue(env, name);
    expected = Object.freeze({
      host: env.SOCIAL_TEST_EXPECTED_HOST.toLowerCase(),
      port: parsePort(
        env.SOCIAL_TEST_EXPECTED_PORT,
        "expected_port_invalid"
      ),
      database: env.SOCIAL_TEST_EXPECTED_DATABASE,
      usernames: Object.freeze([
        env.SOCIAL_TEST_EXPECTED_PROVISIONER_USERNAME,
        env.SOCIAL_TEST_EXPECTED_MIGRATION_USERNAME,
        env.SOCIAL_TEST_EXPECTED_RUNTIME_USERNAME
      ]),
      fingerprint: env.SOCIAL_TEST_EXPECTED_TARGET_FINGERPRINT.toLowerCase()
    });
    const targetLabels = [expected.database, ...expected.usernames];
    const freeTargetInvalid =
      mode === RENDER_REMOTE_MODE &&
      (
        expected.database !== REMOTE_DATABASE ||
        targetLabels.some((label) => BLOCKED_LABEL.test(label))
      );
    const paidDisposableTargetInvalid =
      mode === RENDER_PAID_STAGING_DISPOSABLE_MODE &&
      (
        environmentId !== PAID_STAGING_PUBLIC_TARGET.environmentId ||
        expected.host !== PAID_STAGING_PUBLIC_TARGET.host ||
        expected.port !== PAID_STAGING_PUBLIC_TARGET.port ||
        expected.database !== DISPOSABLE_DATABASE_NAME ||
        expected.usernames[0] !==
          PAID_STAGING_PUBLIC_TARGET.provisionerLogin ||
        expected.usernames[1] !==
          PAID_STAGING_PUBLIC_TARGET.migrationLogin ||
        expected.usernames[2] !==
          PAID_STAGING_PUBLIC_TARGET.runtimeLogin ||
        targetLabels.some((label) => PRODUCTION_LABEL.test(label))
      );
    if (
      net.isIP(expected.host) !== 0 ||
      !expected.host.endsWith(".render.com") ||
      freeTargetInvalid ||
      paidDisposableTargetInvalid
    ) {
      refuse("expected_target_not_disposable");
    }
  }

  const urls = CONNECTION_NAMES.map((name) =>
    parseDatabaseUrl(name, env, mode, expected)
  );
  const identities = urls.map((item) => item.identity);
  if (new Set(urls.map((item) => item.raw)).size !== urls.length) {
    refuse("database_urls_must_be_distinct");
  }
  if (new Set(identities.map((item) => item.username)).size !== 3) {
    refuse("database_users_must_be_distinct");
  }
  for (const identity of identities.slice(1)) {
    if (
      identity.host !== identities[0].host ||
      identity.port !== identities[0].port ||
      identity.database !== identities[0].database
    ) {
      refuse("database_targets_must_match");
    }
  }

  if (mode === LOOPBACK_MODE) {
    if (
      !/^ia4tube_social_test_[a-z0-9_]+$/.test(identities[0].database) ||
      BLOCKED_LABEL.test(identities[0].database) ||
      identities.some((identity) => BLOCKED_LABEL.test(identity.username))
    ) {
      refuse("database_target_not_synthetic");
    }
  } else {
    if (
      identities[0].database !== expected.database ||
      identities.some(
        (identity, index) =>
          identity.username !== expected.usernames[index]
      )
    ) {
      refuse("database_identity_mismatch");
    }
    const actualFingerprint = targetFingerprint({
      mode,
      environmentId,
      host: expected.host,
      port: expected.port,
      database: expected.database,
      provisionerUsername: expected.usernames[0],
      migrationUsername: expected.usernames[1],
      runtimeUsername: expected.usernames[2]
    });
    if (!equalFingerprint(actualFingerprint, expected.fingerprint)) {
      refuse("external_target_fingerprint_mismatch");
    }
  }

  let ssl;
  if (mode !== LOOPBACK_MODE) {
    try {
      ssl = loadSystemPostgresTls(env, identities[0].host);
    } catch (error) {
      if (typeof error?.code === "string") refuse(error.code);
      throw error;
    }
  }
  const configuration = {
    mode,
    environmentId,
    host: identities[0].host,
    port: identities[0].port,
    database: identities[0].database,
    identities: Object.freeze(identities),
    urls: Object.freeze(urls.map((item) => item.raw)),
    fingerprint: targetFingerprint({
      mode,
      environmentId,
      host: identities[0].host,
      port: identities[0].port,
      database: identities[0].database,
      provisionerUsername: identities[0].username,
      migrationUsername: identities[1].username,
      runtimeUsername: identities[2].username
    })
  };
  if (ssl) {
    Object.defineProperty(configuration, "ssl", {
      value: ssl,
      enumerable: false,
      writable: false,
      configurable: false
    });
  }
  return Object.freeze(configuration);
}

function main(env = process.env) {
  let configuration;
  try {
    configuration = validateGateEnvironment(env);
  } catch (error) {
    const code =
      error instanceof PostgresGateRefusal ? error.code : "guard_failed";
    process.stderr.write(`Teste PostgreSQL real recusado: ${code}.\n`);
    return 2;
  }

  const result = spawnSync(
    process.execPath,
    [
      "--test",
      path.resolve(__dirname, "..", "tests", "social-postgres-real.test.js")
    ],
    {
      cwd: path.resolve(__dirname, ".."),
      env: {
        ...env,
        SOCIAL_REAL_POSTGRES_REQUIRED: "true",
        SOCIAL_TEST_GATE_VALIDATED_FINGERPRINT: configuration.fingerprint
      },
      stdio: "inherit"
    }
  );
  if (result.error || result.status === null) {
    process.stderr.write(
      "Teste PostgreSQL real recusado: test_process_failed.\n"
    );
    return 2;
  }
  return result.status;
}

if (require.main === module) process.exit(main());

module.exports = {
  APPROVAL,
  LOOPBACK_MODE,
  PAID_STAGING_DISPOSABLE_APPROVAL,
  PostgresGateRefusal,
  REMOTE_APPROVAL,
  REMOTE_DATABASE,
  RENDER_PAID_STAGING_DISPOSABLE_MODE,
  RENDER_REMOTE_MODE,
  main,
  secureConnection,
  targetFingerprint,
  validateGateEnvironment
};
