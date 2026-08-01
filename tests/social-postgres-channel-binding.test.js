"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { Client } = require("pg");
const { parse } = require("pg-connection-string");
const {
  databaseTargetFingerprint,
  loadRuntimePostgresConfig
} = require("../src/persistence/postgres/config");
const { createSocialRuntime } = require("../src/social/runtime");

const runtimeLogin = "ia4tube_social_staging_runtime";
const host = "db.example.test";
const database = "ia4tube_social_staging";
const password = "synthetic-channel-binding-secret-never-log";

function installedPackageVersion(name) {
  let directory = path.dirname(require.resolve(name));
  while (!fs.existsSync(path.join(directory, "package.json"))) {
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error("package_manifest_missing");
    directory = parent;
  }
  return JSON.parse(
    fs.readFileSync(path.join(directory, "package.json"), "utf8")
  ).version;
}

function runtimeUrl({
  login = runtimeLogin,
  secret = password,
  query = "sslmode=verify-full",
  explicitPort = true
} = {}) {
  const port = explicitPort ? ":5432" : "";
  return (
    `postgresql://${encodeURIComponent(login)}:` +
    `${encodeURIComponent(secret)}@${host}${port}/${database}?${query}`
  );
}

function fingerprint(url) {
  return databaseTargetFingerprint(new URL(url));
}

function runtimeEnvironment(url, expected = fingerprint(url)) {
  return {
    SOCIAL_PERSISTENCE_ENABLED: "true",
    DATABASE_URL: url,
    SOCIAL_DATABASE_EXPECTED_TARGET_FINGERPRINT: expected,
    SOCIAL_DATABASE_EXPECTED_RUNTIME_LOGIN: runtimeLogin,
    SOCIAL_DATABASE_POOL_MAX: "3"
  };
}

function runtimeOutcome(url) {
  try {
    loadRuntimePostgresConfig(runtimeEnvironment(url));
    return "accepted";
  } catch (error) {
    return error?.code || "sanitized_failure";
  }
}

function installedSasl() {
  return require(
    path.join(path.dirname(require.resolve("pg")), "crypto", "sasl")
  );
}

test("installed node-postgres accepts the URL key but does not apply require semantics", () => {
  assert.equal(installedPackageVersion("pg"), "8.22.0");
  assert.equal(installedPackageVersion("pg-connection-string"), "2.14.0");

  const url = runtimeUrl({
    query: "sslmode=verify-full&channel_binding=require"
  });
  const parsed = parse(url);
  assert.equal(parsed.channel_binding, "require");
  assert.equal(parsed.enableChannelBinding, undefined);

  const clientFromUrl = new Client({ connectionString: url });
  assert.equal(clientFromUrl.enableChannelBinding, false);
  assert.equal(clientFromUrl.connectionParameters.channel_binding, undefined);

  const clientWithExplicitPreference = new Client({
    connectionString: url,
    enableChannelBinding: true
  });
  assert.equal(clientWithExplicitPreference.enableChannelBinding, true);

  const stream = {
    getPeerCertificate() {
      return { raw: Buffer.from([1]) };
    }
  };
  const sasl = installedSasl();
  assert.equal(
    sasl.startSession(
      ["SCRAM-SHA-256", "SCRAM-SHA-256-PLUS"],
      stream
    ).mechanism,
    "SCRAM-SHA-256-PLUS"
  );
  assert.equal(
    sasl.startSession(["SCRAM-SHA-256"], stream).mechanism,
    "SCRAM-SHA-256"
  );
});

test("runtime accepts only canonical verify-full without channel_binding", () => {
  const url = runtimeUrl();
  const configuration = loadRuntimePostgresConfig(
    runtimeEnvironment(url)
  );
  assert.equal(configuration.enabled, true);
  assert.equal(configuration.pool.max, 3);
  assert.equal(configuration.pool.ssl.rejectUnauthorized, true);
  assert.equal(configuration.pool.ssl.minVersion, "TLSv1.2");
});

test("runtime rejects every channel_binding spelling and value", () => {
  const queries = [
    "sslmode=verify-full&channel_binding=require",
    "sslmode=verify-full&channel_binding=prefer",
    "sslmode=verify-full&channel_binding=disable",
    "sslmode=verify-full&channel_binding=",
    "sslmode=verify-full&channel_binding=REQUIRE",
    "sslmode=verify-full&channel_binding=%20require%20",
    "sslmode=verify-full&channel_binding=require&channel_binding=require"
  ];
  for (const query of queries) {
    assert.equal(
      runtimeOutcome(runtimeUrl({ query })),
      "social_database_connection_parameter_forbidden"
    );
  }
});

test("runtime rejects unknown parameters and non-verify-full TLS modes", () => {
  assert.equal(
    runtimeOutcome(
      runtimeUrl({ query: "sslmode=verify-full&unknown_parameter=true" })
    ),
    "social_database_connection_parameter_forbidden"
  );
  for (const mode of ["disable", "prefer", "require", "verify-ca", "no-verify"]) {
    assert.equal(
      runtimeOutcome(runtimeUrl({ query: `sslmode=${mode}` })),
      "social_database_tls_mode_invalid"
    );
  }
});

test("query order never changes the fingerprint but both unsafe URLs fail closed", () => {
  const channelFirst = runtimeUrl({
    query: "channel_binding=require&sslmode=verify-full"
  });
  const sslFirst = runtimeUrl({
    query: "sslmode=verify-full&channel_binding=require"
  });
  assert.equal(fingerprint(channelFirst), fingerprint(sslFirst));
  assert.equal(
    runtimeOutcome(channelFirst),
    "social_database_connection_parameter_forbidden"
  );
  assert.equal(
    runtimeOutcome(sslFirst),
    "social_database_connection_parameter_forbidden"
  );
});

test("query, password, username and explicit default port stay outside the fingerprint", () => {
  const baseline = fingerprint(runtimeUrl());
  assert.equal(
    fingerprint(
      runtimeUrl({
        query: "channel_binding=require&sslmode=verify-full"
      })
    ),
    baseline
  );
  assert.equal(
    fingerprint(runtimeUrl({ secret: "different-synthetic-secret" })),
    baseline
  );
  assert.equal(
    fingerprint(runtimeUrl({ login: "different_synthetic_login" })),
    baseline
  );
  assert.equal(
    fingerprint(runtimeUrl({ explicitPort: false })),
    baseline
  );
});

test("invalid channel_binding fails before pool creation and logs remain secret-free", async () => {
  const url = runtimeUrl({
    query: "sslmode=verify-full&channel_binding=require"
  });
  let poolCreations = 0;
  class ForbiddenPool {
    constructor() {
      poolCreations += 1;
    }
  }

  let captured;
  await assert.rejects(
    createSocialRuntime({
      env: runtimeEnvironment(url),
      PoolClass: ForbiddenPool
    }),
    (error) => {
      captured = String(error?.stack || error);
      return error?.code === "social_database_connection_parameter_forbidden";
    }
  );
  assert.equal(poolCreations, 0);
  for (const sensitive of [url, password, fingerprint(url), host]) {
    assert.equal(captured.includes(sensitive), false);
  }
});
