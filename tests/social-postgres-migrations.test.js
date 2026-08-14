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
  EXACT_BASE_MIGRATIONS,
  EXACT_BASE_TABLES,
  EXACT_CONNECTOR_TABLES,
  EXACT_FROM_PROFILE,
  EXACT_PENDING_MIGRATIONS,
  EXACT_TO_PROFILE,
  GLOBAL_VAULT_BACKFILL_POLICY,
  GLOBAL_VAULT_BACKFILL_POLICY_CREATE,
  GLOBAL_VAULT_BACKFILL_POLICY_DROP,
  GLOBAL_VAULT_REGISTRY_MIGRATION,
  LEDGER_NAME,
  PRODUCTION_APPROVAL,
  SOCIAL_CONNECTOR_PERSISTENCE_MIGRATION,
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
const {
  main: migrationCliMain,
  parseMigrationCommand
} = require("../scripts/social-db-migrate");

const root = path.resolve(__dirname, "..");
const environmentId = "77777777-7777-4777-8777-777777777777";
const baseTarget = Object.freeze({
  environment: "test",
  environmentId,
  approval: APPLY_APPROVAL,
  productionApproval: "",
  host: "localhost",
  port: "55432",
  database: "ia4tube_social_test_exact_runner",
  username: "synthetic_migrator"
});

const exactPlanRequest = Object.freeze({
  fromProfile: EXACT_FROM_PROFILE,
  expectedPending: EXACT_PENDING_MIGRATIONS,
  toProfile: EXACT_TO_PROFILE
});
const exactApplyRequest = Object.freeze({
  ...exactPlanRequest,
  recoveryReference: "synthetic-recovery-reference-0004",
  recoveryCapturedAt: "2026-08-13T12:00:00.000Z"
});
const exactApprovalEnvironment = Object.freeze({
  SOCIAL_MIGRATION_TARGET_FINGERPRINT: targetFingerprint(baseTarget)
});

function exactCliEnvironment() {
  const syntheticProtocol = "postgresql:";
  const syntheticCredential = "synthetic_password";
  const syntheticDatabaseUrl = new URL(
    `${syntheticProtocol}//localhost`
  );
  syntheticDatabaseUrl.hostname = baseTarget.host;
  syntheticDatabaseUrl.port = baseTarget.port;
  syntheticDatabaseUrl.pathname = `/${baseTarget.database}`;
  syntheticDatabaseUrl.username = baseTarget.username;
  syntheticDatabaseUrl.password = syntheticCredential;
  const databaseUrl = syntheticDatabaseUrl.toString();
  return {
    NODE_ENV: "test",
    SOCIAL_MIGRATIONS_DATABASE_URL: databaseUrl,
    SOCIAL_DATABASE_EXPECTED_TARGET_FINGERPRINT:
      databaseTargetFingerprint(new URL(databaseUrl)),
    SOCIAL_MIGRATIONS_EXPECTED_LOGIN: "synthetic_migrator",
    SOCIAL_DATABASE_EXPECTED_RUNTIME_LOGIN: "synthetic_runtime",
    SOCIAL_DATABASE_OWNER_ROLE: "ia4tube_social_owner",
    SOCIAL_DATABASE_MIGRATOR_ROLE: "ia4tube_social_migrator",
    SOCIAL_MIGRATION_ENVIRONMENT: "test",
    SOCIAL_MIGRATION_APPROVED: APPLY_APPROVAL,
    SOCIAL_MIGRATION_PRODUCTION_APPROVAL: "",
    SOCIAL_MIGRATION_EXPECTED_ENVIRONMENT_ID: environmentId,
    SOCIAL_MIGRATION_TARGET_FINGERPRINT: targetFingerprint(baseTarget),
    SOCIAL_DATABASE_ALLOW_INSECURE_LOCALHOST: "true"
  };
}

function exactApplyArgv() {
  return [
    "apply-exact",
    `--from-profile=${EXACT_FROM_PROFILE}`,
    `--expect-pending=${SOCIAL_CONNECTOR_PERSISTENCE_MIGRATION}`,
    `--to-profile=${EXACT_TO_PROFILE}`,
    `--recovery-reference=${exactApplyRequest.recoveryReference}`,
    `--recovery-captured-at=${exactApplyRequest.recoveryCapturedAt}`
  ];
}

const exactRuntimeTableGrants = Object.freeze({
  runtime_schema_contract: ["SELECT"],
  social_connections: ["INSERT", "SELECT"],
  social_external_accounts: ["INSERT", "SELECT"],
  social_destinations: ["INSERT", "SELECT"],
  social_connection_scopes: ["DELETE", "INSERT", "SELECT"],
  social_oauth_transactions: ["INSERT", "SELECT"],
  social_encrypted_credentials: ["INSERT", "SELECT"],
  social_reauth_grants: ["INSERT", "SELECT"],
  social_idempotency_operations: ["INSERT", "SELECT"],
  social_publications: ["INSERT", "SELECT"],
  social_publication_attempts: ["INSERT", "SELECT"],
  social_audit_events: ["INSERT", "SELECT"]
});

const exactRuntimeColumnGrants = Object.freeze({
  companies: {
    id: ["SELECT"], name: ["SELECT"], status: ["SELECT"],
    identity_derivation_version: ["SELECT"], created_at: ["SELECT"],
    updated_at: ["SELECT"]
  },
  users: {
    company_id: ["SELECT"], id: ["SELECT"], password_hash: ["SELECT"],
    status: ["SELECT"], auth_version: ["SELECT"]
  },
  company_memberships: {
    company_id: ["SELECT"], user_id: ["SELECT"], role: ["SELECT"],
    status: ["SELECT"], created_at: ["SELECT"], updated_at: ["SELECT"]
  },
  social_connections: {
    status: ["UPDATE"], connected_at: ["UPDATE"], expires_at: ["UPDATE"],
    revoked_at: ["UPDATE"], disconnected_at: ["UPDATE"],
    updated_at: ["UPDATE"], revision: ["UPDATE"]
  },
  social_external_accounts: {
    username: ["UPDATE"], display_name: ["UPDATE"],
    account_type: ["UPDATE"], status: ["UPDATE"], updated_at: ["UPDATE"]
  },
  social_destinations: {
    display_name: ["UPDATE"], status: ["UPDATE"], updated_at: ["UPDATE"]
  },
  social_connection_scopes: { expires_at: ["UPDATE"] },
  social_oauth_transactions: {
    consumed_at: ["UPDATE"], cancelled_at: ["UPDATE"],
    failed_at: ["UPDATE"], failure_code: ["UPDATE"]
  },
  social_encrypted_credentials: {
    connection_id: ["UPDATE"], oauth_transaction_id: ["UPDATE"],
    ciphertext: ["UPDATE"], nonce: ["UPDATE"], auth_tag: ["UPDATE"],
    key_version: ["UPDATE"], expires_at: ["UPDATE"],
    revoked_at: ["UPDATE"], updated_at: ["UPDATE"], revision: ["UPDATE"]
  },
  social_reauth_grants: { consumed_at: ["UPDATE"] },
  social_idempotency_operations: {
    status: ["UPDATE"], result_payload: ["UPDATE"], error_code: ["UPDATE"],
    updated_at: ["UPDATE"], revision: ["UPDATE"]
  },
  social_publications: {
    state: ["UPDATE"], confirmed_provider_reference: ["UPDATE"],
    reconciliation_reference: ["UPDATE"], error_code: ["UPDATE"],
    published_at: ["UPDATE"], updated_at: ["UPDATE"], revision: ["UPDATE"]
  },
  social_publication_attempts: {
    state: ["UPDATE"], error_code: ["UPDATE"],
    provider_reference: ["UPDATE"], finished_at: ["UPDATE"],
    duration_ms: ["UPDATE"], retry_after: ["UPDATE"],
    updated_at: ["UPDATE"], revision: ["UPDATE"]
  }
});

const exactNotValidConstraints = Object.freeze([
  ["social_external_accounts", "social_external_accounts_instagram_professional", "c"],
  ["social_oauth_transactions", "social_oauth_transactions_connection_fk", "f"],
  ["social_audit_events", "social_audit_events_reference_provider_present", "c"],
  ["social_audit_events", "social_audit_events_connection_provider_fk", "f"],
  ["social_audit_events", "social_audit_events_publication_provider_fk", "f"]
]);

function exactTables(profile) {
  return profile === EXACT_TO_PROFILE
    ? [...EXACT_BASE_TABLES, ...EXACT_CONNECTOR_TABLES]
    : [...EXACT_BASE_TABLES];
}

function exactPhysicalRows(profile, kind) {
  const tables = new Set(exactTables(profile));
  const common = {
    grantee: "ia4tube_social_runtime",
    is_grantable: false,
    grantor_name: "ia4tube_social_owner"
  };
  if (kind === "schema") {
    return [{ owner_name: "ia4tube_social_owner", routine_count: 0 }];
  }
  if (kind === "relations") {
    return [
      ...[...tables].sort().map((relname) => ({
        relname,
        object_kind: "r",
        owner_name: "ia4tube_social_owner",
        relrowsecurity: true,
        relforcerowsecurity: true
      })),
      {
        relname: "runtime_schema_contract",
        object_kind: "v",
        owner_name: "ia4tube_social_owner",
        relrowsecurity: false,
        relforcerowsecurity: false
      }
    ].sort((left, right) => left.relname.localeCompare(right.relname));
  }
  if (kind === "policies") {
    return [...tables].sort().map((table) => {
      const column = table === "companies" ? "id" : "company_id";
      const expression =
        `(${column} = NULLIF(current_setting('ia4tube.company_id', true), '')::uuid)`;
      return {
        tablename: table,
        policyname: `${table}_company_scope`,
        permissive: "PERMISSIVE",
        roles: ["public"],
        cmd: "ALL",
        qual: expression,
        with_check: expression
      };
    });
  }
  if (kind === "schemaAcl") {
    return [{ ...common, privilege_type: "USAGE" }];
  }
  if (kind === "tableAcl") {
    const rows = [];
    for (const [table, privileges] of Object.entries(exactRuntimeTableGrants)) {
      if (table !== "runtime_schema_contract" && !tables.has(table)) continue;
      for (const privilege_type of privileges) {
        rows.push({ ...common, table_name: table, privilege_type });
      }
    }
    return rows;
  }
  if (kind === "columnAcl") {
    const rows = [];
    for (const [table, columns] of Object.entries(exactRuntimeColumnGrants)) {
      if (!tables.has(table)) continue;
      for (const [column_name, privileges] of Object.entries(columns)) {
        if (
          profile === EXACT_FROM_PROFILE &&
          ((table === "social_oauth_transactions" &&
            ["failed_at", "failure_code"].includes(column_name)) ||
            (table === "social_encrypted_credentials" &&
              ["connection_id", "oauth_transaction_id"].includes(column_name)))
        ) continue;
        for (const privilege_type of privileges) {
          rows.push({
            ...common,
            table_name: table,
            column_name,
            privilege_type
          });
        }
      }
    }
    return rows;
  }
  if (kind === "constraints") {
    return profile === EXACT_TO_PROFILE
      ? exactNotValidConstraints.map(([table_name, conname, contype]) => ({
          table_name, conname, contype
        }))
      : [];
  }
  throw new Error(`unknown exact fixture kind: ${kind}`);
}

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
    maxActiveLocks: 0,
    physicalProfile: options.physicalProfile || null,
    exactMigrationExecutions: 0,
    commitAttempts: 0
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
        if (text === "BEGIN" || text.startsWith("BEGIN TRANSACTION")) {
          transaction = {
            ledgerRows: [],
            physicalProfile: state.physicalProfile
          };
          return { rows: [] };
        }
        if (text === "COMMIT") {
          state.commitAttempts += 1;
          if (transaction && options.commitOutcomeApplied !== false) {
            state.applied.push(...transaction.ledgerRows);
            state.physicalProfile = transaction.physicalProfile;
          }
          transaction = null;
          if (options.commitThrows) {
            throw new Error("synthetic commit outcome unknown");
          }
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
          return {
            rows: [
              ...state.applied,
              ...(transaction?.ledgerRows || [])
            ].map((row) => ({ ...row }))
          };
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
        if (
          text.includes(
            "CREATE TABLE ia4tube_social.social_idempotency_operations"
          )
        ) {
          state.exactMigrationExecutions += 1;
          if (transaction) transaction.physicalProfile = EXACT_TO_PROFILE;
          if (options.exactMigrationDelayMs) {
            await new Promise((resolve) =>
              setTimeout(resolve, options.exactMigrationDelayMs)
            );
          }
          return { rows: [] };
        }
        const activeProfile =
          transaction?.physicalProfile || state.physicalProfile;
        const physicalRows = (kind) => {
          let rows = exactPhysicalRows(activeProfile, kind).map((row) => ({
            ...row
          }));
          if (typeof options.mutateExactRows === "function") {
            rows = options.mutateExactRows({
              kind,
              profile: activeProfile,
              rows,
              state
            }) || rows;
          }
          return { rows };
        };
        if (
          text.includes("WHERE namespace.nspname = 'ia4tube_social'") &&
          text.includes("AS routine_count")
        ) {
          return physicalRows("schema");
        }
        if (
          text.includes("WHERE namespace.nspname = 'ia4tube_social'") &&
          text.includes("relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')")
        ) {
          return physicalRows("relations");
        }
        if (
          text.includes("FROM pg_catalog.pg_policies") &&
          text.includes("WHERE schemaname = 'ia4tube_social'")
        ) {
          return physicalRows("policies");
        }
        if (
          text.includes("FROM pg_catalog.pg_namespace namespace") &&
          text.includes("WHERE namespace.nspname = 'ia4tube_social'") &&
          text.includes("expanded_acl")
        ) {
          return physicalRows("schemaAcl");
        }
        if (
          text.includes("WHERE namespace.nspname = 'ia4tube_social'") &&
          text.includes("relation.relkind IN ('r', 'p', 'v')") &&
          text.includes("expanded_acl")
        ) {
          return physicalRows("tableAcl");
        }
        if (
          text.includes("WHERE namespace.nspname = 'ia4tube_social'") &&
          text.includes("attribute.attacl")
        ) {
          return physicalRows("columnAcl");
        }
        if (
          text.includes("WHERE namespace.nspname = 'ia4tube_social'") &&
          text.includes("NOT constraint_info.convalidated")
        ) {
          return physicalRows("constraints");
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
        if (error?.discardClient && state.lockOwner === clientId) {
          const next = state.lockQueue.shift();
          if (next) {
            state.lockOwner = next.clientId;
            next.resolve();
          } else {
            state.lockOwner = null;
            state.activeLocks -= 1;
          }
        }
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

function exactAppliedRows(count = EXACT_BASE_MIGRATIONS.length) {
  return readManifest({ root }).slice(0, count).map((migration) => ({
    version: migration.version,
    checksum_sha256: migration.sha256,
    applied_at: new Date("2026-08-13T00:00:00.000Z"),
    execution_ms: 1
  }));
}

function exactMigrationHarness(overrides = {}) {
  return migrationPool({
    ledgerExists: true,
    applied: exactAppliedRows(),
    physicalProfile: EXACT_FROM_PROFILE,
    ...overrides
  });
}

function syntheticManifestWith0005() {
  const manifest = readManifest({ root });
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "ia4tube-social-exact-0005-")
  );
  const synthetic = {
    version: "0005_synthetic_future",
    file: "0005_synthetic_future.up.sql",
    sql: "SELECT 1;\n"
  };
  const entries = [];
  for (const migration of [...manifest, synthetic]) {
    fs.writeFileSync(
      path.join(directory, migration.file),
      migration.sql,
      "utf8"
    );
    entries.push({
      version: migration.version,
      file: migration.file,
      sha256: migration.sha256 || sha256(Buffer.from(migration.sql, "utf8"))
    });
  }
  const manifestPath = path.join(directory, "checksums.json");
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify({ format: 1, migrations: entries }, null, 2)}\n`,
    "utf8"
  );
  return {
    directory,
    options: { migrationsDirectory: directory, manifestPath }
  };
}

test("exact CLI parser accepts only the frozen plan and apply argument sets", () => {
  const common = [
    `--from-profile=${EXACT_FROM_PROFILE}`,
    `--expect-pending=${SOCIAL_CONNECTOR_PERSISTENCE_MIGRATION}`,
    `--to-profile=${EXACT_TO_PROFILE}`
  ];
  assert.deepEqual(
    parseMigrationCommand(["plan-exact", ...common]),
    { command: "plan-exact", request: exactPlanRequest }
  );
  assert.deepEqual(
    parseMigrationCommand([
      "apply-exact",
      ...common,
      "--recovery-reference=synthetic-recovery-reference-0004",
      "--recovery-captured-at=2026-08-13T12:00:00.000Z"
    ]),
    { command: "apply-exact", request: exactApplyRequest }
  );

  for (const command of ["status", "validate", "apply"]) {
    assert.deepEqual(parseMigrationCommand([command]), {
      command,
      request: undefined
    });
    assert.deepEqual(parseMigrationCommand([command, "legacy-extra"]), {
      command,
      request: undefined
    });
  }
});

test("exact CLI parser refuses malformed, unknown, duplicate and missing arguments", () => {
  const common = [
    `--from-profile=${EXACT_FROM_PROFILE}`,
    `--expect-pending=${SOCIAL_CONNECTOR_PERSISTENCE_MIGRATION}`,
    `--to-profile=${EXACT_TO_PROFILE}`
  ];
  const refused = [
    { argv: [], code: "migration_command_invalid" },
    { argv: ["unknown"], code: "migration_command_invalid" },
    {
      argv: ["plan-exact", ...common, "--unknown=value"],
      code: "migration_exact_argument_set_invalid"
    },
    {
      argv: ["plan-exact", ...common, common[0]],
      code: "migration_exact_argument_duplicate"
    },
    {
      argv: ["plan-exact", ...common.slice(0, 2)],
      code: "migration_exact_argument_set_invalid"
    },
    {
      argv: ["plan-exact", "--from-profile", ...common.slice(1)],
      code: "migration_exact_argument_invalid"
    },
    {
      argv: ["plan-exact", "--from-profile=social-schema-9999", ...common.slice(1)],
      code: "migration_exact_from_profile_invalid"
    },
    {
      argv: ["plan-exact", common[0], common[1], "--to-profile=social-schema-9999"],
      code: "migration_exact_to_profile_invalid"
    },
    {
      argv: ["plan-exact", common[0], "--expect-pending=0005_unknown", common[2]],
      code: "migration_exact_pending_migration_invalid"
    },
    {
      argv: ["apply-exact", ...common],
      code: "migration_exact_argument_set_invalid"
    },
    {
      argv: [
        "apply-exact", ...common,
        "--recovery-reference=contains space",
        "--recovery-captured-at=2026-08-13T12:00:00.000Z"
      ],
      code: "migration_exact_recovery_reference_invalid"
    },
    {
      argv: [
        "apply-exact", ...common,
        "--recovery-reference=synthetic-reference",
        "--recovery-captured-at=2026-02-30T12:00:00.000Z"
      ],
      code: "migration_exact_recovery_timestamp_invalid"
    }
  ];
  for (const candidate of refused) {
    assert.throws(
      () => parseMigrationCommand(candidate.argv),
      { code: candidate.code }
    );
  }
});

test("invalid exact CLI input is refused before configuration or pool creation", async () => {
  let poolConstructed = false;
  class ForbiddenPool {
    constructor() {
      poolConstructed = true;
      throw new Error("pool must not be constructed");
    }
  }
  let stdout = "";
  let stderr = "";
  const status = await migrationCliMain({
    argv: ["apply-exact", "--unknown=value"],
    env: {},
    PoolClass: ForbiddenPool,
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } }
  });
  assert.equal(status, 2);
  assert.equal(poolConstructed, false);
  assert.equal(stdout, "");
  assert.deepEqual(JSON.parse(stderr), {
    ok: false,
    code: "migration_exact_argument_set_invalid"
  });
});

test("exact CLI serializes commit ambiguity without leaking recovery evidence", async () => {
  const harness = exactMigrationHarness({
    commitThrows: true,
    commitOutcomeApplied: true
  });
  let stdout = "";
  let stderr = "";
  let closed = false;
  const status = await migrationCliMain({
    argv: exactApplyArgv(),
    env: exactCliEnvironment(),
    createPoolImpl: () => harness.pool,
    closePoolImpl: async () => { closed = true; },
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } }
  });
  assert.equal(status, 1);
  assert.equal(stdout, "");
  assert.deepEqual(JSON.parse(stderr), {
    ok: false,
    code: "migration_exact_commit_outcome_unknown",
    outcomeUnknown: true,
    retryAllowed: false,
    requiresReadOnlyInspection: true
  });
  assert.equal(stderr.includes(exactApplyRequest.recoveryReference), false);
  assert.equal(closed, true);
  assert.equal(harness.state.commitAttempts, 1);
  assert.equal(harness.state.exactMigrationExecutions, 1);
});

test("exact CLI marks postcommit validation failure as applied and non-retryable", async () => {
  let socialSchemaReads = 0;
  const harness = exactMigrationHarness({
    failOn(text) {
      if (
        text.includes("WHERE namespace.nspname = 'ia4tube_social'") &&
        text.includes("AS routine_count")
      ) {
        socialSchemaReads += 1;
        return socialSchemaReads === 3;
      }
      return false;
    }
  });
  let stdout = "";
  let stderr = "";
  const status = await migrationCliMain({
    argv: exactApplyArgv(),
    env: exactCliEnvironment(),
    createPoolImpl: () => harness.pool,
    closePoolImpl: async () => undefined,
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } }
  });
  assert.equal(status, 1);
  assert.equal(stdout, "");
  assert.deepEqual(JSON.parse(stderr), {
    ok: false,
    code: "migration_exact_postcommit_validation_failed",
    applied: true,
    retryAllowed: false,
    requiresReadOnlyInspection: true
  });
  assert.equal(stderr.includes(exactApplyRequest.recoveryReference), false);
  assert.equal(harness.state.commitAttempts, 1);
  assert.equal(harness.state.physicalProfile, EXACT_TO_PROFILE);
});

test("manifest freezes ordered LF-only migration checksums", () => {
  const migrations = readManifest({ root });
  assert.deepEqual(
    migrations.map((item) => item.version),
    [
      "0001_social_multitenant_foundation",
      "0002_social_connections_and_vault",
      "0003_global_vault_key_registry",
      "0004_social_connector_persistence"
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

test("migration scanner allows only the exact 0004 status-check replacement", () => {
  const migrationPath = path.join(
    root,
    "db",
    "migrations",
    "0004_social_connector_persistence.up.sql"
  );
  const migrationSql = fs.readFileSync(migrationPath, "utf8");
  assert.equal(
    SOCIAL_CONNECTOR_PERSISTENCE_MIGRATION,
    "0004_social_connector_persistence"
  );
  assert.doesNotThrow(() =>
    assertNonDestructiveSql(
      migrationSql,
      SOCIAL_CONNECTOR_PERSISTENCE_MIGRATION
    )
  );

  const refused = [
    {
      version: "0005_synthetic",
      sql: migrationSql
    },
    {
      version: SOCIAL_CONNECTOR_PERSISTENCE_MIGRATION,
      sql: migrationSql.replace(
        "DROP CONSTRAINT social_connections_status_allowed,",
        "DROP CONSTRAINT unexpected_status_constraint,"
      )
    },
    {
      version: SOCIAL_CONNECTOR_PERSISTENCE_MIGRATION,
      sql: migrationSql.replace(
        "DROP CONSTRAINT social_connections_status_allowed,",
        [
          "DROP CONSTRAINT unexpected_status_constraint,",
          "  DROP CONSTRAINT social_connections_status_allowed,"
        ].join("\n")
      )
    },
    {
      version: SOCIAL_CONNECTOR_PERSISTENCE_MIGRATION,
      sql: migrationSql.replace(
        "ALTER TABLE ia4tube_social.social_connections",
        "ALTER TABLE ia4tube_social.social_external_accounts"
      )
    },
    {
      version: SOCIAL_CONNECTOR_PERSISTENCE_MIGRATION,
      sql: migrationSql.replace(
        "DROP CONSTRAINT social_connections_status_allowed,",
        "DROP CONSTRAINT IF EXISTS social_connections_status_allowed,"
      )
    },
    {
      version: SOCIAL_CONNECTOR_PERSISTENCE_MIGRATION,
      sql: migrationSql.replace(
        "ADD CONSTRAINT social_connections_status_allowed",
        "ADD CONSTRAINT replacement_name_does_not_match"
      )
    },
    {
      version: SOCIAL_CONNECTOR_PERSISTENCE_MIGRATION,
      sql: migrationSql.replace(
        /ADD CONSTRAINT social_connections_status_allowed\s+CHECK/,
        "ADD CONSTRAINT social_connections_status_allowed UNIQUE"
      )
    }
  ];
  for (const candidate of refused) {
    assert.throws(
      () => assertNonDestructiveSql(candidate.sql, candidate.version),
      { code: "destructive_migration_refused" }
    );
  }
});

test("migration 0004 keeps legacy rows valid and adds only the minimum connector ledger", () => {
  const sql = fs.readFileSync(
    path.join(
      root,
      "db",
      "migrations",
      "0004_social_connector_persistence.up.sql"
    ),
    "utf8"
  );
  const blockingIndex = sql.match(
    /CREATE UNIQUE INDEX social_connections_instagram_blocking_company_unique[\s\S]*?;/
  )?.[0];
  assert.ok(blockingIndex);
  const statusAllowed = sql.match(
    /ADD CONSTRAINT social_connections_status_allowed[\s\S]*?(?=\n\s*ADD CONSTRAINT social_connections_status_timestamp_consistent)/
  )?.[0];
  assert.ok(statusAllowed);
  assert.deepEqual(
    [...statusAllowed.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]),
    [
      "pending",
      "active",
      "expired",
      "revoked",
      "disconnected",
      "error",
      "authorization_pending",
      "connected",
      "reconnect_required",
      "disconnecting",
      "failed"
    ]
  );
  assert.deepEqual(
    [...blockingIndex.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]),
    [
      "instagram",
      "pending",
      "active",
      "authorization_pending",
      "connected",
      "reconnect_required",
      "disconnecting"
    ]
  );
  assert.match(
    sql,
    /CREATE UNIQUE INDEX social_external_accounts_instagram_active_company_unique[\s\S]*?ON ia4tube_social\.social_external_accounts \(company_id\)[\s\S]*?provider = 'instagram' AND status = 'active'/
  );
  const preflight = sql.match(
    /DO \$social_connector_preflight\$[\s\S]*?\$social_connector_preflight\$;/
  )?.[0];
  assert.ok(preflight);
  assert.match(
    preflight,
    /social_connections[\s\S]*?GROUP BY company_id[\s\S]*?HAVING COUNT\(\*\) > 1[\s\S]*?social_connector_blocking_connection_conflict/
  );
  assert.match(
    preflight,
    /social_external_accounts[\s\S]*?GROUP BY company_id[\s\S]*?HAVING COUNT\(\*\) > 1[\s\S]*?social_connector_active_account_conflict/
  );
  assert.equal((preflight.match(/RAISE EXCEPTION/g) || []).length, 2);
  assert.doesNotMatch(preflight, /SELECT\s+(company_id|id|external_id|username)\b/i);
  assert.match(
    sql,
    /status = 'reconnect_required'[\s\S]*?revoked_at IS NULL[\s\S]*?disconnected_at IS NULL/
  );
  assert.match(
    sql,
    /status = 'disconnected'[\s\S]*?disconnected_at IS NOT NULL[\s\S]*?revoked_at IS NULL/
  );
  assert.match(
    sql,
    /social_external_accounts_instagram_professional[\s\S]*?account_type IN \('business', 'creator'\)[\s\S]*?NOT VALID/
  );
  assert.match(sql, /ADD COLUMN connection_id UUID/);
  assert.match(sql, /ADD COLUMN failed_at TIMESTAMPTZ/);
  assert.match(sql, /ADD COLUMN failure_code TEXT/);
  assert.match(sql, /ADD COLUMN audit_event_id UUID/);
  assert.match(sql, /ADD COLUMN correlation_id UUID/);
  assert.match(
    sql,
    /GRANT UPDATE \(connection_id, oauth_transaction_id\)[\s\S]*?social_encrypted_credentials[\s\S]*?ia4tube_social_runtime/
  );
  assert.match(
    sql,
    /social_audit_events_reference_provider_present[\s\S]*?connection_id IS NULL[\s\S]*?publication_id IS NULL[\s\S]*?provider IS NOT NULL[\s\S]*?NOT VALID/
  );
  const intentionalNotValidConstraints = [];
  for (const statement of sql.matchAll(
    /^[ \t]*ALTER TABLE[ \t]+([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)([\s\S]*?);/gm
  )) {
    const constraints = statement[3]
      .split(/(?:^|[\r\n])[ \t]*ADD CONSTRAINT[ \t]+/g)
      .slice(1);
    for (const body of constraints) {
      if (!/\bNOT[ \t]+VALID\b/.test(body)) continue;
      const constraint = body.match(
        /^([a-z_][a-z0-9_]*)[ \t\r\n]+(CHECK|FOREIGN KEY)\b/
      );
      assert.ok(constraint);
      intentionalNotValidConstraints.push({
        schema: statement[1],
        table: statement[2],
        name: constraint[1],
        pgType: constraint[2] === "CHECK" ? "c" : "f"
      });
    }
  }
  const compareConstraintIdentity = (left, right) => {
    const leftIdentity = [left.schema, left.table, left.name, left.pgType]
      .join("\u0000");
    const rightIdentity = [right.schema, right.table, right.name, right.pgType]
      .join("\u0000");
    return leftIdentity < rightIdentity ? -1 : leftIdentity > rightIdentity ? 1 : 0;
  };
  intentionalNotValidConstraints.sort(compareConstraintIdentity);
  const expectedIntentionalNotValidConstraints = [
    {
      schema: "ia4tube_social",
      table: "social_external_accounts",
      name: "social_external_accounts_instagram_professional",
      pgType: "c"
    },
    {
      schema: "ia4tube_social",
      table: "social_oauth_transactions",
      name: "social_oauth_transactions_connection_fk",
      pgType: "f"
    },
    {
      schema: "ia4tube_social",
      table: "social_audit_events",
      name: "social_audit_events_reference_provider_present",
      pgType: "c"
    },
    {
      schema: "ia4tube_social",
      table: "social_audit_events",
      name: "social_audit_events_connection_provider_fk",
      pgType: "f"
    },
    {
      schema: "ia4tube_social",
      table: "social_audit_events",
      name: "social_audit_events_publication_provider_fk",
      pgType: "f"
    }
  ].sort(compareConstraintIdentity);
  assert.equal(intentionalNotValidConstraints.length, 5);
  assert.deepEqual(
    intentionalNotValidConstraints,
    expectedIntentionalNotValidConstraints
  );
  assert.deepEqual(
    [...sql.matchAll(/CREATE TABLE ia4tube_social\.([a-z_]+) \(/g)].map(
      (match) => match[1]
    ),
    [
      "social_idempotency_operations",
      "social_publications",
      "social_publication_attempts"
    ]
  );
  const attempts = sql.match(
    /CREATE TABLE ia4tube_social\.social_publication_attempts \([\s\S]*?\n\);/
  )?.[0];
  assert.ok(attempts);
  assert.match(attempts, /state TEXT NOT NULL DEFAULT 'started'/);
  assert.match(
    attempts,
    /provider_reference ~[\s\S]*?\^\[A-Za-z0-9\]\[A-Za-z0-9\._:-\]\{0,499\}\$[\s\S]*?access\[_-\]\?token/
  );
  assert.match(attempts, /state = 'started'/);
  assert.doesNotMatch(attempts, /'publishing'/);
  const attemptStates = attempts.match(
    /social_publication_attempts_state_allowed[\s\S]*?(?=\n\s*CONSTRAINT social_publication_attempts_error_code_valid)/
  )?.[0];
  assert.ok(attemptStates);
  assert.deepEqual(
    [...attemptStates.matchAll(/'([a-z_]+)'/g)].map(
      (match) => match[1]
    ),
    [
      "started",
      "provider_confirming",
      "published",
      "failed_temporary",
      "failed_permanent"
    ]
  );
  assert.doesNotMatch(sql, /\bBYTEA\b/i);
  for (const table of [
    "social_idempotency_operations",
    "social_publications",
    "social_publication_attempts"
  ]) {
    assert.match(
      sql,
      new RegExp(
        `ALTER TABLE ia4tube_social\\.${table}\\s+` +
          "ENABLE ROW LEVEL SECURITY;"
      )
    );
    assert.match(
      sql,
      new RegExp(
        `ALTER TABLE ia4tube_social\\.${table}\\s+` +
          "FORCE ROW LEVEL SECURITY;"
      )
    );
    assert.match(sql, new RegExp(`CREATE POLICY ${table}_company_scope`));
  }
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
  assert.equal(result.pending, 4);
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

test("plan-exact authenticates canonical 0003 and remains strictly read-only", async () => {
  const harness = exactMigrationHarness();
  const result = await runnerFor(harness).planExact(
    exactPlanRequest,
    exactApprovalEnvironment
  );
  assert.deepEqual(result, {
    fromProfile: EXACT_FROM_PROFILE,
    toProfile: EXACT_TO_PROFILE,
    expectedPending: [SOCIAL_CONNECTOR_PERSISTENCE_MIGRATION],
    observedPending: [SOCIAL_CONNECTOR_PERSISTENCE_MIGRATION],
    planApproved: true
  });
  const forbidden = /^(CREATE|ALTER|DROP|GRANT|REVOKE|INSERT|UPDATE|DELETE|TRUNCATE)\b/i;
  assert.equal(
    harness.state.queries.some((query) => forbidden.test(query.text.trimStart())),
    false
  );
  assert.equal(
    harness.state.queries.some((query) =>
      query.text.includes("CREATE TABLE IF NOT EXISTS ia4tube_migrations.schema_migrations")
    ),
    false
  );
  assert.equal(harness.state.exactMigrationExecutions, 0);
  assert.equal(harness.state.applied.length, 3);
  assert.equal(harness.state.physicalProfile, EXACT_FROM_PROFILE);
  assert.ok(
    harness.state.queries.some((query) =>
      query.text === "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"
    )
  );
  assert.ok(harness.state.queries.some((query) => query.text === "ROLLBACK"));
  assert.equal(harness.state.released, true);
});

test("plan-exact refuses every non-exact ledger state and a future 0005", async () => {
  const manifest = readManifest({ root });
  const states = [
    { name: "empty", applied: [], code: "exact_pending_set_mismatch" },
    {
      name: "already applied",
      applied: exactAppliedRows(4),
      physicalProfile: EXACT_TO_PROFILE,
      code: "exact_pending_set_mismatch"
    },
    {
      name: "partial ledger",
      applied: exactAppliedRows(2),
      code: "exact_pending_set_mismatch"
    },
    {
      name: "unknown migration",
      applied: [
        ...exactAppliedRows(),
        { version: "9999_unknown", checksum_sha256: "a".repeat(64) }
      ],
      code: "unknown_applied_migration"
    },
    {
      name: "checksum mismatch",
      applied: exactAppliedRows().map((row, index) =>
        index === 1 ? { ...row, checksum_sha256: "0".repeat(64) } : row
      ),
      code: "applied_migration_checksum_mismatch"
    },
    {
      name: "ledger gap",
      applied: [exactAppliedRows()[0], exactAppliedRows()[2]],
      code: "migration_ledger_order_invalid"
    },
    {
      name: "duplicate ledger row",
      applied: [exactAppliedRows()[0], exactAppliedRows()[0]],
      code: "migration_ledger_invalid"
    }
  ];
  assert.equal(manifest.length, 4);
  for (const candidate of states) {
    const harness = exactMigrationHarness({
      applied: candidate.applied,
      physicalProfile: candidate.physicalProfile || EXACT_FROM_PROFILE
    });
    await assert.rejects(
      runnerFor(harness).planExact(exactPlanRequest, exactApprovalEnvironment),
      { code: candidate.code },
      candidate.name
    );
    assert.equal(harness.state.exactMigrationExecutions, 0, candidate.name);
  }

  const synthetic = syntheticManifestWith0005();
  try {
    const harness = exactMigrationHarness();
    const runner = createMigrationRunner({
      pool: harness.pool,
      ownerRole: "ia4tube_social_owner",
      migratorRole: "ia4tube_social_migrator",
      target: baseTarget,
      manifestOptions: synthetic.options
    });
    await assert.rejects(
      runner.planExact(exactPlanRequest, exactApprovalEnvironment),
      { code: "exact_pending_set_mismatch" }
    );
    assert.equal(harness.state.exactMigrationExecutions, 0);
  } finally {
    fs.rmSync(synthetic.directory, { recursive: true, force: true });
  }
});

test("plan-exact requires an existing immutable ledger contract", async () => {
  const missing = exactMigrationHarness({ ledgerExists: false });
  await assert.rejects(
    runnerFor(missing).planExact(exactPlanRequest, exactApprovalEnvironment),
    { code: "migration_exact_ledger_missing" }
  );
  assert.equal(
    missing.state.queries.some((query) =>
      query.text.includes("CREATE TABLE IF NOT EXISTS")
    ),
    false
  );

  const invalid = exactMigrationHarness({
    ledgerStructure: {
      owned: false,
      column_count_valid: true,
      columns_valid: true,
      primary_key_valid: true,
      migrator_select: true,
      migrator_insert: true,
      migrator_update: false,
      migrator_delete: false
    }
  });
  await assert.rejects(
    runnerFor(invalid).planExact(exactPlanRequest, exactApprovalEnvironment),
    { code: "migration_ledger_structure_invalid" }
  );

  const invalidAcl = exactMigrationHarness({
    ledgerAcl: [
      {
        grantee: "ia4tube_social_migrator",
        privilege_type: "SELECT",
        is_grantable: true,
        grantor_name: "ia4tube_social_owner"
      }
    ]
  });
  await assert.rejects(
    runnerFor(invalidAcl).planExact(exactPlanRequest, exactApprovalEnvironment),
    { code: "migration_ledger_acl_invalid" }
  );
});

test("plan-exact closes every physical 0003 profile dimension", async () => {
  const drifts = [
    {
      name: "schema owner",
      kind: "schema",
      code: "migration_exact_schema_profile_mismatch",
      mutate: (rows) => [{ ...rows[0], owner_name: "unexpected_owner" }]
    },
    {
      name: "extra relation",
      kind: "relations",
      code: "migration_exact_relation_profile_mismatch",
      mutate: (rows) => [...rows, { ...rows[0], relname: "unexpected_table" }]
    },
    {
      name: "missing relation",
      kind: "relations",
      code: "migration_exact_relation_profile_mismatch",
      mutate: (rows) => rows.slice(1)
    },
    {
      name: "relation owner",
      kind: "relations",
      code: "migration_exact_relation_profile_mismatch",
      mutate: (rows) => [{ ...rows[0], owner_name: "unexpected_owner" }, ...rows.slice(1)]
    },
    {
      name: "relkind",
      kind: "relations",
      code: "migration_exact_relation_profile_mismatch",
      mutate: (rows) => [{ ...rows[0], object_kind: "p" }, ...rows.slice(1)]
    },
    {
      name: "force rls",
      kind: "relations",
      code: "migration_exact_relation_profile_mismatch",
      mutate: (rows) => [{ ...rows[0], relforcerowsecurity: false }, ...rows.slice(1)]
    },
    {
      name: "rls",
      kind: "relations",
      code: "migration_exact_relation_profile_mismatch",
      mutate: (rows) => [{ ...rows[0], relrowsecurity: false }, ...rows.slice(1)]
    },
    {
      name: "policy",
      kind: "policies",
      code: "migration_exact_rls_profile_mismatch",
      mutate: (rows) => [{ ...rows[0], cmd: "SELECT" }, ...rows.slice(1)]
    },
    {
      name: "policy expression",
      kind: "policies",
      code: "migration_exact_rls_profile_mismatch",
      mutate: (rows) => [{ ...rows[0], with_check: "TRUE" }, ...rows.slice(1)]
    },
    {
      name: "schema acl",
      kind: "schemaAcl",
      code: "migration_exact_grants_profile_mismatch",
      mutate: (rows) => [...rows, { ...rows[0], grantee: "unexpected_reader" }]
    },
    {
      name: "schema grant option",
      kind: "schemaAcl",
      code: "migration_exact_grants_profile_mismatch",
      mutate: (rows) => [{ ...rows[0], is_grantable: true }]
    },
    {
      name: "table acl",
      kind: "tableAcl",
      code: "migration_exact_grants_profile_mismatch",
      mutate: (rows) => rows.slice(1)
    },
    {
      name: "column acl",
      kind: "columnAcl",
      code: "migration_exact_grants_profile_mismatch",
      mutate: (rows) => rows.slice(1)
    },
    {
      name: "unvalidated constraint",
      kind: "constraints",
      code: "migration_exact_constraints_profile_mismatch",
      mutate: (rows) => [{
        table_name: "social_connections",
        conname: "unexpected_not_valid",
        contype: "c"
      }, ...rows]
    }
  ];
  for (const drift of drifts) {
    const harness = exactMigrationHarness({
      mutateExactRows({ kind, rows }) {
        return kind === drift.kind ? drift.mutate(rows) : rows;
      }
    });
    await assert.rejects(
      runnerFor(harness).planExact(exactPlanRequest, exactApprovalEnvironment),
      { code: drift.code },
      drift.name
    );
    assert.equal(harness.state.exactMigrationExecutions, 0, drift.name);
  }
});

test("exact modes refuse staging, non-loopback and non-disposable databases before connecting", async () => {
  const targets = [
    { ...baseTarget, environment: "staging" },
    { ...baseTarget, host: "postgres.example.invalid" },
    { ...baseTarget, database: "ia4tube_social_test" },
    { ...baseTarget, database: "ia4tube_social_test_staging_copy" }
  ];
  for (const target of targets) {
    const harness = exactMigrationHarness();
    await assert.rejects(
      runnerFor(harness, target).planExact(exactPlanRequest, {
        SOCIAL_MIGRATION_TARGET_FINGERPRINT: targetFingerprint(target)
      }),
      { code: "migration_exact_target_not_disposable" }
    );
    assert.equal(harness.state.connected, 0);
  }
});

test("exact runner validates the frozen request and synthetic recovery before connecting", async () => {
  const candidates = [
    {
      invoke: (runner) => runner.planExact(
        { ...exactPlanRequest, expectedPending: [] },
        exactApprovalEnvironment
      ),
      code: "migration_exact_request_invalid"
    },
    {
      invoke: (runner) => runner.planExact(
        { ...exactPlanRequest, recoveryReference: "not-allowed" },
        exactApprovalEnvironment
      ),
      code: "migration_exact_recovery_not_allowed"
    },
    {
      invoke: (runner) => runner.applyExact(
        exactPlanRequest,
        exactApprovalEnvironment
      ),
      code: "migration_exact_recovery_reference_invalid"
    },
    {
      invoke: (runner) => runner.applyExact(
        { ...exactApplyRequest, recoveryCapturedAt: "2026-02-30T12:00:00.000Z" },
        exactApprovalEnvironment
      ),
      code: "migration_exact_recovery_timestamp_invalid"
    }
  ];
  for (const candidate of candidates) {
    const harness = exactMigrationHarness();
    await assert.rejects(candidate.invoke(runnerFor(harness)), {
      code: candidate.code
    });
    assert.equal(harness.state.connected, 0);
  }
});

test("apply takes an advisory lock and records SQL plus checksum atomically", async () => {
  const target = baseTarget;
  const harness = migrationPool();
  const runner = runnerFor(harness, target);
  const applied = await runner.apply({
    SOCIAL_MIGRATION_TARGET_FINGERPRINT: targetFingerprint(target)
  });
  assert.equal(applied.length, 4);
  assert.deepEqual(
    harness.state.applied.map((row) => row.version),
    [
      "0001_social_multitenant_foundation",
      "0002_social_connections_and_vault",
      "0003_global_vault_key_registry",
      "0004_social_connector_persistence"
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

test("migration 0004 rolls back atomically and never records a partial ledger row", async () => {
  const harness = migrationPool({
    failOn: "CREATE TABLE ia4tube_social.social_publication_attempts"
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
      "0002_social_connections_and_vault",
      "0003_global_vault_key_registry"
    ]
  );
  assert.equal(
    harness.state.applied.some(
      (row) => row.version === SOCIAL_CONNECTOR_PERSISTENCE_MIGRATION
    ),
    false
  );
  assert.ok(
    harness.state.queries.some((query) => query.text === "ROLLBACK")
  );
});

test("apply-exact commits canonical 0004, ledger and physical validation as one unit", async () => {
  const harness = exactMigrationHarness();
  const result = await runnerFor(harness).applyExact(
    exactApplyRequest,
    exactApprovalEnvironment
  );
  assert.deepEqual(result, {
    fromProfile: EXACT_FROM_PROFILE,
    toProfile: EXACT_TO_PROFILE,
    expectedPending: [SOCIAL_CONNECTOR_PERSISTENCE_MIGRATION],
    observedPending: [SOCIAL_CONNECTOR_PERSISTENCE_MIGRATION],
    appliedMigration: SOCIAL_CONNECTOR_PERSISTENCE_MIGRATION,
    finalProfile: EXACT_TO_PROFILE,
    postCommitValidated: true,
    recoveryReferenceDigest: sha256(exactApplyRequest.recoveryReference),
    recoveryCapturedAt: exactApplyRequest.recoveryCapturedAt,
    recoveryEvidenceExternallyVerified: false
  });
  assert.equal(
    JSON.stringify(result).includes(exactApplyRequest.recoveryReference),
    false
  );
  assert.equal(harness.state.exactMigrationExecutions, 1);
  assert.equal(harness.state.commitAttempts, 1);
  assert.equal(harness.state.physicalProfile, EXACT_TO_PROFILE);
  assert.deepEqual(
    harness.state.applied.map((row) => row.version),
    EXACT_BASE_MIGRATIONS.concat(SOCIAL_CONNECTOR_PERSISTENCE_MIGRATION)
  );

  const texts = harness.state.queries.map((query) => query.text);
  const migrationIndex = texts.findIndex((text) =>
    text.includes("CREATE TABLE ia4tube_social.social_idempotency_operations")
  );
  const ledgerIndex = texts.findIndex(
    (text, index) =>
      index > migrationIndex &&
      text.includes("INSERT INTO ia4tube_migrations.schema_migrations")
  );
  const commitIndex = texts.indexOf("COMMIT");
  const relationProfileReads = texts
    .map((text, index) => ({ text, index }))
    .filter(({ text }) =>
      text.includes("relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')")
    )
    .map(({ index }) => index);
  assert.ok(migrationIndex >= 0);
  assert.ok(ledgerIndex > migrationIndex);
  assert.equal(relationProfileReads.length, 3);
  assert.ok(relationProfileReads[0] < migrationIndex);
  assert.ok(relationProfileReads[1] > ledgerIndex);
  assert.ok(relationProfileReads[1] < commitIndex);
  assert.ok(relationProfileReads[2] > commitIndex);
  assert.equal(
    texts.some((text) =>
      text.includes("CREATE TABLE IF NOT EXISTS ia4tube_migrations.schema_migrations")
    ),
    false
  );
  const firstFunctionalMutation = texts.find((text) =>
    /^(CREATE|ALTER|DROP|GRANT|REVOKE|INSERT|UPDATE|DELETE|TRUNCATE)\b/i.test(
      text.trimStart()
    )
  );
  assert.ok(
    firstFunctionalMutation.includes(
      "ALTER TABLE ia4tube_social.social_connections"
    )
  );
  assert.equal(texts.at(-1).includes("pg_advisory_unlock"), true);
  assert.equal(harness.state.released, true);
});

test("apply-exact rolls back every failure point before COMMIT", async () => {
  const cases = [
    {
      name: "migration beginning",
      options: {
        failOn: (text) =>
          text.startsWith("ALTER TABLE ia4tube_social.social_connections")
      },
      code: undefined
    },
    {
      name: "migration middle",
      options: {
        failOn: (text) =>
          text.includes("CREATE TABLE ia4tube_social.social_publication_attempts")
      },
      code: undefined
    },
    {
      name: "before ledger",
      options: {
        failOn: (text, values) =>
          text.includes("INSERT INTO ia4tube_migrations.schema_migrations") &&
          values[0] === SOCIAL_CONNECTOR_PERSISTENCE_MIGRATION
      },
      code: undefined
    },
    {
      name: "after ledger",
      options: (() => {
        let reads = 0;
        return {
          failOn: (text) => {
            if (
              text.includes("WHERE namespace.nspname = 'ia4tube_social'") &&
              text.includes("AS routine_count")
            ) {
              reads += 1;
              return reads === 2;
            }
            return false;
          }
        };
      })(),
      code: undefined
    },
    {
      name: "precommit profile validation",
      options: {
        mutateExactRows({ kind, profile, rows }) {
          if (kind !== "constraints" || profile !== EXACT_TO_PROFILE) return rows;
          return rows.map((row, index) =>
            index === 0 ? { ...row, table_name: "wrong_table" } : row
          );
        }
      },
      code: "migration_exact_constraints_profile_mismatch"
    }
  ];

  for (const candidate of cases) {
    const harness = exactMigrationHarness(candidate.options);
    await assert.rejects(
      runnerFor(harness).applyExact(exactApplyRequest, exactApprovalEnvironment),
      candidate.code ? { code: candidate.code } : /synthetic migration failure/,
      candidate.name
    );
    assert.deepEqual(
      harness.state.applied.map((row) => row.version),
      EXACT_BASE_MIGRATIONS,
      candidate.name
    );
    assert.equal(harness.state.physicalProfile, EXACT_FROM_PROFILE, candidate.name);
    assert.equal(harness.state.commitAttempts, 0, candidate.name);
    assert.ok(
      harness.state.queries.some((query) => query.text === "ROLLBACK"),
      candidate.name
    );
    assert.equal(
      harness.state.queries.at(-1).text.includes("pg_advisory_unlock"),
      true,
      candidate.name
    );
  }
});

test("apply-exact reports postcommit validation failure without claiming rollback", async () => {
  let socialSchemaReads = 0;
  const harness = exactMigrationHarness({
    failOn(text) {
      if (
        text.includes("WHERE namespace.nspname = 'ia4tube_social'") &&
        text.includes("AS routine_count")
      ) {
        socialSchemaReads += 1;
        return socialSchemaReads === 3;
      }
      return false;
    }
  });
  let failure;
  try {
    await runnerFor(harness).applyExact(
      exactApplyRequest,
      exactApprovalEnvironment
    );
    assert.fail("postcommit validation failure must be explicit");
  } catch (error) {
    failure = error;
  }
  assert.equal(failure.code, "migration_exact_postcommit_validation_failed");
  assert.equal(failure.applied, true);
  assert.equal(failure.retryAllowed, false);
  assert.equal(failure.requiresReadOnlyInspection, true);
  assert.equal(Boolean(failure.discardClient), false);
  assert.equal(harness.state.commitAttempts, 1);
  assert.equal(harness.state.physicalProfile, EXACT_TO_PROFILE);
  assert.equal(
    harness.state.applied.filter(
      (row) => row.version === SOCIAL_CONNECTOR_PERSISTENCE_MIGRATION
    ).length,
    1
  );
  assert.equal(harness.state.exactMigrationExecutions, 1);
  assert.equal(harness.state.queries.at(-1).text.includes("pg_advisory_unlock"), true);
});

test("apply-exact classifies an ambiguous COMMIT and never retries or rolls back", async () => {
  const harness = exactMigrationHarness({
    commitThrows: true,
    commitOutcomeApplied: true
  });
  let failure;
  try {
    await runnerFor(harness).applyExact(
      exactApplyRequest,
      exactApprovalEnvironment
    );
    assert.fail("ambiguous commit must fail closed");
  } catch (error) {
    failure = error;
  }
  assert.equal(failure.code, "migration_exact_commit_outcome_unknown");
  assert.equal(failure.discardClient, true);
  assert.equal(failure.applied, undefined);
  assert.equal(failure.outcomeUnknown, true);
  assert.equal(failure.retryAllowed, false);
  assert.equal(failure.requiresReadOnlyInspection, true);
  assert.equal(harness.state.commitAttempts, 1);
  assert.equal(harness.state.exactMigrationExecutions, 1);
  assert.equal(harness.state.physicalProfile, EXACT_TO_PROFILE);
  assert.equal(
    harness.state.applied.filter(
      (row) => row.version === SOCIAL_CONNECTOR_PERSISTENCE_MIGRATION
    ).length,
    1
  );
  const commitIndex = harness.state.queries.findIndex(
    (query) => query.text === "COMMIT"
  );
  assert.ok(commitIndex >= 0);
  assert.equal(
    harness.state.queries.slice(commitIndex + 1).some(
      (query) => query.text === "ROLLBACK" ||
        query.text.includes("pg_advisory_unlock") ||
        query.text.includes("social_idempotency_operations")
    ),
    false
  );
  assert.equal(harness.state.releaseError, failure);
  assert.equal(harness.state.activeLocks, 0);
});

test("apply-exact discards the client when its rollback cannot be confirmed", async () => {
  const harness = exactMigrationHarness({
    failOn: (text) =>
      text.includes("CREATE TABLE ia4tube_social.social_publication_attempts"),
    rollbackFails: true
  });
  let failure;
  try {
    await runnerFor(harness).applyExact(
      exactApplyRequest,
      exactApprovalEnvironment
    );
    assert.fail("rollback failure must discard the client");
  } catch (error) {
    failure = error;
  }
  assert.equal(failure.code, "migration_exact_rollback_failed");
  assert.equal(failure.discardClient, true);
  assert.equal(harness.state.releaseError, failure);
  assert.equal(harness.state.commitAttempts, 0);
});

test("apply-exact discards a committed session when postcommit rollback is unconfirmed", async () => {
  const harness = exactMigrationHarness({ rollbackFails: true });
  let failure;
  try {
    await runnerFor(harness).applyExact(
      exactApplyRequest,
      exactApprovalEnvironment
    );
    assert.fail("postcommit rollback failure must fail closed");
  } catch (error) {
    failure = error;
  }
  assert.equal(failure.code, "migration_exact_postcommit_validation_failed");
  assert.equal(failure.applied, true);
  assert.equal(failure.retryAllowed, false);
  assert.equal(failure.requiresReadOnlyInspection, true);
  assert.equal(failure.discardClient, true);
  assert.equal(failure.skipAdvisoryUnlock, true);
  assert.equal(failure.cause?.code, "migration_exact_rollback_failed");
  assert.equal(harness.state.commitAttempts, 1);
  assert.equal(harness.state.exactMigrationExecutions, 1);
  assert.equal(harness.state.physicalProfile, EXACT_TO_PROFILE);
  assert.equal(
    harness.state.queries.some((query) =>
      query.text.includes("pg_advisory_unlock")
    ),
    false
  );
  assert.equal(harness.state.releaseError, failure);
  assert.equal(harness.state.activeLocks, 0);
});

test("apply-exact marks postcommit advisory unlock failures as applied and non-retryable", async () => {
  for (const options of [
    { unlockValue: false },
    { unlockThrows: true }
  ]) {
    const harness = exactMigrationHarness(options);
    let failure;
    try {
      await runnerFor(harness).applyExact(
        exactApplyRequest,
        exactApprovalEnvironment
      );
      assert.fail("postcommit unlock failure must fail closed");
    } catch (error) {
      failure = error;
    }
    assert.ok([
      "migration_advisory_unlock_not_owned",
      "migration_advisory_unlock_failed"
    ].includes(failure.code));
    assert.equal(failure.applied, true);
    assert.equal(failure.retryAllowed, false);
    assert.equal(failure.requiresReadOnlyInspection, true);
    assert.equal(failure.discardClient, true);
    assert.equal(harness.state.commitAttempts, 1);
    assert.equal(harness.state.exactMigrationExecutions, 1);
    assert.equal(harness.state.physicalProfile, EXACT_TO_PROFILE);
    assert.equal(
      harness.state.applied.filter(
        (row) => row.version === SOCIAL_CONNECTOR_PERSISTENCE_MIGRATION
      ).length,
      1
    );
    assert.equal(harness.state.releaseError, failure);
    assert.equal(harness.state.activeLocks, 0);
  }
});

test("two apply-exact runners produce one winner and one pending-set refusal", async () => {
  const harness = exactMigrationHarness({ exactMigrationDelayMs: 10 });
  const outcomes = await Promise.allSettled([
    runnerFor(harness).applyExact(exactApplyRequest, exactApprovalEnvironment),
    runnerFor(harness).applyExact(exactApplyRequest, exactApprovalEnvironment)
  ]);
  const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
  const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason?.code, "exact_pending_set_mismatch");
  assert.equal(fulfilled[0].value.appliedMigration, SOCIAL_CONNECTOR_PERSISTENCE_MIGRATION);
  assert.equal(harness.state.lockWaits, 1);
  assert.equal(harness.state.maxActiveLocks, 1);
  assert.equal(harness.state.activeLocks, 0);
  assert.equal(harness.state.exactMigrationExecutions, 1);
  assert.equal(
    harness.state.applied.filter(
      (row) => row.version === SOCIAL_CONNECTOR_PERSISTENCE_MIGRATION
    ).length,
    1
  );
});

test("reapplying all four migrations is idempotent at the ledger boundary", async () => {
  const harness = migrationPool();
  const runner = runnerFor(harness);
  const approval = {
    SOCIAL_MIGRATION_TARGET_FINGERPRINT: targetFingerprint(baseTarget)
  };
  const first = await runner.apply(approval);
  const second = await runner.apply(approval);
  assert.equal(first.length, 4);
  assert.equal(second.length, 0);
  assert.deepEqual(
    harness.state.applied.map((row) => row.version),
    [
      "0001_social_multitenant_foundation",
      "0002_social_connections_and_vault",
      "0003_global_vault_key_registry",
      "0004_social_connector_persistence"
    ]
  );
  assert.equal(
    new Set(harness.state.applied.map((row) => row.version)).size,
    4
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
    [0, 4]
  );
  assert.equal(harness.state.lockWaits, 1);
  assert.equal(harness.state.maxActiveLocks, 1);
  assert.equal(harness.state.activeLocks, 0);
  assert.equal(harness.state.applied.length, 4);
  assert.equal(
    new Set(harness.state.applied.map((row) => row.version)).size,
    4
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
  assert.match(source, /proveExact0004Route/);
  assert.match(source, /runnerA\.planExact/);
  assert.match(source, /runnerA\.applyExact/);
  assert.match(source, /exact_pending_set_mismatch/);
  assert.match(source, /recoveryEvidenceExternallyVerified/);
  assert.match(source, /readExactCatalogSnapshot/);
});
