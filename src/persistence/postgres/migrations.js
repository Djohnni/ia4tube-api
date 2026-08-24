"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  SOCIAL_MIGRATOR_ROLE,
  SOCIAL_OWNER_ROLE,
  SOCIAL_RUNTIME_ROLE
} = require("./config");
const { postgresFail } = require("./errors");
const {
  inspectSessionPrincipalAccess,
  principalAccessIsUnsafe,
  quoteIdentifier
} = require("./pool");
const {
  PAID_STAGING_PUBLIC_TARGET
} = require("./staging-provisioner");

const MIGRATION_FILE_PATTERN = /^(\d{4}_[a-z0-9_]+)\.up\.sql$/;
const ADVISORY_LOCK_ID = "483178116797201191";
const LEDGER_NAME = "ia4tube_migrations.schema_migrations";
const APPLY_APPROVAL = "APPLY_SOCIAL_MIGRATIONS";
const PRODUCTION_APPROVAL =
  "APPLY_SOCIAL_MIGRATIONS_TO_PRODUCTION_WITH_VERIFIED_BACKUP";
const GLOBAL_VAULT_REGISTRY_MIGRATION =
  "0003_global_vault_key_registry";
const SOCIAL_CONNECTOR_PERSISTENCE_MIGRATION =
  "0004_social_connector_persistence";
const EXACT_FROM_PROFILE = "social-schema-0003";
const EXACT_TO_PROFILE = "social-schema-0004";
const EXACT_PENDING_MIGRATIONS = Object.freeze([
  SOCIAL_CONNECTOR_PERSISTENCE_MIGRATION
]);
const STAGING_EXACT_0004_SQL_SHA256 =
  "91f6efc611903c40e16bd37828d5b9c1a03dfae222e1d13b5dc97f81ffde1b5d";
const STAGING_EXACT_APPROVAL_PREFIX =
  "APPLY_SOCIAL_STAGING_EXACT_0004";
const STAGING_EXACT_WEB_SERVICE_ID = "srv-d9itiiurnols73fsbmmg";
const STAGING_EXACT_DATABASE_SERVICE_ID = "dpg-d9l8u27qj5pc738k3rvg-a";
const EXACT_BASE_MIGRATIONS = Object.freeze([
  "0001_social_multitenant_foundation",
  "0002_social_connections_and_vault",
  GLOBAL_VAULT_REGISTRY_MIGRATION
]);
const EXACT_TARGET_MIGRATIONS = Object.freeze([
  ...EXACT_BASE_MIGRATIONS,
  SOCIAL_CONNECTOR_PERSISTENCE_MIGRATION
]);
const EXACT_BASE_TABLES = Object.freeze([
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
const EXACT_CONNECTOR_TABLES = Object.freeze([
  "social_idempotency_operations",
  "social_publications",
  "social_publication_attempts"
]);
const EXACT_PROFILE_TABLES = Object.freeze({
  [EXACT_FROM_PROFILE]: EXACT_BASE_TABLES,
  [EXACT_TO_PROFILE]: Object.freeze([
    ...EXACT_BASE_TABLES,
    ...EXACT_CONNECTOR_TABLES
  ])
});
const EXACT_RUNTIME_TABLE_GRANTS = Object.freeze({
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
const EXACT_RUNTIME_COLUMN_GRANTS = Object.freeze({
  companies: {
    id: ["SELECT"],
    name: ["SELECT"],
    status: ["SELECT"],
    identity_derivation_version: ["SELECT"],
    created_at: ["SELECT"],
    updated_at: ["SELECT"]
  },
  users: {
    company_id: ["SELECT"],
    id: ["SELECT"],
    password_hash: ["SELECT"],
    status: ["SELECT"],
    auth_version: ["SELECT"]
  },
  company_memberships: {
    company_id: ["SELECT"],
    user_id: ["SELECT"],
    role: ["SELECT"],
    status: ["SELECT"],
    created_at: ["SELECT"],
    updated_at: ["SELECT"]
  },
  social_connections: {
    status: ["UPDATE"],
    connected_at: ["UPDATE"],
    expires_at: ["UPDATE"],
    revoked_at: ["UPDATE"],
    disconnected_at: ["UPDATE"],
    updated_at: ["UPDATE"],
    revision: ["UPDATE"]
  },
  social_external_accounts: {
    username: ["UPDATE"],
    display_name: ["UPDATE"],
    account_type: ["UPDATE"],
    status: ["UPDATE"],
    updated_at: ["UPDATE"]
  },
  social_destinations: {
    display_name: ["UPDATE"],
    status: ["UPDATE"],
    updated_at: ["UPDATE"]
  },
  social_connection_scopes: {
    expires_at: ["UPDATE"]
  },
  social_oauth_transactions: {
    consumed_at: ["UPDATE"],
    cancelled_at: ["UPDATE"],
    failed_at: ["UPDATE"],
    failure_code: ["UPDATE"]
  },
  social_encrypted_credentials: {
    connection_id: ["UPDATE"],
    oauth_transaction_id: ["UPDATE"],
    ciphertext: ["UPDATE"],
    nonce: ["UPDATE"],
    auth_tag: ["UPDATE"],
    key_version: ["UPDATE"],
    expires_at: ["UPDATE"],
    revoked_at: ["UPDATE"],
    updated_at: ["UPDATE"],
    revision: ["UPDATE"]
  },
  social_reauth_grants: {
    consumed_at: ["UPDATE"]
  },
  social_idempotency_operations: {
    status: ["UPDATE"],
    result_payload: ["UPDATE"],
    error_code: ["UPDATE"],
    updated_at: ["UPDATE"],
    revision: ["UPDATE"]
  },
  social_publications: {
    state: ["UPDATE"],
    confirmed_provider_reference: ["UPDATE"],
    reconciliation_reference: ["UPDATE"],
    error_code: ["UPDATE"],
    published_at: ["UPDATE"],
    updated_at: ["UPDATE"],
    revision: ["UPDATE"]
  },
  social_publication_attempts: {
    state: ["UPDATE"],
    error_code: ["UPDATE"],
    provider_reference: ["UPDATE"],
    finished_at: ["UPDATE"],
    duration_ms: ["UPDATE"],
    retry_after: ["UPDATE"],
    updated_at: ["UPDATE"],
    revision: ["UPDATE"]
  }
});
const EXACT_0004_NOT_VALID_CONSTRAINTS = Object.freeze([
  "social_external_accounts|social_external_accounts_instagram_professional|c",
  "social_oauth_transactions|social_oauth_transactions_connection_fk|f",
  "social_audit_events|social_audit_events_reference_provider_present|c",
  "social_audit_events|social_audit_events_connection_provider_fk|f",
  "social_audit_events|social_audit_events_publication_provider_fk|f"
]);
const SOCIAL_CONNECTION_STATUS_CONSTRAINT_REPLACEMENTS = Object.freeze([
  "social_connections_status_allowed",
  "social_connections_status_timestamp_consistent"
]);
const GLOBAL_VAULT_BACKFILL_POLICY =
  "social_credentials_key_registry_backfill";
const GLOBAL_VAULT_BACKFILL_POLICY_CREATE = [
  `CREATE POLICY ${GLOBAL_VAULT_BACKFILL_POLICY}`,
  "  ON ia4tube_social.social_encrypted_credentials",
  "  AS PERMISSIVE",
  "  FOR SELECT",
  "  TO ia4tube_social_owner",
  "  USING (TRUE)"
].join("\n");
const GLOBAL_VAULT_BACKFILL_POLICY_DROP = [
  `DROP POLICY ${GLOBAL_VAULT_BACKFILL_POLICY}`,
  "  ON ia4tube_social.social_encrypted_credentials"
].join("\n");

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

function exactSetMatches(actual, expected) {
  if (actual.size !== expected.size) return false;
  for (const value of expected) {
    if (!actual.has(value)) return false;
  }
  return true;
}

function exactProfileTables(profile) {
  const tables = EXACT_PROFILE_TABLES[profile];
  if (!tables) {
    postgresFail(
      "migration_exact_profile_invalid",
      "Perfil fisico de migration recusado."
    );
  }
  return tables;
}

function canonicalPolicyExpression(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/::text\b/g, "")
    .replace(/[\s()]+/g, "");
}

function expectedPolicyExpression(scopeColumn) {
  return (
    `${scopeColumn}=nullifcurrent_setting` +
    "'ia4tube.company_id',true,''::uuid"
  );
}

function expectedExactTableGrantSet(profile, runtimeRole, ownerRole) {
  const tables = new Set(exactProfileTables(profile));
  const expected = new Set();
  for (const [table, privileges] of Object.entries(
    EXACT_RUNTIME_TABLE_GRANTS
  )) {
    if (table !== "runtime_schema_contract" && !tables.has(table)) continue;
    for (const privilege of privileges) {
      expected.add(
        `${runtimeRole}|${table}|${privilege}|false|${ownerRole}`
      );
    }
  }
  return expected;
}

function expectedExactColumnGrantSet(profile, runtimeRole, ownerRole) {
  const tables = new Set(exactProfileTables(profile));
  const expected = new Set();
  for (const [table, columns] of Object.entries(
    EXACT_RUNTIME_COLUMN_GRANTS
  )) {
    if (!tables.has(table)) continue;
    for (const [column, privileges] of Object.entries(columns)) {
      if (
        profile === EXACT_FROM_PROFILE &&
        (
          (table === "social_oauth_transactions" &&
            ["failed_at", "failure_code"].includes(column)) ||
          (table === "social_encrypted_credentials" &&
            ["connection_id", "oauth_transaction_id"].includes(column))
        )
      ) {
        continue;
      }
      for (const privilege of privileges) {
        expected.add(
          `${runtimeRole}|${table}|${column}|${privilege}|false|` +
            ownerRole
        );
      }
    }
  }
  return expected;
}

function exactTableAclRowKey(row) {
  return (
    `${String(row.grantee).toLowerCase()}|${row.table_name}|` +
    `${String(row.privilege_type).toUpperCase()}|` +
    `${Boolean(row.is_grantable)}|` +
    String(row.grantor_name).toLowerCase()
  );
}

function exactColumnAclRowKey(row) {
  return (
    `${String(row.grantee).toLowerCase()}|${row.table_name}|` +
    `${row.column_name}|${String(row.privilege_type).toUpperCase()}|` +
    `${Boolean(row.is_grantable)}|` +
    String(row.grantor_name).toLowerCase()
  );
}

async function verifySocialPhysicalProfile(
  client,
  profile,
  ownerRole = SOCIAL_OWNER_ROLE,
  runtimeRole = SOCIAL_RUNTIME_ROLE
) {
  const tables = exactProfileTables(profile);
  const expectedRelations = new Map([
    ...tables.map((table) => [table, "r"]),
    ["runtime_schema_contract", "v"]
  ]);

  const schema = await client.query(
    [
      "SELECT owner.rolname AS owner_name,",
      "  (",
      "    SELECT COUNT(*)::integer",
      "    FROM pg_catalog.pg_proc routine",
      "    WHERE routine.pronamespace = namespace.oid",
      "  ) AS routine_count",
      "FROM pg_catalog.pg_namespace namespace",
      "JOIN pg_catalog.pg_roles owner",
      "  ON owner.oid = namespace.nspowner",
      "WHERE namespace.nspname = 'ia4tube_social'"
    ].join("\n")
  );
  if (
    schema.rows?.length !== 1 ||
    schema.rows[0].owner_name !== ownerRole ||
    Number(schema.rows[0].routine_count) !== 0
  ) {
    postgresFail(
      "migration_exact_schema_profile_mismatch",
      "Schema social diverge do perfil exato."
    );
  }

  const relations = await client.query(
    [
      "SELECT relation.relname, relation.relkind AS object_kind,",
      "  owner.rolname AS owner_name, relation.relrowsecurity,",
      "  relation.relforcerowsecurity",
      "FROM pg_catalog.pg_class relation",
      "JOIN pg_catalog.pg_namespace namespace",
      "  ON namespace.oid = relation.relnamespace",
      "JOIN pg_catalog.pg_roles owner ON owner.oid = relation.relowner",
      "WHERE namespace.nspname = 'ia4tube_social'",
      "  AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')",
      "ORDER BY relation.relname"
    ].join("\n")
  );
  if (
    relations.rows?.length !== expectedRelations.size ||
    relations.rows.some(
      (row) =>
        expectedRelations.get(row.relname) !== row.object_kind ||
        row.owner_name !== ownerRole ||
        (
          row.object_kind === "r" &&
          (!row.relrowsecurity || !row.relforcerowsecurity)
        )
    )
  ) {
    postgresFail(
      "migration_exact_relation_profile_mismatch",
      "Relacoes sociais divergem do perfil exato."
    );
  }

  const policies = await client.query(
    [
      "SELECT tablename, policyname, permissive, roles, cmd, qual, with_check",
      "FROM pg_catalog.pg_policies",
      "WHERE schemaname = 'ia4tube_social'",
      "ORDER BY tablename, policyname"
    ].join("\n")
  );
  if (policies.rows?.length !== tables.length) {
    postgresFail(
      "migration_exact_rls_profile_mismatch",
      "Policies sociais divergem do perfil exato."
    );
  }
  const policyByTable = new Map();
  for (const policy of policies.rows || []) {
    if (policyByTable.has(policy.tablename)) {
      postgresFail(
        "migration_exact_rls_profile_mismatch",
        "Policies sociais divergem do perfil exato."
      );
    }
    policyByTable.set(policy.tablename, policy);
  }
  for (const table of tables) {
    const policy = policyByTable.get(table);
    const roles = Array.isArray(policy?.roles)
      ? policy.roles.map((item) => String(item).toLowerCase())
      : String(policy?.roles || "").toLowerCase() === "{public}"
        ? ["public"]
        : [];
    const scopeColumn = table === "companies" ? "id" : "company_id";
    const expectedExpression = expectedPolicyExpression(scopeColumn);
    if (
      !policy ||
      policy.policyname !== `${table}_company_scope` ||
      policy.permissive !== "PERMISSIVE" ||
      roles.length !== 1 ||
      roles[0] !== "public" ||
      policy.cmd !== "ALL" ||
      canonicalPolicyExpression(policy.qual) !== expectedExpression ||
      canonicalPolicyExpression(policy.with_check) !== expectedExpression
    ) {
      postgresFail(
        "migration_exact_rls_profile_mismatch",
        "Policies sociais divergem do perfil exato."
      );
    }
  }

  const schemaAclRows = await client.query(
    [
      "SELECT COALESCE(grantee.rolname, 'PUBLIC') AS grantee,",
      "  expanded_acl.privilege_type, expanded_acl.is_grantable,",
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
      "WHERE namespace.nspname = 'ia4tube_social'",
      "  AND expanded_acl.grantee <> namespace.nspowner",
      "ORDER BY grantee, expanded_acl.privilege_type"
    ].join("\n")
  );
  if (
    !exactAclMatches(
      schemaAclRows.rows,
      new Set([`${runtimeRole}|USAGE|false|${ownerRole}`])
    )
  ) {
    postgresFail(
      "migration_exact_grants_profile_mismatch",
      "ACL social diverge do perfil exato."
    );
  }

  const tableAclRows = await client.query(
    [
      "SELECT COALESCE(grantee.rolname, 'PUBLIC') AS grantee,",
      "  relation.relname AS table_name, expanded_acl.privilege_type,",
      "  expanded_acl.is_grantable, grantor.rolname AS grantor_name",
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
      "WHERE namespace.nspname = 'ia4tube_social'",
      "  AND relation.relkind IN ('r', 'p', 'v')",
      "  AND expanded_acl.grantee <> relation.relowner",
      "ORDER BY grantee, table_name, expanded_acl.privilege_type"
    ].join("\n")
  );
  const actualTableGrants = new Set(
    (tableAclRows.rows || []).map(exactTableAclRowKey)
  );
  if (
    !exactSetMatches(
      actualTableGrants,
      expectedExactTableGrantSet(profile, runtimeRole, ownerRole)
    )
  ) {
    postgresFail(
      "migration_exact_grants_profile_mismatch",
      "ACL social diverge do perfil exato."
    );
  }

  const columnAclRows = await client.query(
    [
      "SELECT COALESCE(grantee.rolname, 'PUBLIC') AS grantee,",
      "  relation.relname AS table_name, attribute.attname AS column_name,",
      "  expanded_acl.privilege_type, expanded_acl.is_grantable,",
      "  grantor.rolname AS grantor_name",
      "FROM pg_catalog.pg_attribute attribute",
      "JOIN pg_catalog.pg_class relation",
      "  ON relation.oid = attribute.attrelid",
      "JOIN pg_catalog.pg_namespace namespace",
      "  ON namespace.oid = relation.relnamespace",
      "CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) expanded_acl",
      "LEFT JOIN pg_catalog.pg_roles grantee",
      "  ON grantee.oid = expanded_acl.grantee",
      "LEFT JOIN pg_catalog.pg_roles grantor",
      "  ON grantor.oid = expanded_acl.grantor",
      "WHERE namespace.nspname = 'ia4tube_social'",
      "  AND attribute.attnum > 0 AND NOT attribute.attisdropped",
      "  AND expanded_acl.grantee <> relation.relowner",
      "ORDER BY grantee, table_name, column_name,",
      "  expanded_acl.privilege_type"
    ].join("\n")
  );
  const actualColumnGrants = new Set(
    (columnAclRows.rows || []).map(exactColumnAclRowKey)
  );
  if (
    !exactSetMatches(
      actualColumnGrants,
      expectedExactColumnGrantSet(profile, runtimeRole, ownerRole)
    )
  ) {
    postgresFail(
      "migration_exact_grants_profile_mismatch",
      "ACL social diverge do perfil exato."
    );
  }

  const notValidConstraints = await client.query(
    [
      "SELECT relation.relname AS table_name, constraint_info.conname,",
      "  constraint_info.contype",
      "FROM pg_catalog.pg_constraint constraint_info",
      "JOIN pg_catalog.pg_class relation",
      "  ON relation.oid = constraint_info.conrelid",
      "JOIN pg_catalog.pg_namespace namespace",
      "  ON namespace.oid = relation.relnamespace",
      "WHERE namespace.nspname = 'ia4tube_social'",
      "  AND NOT constraint_info.convalidated",
      "ORDER BY constraint_info.conname"
    ].join("\n")
  );
  const expectedNotValid =
    profile === EXACT_TO_PROFILE
      ? new Set(EXACT_0004_NOT_VALID_CONSTRAINTS)
      : new Set();
  const actualNotValid = new Set(
    (notValidConstraints.rows || []).map(
      (row) => `${row.table_name}|${row.conname}|${row.contype}`
    )
  );
  if (!exactSetMatches(actualNotValid, expectedNotValid)) {
    postgresFail(
      "migration_exact_constraints_profile_mismatch",
      "Constraints sociais divergem do perfil exato."
    );
  }

  return Object.freeze({
    profile,
    relationCount: expectedRelations.size,
    tableCount: tables.length
  });
}

function canonicalCatalogRows(rows, fields) {
  return (rows || []).map((row) => {
    const result = {};
    for (const field of fields) {
      const value = row[field];
      result[field] = value === undefined ? null : value;
    }
    return result;
  });
}

async function readStagingExactCatalogSnapshot(client) {
  const relations = await client.query(
    [
      "SELECT namespace.nspname::text AS schema_name,",
      "  relation.relname::text AS relation_name,",
      "  relation.relkind::text AS relation_kind,",
      "  owner.rolname::text AS owner_name,",
      "  relation.relpersistence::text AS persistence,",
      "  relation.relrowsecurity, relation.relforcerowsecurity,",
      "  relation.relreplident::text AS replica_identity,",
      "  access_method.amname::text AS access_method,",
      "  tablespace.spcname::text AS tablespace_name,",
      "  relation.reloptions",
      "FROM pg_catalog.pg_class relation",
      "JOIN pg_catalog.pg_namespace namespace",
      "  ON namespace.oid = relation.relnamespace",
      "JOIN pg_catalog.pg_roles owner ON owner.oid = relation.relowner",
      "LEFT JOIN pg_catalog.pg_am access_method",
      "  ON access_method.oid = relation.relam",
      "LEFT JOIN pg_catalog.pg_tablespace tablespace",
      "  ON tablespace.oid = relation.reltablespace",
      "WHERE namespace.nspname IN ('ia4tube_migrations', 'ia4tube_social')",
      "  AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')",
      "ORDER BY namespace.nspname, relation.relname"
    ].join("\n")
  );
  const columns = await client.query(
    [
      "SELECT namespace.nspname::text AS schema_name,",
      "  relation.relname::text AS relation_name,",
      "  attribute.attnum::integer AS ordinal_position,",
      "  attribute.attname::text AS column_name,",
      "  pg_catalog.format_type(attribute.atttypid, attribute.atttypmod)::text",
      "    AS data_type,",
      "  attribute.attnotnull, attribute.attidentity::text AS identity_kind,",
      "  attribute.attgenerated::text AS generated_kind,",
      "  pg_catalog.pg_get_expr(default_value.adbin,",
      "    default_value.adrelid, TRUE)::text AS default_definition,",
      "  collation.collname::text AS collation_name",
      "FROM pg_catalog.pg_attribute attribute",
      "JOIN pg_catalog.pg_class relation ON relation.oid = attribute.attrelid",
      "JOIN pg_catalog.pg_namespace namespace",
      "  ON namespace.oid = relation.relnamespace",
      "LEFT JOIN pg_catalog.pg_attrdef default_value",
      "  ON default_value.adrelid = attribute.attrelid",
      "  AND default_value.adnum = attribute.attnum",
      "LEFT JOIN pg_catalog.pg_collation collation",
      "  ON collation.oid = NULLIF(attribute.attcollation, 0)",
      "WHERE namespace.nspname IN ('ia4tube_migrations', 'ia4tube_social')",
      "  AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')",
      "  AND attribute.attnum > 0 AND NOT attribute.attisdropped",
      "ORDER BY namespace.nspname, relation.relname, attribute.attnum"
    ].join("\n")
  );
  const constraints = await client.query(
    [
      "SELECT namespace.nspname::text AS schema_name,",
      "  relation.relname::text AS relation_name,",
      "  constraint_info.conname::text AS constraint_name,",
      "  constraint_info.contype::text AS constraint_type,",
      "  constraint_info.convalidated, constraint_info.condeferrable,",
      "  constraint_info.condeferred,",
      "  pg_catalog.pg_get_constraintdef(constraint_info.oid, TRUE)::text",
      "    AS definition",
      "FROM pg_catalog.pg_constraint constraint_info",
      "JOIN pg_catalog.pg_class relation",
      "  ON relation.oid = constraint_info.conrelid",
      "JOIN pg_catalog.pg_namespace namespace",
      "  ON namespace.oid = relation.relnamespace",
      "WHERE namespace.nspname IN ('ia4tube_migrations', 'ia4tube_social')",
      "ORDER BY namespace.nspname, relation.relname, constraint_info.conname"
    ].join("\n")
  );
  const indexes = await client.query(
    [
      "SELECT namespace.nspname::text AS schema_name,",
      "  table_relation.relname::text AS relation_name,",
      "  index_relation.relname::text AS index_name,",
      "  owner.rolname::text AS owner_name,",
      "  index_info.indisunique, index_info.indisprimary,",
      "  index_info.indisexclusion, index_info.indisvalid,",
      "  index_info.indisready, index_info.indislive,",
      "  pg_catalog.pg_get_indexdef(index_relation.oid)::text AS definition,",
      "  pg_catalog.pg_get_expr(index_info.indpred,",
      "    index_info.indrelid, TRUE)::text AS predicate",
      "FROM pg_catalog.pg_index index_info",
      "JOIN pg_catalog.pg_class table_relation",
      "  ON table_relation.oid = index_info.indrelid",
      "JOIN pg_catalog.pg_class index_relation",
      "  ON index_relation.oid = index_info.indexrelid",
      "JOIN pg_catalog.pg_namespace namespace",
      "  ON namespace.oid = table_relation.relnamespace",
      "JOIN pg_catalog.pg_roles owner ON owner.oid = index_relation.relowner",
      "WHERE namespace.nspname IN ('ia4tube_migrations', 'ia4tube_social')",
      "ORDER BY namespace.nspname, table_relation.relname,",
      "  index_relation.relname"
    ].join("\n")
  );
  const views = await client.query(
    [
      "SELECT namespace.nspname::text AS schema_name,",
      "  relation.relname::text AS relation_name,",
      "  relation.relkind::text AS relation_kind,",
      "  pg_catalog.pg_get_viewdef(relation.oid, TRUE)::text AS definition",
      "FROM pg_catalog.pg_class relation",
      "JOIN pg_catalog.pg_namespace namespace",
      "  ON namespace.oid = relation.relnamespace",
      "WHERE namespace.nspname IN ('ia4tube_migrations', 'ia4tube_social')",
      "  AND relation.relkind IN ('v', 'm')",
      "ORDER BY namespace.nspname, relation.relname"
    ].join("\n")
  );
  const triggers = await client.query(
    [
      "SELECT namespace.nspname::text AS schema_name,",
      "  relation.relname::text AS relation_name,",
      "  trigger_info.tgname::text AS trigger_name,",
      "  trigger_info.tgenabled::text AS enabled_kind,",
      "  pg_catalog.pg_get_triggerdef(trigger_info.oid, TRUE)::text",
      "    AS definition",
      "FROM pg_catalog.pg_trigger trigger_info",
      "JOIN pg_catalog.pg_class relation",
      "  ON relation.oid = trigger_info.tgrelid",
      "JOIN pg_catalog.pg_namespace namespace",
      "  ON namespace.oid = relation.relnamespace",
      "WHERE namespace.nspname IN ('ia4tube_migrations', 'ia4tube_social')",
      "  AND NOT trigger_info.tgisinternal",
      "ORDER BY namespace.nspname, relation.relname, trigger_info.tgname"
    ].join("\n")
  );
  const rules = await client.query(
    [
      "SELECT namespace.nspname::text AS schema_name,",
      "  relation.relname::text AS relation_name,",
      "  rule_info.rulename::text AS rule_name,",
      "  rule_info.ev_type::text AS event_type,",
      "  rule_info.is_instead,",
      "  pg_catalog.pg_get_ruledef(rule_info.oid, TRUE)::text AS definition",
      "FROM pg_catalog.pg_rewrite rule_info",
      "JOIN pg_catalog.pg_class relation",
      "  ON relation.oid = rule_info.ev_class",
      "JOIN pg_catalog.pg_namespace namespace",
      "  ON namespace.oid = relation.relnamespace",
      "WHERE namespace.nspname IN ('ia4tube_migrations', 'ia4tube_social')",
      "  AND rule_info.rulename <> '_RETURN'",
      "ORDER BY namespace.nspname, relation.relname, rule_info.rulename"
    ].join("\n")
  );
  const sequences = await client.query(
    [
      "SELECT namespace.nspname::text AS schema_name,",
      "  relation.relname::text AS relation_name,",
      "  pg_catalog.format_type(sequence_info.seqtypid, NULL)::text",
      "    AS data_type,",
      "  sequence_info.seqstart::text, sequence_info.seqincrement::text,",
      "  sequence_info.seqmax::text, sequence_info.seqmin::text,",
      "  sequence_info.seqcache::text, sequence_info.seqcycle",
      "FROM pg_catalog.pg_sequence sequence_info",
      "JOIN pg_catalog.pg_class relation",
      "  ON relation.oid = sequence_info.seqrelid",
      "JOIN pg_catalog.pg_namespace namespace",
      "  ON namespace.oid = relation.relnamespace",
      "WHERE namespace.nspname IN ('ia4tube_migrations', 'ia4tube_social')",
      "ORDER BY namespace.nspname, relation.relname"
    ].join("\n")
  );
  const routines = await client.query(
    [
      "SELECT namespace.nspname::text AS schema_name,",
      "  routine.proname::text AS routine_name,",
      "  routine.prokind::text AS routine_kind,",
      "  owner.rolname::text AS owner_name,",
      "  language.lanname::text AS language_name,",
      "  routine.prosecdef, routine.provolatile::text AS volatility,",
      "  routine.proparallel::text AS parallel_kind,",
      "  pg_catalog.pg_get_function_identity_arguments(routine.oid)::text",
      "    AS identity_arguments,",
      "  pg_catalog.pg_get_function_result(routine.oid)::text AS result_type,",
      "  pg_catalog.pg_get_functiondef(routine.oid)::text AS definition",
      "FROM pg_catalog.pg_proc routine",
      "JOIN pg_catalog.pg_namespace namespace",
      "  ON namespace.oid = routine.pronamespace",
      "JOIN pg_catalog.pg_roles owner ON owner.oid = routine.proowner",
      "JOIN pg_catalog.pg_language language ON language.oid = routine.prolang",
      "WHERE namespace.nspname IN ('ia4tube_migrations', 'ia4tube_social')",
      "ORDER BY namespace.nspname, routine.proname,",
      "  pg_catalog.pg_get_function_identity_arguments(routine.oid)"
    ].join("\n")
  );
  const types = await client.query(
    [
      "SELECT namespace.nspname::text AS schema_name,",
      "  type_info.typname::text AS type_name,",
      "  type_info.typtype::text AS type_kind,",
      "  type_info.typcategory::text AS category,",
      "  owner.rolname::text AS owner_name,",
      "  type_info.typnotnull, type_info.typdefault::text AS default_value,",
      "  type_info.typelem::regtype::text AS element_type",
      "FROM pg_catalog.pg_type type_info",
      "JOIN pg_catalog.pg_namespace namespace",
      "  ON namespace.oid = type_info.typnamespace",
      "JOIN pg_catalog.pg_roles owner ON owner.oid = type_info.typowner",
      "WHERE namespace.nspname IN ('ia4tube_migrations', 'ia4tube_social')",
      "ORDER BY namespace.nspname, type_info.typname"
    ].join("\n")
  );
  return Object.freeze({
    relations: Object.freeze(canonicalCatalogRows(relations.rows, [
      "schema_name", "relation_name", "relation_kind", "owner_name",
      "persistence", "relrowsecurity", "relforcerowsecurity",
      "replica_identity", "access_method", "tablespace_name", "reloptions"
    ])),
    columns: Object.freeze(canonicalCatalogRows(columns.rows, [
      "schema_name", "relation_name", "ordinal_position", "column_name",
      "data_type", "attnotnull", "identity_kind", "generated_kind",
      "default_definition", "collation_name"
    ])),
    constraints: Object.freeze(canonicalCatalogRows(constraints.rows, [
      "schema_name", "relation_name", "constraint_name", "constraint_type",
      "convalidated", "condeferrable", "condeferred", "definition"
    ])),
    indexes: Object.freeze(canonicalCatalogRows(indexes.rows, [
      "schema_name", "relation_name", "index_name", "owner_name",
      "indisunique", "indisprimary", "indisexclusion", "indisvalid",
      "indisready", "indislive", "definition", "predicate"
    ])),
    views: Object.freeze(canonicalCatalogRows(views.rows, [
      "schema_name", "relation_name", "relation_kind", "definition"
    ])),
    triggers: Object.freeze(canonicalCatalogRows(triggers.rows, [
      "schema_name", "relation_name", "trigger_name", "enabled_kind",
      "definition"
    ])),
    rules: Object.freeze(canonicalCatalogRows(rules.rows, [
      "schema_name", "relation_name", "rule_name", "event_type",
      "is_instead", "definition"
    ])),
    sequences: Object.freeze(canonicalCatalogRows(sequences.rows, [
      "schema_name", "relation_name", "data_type", "seqstart",
      "seqincrement", "seqmax", "seqmin", "seqcache", "seqcycle"
    ])),
    routines: Object.freeze(canonicalCatalogRows(routines.rows, [
      "schema_name", "routine_name", "routine_kind", "owner_name",
      "language_name", "prosecdef", "volatility", "parallel_kind",
      "identity_arguments", "result_type", "definition"
    ])),
    types: Object.freeze(canonicalCatalogRows(types.rows, [
      "schema_name", "type_name", "type_kind", "category", "owner_name",
      "typnotnull", "default_value", "element_type"
    ]))
  });
}

function stagingExactCatalogDigest(snapshot) {
  return sha256(Buffer.from(JSON.stringify(snapshot), "utf8"));
}

async function verifyStagingExactCatalogSnapshot(client, expectedDigest) {
  if (!/^[0-9a-f]{64}$/.test(String(expectedDigest || ""))) {
    postgresFail(
      "migration_staging_exact_catalog_digest_invalid",
      "Digest do catalogo staging recusado."
    );
  }
  const snapshot = await readStagingExactCatalogSnapshot(client);
  const actualDigest = stagingExactCatalogDigest(snapshot);
  if (actualDigest !== expectedDigest) {
    postgresFail(
      "migration_staging_exact_catalog_mismatch",
      "Catalogo fisico staging diverge do perfil congelado."
    );
  }
  return Object.freeze({
    sha256: actualDigest,
    relationCount: snapshot.relations.length,
    columnCount: snapshot.columns.length,
    constraintCount: snapshot.constraints.length,
    indexCount: snapshot.indexes.length,
    viewCount: snapshot.views.length,
    triggerCount: snapshot.triggers.length,
    ruleCount: snapshot.rules.length,
    sequenceCount: snapshot.sequences.length,
    routineCount: snapshot.routines.length,
    typeCount: snapshot.types.length
  });
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

function stripApprovedConstraintReplacement(sql, version) {
  const dropMarkers = [...sql.matchAll(/\bDROP\s+CONSTRAINT\b/gi)];
  if (
    dropMarkers.length === 0 ||
    version !== SOCIAL_CONNECTOR_PERSISTENCE_MIGRATION
  ) {
    return sql;
  }
  if (
    dropMarkers.length !==
      SOCIAL_CONNECTION_STATUS_CONSTRAINT_REPLACEMENTS.length ||
    /\bDROP\s+CONSTRAINT\s+IF\s+EXISTS\b/i.test(sql)
  ) {
    return sql;
  }

  const statementPattern =
    /\bALTER\s+TABLE\s+ia4tube_social\.social_connections\b[\s\S]*?;/gi;
  const statements = [...sql.matchAll(statementPattern)];
  const statement = statements.find((candidate) => {
    const start = candidate.index;
    const end = start + candidate[0].length;
    return dropMarkers.every(
      (marker) => marker.index >= start && marker.index < end
    );
  });
  if (!statement) return sql;

  const dropClausePattern =
    /\bDROP\s+CONSTRAINT\s+([a-z_][a-z0-9_]*)\s*,/gi;
  const dropClauses = [...statement[0].matchAll(dropClausePattern)];
  const droppedNames = dropClauses.map((match) => match[1].toLowerCase());
  if (
    dropClauses.length !== dropMarkers.length ||
    new Set(droppedNames).size !== droppedNames.length ||
    SOCIAL_CONNECTION_STATUS_CONSTRAINT_REPLACEMENTS.some(
      (constraint) => !droppedNames.includes(constraint)
    )
  ) {
    return sql;
  }

  for (const constraint of SOCIAL_CONNECTION_STATUS_CONSTRAINT_REPLACEMENTS) {
    const escaped = constraint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const replacementPattern = new RegExp(
      `\\bADD\\s+CONSTRAINT\\s+${escaped}\\s+CHECK\\s*\\(`,
      "gi"
    );
    if ([...statement[0].matchAll(replacementPattern)].length !== 1) {
      return sql;
    }
  }

  const sanitizedStatement = statement[0].replace(dropClausePattern, "");
  return (
    sql.slice(0, statement.index) +
    sanitizedStatement +
    sql.slice(statement.index + statement[0].length)
  );
}

function assertNonDestructiveSql(sql, version) {
  const withoutComments = sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ");
  const sanitized = stripApprovedConstraintReplacement(
    withoutComments,
    version
  );
  const forbidden = [
    /\bDROP\s+(TABLE|SCHEMA|DATABASE|COLUMN|CONSTRAINT|INDEX|TYPE)\b/i,
    /\bTRUNCATE\b/i,
    /\bDELETE\s+FROM\b/i,
    /\bALTER\s+TABLE\b[\s\S]*?\bDROP\b/i,
    /\bCASCADE\b/i
  ];
  if (forbidden.some((pattern) => pattern.test(sanitized))) {
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

async function verifyExistingLedgerContract(client, ownerRole, migratorRole) {
  if (!(await ledgerExists(client))) {
    postgresFail(
      "migration_exact_ledger_missing",
      "Ledger existente e obrigatorio para o modo exato."
    );
  }
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
      "SELECT COALESCE(grantee.rolname, 'PUBLIC') AS grantee,",
      "  expanded_acl.privilege_type, expanded_acl.is_grantable,",
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
      "  expanded_acl.privilege_type, expanded_acl.is_grantable,",
      "  grantor.rolname AS grantor_name",
      "FROM pg_catalog.pg_attribute attribute",
      "JOIN pg_catalog.pg_class relation",
      "  ON relation.oid = attribute.attrelid",
      "JOIN pg_catalog.pg_namespace namespace",
      "  ON namespace.oid = relation.relnamespace",
      "CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) expanded_acl",
      "LEFT JOIN pg_catalog.pg_roles grantee",
      "  ON grantee.oid = expanded_acl.grantee",
      "LEFT JOIN pg_catalog.pg_roles grantor",
      "  ON grantor.oid = expanded_acl.grantor",
      "WHERE namespace.nspname = 'ia4tube_migrations'",
      "  AND relation.relname = 'schema_migrations'",
      "  AND attribute.attnum > 0 AND NOT attribute.attisdropped",
      "  AND expanded_acl.grantee <> relation.relowner"
    ].join("\n")
  );
  if ((columnAcl.rows || []).length !== 0) {
    postgresFail(
      "migration_ledger_acl_invalid",
      "ACL por coluna do ledger de migrations recusada."
    );
  }
  return true;
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

function exactArrayMatches(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function validateExactMigrationRequest(request, options = {}) {
  const requireRecovery = Boolean(options.requireRecovery);
  if (
    !request ||
    request.fromProfile !== EXACT_FROM_PROFILE ||
    request.toProfile !== EXACT_TO_PROFILE ||
    !exactArrayMatches(request.expectedPending, EXACT_PENDING_MIGRATIONS)
  ) {
    postgresFail(
      "migration_exact_request_invalid",
      "Contrato da migration exata recusado."
    );
  }
  if (!requireRecovery) {
    if (
      request.recoveryReference !== undefined ||
      request.recoveryCapturedAt !== undefined
    ) {
      postgresFail(
        "migration_exact_recovery_not_allowed",
        "Evidencia de recovery recusada no plano read-only."
      );
    }
    return Object.freeze({
      fromProfile: EXACT_FROM_PROFILE,
      toProfile: EXACT_TO_PROFILE,
      expectedPending: EXACT_PENDING_MIGRATIONS
    });
  }

  const recoveryReference = request.recoveryReference;
  const recoveryCapturedAt = request.recoveryCapturedAt;
  if (
    typeof recoveryReference !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(recoveryReference)
  ) {
    postgresFail(
      "migration_exact_recovery_reference_invalid",
      "Referencia de recovery recusada."
    );
  }
  const recoveryTimestamp = Date.parse(recoveryCapturedAt);
  const canonicalRecoveryTimestamp =
    typeof recoveryCapturedAt === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(recoveryCapturedAt)
      ? recoveryCapturedAt.replace(/Z$/, ".000Z")
      : recoveryCapturedAt;
  if (
    typeof recoveryCapturedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(
      recoveryCapturedAt
    ) ||
    !Number.isFinite(recoveryTimestamp) ||
    new Date(recoveryTimestamp).toISOString() !== canonicalRecoveryTimestamp
  ) {
    postgresFail(
      "migration_exact_recovery_timestamp_invalid",
      "Timestamp de recovery recusado."
    );
  }
  return Object.freeze({
    fromProfile: EXACT_FROM_PROFILE,
    toProfile: EXACT_TO_PROFILE,
    expectedPending: EXACT_PENDING_MIGRATIONS,
    recoveryReference,
    recoveryCapturedAt
  });
}

function exactMigrationState(local, applied, profile) {
  const status = compareMigrationState(local, applied);
  const appliedVersions = status
    .filter((item) => item.state === "applied")
    .map((item) => item.version);
  const observedPending = status
    .filter((item) => item.state === "pending")
    .map((item) => item.version);
  const expectedApplied =
    profile === EXACT_FROM_PROFILE
      ? EXACT_BASE_MIGRATIONS
      : profile === EXACT_TO_PROFILE
        ? EXACT_TARGET_MIGRATIONS
        : null;
  const expectedPending =
    profile === EXACT_FROM_PROFILE ? EXACT_PENDING_MIGRATIONS : [];
  if (
    !expectedApplied ||
    !exactArrayMatches(appliedVersions, expectedApplied) ||
    !exactArrayMatches(observedPending, expectedPending)
  ) {
    postgresFail(
      "exact_pending_set_mismatch",
      "Conjunto pendente diverge da migration exata."
    );
  }
  return Object.freeze({
    appliedVersions: Object.freeze([...appliedVersions]),
    observedPending: Object.freeze([...observedPending]),
    status
  });
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

function assertMigrationTarget(target, env = process.env) {
  if (!target) {
    postgresFail(
      "migration_target_not_verified",
      "Destino da migration nao foi confirmado."
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

function assertExactDisposableTarget(target) {
  const environment = String(target?.environment || "").toLowerCase();
  const host = String(target?.host || "").toLowerCase();
  const database = String(target?.database || "");
  const loopbackHost = new Set(["localhost", "127.0.0.1", "::1"]).has(host);
  if (
    !["local", "test"].includes(environment) ||
    !loopbackHost ||
    !/^ia4tube_social_test_[a-z0-9_]+$/.test(database) ||
    /(^|[-_.])(prod|production|stage|staging|live|main)([-_.]|$)/i.test(
      database
    )
  ) {
    postgresFail(
      "migration_exact_target_not_disposable",
      "Modo exato permitido somente em PostgreSQL descartavel local."
    );
  }
}

function stagingExactApprovalValue(packageDigest, recoveryEvidenceDigest) {
  return [
    STAGING_EXACT_APPROVAL_PREFIX,
    PAID_STAGING_PUBLIC_TARGET.environmentId,
    STAGING_EXACT_0004_SQL_SHA256,
    recoveryEvidenceDigest,
    packageDigest
  ].join(":");
}

function assertExactStagingTarget(target, request) {
  const expected = PAID_STAGING_PUBLIC_TARGET;
  if (
    String(target?.environment || "").toLowerCase() !== "staging" ||
    String(target?.environmentId || "").toLowerCase() !==
      expected.environmentId ||
    String(target?.host || "").toLowerCase() !== expected.host ||
    String(target?.port || "5432") !== expected.port ||
    String(target?.database || "") !== expected.database ||
    String(target?.username || "").toLowerCase() !==
      expected.migrationLogin ||
    String(target?.productionApproval || "") !== ""
  ) {
    postgresFail(
      "migration_staging_exact_target_mismatch",
      "Destino staging da migration exata diverge."
    );
  }
  if (
    request.stagingApproval !== stagingExactApprovalValue(
      request.executionPackageDigest,
      request.recoveryEvidenceDigest
    )
  ) {
    postgresFail(
      "migration_staging_exact_approval_invalid",
      "Aprovacao staging da migration exata recusada."
    );
  }
}

function assertCanonicalStagingExactManifest(local) {
  if (
    !Array.isArray(local) ||
    local.length !== EXACT_TARGET_MIGRATIONS.length ||
    local.some(
      (migration, index) =>
        migration.version !== EXACT_TARGET_MIGRATIONS[index]
    )
  ) {
    postgresFail(
      "migration_staging_exact_manifest_mismatch",
      "Manifesto da migration exata staging diverge."
    );
  }
  const migration = local.find(
    (entry) => entry.version === SOCIAL_CONNECTOR_PERSISTENCE_MIGRATION
  );
  if (!migration || migration.sha256 !== STAGING_EXACT_0004_SQL_SHA256) {
    postgresFail(
      "migration_staging_exact_0004_pin_mismatch",
      "Pin independente da migration 0004 diverge."
    );
  }
}

function validateStagingExactMigrationRequest(request) {
  const exact = validateExactMigrationRequest(request, {
    requireRecovery: true
  });
  const shaFields = [
    "executionPackageDigest",
    "recoveryEvidenceDigest",
    "beforeCatalogSha256",
    "afterCatalogSha256"
  ];
  if (
    shaFields.some(
      (field) => !/^[0-9a-f]{64}$/.test(String(request[field] || ""))
    ) ||
    request.migrationSha256 !== STAGING_EXACT_0004_SQL_SHA256 ||
    request.recoveryStatus !== "AVAILABLE" ||
    request.recoveryConcurrentOperation !== "NONE" ||
    request.renderWebServiceId !== STAGING_EXACT_WEB_SERVICE_ID ||
    request.renderDatabaseServiceId !== STAGING_EXACT_DATABASE_SERVICE_ID ||
    request.databaseMarkerUuid !== PAID_STAGING_PUBLIC_TARGET.environmentId ||
    request.recoveryEvidenceExternallyVerified !== undefined
  ) {
    postgresFail(
      "migration_staging_exact_request_invalid",
      "Contrato staging da migration exata recusado."
    );
  }
  return Object.freeze({
    ...exact,
    migrationSha256: STAGING_EXACT_0004_SQL_SHA256,
    executionPackageDigest: request.executionPackageDigest,
    recoveryEvidenceDigest: request.recoveryEvidenceDigest,
    beforeCatalogSha256: request.beforeCatalogSha256,
    afterCatalogSha256: request.afterCatalogSha256,
    recoveryStatus: "AVAILABLE",
    recoveryConcurrentOperation: "NONE",
    renderWebServiceId: STAGING_EXACT_WEB_SERVICE_ID,
    renderDatabaseServiceId: STAGING_EXACT_DATABASE_SERVICE_ID,
    databaseMarkerUuid: PAID_STAGING_PUBLIC_TARGET.environmentId,
    stagingApproval: request.stagingApproval
  });
}

function assertApplyTarget(target, env = process.env) {
  if (!target || target.approval !== APPLY_APPROVAL) {
    postgresFail(
      "migration_apply_not_approved",
      "Aplicacao de migrations nao autorizada."
    );
  }
  return assertMigrationTarget(target, env);
}

async function readTargetMarker(client) {
  return client.query(
    [
      "SELECT environment_id::text, environment_name",
      "FROM ia4tube_migrations.environment_identity",
      "WHERE singleton = TRUE"
    ].join("\n")
  );
}

function assertTargetMarker(result, target) {
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

async function verifyTargetMarker(client, migratorRole, target) {
  const result = await withRoleTransaction(client, migratorRole, () =>
    readTargetMarker(client)
  );
  assertTargetMarker(result, target);
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
    if (!operationError?.skipAdvisoryUnlock) {
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
        failure.applied = operationError?.applied;
        failure.outcomeUnknown = operationError?.outcomeUnknown;
        failure.retryAllowed = operationError?.retryAllowed;
        failure.requiresReadOnlyInspection =
          operationError?.requiresReadOnlyInspection;
        failure.cause = operationError || error;
        throw failure;
      }
      if (unlocked !== true) {
        const failure = new Error("migration_advisory_unlock_not_owned");
        failure.code = "migration_advisory_unlock_not_owned";
        failure.discardClient = true;
        failure.applied = operationError?.applied;
        failure.outcomeUnknown = operationError?.outcomeUnknown;
        failure.retryAllowed = operationError?.retryAllowed;
        failure.requiresReadOnlyInspection =
          operationError?.requiresReadOnlyInspection;
        failure.cause = operationError;
        throw failure;
      }
    }
  }
}

async function applyOne(client, migration, ownerRole) {
  const started = process.hrtime.bigint();
  await client.query("BEGIN");
  try {
    await client.query(`SET LOCAL ROLE ${quoteIdentifier(ownerRole)}`);
    if (migration.version === GLOBAL_VAULT_REGISTRY_MIGRATION) {
      await client.query(GLOBAL_VAULT_BACKFILL_POLICY_CREATE);
    }
    await client.query(migration.sql);
    if (migration.version === GLOBAL_VAULT_REGISTRY_MIGRATION) {
      await client.query(GLOBAL_VAULT_BACKFILL_POLICY_DROP);
    }
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

async function rollbackExactTransaction(client, cause) {
  try {
    await client.query("ROLLBACK");
    } catch (rollbackError) {
      rollbackError.code = "migration_exact_rollback_failed";
      rollbackError.discardClient = true;
      rollbackError.skipAdvisoryUnlock = true;
      rollbackError.cause = cause;
      throw rollbackError;
  }
}

async function runExactReadOnlyTransaction(client, operation) {
  await client.query(
    "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"
  );
  let rollbackAttempted = false;
  try {
    const result = await operation();
    rollbackAttempted = true;
    try {
      await client.query("ROLLBACK");
    } catch (error) {
      error.code = "migration_exact_rollback_failed";
      error.discardClient = true;
      error.skipAdvisoryUnlock = true;
      throw error;
    }
    return result;
  } catch (error) {
    if (!rollbackAttempted) {
      await rollbackExactTransaction(client, error);
    }
    throw error;
  }
}

async function exactGateWithinTransaction(
  client,
  local,
  profile,
  migratorRole,
  ownerRole,
  target
) {
  await verifyMigrationSession(client, migratorRole, ownerRole);
  await verifyMigrationInfrastructure(client, migratorRole, ownerRole);
  await client.query(`SET LOCAL ROLE ${quoteIdentifier(migratorRole)}`);
  assertTargetMarker(await readTargetMarker(client), target);
  await verifyExistingLedgerContract(client, ownerRole, migratorRole);
  const migrationState = exactMigrationState(
    local,
    await readAppliedMigrations(client),
    profile
  );
  const physical = await verifySocialPhysicalProfile(
    client,
    profile,
    ownerRole,
    SOCIAL_RUNTIME_ROLE
  );
  return Object.freeze({ migrationState, physical });
}

async function stagingExactGateWithinTransaction(
  client,
  local,
  profile,
  migratorRole,
  ownerRole,
  target,
  expectedCatalogDigest
) {
  const gate = await exactGateWithinTransaction(
    client,
    local,
    profile,
    migratorRole,
    ownerRole,
    target
  );
  const catalog = await verifyStagingExactCatalogSnapshot(
    client,
    expectedCatalogDigest
  );
  return Object.freeze({
    migrationState: gate.migrationState,
    physical: gate.physical,
    catalog
  });
}

async function applyExactWithinTransaction(
  client,
  local,
  migratorRole,
  ownerRole,
  target
) {
  await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ");
  let commitAttempted = false;
  try {
    const before = await exactGateWithinTransaction(
      client,
      local,
      EXACT_FROM_PROFILE,
      migratorRole,
      ownerRole,
      target
    );
    const migration = local.find(
      (entry) => entry.version === SOCIAL_CONNECTOR_PERSISTENCE_MIGRATION
    );
    if (!migration) {
      postgresFail(
        "migration_exact_manifest_mismatch",
        "Migration exata nao consta no manifesto autenticado."
      );
    }

    await client.query(`SET LOCAL ROLE ${quoteIdentifier(ownerRole)}`);
    const started = process.hrtime.bigint();
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

    await client.query(`SET LOCAL ROLE ${quoteIdentifier(migratorRole)}`);
    await verifyExistingLedgerContract(client, ownerRole, migratorRole);
    const after = exactMigrationState(
      local,
      await readAppliedMigrations(client),
      EXACT_TO_PROFILE
    );
    const physical = await verifySocialPhysicalProfile(
      client,
      EXACT_TO_PROFILE,
      ownerRole,
      SOCIAL_RUNTIME_ROLE
    );

    commitAttempted = true;
    try {
      await client.query("COMMIT");
    } catch (error) {
      const failure = new Error("migration_exact_commit_outcome_unknown");
      failure.code = "migration_exact_commit_outcome_unknown";
      failure.discardClient = true;
      failure.skipAdvisoryUnlock = true;
      failure.outcomeUnknown = true;
      failure.retryAllowed = false;
      failure.requiresReadOnlyInspection = true;
      failure.cause = error;
      throw failure;
    }
    return Object.freeze({ before, after, physical });
  } catch (error) {
    if (commitAttempted) throw error;
    await rollbackExactTransaction(client, error);
    throw error;
  }
}

async function applyStagingExactWithinTransaction(
  client,
  local,
  migratorRole,
  ownerRole,
  target,
  request
) {
  await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ");
  let commitAttempted = false;
  try {
    const before = await stagingExactGateWithinTransaction(
      client,
      local,
      EXACT_FROM_PROFILE,
      migratorRole,
      ownerRole,
      target,
      request.beforeCatalogSha256
    );
    const migration = local.find(
      (entry) => entry.version === SOCIAL_CONNECTOR_PERSISTENCE_MIGRATION
    );
    if (
      !migration ||
      migration.sha256 !== STAGING_EXACT_0004_SQL_SHA256
    ) {
      postgresFail(
        "migration_staging_exact_0004_pin_mismatch",
        "Pin independente da migration 0004 diverge."
      );
    }

    await client.query(`SET LOCAL ROLE ${quoteIdentifier(ownerRole)}`);
    const started = process.hrtime.bigint();
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

    await client.query(`SET LOCAL ROLE ${quoteIdentifier(migratorRole)}`);
    const after = await stagingExactGateWithinTransaction(
      client,
      local,
      EXACT_TO_PROFILE,
      migratorRole,
      ownerRole,
      target,
      request.afterCatalogSha256
    );

    commitAttempted = true;
    try {
      await client.query("COMMIT");
    } catch (error) {
      const failure = new Error("migration_exact_commit_outcome_unknown");
      failure.code = "migration_exact_commit_outcome_unknown";
      failure.discardClient = true;
      failure.skipAdvisoryUnlock = true;
      failure.outcomeUnknown = true;
      failure.retryAllowed = false;
      failure.requiresReadOnlyInspection = true;
      failure.cause = error;
      throw failure;
    }
    return Object.freeze({ before, after });
  } catch (error) {
    if (commitAttempted) throw error;
    await rollbackExactTransaction(client, error);
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

  async function planExact(request, env = process.env) {
    const exactRequest = validateExactMigrationRequest(request);
    assertMigrationTarget(target, env);
    assertExactDisposableTarget(target);
    const local = readManifest(manifestOptions);
    const client = await pool.connect();
    let releaseError;
    try {
      await verifyMigrationSession(client, migratorRole, ownerRole);
      await verifyMigrationInfrastructure(client, migratorRole, ownerRole);
      const gate = await withAdvisoryLock(client, () =>
        runExactReadOnlyTransaction(client, () =>
          exactGateWithinTransaction(
            client,
            local,
            EXACT_FROM_PROFILE,
            migratorRole,
            ownerRole,
            target
          )
        )
      );
      return Object.freeze({
        fromProfile: gate.physical.profile,
        toProfile: exactRequest.toProfile,
        expectedPending: Object.freeze([...exactRequest.expectedPending]),
        observedPending: Object.freeze([
          ...gate.migrationState.observedPending
        ]),
        planApproved: true
      });
    } catch (error) {
      if (error?.discardClient) releaseError = error;
      throw error;
    } finally {
      client.release(releaseError);
    }
  }

  async function applyExact(request, env = process.env) {
    const exactRequest = validateExactMigrationRequest(request, {
      requireRecovery: true
    });
    assertApplyTarget(target, env);
    assertExactDisposableTarget(target);
    const local = readManifest(manifestOptions);
    const client = await pool.connect();
    let releaseError;
    let commitCompleted = false;
    try {
      await verifyMigrationSession(client, migratorRole, ownerRole);
      await verifyMigrationInfrastructure(client, migratorRole, ownerRole);
      const applied = await withAdvisoryLock(client, async () => {
        const transaction = await applyExactWithinTransaction(
          client,
          local,
          migratorRole,
          ownerRole,
          target
        );
        commitCompleted = true;
        let finalGate;
        try {
          finalGate = await runExactReadOnlyTransaction(client, () =>
            exactGateWithinTransaction(
              client,
              local,
              EXACT_TO_PROFILE,
              migratorRole,
              ownerRole,
              target
            )
          );
        } catch (error) {
          const failure = new Error(
            "migration_exact_postcommit_validation_failed"
          );
          failure.code = "migration_exact_postcommit_validation_failed";
          failure.applied = true;
          failure.retryAllowed = false;
          failure.requiresReadOnlyInspection = true;
          failure.discardClient = Boolean(error?.discardClient);
          failure.skipAdvisoryUnlock = Boolean(
            error?.discardClient || error?.skipAdvisoryUnlock
          );
          failure.cause = error;
          throw failure;
        }
        return Object.freeze({ transaction, finalGate });
      });
      return Object.freeze({
        fromProfile: exactRequest.fromProfile,
        toProfile: exactRequest.toProfile,
        expectedPending: Object.freeze([...exactRequest.expectedPending]),
        observedPending: Object.freeze([
          ...applied.transaction.before.migrationState.observedPending
        ]),
        appliedMigration: SOCIAL_CONNECTOR_PERSISTENCE_MIGRATION,
        finalProfile: applied.finalGate.physical.profile,
        postCommitValidated: true,
        recoveryReferenceDigest: sha256(exactRequest.recoveryReference),
        recoveryCapturedAt: exactRequest.recoveryCapturedAt,
        recoveryEvidenceExternallyVerified: false
      });
    } catch (error) {
      if (commitCompleted) {
        error.applied = true;
        error.retryAllowed = false;
        error.requiresReadOnlyInspection = true;
      }
      if (error?.discardClient) releaseError = error;
      throw error;
    } finally {
      client.release(releaseError);
    }
  }

  async function planStagingExact(request, env = process.env) {
    const exactRequest = validateStagingExactMigrationRequest(request);
    assertMigrationTarget(target, env);
    assertExactStagingTarget(target, exactRequest);
    const local = readManifest(manifestOptions);
    assertCanonicalStagingExactManifest(local);
    const client = await pool.connect();
    let releaseError;
    try {
      await verifyMigrationSession(client, migratorRole, ownerRole);
      await verifyMigrationInfrastructure(client, migratorRole, ownerRole);
      const gate = await withAdvisoryLock(client, () =>
        runExactReadOnlyTransaction(client, () =>
          stagingExactGateWithinTransaction(
            client,
            local,
            EXACT_FROM_PROFILE,
            migratorRole,
            ownerRole,
            target,
            exactRequest.beforeCatalogSha256
          )
        )
      );
      return Object.freeze({
        fromProfile: gate.physical.profile,
        toProfile: exactRequest.toProfile,
        expectedPending: Object.freeze([...exactRequest.expectedPending]),
        observedPending: Object.freeze([
          ...gate.migrationState.observedPending
        ]),
        beforeCatalogSha256: gate.catalog.sha256,
        migrationSha256: exactRequest.migrationSha256,
        executionPackageDigest: exactRequest.executionPackageDigest,
        recoveryEvidenceDigest: exactRequest.recoveryEvidenceDigest,
        planApproved: true,
        readOnly: true
      });
    } catch (error) {
      if (error?.discardClient) releaseError = error;
      throw error;
    } finally {
      client.release(releaseError);
    }
  }

  async function applyStagingExact(request, env = process.env) {
    const exactRequest = validateStagingExactMigrationRequest(request);
    assertApplyTarget(target, env);
    assertExactStagingTarget(target, exactRequest);
    const preflight = await planStagingExact(exactRequest, env);
    const local = readManifest(manifestOptions);
    assertCanonicalStagingExactManifest(local);
    const client = await pool.connect();
    let releaseError;
    let commitCompleted = false;
    try {
      await verifyMigrationSession(client, migratorRole, ownerRole);
      await verifyMigrationInfrastructure(client, migratorRole, ownerRole);
      const applied = await withAdvisoryLock(client, async () => {
        const transaction = await applyStagingExactWithinTransaction(
          client,
          local,
          migratorRole,
          ownerRole,
          target,
          exactRequest
        );
        commitCompleted = true;
        let finalGate;
        try {
          finalGate = await runExactReadOnlyTransaction(client, () =>
            stagingExactGateWithinTransaction(
              client,
              local,
              EXACT_TO_PROFILE,
              migratorRole,
              ownerRole,
              target,
              exactRequest.afterCatalogSha256
            )
          );
        } catch (error) {
          const failure = new Error(
            "migration_exact_postcommit_validation_failed"
          );
          failure.code = "migration_exact_postcommit_validation_failed";
          failure.applied = true;
          failure.retryAllowed = false;
          failure.requiresReadOnlyInspection = true;
          failure.discardClient = Boolean(error?.discardClient);
          failure.skipAdvisoryUnlock = Boolean(
            error?.discardClient || error?.skipAdvisoryUnlock
          );
          failure.cause = error;
          throw failure;
        }
        return Object.freeze({ transaction, finalGate });
      });
      return Object.freeze({
        fromProfile: exactRequest.fromProfile,
        toProfile: exactRequest.toProfile,
        expectedPending: Object.freeze([...exactRequest.expectedPending]),
        observedPending: Object.freeze([
          ...applied.transaction.before.migrationState.observedPending
        ]),
        appliedMigration: SOCIAL_CONNECTOR_PERSISTENCE_MIGRATION,
        finalProfile: applied.finalGate.physical.profile,
        finalCatalogSha256: applied.finalGate.catalog.sha256,
        postCommitValidated: true,
        recoveryReferenceDigest: sha256(exactRequest.recoveryReference),
        recoveryCapturedAt: exactRequest.recoveryCapturedAt,
        recoveryEvidenceDigest: exactRequest.recoveryEvidenceDigest,
        recoveryEvidenceExternallyVerified: false,
        recoveryEvidencePackageBound: true,
        executionPackageDigest: exactRequest.executionPackageDigest,
        preflightCatalogSha256: preflight.beforeCatalogSha256,
        retryAllowed: false
      });
    } catch (error) {
      if (commitCompleted) {
        error.applied = true;
        error.retryAllowed = false;
        error.requiresReadOnlyInspection = true;
      }
      if (error?.discardClient) releaseError = error;
      throw error;
    } finally {
      client.release(releaseError);
    }
  }

  return Object.freeze({
    apply,
    applyExact,
    applyStagingExact,
    inspect,
    planExact,
    planStagingExact,
    validate
  });
}

module.exports = {
  ADVISORY_LOCK_ID,
  APPLY_APPROVAL,
  EXACT_BASE_MIGRATIONS,
  EXACT_BASE_TABLES,
  EXACT_CONNECTOR_TABLES,
  EXACT_FROM_PROFILE,
  EXACT_PENDING_MIGRATIONS,
  EXACT_TARGET_MIGRATIONS,
  EXACT_TO_PROFILE,
  GLOBAL_VAULT_BACKFILL_POLICY,
  GLOBAL_VAULT_BACKFILL_POLICY_CREATE,
  GLOBAL_VAULT_BACKFILL_POLICY_DROP,
  GLOBAL_VAULT_REGISTRY_MIGRATION,
  SOCIAL_CONNECTOR_PERSISTENCE_MIGRATION,
  STAGING_EXACT_0004_SQL_SHA256,
  STAGING_EXACT_APPROVAL_PREFIX,
  STAGING_EXACT_DATABASE_SERVICE_ID,
  STAGING_EXACT_WEB_SERVICE_ID,
  LEDGER_NAME,
  MIGRATION_FILE_PATTERN,
  PRODUCTION_APPROVAL,
  assertApplyTarget,
  assertExactDisposableTarget,
  assertExactStagingTarget,
  assertCanonicalStagingExactManifest,
  assertMigrationTarget,
  assertNonDestructiveSql,
  compareMigrationState,
  createMigrationRunner,
  exactMigrationState,
  readStagingExactCatalogSnapshot,
  readManifest,
  readMigrationState,
  sha256,
  stagingExactApprovalValue,
  stagingExactCatalogDigest,
  targetFingerprint,
  verifyMigrationInfrastructure,
  verifyExistingLedgerContract,
  verifyMigrationSession,
  verifySocialPhysicalProfile,
  verifyTargetMarker,
  validateExactMigrationRequest,
  validateStagingExactMigrationRequest,
  verifyStagingExactCatalogSnapshot,
  withRoleTransaction
};
