"use strict";

// Harness-only adapter. This file deliberately reuses the definitive backup
// implementation without changing its production contract.
const crypto = require("node:crypto");
const {
  SCHEMA_PROFILES,
  createPostgresBackupOperator,
  resolveSchemaProfile,
  runLogicalBackup,
  runLogicalRestore,
  validateManifestFiles
} = require("../src/persistence/postgres/backup-restore");

const LOCAL_PHYSICAL_APPROVAL =
  "RUN_SOCIAL_3A0P_LOCAL_BACKUP_RESTORE";
const EXACT_LOOPBACK_HOST = "127.0.0.1";
const RUN_MARKER_PATTERN = /^ia4tube-social-3a0p-[a-z0-9-]{8,64}$/;
const ALLOWED_PROFILE_IDS = Object.freeze([
  "social-schema-0003",
  "social-schema-0004"
]);
const WINDOWS_DURABILITY = Object.freeze({
  fileFsync: "required",
  directoryFsync: "physicalPendingLinux",
  noFollow: "physicalPendingLinux"
});
const ROLLBACK_MODEL = Object.freeze({
  architecture: "forward-only",
  downMigrationCreated: false,
  transactional: Object.freeze([
    "capture-canonical-0003",
    "apply-controlled-failing-0004",
    "verify-transaction-rollback",
    "compare-canonical-0003"
  ]),
  operational: Object.freeze([
    "backup-profile-0003",
    "apply-0004-on-source",
    "create-marked-disposable-target",
    "restore-profile-0003",
    "validate-profile-0003",
    "remove-disposable-target"
  ]),
  reapply: Object.freeze([
    "reapply-0004",
    "verify-0004-checksum",
    "verify-profile-0004",
    "verify-non-social-unchanged"
  ])
});

class LocalBackupRestoreFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
    this.name = "LocalBackupRestoreFailure";
  }
}

function fail(code) {
  throw new LocalBackupRestoreFailure(code);
}

function safeFailure(error, fallback) {
  if (error instanceof LocalBackupRestoreFailure) return error;
  const code = String(error?.code || "");
  return new LocalBackupRestoreFailure(
    /^[a-z][a-z0-9_]{2,95}$/.test(code) ? code : fallback
  );
}

function attachCleanupFailure(primaryFailure, cleanupFailure) {
  const primary = safeFailure(primaryFailure, "local_operation_failed");
  const cleanup = safeFailure(cleanupFailure, "local_cleanup_failed");
  Object.defineProperty(primary, "cleanupFailureCode", {
    value: cleanup.code,
    enumerable: true,
    writable: false,
    configurable: false
  });
  return primary;
}

function isSha256(value) {
  return /^[0-9a-f]{64}$/.test(String(value || ""));
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return crypto
    .createHash("sha256")
    .update(canonicalJson(value))
    .digest("hex");
}

function assertExactLoopbackHost(host) {
  if (host !== EXACT_LOOPBACK_HOST) {
    fail("local_backup_restore_host_refused");
  }
  return true;
}

function requireProfileId(value) {
  const profileId = typeof value === "string" ? value : value?.id;
  if (!ALLOWED_PROFILE_IDS.includes(profileId)) {
    fail("local_backup_restore_profile_refused");
  }
  return profileId;
}

function profileForRows(rows, dependencies = {}) {
  const resolver = dependencies.resolveSchemaProfile || resolveSchemaProfile;
  const profile = resolver(rows);
  const profileId = requireProfileId(profile);
  const canonical = SCHEMA_PROFILES.find((item) => item.id === profileId);
  if (!canonical) fail("local_backup_restore_profile_refused");
  return canonical;
}

function assertProfileBinding(expectedProfile, actualProfile) {
  const expected = requireProfileId(expectedProfile);
  const actual = requireProfileId(actualProfile);
  if (expected !== actual) {
    fail("local_backup_restore_cross_profile_refused");
  }
  return true;
}

function requireRunMarker(value) {
  if (!RUN_MARKER_PATTERN.test(String(value || ""))) {
    fail("local_backup_restore_run_marker_invalid");
  }
  return value;
}

function assertDisposableLifecycle(
  lifecycle,
  expectedProfile,
  { expectedDatabase, runMarker } = {}
) {
  const expected = requireProfileId(expectedProfile);
  const expectedRunMarker = requireRunMarker(runMarker);
  if (
    !lifecycle ||
    lifecycle.markedDisposable !== true ||
    lifecycle.productionLike !== false ||
    lifecycle.host !== EXACT_LOOPBACK_HOST ||
    lifecycle.profileId !== expected ||
    lifecycle.runMarker !== expectedRunMarker ||
    !/^[a-z][a-z0-9_]{2,62}$/.test(String(lifecycle.database || "")) ||
    !String(lifecycle.database).includes("disposable") ||
    (expectedDatabase !== undefined &&
      lifecycle.database !== expectedDatabase) ||
    typeof lifecycle.create !== "function" ||
    typeof lifecycle.reconcileCreateFailure !== "function" ||
    typeof lifecycle.assertCreated !== "function" ||
    typeof lifecycle.assertRemoved !== "function" ||
    typeof lifecycle.remove !== "function"
  ) {
    fail("local_backup_restore_disposable_lifecycle_invalid");
  }
  return Object.freeze({
    host: EXACT_LOOPBACK_HOST,
    database: lifecycle.database,
    profileId: expected,
    runMarker: expectedRunMarker
  });
}

function requireCreateReconciliation(value, identity) {
  const keys = [
    "createdByThisRun",
    "database",
    "host",
    "profileId",
    "runMarker",
    "status"
  ];
  if (
    !value ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys) ||
    !["absent", "owned"].includes(value.status) ||
    value.host !== identity.host ||
    value.database !== identity.database ||
    value.profileId !== identity.profileId ||
    value.runMarker !== identity.runMarker ||
    value.createdByThisRun !== (value.status === "owned")
  ) {
    fail("local_backup_restore_create_reconciliation_invalid");
  }
  if (value.status === "absent") return null;
  return requireOwnershipProof({
    createdByThisRun: true,
    database: value.database,
    host: value.host,
    profileId: value.profileId,
    runMarker: value.runMarker
  }, identity);
}

function requireOwnershipProof(value, identity) {
  const keys = [
    "createdByThisRun",
    "database",
    "host",
    "profileId",
    "runMarker"
  ];
  if (
    !value ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys) ||
    value.createdByThisRun !== true ||
    value.host !== identity.host ||
    value.database !== identity.database ||
    value.profileId !== identity.profileId ||
    value.runMarker !== identity.runMarker
  ) {
    fail("local_backup_restore_ownership_unconfirmed");
  }
  return Object.freeze({ ...value });
}

function assertPhysicalApproval(value) {
  if (value !== LOCAL_PHYSICAL_APPROVAL) {
    fail("local_backup_restore_physical_approval_missing");
  }
  return true;
}

function assertPhysicalResult(result, mode) {
  if (!result || result.ok !== true) {
    fail(`local_${mode}_result_invalid`);
  }
  if (
    result.temporaryWorkspaceCleanupConfirmed !== true ||
    result.plaintextArtifactsAbsent !== true ||
    !isSha256(result.evidenceSha256)
  ) {
    fail(`local_${mode}_evidence_invalid`);
  }
  if (mode === "backup") {
    if (
      result.bundleFileFsyncConfirmed !== true ||
      result.bundleRoundTripVerified !== true ||
      !Number.isSafeInteger(result.bundleSize) ||
      result.bundleSize < 1 ||
      !isSha256(result.bundleSha256)
    ) {
      fail("local_backup_durability_invalid");
    }
  } else if (
    result.runtimeIsolation !== true ||
    result.vault !== true ||
    result.compatibleWith2A !== true
  ) {
    fail("local_restore_behavior_invalid");
  }
  return true;
}

function profileEvidence(profile) {
  const canonical = SCHEMA_PROFILES.find(
    (candidate) => candidate.id === requireProfileId(profile)
  );
  if (!canonical) fail("local_backup_restore_profile_refused");
  return Object.freeze({
    profileId: canonical.id,
    migrationCount: canonical.migrationRows.length,
    migrationLedgerSha256: digest(canonical.migrationRows),
    tableCount: canonical.backupTables.length,
    tableInventorySha256: digest(canonical.backupTables),
    rlsTableCount: canonical.rlsTables.length,
    rlsInventorySha256: digest(canonical.rlsTables)
  });
}

function sanitizedBackupEvidence(profile, result) {
  return Object.freeze({
    ...profileEvidence(profile),
    bundleSize: result.bundleSize,
    bundleSha256: result.bundleSha256,
    evidenceSha256: result.evidenceSha256,
    fileFsyncConfirmed: true,
    bundleRoundTripVerified: true,
    directoryFsync: WINDOWS_DURABILITY.directoryFsync,
    noFollow: WINDOWS_DURABILITY.noFollow,
    plaintextArtifactsAbsent: true,
    temporaryWorkspaceCleanupConfirmed: true
  });
}

function sanitizedRestoreEvidence(profile, result) {
  return Object.freeze({
    ...profileEvidence(profile),
    evidenceSha256: result.evidenceSha256,
    runtimeIsolation: true,
    vault: true,
    compatibleWith2A: true,
    disposableTargetRemoved: true,
    plaintextArtifactsAbsent: true,
    temporaryWorkspaceCleanupConfirmed: true
  });
}

function physicalPendingEvidence() {
  return Object.freeze({
    physicalPending: true,
    gates: Object.freeze([
      "backup-profile-0003",
      "backup-profile-0004",
      "restore-profile-0003",
      "restore-profile-0004",
      "transactional-rollback-0004",
      "operational-rollback-0003",
      "reapply-0004"
    ]),
    windows: WINDOWS_DURABILITY,
    postgresAccessed: false,
    networkAccessed: false
  });
}

function validateBoundManifest({
  manifest,
  expectedProfile,
  validationOptions,
  dependencies = {}
}) {
  const expectedProfileId = requireProfileId(expectedProfile);
  const manifestProfileId = manifest?.schemaProfile?.id;
  assertProfileBinding(expectedProfileId, manifestProfileId);
  const validate = dependencies.validateManifestFiles || validateManifestFiles;
  if (typeof validate !== "function" || !validationOptions) {
    fail("local_backup_manifest_validator_missing");
  }
  try {
    validate(manifest, validationOptions);
  } catch {
    fail("local_backup_manifest_tampered");
  }
  return true;
}

function assertLocalConfigTarget(config, mode, localBinding) {
  const target = mode === "backup" ? config?.source : config?.target;
  assertExactLoopbackHost(target?.public?.host);
  const keys = ["database", "host", "login", "port", "runMarker"];
  const port = Number(target?.public?.port);
  if (
    !target?.public?.database ||
    !target?.public?.login ||
    !/^[a-z][a-z0-9_]{2,62}$/.test(target.public.database) ||
    !/^[a-z][a-z0-9_]{2,62}$/.test(target.public.login) ||
    !Number.isSafeInteger(port) ||
    port < 1024 ||
    port > 65535 ||
    String(port) !== String(target.public.port) ||
    !localBinding ||
    Object.getPrototypeOf(localBinding) !== Object.prototype ||
    JSON.stringify(Object.keys(localBinding).sort()) !== JSON.stringify(keys) ||
    localBinding.host !== EXACT_LOOPBACK_HOST ||
    localBinding.host !== target.public.host ||
    localBinding.port !== String(target.public.port) ||
    localBinding.database !== target.public.database ||
    localBinding.login !== target.public.login ||
    !RUN_MARKER_PATTERN.test(String(localBinding.runMarker || ""))
  ) {
    fail(`local_${mode}_target_invalid`);
  }
  return true;
}

function createOperator(pool, dependencies) {
  if (!pool) fail("local_backup_restore_pool_missing");
  const factory =
    dependencies.createPostgresBackupOperator || createPostgresBackupOperator;
  const operator = factory(pool);
  if (!operator) fail("local_backup_restore_operator_invalid");
  return operator;
}

function bindBackupOperatorToProfile(operator, expectedProfile) {
  const methods = [
    "acquireLocks",
    "preflight",
    "assertTransientPoliciesAbsent",
    "collectCatalogEvidence",
    "releaseLocks"
  ];
  if (methods.some((name) => typeof operator?.[name] !== "function")) {
    fail("local_backup_restore_operator_invalid");
  }
  return Object.freeze({
    acquireLocks: (...args) => operator.acquireLocks(...args),
    async preflight(...args) {
      const observedProfile = await operator.preflight(...args);
      assertProfileBinding(expectedProfile, observedProfile);
      return observedProfile;
    },
    assertTransientPoliciesAbsent: (...args) =>
      operator.assertTransientPoliciesAbsent(...args),
    collectCatalogEvidence: (...args) =>
      operator.collectCatalogEvidence(...args),
    releaseLocks: (...args) => operator.releaseLocks(...args)
  });
}

async function runProfileBackup({
  approval,
  profileRows,
  config,
  pool,
  runTool,
  generatedAt,
  runMarker,
  localBinding,
  dependencies = {}
}) {
  assertPhysicalApproval(approval);
  assertLocalConfigTarget(config, "backup", localBinding);
  if (localBinding.runMarker !== runMarker) {
    fail("local_backup_target_invalid");
  }
  const profile = profileForRows(profileRows, dependencies);
  if (typeof runTool !== "function") fail("local_backup_tool_runner_missing");
  const run = dependencies.runLogicalBackup || runLogicalBackup;
  const operator = bindBackupOperatorToProfile(
    createOperator(pool, dependencies),
    profile
  );
  let result;
  try {
    result = await run({
      config,
      operator,
      runTool,
      generatedAt,
      // Windows proves file durability. Directory fsync remains a Linux gate.
      requireBundleDirectoryFsync: false
    });
  } catch (error) {
    throw safeFailure(error, "local_backup_execution_failed");
  }
  assertPhysicalResult(result, "backup");
  return Object.freeze({
    profileId: profile.id,
    evidence: sanitizedBackupEvidence(profile, result)
  });
}

async function runProfileRestore({
  approval,
  expectedProfile,
  config,
  pool,
  runTool,
  verifierTargetFingerprint,
  verifyRuntimeIsolation,
  verifyVault,
  verify2ACompatibility,
  verifyRestoredProfile,
  closeVerifiers,
  runMarker,
  localBinding,
  lifecycle,
  dependencies = {}
}) {
  assertPhysicalApproval(approval);
  assertLocalConfigTarget(config, "restore", localBinding);
  if (localBinding.runMarker !== runMarker) {
    fail("local_restore_target_invalid");
  }
  const identity = assertDisposableLifecycle(
    lifecycle,
    expectedProfile,
    {
      expectedDatabase: config.target.public.database,
      runMarker
    }
  );
  if (
    typeof runTool !== "function" ||
    typeof verifyRestoredProfile !== "function"
  ) {
    fail("local_restore_verifier_missing");
  }
  let ownershipProof;
  let primaryFailure;
  let cleanupFailure;
  let result;
  try {
    ownershipProof = requireOwnershipProof(
      await lifecycle.create(identity),
      identity
    );
    if ((await lifecycle.assertCreated(ownershipProof)) !== true) {
      fail("local_restore_disposable_create_unconfirmed");
    }
    const run = dependencies.runLogicalRestore || runLogicalRestore;
    result = await run({
      config,
      operator: createOperator(pool, dependencies),
      runTool,
      verifierTargetFingerprint,
      verifyRuntimeIsolation,
      verifyVault,
      verify2ACompatibility
    });
    assertPhysicalResult(result, "restore");
    const restoredProfile = await verifyRestoredProfile();
    assertProfileBinding(expectedProfile, restoredProfile);
  } catch (error) {
    primaryFailure = safeFailure(error, "local_restore_execution_failed");
    if (!ownershipProof) {
      try {
        ownershipProof = requireCreateReconciliation(
          await lifecycle.reconcileCreateFailure(identity),
          identity
        );
      } catch (reconciliationError) {
        cleanupFailure = safeFailure(
          reconciliationError,
          "local_restore_create_reconciliation_failed"
        );
      }
    }
  } finally {
    if (typeof closeVerifiers === "function") {
      try {
        await closeVerifiers();
      } catch (verifierCleanupError) {
        cleanupFailure = safeFailure(
          verifierCleanupError,
          "local_restore_verifier_cleanup_failed"
        );
      }
    }
    if (ownershipProof) {
      try {
        if ((await lifecycle.remove(ownershipProof)) !== true) {
          fail("local_restore_disposable_remove_failed");
        }
        if ((await lifecycle.assertRemoved(ownershipProof)) !== true) {
          fail("local_restore_disposable_remove_unconfirmed");
        }
      } catch (cleanupError) {
        if (!cleanupFailure) {
          cleanupFailure = safeFailure(
            cleanupError,
            "local_restore_disposable_cleanup_failed"
          );
        }
      }
    }
  }
  if (primaryFailure && cleanupFailure) {
    throw attachCleanupFailure(primaryFailure, cleanupFailure);
  }
  if (primaryFailure) throw primaryFailure;
  if (cleanupFailure) throw cleanupFailure;
  return sanitizedRestoreEvidence(expectedProfile, result);
}

function assertRollbackStep(value, code) {
  if (value !== true) fail(code);
}

async function runForwardOnlyRollbackGate({
  approval,
  host,
  runMarker,
  adapter
}) {
  assertPhysicalApproval(approval);
  assertExactLoopbackHost(host);
  if (!adapter || typeof adapter !== "object") {
    fail("local_rollback_adapter_invalid");
  }
  const required = [
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
  if (required.some((name) => typeof adapter[name] !== "function")) {
    fail("local_rollback_adapter_invalid");
  }
  const disposableIdentity = assertDisposableLifecycle(
    {
      markedDisposable: adapter.markedDisposable,
      productionLike: adapter.productionLike,
      host,
      database: adapter.disposableDatabase,
      profileId: profile0003().id,
      runMarker: adapter.runMarker,
      create: adapter.createDisposable0003,
      reconcileCreateFailure: adapter.reconcileDisposable0003CreateFailure,
      assertCreated: adapter.assertDisposable0003Created,
      remove: adapter.removeDisposable0003,
      assertRemoved: adapter.assertDisposable0003Removed
    },
    profile0003(),
    {
      expectedDatabase: adapter.disposableDatabase,
      runMarker
    }
  );

  assertRollbackStep(
    await adapter.captureCanonical0003(),
    "local_rollback_0003_capture_failed"
  );
  assertRollbackStep(
    await adapter.applyControlledFailing0004(),
    "local_rollback_controlled_failure_missing"
  );
  assertRollbackStep(
    await adapter.verifyTransactionRollback(),
    "local_rollback_transaction_unconfirmed"
  );
  assertRollbackStep(
    await adapter.compareCanonical0003(),
    "local_rollback_0003_changed"
  );

  assertRollbackStep(
    await adapter.backup0003(),
    "local_rollback_backup_0003_failed"
  );
  assertRollbackStep(
    await adapter.apply0004(),
    "local_rollback_apply_0004_failed"
  );
  let ownershipProof;
  let operationalFailure;
  let cleanupFailure;
  try {
    ownershipProof = requireOwnershipProof(
      await adapter.createDisposable0003(disposableIdentity),
      disposableIdentity
    );
    assertRollbackStep(
      await adapter.assertDisposable0003Created(ownershipProof),
      "local_rollback_disposable_create_unconfirmed"
    );
    assertRollbackStep(
      await adapter.restore0003(ownershipProof),
      "local_rollback_restore_0003_failed"
    );
    assertRollbackStep(
      await adapter.verifyRestored0003(ownershipProof),
      "local_rollback_restore_0003_invalid"
    );
  } catch (error) {
    operationalFailure = safeFailure(
      error,
      "local_rollback_operational_failed"
    );
    if (!ownershipProof) {
      try {
        ownershipProof = requireCreateReconciliation(
          await adapter.reconcileDisposable0003CreateFailure(
            disposableIdentity
          ),
          disposableIdentity
        );
      } catch (reconciliationError) {
        cleanupFailure = safeFailure(
          reconciliationError,
          "local_rollback_create_reconciliation_failed"
        );
      }
    }
  } finally {
    if (ownershipProof) {
      try {
        assertRollbackStep(
          await adapter.removeDisposable0003(ownershipProof),
          "local_rollback_disposable_remove_failed"
        );
        assertRollbackStep(
          await adapter.assertDisposable0003Removed(ownershipProof),
          "local_rollback_disposable_remove_unconfirmed"
        );
      } catch (cleanupError) {
        cleanupFailure = safeFailure(
          cleanupError,
          "local_rollback_disposable_cleanup_failed"
        );
      }
    }
  }
  if (operationalFailure && cleanupFailure) {
    throw attachCleanupFailure(operationalFailure, cleanupFailure);
  }
  if (operationalFailure) throw operationalFailure;
  if (cleanupFailure) throw cleanupFailure;

  assertRollbackStep(
    await adapter.reapply0004(),
    "local_rollback_reapply_0004_failed"
  );
  assertRollbackStep(
    await adapter.verify0004Checksum(),
    "local_rollback_0004_checksum_invalid"
  );
  assertRollbackStep(
    await adapter.verifyProfile0004(),
    "local_rollback_profile_0004_invalid"
  );
  assertRollbackStep(
    await adapter.verifyNonSocialUnchanged(),
    "local_rollback_non_social_changed"
  );

  return Object.freeze({
    ok: true,
    architecture: ROLLBACK_MODEL.architecture,
    downMigrationCreated: false,
    transactionalRollbackVerified: true,
    operationalRestoreVerified: true,
    reapplyVerified: true,
    disposableTargetRemoved: true
  });
}

function profile0003() {
  const profile = SCHEMA_PROFILES.find(
    (candidate) => candidate.id === "social-schema-0003"
  );
  if (!profile) fail("local_backup_restore_profile_refused");
  return profile;
}

module.exports = {
  ALLOWED_PROFILE_IDS,
  EXACT_LOOPBACK_HOST,
  LOCAL_PHYSICAL_APPROVAL,
  LocalBackupRestoreFailure,
  ROLLBACK_MODEL,
  RUN_MARKER_PATTERN,
  WINDOWS_DURABILITY,
  assertDisposableLifecycle,
  assertExactLoopbackHost,
  assertPhysicalApproval,
  assertProfileBinding,
  bindBackupOperatorToProfile,
  profileEvidence,
  physicalPendingEvidence,
  profileForRows,
  runForwardOnlyRollbackGate,
  runProfileBackup,
  runProfileRestore,
  requireOwnershipProof,
  validateBoundManifest
};
