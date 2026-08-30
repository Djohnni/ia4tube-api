"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const tls = require("node:tls");
const { SocialPostgresError, postgresFail } = require("./errors");
const { loadSystemPostgresTls } = require("./tls");
const {
  ADVISORY_LOCK_ID: MIGRATION_LOCK_ID
} = require("./migrations");
const {
  inspectPermanentDatabaseLogins
} = require("./login-bootstrap");
const {
  cleanupCreatedBundle,
  cleanupOwnedWorkspace,
  compareEntryEvidence,
  createEncryptedBundle,
  createOwnedWorkspace,
  decodeBundleKey,
  EncryptedBackupBundleError,
  recoverOwnedWorkspaces,
  withExtractedEncryptedBundle
} = require("./encrypted-backup-bundle");
const { requireSafeLabel, requireSha256, requireUuid } = require("./validation");
const migrationManifest = require("../../../db/migrations/checksums.json");

const BACKUP_APPROVAL = "BACKUP_SOCIAL_POSTGRES_2B0";
const RESTORE_APPROVAL = "RESTORE_SOCIAL_POSTGRES_2B0_ISOLATED";
const BACKUP_LOCK_ID = "49703484320260730";
const OWNER_ROLE = "ia4tube_social_owner";
const MIGRATOR_ROLE = "ia4tube_social_migrator";
const RUNTIME_ROLE = "ia4tube_social_runtime";
const POLICY_PREFIX = "ia4tube_backup_owner_";
const POSTGRES_MAJOR = 18;
const MAX_METADATA_BYTES = 1024 * 1024;
const BUNDLE_ARCHIVE_MANIFEST = "00-manifest.json";
const BUNDLE_ARCHIVE_SCHEMA = "01-schema.dump";
const LOGIN_PATTERN = /^[a-z][a-z0-9_]{2,62}$/;
const DATABASE_PATTERN = /^[a-z][a-z0-9_]{2,62}$/;
const DISPOSABLE_DATABASE_PATTERN =
  /^ia4tube_social_[a-z0-9_]*(?:restore|disposable)[a-z0-9_]*$/;
const BLOCKED_RESTORE_LABEL =
  /(^|_)(?:prod|production|live|main|stage|staging)(_|$)/;
const SYSTEM_ROOT_BUNDLE_NAME =
  ".ia4tube-postgresql-system-roots.pem";
const MAX_SYSTEM_ROOT_BUNDLE_BYTES = 4 * 1024 * 1024;
const PEM_CERTIFICATE =
  /^-----BEGIN CERTIFICATE-----\n(?:[A-Za-z0-9+/=]+\n)+-----END CERTIFICATE-----$/;

const EXPECTED_MIGRATION_ROWS = Object.freeze(
  migrationManifest.migrations.map((migration) =>
    Object.freeze({
      version: migration.version,
      checksum: migration.sha256
    })
  )
);
const EXPECTED_MIGRATIONS = Object.freeze(
  EXPECTED_MIGRATION_ROWS.map((migration) => migration.version)
);
const PROFILE_0005_MIGRATION_ROWS = Object.freeze(
  EXPECTED_MIGRATION_ROWS.slice(0, 5)
);
if (
  PROFILE_0005_MIGRATION_ROWS.length !== 5 ||
  PROFILE_0005_MIGRATION_ROWS[4]?.version !==
    "0005_fix_social_reference_checks"
) {
  postgresFail(
    "backup_schema_profile_0005_manifest_invalid",
    "Perfil autenticado 0005 diverge do manifesto."
  );
}
const PROFILE_0006_MIGRATION_ROWS = Object.freeze(
  EXPECTED_MIGRATION_ROWS.slice(0, 6)
);
if (
  PROFILE_0006_MIGRATION_ROWS.length !== 6 ||
  PROFILE_0006_MIGRATION_ROWS[5]?.version !==
    "0006_social_compliance_persistence"
) {
  postgresFail(
    "backup_schema_profile_0006_manifest_invalid",
    "Perfil autenticado 0006 diverge do manifesto."
  );
}
const PRE_0004_RLS_TABLES = Object.freeze([
  "companies",
  "users",
  "company_memberships",
  "legacy_entity_mappings",
  "social_connections",
  "social_external_accounts",
  "social_destinations",
  "social_connection_scopes",
  "social_oauth_transactions",
  "social_encrypted_credentials",
  "social_reauth_grants",
  "social_audit_events"
]);
const CONNECTOR_RLS_TABLES = Object.freeze([
  ...PRE_0004_RLS_TABLES.slice(0, -1),
  "social_idempotency_operations",
  "social_publications",
  "social_publication_attempts",
  "social_audit_events"
]);
const RLS_TABLES = Object.freeze([
  ...CONNECTOR_RLS_TABLES,
  "social_meta_subject_mappings",
  "social_compliance_requests"
]);
const PRE_0004_BACKUP_TABLES = Object.freeze([
  "ia4tube_migrations.environment_identity",
  "ia4tube_migrations.schema_migrations",
  "ia4tube_social_admin.vault_key_versions",
  "ia4tube_social.companies",
  "ia4tube_social.users",
  "ia4tube_social.company_memberships",
  "ia4tube_social.social_connections",
  "ia4tube_social.social_external_accounts",
  "ia4tube_social.social_destinations",
  "ia4tube_social.social_connection_scopes",
  "ia4tube_social.social_oauth_transactions",
  "ia4tube_social.social_encrypted_credentials",
  "ia4tube_social.social_reauth_grants",
  "ia4tube_social.social_audit_events",
  "ia4tube_social.legacy_entity_mappings"
]);
const CONNECTOR_BACKUP_TABLES = Object.freeze([
  ...PRE_0004_BACKUP_TABLES.slice(0, -2),
  "ia4tube_social.social_idempotency_operations",
  "ia4tube_social.social_publications",
  "ia4tube_social.social_publication_attempts",
  "ia4tube_social.social_audit_events",
  "ia4tube_social.legacy_entity_mappings"
]);
const BACKUP_TABLES = Object.freeze([
  ...CONNECTOR_BACKUP_TABLES.slice(0, -2),
  "ia4tube_social.social_meta_subject_mappings",
  "ia4tube_social.social_compliance_requests",
  "ia4tube_social.social_audit_events",
  "ia4tube_social.legacy_entity_mappings"
]);
const EVIDENCE_TABLES = Object.freeze(
  [...BACKUP_TABLES].sort((left, right) => left.localeCompare(right))
);
const SCHEMA_PROFILES = Object.freeze([
  Object.freeze({
    id: "social-schema-0003",
    migrationRows: Object.freeze(EXPECTED_MIGRATION_ROWS.slice(0, 3)),
    backupTables: PRE_0004_BACKUP_TABLES,
    evidenceTables: Object.freeze(
      [...PRE_0004_BACKUP_TABLES].sort((left, right) =>
        left.localeCompare(right)
      )
    ),
    rlsTables: PRE_0004_RLS_TABLES
  }),
  Object.freeze({
    id: "social-schema-0004",
    migrationRows: Object.freeze(EXPECTED_MIGRATION_ROWS.slice(0, 4)),
    backupTables: CONNECTOR_BACKUP_TABLES,
    evidenceTables: Object.freeze(
      [...CONNECTOR_BACKUP_TABLES].sort((left, right) =>
        left.localeCompare(right)
      )
    ),
    rlsTables: CONNECTOR_RLS_TABLES
  }),
  Object.freeze({
    id: "social-schema-0005",
    migrationRows: PROFILE_0005_MIGRATION_ROWS,
    backupTables: CONNECTOR_BACKUP_TABLES,
    evidenceTables: Object.freeze(
      [...CONNECTOR_BACKUP_TABLES].sort((left, right) =>
        left.localeCompare(right)
      )
    ),
    rlsTables: CONNECTOR_RLS_TABLES
  }),
  Object.freeze({
    id: "social-schema-0006",
    migrationRows: PROFILE_0006_MIGRATION_ROWS,
    backupTables: BACKUP_TABLES,
    evidenceTables: EVIDENCE_TABLES,
    rlsTables: RLS_TABLES
  })
]);
const SOCIAL_CONNECTOR_UNVALIDATED_CONSTRAINTS = Object.freeze([
  Object.freeze({
    schema: "ia4tube_social",
    table: "social_external_accounts",
    name: "social_external_accounts_instagram_professional",
    type: "c"
  }),
  Object.freeze({
    schema: "ia4tube_social",
    table: "social_oauth_transactions",
    name: "social_oauth_transactions_connection_fk",
    type: "f"
  }),
  Object.freeze({
    schema: "ia4tube_social",
    table: "social_audit_events",
    name: "social_audit_events_reference_provider_present",
    type: "c"
  }),
  Object.freeze({
    schema: "ia4tube_social",
    table: "social_audit_events",
    name: "social_audit_events_connection_provider_fk",
    type: "f"
  }),
  Object.freeze({
    schema: "ia4tube_social",
    table: "social_audit_events",
    name: "social_audit_events_publication_provider_fk",
    type: "f"
  })
]);
const REQUIRED_VAULT_CONSTRAINT = Object.freeze({
  schema: "ia4tube_social",
  table: "social_encrypted_credentials",
  name: "social_encrypted_credentials_key_version_fk",
  type: "f"
});
const ALLOWED_UNVALIDATED_CONSTRAINTS_BY_PROFILE = Object.freeze({
  "social-schema-0003": Object.freeze([]),
  "social-schema-0004": SOCIAL_CONNECTOR_UNVALIDATED_CONSTRAINTS,
  "social-schema-0005": SOCIAL_CONNECTOR_UNVALIDATED_CONSTRAINTS,
  "social-schema-0006": SOCIAL_CONNECTOR_UNVALIDATED_CONSTRAINTS
});
const CURRENT_SCHEMA_PROFILE = SCHEMA_PROFILES.at(-1);
const TOOL_BASENAMES = Object.freeze({
  dump: new Set(["pg_dump", "pg_dump.exe"]),
  restore: new Set(["pg_restore", "pg_restore.exe"]),
  psql: new Set(["psql", "psql.exe"])
});

function fail(code) {
  postgresFail(code, "Backup PostgreSQL social recusado.");
}

function migrationRowsDigest(rows) {
  return crypto
    .createHash("sha256")
    .update(canonicalJson(rows))
    .digest("hex");
}

function schemaProfileById(
  value,
  failureCode = "backup_schema_profile_invalid"
) {
  const id = typeof value === "string" ? value : value?.id;
  const profile = SCHEMA_PROFILES.find((candidate) => candidate.id === id);
  if (!profile) fail(failureCode);
  return profile;
}

function constraintIdentity(value) {
  const parts = [value?.schema, value?.table, value?.name, value?.type];
  if (parts.some((part) => typeof part !== "string" || part.length === 0)) {
    return null;
  }
  return JSON.stringify(parts);
}

function catalogConstraintsMatchProfile(profile, rows) {
  const allowed = ALLOWED_UNVALIDATED_CONSTRAINTS_BY_PROFILE[profile?.id];
  if (!allowed || !Array.isArray(rows)) return false;
  const allowedIdentities = new Set(
    allowed.map((constraint) => constraintIdentity(constraint))
  );
  if (
    allowedIdentities.size !== allowed.length ||
    allowedIdentities.has(null)
  ) return false;

  const observedIdentities = new Set();
  const unvalidatedIdentities = new Set();
  for (const row of rows) {
    const identity = constraintIdentity({
      schema: row?.schema_name,
      table: row?.table_name,
      name: row?.constraint_name,
      type: row?.constraint_type
    });
    if (
      !identity ||
      typeof row?.validated !== "boolean" ||
      typeof row?.definition !== "string" ||
      row.definition.length === 0 ||
      observedIdentities.has(identity)
    ) return false;
    observedIdentities.add(identity);
    if (!row.validated) unvalidatedIdentities.add(identity);
  }

  const vaultIdentity = constraintIdentity(REQUIRED_VAULT_CONSTRAINT);
  return (
    observedIdentities.has(vaultIdentity) &&
    allowed.every((constraint) => (
      observedIdentities.has(constraintIdentity(constraint))
    )) &&
    [...unvalidatedIdentities].every((identity) => (
      allowedIdentities.has(identity)
    ))
  );
}

function normalizeRawMigrationRows(rows) {
  if (!Array.isArray(rows)) fail("backup_migration_state_invalid");
  return Object.freeze(
    rows.map((row) =>
      Object.freeze({
        version: String(row?.version || ""),
        checksum: requireSha256(
          String(row?.checksum || row?.checksum_sha256 || "").toLowerCase(),
          "backup_migration_checksum"
        )
      })
    )
  );
}

function resolveSchemaProfile(rows) {
  const normalized = normalizeRawMigrationRows(rows);
  const profile = SCHEMA_PROFILES.find(
    (candidate) =>
      candidate.migrationRows.length === normalized.length &&
      candidate.migrationRows.every(
        (expected, index) =>
          expected.version === normalized[index].version &&
          expected.checksum === normalized[index].checksum
      )
  );
  if (!profile) fail("backup_migration_state_invalid");
  return profile;
}

function schemaProfileContract(value) {
  const profile = schemaProfileById(value);
  return Object.freeze({
    id: profile.id,
    migrationLedgerSha256: migrationRowsDigest(profile.migrationRows),
    backupTables: profile.backupTables,
    rlsTables: profile.rlsTables
  });
}

function requireManifestSchemaProfile(manifest) {
  const stored = manifest?.schemaProfile;
  if (!stored) {
    const legacyProfile = resolveSchemaProfile(manifest?.evidence?.migrations);
    if (manifest?.format !== 2 || legacyProfile.id !== "social-schema-0003") {
      fail("restore_manifest_schema_profile_invalid");
    }
    return legacyProfile;
  }
  const profile = schemaProfileById(stored?.id);
  const expected = schemaProfileContract(profile);
  if (
    !stored ||
    canonicalJson(Object.keys(stored).sort()) !==
      canonicalJson(Object.keys(expected).sort()) ||
    stored.migrationLedgerSha256 !== expected.migrationLedgerSha256 ||
    !Array.isArray(stored.backupTables) ||
    !Array.isArray(stored.rlsTables) ||
    canonicalJson(stored.backupTables) !== canonicalJson(expected.backupTables) ||
    canonicalJson(stored.rlsTables) !== canonicalJson(expected.rlsTables)
  ) {
    fail("restore_manifest_schema_profile_invalid");
  }
  return profile;
}

function explicitTrue(value) {
  return String(value || "").trim().toLowerCase() === "true";
}

function requireText(value, code) {
  if (typeof value !== "string" || !value || value !== value.trim()) {
    fail(code);
  }
  return value;
}

function decodePart(value, code) {
  try {
    return decodeURIComponent(value);
  } catch {
    fail(code);
  }
}

function quoteIdentifier(value) {
  if (!LOGIN_PATTERN.test(value)) fail("backup_identifier_invalid");
  return `"${value}"`;
}

function quoteLiteral(value) {
  const text = String(value);
  if (/[\0\r\n]/.test(text)) fail("backup_literal_invalid");
  return `'${text.replace(/'/g, "''")}'`;
}

function quoteQualifiedTable(table) {
  if (!BACKUP_TABLES.includes(table)) fail("backup_table_invalid");
  const [schema, name] = table.split(".");
  return `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
}

function clientPathLiteral(file) {
  const normalized = path.resolve(file).replace(/\\/g, "/");
  return quoteLiteral(normalized);
}

function parseSecureDatabaseUrl(raw, field) {
  const value = requireText(raw, `${field}_missing`);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${field}_invalid`);
  }
  const queryKeys = [...new Set(parsed.searchParams.keys())];
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !parsed.hostname ||
    !parsed.username ||
    !parsed.password ||
    !parsed.pathname ||
    parsed.pathname === "/" ||
    parsed.hash ||
    queryKeys.length !== 1 ||
    queryKeys[0] !== "sslmode" ||
    parsed.searchParams.getAll("sslmode").length !== 1 ||
    parsed.searchParams.get("sslmode").toLowerCase() !== "verify-full"
  ) {
    fail(`${field}_invalid`);
  }
  const database = decodePart(parsed.pathname.slice(1), `${field}_invalid`);
  const login = decodePart(parsed.username, `${field}_invalid`).toLowerCase();
  if (!DATABASE_PATTERN.test(database) || !LOGIN_PATTERN.test(login)) {
    fail(`${field}_invalid`);
  }
  const connection = {
    public: Object.freeze({
      host: parsed.hostname.toLowerCase(),
      port: parsed.port || "5432",
      database,
      login
    })
  };
  Object.defineProperty(connection, "parsed", {
    value: parsed,
    enumerable: false,
    writable: false,
    configurable: false
  });
  return Object.freeze(connection);
}

function targetFingerprint(target) {
  return crypto
    .createHash("sha256")
    .update(
      [
        "ia4tube-social-backup-target-v2",
        target.host,
        target.port,
        target.database,
        "tls-verify-full"
      ].join("/")
    )
    .digest("hex");
}

function equalDigest(actual, expected) {
  if (
    !/^[0-9a-f]{64}$/.test(String(actual || "")) ||
    !/^[0-9a-f]{64}$/.test(String(expected || ""))
  ) {
    return false;
  }
  return crypto.timingSafeEqual(
    Buffer.from(actual, "hex"),
    Buffer.from(expected, "hex")
  );
}

function equalSecret(left, right) {
  const leftDigest = crypto.createHash("sha256").update(left).digest();
  const rightDigest = crypto.createHash("sha256").update(right).digest();
  try {
    return crypto.timingSafeEqual(leftDigest, rightDigest);
  } finally {
    leftDigest.fill(0);
    rightDigest.fill(0);
  }
}

function requireExpectedTarget(env, prefix, connection) {
  const expected = Object.freeze({
    host: requireText(
      env[`${prefix}_EXPECTED_HOST`],
      "backup_expected_host_missing"
    ).toLowerCase(),
    port: requireText(
      env[`${prefix}_EXPECTED_PORT`],
      "backup_expected_port_missing"
    ),
    database: requireText(
      env[`${prefix}_EXPECTED_DATABASE`],
      "backup_expected_database_missing"
    ),
    login: requireText(
      env[`${prefix}_EXPECTED_LOGIN`],
      "backup_expected_login_missing"
    ).toLowerCase()
  });
  if (
    expected.host !== connection.public.host ||
    expected.port !== connection.public.port ||
    expected.database !== connection.public.database ||
    expected.login !== connection.public.login
  ) {
    fail("backup_target_mismatch");
  }
  const fingerprint = targetFingerprint(connection.public);
  const expectedFingerprint = requireSha256(
    String(env[`${prefix}_EXPECTED_FINGERPRINT`] || "").toLowerCase(),
    "backup_expected_fingerprint"
  );
  if (!equalDigest(fingerprint, expectedFingerprint)) {
    fail("backup_target_fingerprint_mismatch");
  }
  return fingerprint;
}

function requireTool(raw, kind) {
  const supplied = requireText(raw, `backup_${kind}_path_missing`);
  if (!path.isAbsolute(supplied)) fail(`backup_${kind}_path_invalid`);
  const tool = path.normalize(supplied);
  if (!TOOL_BASENAMES[kind].has(path.basename(tool).toLowerCase())) {
    fail(`backup_${kind}_path_invalid`);
  }
  return tool;
}

function ensureOutsideRepository(directory, repositoryRoot, code) {
  const resolved = path.resolve(directory);
  const root = path.resolve(repositoryRoot);
  let checkedRoot = root;
  let checkedResolved = resolved;
  try {
    checkedRoot = fs.realpathSync(root);
    checkedResolved = fs.realpathSync(resolved);
  } catch {
    fail(code);
  }
  const relative = path.relative(checkedRoot, checkedResolved);
  if (!relative || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    fail(code);
  }
  return resolved;
}

function dataFileMap(directory, suffix) {
  return Object.freeze(
    Object.fromEntries(
      BACKUP_TABLES.map((table, index) => [
        table,
        path.join(
          directory,
          `${String(index + 1).padStart(2, "0")}.data.sql${suffix}`
        )
      ])
    )
  );
}

function backupWorkspaceId(label, sourceFingerprint) {
  return crypto
    .createHash("sha256")
    .update(`backup\u0000${label}\u0000${sourceFingerprint}`)
    .digest("hex")
    .slice(0, 32);
}

function backupWorkspacePath(outputDirectory, id) {
  return path.join(
    outputDirectory,
    `.ia4tube-social-workspace-backup-${id}`
  );
}

function bundleDataArchiveName(table, index) {
  return `${String(index + 2).padStart(2, "0")}-${table.replace(
    ".",
    "__"
  )}.data.sql`;
}

function bundleArchiveNames(schemaProfile = CURRENT_SCHEMA_PROFILE) {
  const profile = schemaProfileById(schemaProfile);
  return Object.freeze([
    BUNDLE_ARCHIVE_MANIFEST,
    BUNDLE_ARCHIVE_SCHEMA,
    ...profile.backupTables.map(bundleDataArchiveName)
  ]);
}

function bundleArchiveEntries(config, schemaProfile = CURRENT_SCHEMA_PROFILE) {
  const profile = schemaProfileById(schemaProfile);
  return Object.freeze([
    Object.freeze({
      name: BUNDLE_ARCHIVE_MANIFEST,
      path: config.files.manifest
    }),
    Object.freeze({
      name: BUNDLE_ARCHIVE_SCHEMA,
      path: config.files.schema
    }),
    ...profile.backupTables.map((table, index) =>
      Object.freeze({
        name: bundleDataArchiveName(table, index),
        path: config.files.data[table]
      })
    )
  ]);
}

function requirePermanentLogins(env, prefix, connection) {
  const migrationLogin = requireText(
    env[`${prefix}_EXPECTED_MIGRATION_LOGIN`],
    "backup_expected_migration_login_missing"
  );
  const runtimeLogin = requireText(
    env[`${prefix}_EXPECTED_RUNTIME_LOGIN`],
    "backup_expected_runtime_login_missing"
  );
  if (
    !LOGIN_PATTERN.test(migrationLogin) ||
    !LOGIN_PATTERN.test(runtimeLogin) ||
    migrationLogin === runtimeLogin ||
    connection.public.login !== migrationLogin
  ) {
    fail("backup_permanent_logins_invalid");
  }
  return Object.freeze({ migrationLogin, runtimeLogin });
}

function requireOperatorConnection(
  env,
  prefix,
  rawUrl,
  toolConnection,
  permanentLogins
) {
  const field = `${prefix.toLowerCase()}_provisioner_database_url`;
  const operator = parseSecureDatabaseUrl(rawUrl, field);
  const operatorFingerprint = requireExpectedTarget(env, prefix, operator);
  const toolFingerprint = targetFingerprint(toolConnection.public);
  if (
    operator.public.host !== toolConnection.public.host ||
    operator.public.port !== toolConnection.public.port ||
    operator.public.database !== toolConnection.public.database ||
    !equalDigest(operatorFingerprint, toolFingerprint)
  ) {
    fail("backup_operator_target_mismatch");
  }
  if (
    operator.public.login === permanentLogins.migrationLogin ||
    operator.public.login === permanentLogins.runtimeLogin ||
    [OWNER_ROLE, MIGRATOR_ROLE, RUNTIME_ROLE].includes(operator.public.login)
  ) {
    fail("backup_operator_login_invalid");
  }
  if (
    equalSecret(
      decodePart(
        operator.parsed.password,
        "backup_operator_database_password_invalid"
      ),
      decodePart(
        toolConnection.parsed.password,
        "backup_database_password_invalid"
      )
    )
  ) {
    fail("backup_operator_secret_reused");
  }
  return operator;
}

function freezeConfigWithBundleKey(properties, bundleKey) {
  const config = { ...properties };
  Object.defineProperty(config, "bundleKey", {
    value: bundleKey,
    enumerable: false,
    writable: false,
    configurable: false
  });
  return Object.freeze(config);
}

function loadBackupConfig(env = process.env, options = {}) {
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0") fail("backup_tls_disabled");
  if (env.SOCIAL_BACKUP_APPROVED !== BACKUP_APPROVAL) {
    fail("backup_approval_missing");
  }
  if (!explicitTrue(env.SOCIAL_BACKUP_DIRECTORY_PROTECTED)) {
    fail("backup_directory_protection_unconfirmed");
  }
  const repositoryRoot = path.resolve(options.repositoryRoot || process.cwd());
  const outputDirectory = ensureOutsideRepository(
    requireText(
      env.SOCIAL_BACKUP_OUTPUT_DIRECTORY,
      "backup_output_directory_missing"
    ),
    repositoryRoot,
    "backup_output_inside_repository"
  );
  const label = requireSafeLabel(
    env.SOCIAL_BACKUP_LABEL,
    "backup_label"
  ).toLowerCase();
  const source = parseSecureDatabaseUrl(
    env.SOCIAL_BACKUP_SOURCE_DATABASE_URL,
    "backup_source_database_url"
  );
  const sourceFingerprint = requireExpectedTarget(
    env,
    "SOCIAL_BACKUP_SOURCE",
    source
  );
  const permanentLogins = requirePermanentLogins(
    env,
    "SOCIAL_BACKUP",
    source
  );
  const operator = requireOperatorConnection(
    env,
    "SOCIAL_BACKUP_OPERATOR",
    env.SOCIAL_BACKUP_OPERATOR_PROVISIONER_DATABASE_URL,
    source,
    permanentLogins
  );
  const environmentId = requireUuid(
    env.SOCIAL_BACKUP_EXPECTED_ENVIRONMENT_ID,
    "backup_expected_environment_id"
  );
  const environment = requireSafeLabel(
    env.SOCIAL_BACKUP_EXPECTED_ENVIRONMENT,
    "backup_expected_environment"
  ).toLowerCase();
  const bundleKey = decodeBundleKey(env.SOCIAL_BACKUP_BUNDLE_KEY);
  const workspaceId = backupWorkspaceId(label, sourceFingerprint);
  const workspacePath = backupWorkspacePath(
    outputDirectory,
    workspaceId
  );
  const bundleBase = path.join(outputDirectory, label);
  return freezeConfigWithBundleKey({
    source,
    operator,
    postgresTls: loadSystemPostgresTls(env, operator.public.host),
    sourceFingerprint,
    permanentLogins,
    environmentId,
    environment,
    outputDirectory,
    label,
    workspace: Object.freeze({
      id: workspaceId,
      path: workspacePath,
      purpose: "backup"
    }),
    files: Object.freeze({
      schemaPartial: path.join(workspacePath, "schema.dump.partial"),
      schema: path.join(workspacePath, "schema.dump"),
      evidencePartial: path.join(workspacePath, "evidence.json.partial"),
      manifestPartial: path.join(workspacePath, "manifest.json.partial"),
      manifest: path.join(workspacePath, "manifest.json"),
      bundlePartial: `${bundleBase}.ia4sb.partial`,
      bundle: `${bundleBase}.ia4sb`,
      dataPartial: dataFileMap(workspacePath, ".partial"),
      data: dataFileMap(workspacePath, "")
    }),
    tools: Object.freeze({
      dump: requireTool(env.SOCIAL_BACKUP_PG_DUMP_PATH, "dump"),
      restore: requireTool(env.SOCIAL_BACKUP_PG_RESTORE_PATH, "restore"),
      psql: requireTool(env.SOCIAL_BACKUP_PSQL_PATH, "psql")
    })
  }, bundleKey);
}

function loadRestoreConfig(env = process.env, options = {}) {
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0") fail("restore_tls_disabled");
  if (env.SOCIAL_RESTORE_APPROVED !== RESTORE_APPROVAL) {
    fail("restore_approval_missing");
  }
  if (!explicitTrue(env.SOCIAL_RESTORE_WORK_DIRECTORY_PROTECTED)) {
    fail("restore_directory_protection_unconfirmed");
  }
  const repositoryRoot = path.resolve(options.repositoryRoot || process.cwd());
  const bundlePath = ensureOutsideRepository(
    requireText(env.SOCIAL_RESTORE_BUNDLE, "restore_bundle_missing"),
    repositoryRoot,
    "restore_bundle_inside_repository"
  );
  const workDirectory = ensureOutsideRepository(
    requireText(
      env.SOCIAL_RESTORE_WORK_DIRECTORY,
      "restore_work_directory_missing"
    ),
    repositoryRoot,
    "restore_work_directory_inside_repository"
  );
  const target = parseSecureDatabaseUrl(
    env.SOCIAL_RESTORE_TARGET_DATABASE_URL,
    "restore_target_database_url"
  );
  const targetFingerprintValue = requireExpectedTarget(
    env,
    "SOCIAL_RESTORE_TARGET",
    target
  );
  const permanentLogins = requirePermanentLogins(
    env,
    "SOCIAL_RESTORE",
    target
  );
  const operator = requireOperatorConnection(
    env,
    "SOCIAL_RESTORE_OPERATOR",
    env.SOCIAL_RESTORE_OPERATOR_PROVISIONER_DATABASE_URL,
    target,
    permanentLogins
  );
  if (
    !DISPOSABLE_DATABASE_PATTERN.test(target.public.database) ||
    BLOCKED_RESTORE_LABEL.test(target.public.database)
  ) {
    fail("restore_target_not_disposable");
  }
  const sourceFingerprint = requireSha256(
    String(env.SOCIAL_RESTORE_SOURCE_FINGERPRINT || "").toLowerCase(),
    "restore_source_fingerprint"
  );
  if (equalDigest(sourceFingerprint, targetFingerprintValue)) {
    fail("restore_target_equals_source");
  }
  const label = requireSafeLabel(
    env.SOCIAL_RESTORE_LABEL,
    "restore_label"
  ).toLowerCase();
  const bundleKey = decodeBundleKey(env.SOCIAL_BACKUP_BUNDLE_KEY);
  return freezeConfigWithBundleKey({
    bundlePath,
    label,
    sourceFingerprint,
    target,
    operator,
    postgresTls: loadSystemPostgresTls(env, operator.public.host),
    targetFingerprint: targetFingerprintValue,
    permanentLogins,
    workDirectory,
    files: Object.freeze({
      evidencePartial: path.join(
        workDirectory,
        `${label}.restored-evidence.json.partial`
      )
    }),
    tools: Object.freeze({
      restore: requireTool(env.SOCIAL_RESTORE_PG_RESTORE_PATH, "restore"),
      psql: requireTool(env.SOCIAL_RESTORE_PSQL_PATH, "psql")
    })
  }, bundleKey);
}

function policyName(table, command) {
  if (!RLS_TABLES.includes(table) || !["select", "all"].includes(command)) {
    fail("backup_policy_table_invalid");
  }
  return `${POLICY_PREFIX}${command}_${table}`;
}

function temporaryPolicySql(
  command = "select",
  schemaProfile = CURRENT_SCHEMA_PROFILE
) {
  const profile = schemaProfileById(schemaProfile);
  const all = command === "all";
  if (!all && command !== "select") fail("backup_policy_command_invalid");
  return Object.freeze(
    profile.rlsTables.map((table) => {
      const name = policyName(table, command);
      return Object.freeze({
        table,
        policy: name,
        create: [
          `CREATE POLICY ${quoteIdentifier(name)}`,
          `  ON ia4tube_social.${quoteIdentifier(table)}`,
          "  AS PERMISSIVE",
          `  FOR ${all ? "ALL" : "SELECT"}`,
          `  TO ${quoteIdentifier(OWNER_ROLE)}`,
          "  USING (TRUE)",
          ...(all ? ["  WITH CHECK (TRUE)"] : [])
        ].join("\n"),
        drop: [
          `DROP POLICY ${quoteIdentifier(name)}`,
          `  ON ia4tube_social.${quoteIdentifier(table)}`
        ].join("\n")
      });
    })
  );
}

function sameObjectIdentity(left, right) {
  return Boolean(
    left &&
      right &&
      left.dev === right.dev &&
      left.ino === right.ino
  );
}

function sameStableFileIdentity(left, right) {
  return Boolean(
    sameObjectIdentity(left, right) &&
      left.size === right.size &&
      left.mtimeMs === right.mtimeMs &&
      left.ctimeMs === right.ctimeMs
  );
}

function systemRootBundleBytes(rootCertificates = tls.rootCertificates) {
  if (
    !Array.isArray(rootCertificates) ||
    rootCertificates.length < 1 ||
    rootCertificates.length > 1024
  ) {
    fail("backup_tls_root_certificates_invalid");
  }
  for (const certificate of rootCertificates) {
    if (
      typeof certificate !== "string" ||
      certificate !== certificate.trim() ||
      !PEM_CERTIFICATE.test(certificate)
    ) {
      fail("backup_tls_root_certificates_invalid");
    }
    try {
      new crypto.X509Certificate(certificate);
    } catch {
      fail("backup_tls_root_certificates_invalid");
    }
  }
  const bytes = Buffer.from(`${rootCertificates.join("\n")}\n`, "ascii");
  if (
    bytes.length < 1 ||
    bytes.length > MAX_SYSTEM_ROOT_BUNDLE_BYTES
  ) {
    bytes.fill(0);
    fail("backup_tls_root_certificates_invalid");
  }
  return bytes;
}

function requireProtectedWorkspace(workspace, fileSystem = fs) {
  if (
    !workspace ||
    typeof workspace.path !== "string" ||
    !path.isAbsolute(workspace.path) ||
    !workspace.identity
  ) {
    fail("backup_tls_root_workspace_invalid");
  }
  const workspacePath = path.resolve(workspace.path);
  let current;
  try {
    current = fileSystem.lstatSync(workspacePath);
  } catch {
    fail("backup_tls_root_workspace_invalid");
  }
  if (
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    !sameObjectIdentity(workspace.identity, current) ||
    (process.platform !== "win32" && (current.mode & 0o077) !== 0)
  ) {
    fail("backup_tls_root_workspace_invalid");
  }
  return Object.freeze({
    path: workspacePath,
    identity: current
  });
}

function freezeSystemRootBundle(properties, privateProperties) {
  const bundle = { ...properties };
  for (const [name, value] of Object.entries(privateProperties)) {
    Object.defineProperty(bundle, name, {
      value,
      enumerable: false,
      writable: false,
      configurable: false
    });
  }
  return Object.freeze(bundle);
}

function createSystemRootCertificateBundle({
  workspace,
  rootCertificates = tls.rootCertificates,
  fileSystem = fs
}) {
  const checkedWorkspace = requireProtectedWorkspace(workspace, fileSystem);
  const file = path.join(
    checkedWorkspace.path,
    SYSTEM_ROOT_BUNDLE_NAME
  );
  const bytes = systemRootBundleBytes(rootCertificates);
  let descriptor;
  let ownedIdentity;
  try {
    descriptor = fileSystem.openSync(
      file,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW || 0),
      0o600
    );
    const opened = fileSystem.fstatSync(descriptor);
    if (!opened.isFile()) {
      fail("backup_tls_root_bundle_creation_failed");
    }
    ownedIdentity = opened;
    fileSystem.writeFileSync(descriptor, bytes);
    fileSystem.fchmodSync(descriptor, 0o600);
    fileSystem.fsyncSync(descriptor);
    const completed = fileSystem.fstatSync(descriptor);
    if (
      !completed.isFile() ||
      !sameObjectIdentity(opened, completed) ||
      completed.size !== bytes.length ||
      (process.platform !== "win32" && (completed.mode & 0o077) !== 0)
    ) {
      fail("backup_tls_root_bundle_creation_failed");
    }
    ownedIdentity = completed;
    fileSystem.closeSync(descriptor);
    descriptor = undefined;
    const published = fileSystem.lstatSync(file);
    if (
      !published.isFile() ||
      published.isSymbolicLink() ||
      !sameStableFileIdentity(completed, published)
    ) {
      fail("backup_tls_root_bundle_creation_failed");
    }
    return freezeSystemRootBundle(
      {
        path: file,
        size: completed.size,
        sha256: crypto.createHash("sha256").update(bytes).digest("hex")
      },
      {
        identity: completed,
        workspaceIdentity: checkedWorkspace.identity,
        workspacePath: checkedWorkspace.path
      }
    );
  } catch (error) {
    let descriptorCleanupFailed = false;
    let fileCleanupFailed = false;
    if (descriptor !== undefined) {
      try {
        fileSystem.closeSync(descriptor);
      } catch {
        descriptorCleanupFailed = true;
      }
    }
    if (ownedIdentity) {
      try {
        const current = fileSystem.lstatSync(file);
        if (
          !current.isFile() ||
          current.isSymbolicLink() ||
          !sameObjectIdentity(ownedIdentity, current)
        ) {
          fileCleanupFailed = true;
        } else {
          fileSystem.unlinkSync(file);
          fileCleanupFailed = fileSystem.existsSync(file);
        }
      } catch (cleanupError) {
        fileCleanupFailed = cleanupError?.code !== "ENOENT";
      }
    }
    bytes.fill(0);
    if (fileCleanupFailed) fail("backup_tls_root_bundle_cleanup_failed");
    if (descriptorCleanupFailed) {
      fail("backup_tls_root_bundle_descriptor_cleanup_failed");
    }
    if (error instanceof SocialPostgresError) throw error;
    if (error?.code === "EEXIST") {
      fail("backup_tls_root_bundle_collision");
    }
    fail("backup_tls_root_bundle_creation_failed");
  } finally {
    bytes.fill(0);
  }
}

function inspectSystemRootCertificateBundle(bundle, fileSystem = fs) {
  if (
    !bundle ||
    typeof bundle.path !== "string" ||
    !path.isAbsolute(bundle.path) ||
    path.basename(bundle.path) !== SYSTEM_ROOT_BUNDLE_NAME ||
    path.dirname(path.resolve(bundle.path)) !==
      path.resolve(bundle.workspacePath || "") ||
    !bundle.identity ||
    !bundle.workspaceIdentity ||
    !Number.isSafeInteger(bundle.size) ||
    bundle.size < 1 ||
    bundle.size > MAX_SYSTEM_ROOT_BUNDLE_BYTES ||
    !/^[0-9a-f]{64}$/.test(String(bundle.sha256 || ""))
  ) {
    fail("backup_tls_root_bundle_invalid");
  }
  const workspace = requireProtectedWorkspace(
    {
      path: bundle.workspacePath,
      identity: bundle.workspaceIdentity
    },
    fileSystem
  );
  let descriptor;
  let bytes;
  try {
    const before = fileSystem.lstatSync(bundle.path);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      !sameStableFileIdentity(bundle.identity, before) ||
      (process.platform !== "win32" && (before.mode & 0o077) !== 0)
    ) {
      fail("backup_tls_root_bundle_changed");
    }
    descriptor = fileSystem.openSync(
      bundle.path,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
    );
    const opened = fileSystem.fstatSync(descriptor);
    if (!sameStableFileIdentity(before, opened)) {
      fail("backup_tls_root_bundle_changed");
    }
    bytes = fileSystem.readFileSync(descriptor);
    const after = fileSystem.fstatSync(descriptor);
    const digest = crypto.createHash("sha256").update(bytes).digest("hex");
    if (
      bytes.length !== bundle.size ||
      !sameStableFileIdentity(opened, after) ||
      !equalDigest(digest, bundle.sha256)
    ) {
      fail("backup_tls_root_bundle_changed");
    }
    return Object.freeze({
      path: path.join(workspace.path, SYSTEM_ROOT_BUNDLE_NAME),
      identity: after
    });
  } catch (error) {
    if (error instanceof SocialPostgresError) throw error;
    fail("backup_tls_root_bundle_invalid");
  } finally {
    if (bytes) bytes.fill(0);
    if (descriptor !== undefined) {
      try {
        fileSystem.closeSync(descriptor);
      } catch {
        fail("backup_tls_root_bundle_descriptor_cleanup_failed");
      }
    }
  }
}

function cleanupSystemRootCertificateBundle(bundle, fileSystem = fs) {
  inspectSystemRootCertificateBundle(bundle, fileSystem);
  try {
    const current = fileSystem.lstatSync(bundle.path);
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      !sameStableFileIdentity(bundle.identity, current)
    ) {
      fail("backup_tls_root_bundle_changed");
    }
    fileSystem.unlinkSync(bundle.path);
    if (fileSystem.existsSync(bundle.path)) {
      fail("backup_tls_root_bundle_cleanup_failed");
    }
    return true;
  } catch (error) {
    if (error instanceof SocialPostgresError) throw error;
    fail("backup_tls_root_bundle_cleanup_failed");
  }
}

function safeChildEnvironment(env = process.env) {
  const safe = {};
  for (const name of [
    "SYSTEMROOT",
    "WINDIR",
    "TEMP",
    "TMP",
    "TMPDIR",
    "LANG",
    "LC_ALL"
  ]) {
    if (typeof env[name] === "string" && env[name]) safe[name] = env[name];
  }
  return safe;
}

function childConnectionEnvironment(
  connection,
  rootCertificateBundle,
  env = process.env,
  fileSystem = fs
) {
  const trustedRoots = inspectSystemRootCertificateBundle(
    rootCertificateBundle,
    fileSystem
  );
  return Object.freeze({
    ...safeChildEnvironment(env),
    PGHOST: connection.public.host,
    PGPORT: connection.public.port,
    PGDATABASE: connection.public.database,
    PGUSER: connection.public.login,
    PGPASSWORD: decodePart(
      connection.parsed.password,
      "backup_database_password_invalid"
    ),
    PGCONNECT_TIMEOUT: "10",
    PGCHANNELBINDING: "disable",
    PGSSLMODE: "verify-full",
    PGSSLROOTCERT: "system",
    SSL_CERT_FILE: trustedRoots.path,
    PGAPPNAME: "ia4tube-social-backup-restore"
  });
}

function psqlPlan(
  executable,
  connection,
  input,
  rootCertificateBundle,
  fileSystem = fs
) {
  return Object.freeze({
    executable,
    args: Object.freeze([
      "--no-password",
      "--no-psqlrc",
      "--set=ON_ERROR_STOP=1",
      "--set=VERBOSITY=terse",
      "--quiet",
      "--file=-"
    ]),
    env: childConnectionEnvironment(
      connection,
      rootCertificateBundle,
      process.env,
      fileSystem
    ),
    input
  });
}

function schemaDumpPlan(config, rootCertificateBundle, fileSystem = fs) {
  return Object.freeze({
    executable: config.tools.dump,
    args: Object.freeze([
      "--format=custom",
      "--compress=9",
      "--no-password",
      `--role=${OWNER_ROLE}`,
      "--schema=ia4tube_social",
      "--schema=ia4tube_social_admin",
      "--schema=ia4tube_migrations",
      "--lock-wait-timeout=10000",
      "--schema-only",
      `--file=${config.files.schemaPartial}`
    ]),
    env: childConnectionEnvironment(
      config.source,
      rootCertificateBundle,
      process.env,
      fileSystem
    )
  });
}

function schemaListPlan(executable, archive, env = process.env) {
  return Object.freeze({
    executable,
    args: Object.freeze(["--list", archive]),
    env: Object.freeze(safeChildEnvironment(env))
  });
}

function restoreSchemaPlan(
  config,
  manifest,
  rootCertificateBundle,
  fileSystem = fs
) {
  return Object.freeze({
    executable: config.tools.restore,
    args: Object.freeze([
      "--exit-on-error",
      "--single-transaction",
      "--no-password",
      "--no-owner",
      `--role=${OWNER_ROLE}`,
      `--dbname=${config.target.public.database}`,
      manifest.files.schema.path
    ]),
    env: childConnectionEnvironment(
      config.target,
      rootCertificateBundle,
      process.env,
      fileSystem
    )
  });
}

function migrationAssertionSql(schemaProfile = CURRENT_SCHEMA_PROFILE) {
  const profile = schemaProfileById(schemaProfile);
  const values = profile.migrationRows.map(
    (entry) =>
      `(${quoteLiteral(entry.version)}, ${quoteLiteral(entry.checksum)})`
  ).join(",\n      ");
  return [
    "IF EXISTS (",
    "  SELECT 1",
    `  FROM (VALUES ${values}) expected(version, checksum)`,
    "  FULL JOIN ia4tube_migrations.schema_migrations actual",
    "    ON actual.version = expected.version",
    "  WHERE expected.version IS NULL",
    "    OR actual.version IS NULL",
    "    OR actual.checksum_sha256 <> expected.checksum",
    ") THEN",
    "  RAISE EXCEPTION 'ia4tube_backup_migration_state_invalid';",
    "END IF;"
  ].join("\n");
}

function preflightSql(config, connection, options = {}) {
  const expectedEnvironment = config.environment || "restore";
  const expectedEnvironmentId =
    config.environmentId || "00000000-0000-4000-8000-000000000001";
  return [
    "DO $ia4tube_backup_preflight$",
    "BEGIN",
    "  IF current_setting('server_version_num')::integer < 180000 OR",
    "     current_setting('server_version_num')::integer >= 190000 THEN",
    "    RAISE EXCEPTION 'ia4tube_backup_postgres_18_required';",
    "  END IF;",
    `  IF session_user <> ${quoteLiteral(connection.public.login)} THEN`,
    "    RAISE EXCEPTION 'ia4tube_backup_login_mismatch';",
    "  END IF;",
    ...(config.environmentId
      ? [
          "  IF NOT EXISTS (",
          "    SELECT 1",
          "    FROM ia4tube_migrations.environment_identity",
          "    WHERE singleton = TRUE",
          `      AND environment_id = ${quoteLiteral(expectedEnvironmentId)}::uuid`,
          `      AND environment_name = ${quoteLiteral(expectedEnvironment)}`,
          "  ) THEN",
          "    RAISE EXCEPTION 'ia4tube_backup_environment_mismatch';",
          "  END IF;"
        ]
      : []),
    ...(options.skipMigrations
      ? []
      : [migrationAssertionSql(options.schemaProfile)]),
    "  IF EXISTS (",
    "    SELECT 1 FROM pg_catalog.pg_policies",
    "    WHERE schemaname = 'ia4tube_social'",
    `      AND left(policyname, length(${quoteLiteral(POLICY_PREFIX)})) = ` +
      quoteLiteral(POLICY_PREFIX),
    "  ) THEN",
    "    RAISE EXCEPTION 'ia4tube_backup_transient_policy_present';",
    "  END IF;",
    "END",
    "$ia4tube_backup_preflight$;"
  ].join("\n");
}

function evidenceSelectSql(
  outputFile,
  schemaProfile = CURRENT_SCHEMA_PROFILE
) {
  const profile = schemaProfileById(schemaProfile);
  const countParts = profile.backupTables.map(
    (table) =>
      `SELECT ${quoteLiteral(table)}::text AS table_name, ` +
      `COUNT(*)::bigint AS row_count FROM ${quoteQualifiedTable(table)}`
  ).join("\nUNION ALL\n");
  return [
    `\\o ${clientPathLiteral(outputFile)}`,
    "SELECT jsonb_build_object(",
    "  'tableCounts', (",
    "    SELECT jsonb_agg(",
    "      jsonb_build_object(",
    "        'table', counts.table_name,",
    "        'count', counts.row_count",
    "      ) ORDER BY counts.table_name",
    "    )",
    "    FROM (",
    countParts,
    "    ) counts",
    "  ),",
    "  'migrations', (",
    "    SELECT jsonb_agg(",
    "      jsonb_build_object(",
    "        'version', version,",
    "        'checksum', checksum_sha256",
    "      ) ORDER BY version",
    "    )",
    "    FROM ia4tube_migrations.schema_migrations",
    "  )",
    ")::text;",
    "\\o"
  ].join("\n");
}

function assertPoliciesAbsentSql() {
  return [
    "DO $ia4tube_backup_policy_cleanup$",
    "BEGIN",
    "  IF EXISTS (",
    "    SELECT 1 FROM pg_catalog.pg_policies",
    "    WHERE schemaname = 'ia4tube_social'",
    `      AND left(policyname, length(${quoteLiteral(POLICY_PREFIX)})) = ` +
      quoteLiteral(POLICY_PREFIX),
    "  ) THEN",
    "    RAISE EXCEPTION 'ia4tube_backup_policy_cleanup_failed';",
    "  END IF;",
    "END",
    "$ia4tube_backup_policy_cleanup$;"
  ].join("\n");
}

function psqlHeader() {
  return [
    "\\set ON_ERROR_STOP on",
    "\\pset pager off",
    "\\pset tuples_only on",
    "\\pset format unaligned",
    "BEGIN ISOLATION LEVEL REPEATABLE READ;",
    "SET LOCAL lock_timeout = '10s';",
    "SET LOCAL statement_timeout = '15min';",
    `SET LOCAL ROLE ${quoteIdentifier(OWNER_ROLE)};`
  ];
}

function dataRowSql(table) {
  const [schema, name] = table.split(".");
  return [
    "SELECT format(",
    `  'INSERT INTO %I.%I SELECT (jsonb_populate_record(NULL::%I.%I, %L::jsonb)).*;',`,
    `  ${quoteLiteral(schema)}, ${quoteLiteral(name)},`,
    `  ${quoteLiteral(schema)}, ${quoteLiteral(name)},`,
    "  to_jsonb(source_row)::text",
    ")",
    `FROM ${quoteQualifiedTable(table)} source_row;`
  ].join("\n");
}

function createBackupDataScript(
  config,
  schemaProfile = CURRENT_SCHEMA_PROFILE
) {
  const profile = schemaProfileById(schemaProfile);
  const policies = temporaryPolicySql("select", profile);
  const lines = [
    ...psqlHeader(),
    preflightSql(config, config.source, { schemaProfile: profile }),
    ...policies.map((policy) => `${policy.create};`)
  ];
  for (const table of profile.backupTables) {
    lines.push(`\\o ${clientPathLiteral(config.files.dataPartial[table])}`);
    lines.push(`\\qecho -- IA4Tube logical data: ${table}`);
    lines.push(dataRowSql(table));
    lines.push("\\o");
  }
  lines.push(evidenceSelectSql(config.files.evidencePartial, profile));
  lines.push(...[...policies].reverse().map((policy) => `${policy.drop};`));
  lines.push(assertPoliciesAbsentSql(), "COMMIT;");
  return `${lines.join("\n")}\n`;
}

function createRestoreDataScript(config, manifest) {
  const profile = requireManifestSchemaProfile(manifest);
  const policies = temporaryPolicySql("all", profile);
  const lines = [
    ...psqlHeader(),
    preflightSql({}, config.target, { skipMigrations: true }),
    ...policies.map((policy) => `${policy.create};`)
  ];
  for (const table of profile.backupTables) {
    const entry = manifest.files.data.find((file) => file.table === table);
    if (!entry) fail("restore_manifest_table_missing");
    lines.push(`\\i ${clientPathLiteral(entry.path)}`);
  }
  lines.push(...[...policies].reverse().map((policy) => `${policy.drop};`));
  lines.push(assertPoliciesAbsentSql(), "COMMIT;");
  return `${lines.join("\n")}\n`;
}

function createEvidenceScript(config, outputFile, sourceManifest) {
  const profile = requireManifestSchemaProfile(sourceManifest);
  const policies = temporaryPolicySql("select", profile);
  const source = sourceManifest?.source;
  const expectedSource =
    source?.environmentId && source?.environment
      ? {
          environmentId: source.environmentId,
          environment: source.environment
        }
      : {};
  return `${[
    ...psqlHeader(),
    preflightSql(expectedSource, config.target, { schemaProfile: profile }),
    ...policies.map((policy) => `${policy.create};`),
    evidenceSelectSql(outputFile, profile),
    ...[...policies].reverse().map((policy) => `${policy.drop};`),
    assertPoliciesAbsentSql(),
    "COMMIT;"
  ].join("\n")}\n`;
}

function assertSecretFreePlan(plan, secretValues) {
  const serialized = JSON.stringify({
    executable: plan.executable,
    args: plan.args,
    input: plan.input
  });
  for (const secret of secretValues) {
    if (typeof secret === "string" && secret && serialized.includes(secret)) {
      fail("backup_secret_in_process_plan");
    }
  }
  return true;
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function evidenceDigest(evidence) {
  return crypto
    .createHash("sha256")
    .update(canonicalJson(evidence))
    .digest("hex");
}

function normalizeMigrationEvidence(rows, expectedSchemaProfile) {
  const migrations = normalizeRawMigrationRows(rows);
  const profile = resolveSchemaProfile(migrations);
  if (
    expectedSchemaProfile &&
    profile.id !== schemaProfileById(expectedSchemaProfile).id
  ) {
    fail("backup_migration_state_invalid");
  }
  return Object.freeze({ migrations, profile });
}

function normalizeCatalogEvidence(catalog, profile) {
  if (
    !catalog ||
    Number(catalog.rlsTableCount) !== profile.rlsTables.length ||
    Number(catalog.forcedRlsTableCount) !== profile.rlsTables.length ||
    Number(catalog.transientPolicyCount) !== 0 ||
    Number(catalog.canonicalRoleCount) !== 3 ||
    catalog.runtimeEscalationPossible !== false ||
    catalog.requiredConstraintsPresent !== true ||
    catalog.compatibleWith2A !== true
  ) {
    fail("backup_catalog_state_invalid");
  }
  return Object.freeze({
    rlsTableCount: profile.rlsTables.length,
    forcedRlsTableCount: profile.rlsTables.length,
    transientPolicyCount: 0,
    canonicalRoleCount: 3,
    runtimeEscalationPossible: false,
    requiredConstraintsPresent: true,
    compatibleWith2A: true,
    policyDigest: requireSha256(
      String(catalog.policyDigest || "").toLowerCase(),
      "backup_policy_digest"
    ),
    constraintDigest: requireSha256(
      String(catalog.constraintDigest || "").toLowerCase(),
      "backup_constraint_digest"
    ),
    roleDigest: requireSha256(
      String(catalog.roleDigest || "").toLowerCase(),
      "backup_role_digest"
    )
  });
}

function normalizeEvidence(raw, expectedSchemaProfile) {
  const migrationState = normalizeMigrationEvidence(
    raw?.migrations,
    expectedSchemaProfile
  );
  const profile = migrationState.profile;
  const tableCounts = [...(raw?.tableCounts || [])]
    .map((row) =>
      Object.freeze({
        table: String(row.table || ""),
        count: Number(row.count)
      })
    )
    .sort((left, right) => left.table.localeCompare(right.table));
  if (
    tableCounts.length !== profile.evidenceTables.length ||
    tableCounts.some(
      (row, index) =>
        row.table !== profile.evidenceTables[index] ||
        !Number.isSafeInteger(row.count) ||
        row.count < 0
    )
  ) {
    fail("backup_table_counts_invalid");
  }
  const catalog = normalizeCatalogEvidence(raw?.catalog, profile);
  return Object.freeze({
    tableCounts: Object.freeze(tableCounts),
    migrations: migrationState.migrations,
    catalog
  });
}

function hashFile(file, fileSystem = fs) {
  const descriptor = fileSystem.openSync(file, "r");
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let size = 0;
  try {
    while (true) {
      const read = fileSystem.readSync(
        descriptor,
        buffer,
        0,
        buffer.length,
        null
      );
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
      size += read;
    }
  } finally {
    buffer.fill(0);
    fileSystem.closeSync(descriptor);
  }
  return Object.freeze({ size, sha256: hash.digest("hex") });
}

function buildManifest({ config, evidence, generatedAt, fileSystem = fs }) {
  const normalized = normalizeEvidence(evidence);
  const profile = resolveSchemaProfile(normalized.migrations);
  const schema = hashFile(config.files.schema, fileSystem);
  const data = profile.backupTables.map((table) => {
    const metadata = hashFile(config.files.data[table], fileSystem);
    if (metadata.size < 1) fail("backup_data_file_empty");
    return Object.freeze({
      table,
      path: config.files.data[table],
      format: "psql-jsonb-insert-v1",
      ...metadata
    });
  });
  return Object.freeze({
    format: 3,
    kind: "ia4tube-social-postgresql-logical-bundle",
    generatedAt: new Date(generatedAt || Date.now()).toISOString(),
    source: Object.freeze({
      fingerprint: config.sourceFingerprint,
      environmentId: config.environmentId,
      environment: config.environment,
      postgresMajor: POSTGRES_MAJOR
    }),
    schemaProfile: schemaProfileContract(profile),
    files: Object.freeze({
      schema: Object.freeze({
        path: config.files.schema,
        format: "pg_dump-custom-schema-only",
        ...schema
      }),
      data: Object.freeze(data)
    }),
    evidence: normalized,
    evidenceSha256: evidenceDigest(normalized)
  });
}

function readSmallJson(file, fileSystem = fs) {
  const stat = fileSystem.statSync(file);
  if (!stat.isFile() || stat.size < 2 || stat.size > MAX_METADATA_BYTES) {
    fail("backup_metadata_file_invalid");
  }
  try {
    return JSON.parse(fileSystem.readFileSync(file, "utf8"));
  } catch {
    fail("backup_metadata_file_invalid");
  }
}

function materializeExtractedManifest(
  extracted,
  schemaProfile,
  fileSystem = fs
) {
  const profile = schemaProfileById(schemaProfile);
  const names = bundleArchiveNames(profile);
  if (
    !extracted ||
    !Array.isArray(extracted.files) ||
    extracted.files.length !== names.length ||
    extracted.files.some((entry, index) => entry?.name !== names[index])
  ) {
    fail("restore_encrypted_bundle_invalid");
  }
  const byName = new Map(
    extracted.files.map((entry) => [entry.name, entry.path])
  );
  const stored = readSmallJson(
    byName.get(BUNDLE_ARCHIVE_MANIFEST),
    fileSystem
  );
  const storedProfile = requireManifestSchemaProfile(stored);
  if (
    storedProfile.id !== profile.id ||
    !stored?.files?.schema ||
    !Array.isArray(stored?.files?.data) ||
    stored.files.data.length !== profile.backupTables.length
  ) {
    fail("restore_manifest_invalid");
  }
  return Object.freeze({
    ...stored,
    files: Object.freeze({
      schema: Object.freeze({
        ...stored.files.schema,
        path: byName.get(BUNDLE_ARCHIVE_SCHEMA)
      }),
      data: Object.freeze(
        stored.files.data.map((entry, index) =>
          Object.freeze({
            ...entry,
            path: byName.get(
              bundleDataArchiveName(profile.backupTables[index], index)
            )
          })
        )
      )
    })
  });
}

function validateManifestFiles(manifest, options = {}) {
  const fileSystem = options.fileSystem || fs;
  if (
    ![2, 3].includes(manifest?.format) ||
    (manifest?.format === 2 && manifest.schemaProfile !== undefined) ||
    (manifest?.format === 3 && !manifest.schemaProfile) ||
    manifest?.kind !== "ia4tube-social-postgresql-logical-bundle" ||
    !manifest.source ||
    manifest.source.postgresMajor !== POSTGRES_MAJOR ||
    !/^[0-9a-f]{64}$/.test(String(manifest.source.fingerprint || "")) ||
    requireUuid(
      manifest.source.environmentId,
      "restore_manifest_environment_id"
    ) !== manifest.source.environmentId ||
    requireSafeLabel(
      manifest.source.environment,
      "restore_manifest_environment"
    ) !== manifest.source.environment
  ) {
    fail("restore_manifest_invalid");
  }
  const profile = requireManifestSchemaProfile(manifest);
  if (
    options.sourceFingerprint &&
    !equalDigest(manifest.source.fingerprint, options.sourceFingerprint)
  ) {
    fail("restore_manifest_source_mismatch");
  }
  const expectedDirectory = options.expectedDirectory
    ? path.resolve(options.expectedDirectory)
    : null;
  const entries = [
    manifest.files?.schema,
    ...(manifest.files?.data || [])
  ];
  if (
    entries.length !== profile.backupTables.length + 1 ||
    manifest.files.data.some(
      (entry, index) => entry.table !== profile.backupTables[index]
    )
  ) {
    fail("restore_manifest_invalid");
  }
  for (const entry of entries) {
    if (
      !entry ||
      !path.isAbsolute(entry.path) ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 1 ||
      (expectedDirectory &&
        path.resolve(path.dirname(entry.path)) !== expectedDirectory)
    ) {
      fail("restore_manifest_invalid");
    }
    const actual = hashFile(entry.path, fileSystem);
    if (
      actual.size !== entry.size ||
      !equalDigest(actual.sha256, entry.sha256)
    ) {
      fail("restore_archive_integrity_failed");
    }
  }
  const normalized = normalizeEvidence(manifest.evidence, profile);
  if (!equalDigest(evidenceDigest(normalized), manifest.evidenceSha256)) {
    fail("restore_manifest_integrity_failed");
  }
  return normalized;
}

function compareRestoredEvidence(expected, actual) {
  const normalizedExpected = normalizeEvidence(expected);
  const profile = resolveSchemaProfile(normalizedExpected.migrations);
  const normalizedActual = normalizeEvidence(actual, profile);
  if (
    !equalDigest(
      evidenceDigest(normalizedExpected),
      evidenceDigest(normalizedActual)
    )
  ) {
    fail("restore_evidence_mismatch");
  }
  return true;
}

function assertSchemaArchiveList(
  text,
  schemaProfile = CURRENT_SCHEMA_PROFILE
) {
  const profile = schemaProfileById(schemaProfile);
  const output = String(text || "");
  if (output.includes(POLICY_PREFIX)) fail("backup_transient_policy_archived");
  for (const table of profile.backupTables) {
    const [schema, name] = table.split(".");
    if (!output.includes(schema) || !output.includes(name)) {
      fail("backup_schema_archive_incomplete");
    }
  }
  return true;
}

function existingOutputFiles(config) {
  return [
    config.files.schemaPartial,
    config.files.schema,
    config.files.evidencePartial,
    config.files.manifestPartial,
    config.files.manifest,
    config.files.bundlePartial,
    config.files.bundle,
    ...Object.values(config.files.dataPartial),
    ...Object.values(config.files.data)
  ];
}

function assertFreshOutput(config, fileSystem = fs) {
  if (!fileSystem.statSync(config.outputDirectory).isDirectory()) {
    fail("backup_output_directory_invalid");
  }
  if (existingOutputFiles(config).some((file) => fileSystem.existsSync(file))) {
    fail("backup_output_already_exists");
  }
}

function safeToolFailure() {
  return new SocialPostgresError(
    "backup_external_tool_failed",
    "Ferramenta PostgreSQL recusou a operacao."
  );
}

function digestRows(rows) {
  return crypto
    .createHash("sha256")
    .update(canonicalJson(rows || []))
    .digest("hex");
}

function createPostgresBackupOperator(pool) {
  if (!pool || typeof pool.connect !== "function") {
    fail("backup_pool_invalid");
  }
  let client;
  let heldLocks = [];

  function requireClient() {
    if (!client) fail("backup_lock_session_missing");
    return client;
  }

  async function querySafe(text, values = []) {
    try {
      return await requireClient().query(text, values);
    } catch {
      fail("backup_catalog_query_failed");
    }
  }

  async function acquireLocks(lockIds) {
    if (client || !Array.isArray(lockIds) || lockIds.length !== 2) {
      fail("backup_lock_state_invalid");
    }
    try {
      client = await pool.connect();
      for (const lockId of lockIds) {
        await client.query("SELECT pg_catalog.pg_advisory_lock($1::bigint)", [
          lockId
        ]);
        heldLocks.push(lockId);
      }
    } catch {
      if (client) {
        try {
          for (const lockId of [...heldLocks].reverse()) {
            await client.query(
              "SELECT pg_catalog.pg_advisory_unlock($1::bigint)",
              [lockId]
            );
          }
        } catch {
          // The session is discarded below, which releases session locks.
        }
        client.release(new Error("backup_lock_acquire_failed"));
      }
      client = undefined;
      heldLocks = [];
      fail("backup_lock_acquire_failed");
    }
  }

  async function inspectPermanentLogins(config) {
    return inspectPermanentDatabaseLogins(
      { query: querySafe },
      config.permanentLogins
    );
  }

  async function inspectSchemaProfile() {
    const result = await querySafe(
      [
        "SELECT version, checksum_sha256 AS checksum",
        "FROM ia4tube_migrations.schema_migrations",
        "ORDER BY version"
      ].join("\n")
    );
    return resolveSchemaProfile(result.rows || []);
  }

  async function inspectPrincipal(connection) {
    const result = await querySafe(
      [
        "SELECT",
        "  current_setting('server_version_num')::integer >= 180000",
        "    AND current_setting('server_version_num')::integer < 190000",
        "    AS postgres_version_supported,",
        "  current_database() = $1 AS database_exact,",
        "  session_user = $2 AS login_exact,",
        "  database_owner.oid = login.oid AS database_owner_exact,",
        "  login.rolcanlogin AS login_enabled,",
        "  NOT login.rolsuper AS superuser_absent,",
        "  login.rolcreaterole AS createrole_present,",
        "  NOT login.rolreplication AS replication_absent,",
        "  NOT login.rolbypassrls AS bypassrls_absent,",
        "  NOT pg_catalog.pg_has_role(session_user, $3, 'SET')",
        "    AND NOT pg_catalog.pg_has_role(session_user, $4, 'SET')",
        "    AND NOT pg_catalog.pg_has_role(session_user, $5, 'SET')",
        "    AS canonical_set_absent",
        "FROM pg_catalog.pg_roles login",
        "JOIN pg_catalog.pg_database database_info",
        "  ON database_info.datname = current_database()",
        "JOIN pg_catalog.pg_roles database_owner",
        "  ON database_owner.oid = database_info.datdba",
        "WHERE login.rolname = session_user"
      ].join("\n"),
      [
        connection.public.database,
        connection.public.login,
        MIGRATOR_ROLE,
        OWNER_ROLE,
        RUNTIME_ROLE
      ]
    );
    const row = result.rows?.[0];
    if (
      result.rows?.length !== 1 ||
      !row.postgres_version_supported ||
      !row.database_exact ||
      !row.login_exact ||
      !row.database_owner_exact ||
      !row.login_enabled ||
      !row.superuser_absent ||
      !row.createrole_present ||
      !row.replication_absent ||
      !row.bypassrls_absent ||
      !row.canonical_set_absent
    ) {
      fail("backup_principal_unsafe");
    }
  }

  async function preflight(config) {
    await inspectPrincipal(config.operator);
    await inspectPermanentLogins(config);
    return inspectSchemaProfile();
  }

  async function preflightEmptyTarget(config) {
    await inspectPrincipal(config.operator);
    await inspectPermanentLogins(config);
    const result = await querySafe(
      [
        "SELECT",
        "  (",
        "    SELECT COUNT(*)::integer",
        "    FROM pg_catalog.pg_namespace",
        "    WHERE nspname IN (",
        "      'ia4tube_social',",
        "      'ia4tube_social_admin',",
        "      'ia4tube_migrations'",
        "    )",
        "  ) AS application_schema_count,",
        "  (",
        "    SELECT COUNT(*)::integer",
        "    FROM pg_catalog.pg_class relation",
        "    JOIN pg_catalog.pg_namespace namespace",
        "      ON namespace.oid = relation.relnamespace",
        "    WHERE namespace.nspname !~ '^pg_'",
        "      AND namespace.nspname <> 'information_schema'",
        "      AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')",
        "  ) AS user_relation_count,",
        "  (",
        "    SELECT COUNT(*)::integer",
        "    FROM pg_catalog.pg_proc routine",
        "    JOIN pg_catalog.pg_namespace namespace",
        "      ON namespace.oid = routine.pronamespace",
        "    WHERE namespace.nspname !~ '^pg_'",
        "      AND namespace.nspname <> 'information_schema'",
        "  ) AS user_routine_count,",
        "  (",
        "    SELECT COUNT(*)::integer",
        "    FROM pg_catalog.pg_namespace namespace",
        "    WHERE namespace.nspname !~ '^pg_'",
        "      AND namespace.nspname NOT IN ('information_schema', 'public')",
        "  ) AS user_schema_count,",
        "  (",
        "    SELECT COUNT(*)::integer",
        "    FROM pg_catalog.pg_type type_info",
        "    JOIN pg_catalog.pg_namespace namespace",
        "      ON namespace.oid = type_info.typnamespace",
        "    WHERE namespace.nspname !~ '^pg_'",
        "      AND namespace.nspname <> 'information_schema'",
        "      AND type_info.typrelid = 0",
        "      AND type_info.typtype IN ('c', 'd', 'e', 'r', 'm')",
        "  ) AS standalone_user_type_count,",
        "  (",
        "    SELECT COUNT(*)::integer",
        "    FROM pg_catalog.pg_event_trigger",
        "  ) AS event_trigger_count,",
        "  (",
        "    SELECT COUNT(*)::integer",
        "    FROM pg_catalog.pg_extension",
        "    WHERE extname <> 'plpgsql'",
        "  ) AS non_default_extension_count,",
        "  (",
        "    SELECT COUNT(*)::integer",
        "    FROM pg_catalog.pg_foreign_server",
        "  ) AS foreign_server_count"
      ].join("\n")
    );
    if (
      Number(result.rows?.[0]?.application_schema_count) !== 0 ||
      Number(result.rows?.[0]?.user_relation_count) !== 0 ||
      Number(result.rows?.[0]?.user_routine_count) !== 0 ||
      Number(result.rows?.[0]?.user_schema_count) !== 0 ||
      Number(result.rows?.[0]?.standalone_user_type_count) !== 0 ||
      Number(result.rows?.[0]?.event_trigger_count) !== 0 ||
      Number(result.rows?.[0]?.non_default_extension_count) !== 0 ||
      Number(result.rows?.[0]?.foreign_server_count) !== 0
    ) {
      fail("restore_target_not_empty");
    }
  }

  async function assertTransientPoliciesAbsent() {
    const result = await querySafe(
      [
        "SELECT COUNT(*)::integer AS transient_policy_count",
        "FROM pg_catalog.pg_policies",
        "WHERE schemaname = 'ia4tube_social'",
        "  AND left(policyname, length($1)) = $1"
      ].join("\n"),
      [POLICY_PREFIX]
    );
    if (Number(result.rows?.[0]?.transient_policy_count) !== 0) {
      fail("backup_transient_policy_present");
    }
  }

  async function collectCatalogEvidence(
    config,
    schemaProfile = CURRENT_SCHEMA_PROFILE
  ) {
    const profile = schemaProfileById(
      schemaProfile,
      "backup_catalog_state_invalid"
    );
    const permanentLogins = await inspectPermanentLogins(config);
    const state = await querySafe(
      [
        "SELECT",
        "  COUNT(*)::integer AS rls_table_count,",
        "  COUNT(*) FILTER (",
        "    WHERE relation.relrowsecurity",
        "  )::integer AS enabled_rls_table_count,",
        "  COUNT(*) FILTER (",
        "    WHERE relation.relforcerowsecurity",
        "  )::integer AS forced_rls_table_count",
        "FROM pg_catalog.pg_class relation",
        "JOIN pg_catalog.pg_namespace namespace",
        "  ON namespace.oid = relation.relnamespace",
        "WHERE namespace.nspname = 'ia4tube_social'",
        "  AND relation.relkind IN ('r', 'p')",
        "  AND relation.relname = ANY($1::text[])"
      ].join("\n"),
      [profile.rlsTables]
    );
    const roles = await querySafe(
      [
        "SELECT rolname, rolcanlogin, rolsuper, rolcreatedb,",
        "  rolcreaterole, rolinherit, rolreplication, rolbypassrls",
        "FROM pg_catalog.pg_roles",
        "WHERE rolname = ANY($1::text[])",
        "ORDER BY rolname"
      ].join("\n"),
      [[OWNER_ROLE, MIGRATOR_ROLE, RUNTIME_ROLE]]
    );
    const memberships = await querySafe(
      [
        "SELECT granted.rolname AS granted_role,",
        "  member.rolname AS member_role,",
        "  membership.admin_option,",
        "  membership.inherit_option,",
        "  membership.set_option",
        "FROM pg_catalog.pg_auth_members membership",
        "JOIN pg_catalog.pg_roles granted",
        "  ON granted.oid = membership.roleid",
        "JOIN pg_catalog.pg_roles member",
        "  ON member.oid = membership.member",
        "WHERE granted.rolname = ANY($1::text[])",
        "  AND member.rolname = ANY($1::text[])",
        "ORDER BY granted.rolname, member.rolname"
      ].join("\n"),
      [[OWNER_ROLE, MIGRATOR_ROLE, RUNTIME_ROLE]]
    );
    const policies = await querySafe(
      [
        "SELECT tablename, policyname, permissive, roles, cmd,",
        "  qual, with_check",
        "FROM pg_catalog.pg_policies",
        "WHERE schemaname = 'ia4tube_social'",
        "  AND left(policyname, length($1)) <> $1",
        "ORDER BY tablename, policyname"
      ].join("\n"),
      [POLICY_PREFIX]
    );
    const constraints = await querySafe(
      [
        "SELECT namespace.nspname AS schema_name,",
        "  relation.relname AS table_name,",
        "  constraint_info.conname AS constraint_name,",
        "  constraint_info.contype AS constraint_type,",
        "  constraint_info.convalidated AS validated,",
        "  pg_catalog.pg_get_constraintdef(",
        "    constraint_info.oid, TRUE",
        "  ) AS definition",
        "FROM pg_catalog.pg_constraint constraint_info",
        "JOIN pg_catalog.pg_class relation",
        "  ON relation.oid = constraint_info.conrelid",
        "JOIN pg_catalog.pg_namespace namespace",
        "  ON namespace.oid = relation.relnamespace",
        "WHERE namespace.nspname IN (",
        "  'ia4tube_social',",
        "  'ia4tube_social_admin',",
        "  'ia4tube_migrations'",
        ")",
        "ORDER BY namespace.nspname, relation.relname,",
        "  constraint_info.conname"
      ].join("\n")
    );
    const compatibility = await querySafe(
      [
        "SELECT",
        "  COUNT(relation.oid) = 5",
        "    AND bool_and(relation.relkind = required.relkind)",
        "    AS compatible_with_2a",
        "FROM (VALUES",
        "  ('ia4tube_social', 'companies', 'r'::\"char\"),",
        "  ('ia4tube_social', 'users', 'r'::\"char\"),",
        "  ('ia4tube_social', 'social_encrypted_credentials', 'r'::\"char\"),",
        "  ('ia4tube_social_admin', 'vault_key_versions', 'r'::\"char\"),",
        "  ('ia4tube_social', 'runtime_schema_contract', 'v'::\"char\")",
        ") required(schema_name, relation_name, relkind)",
        "LEFT JOIN pg_catalog.pg_namespace namespace",
        "  ON namespace.nspname = required.schema_name",
        "LEFT JOIN pg_catalog.pg_class relation",
        "  ON relation.relnamespace = namespace.oid",
        "  AND relation.relname = required.relation_name"
      ].join("\n")
    );
    const transient = await querySafe(
      [
        "SELECT COUNT(*)::integer AS transient_policy_count",
        "FROM pg_catalog.pg_policies",
        "WHERE schemaname = 'ia4tube_social'",
        "  AND left(policyname, length($1)) = $1"
      ].join("\n"),
      [POLICY_PREFIX]
    );

    const stateRow = state.rows?.[0] || {};
    const roleRows = roles.rows || [];
    const membershipRows = memberships.rows || [];
    const constraintRows = constraints.rows || [];
    const canonicalRoleAttributesExact =
      roleRows.length === 3 &&
      roleRows.every(
        (role) =>
          !role.rolcanlogin &&
          !role.rolsuper &&
          !role.rolcreatedb &&
          !role.rolcreaterole &&
          !role.rolinherit &&
          !role.rolreplication &&
          !role.rolbypassrls
      );
    const canonicalMembershipExact =
      membershipRows.length === 1 &&
      membershipRows[0].granted_role === OWNER_ROLE &&
      membershipRows[0].member_role === MIGRATOR_ROLE &&
      !membershipRows[0].admin_option &&
      !membershipRows[0].inherit_option &&
      membershipRows[0].set_option;
    return Object.freeze({
      rlsTableCount:
        Number(stateRow.enabled_rls_table_count) === profile.rlsTables.length
          ? Number(stateRow.rls_table_count)
          : -1,
      forcedRlsTableCount: Number(stateRow.forced_rls_table_count),
      transientPolicyCount: Number(
        transient.rows?.[0]?.transient_policy_count
      ),
      canonicalRoleCount: roleRows.length,
      runtimeEscalationPossible:
        !canonicalRoleAttributesExact || !canonicalMembershipExact,
      requiredConstraintsPresent: catalogConstraintsMatchProfile(
        profile,
        constraintRows
      ),
      compatibleWith2A:
        compatibility.rows?.[0]?.compatible_with_2a === true,
      policyDigest: digestRows(policies.rows),
      constraintDigest: digestRows(constraintRows),
      roleDigest: digestRows({
        roles: roleRows,
        memberships: membershipRows,
        permanentLogins
      })
    });
  }

  async function releaseLocks(lockIds) {
    if (!client) fail("backup_lock_state_invalid");
    let discard;
    try {
      for (const lockId of lockIds) {
        const result = await client.query(
          "SELECT pg_catalog.pg_advisory_unlock($1::bigint) AS unlocked",
          [lockId]
        );
        if (result.rows?.[0]?.unlocked !== true) {
          discard = new Error("backup_lock_release_failed");
          break;
        }
      }
    } catch {
      discard = new Error("backup_lock_release_failed");
    } finally {
      client.release(discard);
      client = undefined;
      heldLocks = [];
    }
    if (discard) fail("backup_lock_release_failed");
  }

  return Object.freeze({
    acquireLocks,
    preflight,
    preflightEmptyTarget,
    assertTransientPoliciesAbsent,
    collectCatalogEvidence,
    releaseLocks
  });
}

async function runToolChecked(runTool, plan) {
  let result;
  try {
    result = await runTool(plan);
  } catch {
    throw safeToolFailure();
  }
  if (!result || result.code !== 0) throw safeToolFailure();
  return result;
}

function secretValues(connection) {
  return [
    connection.parsed.password,
    decodePart(connection.parsed.password, "backup_database_password_invalid")
  ];
}

async function runLogicalBackup({
  config,
  operator,
  runTool,
  fileSystem = fs,
  generatedAt,
  requireBundleDirectoryFsync = false
}) {
  if (
    !operator ||
    typeof operator.acquireLocks !== "function" ||
    typeof operator.preflight !== "function" ||
    typeof operator.assertTransientPoliciesAbsent !== "function" ||
    typeof operator.collectCatalogEvidence !== "function" ||
    typeof operator.releaseLocks !== "function" ||
    typeof runTool !== "function" ||
    typeof requireBundleDirectoryFsync !== "boolean"
  ) {
    fail("backup_operator_invalid");
  }
  const passwords = [
    ...secretValues(config.source),
    ...secretValues(config.operator)
  ];
  let locked = false;
  let workspace;
  let rootCertificateBundle;
  let encrypted;
  try {
    await operator.acquireLocks([MIGRATION_LOCK_ID, BACKUP_LOCK_ID]);
    locked = true;
    recoverOwnedWorkspaces({
      root: config.outputDirectory,
      purpose: config.workspace.purpose,
      fileSystem
    });
    workspace = createOwnedWorkspace({
      root: config.outputDirectory,
      purpose: config.workspace.purpose,
      id: config.workspace.id,
      fileSystem
    });
    if (path.resolve(workspace.path) !== path.resolve(config.workspace.path)) {
      fail("backup_workspace_identity_invalid");
    }
    rootCertificateBundle = createSystemRootCertificateBundle({
      workspace,
      fileSystem
    });
    assertFreshOutput(config, fileSystem);
    const schemaProfile = schemaProfileById(await operator.preflight(config));
    await operator.assertTransientPoliciesAbsent();
    const catalog = normalizeCatalogEvidence(
      await operator.collectCatalogEvidence(config, schemaProfile),
      schemaProfile
    );

    const data = psqlPlan(
      config.tools.psql,
      config.source,
      createBackupDataScript(config, schemaProfile),
      rootCertificateBundle,
      fileSystem
    );
    assertSecretFreePlan(data, passwords);
    await runToolChecked(runTool, data);
    await operator.assertTransientPoliciesAbsent();

    const schema = schemaDumpPlan(
      config,
      rootCertificateBundle,
      fileSystem
    );
    assertSecretFreePlan(schema, passwords);
    await runToolChecked(runTool, schema);
    const listing = await runToolChecked(
      runTool,
      schemaListPlan(config.tools.restore, config.files.schemaPartial)
    );
    assertSchemaArchiveList(listing.stdout, schemaProfile);

    const snapshotEvidence = readSmallJson(
      config.files.evidencePartial,
      fileSystem
    );
    const evidence = normalizeEvidence({
      ...snapshotEvidence,
      catalog
    }, schemaProfile);

    for (const table of schemaProfile.backupTables) {
      const partial = config.files.dataPartial[table];
      if (!fileSystem.statSync(partial).isFile()) {
        fail("backup_data_file_missing");
      }
      fileSystem.renameSync(partial, config.files.data[table]);
    }
    fileSystem.renameSync(config.files.schemaPartial, config.files.schema);
    const manifest = buildManifest({
      config,
      evidence,
      generatedAt,
      fileSystem
    });
    fileSystem.writeFileSync(
      config.files.manifestPartial,
      `${canonicalJson(manifest)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 }
    );
    fileSystem.renameSync(config.files.manifestPartial, config.files.manifest);
    fileSystem.unlinkSync(config.files.evidencePartial);
    validateManifestFiles(manifest, {
      fileSystem,
      expectedDirectory: config.workspace.path,
      sourceFingerprint: config.sourceFingerprint
    });
    const archiveNames = bundleArchiveNames(schemaProfile);
    encrypted = await createEncryptedBundle({
      entries: bundleArchiveEntries(config, schemaProfile),
      expectedNames: archiveNames,
      outputPath: config.files.bundle,
      label: config.label,
      sourceFingerprint: config.sourceFingerprint,
      bundleKey: config.bundleKey,
      fileSystem
    });
    if (
      requireBundleDirectoryFsync &&
      encrypted.bundleDirectoryFsyncConfirmed !== true
    ) {
      fail("backup_bundle_directory_sync_unconfirmed");
    }
    await withExtractedEncryptedBundle({
      containerPath: config.files.bundle,
      expectedNames: archiveNames,
      expectedLabel: config.label,
      expectedSourceFingerprint: config.sourceFingerprint,
      workDirectory: config.outputDirectory,
      bundleKey: config.bundleKey,
      workspacePurpose: "backup-verify",
      fileSystem,
      async operation(extracted) {
        compareEntryEvidence(encrypted.entries, extracted.files);
        const roundTripManifest = materializeExtractedManifest(
          extracted,
          schemaProfile,
          fileSystem
        );
        validateManifestFiles(roundTripManifest, {
          fileSystem,
          expectedDirectory: extracted.directory,
          sourceFingerprint: config.sourceFingerprint
        });
        return true;
      }
    });
    cleanupSystemRootCertificateBundle(
      rootCertificateBundle,
      fileSystem
    );
    rootCertificateBundle = undefined;
    cleanupOwnedWorkspace(workspace, fileSystem);
    workspace = undefined;
    return Object.freeze({
      ok: true,
      bundle: encrypted.path,
      bundleSize: encrypted.size,
      bundleSha256: encrypted.sha256,
      bundleFileFsyncConfirmed: true,
      bundleDirectoryFsyncConfirmed:
        encrypted.bundleDirectoryFsyncConfirmed,
      bundleRoundTripVerified: true,
      evidenceSha256: manifest.evidenceSha256,
      files: 1,
      temporaryWorkspaceCleanupConfirmed: true,
      plaintextArtifactsAbsent: true
    });
  } catch (error) {
    let cleanupError;
    let rootCleanupFailed = false;
    if (encrypted) {
      try {
        cleanupCreatedBundle(encrypted, fileSystem);
      } catch (failure) {
        cleanupError = failure;
      }
    }
    if (workspace) {
      if (rootCertificateBundle) {
        try {
          cleanupSystemRootCertificateBundle(
            rootCertificateBundle,
            fileSystem
          );
          rootCertificateBundle = undefined;
        } catch (failure) {
          cleanupError ||= failure;
          rootCleanupFailed = true;
        }
      }
      try {
        if (!rootCleanupFailed) {
          cleanupOwnedWorkspace(workspace, fileSystem);
          workspace = undefined;
        }
      } catch (failure) {
        cleanupError ||= failure;
      }
    }
    if (cleanupError) throw cleanupError;
    if (error instanceof SocialPostgresError) throw error;
    throw safeToolFailure();
  } finally {
    if (locked) {
      await operator.releaseLocks([BACKUP_LOCK_ID, MIGRATION_LOCK_ID]);
    }
  }
}

async function withExtractedVersionedBundle(options) {
  let profileMismatch;
  const attemptedArchiveShapes = new Set();
  for (const profile of [...SCHEMA_PROFILES].reverse()) {
    const expectedNames = bundleArchiveNames(profile);
    const archiveShape = canonicalJson(expectedNames);
    if (attemptedArchiveShapes.has(archiveShape)) continue;
    attemptedArchiveShapes.add(archiveShape);
    try {
      return await withExtractedEncryptedBundle({
        ...options,
        expectedNames,
        async operation(extracted) {
          const manifestEntry = extracted?.files?.find(
            (entry) => entry?.name === BUNDLE_ARCHIVE_MANIFEST
          );
          if (!manifestEntry?.path) fail("restore_encrypted_bundle_invalid");
          const stored = readSmallJson(
            manifestEntry.path,
            options.fileSystem || fs
          );
          const storedProfile = requireManifestSchemaProfile(stored);
          if (
            canonicalJson(bundleArchiveNames(storedProfile)) !== archiveShape
          ) {
            fail("restore_encrypted_bundle_invalid");
          }
          return options.operation(extracted, storedProfile);
        }
      });
    } catch (error) {
      if (
        error instanceof EncryptedBackupBundleError &&
        [
          "backup_bundle_allowlist_incomplete",
          "backup_bundle_tar_entry_invalid"
        ].includes(error.code)
      ) {
        profileMismatch = error;
        continue;
      }
      throw error;
    }
  }
  if (profileMismatch) fail("restore_bundle_schema_profile_unknown");
  fail("restore_encrypted_bundle_invalid");
}

async function runLogicalRestore({
  config,
  operator,
  runTool,
  verifierTargetFingerprint,
  verifyRuntimeIsolation,
  verifyVault,
  verify2ACompatibility,
  fileSystem = fs
}) {
  if (
    !operator ||
    typeof operator.acquireLocks !== "function" ||
    typeof operator.preflightEmptyTarget !== "function" ||
    typeof operator.assertTransientPoliciesAbsent !== "function" ||
    typeof operator.collectCatalogEvidence !== "function" ||
    typeof operator.releaseLocks !== "function" ||
    typeof runTool !== "function" ||
    !/^[0-9a-f]{64}$/.test(String(verifierTargetFingerprint || "")) ||
    typeof verifyRuntimeIsolation !== "function" ||
    typeof verifyVault !== "function" ||
    typeof verify2ACompatibility !== "function"
  ) {
    fail("restore_operator_invalid");
  }
  if (
    !equalDigest(
      verifierTargetFingerprint,
      config.targetFingerprint
    )
  ) {
    fail("restore_behavior_target_mismatch");
  }
  const passwords = [
    ...secretValues(config.target),
    ...secretValues(config.operator)
  ];
  let locked = false;
  let rootWorkspace;
  let rootCertificateBundle;
  try {
    await operator.acquireLocks([MIGRATION_LOCK_ID, BACKUP_LOCK_ID]);
    locked = true;
    await operator.preflightEmptyTarget(config);
    await operator.assertTransientPoliciesAbsent();
    recoverOwnedWorkspaces({
      root: config.workDirectory,
      purpose: "postgres-tls",
      fileSystem
    });
    rootWorkspace = createOwnedWorkspace({
      root: config.workDirectory,
      purpose: "postgres-tls",
      fileSystem
    });
    rootCertificateBundle = createSystemRootCertificateBundle({
      workspace: rootWorkspace,
      fileSystem
    });
    const result = await withExtractedVersionedBundle({
      containerPath: config.bundlePath,
      expectedLabel: config.label,
      expectedSourceFingerprint: config.sourceFingerprint,
      workDirectory: config.workDirectory,
      workspacePurpose: "restore",
      bundleKey: config.bundleKey,
      fileSystem,
      async operation(extracted, schemaProfile) {
        const evidencePartial = path.join(
          extracted.directory,
          `${config.label}.restored-evidence.json.partial`
        );
        const manifest = materializeExtractedManifest(
          extracted,
          schemaProfile,
          fileSystem
        );
        const expected = validateManifestFiles(manifest, {
          fileSystem,
          expectedDirectory: extracted.directory,
          sourceFingerprint: config.sourceFingerprint
        });
        const listing = await runToolChecked(
          runTool,
          schemaListPlan(config.tools.restore, manifest.files.schema.path)
        );
        assertSchemaArchiveList(listing.stdout, schemaProfile);

        const schema = restoreSchemaPlan(
          config,
          manifest,
          rootCertificateBundle,
          fileSystem
        );
        assertSecretFreePlan(schema, passwords);
        await runToolChecked(runTool, schema);

        const data = psqlPlan(
          config.tools.psql,
          config.target,
          createRestoreDataScript(config, manifest),
          rootCertificateBundle,
          fileSystem
        );
        assertSecretFreePlan(data, passwords);
        await runToolChecked(runTool, data);
        await operator.assertTransientPoliciesAbsent();

        const evidencePlan = psqlPlan(
          config.tools.psql,
          config.target,
          createEvidenceScript(
            config,
            evidencePartial,
            manifest
          ),
          rootCertificateBundle,
          fileSystem
        );
        assertSecretFreePlan(evidencePlan, passwords);
        await runToolChecked(runTool, evidencePlan);
        const snapshot = readSmallJson(evidencePartial, fileSystem);
        const catalog = await operator.collectCatalogEvidence(
          config,
          schemaProfile
        );
        const actual = normalizeEvidence(
          { ...snapshot, catalog },
          schemaProfile
        );
        compareRestoredEvidence(expected, actual);

        if (
          (await verifyRuntimeIsolation()) !== true ||
          (await verifyVault()) !== true ||
          (await verify2ACompatibility()) !== true
        ) {
          fail("restore_behavioral_validation_failed");
        }
        fileSystem.unlinkSync(evidencePartial);
        return Object.freeze({
          ok: true,
          evidenceSha256: evidenceDigest(actual),
          runtimeIsolation: true,
          vault: true,
          compatibleWith2A: true
        });
      }
    });
    cleanupSystemRootCertificateBundle(
      rootCertificateBundle,
      fileSystem
    );
    rootCertificateBundle = undefined;
    cleanupOwnedWorkspace(rootWorkspace, fileSystem);
    rootWorkspace = undefined;
    return Object.freeze({
      ...result,
      temporaryWorkspaceCleanupConfirmed: true,
      plaintextArtifactsAbsent: true
    });
  } catch (error) {
    let cleanupError;
    if (rootCertificateBundle) {
      try {
        cleanupSystemRootCertificateBundle(
          rootCertificateBundle,
          fileSystem
        );
        rootCertificateBundle = undefined;
      } catch (failure) {
        cleanupError = failure;
      }
    }
    if (rootWorkspace && !cleanupError) {
      try {
        cleanupOwnedWorkspace(rootWorkspace, fileSystem);
        rootWorkspace = undefined;
      } catch (failure) {
        cleanupError = failure;
      }
    }
    if (cleanupError) throw cleanupError;
    if (error instanceof SocialPostgresError) throw error;
    throw safeToolFailure();
  } finally {
    if (locked) {
      await operator.releaseLocks([BACKUP_LOCK_ID, MIGRATION_LOCK_ID]);
    }
  }
}

module.exports = {
  BACKUP_APPROVAL,
  BACKUP_LOCK_ID,
  BACKUP_TABLES,
  BLOCKED_RESTORE_LABEL,
  DISPOSABLE_DATABASE_PATTERN,
  EVIDENCE_TABLES,
  EXPECTED_MIGRATIONS,
  EXPECTED_MIGRATION_ROWS,
  MIGRATION_LOCK_ID,
  MIGRATOR_ROLE,
  OWNER_ROLE,
  PRE_0004_BACKUP_TABLES,
  PRE_0004_RLS_TABLES,
  POLICY_PREFIX,
  POSTGRES_MAJOR,
  RESTORE_APPROVAL,
  RLS_TABLES,
  RUNTIME_ROLE,
  SCHEMA_PROFILES,
  SYSTEM_ROOT_BUNDLE_NAME,
  assertSchemaArchiveList,
  assertSecretFreePlan,
  bundleArchiveEntries,
  bundleArchiveNames,
  buildManifest,
  childConnectionEnvironment,
  compareRestoredEvidence,
  cleanupSystemRootCertificateBundle,
  createPostgresBackupOperator,
  createBackupDataScript,
  createEvidenceScript,
  createRestoreDataScript,
  createSystemRootCertificateBundle,
  evidenceDigest,
  hashFile,
  inspectSystemRootCertificateBundle,
  loadBackupConfig,
  loadRestoreConfig,
  materializeExtractedManifest,
  normalizeEvidence,
  resolveSchemaProfile,
  psqlPlan,
  restoreSchemaPlan,
  runLogicalBackup,
  runLogicalRestore,
  safeChildEnvironment,
  schemaDumpPlan,
  schemaListPlan,
  targetFingerprint,
  temporaryPolicySql,
  validateManifestFiles
};
