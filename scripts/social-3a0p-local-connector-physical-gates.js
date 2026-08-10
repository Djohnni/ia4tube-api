"use strict";

// Concrete physical gates used by the Windows adapter bundle. Dependencies are
// injectable only so the harness can be tested without opening PostgreSQL.
const crypto = require("node:crypto");
const path = require("node:path");
const LOCAL_PHYSICAL_APPROVAL = "RUN_SOCIAL_3A0P_LOCAL_BACKUP_RESTORE";

const LOOPBACK_HOST = "127.0.0.1";
const OWNER_ROLE = "ia4tube_social_owner";
const RUNTIME_ROLE = "ia4tube_social_runtime";
const MIGRATOR_ROLE = "ia4tube_social_migrator";
const MIGRATION_LOGIN = "ia4tube_social_local_migration";
const LOCAL_DATABASE = "ia4tube_social_local";
const IDENTITY_VERSION = "social-id-v1";
const RUN_MARKER_PATTERN = /^ia4tube-social-3a0p-[a-z0-9-]{8,64}$/;

class ConnectorPhysicalGateFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
    this.name = "ConnectorPhysicalGateFailure";
  }
}

function fail(code) {
  throw new ConnectorPhysicalGateFailure(code);
}

function requireState(state) {
  if (
    !state ||
    state.target?.host !== LOOPBACK_HOST ||
    state.target?.port < 1 ||
    !state.pools?.migration ||
    !state.pools?.runtime
  ) {
    fail("connector_physical_state_invalid");
  }
  return state;
}

function requireTrue(value, code) {
  if (value !== true) fail(code);
}

function uuid(randomUUID) {
  const value = randomUUID();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    fail("connector_physical_uuid_invalid");
  }
  return value;
}

function defaultDependencies() {
  const backupRunner = require("./social-3a0p-local-backup-restore");
  const migrations = require("../src/persistence/postgres/migrations");
  const { withTransaction } = require("../src/persistence/postgres/pool");
  const { createPostgresConnectorStore } = require("../src/persistence/postgres/social-connector-store");
  const { createPostgresOAuthRepository } = require("../src/persistence/postgres/social-oauth-repository");
  const { createSocialAuthAdapter } = require("../src/social/auth-adapter");
  const { createConnectorContext } = require("../src/social/connectors/contract");
  const { createSocialVault } = require("../src/social/vault");
  const {
    deriveVaultKeyVersion,
    vaultKeyringFingerprint
  } = require("../src/social/vault-key-version");
  const { SESSION_AUDIENCE, SESSION_ISSUER } = require("../src/social/reauth");
  const { RLS_TABLES } = require("../src/persistence/postgres/backup-restore");
  return Object.freeze({
    createConnectorContext,
    createMigrationRunner: migrations.createMigrationRunner,
    createPostgresConnectorStore,
    createPostgresOAuthRepository,
    createSocialAuthAdapter,
    createSocialVault,
    deriveVaultKeyVersion,
    readManifest: migrations.readManifest,
    RLS_TABLES,
    runForwardOnlyRollbackGate: backupRunner.runForwardOnlyRollbackGate,
    runProfileBackup: backupRunner.runProfileBackup,
    runProfileRestore: backupRunner.runProfileRestore,
    SESSION_AUDIENCE,
    SESSION_ISSUER,
    targetFingerprint: migrations.targetFingerprint,
    vaultKeyringFingerprint,
    withTransaction
  });
}

function physicalPrincipal(dependencies, identityKey, legacyId) {
  return dependencies.createSocialAuthAdapter({
    namespaceUuid: "41cb8c58-0bf4-4bd9-83b2-3f2f96dfe29f",
    key: identityKey,
    derivationVersion: IDENTITY_VERSION
  }).fromVerifiedJwt({
    token_version: 2,
    iss: dependencies.SESSION_ISSUER,
    aud: dependencies.SESSION_AUDIENCE,
    jti: `synthetic-jwt-${legacyId}`,
    sub: legacyId,
    whatsapp: legacyId,
    company_id: legacyId
  });
}

function contextFor(dependencies, identityKey, fixture) {
  return dependencies.createConnectorContext({
    principal: physicalPrincipal(
      dependencies,
      identityKey,
      fixture.legacyId
    ),
    provider: "instagram",
    environment: "test",
    correlationId: fixture.correlationId,
    auditEventId: fixture.auditEventId
  });
}

function createFixture(randomUUID, label) {
  return Object.freeze({
    label,
    legacyId: `synthetic-${label.toLowerCase().replaceAll(" ", "-")}`,
    companyId: uuid(randomUUID),
    userId: uuid(randomUUID),
    connectionId: uuid(randomUUID),
    authorizationId: uuid(randomUUID),
    operationId: uuid(randomUUID),
    correlationId: uuid(randomUUID),
    auditEventId: uuid(randomUUID)
  });
}

async function seedTenant(dependencies, pool, fixture) {
  await dependencies.withTransaction(
    pool,
    async (client) => {
      await client.query(
        "INSERT INTO ia4tube_social.companies (id,name,identity_derivation_version) VALUES ($1,$2,$3)",
        [fixture.companyId, `Synthetic ${fixture.label}`, IDENTITY_VERSION]
      );
      await client.query(
        "INSERT INTO ia4tube_social.users (company_id,id,login_key_digest) VALUES ($1,$2,$3)",
        [
          fixture.companyId,
          fixture.userId,
          crypto.createHash("sha256").update(`synthetic:${fixture.userId}`).digest("hex")
        ]
      );
      await client.query(
        "INSERT INTO ia4tube_social.company_memberships (company_id,user_id,role) VALUES ($1,$2,'owner')",
        [fixture.companyId, fixture.userId]
      );
    },
    { role: OWNER_ROLE, companyId: fixture.companyId }
  );
}

async function migrationGate(state, dependencies, plans) {
  const target = {
    approval: "APPLY_SOCIAL_MIGRATIONS",
    productionApproval: "not-applicable-local-harness",
    environment: "local",
    environmentId: state.environmentId,
    host: LOOPBACK_HOST,
    port: String(state.target.port),
    database: LOCAL_DATABASE,
    username: MIGRATION_LOGIN
  };
  const fingerprint = dependencies.targetFingerprint(target);
  const runner = dependencies.createMigrationRunner({
    pool: state.pools.migration,
    ownerRole: OWNER_ROLE,
    migratorRole: MIGRATOR_ROLE,
    target,
    manifestOptions: { root: state.repositoryRoot }
  });
  const applied = await runner.apply({ SOCIAL_MIGRATION_TARGET_FINGERPRINT: fingerprint });
  const validation = await runner.validate();
  if (
    validation.valid !== true ||
    validation.pending !== 0 ||
    validation.applied !== 4 ||
    !Array.isArray(applied)
  ) {
    fail("connector_physical_migration_invalid");
  }
  // Exact 0004 rollback is executed by the forward-only plan against a
  // profile-0003 disposable database; no down migration is invented here.
  if (!RUN_MARKER_PATTERN.test(String(plans?.runMarker || ""))) {
    fail("connector_physical_run_marker_invalid");
  }
  const rollbackAdapter = typeof plans.createRollbackAdapter === "function"
    ? await plans.createRollbackAdapter(state)
    : plans?.rollbackAdapter;
  if (
    !rollbackAdapter ||
    rollbackAdapter.runMarker !== plans.runMarker
  ) {
    fail("connector_physical_rollback_plan_missing");
  }
  const rollback = await dependencies.runForwardOnlyRollbackGate({
    approval: LOCAL_PHYSICAL_APPROVAL,
    host: LOOPBACK_HOST,
    runMarker: plans.runMarker,
    adapter: rollbackAdapter
  });
  requireTrue(rollback.transactionalRollbackVerified, "connector_physical_transactional_rollback_invalid");
  requireTrue(rollback.reapplyVerified, "connector_physical_reapply_invalid");
  state.forwardOnlyRollback = rollback;
  return {
    physicalExecution: true,
    syntheticOnly: true,
    profile0004: true,
    transactionalRollback: true,
    nonSocialUnchanged: true,
    migrationsApplied: validation.applied
  };
}

async function rlsGate(state, dependencies, fixtures) {
  const [companyA, companyB] = fixtures;
  await seedTenant(dependencies, state.pools.migration, companyA);
  await seedTenant(dependencies, state.pools.migration, companyB);
  const own = await dependencies.withTransaction(
    state.pools.runtime,
    (client) => client.query(
      "SELECT COUNT(*)::integer AS visible FROM ia4tube_social.companies WHERE id=$1",
      [companyA.companyId]
    ),
    { role: RUNTIME_ROLE, companyId: companyA.companyId }
  );
  const cross = await dependencies.withTransaction(
    state.pools.runtime,
    (client) => client.query(
      "SELECT COUNT(*)::integer AS visible FROM ia4tube_social.companies WHERE id=$1",
      [companyB.companyId]
    ),
    { role: RUNTIME_ROLE, companyId: companyA.companyId }
  );
  if (Number(own.rows?.[0]?.visible) !== 1 || Number(cross.rows?.[0]?.visible) !== 0) {
    fail("connector_physical_rls_isolation_invalid");
  }
  let missingContextRefused = false;
  try {
    const missing = await dependencies.withTransaction(
      state.pools.runtime,
      (client) => client.query("SELECT COUNT(*)::integer AS visible FROM ia4tube_social.companies"),
      { role: RUNTIME_ROLE }
    );
    missingContextRefused = Number(missing.rows?.[0]?.visible) === 0;
  } catch {
    missingContextRefused = true;
  }
  if (!missingContextRefused) fail("connector_physical_missing_context_visible");
  let tamperedRefused = false;
  const client = await state.pools.runtime.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE "${RUNTIME_ROLE}"`);
    await client.query("SELECT set_config('ia4tube.company_id',$1,TRUE)", ["not-a-uuid"]);
    await client.query("SELECT COUNT(*) FROM ia4tube_social.companies");
  } catch {
    tamperedRefused = true;
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
  if (!tamperedRefused) fail("connector_physical_tampered_context_accepted");
  const force = await dependencies.withTransaction(
    state.pools.migration,
    (owner) => owner.query([
      "SELECT COUNT(*)::integer AS missing",
      "FROM pg_catalog.pg_class relation",
      "JOIN pg_catalog.pg_namespace namespace ON namespace.oid=relation.relnamespace",
      "WHERE namespace.nspname='ia4tube_social' AND relation.relkind IN ('r','p')",
      "AND relation.relname=ANY($1::text[])",
      "AND (NOT relation.relrowsecurity OR NOT relation.relforcerowsecurity)"
    ].join("\n"), [dependencies.RLS_TABLES]),
    { role: OWNER_ROLE }
  );
  if (Number(force.rows?.[0]?.missing) !== 0) fail("connector_physical_force_rls_invalid");
  state.connectorFixtures = fixtures;
  return {
    physicalExecution: true,
    syntheticOnly: true,
    tenantIsolation: true,
    missingContextRefused: true,
    tamperedContextRefused: true,
    forceRls: true,
    syntheticCompanies: 2
  };
}

async function concurrencyGate(state, dependencies, identityKey, fixtures) {
  const runSubstep = typeof dependencies.runGate3Substep === "function"
    ? dependencies.runGate3Substep
    : (_substep, _operationClass, operation) => operation();
  const fixture = fixtures[0];
  const setup = await runSubstep("B1", "internal_setup", () => {
    const context = contextFor(dependencies, identityKey, fixture);
    const scope = dependencies.createPostgresConnectorStore({
      pool: state.pools.runtime,
      runtimeRole: RUNTIME_ROLE
    }).scope(context);
    return { context, scope };
  });
  const { context, scope } = setup;
  await runSubstep("B2", "postgres_transaction", () => scope.saveConnection({
    companyId: fixture.companyId,
    id: fixture.connectionId,
    provider: "instagram",
    state: "authorization_pending",
    account: null,
    revision: 1
  }, null));

  const oauthMaterial = await runSubstep("B3", "internal_setup", () => {
    const oauth = dependencies.createPostgresOAuthRepository({
      pool: state.pools.runtime,
      runtimeRole: RUNTIME_ROLE
    }).scope(context);
    const rawState = `synthetic-state-${crypto.randomBytes(32).toString("hex")}`;
    const sessionJti = `synthetic-session-${crypto.randomBytes(16).toString("hex")}`;
    const authorization = {
      authorizationHandle: fixture.authorizationId,
      connectionId: fixture.connectionId,
      purpose: "connect",
      state: rawState,
      redirectUri: "https://synthetic.invalid/social/oauth/callback",
      sessionJti,
      expiresAt: new Date(Date.now() + 5 * 60_000)
    };
    return { authorization, oauth, rawState, sessionJti };
  });
  const { authorization, oauth, rawState, sessionJti } = oauthMaterial;
  await runSubstep("B4", "postgres_transaction", async () => {
    const created = await oauth.createAuthorization(authorization);
    if (created.authorizationHandle !== fixture.authorizationId) {
      fail("connector_physical_oauth_idempotency_invalid");
    }
  });
  await runSubstep("B5", "postgres_transaction", async () => {
    const consumed = await oauth.consumeAuthorization({
      authorizationHandle: fixture.authorizationId,
      state: rawState,
      redirectUri: authorization.redirectUri,
      sessionJti
    });
    if (consumed.status !== "consumed") {
      fail("connector_physical_oauth_lifecycle_invalid");
    }
  });

  const request = {
    capability: "beginAuthorization",
    operationId: fixture.operationId,
    digest: "d".repeat(64)
  };
  const contenders = await runSubstep(
    "B6",
    "postgres_concurrent_transactions",
    () => Promise.all([
      scope.beginIdempotency(request),
      scope.beginIdempotency(request)
    ])
  );
  await runSubstep("B7", "internal_validation", () => {
    const statuses = contenders.map((item) => item.status).sort();
    if (statuses.join(",") !== "acquired,pending") {
      fail("connector_physical_idempotency_race_invalid");
    }
  });
  await runSubstep("B8", "postgres_transaction", () => scope.completeIdempotency({
    capability: request.capability,
    operationId: request.operationId,
    digest: request.digest,
    result: {
      connectionId: fixture.connectionId,
      provider: "instagram",
      state: "authorization_pending",
      account: null,
      revision: 1,
      authorizationHandle: fixture.authorizationId
    },
    errorCode: null
  }));
  await runSubstep("B9", "postgres_transaction", async () => {
    const replay = await scope.beginIdempotency(request);
    if (replay.status !== "completed") {
      fail("connector_physical_idempotency_replay_invalid");
    }
  });
  return runSubstep("B10", "internal_validation", () => {
    state.syntheticOauthDigests = {
      state: crypto.createHash("sha256").update(rawState).digest("hex"),
      session: crypto.createHash("sha256").update(sessionJti).digest("hex")
    };
    return {
      physicalExecution: true,
      syntheticOnly: true,
      concurrencySafe: true,
      oauthSynthetic: true,
      idempotencySafe: true,
      externalCallsAbsent: true
    };
  });
}

async function vaultGate(state, dependencies, randomBytes, randomUUID) {
  const keyV1 = state.materials.vault;
  const keyV2 = randomBytes(32);
  const plaintext = Buffer.from("synthetic-vault-physical-gate", "utf8");
  const context = {
    companyId: uuid(randomUUID),
    provider: "instagram",
    credentialId: uuid(randomUUID),
    credentialType: "access_token",
    subjectType: "connection",
    subjectId: uuid(randomUUID)
  };
  const versionV1 = dependencies.deriveVaultKeyVersion(1, keyV1);
  const versionV2 = dependencies.deriveVaultKeyVersion(2, keyV2);
  let oldVault;
  let currentVault;
  try {
    oldVault = dependencies.createSocialVault({
      keyring: { activeVersion: versionV1, keys: new Map([[versionV1, keyV1]]) },
      expectedKeyringFingerprint: dependencies.vaultKeyringFingerprint(versionV1, [versionV1])
    });
    const envelope = oldVault.encrypt(plaintext, context);
    const roundTrip = oldVault.decrypt(envelope, context);
    if (!roundTrip.equals(plaintext)) fail("connector_physical_vault_roundtrip_invalid");
    roundTrip.fill(0);
    let aadRefused = false;
    try {
      oldVault.decrypt(envelope, { ...context, companyId: uuid(randomUUID) });
    } catch {
      aadRefused = true;
    }
    if (!aadRefused) fail("connector_physical_vault_aad_invalid");
    currentVault = dependencies.createSocialVault({
      keyring: {
        activeVersion: versionV2,
        keys: new Map([[versionV1, keyV1], [versionV2, keyV2]])
      },
      expectedKeyringFingerprint: dependencies.vaultKeyringFingerprint(versionV2, [versionV1, versionV2])
    });
    const rotated = currentVault.rotate(envelope, context);
    if (!rotated.changed || rotated.envelope.keyVersion !== versionV2) {
      fail("connector_physical_vault_rotation_invalid");
    }
    const after = currentVault.decrypt(rotated.envelope, context);
    if (!after.equals(plaintext)) fail("connector_physical_vault_rotation_invalid");
    after.fill(0);
  } finally {
    oldVault?.destroy();
    currentVault?.destroy();
    keyV2.fill(0);
    plaintext.fill(0);
  }
  return {
    physicalExecution: true,
    syntheticOnly: true,
    aes256Gcm: true,
    aadBound: true,
    roundTrip: true,
    rotation: true,
    plaintextAbsent: true
  };
}

async function backupRestoreGate(state, dependencies, plans) {
  const plan = typeof plans?.prepareBackupRestore === "function"
    ? await plans.prepareBackupRestore(state)
    : plans?.backupRestore;
  if (!plan) fail("connector_physical_backup_plan_missing");
  let primaryFailed = false;
  try {
    const rollback = state.forwardOnlyRollback;
    if (rollback?.operationalRestoreVerified !== true) {
      fail("connector_physical_backup_restore_invalid");
    }
    const requireBackupResult = (backup, expectedProfileId) => {
      if (backup?.profileId !== expectedProfileId) {
        fail("connector_physical_backup_restore_invalid");
      }
      const bundle = {
        size: Number(backup.evidence?.bundleSize),
        sha256: String(backup.evidence?.bundleSha256 || ""),
        tables: Number(backup.evidence?.tableCount),
        rlsPolicies: Number(backup.evidence?.rlsTableCount)
      };
      if (
        !Number.isSafeInteger(bundle.size) ||
        bundle.size < 1 ||
        !/^[0-9a-f]{64}$/.test(bundle.sha256) ||
        !Number.isSafeInteger(bundle.tables) ||
        bundle.tables < 1 ||
        !Number.isSafeInteger(bundle.rlsPolicies) ||
        bundle.rlsPolicies < 1
      ) {
        fail("connector_physical_backup_bundle_evidence_invalid");
      }
      return bundle;
    };
    const backup0003 = await dependencies.runProfileBackup(plan.backup0003);
    const bundle0003 = requireBackupResult(
      backup0003,
      "social-schema-0003"
    );
    const restore0003 = await dependencies.runProfileRestore(plan.restore0003);
    if (restore0003?.disposableTargetRemoved !== true) {
      fail("connector_physical_backup_restore_invalid");
    }
    const backup0004 = await dependencies.runProfileBackup(plan.backup0004);
    const bundle0004 = requireBackupResult(
      backup0004,
      "social-schema-0004"
    );
    const restore0004 = await dependencies.runProfileRestore(plan.restore0004);
    if (restore0004?.disposableTargetRemoved !== true) {
      fail("connector_physical_backup_restore_invalid");
    }
    // Tamper and cross-profile refusals are executed by the concrete plan so no
    // result is inferred from a unit-test-only JSON mutation.
    requireTrue(await plan.assertManifestTamperRefused(), "connector_physical_manifest_tamper_accepted");
    requireTrue(await plan.assertCrossProfileRefused(), "connector_physical_cross_profile_accepted");
    return {
      physicalExecution: true,
      syntheticOnly: true,
      profile0003: true,
      profile0004: true,
      restoreIsolated: true,
      manifestTamperRefused: true,
      crossProfileRefused: true,
      operationalRollback: true,
      disposableRemoved: true,
      fileFsync: true,
      bundle0003Size: bundle0003.size,
      bundle0003Sha256: bundle0003.sha256,
      bundle0003Tables: bundle0003.tables,
      bundle0003RlsPolicies: bundle0003.rlsPolicies,
      bundle0004Size: bundle0004.size,
      bundle0004Sha256: bundle0004.sha256,
      bundle0004Tables: bundle0004.tables,
      bundle0004RlsPolicies: bundle0004.rlsPolicies
    };
  } catch (error) {
    primaryFailed = true;
    throw error;
  } finally {
    if (typeof plan.cleanup === "function") {
      try {
        await plan.cleanup();
      } catch (error) {
        if (!primaryFailed) throw error;
      }
    }
  }
}

function createConnectorPhysicalGates(options = {}) {
  const dependencies = Object.freeze({
    ...(options.replaceDefaultDependencies === true ? {} : defaultDependencies()),
    ...(options.dependencies || {})
  });
  const plans = options.plans || {};
  const randomBytes = options.randomBytes || crypto.randomBytes;
  const randomUUID = options.randomUUID || crypto.randomUUID;
  const identityKey = randomBytes(32);
  const fixtures = [
    createFixture(randomUUID, "Company A"),
    createFixture(randomUUID, "Company B")
  ].map((fixture) => {
    const principal = physicalPrincipal(dependencies, identityKey, fixture.legacyId);
    return Object.freeze({ ...fixture, companyId: principal.companyId, userId: principal.userId });
  });
  function assertConfigured() {
    const rollbackRequired = [
      "captureCanonical0003",
      "applyControlledFailing0004",
      "verifyTransactionRollback",
      "compareCanonical0003",
      "backup0003",
      "apply0004",
      "createDisposable0003",
      "reconcileDisposable0003CreateFailure",
      "assertDisposable0003Created",
      "restore0003",
      "verifyRestored0003",
      "removeDisposable0003",
      "assertDisposable0003Removed",
      "reapply0004",
      "verify0004Checksum",
      "verifyProfile0004",
      "verifyNonSocialUnchanged"
    ];
    if (!RUN_MARKER_PATTERN.test(String(plans.runMarker || ""))) {
      fail("connector_physical_run_marker_invalid");
    }
    const hasStaticRollback = plans.rollbackAdapter &&
      rollbackRequired.every((name) => typeof plans.rollbackAdapter[name] === "function");
    if (!hasStaticRollback && typeof plans.createRollbackAdapter !== "function") {
      fail("connector_physical_rollback_plan_missing");
    }
    const backup = plans.backupRestore;
    if (
      typeof plans.prepareBackupRestore !== "function" &&
      (!backup ||
        !backup.backup0003 ||
        !backup.restore0003 ||
        !backup.backup0004 ||
        !backup.restore0004 ||
        typeof backup.assertManifestTamperRefused !== "function" ||
        typeof backup.assertCrossProfileRefused !== "function")
    ) {
      fail("connector_physical_backup_plan_missing");
    }
    return true;
  }
  return Object.freeze({
    assertConfigured,
    migration: ({ state }) => migrationGate(requireState(state), dependencies, plans),
    rls: ({ state }) => rlsGate(requireState(state), dependencies, fixtures),
    concurrency: ({ state }) => concurrencyGate(requireState(state), dependencies, identityKey, fixtures),
    vault: ({ state }) => vaultGate(requireState(state), dependencies, randomBytes, randomUUID),
    backupRestore: ({ state }) => backupRestoreGate(requireState(state), dependencies, plans),
    async destroy() {
      identityKey.fill(0);
      if (typeof plans.destroy === "function") await plans.destroy();
    }
  });
}

module.exports = {
  ConnectorPhysicalGateFailure,
  createConnectorPhysicalGates,
  createFixture,
  seedTenant
};
