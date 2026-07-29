"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  BOOTSTRAP_APPROVAL,
  BOOTSTRAP_LOCK_ID,
  MIGRATION_CONNECTION_LIMIT,
  MIGRATOR_ROLE,
  RUNTIME_CONNECTION_LIMIT,
  RUNTIME_ROLE,
  bootstrapDatabaseLogins,
  inspectPermanentDatabaseLogins,
  loadLoginBootstrapConfig,
  targetFingerprint,
  validateBootstrapConfiguration,
  validateInfrastructureSnapshot,
  validateLoginSnapshot,
  verifyProvisionedLoginCredentials
} = require("../src/persistence/postgres/login-bootstrap");
const { main } = require("../scripts/social-db-bootstrap-logins");

const root = path.resolve(__dirname, "..");
const PROVISIONER_PASSWORD = "Provisioner-Only-Synthetic-Password-123!";
const MIGRATION_PASSWORD = "Migration-Only-Synthetic-Password-456!";
const RUNTIME_PASSWORD = "Runtime-Only-Synthetic-Password-789!";
const TARGET = Object.freeze({
  host: "synthetic-a.oregon-postgres.render.com",
  port: "5432",
  database: "ia4tube_social_synthetic",
  provisionerLogin: "synthetic_provisioner",
  migrationLogin: "synthetic_migration_login",
  runtimeLogin: "synthetic_runtime_login"
});

function environment(overrides = {}) {
  return {
    SOCIAL_LOGIN_BOOTSTRAP_APPROVED: BOOTSTRAP_APPROVAL,
    SOCIAL_LOGIN_BOOTSTRAP_PROVISIONER_DATABASE_URL:
      `postgresql://${TARGET.provisionerLogin}:` +
      `${encodeURIComponent(PROVISIONER_PASSWORD)}@${TARGET.host}:` +
      `${TARGET.port}/${TARGET.database}?sslmode=verify-full`,
    SOCIAL_LOGIN_BOOTSTRAP_EXPECTED_HOST: TARGET.host,
    SOCIAL_LOGIN_BOOTSTRAP_EXPECTED_DATABASE: TARGET.database,
    SOCIAL_LOGIN_BOOTSTRAP_EXPECTED_PROVISIONER_LOGIN:
      TARGET.provisionerLogin,
    SOCIAL_LOGIN_BOOTSTRAP_EXPECTED_TARGET_FINGERPRINT:
      targetFingerprint(TARGET),
    SOCIAL_LOGIN_BOOTSTRAP_MIGRATION_LOGIN: TARGET.migrationLogin,
    SOCIAL_LOGIN_BOOTSTRAP_MIGRATION_PASSWORD: MIGRATION_PASSWORD,
    SOCIAL_LOGIN_BOOTSTRAP_RUNTIME_LOGIN: TARGET.runtimeLogin,
    SOCIAL_LOGIN_BOOTSTRAP_RUNTIME_PASSWORD: RUNTIME_PASSWORD,
    ...overrides
  };
}

function safeInfrastructure(overrides = {}) {
  return {
    postgres_version_supported: true,
    provisioner_is_database_owner: true,
    provisioner_safe: true,
    public_database_acl_absent: true,
    public_schema_create_absent: true,
    nologin_roles_exact: true,
    provisioner_admin_memberships_exact: true,
    canonical_role_memberships_restricted: true,
    owner_migrator_membership_exact: true,
    canonical_role_topology_exact: true,
    ...overrides
  };
}

function safeLogin(overrides = {}) {
  return {
    can_login: true,
    superuser: false,
    create_database: false,
    create_role: false,
    inherit: false,
    replication: false,
    bypass_rls: false,
    connection_limit: MIGRATION_CONNECTION_LIMIT,
    connection_limit_exact: true,
    valid_until_absent: true,
    role_config_absent: true,
    password_present: true,
    direct_membership_count: "1",
    expected_membership_exact: true,
    role_members_count: "1",
    role_administration_exact: true,
    direct_database_acl_count: "1",
    direct_connect_exact: true,
    database_create: false,
    database_temp: false,
    schema_create: false,
    owns_objects: false,
    cluster_ownership_dependency: false,
    table_truncate: false,
    ...overrides
  };
}

function harness({ before = [null, null], after } = {}) {
  const queries = [];
  const secrets = [];
  const inspections = [
    ...before,
    ...(after || before.map(() => safeLogin()))
  ];
  let infrastructureInspections = 0;
  const client = {
    release() {
      this.released = true;
    }
  };

  let inspectionIndex = 0;
  client.query = async (text, values = []) => {
    queries.push({ text, values });
    if (text.includes("login_bootstrap_infrastructure")) {
      infrastructureInspections += 1;
      return { rows: [safeInfrastructure()] };
    }
    if (text.includes("login_bootstrap_login */")) {
      const snapshot = inspections[inspectionIndex];
      inspectionIndex += 1;
      return snapshot ? { rows: [snapshot] } : { rows: [] };
    }
    if (
      text.includes("ia4tube.login_bootstrap.password") &&
      values.length === 2
    ) {
      secrets.push(values[1]);
    }
    return { rows: [{ ok: true }] };
  };

  return {
    pool: {
      async connect() {
        return client;
      }
    },
    client,
    queries,
    secrets,
    infrastructureInspections() {
      return infrastructureInspections;
    }
  };
}

function assertCode(operation, code) {
  assert.throws(operation, (error) => error?.code === code);
}

test("configuration requires explicit target, distinct logins and strong env passwords", () => {
  const config = loadLoginBootstrapConfig(environment());
  assert.equal(config.target.migrationLogin, TARGET.migrationLogin);
  assert.equal(config.target.runtimeLogin, TARGET.runtimeLogin);
  assert.equal(
    config.migration.connectionLimit,
    MIGRATION_CONNECTION_LIMIT
  );
  assert.equal(config.runtime.connectionLimit, RUNTIME_CONNECTION_LIMIT);
  assert.equal(config.provisionerPool.ssl.rejectUnauthorized, true);
  assert.equal(config.provisionerPool.ssl.servername, TARGET.host);
  assert.equal(
    config.provisionerPool.connectionString.includes("sslmode"),
    false
  );
  assert.equal(
    Object.keys(config.provisionerPool).includes("connectionString"),
    false
  );
  assert.equal(Object.keys(config.migration).includes("password"), false);
  assert.equal(Object.keys(config.runtime).includes("password"), false);
  const serialized = JSON.stringify(config);
  assert.equal(serialized.includes(PROVISIONER_PASSWORD), false);
  assert.equal(serialized.includes(MIGRATION_PASSWORD), false);
  assert.equal(serialized.includes(RUNTIME_PASSWORD), false);

  assertCode(
    () => loadLoginBootstrapConfig(environment({
      SOCIAL_LOGIN_BOOTSTRAP_APPROVED: ""
    })),
    "login_bootstrap_approval_missing"
  );
  assertCode(
    () => loadLoginBootstrapConfig(environment({
      SOCIAL_LOGIN_BOOTSTRAP_RUNTIME_LOGIN: TARGET.migrationLogin
    })),
    "login_bootstrap_logins_must_be_distinct"
  );
  assertCode(
    () => loadLoginBootstrapConfig(environment({
      SOCIAL_LOGIN_BOOTSTRAP_RUNTIME_PASSWORD: "weak"
    })),
    "login_bootstrap_runtime_password_weak"
  );
  assertCode(
    () => loadLoginBootstrapConfig(environment({
      SOCIAL_LOGIN_BOOTSTRAP_RUNTIME_PASSWORD: MIGRATION_PASSWORD
    })),
    "login_bootstrap_passwords_must_be_distinct"
  );
  assertCode(
    () => loadLoginBootstrapConfig(environment({
      SOCIAL_LOGIN_BOOTSTRAP_RUNTIME_PASSWORD: PROVISIONER_PASSWORD
    })),
    "login_bootstrap_passwords_must_be_distinct"
  );
  assertCode(
    () => loadLoginBootstrapConfig(environment({
      SOCIAL_LOGIN_BOOTSTRAP_EXPECTED_DATABASE: "wrong_database"
    })),
    "login_bootstrap_target_mismatch"
  );
  assertCode(
    () => loadLoginBootstrapConfig(environment({
      SOCIAL_LOGIN_BOOTSTRAP_EXPECTED_TARGET_FINGERPRINT: "0".repeat(64)
    })),
    "login_bootstrap_target_fingerprint_mismatch"
  );
});

test("ambient PostgreSQL overrides and URL connection options fail closed", () => {
  assertCode(
    () => loadLoginBootstrapConfig(environment({
      NODE_TLS_REJECT_UNAUTHORIZED: "0"
    })),
    "login_bootstrap_tls_disabled"
  );
  for (const [name, value] of [
    ["PGSSLMODE", "require"],
    ["PGOPTIONS", "-c search_path=untrusted"],
    ["PGSERVICE", "untrusted-service"],
    ["PGPASSFILE", "untrusted-password-file"],
    ["PGHOST", "untrusted.example.test"],
    ["pgclientencoding", "SQL_ASCII"],
    ["PGFUTUREOVERRIDE", "configured"]
  ]) {
    assertCode(
      () =>
        loadLoginBootstrapConfig(environment({
          [name]: value
        })),
      "login_bootstrap_postgres_environment_override_forbidden"
    );
  }
  assert.doesNotThrow(() =>
    loadLoginBootstrapConfig(environment({
      PGOPTIONS: " "
    }))
  );
  assertCode(
    () => loadLoginBootstrapConfig(environment({
      SOCIAL_LOGIN_BOOTSTRAP_PROVISIONER_DATABASE_URL:
        environment().SOCIAL_LOGIN_BOOTSTRAP_PROVISIONER_DATABASE_URL +
        "&application_name=unexpected"
    })),
    "login_bootstrap_provisioner_url_invalid"
  );
});

test("catalog validators accept only exact least-privilege topology", () => {
  assert.doesNotThrow(() =>
    validateInfrastructureSnapshot(safeInfrastructure())
  );
  assert.doesNotThrow(() => validateLoginSnapshot(safeLogin()));

  for (const field of [
    "postgres_version_supported",
    "provisioner_is_database_owner",
    "provisioner_safe",
    "public_database_acl_absent",
    "public_schema_create_absent",
    "nologin_roles_exact",
    "provisioner_admin_memberships_exact",
    "canonical_role_memberships_restricted",
    "owner_migrator_membership_exact",
    "canonical_role_topology_exact"
  ]) {
    assertCode(
      () =>
        validateInfrastructureSnapshot(
          safeInfrastructure({ [field]: false })
        ),
      "login_bootstrap_infrastructure_drift"
    );
  }

  for (const field of [
    "superuser",
    "create_database",
    "create_role",
    "inherit",
    "replication",
    "bypass_rls",
    "database_create",
    "database_temp",
    "schema_create",
    "owns_objects",
    "cluster_ownership_dependency",
    "table_truncate"
  ]) {
    assertCode(
      () => validateLoginSnapshot(safeLogin({ [field]: true })),
      "login_bootstrap_login_drift"
    );
  }
  for (const field of [
    "can_login",
    "connection_limit_exact",
    "valid_until_absent",
    "role_config_absent",
    "password_present",
    "expected_membership_exact",
    "role_administration_exact",
    "direct_connect_exact"
  ]) {
    assertCode(
      () => validateLoginSnapshot(safeLogin({ [field]: false })),
      "login_bootstrap_login_drift"
    );
  }
  for (const [field, value] of [
    ["direct_membership_count", "2"],
    ["role_members_count", "2"],
    ["direct_database_acl_count", "2"]
  ]) {
    assertCode(
      () => validateLoginSnapshot(safeLogin({ [field]: value })),
      "login_bootstrap_login_drift"
    );
  }
});

test("infrastructure query rejects direct and transitive canonical escalation", () => {
  const {
    INFRASTRUCTURE_SQL
  } = require("../src/persistence/postgres/login-bootstrap");
  assert.match(
    INFRASTRUCTURE_SQL,
    /pg_catalog\.pg_has_role\(\$3, \$2, 'MEMBER'\)/
  );
  assert.match(
    INFRASTRUCTURE_SQL,
    /NOT pg_catalog\.pg_has_role\(\$4, \$2, 'MEMBER'\)/
  );
  assert.match(
    INFRASTRUCTURE_SQL,
    /WHERE member\.rolname = ANY\(\$1::text\[\]\)/
  );
  assert.match(
    INFRASTRUCTURE_SQL,
    /AS canonical_role_memberships_restricted/
  );
  assert.match(
    INFRASTRUCTURE_SQL,
    /granted\.rolname = \$3[\s\S]*?member\.rolname = \$5/
  );
  assert.match(
    INFRASTRUCTURE_SQL,
    /granted\.rolname = \$4[\s\S]*?member\.rolname = \$6/
  );
  assert.doesNotMatch(
    INFRASTRUCTURE_SQL,
    /WHERE granted\.rolname = ANY\(\$1::text\[\]\)\s+AND member\.rolname/
  );
});

test("a third login in any canonical role is refused before mutation", async () => {
  assertCode(
    () =>
      validateInfrastructureSnapshot(
        safeInfrastructure({
          canonical_role_memberships_restricted: false
        })
      ),
    "login_bootstrap_infrastructure_drift"
  );

  const configuration = loadLoginBootstrapConfig(environment());
  const fake = harness();
  fake.client.query = async (text) => {
    fake.queries.push({ text, values: [] });
    if (text.includes("login_bootstrap_infrastructure")) {
      return {
        rows: [
          safeInfrastructure({
            canonical_role_memberships_restricted: false
          })
        ]
      };
    }
    return { rows: [] };
  };
  await assert.rejects(
    bootstrapDatabaseLogins(fake.pool, configuration),
    { code: "login_bootstrap_infrastructure_drift" }
  );
  const texts = fake.queries.map((query) => query.text).join("\n");
  assert.doesNotMatch(texts, /CREATE ROLE|GRANT CONNECT ON DATABASE/);
  assert.match(texts, /ROLLBACK/);
});

test("direct parameter API cannot bypass canonical role mapping or password rules", () => {
  const config = loadLoginBootstrapConfig(environment());
  assert.doesNotThrow(() => validateBootstrapConfiguration(config));
  assertCode(
    () =>
      validateBootstrapConfiguration({
        ...config,
        runtime: {
          ...config.runtime,
          role: "ia4tube_social_owner"
        }
      }),
    "login_bootstrap_role_mapping_invalid"
  );
  assertCode(
    () =>
      validateBootstrapConfiguration({
        ...config,
        runtime: {
          ...config.runtime,
          connectionLimit: RUNTIME_CONNECTION_LIMIT + 1
        }
      }),
    "login_bootstrap_connection_limit_invalid"
  );
  assertCode(
    () =>
      validateBootstrapConfiguration({
        ...config,
        migration: {
          ...config.migration,
          password: "weak"
        }
      }),
    "login_bootstrap_migration_password_weak"
  );
});

test("bootstrap creates both missing logins atomically without secret SQL text", async () => {
  const configuration = loadLoginBootstrapConfig(environment());
  const fake = harness();
  const result = await bootstrapDatabaseLogins(fake.pool, configuration);
  assert.deepEqual(result, {
    safe: true,
    created: { migration: true, runtime: true },
    migrationConnectionLimitUpdated: false
  });
  assert.equal(fake.client.released, true);
  assert.equal(fake.infrastructureInspections(), 2);
  assert.deepEqual(fake.secrets, [MIGRATION_PASSWORD, RUNTIME_PASSWORD]);

  const texts = fake.queries.map((query) => query.text).join("\n");
  for (const secret of [
    PROVISIONER_PASSWORD,
    MIGRATION_PASSWORD,
    RUNTIME_PASSWORD
  ]) {
    assert.equal(texts.includes(secret), false);
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
  assert.match(
    texts,
    /LOGIN NOSUPERUSER NOCREATEDB[\s\S]*?NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS/
  );
  assert.match(
    texts,
    new RegExp(`CONNECTION LIMIT ${MIGRATION_CONNECTION_LIMIT}`)
  );
  assert.match(
    texts,
    new RegExp(`CONNECTION LIMIT ${RUNTIME_CONNECTION_LIMIT}`)
  );
  assert.doesNotMatch(texts, /CONNECTION LIMIT -1/);
  assert.match(
    texts,
    new RegExp(
      `GRANT "${MIGRATOR_ROLE}" TO "${TARGET.migrationLogin}"` +
        "[\\s\\S]*?ADMIN FALSE, INHERIT FALSE, SET TRUE"
    )
  );
  assert.match(
    texts,
    new RegExp(
      `GRANT "${RUNTIME_ROLE}" TO "${TARGET.runtimeLogin}"` +
        "[\\s\\S]*?ADMIN FALSE, INHERIT FALSE, SET TRUE"
    )
  );
  assert.match(
    texts,
    new RegExp(
      `GRANT CONNECT ON DATABASE "${TARGET.database}"` +
        `[\\s\\S]*?TO "${TARGET.migrationLogin}"`
    )
  );
  const mutationTexts = fake.queries
    .map((query) => query.text.trim())
    .filter((text) =>
      /^(CREATE|ALTER|GRANT|REVOKE|TRUNCATE)\b/i.test(text)
    )
    .join("\n");
  assert.doesNotMatch(
    mutationTexts,
    /\b(GRANT\s+(CREATE|TEMP)|TRUNCATE|ALTER\s+.*OWNER|OWNER\s+TO)\b/i
  );
  assert.ok(
    fake.queries.some(
      (query) =>
        query.text.includes("pg_advisory_xact_lock") &&
        query.values[0] === BOOTSTRAP_LOCK_ID
    )
  );
  assert.ok(
    fake.queries.some(
      (query) => query.text === "SET LOCAL createrole_self_grant = ''"
    )
  );
  assert.ok(
    fake.queries.some(
      (query) =>
        query.text ===
        "SET LOCAL password_encryption = 'scram-sha-256'"
    )
  );
  assert.equal(fake.queries.at(-1).text, "COMMIT");
});

test("bootstrap upgrades only the approved migration limit from one to two", async () => {
  const configuration = loadLoginBootstrapConfig(environment());
  const fake = harness({
    before: [
      safeLogin({
        connection_limit: 1,
        connection_limit_exact: false
      }),
      safeLogin({ connection_limit: RUNTIME_CONNECTION_LIMIT })
    ],
    after: [
      safeLogin({ connection_limit: MIGRATION_CONNECTION_LIMIT }),
      safeLogin({ connection_limit: RUNTIME_CONNECTION_LIMIT })
    ]
  });
  const result = await bootstrapDatabaseLogins(fake.pool, configuration);
  assert.deepEqual(result, {
    safe: true,
    created: { migration: false, runtime: false },
    migrationConnectionLimitUpdated: true
  });
  const texts = fake.queries.map((query) => query.text).join("\n");
  assert.match(
    texts,
    new RegExp(
      `ALTER ROLE "${TARGET.migrationLogin}" ` +
        `CONNECTION LIMIT ${MIGRATION_CONNECTION_LIMIT}`
    )
  );
  assert.doesNotMatch(texts, /CREATE ROLE|GRANT CONNECT ON DATABASE/);
  assert.deepEqual(fake.secrets, []);

  const runtimeDrift = harness({
    before: [
      safeLogin(),
      safeLogin({
        connection_limit: 1,
        connection_limit_exact: false
      })
    ]
  });
  await assert.rejects(
    bootstrapDatabaseLogins(runtimeDrift.pool, configuration),
    { code: "login_bootstrap_login_drift" }
  );
  const runtimeTexts = runtimeDrift.queries
    .map((query) => query.text)
    .join("\n");
  assert.doesNotMatch(runtimeTexts, /ALTER ROLE|CREATE ROLE|GRANT CONNECT/);

  const migrationDrift = harness({
    before: [
      safeLogin({
        connection_limit: -1,
        connection_limit_exact: false
      }),
      safeLogin({ connection_limit: RUNTIME_CONNECTION_LIMIT })
    ]
  });
  await assert.rejects(
    bootstrapDatabaseLogins(migrationDrift.pool, configuration),
    { code: "login_bootstrap_login_drift" }
  );
  const migrationTexts = migrationDrift.queries
    .map((query) => query.text)
    .join("\n");
  assert.doesNotMatch(
    migrationTexts,
    /ALTER ROLE|CREATE ROLE|GRANT CONNECT/
  );
});

test("public permanent-login validator checks both exact limits and memberships", async () => {
  const fake = harness({
    before: [safeLogin(), safeLogin()],
    after: []
  });
  const result = await inspectPermanentDatabaseLogins(fake.client, {
    migrationLogin: TARGET.migrationLogin,
    runtimeLogin: TARGET.runtimeLogin
  });
  assert.deepEqual(result, {
    migration: {
      login: TARGET.migrationLogin,
      role: MIGRATOR_ROLE,
      connectionLimit: MIGRATION_CONNECTION_LIMIT,
      validated: true
    },
    runtime: {
      login: TARGET.runtimeLogin,
      role: RUNTIME_ROLE,
      connectionLimit: RUNTIME_CONNECTION_LIMIT,
      validated: true
    }
  });
  const inspections = fake.queries.filter((query) =>
    query.text.includes("login_bootstrap_login */")
  );
  assert.deepEqual(inspections.map((query) => query.values), [
    [TARGET.migrationLogin, MIGRATOR_ROLE, MIGRATION_CONNECTION_LIMIT],
    [TARGET.runtimeLogin, RUNTIME_ROLE, RUNTIME_CONNECTION_LIMIT]
  ]);

  const drift = harness({
    before: [
      safeLogin(),
      safeLogin({ connection_limit_exact: false })
    ],
    after: []
  });
  await assert.rejects(
    inspectPermanentDatabaseLogins(drift.client, {
      migrationLogin: TARGET.migrationLogin,
      runtimeLogin: TARGET.runtimeLogin
    }),
    { code: "login_bootstrap_login_drift" }
  );
});

test("exact rerun is idempotent and never receives password parameters", async () => {
  const configuration = loadLoginBootstrapConfig(environment());
  const exact = [safeLogin(), safeLogin()];
  const fake = harness({ before: exact, after: exact });
  const result = await bootstrapDatabaseLogins(fake.pool, configuration);
  assert.deepEqual(result, {
    safe: true,
    created: { migration: false, runtime: false },
    migrationConnectionLimitUpdated: false
  });
  const texts = fake.queries.map((query) => query.text).join("\n");
  assert.doesNotMatch(texts, /CREATE ROLE|GRANT CONNECT ON DATABASE/);
  assert.deepEqual(fake.secrets, []);
});

test("existing drift aborts before any role, membership or ACL mutation", async () => {
  const configuration = loadLoginBootstrapConfig(environment());
  const fake = harness({
    before: [safeLogin({ bypass_rls: true }), null]
  });
  await assert.rejects(
    bootstrapDatabaseLogins(fake.pool, configuration),
    { code: "login_bootstrap_login_drift" }
  );
  const texts = fake.queries.map((query) => query.text).join("\n");
  assert.doesNotMatch(texts, /CREATE ROLE|GRANT CONNECT ON DATABASE/);
  assert.match(texts, /ROLLBACK/);
  assert.equal(fake.client.released, true);
});

test("provided passwords authenticate both isolated logins without logging them", async () => {
  const configuration = loadLoginBootstrapConfig(environment());
  const poolConfigs = [];
  class VerificationPool {
    constructor(config) {
      poolConfigs.push(config);
    }
    async connect() {
      return {
        async query(text) {
          if (text.includes("role_not_assumed")) {
            return {
              rows: [{
                login_exact: true,
                role_not_assumed: true,
                database_exact: true,
                superuser_absent: true,
                database_create_absent: true,
                database_temp_absent: true
              }]
            };
          }
          if (text.includes("role_exact")) {
            return { rows: [{ login_exact: true, role_exact: true }] };
          }
          return { rows: [] };
        },
        release() {}
      };
    }
    async end() {}
  }
  const result = await verifyProvisionedLoginCredentials(
    VerificationPool,
    configuration
  );
  assert.deepEqual(result, { safe: true, verified: 2 });
  assert.equal(poolConfigs.length, 2);
  assert.equal(
    new URL(poolConfigs[0].connectionString).username,
    TARGET.migrationLogin
  );
  assert.equal(
    new URL(poolConfigs[1].connectionString).username,
    TARGET.runtimeLogin
  );
  assert.equal(JSON.stringify(result).includes(MIGRATION_PASSWORD), false);
  assert.equal(JSON.stringify(result).includes(RUNTIME_PASSWORD), false);
});

test("credential verification fails closed and redacts driver details", async () => {
  const configuration = loadLoginBootstrapConfig(environment());
  class RefusingPool {
    async connect() {
      throw new Error(`driver failure ${RUNTIME_PASSWORD}`);
    }
    async end() {}
  }
  await assert.rejects(
    verifyProvisionedLoginCredentials(RefusingPool, configuration),
    (error) =>
      error?.code === "login_bootstrap_credential_verification_failed" &&
      !String(error.message).includes(RUNTIME_PASSWORD) &&
      error.cause === undefined
  );
});

test("operator script refuses argv and only emits boolean state plus error code", async () => {
  let stdout = "";
  let stderr = "";
  const status = await main({
    env: environment(),
    argv: ["--password", RUNTIME_PASSWORD],
    PoolClass: class ForbiddenPool {
      constructor() {
        throw new Error("must not be created");
      }
    },
    stdout: { write(value) { stdout += value; } },
    stderr: { write(value) { stderr += value; } }
  });
  assert.equal(status, 2);
  assert.equal(stdout, "");
  assert.match(stderr, /login_bootstrap_argv_refused/);
  assert.equal(stderr.includes(RUNTIME_PASSWORD), false);
});

test("bootstrap stays outside the web process and source contains no embedded credentials", () => {
  const serverSource = fs.readFileSync(
    path.join(root, "server.js"),
    "utf8"
  );
  const scriptSource = fs.readFileSync(
    path.join(root, "scripts", "social-db-bootstrap-logins.js"),
    "utf8"
  );
  const moduleSource = fs.readFileSync(
    path.join(
      root,
      "src",
      "persistence",
      "postgres",
      "login-bootstrap.js"
    ),
    "utf8"
  );
  assert.doesNotMatch(serverSource, /social-db-bootstrap-logins|login-bootstrap/);
  assert.doesNotMatch(
    `${scriptSource}\n${moduleSource}`,
    new RegExp(
      [
        PROVISIONER_PASSWORD,
        MIGRATION_PASSWORD,
        RUNTIME_PASSWORD
      ]
        .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("|")
    )
  );
  assert.match(scriptSource, /process\.argv\.slice\(2\)/);
  assert.doesNotMatch(scriptSource, /process\.argv\[[23]\]/);
});
