"use strict";

const crypto = require("node:crypto");
const {
  MIGRATION_LOGIN,
  MIGRATOR_ROLE,
  OWNER_ROLE,
  PROVISIONER_LOGIN,
  RUNTIME_LOGIN,
  RUNTIME_ROLE,
  LOOPBACK
} = require("./social-3a0p-linux-postgres");

const IDENTITY_VERSION = "social-id-v1";
const VERIFIER_HOST = "local.ia4tube.invalid";

class LinuxPhysicalGateFailure extends Error {
  constructor(code) {
    super(code);
    this.name = "LinuxPhysicalGateFailure";
    this.code = code;
  }
}

function fail(code) {
  throw new LinuxPhysicalGateFailure(code);
}

function exactRejection(results, fulfilled, code, rejectedCode) {
  const fulfilledCount = results.filter((item) => item.status === "fulfilled").length;
  const rejectedCount = results.filter((item) => item.status === "rejected").length;
  const rejectedCodesValid = rejectedCode === undefined || results
    .filter((item) => item.status === "rejected")
    .every((item) => item.reason?.code === rejectedCode);
  if (fulfilledCount !== fulfilled || rejectedCount !== results.length - fulfilled || !rejectedCodesValid) fail(code);
}

async function expectErrorCode(operation, expected, code) {
  try {
    await operation();
  } catch (error) {
    if (error?.code === expected) return true;
    fail(code);
  }
  fail(code);
}

function requireSubstepRunner(dependencies) {
  if (typeof dependencies.runSubstep !== "function") {
    fail("linux_gate_rls_substep_runner_required");
  }
  return dependencies.runSubstep;
}

const RLS_INVENTORY_RELATIONS = Object.freeze([
  "social_audit_events",
  "users"
]);
const AUTHORIZED_RLS_INVENTORY_CLIENTS = new WeakSet();

const RLS_INVENTORY_CONTEXT_RESULT = Object.freeze({
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
  aclUnchanged: true
});

const RUNTIME_ATTRIBUTES_RESULT = Object.freeze({
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
  aclUnchanged: true
});

function exactInventoryRelationRows(rows, code) {
  if (!Array.isArray(rows) || rows.length !== RLS_INVENTORY_RELATIONS.length) fail(code);
  const ordered = [...rows].sort((left, right) =>
    String(left?.relation_name || "").localeCompare(String(right?.relation_name || ""))
  );
  if (ordered.map((row) => row?.relation_name).join(",") !== RLS_INVENTORY_RELATIONS.join(",")) {
    fail(code);
  }
  return ordered;
}

function relationAclFingerprint(rows) {
  const canonical = exactInventoryRelationRows(
    rows,
    "linux_gate_rls_privilege_inventory_relations_invalid"
  ).map((row) => Object.freeze({
    relationName: row.relation_name,
    schemaAcl: row.schema_acl === null || row.schema_acl === undefined ? null : String(row.schema_acl),
    relationAcl: row.relation_acl === null || row.relation_acl === undefined ? null : String(row.relation_acl)
  }));
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

async function runtimeWritePrivilegeInventory(client) {
  if (!client || typeof client.query !== "function" || typeof client.release !== "function") {
    fail("linux_gate_rls_privilege_inventory_client_required");
  }
  if (!AUTHORIZED_RLS_INVENTORY_CLIENTS.has(client)) {
    fail("linux_gate_rls_privilege_inventory_transaction_client_required");
  }
  if (client._txStatus !== "T") {
    fail("linux_gate_rls_privilege_inventory_transaction_client_required");
  }
  const result = await client.query([
    "SELECT",
    " namespace.nspname AS namespace_name,",
    " namespace.oid AS namespace_oid,",
    " relation.relname AS relation_name,",
    " relation.oid AS relation_oid,",
    " relation.relkind AS relation_kind,",
    " session_user=$1 AS session_user_is_migration,",
    " current_user=$2 AS current_user_is_migrator,",
    " has_schema_privilege(current_user,namespace.oid,'USAGE') AS schema_usage,",
    " pg_has_role($3,$4,'SET') AS runtime_login_can_set_role,",
    " has_table_privilege($3,relation.oid,'INSERT') AS runtime_login_insert,",
    " has_table_privilege($4,relation.oid,'INSERT') AS runtime_insert,",
    " (relation.relname='social_audit_events' AND relation.relrowsecurity)",
    "   AS social_audit_rls_enabled,",
    " (relation.relname='social_audit_events' AND relation.relforcerowsecurity)",
    "   AS social_audit_force_rls,",
    " COALESCE(policy_check.policy_exists,FALSE) AS social_audit_policy_exists,",
    " COALESCE(policy_check.policy_using,FALSE) AS social_audit_policy_using,",
    " COALESCE(policy_check.policy_with_check,FALSE) AS social_audit_policy_with_check,",
    " COALESCE(policy_check.policy_company_bound,FALSE)",
    "   AS social_audit_policy_company_bound,",
    " namespace.nspacl::text AS schema_acl,",
    " relation.relacl::text AS relation_acl",
    "FROM pg_catalog.pg_class relation",
    "JOIN pg_catalog.pg_namespace namespace ON namespace.oid=relation.relnamespace",
    "LEFT JOIN LATERAL (",
    " SELECT",
    "   COUNT(*)=1 AS policy_exists,",
    "   COUNT(*)=1 AND BOOL_AND(policy.polqual IS NOT NULL) AS policy_using,",
    "   COUNT(*)=1 AND BOOL_AND(policy.polwithcheck IS NOT NULL) AS policy_with_check,",
    "   COUNT(*)=1 AND BOOL_AND(",
    "     policy.polqual IS NOT NULL",
    "     AND policy.polwithcheck IS NOT NULL",
    "     AND (",
    "       length(pg_catalog.pg_get_expr(policy.polqual,policy.polrelid))-",
    "       length(replace(pg_catalog.pg_get_expr(policy.polqual,policy.polrelid),'company_id',''))",
    "     )/length('company_id')>=2",
    "     AND position('ia4tube.company_id' IN pg_catalog.pg_get_expr(policy.polqual,policy.polrelid))>0",
    "     AND (",
    "       length(pg_catalog.pg_get_expr(policy.polwithcheck,policy.polrelid))-",
    "       length(replace(pg_catalog.pg_get_expr(policy.polwithcheck,policy.polrelid),'company_id',''))",
    "     )/length('company_id')>=2",
    "     AND position('ia4tube.company_id' IN pg_catalog.pg_get_expr(policy.polwithcheck,policy.polrelid))>0",
    "   ) AS policy_company_bound",
    " FROM pg_catalog.pg_policy policy",
    " WHERE policy.polrelid=relation.oid",
    "   AND policy.polname='social_audit_events_company_scope'",
    "   AND policy.polcmd='*'",
    "   AND policy.polroles=ARRAY[0::oid]",
    ") policy_check ON relation.relname='social_audit_events'",
    "WHERE namespace.nspname='ia4tube_social'",
    "  AND relation.relname IN ('users','social_audit_events')",
    "  AND relation.relkind IN ('r','p')",
    "ORDER BY relation.relname"
  ].join("\n"), [MIGRATION_LOGIN, MIGRATOR_ROLE, RUNTIME_LOGIN, RUNTIME_ROLE]);
  const rows = exactInventoryRelationRows(
    result.rows,
    "linux_gate_rls_privilege_inventory_relations_invalid"
  );
  const catalogOids = rows.map((row) => String(row.relation_oid ?? ""));
  if (rows.some((row) =>
    row.namespace_name !== "ia4tube_social" ||
    !/^[1-9][0-9]*$/.test(String(row.namespace_oid ?? "")) ||
    !/^[1-9][0-9]*$/.test(String(row.relation_oid ?? "")) ||
    !["r", "p"].includes(row.relation_kind) ||
    row.session_user_is_migration !== true ||
    row.current_user_is_migrator !== true ||
    row.schema_usage !== false
  ) ||
      new Set(rows.map((row) => String(row.namespace_oid))).size !== 1 ||
      new Set(catalogOids).size !== rows.length) {
    fail("linux_gate_rls_privilege_inventory_context_invalid");
  }
  const audit = rows[0];
  const users = rows[1];
  if (users.runtime_login_insert !== false || users.runtime_insert !== false) {
    fail("linux_gate_rls_core_user_insert_privilege_unexpected");
  }
  const socialAuditPolicyExists = audit.social_audit_policy_exists === true;
  const socialAuditPolicyUsing = audit.social_audit_policy_using === true;
  const socialAuditPolicyWithCheck = audit.social_audit_policy_with_check === true;
  const socialAuditPolicyCompanyBound = audit.social_audit_policy_company_bound === true;
  return Object.freeze({
    inventorySessionUserMigration: true,
    inventoryCurrentUserMigrator: true,
    migratorSchemaUsage: false,
    oidInventoryUsed: true,
    textualRelationResolutionUsed: false,
    runtimeLoginCanSetRole: rows.every((row) => row.runtime_login_can_set_role === true),
    runtimeLoginCoreUserInsert: users.runtime_login_insert === true,
    coreUserInsert: users.runtime_insert === true,
    socialAuditInsert: audit.runtime_insert === true,
    socialAuditRlsEnabled: audit.social_audit_rls_enabled === true,
    socialAuditForceRls: audit.social_audit_force_rls === true,
    socialAuditPolicyExists,
    socialAuditPolicyUsing,
    socialAuditPolicyWithCheck,
    socialAuditPolicyCompanyBound,
    socialAuditCompanyPolicy: socialAuditPolicyExists &&
      socialAuditPolicyUsing && socialAuditPolicyWithCheck && socialAuditPolicyCompanyBound,
    relationCount: rows.length,
    aclFingerprint: relationAclFingerprint(rows)
  });
}

async function authorizedRuntimeWritePrivilegeInventory(client) {
  AUTHORIZED_RLS_INVENTORY_CLIENTS.add(client);
  try {
    return await runtimeWritePrivilegeInventory(client);
  } finally {
    AUTHORIZED_RLS_INVENTORY_CLIENTS.delete(client);
  }
}

function exactRuntimeWritePrivilegeInventory(left, right) {
  return left.inventorySessionUserMigration === right.inventorySessionUserMigration &&
    left.inventoryCurrentUserMigrator === right.inventoryCurrentUserMigrator &&
    left.migratorSchemaUsage === right.migratorSchemaUsage &&
    left.oidInventoryUsed === right.oidInventoryUsed &&
    left.textualRelationResolutionUsed === right.textualRelationResolutionUsed &&
    left.runtimeLoginCanSetRole === right.runtimeLoginCanSetRole &&
    left.runtimeLoginCoreUserInsert === right.runtimeLoginCoreUserInsert &&
    left.coreUserInsert === right.coreUserInsert &&
    left.socialAuditInsert === right.socialAuditInsert &&
    left.socialAuditRlsEnabled === right.socialAuditRlsEnabled &&
    left.socialAuditForceRls === right.socialAuditForceRls &&
    left.socialAuditPolicyExists === right.socialAuditPolicyExists &&
    left.socialAuditPolicyUsing === right.socialAuditPolicyUsing &&
    left.socialAuditPolicyWithCheck === right.socialAuditPolicyWithCheck &&
    left.socialAuditPolicyCompanyBound === right.socialAuditPolicyCompanyBound &&
    left.socialAuditCompanyPolicy === right.socialAuditCompanyPolicy &&
    left.relationCount === right.relationCount &&
    left.aclFingerprint === right.aclFingerprint;
}

function validRlsPrivilegeInventoryContextReproduction(candidate) {
  return candidate &&
    Object.getPrototypeOf(candidate) === Object.prototype &&
    Object.keys(candidate).sort().join(",") ===
      Object.keys(RLS_INVENTORY_CONTEXT_RESULT).sort().join(",") &&
    Object.entries(RLS_INVENTORY_CONTEXT_RESULT).every(([key, value]) => candidate[key] === value);
}

async function directSessionIdentity(client) {
  const result = await client.query([
    "SELECT",
    " session_user=$1 AS direct_session_identity,",
    " current_user=$1 AS direct_current_identity,",
    " login.rolsuper AS direct_superuser,",
    " login.rolbypassrls AS direct_bypassrls,",
    " login.rolcreaterole AS direct_createrole,",
    " pg_has_role($1,$2,'SET') AS direct_can_set_migrator,",
    " (login.rolinherit AND pg_has_role($1,$2,'MEMBER')) AS direct_inherits_migrator",
    "FROM pg_catalog.pg_roles login",
    "WHERE login.rolname=$1"
  ].join("\n"), [MIGRATION_LOGIN, MIGRATOR_ROLE]);
  const row = result.rows?.length === 1 ? result.rows[0] : null;
  if (!row) fail("linux_gate_rls_inventory_direct_session_invalid");
  return Object.freeze({
    sessionIdentity: row.direct_session_identity === true,
    currentIdentity: row.direct_current_identity === true,
    superuser: row.direct_superuser === true,
    bypassRls: row.direct_bypassrls === true,
    createRole: row.direct_createrole === true,
    canSetMigrator: row.direct_can_set_migrator === true,
    inheritsMigrator: row.direct_inherits_migrator === true
  });
}

function validDirectSessionIdentity(identity) {
  return identity.sessionIdentity === true &&
    identity.currentIdentity === true &&
    identity.superuser === false &&
    identity.bypassRls === false &&
    identity.createRole === false &&
    identity.canSetMigrator === true &&
    identity.inheritsMigrator === false;
}

function exactDirectSessionIdentity(left, right) {
  return left.sessionIdentity === right.sessionIdentity &&
    left.currentIdentity === right.currentIdentity &&
    left.superuser === right.superuser &&
    left.bypassRls === right.bypassRls &&
    left.createRole === right.createRole &&
    left.canSetMigrator === right.canSetMigrator &&
    left.inheritsMigrator === right.inheritsMigrator;
}

async function directAclSnapshot(client) {
  const result = await client.query([
    "SELECT",
    " relation.relname AS relation_name,",
    " has_schema_privilege(current_user,namespace.oid,'USAGE') AS direct_schema_usage,",
    " namespace.nspacl::text AS schema_acl,",
    " relation.relacl::text AS relation_acl",
    "FROM pg_catalog.pg_class relation",
    "JOIN pg_catalog.pg_namespace namespace ON namespace.oid=relation.relnamespace",
    "WHERE namespace.nspname='ia4tube_social'",
    "  AND relation.relname IN ('users','social_audit_events')",
    "  AND relation.relkind IN ('r','p')",
    "ORDER BY relation.relname"
  ].join("\n"));
  const rows = exactInventoryRelationRows(
    result.rows,
    "linux_gate_rls_inventory_acl_relations_invalid"
  );
  const schemaUsage = rows.every((row) => row.direct_schema_usage === true);
  if (rows.some((row) => (row.direct_schema_usage === true) !== schemaUsage)) {
    fail("linux_gate_rls_inventory_direct_schema_access_invalid");
  }
  return Object.freeze({
    schemaUsage,
    aclFingerprint: relationAclFingerprint(rows)
  });
}

async function migratorRoleActivation(client) {
  const result = await client.query([
    "SELECT",
    " session_user=$1 AS migrator_session_identity,",
    " current_user=$2 AS migrator_current_identity,",
    " has_schema_privilege(current_user,namespace.oid,'USAGE') AS migrator_schema_usage",
    "FROM pg_catalog.pg_namespace namespace",
    "WHERE namespace.nspname='ia4tube_social'"
  ].join("\n"), [MIGRATION_LOGIN, MIGRATOR_ROLE]);
  const row = result.rows?.length === 1 ? result.rows[0] : null;
  if (!row || row.migrator_session_identity !== true || row.migrator_current_identity !== true) {
    fail("linux_gate_rls_inventory_migrator_role_activation_invalid");
  }
  if (row.migrator_schema_usage !== false) {
    fail("linux_gate_rls_inventory_migrator_schema_privilege_unexpected");
  }
}

function validateRuntimeWritePrivilegeInventory(inventory) {
  if (!inventory.runtimeLoginCanSetRole) {
    fail("linux_gate_rls_runtime_role_set_missing");
  }
  if (inventory.runtimeLoginCoreUserInsert || inventory.coreUserInsert) {
    fail("linux_gate_rls_core_user_insert_privilege_unexpected");
  }
  if (!inventory.socialAuditInsert) {
    fail("linux_gate_rls_social_audit_insert_privilege_missing");
  }
  if (!inventory.socialAuditRlsEnabled) {
    fail("linux_gate_rls_social_audit_rls_disabled");
  }
  if (!inventory.socialAuditForceRls) {
    fail("linux_gate_rls_social_audit_force_rls_disabled");
  }
  if (!inventory.socialAuditPolicyExists) {
    fail("linux_gate_rls_social_audit_policy_missing");
  }
  if (!inventory.socialAuditPolicyUsing) {
    fail("linux_gate_rls_social_audit_policy_using_missing");
  }
  if (!inventory.socialAuditPolicyWithCheck) {
    fail("linux_gate_rls_social_audit_policy_with_check_missing");
  }
  if (!inventory.socialAuditPolicyCompanyBound) {
    fail("linux_gate_rls_social_audit_policy_company_scope_missing");
  }
  return inventory;
}

async function runRlsPrivilegeInventoryContextReproduction(state, dependencies = {}) {
  const { withTransaction } = require("../src/persistence/postgres/pool");
  const runSubstep = requireSubstepRunner(dependencies);
  let directClient;
  let directIdentity;
  let beforeAcl;
  let activatedInventory;
  let primaryFailure;
  try {
    await runSubstep("rls_inventory_direct_session_identity", async () => {
      directClient = await state.pools.migration.connect();
      if (!directClient || typeof directClient.query !== "function" || typeof directClient.release !== "function") {
        fail("linux_gate_rls_inventory_direct_client_invalid");
      }
      directIdentity = await directSessionIdentity(directClient);
      if (!validDirectSessionIdentity(directIdentity)) {
        fail("linux_gate_rls_inventory_direct_session_invalid");
      }
    });

    await runSubstep("rls_inventory_direct_schema_access", async () => {
      beforeAcl = await directAclSnapshot(directClient);
      if (beforeAcl.schemaUsage !== false) {
        fail("linux_gate_rls_inventory_direct_schema_access_unexpected");
      }
    });

    await runSubstep("rls_inventory_direct_name_resolution_refusal", async () => {
      await expectErrorCode(
        () => directClient.query(
          "SELECT has_table_privilege($1,'ia4tube_social.users','INSERT') AS direct_runtime_insert",
          [RUNTIME_ROLE]
        ),
        "42501",
        "linux_gate_rls_inventory_direct_name_resolution_invalid"
      );
      const usable = await directClient.query([
        "SELECT",
        " current_user=session_user AS direct_pool_usable,",
        " pg_current_xact_id_if_assigned() IS NOT NULL AS direct_transaction_persisted"
      ].join("\n"));
      const row = usable.rows?.length === 1 ? usable.rows[0] : null;
      if (!row || row.direct_pool_usable !== true || row.direct_transaction_persisted !== false) {
        fail("linux_gate_rls_inventory_direct_pool_state_invalid");
      }
    });

    await runSubstep("rls_inventory_migrator_role_activation", () => withTransaction(
      state.pools.migration,
      async (client) => {
        await migratorRoleActivation(client);
        activatedInventory = await runSubstep(
          "rls_inventory_migrator_privilege_read",
          async () => {
            const inventory = validateRuntimeWritePrivilegeInventory(
              await authorizedRuntimeWritePrivilegeInventory(client)
            );
            if (inventory.aclFingerprint !== beforeAcl.aclFingerprint) {
              fail("linux_gate_rls_inventory_acl_changed");
            }
            return inventory;
          }
        );
      },
      { role: MIGRATOR_ROLE }
    ));

    await runSubstep("rls_inventory_role_reset", async () => {
      let resetClient;
      let resetFailure;
      try {
        resetClient = await state.pools.migration.connect();
        const resetIdentity = await directSessionIdentity(resetClient);
        if (!validDirectSessionIdentity(resetIdentity) ||
            !exactDirectSessionIdentity(directIdentity, resetIdentity)) {
          fail("linux_gate_rls_inventory_role_reset_invalid");
        }
        const afterAcl = await directAclSnapshot(resetClient);
        if (afterAcl.schemaUsage !== false) {
          fail("linux_gate_rls_inventory_role_reset_invalid");
        }
        if (afterAcl.aclFingerprint !== beforeAcl.aclFingerprint ||
            activatedInventory.aclFingerprint !== afterAcl.aclFingerprint) {
          fail("linux_gate_rls_inventory_acl_changed");
        }
      } catch (error) {
        resetFailure = error;
      }
      try {
        resetClient?.release();
      } catch (error) {
        if (!resetFailure) resetFailure = error;
      }
      try {
        directClient.release();
        directClient = null;
      } catch (error) {
        if (!resetFailure) resetFailure = error;
      }
      if (resetFailure) throw resetFailure;
    });

    return Object.freeze({ ...RLS_INVENTORY_CONTEXT_RESULT });
  } catch (error) {
    primaryFailure = error;
  } finally {
    if (directClient) {
      try {
        directClient.release();
      } catch (cleanupFailure) {
        if (!primaryFailure) primaryFailure = cleanupFailure;
      }
    }
  }
  throw primaryFailure;
}

function validRlsRuntimeWriteContractReproduction(candidate) {
  return candidate &&
    Object.keys(candidate).sort().join(",") === [
      "oldGateLaterStagesReached",
      "runtimeCoreUserInsertPersisted",
      "runtimeCoreUserInsertPrivilege",
      "runtimeCoreUserInsertRefused",
      "runtimePoolUsableAfterRefusal",
      "runtimePrivilegesUnchanged",
      "runtimeWriteContractReproductionPassed",
      "socialAuditEventInsertPrivilege",
      "socialAuditEventsRlsProtected",
      "tenantSeedsCreatedByAdministrativeRole"
    ].sort().join(",") &&
    candidate.runtimeWriteContractReproductionPassed === true &&
    candidate.tenantSeedsCreatedByAdministrativeRole === true &&
    candidate.runtimeCoreUserInsertPrivilege === false &&
    candidate.runtimeCoreUserInsertRefused === true &&
    candidate.runtimeCoreUserInsertPersisted === false &&
    candidate.runtimePoolUsableAfterRefusal === true &&
    candidate.runtimePrivilegesUnchanged === true &&
    candidate.socialAuditEventInsertPrivilege === true &&
    candidate.socialAuditEventsRlsProtected === true &&
    candidate.oldGateLaterStagesReached === false;
}

function createTenant(label, dependencies = {}) {
  const randomUUID = dependencies.randomUUID || crypto.randomUUID;
  const identityKey = dependencies.identityKey || crypto.randomBytes(32);
  const { createSocialAuthAdapter } = require("../src/social/auth-adapter");
  const { createConnectorContext } = require("../src/social/connectors/contract");
  const { SESSION_AUDIENCE, SESSION_ISSUER } = require("../src/social/reauth");
  const legacyId = `synthetic-linux-${label}`;
  const principal = createSocialAuthAdapter({
    namespaceUuid: "41cb8c58-0bf4-4bd9-83b2-3f2f96dfe29f",
    key: identityKey,
    derivationVersion: IDENTITY_VERSION
  }).fromVerifiedJwt({
    token_version: 2,
    iss: SESSION_ISSUER,
    aud: SESSION_AUDIENCE,
    jti: `synthetic-linux-jwt-${label}`,
    sub: legacyId,
    whatsapp: legacyId,
    company_id: legacyId
  });
  const fixture = Object.freeze({
    label,
    companyId: principal.companyId,
    userId: principal.userId,
    connectionId: randomUUID(),
    secondConnectionId: randomUUID(),
    activeConnectionId: randomUUID(),
    authorizationId: randomUUID(),
    expiredAuthorizationId: randomUUID(),
    operationId: randomUUID(),
    publicationId: randomUUID(),
    correlationId: randomUUID(),
    auditEventId: randomUUID()
  });
  const context = createConnectorContext({
    principal,
    provider: "instagram",
    environment: "test",
    correlationId: fixture.correlationId,
    auditEventId: fixture.auditEventId
  });
  return Object.freeze({ fixture, context, identityKey });
}

async function seedTenant(pool, fixture) {
  const { withTransaction } = require("../src/persistence/postgres/pool");
  await withTransaction(pool, async (client) => {
    await client.query(
      "INSERT INTO ia4tube_social.companies(id,name,identity_derivation_version) VALUES($1,$2,$3)",
      [fixture.companyId, `Synthetic Linux ${fixture.label}`, IDENTITY_VERSION]
    );
    await client.query(
      "INSERT INTO ia4tube_social.users(company_id,id,login_key_digest) VALUES($1,$2,$3)",
      [fixture.companyId, fixture.userId, crypto.createHash("sha256").update(`linux:${fixture.userId}`).digest("hex")]
    );
    await client.query(
      "INSERT INTO ia4tube_social.company_memberships(company_id,user_id,role) VALUES($1,$2,'owner')",
      [fixture.companyId, fixture.userId]
    );
  }, { role: OWNER_ROLE, companyId: fixture.companyId });
}

async function runRlsRuntimeWriteContractReproduction(state, dependencies = {}) {
  const { withTransaction } = require("../src/persistence/postgres/pool");
  const runSubstep = requireSubstepRunner(dependencies);
  if (!validRlsPrivilegeInventoryContextReproduction(dependencies.inventoryContextReproduction)) {
    fail("linux_gate_rls_inventory_context_reproduction_required");
  }
  let a;
  let b;
  let candidateUserId;
  try {
    await runSubstep("rls_seed_tenants", async () => {
      a = createTenant("rls-reproduction-a", dependencies);
      b = createTenant("rls-reproduction-b", dependencies);
      await seedTenant(state.pools.migration, a.fixture);
      await seedTenant(state.pools.migration, b.fixture);
    });
    const before = await runSubstep("rls_inventory_migrator_privilege_read", async () => {
      const inventory = await withTransaction(
        state.pools.migration,
        async (client) => validateRuntimeWritePrivilegeInventory(
          await authorizedRuntimeWritePrivilegeInventory(client)
        ),
        { role: MIGRATOR_ROLE }
      );
      return inventory;
    });

    await runSubstep("rls_core_user_insert_reproduction", async () => {
      candidateUserId = crypto.randomUUID();
      await expectErrorCode(
        () => withTransaction(state.pools.runtime, (client) => client.query(
          "INSERT INTO ia4tube_social.users(company_id,id,login_key_digest) VALUES($1,$2,$3)",
          [
            a.fixture.companyId,
            candidateUserId,
            crypto.createHash("sha256").update(candidateUserId).digest("hex")
          ]
        ), { role: RUNTIME_ROLE, companyId: a.fixture.companyId }),
        "42501",
        "linux_gate_rls_core_user_insert_reproduction_invalid"
      );
      if (
        typeof dependencies.legacyFailureCode !== "function" ||
        dependencies.legacyFailureCode({ code: "42501" }) !== "linux_gate_unclassified_failure"
      ) fail("linux_gate_rls_legacy_failure_classification_invalid");
    });

    await runSubstep("rls_core_user_insert_refusal", async () => {
      const persisted = await withTransaction(state.pools.migration, (client) => client.query(
        "SELECT COUNT(*)::integer AS n FROM ia4tube_social.users WHERE company_id=$1 AND id=$2",
        [a.fixture.companyId, candidateUserId]
      ), { role: OWNER_ROLE, companyId: a.fixture.companyId });
      if (Number(persisted.rows?.[0]?.n) !== 0) fail("linux_gate_rls_core_user_insert_persisted");
      const reusable = await withTransaction(state.pools.runtime, (client) => client.query(
        "SELECT 1::integer AS n"
      ), { role: RUNTIME_ROLE, companyId: a.fixture.companyId });
      if (Number(reusable.rows?.[0]?.n) !== 1) {
        fail("linux_gate_rls_runtime_pool_unusable_after_refusal");
      }
    });
    await runSubstep("rls_inventory_migrator_privilege_read", async () => {
      const after = await withTransaction(
        state.pools.migration,
        async (client) => validateRuntimeWritePrivilegeInventory(
          await authorizedRuntimeWritePrivilegeInventory(client)
        ),
        { role: MIGRATOR_ROLE }
      );
      if (!exactRuntimeWritePrivilegeInventory(before, after)) {
        fail("linux_gate_rls_runtime_privilege_changed");
      }
    });
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
      oldGateLaterStagesReached: false
    });
  } finally {
    a?.identityKey.fill(0);
    b?.identityKey.fill(0);
  }
}

function validRuntimeAttributesTextResolutionReproduction(candidate) {
  return candidate &&
    Object.getPrototypeOf(candidate) === Object.prototype &&
    Object.keys(candidate).sort().join(",") ===
      Object.keys(RUNTIME_ATTRIBUTES_RESULT).sort().join(",") &&
    Object.entries(RUNTIME_ATTRIBUTES_RESULT).every(([key, value]) => candidate[key] === value);
}

function validPositiveOid(value) {
  return /^[1-9][0-9]*$/.test(String(value ?? ""));
}

function requireRuntimeAttributesClient(client) {
  if (!client || typeof client.query !== "function" || typeof client.release !== "function") {
    fail("linux_gate_runtime_attributes_client_invalid");
  }
  if (client._txStatus !== "I") {
    fail("linux_gate_runtime_attributes_transaction_state_invalid");
  }
  return client;
}

function requireRuntimeAttributesIdleState(client) {
  if (client?._txStatus !== "I") {
    fail("linux_gate_runtime_attributes_transaction_state_invalid");
  }
}

async function runtimeAttributesDirectIdentity(client) {
  const result = await client.query([
    "SELECT",
    " session_user=$1 AS direct_session_identity,",
    " current_user=$1 AS direct_current_identity,",
    " pg_has_role(session_user,$2,'USAGE') AS direct_inherits_migrator,",
    " has_schema_privilege(session_user,$3,'USAGE') AS direct_schema_usage"
  ].join("\n"), [MIGRATION_LOGIN, MIGRATOR_ROLE, "ia4tube_migrations"]);
  const row = result.rows?.length === 1 ? result.rows[0] : null;
  if (!row ||
      row.direct_session_identity !== true ||
      row.direct_current_identity !== true ||
      row.direct_inherits_migrator !== false ||
      row.direct_schema_usage !== false) {
    fail("linux_gate_runtime_attributes_direct_identity_invalid");
  }
}

function runtimeAttributesRawAclFingerprint(rows) {
  const canonical = (Array.isArray(rows) ? rows : []).map((row) => ({
    namespaceName: String(row?.namespace_name ?? ""),
    namespaceOid: String(row?.namespace_oid ?? ""),
    relationName: String(row?.relation_name ?? ""),
    relationOid: String(row?.relation_oid ?? ""),
    relationKind: String(row?.relation_kind ?? ""),
    namespaceAcl: row?.schema_acl === null || row?.schema_acl === undefined
      ? null
      : String(row.schema_acl),
    relationAcl: row?.relation_acl === null || row?.relation_acl === undefined
      ? null
      : String(row.relation_acl)
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

async function runtimeAttributesRawAclSnapshot(client) {
  const result = await client.query([
    "SELECT",
    " namespace.nspname AS namespace_name,",
    " namespace.oid AS namespace_oid,",
    " relation.relname AS relation_name,",
    " relation.oid AS relation_oid,",
    " relation.relkind AS relation_kind,",
    " namespace.nspacl::text AS schema_acl,",
    " relation.relacl::text AS relation_acl",
    "FROM pg_catalog.pg_namespace namespace",
    "JOIN pg_catalog.pg_class relation ON relation.relnamespace=namespace.oid",
    "WHERE namespace.nspname='ia4tube_migrations'",
    "  AND relation.relname='schema_migrations'",
    "ORDER BY namespace.oid,relation.oid"
  ].join("\n"));
  const rows = Array.isArray(result.rows) ? result.rows : [];
  return Object.freeze({
    rowCount: rows.length,
    fingerprint: runtimeAttributesRawAclFingerprint(rows)
  });
}

async function runtimeAttributesOidCatalog(client) {
  const schemaResult = await client.query([
    "SELECT",
    " namespace.nspname AS namespace_name,",
    " namespace.oid AS namespace_oid,",
    " namespace.nspacl::text AS schema_acl",
    "FROM pg_catalog.pg_namespace namespace",
    "WHERE namespace.nspname='ia4tube_migrations'"
  ].join("\n"));
  if (schemaResult.rows?.length !== 1) {
    fail("linux_gate_runtime_attributes_migration_schema_invalid");
  }
  const namespace = schemaResult.rows[0];
  if (namespace.namespace_name !== "ia4tube_migrations" ||
      !validPositiveOid(namespace.namespace_oid)) {
    fail("linux_gate_runtime_attributes_migration_schema_invalid");
  }

  const relationResult = await client.query([
    "SELECT",
    " relation.relname AS relation_name,",
    " relation.oid AS relation_oid,",
    " relation.relkind AS relation_kind,",
    " relation.relacl::text AS relation_acl",
    "FROM pg_catalog.pg_class relation",
    "WHERE relation.relnamespace=$1::oid",
    "  AND relation.relname='schema_migrations'"
  ].join("\n"), [namespace.namespace_oid]);
  if (relationResult.rows?.length !== 1) {
    fail("linux_gate_runtime_attributes_migration_ledger_invalid");
  }
  const relation = relationResult.rows[0];
  if (relation.relation_name !== "schema_migrations" ||
      !validPositiveOid(relation.relation_oid)) {
    fail("linux_gate_runtime_attributes_migration_ledger_invalid");
  }
  if (!["r", "p"].includes(relation.relation_kind)) {
    fail("linux_gate_runtime_attributes_migration_ledger_kind_invalid");
  }

  const rolesResult = await client.query([
    "SELECT role.rolname AS role_name,role.oid AS role_oid",
    "FROM pg_catalog.pg_roles role",
    "WHERE role.rolname IN ($1,$2,$3,$4)",
    "ORDER BY role.rolname"
  ].join("\n"), [RUNTIME_LOGIN, RUNTIME_ROLE, MIGRATOR_ROLE, OWNER_ROLE]);
  const expectedRoleNames = [RUNTIME_LOGIN, RUNTIME_ROLE, MIGRATOR_ROLE, OWNER_ROLE].sort();
  const roleRows = Array.isArray(rolesResult.rows) ? rolesResult.rows : [];
  const observedRoleNames = roleRows.map((row) => row?.role_name).sort();
  const observedRoleOids = roleRows.map((row) => String(row?.role_oid ?? ""));
  if (roleRows.length !== expectedRoleNames.length ||
      observedRoleNames.join(",") !== expectedRoleNames.join(",") ||
      observedRoleOids.some((oid) => !validPositiveOid(oid)) ||
      new Set(observedRoleOids).size !== expectedRoleNames.length) {
    fail("linux_gate_runtime_attributes_role_catalog_invalid");
  }
  const roleOids = Object.freeze(Object.fromEntries(
    roleRows.map((row) => [row.role_name, String(row.role_oid)])
  ));
  return Object.freeze({
    namespaceOid: String(namespace.namespace_oid),
    relationOid: String(relation.relation_oid),
    relationKind: relation.relation_kind,
    roleOids,
    aclFingerprint: runtimeAttributesRawAclFingerprint([{
      namespace_name: namespace.namespace_name,
      namespace_oid: namespace.namespace_oid,
      relation_name: relation.relation_name,
      relation_oid: relation.relation_oid,
      relation_kind: relation.relation_kind,
      schema_acl: namespace.schema_acl,
      relation_acl: relation.relation_acl
    }])
  });
}

function exactRuntimeAttributesCatalog(left, right) {
  return left.namespaceOid === right.namespaceOid &&
    left.relationOid === right.relationOid &&
    left.relationKind === right.relationKind &&
    left.roleOids[RUNTIME_LOGIN] === right.roleOids[RUNTIME_LOGIN] &&
    left.roleOids[RUNTIME_ROLE] === right.roleOids[RUNTIME_ROLE] &&
    left.roleOids[MIGRATOR_ROLE] === right.roleOids[MIGRATOR_ROLE] &&
    left.roleOids[OWNER_ROLE] === right.roleOids[OWNER_ROLE] &&
    left.aclFingerprint === right.aclFingerprint;
}

async function runtimeAttributesOidPrivilegeInventory(client, catalog) {
  const result = await client.query([
    "SELECT",
    " session_user=$1 AS inventory_session_identity,",
    " current_user=$1 AS inventory_current_identity,",
    " runtime_login.rolsuper AS runtime_login_superuser,",
    " runtime_login.rolbypassrls AS runtime_login_bypassrls,",
    " runtime_login.rolcreatedb AS runtime_login_createdb,",
    " runtime_login.rolcreaterole AS runtime_login_createrole,",
    " runtime_login.rolreplication AS runtime_login_replication,",
    " runtime_role.rolsuper AS runtime_role_superuser,",
    " runtime_role.rolbypassrls AS runtime_role_bypassrls,",
    " runtime_role.rolcreatedb AS runtime_role_createdb,",
    " runtime_role.rolcreaterole AS runtime_role_createrole,",
    " runtime_role.rolreplication AS runtime_role_replication,",
    " pg_has_role(runtime_login.oid,migrator_role.oid,'MEMBER')",
    "   AS runtime_login_migrator_member,",
    " pg_has_role(runtime_role.oid,migrator_role.oid,'MEMBER')",
    "   AS runtime_role_migrator_member,",
    " pg_has_role(runtime_login.oid,owner_role.oid,'MEMBER')",
    "   AS runtime_login_owner_member,",
    " pg_has_role(runtime_role.oid,owner_role.oid,'MEMBER')",
    "   AS runtime_role_owner_member,",
    " has_schema_privilege(runtime_login.oid,namespace.oid,'USAGE')",
    "   AS runtime_login_schema_usage,",
    " has_schema_privilege(runtime_role.oid,namespace.oid,'USAGE')",
    "   AS runtime_role_schema_usage,",
    " has_schema_privilege(runtime_login.oid,namespace.oid,'CREATE')",
    "   AS runtime_login_schema_create,",
    " has_schema_privilege(runtime_role.oid,namespace.oid,'CREATE')",
    "   AS runtime_role_schema_create,",
    " has_table_privilege(runtime_login.oid,relation.oid,'SELECT')",
    "   AS runtime_login_table_select,",
    " has_table_privilege(runtime_login.oid,relation.oid,'INSERT')",
    "   AS runtime_login_table_insert,",
    " has_table_privilege(runtime_login.oid,relation.oid,'UPDATE')",
    "   AS runtime_login_table_update,",
    " has_table_privilege(runtime_login.oid,relation.oid,'DELETE')",
    "   AS runtime_login_table_delete,",
    " has_table_privilege(runtime_login.oid,relation.oid,'TRUNCATE')",
    "   AS runtime_login_table_truncate,",
    " has_table_privilege(runtime_login.oid,relation.oid,'REFERENCES')",
    "   AS runtime_login_table_references,",
    " has_table_privilege(runtime_login.oid,relation.oid,'TRIGGER')",
    "   AS runtime_login_table_trigger,",
    " has_table_privilege(runtime_login.oid,relation.oid,'MAINTAIN')",
    "   AS runtime_login_table_maintain,",
    " has_table_privilege(runtime_role.oid,relation.oid,'SELECT')",
    "   AS runtime_role_table_select,",
    " has_table_privilege(runtime_role.oid,relation.oid,'INSERT')",
    "   AS runtime_role_table_insert,",
    " has_table_privilege(runtime_role.oid,relation.oid,'UPDATE')",
    "   AS runtime_role_table_update,",
    " has_table_privilege(runtime_role.oid,relation.oid,'DELETE')",
    "   AS runtime_role_table_delete,",
    " has_table_privilege(runtime_role.oid,relation.oid,'TRUNCATE')",
    "   AS runtime_role_table_truncate,",
    " has_table_privilege(runtime_role.oid,relation.oid,'REFERENCES')",
    "   AS runtime_role_table_references,",
    " has_table_privilege(runtime_role.oid,relation.oid,'TRIGGER')",
    "   AS runtime_role_table_trigger,",
    " has_table_privilege(runtime_role.oid,relation.oid,'MAINTAIN')",
    "   AS runtime_role_table_maintain",
    "FROM pg_catalog.pg_namespace namespace",
    "JOIN pg_catalog.pg_class relation ON relation.relnamespace=namespace.oid",
    "CROSS JOIN pg_catalog.pg_roles runtime_login",
    "CROSS JOIN pg_catalog.pg_roles runtime_role",
    "CROSS JOIN pg_catalog.pg_roles migrator_role",
    "CROSS JOIN pg_catalog.pg_roles owner_role",
    "WHERE namespace.oid=$2::oid",
    "  AND relation.oid=$3::oid",
    "  AND runtime_login.oid=$4::oid",
    "  AND runtime_role.oid=$5::oid",
    "  AND migrator_role.oid=$6::oid",
    "  AND owner_role.oid=$7::oid"
  ].join("\n"), [
    MIGRATION_LOGIN,
    catalog.namespaceOid,
    catalog.relationOid,
    catalog.roleOids[RUNTIME_LOGIN],
    catalog.roleOids[RUNTIME_ROLE],
    catalog.roleOids[MIGRATOR_ROLE],
    catalog.roleOids[OWNER_ROLE]
  ]);
  const row = result.rows?.length === 1 ? result.rows[0] : null;
  if (!row ||
      row.inventory_session_identity !== true ||
      row.inventory_current_identity !== true) {
    fail("linux_gate_runtime_attributes_oid_inventory_invalid");
  }
  if ([
    row.runtime_login_superuser,
    row.runtime_login_bypassrls,
    row.runtime_login_createdb,
    row.runtime_login_createrole,
    row.runtime_login_replication
  ].some((value) => value !== false)) {
    fail("linux_gate_runtime_login_attributes_unsafe");
  }
  if ([
    row.runtime_role_superuser,
    row.runtime_role_bypassrls,
    row.runtime_role_createdb,
    row.runtime_role_createrole,
    row.runtime_role_replication
  ].some((value) => value !== false)) {
    fail("linux_gate_runtime_role_attributes_unsafe");
  }
  if (row.runtime_login_migrator_member !== false) {
    fail("linux_gate_runtime_login_migrator_membership_unexpected");
  }
  if (row.runtime_role_migrator_member !== false) {
    fail("linux_gate_runtime_role_migrator_membership_unexpected");
  }
  if (row.runtime_login_owner_member !== false) {
    fail("linux_gate_runtime_login_owner_membership_unexpected");
  }
  if (row.runtime_role_owner_member !== false) {
    fail("linux_gate_runtime_role_owner_membership_unexpected");
  }
  if (row.runtime_login_schema_usage !== false) {
    fail("linux_gate_runtime_login_migration_schema_usage_unexpected");
  }
  if (row.runtime_role_schema_usage !== false) {
    fail("linux_gate_runtime_role_migration_schema_usage_unexpected");
  }
  if (row.runtime_login_schema_create !== false) {
    fail("linux_gate_runtime_login_migration_schema_create_unexpected");
  }
  if (row.runtime_role_schema_create !== false) {
    fail("linux_gate_runtime_role_migration_schema_create_unexpected");
  }
  if ([
    row.runtime_login_table_select,
    row.runtime_login_table_insert,
    row.runtime_login_table_update,
    row.runtime_login_table_delete,
    row.runtime_login_table_truncate,
    row.runtime_login_table_references,
    row.runtime_login_table_trigger,
    row.runtime_login_table_maintain
  ].some((value) => value !== false)) {
    fail("linux_gate_runtime_login_migration_table_privilege_unexpected");
  }
  if ([
    row.runtime_role_table_select,
    row.runtime_role_table_insert,
    row.runtime_role_table_update,
    row.runtime_role_table_delete,
    row.runtime_role_table_truncate,
    row.runtime_role_table_references,
    row.runtime_role_table_trigger,
    row.runtime_role_table_maintain
  ].some((value) => value !== false)) {
    fail("linux_gate_runtime_role_migration_table_privilege_unexpected");
  }
}

async function cleanupRuntimeAttributesClient(client) {
  let cleanupFailure;
  if (client?._txStatus === "T" || client?._txStatus === "E") {
    try {
      await client.query("ROLLBACK");
    } catch (error) {
      cleanupFailure = error;
    }
  }
  try {
    await client?.release(cleanupFailure);
  } catch (error) {
    cleanupFailure ||= error;
  }
  if (cleanupFailure) throw cleanupFailure;
}

async function runRuntimeAttributesTextResolutionReproduction(state, dependencies = {}) {
  const runSubstep = requireSubstepRunner(dependencies);
  let directClient;
  let inventoryClient;
  let resetClient;
  let catalogBaseline;
  let catalogBefore;
  let primaryFailure;
  try {
    await runSubstep("rls_runtime_attributes_direct_identity", async () => {
      directClient = await state.pools.migration.connect();
      requireRuntimeAttributesClient(directClient);
      await runtimeAttributesDirectIdentity(directClient);
    });

    await runSubstep("rls_runtime_attributes_text_resolution_refusal", async () => {
      catalogBaseline = await runtimeAttributesRawAclSnapshot(directClient);
      requireRuntimeAttributesIdleState(directClient);
      await expectErrorCode(
        () => directClient.query(
          "SELECT has_table_privilege($1,'ia4tube_migrations.schema_migrations','SELECT') AS textual_runtime_privilege",
          [RUNTIME_LOGIN]
        ),
        "42501",
        "linux_gate_runtime_attributes_text_resolution_invalid"
      );
      const usable = await directClient.query([
        "SELECT",
        " current_user=session_user AS direct_pool_usable,",
        " pg_current_xact_id_if_assigned() IS NOT NULL AS direct_transaction_persisted"
      ].join("\n"));
      const row = usable.rows?.length === 1 ? usable.rows[0] : null;
      requireRuntimeAttributesIdleState(directClient);
      if (!row ||
          row.direct_pool_usable !== true ||
          row.direct_transaction_persisted !== false) {
        fail("linux_gate_runtime_attributes_pool_state_invalid");
      }
      const catalogAfterTextRefusal = await runtimeAttributesRawAclSnapshot(directClient);
      if (catalogBaseline.rowCount !== catalogAfterTextRefusal.rowCount ||
          catalogBaseline.fingerprint !== catalogAfterTextRefusal.fingerprint) {
        fail("linux_gate_runtime_attributes_acl_changed");
      }
    });

    await runSubstep("rls_runtime_attributes_oid_catalog", async () => {
      const released = directClient;
      directClient = null;
      await cleanupRuntimeAttributesClient(released);
      inventoryClient = await state.pools.migration.connect();
      requireRuntimeAttributesClient(inventoryClient);
      await runtimeAttributesDirectIdentity(inventoryClient);
      catalogBefore = await runtimeAttributesOidCatalog(inventoryClient);
      if (catalogBaseline.rowCount !== 1 ||
          catalogBaseline.fingerprint !== catalogBefore.aclFingerprint) {
        fail("linux_gate_runtime_attributes_acl_changed");
      }
    });

    await runSubstep("rls_runtime_attributes_oid_privileges", async () => {
      await runtimeAttributesOidPrivilegeInventory(inventoryClient, catalogBefore);
      requireRuntimeAttributesIdleState(inventoryClient);
    });

    await runSubstep("rls_runtime_attributes_acl_reset", async () => {
      const catalogAfter = await runtimeAttributesOidCatalog(inventoryClient);
      requireRuntimeAttributesIdleState(inventoryClient);
      if (catalogBaseline.rowCount !== 1 ||
          catalogBaseline.fingerprint !== catalogAfter.aclFingerprint ||
          !exactRuntimeAttributesCatalog(catalogBefore, catalogAfter)) {
        fail("linux_gate_runtime_attributes_acl_changed");
      }
      const released = inventoryClient;
      inventoryClient = null;
      await cleanupRuntimeAttributesClient(released);
      resetClient = await state.pools.migration.connect();
      requireRuntimeAttributesClient(resetClient);
      await runtimeAttributesDirectIdentity(resetClient);
      const reset = resetClient;
      resetClient = null;
      await cleanupRuntimeAttributesClient(reset);
    });
  } catch (error) {
    primaryFailure = error;
  } finally {
    for (const key of ["directClient", "inventoryClient", "resetClient"]) {
      const client = key === "directClient"
        ? directClient
        : key === "inventoryClient"
          ? inventoryClient
          : resetClient;
      if (!client) continue;
      if (key === "directClient") directClient = null;
      if (key === "inventoryClient") inventoryClient = null;
      if (key === "resetClient") resetClient = null;
      try {
        await cleanupRuntimeAttributesClient(client);
      } catch (cleanupFailure) {
        if (!primaryFailure) primaryFailure = cleanupFailure;
      }
    }
  }
  if (primaryFailure) throw primaryFailure;
  return Object.freeze({ ...RUNTIME_ATTRIBUTES_RESULT });
}

async function runRlsAndRoleGate(state, dependencies = {}) {
  if (dependencies.baseRlsGatePassed !== true) {
    fail("linux_gate_rls_base_gate_prerequisite_missing");
  }
  if (!validRuntimeAttributesTextResolutionReproduction(
    dependencies.runtimeAttributesTextResolutionReproduction
  )) {
    fail("linux_gate_runtime_attributes_reproduction_required");
  }
  const { withTransaction } = require("../src/persistence/postgres/pool");
  const runSubstep = requireSubstepRunner(dependencies);
  let a;
  let b;
  try {
    await runSubstep("rls_seed_tenants", async () => {
      a = createTenant("rls-corrected-a", dependencies);
      b = createTenant("rls-corrected-b", dependencies);
      await seedTenant(state.pools.migration, a.fixture);
      await seedTenant(state.pools.migration, b.fixture);
    });
    await runSubstep("rls_core_user_insert_refusal", async () => {
      if (!validRlsRuntimeWriteContractReproduction(dependencies.reproduction)) {
        fail("linux_gate_rls_runtime_write_reproduction_required");
      }
    });

    await runSubstep("rls_bidirectional_read", async () => {
      const ownA = await withTransaction(state.pools.runtime, (client) => client.query(
        "SELECT COUNT(*)::integer AS n FROM ia4tube_social.companies WHERE id=$1", [a.fixture.companyId]
      ), { role: RUNTIME_ROLE, companyId: a.fixture.companyId });
      const crossA = await withTransaction(state.pools.runtime, (client) => client.query(
        "SELECT COUNT(*)::integer AS n FROM ia4tube_social.companies WHERE id=$1", [b.fixture.companyId]
      ), { role: RUNTIME_ROLE, companyId: a.fixture.companyId });
      const ownB = await withTransaction(state.pools.runtime, (client) => client.query(
        "SELECT COUNT(*)::integer AS n FROM ia4tube_social.companies WHERE id=$1", [b.fixture.companyId]
      ), { role: RUNTIME_ROLE, companyId: b.fixture.companyId });
      const crossB = await withTransaction(state.pools.runtime, (client) => client.query(
        "SELECT COUNT(*)::integer AS n FROM ia4tube_social.companies WHERE id=$1", [a.fixture.companyId]
      ), { role: RUNTIME_ROLE, companyId: b.fixture.companyId });
      if ([ownA, crossA, ownB, crossB].map((result) => Number(result.rows[0].n)).join(",") !== "1,0,1,0") {
        fail("linux_gate_rls_bidirectional_read_failed");
      }
    });

    await runSubstep("rls_missing_context", async () => {
      const missingContext = await withTransaction(state.pools.runtime, (client) => client.query(
        "SELECT COUNT(*)::integer AS n FROM ia4tube_social.companies"
      ), { role: RUNTIME_ROLE });
      if (Number(missingContext.rows?.[0]?.n) !== 0) fail("linux_gate_rls_missing_context_visible");
    });
    await runSubstep("rls_tampered_context", () => expectErrorCode(
      () => withTransaction(state.pools.runtime, async (client) => {
        await client.query("SELECT set_config('ia4tube.company_id',$1,TRUE)", ["not-a-uuid"]);
        return client.query("SELECT COUNT(*)::integer AS n FROM ia4tube_social.companies");
      }, { role: RUNTIME_ROLE }),
      "22P02",
      "linux_gate_rls_tampered_context_invalid"
    ));

    const insertAuditEvent = (contextCompanyId, fixture, event, action) => withTransaction(
      state.pools.runtime,
      (client) => client.query([
        "INSERT INTO ia4tube_social.social_audit_events(",
        " company_id,id,event_id,actor_user_id,action,outcome,details_code",
        ") VALUES($1,$2,$3,$4,$5,'succeeded',$6)"
      ].join("\n"), [
        fixture.companyId,
        event.id,
        event.eventId,
        fixture.userId,
        action,
        "synthetic_linux_gate"
      ]),
      { role: RUNTIME_ROLE, companyId: contextCompanyId }
    );

    await runSubstep("rls_own_social_write", async () => {
      const ownEventA = Object.freeze({ id: crypto.randomUUID(), eventId: crypto.randomUUID() });
      const ownEventB = Object.freeze({ id: crypto.randomUUID(), eventId: crypto.randomUUID() });
      const ownWriteA = await insertAuditEvent(
        a.fixture.companyId, a.fixture, ownEventA, "linux.gate.own_a"
      );
      const ownWriteB = await insertAuditEvent(
        b.fixture.companyId, b.fixture, ownEventB, "linux.gate.own_b"
      );
      if (ownWriteA.rowCount !== 1 || ownWriteB.rowCount !== 1) {
        fail("linux_gate_rls_own_social_write_failed");
      }
    });
    await runSubstep("rls_cross_tenant_write", async () => {
      const crossEventAToB = Object.freeze({ id: crypto.randomUUID(), eventId: crypto.randomUUID() });
      const crossEventBToA = Object.freeze({ id: crypto.randomUUID(), eventId: crypto.randomUUID() });
      await expectErrorCode(
        () => insertAuditEvent(
          a.fixture.companyId, b.fixture, crossEventAToB, "linux.gate.cross_a_to_b"
        ),
        "42501",
        "linux_gate_rls_cross_write_a_to_b_invalid"
      );
      await expectErrorCode(
        () => insertAuditEvent(
          b.fixture.companyId, a.fixture, crossEventBToA, "linux.gate.cross_b_to_a"
        ),
        "42501",
        "linux_gate_rls_cross_write_b_to_a_invalid"
      );
      const countCrossEvent = (fixture, event) => withTransaction(
        state.pools.migration,
        (client) => client.query([
          "SELECT COUNT(*)::integer AS n",
          "FROM ia4tube_social.social_audit_events",
          "WHERE company_id=$1 AND id=$2"
        ].join("\n"), [fixture.companyId, event.id]),
        { role: OWNER_ROLE, companyId: fixture.companyId }
      );
      const [crossAToBRows, crossBToARows] = await Promise.all([
        countCrossEvent(b.fixture, crossEventAToB),
        countCrossEvent(a.fixture, crossEventBToA)
      ]);
      if (
        Number(crossAToBRows.rows?.[0]?.n) !== 0 ||
        Number(crossBToARows.rows?.[0]?.n) !== 0
      ) fail("linux_gate_rls_cross_write_persisted");
    });

    await runSubstep("rls_connection_scope_reset", async () => {
      const reused = await state.pools.runtime.connect();
      let connectionScopeReset = false;
      let primaryFailure = null;
      try {
        await reused.query("BEGIN");
        await reused.query(`SET LOCAL ROLE ${RUNTIME_ROLE}`);
        await reused.query("SELECT set_config('ia4tube.company_id',$1,TRUE)", [a.fixture.companyId]);
        await reused.query("COMMIT");
        await reused.query("BEGIN");
        await reused.query(`SET LOCAL ROLE ${RUNTIME_ROLE}`);
        await reused.query("SELECT set_config('ia4tube.company_id',$1,TRUE)", [b.fixture.companyId]);
        const result = await reused.query(
          "SELECT COUNT(*)::integer AS n FROM ia4tube_social.companies WHERE id=$1",
          [a.fixture.companyId]
        );
        await reused.query("COMMIT");
        connectionScopeReset = Number(result.rows[0].n) === 0;
        if (!connectionScopeReset) fail("linux_gate_rls_connection_context_leaked");
      } catch (error) {
        primaryFailure = error;
      }
      let cleanupFailure = null;
      try {
        await reused.query("ROLLBACK");
      } catch (error) {
        cleanupFailure = error;
      }
      try {
        await reused.release();
      } catch (error) {
        cleanupFailure ||= error;
      }
      if (primaryFailure) throw primaryFailure;
      if (cleanupFailure) throw cleanupFailure;
    });

    return Object.freeze({
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
  } finally {
    a?.identityKey.fill(0);
    b?.identityKey.fill(0);
  }
}

async function insertConnectedConnection(pool, fixture) {
  const { withTransaction } = require("../src/persistence/postgres/pool");
  await withTransaction(pool, (client) => client.query([
    "INSERT INTO ia4tube_social.social_connections(",
    " company_id,id,provider,status,created_by_user_id,connected_at,revision",
    ") VALUES($1,$2,'instagram','connected',$3,CURRENT_TIMESTAMP,1)"
  ].join("\n"), [fixture.companyId, fixture.activeConnectionId, fixture.userId]), {
    role: OWNER_ROLE,
    companyId: fixture.companyId
  });
}

async function databaseContainsMarker(pool, marker, companyId) {
  const { withTransaction } = require("../src/persistence/postgres/pool");
  const result = await withTransaction(pool, (client) => client.query([
    "SELECT (",
    " EXISTS(SELECT 1 FROM ia4tube_social.social_oauth_transactions row WHERE to_jsonb(row)::text LIKE '%'||$1||'%') OR",
    " EXISTS(SELECT 1 FROM ia4tube_social.social_encrypted_credentials row WHERE to_jsonb(row)::text LIKE '%'||$1||'%')",
    ") AS present"
  ].join("\n"), [marker]), { role: OWNER_ROLE, companyId });
  return result.rows?.[0]?.present === true;
}

async function runConcurrencyOAuthIdempotencyGate(state, sensitiveMarkers, dependencies = {}) {
  const { createPostgresConnectorStore } = require("../src/persistence/postgres/social-connector-store");
  const { createPostgresOAuthRepository } = require("../src/persistence/postgres/social-oauth-repository");
  const { withTransaction } = require("../src/persistence/postgres/pool");
  const runGate3Substep = typeof dependencies.runGate3Substep === "function"
    ? dependencies.runGate3Substep
    : (_substep, _operationClass, operation) => operation();
  let a;
  let b;
  let primaryFailure;
  let primaryFailed = false;
  let result;
  try {
    await runGate3Substep("S1", "internal_setup", async () => {
      a = createTenant("concurrency-a", dependencies);
      b = createTenant("concurrency-b", dependencies);
    });
    await runGate3Substep("S2", "postgres_transaction", () =>
      seedTenant(state.pools.migration, a.fixture));
    await runGate3Substep("S3", "postgres_transaction", () =>
      seedTenant(state.pools.migration, b.fixture));

    let storeA;
    let storeB;
    let connectionRecord;
    await runGate3Substep("S4", "internal_setup", async () => {
      storeA = createPostgresConnectorStore({ pool: state.pools.runtime, runtimeRole: RUNTIME_ROLE }).scope(a.context);
      storeB = createPostgresConnectorStore({ pool: state.pools.runtime, runtimeRole: RUNTIME_ROLE }).scope(b.context);
      connectionRecord = (id) => ({
        companyId: a.fixture.companyId, id, provider: "instagram",
        state: "authorization_pending", account: null, revision: 1
      });
    });
    const reservations = await runGate3Substep("S5", "postgres_concurrent_transactions", () =>
      Promise.allSettled([
        storeA.saveConnection(connectionRecord(a.fixture.connectionId), null),
        storeA.saveConnection(connectionRecord(a.fixture.secondConnectionId), null)
      ]));
    let winning;
    await runGate3Substep("S6", "internal_validation", async () => {
      exactRejection(reservations, 1, "linux_gate_connection_reservation_race_invalid", "state_transition_invalid");
      winning = reservations[0].status === "fulfilled" ? a.fixture.connectionId : a.fixture.secondConnectionId;
    });
    await runGate3Substep("S7", "postgres_inventory", async () => {
      const blocking = await withTransaction(state.pools.migration, (client) => client.query(
        "SELECT id::text AS id FROM ia4tube_social.social_connections WHERE company_id=$1 AND provider='instagram' AND status IN('pending','active','authorization_pending','connected','reconnect_required','disconnecting') ORDER BY id LIMIT 2",
        [a.fixture.companyId]
      ), { role: OWNER_ROLE, companyId: a.fixture.companyId });
      if (blocking.rows?.length !== 1 || blocking.rows[0].id !== winning) fail("linux_gate_connection_blocking_identity_invalid");
    });

    let oauthA;
    let oauthB;
    let rawState;
    let session;
    let redirectUri;
    let input;
    let consume;
    await runGate3Substep("S8", "internal_setup", async () => {
      oauthA = createPostgresOAuthRepository({ pool: state.pools.runtime, runtimeRole: RUNTIME_ROLE }).scope(a.context);
      oauthB = createPostgresOAuthRepository({ pool: state.pools.runtime, runtimeRole: RUNTIME_ROLE }).scope(b.context);
      rawState = `synthetic-linux-state-${crypto.randomBytes(32).toString("hex")}`;
      session = `synthetic-linux-session-${crypto.randomBytes(20).toString("hex")}`;
      sensitiveMarkers.push(rawState, session);
      redirectUri = "https://synthetic.invalid/social/oauth/callback";
      input = {
        authorizationHandle: a.fixture.authorizationId,
        connectionId: winning,
        purpose: "connect",
        state: rawState,
        redirectUri,
        sessionJti: session,
        expiresAt: new Date(Date.now() + 300_000)
      };
      consume = {
        authorizationHandle: input.authorizationHandle,
        state: rawState,
        redirectUri,
        sessionJti: session
      };
    });
    await runGate3Substep("S9", "postgres_transaction", () => oauthA.createAuthorization(input));
    const consumers = await runGate3Substep("S10", "postgres_concurrent_transactions", () =>
      Promise.allSettled([
        oauthA.consumeAuthorization(consume),
        oauthA.consumeAuthorization(consume)
      ]));
    await runGate3Substep("S11", "internal_validation", async () => {
      exactRejection(consumers, 1, "linux_gate_oauth_single_consumer_invalid", "social_oauth_state_already_consumed");
    });
    await runGate3Substep("S12", "postgres_concurrent_transactions", () => Promise.all([
      expectErrorCode(() => oauthA.consumeAuthorization(consume), "social_oauth_state_already_consumed", "linux_gate_oauth_replay_invalid"),
      expectErrorCode(() => oauthB.consumeAuthorization(consume), "authorization_expired", "linux_gate_oauth_cross_company_invalid")
    ]));

    let expiredState;
    let expiredSession;
    let expiredInput;
    await runGate3Substep("S13", "internal_setup", async () => {
      expiredState = `synthetic-linux-expired-${crypto.randomBytes(32).toString("hex")}`;
      expiredSession = `synthetic-linux-expired-session-${crypto.randomBytes(20).toString("hex")}`;
      sensitiveMarkers.push(expiredState, expiredSession);
      expiredInput = {
        authorizationHandle: a.fixture.expiredAuthorizationId,
        connectionId: winning,
        purpose: "connect",
        state: expiredState,
        redirectUri,
        sessionJti: expiredSession,
        expiresAt: new Date(Date.now() + 300_000)
      };
    });
    await runGate3Substep("S14", "postgres_transaction", () => oauthA.createAuthorization(expiredInput));
    await runGate3Substep("S15", "postgres_transaction", () =>
      withTransaction(state.pools.migration, async (client) => {
        const forcedExpiry = await client.query([
          "UPDATE ia4tube_social.social_oauth_transactions",
          "SET created_at=CURRENT_TIMESTAMP-INTERVAL '2 seconds',",
          " expires_at=CURRENT_TIMESTAMP-INTERVAL '1 second'",
          "WHERE company_id=$1 AND id=$2",
          " AND consumed_at IS NULL",
          " AND cancelled_at IS NULL",
          " AND failed_at IS NULL",
          "RETURNING",
          " id=$2 AS id_matches,",
          " expires_at>created_at AS expiry_after_creation,",
          " expires_at<CURRENT_TIMESTAMP AS expiry_before_current,",
          " consumed_at IS NULL AS consumed_at_is_null,",
          " cancelled_at IS NULL AS cancelled_at_is_null,",
          " failed_at IS NULL AS failed_at_is_null"
        ].join("\n"), [a.fixture.companyId, a.fixture.expiredAuthorizationId]);
        if (forcedExpiry?.rowCount !== 1 || forcedExpiry.rows?.length !== 1) {
          fail("linux_gate_oauth_force_expiry_target_invalid");
        }
        const proof = forcedExpiry.rows[0];
        if (
          proof?.id_matches !== true ||
          proof?.consumed_at_is_null !== true ||
          proof?.cancelled_at_is_null !== true ||
          proof?.failed_at_is_null !== true
        ) {
          fail("linux_gate_oauth_force_expiry_target_invalid");
        }
        if (
          proof.expiry_after_creation !== true ||
          proof.expiry_before_current !== true
        ) {
          fail("linux_gate_oauth_force_expiry_temporal_order_invalid");
        }
      }, { role: OWNER_ROLE, companyId: a.fixture.companyId }));
    await runGate3Substep("S16", "postgres_transaction", () => expectErrorCode(
      () => oauthA.consumeAuthorization({
        authorizationHandle: expiredInput.authorizationHandle,
        state: expiredState,
        redirectUri,
        sessionJti: expiredSession
      }),
      "authorization_expired",
      "linux_gate_oauth_expired_invalid"
    ));
    await runGate3Substep("S17", "postgres_inventory", async () => {
      if (
        await databaseContainsMarker(state.pools.migration, rawState, a.fixture.companyId) ||
        await databaseContainsMarker(state.pools.migration, expiredState, a.fixture.companyId)
      ) {
        fail("linux_gate_oauth_plaintext_persisted");
      }
    });

    await runGate3Substep("S18", "postgres_transaction", () => storeA.saveConnection({
      companyId: a.fixture.companyId, id: winning, provider: "instagram",
      state: "disconnected", account: null, revision: 2
    }, 1));
    await runGate3Substep("S19", "postgres_transaction", () =>
      insertConnectedConnection(state.pools.migration, a.fixture));
    await runGate3Substep("S20", "postgres_transaction", () =>
      insertConnectedConnection(state.pools.migration, b.fixture));

    let digest;
    let request;
    await runGate3Substep("S21", "internal_setup", async () => {
      digest = crypto.createHash("sha256").update("synthetic-linux-publication").digest("hex");
      request = (tenant, fixture) => ({
        capability: "publishImage",
        operationId: a.fixture.operationId,
        digest,
        payload: {
          operationId: a.fixture.operationId,
          publicationId: fixture.publicationId,
          connectionId: fixture.activeConnectionId,
          image: { mediaId: `synthetic-media-${tenant}`, mimeType: "image/jpeg" },
          caption: "Synthetic Linux caption"
        }
      });
    });
    const publicationRace = await runGate3Substep("S22", "postgres_concurrent_transactions", () =>
      Promise.all([
        storeA.beginIdempotency(request("a", a.fixture)),
        storeA.beginIdempotency(request("a", a.fixture))
      ]));
    await runGate3Substep("S23", "internal_validation", async () => {
      if (publicationRace.map((item) => item.status).sort().join(",") !== "acquired,pending") {
        fail("linux_gate_publication_idempotency_race_invalid");
      }
    });
    await runGate3Substep("S24", "postgres_transaction", () => storeA.completeIdempotency({
      capability: "publishImage", operationId: a.fixture.operationId, digest,
      result: {
        publicationId: a.fixture.publicationId,
        connectionId: a.fixture.activeConnectionId,
        provider: "instagram",
        state: "published",
        confirmedProviderReference: "synthetic-linux-provider-reference",
        reconciliationReference: null,
        revision: 3
      },
      errorCode: null
    }));
    await runGate3Substep("S25", "postgres_transaction", async () => {
      const replay = await storeA.beginIdempotency(request("a", a.fixture));
      if (replay.status !== "completed") fail("linux_gate_idempotency_same_request_not_reused");
    });
    await runGate3Substep("S26", "postgres_transaction", () => expectErrorCode(
      () => storeA.beginIdempotency({ ...request("a", a.fixture), digest: "f".repeat(64) }),
      "idempotency_conflict",
      "linux_gate_idempotency_changed_hash_invalid"
    ));
    await runGate3Substep("S27", "postgres_transaction", async () => {
      const crossTenant = await storeB.beginIdempotency(request("b", b.fixture));
      if (crossTenant.status !== "acquired") fail("linux_gate_idempotency_cross_tenant_refused");
    });
    await runGate3Substep("S28", "postgres_inventory", async () => {
      const rows = await withTransaction(state.pools.migration, (client) => client.query([
        "SELECT",
        " (SELECT COUNT(*)::integer FROM ia4tube_social.social_publications WHERE company_id=$1 AND id=$2) AS publications,",
        " (SELECT COUNT(*)::integer FROM ia4tube_social.social_publication_attempts WHERE company_id=$1 AND publication_id=$2) AS attempts"
      ].join("\n"), [a.fixture.companyId, a.fixture.publicationId]), { role: OWNER_ROLE, companyId: a.fixture.companyId });
      if (Number(rows.rows[0].publications) !== 1 || Number(rows.rows[0].attempts) !== 0) {
        fail("linux_gate_publication_duplicate_detected");
      }
    });
    result = await runGate3Substep("S29", "internal_validation", async () => Object.freeze({
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
    }));
  } catch (error) {
    primaryFailed = true;
    primaryFailure = error;
  } finally {
    try {
      await runGate3Substep("S30", "memory_cleanup", async () => {
        let cleanupFailure;
        let cleanupFailed = false;
        for (const tenant of [a, b]) {
          try {
            tenant?.identityKey.fill(0);
          } catch (error) {
            if (!cleanupFailed) {
              cleanupFailed = true;
              cleanupFailure = error;
            }
          }
        }
        if (cleanupFailed) throw cleanupFailure;
      });
    } catch (error) {
      if (!primaryFailed) {
        primaryFailed = true;
        primaryFailure = error;
      }
    }
  }
  if (primaryFailed) throw primaryFailure;
  return result;
}

async function runVaultSupplementalGate(
  state,
  sensitiveMarkers,
  { runGate4Substep = async (_substep, _operationClass, operation) => operation() } = {}
) {
  let setup = {};
  let vault;
  let result;
  let primaryFailure;
  let primaryFailed = false;

  try {
    const returnedSetup = await runGate4Substep("V10", "memory_setup", async () => {
      setup.createSocialVault = require("../src/social/vault").createSocialVault;
      const keyVersion = require("../src/social/vault-key-version");
      setup.deriveVaultKeyVersion = keyVersion.deriveVaultKeyVersion;
      setup.vaultKeyringFingerprint = keyVersion.vaultKeyringFingerprint;
      setup.token = Buffer.from(`synthetic-linux-token-${crypto.randomBytes(32).toString("hex")}`, "utf8");
      sensitiveMarkers.push(setup.token.toString("utf8"));
      setup.key = state.materials.vault;
      setup.version = setup.deriveVaultKeyVersion(1, setup.key);
      setup.context = {
        companyId: crypto.randomUUID(),
        provider: "instagram",
        credentialId: crypto.randomUUID(),
        credentialType: "access_token",
        subjectType: "connection",
        subjectId: crypto.randomUUID()
      };
      return setup;
    });
    if (returnedSetup !== undefined) setup = returnedSetup;
    const returnedVault = await runGate4Substep("V11", "memory_crypto", async () => {
      vault = setup.createSocialVault({
        keyring: { activeVersion: setup.version, keys: new Map([[setup.version, setup.key]]) },
        expectedKeyringFingerprint: setup.vaultKeyringFingerprint(setup.version, [setup.version])
      });
      return vault;
    });
    if (vault === undefined && returnedVault !== undefined) vault = returnedVault;
    const envelope = await runGate4Substep(
      "V12",
      "memory_crypto",
      async () => vault.encrypt(setup.token, setup.context)
    );
    await runGate4Substep("V13", "memory_validation", async () => {
      const correct = vault.decrypt(envelope, setup.context);
      try {
        if (!correct.equals(setup.token)) fail("linux_gate_vault_context_validation_failed");
      } finally {
        correct.fill(0);
      }
    });
    const rejected = async (operation) => {
      try { operation(); return false; } catch (error) { return error?.code === "vault_authentication_failed"; }
    };
    await runGate4Substep("V14", "memory_validation", async () => {
      if (!await rejected(() => vault.decrypt(envelope, { ...setup.context, companyId: crypto.randomUUID() }))) {
        fail("linux_gate_vault_context_validation_failed");
      }
    });
    await runGate4Substep("V15", "memory_validation", async () => {
      if (!await rejected(() => vault.decrypt(envelope, { ...setup.context, provider: "facebook" }))) {
        fail("linux_gate_vault_context_validation_failed");
      }
    });
    await runGate4Substep("V16", "memory_validation", async () => {
      if (!await rejected(() => vault.decrypt(envelope, { ...setup.context, subjectId: crypto.randomUUID() }))) {
        fail("linux_gate_vault_context_validation_failed");
      }
    });
    await runGate4Substep("V17", "memory_validation", async () => {
      if (!await rejected(() => vault.decrypt(envelope, { ...setup.context, credentialType: "refresh_token" }))) {
        fail("linux_gate_vault_context_validation_failed");
      }
    });
    result = await runGate4Substep("V18", "memory_validation", async () => {
      const tampered = { ...envelope, ciphertext: Buffer.from(envelope.ciphertext) };
      try {
        tampered.ciphertext[0] ^= 0xff;
        if (!await rejected(() => vault.decrypt(tampered, setup.context))) {
          fail("linux_gate_vault_context_validation_failed");
        }
      } finally {
        tampered.ciphertext.fill(0);
      }
      return Object.freeze({
        algorithm: "AES-256-GCM",
        aadBound: true,
        companyChangeRefused: true,
        providerChangeRefused: true,
        connectionChangeRefused: true,
        ciphertextTamperRefused: true,
        aadTamperRefused: true
      });
    });
  } catch (error) {
    primaryFailed = true;
    primaryFailure = error;
  } finally {
    try {
      await runGate4Substep("V19", "memory_cleanup", async () => {
        let cleanupFailure;
        let cleanupFailed = false;
        try {
          vault?.destroy();
        } catch (error) {
          cleanupFailed = true;
          cleanupFailure = error;
        }
        try {
          setup?.token?.fill(0);
        } catch (error) {
          if (!cleanupFailed) {
            cleanupFailed = true;
            cleanupFailure = error;
          }
        }
        if (cleanupFailed) throw cleanupFailure;
      });
    } catch (error) {
      if (!primaryFailed) {
        primaryFailed = true;
        primaryFailure = error;
      }
    }
  }
  if (primaryFailed) throw primaryFailure;
  return result;
}

const GATE4_CONNECTION_CAPACITY_SNAPSHOT_COLUMNS = Object.freeze([
  "serverMaxConnections",
  "serverReservedConnections",
  "serverSuperuserReservedConnections",
  "serverClientConnectionsBeforeV22Failure",
  "databaseConnectionLimit",
  "databaseClientConnectionsBeforeV22Failure",
  "provisionerConnectionLimit",
  "provisionerClientConnectionsBeforeV22Failure",
  "migrationConnectionLimit",
  "migrationClientConnectionsBeforeV22Failure",
  "runtimeConnectionLimit",
  "runtimeClientConnectionsBeforeV22Failure"
]);

const GATE4_CONNECTION_CAPACITY_SNAPSHOT_SQL = [
  "SELECT",
  " current_setting('max_connections')::integer AS \"serverMaxConnections\",",
  " current_setting('reserved_connections')::integer AS \"serverReservedConnections\",",
  " current_setting('superuser_reserved_connections')::integer AS \"serverSuperuserReservedConnections\",",
  " (SELECT COUNT(*)::integer FROM pg_catalog.pg_stat_activity",
  "   WHERE backend_type='client backend') AS \"serverClientConnectionsBeforeV22Failure\",",
  " (SELECT datconnlimit::integer FROM pg_catalog.pg_database",
  "   WHERE datname=$1) AS \"databaseConnectionLimit\",",
  " (SELECT COUNT(*)::integer FROM pg_catalog.pg_stat_activity",
  "   WHERE backend_type='client backend'",
  "     AND datname=$1)",
  "   AS \"databaseClientConnectionsBeforeV22Failure\",",
  " (SELECT rolconnlimit::integer FROM pg_catalog.pg_roles",
  "   WHERE rolname=$2) AS \"provisionerConnectionLimit\",",
  " (SELECT COUNT(*)::integer FROM pg_catalog.pg_stat_activity",
  "   WHERE backend_type='client backend'",
  "     AND usename=$2)",
  "   AS \"provisionerClientConnectionsBeforeV22Failure\",",
  " (SELECT rolconnlimit::integer FROM pg_catalog.pg_roles",
  "   WHERE rolname=$3) AS \"migrationConnectionLimit\",",
  " (SELECT COUNT(*)::integer FROM pg_catalog.pg_stat_activity",
  "   WHERE backend_type='client backend'",
  "     AND usename=$3)",
  "   AS \"migrationClientConnectionsBeforeV22Failure\",",
  " (SELECT rolconnlimit::integer FROM pg_catalog.pg_roles",
  "   WHERE rolname=$4) AS \"runtimeConnectionLimit\",",
  " (SELECT COUNT(*)::integer FROM pg_catalog.pg_stat_activity",
  "   WHERE backend_type='client backend'",
  "     AND usename=$4)",
  "   AS \"runtimeClientConnectionsBeforeV22Failure\""
].join("\n");

function unavailableGate4ConnectionCapacitySnapshot() {
  const role = () => Object.freeze({
    connectionLimit: null,
    clientConnectionsBeforeV22Failure: null
  });
  return Object.freeze({
    server: Object.freeze({
      maxConnections: null,
      reservedConnections: null,
      superuserReservedConnections: null,
      clientConnectionsBeforeV22Failure: null
    }),
    database: Object.freeze({
      connectionLimit: null,
      clientConnectionsBeforeV22Failure: null
    }),
    roles: Object.freeze({
      provisioner: role(),
      migration: role(),
      runtime: role()
    })
  });
}

function parseGate4ConnectionCapacitySnapshot(result) {
  if (!Array.isArray(result?.rows) || result.rows.length !== 1) return null;
  const row = result.rows[0];
  if (
    !row || Object.getPrototypeOf(row) !== Object.prototype ||
    Object.keys(row).sort().join("\n") !== [...GATE4_CONNECTION_CAPACITY_SNAPSHOT_COLUMNS].sort().join("\n")
  ) return null;
  const nonnegative = (value) => Number.isSafeInteger(value) && value >= 0;
  const connectionLimit = (value) => Number.isSafeInteger(value) && (value === -1 || value >= 0);
  if (
    !Number.isSafeInteger(row.serverMaxConnections) || row.serverMaxConnections <= 0 ||
    !nonnegative(row.serverReservedConnections) ||
    !nonnegative(row.serverSuperuserReservedConnections) ||
    !nonnegative(row.serverClientConnectionsBeforeV22Failure) ||
    !connectionLimit(row.databaseConnectionLimit) ||
    !nonnegative(row.databaseClientConnectionsBeforeV22Failure) ||
    !connectionLimit(row.provisionerConnectionLimit) ||
    !nonnegative(row.provisionerClientConnectionsBeforeV22Failure) ||
    !connectionLimit(row.migrationConnectionLimit) ||
    !nonnegative(row.migrationClientConnectionsBeforeV22Failure) ||
    !connectionLimit(row.runtimeConnectionLimit) ||
    !nonnegative(row.runtimeClientConnectionsBeforeV22Failure)
  ) return null;
  const role = (prefix) => Object.freeze({
    connectionLimit: row[`${prefix}ConnectionLimit`],
    clientConnectionsBeforeV22Failure: row[`${prefix}ClientConnectionsBeforeV22Failure`]
  });
  return Object.freeze({
    server: Object.freeze({
      maxConnections: row.serverMaxConnections,
      reservedConnections: row.serverReservedConnections,
      superuserReservedConnections: row.serverSuperuserReservedConnections,
      clientConnectionsBeforeV22Failure: row.serverClientConnectionsBeforeV22Failure
    }),
    database: Object.freeze({
      connectionLimit: row.databaseConnectionLimit,
      clientConnectionsBeforeV22Failure: row.databaseClientConnectionsBeforeV22Failure
    }),
    roles: Object.freeze({
      provisioner: role("provisioner"),
      migration: role("migration"),
      runtime: role("runtime")
    })
  });
}

function gate4ConnectionCapacityPoolSnapshot(entry) {
  const result = {
    configuredMax: entry?.configuredMax,
    totalCount: entry?.pool?.totalCount,
    idleCount: entry?.pool?.idleCount,
    waitingCount: entry?.pool?.waitingCount,
    connectAttempts: entry?.connectAttempts,
    connectSucceeded: entry?.connectSucceeded,
    connectionCapacityFailures: entry?.connectionCapacityFailures
  };
  if (
    !Number.isSafeInteger(result.configuredMax) || result.configuredMax <= 0 ||
    Object.entries(result).some(([key, value]) =>
      key !== "configuredMax" && (!Number.isSafeInteger(value) || value < 0)
    )
  ) fail("linux_gate_connection_capacity_pool_counters_invalid");
  return Object.freeze(result);
}

function createGate4ConnectionCapacityCapture(state) {
  const pools = {
    mainMigration: {
      pool: state?.pools?.migration,
      configuredMax: state?.pools?.migration?.options?.max,
      connectAttempts: 0,
      connectSucceeded: 0,
      connectionCapacityFailures: 0
    },
    mainRuntime: {
      pool: state?.pools?.runtime,
      configuredMax: state?.pools?.runtime?.options?.max,
      connectAttempts: 0,
      connectSucceeded: 0,
      connectionCapacityFailures: 0
    },
    verifierMigration: null,
    verifierRuntime: null
  };
  let armed = false;
  let latch = "not_attempted";
  let snapshot = null;

  async function captureOnFunctionalClient(client) {
    if (!armed || latch !== "not_attempted") return;
    latch = "unavailable";
    if (!client || typeof client.query !== "function") return;
    try {
      const result = await client.query(GATE4_CONNECTION_CAPACITY_SNAPSHOT_SQL, [
        state.database,
        PROVISIONER_LOGIN,
        MIGRATION_LOGIN,
        RUNTIME_LOGIN
      ]);
      const parsed = parseGate4ConnectionCapacitySnapshot(result);
      if (parsed) {
        snapshot = parsed;
        latch = "captured";
      }
    } catch {}
  }

  function instrumentVerifierPool(login, pool, configuredMax) {
    const category = login === MIGRATION_LOGIN
      ? "verifierMigration"
      : login === RUNTIME_LOGIN
        ? "verifierRuntime"
        : null;
    if (
      !category || pools[category] !== null || !pool || typeof pool.connect !== "function" ||
      !Number.isSafeInteger(configuredMax) || configuredMax <= 0
    ) fail("linux_gate_connection_capacity_verifier_pool_invalid");
    const entry = {
      pool,
      configuredMax,
      connectAttempts: 0,
      connectSucceeded: 0,
      connectionCapacityFailures: 0
    };
    pools[category] = entry;
    const connect = pool.connect.bind(pool);
    const recordFailure = (error) => {
      if (error?.code === "53300") {
        entry.connectionCapacityFailures += 1;
        if (armed && latch === "not_attempted") latch = "unavailable";
      }
    };
    const connected = async (client) => {
      entry.connectSucceeded += 1;
      await captureOnFunctionalClient(client);
      return client;
    };
    Object.defineProperty(pool, "connect", {
      configurable: true,
      enumerable: false,
      writable: false,
      value(...args) {
        entry.connectAttempts += 1;
        const callbackIndex = typeof args.at(-1) === "function" ? args.length - 1 : -1;
        if (callbackIndex >= 0) {
          const callback = args[callbackIndex];
          const delegated = [...args];
          delegated[callbackIndex] = (...callbackArgs) => {
            const [error, client] = callbackArgs;
            if (error) {
              recordFailure(error);
              callback(...callbackArgs);
              return;
            }
            entry.connectSucceeded += 1;
            void captureOnFunctionalClient(client).then(
              () => callback(...callbackArgs),
              () => callback(...callbackArgs)
            );
          };
          try {
            return connect(...delegated);
          } catch (error) {
            recordFailure(error);
            throw error;
          }
        }
        let pending;
        try {
          pending = connect(...args);
        } catch (error) {
          recordFailure(error);
          throw error;
        }
        return Promise.resolve(pending).then(
          connected,
          (error) => {
            recordFailure(error);
            throw error;
          }
        );
      }
    });
    return pool;
  }

  return Object.freeze({
    arm() { armed = true; },
    instrumentVerifierPool,
    candidate() {
      const databaseSnapshot = latch === "captured" && snapshot
        ? snapshot
        : unavailableGate4ConnectionCapacitySnapshot();
      return Object.freeze({
        server: databaseSnapshot.server,
        database: databaseSnapshot.database,
        roles: databaseSnapshot.roles,
        pools: Object.freeze({
          mainMigration: gate4ConnectionCapacityPoolSnapshot(pools.mainMigration),
          mainRuntime: gate4ConnectionCapacityPoolSnapshot(pools.mainRuntime),
          verifierMigration: gate4ConnectionCapacityPoolSnapshot(pools.verifierMigration),
          verifierRuntime: gate4ConnectionCapacityPoolSnapshot(pools.verifierRuntime)
        })
      });
    }
  });
}

function createVerifierPoolCleanupRegistry() {
  const pools = [];

  function register(pool) {
    if (!pool || typeof pool !== "object" || typeof pool.end !== "function") {
      fail("linux_gate_verifier_pool_cleanup_contract_invalid");
    }
    const originalEnd = pool.end.bind(pool);
    let endPromise;
    Object.defineProperty(pool, "end", {
      configurable: true,
      enumerable: false,
      writable: false,
      value(...args) {
        if (!endPromise) {
          try {
            endPromise = Promise.resolve(originalEnd(...args));
          } catch (error) {
            endPromise = Promise.reject(error);
          }
        }
        return endPromise;
      }
    });
    pools.push(pool);
    return pool;
  }

  async function closeAll() {
    let firstFailure;
    for (const pool of [...pools].reverse()) {
      try {
        await pool.end();
      } catch (error) {
        if (!firstFailure) firstFailure = error;
      }
    }
    if (firstFailure) throw firstFailure;
    return true;
  }

  return Object.freeze({ closeAll, register });
}

function createLocalVerifierPoolClass({
  PoolClass,
  port,
  database,
  passwords,
  gate4ConnectionCapacityCapture = null,
  registerVerifierPool = (pool) => pool
}) {
  if (typeof registerVerifierPool !== "function") {
    fail("linux_gate_verifier_pool_cleanup_contract_invalid");
  }
  return class LinuxLocalVerifierPool {
    constructor(configuration) {
      let parsed;
      try { parsed = new URL(configuration.connectionString); } catch { fail("linux_gate_verifier_target_invalid"); }
      const login = decodeURIComponent(parsed.username);
      const password = decodeURIComponent(parsed.password);
      if (
        parsed.hostname !== VERIFIER_HOST || Number(parsed.port) !== port ||
        decodeURIComponent(parsed.pathname.slice(1)) !== database || password !== passwords[login] ||
        configuration.ssl?.rejectUnauthorized !== true || configuration.ssl?.servername !== VERIFIER_HOST
      ) fail("linux_gate_verifier_target_invalid");
      const pool = new PoolClass({
        ...configuration,
        connectionString: undefined,
        host: LOOPBACK,
        port,
        database,
        user: login,
        password,
        ssl: false
      });
      const registeredPool = registerVerifierPool(pool);
      if (registeredPool !== pool) {
        fail("linux_gate_verifier_pool_cleanup_contract_invalid");
      }
      return gate4ConnectionCapacityCapture
        ? gate4ConnectionCapacityCapture.instrumentVerifierPool(
          login,
          registeredPool,
          configuration.max
        )
        : registeredPool;
    }
  };
}

function createRestoreBehaviorFacade(legacy2ARoot) {
  const original = require("../src/persistence/postgres/restore-behavior-verifiers");
  return Object.freeze({
    createRestoreBehaviorVerifiers(options) {
      return original.createRestoreBehaviorVerifiers({
        ...options,
        legacy2ARoot
      });
    }
  });
}

async function runPersistedVaultGate(
  state,
  sensitiveMarkers,
  legacy2ARoot,
  {
    runGate4Substep = async (_substep, _operationClass, operation) => operation(),
    recordGate4ConnectionCapacityDiagnostics,
    retirePrimaryMigrationPoolBeforePersistedVault
  } = {}
) {
  let setup = {};
  let gate;
  let result;
  let primaryFailure;
  let primaryFailed = false;
  let primaryMigrationPoolRetired = false;
  const verifierPoolCleanup = createVerifierPoolCleanupRegistry();
  const gate4ConnectionCapacityCapture =
    typeof recordGate4ConnectionCapacityDiagnostics === "function"
      ? createGate4ConnectionCapacityCapture(state)
      : null;

  try {
    const returnedSetup = await runGate4Substep("V20", "memory_setup", async () => {
      setup.original = require("../src/persistence/postgres/restore-behavior-verifiers");
      setup.passwords = {
        [MIGRATION_LOGIN]: state.passwords[MIGRATION_LOGIN],
        [RUNTIME_LOGIN]: state.passwords[RUNTIME_LOGIN]
      };
      setup.databaseUrl = (login) => {
        const value = new URL(`postgresql://${VERIFIER_HOST}:${state.target.port}/${state.database}`);
        value.username = login;
        value.password = setup.passwords[login];
        value.searchParams.set("sslmode", "verify-full");
        return value.toString();
      };
      setup.persistedA = Buffer.from(`persisted-a-${crypto.randomBytes(18).toString("hex")}`.slice(0, 48), "utf8");
      setup.persistedB = Buffer.from(`persisted-b-${crypto.randomBytes(18).toString("hex")}`.slice(0, 48), "utf8");
      if (setup.persistedA.length !== 48 || setup.persistedB.length !== 48) {
        fail("linux_gate_persisted_marker_invalid");
      }
      sensitiveMarkers.push(setup.persistedA.toString("utf8"), setup.persistedB.toString("utf8"));
      return setup;
    });
    if (returnedSetup !== undefined) setup = returnedSetup;
    const returnedGate = await runGate4Substep("V21", "postgres_verifier_setup", async () => {
      if (typeof retirePrimaryMigrationPoolBeforePersistedVault !== "function") {
        fail("linux_gate_primary_migration_pool_retirement_invalid");
      }
      if ((await retirePrimaryMigrationPoolBeforePersistedVault()) !== true) {
        fail("linux_gate_primary_migration_pool_retirement_invalid");
      }
      primaryMigrationPoolRetired = true;
      let plaintextIndex = 0;
      gate = setup.original.createRestoreBehaviorVerifiers({
        env: {},
        migrationDatabaseUrl: setup.databaseUrl(MIGRATION_LOGIN),
        runtimeDatabaseUrl: setup.databaseUrl(RUNTIME_LOGIN),
        expectedMigrationLogin: MIGRATION_LOGIN,
        expectedRuntimeLogin: RUNTIME_LOGIN,
        legacy2ARoot,
        randomBytes(size) {
          if (size === 48) {
            const source = plaintextIndex++ === 0 ? setup.persistedA : setup.persistedB;
            return Buffer.from(source);
          }
          return crypto.randomBytes(size);
        },
        dependencies: {
          PoolClass: createLocalVerifierPoolClass({
            PoolClass: state.PoolClass,
            port: state.target.port,
            database: state.database,
            passwords: setup.passwords,
            gate4ConnectionCapacityCapture,
            registerVerifierPool: verifierPoolCleanup.register
          })
        }
      });
      return gate;
    });
    if (gate === undefined && returnedGate !== undefined) gate = returnedGate;
    if (primaryMigrationPoolRetired !== true) {
      fail("linux_gate_primary_migration_pool_retirement_invalid");
    }
    gate4ConnectionCapacityCapture?.arm();
    try {
      await runGate4Substep("V22", "postgres_runtime_isolation", async () => {
        if ((await gate.verifiers.verifyRuntimeIsolation()) !== true) {
          fail("linux_gate_persisted_runtime_isolation_failed");
        }
      });
    } catch (error) {
      if (error?.code === "53300" && gate4ConnectionCapacityCapture) {
        try {
          recordGate4ConnectionCapacityDiagnostics(
            gate4ConnectionCapacityCapture.candidate()
          );
        } catch {}
      }
      throw error;
    }
    result = await runGate4Substep("V23", "postgres_vault_verification", async () => {
      if ((await gate.verifiers.verifyVault()) !== true) fail("linux_gate_persisted_vault_failed");
      return Object.freeze({
        runtimeIsolationPrerequisite: true,
        persistedRoundTrip: true,
        keyRotation: true,
        retirementWhileInUseRefused: true,
        plaintextDatabaseAbsent: true
      });
    });
  } catch (error) {
    primaryFailed = true;
    primaryFailure = error;
  } finally {
    try {
      await runGate4Substep("V24", "postgres_verifier_cleanup", async () => {
        let cleanupFailure;
        let cleanupFailed = false;
        try {
          if (gate) await gate.close();
        } catch (error) {
          cleanupFailed = true;
          cleanupFailure = error;
        }
        try {
          await verifierPoolCleanup.closeAll();
        } catch (error) {
          if (!cleanupFailed) {
            cleanupFailed = true;
            cleanupFailure = error;
          }
        }
        if (cleanupFailed) throw cleanupFailure;
      });
    } catch (error) {
      if (!primaryFailed) {
        primaryFailed = true;
        primaryFailure = error;
      }
    }
    try {
      await runGate4Substep("V25", "memory_cleanup", async () => {
        let cleanupFailure;
        let cleanupFailed = false;
        try {
          setup?.persistedA?.fill(0);
        } catch (error) {
          cleanupFailed = true;
          cleanupFailure = error;
        }
        try {
          setup?.persistedB?.fill(0);
        } catch (error) {
          if (!cleanupFailed) {
            cleanupFailed = true;
            cleanupFailure = error;
          }
        }
        if (cleanupFailed) throw cleanupFailure;
      });
    } catch (error) {
      if (!primaryFailed) {
        primaryFailed = true;
        primaryFailure = error;
      }
    }
  }
  if (primaryFailed) throw primaryFailure;
  return result;
}

module.exports = {
  LinuxPhysicalGateFailure,
  createLocalVerifierPoolClass,
  createRestoreBehaviorFacade,
  createTenant,
  databaseContainsMarker,
  runConcurrencyOAuthIdempotencyGate,
  runPersistedVaultGate,
  runRlsAndRoleGate,
  runRlsPrivilegeInventoryContextReproduction,
  runRlsRuntimeWriteContractReproduction,
  runRuntimeAttributesTextResolutionReproduction,
  runVaultSupplementalGate,
  runtimeWritePrivilegeInventory,
  seedTenant
};
