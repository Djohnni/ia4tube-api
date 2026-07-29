"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  SOCIAL_MIGRATOR_ROLE,
  SOCIAL_OWNER_ROLE
} = require("./config");
const { postgresFail } = require("./errors");
const {
  inspectSessionPrincipalAccess,
  principalAccessIsUnsafe,
  quoteIdentifier
} = require("./pool");

const MIGRATION_FILE_PATTERN = /^(\d{4}_[a-z0-9_]+)\.up\.sql$/;
const ADVISORY_LOCK_ID = "483178116797201191";
const LEDGER_NAME = "ia4tube_migrations.schema_migrations";
const APPLY_APPROVAL = "APPLY_SOCIAL_MIGRATIONS";
const PRODUCTION_APPROVAL =
  "APPLY_SOCIAL_MIGRATIONS_TO_PRODUCTION_WITH_VERIFIED_BACKUP";

function aclRowKey(row) {
  return (
    `${String(row.grantee).toLowerCase()}|` +
    `${String(row.privilege_type).toUpperCase()}|` +
    `${Boolean(row.is_grantable)}|` +
    String(row.grantor_name).toLowerCase()
  );
}

function exactAclMatches(rows, expected) {
  const actual = new Set((rows || []).map(aclRowKey));
  if (actual.size !== expected.size) return false;
  for (const item of expected) {
    if (!actual.has(item)) return false;
  }
  return true;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalSql(filePath) {
  const content = fs.readFileSync(filePath);
  if (content.includes(13)) {
    postgresFail(
      "migration_line_endings_invalid",
      "Migration deve usar somente LF."
    );
  }
  if (content.length === 0 || content[content.length - 1] !== 10) {
    postgresFail(
      "migration_terminal_newline_required",
      "Migration deve terminar com LF."
    );
  }
  return content;
}

function assertNonDestructiveSql(sql, version) {
  const withoutComments = sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ");
  const forbidden = [
    /\bDROP\s+(TABLE|SCHEMA|DATABASE|COLUMN|CONSTRAINT|INDEX|TYPE)\b/i,
    /\bTRUNCATE\b/i,
    /\bDELETE\s+FROM\b/i,
    /\bALTER\s+TABLE\b[\s\S]*?\bDROP\b/i,
    /\bCASCADE\b/i
  ];
  if (forbidden.some((pattern) => pattern.test(withoutComments))) {
    postgresFail(
      "destructive_migration_refused",
      `Migration ${version} contem DDL destrutiva.`
    );
  }
}

function readManifest(options = {}) {
  const root = options.root || path.resolve(__dirname, "..", "..", "..");
  const migrationsDirectory =
    options.migrationsDirectory || path.join(root, "db", "migrations");
  const manifestPath =
    options.manifestPath ||
    path.join(migrationsDirectory, "checksums.json");
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    postgresFail(
      "migration_manifest_invalid",
      "Manifesto de migrations ausente ou invalido.",
      error
    );
  }
  if (
    parsed?.format !== 1 ||
    !Array.isArray(parsed.migrations) ||
    parsed.migrations.length === 0
  ) {
    postgresFail(
      "migration_manifest_invalid",
      "Manifesto de migrations recusado."
    );
  }

  const files = fs
    .readdirSync(migrationsDirectory, { withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && MIGRATION_FILE_PATTERN.test(entry.name)
    )
    .map((entry) => entry.name)
    .sort();
  const declaredFiles = parsed.migrations.map((entry) => entry.file);
  if (
    files.length !== declaredFiles.length ||
    files.some((file, index) => file !== declaredFiles[index])
  ) {
    postgresFail(
      "migration_manifest_file_set_mismatch",
      "Conjunto de migrations diverge do manifesto."
    );
  }

  let previousVersion = "";
  const versions = new Set();
  const migrations = parsed.migrations.map((entry) => {
    if (
      !entry ||
      typeof entry.version !== "string" ||
      typeof entry.file !== "string" ||
      typeof entry.sha256 !== "string" ||
      !MIGRATION_FILE_PATTERN.test(entry.file) ||
      MIGRATION_FILE_PATTERN.exec(entry.file)[1] !== entry.version ||
      !/^[0-9a-f]{64}$/.test(entry.sha256) ||
      versions.has(entry.version) ||
      (previousVersion && entry.version <= previousVersion)
    ) {
      postgresFail(
        "migration_manifest_invalid",
        "Entrada de migration recusada."
      );
    }
    versions.add(entry.version);
    previousVersion = entry.version;
    const filePath = path.join(migrationsDirectory, entry.file);
    const sqlBytes = canonicalSql(filePath);
    const actualChecksum = sha256(sqlBytes);
    if (actualChecksum !== entry.sha256) {
      postgresFail(
        "migration_checksum_mismatch",
        `Checksum da migration ${entry.version} diverge.`
      );
    }
    const sql = sqlBytes.toString("utf8");
    assertNonDestructiveSql(sql, entry.version);
    return Object.freeze({
      version: entry.version,
      file: entry.file,
      sha256: actualChecksum,
      sql
    });
  });
  return Object.freeze(migrations);
}

async function ledgerExists(client) {
  const result = await client.query(
    "SELECT to_regclass($1) IS NOT NULL AS exists",
    [LEDGER_NAME]
  );
  return Boolean(result.rows?.[0]?.exists);
}

async function readAppliedMigrations(client) {
  if (!(await ledgerExists(client))) return [];
  const result = await client.query(
    [
      "SELECT version, checksum_sha256, applied_at, execution_ms",
      `FROM ${LEDGER_NAME}`,
      "ORDER BY version"
    ].join("\n")
  );
  return Array.isArray(result.rows) ? result.rows : [];
}

function compareMigrationState(local, applied) {
  const localByVersion = new Map(
    local.map((migration) => [migration.version, migration])
  );
  const appliedByVersion = new Map();
  for (const row of applied) {
    if (
      !row ||
      typeof row.version !== "string" ||
      typeof row.checksum_sha256 !== "string" ||
      appliedByVersion.has(row.version)
    ) {
      postgresFail(
        "migration_ledger_invalid",
        "Ledger de migrations recusado."
      );
    }
    appliedByVersion.set(row.version, row);
    const expected = localByVersion.get(row.version);
    if (!expected) {
      postgresFail(
        "unknown_applied_migration",
        `Migration aplicada desconhecida: ${row.version}.`
      );
    }
    if (expected.sha256 !== row.checksum_sha256) {
      postgresFail(
        "applied_migration_checksum_mismatch",
        `Migration aplicada foi alterada: ${row.version}.`
      );
    }
  }
  const appliedVersions = applied.map((row) => row.version);
  const expectedPrefix = local
    .slice(0, appliedVersions.length)
    .map((migration) => migration.version);
  if (
    appliedVersions.length > local.length ||
    appliedVersions.some(
      (version, index) => version !== expectedPrefix[index]
    )
  ) {
    postgresFail(
      "migration_ledger_order_invalid",
      "Ordem do ledger de migrations recusada."
    );
  }

  const status = local.map((migration) =>
    Object.freeze({
      version: migration.version,
      checksum: migration.sha256,
      state: appliedByVersion.has(migration.version)
        ? "applied"
        : "pending"
    })
  );
  return Object.freeze(status);
}

async function ensureLedger(client, ownerRole, migratorRole) {
  await client.query("BEGIN");
  try {
    await client.query(`SET LOCAL ROLE ${quoteIdentifier(ownerRole)}`);
    await client.query(
      [
        `CREATE TABLE IF NOT EXISTS ${LEDGER_NAME} (`,
        "  version TEXT PRIMARY KEY,",
        "  checksum_sha256 CHAR(64) NOT NULL,",
        "  applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,",
        "  execution_ms BIGINT NOT NULL,",
        "  CONSTRAINT ia4tube_schema_migrations_version_not_blank",
        "    CHECK (length(btrim(version)) > 0),",
        "  CONSTRAINT ia4tube_schema_migrations_checksum_format",
        "    CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),",
        "  CONSTRAINT ia4tube_schema_migrations_duration_nonnegative",
        "    CHECK (execution_ms >= 0)",
        ")"
      ].join("\n")
    );
    await client.query(`REVOKE ALL ON ${LEDGER_NAME} FROM PUBLIC`);
    await client.query(
      `REVOKE ALL ON ${LEDGER_NAME} FROM ${quoteIdentifier(
        migratorRole
      )}`
    );
    await client.query(
      `GRANT SELECT, INSERT ON ${LEDGER_NAME} TO ${quoteIdentifier(
        migratorRole
      )}`
    );
    const structure = await client.query(
      [
        "SELECT",
        "  pg_get_userbyid(table_class.relowner) = $2 AS owned,",
        "  COUNT(column_info.column_name)::integer = 4 AS column_count_valid,",
        "  BOOL_AND(",
        "    CASE column_info.ordinal_position",
        "      WHEN 1 THEN column_info.column_name = 'version'",
        "        AND column_info.data_type = 'text'",
        "        AND column_info.is_nullable = 'NO'",
        "      WHEN 2 THEN column_info.column_name = 'checksum_sha256'",
        "        AND column_info.data_type = 'character'",
        "        AND column_info.character_maximum_length = 64",
        "        AND column_info.is_nullable = 'NO'",
        "      WHEN 3 THEN column_info.column_name = 'applied_at'",
        "        AND column_info.data_type = 'timestamp with time zone'",
        "        AND column_info.is_nullable = 'NO'",
        "      WHEN 4 THEN column_info.column_name = 'execution_ms'",
        "        AND column_info.data_type = 'bigint'",
        "        AND column_info.is_nullable = 'NO'",
        "      ELSE FALSE",
        "    END",
        "  ) AS columns_valid,",
        "  EXISTS (",
        "    SELECT 1",
        "    FROM information_schema.table_constraints constraint_info",
        "    JOIN information_schema.key_column_usage key_info",
        "      ON key_info.constraint_schema = constraint_info.constraint_schema",
        "      AND key_info.constraint_name = constraint_info.constraint_name",
        "    WHERE constraint_info.table_schema = 'ia4tube_migrations'",
        "      AND constraint_info.table_name = 'schema_migrations'",
        "      AND constraint_info.constraint_type = 'PRIMARY KEY'",
        "    GROUP BY constraint_info.constraint_name",
        "    HAVING COUNT(*) = 1 AND MIN(key_info.column_name) = 'version'",
        "  ) AS primary_key_valid,",
        "  has_table_privilege($1::name,",
        "    'ia4tube_migrations.schema_migrations', 'SELECT')",
        "    AS migrator_select,",
        "  has_table_privilege($1::name,",
        "    'ia4tube_migrations.schema_migrations', 'INSERT')",
        "    AS migrator_insert,",
        "  has_table_privilege($1,",
        "    'ia4tube_migrations.schema_migrations', 'UPDATE')",
        "    AS migrator_update,",
        "  has_table_privilege($1,",
        "    'ia4tube_migrations.schema_migrations', 'DELETE')",
        "    AS migrator_delete",
        "FROM pg_catalog.pg_class table_class",
        "JOIN pg_catalog.pg_namespace namespace",
        "  ON namespace.oid = table_class.relnamespace",
        "JOIN information_schema.columns column_info",
        "  ON column_info.table_schema = namespace.nspname",
        "  AND column_info.table_name = table_class.relname",
        "WHERE namespace.nspname = 'ia4tube_migrations'",
        "  AND table_class.relname = 'schema_migrations'",
        "GROUP BY table_class.relowner, table_class.relacl"
      ].join("\n"),
      [migratorRole, ownerRole]
    );
    const ledger = structure.rows?.[0];
    if (
      !ledger?.owned ||
      !ledger.column_count_valid ||
      !ledger.columns_valid ||
      !ledger.primary_key_valid ||
      !ledger.migrator_select ||
      !ledger.migrator_insert ||
      ledger.migrator_update ||
      ledger.migrator_delete
    ) {
      postgresFail(
        "migration_ledger_structure_invalid",
        "Ledger de migrations recusado."
      );
    }
    const tableAcl = await client.query(
      [
        "SELECT",
        "  COALESCE(grantee.rolname, 'PUBLIC') AS grantee,",
        "  expanded_acl.privilege_type,",
        "  expanded_acl.is_grantable,",
        "  grantor.rolname AS grantor_name",
        "FROM pg_catalog.pg_class relation",
        "JOIN pg_catalog.pg_namespace namespace",
        "  ON namespace.oid = relation.relnamespace",
        "CROSS JOIN LATERAL pg_catalog.aclexplode(",
        "  COALESCE(relation.relacl,",
        "    pg_catalog.acldefault('r', relation.relowner))",
        ") expanded_acl",
        "LEFT JOIN pg_catalog.pg_roles grantee",
        "  ON grantee.oid = expanded_acl.grantee",
        "LEFT JOIN pg_catalog.pg_roles grantor",
        "  ON grantor.oid = expanded_acl.grantor",
        "WHERE namespace.nspname = 'ia4tube_migrations'",
        "  AND relation.relname = 'schema_migrations'",
        "  AND expanded_acl.grantee <> relation.relowner",
        "ORDER BY grantee, expanded_acl.privilege_type"
      ].join("\n")
    );
    if (
      !exactAclMatches(
        tableAcl.rows,
        new Set([
          `${migratorRole}|INSERT|false|${ownerRole}`,
          `${migratorRole}|SELECT|false|${ownerRole}`
        ])
      )
    ) {
      postgresFail(
        "migration_ledger_acl_invalid",
        "ACL do ledger de migrations recusada."
      );
    }
    const columnAcl = await client.query(
      [
        "SELECT attribute.attname AS column_name,",
        "  COALESCE(grantee.rolname, 'PUBLIC') AS grantee,",
        "  expanded_acl.privilege_type,",
        "  expanded_acl.is_grantable,",
        "  grantor.rolname AS grantor_name",
        "FROM pg_catalog.pg_attribute attribute",
        "JOIN pg_catalog.pg_class relation",
        "  ON relation.oid = attribute.attrelid",
        "JOIN pg_catalog.pg_namespace namespace",
        "  ON namespace.oid = relation.relnamespace",
        "CROSS JOIN LATERAL pg_catalog.aclexplode(",
        "  attribute.attacl",
        ") expanded_acl",
        "LEFT JOIN pg_catalog.pg_roles grantee",
        "  ON grantee.oid = expanded_acl.grantee",
        "LEFT JOIN pg_catalog.pg_roles grantor",
        "  ON grantor.oid = expanded_acl.grantor",
        "WHERE namespace.nspname = 'ia4tube_migrations'",
        "  AND relation.relname = 'schema_migrations'",
        "  AND attribute.attnum > 0",
        "  AND NOT attribute.attisdropped",
        "  AND expanded_acl.grantee <> relation.relowner"
      ].join("\n")
    );
    if ((columnAcl.rows || []).length !== 0) {
      postgresFail(
        "migration_ledger_acl_invalid",
        "ACL por coluna do ledger de migrations recusada."
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      rollbackError.code = "migration_ledger_rollback_failed";
      rollbackError.discardClient = true;
      rollbackError.cause = error;
      throw rollbackError;
    }
    throw error;
  }
}

async function verifyMigrationInfrastructure(
  client,
  migratorRole,
  ownerRole
) {
  const schema = await client.query(
    [
      "SELECT owner.rolname AS schema_owner_name,",
      "  (",
      "    SELECT COUNT(*)::integer",
      "    FROM pg_catalog.pg_proc routine",
      "    WHERE routine.pronamespace = namespace.oid",
      "  ) AS routine_count",
      "FROM pg_catalog.pg_namespace namespace",
      "JOIN pg_catalog.pg_roles owner",
      "  ON owner.oid = namespace.nspowner",
      "WHERE namespace.nspname = 'ia4tube_migrations'"
    ].join("\n")
  );
  if (
    schema.rows?.length !== 1 ||
    schema.rows[0].schema_owner_name !== ownerRole ||
    Number(schema.rows[0].routine_count) !== 0
  ) {
    postgresFail(
      "migration_infrastructure_owner_invalid",
      "Schema de migrations recusado."
    );
  }

  const schemaAcl = await client.query(
    [
      "SELECT",
      "  COALESCE(grantee.rolname, 'PUBLIC') AS grantee,",
      "  expanded_acl.privilege_type,",
      "  expanded_acl.is_grantable,",
      "  grantor.rolname AS grantor_name",
      "FROM pg_catalog.pg_namespace namespace",
      "CROSS JOIN LATERAL pg_catalog.aclexplode(",
      "  COALESCE(namespace.nspacl,",
      "    pg_catalog.acldefault('n', namespace.nspowner))",
      ") expanded_acl",
      "LEFT JOIN pg_catalog.pg_roles grantee",
      "  ON grantee.oid = expanded_acl.grantee",
      "LEFT JOIN pg_catalog.pg_roles grantor",
      "  ON grantor.oid = expanded_acl.grantor",
      "WHERE namespace.nspname = 'ia4tube_migrations'",
      "  AND expanded_acl.grantee <> namespace.nspowner",
      "ORDER BY grantee, expanded_acl.privilege_type"
    ].join("\n")
  );
  if (
    !exactAclMatches(
      schemaAcl.rows,
      new Set([`${migratorRole}|USAGE|false|${ownerRole}`])
    )
  ) {
    postgresFail(
      "migration_infrastructure_acl_invalid",
      "ACL do schema de migrations recusada."
    );
  }

  const marker = await client.query(
    [
      "SELECT relation.relkind AS marker_kind,",
      "  owner.rolname AS marker_owner_name",
      "FROM pg_catalog.pg_class relation",
      "JOIN pg_catalog.pg_namespace namespace",
      "  ON namespace.oid = relation.relnamespace",
      "JOIN pg_catalog.pg_roles owner",
      "  ON owner.oid = relation.relowner",
      "WHERE namespace.nspname = 'ia4tube_migrations'",
      "  AND relation.relname = 'environment_identity'"
    ].join("\n")
  );
  if (
    marker.rows?.length !== 1 ||
    marker.rows[0].marker_kind !== "r" ||
    marker.rows[0].marker_owner_name !== ownerRole
  ) {
    postgresFail(
      "migration_environment_marker_structure_invalid",
      "Estrutura do marcador de ambiente recusada."
    );
  }

  const markerAcl = await client.query(
    [
      "SELECT",
      "  COALESCE(grantee.rolname, 'PUBLIC') AS grantee,",
      "  expanded_acl.privilege_type,",
      "  expanded_acl.is_grantable,",
      "  grantor.rolname AS grantor_name",
      "FROM pg_catalog.pg_class relation",
      "JOIN pg_catalog.pg_namespace namespace",
      "  ON namespace.oid = relation.relnamespace",
      "CROSS JOIN LATERAL pg_catalog.aclexplode(",
      "  COALESCE(relation.relacl,",
      "    pg_catalog.acldefault('r', relation.relowner))",
      ") expanded_acl",
      "LEFT JOIN pg_catalog.pg_roles grantee",
      "  ON grantee.oid = expanded_acl.grantee",
      "LEFT JOIN pg_catalog.pg_roles grantor",
      "  ON grantor.oid = expanded_acl.grantor",
      "WHERE namespace.nspname = 'ia4tube_migrations'",
      "  AND relation.relname = 'environment_identity'",
      "  AND expanded_acl.grantee <> relation.relowner",
      "ORDER BY grantee, expanded_acl.privilege_type"
    ].join("\n")
  );
  if (
    !exactAclMatches(
      markerAcl.rows,
      new Set([`${migratorRole}|SELECT|false|${ownerRole}`])
    )
  ) {
    postgresFail(
      "migration_environment_marker_acl_invalid",
      "ACL do marcador de ambiente recusada."
    );
  }

  const markerColumnAcl = await client.query(
    [
      "SELECT attribute.attname AS column_name,",
      "  COALESCE(grantee.rolname, 'PUBLIC') AS grantee,",
      "  expanded_acl.privilege_type,",
      "  expanded_acl.is_grantable,",
      "  grantor.rolname AS grantor_name",
      "FROM pg_catalog.pg_attribute attribute",
      "JOIN pg_catalog.pg_class relation",
      "  ON relation.oid = attribute.attrelid",
      "JOIN pg_catalog.pg_namespace namespace",
      "  ON namespace.oid = relation.relnamespace",
      "CROSS JOIN LATERAL pg_catalog.aclexplode(",
      "  attribute.attacl",
      ") expanded_acl",
      "LEFT JOIN pg_catalog.pg_roles grantee",
      "  ON grantee.oid = expanded_acl.grantee",
      "LEFT JOIN pg_catalog.pg_roles grantor",
      "  ON grantor.oid = expanded_acl.grantor",
      "WHERE namespace.nspname = 'ia4tube_migrations'",
      "  AND relation.relname = 'environment_identity'",
      "  AND attribute.attnum > 0",
      "  AND NOT attribute.attisdropped",
      "  AND expanded_acl.grantee <> relation.relowner"
    ].join("\n")
  );
  if ((markerColumnAcl.rows || []).length !== 0) {
    postgresFail(
      "migration_environment_marker_acl_invalid",
      "ACL por coluna do marcador de ambiente recusada."
    );
  }
}

async function withRoleTransaction(client, role, operation) {
  await client.query("BEGIN");
  try {
    await client.query(`SET LOCAL ROLE ${quoteIdentifier(role)}`);
    const result = await operation();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      rollbackError.code = "migration_transaction_rollback_failed";
      rollbackError.discardClient = true;
      rollbackError.cause = error;
      throw rollbackError;
    }
    throw error;
  }
}

async function readMigrationState(client, migratorRole) {
  return withRoleTransaction(client, migratorRole, () =>
    readAppliedMigrations(client)
  );
}

async function verifyMigrationSession(
  client,
  migratorRole,
  ownerRole
) {
  const result = await client.query(
    [
      "SELECT",
      "  current_setting('server_version_num')::integer >= 180000",
      "    AND current_setting('server_version_num')::integer < 190000",
      "    AS postgres_version_supported,",
      "  login.rolsuper,",
      "  login.rolcreatedb,",
      "  login.rolcreaterole,",
      "  login.rolreplication,",
      "  login.rolbypassrls,",
      "  migrator.rolcanlogin AS migrator_canlogin,",
      "  migrator.rolsuper AS migrator_superuser,",
      "  migrator.rolcreatedb AS migrator_createdb,",
      "  migrator.rolcreaterole AS migrator_createrole,",
      "  migrator.rolinherit AS migrator_inherit,",
      "  migrator.rolreplication AS migrator_replication,",
      "  migrator.rolbypassrls AS migrator_bypassrls,",
      "  owner.rolcanlogin AS owner_canlogin,",
      "  owner.rolsuper AS owner_superuser,",
      "  owner.rolcreatedb AS owner_createdb,",
      "  owner.rolcreaterole AS owner_createrole,",
      "  owner.rolinherit AS owner_inherit,",
      "  owner.rolreplication AS owner_replication,",
      "  owner.rolbypassrls AS owner_bypassrls,",
      "  database_owner.rolcanlogin",
      "    AND NOT database_owner.rolsuper",
      "    AND database_owner.rolcreaterole",
      "    AND NOT database_owner.rolreplication",
      "    AND NOT database_owner.rolbypassrls",
      "    AS database_owner_safe,",
      "  session_user <> database_owner.rolname",
      "    AS login_is_separate,",
      "  (",
      "    SELECT COUNT(*) = 1",
      "      AND BOOL_AND(",
      "        expanded_acl.privilege_type = 'CONNECT'",
      "        AND NOT expanded_acl.is_grantable",
      "        AND expanded_acl.grantor = database_info.datdba",
      "      )",
      "    FROM pg_catalog.aclexplode(",
      "      COALESCE(database_info.datacl,",
      "        pg_catalog.acldefault('d', database_info.datdba))",
      "    ) expanded_acl",
      "    WHERE expanded_acl.grantee = login.oid",
      "  ) AS direct_connect_exact,",
      "  NOT EXISTS (",
      "    SELECT 1",
      "    FROM pg_catalog.aclexplode(",
      "      COALESCE(database_info.datacl,",
      "        pg_catalog.acldefault('d', database_info.datdba))",
      "    ) expanded_acl",
      "    WHERE expanded_acl.grantee = 0",
      "  ) AS public_database_acl_absent,",
      "  NOT pg_catalog.has_database_privilege(",
      "    session_user, current_database(), 'TEMP'",
      "  ) AS database_temp_absent,",
      "  pg_has_role(session_user, $1, 'MEMBER') AS can_migrate,",
      "  EXISTS (",
      "    SELECT 1",
      "    FROM pg_catalog.pg_auth_members membership",
      "    JOIN pg_catalog.pg_roles granted",
      "      ON granted.oid = membership.roleid",
      "    JOIN pg_catalog.pg_roles member",
      "      ON member.oid = membership.member",
      "    WHERE member.rolname = session_user",
      "      AND granted.rolname = $2",
      "  ) AS direct_owner_membership,",
      "  EXISTS (",
      "    SELECT 1",
      "    FROM pg_catalog.pg_roles reachable",
      "    WHERE pg_has_role(session_user, reachable.rolname, 'MEMBER')",
      "      AND reachable.rolname NOT IN (session_user, $1, $2)",
      "  ) AS unexpected_membership,",
      "  (",
      "    SELECT COUNT(*) = 2",
      "      AND COUNT(*) FILTER (",
      "        WHERE member.rolname = session_user",
      "          AND NOT membership.admin_option",
      "          AND NOT membership.inherit_option",
      "          AND membership.set_option",
      "          AND grantor.oid = database_info.datdba",
      "      ) = 1",
      "      AND COUNT(*) FILTER (",
      "        WHERE member.oid = database_info.datdba",
      "          AND membership.admin_option",
      "          AND NOT membership.inherit_option",
      "          AND NOT membership.set_option",
      "          AND grantor.rolsuper",
      "      ) = 1",
      "    FROM pg_catalog.pg_auth_members membership",
      "    JOIN pg_catalog.pg_roles granted",
      "      ON granted.oid = membership.roleid",
      "    JOIN pg_catalog.pg_roles member",
      "      ON member.oid = membership.member",
      "    JOIN pg_catalog.pg_roles grantor",
      "      ON grantor.oid = membership.grantor",
      "    WHERE granted.rolname = $1",
      "  ) AS migrator_members_exact,",
      "  (",
      "    SELECT COUNT(*) = 2",
      "      AND COUNT(*) FILTER (",
      "        WHERE member.rolname = $1",
      "          AND NOT membership.admin_option",
      "          AND NOT membership.inherit_option",
      "          AND membership.set_option",
      "          AND grantor.oid = database_info.datdba",
      "      ) = 1",
      "      AND COUNT(*) FILTER (",
      "        WHERE member.oid = database_info.datdba",
      "          AND membership.admin_option",
      "          AND NOT membership.inherit_option",
      "          AND NOT membership.set_option",
      "          AND grantor.rolsuper",
      "      ) = 1",
      "    FROM pg_catalog.pg_auth_members membership",
      "    JOIN pg_catalog.pg_roles granted",
      "      ON granted.oid = membership.roleid",
      "    JOIN pg_catalog.pg_roles member",
      "      ON member.oid = membership.member",
      "    JOIN pg_catalog.pg_roles grantor",
      "      ON grantor.oid = membership.grantor",
      "    WHERE granted.rolname = $2",
      "  ) AS owner_members_exact",
      "FROM pg_catalog.pg_roles login",
      "JOIN pg_catalog.pg_roles migrator ON migrator.rolname = $1",
      "JOIN pg_catalog.pg_roles owner ON owner.rolname = $2",
      "JOIN pg_catalog.pg_database database_info",
      "  ON database_info.datname = current_database()",
      "JOIN pg_catalog.pg_roles database_owner",
      "  ON database_owner.oid = database_info.datdba",
      "WHERE login.rolname = session_user"
    ].join("\n"),
    [migratorRole, ownerRole]
  );
  const row = result.rows?.[0];
  if (
    !row ||
    !row.postgres_version_supported ||
    row.rolsuper ||
    row.rolcreatedb ||
    row.rolcreaterole ||
    row.rolreplication ||
    row.rolbypassrls ||
    row.migrator_canlogin ||
    row.migrator_superuser ||
    row.migrator_createdb ||
    row.migrator_createrole ||
    row.migrator_inherit ||
    row.migrator_replication ||
    row.migrator_bypassrls ||
    row.owner_canlogin ||
    row.owner_superuser ||
    row.owner_createdb ||
    row.owner_createrole ||
    row.owner_inherit ||
    row.owner_replication ||
    row.owner_bypassrls ||
    !row.database_owner_safe ||
    !row.login_is_separate ||
    !row.direct_connect_exact ||
    !row.public_database_acl_absent ||
    !row.database_temp_absent ||
    !row.can_migrate ||
    row.direct_owner_membership ||
    row.unexpected_membership ||
    !row.migrator_members_exact ||
    !row.owner_members_exact
  ) {
    postgresFail(
      "migration_session_role_unsafe",
      "Role PostgreSQL de migration recusada."
    );
  }
  const access = await inspectSessionPrincipalAccess(client);
  if (principalAccessIsUnsafe(access)) {
    postgresFail(
      "migration_session_owns_schema_object",
      "Principal PostgreSQL de migration recusada."
    );
  }
}

function targetFingerprint(target) {
  const normalized = [
    String(target.environment || "").toLowerCase(),
    String(target.environmentId || "").toLowerCase(),
    String(target.host || "").toLowerCase(),
    String(target.port || "5432"),
    String(target.database || ""),
    String(target.username || "").toLowerCase()
  ].join("/");
  return sha256(normalized);
}

function assertApplyTarget(target, env = process.env) {
  if (!target || target.approval !== APPLY_APPROVAL) {
    postgresFail(
      "migration_apply_not_approved",
      "Aplicacao de migrations nao autorizada."
    );
  }
  const expectedFingerprint = String(
    env.SOCIAL_MIGRATION_TARGET_FINGERPRINT || ""
  );
  if (
    !/^[0-9a-f]{64}$/.test(expectedFingerprint) ||
    expectedFingerprint !== targetFingerprint(target)
  ) {
    postgresFail(
      "migration_target_not_verified",
      "Destino da migration nao foi confirmado."
    );
  }

  const environment = String(target.environment || "").toLowerCase();
  const productionLike =
    environment === "production" ||
    environment === "prod" ||
    /(^|[-_.])(prod|production)([-_.]|$)/i.test(
      `${target.host}/${target.database}`
    );
  if (productionLike && target.productionApproval !== PRODUCTION_APPROVAL) {
    postgresFail(
      "production_migration_not_approved",
      "Migration de producao recusada."
    );
  }
  if (
    !productionLike &&
    !["local", "test", "staging"].includes(environment)
  ) {
    postgresFail(
      "migration_environment_invalid",
      "Ambiente de migration recusado."
    );
  }
}

async function verifyTargetMarker(client, migratorRole, target) {
  const result = await withRoleTransaction(client, migratorRole, () =>
    client.query(
      [
        "SELECT environment_id::text, environment_name",
        "FROM ia4tube_migrations.environment_identity",
        "WHERE singleton = TRUE"
      ].join("\n")
    )
  );
  const row = result.rows?.[0];
  if (
    !row ||
    result.rows.length !== 1 ||
    row.environment_id !== String(target.environmentId).toLowerCase() ||
    row.environment_name !== String(target.environment).toLowerCase()
  ) {
    postgresFail(
      "migration_environment_marker_mismatch",
      "Identidade persistida do ambiente diverge."
    );
  }
}

async function withAdvisoryLock(client, operation) {
  await client.query("SELECT pg_advisory_lock($1::bigint)", [
    ADVISORY_LOCK_ID
  ]);
  let operationError;
  try {
    return await operation();
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    let unlocked;
    try {
      const result = await client.query(
        "SELECT pg_advisory_unlock($1::bigint) AS unlocked",
        [ADVISORY_LOCK_ID]
      );
      unlocked = result.rows?.[0]?.unlocked;
    } catch (error) {
      const failure = new Error("migration_advisory_unlock_failed");
      failure.code = "migration_advisory_unlock_failed";
      failure.discardClient = true;
      failure.cause = operationError || error;
      throw failure;
    }
    if (unlocked !== true) {
      const failure = new Error("migration_advisory_unlock_not_owned");
      failure.code = "migration_advisory_unlock_not_owned";
      failure.discardClient = true;
      failure.cause = operationError;
      throw failure;
    }
  }
}

async function applyOne(client, migration, ownerRole) {
  const started = process.hrtime.bigint();
  await client.query("BEGIN");
  try {
    await client.query(`SET LOCAL ROLE ${quoteIdentifier(ownerRole)}`);
    await client.query(migration.sql);
    const elapsed = Number((process.hrtime.bigint() - started) / 1000000n);
    await client.query(
      [
        `INSERT INTO ${LEDGER_NAME} (`,
        "  version, checksum_sha256, execution_ms",
        ") VALUES ($1, $2, $3)"
      ].join("\n"),
      [migration.version, migration.sha256, elapsed]
    );
    await client.query("COMMIT");
    return Object.freeze({
      version: migration.version,
      checksum: migration.sha256,
      executionMs: elapsed
    });
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      rollbackError.code = "migration_apply_rollback_failed";
      rollbackError.discardClient = true;
      rollbackError.cause = error;
      throw rollbackError;
    }
    throw error;
  }
}

function createMigrationRunner(options = {}) {
  const pool = options.pool;
  const ownerRole = options.ownerRole;
  const migratorRole = options.migratorRole;
  const target = options.target;
  const manifestOptions = options.manifestOptions || {};
  if (!pool || typeof pool.connect !== "function") {
    postgresFail("postgres_pool_required", "Pool PostgreSQL obrigatorio.");
  }
  quoteIdentifier(ownerRole);
  quoteIdentifier(migratorRole);
  if (
    ownerRole !== SOCIAL_OWNER_ROLE ||
    migratorRole !== SOCIAL_MIGRATOR_ROLE
  ) {
    postgresFail(
      "migration_roles_must_be_canonical",
      "Roles PostgreSQL de migration divergentes."
    );
  }

  async function inspect() {
    const local = readManifest(manifestOptions);
    const client = await pool.connect();
    let releaseError;
    try {
      await verifyMigrationSession(client, migratorRole, ownerRole);
      await verifyMigrationInfrastructure(client, migratorRole, ownerRole);
      await verifyTargetMarker(client, migratorRole, target);
      const applied = await readMigrationState(client, migratorRole);
      return compareMigrationState(local, applied);
    } catch (error) {
      if (error?.discardClient) releaseError = error;
      throw error;
    } finally {
      client.release(releaseError);
    }
  }

  async function validate() {
    const status = await inspect();
    return Object.freeze({
      valid: true,
      applied: status.filter((item) => item.state === "applied").length,
      pending: status.filter((item) => item.state === "pending").length,
      migrations: status
    });
  }

  async function apply(env = process.env) {
    assertApplyTarget(target, env);
    const local = readManifest(manifestOptions);
    const client = await pool.connect();
    let releaseError;
    try {
      await verifyMigrationSession(client, migratorRole, ownerRole);
      await verifyMigrationInfrastructure(client, migratorRole, ownerRole);
      await verifyTargetMarker(client, migratorRole, target);
      return await withAdvisoryLock(client, async () => {
        await ensureLedger(client, ownerRole, migratorRole);
        const state = compareMigrationState(
          local,
          await readMigrationState(client, migratorRole)
        );
        const pendingVersions = new Set(
          state
            .filter((item) => item.state === "pending")
            .map((item) => item.version)
        );
        const applied = [];
        for (const migration of local) {
          if (pendingVersions.has(migration.version)) {
            applied.push(await applyOne(client, migration, ownerRole));
          }
        }
        return Object.freeze(applied);
      });
    } catch (error) {
      if (error?.discardClient) releaseError = error;
      throw error;
    } finally {
      client.release(releaseError);
    }
  }

  return Object.freeze({ apply, inspect, validate });
}

module.exports = {
  ADVISORY_LOCK_ID,
  APPLY_APPROVAL,
  LEDGER_NAME,
  MIGRATION_FILE_PATTERN,
  PRODUCTION_APPROVAL,
  assertApplyTarget,
  assertNonDestructiveSql,
  compareMigrationState,
  createMigrationRunner,
  readManifest,
  readMigrationState,
  sha256,
  targetFingerprint,
  verifyMigrationInfrastructure,
  verifyMigrationSession,
  verifyTargetMarker,
  withRoleTransaction
};
