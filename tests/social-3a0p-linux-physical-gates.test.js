"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  createLocalVerifierPoolClass,
  createTenant,
  databaseContainsMarker,
  runRlsAndRoleGate,
  runRlsPrivilegeInventoryContextReproduction,
  runRlsRuntimeWriteContractReproduction,
  runVaultSupplementalGate,
  runtimeWritePrivilegeInventory
} = require("../scripts/social-3a0p-linux-physical-gates");

const ROOT = path.resolve(__dirname, "..");
const MIGRATION_LOGIN = "ia4tube_social_local_migration";
const MIGRATOR_ROLE = "ia4tube_social_migrator";
const RUNTIME_LOGIN = "ia4tube_social_local_runtime";
const RUNTIME_ROLE = "ia4tube_social_runtime";

function postgresError(code) {
  return Object.assign(new Error("synthetic postgres refusal"), { code });
}

function legacyFailureCode(error) {
  const candidate = String(error?.code || error?.message || "");
  return /^[a-z][a-z0-9_]{2,119}$/.test(candidate)
    ? candidate
    : "linux_gate_unclassified_failure";
}

function inventoryContextProof(overrides = {}) {
  return Object.freeze({
    directSessionIdentityVerified: true,
    directLoginSuperuser: false,
    directLoginBypassRls: false,
    directLoginCreateRole: false,
    directLoginCanSetMigratorRole: true,
    directLoginInheritsMigratorRole: false,
    directSchemaUsage: false,
    directNameResolutionRefused: true,
    directTransactionPersisted: false,
    directPoolUsableAfterRefusal: true,
    inventorySessionUserMigration: true,
    inventoryCurrentUserMigrator: true,
    migratorSessionIdentityPreserved: true,
    migratorRoleActivated: true,
    migratorSchemaUsage: false,
    migratorInventorySucceeded: true,
    oidInventoryUsed: true,
    textualRelationResolutionUsed: false,
    relationCount: 2,
    roleResetAfterTransaction: true,
    privilegesUnchanged: true,
    aclUnchanged: true,
    ...overrides
  });
}

function createInventoryContextDatabase(options = {}) {
  const calls = [];
  const clients = [];
  const available = [];
  let aclReads = 0;
  let inventoryReads = 0;

  const relationRows = (client) => {
    const schemaAcl = "{synthetic_schema_acl}";
    const base = [
      {
        namespace_name: options.auditSchemaName ?? options.inventorySchemaName ?? "ia4tube_social",
        namespace_oid: options.auditNamespaceOid ?? options.inventoryNamespaceOid ?? 4100,
        relation_name: "social_audit_events",
        relation_oid: options.auditRelationOid ?? 4101,
        relation_kind: options.auditRelationKind ?? "r",
        session_user_is_migration: options.inventorySessionUserMigration !== false &&
          client.sessionUser === MIGRATION_LOGIN,
        current_user_is_migrator: options.inventoryCurrentUserMigrator !== false &&
          client.currentUser === MIGRATOR_ROLE,
        schema_usage: options.migratorSchemaUsage === true,
        runtime_login_can_set_role: true,
        runtime_login_insert: false,
        runtime_insert: options.auditInsertPrivilege !== false,
        social_audit_rls_enabled: options.auditRlsEnabled !== false,
        social_audit_force_rls: options.auditForceRls !== false,
        social_audit_policy_exists: options.auditPolicyExists !== false,
        social_audit_policy_using: options.auditPolicyUsing !== false,
        social_audit_policy_with_check: options.auditPolicyWithCheck !== false,
        social_audit_policy_company_bound: options.auditPolicyCompanyBound !== false,
        schema_acl: schemaAcl,
        relation_acl: inventoryReads > 1 && options.inventoryAclMutationAfterFirst
          ? "{mutated_audit_acl}"
          : "{synthetic_audit_acl}"
      },
      {
        namespace_name: options.userSchemaName ?? options.inventorySchemaName ?? "ia4tube_social",
        namespace_oid: options.userNamespaceOid ?? options.inventoryNamespaceOid ?? 4100,
        relation_name: "users",
        relation_oid: options.userRelationOid ?? 4102,
        relation_kind: options.userRelationKind ?? "r",
        session_user_is_migration: options.inventorySessionUserMigration !== false &&
          client.sessionUser === MIGRATION_LOGIN,
        current_user_is_migrator: options.inventoryCurrentUserMigrator !== false &&
          client.currentUser === MIGRATOR_ROLE,
        schema_usage: options.migratorSchemaUsage === true,
        runtime_login_can_set_role: true,
        runtime_login_insert: false,
        runtime_insert: options.userInsertPrivilege === true,
        social_audit_rls_enabled: false,
        social_audit_force_rls: false,
        social_audit_policy_exists: false,
        social_audit_policy_using: false,
        social_audit_policy_with_check: false,
        social_audit_policy_company_bound: false,
        schema_acl: schemaAcl,
        relation_acl: "{synthetic_users_acl}"
      }
    ];
    if (options.missingRelation || options.missingUsers) return base.slice(0, 1);
    if (options.missingAudit) return base.slice(1);
    if (options.duplicateRelation) return [...base, { ...base[1] }];
    if (Object.hasOwn(options, "userRuntimeLoginInsertRaw")) {
      base[1].runtime_login_insert = options.userRuntimeLoginInsertRaw;
    }
    if (Object.hasOwn(options, "userRuntimeInsertRaw")) {
      base[1].runtime_insert = options.userRuntimeInsertRaw;
    }
    if (options.omitUserRuntimeLoginInsert === true) delete base[1].runtime_login_insert;
    if (options.omitUserRuntimeInsert === true) delete base[1].runtime_insert;
    return base;
  };

  class Client {
    constructor() {
      this.sessionUser = MIGRATION_LOGIN;
      this.currentUser = MIGRATION_LOGIN;
      this.inTransaction = false;
      this._txStatus = "I";
      this.checkedOut = true;
      clients.push(this);
    }

    async query(text, values = []) {
      const sql = String(text);
      calls.push({
        sql,
        values: [...values],
        sessionUser: this.sessionUser,
        currentUser: this.currentUser,
        inTransaction: this.inTransaction,
        transactionStatus: this._txStatus
      });
      if (sql === "BEGIN") {
        this.inTransaction = true;
        if (options.transactionStatusAfterBegin === "absent") {
          delete this._txStatus;
        } else {
          this._txStatus = options.transactionStatusAfterBegin ?? "T";
        }
        return { rows: [] };
      }
      if (sql.startsWith("SET LOCAL ROLE")) {
        if (options.migratorRoleActivationFails) throw postgresError("42501");
        this.currentUser = MIGRATOR_ROLE;
        return { rows: [] };
      }
      if (sql === "COMMIT" || sql === "ROLLBACK") {
        this.inTransaction = false;
        this._txStatus = "I";
        if (options.roleLeakAfterTransaction !== true) {
          this.currentUser = MIGRATION_LOGIN;
        }
        return { rows: [] };
      }
      if (sql.includes("AS direct_session_identity")) {
        return { rows: [{
          direct_session_identity: options.directSessionIdentity !== false &&
            this.sessionUser === MIGRATION_LOGIN,
          direct_current_identity: options.directCurrentIdentity !== false &&
            this.currentUser === MIGRATION_LOGIN,
          direct_superuser: options.directSuperuser === true,
          direct_bypassrls: options.directBypassRls === true,
          direct_createrole: options.directCreateRole === true,
          direct_can_set_migrator: options.directCanSetMigrator !== false,
          direct_inherits_migrator: options.directInheritsMigrator === true
        }] };
      }
      if (sql.includes("AS migrator_session_identity")) {
        return { rows: [{
          migrator_session_identity: this.sessionUser === MIGRATION_LOGIN,
          migrator_current_identity: this.currentUser === MIGRATOR_ROLE,
          migrator_schema_usage: options.migratorSchemaUsage === true
        }] };
      }
      if (sql.includes("AS relation_acl") && !sql.includes("AS runtime_insert")) {
        aclReads += 1;
        const mutation = options.aclMutationAfterDirectRefusal && aclReads > 1;
        return { rows: [
          {
            relation_name: "social_audit_events",
            direct_schema_usage: options.directSchemaUsage === true,
            schema_acl: "{synthetic_schema_acl}",
            relation_acl: mutation ? "{mutated_audit_acl}" : "{synthetic_audit_acl}"
          },
          {
            relation_name: "users",
            direct_schema_usage: options.directSchemaUsage === true,
            schema_acl: "{synthetic_schema_acl}",
            relation_acl: "{synthetic_users_acl}"
          }
        ] };
      }
      if (sql.includes("AS direct_runtime_insert")) {
        throw postgresError(options.directFailureCode || "42501");
      }
      if (sql.includes("AS direct_pool_usable")) {
        return { rows: [{
          direct_pool_usable: options.directPoolUsable !== false,
          direct_transaction_persisted: false
        }] };
      }
      if (sql.includes("AS relation_name") && sql.includes("AS runtime_insert")) {
        inventoryReads += 1;
        if (options.inventoryFailure) throw postgresError("synthetic_inventory_failure");
        return { rows: relationRows(this) };
      }
      throw new Error(`unexpected inventory query: ${sql}`);
    }

    release() {
      if (!this.checkedOut) return;
      this.checkedOut = false;
      available.push(this);
    }
  }

  const migration = {
    async connect() {
      const client = available.pop() || new Client();
      client.checkedOut = true;
      return client;
    }
  };
  return {
    state: { pools: { migration } },
    calls,
    clients,
    migration,
    authorizedClient() {
      const client = new Client();
      client.inTransaction = true;
      client._txStatus = "T";
      client.currentUser = MIGRATOR_ROLE;
      return client;
    },
    get inventoryReads() { return inventoryReads; }
  };
}

function createRlsDatabase(options = {}) {
  const companies = new Set();
  const users = new Set();
  const auditEvents = new Set();
  const calls = [];
  const releases = [];
  let inventoryCalls = 0;
  const key = (companyId, id) => `${companyId}:${id}`;

  class Client {
    constructor(kind) {
      this.kind = kind;
      this.companyId = null;
      this.invalidCompanyContext = false;
      this.manualScopeClient = false;
      this.inTransaction = false;
      this._txStatus = "I";
      this.sessionUser = kind === "migration" ? MIGRATION_LOGIN : RUNTIME_LOGIN;
      this.currentUser = this.sessionUser;
    }

    async query(text, values = []) {
      const sql = String(text);
      calls.push({
        kind: this.kind,
        sql,
        values: [...values],
        manualScopeClient: this.manualScopeClient
      });
      if (sql === "BEGIN") {
        this.inTransaction = true;
        this._txStatus = "T";
        return { rows: [] };
      }
      if (sql === "COMMIT" || sql === "ROLLBACK") {
        this.companyId = null;
        this.invalidCompanyContext = false;
        this.inTransaction = false;
        this._txStatus = "I";
        this.currentUser = this.sessionUser;
        return { rows: [] };
      }
      if (sql.startsWith("SET LOCAL ROLE")) {
        if (!sql.includes('"')) this.manualScopeClient = true;
        if (sql.includes(MIGRATOR_ROLE)) this.currentUser = MIGRATOR_ROLE;
        return { rows: [] };
      }
      if (sql.includes("set_config('ia4tube.company_id'")) {
        this.companyId = values[0];
        this.invalidCompanyContext = values[0] === "not-a-uuid";
        return { rows: [{ set_config: values[0] }] };
      }
      if (sql.includes("INSERT INTO ia4tube_social.companies")) {
        companies.add(values[0]);
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("INSERT INTO ia4tube_social.users")) {
        if (this.kind === "runtime") {
          if (options.persistUserOnRuntimeFailure) users.add(key(values[0], values[1]));
          throw postgresError(options.userInsertFailureCode || "42501");
        }
        users.add(key(values[0], values[1]));
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("INSERT INTO ia4tube_social.company_memberships")) {
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("INSERT INTO ia4tube_social.social_audit_events")) {
        if (this.kind !== "runtime" || values[0] !== this.companyId) {
          if (options.persistCrossBeforeFailure) auditEvents.add(key(values[0], values[1]));
          throw postgresError(options.crossWriteFailureCode || "42501");
        }
        auditEvents.add(key(values[0], values[1]));
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("FROM ia4tube_social.users WHERE company_id=$1 AND id=$2")) {
        return { rows: [{ n: users.has(key(values[0], values[1])) ? 1 : 0 }] };
      }
      if (sql.includes("FROM ia4tube_social.social_audit_events") && sql.includes("WHERE company_id=$1")) {
        const visible = this.companyId === values[0] && auditEvents.has(key(values[0], values[1]));
        return { rows: [{ n: visible ? 1 : 0 }] };
      }
      if (sql.includes("SELECT 1::integer AS n")) {
        return { rows: [{ n: options.runtimePoolReusable === false ? 0 : 1 }] };
      }
      if (sql.includes("FROM ia4tube_social.companies")) {
        if (this.invalidCompanyContext) throw postgresError("22P02");
        if (!sql.includes("WHERE id=$1")) return { rows: [{ n: 0 }] };
        const visible = options.connectionScopeLeaks === true && this.manualScopeClient
          ? companies.has(values[0])
          : this.companyId === values[0] && companies.has(values[0]);
        return { rows: [{ n: visible ? 1 : 0 }] };
      }
      if (sql.includes("AS relation_name") && sql.includes("AS runtime_insert")) {
        inventoryCalls += 1;
        const schemaAcl = "{synthetic_schema_acl}";
        return { rows: [
          {
            namespace_name: "ia4tube_social",
            namespace_oid: 5100,
            relation_name: "social_audit_events",
            relation_oid: 5101,
            relation_kind: "r",
            session_user_is_migration: this.sessionUser === MIGRATION_LOGIN,
            current_user_is_migrator: this.currentUser === MIGRATOR_ROLE,
            schema_usage: false,
            runtime_login_can_set_role: options.runtimeLoginCanSetRole !== false,
            runtime_login_insert: false,
            runtime_insert: options.auditInsertPrivilege !== false,
            social_audit_rls_enabled: options.auditRlsEnabled !== false,
            social_audit_force_rls: options.auditForceRls !== false,
            social_audit_policy_exists: options.auditPolicyExists !== false &&
              options.auditPolicyAppliesToRuntime !== false,
            social_audit_policy_using: options.auditPolicyUsing !== false,
            social_audit_policy_with_check: options.auditPolicyWithCheck !== false,
            social_audit_policy_company_bound: options.auditCompanyPolicy !== false &&
              options.auditPolicyCompanyBound !== false,
            schema_acl: schemaAcl,
            relation_acl: (options.mutatePrivilegeAfterRefusal === true ||
              options.mutateAclAfterRefusal === true) && inventoryCalls > 1
              ? "{mutated_audit_acl}"
              : "{synthetic_audit_acl}"
          },
          {
            namespace_name: "ia4tube_social",
            namespace_oid: 5100,
            relation_name: "users",
            relation_oid: 5102,
            relation_kind: "r",
            session_user_is_migration: this.sessionUser === MIGRATION_LOGIN,
            current_user_is_migrator: this.currentUser === MIGRATOR_ROLE,
            schema_usage: false,
            runtime_login_can_set_role: options.runtimeLoginCanSetRole !== false,
            runtime_login_insert: options.runtimeLoginUserInsertPrivilege === true,
            runtime_insert: options.userInsertPrivilege === true ||
              (options.mutatePrivilegeAfterRefusal === true && inventoryCalls > 1),
            social_audit_rls_enabled: false,
            social_audit_force_rls: false,
            social_audit_policy_exists: false,
            social_audit_policy_using: false,
            social_audit_policy_with_check: false,
            social_audit_policy_company_bound: false,
            schema_acl: schemaAcl,
            relation_acl: "{synthetic_users_acl}"
          }
        ] };
      }
      throw new Error(`unexpected synthetic query: ${sql}`);
    }

    release() {
      releases.push({ kind: this.kind, manualScopeClient: this.manualScopeClient });
      if (options.manualScopeReleaseFailure && this.manualScopeClient) {
        throw postgresError("release_cleanup_failed");
      }
    }
  }

  const migration = {
    async connect() { return new Client("migration"); },
    async query(text) {
      const sql = String(text);
      calls.push({ kind: "migration-pool", sql, values: [] });
      if (sql.includes("SELECT rolsuper")) {
        return { rows: [{
          rolsuper: false,
          rolbypassrls: false,
          rolcreatedb: false,
          rolcreaterole: false,
          rolreplication: false,
          migrator_member: false,
          migration_table_privilege: false,
          migration_schema_create: false
        }] };
      }
      throw new Error(`unexpected synthetic pool query: ${sql}`);
    }
  };
  const runtime = {
    async connect() { return new Client("runtime"); }
  };
  return {
    state: { pools: { migration, runtime } },
    calls,
    releases,
    companies,
    users,
    auditEvents
  };
}

function reproductionProof(overrides = {}) {
  return Object.freeze({
    runtimeWriteContractReproductionPassed: true,
    tenantSeedsCreatedByAdministrativeRole: true,
    runtimeCoreUserInsertPrivilege: false,
    runtimeCoreUserInsertRefused: true,
    runtimeCoreUserInsertPersisted: false,
    runtimePoolUsableAfterRefusal: true,
    runtimePrivilegesUnchanged: true,
    socialAuditEventInsertPrivilege: true,
    socialAuditEventsRlsProtected: true,
    oldGateLaterStagesReached: false,
    ...overrides
  });
}

test("runtime privilege inventory refuses a raw pool before any query", async () => {
  let queried = false;
  const rawPool = {
    async connect() { throw new Error("must not connect"); },
    async query() {
      queried = true;
      throw new Error("must not query");
    }
  };
  await assert.rejects(
    runtimeWritePrivilegeInventory(rawPool),
    { code: "linux_gate_rls_privilege_inventory_client_required" }
  );
  assert.equal(queried, false);
});

test("runtime privilege inventory refuses an isolated client without the private transaction authorization", async () => {
  const database = createInventoryContextDatabase();
  const client = database.authorizedClient();
  await assert.rejects(
    runtimeWritePrivilegeInventory(client),
    { code: "linux_gate_rls_privilege_inventory_transaction_client_required" }
  );
  assert.equal(database.inventoryReads, 0);
  client.release();
});

test("runtime privilege inventory refuses idle or missing physical transaction status", async () => {
  for (const transactionStatusAfterBegin of ["I", "absent"]) {
    const database = createInventoryContextDatabase({ transactionStatusAfterBegin });
    const substeps = [];
    await assert.rejects(
      runRlsPrivilegeInventoryContextReproduction(database.state, {
        async runSubstep(name, operation) {
          substeps.push(name);
          return operation();
        }
      }),
      { code: "linux_gate_rls_privilege_inventory_transaction_client_required" }
    );
    assert.equal(substeps.at(-1), "rls_inventory_migrator_privilege_read");
    assert.equal(database.inventoryReads, 0);
    assert.equal(database.calls.some((call) => call.sql === "ROLLBACK"), true);
  }
});

test("runtime privilege inventory refuses missing or duplicate catalog relations", async () => {
  for (const options of [
    { missingUsers: true },
    { missingAudit: true },
    { duplicateRelation: true }
  ]) {
    const database = createInventoryContextDatabase(options);
    await assert.rejects(
      runRlsPrivilegeInventoryContextReproduction(database.state, {
        runSubstep: (_name, operation) => operation()
      }),
      { code: "linux_gate_rls_privilege_inventory_relations_invalid" }
    );
  }
});

test("runtime privilege inventory refuses identity, schema, OID and relkind drift", async () => {
  for (const options of [
    { inventorySessionUserMigration: false },
    { inventoryCurrentUserMigrator: false },
    { inventorySchemaName: "unexpected_schema" },
    { userSchemaName: "unexpected_schema" },
    { userRelationKind: "v" },
    { inventoryNamespaceOid: 0 },
    { userNamespaceOid: 4103 },
    { userRelationOid: 0 },
    { userRelationOid: 4101 }
  ]) {
    const database = createInventoryContextDatabase(options);
    await assert.rejects(
      runRlsPrivilegeInventoryContextReproduction(database.state, {
        runSubstep: (_name, operation) => operation()
      }),
      { code: "linux_gate_rls_privilege_inventory_context_invalid" }
    );
  }
});

test("runtime privilege inventory refuses null or omitted negative users privileges", async () => {
  for (const options of [
    { userRuntimeLoginInsertRaw: null },
    { omitUserRuntimeLoginInsert: true },
    { userRuntimeInsertRaw: null },
    { omitUserRuntimeInsert: true }
  ]) {
    const database = createInventoryContextDatabase(options);
    const substeps = [];
    await assert.rejects(
      runRlsPrivilegeInventoryContextReproduction(database.state, {
        async runSubstep(name, operation) {
          substeps.push(name);
          return operation();
        }
      }),
      { code: "linux_gate_rls_core_user_insert_privilege_unexpected" }
    );
    assert.equal(substeps.at(-1), "rls_inventory_migrator_privilege_read");
    assert.equal(database.inventoryReads, 1);
  }
});

test("corrected inventory contains no textual regclass path outside the isolated negative proof", () => {
  const inventorySource = runtimeWritePrivilegeInventory.toString();
  assert.match(inventorySource, /pg_catalog\.pg_class/);
  assert.match(inventorySource, /pg_catalog\.pg_namespace/);
  assert.match(
    inventorySource,
    /has_schema_privilege\(current_user,namespace\.oid,'USAGE'\)/
  );
  assert.equal(
    (inventorySource.match(/has_table_privilege\(\$[34],relation\.oid,'INSERT'\)/g) || []).length,
    2
  );
  assert.match(inventorySource, /policy\.polrelid=relation\.oid/);
  assert.doesNotMatch(inventorySource, /::\s*regclass|to_regclass/i);
  assert.doesNotMatch(inventorySource, /pg_stat_activity|xact_start|query_start/);
  assert.doesNotMatch(
    inventorySource,
    /has_table_privilege\([^\n]*['"]ia4tube_social\.(?:users|social_audit_events)/
  );
  const fullSource = fs.readFileSync(
    path.join(ROOT, "scripts/social-3a0p-linux-physical-gates.js"),
    "utf8"
  );
  assert.equal((fullSource.match(/'ia4tube_social\.users'/g) || []).length, 1);
  assert.match(fullSource, /AS direct_runtime_insert/);
  assert.match(fullSource, /const AUTHORIZED_RLS_INVENTORY_CLIENTS = new WeakSet\(\)/);
  assert.match(fullSource, /AUTHORIZED_RLS_INVENTORY_CLIENTS\.add\(client\)/);
  assert.match(fullSource, /AUTHORIZED_RLS_INVENTORY_CLIENTS\.delete\(client\)/);
  assert.match(fullSource, /client\._txStatus !== "T"/);
});

test("inventory context reproduction closes direct refusal, migrator inventory, reset and ACL proof", async () => {
  const database = createInventoryContextDatabase();
  const substeps = [];
  const result = await runRlsPrivilegeInventoryContextReproduction(database.state, {
    async runSubstep(name, operation) {
      substeps.push(name);
      return operation();
    }
  });
  assert.deepEqual(result, inventoryContextProof());
  assert.deepEqual(Object.keys(result), Object.keys(inventoryContextProof()));
  assert.deepEqual(substeps, [
    "rls_inventory_direct_session_identity",
    "rls_inventory_direct_schema_access",
    "rls_inventory_direct_name_resolution_refusal",
    "rls_inventory_migrator_role_activation",
    "rls_inventory_migrator_privilege_read",
    "rls_inventory_role_reset"
  ]);
  assert.equal(database.inventoryReads, 1);
  const beginIndex = database.calls.findIndex((call) => call.sql === "BEGIN");
  const roleIndex = database.calls.findIndex((call) =>
    call.sql === `SET LOCAL ROLE "${MIGRATOR_ROLE}"`
  );
  const inventoryIndex = database.calls.findIndex((call) =>
    call.sql.includes("AS relation_name") && call.sql.includes("AS runtime_insert")
  );
  const commitIndex = database.calls.findIndex((call, index) =>
    index > inventoryIndex && call.sql === "COMMIT"
  );
  assert.ok(beginIndex >= 0 && beginIndex < roleIndex);
  assert.ok(roleIndex < inventoryIndex && inventoryIndex < commitIndex);
  assert.equal(database.calls[inventoryIndex].inTransaction, true);
  assert.equal(database.calls[inventoryIndex].transactionStatus, "T");
  assert.equal(database.calls[inventoryIndex].currentUser, MIGRATOR_ROLE);
  assert.deepEqual(database.calls[inventoryIndex].values, [
    MIGRATION_LOGIN,
    MIGRATOR_ROLE,
    RUNTIME_LOGIN,
    RUNTIME_ROLE
  ]);
  assert.equal(database.calls.some((call) =>
    call.sql.includes("AS direct_runtime_insert") && call.currentUser !== MIGRATION_LOGIN
  ), false);
  assert.equal(database.clients.every((client) =>
    client.inTransaction === false && client.currentUser === MIGRATION_LOGIN && client.checkedOut === false
  ), true);
  assert.equal(database.calls.some((call) =>
    /(?:^|\n)\s*(?:INSERT|UPDATE|DELETE|GRANT|REVOKE|ALTER|CREATE|DROP|TRUNCATE)\b/m.test(call.sql)
  ), false);
  const callCountAfterReproduction = database.calls.length;
  await assert.rejects(
    runtimeWritePrivilegeInventory(database.clients.at(-1)),
    { code: "linux_gate_rls_privilege_inventory_transaction_client_required" }
  );
  assert.equal(database.calls.length, callCountAfterReproduction);
});

test("OID inventory refuses every RLS and exact policy component divergence", async () => {
  for (const [options, code] of [
    [{ auditRlsEnabled: false }, "linux_gate_rls_social_audit_rls_disabled"],
    [{ auditForceRls: false }, "linux_gate_rls_social_audit_force_rls_disabled"],
    [{ auditPolicyExists: false }, "linux_gate_rls_social_audit_policy_missing"],
    [{ auditPolicyUsing: false }, "linux_gate_rls_social_audit_policy_using_missing"],
    [
      { auditPolicyWithCheck: false },
      "linux_gate_rls_social_audit_policy_with_check_missing"
    ],
    [
      { auditPolicyCompanyBound: false },
      "linux_gate_rls_social_audit_policy_company_scope_missing"
    ]
  ]) {
    const database = createInventoryContextDatabase(options);
    const substeps = [];
    await assert.rejects(
      runRlsPrivilegeInventoryContextReproduction(database.state, {
        async runSubstep(name, operation) {
          substeps.push(name);
          return operation();
        }
      }),
      { code }
    );
    assert.equal(substeps.at(-1), "rls_inventory_migrator_privilege_read");
  }
});

test("inventory context reproduction stops at each direct-session divergence", async () => {
  for (const [options, code, lastSubstep] of [
    [
      { directCanSetMigrator: false },
      "linux_gate_rls_inventory_direct_session_invalid",
      "rls_inventory_direct_session_identity"
    ],
    [
      { directSchemaUsage: true },
      "linux_gate_rls_inventory_direct_schema_access_unexpected",
      "rls_inventory_direct_schema_access"
    ],
    [
      { directFailureCode: "22P02" },
      "linux_gate_rls_inventory_direct_name_resolution_invalid",
      "rls_inventory_direct_name_resolution_refusal"
    ],
    [
      { directPoolUsable: false },
      "linux_gate_rls_inventory_direct_pool_state_invalid",
      "rls_inventory_direct_name_resolution_refusal"
    ]
  ]) {
    const database = createInventoryContextDatabase(options);
    const substeps = [];
    await assert.rejects(
      runRlsPrivilegeInventoryContextReproduction(database.state, {
        async runSubstep(name, operation) {
          substeps.push(name);
          return operation();
        }
      }),
      { code }
    );
    assert.equal(substeps.at(-1), lastSubstep);
    assert.equal(database.inventoryReads, 0);
    assert.equal(substeps.includes("rls_inventory_migrator_privilege_read"), false);
  }
});

test("unexpected schema USAGE under MIGRATOR_ROLE stops before the OID inventory and Gate 2", async () => {
  const database = createInventoryContextDatabase({ migratorSchemaUsage: true });
  const substeps = [];
  await assert.rejects(
    runRlsPrivilegeInventoryContextReproduction(database.state, {
      async runSubstep(name, operation) {
        substeps.push(name);
        return operation();
      }
    }),
    { code: "linux_gate_rls_inventory_migrator_schema_privilege_unexpected" }
  );
  assert.equal(substeps.at(-1), "rls_inventory_migrator_role_activation");
  assert.equal(substeps.includes("rls_inventory_migrator_privilege_read"), false);
  assert.equal(database.inventoryReads, 0);
  assert.equal(database.calls.some((call) => call.sql === "ROLLBACK"), true);
  assert.equal(database.clients.every((client) =>
    client.inTransaction === false && client.currentUser === MIGRATION_LOGIN
  ), true);
});

test("inventory exceptions roll back and reset the activated migrator role", async () => {
  const database = createInventoryContextDatabase({ inventoryFailure: true });
  const substeps = [];
  await assert.rejects(
    runRlsPrivilegeInventoryContextReproduction(database.state, {
      async runSubstep(name, operation) {
        substeps.push(name);
        return operation();
      }
    }),
    { code: "synthetic_inventory_failure" }
  );
  assert.equal(substeps.at(-1), "rls_inventory_migrator_privilege_read");
  assert.equal(database.calls.some((call) => call.sql === "ROLLBACK"), true);
  assert.equal(database.clients.every((client) =>
    client.inTransaction === false && client.currentUser === MIGRATION_LOGIN && client.checkedOut === false
  ), true);
});

test("inventory context reproduction rejects role leaks and ACL changes in its reset substep", async () => {
  for (const [options, code] of [
    [{ roleLeakAfterTransaction: true }, "linux_gate_rls_inventory_role_reset_invalid"],
    [{ aclMutationAfterDirectRefusal: true }, "linux_gate_rls_inventory_acl_changed"]
  ]) {
    const database = createInventoryContextDatabase(options);
    const substeps = [];
    await assert.rejects(
      runRlsPrivilegeInventoryContextReproduction(database.state, {
        async runSubstep(name, operation) {
          substeps.push(name);
          return operation();
        }
      }),
      { code }
    );
    assert.equal(substeps.at(-1), "rls_inventory_role_reset");
  }
});

test("old runtime write contract reproduces 42501 before every corrected write stage", async () => {
  const database = createRlsDatabase();
  const substeps = [];
  const result = await runRlsRuntimeWriteContractReproduction(database.state, {
    inventoryContextReproduction: inventoryContextProof(),
    legacyFailureCode,
    async runSubstep(name, operation) {
      substeps.push(name);
      return operation();
    }
  });
  assert.deepEqual(result, reproductionProof());
  assert.deepEqual(substeps, [
    "rls_seed_tenants",
    "rls_inventory_migrator_privilege_read",
    "rls_core_user_insert_reproduction",
    "rls_core_user_insert_refusal",
    "rls_inventory_migrator_privilege_read"
  ]);
  const runtimeUserWrites = database.calls.filter((call) =>
    call.kind === "runtime" && call.sql.includes("INSERT INTO ia4tube_social.users")
  );
  assert.equal(runtimeUserWrites.length, 1);
  assert.equal(database.calls.some((call) =>
    call.sql.includes("INSERT INTO ia4tube_social.social_audit_events")
  ), false);
  assert.equal(database.users.size, 2);
  assert.equal(database.calls.filter((call) => call.sql === "ROLLBACK").length, 1);
  assert.equal(database.calls.some((call) => call.sql.includes("SELECT 1::integer AS n")), true);
});

test("reproduction stops before the old insert when runtime unexpectedly owns users INSERT", async () => {
  const database = createRlsDatabase({ userInsertPrivilege: true });
  const substeps = [];
  await assert.rejects(
    runRlsRuntimeWriteContractReproduction(database.state, {
      inventoryContextReproduction: inventoryContextProof(),
      legacyFailureCode,
      async runSubstep(name, operation) {
        substeps.push(name);
        return operation();
      }
    }),
    { code: "linux_gate_rls_core_user_insert_privilege_unexpected" }
  );
  assert.deepEqual(substeps, ["rls_seed_tenants", "rls_inventory_migrator_privilege_read"]);
  assert.equal(database.calls.some((call) =>
    call.kind === "runtime" && call.sql.includes("INSERT INTO ia4tube_social.users")
  ), false);
});

test("privilege inventory seals SET ROLE and refuses direct login identity writes", async () => {
  for (const [options, code] of [
    [{ runtimeLoginCanSetRole: false }, "linux_gate_rls_runtime_role_set_missing"],
    [{ runtimeLoginUserInsertPrivilege: true }, "linux_gate_rls_core_user_insert_privilege_unexpected"]
  ]) {
    const database = createRlsDatabase(options);
    await assert.rejects(
      runRlsRuntimeWriteContractReproduction(database.state, {
        inventoryContextReproduction: inventoryContextProof(),
        legacyFailureCode,
        runSubstep: (_name, operation) => operation()
      }),
      { code }
    );
    assert.equal(database.calls.some((call) =>
      call.kind === "runtime" && call.sql.includes("INSERT INTO ia4tube_social.users")
    ), false);
  }
});

test("privilege inventory pins the exact audit policy and both tenant expressions", () => {
  const source = fs.readFileSync(
    path.join(ROOT, "scripts/social-3a0p-linux-physical-gates.js"),
    "utf8"
  );
  assert.match(source, /policy\.polname='social_audit_events_company_scope'/);
  assert.match(source, /policy\.polroles=ARRAY\[0::oid\]/);
  assert.match(source, /pg_get_expr\(policy\.polqual,policy\.polrelid\)/);
  assert.match(source, /pg_get_expr\(policy\.polwithcheck,policy\.polrelid\)/);
  assert.equal((source.match(/\/length\('company_id'\)>=2/g) || []).length, 2);
  assert.match(source, /position\('ia4tube\.company_id'/);
});

test("reproduction fails closed when users refusal or audit write surface diverges", async () => {
  for (const [options, code] of [
    [{ userInsertFailureCode: "23505" }, "linux_gate_rls_core_user_insert_reproduction_invalid"],
    [{ auditInsertPrivilege: false }, "linux_gate_rls_social_audit_insert_privilege_missing"],
    [{ auditRlsEnabled: false }, "linux_gate_rls_social_audit_rls_disabled"],
    [{ auditForceRls: false }, "linux_gate_rls_social_audit_force_rls_disabled"],
    [{ auditPolicyExists: false }, "linux_gate_rls_social_audit_policy_missing"],
    [{ auditPolicyUsing: false }, "linux_gate_rls_social_audit_policy_using_missing"],
    [
      { auditPolicyWithCheck: false },
      "linux_gate_rls_social_audit_policy_with_check_missing"
    ],
    [
      { auditPolicyCompanyBound: false },
      "linux_gate_rls_social_audit_policy_company_scope_missing"
    ],
    [{ auditPolicyAppliesToRuntime: false }, "linux_gate_rls_social_audit_policy_missing"]
  ]) {
    const database = createRlsDatabase(options);
    await assert.rejects(
      runRlsRuntimeWriteContractReproduction(database.state, {
        inventoryContextReproduction: inventoryContextProof(),
        legacyFailureCode,
        runSubstep: (_name, operation) => operation()
      }),
      { code }
    );
    assert.equal(database.calls.some((call) =>
      call.sql.includes("INSERT INTO ia4tube_social.social_audit_events")
    ), false);
  }
});

test("every post-insert reproduction failure retains its exact closed substep", async () => {
  for (const [options, code, lastSubstep] of [
    [{ persistUserOnRuntimeFailure: true }, "linux_gate_rls_core_user_insert_persisted", "rls_core_user_insert_refusal"],
    [{ runtimePoolReusable: false }, "linux_gate_rls_runtime_pool_unusable_after_refusal", "rls_core_user_insert_refusal"],
    [
      { mutatePrivilegeAfterRefusal: true },
      "linux_gate_rls_core_user_insert_privilege_unexpected",
      "rls_inventory_migrator_privilege_read"
    ],
    [
      { mutateAclAfterRefusal: true },
      "linux_gate_rls_runtime_privilege_changed",
      "rls_inventory_migrator_privilege_read"
    ]
  ]) {
    const database = createRlsDatabase(options);
    const substeps = [];
    await assert.rejects(
      runRlsRuntimeWriteContractReproduction(database.state, {
        inventoryContextReproduction: inventoryContextProof(),
        legacyFailureCode,
        async runSubstep(name, operation) {
          substeps.push(name);
          return operation();
        }
      }),
      { code }
    );
    assert.equal(substeps.at(-1), lastSubstep);
    assert.equal(substeps.includes("rls_own_social_write"), false);
  }
});

test("reproduction requires the old numeric SQLSTATE classification in the physical substep", async () => {
  for (const classifier of [undefined, () => "postgres_insufficient_privilege"]) {
    const database = createRlsDatabase();
    const substeps = [];
    await assert.rejects(
      runRlsRuntimeWriteContractReproduction(database.state, {
        inventoryContextReproduction: inventoryContextProof(),
        legacyFailureCode: classifier,
        async runSubstep(name, operation) {
          substeps.push(name);
          return operation();
        }
      }),
      { code: "linux_gate_rls_legacy_failure_classification_invalid" }
    );
    assert.equal(substeps.at(-1), "rls_core_user_insert_reproduction");
  }
});

test("corrected RLS gate has no fallback around base or reproduction prerequisites", async () => {
  const runSubstep = (_name, operation) => operation();
  const baseMissing = createRlsDatabase();
  await assert.rejects(
    runRlsAndRoleGate(baseMissing.state, { runSubstep, reproduction: reproductionProof() }),
    { code: "linux_gate_rls_base_gate_prerequisite_missing" }
  );
  assert.equal(baseMissing.calls.length, 0);
  for (const reproduction of [
    undefined,
    reproductionProof({ runtimeCoreUserInsertRefused: false })
  ]) {
    const database = createRlsDatabase();
    const substeps = [];
    await assert.rejects(
      runRlsAndRoleGate(database.state, {
        baseRlsGatePassed: true,
        reproduction,
        async runSubstep(name, operation) {
          substeps.push(name);
          return operation();
        }
      }),
      { code: "linux_gate_rls_runtime_write_reproduction_required" }
    );
    assert.deepEqual(substeps, ["rls_seed_tenants", "rls_core_user_insert_refusal"]);
    assert.equal(database.calls.some((call) =>
      call.sql.includes("INSERT INTO ia4tube_social.social_audit_events")
    ), false);
  }
});

test("corrected RLS gate writes own audit events and rejects both cross-tenant directions", async () => {
  const database = createRlsDatabase();
  const substeps = [];
  const result = await runRlsAndRoleGate(database.state, {
    baseRlsGatePassed: true,
    reproduction: reproductionProof(),
    async runSubstep(name, operation) {
      substeps.push(name);
      return operation();
    }
  });
  assert.deepEqual(substeps, [
    "rls_seed_tenants",
    "rls_core_user_insert_refusal",
    "rls_bidirectional_read",
    "rls_missing_context",
    "rls_tampered_context",
    "rls_own_social_write",
    "rls_cross_tenant_write",
    "rls_connection_scope_reset",
    "rls_runtime_role_attributes"
  ]);
  assert.deepEqual(result, {
    baseRlsGatePassed: true,
    tenantSeedsCreatedByAdministrativeRole: true,
    runtimeCoreUserInsertPrivilege: false,
    runtimeCoreUserInsertRefused: true,
    runtimeCoreUserInsertPersisted: false,
    companyAOwnRead: true,
    companyBOwnRead: true,
    companyAToBReadRefused: true,
    companyBToAReadRefused: true,
    companyAOwnSocialWrite: true,
    companyBOwnSocialWrite: true,
    companyAToBWriteRefused: true,
    companyBToAWriteRefused: true,
    crossTenantRowsPersisted: false,
    missingContextZeroRows: true,
    tamperedContextRefused: true,
    connectionScopeReset: true,
    runtimeSuperuser: false,
    runtimeBypassRls: false,
    runtimeCreateDb: false,
    runtimeCreateRole: false,
    runtimeMigrationPrivileges: false
  });
  assert.equal(Object.keys(result).length, 22);
  assert.equal(database.auditEvents.size, 2);
  assert.equal(database.calls.filter((call) =>
    call.kind === "runtime" && call.sql.includes("INSERT INTO ia4tube_social.social_audit_events")
  ).length, 4);
  assert.equal(database.calls.some((call) =>
    call.kind === "runtime" && call.sql.includes("INSERT INTO ia4tube_social.users")
  ), false);
});

test("corrected RLS gate detects any cross-tenant event that remains persisted", async () => {
  const database = createRlsDatabase({ persistCrossBeforeFailure: true });
  await assert.rejects(
    runRlsAndRoleGate(database.state, {
      baseRlsGatePassed: true,
      reproduction: reproductionProof(),
      runSubstep: (_name, operation) => operation()
    }),
    { code: "linux_gate_rls_cross_write_persisted" }
  );
});

test("connection reset preserves a primary failure while still attempting release", async () => {
  const database = createRlsDatabase({
    connectionScopeLeaks: true,
    manualScopeReleaseFailure: true
  });
  const substeps = [];
  await assert.rejects(
    runRlsAndRoleGate(database.state, {
      baseRlsGatePassed: true,
      reproduction: reproductionProof(),
      async runSubstep(name, operation) {
        substeps.push(name);
        return operation();
      }
    }),
    { code: "linux_gate_rls_connection_context_leaked" }
  );
  assert.equal(substeps.at(-1), "rls_connection_scope_reset");
  assert.equal(database.releases.filter((entry) => entry.manualScopeClient).length, 1);
  assert.equal(database.calls.some((call) =>
    call.kind === "runtime" && call.sql === "ROLLBACK" && call.manualScopeClient
  ), true);
});

test("connection reset propagates a release-only failure from its closed substep", async () => {
  const database = createRlsDatabase({ manualScopeReleaseFailure: true });
  const substeps = [];
  await assert.rejects(
    runRlsAndRoleGate(database.state, {
      baseRlsGatePassed: true,
      reproduction: reproductionProof(),
      async runSubstep(name, operation) {
        substeps.push(name);
        return operation();
      }
    }),
    { code: "release_cleanup_failed" }
  );
  assert.equal(substeps.at(-1), "rls_connection_scope_reset");
  assert.equal(database.releases.filter((entry) => entry.manualScopeClient).length, 1);
});

test("synthetic tenant context is locally derived and contains no external account", () => {
  const identityKey = Buffer.alloc(32, 7);
  const ids = [
    "00000000-0000-4000-8000-000000000001",
    "00000000-0000-4000-8000-000000000002",
    "00000000-0000-4000-8000-000000000003",
    "00000000-0000-4000-8000-000000000004",
    "00000000-0000-4000-8000-000000000005",
    "00000000-0000-4000-8000-000000000006",
    "00000000-0000-4000-8000-000000000007",
    "00000000-0000-4000-8000-000000000008",
    "00000000-0000-4000-8000-000000000009"
  ];
  const tenant = createTenant("test-tenant", {
    identityKey,
    randomUUID: () => ids.shift()
  });
  assert.equal(tenant.context.provider, "instagram");
  assert.equal(tenant.context.environment, "test");
  assert.equal(tenant.context.companyId, tenant.fixture.companyId);
  assert.equal(tenant.context.userId, tenant.fixture.userId);
  assert.equal(Object.hasOwn(tenant.fixture, "accessToken"), false);
  identityKey.fill(0);
});

test("local verifier maps a verified synthetic TLS identity only to loopback", () => {
  const seen = [];
  class FakePool {
    constructor(configuration) {
      seen.push(configuration);
      return configuration;
    }
  }
  const passwords = {
    ia4tube_social_local_migration: "m".repeat(48),
    ia4tube_social_local_runtime: "r".repeat(48)
  };
  const LocalPool = createLocalVerifierPoolClass({
    PoolClass: FakePool,
    port: 49152,
    database: "ia4tube_social_local",
    passwords
  });
  const url = new URL("postgresql://local.ia4tube.invalid:49152/ia4tube_social_local");
  url.username = "ia4tube_social_local_runtime";
  url.password = passwords.ia4tube_social_local_runtime;
  const mapped = new LocalPool({
    connectionString: url.toString(),
    ssl: { rejectUnauthorized: true, servername: "local.ia4tube.invalid" },
    max: 2
  });
  assert.equal(mapped.host, "127.0.0.1");
  assert.equal(mapped.port, 49152);
  assert.equal(mapped.ssl, false);
  const bad = new URL(url);
  bad.hostname = "external.invalid";
  assert.throws(() => new LocalPool({
    connectionString: bad.toString(),
    ssl: { rejectUnauthorized: true, servername: "external.invalid" },
    max: 2
  }));
  assert.equal(seen.length, 1);
});

test("database plaintext probe is parameterized and never interpolates the marker", async () => {
  const marker = `synthetic-${crypto.randomBytes(24).toString("hex")}`;
  let call;
  const client = {
    async query(text, values) {
      if (String(text).includes("SELECT (")) {
        call = { text, values };
        return { rows: [{ present: false }] };
      }
      return { rows: [] };
    },
    release() {}
  };
  const pool = {
    async connect() { return client; }
  };
  const companyId = crypto.randomUUID();
  assert.equal(await databaseContainsMarker(pool, marker, companyId), false);
  assert.equal(call.text.includes(marker), false);
  assert.deepEqual(call.values, [marker]);
  assert.match(call.text, /social_encrypted_credentials/);
  assert.doesNotMatch(call.text, /social_credentials\b/);
});

test("vault supplemental gate proves connection and AAD binding without persistence", async () => {
  const markers = [];
  const state = { materials: { vault: Buffer.alloc(32, 11) } };
  const result = await runVaultSupplementalGate(state, markers);
  assert.deepEqual(result, {
    algorithm: "AES-256-GCM",
    aadBound: true,
    companyChangeRefused: true,
    providerChangeRefused: true,
    connectionChangeRefused: true,
    ciphertextTamperRefused: true,
    aadTamperRefused: true
  });
  assert.equal(markers.length, 1);
  assert.match(markers[0], /^synthetic-linux-token-/);
  state.materials.vault.fill(0);
  markers[0] = "";
});

test("Linux physical adapter contains no provider endpoint, customer data or real OAuth path", () => {
  const source = fs.readFileSync(path.join(ROOT, "scripts/social-3a0p-linux-physical-gates.js"), "utf8");
  assert.doesNotMatch(source, /graph\.facebook\.com|api\.instagram\.com|instagram\.com\/oauth/i);
  assert.doesNotMatch(source, /\b(?:119|customer|cliente_real|production_token)\b/i);
  assert.doesNotMatch(source, /\b(?:fetch|axios|undici|https?\.request)\s*\(/);
  assert.doesNotMatch(source, /currentLegacyDependencies|legacyDependencies:\s*current/);
  assert.match(source, /legacy2ARoot/);
  const runtimeIsolation = source.indexOf("gate.verifiers.verifyRuntimeIsolation()");
  const persistedVault = source.indexOf("gate.verifiers.verifyVault()");
  assert.ok(runtimeIsolation >= 0 && persistedVault > runtimeIsolation);
});
