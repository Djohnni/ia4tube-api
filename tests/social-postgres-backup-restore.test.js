"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { PassThrough, Readable, Writable } = require("node:stream");
const test = require("node:test");
const tls = require("node:tls");
const {
  BACKUP_APPROVAL,
  BACKUP_LOCK_ID,
  BACKUP_TABLES,
  EVIDENCE_TABLES,
  EXPECTED_MIGRATION_ROWS,
  MIGRATION_LOCK_ID,
  MIGRATOR_ROLE,
  OWNER_ROLE,
  PRE_0004_BACKUP_TABLES,
  PRE_0004_RLS_TABLES,
  POLICY_PREFIX,
  RESTORE_APPROVAL,
  RLS_TABLES,
  RUNTIME_ROLE,
  SCHEMA_PROFILES,
  SYSTEM_ROOT_BUNDLE_NAME,
  assertSecretFreePlan,
  bundleArchiveEntries,
  bundleArchiveNames,
  buildManifest,
  childConnectionEnvironment,
  cleanupSystemRootCertificateBundle,
  compareRestoredEvidence,
  createBackupDataScript,
  createEvidenceScript,
  createPostgresBackupOperator,
  createRestoreDataScript,
  createSystemRootCertificateBundle,
  inspectSystemRootCertificateBundle,
  loadBackupConfig,
  loadRestoreConfig,
  normalizeEvidence,
  psqlPlan,
  runLogicalBackup,
  runLogicalRestore,
  resolveSchemaProfile,
  targetFingerprint,
  temporaryPolicySql,
  validateManifestFiles
} = require("../src/persistence/postgres/backup-restore");
const {
  createEncryptedBundle,
  createOwnedWorkspace
} = require("../src/persistence/postgres/encrypted-backup-bundle");
const {
  ADVISORY_LOCK_ID
} = require("../src/persistence/postgres/migrations");
const {
  MAX_TOOL_RUNTIME_MS,
  TOOL_TERMINATION_GRACE_MS,
  closeOperatorPool,
  main,
  poolConfig,
  runTool,
  safeToolEnvironment,
  successPayload
} = require("../scripts/social-db-backup-restore");

const root = path.resolve(__dirname, "..");
const environmentId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const password = "Synthetic-Backup-Password-Only-123!";
const operatorPassword = "Synthetic-Operator-Password-Only-456!";
const bundleKey = Buffer.alloc(32, 23).toString("base64");
const sourceTarget = Object.freeze({
  host: "synthetic-db.example.test",
  port: "5432",
  database: "ia4tube_social_synthetic",
  login: "synthetic_migration_login"
});
const targetTarget = Object.freeze({
  host: "synthetic-restore.example.test",
  port: "5432",
  database: "ia4tube_social_disposable_restore",
  login: "synthetic_migration_login"
});
const sourceOperatorTarget = Object.freeze({
  ...sourceTarget,
  login: "synthetic_provisioner"
});
const targetOperatorTarget = Object.freeze({
  ...targetTarget,
  login: "synthetic_provisioner"
});
const tools = Object.freeze({
  dump: "C:\\PostgreSQL\\18\\bin\\pg_dump.exe",
  restore: "C:\\PostgreSQL\\18\\bin\\pg_restore.exe",
  psql: "C:\\PostgreSQL\\18\\bin\\psql.exe"
});
const VAULT_CONSTRAINT = Object.freeze({
  schema_name: "ia4tube_social",
  table_name: "social_encrypted_credentials",
  constraint_name: "social_encrypted_credentials_key_version_fk",
  constraint_type: "f"
});
const PROFILE_0004_UNVALIDATED_CONSTRAINTS = Object.freeze([
  Object.freeze({
    schema_name: "ia4tube_social",
    table_name: "social_external_accounts",
    constraint_name: "social_external_accounts_instagram_professional",
    constraint_type: "c"
  }),
  Object.freeze({
    schema_name: "ia4tube_social",
    table_name: "social_oauth_transactions",
    constraint_name: "social_oauth_transactions_connection_fk",
    constraint_type: "f"
  }),
  Object.freeze({
    schema_name: "ia4tube_social",
    table_name: "social_audit_events",
    constraint_name: "social_audit_events_reference_provider_present",
    constraint_type: "c"
  }),
  Object.freeze({
    schema_name: "ia4tube_social",
    table_name: "social_audit_events",
    constraint_name: "social_audit_events_connection_provider_fk",
    constraint_type: "f"
  }),
  Object.freeze({
    schema_name: "ia4tube_social",
    table_name: "social_audit_events",
    constraint_name: "social_audit_events_publication_provider_fk",
    constraint_type: "f"
  })
]);

function catalogConstraintRow(constraint, validated = true, overrides = {}) {
  return {
    ...constraint,
    validated,
    definition: `synthetic-${constraint.constraint_name}`,
    ...overrides
  };
}

function profile0004ConstraintRows(validated = false) {
  return [
    catalogConstraintRow(VAULT_CONSTRAINT, true),
    ...PROFILE_0004_UNVALIDATED_CONSTRAINTS.map((constraint, index) => (
      catalogConstraintRow(
        constraint,
        typeof validated === "function"
          ? validated(constraint, index)
          : validated
      )
    ))
  ];
}

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "ia4tube-social-backup-test-")
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function systemRootsFixture(t, directory) {
  const workspace = createOwnedWorkspace({
    root: directory,
    purpose: "tls-test"
  });
  const bundle = createSystemRootCertificateBundle({ workspace });
  return { bundle, workspace };
}

function backupEnvironment(directory, overrides = {}) {
  return {
    SOCIAL_BACKUP_APPROVED: BACKUP_APPROVAL,
    SOCIAL_BACKUP_DIRECTORY_PROTECTED: "true",
    SOCIAL_BACKUP_OUTPUT_DIRECTORY: directory,
    SOCIAL_BACKUP_LABEL: "synthetic-2b0",
    SOCIAL_BACKUP_SOURCE_DATABASE_URL:
      `postgresql://${sourceTarget.login}:` +
      `${encodeURIComponent(password)}@${sourceTarget.host}:` +
      `${sourceTarget.port}/${sourceTarget.database}?sslmode=verify-full`,
    SOCIAL_BACKUP_SOURCE_EXPECTED_HOST: sourceTarget.host,
    SOCIAL_BACKUP_SOURCE_EXPECTED_PORT: sourceTarget.port,
    SOCIAL_BACKUP_SOURCE_EXPECTED_DATABASE: sourceTarget.database,
    SOCIAL_BACKUP_SOURCE_EXPECTED_LOGIN: sourceTarget.login,
    SOCIAL_BACKUP_EXPECTED_MIGRATION_LOGIN: sourceTarget.login,
    SOCIAL_BACKUP_EXPECTED_RUNTIME_LOGIN: "synthetic_runtime_login",
    SOCIAL_BACKUP_SOURCE_EXPECTED_FINGERPRINT:
      targetFingerprint(sourceTarget),
    SOCIAL_BACKUP_OPERATOR_PROVISIONER_DATABASE_URL:
      `postgresql://${sourceOperatorTarget.login}:` +
      `${encodeURIComponent(operatorPassword)}@${sourceOperatorTarget.host}:` +
      `${sourceOperatorTarget.port}/${sourceOperatorTarget.database}` +
      "?sslmode=verify-full",
    SOCIAL_BACKUP_OPERATOR_EXPECTED_HOST: sourceOperatorTarget.host,
    SOCIAL_BACKUP_OPERATOR_EXPECTED_PORT: sourceOperatorTarget.port,
    SOCIAL_BACKUP_OPERATOR_EXPECTED_DATABASE:
      sourceOperatorTarget.database,
    SOCIAL_BACKUP_OPERATOR_EXPECTED_LOGIN: sourceOperatorTarget.login,
    SOCIAL_BACKUP_OPERATOR_EXPECTED_FINGERPRINT:
      targetFingerprint(sourceOperatorTarget),
    SOCIAL_BACKUP_EXPECTED_ENVIRONMENT_ID: environmentId,
    SOCIAL_BACKUP_EXPECTED_ENVIRONMENT: "test",
    SOCIAL_BACKUP_BUNDLE_KEY: bundleKey,
    SOCIAL_BACKUP_PG_DUMP_PATH: tools.dump,
    SOCIAL_BACKUP_PG_RESTORE_PATH: tools.restore,
    SOCIAL_BACKUP_PSQL_PATH: tools.psql,
    ...overrides
  };
}

function restoreEnvironment(directory, manifest, overrides = {}) {
  return {
    SOCIAL_RESTORE_APPROVED: RESTORE_APPROVAL,
    SOCIAL_RESTORE_WORK_DIRECTORY_PROTECTED: "true",
    SOCIAL_RESTORE_WORK_DIRECTORY: directory,
    SOCIAL_RESTORE_BUNDLE: manifest,
    SOCIAL_RESTORE_LABEL: "synthetic-2b0",
    SOCIAL_BACKUP_BUNDLE_KEY: bundleKey,
    SOCIAL_RESTORE_TARGET_DATABASE_URL:
      `postgresql://${targetTarget.login}:` +
      `${encodeURIComponent(password)}@${targetTarget.host}:` +
      `${targetTarget.port}/${targetTarget.database}?sslmode=verify-full`,
    SOCIAL_RESTORE_TARGET_EXPECTED_HOST: targetTarget.host,
    SOCIAL_RESTORE_TARGET_EXPECTED_PORT: targetTarget.port,
    SOCIAL_RESTORE_TARGET_EXPECTED_DATABASE: targetTarget.database,
    SOCIAL_RESTORE_TARGET_EXPECTED_LOGIN: targetTarget.login,
    SOCIAL_RESTORE_EXPECTED_MIGRATION_LOGIN: targetTarget.login,
    SOCIAL_RESTORE_EXPECTED_RUNTIME_LOGIN: "synthetic_runtime_login",
    SOCIAL_RESTORE_TARGET_EXPECTED_FINGERPRINT:
      targetFingerprint(targetTarget),
    SOCIAL_RESTORE_OPERATOR_PROVISIONER_DATABASE_URL:
      `postgresql://${targetOperatorTarget.login}:` +
      `${encodeURIComponent(operatorPassword)}@${targetOperatorTarget.host}:` +
      `${targetOperatorTarget.port}/${targetOperatorTarget.database}` +
      "?sslmode=verify-full",
    SOCIAL_RESTORE_OPERATOR_EXPECTED_HOST: targetOperatorTarget.host,
    SOCIAL_RESTORE_OPERATOR_EXPECTED_PORT: targetOperatorTarget.port,
    SOCIAL_RESTORE_OPERATOR_EXPECTED_DATABASE:
      targetOperatorTarget.database,
    SOCIAL_RESTORE_OPERATOR_EXPECTED_LOGIN: targetOperatorTarget.login,
    SOCIAL_RESTORE_OPERATOR_EXPECTED_FINGERPRINT:
      targetFingerprint(targetOperatorTarget),
    SOCIAL_RESTORE_SOURCE_FINGERPRINT: targetFingerprint(sourceTarget),
    SOCIAL_RESTORE_PG_RESTORE_PATH: tools.restore,
    SOCIAL_RESTORE_PSQL_PATH: tools.psql,
    ...overrides
  };
}

function safeCatalog(overrides = {}) {
  return {
    rlsTableCount: RLS_TABLES.length,
    forcedRlsTableCount: RLS_TABLES.length,
    transientPolicyCount: 0,
    canonicalRoleCount: 3,
    runtimeEscalationPossible: false,
    requiredConstraintsPresent: true,
    compatibleWith2A: true,
    policyDigest: "1".repeat(64),
    constraintDigest: "2".repeat(64),
    roleDigest: "3".repeat(64),
    ...overrides
  };
}

function safeBootstrapInfrastructure() {
  return {
    public_database_acl_absent: true,
    public_schema_create_absent: true,
    nologin_roles_exact: true,
    provisioner_admin_memberships_exact: true,
    canonical_role_memberships_restricted: true,
    owner_migrator_membership_exact: true,
    canonical_role_topology_exact: true
  };
}

function safePermanentLogin() {
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
    direct_membership_count: 1,
    expected_membership_exact: true,
    role_members_count: 1,
    role_administration_exact: true,
    direct_database_acl_count: 1,
    direct_connect_exact: true,
    database_create: false,
    database_temp: false,
    schema_create: false,
    owns_objects: false,
    cluster_ownership_dependency: false,
    table_truncate: false
  };
}

function catalogInspectionClient(profile, constraintRows) {
  return {
    async query(text) {
      if (text.includes("pg_advisory_lock")) return { rows: [{}] };
      if (text.includes("pg_advisory_unlock")) {
        return { rows: [{ unlocked: true }] };
      }
      if (text.includes("login_bootstrap_infrastructure")) {
        return { rows: [safeBootstrapInfrastructure()] };
      }
      if (text.includes("login_bootstrap_login */")) {
        return { rows: [safePermanentLogin()] };
      }
      if (text.includes("AS rls_table_count")) {
        return {
          rows: [{
            rls_table_count: profile.rlsTables.length,
            enabled_rls_table_count: profile.rlsTables.length,
            forced_rls_table_count: profile.rlsTables.length
          }]
        };
      }
      if (text.startsWith("SELECT rolname, rolcanlogin")) {
        return {
          rows: [OWNER_ROLE, MIGRATOR_ROLE, RUNTIME_ROLE].map(
            (rolname) => ({
              rolname,
              rolcanlogin: false,
              rolsuper: false,
              rolcreatedb: false,
              rolcreaterole: false,
              rolinherit: false,
              rolreplication: false,
              rolbypassrls: false
            })
          )
        };
      }
      if (text.startsWith("SELECT granted.rolname")) {
        return {
          rows: [{
            granted_role: OWNER_ROLE,
            member_role: MIGRATOR_ROLE,
            admin_option: false,
            inherit_option: false,
            set_option: true
          }]
        };
      }
      if (text.startsWith("SELECT tablename, policyname")) {
        return { rows: [] };
      }
      if (text.includes("constraint_info.conname")) {
        return { rows: constraintRows.map((row) => ({ ...row })) };
      }
      if (text.includes("AS compatible_with_2a")) {
        return { rows: [{ compatible_with_2a: true }] };
      }
      if (text.includes("transient_policy_count")) {
        return { rows: [{ transient_policy_count: 0 }] };
      }
      throw new Error("unexpected catalog contract query");
    },
    release() {}
  };
}

async function collectProfileCatalog(t, profile, constraintRows) {
  const directory = temporaryDirectory(t);
  const config = loadBackupConfig(backupEnvironment(directory), {
    repositoryRoot: root
  });
  const client = catalogInspectionClient(profile, constraintRows);
  const operator = createPostgresBackupOperator({
    async connect() {
      return client;
    }
  });
  await operator.acquireLocks([MIGRATION_LOCK_ID, BACKUP_LOCK_ID]);
  try {
    return await operator.collectCatalogEvidence(config, profile);
  } finally {
    await operator.releaseLocks([BACKUP_LOCK_ID, MIGRATION_LOCK_ID]);
  }
}

function safeSnapshot(overrides = {}) {
  return {
    tableCounts: EVIDENCE_TABLES.map((table, index) => ({
      table,
      count: index + 1
    })),
    migrations: EXPECTED_MIGRATION_ROWS.map((migration) => ({
      ...migration
    })),
    ...overrides
  };
}

function safeEvidence(overrides = {}) {
  return {
    ...safeSnapshot(),
    catalog: safeCatalog(),
    ...overrides
  };
}

function profileCatalog(profile, overrides = {}) {
  return safeCatalog({
    rlsTableCount: profile.rlsTables.length,
    forcedRlsTableCount: profile.rlsTables.length,
    ...overrides
  });
}

function profileSnapshot(profile, overrides = {}) {
  return {
    tableCounts: profile.evidenceTables.map((table, index) => ({
      table,
      count: index + 1
    })),
    migrations: profile.migrationRows.map((migration) => ({ ...migration })),
    ...overrides
  };
}

function profileEvidence(profile, overrides = {}) {
  return {
    ...profileSnapshot(profile),
    catalog: profileCatalog(profile),
    ...overrides
  };
}

function archiveList(profile = SCHEMA_PROFILES.at(-1)) {
  return profile.backupTables.map((table) => {
    const [schema, name] = table.split(".");
    return `TABLE ${schema} ${name}`;
  }).join("\n");
}

function planOutputFile(plan) {
  const match = String(plan?.input || "").match(/^\\o '((?:[^']|'')+)'$/m);
  return match ? match[1].replace(/''/g, "'") : null;
}

function mockOperator(
  events,
  catalog = safeCatalog(),
  schemaProfile = SCHEMA_PROFILES.at(-1)
) {
  return {
    async acquireLocks(ids) {
      events.push(["acquire", ...ids]);
    },
    async preflight() {
      events.push(["preflight"]);
      return schemaProfile;
    },
    async preflightEmptyTarget() {
      events.push(["preflight-empty"]);
    },
    async assertTransientPoliciesAbsent() {
      events.push(["policies-absent"]);
    },
    async collectCatalogEvidence() {
      events.push(["catalog"]);
      return catalog;
    },
    async releaseLocks(ids) {
      events.push(["release", ...ids]);
    }
  };
}

function createBundle(t, profile = SCHEMA_PROFILES.at(-1)) {
  const directory = temporaryDirectory(t);
  const config = loadBackupConfig(backupEnvironment(directory), {
    repositoryRoot: root
  });
  createOwnedWorkspace({
    root: config.outputDirectory,
    purpose: config.workspace.purpose,
    id: config.workspace.id
  });
  fs.writeFileSync(config.files.schema, "synthetic schema archive");
  for (const table of profile.backupTables) {
    fs.writeFileSync(
      config.files.data[table],
      `-- ${table}\nINSERT synthetic;\n`
    );
  }
  const evidence = normalizeEvidence(profileEvidence(profile));
  const manifest = buildManifest({
    config,
    evidence,
    generatedAt: "2026-07-29T12:00:00.000Z"
  });
  fs.writeFileSync(config.files.manifest, `${JSON.stringify(manifest)}\n`);
  return { config, directory, evidence, manifest };
}

async function createEncryptedFixture(t, profile = SCHEMA_PROFILES.at(-1)) {
  const bundle = createBundle(t, profile);
  const encrypted = await createEncryptedBundle({
    entries: bundleArchiveEntries(bundle.config, profile),
    expectedNames: bundleArchiveNames(profile),
    outputPath: bundle.config.files.bundle,
    label: bundle.config.label,
    sourceFingerprint: bundle.config.sourceFingerprint,
    bundleKey: bundle.config.bundleKey
  });
  return { ...bundle, encrypted };
}

async function createLegacy0003EncryptedFixture(t) {
  const profile = SCHEMA_PROFILES[0];
  const bundle = createBundle(t, profile);
  const legacyManifest = JSON.parse(JSON.stringify(bundle.manifest));
  legacyManifest.format = 2;
  delete legacyManifest.schemaProfile;
  fs.writeFileSync(
    bundle.config.files.manifest,
    `${JSON.stringify(legacyManifest)}\n`
  );
  const encrypted = await createEncryptedBundle({
    entries: bundleArchiveEntries(bundle.config, profile),
    expectedNames: bundleArchiveNames(profile),
    outputPath: bundle.config.files.bundle,
    label: bundle.config.label,
    sourceFingerprint: bundle.config.sourceFingerprint,
    bundleKey: bundle.config.bundleKey
  });
  return { ...bundle, encrypted, legacyManifest, profile };
}

test("backup and restore configs require exact protected isolated targets", (t) => {
  const directory = temporaryDirectory(t);
  const config = loadBackupConfig(backupEnvironment(directory), {
    repositoryRoot: root
  });
  assert.equal(config.source.public.login, sourceTarget.login);
  assert.equal(
    config.operator.public.login,
    sourceOperatorTarget.login
  );
  assert.equal(
    targetFingerprint(config.operator.public),
    config.sourceFingerprint
  );
  assert.deepEqual(config.permanentLogins, {
    migrationLogin: sourceTarget.login,
    runtimeLogin: "synthetic_runtime_login"
  });
  assert.equal(config.sourceFingerprint, targetFingerprint(sourceTarget));
  assert.equal(Buffer.isBuffer(config.bundleKey), true);
  assert.equal(Object.keys(config).includes("bundleKey"), false);
  assert.equal(Object.keys(config.source).includes("parsed"), false);
  assert.equal(Object.keys(config.operator).includes("parsed"), false);
  assert.equal(
    path.dirname(config.files.schema),
    config.workspace.path
  );
  assert.equal(
    path.dirname(config.files.bundle),
    config.outputDirectory
  );
  assert.equal(fs.existsSync(config.workspace.path), false);
  const serializedBackupConfig = JSON.stringify(config);
  assert.equal(serializedBackupConfig.includes(bundleKey), false);
  assert.equal(serializedBackupConfig.includes(password), false);
  assert.equal(serializedBackupConfig.includes(operatorPassword), false);
  assert.equal(config.files.data.length, undefined);
  assert.equal(Object.keys(config.files.data).length, BACKUP_TABLES.length);

  assert.throws(
    () =>
      loadBackupConfig(
        backupEnvironment(directory, {
          SOCIAL_BACKUP_DIRECTORY_PROTECTED: "false"
        }),
        { repositoryRoot: root }
      ),
    { code: "backup_directory_protection_unconfirmed" }
  );
  assert.throws(
    () =>
      loadBackupConfig(
        backupEnvironment(root),
        { repositoryRoot: root }
      ),
    { code: "backup_output_inside_repository" }
  );
  assert.throws(
    () =>
      loadBackupConfig(
        backupEnvironment(directory, {
          SOCIAL_BACKUP_PSQL_PATH: "psql.exe"
        }),
        { repositoryRoot: root }
      ),
    { code: "backup_psql_path_invalid" }
  );
  assert.throws(
    () =>
      loadBackupConfig(
        backupEnvironment(directory, {
          SOCIAL_BACKUP_EXPECTED_RUNTIME_LOGIN: sourceTarget.login
        }),
        { repositoryRoot: root }
      ),
    { code: "backup_permanent_logins_invalid" }
  );
  assert.throws(
    () =>
      loadBackupConfig(
        backupEnvironment(directory, {
          SOCIAL_BACKUP_OPERATOR_PROVISIONER_DATABASE_URL:
            `postgresql://${sourceTarget.login}:` +
            `${encodeURIComponent(operatorPassword)}@${sourceTarget.host}:` +
            `${sourceTarget.port}/${sourceTarget.database}` +
            "?sslmode=verify-full",
          SOCIAL_BACKUP_OPERATOR_EXPECTED_LOGIN: sourceTarget.login
        }),
        { repositoryRoot: root }
      ),
    { code: "backup_operator_login_invalid" }
  );
  assert.throws(
    () =>
      loadBackupConfig(
        backupEnvironment(directory, {
          SOCIAL_BACKUP_OPERATOR_PROVISIONER_DATABASE_URL:
            `postgresql://${sourceOperatorTarget.login}:` +
            `${encodeURIComponent(password)}@${sourceOperatorTarget.host}:` +
            `${sourceOperatorTarget.port}/${sourceOperatorTarget.database}` +
            "?sslmode=verify-full"
        }),
        { repositoryRoot: root }
      ),
    { code: "backup_operator_secret_reused" }
  );
  assert.throws(
    () =>
      loadBackupConfig(
        backupEnvironment(directory, {
          SOCIAL_BACKUP_OPERATOR_PROVISIONER_DATABASE_URL:
            `postgresql://${sourceOperatorTarget.login}:` +
            `${encodeURIComponent(operatorPassword)}@` +
            "other-db.example.test:5432/" +
            `${sourceTarget.database}?sslmode=verify-full`,
          SOCIAL_BACKUP_OPERATOR_EXPECTED_HOST:
            "other-db.example.test",
          SOCIAL_BACKUP_OPERATOR_EXPECTED_FINGERPRINT:
            targetFingerprint({
              ...sourceOperatorTarget,
              host: "other-db.example.test"
            })
        }),
        { repositoryRoot: root }
      ),
    { code: "backup_operator_target_mismatch" }
  );

  const bundle = createBundle(t);
  const restore = loadRestoreConfig(
    restoreEnvironment(directory, bundle.config.files.manifest),
    { repositoryRoot: root }
  );
  assert.equal(restore.target.public.database, targetTarget.database);
  assert.equal(
    restore.operator.public.login,
    targetOperatorTarget.login
  );
  assert.equal(
    targetFingerprint(restore.operator.public),
    restore.targetFingerprint
  );
  assert.deepEqual(restore.permanentLogins, {
    migrationLogin: targetTarget.login,
    runtimeLogin: "synthetic_runtime_login"
  });
  const serializedRestoreConfig = JSON.stringify(restore);
  assert.equal(serializedRestoreConfig.includes(bundleKey), false);
  assert.equal(serializedRestoreConfig.includes(password), false);
  assert.equal(serializedRestoreConfig.includes(operatorPassword), false);
  assert.throws(
    () =>
      loadRestoreConfig(
        restoreEnvironment(directory, bundle.config.files.manifest, {
          SOCIAL_RESTORE_TARGET_DATABASE_URL:
            `postgresql://${targetTarget.login}:password@` +
            "synthetic-restore.example.test/ia4tube_social_production" +
            "?sslmode=verify-full",
          SOCIAL_RESTORE_TARGET_EXPECTED_DATABASE:
            "ia4tube_social_production",
          SOCIAL_RESTORE_TARGET_EXPECTED_FINGERPRINT: targetFingerprint({
            ...targetTarget,
            database: "ia4tube_social_production"
          }),
          SOCIAL_RESTORE_OPERATOR_PROVISIONER_DATABASE_URL:
            `postgresql://${targetOperatorTarget.login}:` +
            `${encodeURIComponent(operatorPassword)}@` +
            "synthetic-restore.example.test/" +
            "ia4tube_social_production?sslmode=verify-full",
          SOCIAL_RESTORE_OPERATOR_EXPECTED_DATABASE:
            "ia4tube_social_production",
          SOCIAL_RESTORE_OPERATOR_EXPECTED_FINGERPRINT: targetFingerprint({
            ...targetOperatorTarget,
            database: "ia4tube_social_production"
          })
        }),
        { repositoryRoot: root }
      ),
    { code: "restore_target_not_disposable" }
  );
});

test("operator pool is built only from the distinct provisioner connection", (t) => {
  const directory = temporaryDirectory(t);
  const config = loadBackupConfig(backupEnvironment(directory), {
    repositoryRoot: root
  });
  const pool = poolConfig(config.operator, config.postgresTls);
  const parsed = new URL(pool.connectionString);
  assert.equal(
    Object.prototype.hasOwnProperty.call(pool.ssl, "ca"),
    false
  );
  assert.equal(
    decodeURIComponent(parsed.username),
    sourceOperatorTarget.login
  );
  assert.notEqual(
    decodeURIComponent(parsed.username),
    config.source.public.login
  );
  assert.equal(parsed.hostname, config.source.public.host);
  assert.equal(
    decodeURIComponent(parsed.pathname.slice(1)),
    config.source.public.database
  );
});

test("CLI backup success reports only verifiable non-secret metadata", () => {
  const payload = successPayload("backup", {
    files: 1,
    bundleSize: 1234,
    bundleSha256: "a".repeat(64),
    bundleFileFsyncConfirmed: true,
    bundleDirectoryFsyncConfirmed: false,
    bundleRoundTripVerified: true,
    evidenceSha256: "b".repeat(64),
    temporaryWorkspaceCleanupConfirmed: true,
    plaintextArtifactsAbsent: true,
    bundle: "C:\\must-not-appear\\backup.ia4sb",
    bundleKey,
    password,
    operatorPassword
  });
  assert.deepEqual(payload, {
    ok: true,
    mode: "backup",
    evidenceVerified: true,
    evidenceSha256: "b".repeat(64),
    temporaryWorkspaceCleanupConfirmed: true,
    plaintextArtifactsAbsent: true,
    fileCount: 1,
    bundleSize: 1234,
    bundleSha256: "a".repeat(64),
    bundleFileFsyncConfirmed: true,
    bundleDirectoryFsyncConfirmed: false,
    bundleRoundTripVerified: true
  });
  const serialized = JSON.stringify(payload);
  assert.equal(serialized.includes("must-not-appear"), false);
  assert.equal(serialized.includes(bundleKey), false);
  assert.equal(serialized.includes(password), false);
  assert.equal(serialized.includes(operatorPassword), false);
});

test("CLI refuses backup metadata without an explicit directory durability result", () => {
  assert.throws(
    () =>
      successPayload("backup", {
        files: 1,
        bundleSize: 1234,
        bundleSha256: "a".repeat(64),
        bundleFileFsyncConfirmed: true,
        bundleRoundTripVerified: true,
        evidenceSha256: "b".repeat(64),
        temporaryWorkspaceCleanupConfirmed: true,
        plaintextArtifactsAbsent: true
      }),
    { code: "backup_result_metadata_invalid" }
  );
});

test("backup plaintext paths remain below the legacy Windows path limit", (t) => {
  const nested = path.join(
    temporaryDirectory(t),
    "a".repeat(48),
    "b".repeat(48)
  );
  fs.mkdirSync(nested, { recursive: true });
  const config = loadBackupConfig(backupEnvironment(nested), {
    repositoryRoot: root
  });
  const plaintextPaths = [
    config.files.schemaPartial,
    config.files.schema,
    config.files.evidencePartial,
    config.files.manifestPartial,
    config.files.manifest,
    ...Object.values(config.files.dataPartial),
    ...Object.values(config.files.data)
  ];
  assert.equal(
    plaintextPaths.every((file) => file.length < 260),
    true
  );
});

test("operator uses only provisioner locks and catalog inspection", async (t) => {
  const directory = temporaryDirectory(t);
  const config = loadBackupConfig(backupEnvironment(directory), {
    repositoryRoot: root
  });
  const bundle = createBundle(t);
  const restore = loadRestoreConfig(
    restoreEnvironment(directory, bundle.config.files.manifest),
    { repositoryRoot: root }
  );
  const events = [];
  const loginChecks = [];
  const client = {
    async query(text, values = []) {
      events.push(text);
      if (text.includes("pg_advisory_lock")) return { rows: [{}] };
      if (text.includes("pg_advisory_unlock")) {
        return { rows: [{ unlocked: true }] };
      }
      if (text.includes("login_bootstrap_infrastructure")) {
        return { rows: [safeBootstrapInfrastructure()] };
      }
      if (text.includes("login_bootstrap_login */")) {
        loginChecks.push(values);
        return { rows: [safePermanentLogin()] };
      }
      if (
        text.startsWith("SELECT version, checksum_sha256 AS checksum")
      ) {
        return { rows: EXPECTED_MIGRATION_ROWS };
      }
      if (text.includes("AS postgres_version_supported")) {
        return {
          rows: [{
            postgres_version_supported: true,
            database_exact: true,
            login_exact: true,
            database_owner_exact: true,
            login_enabled: true,
            superuser_absent: true,
            createrole_present: true,
            replication_absent: true,
            bypassrls_absent: true,
            canonical_set_absent: true
          }]
        };
      }
      if (text.includes("application_schema_count")) {
        return {
          rows: [{
            application_schema_count: 0,
            user_relation_count: 0,
            user_routine_count: 0,
            user_schema_count: 0,
            standalone_user_type_count: 0,
            event_trigger_count: 0,
            non_default_extension_count: 0,
            foreign_server_count: 0
          }]
        };
      }
      if (text.includes("AS rls_table_count")) {
        return {
          rows: [{
            rls_table_count: RLS_TABLES.length,
            enabled_rls_table_count: RLS_TABLES.length,
            forced_rls_table_count: RLS_TABLES.length
          }]
        };
      }
      if (text.startsWith("SELECT rolname, rolcanlogin")) {
        return {
          rows: [OWNER_ROLE, MIGRATOR_ROLE, RUNTIME_ROLE].map(
            (rolname) => ({
              rolname,
              rolcanlogin: false,
              rolsuper: false,
              rolcreatedb: false,
              rolcreaterole: false,
              rolinherit: false,
              rolreplication: false,
              rolbypassrls: false
            })
          )
        };
      }
      if (text.startsWith("SELECT granted.rolname")) {
        return {
          rows: [{
            granted_role: OWNER_ROLE,
            member_role: MIGRATOR_ROLE,
            admin_option: false,
            inherit_option: false,
            set_option: true
          }]
        };
      }
      if (text.startsWith("SELECT tablename, policyname")) {
        return { rows: [] };
      }
      if (text.includes("constraint_info.conname")) {
        return { rows: profile0004ConstraintRows(false) };
      }
      if (text.includes("AS compatible_with_2a")) {
        return { rows: [{ compatible_with_2a: true }] };
      }
      if (text.includes("transient_policy_count")) {
        return { rows: [{ transient_policy_count: 0 }] };
      }
      throw new Error("unexpected synthetic query");
    },
    release() {}
  };
  const operator = createPostgresBackupOperator({
    async connect() {
      return client;
    }
  });
  await operator.acquireLocks([MIGRATION_LOCK_ID, BACKUP_LOCK_ID]);
  const inspectedProfile = await operator.preflight(config);
  await operator.preflightEmptyTarget(restore);
  const catalog = await operator.collectCatalogEvidence(config);
  await operator.releaseLocks([BACKUP_LOCK_ID, MIGRATION_LOCK_ID]);

  assert.equal(catalog.runtimeEscalationPossible, false);
  assert.equal(catalog.requiredConstraintsPresent, true);
  assert.deepEqual(
    loginChecks.map((values) => values[2]),
    [2, 9, 2, 9, 2, 9]
  );
  assert.equal(events.includes("BEGIN"), false);
  assert.equal(events.some((text) => /\bSET\s+(?:LOCAL\s+)?ROLE\b/i.test(text)), false);
  assert.equal(events.some((text) => text.includes("environment_identity")), false);
  assert.equal(inspectedProfile.id, "social-schema-0004");
  assert.equal(
    events.filter((text) => text.includes("schema_migrations")).length,
    1
  );
  assert.equal(
    events.some(
      (text) =>
        text.includes("schema_migrations") &&
        /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP)\b/i.test(text)
    ),
    false
  );
});

test("catalog constraints are closed per authenticated schema profile", async (t) => {
  const profile0003 = SCHEMA_PROFILES[0];
  const profile0004 = SCHEMA_PROFILES[1];

  async function accepted(context, profile, rows) {
    const catalog = await collectProfileCatalog(context, profile, rows);
    assert.equal(catalog.requiredConstraintsPresent, true);
    const evidence = normalizeEvidence(
      profileEvidence(profile, { catalog }),
      profile
    );
    assert.equal(evidence.catalog.requiredConstraintsPresent, true);
    return { catalog, evidence };
  }

  async function refused(context, profile, rows) {
    const catalog = await collectProfileCatalog(context, profile, rows);
    assert.equal(catalog.requiredConstraintsPresent, false);
    assert.throws(
      () => normalizeEvidence(profileEvidence(profile, { catalog }), profile),
      { code: "backup_catalog_state_invalid" }
    );
    return catalog;
  }

  await t.test("0003 accepts a fully validated catalog", async (context) => {
    await accepted(
      context,
      profile0003,
      [catalogConstraintRow(VAULT_CONSTRAINT, true)]
    );
  });

  await t.test("0003 refuses every unvalidated constraint", async (context) => {
    await refused(context, profile0003, [
      catalogConstraintRow(VAULT_CONSTRAINT, true),
      catalogConstraintRow(PROFILE_0004_UNVALIDATED_CONSTRAINTS[0], false)
    ]);
  });

  await t.test("0004 accepts all five intentional constraints unvalidated", async (context) => {
    await accepted(context, profile0004, profile0004ConstraintRows(false));
  });

  await t.test("0004 accepts all five constraints validated", async (context) => {
    await accepted(context, profile0004, profile0004ConstraintRows(true));
  });

  await t.test("0004 accepts a mixed validation state", async (context) => {
    await accepted(
      context,
      profile0004,
      profile0004ConstraintRows((_constraint, index) => index % 2 === 0)
    );
  });

  for (const required of PROFILE_0004_UNVALIDATED_CONSTRAINTS) {
    await t.test(`0004 refuses missing ${required.constraint_name}`, async (context) => {
      await refused(
        context,
        profile0004,
        profile0004ConstraintRows(false).filter(
          (row) => row.constraint_name !== required.constraint_name
        )
      );
    });
  }

  await t.test("0004 refuses a sixth unvalidated constraint", async (context) => {
    await refused(context, profile0004, [
      ...profile0004ConstraintRows(false),
      catalogConstraintRow({
        schema_name: "ia4tube_social",
        table_name: "social_connections",
        constraint_name: "social_connections_sixth_unvalidated",
        constraint_type: "c"
      }, false)
    ]);
  });

  for (const [field, value] of [
    ["schema_name", "ia4tube_social_admin"],
    ["table_name", "social_connections"],
    ["constraint_name", "social_external_accounts_professional"],
    ["constraint_type", "f"]
  ]) {
    await t.test(`0004 refuses an authorized identity with wrong ${field}`, async (context) => {
      const rows = profile0004ConstraintRows(false);
      rows[1] = { ...rows[1], [field]: value };
      await refused(context, profile0004, rows);
    });
  }

  await t.test("0004 accepts an additional validated constraint", async (context) => {
    await accepted(context, profile0004, [
      ...profile0004ConstraintRows(false),
      catalogConstraintRow({
        schema_name: "ia4tube_social",
        table_name: "social_connections",
        constraint_name: "social_connections_additional_validated",
        constraint_type: "c"
      }, true)
    ]);
  });

  await t.test("every profile requires the exact vault foreign key", async (context) => {
    await refused(
      context,
      profile0004,
      profile0004ConstraintRows(false).filter(
        (row) => row.constraint_name !== VAULT_CONSTRAINT.constraint_name
      )
    );
  });

  for (const invalid of [undefined, "false"]) {
    await t.test(`validated state ${String(invalid)} is refused`, async (context) => {
      const rows = profile0004ConstraintRows(false);
      if (invalid === undefined) delete rows[1].validated;
      else rows[1].validated = invalid;
      await refused(context, profile0004, rows);
    });
  }

  await t.test("0003 does not inherit the 0004 allowlist", async (context) => {
    await refused(context, profile0003, [
      catalogConstraintRow(VAULT_CONSTRAINT, true),
      ...PROFILE_0004_UNVALIDATED_CONSTRAINTS.map((constraint) => (
        catalogConstraintRow(constraint, false)
      ))
    ]);
  });

  await t.test("a similar prefix never authorizes an unvalidated constraint", async (context) => {
    await refused(context, profile0004, [
      ...profile0004ConstraintRows(false),
      catalogConstraintRow({
        schema_name: "ia4tube_social",
        table_name: "social_external_accounts",
        constraint_name:
          "social_external_accounts_instagram_professional_similar",
        constraint_type: "c"
      }, false)
    ]);
  });

  await t.test("duplicate canonical identities are refused", async (context) => {
    const rows = profile0004ConstraintRows(false);
    rows.push({ ...rows[1] });
    await refused(context, profile0004, rows);
  });

  await t.test("an unknown profile is refused as invalid catalog state", async (context) => {
    await assert.rejects(
      collectProfileCatalog(
        context,
        { ...profile0004, id: "social-schema-unknown" },
        profile0004ConstraintRows(false)
      ),
      { code: "backup_catalog_state_invalid" }
    );
  });

  await t.test("constraint digest preserves the observed validation state", async (context) => {
    const unvalidated = await collectProfileCatalog(
      context,
      profile0004,
      profile0004ConstraintRows(false)
    );
    const validated = await collectProfileCatalog(
      context,
      profile0004,
      profile0004ConstraintRows(true)
    );
    assert.notEqual(unvalidated.constraintDigest, validated.constraintDigest);
  });

  await t.test("public evidence contains no constraint names or definitions", async (context) => {
    const { evidence } = await accepted(
      context,
      profile0004,
      profile0004ConstraintRows(false)
    );
    const serialized = JSON.stringify(evidence);
    for (const constraint of [
      VAULT_CONSTRAINT,
      ...PROFILE_0004_UNVALIDATED_CONSTRAINTS
    ]) {
      assert.equal(serialized.includes(constraint.constraint_name), false);
    }
    assert.equal(serialized.includes("synthetic-"), false);
  });

  assert.throws(
    () => normalizeEvidence(profileEvidence(profile0004, {
      catalog: profileCatalog(profile0004, {
        requiredConstraintsPresent: false
      })
    })),
    { code: "backup_catalog_state_invalid" }
  );
});

test("backup data is exported under owner-only policies in one transaction", (t) => {
  const directory = temporaryDirectory(t);
  const config = loadBackupConfig(backupEnvironment(directory), {
    repositoryRoot: root
  });
  const sql = createBackupDataScript(config);
  const ownerAt = sql.indexOf('SET LOCAL ROLE "ia4tube_social_owner"');
  const markerAt = sql.indexOf("environment_identity");
  const migrationsAt = sql.indexOf("schema_migrations");
  assert.match(sql, /BEGIN ISOLATION LEVEL REPEATABLE READ;/);
  assert.match(sql, /SET LOCAL ROLE "ia4tube_social_owner";/);
  assert.ok(ownerAt >= 0 && ownerAt < markerAt);
  assert.ok(markerAt < migrationsAt);
  assert.match(sql, /jsonb_populate_record/);
  assert.match(sql, /COMMIT;\s*$/);
  assert.doesNotMatch(
    sql,
    /DISABLE ROW LEVEL SECURITY|NO FORCE ROW LEVEL SECURITY|BYPASSRLS|SUPERUSER|--snapshot/
  );
  for (const policy of temporaryPolicySql("select")) {
    const createAt = sql.indexOf(policy.create);
    const dropAt = sql.indexOf(policy.drop);
    assert.ok(createAt > sql.indexOf("BEGIN"));
    assert.ok(dropAt > createAt);
    assert.ok(dropAt < sql.lastIndexOf("COMMIT"));
  }
  for (const table of BACKUP_TABLES) {
    assert.match(sql, new RegExp(table.replace(".", "\\.")));
  }
  assert.equal(sql.includes(password), false);
});

test("restore and evidence scripts also remove temporary policies atomically", (t) => {
  const bundle = createBundle(t);
  const restore = loadRestoreConfig(
    restoreEnvironment(bundle.directory, bundle.config.files.manifest),
    { repositoryRoot: root }
  );
  const restoreSql = createRestoreDataScript(restore, bundle.manifest);
  const evidenceSql = createEvidenceScript(
    restore,
    restore.files.evidencePartial,
    bundle.manifest
  );
  for (const sql of [restoreSql, evidenceSql]) {
    assert.match(sql, /BEGIN ISOLATION LEVEL REPEATABLE READ;/);
    assert.match(sql, /COMMIT;\s*$/);
    assert.doesNotMatch(
      sql,
      /DISABLE ROW LEVEL SECURITY|NO FORCE ROW LEVEL SECURITY|BYPASSRLS/
    );
    for (const policy of temporaryPolicySql(
      sql === restoreSql ? "all" : "select"
    )) {
      assert.ok(sql.indexOf(policy.drop) > sql.indexOf(policy.create));
    }
    assert.equal(sql.includes(password), false);
  }
  assert.match(evidenceSql, new RegExp(bundle.manifest.source.environmentId));
  assert.match(evidenceSql, /environment_identity/);
  assert.ok(
    evidenceSql.indexOf('SET LOCAL ROLE "ia4tube_social_owner"') <
      evidenceSql.indexOf("environment_identity")
  );
  for (const entry of bundle.manifest.files.data) {
    assert.ok(restoreSql.includes(entry.path.replace(/\\/g, "/")));
  }
});

test("process plans keep passwords out of argv and SQL", (t) => {
  const directory = temporaryDirectory(t);
  const config = loadBackupConfig(backupEnvironment(directory), {
    repositoryRoot: root
  });
  const roots = systemRootsFixture(t, directory);
  const plan = psqlPlan(
    config.tools.psql,
    config.source,
    createBackupDataScript(config),
    roots.bundle
  );
  assert.equal(plan.env.PGPASSWORD, password);
  assert.equal(plan.env.PGCHANNELBINDING, "disable");
  assert.equal(plan.env.PGSSLMODE, "verify-full");
  assert.equal(plan.env.PGSSLROOTCERT, "system");
  assert.equal(
    assertSecretFreePlan(plan, [password, operatorPassword]),
    true
  );
  assert.equal(JSON.stringify(plan.args).includes(password), false);
  assert.equal(plan.input.includes(password), false);
  assert.throws(
    () =>
      assertSecretFreePlan(
        { ...plan, args: [...plan.args, password] },
        [password]
      ),
    { code: "backup_secret_in_process_plan" }
  );
});

test("PostgreSQL child environment uses verified TLS with system roots", (t) => {
  const directory = temporaryDirectory(t);
  const config = loadBackupConfig(backupEnvironment(directory), {
    repositoryRoot: root
  });
  const roots = systemRootsFixture(t, directory);
  const childEnvironment = childConnectionEnvironment(
    config.source,
    roots.bundle,
    {
      SYSTEMROOT: "C:\\Windows",
      PGCHANNELBINDING: "require",
      PGSSLMODE: "disable",
      PGSSLROOTCERT: "untrusted-root.pem",
      PGSSLCERT: "untrusted-client.pem",
      PGSSLKEY: "untrusted-client.key",
      PGSSLCRL: "untrusted-crl.pem",
      PGSSLCRLDIR: "untrusted-crl-directory",
      PGSSLCERTMODE: "require",
      PGPASSFILE: "untrusted-password-file",
      PGSERVICE: "untrusted-service",
      PGCONNECT_TIMEOUT: "999",
      PGOPTIONS: "-c search_path=untrusted",
      SSL_CERT_FILE: "untrusted-system-roots.pem",
      SSL_CERT_DIR: "untrusted-system-roots",
      OPENSSL_CONF: "untrusted-openssl.cnf"
    }
  );

  assert.equal(childEnvironment.PGCHANNELBINDING, "disable");
  assert.equal(childEnvironment.PGSSLMODE, "verify-full");
  assert.equal(childEnvironment.PGSSLROOTCERT, "system");
  assert.equal(childEnvironment.PGCONNECT_TIMEOUT, "10");
  assert.equal(childEnvironment.SSL_CERT_FILE, roots.bundle.path);
  assert.equal(childEnvironment.SYSTEMROOT, "C:\\Windows");
  for (const name of [
    "PGSSLCERT",
    "PGSSLKEY",
    "PGSSLCRL",
    "PGSSLCRLDIR",
    "PGSSLCERTMODE",
    "PGPASSFILE",
    "PGSERVICE",
    "PGOPTIONS",
    "SSL_CERT_DIR",
    "OPENSSL_CONF"
  ]) {
    assert.equal(childEnvironment[name], undefined);
  }
});

test("system root bundle is exact, private, regular and identity-bound", (t) => {
  const directory = temporaryDirectory(t);
  const workspace = createOwnedWorkspace({
    root: directory,
    purpose: "tls-exact"
  });
  const rootCertificates = tls.rootCertificates.slice(0, 2);
  const expected = `${rootCertificates.join("\n")}\n`;
  const bundle = createSystemRootCertificateBundle({
    workspace,
    rootCertificates
  });
  const stat = fs.lstatSync(bundle.path);

  assert.equal(path.basename(bundle.path), SYSTEM_ROOT_BUNDLE_NAME);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(fs.readFileSync(bundle.path, "ascii"), expected);
  assert.equal(bundle.size, Buffer.byteLength(expected, "ascii"));
  assert.equal(
    bundle.sha256,
    crypto.createHash("sha256").update(expected, "ascii").digest("hex")
  );
  if (process.platform !== "win32") {
    assert.equal(stat.mode & 0o077, 0);
  }
  assert.equal(
    inspectSystemRootCertificateBundle(bundle).path,
    bundle.path
  );
  assert.equal(cleanupSystemRootCertificateBundle(bundle), true);
  assert.equal(fs.existsSync(bundle.path), false);
});

test("system root bundle creation is exclusive and preserves collisions", (t) => {
  const directory = temporaryDirectory(t);
  const workspace = createOwnedWorkspace({
    root: directory,
    purpose: "tls-collision"
  });
  const collision = path.join(workspace.path, SYSTEM_ROOT_BUNDLE_NAME);
  fs.writeFileSync(collision, "unrelated preserved file", {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600
  });

  assert.throws(
    () => createSystemRootCertificateBundle({ workspace }),
    { code: "backup_tls_root_bundle_collision" }
  );
  assert.equal(
    fs.readFileSync(collision, "utf8"),
    "unrelated preserved file"
  );
});

test("failed system root bundle creation removes only its owned file", (t) => {
  const directory = temporaryDirectory(t);
  const workspace = createOwnedWorkspace({
    root: directory,
    purpose: "tls-create-fail"
  });
  const expectedPath = path.join(
    workspace.path,
    SYSTEM_ROOT_BUNDLE_NAME
  );
  const failingFileSystem = {
    ...fs,
    writeFileSync(target, ...args) {
      if (Number.isInteger(target)) {
        throw new Error("synthetic certificate write failure");
      }
      return fs.writeFileSync(target, ...args);
    }
  };

  assert.throws(
    () =>
      createSystemRootCertificateBundle({
        workspace,
        fileSystem: failingFileSystem
      }),
    { code: "backup_tls_root_bundle_creation_failed" }
  );
  assert.equal(fs.existsSync(expectedPath), false);
});

test("system root cleanup refuses a replaced file and preserves it", (t) => {
  const directory = temporaryDirectory(t);
  const workspace = createOwnedWorkspace({
    root: directory,
    purpose: "tls-replaced"
  });
  const bundle = createSystemRootCertificateBundle({ workspace });
  fs.unlinkSync(bundle.path);
  fs.writeFileSync(bundle.path, "replacement must survive refusal", {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600
  });

  assert.throws(
    () => cleanupSystemRootCertificateBundle(bundle),
    { code: "backup_tls_root_bundle_changed" }
  );
  assert.equal(
    fs.readFileSync(bundle.path, "utf8"),
    "replacement must survive refusal"
  );
});

test("system root cleanup reports unlink failure without losing ownership evidence", (t) => {
  const directory = temporaryDirectory(t);
  const workspace = createOwnedWorkspace({
    root: directory,
    purpose: "tls-cleanup-fail"
  });
  const bundle = createSystemRootCertificateBundle({ workspace });
  const failingFileSystem = {
    ...fs,
    unlinkSync(target) {
      if (path.resolve(target) === path.resolve(bundle.path)) {
        throw new Error("synthetic unlink failure");
      }
      return fs.unlinkSync(target);
    }
  };

  assert.throws(
    () =>
      cleanupSystemRootCertificateBundle(
        bundle,
        failingFileSystem
      ),
    { code: "backup_tls_root_bundle_cleanup_failed" }
  );
  assert.equal(fs.existsSync(bundle.path), true);
  assert.equal(cleanupSystemRootCertificateBundle(bundle), true);
  assert.equal(fs.existsSync(bundle.path), false);
});

test("manifest verifies every logical file, counts and migration checksum", (t) => {
  const bundle = createBundle(t);
  assert.equal(bundle.manifest.files.data.length, BACKUP_TABLES.length);
  assert.deepEqual(
    bundle.manifest.evidence.migrations,
    EXPECTED_MIGRATION_ROWS
  );
  assert.doesNotThrow(() =>
      validateManifestFiles(bundle.manifest, {
        expectedDirectory: bundle.config.workspace.path,
        sourceFingerprint: targetFingerprint(sourceTarget)
      })
  );
  assert.equal(
    compareRestoredEvidence(bundle.evidence, safeEvidence()),
    true
  );

  fs.appendFileSync(bundle.manifest.files.data[0].path, "tamper");
  assert.throws(
    () =>
      validateManifestFiles(bundle.manifest, {
        expectedDirectory: bundle.config.workspace.path,
        sourceFingerprint: targetFingerprint(sourceTarget)
      }),
    { code: "restore_archive_integrity_failed" }
  );
  assert.throws(
    () =>
      normalizeEvidence(
        safeEvidence({
          migrations: EXPECTED_MIGRATION_ROWS.map((entry, index) => ({
            ...entry,
            checksum: index === 0 ? "0".repeat(64) : entry.checksum
          }))
        })
      ),
    { code: "backup_migration_state_invalid" }
  );
});

test("schema profile is selected only from an exact authenticated migration prefix", () => {
  const legacy = SCHEMA_PROFILES[0];
  const current = SCHEMA_PROFILES[1];
  assert.equal(resolveSchemaProfile(legacy.migrationRows).id, legacy.id);
  assert.equal(resolveSchemaProfile(current.migrationRows).id, current.id);
  assert.throws(() => resolveSchemaProfile([]), {
    code: "backup_migration_state_invalid"
  });
  assert.throws(
    () =>
      resolveSchemaProfile([
        ...legacy.migrationRows.slice(0, -1),
        { ...legacy.migrationRows.at(-1), checksum: "0".repeat(64) }
      ]),
    { code: "backup_migration_state_invalid" }
  );
  assert.throws(
    () => resolveSchemaProfile([...legacy.migrationRows].reverse()),
    { code: "backup_migration_state_invalid" }
  );
  assert.throws(
    () =>
      resolveSchemaProfile([
        ...legacy.migrationRows,
        { version: "9999_unknown", checksum: "f".repeat(64) }
      ]),
    { code: "backup_migration_state_invalid" }
  );
});

test("pre-0004 backup reads only existing tables and authenticates the exact set", (t) => {
  const profile = SCHEMA_PROFILES[0];
  const directory = temporaryDirectory(t);
  const config = loadBackupConfig(backupEnvironment(directory), {
    repositoryRoot: root
  });
  const sql = createBackupDataScript(config, profile);
  for (const table of PRE_0004_BACKUP_TABLES) {
    assert.match(sql, new RegExp(table.replace(".", "\\.")));
  }
  for (const table of BACKUP_TABLES.filter(
    (name) => !PRE_0004_BACKUP_TABLES.includes(name)
  )) {
    assert.doesNotMatch(sql, new RegExp(table.replace(".", "\\.")));
  }
  assert.equal(temporaryPolicySql("select", profile).length, PRE_0004_RLS_TABLES.length);
  assert.equal(sql.includes(EXPECTED_MIGRATION_ROWS[2].version), true);
  assert.equal(sql.includes(EXPECTED_MIGRATION_ROWS[3].version), false);

  const bundle = createBundle(t, profile);
  assert.equal(bundle.manifest.format, 3);
  assert.equal(bundle.manifest.schemaProfile.id, profile.id);
  assert.deepEqual(
    bundle.manifest.schemaProfile.backupTables,
    PRE_0004_BACKUP_TABLES
  );
  assert.deepEqual(bundle.manifest.schemaProfile.rlsTables, PRE_0004_RLS_TABLES);
  assert.deepEqual(
    bundle.manifest.files.data.map((entry) => entry.table),
    PRE_0004_BACKUP_TABLES
  );
  assert.doesNotThrow(() =>
    validateManifestFiles(bundle.manifest, {
      expectedDirectory: bundle.config.workspace.path,
      sourceFingerprint: bundle.config.sourceFingerprint
    })
  );

  const switched = JSON.parse(JSON.stringify(bundle.manifest));
  switched.schemaProfile.backupTables = [...PRE_0004_BACKUP_TABLES].reverse();
  assert.throws(() => validateManifestFiles(switched), {
    code: "restore_manifest_schema_profile_invalid"
  });
  const missing = JSON.parse(JSON.stringify(bundle.manifest));
  delete missing.schemaProfile;
  assert.throws(() => validateManifestFiles(missing), {
    code: "restore_manifest_invalid"
  });
  const missingTable = JSON.parse(JSON.stringify(bundle.manifest));
  missingTable.files.data.pop();
  assert.throws(() => validateManifestFiles(missingTable), {
    code: "restore_manifest_invalid"
  });
  const exchangedTables = JSON.parse(JSON.stringify(bundle.manifest));
  [exchangedTables.files.data[0], exchangedTables.files.data[1]] = [
    exchangedTables.files.data[1],
    exchangedTables.files.data[0]
  ];
  assert.throws(() => validateManifestFiles(exchangedTables), {
    code: "restore_manifest_invalid"
  });
  const wrongLedgerDigest = JSON.parse(JSON.stringify(bundle.manifest));
  wrongLedgerDigest.schemaProfile.migrationLedgerSha256 = "0".repeat(64);
  assert.throws(() => validateManifestFiles(wrongLedgerDigest), {
    code: "restore_manifest_schema_profile_invalid"
  });
});

test("legacy format-2 0003 bundle restores with its exact authenticated table set", async (t) => {
  const bundle = await createLegacy0003EncryptedFixture(t);
  assert.doesNotThrow(() =>
    validateManifestFiles(bundle.legacyManifest, {
      expectedDirectory: bundle.config.workspace.path,
      sourceFingerprint: bundle.config.sourceFingerprint
    })
  );
  const config = loadRestoreConfig(
    restoreEnvironment(bundle.directory, bundle.config.files.bundle),
    { repositoryRoot: root }
  );
  let psqlCalls = 0;
  const result = await runLogicalRestore({
    config,
    operator: mockOperator([], profileCatalog(bundle.profile), bundle.profile),
    verifierTargetFingerprint: config.targetFingerprint,
    async runTool(plan) {
      if (plan.executable === tools.restore && plan.args[0] === "--list") {
        return { code: 0, stdout: archiveList(bundle.profile) };
      }
      if (plan.executable === tools.psql) {
        psqlCalls += 1;
        if (psqlCalls === 1) {
          assert.equal(
            plan.input.split("\n").filter((line) => line.startsWith("\\i ")).length,
            PRE_0004_BACKUP_TABLES.length
          );
          for (const table of BACKUP_TABLES.filter(
            (name) => !PRE_0004_BACKUP_TABLES.includes(name)
          )) {
            assert.equal(
              plan.input.includes(table.replace(".", "__")),
              false
            );
          }
        } else {
          fs.writeFileSync(
            planOutputFile(plan),
            JSON.stringify(profileSnapshot(bundle.profile))
          );
        }
      }
      return { code: 0, stdout: "" };
    },
    async verifyRuntimeIsolation() {
      return true;
    },
    async verifyVault() {
      return true;
    },
    async verify2ACompatibility() {
      return true;
    }
  });
  assert.equal(result.ok, true);
  assert.equal(psqlCalls, 2);
});

test("legacy format-2 exception is limited to the exact 0003 contract", (t) => {
  const current = createBundle(t, SCHEMA_PROFILES[1]);
  const disguisedCurrent = JSON.parse(JSON.stringify(current.manifest));
  disguisedCurrent.format = 2;
  delete disguisedCurrent.schemaProfile;
  assert.throws(() => validateManifestFiles(disguisedCurrent), {
    code: "restore_manifest_schema_profile_invalid"
  });

  const legacy = createBundle(t, SCHEMA_PROFILES[0]);
  const format2WithUntrustedProfile = JSON.parse(JSON.stringify(legacy.manifest));
  format2WithUntrustedProfile.format = 2;
  assert.throws(() => validateManifestFiles(format2WithUntrustedProfile), {
    code: "restore_manifest_invalid"
  });
});

test("backup workflow completes against an exact pre-0004 ledger without future tables", async (t) => {
  const profile = SCHEMA_PROFILES[0];
  const directory = temporaryDirectory(t);
  const config = loadBackupConfig(backupEnvironment(directory), {
    repositoryRoot: root
  });
  let dataPlan;
  const result = await runLogicalBackup({
    config,
    operator: mockOperator([], profileCatalog(profile), profile),
    async runTool(plan) {
      if (plan.executable === tools.psql) {
        dataPlan = plan;
        for (const table of profile.backupTables) {
          fs.writeFileSync(
            config.files.dataPartial[table],
            `-- ${table}\nINSERT synthetic;\n`
          );
        }
        fs.writeFileSync(
          config.files.evidencePartial,
          JSON.stringify(profileSnapshot(profile))
        );
        return { code: 0, stdout: "" };
      }
      if (plan.executable === tools.dump) {
        fs.writeFileSync(config.files.schemaPartial, "schema archive");
        return { code: 0, stdout: "" };
      }
      return { code: 0, stdout: archiveList(profile) };
    },
    generatedAt: "2026-08-04T12:00:00.000Z"
  });
  assert.equal(result.ok, true);
  assert.ok(dataPlan);
  for (const table of BACKUP_TABLES.filter(
    (name) => !PRE_0004_BACKUP_TABLES.includes(name)
  )) {
    assert.doesNotMatch(dataPlan.input, new RegExp(table.replace(".", "\\.")));
    assert.equal(fs.existsSync(config.files.data[table]), false);
  }
});

test("backup refuses an invalid profile catalog before external transport", async (t) => {
  const directory = temporaryDirectory(t);
  const config = loadBackupConfig(backupEnvironment(directory), {
    repositoryRoot: root
  });
  const events = [];
  let toolCalls = 0;
  await assert.rejects(
    runLogicalBackup({
      config,
      operator: mockOperator(
        events,
        safeCatalog({ requiredConstraintsPresent: false })
      ),
      async runTool() {
        toolCalls += 1;
        return { code: 0, stdout: "" };
      },
      generatedAt: "2026-08-11T12:00:00.000Z"
    }),
    { code: "backup_catalog_state_invalid" }
  );
  assert.equal(toolCalls, 0);
  assert.equal(
    events.filter((event) => event[0] === "catalog").length,
    1
  );
  assert.deepEqual(events.at(-1), [
    "release",
    BACKUP_LOCK_ID,
    MIGRATION_LOCK_ID
  ]);
  assert.equal(fs.existsSync(config.workspace.path), false);
});

test("backup workflow produces a verified bundle and always releases locks", async (t) => {
  assert.equal(MIGRATION_LOCK_ID, ADVISORY_LOCK_ID);
  const directory = temporaryDirectory(t);
  const config = loadBackupConfig(backupEnvironment(directory), {
    repositoryRoot: root
  });
  const events = [];
  const operator = mockOperator(events);
  const plans = [];
  async function runTool(plan) {
    plans.push(plan);
    events.push(["tool", plan.executable]);
    assert.equal(fs.existsSync(config.workspace.path), true);
    assert.equal(
      fs.existsSync(
        path.join(
          config.workspace.path,
          ".ia4tube-workspace-owner.json"
        )
      ),
      true
    );
    if ([tools.psql, tools.dump].includes(plan.executable)) {
      assert.equal(plan.env.PGCHANNELBINDING, "disable");
      assert.equal(plan.env.PGSSLMODE, "verify-full");
      assert.equal(plan.env.PGSSLROOTCERT, "system");
      assert.equal(
        path.basename(plan.env.SSL_CERT_FILE),
        SYSTEM_ROOT_BUNDLE_NAME
      );
      assert.equal(fs.lstatSync(plan.env.SSL_CERT_FILE).isFile(), true);
    }
    if (plan.executable === tools.psql) {
      for (const table of BACKUP_TABLES) {
        fs.writeFileSync(
          config.files.dataPartial[table],
          `-- ${table}\nINSERT synthetic;\n`
        );
      }
      fs.writeFileSync(
        config.files.evidencePartial,
        JSON.stringify(safeSnapshot())
      );
      return { code: 0, stdout: "" };
    }
    if (plan.executable === tools.dump) {
      fs.writeFileSync(config.files.schemaPartial, "schema archive");
      return { code: 0, stdout: "" };
    }
    return { code: 0, stdout: archiveList() };
  }
  const result = await runLogicalBackup({
    config,
    operator,
    runTool,
    generatedAt: "2026-07-29T12:00:00.000Z"
  });
  assert.equal(result.ok, true);
  assert.equal(result.files, 1);
  assert.equal(fs.existsSync(config.files.bundle), true);
  assert.equal(result.bundleSize, fs.statSync(config.files.bundle).size);
  assert.match(result.bundleSha256, /^[0-9a-f]{64}$/);
  assert.equal(result.bundleFileFsyncConfirmed, true);
  assert.equal(
    typeof result.bundleDirectoryFsyncConfirmed,
    "boolean"
  );
  assert.equal(result.bundleRoundTripVerified, true);
  assert.equal(fs.existsSync(config.files.manifest), false);
  assert.equal(fs.existsSync(config.files.schema), false);
  assert.equal(
    Object.values(config.files.data).some((file) => fs.existsSync(file)),
    false
  );
  assert.equal(fs.existsSync(config.workspace.path), false);
  assert.deepEqual(events[0], [
    "acquire",
    MIGRATION_LOCK_ID,
    BACKUP_LOCK_ID
  ]);
  assert.deepEqual(events.at(-1), [
    "release",
    BACKUP_LOCK_ID,
    MIGRATION_LOCK_ID
  ]);
  const catalogAt = events.findIndex((event) => event[0] === "catalog");
  const firstToolAt = events.findIndex((event) => event[0] === "tool");
  assert.equal(events.filter((event) => event[0] === "catalog").length, 1);
  assert.ok(catalogAt >= 0 && catalogAt < firstToolAt);
  assert.equal(
    plans.some((plan) => plan.args.some((arg) => arg.includes("--snapshot"))),
    false
  );
  assert.equal(
    plans.some((plan) => JSON.stringify(plan).includes(password)),
    true,
    "password exists only in the child environment"
  );
  for (const plan of plans) {
    assert.equal(
      JSON.stringify({ args: plan.args, input: plan.input }).includes(password),
      false
    );
    if ([tools.psql, tools.dump].includes(plan.executable)) {
      assert.equal(fs.existsSync(plan.env.SSL_CERT_FILE), false);
    }
  }
});

test("strict Linux durability gate removes a bundle when directory fsync is unconfirmed", async (t) => {
  const directory = temporaryDirectory(t);
  const config = loadBackupConfig(backupEnvironment(directory), {
    repositoryRoot: root
  });
  const unrelated = path.join(directory, "unrelated-preserved.txt");
  fs.writeFileSync(unrelated, "preserve me");
  const events = [];
  const realOpen = fs.openSync.bind(fs);
  const unsupportedDirectoryFsync = {
    ...fs,
    openSync(file, flags, mode) {
      if (
        path.resolve(file) === path.resolve(directory) &&
        fs.existsSync(config.files.bundle)
      ) {
        const error = new Error(
          "synthetic unsupported directory fsync"
        );
        error.code = "EPERM";
        throw error;
      }
      return realOpen(file, flags, mode);
    }
  };

  async function populate(plan) {
    if (plan.executable === tools.psql) {
      for (const table of BACKUP_TABLES) {
        fs.writeFileSync(
          config.files.dataPartial[table],
          `-- ${table}\nINSERT synthetic;\n`
        );
      }
      fs.writeFileSync(
        config.files.evidencePartial,
        JSON.stringify(safeSnapshot())
      );
      return { code: 0, stdout: "" };
    }
    if (plan.executable === tools.dump) {
      fs.writeFileSync(config.files.schemaPartial, "schema archive");
      return { code: 0, stdout: "" };
    }
    return { code: 0, stdout: archiveList() };
  }

  await assert.rejects(
    runLogicalBackup({
      config,
      operator: mockOperator(events),
      runTool: populate,
      fileSystem: unsupportedDirectoryFsync,
      generatedAt: "2026-07-29T12:00:00.000Z",
      requireBundleDirectoryFsync: true
    }),
    { code: "backup_bundle_directory_sync_unconfirmed" }
  );
  assert.equal(fs.existsSync(config.files.bundle), false);
  assert.equal(fs.existsSync(config.files.bundlePartial), false);
  assert.equal(fs.existsSync(config.workspace.path), false);
  assert.equal(fs.readFileSync(unrelated, "utf8"), "preserve me");
  assert.deepEqual(events.at(-1), [
    "release",
    BACKUP_LOCK_ID,
    MIGRATION_LOCK_ID
  ]);
});

test("failed encrypted roundtrip removes the container and every plaintext output", async (t) => {
  const directory = temporaryDirectory(t);
  const config = loadBackupConfig(backupEnvironment(directory), {
    repositoryRoot: root
  });
  const unrelated = path.join(directory, "unrelated-preserved.txt");
  fs.writeFileSync(unrelated, "preserve me");
  const events = [];
  const tamperingFileSystem = {
    ...fs,
    createReadStream(file, options) {
      if (
        path.resolve(file) === path.resolve(config.files.bundle) &&
        Number.isSafeInteger(options?.start) &&
        Number.isSafeInteger(options?.end)
      ) {
        const encrypted = fs
          .readFileSync(file)
          .subarray(options.start, options.end + 1);
        const tampered = Buffer.from(encrypted);
        tampered[0] ^= 0x01;
        return Readable.from(tampered);
      }
      return fs.createReadStream(file, options);
    }
  };

  async function populate(plan) {
    if (plan.executable === tools.psql) {
      for (const table of BACKUP_TABLES) {
        fs.writeFileSync(
          config.files.dataPartial[table],
          `-- ${table}\nINSERT synthetic;\n`
        );
      }
      fs.writeFileSync(
        config.files.evidencePartial,
        JSON.stringify(safeSnapshot())
      );
      return { code: 0, stdout: "" };
    }
    if (plan.executable === tools.dump) {
      fs.writeFileSync(config.files.schemaPartial, "schema archive");
      return { code: 0, stdout: "" };
    }
    return { code: 0, stdout: archiveList() };
  }

  await assert.rejects(
    runLogicalBackup({
      config,
      operator: mockOperator(events),
      runTool: populate,
      fileSystem: tamperingFileSystem,
      generatedAt: "2026-07-29T12:00:00.000Z"
    }),
    (error) =>
      typeof error?.code === "string" &&
      error.code.startsWith("backup_bundle_")
  );
  for (const file of [
    config.files.schemaPartial,
    config.files.schema,
    config.files.evidencePartial,
    config.files.manifestPartial,
    config.files.manifest,
    config.files.bundlePartial,
    config.files.bundle,
    ...Object.values(config.files.dataPartial),
    ...Object.values(config.files.data)
  ]) {
    assert.equal(fs.existsSync(file), false);
  }
  assert.equal(fs.readFileSync(unrelated, "utf8"), "preserve me");
  assert.equal(fs.existsSync(config.workspace.path), false);
  assert.deepEqual(events.at(-1), [
    "release",
    BACKUP_LOCK_ID,
    MIGRATION_LOCK_ID
  ]);
});

test("failed backup removes its exact outputs and still releases locks", async (t) => {
  const directory = temporaryDirectory(t);
  const config = loadBackupConfig(backupEnvironment(directory), {
    repositoryRoot: root
  });
  const events = [];
  await assert.rejects(
    runLogicalBackup({
      config,
      operator: mockOperator(events),
      async runTool(plan) {
        if (plan.executable === tools.psql) {
          fs.writeFileSync(
            config.files.dataPartial[BACKUP_TABLES[0]],
            "incomplete"
          );
        }
        return { code: 1, stdout: "" };
      }
    }),
    { code: "backup_external_tool_failed" }
  );
  assert.equal(
    fs.existsSync(config.files.dataPartial[BACKUP_TABLES[0]]),
    false
  );
  assert.equal(fs.existsSync(config.files.manifest), false);
  assert.equal(fs.existsSync(config.workspace.path), false);
  assert.deepEqual(events.at(-1), [
    "release",
    BACKUP_LOCK_ID,
    MIGRATION_LOCK_ID
  ]);
});

test("a crashed marked backup workspace is recovered under the backup locks", async (t) => {
  const directory = temporaryDirectory(t);
  const config = loadBackupConfig(backupEnvironment(directory), {
    repositoryRoot: root
  });
  const modulePath = path.resolve(
    root,
    "src",
    "persistence",
    "postgres",
    "encrypted-backup-bundle.js"
  );
  const script = [
    `"use strict";`,
    `const fs = require("node:fs");`,
    `const path = require("node:path");`,
    `const bundle = require(${JSON.stringify(modulePath)});`,
    `const workspace = bundle.createOwnedWorkspace({`,
    `  root: ${JSON.stringify(config.outputDirectory)},`,
    `  purpose: ${JSON.stringify(config.workspace.purpose)},`,
    `  id: ${JSON.stringify(config.workspace.id)},`,
    `  now: () => new Date(Date.now() - 25 * 60 * 60 * 1000)`,
    `});`,
    `fs.writeFileSync(path.join(workspace.path, "crashed.sql"),`,
    `  "synthetic plaintext", { mode: 0o600 });`,
    `process.exit(31);`
  ].join("\n");
  const child = spawnSync(process.execPath, ["-e", script], {
    timeout: 10_000,
    encoding: "utf8"
  });
  assert.equal(child.status, 31);
  assert.equal(fs.existsSync(config.workspace.path), true);
  const events = [];
  async function populate(plan) {
    if (plan.executable === tools.psql) {
      assert.equal(
        fs.existsSync(path.join(config.workspace.path, "crashed.sql")),
        false
      );
      for (const table of BACKUP_TABLES) {
        fs.writeFileSync(
          config.files.dataPartial[table],
          `-- ${table}\nINSERT synthetic;\n`
        );
      }
      fs.writeFileSync(
        config.files.evidencePartial,
        JSON.stringify(safeSnapshot())
      );
      return { code: 0, stdout: "" };
    }
    if (plan.executable === tools.dump) {
      fs.writeFileSync(config.files.schemaPartial, "schema archive");
      return { code: 0, stdout: "" };
    }
    return { code: 0, stdout: archiveList() };
  }
  const result = await runLogicalBackup({
    config,
    operator: mockOperator(events),
    runTool: populate,
    generatedAt: "2026-07-29T12:00:00.000Z"
  });
  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(config.workspace.path), false);
  assert.equal(fs.existsSync(config.files.bundle), true);
  assert.deepEqual(events[0], [
    "acquire",
    MIGRATION_LOCK_ID,
    BACKUP_LOCK_ID
  ]);
});

test("failure between promotions removes every exact output and permits a clean retry", async (t) => {
  const directory = temporaryDirectory(t);
  const config = loadBackupConfig(backupEnvironment(directory), {
    repositoryRoot: root
  });
  const unrelated = path.join(directory, "unrelated-preserved.txt");
  fs.writeFileSync(unrelated, "preserve me");
  const realRename = fs.renameSync.bind(fs);
  let renameCalls = 0;
  const failingFileSystem = {
    ...fs,
    renameSync(source, destination) {
      renameCalls += 1;
      realRename(source, destination);
      if (renameCalls === 2) {
        throw new Error("synthetic interruption after rename");
      }
    }
  };

  async function populate(plan) {
    if (plan.executable === tools.psql) {
      for (const table of BACKUP_TABLES) {
        fs.writeFileSync(
          config.files.dataPartial[table],
          `-- ${table}\nINSERT synthetic;\n`
        );
      }
      fs.writeFileSync(
        config.files.evidencePartial,
        JSON.stringify(safeSnapshot())
      );
      return { code: 0, stdout: "" };
    }
    if (plan.executable === tools.dump) {
      fs.writeFileSync(config.files.schemaPartial, "schema archive");
      return { code: 0, stdout: "" };
    }
    return { code: 0, stdout: archiveList() };
  }

  await assert.rejects(
    runLogicalBackup({
      config,
      operator: mockOperator([]),
      runTool: populate,
      fileSystem: failingFileSystem
    }),
    { code: "backup_external_tool_failed" }
  );
  for (const file of [
    config.files.schemaPartial,
    config.files.schema,
    config.files.evidencePartial,
    config.files.manifestPartial,
    config.files.manifest,
    config.files.bundlePartial,
    config.files.bundle,
    ...Object.values(config.files.dataPartial),
    ...Object.values(config.files.data)
  ]) {
    assert.equal(fs.existsSync(file), false);
  }
  assert.equal(fs.readFileSync(unrelated, "utf8"), "preserve me");
  assert.equal(fs.existsSync(config.workspace.path), false);

  const retry = await runLogicalBackup({
    config,
    operator: mockOperator([]),
    runTool: populate,
    generatedAt: "2026-07-29T12:00:00.000Z"
  });
  assert.equal(retry.ok, true);
  assert.equal(fs.existsSync(config.files.bundle), true);
  assert.equal(fs.existsSync(config.files.manifest), false);
  assert.equal(fs.existsSync(config.workspace.path), false);
});

test("restore approval requires catalog equality plus runtime, vault and 2A gates", async (t) => {
  const bundle = await createEncryptedFixture(t);
  const config = loadRestoreConfig(
    restoreEnvironment(bundle.directory, bundle.config.files.bundle),
    { repositoryRoot: root }
  );
  const events = [];
  let psqlCalls = 0;
  let restoreWorkspace;
  const rootBundlePaths = new Set();
  const verifications = [];
  const result = await runLogicalRestore({
    config,
    operator: mockOperator(events),
    verifierTargetFingerprint: config.targetFingerprint,
    async runTool(plan) {
      if (plan.executable === tools.restore && plan.args[0] === "--list") {
        return { code: 0, stdout: archiveList() };
      }
      assert.equal(plan.env.PGSSLMODE, "verify-full");
      assert.equal(plan.env.PGSSLROOTCERT, "system");
      assert.equal(
        path.basename(plan.env.SSL_CERT_FILE),
        SYSTEM_ROOT_BUNDLE_NAME
      );
      rootBundlePaths.add(plan.env.SSL_CERT_FILE);
      assert.equal(fs.existsSync(plan.env.SSL_CERT_FILE), true);
      if (plan.executable === tools.psql) {
        psqlCalls += 1;
        if (psqlCalls === 2) {
          const evidenceFile = planOutputFile(plan);
          assert.ok(evidenceFile);
          restoreWorkspace = path.dirname(evidenceFile);
          assert.ok(
            path.basename(restoreWorkspace).startsWith(
              ".ia4tube-social-workspace-restore-"
            )
          );
          fs.writeFileSync(
            evidenceFile,
            JSON.stringify(safeSnapshot())
          );
        }
      }
      return { code: 0, stdout: "" };
    },
    async verifyRuntimeIsolation() {
      verifications.push("runtime");
      return true;
    },
    async verifyVault() {
      verifications.push("vault");
      return true;
    },
    async verify2ACompatibility() {
      verifications.push("2a");
      return true;
    }
  });
  assert.deepEqual(verifications, ["runtime", "vault", "2a"]);
  assert.equal(result.ok, true);
  assert.equal(result.compatibleWith2A, true);
  assert.equal(fs.existsSync(restoreWorkspace), false);
  assert.equal(rootBundlePaths.size, 1);
  for (const rootBundlePath of rootBundlePaths) {
    assert.equal(fs.existsSync(rootBundlePath), false);
  }
  assert.deepEqual(events[0], [
    "acquire",
    MIGRATION_LOCK_ID,
    BACKUP_LOCK_ID
  ]);
  assert.deepEqual(events.at(-1), [
    "release",
    BACKUP_LOCK_ID,
    MIGRATION_LOCK_ID
  ]);
});

test("restore refuses behavioral verifiers bound to another database", async (t) => {
  const bundle = await createEncryptedFixture(t);
  const config = loadRestoreConfig(
    restoreEnvironment(bundle.directory, bundle.config.files.bundle),
    { repositoryRoot: root }
  );
  const events = [];
  await assert.rejects(
    runLogicalRestore({
      config,
      operator: mockOperator(events),
      async runTool() {
        assert.fail("tools must not run for a mismatched verifier target");
      },
      verifierTargetFingerprint: "f".repeat(64),
      async verifyRuntimeIsolation() {
        assert.fail("verifier must not run for a mismatched target");
      },
      async verifyVault() {
        assert.fail("verifier must not run for a mismatched target");
      },
      async verify2ACompatibility() {
        assert.fail("verifier must not run for a mismatched target");
      }
    }),
    { code: "restore_behavior_target_mismatch" }
  );
  assert.deepEqual(events, []);
});

test("restore refuses to approve when the exact 2A runtime gate fails", async (t) => {
  const bundle = await createEncryptedFixture(t);
  const config = loadRestoreConfig(
    restoreEnvironment(bundle.directory, bundle.config.files.bundle),
    { repositoryRoot: root }
  );
  let psqlCalls = 0;
  const rootBundlePaths = new Set();
  await assert.rejects(
    runLogicalRestore({
      config,
      operator: mockOperator([]),
      verifierTargetFingerprint: config.targetFingerprint,
      async runTool(plan) {
        if (plan.executable === tools.restore && plan.args[0] === "--list") {
          return { code: 0, stdout: archiveList() };
        }
        rootBundlePaths.add(plan.env.SSL_CERT_FILE);
        if (plan.executable === tools.psql && ++psqlCalls === 2) {
          const evidenceFile = planOutputFile(plan);
          assert.ok(evidenceFile);
          fs.writeFileSync(
            evidenceFile,
            JSON.stringify(safeSnapshot())
          );
        }
        return { code: 0, stdout: "" };
      },
      async verifyRuntimeIsolation() {
        return true;
      },
      async verifyVault() {
        return true;
      },
      async verify2ACompatibility() {
        return false;
      }
    }),
    { code: "restore_behavioral_validation_failed" }
  );
  assert.equal(rootBundlePaths.size, 1);
  for (const rootBundlePath of rootBundlePaths) {
    assert.equal(fs.existsSync(rootBundlePath), false);
  }
});

test("official PostgreSQL tools have a bounded total runtime", async () => {
  assert.equal(MAX_TOOL_RUNTIME_MS, 20 * 60 * 1000);
  assert.equal(TOOL_TERMINATION_GRACE_MS, 2 * 1000);
  const startedAt = Date.now();
  await assert.rejects(
    runTool(
      {
        executable: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        env: safeToolEnvironment()
      },
      {
        timeoutMs: 100,
        terminationGraceMs: 100
      }
    ),
    { code: "postgres_tool_timeout" }
  );
  assert.ok(Date.now() - startedAt < 5000);
});

test("operator pool closure is mandatory and driver details stay internal", async () => {
  await closeOperatorPool({ async end() {} });
  await assert.rejects(
    closeOperatorPool({
      async end() {
        throw new Error(`driver-close-${password}`);
      }
    }),
    (error) =>
      error?.code === "backup_restore_pool_close_failed" &&
      !String(error?.message || "").includes(password)
  );
});

test("raw error after timeout waits for confirmed child close", async () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => {
    setImmediate(() => {
      child.emit(
        "error",
        new Error("synthetic sensitive process error")
      );
    });
    return true;
  };
  let settled = false;
  const operation = runTool(
    {
      executable: "synthetic-tool",
      args: [],
      env: {},
      input: "synthetic input"
    },
    {
      timeoutMs: 10,
      terminationGraceMs: 10,
      spawnFunction: () => child
    }
  ).finally(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(settled, false);
  child.exitCode = 1;
  child.emit("close", 1);
  await assert.rejects(
    operation,
    (error) => {
      assert.equal(
        error.code,
        "postgres_tool_timeout"
      );
      assert.equal(error.message.includes("sensitive"), false);
      return true;
    }
  );
  assert.equal(settled, true);
});

test("tool input EPIPE is translated and the child is terminated", async () => {
  const child = new EventEmitter();
  child.stdin = new Writable({
    write(chunk, encoding, callback) {
      const error = new Error("synthetic sensitive EPIPE");
      error.code = "EPIPE";
      callback(error);
    }
  });
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    setImmediate(() => {
      child.exitCode = 1;
      child.emit("close", 1);
    });
    return true;
  };
  await assert.rejects(
    runTool(
      {
        executable: "synthetic-tool",
        args: [],
        env: {},
        input: "synthetic input"
      },
      {
        timeoutMs: 1000,
        terminationGraceMs: 10,
        spawnFunction: () => child
      }
    ),
    (error) => {
      assert.equal(error.code, "postgres_tool_input_failed");
      assert.equal(error.message.includes("sensitive"), false);
      return true;
    }
  );
  assert.deepEqual(signals, ["SIGTERM"]);
});

test("unconfirmed termination never settles before child close", async () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    return false;
  };
  let settled = false;
  const operation = runTool(
    {
      executable: "synthetic-tool",
      args: [],
      env: {}
    },
    {
      timeoutMs: 10,
      terminationGraceMs: 10,
      spawnFunction: () => child
    }
  ).finally(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(settled, false);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  child.exitCode = 1;
  child.emit("close", 1);
  await assert.rejects(operation, {
    code: "postgres_tool_termination_unconfirmed"
  });
  assert.equal(settled, true);
});

test("operator CLI refuses restore without external behavioral verifiers", async (t) => {
  const bundle = createBundle(t);
  let stdout = "";
  let stderr = "";
  let poolCreated = false;
  const status = await main({
    env: restoreEnvironment(
      bundle.directory,
      bundle.config.files.manifest
    ),
    argv: ["restore"],
    PoolClass: class ForbiddenPool {
      constructor() {
        poolCreated = true;
      }
    },
    stdout: { write(value) { stdout += value; } },
    stderr: { write(value) { stderr += value; } }
  });
  assert.equal(status, 1);
  assert.equal(poolCreated, false);
  assert.equal(stdout, "");
  assert.match(stderr, /restore_external_verifiers_required/);
  assert.equal(stderr.includes(password), false);
});

test("backup module remains operator-only and outside normal server startup", () => {
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const script = fs.readFileSync(
    path.join(root, "scripts", "social-db-backup-restore.js"),
    "utf8"
  );
  assert.doesNotMatch(
    server,
    /social-db-backup-restore|postgres\/backup-restore/
  );
  assert.match(script, /process\.argv\.slice\(2\)/);
  assert.doesNotMatch(script, /console\.log|stderr\.write\(error/);
  assert.doesNotMatch(
    `${server}\n${script}`,
    new RegExp(password.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  );
  assert.ok(POLICY_PREFIX.startsWith("ia4tube_backup_owner_"));
});
