"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  LinuxPostgresFailure,
  instrumentedPoolClass
} = require("../scripts/social-3a0p-linux-postgres");
const {
  createPoolMetricsRegistry
} = require("../scripts/social-3a0p-local-runtime-evidence-metrics");
const {
  createProfile0003SocialRepositoryBridge,
  createProfileAwareSocialRepositoryFactory
} = require("../scripts/social-3a0p-local-windows-physical-plans");
const { Pool: PgPool } = require("pg");
const {
  MIGRATION_CONNECTION_LIMIT,
  MIGRATOR_ROLE,
  RUNTIME_CONNECTION_LIMIT,
  RUNTIME_ROLE,
  targetFingerprint,
  verifyProvisionedLoginCredentials
} = require("../src/persistence/postgres/login-bootstrap");
const {
  SCHEMA_PROFILES
} = require("../src/persistence/postgres/backup-restore");
const {
  createSocialRepository
} = require("../src/persistence/postgres/social-repository");
const {
  createVaultKeyRegistryAdmin
} = require("../src/persistence/postgres/vault-key-registry-admin");
const {
  createSocialCredentialService
} = require("../src/social/credential-service");
const {
  deriveVaultKeyVersion
} = require("../src/social/vault-key-version");
const {
  BASE_COMMIT,
  BRANCH,
  GATE_PROCESS_STATUS_FILE,
  GATE_PROCESS_STATUS_HASH_FILE,
  canonicalJson,
  containsMarkerInTree,
  createBackupRestoreProvenanceTracker,
  createBackupTransportBridge,
  createDrainAwareRunTool,
  createGate1MigrationPoolLifecycle,
  createGate3FailureProvenanceTracker,
  createGate4FailureProvenanceTracker,
  createLinuxProfile0003PlansFacade,
  createLinuxProfileBackupRunner,
  createLinuxProfileRestoreRunner,
  createLinuxRestoreConfigFacade,
  createPhaseRunner,
  createPhysicalPoolDrainTracker,
  createPrivatePlanPoolOptionsAdapter,
  createRlsFailureProvenanceTracker,
  createRlsRuntimeWriteContractOrchestrator,
  createRestoreBehaviorFacade,
  createRoleScopedPlanPoolClass,
  createVerifiedLoginCredentialPoolBridge,
  evidenceSafe,
  failureCode,
  gate3FailureCode,
  gate4FailureCode,
  gateProcessStatusFromChildResult,
  isLinuxRestoreDatabase,
  isRestoreEmptyTargetInventoryQuery,
  migrationEvidence,
  prepareLinuxRestoreTarget,
  publicBackupTransportEvidence,
  publicBootstrapEvidence,
  publicPlatformEvidence,
  publicRlsPrivilegeInventoryContextReproductionEvidence,
  publicRlsRoleGateEvidence,
  publicRlsRuntimeAttributesTextResolutionReproductionEvidence,
  publicRlsRuntimeWriteContractReproductionEvidence,
  retirePrimaryPoolsBeforeBackup,
  rlsFailureCode,
  sanitizedBackupRestoreFailureProvenance,
  sanitizedFailureEvidence,
  sanitizedGate3FailureProvenance,
  sanitizedGate4FailureProvenance,
  sanitizedGateProcessStatus,
  sanitizedRlsFailureProvenance,
  runRlsPrivilegeInventoryContextPhase,
  runRlsRuntimeAttributesTextResolutionPhase,
  runGateProcessSupervisor,
  writeGateProcessStatus
} = require("../scripts/social-3a0p-linux-gate");

const ROOT = path.resolve(__dirname, "..");
const PROFILE_0003_ID = "social-schema-0003";
const PROFILE_0004_ID = "social-schema-0004";
const PROFILE_0004_ONLY_RELATIONS = Object.freeze([
  "social_idempotency_operations",
  "social_publications",
  "social_publication_attempts"
]);

function validRlsBaseGateResult(overrides = {}) {
  return {
    physicalExecution: true,
    syntheticOnly: true,
    tenantIsolation: true,
    missingContextRefused: true,
    tamperedContextRefused: true,
    forceRls: true,
    syntheticCompanies: 2,
    ...overrides
  };
}

function validRlsInventoryContextReproductionResult(overrides = {}) {
  return {
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
    migratorSessionIdentityPreserved: true,
    migratorRoleActivated: true,
    migratorSchemaUsage: false,
    migratorInventorySucceeded: true,
    inventorySessionUserMigration: true,
    inventoryCurrentUserMigrator: true,
    oidInventoryUsed: true,
    textualRelationResolutionUsed: false,
    relationCount: 2,
    roleResetAfterTransaction: true,
    privilegesUnchanged: true,
    aclUnchanged: true,
    ...overrides
  };
}

function validRlsReproductionResult(overrides = {}) {
  return {
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
  };
}

function validRlsRuntimeAttributesTextResolutionResult(overrides = {}) {
  return {
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
  };
}

function validRlsRoleGateResult(overrides = {}) {
  return {
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
    runtimeMigrationPrivileges: false,
    ...overrides
  };
}

function materializeFixedLegacy2AForTest() {
  const manifest = require("../src/persistence/postgres/legacy-2a-source-manifest.json");
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "social-3a0p-profile-matrix-")
  );
  const legacyRoot = path.join(temporaryRoot, "legacy-2a");
  const dependenciesLink = path.join(legacyRoot, "node_modules");
  fs.mkdirSync(legacyRoot, { mode: 0o700 });
  try {
    for (const relative of Object.keys(manifest.files).sort()) {
      const target = path.join(legacyRoot, ...relative.split("/"));
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.writeFileSync(
        target,
        execFileSync("git", ["show", `${manifest.commit}:${relative}`], {
          cwd: ROOT,
          encoding: "buffer",
          maxBuffer: 8 * 1024 * 1024,
          windowsHide: true
        }),
        { flag: "wx", mode: 0o600 }
      );
    }
    const nodeModules = path.dirname(
      path.dirname(require.resolve("pg/package.json"))
    );
    fs.symlinkSync(
      nodeModules,
      dependenciesLink,
      process.platform === "win32" ? "junction" : "dir"
    );
    const restoreBehavior = require("../src/persistence/postgres/restore-behavior-verifiers");
    const dependencies = restoreBehavior.loadLegacy2ADependencies(legacyRoot);
    const requireLegacy = createRequire(path.join(legacyRoot, "package.json"));
    return Object.freeze({
      cleanup() {
        if (fs.existsSync(dependenciesLink)) fs.unlinkSync(dependenciesLink);
        fs.rmSync(temporaryRoot, { recursive: true, force: false });
      },
      dependencies,
      legacyRoot,
      migrations: requireLegacy("./src/persistence/postgres/migrations.js"),
      runtimeValidation: requireLegacy(
        "./src/persistence/postgres/runtime-validation.js"
      )
    });
  } catch (error) {
    if (fs.existsSync(dependenciesLink)) fs.unlinkSync(dependenciesLink);
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

function profileCredentialCatalogHarness(
  profileId,
  defaultRow,
  options = {}
) {
  if (![PROFILE_0003_ID, PROFILE_0004_ID].includes(profileId)) {
    throw new TypeError("synthetic_profile_invalid");
  }
  const queries = [];
  const client = Object.freeze({
    async query(text, values = []) {
      const sql = String(text);
      queries.push(Object.freeze({ text: sql, values }));
      if (
        sql.includes(
          "INSERT INTO ia4tube_social.social_encrypted_credentials"
        )
      ) {
        return {
          rowCount: 1,
          rows: [Object.freeze({
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
            expires_at: values[11],
            revision: 1
          })]
        };
      }
      if (
        sql.includes(
          "FROM ia4tube_social.social_encrypted_credentials credential"
        )
      ) {
        if (
          profileId === PROFILE_0003_ID &&
          sql.includes("oauth.failed_at")
        ) {
          throw Object.assign(new Error("synthetic_undefined_column"), {
            code: "42703"
          });
        }
        const expired = defaultRow.expires_at !== null &&
          new Date(defaultRow.expires_at).getTime() <= Date.now();
        const visible =
          values[0] === defaultRow.company_id &&
          values[1] === defaultRow.id &&
          options.revoked !== true &&
          !expired;
        return {
          rowCount: visible ? 1 : 0,
          rows: visible ? [defaultRow] : []
        };
      }
      return { rowCount: 0, rows: [] };
    },
    release() {}
  });
  return Object.freeze({
    pool: Object.freeze({
      async connect() {
        return client;
      }
    }),
    queries
  });
}

function profileVaultRegistryHarness(profileId) {
  if (![PROFILE_0003_ID, PROFILE_0004_ID].includes(profileId)) {
    throw new TypeError("synthetic_profile_invalid");
  }
  const queries = [];
  const registered = new Map();
  const client = Object.freeze({
    async query(text, values = []) {
      const sql = String(text);
      queries.push(Object.freeze({ text: sql, values }));
      if (
        profileId === PROFILE_0003_ID &&
        /\b(?:failed_at|failure_code)\b/.test(sql)
      ) {
        throw Object.assign(new Error("synthetic_undefined_column"), {
          code: "42703"
        });
      }
      if (sql.includes("SELECT pg_advisory_unlock")) {
        return { rowCount: 1, rows: [{ unlocked: true }] };
      }
      if (
        sql.includes("SELECT key_version, registered_at") &&
        sql.includes("ia4tube_social_admin.vault_key_versions")
      ) {
        return { rowCount: registered.size, rows: [...registered.values()] };
      }
      if (
        sql.includes(
          "INSERT INTO ia4tube_social_admin.vault_key_versions"
        )
      ) {
        const keyVersion = values[0];
        if (registered.has(keyVersion)) return { rowCount: 0, rows: [] };
        const row = Object.freeze({
          key_version: keyVersion,
          registered_at: new Date(0)
        });
        registered.set(keyVersion, row);
        return { rowCount: 1, rows: [row] };
      }
      return { rowCount: 0, rows: [] };
    },
    release() {}
  });
  return Object.freeze({
    pool: Object.freeze({
      async connect() {
        return client;
      }
    }),
    queries,
    registered
  });
}

function runtimeSchemaContract(runtimeValidation, migrations) {
  return Object.freeze({
    migrations: migrations.readManifest(),
    runtimeValidation,
    tables: runtimeValidation.TENANT_TABLES,
    policies: runtimeValidation.TENANT_POLICIES,
    scopeColumns: runtimeValidation.TENANT_SCOPE_COLUMNS,
    tableGrants: runtimeValidation.RUNTIME_TABLE_GRANTS,
    columnGrants: runtimeValidation.RUNTIME_COLUMN_GRANTS
  });
}

function exactSchemaInventory(contract) {
  return Object.freeze([
    ...contract.tables.map((name) => Object.freeze({
      name,
      kind: "r",
      owner: "ia4tube_social_owner"
    })),
    Object.freeze({
      name: "runtime_schema_contract",
      kind: "v",
      owner: "ia4tube_social_owner"
    })
  ]);
}

function replaceSchemaInventory(inventory, operation) {
  return Object.freeze(operation(inventory.map((entry) => ({ ...entry })))
    .map((entry) => Object.freeze({ ...entry })));
}

function schemaInventoryStatistics(inventory, expectedRelations) {
  const observedByName = new Map(inventory.map((entry) => [entry.name, entry]));
  const expectedByName = new Map(expectedRelations.map((name) => [
    name,
    name === "runtime_schema_contract" ? "v" : "r"
  ]));
  return Object.freeze({
    observedRelationCount: inventory.length,
    expectedRelationCount: expectedRelations.length,
    missingRelations: Object.freeze(expectedRelations.filter(
      (name) => !observedByName.has(name)
    )),
    unexpectedRelations: Object.freeze(inventory
      .filter((entry) => !expectedByName.has(entry.name))
      .map((entry) => entry.name)),
    kindMismatchCount: inventory.filter(
      (entry) => expectedByName.has(entry.name) &&
        expectedByName.get(entry.name) !== entry.kind
    ).length,
    ownerMismatchCount: inventory.filter(
      (entry) => entry.owner !== "ia4tube_social_owner"
    ).length
  });
}

function runtimeTableAclRows(contract) {
  return Object.entries(contract.tableGrants).flatMap(
    ([table_name, privileges]) => privileges.map((privilege_type) => ({
      grantee: "ia4tube_social_runtime",
      table_name,
      privilege_type,
      is_grantable: false,
      grantor_name: "ia4tube_social_owner"
    }))
  );
}

function runtimeColumnAclRows(contract) {
  return Object.entries(contract.columnGrants).flatMap(
    ([table_name, columns]) => Object.entries(columns).flatMap(
      ([column_name, privileges]) => privileges.map((privilege_type) => ({
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

function runtimeSchemaCatalogPool(contract, inventory) {
  const queries = [];
  async function query(text, values) {
    const sql = String(text);
    const normalized = sql.trim();
    queries.push(Object.freeze({ text: sql, values }));
    if (
      normalized === "BEGIN" || normalized === "COMMIT" ||
      normalized === "ROLLBACK" || normalized.startsWith("SET LOCAL ROLE ")
    ) {
      return { rowCount: 0, rows: [] };
    }
    if (normalized.startsWith("WITH expected(relation_name, object_kind) AS")) {
      const expected = values[0];
      const statistics = schemaInventoryStatistics(inventory, expected);
      return {
        rowCount: 1,
        rows: [{
          observed_relation_count: statistics.observedRelationCount,
          expected_relation_count: statistics.expectedRelationCount,
          missing_relation_count: statistics.missingRelations.length,
          unexpected_relation_count: statistics.unexpectedRelations.length,
          kind_mismatch_count: statistics.kindMismatchCount,
          owner_mismatch_count: statistics.ownerMismatchCount
        }]
      };
    }
    if (
      sql.includes("SELECT owner.rolname AS owner_name") &&
      sql.includes("WHERE namespace.nspname = 'ia4tube_social'")
    ) {
      return {
        rowCount: 1,
        rows: [{ owner_name: "ia4tube_social_owner" }]
      };
    }
    if (sql.includes("AS vault_registry_fk_count")) {
      return {
        rowCount: 1,
        rows: [{
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
          runtime_create_absent: true
        }]
      };
    }
    if (sql.includes("relation.relkind AS object_kind")) {
      return {
        rowCount: inventory.length,
        rows: inventory.map((entry) => ({
          relname: entry.name,
          object_kind: entry.kind,
          owner_name: entry.owner
        }))
      };
    }
    if (sql.includes("FROM pg_catalog.pg_proc routine")) {
      return { rowCount: 1, rows: [{ routine_count: 0 }] };
    }
    if (sql.includes("FROM ia4tube_social.runtime_schema_contract")) {
      return {
        rowCount: contract.migrations.length,
        rows: contract.migrations.map((migration) => ({
          version: migration.version,
          checksum_sha256: migration.sha256
        }))
      };
    }
    if (sql.includes("COUNT(policy.policyname)::integer AS policy_count")) {
      return {
        rowCount: contract.tables.length,
        rows: contract.tables.map((relname) => ({
          relname,
          relrowsecurity: true,
          relforcerowsecurity: true,
          policy_count: 1
        }))
      };
    }
    if (sql.includes("FROM pg_catalog.pg_policies")) {
      return {
        rowCount: contract.tables.length,
        rows: contract.tables.map((tablename) => {
          const expression =
            `(${contract.scopeColumns[tablename]} = ` +
            "NULLIF(current_setting('ia4tube.company_id'::text, true), " +
            "''::text)::uuid)";
          return {
            tablename,
            policyname: contract.policies[tablename],
            permissive: "PERMISSIVE",
            roles: ["public"],
            cmd: "ALL",
            qual: expression,
            with_check: expression
          };
        })
      };
    }
    if (sql.includes("namespace.nspacl")) {
      return {
        rowCount: 1,
        rows: [{
          grantee: "ia4tube_social_runtime",
          privilege_type: "USAGE",
          is_grantable: false,
          grantor_name: "ia4tube_social_owner"
        }]
      };
    }
    if (sql.includes("relation.relacl")) {
      const rows = runtimeTableAclRows(contract);
      return { rowCount: rows.length, rows };
    }
    if (sql.includes("attribute.attacl")) {
      const rows = runtimeColumnAclRows(contract);
      return { rowCount: rows.length, rows };
    }
    if (sql.includes("has_table_privilege")) {
      return {
        rowCount: 1,
        rows: [{
          contract_select: true,
          audit_update: false,
          audit_delete: false,
          identity_write: false,
          legacy_access: false
        }]
      };
    }
    throw new Error(`unexpected_runtime_schema_query:${normalized.slice(0, 48)}`);
  }
  const client = Object.freeze({ query, release() {} });
  return Object.freeze({
    queries,
    query,
    async connect() { return client; }
  });
}

function restoreBehaviorFacadeFixture(options = {}) {
  const calls = {
    created: [],
    currentSchema: [],
    legacyRepositoryOptions: [],
    legacySchema: [],
    loadedRoots: []
  };
  const legacyRepository = Object.freeze({
    consumeReauthGrant() {},
    createConnection() {},
    createReauthGrant() {},
    findReauthIdentity() {},
    findConnection() {},
    findEncryptedCredential() {},
    listCredentialKeyVersions() {},
    rotateEncryptedCredential() {},
    storeEncryptedCredential() {}
  });
  const legacy = Object.freeze({
    createCompanyScopedRepository() {},
    createSocialCredentialService() {},
    createSocialRepository(repositoryOptions) {
      calls.legacyRepositoryOptions.push(repositoryOptions);
      return legacyRepository;
    },
    createSocialVault() {},
    verifyRuntimeRole() {},
    async verifyRuntimeSchema(...args) {
      calls.legacySchema.push(args);
      if (options.legacySchemaFailure) throw options.legacySchemaFailure;
      return true;
    }
  });
  const restoreBehavior = {
    loadLegacy2ADependencies(root) {
      calls.loadedRoots.push(root);
      if (options.loaderFailure) throw options.loaderFailure;
      return legacy;
    },
    createRestoreBehaviorVerifiers(configuration) {
      calls.created.push(configuration);
      return Object.freeze({ configuration });
    }
  };
  const runtimeValidation = {
    async verifyRuntimeSchema(...args) {
      calls.currentSchema.push(args);
      if (options.currentSchemaFailure) throw options.currentSchemaFailure;
      return true;
    }
  };
  const legacyRoot = path.join(ROOT, "synthetic-legacy-2a-source");
  const facade = createRestoreBehaviorFacade(legacyRoot, {
    restoreBehavior,
    runtimeValidation
  });
  return Object.freeze({
    calls,
    facade,
    legacy,
    legacyRepository,
    legacyRoot
  });
}

test("evidence provenance matches the authorized workflow branch and parent", () => {
  assert.equal(
    BRANCH,
    "social/checkpoint-3a0p-linux-vault-failure-provenance-20260811"
  );
  assert.equal(
    BASE_COMMIT,
    "6fbcbdb75d3cbc0adea365530fa5c8fed1f01314"
  );
  const workflow = JSON.parse(fs.readFileSync(
    path.join(ROOT, ".github", "workflows", "social-3a0p-linux-physical-gates.yml"),
    "utf8"
  ));
  assert.deepEqual(workflow.on.push.branches, [BRANCH]);
  assert.equal(workflow.env.SOCIAL_3A0P_AUTHORIZED_PARENT, BASE_COMMIT);
});

test("profile-aware restore facade binds both schema slots to legacy for 0003 and current for 0004", async () => {
  const fixture = restoreBehaviorFacadeFixture();
  assert.deepEqual(fixture.calls.loadedRoots, [fixture.legacyRoot]);

  fixture.facade.createRestoreBehaviorVerifiers({
    expectedProfileId: "social-schema-0003",
    dependencies: { PoolClass: class SyntheticPool {} },
    env: { SOCIAL_SCHEMA_PROFILE: "social-schema-0004" }
  });
  const profile0003 = fixture.calls.created[0];
  assert.equal(Object.hasOwn(profile0003, "expectedProfileId"), false);
  assert.equal(profile0003.legacy2ARoot, fixture.legacyRoot);
  assert.equal(
    profile0003.dependencies.verifyRuntimeSchema,
    profile0003.legacyDependencies.verifyRuntimeSchema
  );
  for (const operation of [
    "createCompanyScopedRepository",
    "createSocialCredentialService",
    "createSocialRepository",
    "createSocialVault",
    "verifyRuntimeRole"
  ]) {
    assert.equal(profile0003.legacyDependencies[operation], fixture.legacy[operation]);
  }
  const pool0003 = Object.freeze({ observedProfileId: "social-schema-0004" });
  await profile0003.dependencies.verifyRuntimeSchema(pool0003, "synthetic_runtime");
  await profile0003.legacyDependencies.verifyRuntimeSchema(pool0003, "synthetic_runtime");
  assert.equal(fixture.calls.legacySchema.length, 2);
  assert.equal(fixture.calls.currentSchema.length, 0);

  fixture.facade.createRestoreBehaviorVerifiers({
    expectedProfileId: "social-schema-0004",
    dependencies: { PoolClass: class SyntheticPool {} },
    env: { SOCIAL_SCHEMA_PROFILE: "social-schema-0003" }
  });
  const profile0004 = fixture.calls.created[1];
  assert.equal(
    profile0004.dependencies.verifyRuntimeSchema,
    profile0004.legacyDependencies.verifyRuntimeSchema
  );
  for (const operation of [
    "createCompanyScopedRepository",
    "createSocialCredentialService",
    "createSocialRepository",
    "createSocialVault",
    "verifyRuntimeRole"
  ]) {
    assert.equal(profile0004.legacyDependencies[operation], fixture.legacy[operation]);
  }
  const pool0004 = Object.freeze({ observedProfileId: "social-schema-0003" });
  await profile0004.dependencies.verifyRuntimeSchema(pool0004, "synthetic_runtime");
  await profile0004.legacyDependencies.verifyRuntimeSchema(pool0004, "synthetic_runtime");
  assert.equal(fixture.calls.legacySchema.length, 2);
  assert.equal(fixture.calls.currentSchema.length, 2);
});

test("profile-aware restore facade binds the primary repository before creation without SQL-error fallback", () => {
  const fixture = restoreBehaviorFacadeFixture();
  const repositoryOptions = Object.freeze({
    pool: Object.freeze({ async connect() {} }),
    runtimeRole: "ia4tube_social_runtime",
    identityDerivationVersion: "v1"
  });

  fixture.facade.createRestoreBehaviorVerifiers({
    expectedProfileId: PROFILE_0003_ID,
    dependencies: { PoolClass: class SyntheticPool {} },
    env: { SOCIAL_SCHEMA_PROFILE: PROFILE_0004_ID }
  });
  const profile0003 = fixture.calls.created[0];
  assert.notEqual(
    profile0003.dependencies.createSocialRepository,
    createSocialRepository
  );
  const bridge = profile0003.dependencies.createSocialRepository(
    repositoryOptions
  );
  assert.equal(Object.isFrozen(bridge), true);
  assert.deepEqual(Reflect.ownKeys(bridge), [
    "consumeReauthGrant",
    "createConnection",
    "createReauthGrant",
    "findReauthIdentity",
    "findConnection",
    "findEncryptedCredential",
    "findEncryptedCredentialForKeyRotation",
    "listCredentialKeyVersions",
    "rotateEncryptedCredential",
    "rotateEncryptedCredentialForKeyRotation",
    "storeEncryptedCredential"
  ]);
  assert.equal(
    bridge.findEncryptedCredential,
    fixture.legacyRepository.findEncryptedCredential
  );
  for (const name of [
    "consumeReauthGrant",
    "createConnection",
    "createReauthGrant",
    "findReauthIdentity",
    "findConnection",
    "listCredentialKeyVersions",
    "rotateEncryptedCredential",
    "storeEncryptedCredential"
  ]) {
    assert.notEqual(bridge[name], fixture.legacyRepository[name]);
  }
  assert.deepEqual(fixture.calls.legacyRepositoryOptions, [repositoryOptions]);

  fixture.facade.createRestoreBehaviorVerifiers({
    expectedProfileId: PROFILE_0004_ID,
    dependencies: { PoolClass: class SyntheticPool {} },
    env: { SOCIAL_SCHEMA_PROFILE: PROFILE_0003_ID }
  });
  const profile0004 = fixture.calls.created[1];
  assert.equal(
    profile0004.dependencies.createSocialRepository,
    createSocialRepository
  );
  assert.equal(fixture.calls.legacyRepositoryOptions.length, 1);

  const createdBeforeUnknown = fixture.calls.created.length;
  assert.throws(
    () => fixture.facade.createRestoreBehaviorVerifiers({
      expectedProfileId: "social-schema-unknown",
      dependencies: { PoolClass: class SyntheticPool {} }
    }),
    { code: "linux_gate_schema_profile_invalid" }
  );
  assert.equal(fixture.calls.created.length, createdBeforeUnknown);
  assert.equal(fixture.calls.legacyRepositoryOptions.length, 1);
  assert.throws(
    () => fixture.facade.createRestoreBehaviorVerifiers({
      expectedProfileId: PROFILE_0003_ID,
      dependencies: {
        PoolClass: class SyntheticPool {},
        createSocialRepository() {}
      }
    }),
    { code: "linux_gate_restore_behavior_repository_dependency_invalid" }
  );
});

test("fixed 0003 and current 0004 schema verifiers enforce their exact closed inventories", async (t) => {
  const fixedLegacy = materializeFixedLegacy2AForTest();
  try {
    const currentRuntimeValidation = require(
      "../src/persistence/postgres/runtime-validation"
    );
    const currentMigrations = require(
      "../src/persistence/postgres/migrations"
    );
    const profiles = require(
      "../src/persistence/postgres/backup-restore"
    ).SCHEMA_PROFILES;
    const profile0003 = profiles.find((profile) => profile.id === PROFILE_0003_ID);
    const profile0004 = profiles.find((profile) => profile.id === PROFILE_0004_ID);
    const legacyContract = runtimeSchemaContract(
      fixedLegacy.runtimeValidation,
      fixedLegacy.migrations
    );
    const currentContract = runtimeSchemaContract(
      currentRuntimeValidation,
      currentMigrations
    );
    const inventory0003 = exactSchemaInventory(legacyContract);
    const inventory0004 = exactSchemaInventory(currentContract);
    const facade = createRestoreBehaviorFacade(fixedLegacy.legacyRoot);
    const request = (expectedProfileId, pool) => ({
      expectedProfileId,
      pool,
      role: "ia4tube_social_runtime"
    });
    const rejectsRelationMismatch = (operation) => assert.rejects(
      operation,
      { code: "postgres_relation_owner_mismatch" }
    );

    await t.test("exact 0003 passes the fixed legacy verifier", async () => {
      const result = await facade.verifyRuntimeSchemaForProfile(
        request(
          PROFILE_0003_ID,
          runtimeSchemaCatalogPool(legacyContract, inventory0003)
        )
      );
      assert.deepEqual(result, {
        valid: true,
        migrationCount: 3,
        tenantTableCount: 12
      });
    });

    await t.test("exact 0003 deterministically fails current only for the three 0004 relations", async () => {
      const expectedCurrentRelations = [
        ...profile0004.rlsTables,
        "runtime_schema_contract"
      ];
      const statistics = schemaInventoryStatistics(
        inventory0003,
        expectedCurrentRelations
      );
      assert.deepEqual(statistics.missingRelations, PROFILE_0004_ONLY_RELATIONS);
      assert.deepEqual(statistics.unexpectedRelations, []);
      assert.equal(statistics.kindMismatchCount, 0);
      assert.equal(statistics.ownerMismatchCount, 0);
      assert.equal(statistics.observedRelationCount, 13);
      assert.equal(statistics.expectedRelationCount, 16);

      await rejectsRelationMismatch(
        facade.verifyRuntimeSchemaForProfile(
          request(
            PROFILE_0004_ID,
            runtimeSchemaCatalogPool(legacyContract, inventory0003)
          )
        )
      );
      assert.deepEqual(facade.schemaProfileDiagnostics(), {
        observedRelationCount: 13,
        expectedRelationCount: 16,
        missingRelationCount: 3,
        unexpectedRelationCount: 0,
        kindMismatchCount: 0,
        ownerMismatchCount: 0
      });
    });

    await t.test("adding only the three 0004 relations removes the generic relation failure", async () => {
      const augmented = replaceSchemaInventory(inventory0003, (entries) => {
        entries.push(...PROFILE_0004_ONLY_RELATIONS.map((name) => ({
          name,
          kind: "r",
          owner: "ia4tube_social_owner"
        })));
        return entries;
      });
      const pool = runtimeSchemaCatalogPool(legacyContract, augmented);
      let observed;
      try {
        await currentRuntimeValidation.verifyRuntimeSchema(
          pool,
          "ia4tube_social_runtime"
        );
      } catch (error) {
        observed = error;
      }
      assert.ok(observed);
      assert.notEqual(observed.code, "postgres_relation_owner_mismatch");
      assert.equal(
        pool.queries.some(({ text }) =>
          text.includes("FROM ia4tube_social.runtime_schema_contract")
        ),
        true
      );
    });

    await t.test("exact 0004 passes the complete current verifier", async () => {
      const result = await facade.verifyRuntimeSchemaForProfile(
        request(
          PROFILE_0004_ID,
          runtimeSchemaCatalogPool(currentContract, inventory0004)
        )
      );
      assert.deepEqual(result, {
        valid: true,
        migrationCount: 4,
        tenantTableCount: 15
      });
    });

    await t.test("0003 refuses a missing native relation", async () => {
      const missing = replaceSchemaInventory(
        inventory0003,
        (entries) => entries.filter((entry) => entry.name !== "social_connections")
      );
      await rejectsRelationMismatch(
        fixedLegacy.dependencies.verifyRuntimeSchema(
          runtimeSchemaCatalogPool(legacyContract, missing),
          "ia4tube_social_runtime"
        )
      );
    });

    await t.test("0003 refuses every relation exclusive to 0004", async () => {
      for (const relation of PROFILE_0004_ONLY_RELATIONS) {
        const extra = replaceSchemaInventory(inventory0003, (entries) => {
          entries.push({
            name: relation,
            kind: "r",
            owner: "ia4tube_social_owner"
          });
          return entries;
        });
        await rejectsRelationMismatch(
          fixedLegacy.dependencies.verifyRuntimeSchema(
            runtimeSchemaCatalogPool(legacyContract, extra),
            "ia4tube_social_runtime"
          )
        );
      }
    });

    await t.test("0004 refuses each missing new relation", async () => {
      for (const relation of PROFILE_0004_ONLY_RELATIONS) {
        const missing = replaceSchemaInventory(
          inventory0004,
          (entries) => entries.filter((entry) => entry.name !== relation)
        );
        await rejectsRelationMismatch(
          currentRuntimeValidation.verifyRuntimeSchema(
            runtimeSchemaCatalogPool(currentContract, missing),
            "ia4tube_social_runtime"
          )
        );
      }
    });

    await t.test("both profiles refuse a wrong relation owner", async () => {
      for (const [contract, inventory, verifier] of [
        [legacyContract, inventory0003, fixedLegacy.dependencies.verifyRuntimeSchema],
        [currentContract, inventory0004, currentRuntimeValidation.verifyRuntimeSchema]
      ]) {
        const wrongOwner = replaceSchemaInventory(inventory, (entries) => {
          entries.find((entry) => entry.name === "companies").owner = "unexpected_owner";
          return entries;
        });
        await rejectsRelationMismatch(
          verifier(
            runtimeSchemaCatalogPool(contract, wrongOwner),
            "ia4tube_social_runtime"
          )
        );
      }
    });

    await t.test("both profiles refuse a wrong relkind", async () => {
      for (const [contract, inventory, verifier] of [
        [legacyContract, inventory0003, fixedLegacy.dependencies.verifyRuntimeSchema],
        [currentContract, inventory0004, currentRuntimeValidation.verifyRuntimeSchema]
      ]) {
        const wrongKind = replaceSchemaInventory(inventory, (entries) => {
          entries.find((entry) => entry.name === "companies").kind = "v";
          return entries;
        });
        await rejectsRelationMismatch(
          verifier(
            runtimeSchemaCatalogPool(contract, wrongKind),
            "ia4tube_social_runtime"
          )
        );
      }
    });

    await t.test("both profiles refuse a missing runtime contract view", async () => {
      for (const [contract, inventory, verifier] of [
        [legacyContract, inventory0003, fixedLegacy.dependencies.verifyRuntimeSchema],
        [currentContract, inventory0004, currentRuntimeValidation.verifyRuntimeSchema]
      ]) {
        const missingView = replaceSchemaInventory(
          inventory,
          (entries) => entries.filter(
            (entry) => entry.name !== "runtime_schema_contract"
          )
        );
        await rejectsRelationMismatch(
          verifier(
            runtimeSchemaCatalogPool(contract, missingView),
            "ia4tube_social_runtime"
          )
        );
      }
    });

    assert.deepEqual(profile0003.rlsTables, legacyContract.tables);
    assert.deepEqual(profile0004.rlsTables, currentContract.tables);
  } finally {
    fixedLegacy.cleanup();
  }
});

test("pre-correction profile 0003 vault reproduction proves current-read 42703 before vault lifecycle", async () => {
  const migrationManifest = JSON.parse(fs.readFileSync(
    path.join(ROOT, "db", "migrations", "checksums.json"),
    "utf8"
  ));
  const migrationSql = new Map(migrationManifest.migrations.map((migration) => [
    migration.version,
    fs.readFileSync(
      path.join(ROOT, "db", "migrations", migration.file),
      "utf8"
    )
  ]));
  const profile0003 = SCHEMA_PROFILES.find(
    (profile) => profile.id === PROFILE_0003_ID
  );
  const profile0004 = SCHEMA_PROFILES.find(
    (profile) => profile.id === PROFILE_0004_ID
  );
  assert.deepEqual(
    profile0003.migrationRows.map(({ version }) => version),
    [
      "0001_social_multitenant_foundation",
      "0002_social_connections_and_vault",
      "0003_global_vault_key_registry"
    ]
  );
  assert.deepEqual(
    profile0004.migrationRows.map(({ version }) => version),
    [...profile0003.migrationRows.map(({ version }) => version),
      "0004_social_connector_persistence"]
  );

  const migration0002 = migrationSql.get(
    "0002_social_connections_and_vault"
  );
  const oauthTableStart = migration0002.indexOf(
    "CREATE TABLE ia4tube_social.social_oauth_transactions"
  );
  const oauthTableEnd = migration0002.indexOf(
    "CREATE TABLE ia4tube_social.social_encrypted_credentials",
    oauthTableStart
  );
  assert.ok(oauthTableStart >= 0 && oauthTableEnd > oauthTableStart);
  const oauthTable0003 = migration0002.slice(oauthTableStart, oauthTableEnd);
  for (const column of ["expires_at", "consumed_at", "cancelled_at"]) {
    assert.match(oauthTable0003, new RegExp(`\\b${column}\\b`));
  }
  assert.doesNotMatch(oauthTable0003, /\b(?:failed_at|failure_code)\b/);

  for (const column of ["failed_at", "failure_code"]) {
    const origins = migrationManifest.migrations
      .filter((migration) =>
        new RegExp(`\\b${column}\\b`).test(migrationSql.get(migration.version))
      )
      .map(({ version }) => version);
    assert.deepEqual(origins, ["0004_social_connector_persistence"]);
  }
  const migration0004 = migrationSql.get(
    "0004_social_connector_persistence"
  );
  assert.match(migration0004, /ADD COLUMN failed_at TIMESTAMPTZ/);
  assert.match(migration0004, /ADD COLUMN failure_code TEXT/);

  const registrySource = fs.readFileSync(
    path.join(
      ROOT,
      "src",
      "persistence",
      "postgres",
      "vault-key-registry-admin.js"
    ),
    "utf8"
  );
  const registerStart = registrySource.indexOf("async function register(");
  const registerEnd = registrySource.indexOf(
    "async function withActiveVersion(",
    registerStart
  );
  assert.ok(registerStart >= 0 && registerEnd > registerStart);
  const registerImplementation = registrySource.slice(
    registerStart,
    registerEnd
  );
  assert.doesNotMatch(
    registerImplementation,
    /\b(?:failed_at|failure_code)\b/
  );
  assert.match(
    migrationSql.get("0003_global_vault_key_registry"),
    /CREATE TABLE ia4tube_social_admin\.vault_key_versions/
  );

  const fixedLegacy = materializeFixedLegacy2AForTest();
  try {
    const legacyManifest = require(
      "../src/persistence/postgres/legacy-2a-source-manifest.json"
    );
    assert.equal(
      legacyManifest.commit,
      "9deb1e04249026a7046d44d6cbf4e2da87b9a0a4"
    );

    const companyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const connectionId = "22222222-2222-4222-8222-222222222222";
    const credentialA = "55555555-5555-4555-8555-555555555555";
    const credentialB = "66666666-6666-4666-8666-666666666666";
    const keyMaterialV1 = Buffer.alloc(32, 9);
    const keyMaterialV2 = Buffer.alloc(32, 10);
    const keyVersionV1 = deriveVaultKeyVersion(101, keyMaterialV1);
    const keyVersionV2 = deriveVaultKeyVersion(102, keyMaterialV2);
    keyMaterialV1.fill(0);
    keyMaterialV2.fill(0);
    const defaultRow = Object.freeze({
      company_id: companyId,
      id: credentialA,
      provider: "instagram",
      connection_id: connectionId,
      oauth_transaction_id: null,
      credential_type: "access_token",
      ciphertext: Buffer.from([1]),
      nonce: Buffer.alloc(12, 2),
      auth_tag: Buffer.alloc(16, 3),
      key_version: keyVersionV1,
      aad_version: 1,
      expires_at: null,
      revision: 1
    });
    const input = Object.freeze({ companyId, credentialId: credentialA });

    const legacy0003Catalog = profileCredentialCatalogHarness(
      PROFILE_0003_ID,
      defaultRow
    );
    const legacyRepository = fixedLegacy.dependencies.createSocialRepository({
      pool: legacy0003Catalog.pool,
      runtimeRole: "ia4tube_social_runtime",
      identityDerivationVersion: "identity-v1"
    });
    const legacyResult = await legacyRepository.findEncryptedCredential(input);
    assert.equal(legacyResult.id, credentialA);
    const legacyRead = legacy0003Catalog.queries.find(({ text }) =>
      text.includes(
        "FROM ia4tube_social.social_encrypted_credentials credential"
      )
    );
    assert.ok(legacyRead);
    assert.doesNotMatch(legacyRead.text, /\boauth\.failed_at\b/);

    const current0004Catalog = profileCredentialCatalogHarness(
      PROFILE_0004_ID,
      defaultRow
    );
    const current0004Repository = createSocialRepository({
      pool: current0004Catalog.pool,
      runtimeRole: "ia4tube_social_runtime",
      identityDerivationVersion: "identity-v1"
    });
    const current0004Result = await current0004Repository
      .findEncryptedCredential(input);
    assert.equal(current0004Result.id, credentialA);
    const current0004Read = current0004Catalog.queries.find(({ text }) =>
      text.includes(
        "FROM ia4tube_social.social_encrypted_credentials credential"
      )
    );
    assert.ok(current0004Read);
    assert.match(current0004Read.text, /\boauth\.failed_at\b/);

    const current0003Catalog = profileCredentialCatalogHarness(
      PROFILE_0003_ID,
      defaultRow
    );
    const current0003Repository = createSocialRepository({
      pool: current0003Catalog.pool,
      runtimeRole: "ia4tube_social_runtime",
      identityDerivationVersion: "identity-v1"
    });
    const observed = {
      decrypt: 0,
      encrypt: 0,
      register: 0,
      retire: 0,
      rotate: 0,
      tamper: 0,
      verify2A: 0
    };
    const vault = Object.freeze({
      decrypt() {
        observed.decrypt += 1;
        return Buffer.from("must-not-be-reached");
      },
      encrypt() {
        observed.encrypt += 1;
        return Object.freeze({
          ciphertext: Buffer.from([observed.encrypt]),
          nonce: Buffer.alloc(12, observed.encrypt),
          authTag: Buffer.alloc(16, observed.encrypt + 2),
          keyVersion: keyVersionV1,
          aadVersion: 1
        });
      },
      rotate() {
        observed.rotate += 1;
        return Object.freeze({
          changed: false,
          envelope: Object.freeze({ keyVersion: keyVersionV1 })
        });
      }
    });
    const credentials = createSocialCredentialService({
      repository: current0003Repository,
      vault
    });
    const registryCatalog = profileVaultRegistryHarness(PROFILE_0003_ID);
    const registry = createVaultKeyRegistryAdmin({
      pool: registryCatalog.pool,
      ownerRole: "ia4tube_social_owner"
    });
    let undefinedColumn;
    try {
      await registry.register({ keyVersion: keyVersionV1 });
      observed.register += 1;
      await registry.register({ keyVersion: keyVersionV2 });
      observed.register += 1;
      await credentials.store({
        companyId,
        provider: "instagram",
        credentialId: credentialA,
        credentialType: "access_token",
        connectionId,
        plaintext: Buffer.from("synthetic-a")
      });
      await credentials.store({
        companyId,
        provider: "instagram",
        credentialId: credentialB,
        credentialType: "refresh_token",
        connectionId,
        plaintext: Buffer.from("synthetic-b")
      });
      await credentials.withDecryptedCredential(input, () => true);
      observed.tamper += 1;
      observed.rotate += 1;
      observed.retire += 1;
      observed.verify2A += 1;
    } catch (error) {
      undefinedColumn = error;
    }
    assert.equal(undefinedColumn?.code, "42703");
    const sanitizedInternalCode = undefinedColumn?.code === "42703"
      ? "postgres_undefined_column"
      : "postgres_failure";
    assert.equal(sanitizedInternalCode, "postgres_undefined_column");
    const internalReproductionEvidence = Object.freeze({
      profileRepositoryMode: "legacy_read_current_lifecycle",
      profile0003CurrentReadRefused: true,
      sanitizedSqlStateClass: "undefined_column",
      externalProcessStarted: false
    });
    assert.deepEqual(internalReproductionEvidence, {
      profileRepositoryMode: "legacy_read_current_lifecycle",
      profile0003CurrentReadRefused: true,
      sanitizedSqlStateClass: "undefined_column",
      externalProcessStarted: false
    });
    assert.equal(
      JSON.stringify(internalReproductionEvidence).includes("42703"),
      false
    );
    assert.deepEqual(observed, {
      decrypt: 0,
      encrypt: 2,
      register: 2,
      retire: 0,
      rotate: 0,
      tamper: 0,
      verify2A: 0
    });
    const storeQueries = current0003Catalog.queries.filter(({ text }) =>
      text.includes(
        "INSERT INTO ia4tube_social.social_encrypted_credentials"
      )
    );
    assert.equal(storeQueries.length, 2);
    for (const { text } of storeQueries) {
      assert.doesNotMatch(text, /\b(?:failed_at|failure_code)\b/);
    }
    assert.equal(registryCatalog.registered.size, 2);
    const registryInsertQueries = registryCatalog.queries.filter(({ text }) =>
      text.includes(
        "INSERT INTO ia4tube_social_admin.vault_key_versions"
      )
    );
    assert.equal(registryInsertQueries.length, 2);
    for (const { text } of registryCatalog.queries) {
      assert.doesNotMatch(text, /\b(?:failed_at|failure_code)\b/);
    }
    const current0003Read = current0003Catalog.queries.find(({ text }) =>
      text.includes(
        "FROM ia4tube_social.social_encrypted_credentials credential"
      )
    );
    assert.ok(current0003Read);
    assert.match(current0003Read.text, /\boauth\.failed_at\b/);
    assert.equal(
      current0003Catalog.queries.some(({ text }) => text === "ROLLBACK"),
      true
    );

    const verifierSource = fs.readFileSync(
      path.join(
        ROOT,
        "src",
        "persistence",
        "postgres",
        "restore-behavior-verifiers.js"
      ),
      "utf8"
    );
    const registerV1 = verifierSource.indexOf(
      "await registry.register({ keyVersion: versionV1 })"
    );
    const registerV2 = verifierSource.indexOf(
      "await registry.register({ keyVersion: versionV2 })",
      registerV1
    );
    const storeA = verifierSource.indexOf(
      "await credentialsV1.store({",
      registerV2
    );
    const storeB = verifierSource.indexOf(
      "await credentialsV1.store({",
      storeA + 1
    );
    const firstRead = verifierSource.indexOf(
      "await credentialsV1.withDecryptedCredential(",
      storeB
    );
    const tamper = verifierSource.indexOf(
      "for (const field of [\"ciphertext\", \"nonce\", \"authTag\"])",
      firstRead
    );
    const rotate = verifierSource.indexOf(
      "const first = await rotation.rotateTenant({",
      tamper
    );
    const retire = verifierSource.indexOf(
      "() => rotation.retire({ keyVersion: versionV2 })",
      rotate
    );
    const verify2A = verifierSource.indexOf(
      "async function verify2ACompatibility()",
      retire
    );
    const exactOrder = [
      registerV1,
      registerV2,
      storeA,
      storeB,
      firstRead,
      tamper,
      rotate,
      retire,
      verify2A
    ];
    assert.ok(exactOrder.every((index) => index >= 0));
    assert.deepEqual(
      [...exactOrder].sort((left, right) => left - right),
      exactOrder
    );
    const backupRestoreSource = fs.readFileSync(
      path.join(
        ROOT,
        "src",
        "persistence",
        "postgres",
        "backup-restore.js"
      ),
      "utf8"
    );
    const logicalRestore = backupRestoreSource.slice(
      backupRestoreSource.indexOf("async function runLogicalRestore("),
      backupRestoreSource.indexOf("module.exports = {")
    );
    const runtimeIsolationCall = logicalRestore.indexOf(
      "(await verifyRuntimeIsolation())"
    );
    const vaultCall = logicalRestore.indexOf(
      "(await verifyVault())",
      runtimeIsolationCall
    );
    const compatibilityCall = logicalRestore.indexOf(
      "(await verify2ACompatibility())",
      vaultCall
    );
    assert.ok(
      runtimeIsolationCall >= 0 &&
      runtimeIsolationCall < vaultCall &&
      vaultCall < compatibilityCall
    );

    const tracker = createBackupRestoreProvenanceTracker();
    const request = {
      runTool: spawnedToolRunner(tracker, [0, 0, 0, 0]),
      async verifyVault() {
        throw undefinedColumn;
      }
    };
    await assert.rejects(
      () => bindAndRunProvenance(
        tracker,
        "restore",
        "rollback_restore_0003",
        async (tracked) => {
          for (let index = 0; index < 4; index += 1) {
            await tracked.runTool();
          }
          await tracked.verifyVault();
        },
        request
      ),
      (error) => error === undefinedColumn
    );
    assert.deepEqual(tracker.failure(), {
      operation: "rollback_restore_0003",
      substep: "restore_vault",
      boundary: "internal_callback",
      causalCode: "backup_restore_internal_callback_failed",
      externalTransportProcessStarted: false,
      substepExact: true
    });
  } finally {
    fixedLegacy.cleanup();
  }
});

test("profile 0003 bridge uses the validated legacy read and current lifecycle while 0004 keeps the current factory", async () => {
  const fixedLegacy = materializeFixedLegacy2AForTest();
  try {
    const profile0003 = SCHEMA_PROFILES.find(
      (profile) => profile.id === PROFILE_0003_ID
    );
    const profile0004 = SCHEMA_PROFILES.find(
      (profile) => profile.id === PROFILE_0004_ID
    );
    const companyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const otherCompanyId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const credentialId = "55555555-5555-4555-8555-555555555555";
    const connectionId = "22222222-2222-4222-8222-222222222222";
    const keyMaterial = Buffer.alloc(32, 11);
    const keyVersion = deriveVaultKeyVersion(103, keyMaterial);
    keyMaterial.fill(0);
    const row = Object.freeze({
      company_id: companyId,
      id: credentialId,
      provider: "instagram",
      connection_id: connectionId,
      oauth_transaction_id: null,
      credential_type: "access_token",
      ciphertext: Buffer.from([7, 8, 9]),
      nonce: Buffer.alloc(12, 4),
      auth_tag: Buffer.alloc(16, 5),
      key_version: keyVersion,
      aad_version: 1,
      expires_at: null,
      revision: 1
    });
    const catalog = profileCredentialCatalogHarness(
      PROFILE_0003_ID,
      row
    );
    const repositoryOptions = Object.freeze({
      pool: catalog.pool,
      runtimeRole: "ia4tube_social_runtime",
      identityDerivationVersion: "v1"
    });
    const currentRepository = createSocialRepository(repositoryOptions);
    const legacyRepository =
      fixedLegacy.dependencies.createSocialRepository(repositoryOptions);
    const bridge = createProfile0003SocialRepositoryBridge(
      currentRepository,
      legacyRepository
    );
    assert.equal(Object.isFrozen(bridge), true);
    assert.deepEqual(Reflect.ownKeys(bridge), Reflect.ownKeys(currentRepository));
    for (const name of Reflect.ownKeys(currentRepository)) {
      assert.equal(
        bridge[name],
        name === "findEncryptedCredential"
          ? legacyRepository[name]
          : currentRepository[name]
      );
    }
    assert.equal(
      Object.values(bridge).every((operation) => typeof operation === "function"),
      true
    );

    const own = await bridge.findEncryptedCredential({
      companyId,
      credentialId
    });
    assert.equal(own.id, credentialId);
    assert.equal(
      await bridge.findEncryptedCredential({
        companyId: otherCompanyId,
        credentialId
      }),
      null
    );
    const read = catalog.queries.find(({ text }) =>
      text.includes(
        "FROM ia4tube_social.social_encrypted_credentials credential"
      )
    );
    assert.ok(read);
    assert.doesNotMatch(read.text, /\boauth\.failed_at\b/);
    assert.match(read.text, /credential\.revoked_at IS NULL/);
    assert.match(read.text, /credential\.expires_at > CURRENT_TIMESTAMP/);
    assert.match(read.text, /connection\.status = 'active'/);
    assert.match(read.text, /oauth\.cancelled_at IS NULL/);

    const credentials = createSocialCredentialService({
      repository: bridge,
      vault: Object.freeze({
        decrypt() { return Buffer.from("bridge-roundtrip", "utf8"); },
        encrypt() { throw new Error("not_used"); },
        rotate() { throw new Error("not_used"); }
      })
    });
    assert.equal(typeof credentials.rotateForKeyLifecycle, "function");
    const roundtrip = await credentials.withDecryptedCredential(
      { companyId, credentialId },
      (plaintext) => plaintext.toString("utf8")
    );
    assert.equal(roundtrip, "bridge-roundtrip");

    for (const [label, candidateRow, catalogOptions] of [
      [
        "expired",
        Object.freeze({ ...row, expires_at: new Date(0) }),
        Object.freeze({})
      ],
      ["revoked", row, Object.freeze({ revoked: true })]
    ]) {
      const unavailableCatalog = profileCredentialCatalogHarness(
        PROFILE_0003_ID,
        candidateRow,
        catalogOptions
      );
      const unavailableOptions = Object.freeze({
        ...repositoryOptions,
        pool: unavailableCatalog.pool
      });
      const unavailableBridge = createProfile0003SocialRepositoryBridge(
        createSocialRepository(unavailableOptions),
        fixedLegacy.dependencies.createSocialRepository(unavailableOptions)
      );
      assert.equal(
        await unavailableBridge.findEncryptedCredential({
          companyId,
          credentialId
        }),
        null,
        label
      );
    }

    const profile0003Factory = createProfileAwareSocialRepositoryFactory({
      currentCreateSocialRepository: createSocialRepository,
      expectedProfile: profile0003,
      legacyCreateSocialRepository:
        fixedLegacy.dependencies.createSocialRepository
    });
    assert.notEqual(profile0003Factory, createSocialRepository);
    assert.equal(Object.isFrozen(profile0003Factory), true);
    const profile0004Factory = createProfileAwareSocialRepositoryFactory({
      currentCreateSocialRepository: createSocialRepository,
      expectedProfile: profile0004,
      legacyCreateSocialRepository:
        fixedLegacy.dependencies.createSocialRepository
    });
    assert.equal(profile0004Factory, createSocialRepository);
  } finally {
    fixedLegacy.cleanup();
  }
});

test("profile selection is closed, ignores environment and observed database state, and has no fallback", async () => {
  const legacyRelationFailure = Object.assign(
    new Error("postgres_relation_owner_mismatch"),
    { code: "postgres_relation_owner_mismatch" }
  );
  const fixture = restoreBehaviorFacadeFixture({
    legacySchemaFailure: legacyRelationFailure
  });
  assert.throws(
    () => fixture.facade.createRestoreBehaviorVerifiers({
      expectedProfileId: "social-schema-unknown",
      env: { SOCIAL_SCHEMA_PROFILE: "social-schema-0003" }
    }),
    { code: "linux_gate_schema_profile_invalid" }
  );
  assert.equal(fixture.calls.created.length, 0);

  const pool = Object.freeze({
    observedProfileId: "social-schema-0004",
    query: async () => { throw new Error("diagnostic_unavailable"); }
  });
  await assert.rejects(
    fixture.facade.verifyRuntimeSchemaForProfile({
      expectedProfileId: "social-schema-0003",
      pool,
      role: "synthetic_runtime"
    }),
    (error) => error === legacyRelationFailure
  );
  assert.equal(fixture.calls.legacySchema.length, 1);
  assert.equal(fixture.calls.currentSchema.length, 0);
  assert.equal(fixture.facade.schemaProfileDiagnostics(), null);

  const currentRelationFailure = Object.assign(
    new Error("postgres_relation_owner_mismatch"),
    { code: "postgres_relation_owner_mismatch" }
  );
  const noCurrentToLegacyFallback = restoreBehaviorFacadeFixture({
    currentSchemaFailure: currentRelationFailure
  });
  await assert.rejects(
    noCurrentToLegacyFallback.facade.verifyRuntimeSchemaForProfile({
      expectedProfileId: "social-schema-0004",
      pool: Object.freeze({
        observedProfileId: "social-schema-0003",
        query: async () => { throw new Error("diagnostic_unavailable"); }
      }),
      role: "synthetic_runtime"
    }),
    (error) => error === currentRelationFailure
  );
  assert.equal(noCurrentToLegacyFallback.calls.currentSchema.length, 1);
  assert.equal(noCurrentToLegacyFallback.calls.legacySchema.length, 0);
});

test("legacy loader failure is terminal and never substitutes the current verifier", () => {
  const loaderFailure = Object.assign(new Error("legacy_source_hash_mismatch"), {
    code: "restore_behavior_2a_source_hash_mismatch"
  });
  const currentCalls = [];
  assert.throws(
    () => createRestoreBehaviorFacade("synthetic-legacy-root", {
      restoreBehavior: {
        loadLegacy2ADependencies() { throw loaderFailure; },
        createRestoreBehaviorVerifiers() { throw new Error("must_not_create"); }
      },
      runtimeValidation: {
        verifyRuntimeSchema(...args) {
          currentCalls.push(args);
          return true;
        }
      }
    }),
    (error) => error === loaderFailure
  );
  assert.deepEqual(currentCalls, []);
});

test("relation mismatch diagnostics retain only six closed integer counters and survive evidence sanitization", async () => {
  const relationFailure = Object.assign(
    new Error("postgres_relation_owner_mismatch"),
    { code: "postgres_relation_owner_mismatch" }
  );
  const fixture = restoreBehaviorFacadeFixture({
    currentSchemaFailure: relationFailure
  });
  const queryCalls = [];
  const pool = {
    observedProfileId: "social-schema-0003",
    async query(sql, values) {
      queryCalls.push({ sql, values });
      return {
        rowCount: 1,
        rows: [{
          observed_relation_count: "13",
          expected_relation_count: "16",
          missing_relation_count: "3",
          unexpected_relation_count: "0",
          kind_mismatch_count: "0",
          owner_mismatch_count: "0",
          observed_relation_names: ["forbidden_name"]
        }]
      };
    }
  };
  await assert.rejects(
    fixture.facade.verifyRuntimeSchemaForProfile({
      expectedProfileId: "social-schema-0004",
      pool,
      role: "synthetic_runtime"
    }),
    (error) => error === relationFailure
  );
  assert.equal(queryCalls.length, 1);
  assert.equal(queryCalls[0].values[0].length, 16);
  assert.equal(queryCalls[0].values[1], "ia4tube_social_owner");
  const diagnostics = fixture.facade.schemaProfileDiagnostics();
  assert.deepEqual(diagnostics, {
    observedRelationCount: 13,
    expectedRelationCount: 16,
    missingRelationCount: 3,
    unexpectedRelationCount: 0,
    kindMismatchCount: 0,
    ownerMismatchCount: 0
  });
  assert.equal(Object.isFrozen(diagnostics), true);
  assert.deepEqual(Object.keys(diagnostics).sort(), [
    "expectedRelationCount",
    "kindMismatchCount",
    "missingRelationCount",
    "observedRelationCount",
    "ownerMismatchCount",
    "unexpectedRelationCount"
  ]);
  assert.equal(JSON.stringify(diagnostics).includes("forbidden_name"), false);
  assert.equal(evidenceSafe({ schemaProfileDiagnostics: diagnostics }), true);

  const sanitized = sanitizedFailureEvidence({
    firstFailure: {
      phase: "migrations",
      code: "postgres_relation_owner_mismatch"
    },
    schemaProfileDiagnostics: diagnostics,
    cleanup: {
      cleanupCompleted: true,
      containerResiduals: 0,
      volumeResiduals: 0,
      networkResiduals: 0,
      listenerResiduals: 0,
      temporaryRootResiduals: 0
    }
  });
  assert.deepEqual(sanitized.schemaProfileDiagnostics, diagnostics);
  assert.equal(evidenceSafe(sanitized), true);
  const source = fs.readFileSync(
    path.join(ROOT, "scripts", "social-3a0p-linux-gate.js"),
    "utf8"
  );
  assert.match(
    source,
    /finally\s*\{[\s\S]*evidence\.schemaProfileDiagnostics\s*=/
  );
});

test("canonical evidence JSON is stable and key ordered", () => {
  assert.equal(canonicalJson({ z: 1, a: { y: true, b: false } }), '{"a":{"b":false,"y":true},"z":1}');
});

test("backup transport bridge preserves the issued binding across the drain-aware runner", async () => {
  const contract = Object.freeze({
    database: "ia4tube_social_local",
    login: "ia4tube_social_local_migration",
    runMarker: "ia4tube-social-3a0p-linux-0123456789abcdef",
    targetFingerprint: "a".repeat(64)
  });
  const localBinding = Object.freeze({
    connectivityMode: "logical_dns_to_internal_container_v1",
    logicalHost: "backup.local.ia4tube.invalid",
    logicalPort: 5432,
    physicalMode: "internal_container_loopback",
    physicalHost: "127.0.0.1",
    physicalPort: 5432,
    database: contract.database,
    login: contract.login,
    runMarker: contract.runMarker,
    targetFingerprint: contract.targetFingerprint,
    containerIdentityDigest: "b".repeat(64)
  });
  const observed = [];
  const postgres = {
    createBackupTransportBinding(candidate) {
      assert.equal(candidate, contract);
      return localBinding;
    }
  };
  const bridge = createBackupTransportBridge(
    postgres,
    async (...args) => {
      observed.push(args);
      return Object.freeze({ code: 0, stdout: "", stderr: "" });
    },
    contract
  );
  assert.equal(bridge.localBinding, localBinding);
  assert.equal(Object.isFrozen(bridge), true);
  const plan = Object.freeze({ executable: "/usr/bin/psql" });
  await bridge.runTool(plan, localBinding);
  assert.deepEqual(observed, [[plan, localBinding]]);
  await assert.rejects(
    bridge.runTool(plan, Object.freeze({ ...localBinding })),
    { code: "linux_gate_backup_transport_binding_invalid" }
  );
  assert.equal(observed.length, 1);
});

test("failed-run evidence preserves whether pg_dump or pg_restore actually started", () => {
  const snapshot = Object.freeze({
    logicalIdentityTlsContractValidated: true,
    physicalDisposableTransportValidated: false,
    productionTlsPhysicallyTestedInThisGate: false,
    productionTlsPreviouslyProvedBySocial2B: true,
    localTlsDisabledOnlyInsideOwnedContainer: true,
    pgDumpStarted: true,
    pgDumpSucceeded: false,
    pgRestoreStarted: false,
    pgRestoreSucceeded: false
  });
  const evidence = {
    backupTransport: publicBackupTransportEvidence({
      backupTransportEvidence() { return snapshot; }
    })
  };
  assert.deepEqual(evidence.backupTransport, snapshot);
  assert.equal(evidenceSafe(evidence), true);
  const source = fs.readFileSync(
    path.join(ROOT, "scripts", "social-3a0p-linux-gate.js"),
    "utf8"
  );
  assert.match(
    source,
    /finally\s*\{[\s\S]*evidence\.backupTransport\s*=\s*publicBackupTransportEvidence\(postgres\)/
  );
});

test("evidence contract refuses secrets, URLs and sensitive key names", () => {
  assert.equal(evidenceSafe({ ok: true, sha256: "a".repeat(64) }), true);
  assert.equal(evidenceSafe({ databaseUrl: "redacted" }), false);
  assert.equal(evidenceSafe({ databaseHost: "redacted" }), false);
  assert.equal(evidenceSafe({ containerId: "a".repeat(64) }), false);
  assert.equal(evidenceSafe({ networkId: "b".repeat(64) }), false);
  assert.equal(evidenceSafe({ value: "172.30.0.2" }), false);
  assert.equal(evidenceSafe({ value: "172.30.0.0/16" }), false);
  assert.equal(evidenceSafe({ value: "postgresql://user:pass@host/db" }), false);
  assert.equal(evidenceSafe({ value: "-----BEGIN PRIVATE KEY-----" }), false);
  assert.equal(evidenceSafe({ value: "eyJabcdefghijk.abcdefghijk.abcdefghijk" }), false);
});

test("unsafe evidence is replaced by a minimal sanitized failure", () => {
  const fallback = sanitizedFailureEvidence({
    firstFailure: { phase: "vault", code: "linux_gate_vault_failed" },
    cleanupFailure: null,
    cleanup: {
      cleanupCompleted: true,
      containerResiduals: 0,
      volumeResiduals: 0,
      networkResiduals: 0,
      listenerResiduals: 0,
      temporaryRootResiduals: 0
    },
    databaseUrl: "postgresql://synthetic:unsafe@invalid/db"
  });
  assert.equal(fallback.status, "failed");
  assert.deepEqual(fallback.firstFailure, {
    phase: "vault",
    code: "gate4_failure_provenance_unobserved"
  });
  assert.equal(fallback.gate4FailureProvenance, null);
  assert.equal(fallback.sanitizationFailure, true);
  assert.equal(Object.hasOwn(fallback, "databaseUrl"), false);
  assert.equal(evidenceSafe(fallback), true);
});

test("first failed phase prevents every later gate", async () => {
  const evidence = { phases: [], firstFailure: null };
  const phase = createPhaseRunner(evidence);
  const calls = [];
  await phase("durability", async () => { calls.push("durability"); return { ok: true }; });
  await assert.rejects(
    phase("postgres", async () => { calls.push("postgres"); const error = new Error("failed"); error.code = "synthetic_first_failure"; throw error; })
  );
  await assert.rejects(phase("bootstrap", async () => { calls.push("forbidden"); }));
  assert.deepEqual(calls, ["durability", "postgres"]);
  assert.deepEqual(evidence.firstFailure, { phase: "postgres", code: "synthetic_first_failure" });
});

test("RLS SQLSTATE classification is closed without broadening the legacy sanitizer", () => {
  assert.equal(failureCode({ code: "42501" }), "linux_gate_unclassified_failure");
  assert.equal(failureCode({ code: "22P02" }), "linux_gate_unclassified_failure");
  assert.equal(rlsFailureCode({ code: "42501" }), "postgres_insufficient_privilege");
  assert.equal(rlsFailureCode({ code: "22P02" }), "postgres_invalid_text_representation");
  assert.equal(rlsFailureCode({ code: "linux_gate_rls_failed" }), "linux_gate_rls_failed");
});

test("RLS rollback wrapper preserves the primary SQLSTATE without publishing messages", async () => {
  const primary = Object.assign(new Error("password=primary-must-not-appear"), {
    code: "42501"
  });
  const rollback = Object.assign(new Error("password=rollback-must-not-appear"), {
    code: "postgres_rollback_failed",
    cause: primary
  });
  assert.equal(rlsFailureCode(rollback), "postgres_insufficient_privilege");
  assert.equal(
    rlsFailureCode({
      code: "postgres_rollback_failed",
      cause: { code: "postgres_rollback_failed", cause: { code: "22P02" } }
    }),
    "postgres_invalid_text_representation"
  );
  assert.equal(
    rlsFailureCode({
      code: "postgres_rollback_failed",
      cause: { code: "42501 unsafe", message: "password=must-not-appear" }
    }),
    "postgres_rollback_failed"
  );
  assert.equal(
    rlsFailureCode({
      code: "postgres_rollback_failed",
      message: "password=must-not-appear"
    }),
    "postgres_rollback_failed"
  );

  const tracker = createRlsFailureProvenanceTracker();
  await assert.rejects(
    tracker.runSubstep("rls_cross_tenant_write", async () => { throw rollback; }),
    { code: "postgres_insufficient_privilege", name: "LinuxGateFailure" }
  );
  const serialized = canonicalJson(tracker.failure());
  assert.equal(serialized.includes("primary-must-not-appear"), false);
  assert.equal(serialized.includes("rollback-must-not-appear"), false);
  assert.deepEqual(tracker.failure(), {
    substep: "rls_cross_tenant_write",
    causalCode: "postgres_insufficient_privilege"
  });
});

const GATE3_BOUNDARIES = Object.freeze([
  ["base", "B1", "internal_setup"],
  ["base", "B2", "postgres_transaction"],
  ["base", "B3", "internal_setup"],
  ["base", "B4", "postgres_transaction"],
  ["base", "B5", "postgres_transaction"],
  ["base", "B6", "postgres_concurrent_transactions"],
  ["base", "B7", "internal_validation"],
  ["base", "B8", "postgres_transaction"],
  ["base", "B9", "postgres_transaction"],
  ["base", "B10", "internal_validation"],
  ["supplemental", "S1", "internal_setup"],
  ["supplemental", "S2", "postgres_transaction"],
  ["supplemental", "S3", "postgres_transaction"],
  ["supplemental", "S4", "internal_setup"],
  ["supplemental", "S5", "postgres_concurrent_transactions"],
  ["supplemental", "S6", "internal_validation"],
  ["supplemental", "S7", "postgres_inventory"],
  ["supplemental", "S8", "internal_setup"],
  ["supplemental", "S9", "postgres_transaction"],
  ["supplemental", "S10", "postgres_concurrent_transactions"],
  ["supplemental", "S11", "internal_validation"],
  ["supplemental", "S12", "postgres_concurrent_transactions"],
  ["supplemental", "S13", "internal_setup"],
  ["supplemental", "S14", "postgres_transaction"],
  ["supplemental", "S15", "postgres_transaction"],
  ["supplemental", "S16", "postgres_transaction"],
  ["supplemental", "S17", "postgres_inventory"],
  ["supplemental", "S18", "postgres_transaction"],
  ["supplemental", "S19", "postgres_transaction"],
  ["supplemental", "S20", "postgres_transaction"],
  ["supplemental", "S21", "internal_setup"],
  ["supplemental", "S22", "postgres_concurrent_transactions"],
  ["supplemental", "S23", "internal_validation"],
  ["supplemental", "S24", "postgres_transaction"],
  ["supplemental", "S25", "postgres_transaction"],
  ["supplemental", "S26", "postgres_transaction"],
  ["supplemental", "S27", "postgres_transaction"],
  ["supplemental", "S28", "postgres_inventory"],
  ["supplemental", "S29", "internal_validation"],
  ["supplemental", "S30", "memory_cleanup"]
]);

const GATE4_BOUNDARIES = Object.freeze([
  ["base", "V01", "memory_setup"],
  ["base", "V02", "memory_crypto"],
  ["base", "V03", "memory_crypto"],
  ["base", "V04", "memory_validation"],
  ["base", "V05", "memory_validation"],
  ["base", "V06", "memory_crypto"],
  ["base", "V07", "memory_crypto"],
  ["base", "V08", "memory_validation"],
  ["base", "V09", "memory_cleanup"],
  ["supplemental", "V10", "memory_setup"],
  ["supplemental", "V11", "memory_crypto"],
  ["supplemental", "V12", "memory_crypto"],
  ["supplemental", "V13", "memory_validation"],
  ["supplemental", "V14", "memory_validation"],
  ["supplemental", "V15", "memory_validation"],
  ["supplemental", "V16", "memory_validation"],
  ["supplemental", "V17", "memory_validation"],
  ["supplemental", "V18", "memory_validation"],
  ["supplemental", "V19", "memory_cleanup"],
  ["persisted", "V20", "memory_setup"],
  ["persisted", "V21", "postgres_verifier_setup"],
  ["persisted", "V22", "postgres_runtime_isolation"],
  ["persisted", "V23", "postgres_vault_verification"],
  ["persisted", "V24", "postgres_verifier_cleanup"],
  ["persisted", "V25", "memory_cleanup"]
]);

test("Gate 3 causal classification is closed and never serializes raw error context", () => {
  assert.equal(gate3FailureCode({ code: "linux_safe_failure" }), "linux_safe_failure");
  assert.equal(gate3FailureCode({ code: "23505" }), "gate3_error_code_23505");
  assert.equal(gate3FailureCode({ code: "57014" }), "gate3_error_code_57014");
  assert.equal(gate3FailureCode({ code: "ECONNRESET" }), "gate3_error_code_econnreset");
  assert.equal(gate3FailureCode({ code: "ETIMEDOUT" }), "gate3_error_code_etimedout");
  assert.equal(gate3FailureCode({ code: "EPIPE" }), "gate3_error_code_epipe");
  assert.equal(gate3FailureCode(new TypeError("postgresql://user:secret@host/db SELECT forbidden")), "gate3_type_error");
  assert.equal(gate3FailureCode(new Error("password=secret stdout=forbidden stderr=forbidden")), "gate3_error_code_unavailable");
  assert.equal(gate3FailureCode({ code: "UNSUPPORTED SECRET", message: "SELECT forbidden" }), "gate3_error_code_unsupported");
  assert.equal(gate3FailureCode({
    code: "postgres_rollback_failed",
    message: "password=rollback-secret",
    cause: { code: "23505", message: "SELECT secret" }
  }), "gate3_error_code_23505");
  assert.equal(gate3FailureCode({
    code: "postgres_rollback_failed",
    cause: { code: "UNSUPPORTED SECRET", message: "stderr secret" }
  }), "gate3_error_code_unsupported");
  assert.equal(gate3FailureCode({ code: "postgres_rollback_failed" }), "postgres_rollback_failed");
});

test("Gate 3 tracker accepts exactly B1-B10 and S1-S30 with their operation classes", async () => {
  for (const [operation, substep, operationClass] of GATE3_BOUNDARIES) {
    const tracker = createGate3FailureProvenanceTracker();
    const marker = Object.freeze({ operation, substep });
    assert.equal(
      await tracker.forOperation(operation)(substep, operationClass, async () => marker),
      marker
    );
    assert.equal(tracker.failure(), null);
  }
  const tracker = createGate3FailureProvenanceTracker();
  await assert.rejects(
    tracker.runSubstep("base", "S1", "internal_setup", async () => true),
    { code: "gate3_failure_provenance_substep_invalid" }
  );
  await assert.rejects(
    tracker.runSubstep("base", "B1", "postgres_transaction", async () => true),
    { code: "gate3_failure_provenance_substep_invalid" }
  );
});

test("Gate 3 tracker rethrows the same error and freezes first failure before later cleanup", async () => {
  const tracker = createGate3FailureProvenanceTracker();
  const runBase = tracker.forOperation("base");
  const runSupplemental = tracker.forOperation("supplemental");
  const marker = Object.freeze({ passed: true });
  assert.equal(await runBase("B1", "internal_setup", async () => marker), marker);

  const primary = Object.assign(
    new Error("postgresql://user:password@host/db SELECT secret stdout secret stderr secret"),
    { code: "23505", constraint: "forbidden_constraint" }
  );
  await assert.rejects(
    runBase("B2", "postgres_transaction", async () => { throw primary; }),
    (error) => error === primary
  );
  const first = tracker.failure();
  assert.equal(Object.isFrozen(first), true);
  assert.deepEqual(first, {
    operation: "base",
    substep: "B2",
    operationClass: "postgres_transaction",
    causalCode: "gate3_error_code_23505",
    lastCompletedSubstep: "B1",
    externalProcessStarted: false,
    exitCode: null,
    signal: null
  });

  const secondary = Object.assign(new Error("cleanup secret"), { code: "ETIMEDOUT" });
  await assert.rejects(
    runSupplemental("S30", "memory_cleanup", async () => { throw secondary; }),
    (error) => error === secondary
  );
  assert.equal(tracker.failure(), first);
  const serialized = canonicalJson(first);
  for (const forbidden of [
    "password", "SELECT", "stdout", "stderr", "constraint", "forbidden", "cleanup secret"
  ]) assert.equal(serialized.includes(forbidden), false, forbidden);
});

test("Gate 3 provenance sanitizer rejects impossible shapes and survives fallback", () => {
  const provenance = Object.freeze({
    operation: "supplemental",
    substep: "S17",
    operationClass: "postgres_inventory",
    causalCode: "gate3_error_code_econnreset",
    lastCompletedSubstep: "S16",
    externalProcessStarted: false,
    exitCode: null,
    signal: null
  });
  assert.deepEqual(sanitizedGate3FailureProvenance(provenance), provenance);
  assert.equal(Object.isFrozen(sanitizedGate3FailureProvenance(provenance)), true);
  for (const invalid of [
    { ...provenance, operation: "base" },
    { ...provenance, operationClass: "postgres_transaction" },
    { ...provenance, lastCompletedSubstep: "S18" },
    { ...provenance, externalProcessStarted: true },
    { ...provenance, exitCode: 1 },
    { ...provenance, signal: "SIGTERM" },
    { ...provenance, message: "secret" }
  ]) assert.equal(sanitizedGate3FailureProvenance(invalid), null);

  const fallback = sanitizedFailureEvidence({
    firstFailure: {
      phase: "concurrency_oauth_idempotency",
      code: "linux_gate_unclassified_failure"
    },
    gate3FailureProvenance: {
      ...provenance,
      message: "postgresql://user:secret@host/db"
    },
    cleanup: {
      cleanupCompleted: true,
      containerResiduals: 0,
      volumeResiduals: 0,
      networkResiduals: 0,
      listenerResiduals: 0,
      temporaryRootResiduals: 0
    }
  });
  assert.equal(fallback.gate3FailureProvenance, null);
  assert.equal(evidenceSafe(fallback), true);
  assert.equal(canonicalJson(fallback).includes("secret"), false);

  const preserved = sanitizedFailureEvidence({
    firstFailure: {
      phase: "concurrency_oauth_idempotency",
      code: "linux_gate_unclassified_failure"
    },
    gate3FailureProvenance: provenance,
    cleanup: {
      cleanupCompleted: true,
      containerResiduals: 0,
      volumeResiduals: 0,
      networkResiduals: 0,
      listenerResiduals: 0,
      temporaryRootResiduals: 0
    }
  });
  assert.deepEqual(preserved.gate3FailureProvenance, provenance);
  assert.equal(evidenceSafe({ gate3FailureProvenance: provenance }), true);
});

test("Gate 4 causal classification is closed and never reads raw messages", () => {
  assert.equal(gate4FailureCode({ code: "linux_safe_failure" }), "linux_safe_failure");
  assert.equal(gate4FailureCode({ code: "23514" }), "gate4_error_code_23514");
  assert.equal(gate4FailureCode({ code: "23505" }), "gate4_error_code_23505");
  assert.equal(gate4FailureCode({ code: "ETIMEDOUT" }), "gate4_error_code_etimedout");
  assert.equal(gate4FailureCode({ code: "EPIPE" }), "gate4_error_code_epipe");
  assert.equal(gate4FailureCode(new TypeError("plaintext token SQL UUID")), "gate4_type_error");
  assert.equal(gate4FailureCode(new RangeError("ciphertext nonce auth tag")), "gate4_range_error");
  assert.equal(gate4FailureCode(new Error("postgresql://user:secret@host/db")), "gate4_error_code_unavailable");
  assert.equal(gate4FailureCode({ code: "UNSUPPORTED SECRET" }), "gate4_error_code_unavailable");
  assert.equal(gate4FailureCode({
    code: "postgres_rollback_failed",
    cause: { code: "23514", cause: { code: "forbidden_nested" }, message: "secret" }
  }), "gate4_error_code_23514");
  assert.equal(gate4FailureCode({ code: "postgres_rollback_failed" }), "postgres_rollback_failed");
});

test("Gate 4 tracker accepts exactly V01-V25 once in deterministic order", async () => {
  const tracker = createGate4FailureProvenanceTracker();
  const calls = [];
  for (const [operation, substep, operationClass] of GATE4_BOUNDARIES) {
    const marker = Object.freeze({ substep });
    assert.equal(
      await tracker.forOperation(operation)(substep, operationClass, async () => {
        calls.push(substep);
        return marker;
      }),
      marker
    );
  }
  assert.deepEqual(calls, GATE4_BOUNDARIES.map(([, substep]) => substep));
  assert.equal(new Set(calls).size, 25);
  assert.equal(tracker.failure(), null);
  assert.equal(tracker.requireComplete(), true);
  assert.throws(
    () => tracker.forOperation("unknown"),
    { code: "gate4_failure_provenance_operation_invalid" }
  );
});

test("Gate 4 tracker classifies an injected first failure at every V01-V25 boundary", async () => {
  for (let targetIndex = 0; targetIndex < GATE4_BOUNDARIES.length; targetIndex += 1) {
    const tracker = createGate4FailureProvenanceTracker();
    const calls = [];
    for (let index = 0; index < targetIndex; index += 1) {
      const [operation, substep, operationClass] = GATE4_BOUNDARIES[index];
      await tracker.runSubstep(operation, substep, operationClass, async () => {
        calls.push(substep);
        return true;
      });
    }
    const [operation, substep, operationClass] = GATE4_BOUNDARIES[targetIndex];
    const injected = Object.assign(
      new Error("plaintext ciphertext nonce auth tag UUID SQL token stack"),
      { code: "23514", query: "SELECT forbidden" }
    );
    await assert.rejects(
      tracker.runSubstep(operation, substep, operationClass, async () => {
        calls.push(substep);
        throw injected;
      }),
      (error) => error === injected
    );
    assert.deepEqual(tracker.failure(), {
      operation,
      substep,
      operationClass,
      causalCode: "gate4_error_code_23514",
      lastCompletedSubstep: targetIndex === 0
        ? null
        : GATE4_BOUNDARIES[targetIndex - 1][1],
      externalProcessStarted: false,
      exitCode: null,
      signal: null
    });
    assert.deepEqual(
      calls,
      GATE4_BOUNDARIES.slice(0, targetIndex + 1).map(([, boundary]) => boundary)
    );
  }
});

test("Gate 4 tracker refuses wrong classes, repetition, skips, and backward jumps", async () => {
  const wrongClass = createGate4FailureProvenanceTracker();
  await assert.rejects(
    wrongClass.runSubstep("base", "V01", "memory_crypto", async () => true),
    { code: "gate4_failure_provenance_substep_invalid" }
  );
  const wrongOperation = createGate4FailureProvenanceTracker();
  await assert.rejects(
    wrongOperation.runSubstep("supplemental", "V01", "memory_setup", async () => true),
    { code: "gate4_failure_provenance_substep_invalid" }
  );
  const unknown = createGate4FailureProvenanceTracker();
  await assert.rejects(
    unknown.runSubstep("base", "V99", "memory_setup", async () => true),
    { code: "gate4_failure_provenance_substep_invalid" }
  );
  const skipped = createGate4FailureProvenanceTracker();
  await skipped.runSubstep("base", "V01", "memory_setup", async () => true);
  await assert.rejects(
    skipped.runSubstep("base", "V03", "memory_crypto", async () => true),
    { code: "gate4_failure_provenance_substep_invalid" }
  );
  await assert.rejects(
    skipped.runSubstep("base", "V01", "memory_setup", async () => true),
    { code: "gate4_failure_provenance_substep_invalid" }
  );
  const backward = createGate4FailureProvenanceTracker();
  await backward.runSubstep("base", "V01", "memory_setup", async () => true);
  await backward.runSubstep("base", "V02", "memory_crypto", async () => true);
  await assert.rejects(
    backward.runSubstep("base", "V01", "memory_setup", async () => true),
    { code: "gate4_failure_provenance_substep_invalid" }
  );
});

test("Gate 4 tracker freezes the first failure and never lets cleanup mask it", async () => {
  const tracker = createGate4FailureProvenanceTracker();
  await tracker.runSubstep("base", "V01", "memory_setup", async () => true);
  const primary = Object.assign(
    new Error("plaintext ciphertext nonce auth tag UUID SQL token"),
    { code: "23505", query: "SELECT forbidden", cause: { code: "secret" } }
  );
  await assert.rejects(
    tracker.runSubstep("base", "V02", "memory_crypto", async () => { throw primary; }),
    (error) => error === primary
  );
  const first = tracker.failure();
  assert.deepEqual(first, {
    operation: "base",
    substep: "V02",
    operationClass: "memory_crypto",
    causalCode: "gate4_error_code_23505",
    lastCompletedSubstep: "V01",
    externalProcessStarted: false,
    exitCode: null,
    signal: null
  });
  const cleanup = Object.assign(new Error("cleanup secret"), { code: "ETIMEDOUT" });
  await assert.rejects(
    tracker.runSubstep("base", "V09", "memory_cleanup", async () => { throw cleanup; }),
    (error) => error === cleanup
  );
  assert.equal(tracker.failure(), first);
  const serialized = canonicalJson(first);
  for (const forbidden of [
    "plaintext", "ciphertext", "nonce", "auth tag", "UUID", "SELECT",
    "query", "cause", "cleanup secret"
  ]) assert.equal(serialized.includes(forbidden), false, forbidden);
});

test("Gate 4 tracker records cleanup when cleanup is the first failure", async () => {
  const tracker = createGate4FailureProvenanceTracker();
  for (const [operation, substep, operationClass] of GATE4_BOUNDARIES.slice(0, 8)) {
    await tracker.runSubstep(operation, substep, operationClass, async () => true);
  }
  const cleanup = new RangeError("secret cleanup stack");
  await assert.rejects(
    tracker.runSubstep("base", "V09", "memory_cleanup", async () => { throw cleanup; }),
    (error) => error === cleanup
  );
  assert.deepEqual(tracker.failure(), {
    operation: "base",
    substep: "V09",
    operationClass: "memory_cleanup",
    causalCode: "gate4_range_error",
    lastCompletedSubstep: "V08",
    externalProcessStarted: false,
    exitCode: null,
    signal: null
  });
});

test("Gate 4 provenance sanitizer enforces the exact eight-field shape", () => {
  const provenance = Object.freeze({
    operation: "persisted",
    substep: "V23",
    operationClass: "postgres_vault_verification",
    causalCode: "gate4_error_code_23514",
    lastCompletedSubstep: "V22",
    externalProcessStarted: false,
    exitCode: null,
    signal: null
  });
  assert.deepEqual(sanitizedGate4FailureProvenance(provenance), provenance);
  const firstBoundary = {
    ...provenance,
    operation: "base",
    substep: "V01",
    operationClass: "memory_setup",
    lastCompletedSubstep: null
  };
  assert.deepEqual(sanitizedGate4FailureProvenance(firstBoundary), firstBoundary);
  assert.deepEqual(Object.keys(provenance).sort(), [
    "causalCode", "exitCode", "externalProcessStarted", "lastCompletedSubstep",
    "operation", "operationClass", "signal", "substep"
  ]);
  const { signal: _signal, ...missing } = provenance;
  for (const invalid of [
    missing,
    { ...provenance, message: "secret" },
    { ...provenance, operation: "supplemental" },
    { ...provenance, operationClass: "memory_crypto" },
    { ...provenance, lastCompletedSubstep: null },
    { ...provenance, lastCompletedSubstep: "V01" },
    { ...provenance, lastCompletedSubstep: "V24" },
    { ...provenance, causalCode: { toString: () => "safe_code", secret: "value" } },
    { ...provenance, externalProcessStarted: true },
    { ...provenance, exitCode: 1 },
    { ...provenance, signal: "SIGTERM" }
  ]) {
    assert.equal(sanitizedGate4FailureProvenance(invalid), null);
    assert.equal(evidenceSafe({ gate4FailureProvenance: invalid }), false);
  }
  assert.equal(evidenceSafe({ gate4FailureProvenance: provenance }), true);
  assert.equal(evidenceSafe({ gate4FailureProvenance: null }), true);
});

test("Gate 4 provenance survives only validated failure fallback evidence", () => {
  const provenance = {
    operation: "supplemental",
    substep: "V18",
    operationClass: "memory_validation",
    causalCode: "gate4_type_error",
    lastCompletedSubstep: "V17",
    externalProcessStarted: false,
    exitCode: null,
    signal: null
  };
  const source = {
    firstFailure: { phase: "vault", code: "gate4_type_error" },
    gate4FailureProvenance: provenance,
    cleanup: {
      cleanupCompleted: true,
      containerResiduals: 0,
      volumeResiduals: 0,
      networkResiduals: 0,
      listenerResiduals: 0,
      temporaryRootResiduals: 0
    }
  };
  const preserved = sanitizedFailureEvidence(source);
  assert.deepEqual(preserved.gate4FailureProvenance, provenance);
  for (const firstFailure of [
    { phase: "rls_roles", code: "gate4_type_error" },
    { phase: "vault", code: "gate4_range_error" },
    { phase: "vault", code: "gate4_failure_provenance_unobserved" }
  ]) {
    const mismatched = { ...source, firstFailure };
    const sanitized = sanitizedFailureEvidence(mismatched);
    assert.equal(sanitized.gate4FailureProvenance, null);
    assert.deepEqual(
      sanitized.firstFailure,
      firstFailure.phase === "vault" && firstFailure.code !== "gate4_failure_provenance_unobserved"
        ? { phase: "vault", code: "gate4_failure_provenance_unobserved" }
        : firstFailure
    );
    assert.equal(evidenceSafe(mismatched), false);
  }
  const rejected = sanitizedFailureEvidence({
    ...source,
    gate4FailureProvenance: { ...provenance, sql: "SELECT secret" }
  });
  assert.equal(rejected.gate4FailureProvenance, null);
  assert.deepEqual(rejected.firstFailure, {
    phase: "vault",
    code: "gate4_failure_provenance_unobserved"
  });
  assert.equal(canonicalJson(rejected).includes("SELECT"), false);
  assert.equal(evidenceSafe(preserved), true);
  assert.equal(evidenceSafe({
    ...source,
    gate4FailureProvenance: null
  }), false);
});

test("Gate 4 tracker refuses an unobserved failure without fabricating provenance", () => {
  const tracker = createGate4FailureProvenanceTracker();
  assert.equal(tracker.failure(), null);
  assert.throws(
    () => tracker.requireFailure(),
    { code: "gate4_failure_provenance_unobserved" }
  );
  assert.equal(tracker.failure(), null);
});

test("Gate 4 tracker refuses success until the complete V01-V25 tail is observed", async () => {
  const empty = createGate4FailureProvenanceTracker();
  assert.throws(
    () => empty.requireComplete(),
    { code: "gate4_failure_provenance_incomplete" }
  );
  const withoutPersisted = createGate4FailureProvenanceTracker();
  for (const [operation, substep, operationClass] of GATE4_BOUNDARIES.slice(0, 19)) {
    await withoutPersisted.runSubstep(operation, substep, operationClass, async () => true);
  }
  assert.throws(
    () => withoutPersisted.requireComplete(),
    { code: "gate4_failure_provenance_incomplete" }
  );
  const withoutV25 = createGate4FailureProvenanceTracker();
  for (const [operation, substep, operationClass] of GATE4_BOUNDARIES.slice(0, 24)) {
    await withoutV25.runSubstep(operation, substep, operationClass, async () => true);
  }
  assert.throws(
    () => withoutV25.requireComplete(),
    { code: "gate4_failure_provenance_incomplete" }
  );
});

test("Gate 4 tracker refuses reentrancy without consuming the pending next boundary", async () => {
  const tracker = createGate4FailureProvenanceTracker();
  let releaseFirst;
  let markStarted;
  const firstStarted = new Promise((resolve) => { markStarted = resolve; });
  const holdFirst = new Promise((resolve) => { releaseFirst = resolve; });
  const first = tracker.runSubstep("base", "V01", "memory_setup", async () => {
    markStarted();
    await holdFirst;
    return true;
  });
  await firstStarted;
  await assert.rejects(
    tracker.runSubstep("base", "V02", "memory_crypto", async () => true),
    { code: "gate4_failure_provenance_reentrancy_refused" }
  );
  releaseFirst();
  assert.equal(await first, true);
  assert.equal(
    await tracker.runSubstep("base", "V02", "memory_crypto", async () => "after"),
    "after"
  );
  assert.equal(tracker.failure(), null);
});

test("Gate 4 tracker requires V24 before V25 after a persisted failure", async () => {
  const tracker = createGate4FailureProvenanceTracker();
  for (const [operation, substep, operationClass] of GATE4_BOUNDARIES.slice(0, 20)) {
    await tracker.runSubstep(operation, substep, operationClass, async () => true);
  }
  const primary = Object.assign(new Error("private persisted failure"), { code: "23514" });
  await assert.rejects(
    tracker.runSubstep("persisted", "V21", "postgres_verifier_setup", async () => {
      throw primary;
    }),
    (error) => error === primary
  );
  await assert.rejects(
    tracker.runSubstep("persisted", "V25", "memory_cleanup", async () => true),
    { code: "gate4_failure_provenance_substep_invalid" }
  );
  assert.equal(
    await tracker.runSubstep("persisted", "V24", "postgres_verifier_cleanup", async () => "closed"),
    "closed"
  );
  assert.equal(
    await tracker.runSubstep("persisted", "V25", "memory_cleanup", async () => "wiped"),
    "wiped"
  );
  assert.deepEqual(tracker.failure(), {
    operation: "persisted",
    substep: "V21",
    operationClass: "postgres_verifier_setup",
    causalCode: "gate4_error_code_23514",
    lastCompletedSubstep: "V20",
    externalProcessStarted: false,
    exitCode: null,
    signal: null
  });
});

test("Gate 4 failure blocks Gate 5 while complete Gate 4 permits Gate 5", async () => {
  const failedEvidence = { phases: [], firstFailure: null };
  const failedPhase = createPhaseRunner(failedEvidence);
  const failedTracker = createGate4FailureProvenanceTracker();
  const calls = [];
  await assert.rejects(
    failedPhase("vault", () => failedTracker.runSubstep(
      "base",
      "V01",
      "memory_setup",
      async () => {
        calls.push("gate-4");
        throw Object.assign(new Error("secret"), { code: "23514" });
      }
    ))
  );
  await assert.rejects(
    failedPhase("backup_restore", async () => { calls.push("forbidden-gate-5"); }),
    { code: "linux_gate_phase_after_failure_refused" }
  );
  assert.deepEqual(calls, ["gate-4"]);
  assert.equal(failedTracker.failure().substep, "V01");

  const passedEvidence = { phases: [], firstFailure: null };
  const passedPhase = createPhaseRunner(passedEvidence);
  const passedTracker = createGate4FailureProvenanceTracker();
  await passedPhase("vault", async () => {
    calls.push("gate-4-passed");
    for (const [operation, substep, operationClass] of GATE4_BOUNDARIES) {
      await passedTracker.runSubstep(operation, substep, operationClass, async () => true);
    }
    return passedTracker.requireComplete();
  });
  await passedPhase("backup_restore", async () => { calls.push("gate-5"); });
  assert.deepEqual(calls, ["gate-4", "gate-4-passed", "gate-5"]);
});

test("Gate 4 tracker is wired into normal, failed, and sanitized fallback evidence", () => {
  const source = fs.readFileSync(
    path.join(ROOT, "scripts", "social-3a0p-linux-gate.js"),
    "utf8"
  );
  for (const needle of [
    "const gate4FailureProvenance = createGate4FailureProvenanceTracker();",
    "gate4FailureProvenance: null",
    'runGate4Substep: gate4FailureProvenance.forOperation("base")',
    'runGate4Substep: gate4FailureProvenance.forOperation("supplemental")',
    'runGate4Substep: gate4FailureProvenance.forOperation("persisted")',
    "gate4FailureProvenance.requireComplete();",
    "gate4FailureProvenance.requireFailure();",
    "evidence.gate4FailureProvenance = gate4FailureProvenance.failure();",
    "source?.gate4FailureProvenance"
  ]) assert.ok(source.includes(needle), needle);
  const baseIndex = source.indexOf('gate4FailureProvenance.forOperation("base")');
  const supplementalIndex = source.indexOf('gate4FailureProvenance.forOperation("supplemental")');
  const persistedIndex = source.indexOf('gate4FailureProvenance.forOperation("persisted")');
  assert.ok(baseIndex >= 0 && baseIndex < supplementalIndex && supplementalIndex < persistedIndex);

  const beforeGate4 = sanitizedFailureEvidence({
    firstFailure: { phase: "rls_roles", code: "linux_gate_unclassified_failure" },
    cleanup: {
      cleanupCompleted: true,
      containerResiduals: 0,
      volumeResiduals: 0,
      networkResiduals: 0,
      listenerResiduals: 0,
      temporaryRootResiduals: 0
    }
  });
  assert.equal(beforeGate4.gate4FailureProvenance, null);
  assert.equal(evidenceSafe(beforeGate4), true);
});

test("Gate 4 phase classification never stores the raw error message fallback", async () => {
  const evidence = { phases: [], firstFailure: null };
  const phase = createPhaseRunner(evidence);
  const raw = new Error("raw_vault_message_must_not_be_stored");
  let classifierArguments = -1;
  await assert.rejects(
    phase("vault", async () => { throw raw; }, {
      classifyFailure(...args) {
        classifierArguments = args.length;
        return "gate4_error_code_unavailable";
      }
    }),
    (error) => error === raw
  );
  assert.equal(classifierArguments, 0);
  assert.deepEqual(evidence.firstFailure, {
    phase: "vault",
    code: "gate4_error_code_unavailable"
  });
  assert.equal(canonicalJson(evidence).includes(raw.message), false);
});

test("gate process status sidecar is closed, hashed, and stores no streams", () => {
  const exited = Object.freeze({
    exitCode: 1,
    signal: null,
    timedOut: false,
    stdoutStored: false,
    stderrStored: false
  });
  assert.deepEqual(gateProcessStatusFromChildResult({
    exitCode: 1,
    signal: null,
    timedOut: false
  }), exited);
  assert.deepEqual(gateProcessStatusFromChildResult({
    exitCode: 137,
    signal: null,
    timedOut: false
  }), {
    exitCode: 137,
    signal: null,
    timedOut: false,
    stdoutStored: false,
    stderrStored: false
  });
  assert.deepEqual(gateProcessStatusFromChildResult({
    exitCode: null,
    signal: "SIGKILL",
    timedOut: false
  }), {
    exitCode: null,
    signal: "SIGKILL",
    timedOut: false,
    stdoutStored: false,
    stderrStored: false
  });
  assert.deepEqual(sanitizedGateProcessStatus({
    exitCode: null,
    signal: "SIGTERM",
    timedOut: true,
    stdoutStored: false,
    stderrStored: false
  }), {
    exitCode: null,
    signal: "SIGTERM",
    timedOut: true,
    stdoutStored: false,
    stderrStored: false
  });
  assert.equal(sanitizedGateProcessStatus({
    ...exited,
    stdoutStored: "forbidden"
  }), null);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "social-gate3-process-status-"));
  try {
    const result = writeGateProcessStatus({ evidenceDirectory: directory, status: exited });
    assert.deepEqual(result, exited);
    const jsonPath = path.join(directory, GATE_PROCESS_STATUS_FILE);
    const hashPath = path.join(directory, GATE_PROCESS_STATUS_HASH_FILE);
    const serialized = fs.readFileSync(jsonPath, "utf8");
    const expectedHash = fs.readFileSync(hashPath, "utf8").slice(0, 64);
    assert.equal(
      crypto.createHash("sha256").update(serialized).digest("hex"),
      expectedHash
    );
    assert.deepEqual(JSON.parse(serialized), result);
    assert.equal(Object.hasOwn(JSON.parse(serialized), "stdout"), false);
    assert.equal(Object.hasOwn(JSON.parse(serialized), "stderr"), false);
    for (const forbidden of ["password", "token", "postgresql://"]) {
      assert.equal(serialized.includes(forbidden), false);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: false });
  }
});

test("gate process supervisor records the actual signal and timeout without storing streams", async () => {
  const directory = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "social-gate3-supervisor-")),
    "evidence"
  );
  const child = new EventEmitter();
  const kills = [];
  child.kill = (signal) => {
    kills.push(signal);
    setImmediate(() => child.emit("close", null, signal));
    return true;
  };
  try {
    const result = await runGateProcessSupervisor({
      evidenceDirectory: directory,
      killGraceMs: 100,
      runnerTemp: os.tmpdir(),
      spawnImpl(executable, args, options) {
        assert.equal(executable, process.execPath);
        assert.deepEqual(args.slice(-1), ["--run"]);
        assert.equal(options.stdio, "inherit");
        assert.equal(Object.hasOwn(options, "shell"), false);
        return child;
      },
      timeoutMs: 5
    });
    assert.deepEqual(kills, ["SIGTERM"]);
    assert.deepEqual(result, {
      status: {
        exitCode: null,
        signal: "SIGTERM",
        timedOut: true,
        stdoutStored: false,
        stderrStored: false
      },
      workflowExitCode: 1
    });
    const serialized = fs.readFileSync(
      path.join(directory, GATE_PROCESS_STATUS_FILE),
      "utf8"
    );
    assert.deepEqual(JSON.parse(serialized), result.status);
    assert.equal(serialized.includes("stdout\":"), false);
    assert.equal(serialized.includes("stderr\":"), false);
  } finally {
    fs.rmSync(path.dirname(directory), { recursive: true, force: false });
  }
});

test("gate process supervisor distinguishes normal exit, signal, and sidecar failure", async (t) => {
  async function runClosed(exitCode, signal, directory) {
    const child = new EventEmitter();
    child.kill = () => true;
    setImmediate(() => child.emit("close", exitCode, signal));
    return runGateProcessSupervisor({
      evidenceDirectory: directory,
      killGraceMs: 100,
      runnerTemp: os.tmpdir(),
      spawnImpl() { return child; },
      timeoutMs: 1_000
    });
  }

  await t.test("normal exit", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "social-gate3-normal-"));
    try {
      const result = await runClosed(0, null, path.join(root, "evidence"));
      assert.deepEqual(result.status, {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdoutStored: false,
        stderrStored: false
      });
      assert.equal(result.workflowExitCode, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: false });
    }
  });

  await t.test("real signal", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "social-gate3-signal-"));
    try {
      const result = await runClosed(null, "SIGABRT", path.join(root, "evidence"));
      assert.deepEqual(result.status, {
        exitCode: null,
        signal: "SIGABRT",
        timedOut: false,
        stdoutStored: false,
        stderrStored: false
      });
      assert.equal(result.workflowExitCode, 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: false });
    }
  });

  await t.test("sidecar collision rejects", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "social-gate3-collision-"));
    const directory = path.join(root, "evidence");
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, GATE_PROCESS_STATUS_FILE), "occupied", {
      flag: "wx"
    });
    try {
      await assert.rejects(runClosed(0, null, directory), { code: "EEXIST" });
    } finally {
      fs.rmSync(root, { recursive: true, force: false });
    }
  });
});

test("RLS failure provenance preserves only the first closed substep and causal code", async () => {
  const tracker = createRlsFailureProvenanceTracker();
  await assert.rejects(
    tracker.runSubstep("rls_core_user_insert_reproduction", async () => {
      throw Object.assign(new Error("must not be published"), { code: "42501" });
    }),
    { code: "postgres_insufficient_privilege", name: "LinuxGateFailure" }
  );
  await assert.rejects(
    tracker.runSubstep("rls_cross_tenant_write", async () => {
      throw Object.assign(new Error("must not replace first"), { code: "22P02" });
    }),
    { code: "postgres_invalid_text_representation", name: "LinuxGateFailure" }
  );
  assert.deepEqual(tracker.failure(), {
    substep: "rls_core_user_insert_reproduction",
    causalCode: "postgres_insufficient_privilege"
  });
  assert.deepEqual(sanitizedRlsFailureProvenance(tracker.failure()), tracker.failure());
  assert.equal(sanitizedRlsFailureProvenance({
    ...tracker.failure(),
    sql: "forbidden"
  }), null);
  assert.equal(sanitizedRlsFailureProvenance({
    substep: "unknown",
    causalCode: "postgres_insufficient_privilege"
  }), null);
  const fallback = sanitizedFailureEvidence({
    firstFailure: {
      phase: "rls_runtime_write_contract_reproduction",
      code: "postgres_insufficient_privilege"
    },
    rlsFailureProvenance: tracker.failure(),
    cleanup: {
      cleanupCompleted: true,
      containerResiduals: 0,
      volumeResiduals: 0,
      networkResiduals: 0,
      listenerResiduals: 0,
      temporaryRootResiduals: 0
    }
  });
  assert.deepEqual(fallback.rlsFailureProvenance, tracker.failure());
  assert.equal(evidenceSafe(fallback), true);
});

test("RLS OID inventory-context evidence is exact, frozen, semantic, and identity-free", () => {
  const evidence = publicRlsPrivilegeInventoryContextReproductionEvidence(
    validRlsInventoryContextReproductionResult()
  );
  assert.equal(Object.isFrozen(evidence), true);
  assert.deepEqual(
    Object.keys(evidence).sort(),
    Object.keys(validRlsInventoryContextReproductionResult()).sort()
  );
  assert.equal(Object.keys(evidence).length, 22);
  assert.equal(evidence.migratorSchemaUsage, false);
  assert.equal(evidence.inventorySessionUserMigration, true);
  assert.equal(evidence.inventoryCurrentUserMigrator, true);
  assert.equal(evidence.oidInventoryUsed, true);
  assert.equal(evidence.textualRelationResolutionUsed, false);
  assert.equal(evidence.relationCount, 2);
  assert.equal(
    Object.entries(evidence).every(([key, value]) =>
      key === "relationCount" ? Number.isInteger(value) : typeof value === "boolean"
    ),
    true
  );
  for (const forbidden of [
    "sessionUser", "currentUser", "login", "roleName", "sql", "arguments", "message"
  ]) {
    assert.equal(Object.hasOwn(evidence, forbidden), false);
  }
  assert.equal(evidenceSafe({ inventoryContextReproduction: evidence }), true);
  for (const divergence of [
    { migratorSchemaUsage: true },
    { inventorySessionUserMigration: false },
    { inventoryCurrentUserMigrator: false },
    { oidInventoryUsed: false },
    { textualRelationResolutionUsed: true },
    { relationCount: 1 },
    { relationCount: 3 },
    { unexpected: true }
  ]) {
    assert.throws(
      () => publicRlsPrivilegeInventoryContextReproductionEvidence(
        validRlsInventoryContextReproductionResult(divergence)
      ),
      {
        code: "rls_privilege_inventory_context_reproduction_invalid",
        name: "LinuxGateFailure"
      }
    );
  }
});

test("RLS inventory-context phase passes only canonical state and the closed substep adapter", async () => {
  const tracker = createRlsFailureProvenanceTracker();
  const state = Object.freeze({ synthetic: true });
  const calls = [];
  const evidence = await runRlsPrivilegeInventoryContextPhase({
    state,
    runSubstep: tracker.runSubstep,
    async runReproduction(receivedState, dependencies) {
      assert.equal(receivedState, state);
      assert.deepEqual(Object.keys(dependencies), ["runSubstep"]);
      assert.equal(dependencies.runSubstep, tracker.runSubstep);
      await dependencies.runSubstep(
        "rls_inventory_direct_session_identity",
        async () => { calls.push("direct-session"); }
      );
      await dependencies.runSubstep(
        "rls_inventory_migrator_role_activation",
        async () => { calls.push("migrator-role"); }
      );
      await dependencies.runSubstep(
        "rls_inventory_role_reset",
        async () => { calls.push("role-reset"); }
      );
      return validRlsInventoryContextReproductionResult();
    }
  });
  assert.deepEqual(calls, ["direct-session", "migrator-role", "role-reset"]);
  assert.deepEqual(evidence, validRlsInventoryContextReproductionResult());
  assert.equal(evidence.migratorSchemaUsage, false);
  assert.equal(evidence.oidInventoryUsed, true);
  assert.equal(evidence.textualRelationResolutionUsed, false);
  assert.equal(evidence.relationCount, 2);
  assert.equal(tracker.failure(), null);
});

test("RLS OID inventory divergence stops before old reproduction and Gates 2 through 5", async () => {
  const tracker = createRlsFailureProvenanceTracker();
  const calls = [];
  const evidence = { phases: [], firstFailure: null };
  const phase = createPhaseRunner(evidence);
  await phase("migrations", async () => ({ gate1Passed: true }));
  await assert.rejects(
    phase(
      "rls_privilege_inventory_context_reproduction",
      () => runRlsPrivilegeInventoryContextPhase({
        state: {},
        runSubstep: tracker.runSubstep,
        async runReproduction() {
          calls.push("inventory-context");
          return validRlsInventoryContextReproductionResult({ migratorSchemaUsage: true });
        }
      })
    ),
    {
      code: "rls_privilege_inventory_context_reproduction_invalid",
      name: "LinuxGateFailure"
    }
  );
  await assert.rejects(
    phase("rls_runtime_write_contract_reproduction", async () => {
      calls.push("forbidden-old-reproduction");
    }),
    { code: "linux_gate_phase_after_failure_refused", name: "LinuxGateFailure" }
  );
  await assert.rejects(
    phase("rls_roles", async () => { calls.push("forbidden-gate-2"); }),
    { code: "linux_gate_phase_after_failure_refused", name: "LinuxGateFailure" }
  );
  for (const [name, marker] of [
    ["concurrency_oauth_idempotency", "forbidden-gate-3"],
    ["vault", "forbidden-gate-4"],
    ["backup_restore", "forbidden-gate-5"]
  ]) {
    await assert.rejects(
      phase(name, async () => { calls.push(marker); }),
      { code: "linux_gate_phase_after_failure_refused", name: "LinuxGateFailure" }
    );
  }
  assert.deepEqual(calls, ["inventory-context"]);
  assert.deepEqual(evidence.firstFailure, {
    phase: "rls_privilege_inventory_context_reproduction",
    code: "rls_privilege_inventory_context_reproduction_invalid"
  });
  assert.deepEqual(tracker.failure(), {
    substep: "rls_inventory_role_reset",
    causalCode: "rls_privilege_inventory_context_reproduction_invalid"
  });
});

test("RLS runtime-attributes OID evidence is exact, frozen, boolean, and identity-free", () => {
  const expected = validRlsRuntimeAttributesTextResolutionResult();
  const evidence = publicRlsRuntimeAttributesTextResolutionReproductionEvidence(expected);
  assert.equal(Object.isFrozen(evidence), true);
  assert.deepEqual(Object.keys(evidence).sort(), Object.keys(expected).sort());
  assert.equal(Object.keys(evidence).length, 16);
  assert.equal(Object.values(evidence).every((value) => typeof value === "boolean"), true);
  assert.equal(evidence.runtimeLoginMigrationSchemaUsage, false);
  assert.equal(evidence.runtimeRoleMigrationSchemaUsage, false);
  assert.equal(evidence.migrationSchemaLocatedByOid, true);
  assert.equal(evidence.migrationLedgerLocatedByOid, true);
  assert.equal(evidence.textualResolutionUsed, false);
  for (const forbidden of [
    "sessionUser", "currentUser", "login", "roleName", "schemaName",
    "relationName", "oid", "sql", "arguments", "message"
  ]) {
    assert.equal(Object.hasOwn(evidence, forbidden), false);
  }
  assert.equal(evidenceSafe({ runtimeAttributesTextResolutionReproduction: evidence }), true);
  for (const [key, value] of Object.entries(expected)) {
    assert.throws(
      () => publicRlsRuntimeAttributesTextResolutionReproductionEvidence({
        ...expected,
        [key]: !value
      }),
      {
        code: "rls_runtime_attributes_text_resolution_reproduction_invalid",
        name: "LinuxGateFailure"
      }
    );
  }
  assert.throws(
    () => publicRlsRuntimeAttributesTextResolutionReproductionEvidence({
      ...expected,
      unexpected: true
    }),
    {
      code: "rls_runtime_attributes_text_resolution_reproduction_invalid",
      name: "LinuxGateFailure"
    }
  );
});

test("RLS runtime-attributes phase calls the physical proof once with only the closed adapter", async () => {
  const tracker = createRlsFailureProvenanceTracker();
  const state = Object.freeze({ synthetic: true });
  const calls = [];
  const substeps = [];
  const runSubstep = async (substep, operation) => {
    substeps.push(substep);
    return tracker.runSubstep(substep, operation);
  };
  const evidence = await runRlsRuntimeAttributesTextResolutionPhase({
    state,
    runSubstep,
    async runReproduction(receivedState, dependencies) {
      calls.push("reproduction");
      assert.equal(receivedState, state);
      assert.deepEqual(Object.keys(dependencies), ["runSubstep"]);
      assert.equal(dependencies.runSubstep, runSubstep);
      await dependencies.runSubstep(
        "rls_runtime_attributes_direct_identity",
        async () => { calls.push("direct-identity"); }
      );
      await dependencies.runSubstep(
        "rls_runtime_attributes_text_resolution_refusal",
        async () => { calls.push("text-refusal"); }
      );
      await dependencies.runSubstep(
        "rls_runtime_attributes_oid_catalog",
        async () => { calls.push("oid-catalog"); }
      );
      await dependencies.runSubstep(
        "rls_runtime_attributes_oid_privileges",
        async () => { calls.push("oid-privileges"); }
      );
      await dependencies.runSubstep(
        "rls_runtime_attributes_acl_reset",
        async () => { calls.push("acl-reset"); }
      );
      return validRlsRuntimeAttributesTextResolutionResult();
    }
  });
  assert.deepEqual(calls, [
    "reproduction", "direct-identity", "text-refusal", "oid-catalog",
    "oid-privileges", "acl-reset"
  ]);
  assert.deepEqual(substeps, [
    "rls_runtime_attributes_direct_identity",
    "rls_runtime_attributes_text_resolution_refusal",
    "rls_runtime_attributes_oid_catalog",
    "rls_runtime_attributes_oid_privileges",
    "rls_runtime_attributes_acl_reset",
    "rls_runtime_attributes_evidence_validation"
  ]);
  assert.deepEqual(evidence, validRlsRuntimeAttributesTextResolutionResult());
  assert.equal(tracker.failure(), null);
});

test("RLS runtime-attributes divergence stops before Gate 2 and Gates 3 through 5", async () => {
  const tracker = createRlsFailureProvenanceTracker();
  const calls = [];
  const evidence = { phases: [], firstFailure: null };
  const phase = createPhaseRunner(evidence);
  await phase("migrations", async () => ({ gate1Passed: true }));
  await phase(
    "rls_privilege_inventory_context_reproduction",
    async () => validRlsInventoryContextReproductionResult()
  );
  await phase(
    "rls_runtime_write_contract_reproduction",
    async () => ({ baseRlsGatePassed: true })
  );
  await assert.rejects(
    phase(
      "rls_runtime_attributes_text_resolution_reproduction",
      () => runRlsRuntimeAttributesTextResolutionPhase({
        state: {},
        runSubstep: tracker.runSubstep,
        async runReproduction() {
          calls.push("runtime-attributes");
          return validRlsRuntimeAttributesTextResolutionResult({
            textualResolutionUsed: true
          });
        }
      })
    ),
    {
      code: "rls_runtime_attributes_text_resolution_reproduction_invalid",
      name: "LinuxGateFailure"
    }
  );
  for (const [name, marker] of [
    ["rls_roles", "forbidden-gate-2"],
    ["concurrency_oauth_idempotency", "forbidden-gate-3"],
    ["vault", "forbidden-gate-4"],
    ["backup_restore", "forbidden-gate-5"]
  ]) {
    await assert.rejects(
      phase(name, async () => { calls.push(marker); }),
      { code: "linux_gate_phase_after_failure_refused", name: "LinuxGateFailure" }
    );
  }
  assert.deepEqual(calls, ["runtime-attributes"]);
  assert.deepEqual(evidence.firstFailure, {
    phase: "rls_runtime_attributes_text_resolution_reproduction",
    code: "rls_runtime_attributes_text_resolution_reproduction_invalid"
  });
  assert.deepEqual(tracker.failure(), {
    substep: "rls_runtime_attributes_evidence_validation",
    causalCode: "rls_runtime_attributes_text_resolution_reproduction_invalid"
  });
});

test("canonical runtime-attributes proof permits Gate 2 and simulated Gates 3 through 5 in order", async () => {
  const calls = [];
  const tracker = createRlsFailureProvenanceTracker();
  const state = Object.freeze({ synthetic: true });
  const evidence = { phases: [], firstFailure: null };
  const phase = createPhaseRunner(evidence);
  const orchestrator = createRlsRuntimeWriteContractOrchestrator({
    state,
    inventoryContextReproduction: validRlsInventoryContextReproductionResult(),
    gates: {
      async rls() {
        calls.push("base");
        return validRlsBaseGateResult();
      }
    },
    runSubstep: tracker.runSubstep,
    async runReproduction() {
      calls.push("old-reproduction");
      return validRlsReproductionResult();
    },
    async runCorrected(receivedState, dependencies) {
      assert.equal(receivedState, state);
      assert.deepEqual(
        dependencies.runtimeAttributesTextResolutionReproduction,
        validRlsRuntimeAttributesTextResolutionResult()
      );
      calls.push("gate-2");
      return validRlsRoleGateResult();
    }
  });
  await phase("migrations", async () => { calls.push("gate-1"); return { passed: true }; });
  await phase(
    "rls_privilege_inventory_context_reproduction",
    async () => validRlsInventoryContextReproductionResult()
  );
  await phase(
    "rls_runtime_write_contract_reproduction",
    () => orchestrator.reproduce()
  );
  const runtimeAttributes = await phase(
    "rls_runtime_attributes_text_resolution_reproduction",
    () => runRlsRuntimeAttributesTextResolutionPhase({
      state,
      runSubstep: tracker.runSubstep,
      async runReproduction() {
        calls.push("runtime-attributes");
        return validRlsRuntimeAttributesTextResolutionResult();
      }
    })
  );
  await phase("rls_roles", () => orchestrator.correct(runtimeAttributes));
  await phase("concurrency_oauth_idempotency", async () => { calls.push("gate-3"); return {}; });
  await phase("vault", async () => { calls.push("gate-4"); return {}; });
  await phase("backup_restore", async () => { calls.push("gate-5"); return {}; });
  assert.deepEqual(calls, [
    "gate-1", "base", "old-reproduction", "runtime-attributes",
    "gate-2", "gate-3", "gate-4", "gate-5"
  ]);
  assert.equal(evidence.firstFailure, null);
  assert.deepEqual(evidence.phases.map(({ name, status }) => [name, status]), [
    ["migrations", "passed"],
    ["rls_privilege_inventory_context_reproduction", "passed"],
    ["rls_runtime_write_contract_reproduction", "passed"],
    ["rls_runtime_attributes_text_resolution_reproduction", "passed"],
    ["rls_roles", "passed"],
    ["concurrency_oauth_idempotency", "passed"],
    ["vault", "passed"],
    ["backup_restore", "passed"]
  ]);
});

test("RLS write-contract orchestrator requires the canonical inventory-context proof", () => {
  const options = {
    state: {},
    gates: { async rls() { return validRlsBaseGateResult(); } },
    runSubstep: createRlsFailureProvenanceTracker().runSubstep,
    async runReproduction() { return validRlsReproductionResult(); },
    async runCorrected() { return validRlsRoleGateResult(); }
  };
  assert.throws(
    () => createRlsRuntimeWriteContractOrchestrator(options),
    {
      code: "rls_privilege_inventory_context_reproduction_required",
      name: "LinuxGateFailure"
    }
  );
  assert.throws(
    () => createRlsRuntimeWriteContractOrchestrator({
      ...options,
      inventoryContextReproduction: validRlsInventoryContextReproductionResult({
        migratorSchemaUsage: true
      })
    }),
    {
      code: "rls_privilege_inventory_context_reproduction_required",
      name: "LinuxGateFailure"
    }
  );
  assert.throws(
    () => createRlsRuntimeWriteContractOrchestrator({
      ...options,
      inventoryContextReproduction: validRlsInventoryContextReproductionResult({
        oidInventoryUsed: false,
        textualRelationResolutionUsed: true
      })
    }),
    {
      code: "rls_privilege_inventory_context_reproduction_required",
      name: "LinuxGateFailure"
    }
  );
});

test("RLS reproduction and corrected evidence have exact frozen boolean inventories", () => {
  const reproduction = publicRlsRuntimeWriteContractReproductionEvidence(
    validRlsReproductionResult()
  );
  assert.equal(Object.isFrozen(reproduction), true);
  assert.deepEqual(Object.keys(reproduction).sort(), [
    "baseRlsGatePassed",
    "oldGateLaterStagesReached",
    "runtimeCoreUserInsertPersisted",
    "runtimeCoreUserInsertPrivilege",
    "runtimeCoreUserInsertRefused",
    "runtimePoolUsableAfterRefusal",
    "runtimePrivilegesUnchanged",
    "socialAuditEventInsertPrivilege",
    "socialAuditEventsRlsProtected",
    "tenantSeedsCreatedByAdministrativeRole"
  ].sort());
  assert.equal(Object.values(reproduction).every((value) => typeof value === "boolean"), true);
  assert.equal(Object.hasOwn(reproduction, "legacySanitizerClassification"), false);

  const corrected = publicRlsRoleGateEvidence(validRlsRoleGateResult());
  assert.equal(Object.isFrozen(corrected), true);
  assert.deepEqual(Object.keys(corrected).sort(), Object.keys(validRlsRoleGateResult()).sort());
  assert.equal(Object.keys(corrected).length, 22);
  assert.equal(Object.values(corrected).every((value) => typeof value === "boolean"), true);
  assert.equal(evidenceSafe({ reproduction, corrected, rlsFailureProvenance: null }), true);
});

test("RLS orchestrator runs base then reproduction then corrected without publishing legacy diagnostics", async () => {
  const calls = [];
  const tracker = createRlsFailureProvenanceTracker();
  const state = Object.freeze({ synthetic: true });
  const orchestrator = createRlsRuntimeWriteContractOrchestrator({
    state,
    inventoryContextReproduction: validRlsInventoryContextReproductionResult(),
    gates: {
      async rls(request) {
        assert.equal(request.state, state);
        calls.push("base");
        return validRlsBaseGateResult();
      }
    },
    runSubstep: tracker.runSubstep,
    async runReproduction(receivedState, dependencies) {
      assert.equal(receivedState, state);
      assert.deepEqual(
        dependencies.inventoryContextReproduction,
        validRlsInventoryContextReproductionResult()
      );
      assert.equal(dependencies.legacyFailureCode({ code: "42501" }), "linux_gate_unclassified_failure");
      calls.push("reproduction");
      await dependencies.runSubstep("rls_inventory_migrator_privilege_read", async () => {
        calls.push("inventory");
      });
      return validRlsReproductionResult();
    },
    async runCorrected(receivedState, dependencies) {
      assert.equal(receivedState, state);
      assert.equal(dependencies.baseRlsGatePassed, true);
      assert.deepEqual(dependencies.reproduction, validRlsReproductionResult());
      assert.deepEqual(
        dependencies.runtimeAttributesTextResolutionReproduction,
        validRlsRuntimeAttributesTextResolutionResult()
      );
      calls.push("corrected");
      await dependencies.runSubstep("rls_own_social_write", async () => {
        calls.push("own-write");
      });
      return validRlsRoleGateResult();
    }
  });
  const reproductionEvidence = await orchestrator.reproduce();
  const correctedEvidence = await orchestrator.correct(
    validRlsRuntimeAttributesTextResolutionResult()
  );
  assert.deepEqual(calls, ["base", "reproduction", "inventory", "corrected", "own-write"]);
  assert.equal(reproductionEvidence.baseRlsGatePassed, true);
  assert.equal(correctedEvidence.companyAOwnSocialWrite, true);
  assert.equal(correctedEvidence.companyBToAWriteRefused, true);
  assert.equal(tracker.failure(), null);
  assert.equal(canonicalJson({ reproductionEvidence, correctedEvidence }).includes(
    "linux_gate_unclassified_failure"
  ), false);
});

test("RLS orchestrator requires the canonical runtime-attributes proof and has no fallback", async () => {
  for (const proof of [
    undefined,
    validRlsRuntimeAttributesTextResolutionResult({ migrationSchemaLocatedByOid: false }),
    validRlsRuntimeAttributesTextResolutionResult({ textualResolutionUsed: true }),
    validRlsRuntimeAttributesTextResolutionResult({ unexpected: true })
  ]) {
    const calls = [];
    const orchestrator = createRlsRuntimeWriteContractOrchestrator({
      state: {},
      inventoryContextReproduction: validRlsInventoryContextReproductionResult(),
      gates: { async rls() { calls.push("base"); return validRlsBaseGateResult(); } },
      runSubstep: createRlsFailureProvenanceTracker().runSubstep,
      async runReproduction() {
        calls.push("reproduction");
        return validRlsReproductionResult();
      },
      async runCorrected() {
        calls.push("forbidden-corrected");
        return validRlsRoleGateResult();
      }
    });
    await orchestrator.reproduce();
    await assert.rejects(
      orchestrator.correct(proof),
      {
        code: "rls_runtime_attributes_text_resolution_reproduction_required",
        name: "LinuxGateFailure"
      }
    );
    await assert.rejects(
      orchestrator.correct(validRlsRuntimeAttributesTextResolutionResult()),
      {
        code: "rls_runtime_write_contract_reproduction_required",
        name: "LinuxGateFailure"
      }
    );
    assert.deepEqual(calls, ["base", "reproduction"]);
  }
});

test("RLS orchestrator refuses a noncanonical base result before reproduction", async () => {
  const calls = [];
  const tracker = createRlsFailureProvenanceTracker();
  const orchestrator = createRlsRuntimeWriteContractOrchestrator({
    state: {},
    inventoryContextReproduction: validRlsInventoryContextReproductionResult(),
    gates: {
      async rls() {
        calls.push("base");
        return validRlsBaseGateResult({ forceRls: false });
      }
    },
    runSubstep: tracker.runSubstep,
    async runReproduction() {
      calls.push("forbidden-reproduction");
      return validRlsReproductionResult();
    },
    async runCorrected() {
      calls.push("forbidden-corrected");
      return validRlsRoleGateResult();
    }
  });
  await assert.rejects(
    orchestrator.reproduce(),
    { code: "rls_base_gate_evidence_invalid", name: "LinuxGateFailure" }
  );
  assert.deepEqual(calls, ["base"]);
  assert.deepEqual(tracker.failure(), {
    substep: "rls_base_gate",
    causalCode: "rls_base_gate_evidence_invalid"
  });
});

test("RLS orchestrator attributes a noncanonical corrected result before later gates", async () => {
  const tracker = createRlsFailureProvenanceTracker();
  const orchestrator = createRlsRuntimeWriteContractOrchestrator({
    state: {},
    inventoryContextReproduction: validRlsInventoryContextReproductionResult(),
    gates: { async rls() { return validRlsBaseGateResult(); } },
    runSubstep: tracker.runSubstep,
    async runReproduction() { return validRlsReproductionResult(); },
    async runCorrected() {
      return validRlsRoleGateResult({ runtimeSuperuser: true });
    }
  });
  await orchestrator.reproduce();
  await assert.rejects(
    orchestrator.correct(validRlsRuntimeAttributesTextResolutionResult()),
    { code: "rls_role_gate_evidence_invalid", name: "LinuxGateFailure" }
  );
  assert.deepEqual(tracker.failure(), {
    substep: "rls_runtime_role_attributes",
    causalCode: "rls_role_gate_evidence_invalid"
  });
});

test("RLS reproduction divergence fails closed before corrected and later phases", async () => {
  const calls = [];
  const tracker = createRlsFailureProvenanceTracker();
  const orchestrator = createRlsRuntimeWriteContractOrchestrator({
    state: {},
    inventoryContextReproduction: validRlsInventoryContextReproductionResult(),
    gates: {
      async rls() {
        calls.push("base");
        return validRlsBaseGateResult();
      }
    },
    runSubstep: tracker.runSubstep,
    async runReproduction() {
      calls.push("reproduction");
      return validRlsReproductionResult({ runtimeCoreUserInsertPrivilege: true });
    },
    async runCorrected() {
      calls.push("corrected");
      return validRlsRoleGateResult();
    }
  });
  await assert.rejects(
    orchestrator.reproduce(),
    { code: "rls_runtime_write_contract_reproduction_invalid", name: "LinuxGateFailure" }
  );
  await assert.rejects(
    orchestrator.correct(),
    { code: "rls_runtime_write_contract_reproduction_required", name: "LinuxGateFailure" }
  );
  assert.deepEqual(calls, ["base", "reproduction"]);
  assert.deepEqual(tracker.failure(), {
    substep: "rls_core_user_insert_reproduction",
    causalCode: "rls_runtime_write_contract_reproduction_invalid"
  });

  const evidence = { phases: [], firstFailure: null };
  const phase = createPhaseRunner(evidence);
  await assert.rejects(phase("rls_runtime_write_contract_reproduction", () => {
    throw new LinuxGateFailure("rls_runtime_write_contract_reproduction_invalid");
  }));
  await assert.rejects(phase("rls_roles", async () => {
    calls.push("forbidden-corrected-phase");
  }));
  await assert.rejects(phase("concurrency_oauth_idempotency", async () => {
    calls.push("forbidden-gate-3");
  }));
  assert.deepEqual(calls, ["base", "reproduction"]);
});

test("postgres failure evidence preserves only the closed sanitized diagnostics", async () => {
  const evidence = { phases: [], firstFailure: null };
  const phase = createPhaseRunner(evidence);
  const diagnostic = {
    networkCreated: true,
    networkInternal: true,
    networkDriverClass: "bridge",
    containerCreated: true,
    containerRunning: true,
    containerNetworkCount: 1,
    containerIpPresent: true,
    containerIpWithinSubnet: true,
    portBindingsAbsent: true,
    publishedPortsAbsent: true,
    internalReadinessPassed: true,
    hostDirectConnectionAttempted: true,
    hostDirectConnectionPassed: false,
    hostListenerAbsent: true,
    failureStage: "host_direct_connection",
    sanitizedFailureCode: "linux_postgres_host_direct_connection_failed",
    cleanupCompleted: false,
    rawStdout: "forbidden",
    rawInspect: { Id: "forbidden" },
    message: "forbidden"
  };
  await assert.rejects(
    phase("postgres", async () => {
      throw new LinuxPostgresFailure("linux_postgres_host_direct_connection_failed", diagnostic);
    }),
    { code: "linux_postgres_host_direct_connection_failed" }
  );
  assert.deepEqual(evidence.firstFailure, {
    phase: "postgres",
    code: "linux_postgres_host_direct_connection_failed"
  });
  assert.equal(evidence.phases.length, 1);
  assert.deepEqual(Object.keys(evidence.phases[0].diagnostics).sort(), [
    "networkCreated", "networkInternal", "networkDriverClass",
    "containerCreated", "containerRunning", "containerNetworkCount",
    "containerIpPresent", "containerIpWithinSubnet", "portBindingsAbsent",
    "publishedPortsAbsent", "internalReadinessPassed",
    "hostDirectConnectionAttempted", "hostDirectConnectionPassed",
    "hostListenerAbsent", "failureStage", "sanitizedFailureCode",
    "cleanupCompleted"
  ].sort());
  const serialized = JSON.stringify(evidence);
  assert.equal(serialized.includes("forbidden"), false);
  assert.equal(serialized.includes("rawStdout"), false);
  assert.equal(serialized.includes("rawInspect"), false);
  assert.equal(evidenceSafe(evidence), true);

  const forged = { phases: [], firstFailure: null };
  await assert.rejects(createPhaseRunner(forged)("postgres", async () => {
    const error = new Error("synthetic");
    error.code = "linux_postgres_container_inspect_failed";
    error.linuxPostgresDiagnostic = diagnostic;
    throw error;
  }));
  assert.equal(Object.hasOwn(forged.phases[0], "diagnostics"), false);
});

test("bootstrap evidence excludes pools and password-bearing configuration", () => {
  const raw = {
    checks: {
      roleBootstrapIdempotent: true,
      runtimePoolMax3: true,
      runtimePoolConfiguredMax: 3,
      syntheticCredentialsOnly: true
    },
    pools: { runtime: { options: { password: "synthetic-sensitive" } } }
  };
  const result = publicBootstrapEvidence(raw);
  assert.deepEqual(result, raw.checks);
  assert.equal(Object.hasOwn(result, "pools"), false);
  assert.equal(evidenceSafe(result), true);
});

test("platform evidence normalizes the hosted runner ext filesystem name", async () => {
  let call = 0;
  const result = await publicPlatformEvidence(path.resolve(os.tmpdir()), async () => {
    call += 1;
    return { code: 0, signal: null, stdout: call === 1 ? "ext2/ext3\n" : "11.6.0\n", stderr: "" };
  });
  assert.equal(result.filesystem, "ext2-ext3");
  assert.equal(result.runner, "ubuntu-24.04");
});

test("Linux restore targets are exact and source databases never match", () => {
  assert.equal(isLinuxRestoreDatabase("ia4tube_social_disposable_restore_0003_012345abcdef"), true);
  assert.equal(isLinuxRestoreDatabase("ia4tube_social_disposable_restore_0004_012345abcdef"), true);
  assert.equal(isLinuxRestoreDatabase("ia4tube_social_disposable_rollback_0003_012345abcdef"), true);
  assert.equal(isLinuxRestoreDatabase("ia4tube_social_disposable_tamper_012345abcdef"), true);
  assert.equal(isLinuxRestoreDatabase("ia4tube_social_disposable_cross_012345abcdef"), true);
  assert.equal(isLinuxRestoreDatabase("ia4tube_social_disposable_source_0003_012345abcdef"), false);
  assert.equal(isLinuxRestoreDatabase("ia4tube_social_disposable_rollback_source_012345abcdef"), false);
  assert.equal(isLinuxRestoreDatabase("ia4tube_social_local"), false);
  assert.equal(isLinuxRestoreDatabase("ia4tube_social_disposable_restore_0003_012345abcdeg"), false);
});

test("restore target preparation removes only the three application schemas under temporary owner role", async () => {
  const database = "ia4tube_social_disposable_restore_0003_012345abcdef";
  const events = [];
  let clusterReads = 0;
  let inventoryReads = 0;
  const query = async (text) => {
    const normalized = String(text);
    if (normalized === "BEGIN" || normalized === "COMMIT" || normalized === "ROLLBACK") {
      events.push(normalized);
      return { rows: [] };
    }
    if (normalized.includes("current_database()=$1")) {
      events.push("identity");
      return { rows: [{ database_exact: true, login_exact: true, owner_exact: true }] };
    }
    if (normalized.includes("cluster_snapshot")) {
      clusterReads += 1;
      events.push(`cluster${clusterReads}`);
      return { rows: [{ role_count: 6, cluster_snapshot: "canonical-cluster-snapshot" }] };
    }
    if (normalized.includes("unexpected_schema_count")) {
      inventoryReads += 1;
      events.push(`inventory${inventoryReads}`);
      return { rows: [inventoryReads === 1 ? {
        application_schema_count: 1,
        application_relation_count: 1,
        environment_identity_count: 1,
        unexpected_schema_count: 0,
        unexpected_relation_count: 0,
        unexpected_routine_count: 0,
        unexpected_type_count: 0
      } : {
        application_schema_count: 0,
        application_relation_count: 0,
        environment_identity_count: 0,
        unexpected_schema_count: 0,
        unexpected_relation_count: 0,
        unexpected_routine_count: 0,
        unexpected_type_count: 0
      }] };
    }
    if (normalized.startsWith("GRANT ia4tube_social_owner")) events.push("grant-owner");
    else if (normalized === "SET LOCAL ROLE ia4tube_social_owner") events.push("set-owner");
    else if (normalized.startsWith("DROP SCHEMA")) events.push(normalized);
    else if (normalized === "RESET ROLE") events.push("reset-owner");
    else if (normalized.startsWith("REVOKE ia4tube_social_owner")) events.push("revoke-owner");
    else assert.fail(`unexpected query category: ${normalized.slice(0, 40)}`);
    return { rows: [] };
  };
  assert.equal(await prepareLinuxRestoreTarget({ database, query }), true);
  assert.deepEqual(events, [
    "BEGIN",
    "identity",
    "cluster1",
    "inventory1",
    "grant-owner",
    "set-owner",
    'DROP SCHEMA IF EXISTS "ia4tube_social" CASCADE',
    'DROP SCHEMA IF EXISTS "ia4tube_social_admin" CASCADE',
    'DROP SCHEMA IF EXISTS "ia4tube_migrations" CASCADE',
    "reset-owner",
    "revoke-owner",
    "cluster2",
    "inventory2",
    "COMMIT"
  ]);
  assert.equal(events.filter((event) => event === "grant-owner").length, 1);
  assert.equal(events.filter((event) => event === "revoke-owner").length, 1);
  assert.ok(events.indexOf("cluster2") > events.indexOf("revoke-owner"));
  assert.equal(events.filter((event) => String(event).startsWith("DROP SCHEMA")).length, 3);
  assert.equal(events.includes("ROLLBACK"), false);
});

test("restore target preparation detects a residual owner membership and rolls back", async () => {
  let clusterReads = 0;
  const events = [];
  const query = async (text) => {
    const normalized = String(text);
    events.push(normalized);
    if (normalized.includes("current_database()=$1")) {
      return { rows: [{ database_exact: true, login_exact: true, owner_exact: true }] };
    }
    if (normalized.includes("cluster_snapshot")) {
      clusterReads += 1;
      return { rows: [{
        role_count: 6,
        cluster_snapshot: clusterReads === 1 ? "canonical" : "residual-owner-membership"
      }] };
    }
    if (normalized.includes("unexpected_schema_count")) {
      return { rows: [{
        application_schema_count: clusterReads === 1 ? 1 : 0,
        application_relation_count: clusterReads === 1 ? 1 : 0,
        environment_identity_count: clusterReads === 1 ? 1 : 0,
        unexpected_schema_count: 0,
        unexpected_relation_count: 0,
        unexpected_routine_count: 0,
        unexpected_type_count: 0
      }] };
    }
    return { rows: [] };
  };
  await assert.rejects(
    prepareLinuxRestoreTarget({
      database: "ia4tube_social_disposable_restore_0003_012345abcdef",
      query
    }),
    { code: "linux_gate_restore_cluster_identity_changed" }
  );
  assert.equal(events.filter((text) => text.startsWith("REVOKE ia4tube_social_owner")).length, 1);
  assert.equal(events.at(-1), "ROLLBACK");
});

test("restore target preparation refuses unexpected objects before role grant or drop", async () => {
  const events = [];
  const query = async (text) => {
    const normalized = String(text);
    events.push(normalized);
    if (normalized.includes("current_database()=$1")) {
      return { rows: [{ database_exact: true, login_exact: true, owner_exact: true }] };
    }
    if (normalized.includes("cluster_snapshot")) {
      return { rows: [{ role_count: 6, cluster_snapshot: "canonical" }] };
    }
    if (normalized.includes("unexpected_schema_count")) {
      return { rows: [{
        application_schema_count: 1,
        application_relation_count: 1,
        environment_identity_count: 1,
        unexpected_schema_count: 0,
        unexpected_relation_count: 1,
        unexpected_routine_count: 0,
        unexpected_type_count: 0
      }] };
    }
    return { rows: [] };
  };
  await assert.rejects(
    prepareLinuxRestoreTarget({
      database: "ia4tube_social_disposable_restore_0003_012345abcdef",
      query
    }),
    { code: "linux_gate_restore_target_unexpected_objects" }
  );
  assert.equal(events.some((text) => text.startsWith("GRANT ia4tube_social_owner")), false);
  assert.equal(events.some((text) => text.startsWith("DROP SCHEMA")), false);
  assert.equal(events.at(-1), "ROLLBACK");
});

test("restore target rollback failure never overwrites the primary query failure", async () => {
  const primary = Object.assign(new Error("not persisted"), {
    code: "synthetic_restore_preparation_failure"
  });
  const rollback = Object.assign(new Error("not persisted"), {
    code: "synthetic_restore_rollback_failure"
  });
  const events = [];
  await assert.rejects(
    prepareLinuxRestoreTarget({
      database: "ia4tube_social_disposable_restore_0003_012345abcdef",
      async query(text) {
        events.push(String(text));
        if (text === "BEGIN") return { rows: [] };
        if (text === "ROLLBACK") throw rollback;
        throw primary;
      }
    }),
    (error) => error === primary
  );
  assert.equal(events.length, 3);
  assert.equal(events[0], "BEGIN");
  assert.equal(events.at(-1), "ROLLBACK");
});

test("restore inventory interception runs once only for an exact disposable target", async () => {
  const inventory = [
    "SELECT 0 AS application_schema_count,",
    " 0 AS user_relation_count, 0 AS user_routine_count,",
    " 0 AS standalone_user_type_count"
  ].join("\n");
  assert.equal(isRestoreEmptyTargetInventoryQuery(inventory), true);
  const events = [];
  class BasePool {
    constructor(options) { this.options = options; }
    async connect() {
      return {
        async query(text) { events.push(["raw", text]); return { rows: [] }; },
        release() {}
      };
    }
    async end() {}
  }
  const Pool = createRoleScopedPlanPoolClass(
    BasePool,
    async () => ({ rows: [] }),
    null,
    async ({ database }) => { events.push(["prepare", database]); return true; }
  );
  const target = new Pool({
    database: "ia4tube_social_disposable_restore_0003_012345abcdef",
    user: "ia4tube_social_local_provisioner"
  });
  const targetClient = await target.connect();
  await targetClient.query(inventory);
  await targetClient.query(inventory);
  targetClient.release();
  assert.equal(events.filter(([kind]) => kind === "prepare").length, 1);
  assert.equal(events.filter(([kind]) => kind === "raw").length, 2);
  const source = new Pool({
    database: "ia4tube_social_disposable_source_0003_012345abcdef",
    user: "ia4tube_social_local_provisioner"
  });
  const sourceClient = await source.connect();
  await assert.rejects(sourceClient.query(inventory), { code: "linux_gate_restore_target_database_invalid" });
  sourceClient.release();
  await Pool.closeAll();
});

test("physical plan pools remap only the canonical logical transport before BasePool", async () => {
  const privateHost = ["10", "44", "0", "9"].join(".");
  const adaptedInputs = [];
  const constructed = [];
  const postgres = {
    get databaseHost() { return privateHost; },
    adaptLogicalPoolOptions(options) {
      adaptedInputs.push(options);
      return { ...options, host: privateHost, port: 5432 };
    }
  };
  class BasePool {
    constructor(options) {
      this.options = options;
      constructed.push(options);
    }
    async end() {}
  }
  const Pool = createRoleScopedPlanPoolClass(
    BasePool,
    async () => ({ rows: [] }),
    null,
    async () => true,
    createPrivatePlanPoolOptionsAdapter(postgres)
  );
  const logical = {
    host: "127.0.0.1",
    port: 5432,
    ssl: false,
    connectionString: undefined,
    database: "ia4tube_social_local",
    user: "ia4tube_social_local_migration",
    password: "synthetic-not-a-secret",
    max: 1
  };
  const pool = new Pool(logical);
  const verifier = new Pool({ ...logical, database: "ia4tube_social_disposable_restore_0003_012345abcdef" });
  assert.equal(logical.host, "127.0.0.1");
  assert.equal(logical.port, 5432);
  assert.equal(logical.ssl, false);
  assert.equal(adaptedInputs.length, 2);
  assert.equal(constructed.length, 2);
  for (const options of constructed) {
    assert.equal(options.host, privateHost);
    assert.equal(options.port, 5432);
    assert.equal(options.ssl, false);
    assert.equal(options.connectionString, undefined);
    assert.equal(options.max, 1);
  }
  assert.equal(pool.options.database, "ia4tube_social_local");
  assert.equal(verifier.options.database, "ia4tube_social_disposable_restore_0003_012345abcdef");
  await Pool.closeAll();
});

test("definitive login credential verification reproduces the connectionString transport incompatibility before socket or authentication", async () => {
  const database = "ia4tube_social_disposable_restore_0003_012345abcdef";
  const provisionerLogin = "ia4tube_social_local_provisioner";
  const migrationLogin = "ia4tube_social_local_migration";
  const runtimeLogin = "ia4tube_social_local_runtime";
  const provisionerPassword = "Synthetic-Provisioner-Credential-123!";
  const migrationPassword = "Synthetic-Migration-Credential-456!";
  const runtimePassword = "Synthetic-Runtime-Credential-789!";
  const target = Object.freeze({
    host: "127.0.0.1",
    port: "5432",
    database,
    provisionerLogin,
    migrationLogin,
    runtimeLogin
  });
  const provisionerUrl = new URL(`postgresql://127.0.0.1:5432/${database}`);
  provisionerUrl.username = provisionerLogin;
  provisionerUrl.password = provisionerPassword;
  const hidden = (value, key, secret) => {
    Object.defineProperty(value, key, {
      configurable: false,
      enumerable: false,
      writable: false,
      value: secret
    });
    return Object.freeze(value);
  };
  const configuration = Object.freeze({
    target,
    targetFingerprint: targetFingerprint(target),
    provisionerPool: Object.freeze({
      host: "127.0.0.1",
      port: 5432,
      database,
      user: provisionerLogin,
      password: provisionerPassword,
      ssl: false,
      max: 1,
      min: 0,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 5_000,
      query_timeout: 15_000,
      application_name: "ia4tube-social-3a0p-provisioner",
      options: "-c statement_timeout=10000 -c lock_timeout=5000 -c idle_in_transaction_session_timeout=5000",
      allowExitOnIdle: false,
      connectionString: provisionerUrl.toString()
    }),
    migration: hidden({
      login: migrationLogin,
      role: MIGRATOR_ROLE,
      connectionLimit: MIGRATION_CONNECTION_LIMIT
    }, "password", migrationPassword),
    runtime: hidden({
      login: runtimeLogin,
      role: RUNTIME_ROLE,
      connectionLimit: RUNTIME_CONNECTION_LIMIT
    }, "password", runtimePassword)
  });

  let basePoolConstructions = 0;
  let physicalConnectCalls = 0;
  let authenticationAttempts = 0;
  let physicalAdaptations = 0;
  class SocketAndAuthenticationSentinelPool {
    constructor(options) {
      basePoolConstructions += 1;
      this.options = options;
    }
    async connect() {
      physicalConnectCalls += 1;
      authenticationAttempts += 1;
      throw new Error("socket/authentication sentinel must remain unreachable");
    }
    async end() {}
  }
  const privateHost = ["10", "44", "0", "9"].join(".");
  const PhysicalPlanPool = createRoleScopedPlanPoolClass(
    SocketAndAuthenticationSentinelPool,
    async () => ({ rows: [] }),
    null,
    async () => true,
    createPrivatePlanPoolOptionsAdapter({
      databaseHost: privateHost,
      adaptLogicalPoolOptions(options) {
        physicalAdaptations += 1;
        return { ...options, host: privateHost, port: 5432 };
      }
    })
  );

  const migrationUrl = new URL(configuration.provisionerPool.connectionString);
  migrationUrl.username = migrationLogin;
  migrationUrl.password = migrationPassword;
  const definitiveMigrationPoolConfig = Object.freeze({
    ...configuration.provisionerPool,
    connectionString: migrationUrl.toString(),
    application_name: "ia4tube-social-migration-login-check"
  });
  assert.equal(migrationUrl.protocol, "postgresql:");
  assert.equal(migrationUrl.hostname, "127.0.0.1");
  assert.equal(migrationUrl.port, "5432");
  assert.equal(decodeURIComponent(migrationUrl.pathname.slice(1)), database);
  assert.equal(decodeURIComponent(migrationUrl.username), migrationLogin);

  assert.throws(
    () => new PhysicalPlanPool(definitiveMigrationPoolConfig),
    { code: "linux_gate_plan_pool_logical_transport_invalid" }
  );
  assert.equal(basePoolConstructions, 0);
  assert.equal(physicalAdaptations, 0);
  assert.equal(physicalConnectCalls, 0);
  assert.equal(authenticationAttempts, 0);

  await assert.rejects(
    verifyProvisionedLoginCredentials(PhysicalPlanPool, configuration),
    (error) => (
      error?.code === "login_bootstrap_credential_verification_failed" &&
      error?.cause === undefined &&
      !String(error?.message).includes(migrationPassword) &&
      !String(error?.message).includes(runtimePassword)
    )
  );
  assert.equal(basePoolConstructions, 0);
  assert.equal(physicalAdaptations, 0);
  assert.equal(physicalConnectCalls, 0);
  assert.equal(authenticationAttempts, 0);
  assert.equal(await PhysicalPlanPool.closeAll(), true);
});

test("verified login credential bridge translates both definitive verifier pools to the approved physical transport", async () => {
  const database = "ia4tube_social_disposable_restore_0003_012345abcdef";
  const provisionerLogin = "ia4tube_social_local_provisioner";
  const migrationLogin = "ia4tube_social_local_migration";
  const runtimeLogin = "ia4tube_social_local_runtime";
  const passwords = Object.freeze({
    [provisionerLogin]: "Synthetic-Provisioner-Credential-123!",
    [migrationLogin]: "Synthetic-Migration-Credential-456!",
    [runtimeLogin]: "Synthetic-Runtime-Credential-789!"
  });
  const privateHost = ["10", "44", "0", "9"].join(".");
  const constructed = [];
  const released = [];
  const ended = [];
  const roleChanges = [];
  class InstrumentedPoolSentinel {
    constructor(options) {
      this.options = options;
      constructed.push(options);
    }
    async connect() {
      const options = this.options;
      return {
        async query(text, values = []) {
          if (String(text).includes("role_not_assumed")) {
            return { rows: [{
              login_exact: values[0] === options.user,
              role_not_assumed: true,
              database_exact: values[1] === options.database,
              superuser_absent: true,
              database_create_absent: true,
              database_temp_absent: true
            }] };
          }
          if (String(text).startsWith("SET LOCAL ROLE")) {
            roleChanges.push([options.user, String(text)]);
            return { rows: [] };
          }
          if (String(text).includes("role_exact")) {
            const expectedRole = options.user === migrationLogin ? MIGRATOR_ROLE : RUNTIME_ROLE;
            return { rows: [{
              login_exact: values[0] === options.user,
              role_exact: values[1] === expectedRole
            }] };
          }
          return { rows: [] };
        },
        release() { released.push(options.user); }
      };
    }
    async end() { ended.push(this.options.user); }
  }
  const postgres = {
    InstrumentedPool: InstrumentedPoolSentinel,
    get databaseHost() { return privateHost; },
    get port() { return 5432; }
  };
  const bridge = createVerifiedLoginCredentialPoolBridge(postgres, {
    target: { host: "127.0.0.1", port: 5432 },
    database,
    provisionerLogin,
    migrationLogin,
    runtimeLogin,
    passwords
  }, { environment: {} });
  const provisionerUrl = new URL(`postgresql://127.0.0.1:5432/${database}`);
  provisionerUrl.username = provisionerLogin;
  provisionerUrl.password = passwords[provisionerLogin];
  const provisionerPool = bridge.authorizeProvisionerPool(Object.freeze({
    host: "127.0.0.1",
    port: 5432,
    database,
    user: provisionerLogin,
    password: passwords[provisionerLogin],
    ssl: false,
    max: 1,
    min: 0,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 5_000,
    query_timeout: 15_000,
    application_name: "ia4tube-social-3a0p-provisioner",
    options: "-c statement_timeout=10000 -c lock_timeout=5000 -c idle_in_transaction_session_timeout=5000",
    allowExitOnIdle: false,
    connectionString: provisionerUrl.toString()
  }));
  const target = Object.freeze({
    host: "127.0.0.1",
    port: "5432",
    database,
    provisionerLogin,
    migrationLogin,
    runtimeLogin
  });
  const hidden = (value, key, secret) => {
    Object.defineProperty(value, key, { value: secret, enumerable: false });
    return Object.freeze(value);
  };
  const configuration = Object.freeze({
    target,
    targetFingerprint: targetFingerprint(target),
    provisionerPool,
    migration: hidden({
      login: migrationLogin,
      role: MIGRATOR_ROLE,
      connectionLimit: MIGRATION_CONNECTION_LIMIT
    }, "password", passwords[migrationLogin]),
    runtime: hidden({
      login: runtimeLogin,
      role: RUNTIME_ROLE,
      connectionLimit: RUNTIME_CONNECTION_LIMIT
    }, "password", passwords[runtimeLogin])
  });

  assert.deepEqual(
    await verifyProvisionedLoginCredentials(bridge.PoolClass, configuration),
    { safe: true, verified: 2 }
  );
  assert.equal(constructed.length, 2);
  for (const options of constructed) {
    assert.equal(options.host, privateHost);
    assert.equal(options.port, 5432);
    assert.equal(options.database, database);
    assert.equal(options.ssl, false);
    assert.equal(Object.hasOwn(options, "connectionString"), false);
    assert.equal(options.user === migrationLogin || options.user === runtimeLogin, true);
    assert.equal(options.password, passwords[options.user]);
  }
  assert.deepEqual(released.sort(), [migrationLogin, runtimeLogin].sort());
  assert.deepEqual(ended.sort(), [migrationLogin, runtimeLogin].sort());
  assert.deepEqual(roleChanges.sort((left, right) => left[0].localeCompare(right[0])), [
    [migrationLogin, `SET LOCAL ROLE "${MIGRATOR_ROLE}"`],
    [runtimeLogin, `SET LOCAL ROLE "${RUNTIME_ROLE}"`]
  ].sort((left, right) => left[0].localeCompare(right[0])));
});

const LOGIN_VERIFIER_FIXTURE = Object.freeze({
  database: "ia4tube_social_disposable_restore_0003_012345abcdef",
  provisionerLogin: "ia4tube_social_local_provisioner",
  migrationLogin: "ia4tube_social_local_migration",
  runtimeLogin: "ia4tube_social_local_runtime",
  privateHost: ["10", "44", "0", "9"].join("."),
  passwords: Object.freeze({
    ia4tube_social_local_provisioner: "Synthetic-Provisioner-Credential-123!",
    ia4tube_social_local_migration: "Synthetic-Migration-Credential-456!",
    ia4tube_social_local_runtime: "Synthetic-Runtime-Credential-789!"
  })
});

function loginVerifierUrl({
  protocol = "postgresql:",
  host = "127.0.0.1",
  port = 5432,
  database = LOGIN_VERIFIER_FIXTURE.database,
  login = LOGIN_VERIFIER_FIXTURE.provisionerLogin,
  password = LOGIN_VERIFIER_FIXTURE.passwords[login],
  omitPassword = false,
  search = "",
  hash = ""
} = {}) {
  const value = new URL(`${protocol}//${host}:${port}/${database}`);
  value.username = login;
  if (!omitPassword) value.password = password;
  value.search = search;
  value.hash = hash;
  return value.toString();
}

function loginVerifierProvisionerPool(overrides = {}) {
  return Object.freeze({
    host: "127.0.0.1",
    port: 5432,
    database: LOGIN_VERIFIER_FIXTURE.database,
    user: LOGIN_VERIFIER_FIXTURE.provisionerLogin,
    password: LOGIN_VERIFIER_FIXTURE.passwords[LOGIN_VERIFIER_FIXTURE.provisionerLogin],
    ssl: false,
    max: 1,
    min: 0,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 5_000,
    query_timeout: 15_000,
    application_name: "ia4tube-social-3a0p-provisioner",
    options: "-c statement_timeout=10000 -c lock_timeout=5000 -c idle_in_transaction_session_timeout=5000",
    allowExitOnIdle: false,
    connectionString: loginVerifierUrl(),
    ...overrides
  });
}

function createLoginVerifierFixture(options = {}) {
  const constructed = [];
  const ended = [];
  let physicalHost = options.physicalHost || LOGIN_VERIFIER_FIXTURE.privateHost;
  let physicalPort = options.omitPhysicalPort
    ? undefined
    : options.physicalPort === undefined ? 5432 : options.physicalPort;
  class CapturingInstrumentedPool {
    constructor(configuration) {
      if (options.baseFailure) throw options.baseFailure;
      this.options = configuration;
      constructed.push(configuration);
    }
    async connect() {
      if (typeof options.connect === "function") return options.connect(this.options);
      return { async query() { return { rows: [] }; }, release() {} };
    }
    async end() { ended.push(this.options.user); }
  }
  const postgres = {
    InstrumentedPool: options.InstrumentedPool || CapturingInstrumentedPool,
    get databaseHost() { return physicalHost; },
    get port() { return physicalPort; }
  };
  const bridge = createVerifiedLoginCredentialPoolBridge(postgres, {
    target: { host: "127.0.0.1", port: 5432 },
    database: LOGIN_VERIFIER_FIXTURE.database,
    provisionerLogin: LOGIN_VERIFIER_FIXTURE.provisionerLogin,
    migrationLogin: LOGIN_VERIFIER_FIXTURE.migrationLogin,
    runtimeLogin: LOGIN_VERIFIER_FIXTURE.runtimeLogin,
    passwords: { ...LOGIN_VERIFIER_FIXTURE.passwords }
  }, { environment: options.environment || {} });
  const provisionerPool = options.authorize === false
    ? null
    : bridge.authorizeProvisionerPool(options.provisionerPool || loginVerifierProvisionerPool());
  return {
    bridge,
    constructed,
    ended,
    provisionerPool,
    setPhysicalHost(value) { physicalHost = value; },
    setPhysicalPort(value) { physicalPort = value; }
  };
}

function loginVerifierPoolConfiguration(fixture, overrides = {}) {
  const login = overrides.login || LOGIN_VERIFIER_FIXTURE.migrationLogin;
  const password = Object.hasOwn(overrides, "uriPassword")
    ? overrides.uriPassword
    : LOGIN_VERIFIER_FIXTURE.passwords[login];
  const connectionString = Object.hasOwn(overrides, "connectionString")
    ? overrides.connectionString
    : loginVerifierUrl({
        protocol: overrides.protocol,
        host: overrides.uriHost,
        port: overrides.uriPort,
        database: overrides.uriDatabase,
        login,
        password,
        omitPassword: overrides.omitPassword,
        search: overrides.search,
        hash: overrides.hash
      });
  const configuration = {
    ...fixture.provisionerPool,
    connectionString,
    application_name: overrides.application_name || (
      login === LOGIN_VERIFIER_FIXTURE.runtimeLogin
        ? "ia4tube-social-runtime-login-check"
        : "ia4tube-social-migration-login-check"
    )
  };
  for (const [key, value] of Object.entries(overrides.configuration || {})) {
    if (value === undefined) delete configuration[key];
    else configuration[key] = value;
  }
  return Object.freeze(configuration);
}

test("login verifier bridge accepts only exact postgres URI shapes and emits explicit BasePool options", async () => {
  for (const [protocol, login, applicationName] of [
    ["postgresql:", LOGIN_VERIFIER_FIXTURE.migrationLogin, "ia4tube-social-migration-login-check"],
    ["postgres:", LOGIN_VERIFIER_FIXTURE.runtimeLogin, "ia4tube-social-runtime-login-check"]
  ]) {
    const fixture = createLoginVerifierFixture();
    const original = fixture.provisionerPool;
    const pool = new fixture.bridge.PoolClass(loginVerifierPoolConfiguration(fixture, {
      protocol,
      login,
      application_name: applicationName
    }));
    assert.equal(fixture.constructed.length, 1);
    assert.deepEqual(Object.keys(pool.options).sort(), [
      "allowExitOnIdle", "application_name", "connectionTimeoutMillis", "database",
      "host", "idleTimeoutMillis", "max", "min", "options", "password", "port",
      "query_timeout", "ssl", "user"
    ].sort());
    assert.equal(Object.hasOwn(pool.options, "connectionString"), false);
    assert.equal(pool.options.host, LOGIN_VERIFIER_FIXTURE.privateHost);
    assert.equal(pool.options.port, 5432);
    assert.equal(pool.options.database, LOGIN_VERIFIER_FIXTURE.database);
    assert.equal(pool.options.user, login);
    assert.equal(pool.options.password, LOGIN_VERIFIER_FIXTURE.passwords[login]);
    assert.equal(pool.options.ssl, false);
    assert.equal(pool.options.max, 1);
    assert.equal(pool.options.min, 0);
    assert.equal(pool.options.connectionTimeoutMillis, 5_000);
    assert.equal(pool.options.idleTimeoutMillis, 5_000);
    assert.equal(pool.options.query_timeout, 15_000);
    assert.equal(pool.options.application_name, applicationName);
    assert.equal(Object.isFrozen(original), true);
    await pool.end();
    assert.deepEqual(fixture.ended, [login]);
  }
});

test("login verifier bridge refuses every URI, configuration and provenance drift before BasePool", () => {
  const canonicalMigrationUrl = loginVerifierUrl({
    login: LOGIN_VERIFIER_FIXTURE.migrationLogin,
    password: LOGIN_VERIFIER_FIXTURE.passwords[LOGIN_VERIFIER_FIXTURE.migrationLogin]
  });
  const cases = [
    ["logical host", { configuration: { host: "localhost" } }, "linux_gate_login_verifier_configuration_invalid"],
    ["URI loopback alias", { uriHost: "localhost" }, "linux_gate_login_verifier_uri_invalid"],
    ["URI external host", { uriHost: "database.example.invalid" }, "linux_gate_login_verifier_uri_invalid"],
    ["URI production host", { uriHost: "production.example.com" }, "linux_gate_login_verifier_uri_invalid"],
    ["logical port", { configuration: { port: 5433 } }, "linux_gate_login_verifier_configuration_invalid"],
    ["URI port", { uriPort: 5433 }, "linux_gate_login_verifier_uri_invalid"],
    ["logical database", { configuration: { database: "ia4tube_social_disposable_restore_0004_012345abcdef" } }, "linux_gate_login_verifier_configuration_invalid"],
    ["URI database", { uriDatabase: "ia4tube_social_disposable_restore_0004_012345abcdef" }, "linux_gate_login_verifier_uri_invalid"],
    ["migration URI with runtime application", {
      login: LOGIN_VERIFIER_FIXTURE.migrationLogin,
      application_name: "ia4tube-social-runtime-login-check"
    }, "linux_gate_login_verifier_configuration_invalid"],
    ["runtime URI substituted into the migration verifier entry", {
      login: LOGIN_VERIFIER_FIXTURE.runtimeLogin,
      application_name: "ia4tube-social-migration-login-check"
    }, "linux_gate_login_verifier_configuration_invalid"],
    ["unknown login", { login: "ia4tube_social_local_unknown", uriPassword: "Synthetic-Unknown-Credential-000!" }, "linux_gate_login_verifier_login_invalid"],
    ["crossed migration/runtime password", {
      login: LOGIN_VERIFIER_FIXTURE.migrationLogin,
      uriPassword: LOGIN_VERIFIER_FIXTURE.passwords[LOGIN_VERIFIER_FIXTURE.runtimeLogin]
    }, "linux_gate_login_verifier_uri_invalid"],
    ["wrong password", { uriPassword: "Synthetic-Divergent-Credential-000!" }, "linux_gate_login_verifier_uri_invalid"],
    ["missing password", { omitPassword: true }, "linux_gate_login_verifier_uri_invalid"],
    ["query", { search: "sslmode=disable" }, "linux_gate_login_verifier_uri_invalid"],
    ["fragment", { hash: "unexpected" }, "linux_gate_login_verifier_uri_invalid"],
    ["bare query delimiter", { connectionString: `${canonicalMigrationUrl}?` }, "linux_gate_login_verifier_uri_invalid"],
    ["bare fragment delimiter", { connectionString: `${canonicalMigrationUrl}#` }, "linux_gate_login_verifier_uri_invalid"],
    ["leading whitespace", { connectionString: ` ${canonicalMigrationUrl}` }, "linux_gate_login_verifier_uri_invalid"],
    ["trailing whitespace", { connectionString: `${canonicalMigrationUrl} ` }, "linux_gate_login_verifier_uri_invalid"],
    ["non-canonical port", {
      connectionString: canonicalMigrationUrl.replace(":5432/", ":05432/")
    }, "linux_gate_login_verifier_uri_invalid"],
    ["malformed URI", { connectionString: "not a postgresql uri" }, "linux_gate_login_verifier_uri_invalid"],
    ["non-PostgreSQL protocol", { protocol: "http:" }, "linux_gate_login_verifier_uri_invalid"],
    ["TLS", { configuration: { ssl: true } }, "linux_gate_login_verifier_configuration_invalid"],
    ["application name", { application_name: "ia4tube-social-unapproved-check" }, "linux_gate_login_verifier_configuration_invalid"],
    ["pool max", { configuration: { max: 2 } }, "linux_gate_login_verifier_configuration_invalid"],
    ["pool min", { configuration: { min: 1 } }, "linux_gate_login_verifier_configuration_invalid"],
    ["connect timeout", { configuration: { connectionTimeoutMillis: 5_001 } }, "linux_gate_login_verifier_configuration_invalid"],
    ["idle timeout", { configuration: { idleTimeoutMillis: 5_001 } }, "linux_gate_login_verifier_configuration_invalid"],
    ["query timeout", { configuration: { query_timeout: 15_001 } }, "linux_gate_login_verifier_configuration_invalid"],
    ["session options", { configuration: { options: "-c statement_timeout=9999" } }, "linux_gate_login_verifier_configuration_invalid"],
    ["allow exit", { configuration: { allowExitOnIdle: true } }, "linux_gate_login_verifier_configuration_invalid"],
    ["extra option", { configuration: { unexpected: true } }, "linux_gate_login_verifier_provenance_invalid"],
    ["missing connection string", { configuration: { connectionString: undefined } }, "linux_gate_login_verifier_provenance_invalid"]
  ];
  for (const [label, overrides, code] of cases) {
    const fixture = createLoginVerifierFixture();
    assert.throws(
      () => new fixture.bridge.PoolClass(loginVerifierPoolConfiguration(fixture, overrides)),
      (error) => error?.code === code && !String(error?.message).includes("Synthetic-"),
      label
    );
    assert.equal(fixture.constructed.length, 0, label);
  }
});

test("login verifier bridge refuses external provenance, ambient PostgreSQL state and unapproved physical transport", () => {
  class ContractPool {}
  const contractPostgres = {
    InstrumentedPool: ContractPool,
    databaseHost: LOGIN_VERIFIER_FIXTURE.privateHost,
    port: 5432
  };
  const exactContract = {
    target: { host: "127.0.0.1", port: 5432 },
    database: LOGIN_VERIFIER_FIXTURE.database,
    provisionerLogin: LOGIN_VERIFIER_FIXTURE.provisionerLogin,
    migrationLogin: LOGIN_VERIFIER_FIXTURE.migrationLogin,
    runtimeLogin: LOGIN_VERIFIER_FIXTURE.runtimeLogin,
    passwords: { ...LOGIN_VERIFIER_FIXTURE.passwords }
  };
  for (const contract of [
    { ...exactContract, target: { host: "database.example.invalid", port: 5432 } },
    { ...exactContract, physicalHost: ["10", "99", "0", "7"].join(".") },
    { ...exactContract, target: { ...exactContract.target, physicalHost: ["10", "99", "0", "7"].join(".") } }
  ]) {
    assert.throws(
      () => createVerifiedLoginCredentialPoolBridge(contractPostgres, contract, { environment: {} }),
      { code: "linux_gate_login_verifier_contract_invalid" }
    );
  }

  const external = createLoginVerifierFixture();
  const externalConfiguration = loginVerifierProvisionerPool({
    connectionString: loginVerifierUrl({
      login: LOGIN_VERIFIER_FIXTURE.migrationLogin,
      password: LOGIN_VERIFIER_FIXTURE.passwords[LOGIN_VERIFIER_FIXTURE.migrationLogin]
    }),
    application_name: "ia4tube-social-migration-login-check"
  });
  assert.throws(
    () => new external.bridge.PoolClass(externalConfiguration),
    { code: "linux_gate_login_verifier_provenance_invalid" }
  );
  assert.equal(external.constructed.length, 0);
  assert.throws(
    () => external.bridge.authorizeProvisionerPool(loginVerifierProvisionerPool()),
    { code: "linux_gate_login_verifier_provenance_invalid" }
  );

  for (const environment of [
    { DATABASE_URL: "postgresql://external.invalid/database" },
    { PGHOST: "127.0.0.1" },
    { PGUSER: LOGIN_VERIFIER_FIXTURE.migrationLogin },
    { PGCLIENTENCODING: "UTF8" },
    { PGPASSWORD: "Synthetic-Ambient-Credential-000!" },
    { PGSSLMODE: "disable" }
  ]) {
    assert.throws(
      () => createLoginVerifierFixture({ environment, authorize: false }),
      { code: "linux_gate_login_verifier_ambient_environment_refused" }
    );
  }
  for (const physicalHost of ["127.0.0.1", "8.8.8.8", "database.example.invalid"]) {
    assert.throws(
      () => createLoginVerifierFixture({ physicalHost, authorize: false }),
      { code: "linux_gate_login_verifier_private_transport_invalid" }
    );
  }
  assert.throws(
    () => createLoginVerifierFixture({ physicalPort: 5433, authorize: false }),
    { code: "linux_gate_login_verifier_private_transport_invalid" }
  );
  assert.throws(
    () => createLoginVerifierFixture({ omitPhysicalPort: true, authorize: false }),
    { code: "linux_gate_login_verifier_private_transport_invalid" }
  );

  const hostDrift = createLoginVerifierFixture();
  hostDrift.setPhysicalHost(["10", "44", "0", "10"].join("."));
  assert.throws(
    () => new hostDrift.bridge.PoolClass(loginVerifierPoolConfiguration(hostDrift)),
    { code: "linux_gate_login_verifier_provenance_invalid" }
  );
  assert.equal(hostDrift.constructed.length, 0);
  const portDrift = createLoginVerifierFixture();
  portDrift.setPhysicalPort(5433);
  assert.throws(
    () => new portDrift.bridge.PoolClass(loginVerifierPoolConfiguration(portDrift)),
    { code: "linux_gate_login_verifier_provenance_invalid" }
  );
  assert.equal(portDrift.constructed.length, 0);
});

test("login verifier bridge preserves caller input and sanitizes BasePool failures without logs or secrets", async () => {
  const original = loginVerifierProvisionerPool();
  const originalKeys = Reflect.ownKeys(original);
  const originalUrl = original.connectionString;
  const fixture = createLoginVerifierFixture({ provisionerPool: original });
  assert.notStrictEqual(fixture.provisionerPool, original);
  assert.deepEqual(Reflect.ownKeys(original), originalKeys);
  assert.equal(original.connectionString, originalUrl);
  assert.equal(Object.getOwnPropertySymbols(original).length, 0);

  const secret = LOGIN_VERIFIER_FIXTURE.passwords[LOGIN_VERIFIER_FIXTURE.migrationLogin];
  const driverFailure = new Error(`driver refused ${secret} at postgresql://sensitive.invalid/database`);
  const logs = [];
  const originalConsole = { error: console.error, log: console.log, warn: console.warn };
  console.error = (...values) => logs.push(values);
  console.log = (...values) => logs.push(values);
  console.warn = (...values) => logs.push(values);
  try {
    const failing = createLoginVerifierFixture({ baseFailure: driverFailure });
    const target = Object.freeze({
      host: "127.0.0.1",
      port: "5432",
      database: LOGIN_VERIFIER_FIXTURE.database,
      provisionerLogin: LOGIN_VERIFIER_FIXTURE.provisionerLogin,
      migrationLogin: LOGIN_VERIFIER_FIXTURE.migrationLogin,
      runtimeLogin: LOGIN_VERIFIER_FIXTURE.runtimeLogin
    });
    const hidden = (value, password) => {
      Object.defineProperty(value, "password", { value: password, enumerable: false });
      return Object.freeze(value);
    };
    const configuration = Object.freeze({
      target,
      targetFingerprint: targetFingerprint(target),
      provisionerPool: failing.provisionerPool,
      migration: hidden({
        login: LOGIN_VERIFIER_FIXTURE.migrationLogin,
        role: MIGRATOR_ROLE,
        connectionLimit: MIGRATION_CONNECTION_LIMIT
      }, secret),
      runtime: hidden({
        login: LOGIN_VERIFIER_FIXTURE.runtimeLogin,
        role: RUNTIME_ROLE,
        connectionLimit: RUNTIME_CONNECTION_LIMIT
      }, LOGIN_VERIFIER_FIXTURE.passwords[LOGIN_VERIFIER_FIXTURE.runtimeLogin])
    });
    await assert.rejects(
      verifyProvisionedLoginCredentials(failing.bridge.PoolClass, configuration),
      (error) => (
        error?.code === "login_bootstrap_credential_verification_failed" &&
        error?.cause === undefined &&
        !String(error?.message).includes(secret) &&
        !String(error?.stack).includes(secret) &&
        !JSON.stringify(error).includes(secret)
      )
    );
    assert.equal(failing.constructed.length, 0);
    assert.equal(JSON.stringify(logs).includes(secret), false);
    assert.deepEqual(logs, []);
  } finally {
    console.error = originalConsole.error;
    console.log = originalConsole.log;
    console.warn = originalConsole.warn;
  }
});

test("login verifier bridge keeps InstrumentedPool metrics race-free, closes both pools and leaves the registry fail-closed", async () => {
  const registry = createPoolMetricsRegistry();
  const trackedPools = new Set();
  const pools = [];
  const roleChanges = [];
  class SimulatedPool extends EventEmitter {
    constructor(configuration) {
      super();
      this.options = configuration;
      this.totalCount = 0;
      this.idleCount = 0;
      this.waitingCount = 0;
      pools.push(this);
    }
    async connect() {
      this.totalCount = 1;
      const pool = this;
      const client = {
        async query(text, values = []) {
          const sql = String(text);
          if (sql.includes("role_not_assumed")) {
            return { rows: [{
              login_exact: values[0] === pool.options.user,
              role_not_assumed: true,
              database_exact: values[1] === pool.options.database,
              superuser_absent: true,
              database_create_absent: true,
              database_temp_absent: true
            }] };
          }
          if (sql.startsWith("SET LOCAL ROLE")) {
            const expected = pool.options.user === LOGIN_VERIFIER_FIXTURE.migrationLogin
              ? MIGRATOR_ROLE
              : RUNTIME_ROLE;
            assert.equal(sql, `SET LOCAL ROLE "${expected}"`);
            roleChanges.push([pool.options.user, expected]);
            return { rows: [] };
          }
          if (sql.includes("role_exact")) {
            const expected = pool.options.user === LOGIN_VERIFIER_FIXTURE.migrationLogin
              ? MIGRATOR_ROLE
              : RUNTIME_ROLE;
            return { rows: [{
              login_exact: values[0] === pool.options.user,
              role_exact: values[1] === expected
            }] };
          }
          return { rows: [] };
        },
        release() {
          pool.totalCount = 0;
          pool.emit("release", undefined, client);
          pool.emit("remove", client);
        }
      };
      this.emit("connect", client);
      this.emit("acquire", client);
      return client;
    }
    async end() {
      assert.equal(this.totalCount, 0);
    }
  }
  const InstrumentedPool = instrumentedPoolClass(SimulatedPool, registry, trackedPools);
  const fixture = createLoginVerifierFixture({ InstrumentedPool });
  const target = Object.freeze({
    host: "127.0.0.1",
    port: "5432",
    database: LOGIN_VERIFIER_FIXTURE.database,
    provisionerLogin: LOGIN_VERIFIER_FIXTURE.provisionerLogin,
    migrationLogin: LOGIN_VERIFIER_FIXTURE.migrationLogin,
    runtimeLogin: LOGIN_VERIFIER_FIXTURE.runtimeLogin
  });
  const hidden = (value, password) => {
    Object.defineProperty(value, "password", { value: password, enumerable: false });
    return Object.freeze(value);
  };
  const configuration = Object.freeze({
    target,
    targetFingerprint: targetFingerprint(target),
    provisionerPool: fixture.provisionerPool,
    migration: hidden({
      login: LOGIN_VERIFIER_FIXTURE.migrationLogin,
      role: MIGRATOR_ROLE,
      connectionLimit: MIGRATION_CONNECTION_LIMIT
    }, LOGIN_VERIFIER_FIXTURE.passwords[LOGIN_VERIFIER_FIXTURE.migrationLogin]),
    runtime: hidden({
      login: LOGIN_VERIFIER_FIXTURE.runtimeLogin,
      role: RUNTIME_ROLE,
      connectionLimit: RUNTIME_CONNECTION_LIMIT
    }, LOGIN_VERIFIER_FIXTURE.passwords[LOGIN_VERIFIER_FIXTURE.runtimeLogin])
  });

  assert.deepEqual(
    await verifyProvisionedLoginCredentials(fixture.bridge.PoolClass, configuration),
    { safe: true, verified: 2 }
  );
  assert.equal(pools.length, 2);
  assert.equal(trackedPools.size, 0);
  assert.equal(pools.every((pool) => pool.linuxMetricsLifecycle.state === "closed"), true);
  assert.equal(pools.every((pool) => pool.listenerCount("connect") === 0), true);
  assert.equal(pools.every((pool) => pool.listenerCount("acquire") === 0), true);
  assert.equal(pools.every((pool) => pool.listenerCount("remove") === 0), true);
  assert.deepEqual(roleChanges.sort(), [
    [LOGIN_VERIFIER_FIXTURE.migrationLogin, MIGRATOR_ROLE],
    [LOGIN_VERIFIER_FIXTURE.runtimeLogin, RUNTIME_ROLE]
  ].sort());
  const metrics = registry.snapshot();
  assert.equal(metrics.counts.poolInstancesObserved, 2);
  assert.equal(metrics.counts.poolAcquisitionsGlobal, 2);
  assert.equal(metrics.counts.poolConfiguredMaxMigration, 1);
  assert.equal(metrics.counts.poolConfiguredMaxRuntime, 1);
  assert.equal(metrics.checks.poolConfiguredMaxRespected, true);
  assert.throws(
    () => registry.observe(pools[0], pools[0]),
    { code: "harness_pool_metrics_pool_unregistered" }
  );
});

test("physical plan pool adapter refuses divergent logical or physical transports before BasePool", () => {
  const privateHost = ["172", "20", "0", "7"].join(".");
  let constructed = 0;
  class BasePool {
    constructor(options) { constructed += 1; this.options = options; }
    async end() {}
  }
  const valid = {
    host: "127.0.0.1",
    port: 5432,
    ssl: false,
    database: "ia4tube_social_local",
    user: "ia4tube_social_local_migration",
    password: "synthetic-not-a-secret",
    max: 1
  };
  const makePool = (adaptLogicalPoolOptions) => createRoleScopedPlanPoolClass(
    BasePool,
    async () => ({ rows: [] }),
    null,
    async () => true,
    createPrivatePlanPoolOptionsAdapter({
      databaseHost: privateHost,
      adaptLogicalPoolOptions
    })
  );
  const validAdapter = (options) => ({ ...options, host: privateHost, port: 5432 });
  const Pool = makePool(validAdapter);
  for (const divergent of [
    { host: "localhost" },
    { host: privateHost },
    { port: 5433 },
    { port: "5432" },
    { ssl: true },
    { ssl: undefined },
    { connectionString: "postgresql://synthetic.invalid/local" }
  ]) {
    assert.throws(
      () => new Pool({ ...valid, ...divergent }),
      { code: "linux_gate_plan_pool_logical_transport_invalid" }
    );
  }
  assert.equal(constructed, 0);

  const invalidPhysicalAdapters = [
    (options) => options,
    (options) => ({ ...options, host: "127.0.0.1" }),
    (options) => ({ ...options, host: privateHost, port: 5433 }),
    (options) => ({ ...options, host: privateHost, ssl: true }),
    (options) => ({ ...options, host: privateHost, database: "different_database" }),
    (options) => ({ ...options, host: privateHost, unexpected: true }),
    (options) => {
      options.host = privateHost;
      return { ...options };
    }
  ];
  for (const adaptLogicalPoolOptions of invalidPhysicalAdapters) {
    const InvalidPool = makePool(adaptLogicalPoolOptions);
    assert.throws(
      () => new InvalidPool({ ...valid }),
      { code: "linux_gate_plan_pool_physical_transport_invalid" }
    );
  }
  assert.equal(constructed, 0);
  assert.throws(
    () => createPrivatePlanPoolOptionsAdapter({ databaseHost: privateHost }),
    { code: "linux_gate_plan_pool_transport_contract_invalid" }
  );
  assert.throws(
    () => createPrivatePlanPoolOptionsAdapter({
      databaseHost: "127.0.0.1",
      adaptLogicalPoolOptions: validAdapter
    }),
    { code: "linux_gate_plan_pool_private_host_invalid" }
  );
});

test("profile 0003 source fixture is seeded and verified with identical IDs after restore", async () => {
  const events = [];
  const databases = [];
  const tracker = createBackupRestoreProvenanceTracker({
    requireSpawnProof: false
  });
  let boundRestoreRequest;
  let uuidCall = 0;
  const uuids = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222"
  ];
  const basePlans = {
    async prepareBackupRestore(_state, preparationHooks) {
      const verifyProfile0003FixtureRestored =
        preparationHooks.installProfile0003RestoreVerification();
      const verifyRestoredProfile = async () => {
        events.push("profile-verified");
        const profile = { id: "social-schema-0003" };
        await verifyProfile0003FixtureRestored();
        return profile;
      };
      boundRestoreRequest = {
        localBinding: { database: "ia4tube_social_disposable_restore_0003_012345abcdef" },
        async runTool() { return { code: 0 }; },
        verifyRestoredProfile
      };
      tracker.bindRestore("gate5_restore_0003", boundRestoreRequest);
      Object.freeze(boundRestoreRequest);
      return {
        backup0003: { localBinding: { database: "ia4tube_social_disposable_source_0003_012345abcdef" } },
        restore0003: boundRestoreRequest
      };
    },
    async destroy() {}
  };
  const adapter = createLinuxProfile0003PlansFacade({
    plans: basePlans,
    randomUUID() { return uuids[uuidCall++]; },
    makeMigrationPool(database) {
      databases.push(database);
      return {
        async query(text) {
          if (String(text).startsWith("INSERT INTO")) events.push(String(text).split("(")[0]);
          if (String(text).includes("tenant_companies")) {
            const restored = database.includes("restore_0003");
            return { rows: [{
              companies: 1,
              users: 1,
              memberships: 1,
              tenant_companies: restored ? 2 : 1,
              tenant_users: restored ? 2 : 1,
              tenant_memberships: restored ? 2 : 1
            }] };
          }
          return { rows: [] };
        },
        async end() { events.push(`end:${database}`); }
      };
    },
    async withTransactionImpl(pool, operation, options) {
      assert.equal(options.role, "ia4tube_social_owner");
      return operation(pool);
    }
  });
  const plan = await adapter.plans.prepareBackupRestore();
  assert.equal(plan.restore0003, boundRestoreRequest);
  assert.equal(Object.isFrozen(plan.restore0003), true);
  assert.equal(events.filter((event) => String(event).startsWith("INSERT INTO")).length, 3);
  const restoreRunner = createLinuxProfileRestoreRunner({
    backupRestoreProvenance: tracker,
    localBackup: {
      async runProfileRestore(request) {
        for (let index = 0; index < 4; index += 1) {
          await request.runTool();
        }
        return request.verifyRestoredProfile();
      }
    }
  });
  assert.deepEqual(
    await restoreRunner(plan.restore0003),
    { id: "social-schema-0003" }
  );
  assert.equal(tracker.failure(), null);
  assert.deepEqual(databases, [
    "ia4tube_social_disposable_source_0003_012345abcdef",
    "ia4tube_social_disposable_restore_0003_012345abcdef"
  ]);
  const evidence = adapter.evidence();
  assert.equal(evidence.profile0003SyntheticFixtureRestored, true);
  assert.equal(evidence.profile0003FixtureRows, 3);
  assert.match(evidence.profile0003FixtureIdentitySha256, /^[0-9a-f]{64}$/);
});

test("profile 0003 migration-pool drain never overwrites the first operation failure", async () => {
  const primary = Object.assign(new Error("not persisted"), {
    code: "synthetic_profile_snapshot_failure"
  });
  const closing = Object.assign(new Error("not persisted"), {
    code: "synthetic_profile_pool_close_failure"
  });
  const basePlans = {
    async prepareBackupRestore(_state, preparationHooks) {
      const observe =
        preparationHooks.installProfile0003RestoreVerification();
      return {
        backup0003: {
          localBinding: {
            database:
              "ia4tube_social_disposable_source_0003_012345abcdef"
          }
        },
        restore0003: {
          localBinding: {
            database:
              "ia4tube_social_disposable_restore_0003_012345abcdef"
          },
          async verifyRestoredProfile() {
            await observe();
            return { id: "social-schema-0003" };
          }
        }
      };
    }
  };
  const operationAndDrain = createLinuxProfile0003PlansFacade({
    plans: basePlans,
    makeMigrationPool() {
      return {
        async query() { throw primary; },
        async end() { throw closing; }
      };
    },
    async withTransactionImpl(pool, operation) {
      return operation(pool);
    }
  });
  await assert.rejects(
    operationAndDrain.plans.prepareBackupRestore(),
    (error) => error === primary
  );

  const drainOnly = createLinuxProfile0003PlansFacade({
    plans: basePlans,
    makeMigrationPool() {
      return {
        async query(text) {
          if (String(text).includes("tenant_companies")) {
            return { rows: [{
              companies: 1,
              users: 1,
              memberships: 1,
              tenant_companies: 1,
              tenant_users: 1,
              tenant_memberships: 1
            }] };
          }
          return { rows: [] };
        },
        async end() { throw closing; }
      };
    },
    async withTransactionImpl(pool, operation) {
      return operation(pool);
    }
  });
  await assert.rejects(
    drainOnly.plans.prepareBackupRestore(),
    (error) => error === closing
  );

  let restoreDrainCalls = 0;
  const mismatchAndDrain = createLinuxProfile0003PlansFacade({
    plans: basePlans,
    makeMigrationPool(database) {
      return {
        database,
        async query(text) {
          if (String(text).includes("tenant_companies")) {
            return { rows: [{
              companies: 1,
              users: 1,
              memberships: 1,
              tenant_companies: 1,
              tenant_users: 1,
              tenant_memberships: 1
            }] };
          }
          return { rows: [] };
        },
        async end() {
          if (database.includes("restore_0003")) {
            restoreDrainCalls += 1;
            throw closing;
          }
        }
      };
    },
    async withTransactionImpl(pool, operation) {
      const snapshot = await operation(pool);
      if (!pool.database.includes("restore_0003")) return snapshot;
      return Object.freeze({
        ...snapshot,
        identitySha256: "f".repeat(64)
      });
    }
  });
  const mismatchedPlan = await mismatchAndDrain.plans.prepareBackupRestore();
  await assert.rejects(
    mismatchedPlan.restore0003.verifyRestoredProfile(),
    {
      code: "linux_gate_profile0003_fixture_mismatch",
      name: "LinuxGateFailure"
    }
  );
  assert.equal(restoreDrainCalls, 1);
});

test("physical-plan ledger reads assume only the canonical migrator role", async () => {
  const calls = [];
  class BasePool extends PgPool {
    constructor(options) { super(options); }
    connect(callback) {
      const client = new EventEmitter();
      client.query = (text, values, done) => {
        const callbackImpl = typeof values === "function" ? values : done;
        calls.push(["direct", text]);
        const result = { rows: [] };
        if (typeof callbackImpl === "function") {
          callbackImpl(null, result);
          return undefined;
        }
        return Promise.resolve(result);
      };
      client.release = (error) => { calls.push(["release", Boolean(error)]); };
      if (typeof callback === "function") {
        callback(null, client, client.release);
        return undefined;
      }
      return Promise.resolve(client);
    }
    async end() { calls.push(["end", this.options.user]); }
  }
  const ScopedPool = createRoleScopedPlanPoolClass(BasePool, async (pool, operation, options) => {
    calls.push(["role", pool.options.user, options.role]);
    return operation({ async query(text, values) {
      assert.notEqual(typeof values, "function");
      calls.push(["scoped", text]);
      return { rows: [{ version: "0001" }] };
    } });
  });
  const migration = new ScopedPool({ user: "ia4tube_social_local_migration" });
  const ledgerQuery = [
    "SELECT version, checksum_sha256 AS checksum",
    "FROM ia4tube_migrations.schema_migrations ORDER BY version"
  ].join("\n");
  assert.equal((await migration.query(ledgerQuery)).rows.length, 1);
  await migration.query("SELECT 1");
  assert.deepEqual(calls.map((entry) => entry[0]), ["role", "scoped", "direct", "release"]);
  assert.equal(calls[0][2], "ia4tube_social_migrator");
  await new Promise((resolve, reject) => migration.query("SELECT 2", (error, result) => {
    if (error) return reject(error);
    assert.deepEqual(result, { rows: [] });
    resolve();
  }));
  await new Promise((resolve, reject) => migration.query(ledgerQuery, (error, result) => {
    if (error) return reject(error);
    assert.equal(result.rows.length, 1);
    resolve();
  }));
  const runtime = new ScopedPool({ user: "ia4tube_social_local_runtime" });
  const runtimeClient = await runtime.connect();
  runtimeClient.release();
  assert.deepEqual(calls.at(-1), ["release", true]);
  await assert.rejects(
    runtime.query(ledgerQuery),
    { code: "linux_gate_ledger_login_invalid" }
  );
  for (const unsafeQuery of [
    `DELETE FROM ia4tube_migrations.schema_migrations`,
    `WITH rows AS (SELECT * FROM ia4tube_migrations.schema_migrations) SELECT * FROM rows`,
    `${ledgerQuery}; SELECT 1`
  ]) {
    await runtime.query(unsafeQuery);
  }
  assert.equal(await ScopedPool.closeAll(), true);
  assert.equal(calls.filter((entry) => entry[0] === "end").length, 2);
});

test("backup provisioner clients delegate only ledger reads to the scoped migrator", async () => {
  const events = [];
  class BasePool {
    constructor(options) { this.options = options; }
    async connect() {
      return {
        async query(text) { events.push(["provisioner", text]); return { rows: [] }; },
        release(error) { events.push(["release", Boolean(error)]); }
      };
    }
    async end() { events.push(["planEnd"]); }
  }
  const ScopedPool = createRoleScopedPlanPoolClass(
    BasePool,
    async (pool, operation, options) => {
      events.push(["role", options.role]);
      return operation({ async query(text, values) {
        assert.notEqual(typeof values, "function");
        events.push(["migration", text]);
        return { rows: [{ version: "0001" }] };
      } });
    },
    (database) => {
      events.push(["makePool", database]);
      return { async end() { events.push(["migrationEnd"]); } };
    }
  );
  const provisioner = new ScopedPool({
    database: "ia4tube_social_local_restore",
    user: "ia4tube_social_local_provisioner"
  });
  const client = await provisioner.connect();
  await client.query("SELECT current_database()");
  await client.query([
    "SELECT version, checksum_sha256 AS checksum",
    "FROM ia4tube_migrations.schema_migrations ORDER BY version"
  ].join("\n"));
  client.release();
  await ScopedPool.closeAll();
  assert.deepEqual(events.map((entry) => entry[0]), [
    "provisioner", "makePool", "role", "migration", "migrationEnd", "release", "planEnd"
  ]);
});

test("ledger migration-pool drain preserves the primary and propagates drain-only failure", async () => {
  const primary = Object.assign(new Error("not persisted"), {
    code: "synthetic_ledger_query_failure"
  });
  const closing = Object.assign(new Error("not persisted"), {
    code: "synthetic_ledger_pool_close_failure"
  });
  const ledgerQuery = [
    "SELECT version, checksum_sha256 AS checksum",
    "FROM ia4tube_migrations.schema_migrations ORDER BY version"
  ].join("\n");
  class BasePool {
    constructor(options) { this.options = options; }
    async connect() {
      return {
        async query() { return { rows: [] }; },
        release() {}
      };
    }
    async end() {}
  }
  const operationAndDrain = createRoleScopedPlanPoolClass(
    BasePool,
    async () => { throw primary; },
    () => ({ async end() { throw closing; } })
  );
  const firstPool = new operationAndDrain({
    database: "ia4tube_social_local_restore",
    user: "ia4tube_social_local_provisioner"
  });
  const firstClient = await firstPool.connect();
  await assert.rejects(
    firstClient.query(ledgerQuery),
    (error) => error === primary
  );
  firstClient.release();
  await operationAndDrain.closeAll();

  const drainOnly = createRoleScopedPlanPoolClass(
    BasePool,
    async () => ({ rows: [{ version: "0001" }] }),
    () => ({ async end() { throw closing; } })
  );
  const secondPool = new drainOnly({
    database: "ia4tube_social_local_restore",
    user: "ia4tube_social_local_provisioner"
  });
  const secondClient = await secondPool.connect();
  await assert.rejects(
    secondClient.query(ledgerQuery),
    (error) => error === closing
  );
  secondClient.release();
  await drainOnly.closeAll();
});

test("restore configs validate a future owned bundle without leaving a placeholder", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-linux-lazy-restore-"));
  const backupDirectory = path.join(root, "backups");
  fs.mkdirSync(backupDirectory);
  const bundlePath = path.join(backupDirectory, "profile-0003-012345abcdef.ia4sb");
  const events = [];
  const facade = createLinuxRestoreConfigFacade({
    backupDirectory,
    backupProduct: {
      constant: true,
      loadRestoreConfig(environment) {
        const stat = fs.lstatSync(environment.SOCIAL_RESTORE_BUNDLE);
        events.push(["load", stat.isFile(), stat.size]);
        return Object.freeze({ bundlePath: environment.SOCIAL_RESTORE_BUNDLE });
      }
    }
  });
  try {
    assert.equal(facade.constant, true);
    assert.equal(facade.loadRestoreConfig({ SOCIAL_RESTORE_BUNDLE: bundlePath }).bundlePath, bundlePath);
    assert.deepEqual(events, [["load", true, 0]]);
    assert.equal(fs.existsSync(bundlePath), false);
    fs.writeFileSync(bundlePath, "real-bundle", { flag: "wx", mode: 0o600 });
    facade.loadRestoreConfig({ SOCIAL_RESTORE_BUNDLE: bundlePath });
    assert.equal(fs.readFileSync(bundlePath, "utf8"), "real-bundle");
    assert.throws(() => facade.loadRestoreConfig({
      SOCIAL_RESTORE_BUNDLE: path.join(backupDirectory, "rollback-0003-012345abcdef.ia4sb")
    }), { code: "linux_gate_restore_bundle_placeholder_refused" });
    assert.throws(() => facade.loadRestoreConfig({
      SOCIAL_RESTORE_BUNDLE: path.join(root, "outside.ia4sb")
    }), { code: "linux_gate_restore_bundle_path_invalid" });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("restore placeholder cleanup preserves the first failure and attempts every cleanup", async (t) => {
  function fixture({ fileSystem, loadRestoreConfig }) {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "ia4tube-linux-placeholder-order-")
    );
    const backupDirectory = path.join(root, "backups");
    fs.mkdirSync(backupDirectory);
    const bundlePath = path.join(
      backupDirectory,
      "profile-0003-012345abcdef.ia4sb"
    );
    return {
      bundlePath,
      facade: createLinuxRestoreConfigFacade({
        backupDirectory,
        backupProduct: { loadRestoreConfig },
        fileSystem
      }),
      root
    };
  }
  const proxyFileSystem = (overrides) => new Proxy(fs, {
    get(target, property) {
      if (Object.hasOwn(overrides, property)) return overrides[property];
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });

  await t.test("primary plus unlink failure preserves the primary", () => {
    const primary = Object.assign(new Error("not persisted"), {
      code: "synthetic_restore_config_primary_failure"
    });
    const cleanup = Object.assign(new Error("not persisted"), {
      code: "synthetic_restore_placeholder_unlink_failure"
    });
    let unlinkCalls = 0;
    const item = fixture({
      fileSystem: proxyFileSystem({
        unlinkSync() {
          unlinkCalls += 1;
          throw cleanup;
        }
      }),
      loadRestoreConfig() { throw primary; }
    });
    try {
      assert.throws(
        () => item.facade.loadRestoreConfig({
          SOCIAL_RESTORE_BUNDLE: item.bundlePath
        }),
        (error) => error === primary
      );
      assert.equal(unlinkCalls, 1);
    } finally {
      fs.rmSync(item.root, { recursive: true, force: true });
    }
  });

  await t.test("descriptor close failure still attempts unlink and residual check", () => {
    const primary = Object.assign(new Error("not persisted"), {
      code: "synthetic_restore_placeholder_close_failure"
    });
    const cleanup = Object.assign(new Error("not persisted"), {
      code: "synthetic_restore_placeholder_reclose_failure"
    });
    const events = [];
    let closeCalls = 0;
    const item = fixture({
      fileSystem: proxyFileSystem({
        closeSync(descriptor) {
          closeCalls += 1;
          events.push(`close-${closeCalls}`);
          if (closeCalls === 1) {
            fs.closeSync(descriptor);
            throw primary;
          }
          throw cleanup;
        },
        existsSync(candidate) {
          events.push("exists");
          return fs.existsSync(candidate);
        },
        unlinkSync(candidate) {
          events.push("unlink");
          return fs.unlinkSync(candidate);
        }
      }),
      loadRestoreConfig() {
        throw new Error("loader must not run");
      }
    });
    try {
      assert.throws(
        () => item.facade.loadRestoreConfig({
          SOCIAL_RESTORE_BUNDLE: item.bundlePath
        }),
        (error) => error === primary
      );
      assert.deepEqual(events.slice(-4), [
        "close-1", "close-2", "unlink", "exists"
      ]);
      assert.equal(fs.existsSync(item.bundlePath), false);
    } finally {
      fs.rmSync(item.root, { recursive: true, force: true });
    }
  });

  await t.test("cleanup-only failure propagates the first cleanup", () => {
    const cleanup = Object.assign(new Error("not persisted"), {
      code: "synthetic_restore_placeholder_unlink_failure"
    });
    let residualChecks = 0;
    const item = fixture({
      fileSystem: proxyFileSystem({
        existsSync(candidate) {
          residualChecks += 1;
          return fs.existsSync(candidate);
        },
        unlinkSync() { throw cleanup; }
      }),
      loadRestoreConfig() { return Object.freeze({ ok: true }); }
    });
    try {
      assert.throws(
        () => item.facade.loadRestoreConfig({
          SOCIAL_RESTORE_BUNDLE: item.bundlePath
        }),
        (error) => error === cleanup
      );
      assert.equal(residualChecks >= 2, true);
    } finally {
      fs.rmSync(item.root, { recursive: true, force: true });
    }
  });
});

test("physical pool drain waits for remove after end resolves and ends only once", async () => {
  const events = [];
  const client = {};
  const pool = new EventEmitter();
  pool._clients = [client];
  let endCalls = 0;
  pool.end = async () => {
    endCalls += 1;
    events.push("end-resolved");
    pool._clients = [];
    setTimeout(() => {
      events.push("remove-emitted");
      pool.emit("remove", client);
    }, 5);
  };
  const drain = createPhysicalPoolDrainTracker(pool, { timeoutMs: 100 });
  await drain.end(() => pool.end());
  events.push("drain-complete");
  await drain.end(() => pool.end());
  assert.equal(endCalls, 1);
  assert.deepEqual(events, ["end-resolved", "remove-emitted", "drain-complete"]);
  assert.equal(pool.listenerCount("remove"), 0);
});

test("physical pool drain fails with only a sanitized code when remove never arrives", async () => {
  const client = {};
  const pool = new EventEmitter();
  pool._clients = [client];
  pool.end = async () => { pool._clients = []; };
  const drain = createPhysicalPoolDrainTracker(pool, { timeoutMs: 5 });
  await assert.rejects(
    drain.end(() => pool.end()),
    { code: "linux_gate_pool_physical_drain_timeout" }
  );
});

test("physical pool drain times out a hung end without unhandled rejection or listeners", async () => {
  const client = {};
  const pool = new EventEmitter();
  pool._clients = [client];
  pool.end = () => new Promise(() => {});
  const unhandled = [];
  const onUnhandled = (error) => { unhandled.push(error); };
  process.on("unhandledRejection", onUnhandled);
  try {
    const drain = createPhysicalPoolDrainTracker(pool, { timeoutMs: 5 });
    await assert.rejects(
      drain.end(() => pool.end()),
      { code: "linux_gate_pool_physical_drain_timeout" }
    );
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(unhandled.length, 0);
    for (const event of ["connect", "acquire", "release", "remove"]) {
      assert.equal(pool.listenerCount(event), 0);
    }
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
});

test("physical plan pools wait for delayed release removal before reopen and runTool", async () => {
  const events = [];
  let nextClient = 0;
  let endCalls = 0;
  class EarlyResolvingPool extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this._clients = [];
    }
    connect(callback) {
      const id = ++nextClient;
      const client = new EventEmitter();
      client.query = async () => ({ rows: [] });
      client.release = (error) => {
        events.push(`release-${id}`);
        this.emit("release", error, client);
        this._clients = this._clients.filter((candidate) => candidate !== client);
        setTimeout(() => {
          events.push(`remove-${id}`);
          this.emit("remove", client);
        }, 5);
      };
      this._clients.push(client);
      this.emit("connect", client);
      this.emit("acquire", client);
      events.push(`connect-${id}`);
      if (typeof callback === "function") {
        callback(null, client, client.release);
        return undefined;
      }
      return Promise.resolve(client);
    }
    async end() {
      endCalls += 1;
      events.push("base-end-resolved");
      const clients = this._clients.splice(0);
      for (const [index, client] of clients.entries()) {
        setTimeout(() => {
          events.push(`remove-end-${index + 1}`);
          this.emit("remove", client);
        }, 5);
      }
    }
  }
  const ScopedPool = createRoleScopedPlanPoolClass(EarlyResolvingPool, async () => ({ rows: [] }));
  const pool = new ScopedPool({ user: "ia4tube_social_local_migration" });

  const first = await pool.connect();
  first.release();
  const second = await pool.connect();
  assert.ok(events.indexOf("remove-1") < events.indexOf("connect-2"));
  second.release();

  const runTool = createDrainAwareRunTool(ScopedPool, async () => {
    events.push("run-tool");
    return true;
  });
  assert.equal(await runTool(), true);
  assert.ok(events.indexOf("remove-2") < events.indexOf("run-tool"));

  await pool.connect();
  await pool.end();
  events.push("scoped-end-complete");
  assert.ok(events.indexOf("base-end-resolved") < events.indexOf("remove-end-1"));
  assert.ok(events.indexOf("remove-end-1") < events.indexOf("scoped-end-complete"));
  assert.equal(endCalls, 1);
  assert.equal(await ScopedPool.closeAll(), true);
  assert.equal(endCalls, 1);
});

test("a plan pool waits for pending removals from every database before connecting", async () => {
  const events = [];
  class CrossDatabasePool extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this._clients = [];
    }
    connect(callback) {
      const label = this.options.database;
      const client = new EventEmitter();
      client.query = async () => ({ rows: [] });
      client.release = (error) => {
        events.push(`release-${label}`);
        this.emit("release", error, client);
        this._clients = this._clients.filter((candidate) => candidate !== client);
        const delay = label === "database-a" ? 5 : label === "database-b" ? 15 : 1;
        setTimeout(() => {
          events.push(`remove-${label}`);
          this.emit("remove", client);
        }, delay);
      };
      this._clients.push(client);
      this.emit("connect", client);
      this.emit("acquire", client);
      events.push(`connect-${label}`);
      if (typeof callback === "function") {
        callback(null, client, client.release);
        return undefined;
      }
      return Promise.resolve(client);
    }
    async end() {}
  }
  const ScopedPool = createRoleScopedPlanPoolClass(CrossDatabasePool, async () => ({ rows: [] }));
  const poolA = new ScopedPool({ database: "database-a", user: "ia4tube_social_local_migration" });
  const poolB = new ScopedPool({ database: "database-b", user: "ia4tube_social_local_migration" });
  const poolC = new ScopedPool({ database: "database-c", user: "ia4tube_social_local_migration" });

  const clientA = await poolA.connect();
  const clientB = await poolB.connect();
  clientA.release();
  clientB.release();
  const clientC = await poolC.connect();
  assert.ok(events.indexOf("remove-database-a") < events.indexOf("connect-database-c"));
  assert.ok(events.indexOf("remove-database-b") < events.indexOf("connect-database-c"));
  clientC.release();
  await ScopedPool.awaitPendingRemovals();
  await ScopedPool.closeAll();
});

test("backup phase retires both primary pools without double-ending them", async () => {
  const events = [];
  const migration = { async end() { events.push("migration-end"); } };
  const runtime = { async end() { events.push("runtime-end"); } };
  const state = { pools: Object.freeze({ migration, runtime }) };
  assert.equal(await retirePrimaryPoolsBeforeBackup(state), true);
  assert.equal(state.pools.migration.retired, true);
  assert.equal(state.pools.runtime.retired, true);
  await state.pools.migration.end();
  await state.pools.runtime.end();
  assert.deepEqual(events.sort(), ["migration-end", "runtime-end"]);
});

test("Gate 1 retires migration before rollback and recreates an exact max-2 pool", async () => {
  const events = [];
  let initialEnds = 0;
  let replacementEnds = 0;
  let runtimeEnds = 0;
  const initialMigration = {
    async end() {
      initialEnds += 1;
      events.push("initial-migration-end");
    }
  };
  const runtime = {
    async end() {
      runtimeEnds += 1;
      events.push("runtime-end");
    }
  };
  const replacement = {
    options: {
      user: "ia4tube_social_local_migration",
      database: "ia4tube_social_local",
      max: 2
    },
    async end() {
      replacementEnds += 1;
      events.push("replacement-migration-end");
    }
  };
  const state = { pools: Object.freeze({ migration: initialMigration, runtime }) };
  const lifecycle = createGate1MigrationPoolLifecycle({
    state,
    plans: {
      async createRollbackAdapter() {
        events.push("rollback-adapter-created");
        return {
          async captureCanonical0003() {
            events.push("rollback-capture-started");
            assert.equal(state.pools.migration.retired, true);
            assert.equal(state.pools.runtime, runtime);
            return true;
          }
        };
      }
    },
    createMigrationPool() {
      events.push("replacement-migration-created");
      return replacement;
    }
  });

  const adapter = await lifecycle.plans.createRollbackAdapter();
  assert.equal(await adapter.captureCanonical0003(), true);
  assert.deepEqual(events, [
    "rollback-adapter-created",
    "initial-migration-end",
    "rollback-capture-started"
  ]);
  assert.equal(initialEnds, 1);

  assert.equal(await lifecycle.recreateMigrationPoolForEvidence(), true);
  assert.equal(state.pools.migration, replacement);
  assert.equal(state.pools.runtime, runtime);
  assert.equal(state.pools.migration.options.max, 2);
  assert.deepEqual(events, [
    "rollback-adapter-created",
    "initial-migration-end",
    "rollback-capture-started",
    "replacement-migration-created"
  ]);

  await assert.rejects(
    lifecycle.recreateMigrationPoolForEvidence(),
    { code: "linux_gate_gate1_migration_recreation_refused" }
  );
  await assert.rejects(
    adapter.captureCanonical0003(),
    { code: "linux_gate_gate1_capture_reused" }
  );
  assert.equal(initialEnds, 1);

  assert.equal(await retirePrimaryPoolsBeforeBackup(state), true);
  await state.pools.migration.end();
  await state.pools.runtime.end();
  assert.equal(initialEnds, 1);
  assert.equal(replacementEnds, 1);
  assert.equal(runtimeEnds, 1);
  assert.deepEqual(events, [
    "rollback-adapter-created",
    "initial-migration-end",
    "rollback-capture-started",
    "replacement-migration-created",
    "replacement-migration-end",
    "runtime-end"
  ]);
});

test("Gate 1 refuses and closes a replacement outside the exact migration pool limit", async () => {
  let invalidReplacementEnds = 0;
  const runtime = { async end() {} };
  const state = {
    pools: Object.freeze({
      migration: { async end() {} },
      runtime
    })
  };
  const lifecycle = createGate1MigrationPoolLifecycle({
    state,
    plans: {
      async createRollbackAdapter() {
        return { async captureCanonical0003() { return true; } };
      }
    },
    createMigrationPool() {
      return {
        options: {
          user: "ia4tube_social_local_migration",
          database: "ia4tube_social_local",
          max: 3
        },
        async end() { invalidReplacementEnds += 1; }
      };
    }
  });

  const adapter = await lifecycle.plans.createRollbackAdapter();
  assert.equal(await adapter.captureCanonical0003(), true);
  await assert.rejects(
    lifecycle.recreateMigrationPoolForEvidence(),
    { code: "linux_gate_gate1_migration_replacement_invalid" }
  );
  assert.equal(invalidReplacementEnds, 1);
  assert.equal(state.pools.migration.retired, true);
  assert.equal(state.pools.runtime, runtime);
});

test("marker scan sees exact synthetic plaintext and never prints it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-linux-scan-"));
  const marker = `synthetic-marker-${crypto.randomBytes(24).toString("hex")}`;
  try {
    fs.writeFileSync(path.join(root, "evidence.bin"), Buffer.from(`prefix:${marker}:suffix`));
    assert.equal(containsMarkerInTree(root, [marker]).present, true);
    fs.writeFileSync(path.join(root, "evidence.bin"), "sanitized");
    const result = containsMarkerInTree(root, [marker]);
    assert.equal(result.present, false);
    assert.equal(result.filesScanned, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("migration evidence binds the physical ledger to the checked-in manifest", async () => {
  const migrations = require("../src/persistence/postgres/migrations");
  const manifest = migrations.readManifest({ root: ROOT });
  let call = 0;
  const workDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-linux-migration-evidence-"));
  const state = {
    repositoryRoot: ROOT,
    workDirectory,
    environmentId: crypto.randomUUID(),
    target: { port: 49152 },
    pools: {
      migration: {
        async query() {
          call += 1;
          if (call === 1) return { rows: manifest.map((item) => ({ version: item.version, checksum: item.sha256 })) };
          return { rows: [{ idempotency: true, publications: true, attempts: true, indexes: 17, constraints: 23, rls_missing: 0 }] };
        }
      }
    }
  };
  try {
    const result = await migrationEvidence(state, {
      migrationRunner: {
        async apply() { return []; },
        async validate() { return { valid: true, applied: 4, pending: 0 }; }
      },
      async withTransaction(pool, operation) { return operation(pool); }
    });
    assert.equal(result.applied, 4);
    assert.equal(result.requiredTablesPresent, true);
    assert.equal(result.checksumTamperRefused, true);
    assert.equal(result.idempotentReapply, true);
    assert.match(result.ledgerSha256, /^[0-9a-f]{64}$/);
    assert.match(result.migration0004Checksum, /^[0-9a-f]{64}$/);
    assert.deepEqual(fs.readdirSync(workDirectory), []);
  } finally {
    fs.rmSync(workDirectory, { recursive: true, force: true });
  }
});

test("failure diagnostics expose only canonical codes", () => {
  assert.equal(failureCode({ code: "linux_safe_failure" }), "linux_safe_failure");
  assert.equal(failureCode({ message: "path C:/Users/person password=secret" }), "linux_gate_unclassified_failure");
});

test("Linux gate source reuses product plans and has no external provider call", () => {
  const gate = fs.readFileSync(path.join(ROOT, "scripts/social-3a0p-linux-gate.js"), "utf8");
  const physical = fs.readFileSync(path.join(ROOT, "scripts/social-3a0p-linux-physical-gates.js"), "utf8");
  assert.match(gate, /social-3a0p-local-windows-physical-plans/);
  assert.match(gate, /social-3a0p-local-connector-physical-gates/);
  assert.match(gate, /requireBundleDirectoryFsync:\s*true/);
  assert.match(physical, /createPostgresConnectorStore/);
  assert.match(physical, /createPostgresOAuthRepository/);
  assert.doesNotMatch(physical, /\b(?:fetch|axios|https?\.request|tls\.connect|net\.connect)\s*\(/);
  const order = [
    'phase("migrations"',
    'activePhase = "rls_privilege_inventory_context_reproduction";',
    'activePhase = "rls_runtime_write_contract_reproduction";',
    'activePhase = "rls_runtime_attributes_text_resolution_reproduction";',
    'activePhase = "rls_roles";',
    'phase("concurrency_oauth_idempotency"',
    'phase("vault"',
    'phase("backup_restore"'
  ].map((needle) => gate.indexOf(needle));
  assert.ok(order.every((index) => index >= 0));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

function spawnedToolRunner(tracker, outcomes) {
  let call = 0;
  const trackedSpawn = tracker.wrapSpawn(() => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("spawn"));
    return child;
  });
  return async () => {
    trackedSpawn();
    await new Promise((resolve) => queueMicrotask(resolve));
    const code = outcomes[call] ?? 0;
    call += 1;
    return { code };
  };
}

function bindAndRunProvenance(tracker, kind, operation, runner, request) {
  if (kind === "backup") {
    tracker.bindBackup(operation, request);
    return tracker.runBackup(runner, request);
  }
  tracker.bindRestore(operation, request);
  return tracker.runRestore(runner, request);
}

async function failAtExternalSubstep({ kind, operation, target, count }) {
  const tracker = createBackupRestoreProvenanceTracker();
  const outcomes = Array.from({ length: count }, (_, index) =>
    index === target ? 1 : 0
  );
  const runTool = spawnedToolRunner(tracker, outcomes);
  const runner = async (request) => {
    for (let index = 0; index < count; index += 1) {
      const result = await request.runTool();
      if (result.code !== 0) {
        const error = new Error("not persisted");
        error.code = "backup_external_tool_failed";
        throw error;
      }
    }
    return { ok: true };
  };
  const request = { runTool };
  await assert.rejects(
    () => bindAndRunProvenance(
      tracker,
      kind,
      operation,
      runner,
      request
    ),
    { code: "backup_external_tool_failed" }
  );
  return tracker.failure();
}

test("backup/restore provenance identifies each of the seven external positions", async (t) => {
  const positions = [
    ["backup", "rollback_backup_0003", 3, "backup_data_snapshot"],
    ["backup", "rollback_backup_0003", 3, "backup_schema_archive"],
    ["backup", "rollback_backup_0003", 3, "backup_schema_inventory"],
    ["restore", "rollback_restore_0003", 4, "restore_schema_inventory"],
    ["restore", "rollback_restore_0003", 4, "restore_schema_apply"],
    ["restore", "rollback_restore_0003", 4, "restore_data_apply"],
    ["restore", "rollback_restore_0003", 4, "restore_evidence_capture"]
  ];
  for (const [kind, operation, count, substep] of positions) {
    await t.test(substep, async () => {
      const target = (kind === "backup"
        ? ["backup_data_snapshot", "backup_schema_archive", "backup_schema_inventory"]
        : ["restore_schema_inventory", "restore_schema_apply", "restore_data_apply", "restore_evidence_capture"]
      ).indexOf(substep);
      const failure = await failAtExternalSubstep({
        kind,
        operation,
        target,
        count
      });
      assert.deepEqual(failure, {
        operation,
        substep,
        boundary: "external_process",
        causalCode: "backup_restore_external_transport_process_nonzero",
        externalTransportProcessStarted: true,
        substepExact: true
      });
      assert.equal(Object.isFrozen(failure), true);
    });
  }
});

test("provenance distinguishes real spawn, pre-spawn refusal and instrumentation unknown", async () => {
  const preSpawn = createBackupRestoreProvenanceTracker();
  const refusal = new Error("must not be persisted");
  refusal.code = "linux_postgres_tool_transport_refused";
  const preSpawnRequest = { async runTool() { throw refusal; } };
  await assert.rejects(
    () => bindAndRunProvenance(
      preSpawn,
      "restore",
      "rollback_restore_0003",
      async (request) => request.runTool(),
      preSpawnRequest
    ),
    { code: refusal.code }
  );
  assert.deepEqual(preSpawn.failure(), {
    operation: "rollback_restore_0003",
    substep: "restore_schema_inventory",
    boundary: "pre_execution_validation",
    causalCode: refusal.code,
    externalTransportProcessStarted: false,
    substepExact: true
  });

  const unsafePreSpawn = createBackupRestoreProvenanceTracker();
  const unsafePreSpawnRequest = {
    async runTool() { throw new Error("must never reach evidence"); }
  };
  await assert.rejects(
    () => bindAndRunProvenance(
      unsafePreSpawn,
      "backup",
      "rollback_backup_0003",
      async (request) => request.runTool(),
      unsafePreSpawnRequest
    )
  );
  assert.deepEqual(unsafePreSpawn.failure(), {
    operation: "rollback_backup_0003",
    substep: "backup_data_snapshot",
    boundary: "pre_execution_validation",
    causalCode: "backup_restore_pre_execution_validation_failed",
    externalTransportProcessStarted: false,
    substepExact: true
  });

  const unknown = createBackupRestoreProvenanceTracker();
  const unknownRequest = { async runTool() { return { code: 0 }; } };
  await assert.rejects(
    () => bindAndRunProvenance(
      unknown,
      "backup",
      "rollback_backup_0003",
      async () => ({ ok: true }),
      unknownRequest
    ),
    { code: "backup_restore_provenance_sequence_invalid" }
  );
  assert.deepEqual(unknown.failure(), {
    operation: "rollback_backup_0003",
    substep: "unknown",
    boundary: "instrumentation",
    causalCode: "backup_restore_provenance_sequence_invalid",
    externalTransportProcessStarted: null,
    substepExact: false
  });
});

test("exact internal callbacks and unobservable internal intervals stay distinct", async () => {
  const callbackTracker = createBackupRestoreProvenanceTracker();
  const callbackTool = spawnedToolRunner(callbackTracker, [0, 0, 0, 0]);
  const callbackFailure = new Error("not persisted");
  callbackFailure.code = "synthetic_vault_verifier_failed";
  const callbackRequest = {
    runTool: callbackTool,
    async verifyVault() { throw callbackFailure; }
  };
  await assert.rejects(
    () => bindAndRunProvenance(
      callbackTracker,
      "restore",
      "rollback_restore_0003",
      async (request) => {
        for (let index = 0; index < 4; index += 1) await request.runTool();
        await request.verifyVault();
      },
      callbackRequest
    ),
    { code: callbackFailure.code }
  );
  assert.deepEqual(callbackTracker.failure(), {
    operation: "rollback_restore_0003",
    substep: "restore_vault",
    boundary: "internal_callback",
    causalCode: callbackFailure.code,
    externalTransportProcessStarted: false,
    substepExact: true
  });

  const intervalTracker = createBackupRestoreProvenanceTracker();
  const intervalTool = spawnedToolRunner(intervalTracker, [0, 0]);
  const intervalRequest = { runTool: intervalTool };
  await assert.rejects(
    () => bindAndRunProvenance(
      intervalTracker,
      "restore",
      "rollback_restore_0003",
      async (request) => {
        await request.runTool();
        await request.runTool();
        throw new Error("unobservable internal detail");
      },
      intervalRequest
    )
  );
  assert.deepEqual(intervalTracker.failure(), {
    operation: "rollback_restore_0003",
    substep: "restore_after_schema_apply",
    boundary: "internal_interval",
    causalCode: "backup_restore_internal_failure_unclassified",
    externalTransportProcessStarted: false,
    substepExact: false
  });
});

test("known rollback wrappers expose only a safe causal code or the substep fallback", async () => {
  for (const [cause, expected] of [
    [
      Object.assign(new Error("not persisted"), {
        code: "synthetic_original_catalog_failure"
      }),
      "synthetic_original_catalog_failure"
    ],
    [undefined, "backup_restore_internal_callback_failed"],
    [
      Object.assign(new Error("not persisted"), {
        code: "unsafe/path/with/details"
      }),
      "backup_restore_internal_callback_failed"
    ]
  ]) {
    const tracker = createBackupRestoreProvenanceTracker({
      requireSpawnProof: false
    });
    const wrapper = Object.assign(new Error("not persisted"), {
      code: "postgres_rollback_failed"
    });
    if (cause !== undefined) wrapper.cause = cause;
    const request = {
      operator: {
        async preflight() { throw wrapper; }
      }
    };
    tracker.bindBackup("rollback_backup_0003", request);
    await assert.rejects(
      tracker.runBackup(
        async (candidate) => candidate.operator.preflight(),
        request
      ),
      (error) => error === wrapper
    );
    assert.equal(tracker.failure().substep, "backup_preflight");
    assert.equal(tracker.failure().causalCode, expected);
  }
});

test("operator callbacks are exact and cleanup cannot overwrite the first failure", async () => {
  const operatorTracker = createBackupRestoreProvenanceTracker();
  const preflightFailure = new Error("not persisted");
  preflightFailure.code = "synthetic_backup_preflight_failed";
  const operatorRequest = {
    async runTool() { return { code: 0 }; },
    operator: { async preflight() { throw preflightFailure; } }
  };
  await assert.rejects(
    () => bindAndRunProvenance(
      operatorTracker,
      "backup",
      "rollback_backup_0003",
      async (request) => request.operator.preflight(),
      operatorRequest
    ),
    { code: preflightFailure.code }
  );
  assert.equal(operatorTracker.failure().substep, "backup_preflight");
  assert.equal(operatorTracker.failure().substepExact, true);

  const firstTracker = createBackupRestoreProvenanceTracker();
  const runTool = spawnedToolRunner(firstTracker, [1]);
  const cleanupFailure = new Error("not persisted");
  cleanupFailure.code = "synthetic_cleanup_failed";
  const primaryFailure = new Error("not persisted");
  const firstRequest = {
    runTool,
    operator: { async releaseLocks() { throw cleanupFailure; } }
  };
  await assert.rejects(
    () => bindAndRunProvenance(
      firstTracker,
      "backup",
      "rollback_backup_0003",
      async (request) => {
        try {
          const result = await request.runTool();
          if (result.code !== 0) throw primaryFailure;
        } finally {
          await request.operator.releaseLocks();
        }
      },
      firstRequest
    ),
    (error) => error === primaryFailure
  );
  assert.deepEqual(firstTracker.failure(), {
    operation: "rollback_backup_0003",
    substep: "backup_data_snapshot",
    boundary: "external_process",
    causalCode: "backup_restore_external_transport_process_nonzero",
    externalTransportProcessStarted: true,
    substepExact: true
  });
});

test("closing callbacks defer failure, preserve a known primary and fail closed on ambiguous order", async () => {
  const primaryTracker = createBackupRestoreProvenanceTracker({
    requireSpawnProof: false
  });
  const primary = Object.assign(new Error("not persisted"), {
    code: "synthetic_primary_internal_failure"
  });
  const release = Object.assign(new Error("not persisted"), {
    code: "synthetic_release_failure"
  });
  const primaryRequest = {
    async runTool() { return { code: 0 }; },
    operator: {
      async preflight() { throw primary; },
      async releaseLocks() { throw release; }
    }
  };
  await assert.rejects(
    () => bindAndRunProvenance(
      primaryTracker,
      "backup",
      "rollback_backup_0003",
      async (request) => {
        try {
          await request.operator.preflight();
        } finally {
          await request.operator.releaseLocks();
        }
      },
      primaryRequest
    ),
    (error) => error === primary
  );
  assert.equal(primaryTracker.failure().substep, "backup_preflight");
  assert.equal(primaryTracker.failure().causalCode, primary.code);

  const releaseOnlyTracker = createBackupRestoreProvenanceTracker();
  const releaseOnlyTool = spawnedToolRunner(releaseOnlyTracker, [0, 0, 0]);
  const releaseOnly = Object.assign(new Error("not persisted"), {
    code: "synthetic_release_only_failure"
  });
  const releaseOnlyRequest = {
    runTool: releaseOnlyTool,
    operator: { async releaseLocks() { throw releaseOnly; } }
  };
  await assert.rejects(
    () => bindAndRunProvenance(
      releaseOnlyTracker,
      "backup",
      "rollback_backup_0003",
      async (request) => {
        for (let index = 0; index < 3; index += 1) await request.runTool();
        await request.operator.releaseLocks();
      },
      releaseOnlyRequest
    ),
    { code: releaseOnly.code, name: "LinuxGateFailure" }
  );
  assert.deepEqual(releaseOnlyTracker.failure(), {
    operation: "rollback_backup_0003",
    substep: "backup_lock_release",
    boundary: "internal_callback",
    causalCode: releaseOnly.code,
    externalTransportProcessStarted: false,
    substepExact: true
  });

  const ambiguousTracker = createBackupRestoreProvenanceTracker({
    requireSpawnProof: false
  });
  const ambiguousPrimary = new Error("not persisted");
  const ambiguousRequest = {
    async runTool() { return { code: 0 }; },
    operator: { async releaseLocks() { throw release; } }
  };
  await assert.rejects(
    () => bindAndRunProvenance(
      ambiguousTracker,
      "backup",
      "rollback_backup_0003",
      async (request) => {
        try {
          throw ambiguousPrimary;
        } finally {
          await request.operator.releaseLocks();
        }
      },
      ambiguousRequest
    ),
    (error) => error === ambiguousPrimary
  );
  assert.deepEqual(ambiguousTracker.failure(), {
    operation: "rollback_backup_0003",
    substep: "unknown",
    boundary: "instrumentation",
    causalCode: "backup_restore_provenance_closing_order_ambiguous",
    externalTransportProcessStarted: null,
    substepExact: false
  });

  const closeTracker = createBackupRestoreProvenanceTracker();
  const closeTool = spawnedToolRunner(closeTracker, [0, 0, 0, 0]);
  const closeFailure = Object.assign(new Error("not persisted"), {
    code: "synthetic_verifier_close_failure"
  });
  const closeRequest = {
    runTool: closeTool,
    async closeVerifiers() { throw closeFailure; }
  };
  await assert.rejects(
    () => bindAndRunProvenance(
      closeTracker,
      "restore",
      "rollback_restore_0003",
      async (request) => {
        for (let index = 0; index < 4; index += 1) await request.runTool();
        await request.closeVerifiers();
      },
      closeRequest
    ),
    { code: closeFailure.code, name: "LinuxGateFailure" }
  );
  assert.equal(closeTracker.failure().substep, "restore_verifier_cleanup");
  assert.equal(closeTracker.failure().causalCode, closeFailure.code);
});

test("WeakMap provenance router refuses unbound, crossed and reused requests", async () => {
  const forged = createBackupRestoreProvenanceTracker();
  await assert.rejects(
    () => forged.runBackup(async () => true, {
      operation: "rollback_backup_0003"
    }),
    { code: "backup_restore_provenance_operation_invalid" }
  );
  assert.equal(forged.failure().operation, "unknown");

  const crossed = createBackupRestoreProvenanceTracker();
  const crossedRequest = {};
  crossed.bindRestore("rollback_restore_0003", crossedRequest);
  await assert.rejects(
    () => crossed.runBackup(async () => true, crossedRequest),
    { code: "backup_restore_provenance_operation_invalid" }
  );
  assert.equal(crossed.failure().operation, "rollback_restore_0003");

  const reused = createBackupRestoreProvenanceTracker();
  const reusedRequest = {
    runTool: spawnedToolRunner(reused, [0, 0, 0])
  };
  reused.bindBackup("gate5_backup_0003", reusedRequest);
  const runner = async (request) => {
    for (let index = 0; index < 3; index += 1) await request.runTool();
    return true;
  };
  assert.equal(await reused.runBackup(runner, reusedRequest), true);
  await assert.rejects(
    () => reused.runBackup(runner, reusedRequest),
    { code: "backup_restore_provenance_operation_invalid" }
  );
  assert.deepEqual(reused.failure(), {
    operation: "gate5_backup_0003",
    substep: "unknown",
    boundary: "instrumentation",
    causalCode: "backup_restore_provenance_operation_invalid",
    externalTransportProcessStarted: null,
    substepExact: false
  });
});

test("all six normal operations are accepted while tamper/cross stay outside provenance", async () => {
  for (const [kind, operation, count] of [
    ["backup", "rollback_backup_0003", 3],
    ["backup", "gate5_backup_0003", 3],
    ["backup", "gate5_backup_0004", 3],
    ["restore", "rollback_restore_0003", 4],
    ["restore", "gate5_restore_0003", 4],
    ["restore", "gate5_restore_0004", 4]
  ]) {
    const tracker = createBackupRestoreProvenanceTracker();
    const runTool = spawnedToolRunner(tracker, Array(count).fill(0));
    const runner = async (request) => {
      for (let index = 0; index < count; index += 1) await request.runTool();
      return true;
    };
    const request = { runTool };
    assert.equal(
      await bindAndRunProvenance(
        tracker,
        kind,
        operation,
        runner,
        request
      ),
      true
    );
    assert.equal(tracker.failure(), null);
  }
  const refused = createBackupRestoreProvenanceTracker();
  const refusedRequest = { async runTool() { return { code: 0 }; } };
  assert.throws(
    () => refused.bindRestore(
      "tamper_restore_0003",
      refusedRequest
    ),
    { code: "backup_restore_provenance_binding_invalid" }
  );
  assert.equal(refused.failure().operation, "unknown");
  assert.equal(refused.failure().boundary, "instrumentation");
});

test("provenance evidence and sanitized fallback have an exact secret-free schema", () => {
  const provenance = {
    operation: "rollback_restore_0003",
    substep: "restore_data_apply",
    boundary: "external_process",
    causalCode: "backup_restore_external_transport_process_nonzero",
    externalTransportProcessStarted: true,
    substepExact: true
  };
  const closed = sanitizedBackupRestoreFailureProvenance(provenance);
  assert.deepEqual(Object.keys(closed).sort(), [
    "boundary",
    "causalCode",
    "externalTransportProcessStarted",
    "operation",
    "substep",
    "substepExact"
  ]);
  const preserved = sanitizedFailureEvidence({
    firstFailure: { phase: "migrations", code: "backup_external_tool_failed" },
    backupRestoreFailureProvenance: provenance,
    cleanup: {
      cleanupCompleted: true,
      containerResiduals: 0,
      volumeResiduals: 0,
      networkResiduals: 0,
      listenerResiduals: 0,
      temporaryRootResiduals: 0
    }
  });
  assert.deepEqual(preserved.backupRestoreFailureProvenance, provenance);
  const fallback = sanitizedFailureEvidence({
    firstFailure: { phase: "migrations", code: "backup_external_tool_failed" },
    backupRestoreFailureProvenance: {
      ...provenance,
      rawOutput: "forbidden"
    },
    cleanup: {
      cleanupCompleted: true,
      containerResiduals: 0,
      volumeResiduals: 0,
      networkResiduals: 0,
      listenerResiduals: 0,
      temporaryRootResiduals: 0
    }
  });
  assert.deepEqual(fallback.backupRestoreFailureProvenance, {
    operation: "unknown",
    substep: "unknown",
    boundary: "instrumentation",
    causalCode: "backup_restore_provenance_invalid",
    externalTransportProcessStarted: null,
    substepExact: false
  });
  const serialized = canonicalJson(fallback);
  for (const forbidden of [
    "rawOutput", "stdout", "stderr", "password", "postgresql://",
    "--dbname", "SELECT ", "C:\\", "/tmp/"
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
  assert.equal(evidenceSafe(fallback), true);
});

test("provenance sanitizer rejects crossed kinds and unproved external transport", () => {
  const invalid = {
    operation: "unknown",
    substep: "unknown",
    boundary: "instrumentation",
    causalCode: "backup_restore_provenance_invalid",
    externalTransportProcessStarted: null,
    substepExact: false
  };
  const candidates = [
    {
      operation: "rollback_backup_0003",
      substep: "restore_schema_apply",
      boundary: "external_process",
      causalCode: "backup_restore_external_transport_process_failed",
      externalTransportProcessStarted: true,
      substepExact: true
    },
    {
      operation: "rollback_restore_0003",
      substep: "backup_schema_archive",
      boundary: "external_process",
      causalCode: "backup_restore_external_transport_process_failed",
      externalTransportProcessStarted: true,
      substepExact: true
    },
    {
      operation: "unknown",
      substep: "restore_schema_inventory",
      boundary: "external_process",
      causalCode: "backup_restore_external_transport_process_failed",
      externalTransportProcessStarted: true,
      substepExact: true
    },
    {
      operation: "gate5_restore_0004",
      substep: "restore_data_apply",
      boundary: "external_process",
      causalCode: "backup_restore_external_transport_process_failed",
      externalTransportProcessStarted: null,
      substepExact: true
    }
  ];
  for (const candidate of candidates) {
    assert.deepEqual(
      sanitizedBackupRestoreFailureProvenance(candidate),
      invalid
    );
  }
});

test("Linux profile backup composes the provenance runner with directory fsync", async () => {
  let productCalls = 0;
  let provenanceCalls = 0;
  let fsyncRecords = 0;
  const product = {
    async runLogicalBackup() {
      productCalls += 1;
      return { bundleDirectoryFsyncConfirmed: true };
    }
  };
  const localBackup = {
    async runProfileBackup(request) {
      return request.dependencies.runLogicalBackup({ synthetic: true });
    }
  };
  const runner = createLinuxProfileBackupRunner({
    localBackup,
    backupProduct: product,
    recordDirectoryFsync() { fsyncRecords += 1; }
  });
  const result = await runner({
    dependencies: {
      async runLogicalBackup(request) {
        provenanceCalls += 1;
        assert.equal(request.requireBundleDirectoryFsync, true);
        return { bundleDirectoryFsyncConfirmed: true };
      }
    }
  });
  assert.equal(result.bundleDirectoryFsyncConfirmed, true);
  assert.equal(provenanceCalls, 1);
  assert.equal(productCalls, 0);
  assert.equal(fsyncRecords, 1);
});

test("Linux Gate 5 outer runners keep backup, restore and closing failures inside provenance", async (t) => {
  await t.test("backup directory fsync refusal remains in the outer backup interval", async () => {
    const tracker = createBackupRestoreProvenanceTracker({
      requireSpawnProof: false
    });
    let localCalls = 0;
    const runner = createLinuxProfileBackupRunner({
      localBackup: {
        async runProfileBackup(request) {
          localCalls += 1;
          for (let index = 0; index < 3; index += 1) {
            await request.runTool();
          }
          return request.dependencies.runLogicalBackup({ synthetic: true });
        }
      },
      backupProduct: {
        async runLogicalBackup() {
          throw new Error("product fallback must not run");
        }
      },
      backupRestoreProvenance: tracker,
      recordDirectoryFsync() {
        throw new Error("fsync must not be recorded");
      }
    });
    const request = {
      async runTool() { return { code: 0 }; },
      dependencies: {
        async runLogicalBackup() {
          return { bundleDirectoryFsyncConfirmed: false };
        }
      }
    };
    tracker.bindBackup("gate5_backup_0003", request);
    Object.freeze(request);
    await assert.rejects(
      runner(request),
      { code: "linux_gate_bundle_directory_fsync_unconfirmed" }
    );
    assert.equal(localCalls, 1);
    assert.deepEqual(tracker.failure(), {
      operation: "gate5_backup_0003",
      substep: "backup_after_schema_inventory",
      boundary: "internal_interval",
      causalCode: "backup_restore_internal_failure_unclassified",
      externalTransportProcessStarted: false,
      substepExact: false
    });
  });

  await t.test("restore profile validation wins over verifier closing", async () => {
    const tracker = createBackupRestoreProvenanceTracker({
      requireSpawnProof: false
    });
    const primary = Object.assign(new Error("not persisted"), {
      code: "synthetic_restored_profile_failure"
    });
    const closing = Object.assign(new Error("not persisted"), {
      code: "synthetic_restore_closing_failure"
    });
    const runner = createLinuxProfileRestoreRunner({
      backupRestoreProvenance: tracker,
      localBackup: {
        async runProfileRestore(request) {
          for (let index = 0; index < 4; index += 1) {
            await request.runTool();
          }
          try {
            await request.verifyRestoredProfile();
          } finally {
            await request.closeVerifiers();
          }
        }
      }
    });
    const request = {
      async runTool() { return { code: 0 }; },
      async verifyRestoredProfile() { throw primary; },
      async closeVerifiers() { throw closing; }
    };
    tracker.bindRestore("gate5_restore_0003", request);
    Object.freeze(request);
    await assert.rejects(runner(request), (error) => error === primary);
    assert.deepEqual(tracker.failure(), {
      operation: "gate5_restore_0003",
      substep: "restore_profile_validation",
      boundary: "internal_callback",
      causalCode: primary.code,
      externalTransportProcessStarted: false,
      substepExact: true
    });
  });

  await t.test("restore closing-only failure is exact", async () => {
    const tracker = createBackupRestoreProvenanceTracker({
      requireSpawnProof: false
    });
    const closing = Object.assign(new Error("not persisted"), {
      code: "synthetic_restore_closing_only_failure"
    });
    const runner = createLinuxProfileRestoreRunner({
      backupRestoreProvenance: tracker,
      localBackup: {
        async runProfileRestore(request) {
          for (let index = 0; index < 4; index += 1) {
            await request.runTool();
          }
          await request.closeVerifiers();
          return true;
        }
      }
    });
    const request = {
      async runTool() { return { code: 0 }; },
      async closeVerifiers() { throw closing; }
    };
    tracker.bindRestore("gate5_restore_0004", request);
    Object.freeze(request);
    await assert.rejects(runner(request), {
      code: closing.code,
      name: "LinuxGateFailure"
    });
    assert.deepEqual(tracker.failure(), {
      operation: "gate5_restore_0004",
      substep: "restore_verifier_cleanup",
      boundary: "internal_callback",
      causalCode: closing.code,
      externalTransportProcessStarted: false,
      substepExact: true
    });
  });

  await t.test("unobserved primary plus closing failure is ambiguous", async () => {
    const tracker = createBackupRestoreProvenanceTracker({
      requireSpawnProof: false
    });
    const primary = new Error("not persisted");
    const closing = Object.assign(new Error("not persisted"), {
      code: "synthetic_restore_closing_failure"
    });
    const runner = createLinuxProfileRestoreRunner({
      backupRestoreProvenance: tracker,
      localBackup: {
        async runProfileRestore(request) {
          for (let index = 0; index < 4; index += 1) {
            await request.runTool();
          }
          try {
            throw primary;
          } finally {
            await request.closeVerifiers();
          }
        }
      }
    });
    const request = {
      async runTool() { return { code: 0 }; },
      async closeVerifiers() { throw closing; }
    };
    tracker.bindRestore("gate5_restore_0004", request);
    Object.freeze(request);
    await assert.rejects(runner(request), (error) => error === primary);
    assert.deepEqual(tracker.failure(), {
      operation: "gate5_restore_0004",
      substep: "unknown",
      boundary: "instrumentation",
      causalCode: "backup_restore_provenance_closing_order_ambiguous",
      externalTransportProcessStarted: null,
      substepExact: false
    });
  });

  await t.test("unbound Gate 5 request is refused before the local runner", async () => {
    const tracker = createBackupRestoreProvenanceTracker({
      requireSpawnProof: false
    });
    let localCalls = 0;
    const runner = createLinuxProfileBackupRunner({
      backupRestoreProvenance: tracker,
      localBackup: {
        async runProfileBackup() {
          localCalls += 1;
          return true;
        }
      },
      backupProduct: { async runLogicalBackup() { return true; } },
      recordDirectoryFsync() {}
    });
    const request = Object.freeze({
      async runTool() { return { code: 0 }; }
    });
    await assert.rejects(
      runner(request),
      { code: "backup_restore_provenance_operation_invalid" }
    );
    assert.equal(localCalls, 0);
    assert.deepEqual(tracker.failure(), {
      operation: "unknown",
      substep: "unknown",
      boundary: "instrumentation",
      causalCode: "backup_restore_provenance_operation_invalid",
      externalTransportProcessStarted: null,
      substepExact: false
    });
  });
});
