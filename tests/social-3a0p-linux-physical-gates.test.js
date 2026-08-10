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
  runConcurrencyOAuthIdempotencyGate,
  runRlsAndRoleGate,
  runRlsPrivilegeInventoryContextReproduction,
  runRlsRuntimeWriteContractReproduction,
  runRuntimeAttributesTextResolutionReproduction,
  runVaultSupplementalGate,
  runtimeWritePrivilegeInventory
} = require("../scripts/social-3a0p-linux-physical-gates");

const ROOT = path.resolve(__dirname, "..");
const MIGRATION_LOGIN = "ia4tube_social_local_migration";
const MIGRATOR_ROLE = "ia4tube_social_migrator";
const OWNER_ROLE = "ia4tube_social_owner";
const RUNTIME_LOGIN = "ia4tube_social_local_runtime";
const RUNTIME_ROLE = "ia4tube_social_runtime";

const SUPPLEMENTAL_GATE3_SUBSTEPS = Object.freeze([
  ["S1", "supplemental_tenant_create", "internal_setup"],
  ["S2", "supplemental_tenant_a_seed", "postgres_transaction"],
  ["S3", "supplemental_tenant_b_seed", "postgres_transaction"],
  ["S4", "supplemental_connector_store_setup", "internal_setup"],
  ["S5", "supplemental_connection_reservation_race", "postgres_concurrent_transactions"],
  ["S6", "supplemental_connection_reservation_validation", "internal_validation"],
  ["S7", "supplemental_blocking_connection_inventory", "postgres_inventory"],
  ["S8", "supplemental_oauth_repository_material_setup", "internal_setup"],
  ["S9", "supplemental_oauth_authorization_create", "postgres_transaction"],
  ["S10", "supplemental_oauth_consume_race", "postgres_concurrent_transactions"],
  ["S11", "supplemental_oauth_consume_validation", "internal_validation"],
  ["S12", "supplemental_oauth_replay_cross_tenant", "postgres_concurrent_transactions"],
  ["S13", "supplemental_expired_oauth_material_setup", "internal_setup"],
  ["S14", "supplemental_expired_oauth_create", "postgres_transaction"],
  ["S15", "supplemental_oauth_force_expiry", "postgres_transaction"],
  ["S16", "supplemental_expired_oauth_consume", "postgres_transaction"],
  ["S17", "supplemental_plaintext_absence_inventory", "postgres_inventory"],
  ["S18", "supplemental_winner_disconnect", "postgres_transaction"],
  ["S19", "supplemental_connected_tenant_a_seed", "postgres_transaction"],
  ["S20", "supplemental_connected_tenant_b_seed", "postgres_transaction"],
  ["S21", "supplemental_publication_material_setup", "internal_setup"],
  ["S22", "supplemental_publication_idempotency_race", "postgres_concurrent_transactions"],
  ["S23", "supplemental_publication_race_validation", "internal_validation"],
  ["S24", "supplemental_publication_complete", "postgres_transaction"],
  ["S25", "supplemental_publication_replay", "postgres_transaction"],
  ["S26", "supplemental_publication_changed_hash_refusal", "postgres_transaction"],
  ["S27", "supplemental_publication_cross_tenant_key", "postgres_transaction"],
  ["S28", "supplemental_publication_persistence_inventory", "postgres_inventory"],
  ["S29", "supplemental_final_assertion_result", "internal_validation"],
  ["S30", "supplemental_identity_key_zeroing", "memory_cleanup"]
]);

const SUPPLEMENTAL_GATE3_RESULT = Object.freeze({
  connectionReservationsConcurrent: 2,
  blockingConnections: 1,
  secondConnectionConflict: true,
  oauthSingleConsumer: true,
  oauthSecondConsumeRefused: true,
  oauthReplayRefused: true,
  oauthExpiredRefused: true,
  oauthCrossCompanyRefused: true,
  oauthPlaintextAbsent: true,
  sameRequestReused: true,
  changedHashConflict: true,
  crossTenantKeyAccepted: true,
  publicationRows: 1,
  duplicateAttempts: 0,
  externalCalls: 0
});

function postgresError(code) {
  return Object.assign(new Error("synthetic postgres refusal"), { code });
}

function legacyFailureCode(error) {
  const candidate = String(error?.code || error?.message || "");
  return /^[a-z][a-z0-9_]{2,119}$/.test(candidate)
    ? candidate
    : "linux_gate_unclassified_failure";
}

async function withSupplementalGate3Doubles(operation, options = {}) {
  const poolModule = require("../src/persistence/postgres/pool");
  const connectorModule = require("../src/persistence/postgres/social-connector-store");
  const oauthModule = require("../src/persistence/postgres/social-oauth-repository");
  const originals = {
    withTransaction: poolModule.withTransaction,
    createPostgresConnectorStore: connectorModule.createPostgresConnectorStore,
    createPostgresOAuthRepository: oauthModule.createPostgresOAuthRepository,
    randomBytes: crypto.randomBytes,
    now: Date.now
  };
  const observations = {
    transactions: [],
    queries: [],
    connectorCalls: [],
    oauthCalls: []
  };
  const snapshot = (value) => JSON.parse(JSON.stringify(value));
  const postgresRefusal = (code) => Object.assign(new Error("synthetic refusal"), { code });
  const state = {
    pools: {
      migration: Object.freeze({ label: "migration" }),
      runtime: Object.freeze({ label: "runtime" })
    }
  };
  let winningConnectionId;
  let reservationCall = 0;
  let connectorScope = 0;
  let oauthConsumeCall = 0;
  let oauthScope = 0;
  let publicationRaceCall = 0;
  let publicationCompleted = false;
  let randomCall = 0;

  poolModule.withTransaction = async (pool, callback, transactionOptions = {}) => {
    observations.transactions.push({
      pool: pool === state.pools.migration ? "migration" : "runtime",
      options: snapshot(transactionOptions)
    });
    const client = {
      async query(text, values = []) {
        const sql = String(text);
        observations.queries.push({ text: sql, values: snapshot(values) });
        if (sql.includes("SELECT id::text AS id FROM ia4tube_social.social_connections")) {
          return { rows: [{ id: winningConnectionId }] };
        }
        if (sql.includes(") AS present")) return { rows: [{ present: false }] };
        if (sql.includes("AS publications,")) {
          return { rows: [{ publications: 1, attempts: 0 }] };
        }
        return { rows: [] };
      }
    };
    return callback(client);
  };
  connectorModule.createPostgresConnectorStore = () => ({
    scope(context) {
      const tenant = connectorScope++ === 0 ? "a" : "b";
      return Object.freeze({
        async saveConnection(record, expectedRevision) {
          observations.connectorCalls.push({
            method: "saveConnection",
            tenant,
            arguments: snapshot([record, expectedRevision])
          });
          if (record.state === "authorization_pending") {
            reservationCall += 1;
            if (reservationCall === 1) {
              winningConnectionId = record.id;
              return Object.freeze({ ...record });
            }
            throw postgresRefusal("state_transition_invalid");
          }
          return Object.freeze({ ...record });
        },
        async beginIdempotency(input) {
          observations.connectorCalls.push({
            method: "beginIdempotency",
            tenant,
            arguments: snapshot([input])
          });
          if (tenant === "b") return Object.freeze({ status: "acquired" });
          if (input.digest === "f".repeat(64)) throw postgresRefusal("idempotency_conflict");
          if (publicationCompleted) return Object.freeze({ status: "completed" });
          publicationRaceCall += 1;
          return Object.freeze({ status: publicationRaceCall === 1 ? "acquired" : "pending" });
        },
        async completeIdempotency(input) {
          observations.connectorCalls.push({
            method: "completeIdempotency",
            tenant,
            arguments: snapshot([input])
          });
          publicationCompleted = true;
          return true;
        }
      });
    }
  });
  oauthModule.createPostgresOAuthRepository = () => ({
    scope(context) {
      const tenant = oauthScope++ === 0 ? "a" : "b";
      return Object.freeze({
        async createAuthorization(input) {
          observations.oauthCalls.push({
            method: "createAuthorization",
            tenant,
            arguments: snapshot([input])
          });
          return true;
        },
        async consumeAuthorization(input) {
          observations.oauthCalls.push({
            method: "consumeAuthorization",
            tenant,
            arguments: snapshot([input])
          });
          oauthConsumeCall += 1;
          if (oauthConsumeCall === 1) return Object.freeze({ status: "consumed" });
          throw postgresRefusal("authorization_expired");
        }
      });
    }
  });
  crypto.randomBytes = (size) => Buffer.alloc(size, ++randomCall);
  Date.now = () => 1_800_000_000_000;

  try {
    const identityKey = options.identityKey || Buffer.alloc(32, 0x5a);
    let uuid = 0;
    const dependencies = {
      identityKey,
      randomUUID() {
        uuid += 1;
        return `00000000-0000-4000-8000-${String(uuid).padStart(12, "0")}`;
      }
    };
    const sensitiveMarkers = [];
    const value = await operation({
      state,
      dependencies,
      sensitiveMarkers,
      identityKey,
      observations
    });
    return value;
  } finally {
    poolModule.withTransaction = originals.withTransaction;
    connectorModule.createPostgresConnectorStore = originals.createPostgresConnectorStore;
    oauthModule.createPostgresOAuthRepository = originals.createPostgresOAuthRepository;
    crypto.randomBytes = originals.randomBytes;
    Date.now = originals.now;
  }
}

async function executeSupplementalGate3(options = {}) {
  return withSupplementalGate3Doubles(async (fixture) => {
    const runnerCalls = [];
    const operationCounts = new Map();
    const dependencies = { ...fixture.dependencies };
    if (options.runGate3Substep) {
      dependencies.runGate3Substep = async (substep, operationClass, operation) => {
        runnerCalls.push({ substep, operationClass });
        const countedOperation = async () => {
          operationCounts.set(substep, (operationCounts.get(substep) || 0) + 1);
          return operation();
        };
        return options.runGate3Substep(substep, operationClass, countedOperation);
      };
    }
    let result;
    let thrown;
    let didThrow = false;
    try {
      result = await runConcurrencyOAuthIdempotencyGate(
        fixture.state,
        fixture.sensitiveMarkers,
        dependencies
      );
    } catch (error) {
      didThrow = true;
      thrown = error;
    }
    return {
      ...fixture,
      result,
      thrown,
      didThrow,
      runnerCalls,
      operationCounts
    };
  }, options);
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

function createRuntimeAttributesDatabase(options = {}) {
  const calls = [];
  const clients = [];
  const available = [];
  const releaseErrors = [];
  let identityReads = 0;
  let textualReads = 0;
  let privilegeReads = 0;
  let catalogReads = 0;
  let releaseCalls = 0;
  let rollbackCalls = 0;

  const privilegeRow = () => {
    const row = {
      inventory_session_identity: options.inventorySessionIdentity !== false,
      inventory_current_identity: options.inventoryCurrentIdentity !== false,
      runtime_login_superuser: false,
      runtime_login_bypassrls: false,
      runtime_login_createdb: false,
      runtime_login_createrole: false,
      runtime_login_replication: false,
      runtime_role_superuser: false,
      runtime_role_bypassrls: false,
      runtime_role_createdb: false,
      runtime_role_createrole: false,
      runtime_role_replication: false,
      runtime_login_migrator_member: false,
      runtime_role_migrator_member: false,
      runtime_login_owner_member: false,
      runtime_role_owner_member: false,
      runtime_login_schema_usage: false,
      runtime_role_schema_usage: false,
      runtime_login_schema_create: false,
      runtime_role_schema_create: false,
      runtime_login_table_select: false,
      runtime_login_table_insert: false,
      runtime_login_table_update: false,
      runtime_login_table_delete: false,
      runtime_login_table_truncate: false,
      runtime_login_table_references: false,
      runtime_login_table_trigger: false,
      runtime_login_table_maintain: false,
      runtime_role_table_select: false,
      runtime_role_table_insert: false,
      runtime_role_table_update: false,
      runtime_role_table_delete: false,
      runtime_role_table_truncate: false,
      runtime_role_table_references: false,
      runtime_role_table_trigger: false,
      runtime_role_table_maintain: false,
      ...(options.privilegeOverrides || {})
    };
    if (options.omitPrivilegeField) delete row[options.omitPrivilegeField];
    return row;
  };

  const roleRows = () => {
    const rows = [
      { role_name: MIGRATOR_ROLE, role_oid: 6104 },
      { role_name: OWNER_ROLE, role_oid: 6105 },
      { role_name: RUNTIME_LOGIN, role_oid: 6101 },
      { role_name: RUNTIME_ROLE, role_oid: 6103 }
    ];
    if (options.missingRole) return rows.filter((row) => row.role_name !== options.missingRole);
    if (options.duplicateRole) return [...rows, { ...rows[0] }];
    if (Object.hasOwn(options, "invalidRoleOid")) rows[0].role_oid = options.invalidRoleOid;
    if (options.duplicateRoleOid) rows[1].role_oid = rows[0].role_oid;
    if (options.unexpectedRoleName) rows[0].role_name = options.unexpectedRoleName;
    return rows;
  };

  class Client {
    constructor() {
      this.sessionUser = MIGRATION_LOGIN;
      this.currentUser = MIGRATION_LOGIN;
      if (options.initialTransactionStatus !== "absent") {
        this._txStatus = options.initialTransactionStatus ?? "I";
      }
      this.checkedOut = true;
      clients.push(this);
    }

    async query(text, values = []) {
      const sql = String(text);
      calls.push({
        sql,
        values: [...values],
        transactionStatus: this._txStatus,
        sessionUser: this.sessionUser,
        currentUser: this.currentUser
      });
      if (sql === "ROLLBACK") {
        rollbackCalls += 1;
        this._txStatus = "I";
        if (options.rollbackFailureCode) throw postgresError(options.rollbackFailureCode);
        return { rows: [] };
      }
      if (sql.includes("AS direct_session_identity")) {
        identityReads += 1;
        const row = {
          direct_session_identity: options.directSessionIdentity !== false,
          direct_current_identity: options.directCurrentIdentity !== false &&
            !(options.resetIdentityDrift === true && identityReads >= 3),
          direct_inherits_migrator: options.directInheritsMigrator === true,
          direct_schema_usage: options.directSchemaUsage === true
        };
        if (options.omitDirectIdentityField) delete row[options.omitDirectIdentityField];
        return { rows: [row] };
      }
      if (sql.includes("AS textual_runtime_privilege")) {
        textualReads += 1;
        if (options.afterTextTransactionStatus === "absent") {
          delete this._txStatus;
        } else if (options.afterTextTransactionStatus) {
          this._txStatus = options.afterTextTransactionStatus;
        }
        if (options.textualQueryReturns === true) {
          return { rows: [{ textual_runtime_privilege: false }] };
        }
        throw postgresError(options.textualFailureCode || "42501");
      }
      if (sql.includes("AS direct_pool_usable")) {
        return { rows: [{
          direct_pool_usable: options.directPoolUsable !== false,
          direct_transaction_persisted: options.directTransactionPersisted === true
        }] };
      }
      if (sql.includes("AS runtime_login_superuser")) {
        privilegeReads += 1;
        if (options.privilegeFailureCode) throw postgresError(options.privilegeFailureCode);
        if (options.missingPrivilegeRow) return { rows: [] };
        const row = privilegeRow();
        return { rows: options.duplicatePrivilegeRow ? [row, { ...row }] : [row] };
      }
      if (sql.includes("AS namespace_name") && sql.includes("AS relation_name")) {
        catalogReads += 1;
        if (options.missingSchema || options.missingRelation) return { rows: [] };
        const mutated = (options.mutateAclDuringText === true && textualReads > 0) ||
          (options.mutateAclAfterPrivilege === true && privilegeReads > 0);
        const row = {
          namespace_name: options.schemaName ?? "ia4tube_migrations",
          namespace_oid: options.schemaOid ?? 6100,
          relation_name: options.relationName ?? "schema_migrations",
          relation_oid: options.relationOid ?? 6101,
          relation_kind: options.relationKind ?? "r",
          schema_acl: mutated ? "{mutated_schema_acl}" : "{synthetic_schema_acl}",
          relation_acl: mutated ? "{mutated_relation_acl}" : "{synthetic_relation_acl}"
        };
        return {
          rows: options.duplicateSchema || options.duplicateRelation ? [row, { ...row }] : [row]
        };
      }
      if (sql.includes("AS namespace_name")) {
        catalogReads += 1;
        if (options.missingSchema) return { rows: [] };
        const mutated = (options.mutateAclDuringText === true && textualReads > 0) ||
          (options.mutateAclAfterPrivilege === true && privilegeReads > 0);
        const row = {
          namespace_name: options.schemaName ?? "ia4tube_migrations",
          namespace_oid: options.schemaOid ?? 6100,
          schema_acl: mutated ? "{mutated_schema_acl}" : "{synthetic_schema_acl}"
        };
        return { rows: options.duplicateSchema ? [row, { ...row }] : [row] };
      }
      if (sql.includes("AS relation_name")) {
        if (options.missingRelation) return { rows: [] };
        const mutated = (options.mutateAclDuringText === true && textualReads > 0) ||
          (options.mutateAclAfterPrivilege === true && privilegeReads > 0);
        const row = {
          relation_name: options.relationName ?? "schema_migrations",
          relation_oid: options.relationOid ?? 6101,
          relation_kind: options.relationKind ?? "r",
          relation_acl: mutated ? "{mutated_relation_acl}" : "{synthetic_relation_acl}"
        };
        return { rows: options.duplicateRelation ? [row, { ...row }] : [row] };
      }
      if (sql.includes("AS role_name")) {
        return { rows: roleRows() };
      }
      throw new Error(`unexpected runtime attributes query: ${sql}`);
    }

    release(error) {
      if (!this.checkedOut) return;
      releaseCalls += 1;
      releaseErrors.push(error?.code || null);
      this.checkedOut = false;
      if (options.releaseFailureAt === releaseCalls) {
        throw postgresError(options.releaseFailureCode || "runtime_attributes_release_failed");
      }
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
    releaseErrors,
    get catalogReads() { return catalogReads; },
    get identityReads() { return identityReads; },
    get privilegeReads() { return privilegeReads; },
    get releaseCalls() { return releaseCalls; },
    get rollbackCalls() { return rollbackCalls; },
    get textualReads() { return textualReads; }
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

function runtimeAttributesProof(overrides = {}) {
  return Object.freeze({
    runtimeLoginAttributesSafe: true,
    runtimeRoleAttributesSafe: true,
    runtimeLoginMigratorMember: false,
    runtimeRoleMigratorMember: false,
    runtimeLoginOwnerMember: false,
    runtimeRoleOwnerMember: false,
    runtimeLoginMigrationSchemaUsage: false,
    runtimeRoleMigrationSchemaUsage: false,
    runtimeLoginMigrationSchemaCreate: false,
    runtimeRoleMigrationSchemaCreate: false,
    runtimeLoginMigrationTablePrivileges: false,
    runtimeRoleMigrationTablePrivileges: false,
    migrationSchemaLocatedByOid: true,
    migrationLedgerLocatedByOid: true,
    textualResolutionUsed: false,
    aclUnchanged: true,
    ...overrides
  });
}

test("runtime attributes phase exposes the closed OID contract", () => {
  assert.equal(typeof runRuntimeAttributesTextResolutionReproduction, "function");
  assert.equal(Object.keys(runtimeAttributesProof()).length, 16);
});

test("runtime attributes phase reproduces textual 42501 before the exact OID inventory", async () => {
  const database = createRuntimeAttributesDatabase();
  const substeps = [];
  const result = await runRuntimeAttributesTextResolutionReproduction(database.state, {
    async runSubstep(name, operation) {
      substeps.push(name);
      return operation();
    }
  });
  assert.deepEqual(result, runtimeAttributesProof());
  assert.deepEqual(Object.keys(result), Object.keys(runtimeAttributesProof()));
  assert.deepEqual(substeps, [
    "rls_runtime_attributes_direct_identity",
    "rls_runtime_attributes_text_resolution_refusal",
    "rls_runtime_attributes_oid_catalog",
    "rls_runtime_attributes_oid_privileges",
    "rls_runtime_attributes_acl_reset"
  ]);
  assert.equal(database.textualReads, 1);
  assert.equal(database.privilegeReads, 1);
  assert.equal(database.identityReads, 3);
  const textualIndex = database.calls.findIndex((call) =>
    call.sql.includes("AS textual_runtime_privilege")
  );
  const oidIndex = database.calls.findIndex((call) =>
    call.sql.includes("AS runtime_login_superuser")
  );
  assert.ok(textualIndex >= 0 && textualIndex < oidIndex);
  const textual = database.calls[textualIndex];
  assert.deepEqual(textual.values, [RUNTIME_LOGIN]);
  assert.equal(textual.transactionStatus, "I");
  const oid = database.calls[oidIndex];
  assert.deepEqual(oid.values, [
    MIGRATION_LOGIN,
    "6100",
    "6101",
    "6101",
    "6103",
    "6104",
    "6105"
  ]);
  assert.match(oid.sql, /has_schema_privilege\(runtime_login\.oid,namespace\.oid,'USAGE'\)/);
  assert.match(oid.sql, /has_table_privilege\(runtime_role\.oid,relation\.oid,'MAINTAIN'\)/);
  assert.match(oid.sql, /pg_has_role\(runtime_role\.oid,owner_role\.oid,'MEMBER'\)/);
  assert.equal((oid.sql.match(/has_table_privilege\(/g) || []).length, 16);
  assert.equal((oid.sql.match(/has_schema_privilege\(/g) || []).length, 4);
  assert.equal((oid.sql.match(/pg_has_role\(/g) || []).length, 4);
  assert.doesNotMatch(oid.sql, /::\s*regclass|to_regclass|ia4tube_migrations\.schema_migrations/i);
  assert.equal(database.calls.some((call) =>
    /(?:^|\n)\s*(?:INSERT|UPDATE|DELETE|GRANT|REVOKE|ALTER|CREATE|DROP|TRUNCATE)\b/m.test(call.sql)
  ), false);
  assert.equal(database.clients.every((client) => client.checkedOut === false), true);
});

test("runtime attributes corrected path has one isolated textual relation and no fallback", () => {
  const source = fs.readFileSync(
    path.join(ROOT, "scripts/social-3a0p-linux-physical-gates.js"),
    "utf8"
  );
  assert.equal((source.match(/'ia4tube_migrations\.schema_migrations'/g) || []).length, 1);
  assert.equal((source.match(/AS textual_runtime_privilege/g) || []).length, 1);
  assert.doesNotMatch(source, /::\s*regclass|to_regclass/i);
  assert.match(source, /FROM pg_catalog\.pg_namespace namespace/);
  assert.match(source, /FROM pg_catalog\.pg_class relation/);
  assert.match(source, /WHERE relation\.relnamespace=\$1::oid/);
  assert.match(source, /runtime_login\.oid=\$4::oid/);
  assert.match(source, /owner_role\.oid=\$7::oid/);
});

test("runtime attributes textual reproduction fails closed before OID privilege results", async () => {
  for (const [options, code] of [
    [{ textualFailureCode: "22P02" }, "linux_gate_runtime_attributes_text_resolution_invalid"],
    [{ textualQueryReturns: true }, "linux_gate_runtime_attributes_text_resolution_invalid"],
    [{ directPoolUsable: false }, "linux_gate_runtime_attributes_pool_state_invalid"],
    [{ directTransactionPersisted: true }, "linux_gate_runtime_attributes_pool_state_invalid"],
    [{ mutateAclDuringText: true }, "linux_gate_runtime_attributes_acl_changed"]
  ]) {
    const database = createRuntimeAttributesDatabase(options);
    const substeps = [];
    await assert.rejects(
      runRuntimeAttributesTextResolutionReproduction(database.state, {
        async runSubstep(name, operation) {
          substeps.push(name);
          return operation();
        }
      }),
      { code }
    );
    assert.equal(substeps.at(-1), "rls_runtime_attributes_text_resolution_refusal");
    assert.equal(database.privilegeReads, 0);
    assert.equal(database.clients.every((client) => client.checkedOut === false), true);
  }
});

test("runtime attributes reproduction requires exact direct identity booleans", async () => {
  for (const options of [
    { directSessionIdentity: false },
    { directCurrentIdentity: false },
    { directInheritsMigrator: true },
    { directSchemaUsage: true },
    { omitDirectIdentityField: "direct_schema_usage" }
  ]) {
    const database = createRuntimeAttributesDatabase(options);
    await assert.rejects(
      runRuntimeAttributesTextResolutionReproduction(database.state, {
        runSubstep: (_name, operation) => operation()
      }),
      { code: "linux_gate_runtime_attributes_direct_identity_invalid" }
    );
    assert.equal(database.textualReads, 0);
    assert.equal(database.privilegeReads, 0);
  }
});

test("runtime attributes reproduction requires idle physical state and cleans contaminated clients", async () => {
  for (const initialTransactionStatus of ["T", "E", "absent"]) {
    const database = createRuntimeAttributesDatabase({ initialTransactionStatus });
    const substeps = [];
    await assert.rejects(
      runRuntimeAttributesTextResolutionReproduction(database.state, {
        async runSubstep(name, operation) {
          substeps.push(name);
          return operation();
        }
      }),
      { code: "linux_gate_runtime_attributes_transaction_state_invalid" }
    );
    assert.equal(substeps.at(-1), "rls_runtime_attributes_direct_identity");
    assert.equal(database.rollbackCalls, initialTransactionStatus === "absent" ? 0 : 1);
    assert.equal(database.releaseCalls, 1);
  }
  const afterText = createRuntimeAttributesDatabase({ afterTextTransactionStatus: "T" });
  const substeps = [];
  await assert.rejects(
    runRuntimeAttributesTextResolutionReproduction(afterText.state, {
      async runSubstep(name, operation) {
        substeps.push(name);
        return operation();
      }
    }),
    { code: "linux_gate_runtime_attributes_transaction_state_invalid" }
  );
  assert.equal(substeps.at(-1), "rls_runtime_attributes_text_resolution_refusal");
  assert.equal(afterText.rollbackCalls, 1);
  assert.equal(afterText.releaseCalls, 1);
});

test("runtime attributes cleanup preserves primary and propagates cleanup-only failure", async () => {
  const primary = createRuntimeAttributesDatabase({
    initialTransactionStatus: "T",
    rollbackFailureCode: "runtime_attributes_rollback_failed",
    releaseFailureAt: 1
  });
  await assert.rejects(
    runRuntimeAttributesTextResolutionReproduction(primary.state, {
      runSubstep: (_name, operation) => operation()
    }),
    { code: "linux_gate_runtime_attributes_transaction_state_invalid" }
  );
  assert.equal(primary.rollbackCalls, 1);
  assert.equal(primary.releaseCalls, 1);
  assert.deepEqual(primary.releaseErrors, ["runtime_attributes_rollback_failed"]);

  const cleanupOnly = createRuntimeAttributesDatabase({ releaseFailureAt: 3 });
  const substeps = [];
  await assert.rejects(
    runRuntimeAttributesTextResolutionReproduction(cleanupOnly.state, {
      async runSubstep(name, operation) {
        substeps.push(name);
        return operation();
      }
    }),
    { code: "runtime_attributes_release_failed" }
  );
  assert.equal(substeps.at(-1), "rls_runtime_attributes_acl_reset");
  assert.equal(cleanupOnly.releaseCalls, 3);
});

test("runtime attributes OID catalog refuses schema, relation, relkind and role drift", async () => {
  for (const [options, code] of [
    [{ missingSchema: true }, "linux_gate_runtime_attributes_migration_schema_invalid"],
    [{ duplicateSchema: true }, "linux_gate_runtime_attributes_migration_schema_invalid"],
    [{ schemaName: "unexpected_schema" }, "linux_gate_runtime_attributes_migration_schema_invalid"],
    [{ schemaOid: 0 }, "linux_gate_runtime_attributes_migration_schema_invalid"],
    [{ missingRelation: true }, "linux_gate_runtime_attributes_migration_ledger_invalid"],
    [{ duplicateRelation: true }, "linux_gate_runtime_attributes_migration_ledger_invalid"],
    [{ relationName: "unexpected_relation" }, "linux_gate_runtime_attributes_migration_ledger_invalid"],
    [{ relationOid: 0 }, "linux_gate_runtime_attributes_migration_ledger_invalid"],
    [{ relationKind: "v" }, "linux_gate_runtime_attributes_migration_ledger_kind_invalid"],
    [{ missingRole: OWNER_ROLE }, "linux_gate_runtime_attributes_role_catalog_invalid"],
    [{ duplicateRole: true }, "linux_gate_runtime_attributes_role_catalog_invalid"],
    [{ invalidRoleOid: 0 }, "linux_gate_runtime_attributes_role_catalog_invalid"],
    [{ duplicateRoleOid: true }, "linux_gate_runtime_attributes_role_catalog_invalid"],
    [{ unexpectedRoleName: "unexpected_role" }, "linux_gate_runtime_attributes_role_catalog_invalid"]
  ]) {
    const database = createRuntimeAttributesDatabase(options);
    const substeps = [];
    await assert.rejects(
      runRuntimeAttributesTextResolutionReproduction(database.state, {
        async runSubstep(name, operation) {
          substeps.push(name);
          return operation();
        }
      }),
      { code }
    );
    assert.equal(substeps.at(-1), "rls_runtime_attributes_oid_catalog");
    assert.equal(database.textualReads, 1);
    assert.equal(database.privilegeReads, 0);
  }
});

test("runtime attributes OID inventory refuses unsafe attributes and memberships separately", async () => {
  for (const [field, code] of [
    ["runtime_login_superuser", "linux_gate_runtime_login_attributes_unsafe"],
    ["runtime_login_bypassrls", "linux_gate_runtime_login_attributes_unsafe"],
    ["runtime_login_createdb", "linux_gate_runtime_login_attributes_unsafe"],
    ["runtime_login_createrole", "linux_gate_runtime_login_attributes_unsafe"],
    ["runtime_login_replication", "linux_gate_runtime_login_attributes_unsafe"],
    ["runtime_role_superuser", "linux_gate_runtime_role_attributes_unsafe"],
    ["runtime_role_bypassrls", "linux_gate_runtime_role_attributes_unsafe"],
    ["runtime_role_createdb", "linux_gate_runtime_role_attributes_unsafe"],
    ["runtime_role_createrole", "linux_gate_runtime_role_attributes_unsafe"],
    ["runtime_role_replication", "linux_gate_runtime_role_attributes_unsafe"],
    ["runtime_login_migrator_member", "linux_gate_runtime_login_migrator_membership_unexpected"],
    ["runtime_role_migrator_member", "linux_gate_runtime_role_migrator_membership_unexpected"],
    ["runtime_login_owner_member", "linux_gate_runtime_login_owner_membership_unexpected"],
    ["runtime_role_owner_member", "linux_gate_runtime_role_owner_membership_unexpected"]
  ]) {
    const database = createRuntimeAttributesDatabase({ privilegeOverrides: { [field]: true } });
    await assert.rejects(
      runRuntimeAttributesTextResolutionReproduction(database.state, {
        runSubstep: (_name, operation) => operation()
      }),
      { code }
    );
  }
});

test("runtime attributes OID inventory refuses migration schema privileges separately", async () => {
  for (const [field, code] of [
    ["runtime_login_schema_usage", "linux_gate_runtime_login_migration_schema_usage_unexpected"],
    ["runtime_role_schema_usage", "linux_gate_runtime_role_migration_schema_usage_unexpected"],
    ["runtime_login_schema_create", "linux_gate_runtime_login_migration_schema_create_unexpected"],
    ["runtime_role_schema_create", "linux_gate_runtime_role_migration_schema_create_unexpected"]
  ]) {
    const database = createRuntimeAttributesDatabase({ privilegeOverrides: { [field]: true } });
    await assert.rejects(
      runRuntimeAttributesTextResolutionReproduction(database.state, {
        runSubstep: (_name, operation) => operation()
      }),
      { code }
    );
  }
});

test("runtime attributes OID inventory refuses every migration table privilege for both subjects", async () => {
  const privileges = [
    "select",
    "insert",
    "update",
    "delete",
    "truncate",
    "references",
    "trigger",
    "maintain"
  ];
  for (const subject of ["runtime_login", "runtime_role"]) {
    for (const privilege of privileges) {
      const field = `${subject}_table_${privilege}`;
      const database = createRuntimeAttributesDatabase({ privilegeOverrides: { [field]: true } });
      await assert.rejects(
        runRuntimeAttributesTextResolutionReproduction(database.state, {
          runSubstep: (_name, operation) => operation()
        }),
        {
          code: subject === "runtime_login"
            ? "linux_gate_runtime_login_migration_table_privilege_unexpected"
            : "linux_gate_runtime_role_migration_table_privilege_unexpected"
        }
      );
    }
  }
});

test("runtime attributes OID inventory refuses null and omitted security booleans", async () => {
  const expectedCodes = {
    runtime_login_superuser: "linux_gate_runtime_login_attributes_unsafe",
    runtime_login_bypassrls: "linux_gate_runtime_login_attributes_unsafe",
    runtime_login_createdb: "linux_gate_runtime_login_attributes_unsafe",
    runtime_login_createrole: "linux_gate_runtime_login_attributes_unsafe",
    runtime_login_replication: "linux_gate_runtime_login_attributes_unsafe",
    runtime_role_superuser: "linux_gate_runtime_role_attributes_unsafe",
    runtime_role_bypassrls: "linux_gate_runtime_role_attributes_unsafe",
    runtime_role_createdb: "linux_gate_runtime_role_attributes_unsafe",
    runtime_role_createrole: "linux_gate_runtime_role_attributes_unsafe",
    runtime_role_replication: "linux_gate_runtime_role_attributes_unsafe",
    runtime_login_migrator_member: "linux_gate_runtime_login_migrator_membership_unexpected",
    runtime_role_migrator_member: "linux_gate_runtime_role_migrator_membership_unexpected",
    runtime_login_owner_member: "linux_gate_runtime_login_owner_membership_unexpected",
    runtime_role_owner_member: "linux_gate_runtime_role_owner_membership_unexpected",
    runtime_login_schema_usage: "linux_gate_runtime_login_migration_schema_usage_unexpected",
    runtime_role_schema_usage: "linux_gate_runtime_role_migration_schema_usage_unexpected",
    runtime_login_schema_create: "linux_gate_runtime_login_migration_schema_create_unexpected",
    runtime_role_schema_create: "linux_gate_runtime_role_migration_schema_create_unexpected"
  };
  for (const subject of ["runtime_login", "runtime_role"]) {
    for (const privilege of [
      "select", "insert", "update", "delete", "truncate", "references", "trigger", "maintain"
    ]) {
      expectedCodes[`${subject}_table_${privilege}`] = subject === "runtime_login"
        ? "linux_gate_runtime_login_migration_table_privilege_unexpected"
        : "linux_gate_runtime_role_migration_table_privilege_unexpected";
    }
  }
  for (const [field, code] of Object.entries(expectedCodes)) {
    for (const options of [
      { privilegeOverrides: { [field]: null } },
      { omitPrivilegeField: field }
    ]) {
      const database = createRuntimeAttributesDatabase(options);
      await assert.rejects(
        runRuntimeAttributesTextResolutionReproduction(database.state, {
          runSubstep: (_name, operation) => operation()
        }),
        { code }
      );
    }
  }
});

test("runtime attributes OID inventory refuses result drift and resets after exceptions", async () => {
  for (const [options, code, lastSubstep] of [
    [
      { inventorySessionIdentity: false },
      "linux_gate_runtime_attributes_oid_inventory_invalid",
      "rls_runtime_attributes_oid_privileges"
    ],
    [
      { inventoryCurrentIdentity: false },
      "linux_gate_runtime_attributes_oid_inventory_invalid",
      "rls_runtime_attributes_oid_privileges"
    ],
    [
      { missingPrivilegeRow: true },
      "linux_gate_runtime_attributes_oid_inventory_invalid",
      "rls_runtime_attributes_oid_privileges"
    ],
    [
      { duplicatePrivilegeRow: true },
      "linux_gate_runtime_attributes_oid_inventory_invalid",
      "rls_runtime_attributes_oid_privileges"
    ],
    [
      { mutateAclAfterPrivilege: true },
      "linux_gate_runtime_attributes_acl_changed",
      "rls_runtime_attributes_acl_reset"
    ],
    [
      { resetIdentityDrift: true },
      "linux_gate_runtime_attributes_direct_identity_invalid",
      "rls_runtime_attributes_acl_reset"
    ]
  ]) {
    const database = createRuntimeAttributesDatabase(options);
    const substeps = [];
    await assert.rejects(
      runRuntimeAttributesTextResolutionReproduction(database.state, {
        async runSubstep(name, operation) {
          substeps.push(name);
          return operation();
        }
      }),
      { code }
    );
    assert.equal(substeps.at(-1), lastSubstep);
    assert.equal(database.clients.every((client) => client.checkedOut === false), true);
  }
});

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
        runtimeAttributesTextResolutionReproduction: runtimeAttributesProof(),
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

test("corrected RLS gate requires the exact runtime attributes proof before tenant work", async () => {
  for (const runtimeAttributesTextResolutionReproduction of [
    undefined,
    runtimeAttributesProof({ runtimeRoleMigrationTablePrivileges: true })
  ]) {
    const database = createRlsDatabase();
    await assert.rejects(
      runRlsAndRoleGate(database.state, {
        baseRlsGatePassed: true,
        reproduction: reproductionProof(),
        runtimeAttributesTextResolutionReproduction,
        runSubstep: (_name, operation) => operation()
      }),
      { code: "linux_gate_runtime_attributes_reproduction_required" }
    );
    assert.equal(database.calls.length, 0);
  }
});

test("corrected RLS gate writes own audit events and rejects both cross-tenant directions", async () => {
  const database = createRlsDatabase();
  const substeps = [];
  const result = await runRlsAndRoleGate(database.state, {
    baseRlsGatePassed: true,
    runtimeAttributesTextResolutionReproduction: runtimeAttributesProof(),
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
    "rls_connection_scope_reset"
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
      runtimeAttributesTextResolutionReproduction: runtimeAttributesProof(),
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
      runtimeAttributesTextResolutionReproduction: runtimeAttributesProof(),
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
      runtimeAttributesTextResolutionReproduction: runtimeAttributesProof(),
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

test("supplemental Gate 3 exposes every closed S1-S30 pass-through boundary", () => {
  assert.equal(typeof runConcurrencyOAuthIdempotencyGate, "function");
  const source = fs.readFileSync(path.join(ROOT, "scripts/social-3a0p-linux-physical-gates.js"), "utf8");
  for (const [substep, _description, operationClass] of SUPPLEMENTAL_GATE3_SUBSTEPS) {
    assert.match(source, new RegExp(
      `runGate3Substep\\(\\s*[\"']${substep}[\"']\\s*,\\s*[\"']${operationClass}[\"']`
    ));
  }
  assert.match(source, /runGate3Substep\("S5", "postgres_concurrent_transactions", \(\) =>\s*Promise\.allSettled\(\[/);
  assert.match(source, /runGate3Substep\("S10", "postgres_concurrent_transactions", \(\) =>\s*Promise\.allSettled\(\[/);
  assert.match(source, /runGate3Substep\("S12", "postgres_concurrent_transactions", \(\) => Promise\.all\(\[/);
  assert.match(source, /runGate3Substep\("S22", "postgres_concurrent_transactions", \(\) =>\s*Promise\.all\(\[/);
  assert.equal((source.match(/runGate3Substep\("S(?:[1-9]|[12][0-9]|30)"/g) || []).length, 30);
});

test("supplemental Gate 3 pass-through preserves success result, calls, arguments and cleanup", async () => {
  const baseline = await executeSupplementalGate3();
  const instrumented = await executeSupplementalGate3({
    runGate3Substep: (_substep, _operationClass, operation) => operation()
  });

  assert.equal(baseline.didThrow, false);
  assert.equal(instrumented.didThrow, false);
  assert.deepEqual(baseline.result, SUPPLEMENTAL_GATE3_RESULT);
  assert.deepEqual(instrumented.result, baseline.result);
  assert.deepEqual(instrumented.observations, baseline.observations);
  assert.deepEqual(instrumented.sensitiveMarkers, baseline.sensitiveMarkers);
  assert.deepEqual(
    instrumented.runnerCalls,
    SUPPLEMENTAL_GATE3_SUBSTEPS.map(([substep, _description, operationClass]) => ({
      substep,
      operationClass
    }))
  );
  assert.deepEqual(
    [...instrumented.operationCounts.entries()],
    SUPPLEMENTAL_GATE3_SUBSTEPS.map(([substep]) => [substep, 1])
  );
  assert.equal(instrumented.observations.transactions.length, 9);
  assert.equal(instrumented.observations.queries.length, 13);
  assert.equal(instrumented.observations.connectorCalls.length, 9);
  assert.equal(instrumented.observations.oauthCalls.length, 7);
  assert.equal(instrumented.identityKey.every((byte) => byte === 0), true);
  assert.equal(Object.isFrozen(instrumented.result), true);
});

test("supplemental Gate 3 rethrows the same error at every S1-S30 boundary and still cleans up", async (context) => {
  const errorShapes = [
    () => Object.assign(new Error("dsn=postgres://secret SQL SELECT stdout stderr"), { code: "23505" }),
    () => Object.assign(new Error("dsn=postgres://secret SQL SELECT stdout stderr"), { code: "57014" }),
    () => Object.assign(new Error("dsn=postgres://secret SQL SELECT stdout stderr"), { code: "ECONNRESET" }),
    () => Object.assign(new Error("dsn=postgres://secret SQL SELECT stdout stderr"), { code: "ETIMEDOUT" }),
    () => new TypeError("dsn=postgres://secret SQL SELECT stdout stderr"),
    () => new Error("dsn=postgres://secret SQL SELECT stdout stderr")
  ];

  for (let index = 0; index < SUPPLEMENTAL_GATE3_SUBSTEPS.length; index += 1) {
    const [target, description] = SUPPLEMENTAL_GATE3_SUBSTEPS[index];
    await context.test(`${target} ${description}`, async () => {
      const failure = errorShapes[index % errorShapes.length]();
      const execution = await executeSupplementalGate3({
        runGate3Substep: async (substep, _operationClass, operation) => {
          if (substep !== target) return operation();
          if (substep === "S30") {
            await operation();
          }
          throw failure;
        }
      });
      const expectedSteps = SUPPLEMENTAL_GATE3_SUBSTEPS
        .slice(0, index + 1)
        .map(([substep]) => substep);
      if (target !== "S30") expectedSteps.push("S30");

      assert.equal(execution.didThrow, true);
      assert.strictEqual(execution.thrown, failure);
      assert.deepEqual(execution.runnerCalls.map(({ substep }) => substep), expectedSteps);
      assert.equal(execution.runnerCalls.filter(({ substep }) => substep === target).length, 1);
      assert.equal(execution.runnerCalls.filter(({ substep }) => substep === "S30").length, 1);
      if (target !== "S1") {
        assert.equal(execution.identityKey.every((byte) => byte === 0), true);
      }
      const publicTrace = JSON.stringify({ runnerCalls: execution.runnerCalls });
      assert.doesNotMatch(publicTrace, /postgres:\/\/|secret|SELECT|stdout|stderr/i);
    });
  }
});

test("supplemental Gate 3 first failure wins over a later S30 failure", async () => {
  const primary = Object.assign(new Error("primary secret"), { code: "57014" });
  const cleanup = Object.assign(new Error("cleanup secret"), { code: "ECONNRESET" });
  const execution = await executeSupplementalGate3({
    runGate3Substep: async (substep, _operationClass, operation) => {
      if (substep === "S10") throw primary;
      if (substep === "S30") {
        await operation();
        throw cleanup;
      }
      return operation();
    }
  });

  assert.equal(execution.didThrow, true);
  assert.strictEqual(execution.thrown, primary);
  assert.deepEqual(execution.runnerCalls.map(({ substep }) => substep), [
    "S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10", "S30"
  ]);
  assert.equal(execution.identityKey.every((byte) => byte === 0), true);
});

test("supplemental Gate 3 propagates an S30-only failure after zeroing identity material", async () => {
  const cleanup = Object.assign(new Error("cleanup secret"), { code: "ETIMEDOUT" });
  const execution = await executeSupplementalGate3({
    runGate3Substep: async (substep, _operationClass, operation) => {
      const value = await operation();
      if (substep === "S30") throw cleanup;
      return value;
    }
  });

  assert.equal(execution.didThrow, true);
  assert.strictEqual(execution.thrown, cleanup);
  assert.equal(execution.identityKey.every((byte) => byte === 0), true);
  assert.equal(execution.operationCounts.get("S30"), 1);
});

test("supplemental Gate 3 attempts both identity-key zeroing operations and preserves the first cleanup error", async () => {
  const identityKey = Buffer.alloc(32, 0x6b);
  const cleanup = Object.assign(new Error("first fill failed"), { code: "ECONNRESET" });
  let fillCalls = 0;
  Object.defineProperty(identityKey, "fill", {
    configurable: true,
    value(...arguments_) {
      fillCalls += 1;
      if (fillCalls === 1) throw cleanup;
      return Buffer.prototype.fill.call(this, ...arguments_);
    }
  });
  const execution = await executeSupplementalGate3({ identityKey });

  assert.equal(execution.didThrow, true);
  assert.strictEqual(execution.thrown, cleanup);
  assert.equal(fillCalls, 2);
  assert.equal(identityKey.every((byte) => byte === 0), true);
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
