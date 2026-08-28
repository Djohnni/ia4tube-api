"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  SCHEMA_PROFILES,
  targetFingerprint
} = require("../src/persistence/postgres/backup-restore");
const {
  BACKUP_CONNECTIVITY_MODE,
  BACKUP_LOGICAL_HOST,
  BACKUP_LOGICAL_PORT,
  BACKUP_PHYSICAL_MODE,
  BACKUP_PHYSICAL_PORT,
  EXACT_LOOPBACK_HOST,
  LOCAL_PHYSICAL_APPROVAL,
  ROLLBACK_MODEL,
  WINDOWS_DURABILITY,
  assertDisposableLifecycle,
  assertExactLoopbackHost,
  assertProfileBinding,
  physicalPendingEvidence,
  profileForRows,
  runForwardOnlyRollbackGate,
  runProfileBackup,
  runProfileRestore,
  validateBoundManifest
} = require("../scripts/social-3a0p-local-backup-restore");

const profile0003 = SCHEMA_PROFILES.find(
  (profile) => profile.id === "social-schema-0003"
);
const profile0004 = SCHEMA_PROFILES.find(
  (profile) => profile.id === "social-schema-0004"
);
const profile0005 = SCHEMA_PROFILES.find(
  (profile) => profile.id === "social-schema-0005"
);
const runMarker = "ia4tube-social-3a0p-run-00000001";
const restoreDatabase = "ia4tube_social_disposable_restore";

function ownershipIdentity(profileId, database = restoreDatabase) {
  return {
    database,
    host: EXACT_LOOPBACK_HOST,
    profileId,
    runMarker
  };
}

function ownershipProof(profileId, database = restoreDatabase) {
  return {
    createdByThisRun: true,
    ...ownershipIdentity(profileId, database)
  };
}

function backupConfig() {
  return {
    source: {
      public: {
        host: EXACT_LOOPBACK_HOST,
        port: "55432",
        database: "ia4tube_social_local",
        login: "ia4tube_social_local_migration"
      }
    }
  };
}

function restoreConfig(database = restoreDatabase) {
  return {
    target: {
      public: {
        host: EXACT_LOOPBACK_HOST,
        port: "55432",
        database,
        login: "ia4tube_social_local_migration"
      }
    }
  };
}

function bindingFor(config, mode = "backup") {
  const target = mode === "backup" ? config.source.public : config.target.public;
  return {
    database: target.database,
    host: EXACT_LOOPBACK_HOST,
    login: target.login,
    port: target.port,
    runMarker
  };
}

function logicalTlsContract(overrides = {}) {
  return {
    checkServerIdentity() {},
    minVersion: "TLSv1.2",
    rejectUnauthorized: true,
    servername: BACKUP_LOGICAL_HOST,
    ...overrides
  };
}

function logicalConfig(mode = "backup", overrides = {}) {
  const database = overrides.database || (mode === "backup"
    ? "ia4tube_social_local"
    : restoreDatabase);
  const connection = {
    public: {
      host: BACKUP_LOGICAL_HOST,
      port: String(BACKUP_LOGICAL_PORT),
      database,
      login: "ia4tube_social_local_migration"
    }
  };
  const fingerprint = targetFingerprint(connection.public);
  const common = {
    postgresTls: logicalTlsContract(overrides.postgresTls),
    ...(mode === "backup"
      ? { source: connection, sourceFingerprint: fingerprint }
      : {
          target: connection,
          targetFingerprint: fingerprint,
          sourceFingerprint: overrides.sourceFingerprint || "a".repeat(64)
        })
  };
  if (overrides.public) Object.assign(connection.public, overrides.public);
  if (overrides.fingerprint !== undefined) {
    common[mode === "backup" ? "sourceFingerprint" : "targetFingerprint"] =
      overrides.fingerprint;
  }
  return common;
}

function logicalBindingFor(config, mode = "backup", overrides = {}) {
  const target = mode === "backup" ? config.source.public : config.target.public;
  const fingerprint = mode === "backup"
    ? config.sourceFingerprint
    : config.targetFingerprint;
  return Object.freeze({
    connectivityMode: BACKUP_CONNECTIVITY_MODE,
    logicalHost: BACKUP_LOGICAL_HOST,
    logicalPort: BACKUP_LOGICAL_PORT,
    physicalMode: BACKUP_PHYSICAL_MODE,
    physicalHost: EXACT_LOOPBACK_HOST,
    physicalPort: BACKUP_PHYSICAL_PORT,
    database: target.database,
    login: target.login,
    runMarker,
    targetFingerprint: fingerprint,
    containerIdentityDigest: "c".repeat(64),
    ...overrides
  });
}

function backupResult(overrides = {}) {
  return {
    ok: true,
    bundle: "synthetic-bundle.ia4sb",
    bundleSize: 4096,
    bundleSha256: "1".repeat(64),
    evidenceSha256: "2".repeat(64),
    bundleFileFsyncConfirmed: true,
    bundleDirectoryFsyncConfirmed: false,
    bundleRoundTripVerified: true,
    temporaryWorkspaceCleanupConfirmed: true,
    plaintextArtifactsAbsent: true,
    ...overrides
  };
}

function restoreResult(overrides = {}) {
  return {
    ok: true,
    evidenceSha256: "3".repeat(64),
    runtimeIsolation: true,
    vault: true,
    compatibleWith2A: true,
    temporaryWorkspaceCleanupConfirmed: true,
    plaintextArtifactsAbsent: true,
    ...overrides
  };
}

function lifecycle(profileId, events = [], overrides = {}) {
  const {
    database = restoreDatabase,
    ...lifecycleOverrides
  } = overrides;
  let exists = false;
  const base = {
    markedDisposable: true,
    productionLike: false,
    host: EXACT_LOOPBACK_HOST,
    database,
    profileId,
    runMarker,
    async create(identity) {
      events.push("create");
      assert.deepEqual(identity, ownershipIdentity(profileId, database));
      exists = true;
      return ownershipProof(profileId, database);
    },
    async reconcileCreateFailure(identity) {
      events.push("reconcile-create");
      return {
        ...identity,
        status: exists ? "owned" : "absent",
        createdByThisRun: exists
      };
    },
    async assertCreated(proof) {
      events.push("assert-created");
      return exists && proof.createdByThisRun === true;
    },
    async remove(proof) {
      events.push("remove");
      if (!exists || proof.createdByThisRun !== true) return false;
      exists = false;
      return true;
    },
    async assertRemoved(proof) {
      events.push("assert-removed");
      return !exists && proof.createdByThisRun === true;
    }
  };
  return { ...base, ...lifecycleOverrides };
}

function dependencies(
  events = [],
  overrides = {},
  observedProfile = profile0004,
  catalogFailure
) {
  return {
    createPostgresBackupOperator(pool) {
      events.push(["operator", pool.id]);
      return {
        pool,
        async acquireLocks() {},
        async preflight() {
          events.push(["preflight-profile", observedProfile.id]);
          return observedProfile;
        },
        async assertTransientPoliciesAbsent() {},
        async collectCatalogEvidence(_config, schemaProfile) {
          events.push(["catalog-profile", schemaProfile.id]);
          if (catalogFailure) throw catalogFailure;
          return { requiredConstraintsPresent: true };
        },
        async releaseLocks() {}
      };
    },
    async runLogicalBackup(options) {
      const schemaProfile = await options.operator.preflight(options.config);
      await options.operator.collectCatalogEvidence(
        options.config,
        schemaProfile
      );
      await options.runTool(Object.freeze({
        kind: "synthetic-pg-dump-after-catalog"
      }));
      events.push([
        "backup",
        options.requireBundleDirectoryFsync
      ]);
      return backupResult();
    },
    async runLogicalRestore(options) {
      events.push(["restore", options.operator.pool.id]);
      return restoreResult();
    },
    ...overrides
  };
}

function restoreRequest(profile, events = [], overrides = {}) {
  const config = restoreConfig();
  return {
    approval: LOCAL_PHYSICAL_APPROVAL,
    expectedProfile: profile,
    config,
    localBinding: bindingFor(config, "restore"),
    pool: { id: `restore-${profile.id}` },
    runTool: async () => ({ code: 0, stdout: "" }),
    verifierTargetFingerprint: "4".repeat(64),
    verifyRuntimeIsolation: async () => true,
    verifyVault: async () => true,
    verify2ACompatibility: async () => true,
    verifyRestoredProfile: async () => profile,
    runMarker,
    lifecycle: lifecycle(profile.id, events),
    dependencies: dependencies(events),
    ...overrides
  };
}

function rollbackAdapter(events, overrides = {}) {
  const disposableDatabase =
    "ia4tube_social_disposable_rollback_0003";
  const names = [
    "captureCanonical0003",
    "applyControlledFailing0004",
    "verifyTransactionRollback",
    "compareCanonical0003",
    "backup0003",
    "apply0004",
    "createDisposable0003",
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
  const methods = Object.fromEntries(
    names.map((name) => [
      name,
      async () => {
        events.push(name);
        return true;
      }
    ])
  );
  methods.createDisposable0003 = async (identity) => {
    events.push("createDisposable0003");
    assert.deepEqual(
      identity,
      ownershipIdentity(profile0003.id, disposableDatabase)
    );
    return ownershipProof(profile0003.id, disposableDatabase);
  };
  methods.reconcileDisposable0003CreateFailure = async (identity) => ({
    ...identity,
    status: "absent",
    createdByThisRun: false
  });
  return {
    markedDisposable: true,
    productionLike: false,
    disposableDatabase,
    runMarker,
    ...methods,
    ...overrides
  };
}

test("pending evidence does not claim a physical approval", () => {
  const evidence = physicalPendingEvidence();
  assert.equal(evidence.physicalPending, true);
  assert.equal(evidence.postgresAccessed, false);
  assert.equal(evidence.networkAccessed, false);
  assert.equal(evidence.windows.fileFsync, "required");
  assert.equal(evidence.windows.directoryFsync, "physicalPendingLinux");
  assert.equal(evidence.windows.noFollow, "physicalPendingLinux");
  assert.ok(evidence.gates.includes("backup-profile-0005"));
  assert.ok(evidence.gates.includes("restore-profile-0005"));
  assert.equal(Object.hasOwn(evidence, "ok"), false);
});

test("only exact IPv4 loopback is authorized", () => {
  assert.equal(assertExactLoopbackHost("127.0.0.1"), true);
  for (const host of ["localhost", "::1", "127.0.0.2", "example.test", ""]){
    assert.throws(
      () => assertExactLoopbackHost(host),
      { message: "local_backup_restore_host_refused" }
    );
  }
});

test("the definitive migration ledger resolves profile 0003", () => {
  assert.equal(profileForRows(profile0003.migrationRows), profile0003);
});

test("the definitive migration ledger resolves profile 0004", () => {
  assert.equal(profileForRows(profile0004.migrationRows), profile0004);
});

test("the definitive migration ledger resolves current profile 0005", () => {
  assert.equal(profileForRows(profile0005.migrationRows), profile0005);
});

test("an unknown migration ledger is refused", () => {
  assert.throws(
    () => profileForRows([]),
    { code: "backup_migration_state_invalid" }
  );
});

test("profile binding accepts each known profile and rejects every cross-profile direction", () => {
  assert.equal(assertProfileBinding(profile0003, profile0003), true);
  assert.equal(assertProfileBinding(profile0004, profile0004), true);
  assert.equal(assertProfileBinding(profile0005, profile0005), true);
  for (const [expectedProfile, sourceProfile] of [
    [profile0003, profile0004],
    [profile0003, profile0005],
    [profile0004, profile0003],
    [profile0004, profile0005],
    [profile0005, profile0003],
    [profile0005, profile0004]
  ]) {
    assert.throws(
      () => assertProfileBinding(expectedProfile, sourceProfile),
      (error) => {
        assert.equal(error.code, "local_backup_restore_cross_profile_refused");
        assert.equal(error.message, "local_backup_restore_cross_profile_refused");
        return true;
      }
    );
  }
});

test("manifest binding invokes the definitive validator contract", () => {
  let calls = 0;
  assert.equal(
    validateBoundManifest({
      manifest: { schemaProfile: { id: profile0003.id } },
      expectedProfile: profile0003,
      validationOptions: { expectedDirectory: "synthetic" },
      dependencies: {
        validateManifestFiles() {
          calls += 1;
          return true;
        }
      }
    }),
    true
  );
  assert.equal(calls, 1);
});

test("tampered manifest is refused without exposing validator details", () => {
  assert.throws(
    () => validateBoundManifest({
      manifest: { schemaProfile: { id: profile0004.id } },
      expectedProfile: profile0004,
      validationOptions: { expectedDirectory: "synthetic" },
      dependencies: {
        validateManifestFiles() {
          throw new Error("synthetic sensitive detail");
        }
      }
    }),
    { message: "local_backup_manifest_tampered" }
  );
});

test("cross-profile manifest is refused before validation", () => {
  let validatorCalled = false;
  assert.throws(
    () => validateBoundManifest({
      manifest: { schemaProfile: { id: profile0004.id } },
      expectedProfile: profile0003,
      validationOptions: {},
      dependencies: {
        validateManifestFiles() {
          validatorCalled = true;
        }
      }
    }),
    { message: "local_backup_restore_cross_profile_refused" }
  );
  assert.equal(validatorCalled, false);
});

test("disposable lifecycle requires an exact loopback marked target", () => {
  assert.deepEqual(
    assertDisposableLifecycle(
      lifecycle(profile0003.id),
      profile0003,
      { expectedDatabase: restoreDatabase, runMarker }
    ),
    ownershipIdentity(profile0003.id)
  );
  const external = lifecycle(profile0003.id);
  external.host = "synthetic.example.test";
  assert.throws(
    () => assertDisposableLifecycle(
      external,
      profile0003,
      { expectedDatabase: restoreDatabase, runMarker }
    ),
    { message: "local_backup_restore_disposable_lifecycle_invalid" }
  );
});

for (const profile of [profile0003, profile0004, profile0005]) {
  test(`backup ${profile.id} validates its catalog before transport and reports Windows durability honestly`, async () => {
    const events = [];
    const config = backupConfig();
    const result = await runProfileBackup({
      approval: LOCAL_PHYSICAL_APPROVAL,
      runMarker,
      profileRows: profile.migrationRows,
      config,
      localBinding: bindingFor(config),
      pool: { id: `backup-${profile.id}` },
      runTool: async () => {
        events.push(["transport-profile", profile.id]);
        return { code: 0, stdout: "" };
      },
      dependencies: dependencies(events, {}, profile)
    });
    assert.equal(result.profileId, profile.id);
    assert.equal(result.evidence.profileId, profile.id);
    assert.equal(result.evidence.migrationCount, profile.migrationRows.length);
    assert.equal(result.evidence.tableCount, profile.backupTables.length);
    assert.equal(result.evidence.rlsTableCount, profile.rlsTables.length);
    assert.match(result.evidence.migrationLedgerSha256, /^[0-9a-f]{64}$/);
    assert.match(result.evidence.tableInventorySha256, /^[0-9a-f]{64}$/);
    assert.match(result.evidence.rlsInventorySha256, /^[0-9a-f]{64}$/);
    assert.equal(result.evidence.fileFsyncConfirmed, true);
    assert.equal(result.evidence.directoryFsync, "physicalPendingLinux");
    assert.equal(result.evidence.noFollow, "physicalPendingLinux");
    assert.deepEqual(events, [
      ["operator", `backup-${profile.id}`],
      ["preflight-profile", profile.id],
      ["catalog-profile", profile.id],
      ["transport-profile", profile.id],
      ["backup", false]
    ]);
  });
}

test("an invalid 0004 catalog is refused before the bound transport", async () => {
  const events = [];
  const config = backupConfig();
  let transportStarts = 0;
  await assert.rejects(
    runProfileBackup({
      approval: LOCAL_PHYSICAL_APPROVAL,
      runMarker,
      profileRows: profile0004.migrationRows,
      config,
      localBinding: bindingFor(config),
      pool: { id: "backup-0004-invalid-catalog" },
      runTool: async () => {
        transportStarts += 1;
        return { code: 0, stdout: "" };
      },
      dependencies: dependencies(
        events,
        {},
        profile0004,
        Object.assign(new Error("synthetic catalog refusal"), {
          code: "backup_catalog_state_invalid"
        })
      )
    }),
    { code: "backup_catalog_state_invalid" }
  );
  assert.deepEqual(events, [
    ["operator", "backup-0004-invalid-catalog"],
    ["preflight-profile", profile0004.id],
    ["catalog-profile", profile0004.id]
  ]);
  assert.equal(transportStarts, 0);
});

test("restore closes behavioral verifier sessions before removing the disposable database", async () => {
  const events = [];
  const result = await runProfileRestore(restoreRequest(profile0004, events, {
    async closeVerifiers() {
      events.push("close-verifiers");
    }
  }));
  assert.equal(result.disposableTargetRemoved, true);
  assert.deepEqual(events.slice(-3), [
    "close-verifiers",
    "remove",
    "assert-removed"
  ]);
});

test("restore reports verifier cleanup failure separately and still removes the disposable database", async () => {
  const events = [];
  await assert.rejects(
    runProfileRestore(restoreRequest(profile0004, events, {
      async closeVerifiers() {
        events.push("close-verifiers-failed");
        throw new Error("synthetic verifier close failure");
      }
    })),
    { code: "local_restore_verifier_cleanup_failed" }
  );
  assert.deepEqual(events.slice(-3), [
    "close-verifiers-failed",
    "remove",
    "assert-removed"
  ]);
});

test("backup refuses when the operator observes a different physical profile", async () => {
  const config = backupConfig();
  await assert.rejects(
    runProfileBackup({
      approval: LOCAL_PHYSICAL_APPROVAL,
      runMarker,
      profileRows: profile0003.migrationRows,
      config,
      localBinding: bindingFor(config),
      pool: { id: "backup-cross-profile" },
      runTool: async () => ({ code: 0, stdout: "" }),
      dependencies: dependencies([], {}, profile0004)
    }),
    { message: "local_backup_restore_cross_profile_refused" }
  );
});

test("backup refuses a false file-fsync result", async () => {
  const config = backupConfig();
  await assert.rejects(
    runProfileBackup({
      approval: LOCAL_PHYSICAL_APPROVAL,
      runMarker,
      profileRows: profile0004.migrationRows,
      config,
      localBinding: bindingFor(config),
      pool: { id: "backup" },
      runTool: async () => ({ code: 0, stdout: "" }),
      dependencies: dependencies([], {
        async runLogicalBackup() {
          return backupResult({ bundleFileFsyncConfirmed: false });
        }
      })
    }),
    { message: "local_backup_durability_invalid" }
  );
});

test("backup requires explicit physical approval before constructing an operator", async () => {
  let operatorCreated = false;
  const config = backupConfig();
  await assert.rejects(
    runProfileBackup({
      approval: "not-approved",
      runMarker,
      profileRows: profile0003.migrationRows,
      config,
      localBinding: bindingFor(config),
      pool: { id: "backup" },
      runTool: async () => ({ code: 0 }),
      dependencies: {
        createPostgresBackupOperator() {
          operatorCreated = true;
        }
      }
    }),
    { message: "local_backup_restore_physical_approval_missing" }
  );
  assert.equal(operatorCreated, false);
});

test("backup refuses an external config before constructing an operator", async () => {
  const config = backupConfig();
  config.source.public.host = "db.example.test";
  let operatorCreated = false;
  await assert.rejects(
    runProfileBackup({
      approval: LOCAL_PHYSICAL_APPROVAL,
      runMarker,
      profileRows: profile0003.migrationRows,
      config,
      localBinding: bindingFor(backupConfig()),
      pool: { id: "backup" },
      runTool: async () => ({ code: 0 }),
      dependencies: {
        createPostgresBackupOperator() {
          operatorCreated = true;
        }
      }
    }),
    { message: "local_backup_restore_host_refused" }
  );
  assert.equal(operatorCreated, false);
});

test("backup binding refuses wrong port, database, login or run marker before the operator", async () => {
  for (const override of [
    { port: "55433" },
    { database: "ia4tube_social_other" },
    { login: "ia4tube_social_other" },
    { runMarker: "ia4tube-social-3a0p-another-run-0001" }
  ]) {
    const config = backupConfig();
    let operatorCreated = false;
    await assert.rejects(
      runProfileBackup({
        approval: LOCAL_PHYSICAL_APPROVAL,
        runMarker,
        profileRows: profile0003.migrationRows,
        config,
        localBinding: { ...bindingFor(config), ...override },
        pool: { id: "backup" },
        runTool: async () => ({ code: 0 }),
        dependencies: {
          createPostgresBackupOperator() {
            operatorCreated = true;
          }
        }
      }),
      { message: "local_backup_target_invalid" }
    );
    assert.equal(operatorCreated, false);
  }
});

test("logical backup binding validates the exact TLS identity and closes runTool over the immutable binding", async () => {
  const config = logicalConfig("backup");
  const localBinding = logicalBindingFor(config);
  const calls = [];
  const plan = Object.freeze({ kind: "synthetic-logical-backup-plan" });
  const rawRunTool = async (...args) => {
    calls.push(args);
    return { code: 0, stdout: "", stderr: "" };
  };
  const result = await runProfileBackup({
    approval: LOCAL_PHYSICAL_APPROVAL,
    runMarker,
    profileRows: profile0003.migrationRows,
    config,
    localBinding,
    pool: { id: "logical-backup" },
    runTool: rawRunTool,
    dependencies: dependencies([], {
      async runLogicalBackup(options) {
        await options.runTool(plan);
        return backupResult();
      }
    }, profile0003)
  });
  assert.equal(result.profileId, profile0003.id);
  assert.equal(Object.isFrozen(localBinding), true);
  assert.deepEqual(calls, [[plan, localBinding]]);
});

test("logical restore binding closes runTool over the same immutable target binding", async () => {
  const events = [];
  const config = logicalConfig("restore");
  const localBinding = logicalBindingFor(config, "restore");
  const calls = [];
  const plan = Object.freeze({ kind: "synthetic-logical-restore-plan" });
  const result = await runProfileRestore(restoreRequest(profile0003, events, {
    config,
    localBinding,
    runTool: async (...args) => {
      calls.push(args);
      return { code: 0, stdout: "", stderr: "" };
    },
    dependencies: dependencies(events, {
      async runLogicalRestore(options) {
        await options.runTool(plan);
        return restoreResult();
      }
    })
  }));
  assert.equal(result.profileId, profile0003.id);
  assert.deepEqual(calls, [[plan, localBinding]]);
});

test("logical transport binding refuses every identity, transport and provenance mutation before the operator", async () => {
  const config = logicalConfig("backup");
  const exact = logicalBindingFor(config);
  const mutations = [
    { connectivityMode: "logical_dns_to_other_transport_v1" },
    { logicalHost: "127.0.0.1" },
    { logicalHost: "10.20.30.40" },
    { logicalHost: "localhost" },
    { logicalHost: "other.local.ia4tube.invalid" },
    { logicalHost: "database.staging.example" },
    { logicalHost: "database.production.example" },
    { logicalPort: 5433 },
    { physicalMode: "host_listener" },
    { physicalHost: "10.20.30.40" },
    { physicalPort: 5433 },
    { database: "ia4tube_social_other" },
    { login: "ia4tube_social_local_provisioner" },
    { runMarker: "ia4tube-social-3a0p-another-run-0001" },
    { targetFingerprint: "d".repeat(64) },
    { containerIdentityDigest: "not-a-sha256" },
    { containerIdentityDigest: "C".repeat(64) }
  ];
  for (const mutation of mutations) {
    let operatorCreated = false;
    await assert.rejects(runProfileBackup({
      approval: LOCAL_PHYSICAL_APPROVAL,
      runMarker,
      profileRows: profile0003.migrationRows,
      config,
      localBinding: Object.freeze({ ...exact, ...mutation }),
      pool: { id: "logical-binding-mutation" },
      runTool: async () => ({ code: 0 }),
      dependencies: {
        createPostgresBackupOperator() {
          operatorCreated = true;
        }
      }
    }), { code: "local_backup_target_invalid" });
    assert.equal(operatorCreated, false);
  }
  await assert.rejects(runProfileBackup({
    approval: LOCAL_PHYSICAL_APPROVAL,
    runMarker,
    profileRows: profile0003.migrationRows,
    config,
    localBinding: Object.freeze({ ...exact, unexpected: true }),
    pool: { id: "logical-binding-extra-key" },
    runTool: async () => ({ code: 0 })
  }), { code: "local_backup_target_invalid" });
  await assert.rejects(runProfileBackup({
    approval: LOCAL_PHYSICAL_APPROVAL,
    runMarker,
    profileRows: profile0003.migrationRows,
    config,
    localBinding: { ...exact },
    pool: { id: "logical-binding-not-frozen" },
    runTool: async () => ({ code: 0 })
  }), { code: "local_backup_target_invalid" });
});

test("logical config refuses host, port, fingerprint and TLS contract drift", async () => {
  const cases = [
    logicalConfig("backup", { public: { host: "127.0.0.1" } }),
    logicalConfig("backup", { public: { host: "10.20.30.40" } }),
    logicalConfig("backup", { public: { host: "localhost" } }),
    logicalConfig("backup", { public: { host: "other.local.ia4tube.invalid" } }),
    logicalConfig("backup", { public: { port: "5433" } }),
    logicalConfig("backup", { public: { database: "ia4tube_social_other" } }),
    logicalConfig("backup", { public: { login: "ia4tube_social_other" } }),
    logicalConfig("backup", { fingerprint: "d".repeat(64) }),
    logicalConfig("backup", { postgresTls: { servername: "other.local.ia4tube.invalid" } }),
    logicalConfig("backup", { postgresTls: { rejectUnauthorized: false } }),
    logicalConfig("backup", { postgresTls: { minVersion: "TLSv1.1" } }),
    logicalConfig("backup", { postgresTls: { checkServerIdentity: null } })
  ];
  for (const config of cases) {
    await assert.rejects(runProfileBackup({
      approval: LOCAL_PHYSICAL_APPROVAL,
      runMarker,
      profileRows: profile0003.migrationRows,
      config,
      localBinding: logicalBindingFor(logicalConfig("backup")),
      pool: { id: "logical-config-mutation" },
      runTool: async () => ({ code: 0 })
    }), { code: "local_backup_target_invalid" });
  }
});

test("logical restore still refuses source equals target and a non-disposable target", async () => {
  const equalConfig = logicalConfig("restore");
  equalConfig.sourceFingerprint = equalConfig.targetFingerprint;
  await assert.rejects(runProfileRestore(restoreRequest(profile0003, [], {
    config: equalConfig,
    localBinding: logicalBindingFor(equalConfig, "restore")
  })), { code: "local_restore_target_invalid" });

  const nonDisposable = logicalConfig("restore", {
    database: "ia4tube_social_local"
  });
  await assert.rejects(runProfileRestore(restoreRequest(profile0003, [], {
    config: nonDisposable,
    localBinding: logicalBindingFor(nonDisposable, "restore")
  })), { code: "local_restore_target_invalid" });
});

test("restore binding refuses a run marker different from its owned lifecycle", async () => {
  const request = restoreRequest(profile0003, []);
  await assert.rejects(
    runProfileRestore({
      ...request,
      localBinding: {
        ...request.localBinding,
        runMarker: "ia4tube-social-3a0p-another-run-0001"
      }
    }),
    { message: "local_restore_target_invalid" }
  );
});

for (const profile of [profile0003, profile0004, profile0005]) {
  test(`restore ${profile.id} creates, validates, and removes its disposable target`, async () => {
    const events = [];
    const result = await runProfileRestore(restoreRequest(profile, events));
    assert.equal(result.profileId, profile.id);
    assert.equal(result.disposableTargetRemoved, true);
    assert.deepEqual(events, [
      "create",
      "assert-created",
      ["operator", `restore-${profile.id}`],
      ["restore", `restore-${profile.id}`],
      "remove",
      "assert-removed"
    ]);
  });
}

test("restore 0003, 0004 and 0005 keep verifier state, pools, authorities, buffers, and cleanup independent", async () => {
  const specifications = [
    Object.freeze({
      profile: profile0003,
      database: "ia4tube_social_disposable_restore_0003_independent",
      authority: Object.freeze({
        activationMarkerGeneration: 0,
        activeOperationalKeyGeneration: null,
        randomCandidate: 1000000041
      })
    }),
    Object.freeze({
      profile: profile0004,
      database: "ia4tube_social_disposable_restore_0004_independent",
      authority: Object.freeze({
        activationMarkerGeneration: 3,
        activeOperationalKeyGeneration: 1900000000,
        randomCandidate: 1000000041
      })
    }),
    Object.freeze({
      profile: profile0005,
      database: "ia4tube_social_disposable_restore_0005_independent",
      authority: Object.freeze({
        activationMarkerGeneration: 4,
        activeOperationalKeyGeneration: 2000000000,
        randomCandidate: 1000000041
      })
    })
  ];
  const runs = [];

  for (const [index, specification] of specifications.entries()) {
    const { authority, database, profile } = specification;
    const events = [];
    const pool = Object.freeze({ id: `restore-${profile.id}-independent` });
    const registry = { profileId: profile.id, vaultVerified: false };
    const syntheticBuffer = Buffer.alloc(4, index + 1);
    const config = restoreConfig(database);
    const result = await runProfileRestore(restoreRequest(profile, events, {
      config,
      localBinding: bindingFor(config, "restore"),
      pool,
      lifecycle: lifecycle(profile.id, events, { database }),
      async verifyRuntimeIsolation() {
        events.push("runtime");
        return true;
      },
      async verifyVault() {
        events.push("vault");
        assert.equal(registry.profileId, profile.id);
        if (profile !== profile0003) {
          assert.ok(
            authority.activeOperationalKeyGeneration > authority.randomCandidate
          );
          assert.ok(
            authority.activationMarkerGeneration <
              authority.activeOperationalKeyGeneration
          );
        }
        registry.vaultVerified = true;
        return true;
      },
      async verify2ACompatibility() {
        events.push("2a");
        assert.equal(registry.vaultVerified, true);
        return true;
      },
      async verifyRestoredProfile() {
        events.push("profile");
        return profile;
      },
      async closeVerifiers() {
        events.push("close");
        syntheticBuffer.fill(0);
      },
      dependencies: dependencies(events, {
        async runLogicalRestore(options) {
          events.push(["restore", options.operator.pool.id]);
          assert.equal(await options.verifyRuntimeIsolation(), true);
          assert.equal(await options.verifyVault(), true);
          assert.equal(await options.verify2ACompatibility(), true);
          return restoreResult();
        }
      }, profile)
    }));

    assert.equal(result.profileId, profile.id);
    assert.equal(result.disposableTargetRemoved, true);
    assert.deepEqual(events, [
      "create",
      "assert-created",
      ["operator", pool.id],
      ["restore", pool.id],
      "runtime",
      "vault",
      "2a",
      "profile",
      "close",
      "remove",
      "assert-removed"
    ]);
    assert.deepEqual([...syntheticBuffer], [0, 0, 0, 0]);
    runs.push({ authority, pool, registry, syntheticBuffer });
  }

  for (let left = 0; left < runs.length; left += 1) {
    for (let right = left + 1; right < runs.length; right += 1) {
      assert.notEqual(runs[left].authority, runs[right].authority);
      assert.notEqual(runs[left].pool, runs[right].pool);
      assert.notEqual(runs[left].registry, runs[right].registry);
      assert.notEqual(runs[left].syntheticBuffer, runs[right].syntheticBuffer);
    }
  }
});

test("restore removes its disposable target after a runner failure", async () => {
  const events = [];
  const request = restoreRequest(profile0003, events, {
    dependencies: dependencies(events, {
      async runLogicalRestore() {
        events.push("restore-failed");
        throw new Error("synthetic failure");
      }
    })
  });
  await assert.rejects(
    runProfileRestore(request),
    { message: "local_restore_execution_failed" }
  );
  assert.deepEqual(events.slice(-3), [
    "restore-failed",
    "remove",
    "assert-removed"
  ]);
});

test("restore does not remove after partial creation without ownership proof", async () => {
  const events = [];
  const disposable = lifecycle(profile0003.id, events);
  disposable.create = async () => {
    events.push("create-failed");
    throw new Error("synthetic create failure");
  };
  await assert.rejects(
    runProfileRestore(restoreRequest(profile0003, events, {
      lifecycle: disposable
    })),
    { message: "local_restore_execution_failed" }
  );
  assert.deepEqual(events, ["create-failed", "reconcile-create"]);
});

test("restore reconciles an ambiguous create and removes only the owned target", async () => {
  const events = [];
  const disposable = lifecycle(profile0003.id, events, {
    async create() {
      events.push("create-response-lost");
      throw new Error("synthetic response loss");
    },
    async reconcileCreateFailure(identity) {
      events.push("reconcile-owned");
      return {
        ...identity,
        status: "owned",
        createdByThisRun: true
      };
    },
    async remove(proof) {
      events.push("remove-reconciled");
      assert.deepEqual(proof, ownershipProof(profile0003.id));
      return true;
    },
    async assertRemoved(proof) {
      events.push("assert-reconciled-removed");
      assert.deepEqual(proof, ownershipProof(profile0003.id));
      return true;
    }
  });
  await assert.rejects(
    runProfileRestore(restoreRequest(profile0003, events, {
      lifecycle: disposable
    })),
    { message: "local_restore_execution_failed" }
  );
  assert.deepEqual(events, [
    "create-response-lost",
    "reconcile-owned",
    "remove-reconciled",
    "assert-reconciled-removed"
  ]);
});

test("restore refuses mismatched create reconciliation without deleting a target", async () => {
  const events = [];
  const disposable = lifecycle(profile0003.id, events, {
    async create() {
      events.push("create-response-lost");
      throw new Error("synthetic response loss");
    },
    async reconcileCreateFailure(identity) {
      events.push("reconcile-wrong-target");
      return {
        ...identity,
        database: "ia4tube_social_disposable_other",
        status: "owned",
        createdByThisRun: true
      };
    },
    async remove() {
      events.push("must-not-remove");
      return true;
    }
  });
  await assert.rejects(
    runProfileRestore(restoreRequest(profile0003, events, {
      lifecycle: disposable
    })),
    (error) => {
      assert.equal(error.code, "local_restore_execution_failed");
      assert.equal(
        error.cleanupFailureCode,
        "local_backup_restore_create_reconciliation_invalid"
      );
      return true;
    }
  );
  assert.deepEqual(events, [
    "create-response-lost",
    "reconcile-wrong-target"
  ]);
});

test("restore does not remove a preexisting collision", async () => {
  const events = [];
  const disposable = lifecycle(profile0003.id, events, {
    async create() {
      events.push("collision");
      return {
        ...ownershipProof(profile0003.id),
        createdByThisRun: false
      };
    }
  });
  await assert.rejects(
    runProfileRestore(restoreRequest(profile0003, events, {
      lifecycle: disposable
    })),
    { message: "local_backup_restore_ownership_unconfirmed" }
  );
  assert.deepEqual(events, ["collision", "reconcile-create"]);
});

test("restore refuses a database different from its configured target", async () => {
  const events = [];
  const disposable = lifecycle(profile0003.id, events);
  disposable.database = "ia4tube_social_disposable_different";
  await assert.rejects(
    runProfileRestore(restoreRequest(profile0003, events, {
      lifecycle: disposable
    })),
    { message: "local_backup_restore_disposable_lifecycle_invalid" }
  );
  assert.deepEqual(events, []);
});

test("restore refuses a lifecycle from a different run marker", async () => {
  const events = [];
  const disposable = lifecycle(profile0003.id, events);
  disposable.runMarker = "ia4tube-social-3a0p-run-00000002";
  await assert.rejects(
    runProfileRestore(restoreRequest(profile0003, events, {
      lifecycle: disposable
    })),
    { message: "local_backup_restore_disposable_lifecycle_invalid" }
  );
  assert.deepEqual(events, []);
});

test("restore does not remove when creation proof names another database", async () => {
  const events = [];
  const disposable = lifecycle(profile0003.id, events, {
    async create() {
      events.push("wrong-proof");
      return ownershipProof(
        profile0003.id,
        "ia4tube_social_disposable_other"
      );
    }
  });
  await assert.rejects(
    runProfileRestore(restoreRequest(profile0003, events, {
      lifecycle: disposable
    })),
    { message: "local_backup_restore_ownership_unconfirmed" }
  );
  assert.deepEqual(events, ["wrong-proof", "reconcile-create"]);
});

test("restore preserves the primary failure and records cleanup failure separately", async () => {
  const events = [];
  const disposable = lifecycle(profile0003.id, events, {
    async remove() {
      events.push("remove-failed");
      return false;
    }
  });
  const request = restoreRequest(profile0003, events, {
    lifecycle: disposable,
    dependencies: dependencies(events, {
      async runLogicalRestore() {
        events.push("restore-failed");
        throw new Error("must-not-leak");
      }
    })
  });
  await assert.rejects(
    runProfileRestore(request),
    (error) => {
      assert.equal(error.code, "local_restore_execution_failed");
      assert.equal(
        error.cleanupFailureCode,
        "local_restore_disposable_remove_failed"
      );
      assert.equal(error.message.includes("must-not-leak"), false);
      return true;
    }
  );
  assert.deepEqual(events.slice(-2), ["restore-failed", "remove-failed"]);
});

test("restore rejects a different profile and still removes the target", async () => {
  const events = [];
  const request = restoreRequest(profile0003, events, {
    verifyRestoredProfile: async () => profile0004
  });
  await assert.rejects(
    runProfileRestore(request),
    { message: "local_backup_restore_cross_profile_refused" }
  );
  assert.deepEqual(events.slice(-2), ["remove", "assert-removed"]);
});

test("same-profile restore propagates relation-owner mismatch without classifying it as cross-profile success", async () => {
  const events = [];
  const ownerMismatch = Object.assign(
    new Error("synthetic relation-owner mismatch"),
    { code: "postgres_relation_owner_mismatch" }
  );
  await assert.rejects(
    runProfileRestore(restoreRequest(profile0004, events, {
      dependencies: dependencies(events, {
        async runLogicalRestore() {
          events.push("owner-mismatch");
          throw ownerMismatch;
        }
      })
    })),
    (error) => {
      assert.equal(error.code, "postgres_relation_owner_mismatch");
      assert.notEqual(
        error.code,
        "local_backup_restore_cross_profile_refused"
      );
      return true;
    }
  );
  assert.deepEqual(events.slice(-3), [
    "owner-mismatch",
    "remove",
    "assert-removed"
  ]);
});

test("restore refuses an unmarked target without creating it", async () => {
  const events = [];
  const invalid = lifecycle(profile0003.id, events);
  invalid.markedDisposable = false;
  await assert.rejects(
    runProfileRestore(restoreRequest(profile0003, events, {
      lifecycle: invalid
    })),
    { message: "local_backup_restore_disposable_lifecycle_invalid" }
  );
  assert.deepEqual(events, []);
});

test("forward-only rollback executes transactional, operational and reapply phases in order", async () => {
  const events = [];
  const result = await runForwardOnlyRollbackGate({
    approval: LOCAL_PHYSICAL_APPROVAL,
    host: EXACT_LOOPBACK_HOST,
    runMarker,
    adapter: rollbackAdapter(events)
  });
  assert.equal(result.ok, true);
  assert.equal(result.architecture, "forward-only");
  assert.equal(result.downMigrationCreated, false);
  assert.equal(result.transactionalRollbackVerified, true);
  assert.equal(result.operationalRestoreVerified, true);
  assert.equal(result.reapplyVerified, true);
  assert.deepEqual(events, [
    "captureCanonical0003",
    "applyControlledFailing0004",
    "verifyTransactionRollback",
    "compareCanonical0003",
    "backup0003",
    "apply0004",
    "createDisposable0003",
    "assertDisposable0003Created",
    "restore0003",
    "verifyRestored0003",
    "removeDisposable0003",
    "assertDisposable0003Removed",
    "reapply0004",
    "verify0004Checksum",
    "verifyProfile0004",
    "verifyNonSocialUnchanged"
  ]);
});

test("operational rollback removes the disposable target after restore failure", async () => {
  const events = [];
  const adapter = rollbackAdapter(events, {
    async restore0003() {
      events.push("restore0003");
      return false;
    }
  });
  await assert.rejects(
    runForwardOnlyRollbackGate({
      approval: LOCAL_PHYSICAL_APPROVAL,
      host: EXACT_LOOPBACK_HOST,
      runMarker,
      adapter
    }),
    { message: "local_rollback_restore_0003_failed" }
  );
  assert.equal(events.includes("removeDisposable0003"), true);
  assert.equal(events.includes("reapply0004"), false);
});

test("operational rollback does not remove a preexisting collision", async () => {
  const events = [];
  const adapter = rollbackAdapter(events, {
    async createDisposable0003() {
      events.push("collision");
      return {
        ...ownershipProof(
          profile0003.id,
          "ia4tube_social_disposable_rollback_0003"
        ),
        createdByThisRun: false
      };
    }
  });
  await assert.rejects(
    runForwardOnlyRollbackGate({
      approval: LOCAL_PHYSICAL_APPROVAL,
      host: EXACT_LOOPBACK_HOST,
      runMarker,
      adapter
    }),
    { message: "local_backup_restore_ownership_unconfirmed" }
  );
  assert.equal(events.includes("removeDisposable0003"), false);
  assert.equal(events.includes("reapply0004"), false);
});

test("operational rollback does not remove after partial creation without ownership proof", async () => {
  const events = [];
  const adapter = rollbackAdapter(events, {
    async createDisposable0003() {
      events.push("create-failed");
      throw new Error("partial creation without proof");
    }
  });
  await assert.rejects(
    runForwardOnlyRollbackGate({
      approval: LOCAL_PHYSICAL_APPROVAL,
      host: EXACT_LOOPBACK_HOST,
      runMarker,
      adapter
    }),
    { message: "local_rollback_operational_failed" }
  );
  assert.equal(events.includes("removeDisposable0003"), false);
  assert.equal(events.includes("reapply0004"), false);
});

test("operational rollback reconciles an ambiguous create and removes the owned target", async () => {
  const events = [];
  const disposableDatabase =
    "ia4tube_social_disposable_rollback_0003";
  const adapter = rollbackAdapter(events, {
    async createDisposable0003() {
      events.push("create-response-lost");
      throw new Error("synthetic response loss");
    },
    async reconcileDisposable0003CreateFailure(identity) {
      events.push("reconcile-owned");
      return {
        ...identity,
        status: "owned",
        createdByThisRun: true
      };
    },
    async removeDisposable0003(proof) {
      events.push("remove-reconciled");
      assert.deepEqual(
        proof,
        ownershipProof(profile0003.id, disposableDatabase)
      );
      return true;
    },
    async assertDisposable0003Removed(proof) {
      events.push("assert-reconciled-removed");
      assert.deepEqual(
        proof,
        ownershipProof(profile0003.id, disposableDatabase)
      );
      return true;
    }
  });
  await assert.rejects(
    runForwardOnlyRollbackGate({
      approval: LOCAL_PHYSICAL_APPROVAL,
      host: EXACT_LOOPBACK_HOST,
      runMarker,
      adapter
    }),
    { message: "local_rollback_operational_failed" }
  );
  assert.equal(events.includes("reconcile-owned"), true);
  assert.equal(events.includes("remove-reconciled"), true);
  assert.equal(events.includes("assert-reconciled-removed"), true);
  assert.equal(events.includes("reapply0004"), false);
});

test("operational rollback binds restore and verification to the same ownership proof", async () => {
  const events = [];
  const disposableDatabase =
    "ia4tube_social_disposable_rollback_0003";
  let restoreProof;
  let verifyProof;
  const adapter = rollbackAdapter(events, {
    async restore0003(proof) {
      events.push("restore0003");
      restoreProof = proof;
      return true;
    },
    async verifyRestored0003(proof) {
      events.push("verifyRestored0003");
      verifyProof = proof;
      return true;
    }
  });
  const result = await runForwardOnlyRollbackGate({
    approval: LOCAL_PHYSICAL_APPROVAL,
    host: EXACT_LOOPBACK_HOST,
    runMarker,
    adapter
  });
  assert.equal(result.ok, true);
  assert.equal(restoreProof, verifyProof);
  assert.deepEqual(
    restoreProof,
    ownershipProof(profile0003.id, disposableDatabase)
  );
});

test("operational rollback removes an owned target when post-create validation fails", async () => {
  const events = [];
  const adapter = rollbackAdapter(events, {
    async assertDisposable0003Created() {
      events.push("assertDisposable0003Created");
      return false;
    }
  });
  await assert.rejects(
    runForwardOnlyRollbackGate({
      approval: LOCAL_PHYSICAL_APPROVAL,
      host: EXACT_LOOPBACK_HOST,
      runMarker,
      adapter
    }),
    { message: "local_rollback_disposable_create_unconfirmed" }
  );
  assert.equal(events.includes("removeDisposable0003"), true);
  assert.equal(events.includes("assertDisposable0003Removed"), true);
  assert.equal(events.includes("reapply0004"), false);
});

test("operational rollback preserves primary and cleanup failures separately", async () => {
  const events = [];
  const adapter = rollbackAdapter(events, {
    async restore0003() {
      events.push("restore0003");
      return false;
    },
    async removeDisposable0003() {
      events.push("removeDisposable0003-failed");
      return false;
    }
  });
  await assert.rejects(
    runForwardOnlyRollbackGate({
      approval: LOCAL_PHYSICAL_APPROVAL,
      host: EXACT_LOOPBACK_HOST,
      runMarker,
      adapter
    }),
    (error) => {
      assert.equal(error.code, "local_rollback_restore_0003_failed");
      assert.equal(
        error.cleanupFailureCode,
        "local_rollback_disposable_remove_failed"
      );
      return true;
    }
  );
  assert.equal(events.includes("reapply0004"), false);
});

test("rollback refuses an external host before invoking an adapter", async () => {
  const events = [];
  await assert.rejects(
    runForwardOnlyRollbackGate({
      approval: LOCAL_PHYSICAL_APPROVAL,
      host: "db.example.test",
      runMarker,
      adapter: rollbackAdapter(events)
    }),
    { message: "local_backup_restore_host_refused" }
  );
  assert.deepEqual(events, []);
});

test("rollback is fail-closed when a required adapter is missing", async () => {
  await assert.rejects(
    runForwardOnlyRollbackGate({
      approval: LOCAL_PHYSICAL_APPROVAL,
      host: EXACT_LOOPBACK_HOST,
      runMarker,
      adapter: {}
    }),
    { message: "local_rollback_adapter_invalid" }
  );
});

test("rollback contract never treats absence of a down migration as a physical success", () => {
  assert.equal(ROLLBACK_MODEL.architecture, "forward-only");
  assert.equal(ROLLBACK_MODEL.downMigrationCreated, false);
  assert.equal(ROLLBACK_MODEL.transactional.length > 0, true);
  assert.equal(ROLLBACK_MODEL.operational.length > 0, true);
  assert.equal(ROLLBACK_MODEL.reapply.length > 0, true);
  assert.equal(WINDOWS_DURABILITY.directoryFsync, "physicalPendingLinux");
  assert.equal(WINDOWS_DURABILITY.noFollow, "physicalPendingLinux");
});
