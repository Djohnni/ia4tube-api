"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  databaseTargetFingerprint,
  loadMigrationPostgresConfig,
  loadRuntimePostgresConfig
} = require("../src/persistence/postgres/config");
const {
  SET_COMPANY_SCOPE_SQL,
  createPostgresPool,
  verifyRuntimeRole,
  withTransaction
} = require("../src/persistence/postgres/pool");
const {
  createCompanyScopedRepository
} = require("../src/persistence/postgres/company-scoped-repository");
const {
  createSocialRepository
} = require("../src/persistence/postgres/social-repository");
const {
  RUNTIME_COLUMN_GRANTS,
  RUNTIME_TABLE_GRANTS,
  TENANT_POLICIES,
  TENANT_SCOPE_COLUMNS,
  TENANT_TABLES,
  verifyRuntimeSchema
} = require("../src/persistence/postgres/runtime-validation");

function targetOf(url) {
  return databaseTargetFingerprint(new URL(url));
}
const {
  createSocialRuntime
} = require("../src/social/runtime");
const {
  deriveVaultKeyVersion
} = require("../src/social/vault-key-version");

const root = path.resolve(__dirname, "..");
const companyA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const companyB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const userA = "11111111-1111-4111-8111-111111111111";
const connectionA = "22222222-2222-4222-8222-222222222222";
const identityVersion = "identity-v1";
const credentialKeyVersion = deriveVaultKeyVersion(
  1,
  Buffer.alloc(32, 9)
);
const COMPLIANCE_TABLES = new Set([
  "social_meta_subject_mappings",
  "social_compliance_requests"
]);

function runtimeRoutineRows(extra = false) {
  const rows = [
    {
      proname: "resolve_compliance_status",
      identity_arguments: "requested_confirmation_digest text",
      function_result: "TABLE(status text)",
      owner_name: "ia4tube_social_owner",
      prosecdef: true,
      provolatile: "s",
      prokind: "f",
      proconfig: ["search_path=pg_catalog"],
      prosrc:
        "SELECT request.status FROM ia4tube_social.social_compliance_requests request"
    },
    {
      proname: "resolve_meta_subject_mapping",
      identity_arguments:
        "requested_provider text, requested_subject_digest text",
      function_result:
        "TABLE(company_id uuid, user_id uuid, connection_id uuid)",
      owner_name: "ia4tube_social_owner",
      prosecdef: true,
      provolatile: "s",
      prokind: "f",
      proconfig: ["search_path=pg_catalog"],
      prosrc:
        "SELECT mapping.company_id FROM ia4tube_social.social_meta_subject_mappings mapping"
    }
  ];
  if (extra) {
    rows.push({
      ...rows[0],
      proname: "unexpected_runtime_routine",
      identity_arguments: ""
    });
  }
  return rows;
}

function runtimeRoutineAclRows() {
  return runtimeRoutineRows().map((routine) => ({
    proname: routine.proname,
    identity_arguments: routine.identity_arguments,
    grantee: "ia4tube_social_runtime",
    privilege_type: "EXECUTE",
    is_grantable: false,
    grantor_name: "ia4tube_social_owner"
  }));
}

function runtimeRlsTableRows() {
  return TENANT_TABLES.map((relname) => ({
    relname,
    relrowsecurity: true,
    relforcerowsecurity: true,
    policy_count: COMPLIANCE_TABLES.has(relname) ? 2 : 1
  }));
}

function runtimePolicyRows(options = {}) {
  return TENANT_TABLES.flatMap((tablename) => {
    const expression =
      `(${TENANT_SCOPE_COLUMNS[tablename]} = ` +
      "NULLIF(current_setting('ia4tube.company_id'::text, true), " +
      "''::text)::uuid)";
    const qualifier =
      options.tamperedPolicy && tablename === "social_connections"
        ? `(TRUE OR ${expression})`
        : expression;
    const companyPolicy = {
      tablename,
      policyname: TENANT_POLICIES[tablename],
      permissive: "PERMISSIVE",
      roles:
        options.wrongRole && tablename === "social_connections"
          ? ["ia4tube_social_runtime"]
          : ["public"],
      cmd: "ALL",
      qual: qualifier,
      with_check: qualifier
    };
    if (!COMPLIANCE_TABLES.has(tablename)) return [companyPolicy];
    return [
      companyPolicy,
      {
        tablename,
        policyname: `${tablename}_owner_resolver`,
        permissive: "PERMISSIVE",
        roles: ["ia4tube_social_owner"],
        cmd: "SELECT",
        qual: "true",
        with_check: null
      }
    ];
  });
}

function runtimeTableAclRows() {
  return Object.entries(RUNTIME_TABLE_GRANTS).flatMap(
    ([table_name, privileges]) =>
      privileges.map((privilege_type) => ({
        grantee: "ia4tube_social_runtime",
        table_name,
        privilege_type,
        is_grantable: false,
        grantor_name: "ia4tube_social_owner"
      }))
  );
}

function runtimeColumnAclRows() {
  return Object.entries(RUNTIME_COLUMN_GRANTS).flatMap(
    ([table_name, columns]) =>
      Object.entries(columns).flatMap(([column_name, privileges]) =>
        privileges.map((privilege_type) => ({
          grantee: "ia4tube_social_runtime",
          table_name,
          column_name,
          privilege_type,
          is_grantable: false,
          grantor_name: "ia4tube_social_owner"
        }))
      )
  );
}

function runtimeSchemaAclRows() {
  return [
    {
      grantee: "ia4tube_social_runtime",
      privilege_type: "USAGE",
      is_grantable: false,
      grantor_name: "ia4tube_social_owner"
    }
  ];
}

function vaultRegistryBoundaryRow(overrides = {}) {
  return {
    schema_owner: "ia4tube_social_owner",
    registry_kind: "r",
    registry_owner: "ia4tube_social_owner",
    registry_rls: false,
    registry_force_rls: false,
    registry_policy_count: 0,
    registry_primary_key_count: 1,
    vault_registry_fk_count: 1,
    schema_non_owner_acl_count: 0,
    table_non_owner_acl_count: 0,
    runtime_usage_absent: true,
    runtime_create_absent: true,
    ...overrides
  };
}

function socialRelationRows(overrides = {}) {
  return [
    ...TENANT_TABLES.map((relname) => ({
      relname,
      object_kind: "r",
      owner_name: "ia4tube_social_owner"
    })),
    {
      relname: "runtime_schema_contract",
      object_kind: "v",
      owner_name: "ia4tube_social_owner"
    }
  ].map((row) =>
    row.relname === overrides.relation
      ? { ...row, ...overrides.values }
      : row
  );
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

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function fakePool(handler) {
  const queries = [];
  const client = {
    async query(text, values) {
      queries.push({ text, values });
      return handler ? handler(text, values, queries) : { rows: [] };
    },
    release(error) {
      client.released = true;
      client.releaseError = error;
    },
    released: false
  };
  return {
    queries,
    client,
    pool: {
      async connect() {
        return client;
      }
    }
  };
}

test("social persistence is disabled by default without opening a pool", async () => {
  assert.deepEqual(loadRuntimePostgresConfig({}), { enabled: false });
  assert.deepEqual(await createSocialRuntime({ env: {} }), {
    enabled: false,
    reason: "social_persistence_disabled"
  });
});

test("enabled social persistence fails closed without an explicit database", () => {
  assert.throws(
    () =>
      loadRuntimePostgresConfig({
        SOCIAL_PERSISTENCE_ENABLED: "true"
      }),
    { code: "database_url_missing" }
  );
});

test("runtime PostgreSQL forces verified TLS outside loopback tests", () => {
  const url =
    "postgresql://runtime:synthetic@db.example.test/social?sslmode=verify-full";
  const config = loadRuntimePostgresConfig({
    SOCIAL_PERSISTENCE_ENABLED: "true",
    SOCIAL_DATABASE_EXPECTED_RUNTIME_LOGIN: "runtime",
    SOCIAL_DATABASE_EXPECTED_TARGET_FINGERPRINT: targetOf(url),
    DATABASE_URL: url
  });
  assert.equal(config.enabled, true);
  assert.equal(config.pool.ssl.rejectUnauthorized, true);
  assert.equal(config.pool.ssl.servername, "db.example.test");
  assert.equal(
    Object.prototype.hasOwnProperty.call(config.pool.ssl, "ca"),
    false
  );
  assert.equal(config.pool.connectionString.includes("sslmode"), false);
  assert.equal(config.pool.max, 3);
  assert.ok(config.pool.options.includes("statement_timeout=10000"));
  assert.ok(
    config.pool.options.includes("idle_in_transaction_session_timeout=5000")
  );
});

test("node-postgres preserves the strict SSL object after URL parsing", async () => {
  const url =
    "postgresql://runtime:synthetic@db.example.test/social?sslmode=verify-full";
  const config = loadRuntimePostgresConfig({
    SOCIAL_PERSISTENCE_ENABLED: "true",
    SOCIAL_DATABASE_EXPECTED_RUNTIME_LOGIN: "runtime",
    SOCIAL_DATABASE_EXPECTED_TARGET_FINGERPRINT: targetOf(url),
    DATABASE_URL: url
  });
  const pool = createPostgresPool(config.pool);
  try {
    assert.equal(pool.options.max, 3);
    assert.equal(pool.options.connectionString.includes("sslmode"), false);
    assert.equal(pool.options.ssl.rejectUnauthorized, true);
    assert.equal(pool.options.ssl.minVersion, "TLSv1.2");
    assert.equal(pool.options.ssl.servername, "db.example.test");
    assert.equal(
      Object.prototype.hasOwnProperty.call(pool.options.ssl, "ca"),
      false
    );
  } finally {
    await pool.end();
  }
});

test("runtime PostgreSQL refuses role names that diverge from migrations", () => {
  const url =
    "postgresql://runtime:synthetic@db.example.test/social";
  assert.throws(
    () =>
      loadRuntimePostgresConfig({
        SOCIAL_PERSISTENCE_ENABLED: "true",
        SOCIAL_DATABASE_EXPECTED_RUNTIME_LOGIN: "runtime",
        SOCIAL_DATABASE_EXPECTED_TARGET_FINGERPRINT: targetOf(url),
        DATABASE_URL: url,
        SOCIAL_DATABASE_RUNTIME_ROLE: "alternate_runtime"
      }),
    { code: "social_database_runtime_role_must_be_canonical" }
  );
});

test("unencrypted remote PostgreSQL is refused", () => {
  const url =
    "postgresql://runtime:synthetic@db.example.test/social?sslmode=disable";
  assert.throws(
    () =>
      loadRuntimePostgresConfig({
        SOCIAL_PERSISTENCE_ENABLED: "true",
        SOCIAL_DATABASE_EXPECTED_RUNTIME_LOGIN: "runtime",
        SOCIAL_DATABASE_EXPECTED_TARGET_FINGERPRINT: targetOf(url),
        DATABASE_URL: url
      }),
    { code: "social_database_tls_mode_invalid" }
  );
});

test("unencrypted PostgreSQL is allowed only for explicit loopback tests", () => {
  const localUrl =
    "postgresql://runtime:synthetic@127.0.0.1:55432/" +
    "social_test?sslmode=disable";
  const config = loadRuntimePostgresConfig({
    NODE_ENV: "test",
    SOCIAL_PERSISTENCE_ENABLED: "true",
    SOCIAL_DATABASE_EXPECTED_RUNTIME_LOGIN: "runtime",
    SOCIAL_DATABASE_ALLOW_INSECURE_LOCALHOST: "true",
    SOCIAL_DATABASE_EXPECTED_TARGET_FINGERPRINT: targetOf(localUrl),
    DATABASE_URL: localUrl
  });
  assert.equal(config.pool.ssl, false);

  assert.throws(
    () =>
      loadRuntimePostgresConfig({
        NODE_ENV: "test",
        SOCIAL_PERSISTENCE_ENABLED: "true",
        SOCIAL_DATABASE_EXPECTED_RUNTIME_LOGIN: "runtime",
        SOCIAL_DATABASE_ALLOW_INSECURE_LOCALHOST: "true",
        SOCIAL_DATABASE_EXPECTED_TARGET_FINGERPRINT: targetOf(
          "postgresql://runtime:synthetic@remote.test/social" +
            "?sslmode=disable"
        ),
        DATABASE_URL:
          "postgresql://runtime:synthetic@remote.test/social?sslmode=disable"
      }),
    { code: "social_database_tls_mode_invalid" }
  );
});

test("migration credentials must differ from runtime credentials", () => {
  const url = "postgresql://migration:synthetic@localhost/social_test";
  assert.throws(
    () =>
      loadMigrationPostgresConfig({
        NODE_ENV: "test",
        SOCIAL_DATABASE_ALLOW_INSECURE_LOCALHOST: "true",
        SOCIAL_MIGRATION_ENVIRONMENT: "test",
        SOCIAL_MIGRATIONS_EXPECTED_LOGIN: "migration",
        SOCIAL_DATABASE_EXPECTED_RUNTIME_LOGIN: "migration",
        SOCIAL_DATABASE_EXPECTED_TARGET_FINGERPRINT: targetOf(url),
        SOCIAL_MIGRATIONS_DATABASE_URL: url,
      }),
    { code: "migration_runtime_credentials_must_differ" }
  );
});

test("equivalent database URLs cannot disguise reused migration credentials", () => {
  const url =
    "postgresql://migration:one@localhost:5432/" +
    "social_test?application_name=migration";
  assert.throws(
    () =>
      loadMigrationPostgresConfig({
        NODE_ENV: "test",
        SOCIAL_DATABASE_ALLOW_INSECURE_LOCALHOST: "true",
        SOCIAL_MIGRATION_ENVIRONMENT: "test",
        SOCIAL_MIGRATIONS_EXPECTED_LOGIN: "migration",
        SOCIAL_DATABASE_EXPECTED_RUNTIME_LOGIN: "migration",
        SOCIAL_DATABASE_EXPECTED_TARGET_FINGERPRINT: targetOf(url),
        SOCIAL_MIGRATION_EXPECTED_ENVIRONMENT_ID:
          "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        SOCIAL_MIGRATIONS_DATABASE_URL: url,
      }),
    { code: "migration_runtime_credentials_must_differ" }
  );
});

test("tenant transaction sets role and local company context before work", async () => {
  const harness = fakePool((text) => {
    if (text === "SELECT synthetic") return { rows: [{ ok: true }] };
    return { rows: [] };
  });
  const result = await withTransaction(
    harness.pool,
    (client) => client.query("SELECT synthetic"),
    { companyId: companyA, role: "ia4tube_social_runtime" }
  );
  assert.deepEqual(result.rows, [{ ok: true }]);
  assert.deepEqual(
    harness.queries.map((query) => query.text),
    [
      "BEGIN",
      'SET LOCAL ROLE "ia4tube_social_runtime"',
      SET_COMPANY_SCOPE_SQL,
      "SELECT synthetic",
      "COMMIT"
    ]
  );
  assert.deepEqual(harness.queries[2].values, [companyA]);
  assert.equal(harness.client.released, true);
});

test("tenant transaction rolls back and releases the client on failure", async () => {
  const harness = fakePool((text) => {
    if (text === "SELECT fail") throw new Error("synthetic failure");
    return { rows: [] };
  });
  await assert.rejects(
    withTransaction(
      harness.pool,
      (client) => client.query("SELECT fail"),
      { companyId: companyA, role: "ia4tube_social_runtime" }
    ),
    /synthetic failure/
  );
  assert.equal(harness.queries.at(-1).text, "ROLLBACK");
  assert.equal(harness.client.released, true);
});

test("runtime role validation rejects superuser, bypassrls and table owners", async () => {
  for (const unsafe of [
    { postgres_version_supported: false },
    { active_canlogin: true },
    { active_superuser: true },
    { active_createdb: true },
    { active_createrole: true },
    { active_inherit: true },
    { active_replication: true },
    { active_bypassrls: true },
    { login_superuser: true },
    { login_createdb: true },
    { login_createrole: true },
    { login_replication: true },
    { login_bypassrls: true },
    { database_owner_safe: false },
    { login_is_separate: false },
    { direct_connect_exact: false },
    { public_database_acl_absent: false },
    { database_temp_absent: false },
    { owner_member: true },
    { migrator_member: true },
    { unexpected_membership: true },
    { runtime_members_exact: false }
  ]) {
    const harness = fakePool((text) => {
      if (text.includes("FROM pg_catalog.pg_roles")) {
        return {
          rows: [
            {
              postgres_version_supported: true,
              active_canlogin: false,
              active_superuser: false,
              active_createdb: false,
              active_createrole: false,
              active_inherit: false,
              active_replication: false,
              active_bypassrls: false,
              login_superuser: false,
              login_createdb: false,
              login_createrole: false,
              login_replication: false,
              login_bypassrls: false,
              database_owner_safe: true,
              login_is_separate: true,
              direct_connect_exact: true,
              public_database_acl_absent: true,
              database_temp_absent: true,
              runtime_member: true,
              owner_member: false,
              migrator_member: false,
              unexpected_membership: false,
              runtime_members_exact: true,
              ...unsafe
            }
          ]
        };
      }
      if (text.includes("AS owns_database")) {
        return { rows: [safePrincipalAccess()] };
      }
      return { rows: [] };
    });
    await assert.rejects(
      verifyRuntimeRole(harness.pool, "ia4tube_social_runtime"),
      { code: "postgres_runtime_role_unsafe" }
    );
  }

  const ownerHarness = fakePool((text) => {
    if (text.includes("FROM pg_catalog.pg_roles")) {
      return {
        rows: [
          {
            postgres_version_supported: true,
            active_canlogin: false,
            active_superuser: false,
            active_createdb: false,
            active_createrole: false,
            active_inherit: false,
            active_replication: false,
            active_bypassrls: false,
            login_superuser: false,
            login_createdb: false,
            login_createrole: false,
            login_replication: false,
            login_bypassrls: false,
            database_owner_safe: true,
            login_is_separate: true,
            direct_connect_exact: true,
            public_database_acl_absent: true,
            database_temp_absent: true,
            runtime_member: true,
            owner_member: false,
            migrator_member: false,
            unexpected_membership: false,
            runtime_members_exact: true
          }
        ]
      };
    }
    if (text.includes("AS owns_database")) {
      return {
        rows: [safePrincipalAccess({ owns_database: true })]
      };
    }
    return { rows: [] };
  });
  await assert.rejects(
    verifyRuntimeRole(ownerHarness.pool, "ia4tube_social_runtime"),
    { code: "postgres_runtime_role_is_owner" }
  );
  const membershipQuery = ownerHarness.queries.find((query) =>
    query.text.includes("AS runtime_members_exact")
  );
  assert.match(membershipQuery.text, /membership\.admin_option/);
  assert.match(membershipQuery.text, /membership\.inherit_option/);
  assert.match(membershipQuery.text, /membership\.set_option/);
  assert.match(membershipQuery.text, /COUNT\(\*\) = 2/);
  assert.match(membershipQuery.text, /grantor\.rolsuper/);
  assert.match(membershipQuery.text, /database_info\.datdba/);
  assert.match(membershipQuery.text, /direct_connect_exact/);
  assert.match(membershipQuery.text, /public_database_acl_absent/);
  assert.match(membershipQuery.text, /database_temp_absent/);

  for (const elevatedAccess of [
    "database_create",
    "owns_schema",
    "schema_create",
    "owns_relation",
    "owns_function",
    "owns_type",
    "table_truncate"
  ]) {
    const harness = fakePool((text) => {
      if (text.includes("FROM pg_catalog.pg_roles")) {
        return {
          rows: [
            {
              postgres_version_supported: true,
              active_canlogin: false,
              active_superuser: false,
              active_createdb: false,
              active_createrole: false,
              active_inherit: false,
              active_replication: false,
              active_bypassrls: false,
              login_superuser: false,
              login_createdb: false,
              login_createrole: false,
              login_replication: false,
              login_bypassrls: false,
              database_owner_safe: true,
              login_is_separate: true,
              direct_connect_exact: true,
              public_database_acl_absent: true,
              database_temp_absent: true,
              runtime_member: true,
              owner_member: false,
              migrator_member: false,
              unexpected_membership: false,
              runtime_members_exact: true
            }
          ]
        };
      }
      if (text.includes("AS owns_database")) {
        return {
          rows: [safePrincipalAccess({ [elevatedAccess]: true })]
        };
      }
      return { rows: [] };
    });
    await assert.rejects(
      verifyRuntimeRole(harness.pool, "ia4tube_social_runtime"),
      { code: "postgres_runtime_role_is_owner" }
    );
  }
});

test("runtime schema validation requires checksums, FORCE RLS and least privilege", async () => {
  const manifest = JSON.parse(
    read("db/migrations/checksums.json")
  ).migrations;
  const validHarness = fakePool((text) => {
    if (text.includes("SELECT owner.rolname AS owner_name")) {
      return {
        rowCount: 1,
        rows: [{ owner_name: "ia4tube_social_owner" }]
      };
    }
    if (text.includes("AS vault_registry_fk_count")) {
      return { rowCount: 1, rows: [vaultRegistryBoundaryRow()] };
    }
    if (text.includes("relation.relkind AS object_kind")) {
      return { rows: socialRelationRows() };
    }
    if (
      text.includes("FROM pg_catalog.pg_proc routine") &&
      text.includes("pg_get_function_result")
    ) {
      return { rows: runtimeRoutineRows() };
    }
    if (
      text.includes("FROM pg_catalog.pg_proc routine") &&
      text.includes("expanded_acl")
    ) {
      return { rows: runtimeRoutineAclRows() };
    }
    if (text.includes("FROM ia4tube_social.runtime_schema_contract")) {
      return {
        rows: manifest.map((migration) => ({
          version: migration.version,
          checksum_sha256: migration.sha256
        }))
      };
    }
    if (text.includes("FROM pg_catalog.pg_class c")) {
      return {
        rows: runtimeRlsTableRows()
      };
    }
    if (text.includes("FROM pg_catalog.pg_policies")) {
      return {
        rows: runtimePolicyRows()
      };
    }
    if (text.includes("namespace.nspacl")) {
      return { rows: runtimeSchemaAclRows() };
    }
    if (text.includes("relation.relacl")) {
      return { rows: runtimeTableAclRows() };
    }
    if (text.includes("attribute.attacl")) {
      return { rows: runtimeColumnAclRows() };
    }
    if (text.includes("has_table_privilege")) {
      return {
        rows: [
          {
            contract_select: true,
            audit_update: false,
            audit_delete: false,
            credentials_delete: true,
            identity_write: false,
            legacy_access: false
          }
        ]
      };
    }
    return { rows: [] };
  });
  const result = await verifyRuntimeSchema(
    validHarness.pool,
    "ia4tube_social_runtime"
  );
  assert.equal(result.valid, true);
  assert.equal(result.tenantTableCount, TENANT_TABLES.length);

  const unsafeHarness = fakePool((text) => {
    if (text.includes("SELECT owner.rolname AS owner_name")) {
      return {
        rowCount: 1,
        rows: [{ owner_name: "ia4tube_social_owner" }]
      };
    }
    if (text.includes("AS vault_registry_fk_count")) {
      return { rowCount: 1, rows: [vaultRegistryBoundaryRow()] };
    }
    if (text.includes("relation.relkind AS object_kind")) {
      return { rows: socialRelationRows() };
    }
    if (
      text.includes("FROM pg_catalog.pg_proc routine") &&
      text.includes("pg_get_function_result")
    ) {
      return { rows: runtimeRoutineRows() };
    }
    if (
      text.includes("FROM pg_catalog.pg_proc routine") &&
      text.includes("expanded_acl")
    ) {
      return { rows: runtimeRoutineAclRows() };
    }
    if (text.includes("FROM ia4tube_social.runtime_schema_contract")) {
      return {
        rows: manifest.map((migration) => ({
          version: migration.version,
          checksum_sha256: migration.sha256
        }))
      };
    }
    if (text.includes("FROM pg_catalog.pg_class c")) {
      return {
        rows: runtimeRlsTableRows()
      };
    }
    if (text.includes("FROM pg_catalog.pg_policies")) {
      return {
        rows: runtimePolicyRows()
      };
    }
    if (text.includes("namespace.nspacl")) {
      return { rows: runtimeSchemaAclRows() };
    }
    if (text.includes("relation.relacl")) {
      return { rows: runtimeTableAclRows() };
    }
    if (text.includes("attribute.attacl")) {
      return { rows: runtimeColumnAclRows() };
    }
    if (text.includes("has_table_privilege")) {
      return {
        rows: [{
          contract_select: true,
          audit_update: true,
          audit_delete: false,
          credentials_delete: true,
          identity_write: false,
          legacy_access: false
        }]
      };
    }
    return { rows: [] };
  });
  await assert.rejects(
    verifyRuntimeSchema(unsafeHarness.pool, "ia4tube_social_runtime"),
    { code: "postgres_runtime_grants_unsafe" }
  );
});

test("runtime schema rejects policy, table and ACL drift", async () => {
  const manifest = JSON.parse(
    read("db/migrations/checksums.json")
  ).migrations;
  function harnessFor(options = {}) {
    return fakePool((text) => {
      if (text.includes("SELECT owner.rolname AS owner_name")) {
        return {
          rowCount: 1,
          rows: [
            {
              owner_name: options.wrongSchemaOwner
                ? "unexpected_owner"
                : "ia4tube_social_owner"
            }
          ]
        };
      }
      if (text.includes("AS vault_registry_fk_count")) {
        return {
          rowCount: 1,
          rows: [
            vaultRegistryBoundaryRow(
              options.runtimeAdminUsage
                ? { runtime_usage_absent: false }
                : options.invalidVaultForeignKey
                  ? { vault_registry_fk_count: 0 }
                  : {}
            )
          ]
        };
      }
      if (text.includes("relation.relkind AS object_kind")) {
        const rows = socialRelationRows(
          options.wrongRelationOwner
            ? {
                relation: "social_connections",
                values: { owner_name: "unexpected_owner" }
              }
            : {}
        );
        return { rows };
      }
      if (
        text.includes("FROM pg_catalog.pg_proc routine") &&
        text.includes("pg_get_function_result")
      ) {
        return { rows: runtimeRoutineRows(options.unexpectedRoutine) };
      }
      if (
        text.includes("FROM pg_catalog.pg_proc routine") &&
        text.includes("expanded_acl")
      ) {
        return { rows: runtimeRoutineAclRows() };
      }
      if (text.includes("FROM ia4tube_social.runtime_schema_contract")) {
        return {
          rows: manifest.map((migration) => ({
            version: migration.version,
            checksum_sha256: migration.sha256
          }))
        };
      }
      if (text.includes("FROM pg_catalog.pg_class c")) {
        const tables = runtimeRlsTableRows();
        if (options.extraTable) {
          tables.push({
            relname: "unexpected_tenant_data",
            relrowsecurity: false,
            relforcerowsecurity: false,
            policy_count: 0
          });
        }
        return { rows: tables };
      }
      if (text.includes("FROM pg_catalog.pg_policies")) {
        return { rows: runtimePolicyRows(options) };
      }
      if (text.includes("namespace.nspacl")) {
        const rows = runtimeSchemaAclRows();
        if (options.schemaThirdPartyGrant) {
          rows.push({
            grantee: "unexpected_login",
            privilege_type: "USAGE",
            is_grantable: false,
            grantor_name: "ia4tube_social_owner"
          });
        }
        return { rows };
      }
      if (text.includes("relation.relacl")) {
        const rows = runtimeTableAclRows();
        if (options.extraGrant) {
          rows.push({
            grantee: "ia4tube_social_runtime",
            table_name: "social_connections",
            privilege_type: "DELETE"
          });
        }
        if (options.thirdPartyGrant) {
          rows.push({
            grantee: "unexpected_login",
            table_name: "social_encrypted_credentials",
            privilege_type: "SELECT",
            is_grantable: false,
            grantor_name: "ia4tube_social_owner"
          });
        }
        if (options.runtimeGrantOption) {
          rows[0] = { ...rows[0], is_grantable: true };
        }
        return { rows };
      }
      if (text.includes("attribute.attacl")) {
        return { rows: runtimeColumnAclRows() };
      }
      if (text.includes("has_table_privilege")) {
        return {
          rows: [
            {
              contract_select: true,
              audit_update: false,
              audit_delete: false,
              credentials_delete: true,
              identity_write: false,
              legacy_access: false
            }
          ]
        };
      }
      return { rows: [] };
    });
  }

  for (const options of [
    { tamperedPolicy: true },
    { wrongRole: true },
    { extraTable: true },
    { extraGrant: true },
    { thirdPartyGrant: true },
    { runtimeGrantOption: true },
    { schemaThirdPartyGrant: true },
    { runtimeAdminUsage: true },
    { invalidVaultForeignKey: true },
    { wrongSchemaOwner: true },
    { wrongRelationOwner: true },
    { unexpectedRoutine: true }
  ]) {
    await assert.rejects(
      verifyRuntimeSchema(
        harnessFor(options).pool,
        "ia4tube_social_runtime"
      ),
      (error) =>
        error?.code === "postgres_rls_contract_mismatch" ||
        error?.code === "postgres_runtime_grants_unsafe" ||
        error?.code === "postgres_vault_key_registry_unsafe" ||
        error?.code === "postgres_schema_owner_mismatch" ||
        error?.code === "postgres_relation_owner_mismatch" ||
        error?.code === "postgres_routine_contract_mismatch"
    );
  }
});

test("company repository is read-only, typed and derivation-version bound", async () => {
  const harness = fakePool((text, values) => {
    if (text.includes("FROM ia4tube_social.companies")) {
      assert.deepEqual(values, [companyA, identityVersion]);
      return {
        rows: [
          {
            id: companyA,
            name: "Synthetic Company",
            status: "active",
            identity_derivation_version: identityVersion
          }
        ]
      };
    }
    return { rows: [] };
  });
  const repository = createCompanyScopedRepository({
    pool: harness.pool,
    identityDerivationVersion: identityVersion
  });
  assert.deepEqual(Object.keys(repository).sort(), [
    "findCompanyById",
    "findMembership"
  ]);
  const result = await repository.findCompanyById(companyA);
  assert.equal(result.id, companyA);
  assert.equal(
    JSON.stringify(harness.queries).includes(
      "identity_derivation_version"
    ),
    true
  );
});

test("social repository scopes every query and stores only envelopes", async () => {
  const credentialId = "55555555-5555-4555-8555-555555555555";
  const harness = fakePool((text, values) => {
    if (
      text.includes(
        "INSERT INTO ia4tube_social.social_encrypted_credentials"
      )
    ) {
      return {
        rows: [
          {
            company_id: values[0],
            id: values[1],
            provider: values[2],
            connection_id: values[3],
            oauth_transaction_id: values[4],
            credential_type: values[5],
            ciphertext: values[6],
            nonce: values[7],
            auth_tag: values[8],
            key_version: values[9],
            aad_version: values[10],
            revision: 1
          }
        ]
      };
    }
    return { rows: [] };
  });
  const repository = createSocialRepository({
    pool: harness.pool,
    identityDerivationVersion: identityVersion
  });
  const row = await repository.storeEncryptedCredential({
    companyId: companyA,
    id: credentialId,
    provider: "instagram",
    connectionId: connectionA,
    credentialType: "access_token",
    ciphertext: Buffer.from("ciphertext"),
    nonce: Buffer.alloc(12, 1),
    authTag: Buffer.alloc(16, 2),
    keyVersion: credentialKeyVersion,
    aadVersion: 1
  });
  assert.equal(row.company_id, companyA);
  assert.equal(
    harness.queries.some(
      (query) =>
        query.text === SET_COMPANY_SCOPE_SQL &&
        query.values[0] === companyA
    ),
    true
  );
  assert.equal(JSON.stringify(harness.queries).includes("plaintext"), false);
  await repository.findEncryptedCredential({
    companyId: companyA,
    credentialId
  });
  const credentialRead = harness.queries.find((query) =>
    query.text.includes("FROM ia4tube_social.social_encrypted_credentials credential")
  );
  assert.match(
    credentialRead.text,
    /connection\.status IN \('active', 'connected'\)/
  );
  assert.match(credentialRead.text, /oauth\.failed_at IS NULL/);
  await assert.rejects(
    repository.findConnection({
      companyId: companyA,
      connectionId: "00000000-0000-0000-0000-000000000000"
    }),
    { code: "connection_id_invalid" }
  );
});

test("reauth consumption atomically revalidates the active company", async () => {
  const tokenDigest = "a".repeat(64);
  const sessionDigest = "b".repeat(64);
  const harness = fakePool((text, values) => {
    if (text.includes("UPDATE ia4tube_social.social_reauth_grants")) {
      assert.match(text, /ia4tube_social\.companies company/);
      assert.match(text, /company\.status = 'active'/);
      assert.match(
        text,
        /company\.identity_derivation_version = \$8/
      );
      assert.deepEqual(values, [
        companyA,
        userA,
        tokenDigest,
        sessionDigest,
        "social.connect",
        "instagram",
        null,
        identityVersion
      ]);
      return {
        rows: [
          {
            id: "77777777-7777-4777-8777-777777777777",
            company_id: companyA,
            user_id: userA,
            action: "social.connect",
            provider: "instagram",
            target_connection_id: null,
            consumed_at: new Date()
          }
        ]
      };
    }
    return { rows: [] };
  });
  const repository = createSocialRepository({
    pool: harness.pool,
    identityDerivationVersion: identityVersion
  });

  const consumed = await repository.consumeReauthGrant({
    companyId: companyA,
    userId: userA,
    tokenDigest,
    sessionJtiDigest: sessionDigest,
    action: "social.connect",
    provider: "instagram"
  });

  assert.equal(consumed.company_id, companyA);
});

test("SQL foundation forces RLS on every tenant table and uses composite FKs", () => {
  const sql = [
    read("db/migrations/0001_social_multitenant_foundation.up.sql"),
    read("db/migrations/0002_social_connections_and_vault.up.sql")
  ].join("\n");
  const tables = [
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
  ];
  for (const table of tables) {
    assert.match(
      sql,
      new RegExp(
        `ALTER TABLE ia4tube_social\\.${table}[\\s\\S]{0,80}ENABLE ROW LEVEL SECURITY`
      )
    );
    assert.match(
      sql,
      new RegExp(
        `ALTER TABLE ia4tube_social\\.${table}[\\s\\S]{0,80}FORCE ROW LEVEL SECURITY`
      )
    );
  }
  assert.match(
    sql,
    /FOREIGN KEY \(company_id, connection_id, external_account_id\)/
  );
  assert.match(sql, /FOREIGN KEY \(company_id, user_id\)/);
  assert.doesNotMatch(
    sql,
    /\b(access_token|refresh_token|oauth_code|authorization_code)\s+(TEXT|VARCHAR|BYTEA)\b/i
  );
  assert.match(sql, /UNIQUE \(key_version, nonce\)/);
  assert.match(
    sql,
    /FOREIGN KEY \(company_id, connection_id, provider\)/
  );
  assert.doesNotMatch(
    sql,
    /GRANT SELECT, INSERT, UPDATE, DELETE\s+ON ALL TABLES/i
  );
  assert.match(
    sql,
    /GRANT SELECT, INSERT\s+ON ia4tube_social\.social_audit_events/
  );
  assert.doesNotMatch(sql, /\bBEGIN\s*;|\bCOMMIT\s*;/i);
});

test("role bootstrap is password-free and runtime cannot bypass RLS", () => {
  const sql = read("db/postgres/roles.sql");
  assert.match(
    sql,
    /ia4tube_social_runtime[\s\S]*?NOLOGIN[\s\S]*?NOSUPERUSER[\s\S]*?NOREPLICATION[\s\S]*?NOBYPASSRLS/
  );
  assert.match(sql, /ia4tube_social_postgres_18_required/);
  assert.match(
    sql,
    /GRANT ia4tube_social_owner TO ia4tube_social_migrator[\s\S]*?WITH ADMIN FALSE, INHERIT FALSE, SET TRUE/
  );
  assert.match(sql, /REVOKE CREATE ON SCHEMA public FROM PUBLIC/);
  assert.match(sql, /GRANT CREATE ON DATABASE %I TO ia4tube_social_owner/);
  assert.match(sql, /SET LOCAL createrole_self_grant = ''/);
  assert.match(sql, /ia4tube_social_provisioner_invalid/);
  assert.match(sql, /grantor\.rolsuper/);
  assert.match(sql, /SET LOCAL ROLE ia4tube_social_owner/);
  assert.match(sql, /GRANTED BY CURRENT_USER RESTRICT/);
  assert.match(sql, /COMMIT;\s*$/);
  assert.match(sql, /CREATE SCHEMA IF NOT EXISTS ia4tube_migrations/);
  assert.match(sql, /environment_identity/);
  assert.match(sql, /ia4tube_social_role_memberships_invalid/);
  assert.doesNotMatch(sql, /\bPASSWORD\b/i);
});

test("preparation npm command is limited to automated compatibility checks", () => {
  const pkg = JSON.parse(read("package.json"));
  // The official live base has no staging-wide test runner. This checkpoint
  // exposes a bounded local command, not an operator/database/device action.
  const command = pkg.scripts["test:social-production-compatibility"];
  assert.equal(command,
    "node --test tests/production-social-live-compatibility.test.js");
  assert.doesNotMatch(command, /app_mobile|manual|adb|migration|deploy/i);
  const compatibility = read("tests/production-social-live-compatibility.test.js");
  assert.match(compatibility, /invalid social startup stops before importing legacy modules/);
  assert.match(compatibility, /closed social route precedes the global JSON parser/);
});
