"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  PAID_STAGING_PUBLIC_TARGET,
  STAGING_PROVISION_APPROVAL_PREFIX,
  STAGING_ROLES_SQL_SHA256,
  canonicalRolesSqlBody,
  loadStagingProvisionConfig,
  provisionStagingBaseline,
  stagingProvisionTargetFingerprint
} = require("../src/persistence/postgres/staging-provisioner");
const {
  main
} = require("../scripts/social-db-provision-staging");

const PASSWORD = "Synthetic-Staging-Provisioner-Password-2026!";

function target() {
  return {
    environmentId: PAID_STAGING_PUBLIC_TARGET.environmentId,
    host: PAID_STAGING_PUBLIC_TARGET.host,
    port: PAID_STAGING_PUBLIC_TARGET.port,
    database: PAID_STAGING_PUBLIC_TARGET.database,
    provisionerLogin: PAID_STAGING_PUBLIC_TARGET.provisionerLogin
  };
}

function databaseUrl(overrides = {}) {
  const value = { ...target(), ...overrides };
  return (
    `postgresql://${value.provisionerLogin}:${PASSWORD}@` +
    `${value.host}:${value.port}/${value.database}` +
    "?sslmode=verify-full"
  );
}

function environment(overrides = {}) {
  const identity = target();
  return {
    SOCIAL_STAGING_PROVISION_APPROVED:
      `${STAGING_PROVISION_APPROVAL_PREFIX}${identity.environmentId}`,
    SOCIAL_STAGING_PROVISIONER_DATABASE_URL: databaseUrl(),
    SOCIAL_STAGING_PROVISION_EXPECTED_ENVIRONMENT_ID:
      identity.environmentId,
    SOCIAL_STAGING_PROVISION_EXPECTED_HOST: identity.host,
    SOCIAL_STAGING_PROVISION_EXPECTED_PORT: identity.port,
    SOCIAL_STAGING_PROVISION_EXPECTED_DATABASE: identity.database,
    SOCIAL_STAGING_PROVISION_EXPECTED_PROVISIONER_LOGIN:
      identity.provisionerLogin,
    SOCIAL_STAGING_PROVISION_EXPECTED_TARGET_FINGERPRINT:
      stagingProvisionTargetFingerprint(identity),
    ...overrides
  };
}

function identityRow(overrides = {}) {
  return {
    database_name: PAID_STAGING_PUBLIC_TARGET.database,
    current_user_name: PAID_STAGING_PUBLIC_TARGET.provisionerLogin,
    session_user_name: PAID_STAGING_PUBLIC_TARGET.provisionerLogin,
    version_num: 180001,
    read_only: "off",
    datistemplate: false,
    datallowconn: true,
    database_owner: PAID_STAGING_PUBLIC_TARGET.provisionerLogin,
    provisioner_canlogin: true,
    provisioner_superuser: false,
    provisioner_createrole: true,
    provisioner_replication: false,
    provisioner_bypassrls: false,
    ...overrides
  };
}

function baselineRelations() {
  return [
    {
      schema_name: "ia4tube_migrations",
      relation_name: "environment_identity",
      relkind: "r"
    },
    {
      schema_name: "ia4tube_migrations",
      relation_name: "environment_identity_environment_id_key",
      relkind: "i"
    },
    {
      schema_name: "ia4tube_migrations",
      relation_name: "environment_identity_pkey",
      relkind: "i"
    }
  ];
}

function fakeClient(options = {}) {
  const queries = [];
  let releasedWith;
  let markerReads = 0;
  const state = options.state || "pristine";
  const client = {
    queries,
    get releasedWith() {
      return releasedWith;
    },
    async query(text, values) {
      const sql = String(text);
      queries.push({ sql, values });
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rowCount: null, rows: [] };
      }
      if (sql.includes("DO $postgres_version$")) {
        if (options.rolesFailure) throw options.rolesFailure;
        return { rowCount: null, rows: [] };
      }
      if (sql.includes("server_version_num")) {
        return { rowCount: 1, rows: [identityRow(options.identity)] };
      }
      if (sql.includes("migration_schema_count")) {
        if (state === "pristine") {
          return {
            rowCount: 1,
            rows: [{
              migration_schema_count: 0,
              application_schema_count: 0,
              unexpected_schema_count: 0
            }]
          };
        }
        if (state === "partial") {
          return {
            rowCount: 1,
            rows: [{
              migration_schema_count: 1,
              application_schema_count: 0,
              unexpected_schema_count: 0
            }]
          };
        }
        return {
          rowCount: 1,
          rows: [{
            migration_schema_count: state === "foreign" ? 0 : 1,
            application_schema_count: 0,
            unexpected_schema_count: 0
          }]
        };
      }
      if (sql.includes("relation.relname AS relation_name")) {
        return {
          rowCount:
            state === "pristine"
              ? 0
              : state === "partial"
                ? 1
                : state === "foreign"
                  ? 1
                : 3,
          rows:
            state === "pristine"
              ? []
              : state === "partial"
                ? [baselineRelations()[0]]
                : state === "foreign"
                  ? [{
                      schema_name: "public",
                      relation_name: "unrelated_data",
                      relkind: "r"
                    }]
                : baselineRelations()
        };
      }
      if (sql.includes("FROM ia4tube_migrations.environment_identity")) {
        markerReads += 1;
        const marker =
          options.marker || {
            environment_id: PAID_STAGING_PUBLIC_TARGET.environmentId,
            environment_name: "staging"
          };
        return { rowCount: 1, rows: [marker] };
      }
      if (sql.includes("INSERT INTO ia4tube_migrations.environment_identity")) {
        assert.deepEqual(values, [
          PAID_STAGING_PUBLIC_TARGET.environmentId
        ]);
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`unexpected_synthetic_query_${markerReads}`);
    },
    release(error) {
      releasedWith = error;
    }
  };
  return client;
}

function fakePool(client) {
  return {
    async connect() {
      return client;
    }
  };
}

test("configuration is compiled to one paid staging target and hides its URL", () => {
  const config = loadStagingProvisionConfig(environment());
  assert.deepEqual(config.target, target());
  assert.equal(config.pool.max, 1);
  assert.equal(config.pool.min, 0);
  assert.equal(config.pool.ssl.rejectUnauthorized, true);
  assert.equal(config.pool.ssl.minVersion, "TLSv1.2");
  assert.equal(config.pool.ssl.servername, target().host);
  assert.equal(
    new URL(config.pool.connectionString).search,
    ""
  );
  assert.equal(JSON.stringify(config).includes(PASSWORD), false);
  assert.equal(
    config.targetFingerprint,
    stagingProvisionTargetFingerprint(target())
  );
});

test("configuration refuses alternate identities, approvals, TLS and ambient overrides", () => {
  const alternateEnvironment =
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  for (const overrides of [
    { SOCIAL_STAGING_PROVISION_APPROVED: "wrong" },
    {
      SOCIAL_STAGING_PROVISION_EXPECTED_ENVIRONMENT_ID:
        alternateEnvironment,
      SOCIAL_STAGING_PROVISION_APPROVED:
        `${STAGING_PROVISION_APPROVAL_PREFIX}${alternateEnvironment}`
    },
    {
      SOCIAL_STAGING_PROVISION_EXPECTED_HOST:
        "dpg-other-a.oregon-postgres.render.com"
    },
    {
      SOCIAL_STAGING_PROVISION_EXPECTED_DATABASE:
        "ia4tube_social_staging_other"
    },
    {
      SOCIAL_STAGING_PROVISION_EXPECTED_TARGET_FINGERPRINT:
        "0".repeat(64)
    },
    {
      SOCIAL_STAGING_PROVISIONER_DATABASE_URL:
        databaseUrl({
          host: "dpg-other-a.oregon-postgres.render.com"
        })
    },
    {
      SOCIAL_STAGING_PROVISIONER_DATABASE_URL:
        databaseUrl().replace("verify-full", "require")
    },
    {
      SOCIAL_STAGING_PROVISIONER_DATABASE_URL:
        `${databaseUrl()}&application_name=forbidden`
    },
    { NODE_TLS_REJECT_UNAUTHORIZED: "0" },
    { PGPASSWORD: "ambient-secret" }
  ]) {
    assert.throws(
      () => loadStagingProvisionConfig(environment(overrides)),
      (error) =>
        String(error?.code || "").startsWith("staging_provision_") &&
        !String(error?.message || "").includes(PASSWORD)
    );
  }
});

test("canonical roles SQL is transaction-neutral and preserves required ACLs", () => {
  const sql = canonicalRolesSqlBody();
  assert.match(STAGING_ROLES_SQL_SHA256, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(
    sql,
    /(^|\n)\s*(?:BEGIN|START\s+TRANSACTION|COMMIT|ROLLBACK)\s*;/i
  );
  assert.match(sql, /REVOKE ALL ON DATABASE %I FROM PUBLIC/);
  assert.match(
    sql,
    /GRANT CREATE ON DATABASE %I TO ia4tube_social_owner/
  );
  assert.match(sql, /REVOKE CREATE ON SCHEMA public FROM PUBLIC/);
  assert.match(sql, /NOSUPERUSER/);
  assert.match(sql, /NOREPLICATION NOBYPASSRLS/);
});

test("canonical roles SQL is pinned to the reviewed byte sequence", (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "ia4tube-roles-sql-")
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "db", "postgres");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "roles.sql"),
    "BEGIN;\nSELECT 1;\nCOMMIT;\n"
  );
  assert.throws(
    () => canonicalRolesSqlBody({ root }),
    { code: "staging_provision_roles_sql_hash_mismatch" }
  );
});

test("pristine target is provisioned atomically and reports one change", async () => {
  const config = loadStagingProvisionConfig(environment());
  const client = fakeClient({ state: "pristine" });
  const result = await provisionStagingBaseline(
    fakePool(client),
    config
  );
  assert.deepEqual(result, {
    safe: true,
    changed: true,
    baselineCanonical: true
  });
  assert.equal(client.queries.some(({ sql }) => sql === "BEGIN"), true);
  assert.equal(client.queries.some(({ sql }) => sql === "COMMIT"), true);
  assert.equal(client.queries.some(({ sql }) => sql === "ROLLBACK"), false);
  assert.equal(
    client.queries.some(({ sql }) => sql.includes(PASSWORD)),
    false
  );
  assert.equal(client.releasedWith, undefined);
});

test("exact baseline rerun is idempotent and a partial baseline is refused", async () => {
  const config = loadStagingProvisionConfig(environment());
  const exact = fakeClient({ state: "baseline" });
  const result = await provisionStagingBaseline(fakePool(exact), config);
  assert.equal(result.changed, false);
  assert.equal(result.baselineCanonical, true);

  const partial = fakeClient({ state: "partial" });
  await assert.rejects(
    provisionStagingBaseline(fakePool(partial), config),
    { code: "staging_provision_target_not_baseline" }
  );
  assert.equal(
    partial.queries.some(({ sql }) => sql === "BEGIN"),
    false
  );

  const foreign = fakeClient({ state: "foreign" });
  await assert.rejects(
    provisionStagingBaseline(fakePool(foreign), config),
    { code: "staging_provision_target_not_baseline" }
  );
  assert.equal(
    foreign.queries.some(({ sql }) => sql === "BEGIN"),
    false
  );
});

test("identity or marker drift is refused before commit", async () => {
  const config = loadStagingProvisionConfig(environment());
  await assert.rejects(
    provisionStagingBaseline(
      fakePool(fakeClient({
        state: "pristine",
        identity: { provisioner_superuser: true }
      })),
      config
    ),
    { code: "staging_provision_database_identity_invalid" }
  );

  const markerDrift = fakeClient({
    state: "baseline",
    marker: {
      environment_id: PAID_STAGING_PUBLIC_TARGET.environmentId,
      environment_name: "production"
    }
  });
  await assert.rejects(
    provisionStagingBaseline(fakePool(markerDrift), config),
    { code: "staging_provision_environment_marker_mismatch" }
  );
  assert.equal(
    markerDrift.queries.some(({ sql }) => sql === "BEGIN"),
    false
  );
});

test("roles failure rolls back and operator output remains redacted", async () => {
  const config = loadStagingProvisionConfig(environment());
  const client = fakeClient({
    state: "pristine",
    rolesFailure: new Error(`driver-failure-${PASSWORD}`)
  });
  await assert.rejects(
    provisionStagingBaseline(fakePool(client), config),
    { code: "staging_provision_failed" }
  );
  assert.equal(client.queries.some(({ sql }) => sql === "ROLLBACK"), true);

  let stdout = "";
  let stderr = "";
  class FailingPool {
    async connect() {
      throw new Error(`connect-failure-${PASSWORD}`);
    }
    async end() {}
  }
  const status = await main({
    env: environment(),
    argv: [],
    PoolClass: FailingPool,
    stdout: { write(value) { stdout += value; } },
    stderr: { write(value) { stderr += value; } }
  });
  assert.equal(status, 1);
  assert.equal(stdout, "");
  assert.equal(stderr.includes(PASSWORD), false);
  assert.deepEqual(JSON.parse(stderr), {
    ok: false,
    code: "staging_provision_failed"
  });
});

test("operator refuses argv before opening a database pool", async () => {
  let constructed = 0;
  class ForbiddenPool {
    constructor() {
      constructed += 1;
    }
  }
  let stderr = "";
  const status = await main({
    env: environment(),
    argv: ["--url", databaseUrl()],
    PoolClass: ForbiddenPool,
    stdout: { write() {} },
    stderr: { write(value) { stderr += value; } }
  });
  assert.equal(status, 2);
  assert.equal(constructed, 0);
  assert.equal(stderr.includes(PASSWORD), false);
  assert.deepEqual(JSON.parse(stderr), {
    ok: false,
    code: "staging_provision_argv_refused"
  });
});

test("operator forwards the hidden connection string to the real pool boundary", async () => {
  let received;
  class InspectingPool {
    constructor(options) {
      received = options;
    }
    async connect() {
      throw new Error("synthetic connection refusal");
    }
    async end() {}
  }
  const status = await main({
    env: environment(),
    argv: [],
    PoolClass: InspectingPool,
    stdout: { write() {} },
    stderr: { write() {} }
  });
  assert.equal(status, 1);
  assert.equal(typeof received?.connectionString, "string");
  const parsed = new URL(received.connectionString);
  assert.equal(parsed.hostname, target().host);
  assert.equal(decodeURIComponent(parsed.username), target().provisionerLogin);
  assert.equal(decodeURIComponent(parsed.pathname.slice(1)), target().database);
  assert.equal(parsed.search, "");
});

test("operator refuses success when the provisioner pool cannot close", async () => {
  let stdout = "";
  let stderr = "";
  const client = fakeClient({ state: "pristine" });
  class CloseFailurePool {
    async connect() {
      return client;
    }
    async end() {
      throw new Error(`close-failure-${PASSWORD}`);
    }
  }
  const status = await main({
    env: environment(),
    PoolClass: CloseFailurePool,
    stdout: { write(value) { stdout += value; } },
    stderr: { write(value) { stderr += value; } }
  });
  assert.equal(status, 1);
  assert.equal(stdout, "");
  assert.equal(stderr.includes(PASSWORD), false);
  assert.deepEqual(JSON.parse(stderr), {
    ok: false,
    code: "staging_provision_pool_close_failed"
  });
});
