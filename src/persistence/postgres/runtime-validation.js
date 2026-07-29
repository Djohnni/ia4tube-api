"use strict";

const { postgresFail } = require("./errors");
const { readManifest } = require("./migrations");
const { withTransaction } = require("./pool");
const { requireSafeLabel } = require("./validation");

const SOCIAL_SCHEMA = "ia4tube_social";
const SOCIAL_ADMIN_SCHEMA = "ia4tube_social_admin";
const SOCIAL_OWNER_ROLE = "ia4tube_social_owner";
const RUNTIME_CONTRACT_VIEW = "runtime_schema_contract";
const VAULT_KEY_REGISTRY = "vault_key_versions";
const TENANT_TABLES = Object.freeze([
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
const TENANT_POLICIES = Object.freeze(
  Object.fromEntries(
    TENANT_TABLES.map((table) => [table, `${table}_company_scope`])
  )
);
const TENANT_SCOPE_COLUMNS = Object.freeze(
  Object.fromEntries(
    TENANT_TABLES.map((table) => [
      table,
      table === "companies" ? "id" : "company_id"
    ])
  )
);
const RUNTIME_TABLE_GRANTS = Object.freeze({
  runtime_schema_contract: ["SELECT"],
  social_connections: ["INSERT", "SELECT"],
  social_external_accounts: ["INSERT", "SELECT"],
  social_destinations: ["INSERT", "SELECT"],
  social_connection_scopes: ["DELETE", "INSERT", "SELECT"],
  social_oauth_transactions: ["INSERT", "SELECT"],
  social_encrypted_credentials: ["INSERT", "SELECT"],
  social_reauth_grants: ["INSERT", "SELECT"],
  social_audit_events: ["INSERT", "SELECT"]
});
const RUNTIME_COLUMN_GRANTS = Object.freeze({
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
    cancelled_at: ["UPDATE"]
  },
  social_encrypted_credentials: {
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
  }
});

function validateContractRows(rows, local) {
  if (!Array.isArray(rows) || rows.length !== local.length) {
    postgresFail(
      "postgres_schema_contract_mismatch",
      "Contrato PostgreSQL social divergente."
    );
  }
  const applied = new Map(
    rows.map((row) => [row.version, row.checksum_sha256])
  );
  for (const migration of local) {
    if (applied.get(migration.version) !== migration.sha256) {
      postgresFail(
        "postgres_schema_contract_mismatch",
        "Contrato PostgreSQL social divergente."
      );
    }
  }
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

function exactSetMatches(actual, expected) {
  if (actual.size !== expected.size) return false;
  for (const value of expected) {
    if (!actual.has(value)) return false;
  }
  return true;
}

function expectedTableGrantSet(role, ownerRole) {
  const expected = new Set();
  for (const [table, privileges] of Object.entries(
    RUNTIME_TABLE_GRANTS
  )) {
    for (const privilege of privileges) {
      expected.add(
        `${role}|${table}|${privilege}|false|${ownerRole}`
      );
    }
  }
  return expected;
}

function expectedColumnGrantSet(role, ownerRole) {
  const expected = new Set();
  for (const [table, columns] of Object.entries(
    RUNTIME_COLUMN_GRANTS
  )) {
    for (const [column, privileges] of Object.entries(columns)) {
      for (const privilege of privileges) {
        expected.add(
          `${role}|${table}|${column}|${privilege}|false|` +
            ownerRole
        );
      }
    }
  }
  return expected;
}

async function verifyVaultKeyRegistryBoundary(
  client,
  runtimeRole,
  ownerRole
) {
  const result = await client.query(
    [
      "SELECT",
      "  schema_owner.rolname AS schema_owner,",
      "  registry.relkind AS registry_kind,",
      "  registry_owner.rolname AS registry_owner,",
      "  registry.relrowsecurity AS registry_rls,",
      "  registry.relforcerowsecurity AS registry_force_rls,",
      "  (",
      "    SELECT COUNT(*)::integer",
      "    FROM pg_catalog.pg_policy policy",
      "    WHERE policy.polrelid = registry.oid",
      "  ) AS registry_policy_count,",
      "  (",
      "    SELECT COUNT(*)::integer",
      "    FROM pg_catalog.pg_constraint primary_key",
      "    WHERE primary_key.conrelid = registry.oid",
      "      AND primary_key.contype = 'p'",
      "      AND primary_key.conkey = ARRAY[(",
      "        SELECT attribute.attnum",
      "        FROM pg_catalog.pg_attribute attribute",
      "        WHERE attribute.attrelid = registry.oid",
      "          AND attribute.attname = 'key_version'",
      "          AND NOT attribute.attisdropped",
      "      )]::smallint[]",
      "  ) AS registry_primary_key_count,",
      "  (",
      "    SELECT COUNT(*)::integer",
      "    FROM pg_catalog.pg_constraint foreign_key",
      "    WHERE foreign_key.conname =",
      "      'social_encrypted_credentials_key_version_fk'",
      "      AND foreign_key.contype = 'f'",
      "      AND foreign_key.conrelid = credentials.oid",
      "      AND foreign_key.confrelid = registry.oid",
      "      AND foreign_key.conkey = ARRAY[(",
      "        SELECT attribute.attnum",
      "        FROM pg_catalog.pg_attribute attribute",
      "        WHERE attribute.attrelid = credentials.oid",
      "          AND attribute.attname = 'key_version'",
      "          AND NOT attribute.attisdropped",
      "      )]::smallint[]",
      "      AND foreign_key.confkey = ARRAY[(",
      "        SELECT attribute.attnum",
      "        FROM pg_catalog.pg_attribute attribute",
      "        WHERE attribute.attrelid = registry.oid",
      "          AND attribute.attname = 'key_version'",
      "          AND NOT attribute.attisdropped",
      "      )]::smallint[]",
      "      AND foreign_key.confupdtype = 'r'",
      "      AND foreign_key.confdeltype = 'r'",
      "      AND foreign_key.convalidated",
      "      AND NOT foreign_key.condeferrable",
      "  ) AS vault_registry_fk_count,",
      "  (",
      "    SELECT COUNT(*)::integer",
      "    FROM pg_catalog.aclexplode(",
      "      COALESCE(admin_schema.nspacl,",
      "        pg_catalog.acldefault('n', admin_schema.nspowner))",
      "    ) expanded_acl",
      "    WHERE expanded_acl.grantee <> admin_schema.nspowner",
      "  ) AS schema_non_owner_acl_count,",
      "  (",
      "    SELECT COUNT(*)::integer",
      "    FROM pg_catalog.aclexplode(",
      "      COALESCE(registry.relacl,",
      "        pg_catalog.acldefault('r', registry.relowner))",
      "    ) expanded_acl",
      "    WHERE expanded_acl.grantee <> registry.relowner",
      "  ) AS table_non_owner_acl_count,",
      "  NOT pg_catalog.has_schema_privilege(",
      "    $1, admin_schema.oid, 'USAGE'",
      "  ) AS runtime_usage_absent,",
      "  NOT pg_catalog.has_schema_privilege(",
      "    $1, admin_schema.oid, 'CREATE'",
      "  ) AS runtime_create_absent",
      "FROM pg_catalog.pg_namespace admin_schema",
      "JOIN pg_catalog.pg_roles schema_owner",
      "  ON schema_owner.oid = admin_schema.nspowner",
      "JOIN pg_catalog.pg_class registry",
      "  ON registry.relnamespace = admin_schema.oid",
      "  AND registry.relname = 'vault_key_versions'",
      "JOIN pg_catalog.pg_roles registry_owner",
      "  ON registry_owner.oid = registry.relowner",
      "JOIN pg_catalog.pg_namespace social_schema",
      "  ON social_schema.nspname = 'ia4tube_social'",
      "JOIN pg_catalog.pg_class credentials",
      "  ON credentials.relnamespace = social_schema.oid",
      "  AND credentials.relname = 'social_encrypted_credentials'",
      "WHERE admin_schema.nspname = 'ia4tube_social_admin'"
    ].join("\n"),
    [runtimeRole]
  );
  const row = result.rows?.[0];
  if (
    result.rowCount !== 1 ||
    row.schema_owner !== ownerRole ||
    row.registry_kind !== "r" ||
    row.registry_owner !== ownerRole ||
    row.registry_rls ||
    row.registry_force_rls ||
    Number(row.registry_policy_count) !== 0 ||
    Number(row.registry_primary_key_count) !== 1 ||
    Number(row.vault_registry_fk_count) !== 1 ||
    Number(row.schema_non_owner_acl_count) !== 0 ||
    Number(row.table_non_owner_acl_count) !== 0 ||
    !row.runtime_usage_absent ||
    !row.runtime_create_absent
  ) {
    postgresFail(
      "postgres_vault_key_registry_unsafe",
      "Registro global de chaves do cofre divergente."
    );
  }
}

async function verifyRuntimeSchema(pool, role, options = {}) {
  const local = readManifest(options.manifestOptions);
  const runtimeRole = requireSafeLabel(role, "postgres_role");
  const ownerRole = requireSafeLabel(
    options.ownerRole || SOCIAL_OWNER_ROLE,
    "postgres_owner_role"
  );
  return withTransaction(
    pool,
    async (client) => {
      const schema = await client.query(
        [
          "SELECT owner.rolname AS owner_name",
          "FROM pg_catalog.pg_namespace namespace",
          "JOIN pg_catalog.pg_roles owner",
          "  ON owner.oid = namespace.nspowner",
          "WHERE namespace.nspname = 'ia4tube_social'"
        ].join("\n")
      );
      if (
        schema.rowCount !== 1 ||
        schema.rows?.[0]?.owner_name !== ownerRole
      ) {
        postgresFail(
          "postgres_schema_owner_mismatch",
          "Proprietario do schema social divergente."
        );
      }

      await verifyVaultKeyRegistryBoundary(
        client,
        runtimeRole,
        ownerRole
      );

      const relations = await client.query(
        [
          "SELECT relation.relname,",
          "  relation.relkind AS object_kind,",
          "  owner.rolname AS owner_name",
          "FROM pg_catalog.pg_class relation",
          "JOIN pg_catalog.pg_namespace namespace",
          "  ON namespace.oid = relation.relnamespace",
          "JOIN pg_catalog.pg_roles owner",
          "  ON owner.oid = relation.relowner",
          "WHERE namespace.nspname = 'ia4tube_social'",
          "  AND relation.relkind IN ('r', 'p', 'v', 'm', 'S')",
          "ORDER BY relation.relname"
        ].join("\n")
      );
      const expectedRelations = new Map([
        ...TENANT_TABLES.map((table) => [table, "r"]),
        [RUNTIME_CONTRACT_VIEW, "v"]
      ]);
      if (
        relations.rows?.length !== expectedRelations.size ||
        relations.rows.some(
          (entry) =>
            expectedRelations.get(entry.relname) !== entry.object_kind ||
            entry.owner_name !== ownerRole
        )
      ) {
        postgresFail(
          "postgres_relation_owner_mismatch",
          "Proprietarios dos objetos sociais divergentes."
        );
      }

      const routines = await client.query(
        [
          "SELECT COUNT(*)::integer AS routine_count",
          "FROM pg_catalog.pg_proc routine",
          "JOIN pg_catalog.pg_namespace namespace",
          "  ON namespace.oid = routine.pronamespace",
          "WHERE namespace.nspname = 'ia4tube_social'"
        ].join("\n")
      );
      if (Number(routines.rows?.[0]?.routine_count) !== 0) {
        postgresFail(
          "postgres_routine_contract_mismatch",
          "Rotinas PostgreSQL sociais inesperadas."
        );
      }

      const contract = await client.query(
        [
          "SELECT version, checksum_sha256",
          "FROM ia4tube_social.runtime_schema_contract",
          "ORDER BY version"
        ].join("\n")
      );
      validateContractRows(contract.rows, local);

      const tables = await client.query(
        [
          "SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,",
          "  COUNT(policy.policyname)::integer AS policy_count",
          "FROM pg_catalog.pg_class c",
          "JOIN pg_catalog.pg_namespace namespace",
          "  ON namespace.oid = c.relnamespace",
          "LEFT JOIN pg_catalog.pg_policies policy",
          "  ON policy.schemaname = namespace.nspname",
          "  AND policy.tablename = c.relname",
          "WHERE namespace.nspname = 'ia4tube_social'",
          "  AND c.relkind IN ('r', 'p')",
          "GROUP BY c.relname, c.relrowsecurity, c.relforcerowsecurity",
          "ORDER BY c.relname"
        ].join("\n")
      );
      const tableNames = (tables.rows || [])
        .map((row) => row.relname)
        .sort();
      if (
        tables.rows?.length !== TENANT_TABLES.length ||
        tableNames.some(
          (table, index) => table !== [...TENANT_TABLES].sort()[index]
        ) ||
        tables.rows.some(
          (row) =>
            !row.relrowsecurity ||
            !row.relforcerowsecurity ||
            Number(row.policy_count) < 1
        )
      ) {
        postgresFail(
          "postgres_rls_contract_mismatch",
          "Contrato RLS social divergente."
        );
      }

      const policies = await client.query(
        [
          "SELECT tablename, policyname, permissive, roles, cmd,",
          "  qual, with_check",
          "FROM pg_catalog.pg_policies",
          "WHERE schemaname = 'ia4tube_social'",
          "  AND tablename = ANY($1::text[])",
          "ORDER BY tablename, policyname"
        ].join("\n"),
        [TENANT_TABLES]
      );
      const policyByTable = new Map();
      for (const policy of policies.rows || []) {
        if (policyByTable.has(policy.tablename)) {
          postgresFail(
            "postgres_rls_contract_mismatch",
            "Contrato RLS social divergente."
          );
        }
        policyByTable.set(policy.tablename, policy);
      }
      for (const table of TENANT_TABLES) {
        const policy = policyByTable.get(table);
        const scopeColumn = TENANT_SCOPE_COLUMNS[table];
        const qualifier = canonicalPolicyExpression(policy?.qual);
        const check = canonicalPolicyExpression(policy?.with_check);
        const expectedExpression = expectedPolicyExpression(scopeColumn);
        const policyRoles = Array.isArray(policy?.roles)
          ? policy.roles.map((item) => String(item).toLowerCase())
          : String(policy?.roles || "").toLowerCase() === "{public}"
            ? ["public"]
            : [];
        if (
          !policy ||
          policy.policyname !== TENANT_POLICIES[table] ||
          policy.permissive !== "PERMISSIVE" ||
          policyRoles.length !== 1 ||
          policyRoles[0] !== "public" ||
          policy.cmd !== "ALL" ||
          qualifier !== expectedExpression ||
          check !== expectedExpression
        ) {
          postgresFail(
            "postgres_rls_contract_mismatch",
            "Contrato RLS social divergente."
          );
        }
      }

      const schemaAclRows = await client.query(
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
          "WHERE namespace.nspname = 'ia4tube_social'",
          "  AND expanded_acl.grantee <> namespace.nspowner",
          "ORDER BY grantee, expanded_acl.privilege_type"
        ].join("\n")
      );
      const actualSchemaGrants = new Set(
        (schemaAclRows.rows || []).map(
          (entry) =>
            `${String(entry.grantee).toLowerCase()}|` +
            `${String(entry.privilege_type).toUpperCase()}|` +
            `${Boolean(entry.is_grantable)}|` +
            String(entry.grantor_name).toLowerCase()
        )
      );
      if (
        !exactSetMatches(
          actualSchemaGrants,
          new Set([`${runtimeRole}|USAGE|false|${ownerRole}`])
        )
      ) {
        postgresFail(
          "postgres_runtime_grants_unsafe",
          "Privilegios PostgreSQL de runtime divergentes."
        );
      }

      const tableAclRows = await client.query(
        [
          "SELECT",
          "  COALESCE(grantee.rolname, 'PUBLIC') AS grantee,",
          "  relation.relname AS table_name,",
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
          "WHERE namespace.nspname = 'ia4tube_social'",
          "  AND relation.relkind IN ('r', 'p', 'v')",
          "  AND expanded_acl.grantee <> relation.relowner",
          "ORDER BY grantee, table_name, expanded_acl.privilege_type"
        ].join("\n")
      );
      const actualTableGrants = new Set(
        (tableAclRows.rows || []).map(
          (entry) =>
            `${String(entry.grantee).toLowerCase()}|` +
            `${entry.table_name}|${String(
              entry.privilege_type
            ).toUpperCase()}|${Boolean(entry.is_grantable)}|` +
            String(entry.grantor_name).toLowerCase()
        )
      );
      if (
        !exactSetMatches(
          actualTableGrants,
          expectedTableGrantSet(runtimeRole, ownerRole)
        )
      ) {
        postgresFail(
          "postgres_runtime_grants_unsafe",
          "Privilegios PostgreSQL de runtime divergentes."
        );
      }

      const columnAclRows = await client.query(
        [
          "SELECT",
          "  COALESCE(grantee.rolname, 'PUBLIC') AS grantee,",
          "  relation.relname AS table_name,",
          "  attribute.attname AS column_name,",
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
          "WHERE namespace.nspname = 'ia4tube_social'",
          "  AND attribute.attnum > 0",
          "  AND NOT attribute.attisdropped",
          "  AND expanded_acl.grantee <> relation.relowner",
          "ORDER BY grantee, table_name, column_name,",
          "  expanded_acl.privilege_type"
        ].join("\n")
      );
      const actualColumnGrants = new Set(
        (columnAclRows.rows || []).map(
          (entry) =>
            `${String(entry.grantee).toLowerCase()}|` +
            `${entry.table_name}|${entry.column_name}|` +
            `${String(entry.privilege_type).toUpperCase()}|` +
            `${Boolean(entry.is_grantable)}|` +
            String(entry.grantor_name).toLowerCase()
        )
      );
      if (
        !exactSetMatches(
          actualColumnGrants,
          expectedColumnGrantSet(runtimeRole, ownerRole)
        )
      ) {
        postgresFail(
          "postgres_runtime_grants_unsafe",
          "Privilegios PostgreSQL de runtime divergentes."
        );
      }

      const privileges = await client.query(
        [
          "SELECT",
          "  has_table_privilege(",
          "    current_user,",
          "    'ia4tube_social.runtime_schema_contract',",
          "    'SELECT'",
          "  ) AS contract_select,",
          "  has_table_privilege(",
          "    current_user,",
          "    'ia4tube_social.social_audit_events',",
          "    'UPDATE'",
          "  ) AS audit_update,",
          "  has_table_privilege(",
          "    current_user,",
          "    'ia4tube_social.social_audit_events',",
          "    'DELETE'",
          "  ) AS audit_delete,",
          "  has_table_privilege(",
          "    current_user,",
          "    'ia4tube_social.users',",
          "    'INSERT'",
          "  ) OR has_table_privilege(",
          "    current_user,",
          "    'ia4tube_social.users',",
          "    'UPDATE'",
          "  ) OR has_table_privilege(",
          "    current_user,",
          "    'ia4tube_social.users',",
          "    'DELETE'",
          "  ) OR has_table_privilege(",
          "    current_user,",
          "    'ia4tube_social.companies',",
          "    'INSERT'",
          "  ) OR has_table_privilege(",
          "    current_user,",
          "    'ia4tube_social.companies',",
          "    'UPDATE'",
          "  ) OR has_table_privilege(",
          "    current_user,",
          "    'ia4tube_social.companies',",
          "    'DELETE'",
          "  ) OR has_table_privilege(",
          "    current_user,",
          "    'ia4tube_social.company_memberships',",
          "    'INSERT'",
          "  ) OR has_table_privilege(",
          "    current_user,",
          "    'ia4tube_social.company_memberships',",
          "    'UPDATE'",
          "  ) OR has_table_privilege(",
          "    current_user,",
          "    'ia4tube_social.company_memberships',",
          "    'DELETE'",
          "  ) AS identity_write,",
          "  has_table_privilege(",
          "    current_user,",
          "    'ia4tube_social.legacy_entity_mappings',",
          "    'SELECT'",
          "  ) OR has_table_privilege(",
          "    current_user,",
          "    'ia4tube_social.legacy_entity_mappings',",
          "    'INSERT'",
          "  ) OR has_table_privilege(",
          "    current_user,",
          "    'ia4tube_social.legacy_entity_mappings',",
          "    'UPDATE'",
          "  ) OR has_table_privilege(",
          "    current_user,",
          "    'ia4tube_social.legacy_entity_mappings',",
          "    'DELETE'",
          "  ) AS legacy_access"
        ].join("\n")
      );
      const acl = privileges.rows?.[0];
      if (
        !acl?.contract_select ||
        acl.audit_update ||
        acl.audit_delete ||
        acl.identity_write ||
        acl.legacy_access
      ) {
        postgresFail(
          "postgres_runtime_grants_unsafe",
          "Privilegios PostgreSQL de runtime divergentes."
        );
      }

      return Object.freeze({
        valid: true,
        migrationCount: local.length,
        tenantTableCount: TENANT_TABLES.length
      });
    },
    { role: runtimeRole }
  );
}

module.exports = {
  RUNTIME_COLUMN_GRANTS,
  RUNTIME_TABLE_GRANTS,
  SOCIAL_ADMIN_SCHEMA,
  TENANT_POLICIES,
  TENANT_SCOPE_COLUMNS,
  TENANT_TABLES,
  VAULT_KEY_REGISTRY,
  canonicalPolicyExpression,
  exactSetMatches,
  validateContractRows,
  verifyVaultKeyRegistryBoundary,
  verifyRuntimeSchema
};
