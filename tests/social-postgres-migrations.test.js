"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  databaseTargetFingerprint,
  loadMigrationPostgresConfig
} = require("../src/persistence/postgres/config");
const {
  ADVISORY_LOCK_ID,
  APPLY_APPROVAL,
  GLOBAL_VAULT_BACKFILL_POLICY,
  GLOBAL_VAULT_BACKFILL_POLICY_CREATE,
  GLOBAL_VAULT_BACKFILL_POLICY_DROP,
  GLOBAL_VAULT_REGISTRY_MIGRATION,
  LEDGER_NAME,
  PRODUCTION_APPROVAL,
  assertApplyTarget,
  assertNonDestructiveSql,
  compareMigrationState,
  createMigrationRunner,
  readManifest,
  sha256,
  targetFingerprint,
  verifyMigrationInfrastructure,
  verifyMigrationSession,
  verifyTargetMarker
} = require("../src/persistence/postgres/migrations");

const root = path.resolve(__dirname, "..");
const environmentId = "77777777-7777-4777-8777-777777777777";
const baseTarget = Object.freeze({
  environment: "test",
  environmentId,
  approval: APPLY_APPROVAL,
  productionApproval: "",
  host: "localhost",
  port: "55432",
  database: "ia4tube_social_test",
  username: "synthetic_migrator"
});

function safePrincipalAccess(overrides = {}) {
  return {
    owns_database: false,
    database_create: false,
    owns_schema: false,
    schema_create: false,
    owns_relation: false,
    owns_function: false,
    owns_type: false,
    table_truncate: false,
    ...overrides
  };
}

function migrationPool(options = {}) {
  const state = {
    ledgerExists: Boolean(options.ledgerExists),
    applied: [...(options.applied || [])],
    queries: [],
    released: false,
    releaseErrors: [],
    connected: 0,
    lockOwner: null,
    lockQueue: [],
    lockWaits: 0,
    activeLocks: 0,
    maxActiveLocks: 0
  };

  function safeRoleRow() {
    return {
      postgres_version_supported: true,
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false,
      rolbypassrls: false,
      migrator_canlogin: false,
      migrator_superuser: false,
      migrator_replication: false,
      migrator_bypassrls: false,
      owner_canlogin: false,
      owner_superuser: false,
      owner_replication: false,
      owner_bypassrls: false,
      database_owner_safe: true,
      login_is_separate: true,
      direct_connect_exact: true,
      public_database_acl_absent: true,
      database_temp_absent: true,
      can_migrate: true,
      direct_owner_membership: false,
      migrator_members_exact: true,
      owner_members_exact: true,
      ...(options.roleRow || {})
    };
  }

  const safeSchemaAcl = Object.freeze({
    grantee: "ia4tube_social_migrator",
    privilege_type: "USAGE",
    is_grantable: false,
    grantor_name: "ia4tube_social_owner"
  });
  const safeMarkerAcl = Object.freeze({
    grantee: "ia4tube_social_migrator",
    privilege_type: "SELECT",
    is_grantable: false,
    grantor_name: "ia4tube_social_owner"
  });
  const safeLedgerAcl = Object.freeze([
    {
      grantee: "ia4tube_social_migrator",
      privilege_type: "INSERT",
      is_grantable: false,
      grantor_name: "ia4tube_social_owner"
    },
    {
      grantee: "ia4tube_social_migrator",
      privilege_type: "SELECT",
      is_grantable: false,
      grantor_name: "ia4tube_social_owner"
    }
  ]);

  function createClient() {
    const clientId = ++state.connected;
    let transaction = null;
    return {
      async query(text, values = []) {
        state.queries.push({ clientId, text, values });
        if (
          (typeof options.failOn === "string" &&
            text.includes(options.failOn)) ||
          (typeof options.failOn === "function" &&
            options.failOn(text, values))
        ) {
          throw new Error("synthetic migration failure");
        }
        if (text === "BEGIN") {
          transaction = { ledgerRows: [] };
          return { rows: [] };
        }
        if (text === "COMMIT") {
          if (transaction) state.applied.push(...transaction.ledgerRows);
          transaction = null;
          return { rows: [] };
        }
        if (text === "ROLLBACK") {
          if (options.rollbackFails) {
            const failure = new Error("synthetic rollback failure");
            failure.code = "synthetic_rollback_failure";
            throw failure;
          }
          transaction = null;
          return { rows: [] };
        }
        if (text.includes("FROM pg_catalog.pg_roles login")) {
          return { rows: options.missingRoles ? [] : [safeRoleRow()] };
        }
        if (text.includes("AS owns_database")) {
          return {
            rows: [
              safePrincipalAccess({
                owns_relation: Boolean(options.ownsSchemaObject),
                ...(options.principalAccess || {})
              })
            ]
          };
        }
        if (text.includes("AS schema_owner_name")) {
          return {
            rows: options.migrationSchema
              ? [options.migrationSchema]
              : [
                  {
                    schema_owner_name: "ia4tube_social_owner",
                    routine_count: 0
                  }
                ]
          };
        }
        if (
          text.includes("FROM pg_catalog.pg_namespace namespace") &&
          text.includes("expanded_acl") &&
          text.includes("ia4tube_migrations")
        ) {
          return {
            rows:
              options.migrationSchemaAcl === undefined
                ? [{ ...safeSchemaAcl }]
                : options.migrationSchemaAcl
          };
        }
        if (text.includes("AS marker_kind")) {
          return {
            rows: options.environmentMarkerStructure
              ? [options.environmentMarkerStructure]
              : [
                  {
                    marker_kind: "r",
                    marker_owner_name: "ia4tube_social_owner"
                  }
                ]
          };
        }
        if (
          text.includes("relation.relname = 'environment_identity'") &&
          text.includes("pg_catalog.pg_attribute")
        ) {
          return {
            rows: options.environmentMarkerColumnAcl || []
          };
        }
        if (
          text.includes("relation.relname = 'environment_identity'") &&
          text.includes("expanded_acl")
        ) {
          return {
            rows:
              options.environmentMarkerAcl === undefined
                ? [{ ...safeMarkerAcl }]
                : options.environmentMarkerAcl
          };
        }
        if (text.includes("FROM ia4tube_migrations.environment_identity")) {
          if (options.missingEnvironmentMarker) return { rows: [] };
          return {
            rows: [
              {
                environment_id: options.environmentId || environmentId,
                environment_name: options.environmentName || "test"
              }
            ]
          };
        }
        if (
          text.includes(
            "CREATE TABLE IF NOT EXISTS ia4tube_migrations.schema_migrations"
          )
        ) {
          state.ledgerExists = true;
        }
        if (text.includes("AS owned") && text.includes("column_count")) {
          return {
            rows: [
              options.ledgerStructure || {
                owned: true,
                column_count_valid: true,
                columns_valid: true,
                primary_key_valid: true,
                migrator_select: true,
                migrator_insert: true,
                migrator_update: false,
                migrator_delete: false
              }
            ]
          };
        }
        if (
          text.includes("relation.relname = 'schema_migrations'") &&
          text.includes("pg_catalog.pg_attribute")
        ) {
          return { rows: options.ledgerColumnAcl || [] };
        }
        if (
          text.includes("relation.relname = 'schema_migrations'") &&
          text.includes("expanded_acl")
        ) {
          return {
            rows:
              options.ledgerAcl === undefined
                ? safeLedgerAcl.map((entry) => ({ ...entry }))
                : options.ledgerAcl
          };
        }
        if (text.startsWith("SELECT to_regclass")) {
          return { rows: [{ exists: state.ledgerExists }] };
        }
        if (
          text.includes("FROM ia4tube_migrations.schema_migrations") &&
          text.includes("ORDER BY version")
        ) {
          return { rows: state.applied.map((row) => ({ ...row })) };
        }
        if (
          text.includes("INSERT INTO ia4tube_migrations.schema_migrations")
        ) {
          const row = {
            version: values[0],
            checksum_sha256: values[1],
            execution_ms: values[2]
          };
          if (transaction) transaction.ledgerRows.push(row);
          else state.applied.push(row);
          return { rows: [] };
        }
        if (text.includes("pg_advisory_lock")) {
          if (state.lockOwner === null) {
            state.lockOwner = clientId;
            state.activeLocks += 1;
            state.maxActiveLocks = Math.max(
              state.maxActiveLocks,
              state.activeLocks
            );
          } else {
            state.lockWaits += 1;
            await new Promise((resolve) => {
              state.lockQueue.push({ clientId, resolve });
            });
          }
          return { rows: [{ pg_advisory_lock: null }] };
        }
        if (text.includes("pg_advisory_unlock")) {
          if (options.unlockThrows) {
            throw new Error("synthetic unlock failure");
          }
          const unlocked =
            options.unlockValue === undefined
              ? state.lockOwner === clientId
              : options.unlockValue;
          if (unlocked) {
            const next = state.lockQueue.shift();
            if (next) {
              state.lockOwner = next.clientId;
              next.resolve();
            } else {
              state.lockOwner = null;
              state.activeLocks -= 1;
            }
          }
          return { rows: [{ unlocked }] };
        }
        if (
          options.migrationDelayMs &&
          text.includes("CREATE SCHEMA ia4tube_social")
        ) {
          await new Promise((resolve) =>
            setTimeout(resolve, options.migrationDelayMs)
          );
        }
        return { rows: [] };
      },
      release(error) {
        state.released = true;
        state.releaseErrors.push(error);
        state.releaseError = error;
      }
    };
  }

  return {
    state,
    pool: {
      async connect() {
        return createClient();
      }
    }
  };
}

function runnerFor(harness, target = baseTarget) {
  return createMigrationRunner({
    pool: harness.pool,
    ownerRole: "ia4tube_social_owner",
    migratorRole: "ia4tube_social_migrator",
    target
  });
}

test("manifest freezes ordered LF-only migration checksums", () => {
  const migrations = readManifest({ root });
  assert.deepEqual(
    migrations.map((item) => item.version),
    [
      "0001_social_multitenant_foundation",
      "0002_social_connections_and_vault",
      "0003_global_vault_key_registry"
    ]
  );
  for (const migration of migrations) {
    assert.match(migration.sha256, /^[0-9a-f]{64}$/);
    assert.equal(migration.sql.includes("\r"), false);
    assert.equal(migration.sql.endsWith("\n"), true);
  }
});

test("manifest refuses an altered migration checksum", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "ia4tube-social-migrations-")
  );
  try {
    const file = "0001_synthetic.up.sql";
    fs.writeFileSync(path.join(directory, file), "SELECT 1;\n");
    fs.writeFileSync(
      path.join(directory, "checksums.json"),
      JSON.stringify({
        format: 1,
        migrations: [
          {
            version: "0001_synthetic",
            file,
            sha256: "0".repeat(64)
          }
        ]
      })
    );
    assert.throws(
      () =>
        readManifest({
          migrationsDirectory: directory,
          manifestPath: path.join(directory, "checksums.json")
        }),
      { code: "migration_checksum_mismatch" }
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("migration scanner refuses destructive statements", () => {
  for (const sql of [
    "DROP TABLE synthetic;\n",
    "TRUNCATE synthetic;\n",
    "DELETE FROM synthetic;\n",
    "ALTER TABLE synthetic DROP COLUMN value;\n",
    "DROP SCHEMA synthetic CASCADE;\n"
  ]) {
    assert.throws(
      () => assertNonDestructiveSql(sql, "0003_synthetic"),
      { code: "destructive_migration_refused" }
    );
  }
  assert.doesNotThrow(() =>
    assertNonDestructiveSql(
      "CREATE TABLE synthetic (id UUID PRIMARY KEY);\n",
      "0003_synthetic"
    )
  );
});

test("ledger comparison refuses unknown or modified applied migrations", () => {
  const local = [
    { version: "0001_synthetic", sha256: "a".repeat(64) },
    { version: "0002_synthetic", sha256: "b".repeat(64) }
  ];
  assert.throws(
    () =>
      compareMigrationState(local, [
        { version: "9999_unknown", checksum_sha256: "a".repeat(64) }
      ]),
    { code: "unknown_applied_migration" }
  );
  assert.throws(
    () =>
      compareMigrationState(local, [
        { version: "0001_synthetic", checksum_sha256: "c".repeat(64) }
      ]),
    { code: "applied_migration_checksum_mismatch" }
  );
  for (const applied of [
    [
      {
        version: "0002_synthetic",
        checksum_sha256: "b".repeat(64)
      }
    ],
    [
      {
        version: "0002_synthetic",
        checksum_sha256: "b".repeat(64)
      },
      {
        version: "0001_synthetic",
        checksum_sha256: "a".repeat(64)
      }
    ]
  ]) {
    assert.throws(
      () => compareMigrationState(local, applied),
      { code: "migration_ledger_order_invalid" }
    );
  }
});

test("apply requires approval and exact non-secret target fingerprint", () => {
  const target = {
    environment: "staging",
    environmentId,
    approval: APPLY_APPROVAL,
    productionApproval: "",
    host: "db-staging.example.test",
    port: "5432",
    database: "ia4tube_staging",
    username: "staging_migrator"
  };
  assert.throws(
    () => assertApplyTarget(target, {}),
    { code: "migration_target_not_verified" }
  );
  assert.doesNotThrow(() =>
    assertApplyTarget(target, {
      SOCIAL_MIGRATION_TARGET_FINGERPRINT: targetFingerprint(target)
    })
  );
  assert.throws(
    () =>
      assertApplyTarget(
        { ...target, environment: "production" },
        {
          SOCIAL_MIGRATION_TARGET_FINGERPRINT: targetFingerprint({
            ...target,
            environment: "production"
          })
        }
      ),
    { code: "production_migration_not_approved" }
  );
  const productionTarget = {
    ...target,
    environment: "production",
    productionApproval: PRODUCTION_APPROVAL
  };
  assert.doesNotThrow(() =>
    assertApplyTarget(productionTarget, {
      SOCIAL_MIGRATION_TARGET_FINGERPRINT:
        targetFingerprint(productionTarget)
    })
  );

  for (const changed of [
    { ...target, environment: "test" },
    {
      ...target,
      environmentId: "88888888-8888-4888-8888-888888888888"
    },
    { ...target, port: "6432" },
    { ...target, username: "other_migrator" }
  ]) {
    assert.notEqual(targetFingerprint(changed), targetFingerprint(target));
    assert.throws(
      () =>
        assertApplyTarget(changed, {
          SOCIAL_MIGRATION_TARGET_FINGERPRINT: targetFingerprint(target)
        }),
      { code: "migration_target_not_verified" }
    );
  }
});

test("migration job accepts public runtime identity without runtime URL", () => {
  const databaseUrl =
    "postgresql://synthetic_migrator:two@db.example.test/social";
  const common = {
    SOCIAL_MIGRATION_ENVIRONMENT: "test",
    SOCIAL_MIGRATION_EXPECTED_ENVIRONMENT_ID: environmentId,
    SOCIAL_DATABASE_EXPECTED_RUNTIME_LOGIN: "synthetic_runtime",
    SOCIAL_MIGRATIONS_EXPECTED_LOGIN: "synthetic_migrator",
    SOCIAL_DATABASE_EXPECTED_TARGET_FINGERPRINT:
      databaseTargetFingerprint(new URL(databaseUrl))
  };
  assert.throws(
    () =>
      loadMigrationPostgresConfig({
        ...common,
        SOCIAL_MIGRATIONS_DATABASE_URL: databaseUrl,
        SOCIAL_DATABASE_EXPECTED_RUNTIME_LOGIN: "synthetic_migrator"
      }),
    { code: "migration_runtime_credentials_must_differ" }
  );

  const separated = loadMigrationPostgresConfig({
    ...common,
    SOCIAL_MIGRATIONS_DATABASE_URL:
      "postgresql://synthetic_migrator:two@DB.EXAMPLE.test/social",
    SOCIAL_DATABASE_MIGRATOR_ROLE: "ia4tube_social_migrator",
    SOCIAL_DATABASE_OWNER_ROLE: "ia4tube_social_owner"
  });
  assert.equal(separated.target.username, "synthetic_migrator");
  assert.equal(separated.target.port, "5432");
  assert.equal(separated.migratorRole, "ia4tube_social_migrator");
  assert.equal(separated.ownerRole, "ia4tube_social_owner");
});

test("migration configuration refuses non-canonical role names", () => {
  const databaseUrl =
    "postgresql://synthetic_migrator:two@db.example.test/social";
  const common = {
    SOCIAL_MIGRATION_ENVIRONMENT: "test",
    SOCIAL_MIGRATION_EXPECTED_ENVIRONMENT_ID: environmentId,
    SOCIAL_DATABASE_EXPECTED_RUNTIME_LOGIN: "synthetic_runtime",
    SOCIAL_MIGRATIONS_EXPECTED_LOGIN: "synthetic_migrator",
    SOCIAL_DATABASE_EXPECTED_TARGET_FINGERPRINT:
      databaseTargetFingerprint(new URL(databaseUrl)),
    SOCIAL_MIGRATIONS_DATABASE_URL: databaseUrl
  };
  for (const override of [
    { SOCIAL_DATABASE_MIGRATOR_ROLE: "alternate_migrator" },
    { SOCIAL_DATABASE_OWNER_ROLE: "alternate_owner" }
  ]) {
    assert.throws(
      () => loadMigrationPostgresConfig({ ...common, ...override }),
      (error) =>
        error?.code ===
          "social_database_migrator_role_must_be_canonical" ||
        error?.code === "social_database_owner_role_must_be_canonical"
    );
  }
});

test("persistent environment marker is mandatory and exact", async () => {
  for (const options of [
    { missingEnvironmentMarker: true },
    { environmentName: "staging" },
    {
      environmentId: "99999999-9999-4999-8999-999999999999"
    }
  ]) {
    const harness = migrationPool(options);
    await assert.rejects(
      runnerFor(harness).validate(),
      { code: "migration_environment_marker_mismatch" }
    );
    const markerQuery = harness.state.queries.find((query) =>
      query.text.includes(
        "FROM ia4tube_migrations.environment_identity"
      )
    );
    assert.ok(markerQuery);
    assert.match(markerQuery.text, /WHERE singleton = TRUE/);
    assert.equal(harness.state.released, true);
  }

  const harness = migrationPool();
  const client = await harness.pool.connect();
  await assert.doesNotReject(
    verifyTargetMarker(
      client,
      "ia4tube_social_migrator",
      baseTarget
    )
  );
  assert.ok(
    harness.state.queries.some(
      (query) =>
        query.text ===
        'SET LOCAL ROLE "ia4tube_social_migrator"'
    )
  );
});

test("migration infrastructure requires exact owners, ACLs and no routines", async () => {
  const safeHarness = migrationPool();
  const safeClient = await safeHarness.pool.connect();
  await assert.doesNotReject(
    verifyMigrationInfrastructure(
      safeClient,
      "ia4tube_social_migrator",
      "ia4tube_social_owner"
    )
  );

  for (const options of [
    {
      migrationSchema: {
        schema_owner_name: "unexpected_owner",
        routine_count: 0
      },
      expectedCode: "migration_infrastructure_owner_invalid"
    },
    {
      migrationSchema: {
        schema_owner_name: "ia4tube_social_owner",
        routine_count: 1
      },
      expectedCode: "migration_infrastructure_owner_invalid"
    },
    {
      migrationSchemaAcl: [],
      expectedCode: "migration_infrastructure_acl_invalid"
    },
    {
      migrationSchemaAcl: [
        {
          grantee: "ia4tube_social_migrator",
          privilege_type: "USAGE",
          is_grantable: true,
          grantor_name: "ia4tube_social_owner"
        }
      ],
      expectedCode: "migration_infrastructure_acl_invalid"
    },
    {
      environmentMarkerStructure: {
        marker_kind: "v",
        marker_owner_name: "ia4tube_social_owner"
      },
      expectedCode: "migration_environment_marker_structure_invalid"
    },
    {
      environmentMarkerStructure: {
        marker_kind: "r",
        marker_owner_name: "unexpected_owner"
      },
      expectedCode: "migration_environment_marker_structure_invalid"
    },
    {
      environmentMarkerAcl: [
        {
          grantee: "PUBLIC",
          privilege_type: "SELECT",
          is_grantable: false,
          grantor_name: "ia4tube_social_owner"
        }
      ],
      expectedCode: "migration_environment_marker_acl_invalid"
    },
    {
      environmentMarkerColumnAcl: [
        {
          column_name: "environment_id",
          grantee: "unexpected_reader",
          privilege_type: "SELECT",
          is_grantable: false,
          grantor_name: "ia4tube_social_owner"
        }
      ],
      expectedCode: "migration_environment_marker_acl_invalid"
    }
  ]) {
    const { expectedCode, ...harnessOptions } = options;
    const harness = migrationPool(harnessOptions);
    const client = await harness.pool.connect();
    await assert.rejects(
      verifyMigrationInfrastructure(
        client,
        "ia4tube_social_migrator",
        "ia4tube_social_owner"
      ),
      { code: expectedCode }
    );
  }
});

test("migration session validates session_user and safe role topology", async () => {
  const safeHarness = migrationPool();
  const safeClient = await safeHarness.pool.connect();
  await assert.doesNotReject(
    verifyMigrationSession(
      safeClient,
      "ia4tube_social_migrator",
      "ia4tube_social_owner"
    )
  );
  const roleQuery = safeHarness.state.queries.find((query) =>
    query.text.includes("FROM pg_catalog.pg_roles login")
  );
  assert.ok(roleQuery);
  assert.match(roleQuery.text, /session_user/);
  assert.match(roleQuery.text, /direct_owner_membership/);
  assert.match(roleQuery.text, /membership\.admin_option/);
  assert.match(roleQuery.text, /membership\.inherit_option/);
  assert.match(roleQuery.text, /membership\.set_option/);
  assert.match(roleQuery.text, /COUNT\(\*\) = 2/);
  assert.match(roleQuery.text, /grantor\.rolsuper/);
  assert.match(roleQuery.text, /database_info\.datdba/);

  for (const roleRow of [
    { postgres_version_supported: false },
    { rolsuper: true },
    { rolreplication: true },
    { rolbypassrls: true },
    { migrator_canlogin: true },
    { migrator_superuser: true },
    { migrator_replication: true },
    { owner_canlogin: true },
    { owner_replication: true },
    { owner_bypassrls: true },
    { database_owner_safe: false },
    { login_is_separate: false },
    { direct_connect_exact: false },
    { public_database_acl_absent: false },
    { database_temp_absent: false },
    { can_migrate: false },
    { direct_owner_membership: true },
    { migrator_members_exact: false },
    { owner_members_exact: false }
  ]) {
    const harness = migrationPool({ roleRow });
    const client = await harness.pool.connect();
    await assert.rejects(
      verifyMigrationSession(
        client,
        "ia4tube_social_migrator",
        "ia4tube_social_owner"
      ),
      { code: "migration_session_role_unsafe" }
    );
  }

  for (const principalAccess of [
    { owns_database: true },
    { database_create: true },
    { owns_schema: true },
    { schema_create: true },
    { owns_relation: true },
    { owns_function: true },
    { owns_type: true },
    { table_truncate: true }
  ]) {
    const ownerHarness = migrationPool({ principalAccess });
    const ownerClient = await ownerHarness.pool.connect();
    await assert.rejects(
      verifyMigrationSession(
        ownerClient,
        "ia4tube_social_migrator",
        "ia4tube_social_owner"
      ),
      { code: "migration_session_owns_schema_object" }
    );
  }
});

test("role bootstrap keeps owner and migrator non-login and separated", () => {
  const sql = fs.readFileSync(
    path.join(root, "db", "postgres", "roles.sql"),
    "utf8"
  );
  for (const role of [
    "ia4tube_social_owner",
    "ia4tube_social_migrator"
  ]) {
    assert.match(
      sql,
      new RegExp(
        `CREATE ROLE ${role}[\\s\\S]*?NOLOGIN[\\s\\S]*?NOSUPERUSER` +
          `[\\s\\S]*?NOCREATEDB[\\s\\S]*?NOCREATEROLE` +
          `[\\s\\S]*?NOINHERIT[\\s\\S]*?NOREPLICATION` +
          `[\\s\\S]*?NOBYPASSRLS;`
      )
    );
  }
  assert.match(
    sql,
    /GRANT ia4tube_social_owner TO ia4tube_social_migrator[\s\S]*?WITH ADMIN FALSE, INHERIT FALSE, SET TRUE/
  );
  assert.match(sql, /ia4tube_social_postgres_18_required/);
  assert.match(sql, /^BEGIN;/m);
  assert.match(sql, /SET LOCAL createrole_self_grant = ''/);
  assert.match(sql, /ia4tube_social_provisioner_invalid/);
  assert.match(sql, /membership\.admin_option/);
  assert.match(sql, /grantor\.rolsuper/);
  assert.match(
    sql,
    /GRANT ia4tube_social_owner TO CURRENT_USER[\s\S]*?SET TRUE[\s\S]*?GRANTED BY CURRENT_USER/
  );
  assert.match(sql, /SET LOCAL ROLE ia4tube_social_owner/);
  assert.match(
    sql,
    /REVOKE ia4tube_social_owner FROM CURRENT_USER[\s\S]*?GRANTED BY CURRENT_USER RESTRICT/
  );
  assert.match(sql, /ia4tube_social_temporary_membership_not_removed/);
  assert.match(sql, /COMMIT;\s*$/);
  assert.doesNotMatch(
    sql,
    /GRANT CONNECT ON DATABASE[\s\S]*?TO ia4tube_social_/
  );
  assert.match(sql, /CONNECT must be granted directly/);
  assert.doesNotMatch(
    sql,
    /GRANT ia4tube_social_owner TO ia4tube_social_runtime/
  );
  assert.match(
    sql,
    /CREATE SCHEMA IF NOT EXISTS ia4tube_migrations/
  );
  assert.match(
    sql,
    /CREATE TABLE IF NOT EXISTS ia4tube_migrations\.environment_identity/
  );
  assert.match(
    sql,
    /REVOKE ALL ON SCHEMA ia4tube_migrations FROM ia4tube_social_migrator/
  );
  assert.match(
    sql,
    /REVOKE ALL ON ia4tube_migrations\.environment_identity[\s\S]*?FROM ia4tube_social_migrator/
  );
});

test("migration runner refuses non-canonical roles even without env loading", () => {
  const harness = migrationPool();
  for (const roles of [
    {
      ownerRole: "unexpected_owner",
      migratorRole: "ia4tube_social_migrator"
    },
    {
      ownerRole: "ia4tube_social_owner",
      migratorRole: "unexpected_migrator"
    }
  ]) {
    assert.throws(
      () =>
        createMigrationRunner({
          pool: harness.pool,
          target: baseTarget,
          ...roles
        }),
      { code: "migration_roles_must_be_canonical" }
    );
  }
});

test("status and validate are read-only when the ledger is absent", async () => {
  const harness = migrationPool();
  const runner = runnerFor(harness);
  const result = await runner.validate();
  assert.equal(result.valid, true);
  assert.equal(result.applied, 0);
  assert.equal(result.pending, 3);
  assert.equal(
    harness.state.queries.some((query) =>
      /^(CREATE|INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE)\b/i.test(
        query.text.trimStart()
      )
    ),
    false
  );
  assert.equal(harness.state.released, true);
});

test("apply takes an advisory lock and records SQL plus checksum atomically", async () => {
  const target = baseTarget;
  const harness = migrationPool();
  const runner = runnerFor(harness, target);
  const applied = await runner.apply({
    SOCIAL_MIGRATION_TARGET_FINGERPRINT: targetFingerprint(target)
  });
  assert.equal(applied.length, 3);
  assert.deepEqual(
    harness.state.applied.map((row) => row.version),
    [
      "0001_social_multitenant_foundation",
      "0002_social_connections_and_vault",
      "0003_global_vault_key_registry"
    ]
  );
  const texts = harness.state.queries.map((query) => query.text);
  const lock = harness.state.queries.find((query) =>
    query.text.includes("pg_advisory_lock")
  );
  assert.equal(lock.values[0], ADVISORY_LOCK_ID);
  assert.ok(texts.some((text) => text.includes("CREATE SCHEMA ia4tube_social")));
  assert.ok(texts.some((text) => text.includes("COMMIT")));
  assert.ok(texts.at(-1).includes("pg_advisory_unlock"));
  assert.equal(LEDGER_NAME, "ia4tube_migrations.schema_migrations");
  assert.ok(
    texts.some((text) =>
      text.includes(
        "CREATE TABLE IF NOT EXISTS ia4tube_migrations.schema_migrations"
      )
    )
  );
  assert.ok(
    texts.some(
      (text) =>
        text.includes(
          "GRANT SELECT, INSERT ON ia4tube_migrations.schema_migrations"
        ) && text.includes("ia4tube_social_migrator")
    )
  );
  assert.ok(
    texts.some(
      (text) =>
        text.includes("AS owned") &&
        text.includes("column_count") &&
        text.includes("ia4tube_migrations")
    )
  );
  const manifest = readManifest({ root });
  assert.deepEqual(
    harness.state.applied.map((row) => row.checksum_sha256),
    manifest.map((migration) => migration.sha256)
  );
  assert.equal(harness.state.released, true);
});

test("ledger owner and exact structure are mandatory", async () => {
  const validStructure = {
    owned: true,
    column_count_valid: true,
    columns_valid: true,
    primary_key_valid: true,
    migrator_select: true,
    migrator_insert: true,
    migrator_update: false,
    migrator_delete: false
  };
  for (const ledgerStructure of [
    { ...validStructure, owned: false },
    { ...validStructure, column_count_valid: false },
    { ...validStructure, columns_valid: false },
    { ...validStructure, primary_key_valid: false },
    { ...validStructure, migrator_select: false },
    { ...validStructure, migrator_insert: false },
    { ...validStructure, migrator_update: true },
    { ...validStructure, migrator_delete: true }
  ]) {
    const harness = migrationPool({ ledgerStructure });
    await assert.rejects(
      runnerFor(harness).apply({
        SOCIAL_MIGRATION_TARGET_FINGERPRINT:
          targetFingerprint(baseTarget)
      }),
      { code: "migration_ledger_structure_invalid" }
    );
    assert.equal(harness.state.applied.length, 0);
    assert.equal(harness.state.released, true);
  }
});

test("ledger ACL is exact and refuses grant options or third parties", async () => {
  const safeRows = [
    {
      grantee: "ia4tube_social_migrator",
      privilege_type: "INSERT",
      is_grantable: false,
      grantor_name: "ia4tube_social_owner"
    },
    {
      grantee: "ia4tube_social_migrator",
      privilege_type: "SELECT",
      is_grantable: false,
      grantor_name: "ia4tube_social_owner"
    }
  ];
  for (const options of [
    { ledgerAcl: [] },
    {
      ledgerAcl: safeRows.map((row, index) =>
        index === 0 ? { ...row, is_grantable: true } : { ...row }
      )
    },
    {
      ledgerAcl: [
        ...safeRows,
        {
          grantee: "unexpected_reader",
          privilege_type: "SELECT",
          is_grantable: false,
          grantor_name: "ia4tube_social_owner"
        }
      ]
    },
    {
      ledgerAcl: safeRows.map((row) => ({
        ...row,
        grantor_name: "unexpected_grantor"
      }))
    }
  ]) {
    const harness = migrationPool(options);
    await assert.rejects(
      runnerFor(harness).apply({
        SOCIAL_MIGRATION_TARGET_FINGERPRINT:
          targetFingerprint(baseTarget)
      }),
      { code: "migration_ledger_acl_invalid" }
    );
    assert.equal(harness.state.applied.length, 0);
  }

  const columnHarness = migrationPool({
    ledgerColumnAcl: [
      {
        column_name: "checksum_sha256",
        grantee: "unexpected_reader",
        privilege_type: "SELECT",
        is_grantable: false,
        grantor_name: "ia4tube_social_owner"
      }
    ]
  });
  await assert.rejects(
    runnerFor(columnHarness).apply({
      SOCIAL_MIGRATION_TARGET_FINGERPRINT:
        targetFingerprint(baseTarget)
    }),
    { code: "migration_ledger_acl_invalid" }
  );
});

test("failed migration rolls back, releases lock and never records checksum", async () => {
  const target = baseTarget;
  const harness = migrationPool({ failOn: "CREATE SCHEMA ia4tube_social" });
  const runner = runnerFor(harness, target);
  await assert.rejects(
    runner.apply({
      SOCIAL_MIGRATION_TARGET_FINGERPRINT: targetFingerprint(target)
    }),
    /synthetic migration failure/
  );
  assert.equal(harness.state.applied.length, 0);
  const texts = harness.state.queries.map((query) => query.text);
  assert.ok(texts.includes("ROLLBACK"));
  assert.ok(texts.at(-1).includes("pg_advisory_unlock"));
  assert.equal(harness.state.released, true);
});

test("a later migration rollback preserves only committed checksums", async () => {
  const harness = migrationPool({
    failOn: "CREATE TABLE ia4tube_social.social_connections"
  });
  await assert.rejects(
    runnerFor(harness).apply({
      SOCIAL_MIGRATION_TARGET_FINGERPRINT:
        targetFingerprint(baseTarget)
    }),
    /synthetic migration failure/
  );
  const manifest = readManifest({ root });
  assert.deepEqual(
    harness.state.applied.map((row) => ({
      version: row.version,
      checksum: row.checksum_sha256
    })),
    [
      {
        version: manifest[0].version,
        checksum: manifest[0].sha256
      }
    ]
  );
  assert.ok(
    harness.state.queries.some((query) => query.text === "ROLLBACK")
  );
  assert.equal(
    harness.state.applied.some(
      (row) => row.version === manifest[1].version
    ),
    false
  );
});

test("migration 0003 wraps its populated backfill in one owner-only transient policy", async () => {
  const harness = migrationPool();
  await runnerFor(harness).apply({
    SOCIAL_MIGRATION_TARGET_FINGERPRINT:
      targetFingerprint(baseTarget)
  });

  const texts = harness.state.queries.map((query) => query.text);
  const createPolicy = texts.indexOf(GLOBAL_VAULT_BACKFILL_POLICY_CREATE);
  const migrationSql = texts.findIndex((text) =>
    text.includes("CREATE SCHEMA ia4tube_social_admin")
  );
  const dropPolicy = texts.indexOf(GLOBAL_VAULT_BACKFILL_POLICY_DROP);
  const ledgerInsert = texts.findIndex(
    (text, index) =>
      index > dropPolicy &&
      text.includes("INSERT INTO ia4tube_migrations.schema_migrations")
  );

  assert.equal(
    GLOBAL_VAULT_REGISTRY_MIGRATION,
    "0003_global_vault_key_registry"
  );
  assert.equal(
    GLOBAL_VAULT_BACKFILL_POLICY,
    "social_credentials_key_registry_backfill"
  );
  assert.match(
    GLOBAL_VAULT_BACKFILL_POLICY_CREATE,
    /FOR SELECT\s+TO ia4tube_social_owner\s+USING \(TRUE\)/
  );
  assert.equal(
    /ia4tube_social_runtime|BYPASSRLS|SUPERUSER|DISABLE ROW LEVEL SECURITY/i.test(
      GLOBAL_VAULT_BACKFILL_POLICY_CREATE
    ),
    false
  );
  assert.ok(createPolicy >= 0);
  assert.ok(migrationSql > createPolicy);
  assert.ok(dropPolicy > migrationSql);
  assert.ok(ledgerInsert > dropPolicy);
  assert.equal(
    harness.state.applied[2].version,
    GLOBAL_VAULT_REGISTRY_MIGRATION
  );
});

test("failure while removing the 0003 transient policy rolls back its ledger row", async () => {
  const harness = migrationPool({
    failOn: GLOBAL_VAULT_BACKFILL_POLICY_DROP
  });
  await assert.rejects(
    runnerFor(harness).apply({
      SOCIAL_MIGRATION_TARGET_FINGERPRINT:
        targetFingerprint(baseTarget)
    }),
    /synthetic migration failure/
  );

  assert.deepEqual(
    harness.state.applied.map((row) => row.version),
    [
      "0001_social_multitenant_foundation",
      "0002_social_connections_and_vault"
    ]
  );
  assert.ok(
    harness.state.queries.some((query) => query.text === "ROLLBACK")
  );
});

test("concurrent runners serialize and never apply a checksum twice", async () => {
  const harness = migrationPool({ migrationDelayMs: 10 });
  const first = runnerFor(harness);
  const second = runnerFor(harness);
  const results = await Promise.all([
    first.apply({
      SOCIAL_MIGRATION_TARGET_FINGERPRINT:
        targetFingerprint(baseTarget)
    }),
    second.apply({
      SOCIAL_MIGRATION_TARGET_FINGERPRINT:
        targetFingerprint(baseTarget)
    })
  ]);

  assert.deepEqual(
    results.map((result) => result.length).sort((a, b) => a - b),
    [0, 3]
  );
  assert.equal(harness.state.lockWaits, 1);
  assert.equal(harness.state.maxActiveLocks, 1);
  assert.equal(harness.state.activeLocks, 0);
  assert.equal(harness.state.applied.length, 3);
  assert.equal(
    new Set(harness.state.applied.map((row) => row.version)).size,
    3
  );
});

test("false advisory unlock discards the client", async () => {
  const harness = migrationPool({ unlockValue: false });
  let failure;
  try {
    await runnerFor(harness).apply({
      SOCIAL_MIGRATION_TARGET_FINGERPRINT:
        targetFingerprint(baseTarget)
    });
    assert.fail("unlock false must fail closed");
  } catch (error) {
    failure = error;
  }
  assert.equal(failure.code, "migration_advisory_unlock_not_owned");
  assert.equal(failure.discardClient, true);
  assert.equal(harness.state.releaseError, failure);
  assert.equal(harness.state.released, true);
});

test("advisory unlock query failure also discards the client", async () => {
  const harness = migrationPool({ unlockThrows: true });
  let failure;
  try {
    await runnerFor(harness).apply({
      SOCIAL_MIGRATION_TARGET_FINGERPRINT:
        targetFingerprint(baseTarget)
    });
    assert.fail("unlock failure must fail closed");
  } catch (error) {
    failure = error;
  }
  assert.equal(failure.code, "migration_advisory_unlock_failed");
  assert.equal(failure.discardClient, true);
  assert.equal(harness.state.releaseError, failure);
});

test("migration runner source is not imported by normal server startup", () => {
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  assert.equal(server.includes("social-db-migrate"), false);
  assert.equal(server.includes("persistence/postgres/migrations"), false);
  assert.equal(server.includes("ia4tube_schema_migrations"), false);
});

test("physical gate retains CLI, startup, RLS and both vault markers", () => {
  const source = fs.readFileSync(
    path.join(root, "tests", "social-postgres-real.test.js"),
    "utf8"
  );
  assert.match(source, /runMigrationCli\("status", configuration\)/);
  assert.match(source, /runMigrationCli\("validate", configuration\)/);
  assert.match(source, /runMigrationCli\("apply", configuration\)/);
  assert.match(source, /proveStartupBoundary/);
  assert.match(source, /runStartupProbe\(configuration, expectMigrated\)/);
  assert.match(
    source,
    /await migrationPoolB\.end\(\);\s+pools\.splice\(/s
  );
  assert.match(source, /row_security_active\(\$1::regclass\)/);
  assert.match(source, /synthetic-access-token-A-/);
  assert.match(source, /synthetic-refresh-token-B-/);
  assert.match(source, /provisioner_inherit/);
  assert.match(source, /table_truncate/);
});
