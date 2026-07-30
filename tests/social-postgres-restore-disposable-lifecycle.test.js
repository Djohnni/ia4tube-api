"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  BLOCKED_RESTORE_LABEL,
  DISPOSABLE_DATABASE_PATTERN
} = require("../src/persistence/postgres/backup-restore");
const {
  PAID_STAGING_PUBLIC_TARGET
} = require("../src/persistence/postgres/staging-provisioner");
const {
  RESTORE_CREATE_APPROVAL_PREFIX,
  RESTORE_DISPOSABLE_DATABASE_NAME,
  RESTORE_DROP_APPROVAL_PREFIX,
  RESTORE_TOPOLOGY_MUTATIONS,
  createDisposableDatabase,
  disposableDatabaseLifecycleMarker,
  disposableDatabaseTargetFingerprint,
  dropDisposableDatabase,
  loadDisposableDatabaseLifecycleConfig
} = require(
  "../src/persistence/postgres/disposable-database-lifecycle"
);
const {
  main
} = require("../scripts/social-db-disposable-lifecycle");

const PASSWORD =
  "Synthetic-Restore-Provisioner-Password-2026!";

function provisionerUrl(overrides = {}) {
  const target = {
    host: PAID_STAGING_PUBLIC_TARGET.host,
    port: PAID_STAGING_PUBLIC_TARGET.port,
    database: PAID_STAGING_PUBLIC_TARGET.database,
    login: PAID_STAGING_PUBLIC_TARGET.provisionerLogin,
    sslmode: "verify-full",
    ...overrides
  };
  return (
    `postgresql://${target.login}:${PASSWORD}@` +
    `${target.host}:${target.port}/${target.database}` +
    `?sslmode=${target.sslmode}`
  );
}

function environment(action = "create", overrides = {}) {
  const fingerprint = disposableDatabaseTargetFingerprint(
    RESTORE_DISPOSABLE_DATABASE_NAME
  );
  const prefix =
    action === "create"
      ? RESTORE_CREATE_APPROVAL_PREFIX
      : RESTORE_DROP_APPROVAL_PREFIX;
  return {
    SOCIAL_STAGING_DISPOSABLE_DATABASE_ACTION: action,
    SOCIAL_STAGING_DISPOSABLE_DATABASE_APPROVED:
      `${prefix}${PAID_STAGING_PUBLIC_TARGET.environmentId}:` +
      fingerprint,
    SOCIAL_STAGING_DISPOSABLE_PROVISIONER_DATABASE_URL:
      provisionerUrl(),
    SOCIAL_STAGING_DISPOSABLE_EXPECTED_ENVIRONMENT_ID:
      PAID_STAGING_PUBLIC_TARGET.environmentId,
    SOCIAL_STAGING_DISPOSABLE_EXPECTED_HOST:
      PAID_STAGING_PUBLIC_TARGET.host,
    SOCIAL_STAGING_DISPOSABLE_EXPECTED_PORT:
      PAID_STAGING_PUBLIC_TARGET.port,
    SOCIAL_STAGING_DISPOSABLE_EXPECTED_PARENT_DATABASE:
      PAID_STAGING_PUBLIC_TARGET.database,
    SOCIAL_STAGING_DISPOSABLE_EXPECTED_DATABASE:
      RESTORE_DISPOSABLE_DATABASE_NAME,
    SOCIAL_STAGING_DISPOSABLE_EXPECTED_PROVISIONER_LOGIN:
      PAID_STAGING_PUBLIC_TARGET.provisionerLogin,
    SOCIAL_STAGING_DISPOSABLE_EXPECTED_TARGET_FINGERPRINT:
      fingerprint,
    ...overrides
  };
}

function identity(database, overrides = {}) {
  return {
    database_name: database,
    current_user_name: PAID_STAGING_PUBLIC_TARGET.provisionerLogin,
    session_user_name: PAID_STAGING_PUBLIC_TARGET.provisionerLogin,
    version_num: 180001,
    read_only: "off",
    datistemplate: false,
    datallowconn: true,
    database_owner: PAID_STAGING_PUBLIC_TARGET.provisionerLogin,
    provisioner_canlogin: true,
    provisioner_superuser: false,
    provisioner_createdb: true,
    provisioner_createrole: true,
    provisioner_replication: false,
    provisioner_bypassrls: false,
    ...overrides
  };
}

function safeInfrastructure(overrides = {}) {
  return {
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

function safeRestoreTopology(overrides = {}) {
  return {
    database_exact: true,
    provisioner_exact: true,
    owner_exact: true,
    non_owner_database_acl_exact: true,
    public_database_acl_absent: true,
    owner_create_present: true,
    migration_database_acl_exact: true,
    runtime_database_acl_exact: true,
    application_schemas_absent: true,
    public_schema_create_absent: true,
    ...overrides
  };
}

function fakeLifecycle(options = {}) {
  let exists = options.exists === true;
  let marked = options.marked !== false;
  const parentQueries = [];
  const disposableQueries = [];
  let disposablePoolEnded = false;

  async function permanentLoginQuery(sql, values) {
    if (sql.includes("ia4tube_social_login_bootstrap_infrastructure")) {
      return {
        rowCount: 1,
        rows: [safeInfrastructure(options.infrastructure)]
      };
    }
    if (sql.includes("ia4tube_social_login_bootstrap_login")) {
      assert.ok(
        [
          PAID_STAGING_PUBLIC_TARGET.migrationLogin,
          PAID_STAGING_PUBLIC_TARGET.runtimeLogin
        ].includes(values[0])
      );
      return {
        rowCount: 1,
        rows: [safeLogin(options.login)]
      };
    }
    return null;
  }

  const parentClient = {
    async query(text, values = []) {
      const sql = String(text);
      parentQueries.push({ sql, values });
      const permanent = await permanentLoginQuery(sql, values);
      if (permanent) return permanent;
      if (sql.includes("server_version_num")) {
        return {
          rowCount: 1,
          rows: [
            identity(
              PAID_STAGING_PUBLIC_TARGET.database,
              options.parentIdentity
            )
          ]
        };
      }
      if (sql.includes("pg_encoding_to_char")) {
        assert.deepEqual(values, [RESTORE_DISPOSABLE_DATABASE_NAME]);
        if (!exists) return { rowCount: 0, rows: [] };
        return {
          rowCount: 1,
          rows: [{
            database_name: RESTORE_DISPOSABLE_DATABASE_NAME,
            database_owner:
              PAID_STAGING_PUBLIC_TARGET.provisionerLogin,
            database_encoding: "UTF8",
            datistemplate: false,
            datallowconn: true,
            lifecycle_marker: marked
              ? disposableDatabaseLifecycleMarker(
                  RESTORE_DISPOSABLE_DATABASE_NAME
                )
              : null,
            ...options.catalogIdentity
          }]
        };
      }
      if (sql.startsWith("CREATE DATABASE")) {
        exists = true;
        marked = false;
        return { rowCount: null, rows: [] };
      }
      if (sql.startsWith("COMMENT ON DATABASE")) {
        marked = true;
        return { rowCount: null, rows: [] };
      }
      if (sql.includes("pg_terminate_backend")) {
        assert.deepEqual(values, [RESTORE_DISPOSABLE_DATABASE_NAME]);
        return { rowCount: 0, rows: [] };
      }
      if (sql.startsWith("DROP DATABASE")) {
        exists = false;
        return { rowCount: null, rows: [] };
      }
      throw new Error("unexpected_parent_query");
    },
    release() {}
  };

  const disposableClient = {
    async query(text, values = []) {
      const sql = String(text);
      disposableQueries.push({ sql, values });
      const permanent = await permanentLoginQuery(sql, values);
      if (permanent) return permanent;
      if (sql.includes("server_version_num")) {
        return {
          rowCount: 1,
          rows: [
            identity(
              RESTORE_DISPOSABLE_DATABASE_NAME,
              options.disposableIdentity
            )
          ]
        };
      }
      if (
        sql.includes("non_owner_database_acl_exact") &&
        sql.includes("application_schemas_absent")
      ) {
        return {
          rowCount: 1,
          rows: [safeRestoreTopology(options.restoreTopology)]
        };
      }
      if (
        ["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) ||
        RESTORE_TOPOLOGY_MUTATIONS.includes(sql)
      ) {
        return { rowCount: null, rows: [] };
      }
      throw new Error("unexpected_disposable_query");
    },
    release() {}
  };

  return {
    parentPool: {
      async connect() {
        return parentClient;
      },
      async end() {}
    },
    disposablePool: {
      async connect() {
        return disposableClient;
      },
      async end() {
        disposablePoolEnded = true;
      }
    },
    parentQueries,
    disposableQueries,
    get exists() {
      return exists;
    },
    get disposablePoolEnded() {
      return disposablePoolEnded;
    }
  };
}

test("restore target is fixed, accepted by restore guard and separately approved", () => {
  assert.match(
    RESTORE_DISPOSABLE_DATABASE_NAME,
    /^ia4tube_social_disposable_restore_20260729$/
  );
  assert.equal(
    DISPOSABLE_DATABASE_PATTERN.test(
      RESTORE_DISPOSABLE_DATABASE_NAME
    ),
    true
  );
  assert.equal(
    BLOCKED_RESTORE_LABEL.test(
      RESTORE_DISPOSABLE_DATABASE_NAME
    ),
    false
  );
  const config =
    loadDisposableDatabaseLifecycleConfig(environment("create"));
  assert.equal(config.purpose, "backup-restore");
  assert.equal(config.restoreTopology, true);
  assert.equal(
    config.target.disposableDatabase,
    RESTORE_DISPOSABLE_DATABASE_NAME
  );
  assert.deepEqual(config.permanentLogins, {
    migrationLogin: PAID_STAGING_PUBLIC_TARGET.migrationLogin,
    runtimeLogin: PAID_STAGING_PUBLIC_TARGET.runtimeLogin
  });
  assert.notEqual(
    disposableDatabaseTargetFingerprint(
      RESTORE_DISPOSABLE_DATABASE_NAME
    ),
    disposableDatabaseTargetFingerprint()
  );
  assert.notEqual(
    disposableDatabaseLifecycleMarker(
      RESTORE_DISPOSABLE_DATABASE_NAME
    ),
    disposableDatabaseLifecycleMarker()
  );
  assert.equal(JSON.stringify(config).includes(PASSWORD), false);
});

test("restore approvals cannot be swapped with gate or opposite action", () => {
  const gateFingerprint = disposableDatabaseTargetFingerprint();
  assert.throws(
    () =>
      loadDisposableDatabaseLifecycleConfig(
        environment("create", {
          SOCIAL_STAGING_DISPOSABLE_DATABASE_APPROVED:
            `CREATE_SOCIAL_POSTGRES_DISPOSABLE:` +
            `${PAID_STAGING_PUBLIC_TARGET.environmentId}:` +
            gateFingerprint
        })
      ),
    { code: "staging_disposable_approval_invalid" }
  );
  assert.throws(
    () =>
      loadDisposableDatabaseLifecycleConfig(
        environment("create", {
          SOCIAL_STAGING_DISPOSABLE_DATABASE_APPROVED:
            environment("drop")
              .SOCIAL_STAGING_DISPOSABLE_DATABASE_APPROVED
        })
      ),
    { code: "staging_disposable_approval_invalid" }
  );
  for (const database of [
    "__proto__",
    "constructor",
    `${RESTORE_DISPOSABLE_DATABASE_NAME}_other`
  ]) {
    assert.throws(
      () =>
        loadDisposableDatabaseLifecycleConfig(
          environment("create", {
            SOCIAL_STAGING_DISPOSABLE_EXPECTED_DATABASE: database
          })
        ),
      { code: "staging_disposable_expected_target_mismatch" }
    );
  }
});

test("create prepares only the exact minimal restore topology", async () => {
  const config =
    loadDisposableDatabaseLifecycleConfig(environment("create"));
  const fake = fakeLifecycle({ exists: false });
  const result = await createDisposableDatabase(
    fake.parentPool,
    fake.disposablePool,
    config
  );
  assert.deepEqual(result, {
    safe: true,
    created: true,
    identityVerified: true,
    restoreTopologyPrepared: true
  });
  assert.equal(fake.exists, true);
  const mutations = fake.disposableQueries
    .map(({ sql }) => sql)
    .filter((sql) => RESTORE_TOPOLOGY_MUTATIONS.includes(sql));
  assert.deepEqual(mutations, [...RESTORE_TOPOLOGY_MUTATIONS]);
  assert.equal(
    fake.disposableQueries.some(({ sql }) =>
      /CREATE\s+SCHEMA|CREATE\s+TABLE|roles\.sql/i.test(sql)
    ),
    false
  );
  assert.equal(
    fake.parentQueries.filter(({ sql }) =>
      sql.startsWith("CREATE DATABASE")
    ).length,
    1
  );
  assert.match(
    fake.parentQueries.find(({ sql }) =>
      sql.startsWith("CREATE DATABASE")
    ).sql,
    new RegExp(`"${RESTORE_DISPOSABLE_DATABASE_NAME}"`)
  );
});

test("unsafe permanent principals are refused before CREATE DATABASE", async () => {
  const config =
    loadDisposableDatabaseLifecycleConfig(environment("create"));
  const fake = fakeLifecycle({
    exists: false,
    infrastructure: { nologin_roles_exact: false }
  });
  await assert.rejects(
    createDisposableDatabase(
      fake.parentPool,
      fake.disposablePool,
      config
    ),
    { code: "staging_disposable_create_failed" }
  );
  assert.equal(
    fake.parentQueries.some(({ sql }) =>
      sql.startsWith("CREATE DATABASE")
    ),
    false
  );
});

test("topology drift rolls back without deleting or touching another database", async () => {
  const config =
    loadDisposableDatabaseLifecycleConfig(environment("create"));
  const fake = fakeLifecycle({
    exists: false,
    restoreTopology: { runtime_database_acl_exact: false }
  });
  await assert.rejects(
    createDisposableDatabase(
      fake.parentPool,
      fake.disposablePool,
      config
    ),
    { code: "staging_disposable_restore_topology_invalid" }
  );
  assert.equal(fake.exists, true);
  const topologyStatements = fake.disposableQueries.map(
    ({ sql }) => sql
  );
  assert.ok(topologyStatements.includes("BEGIN"));
  assert.ok(topologyStatements.includes("ROLLBACK"));
  assert.equal(topologyStatements.includes("COMMIT"), false);
  assert.equal(
    fake.parentQueries.some(({ sql }) =>
      sql.startsWith("DROP DATABASE")
    ),
    false
  );
});

test("drop accepts only the restore marker and proves exact absence", async () => {
  const config =
    loadDisposableDatabaseLifecycleConfig(environment("drop"));
  const fake = fakeLifecycle({ exists: true });
  const result = await dropDisposableDatabase(
    fake.parentPool,
    fake.disposablePool,
    config
  );
  assert.equal(result.safe, true);
  assert.equal(result.dropped, true);
  assert.equal(result.absenceConfirmed, true);
  assert.equal(fake.exists, false);
  assert.equal(fake.disposablePoolEnded, true);
  const termination = fake.parentQueries.find(({ sql }) =>
    sql.includes("pg_terminate_backend")
  );
  assert.deepEqual(
    termination.values,
    [RESTORE_DISPOSABLE_DATABASE_NAME]
  );
  assert.equal(
    fake.parentQueries.find(({ sql }) =>
      sql.startsWith("DROP DATABASE")
    ).sql,
    `DROP DATABASE "${RESTORE_DISPOSABLE_DATABASE_NAME}" ` +
      "WITH (FORCE)"
  );
});

test("operator output confirms restore topology without exposing credentials", async () => {
  const fake = fakeLifecycle({ exists: false });
  let stdout = "";
  let stderr = "";
  class FakePool {
    constructor(options) {
      this.delegate =
        options.application_name ===
        "ia4tube-social-disposable-parent"
          ? fake.parentPool
          : fake.disposablePool;
    }
    async connect() {
      return this.delegate.connect();
    }
    async end() {
      return this.delegate.end();
    }
  }
  const status = await main({
    env: environment("create"),
    argv: [],
    PoolClass: FakePool,
    stdout: { write(value) { stdout += value; } },
    stderr: { write(value) { stderr += value; } }
  });
  assert.equal(status, 0);
  assert.equal(stderr, "");
  assert.equal(stdout.includes(PASSWORD), false);
  assert.deepEqual(JSON.parse(stdout), {
    ok: true,
    safe: true,
    created: true,
    dropped: false,
    identityVerified: true,
    sessionsTerminated: false,
    absenceConfirmed: false,
    restoreTopologyPrepared: true
  });
});
