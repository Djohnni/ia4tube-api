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

async function runRlsAndRoleGate(state, dependencies = {}) {
  if (dependencies.baseRlsGatePassed !== true) {
    fail("linux_gate_rls_base_gate_prerequisite_missing");
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

    await runSubstep("rls_runtime_role_attributes", async () => {
      const attributes = await state.pools.migration.query([
        "SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication,",
        " pg_has_role($1,'ia4tube_social_migrator','MEMBER') AS migrator_member,",
        " has_table_privilege($1,'ia4tube_migrations.schema_migrations','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS migration_table_privilege,",
        " has_schema_privilege($1,'ia4tube_migrations','CREATE') AS migration_schema_create",
        "FROM pg_catalog.pg_roles WHERE rolname=$1"
      ].join("\n"), [RUNTIME_LOGIN]);
      const role = attributes.rows?.[0];
      if (!role || role.rolsuper || role.rolbypassrls || role.rolcreatedb || role.rolcreaterole || role.rolreplication || role.migrator_member || role.migration_table_privilege || role.migration_schema_create) {
        fail("linux_gate_runtime_role_privileged");
      }
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
  const a = createTenant("concurrency-a", dependencies);
  const b = createTenant("concurrency-b", dependencies);
  try {
    await seedTenant(state.pools.migration, a.fixture);
    await seedTenant(state.pools.migration, b.fixture);
    const storeA = createPostgresConnectorStore({ pool: state.pools.runtime, runtimeRole: RUNTIME_ROLE }).scope(a.context);
    const storeB = createPostgresConnectorStore({ pool: state.pools.runtime, runtimeRole: RUNTIME_ROLE }).scope(b.context);
    const connectionRecord = (id) => ({
      companyId: a.fixture.companyId, id, provider: "instagram",
      state: "authorization_pending", account: null, revision: 1
    });
    const reservations = await Promise.allSettled([
      storeA.saveConnection(connectionRecord(a.fixture.connectionId), null),
      storeA.saveConnection(connectionRecord(a.fixture.secondConnectionId), null)
    ]);
    exactRejection(reservations, 1, "linux_gate_connection_reservation_race_invalid", "state_transition_invalid");
    const winning = reservations[0].status === "fulfilled" ? a.fixture.connectionId : a.fixture.secondConnectionId;
    const blocking = await withTransaction(state.pools.migration, (client) => client.query(
      "SELECT id::text AS id FROM ia4tube_social.social_connections WHERE company_id=$1 AND provider='instagram' AND status IN('pending','active','authorization_pending','connected','reconnect_required','disconnecting') ORDER BY id LIMIT 2",
      [a.fixture.companyId]
    ), { role: OWNER_ROLE, companyId: a.fixture.companyId });
    if (blocking.rows?.length !== 1 || blocking.rows[0].id !== winning) fail("linux_gate_connection_blocking_identity_invalid");

    const oauthA = createPostgresOAuthRepository({ pool: state.pools.runtime, runtimeRole: RUNTIME_ROLE }).scope(a.context);
    const oauthB = createPostgresOAuthRepository({ pool: state.pools.runtime, runtimeRole: RUNTIME_ROLE }).scope(b.context);
    const rawState = `synthetic-linux-state-${crypto.randomBytes(32).toString("hex")}`;
    const session = `synthetic-linux-session-${crypto.randomBytes(20).toString("hex")}`;
    sensitiveMarkers.push(rawState, session);
    const redirectUri = "https://synthetic.invalid/social/oauth/callback";
    const input = {
      authorizationHandle: a.fixture.authorizationId,
      connectionId: winning,
      purpose: "connect",
      state: rawState,
      redirectUri,
      sessionJti: session,
      expiresAt: new Date(Date.now() + 300_000)
    };
    await oauthA.createAuthorization(input);
    const consume = {
      authorizationHandle: input.authorizationHandle,
      state: rawState,
      redirectUri,
      sessionJti: session
    };
    const consumers = await Promise.allSettled([
      oauthA.consumeAuthorization(consume),
      oauthA.consumeAuthorization(consume)
    ]);
    exactRejection(consumers, 1, "linux_gate_oauth_single_consumer_invalid", "authorization_expired");
    await Promise.all([
      expectErrorCode(() => oauthA.consumeAuthorization(consume), "authorization_expired", "linux_gate_oauth_replay_invalid"),
      expectErrorCode(() => oauthB.consumeAuthorization(consume), "authorization_expired", "linux_gate_oauth_cross_company_invalid")
    ]);
    const expiredState = `synthetic-linux-expired-${crypto.randomBytes(32).toString("hex")}`;
    const expiredSession = `synthetic-linux-expired-session-${crypto.randomBytes(20).toString("hex")}`;
    sensitiveMarkers.push(expiredState, expiredSession);
    const expiredInput = {
      authorizationHandle: a.fixture.expiredAuthorizationId,
      connectionId: winning,
      purpose: "connect",
      state: expiredState,
      redirectUri,
      sessionJti: expiredSession,
      expiresAt: new Date(Date.now() + 300_000)
    };
    await oauthA.createAuthorization(expiredInput);
    await withTransaction(state.pools.migration, (client) => client.query(
      "UPDATE ia4tube_social.social_oauth_transactions SET expires_at=CURRENT_TIMESTAMP-INTERVAL '1 second' WHERE company_id=$1 AND id=$2",
      [a.fixture.companyId, a.fixture.expiredAuthorizationId]
    ), { role: OWNER_ROLE, companyId: a.fixture.companyId });
    await expectErrorCode(() => oauthA.consumeAuthorization({
      authorizationHandle: expiredInput.authorizationHandle,
      state: expiredState,
      redirectUri,
      sessionJti: expiredSession
    }), "authorization_expired", "linux_gate_oauth_expired_invalid");
    if (
      await databaseContainsMarker(state.pools.migration, rawState, a.fixture.companyId) ||
      await databaseContainsMarker(state.pools.migration, expiredState, a.fixture.companyId)
    ) {
      fail("linux_gate_oauth_plaintext_persisted");
    }

    await storeA.saveConnection({
      companyId: a.fixture.companyId, id: winning, provider: "instagram",
      state: "disconnected", account: null, revision: 2
    }, 1);
    await insertConnectedConnection(state.pools.migration, a.fixture);
    await insertConnectedConnection(state.pools.migration, b.fixture);
    const digest = crypto.createHash("sha256").update("synthetic-linux-publication").digest("hex");
    const request = (tenant, fixture) => ({
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
    const publicationRace = await Promise.all([
      storeA.beginIdempotency(request("a", a.fixture)),
      storeA.beginIdempotency(request("a", a.fixture))
    ]);
    if (publicationRace.map((item) => item.status).sort().join(",") !== "acquired,pending") {
      fail("linux_gate_publication_idempotency_race_invalid");
    }
    await storeA.completeIdempotency({
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
    });
    const replay = await storeA.beginIdempotency(request("a", a.fixture));
    if (replay.status !== "completed") fail("linux_gate_idempotency_same_request_not_reused");
    await expectErrorCode(
      () => storeA.beginIdempotency({ ...request("a", a.fixture), digest: "f".repeat(64) }),
      "idempotency_conflict",
      "linux_gate_idempotency_changed_hash_invalid"
    );
    const crossTenant = await storeB.beginIdempotency(request("b", b.fixture));
    if (crossTenant.status !== "acquired") fail("linux_gate_idempotency_cross_tenant_refused");
    const rows = await withTransaction(state.pools.migration, (client) => client.query([
      "SELECT",
      " (SELECT COUNT(*)::integer FROM ia4tube_social.social_publications WHERE company_id=$1 AND id=$2) AS publications,",
      " (SELECT COUNT(*)::integer FROM ia4tube_social.social_publication_attempts WHERE company_id=$1 AND publication_id=$2) AS attempts"
    ].join("\n"), [a.fixture.companyId, a.fixture.publicationId]), { role: OWNER_ROLE, companyId: a.fixture.companyId });
    if (Number(rows.rows[0].publications) !== 1 || Number(rows.rows[0].attempts) !== 0) {
      fail("linux_gate_publication_duplicate_detected");
    }
    return Object.freeze({
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
  } finally {
    a.identityKey.fill(0);
    b.identityKey.fill(0);
  }
}

async function runVaultSupplementalGate(state, sensitiveMarkers) {
  const { createSocialVault } = require("../src/social/vault");
  const { deriveVaultKeyVersion, vaultKeyringFingerprint } = require("../src/social/vault-key-version");
  const token = Buffer.from(`synthetic-linux-token-${crypto.randomBytes(32).toString("hex")}`, "utf8");
  sensitiveMarkers.push(token.toString("utf8"));
  const key = state.materials.vault;
  const version = deriveVaultKeyVersion(1, key);
  const vault = createSocialVault({
    keyring: { activeVersion: version, keys: new Map([[version, key]]) },
    expectedKeyringFingerprint: vaultKeyringFingerprint(version, [version])
  });
  const context = {
    companyId: crypto.randomUUID(),
    provider: "instagram",
    credentialId: crypto.randomUUID(),
    credentialType: "access_token",
    subjectType: "connection",
    subjectId: crypto.randomUUID()
  };
  try {
    const envelope = vault.encrypt(token, context);
    const correct = vault.decrypt(envelope, context);
    const correctRoundTrip = correct.equals(token);
    correct.fill(0);
    const rejected = async (operation) => {
      try { operation(); return false; } catch (error) { return error?.code === "vault_authentication_failed"; }
    };
    const companyChanged = await rejected(() => vault.decrypt(envelope, { ...context, companyId: crypto.randomUUID() }));
    const providerChanged = await rejected(() => vault.decrypt(envelope, { ...context, provider: "facebook" }));
    const connectionChanged = await rejected(() => vault.decrypt(envelope, { ...context, subjectId: crypto.randomUUID() }));
    const aadChanged = await rejected(() => vault.decrypt(envelope, { ...context, credentialType: "refresh_token" }));
    const tampered = { ...envelope, ciphertext: Buffer.from(envelope.ciphertext) };
    tampered.ciphertext[0] ^= 0xff;
    const ciphertextChanged = await rejected(() => vault.decrypt(tampered, context));
    tampered.ciphertext.fill(0);
    if (!correctRoundTrip || !companyChanged || !providerChanged || !connectionChanged || !aadChanged || !ciphertextChanged) {
      fail("linux_gate_vault_context_validation_failed");
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
  } finally {
    vault.destroy();
    token.fill(0);
  }
}

function createLocalVerifierPoolClass({ PoolClass, port, database, passwords }) {
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
      return new PoolClass({
        ...configuration,
        connectionString: undefined,
        host: LOOPBACK,
        port,
        database,
        user: login,
        password,
        ssl: false
      });
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

async function runPersistedVaultGate(state, sensitiveMarkers, legacy2ARoot) {
  const original = require("../src/persistence/postgres/restore-behavior-verifiers");
  const passwords = {
    [MIGRATION_LOGIN]: state.passwords[MIGRATION_LOGIN],
    [RUNTIME_LOGIN]: state.passwords[RUNTIME_LOGIN]
  };
  const databaseUrl = (login) => {
    const value = new URL(`postgresql://${VERIFIER_HOST}:${state.target.port}/${state.database}`);
    value.username = login;
    value.password = passwords[login];
    value.searchParams.set("sslmode", "verify-full");
    return value.toString();
  };
  const persistedA = Buffer.from(`persisted-a-${crypto.randomBytes(18).toString("hex")}`.slice(0, 48), "utf8");
  const persistedB = Buffer.from(`persisted-b-${crypto.randomBytes(18).toString("hex")}`.slice(0, 48), "utf8");
  if (persistedA.length !== 48 || persistedB.length !== 48) fail("linux_gate_persisted_marker_invalid");
  sensitiveMarkers.push(persistedA.toString("utf8"), persistedB.toString("utf8"));
  let plaintextIndex = 0;
  const gate = original.createRestoreBehaviorVerifiers({
    env: {},
    migrationDatabaseUrl: databaseUrl(MIGRATION_LOGIN),
    runtimeDatabaseUrl: databaseUrl(RUNTIME_LOGIN),
    expectedMigrationLogin: MIGRATION_LOGIN,
    expectedRuntimeLogin: RUNTIME_LOGIN,
    legacy2ARoot,
    randomBytes(size) {
      if (size === 48) {
        const source = plaintextIndex++ === 0 ? persistedA : persistedB;
        return Buffer.from(source);
      }
      return crypto.randomBytes(size);
    },
    dependencies: {
      PoolClass: createLocalVerifierPoolClass({
        PoolClass: state.PoolClass,
        port: state.target.port,
        database: state.database,
        passwords
      })
    }
  });
  try {
    if ((await gate.verifiers.verifyRuntimeIsolation()) !== true) fail("linux_gate_persisted_runtime_isolation_failed");
    if ((await gate.verifiers.verifyVault()) !== true) fail("linux_gate_persisted_vault_failed");
    return Object.freeze({
      runtimeIsolationPrerequisite: true,
      persistedRoundTrip: true,
      keyRotation: true,
      retirementWhileInUseRefused: true,
      plaintextDatabaseAbsent: true
    });
  } finally {
    await gate.close();
    persistedA.fill(0);
    persistedB.fill(0);
  }
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
  runVaultSupplementalGate,
  runtimeWritePrivilegeInventory,
  seedTenant
};
