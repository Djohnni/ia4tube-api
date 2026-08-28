"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  LOCAL_PHYSICAL_APPROVAL,
  runForwardOnlyRollbackGate,
  runProfileRestore
} = require("../scripts/social-3a0p-local-backup-restore");
const {
  MIGRATION_LOGIN,
  PROVISIONER_LOGIN,
  RUNTIME_LOGIN,
  WindowsPhysicalPlanFailure,
  assertLocalToolPlan,
  createDefaultRestoreBehaviorFacade,
  createLocalPgToolRunner,
  createProfile0003SocialRepositoryBridge,
  createWindowsPhysicalPlans,
  assertRestoreRequestProfileBinding,
  requireCanonicalSchemaProfile
} = require("../scripts/social-3a0p-local-windows-physical-plans");

const RUN_MARKER = "ia4tube-social-3a0p-physical-plan-test-0001";
const TARGET = Object.freeze({ host: "127.0.0.1", port: 55432 });
const OWNED_ROOT = path.resolve("C:\\synthetic-owned\\ia4tube-social-3a0p-plan-test");
const EXECUTABLES = Object.freeze({
  psql: path.join(OWNED_ROOT, "pgsql", "bin", "psql.exe"),
  pgDump: path.join(OWNED_ROOT, "pgsql", "bin", "pg_dump.exe"),
  pgRestore: path.join(OWNED_ROOT, "pgsql", "bin", "pg_restore.exe")
});

const CURRENT_SOCIAL_REPOSITORY_METHODS = Object.freeze([
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
const LEGACY_SOCIAL_REPOSITORY_METHODS = Object.freeze(
  CURRENT_SOCIAL_REPOSITORY_METHODS.filter(
    (name) => ![
      "findEncryptedCredentialForKeyRotation",
      "rotateEncryptedCredentialForKeyRotation"
    ].includes(name)
  )
);

function frozenMethodRepository(methodNames, calls, failures = {}) {
  const repository = {};
  for (const name of methodNames) {
    repository[name] = async (...args) => {
      calls.push(Object.freeze({ args, name }));
      if (failures[name]) throw failures[name];
      return Object.freeze({ name });
    };
  }
  return Object.freeze(repository);
}

function productPlan(overrides = {}) {
  return {
    executable: EXECUTABLES.psql,
    args: [
      "--no-password", "--no-psqlrc", "--set=ON_ERROR_STOP=1",
      "--set=VERBOSITY=terse", "--quiet", "--file=-"
    ],
    env: {
      SYSTEMROOT: "C:\\Windows",
      TEMP: "C:\\external-temp",
      TMP: "C:\\external-temp",
      TMPDIR: "C:\\external-temp",
      PGHOST: "127.0.0.1",
      PGPORT: "55432",
      PGDATABASE: "ia4tube_social_local",
      PGUSER: MIGRATION_LOGIN,
      PGPASSWORD: "synthetic-secret-that-is-at-least-32-bytes-long",
      PGCONNECT_TIMEOUT: "10",
      PGCHANNELBINDING: "disable",
      PGSSLMODE: "verify-full",
      PGSSLROOTCERT: "system",
      SSL_CERT_FILE: path.join(OWNED_ROOT, "postgres-system-roots.pem"),
      PGAPPNAME: "ia4tube-social-backup-restore"
    },
    input: "SELECT 1;",
    ...overrides
  };
}

function runnerFixture() {
  const calls = [];
  const processRunner = {
    async run(spec) {
      calls.push(spec);
      return {
        exitCode: 0,
        stdoutSanitized: "ok",
        stderrSanitized: ""
      };
    }
  };
  const runner = createLocalPgToolRunner({
    approval: LOCAL_PHYSICAL_APPROVAL,
    runMarker: RUN_MARKER,
    target: TARGET,
    ownedRoot: OWNED_ROOT,
    processRunner,
    executables: EXECUTABLES,
    allowedDatabases: () => new Set(["ia4tube_social_local"]),
    allowedLogins: [MIGRATION_LOGIN, PROVISIONER_LOGIN]
  });
  return { calls, runner };
}

function backupTransportFixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-social-backup-transport-test-"));
  const ownedRoot = path.join(root, "owned");
  fs.mkdirSync(ownedRoot);
  if (options.precreateBackupDirectory !== false) {
    fs.mkdirSync(path.join(ownedRoot, "backups"));
  }
  const productBackup = require("../src/persistence/postgres/backup-restore");
  const configLoads = [];
  const restoreConfigLoads = [];
  const runToolCalls = [];
  const pgDumpStarts = [];
  const processStarts = [];
  const databaseManager = {
    isAllowedDatabase() { return true; },
    getPools() { return { provisioner: {} }; },
    async create(identity) {
      return Object.freeze({ ...identity, createdByThisRun: true });
    },
    async reconcile(identity) {
      return Object.freeze({
        ...identity,
        createdByThisRun: false,
        status: "absent"
      });
    },
    async assertCreated() { return true; },
    async remove() { return true; },
    async assertRemoved() { return true; },
    async applyProfile() { return true; },
    async verifyProfile(_database, profileId) {
      return productBackup.SCHEMA_PROFILES.find(
        (profile) => profile.id === profileId
      );
    },
    async cleanupAll() {}
  };
  const backup = {
    ...productBackup,
    loadBackupConfig(environment, loadOptions) {
      const source = new URL(environment.SOCIAL_BACKUP_SOURCE_DATABASE_URL);
      const operator = new URL(environment.SOCIAL_BACKUP_OPERATOR_PROVISIONER_DATABASE_URL);
      const event = {
        sourceHost: source.hostname,
        sourcePort: source.port,
        sourceSslmode: source.searchParams.get("sslmode"),
        sourceExpectedHost: environment.SOCIAL_BACKUP_SOURCE_EXPECTED_HOST,
        operatorHost: operator.hostname,
        operatorPort: operator.port,
        operatorSslmode: operator.searchParams.get("sslmode"),
        operatorExpectedHost: environment.SOCIAL_BACKUP_OPERATOR_EXPECTED_HOST
      };
      configLoads.push(event);
      try {
        const config = productBackup.loadBackupConfig(environment, loadOptions);
        event.postgresTlsServername = config.postgresTls.servername;
        return config;
      } finally {
        Object.freeze(event);
      }
    },
    loadRestoreConfig(environment, loadOptions) {
      const target = new URL(environment.SOCIAL_RESTORE_TARGET_DATABASE_URL);
      const operator = new URL(environment.SOCIAL_RESTORE_OPERATOR_PROVISIONER_DATABASE_URL);
      const event = {
        targetHost: target.hostname,
        targetPort: target.port,
        targetSslmode: target.searchParams.get("sslmode"),
        targetExpectedHost: environment.SOCIAL_RESTORE_TARGET_EXPECTED_HOST,
        operatorHost: operator.hostname,
        operatorPort: operator.port,
        operatorSslmode: operator.searchParams.get("sslmode"),
        operatorExpectedHost: environment.SOCIAL_RESTORE_OPERATOR_EXPECTED_HOST
      };
      restoreConfigLoads.push(event);
      let placeholderCreated = false;
      try {
        if (!fs.existsSync(environment.SOCIAL_RESTORE_BUNDLE)) {
          fs.writeFileSync(environment.SOCIAL_RESTORE_BUNDLE, "", { flag: "wx", mode: 0o600 });
          placeholderCreated = true;
        }
        const config = productBackup.loadRestoreConfig(environment, loadOptions);
        event.postgresTlsServername = config.postgresTls.servername;
        return config;
      } finally {
        Object.freeze(event);
        if (placeholderCreated) fs.unlinkSync(environment.SOCIAL_RESTORE_BUNDLE);
      }
    },
    ...(options.backupOverrides || {})
  };
  const executables = Object.freeze({
    psql: path.join(ownedRoot, "pgsql", "bin", "psql.exe"),
    pgDump: path.join(ownedRoot, "pgsql", "bin", "pg_dump.exe"),
    pgRestore: path.join(ownedRoot, "pgsql", "bin", "pg_restore.exe")
  });
  const plans = createWindowsPhysicalPlans({
    approval: LOCAL_PHYSICAL_APPROVAL,
    runMarker: RUN_MARKER,
    target: { host: "127.0.0.1", port: 5432 },
    state: {
      target: { host: "127.0.0.1", port: 5432 },
      environmentId: "00000000-0000-4000-8000-000000000001",
      materials: {
        provisioner: Buffer.from("p".repeat(48)),
        migration: Buffer.from("m".repeat(48)),
        runtime: Buffer.from("r".repeat(48))
      }
    },
    paths: { ownedRoot },
    executables,
    processRunner: {
      async run(specification) {
        processStarts.push(specification);
        return { exitCode: 0, stdoutSanitized: "", stderrSanitized: "" };
      }
    },
    PoolClass: class {},
    repositoryRoot: path.resolve(__dirname, ".."),
    randomBytes: (size) => Buffer.alloc(size, 7),
    dependencies: {
      backup,
      databaseManager,
      async runTool(plan) {
        runToolCalls.push(plan);
        if (path.basename(String(plan?.executable || "")).toLowerCase().startsWith("pg_dump")) {
          pgDumpStarts.push(plan);
        }
        return { code: 0, stdout: "", stderr: "" };
      },
      ...(options.dependencies || {})
    },
    ...(options.planOptions || {})
  });
  return Object.freeze({
    backup,
    configLoads,
    executables,
    ownedRoot,
    pgDumpStarts,
    plans,
    processStarts,
    restoreConfigLoads,
    root,
    runToolCalls
  });
}

async function destroyBackupTransportFixture(fixture) {
  try {
    await fixture.plans.destroy();
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

function createLogicalBackupTransportBridge(contract) {
  return Object.freeze({
    localBinding: Object.freeze({
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
      containerIdentityDigest: "c".repeat(64)
    }),
    runTool: async () => ({ code: 0, stdout: "", stderr: "" })
  });
}

function successfulLogicalBackupResult() {
  return Object.freeze({
    ok: true,
    bundleFileFsyncConfirmed: true,
    bundleRoundTripVerified: true,
    bundleSize: 1,
    bundleSha256: "b".repeat(64),
    evidenceSha256: "e".repeat(64),
    plaintextArtifactsAbsent: true,
    temporaryWorkspaceCleanupConfirmed: true
  });
}

function successfulLogicalRestoreResult() {
  return Object.freeze({
    ok: true,
    evidenceSha256: "e".repeat(64),
    runtimeIsolation: true,
    vault: true,
    compatibleWith2A: true,
    plaintextArtifactsAbsent: true,
    temporaryWorkspaceCleanupConfirmed: true
  });
}

function provenanceDatabaseManager() {
  const pool = Object.freeze({
    async connect() {
      throw new Error("synthetic_pool_must_not_connect");
    }
  });
  const profiles = require("../src/persistence/postgres/backup-restore").SCHEMA_PROFILES;
  return Object.freeze({
    isAllowedDatabase() { return true; },
    getPools() { return { provisioner: pool, runtime: {} }; },
    async create(identity) {
      return Object.freeze({ ...identity, createdByThisRun: true });
    },
    async reconcile(identity) {
      return Object.freeze({ ...identity, status: "absent", createdByThisRun: false });
    },
    async assertCreated() { return true; },
    async remove() { return true; },
    async assertRemoved() { return true; },
    async applyProfile() { return true; },
    async verifyProfile(database, profileId) {
      return profiles.find((profile) => profile.id === profileId);
    },
    async catalogFingerprint() { return "catalog"; },
    async nonSocialFingerprint() { return "non-social"; },
    async cleanupAll() {}
  });
}

function provenanceRouterFixture({
  confirmRollbackRestore = false,
  executeRollbackRestore = false,
  failures = new Map()
} = {}) {
  const bindings = new WeakMap();
  const calls = [];
  function bind(kind, operation, request) {
    assert.equal(bindings.has(request), false);
    bindings.set(request, { consumed: false, kind, operation });
    return request;
  }
  async function run(kind, runner, request) {
    const binding = bindings.get(request);
    assert.ok(binding);
    assert.equal(binding.kind, kind);
    assert.equal(binding.consumed, false);
    binding.consumed = true;
    calls.push(Object.freeze({ kind, operation: binding.operation, runner, request }));
    const failure = failures.get(binding.operation);
    if (failure) throw failure;
    if (binding.operation === "rollback_backup_0003") {
      return successfulLogicalBackupResult();
    }
    if (binding.operation === "rollback_restore_0003") {
      if (executeRollbackRestore) return runner(request);
      if (confirmRollbackRestore) {
        await request.verifyRestoredProfile();
      }
      return successfulLogicalRestoreResult();
    }
    return runner(request);
  }
  const router = Object.freeze({
    bindBackup: (operation, request) => bind("backup", operation, request),
    bindRestore: (operation, request) => bind("restore", operation, request),
    runBackup: (runner, request) => run("backup", runner, request),
    runRestore: (runner, request) => run("restore", runner, request)
  });
  return { bindings, calls, router };
}

function profileAwareRestoreBehaviorFixture(options = {}) {
  const created = [];
  const operations = [];
  const closed = [];
  const instances = [];
  const schemaValidations = [];
  const facade = Object.freeze({
    createRestoreBehaviorVerifiers(configuration) {
      const profileId = configuration?.expectedProfileId;
      created.push(profileId);
      if (profileId === options.failCreateForProfileId) {
        throw Object.assign(new Error("synthetic_profile_verifier_failure"), {
          code: "synthetic_profile_verifier_failure"
        });
      }
      const authority = options.authorities?.[profileId]
        ? Object.freeze({ ...options.authorities[profileId] })
        : null;
      const instance = {
        authority,
        buffer: Buffer.alloc(4, instances.length + 1),
        pool: Object.freeze({ profileId }),
        profileId,
        registry: { profileId, vaultVerified: false }
      };
      instances.push(instance);
      return Object.freeze({
        async close() {
          closed.push(profileId);
          instance.buffer.fill(0);
          if (options.closeFailure) throw options.closeFailure;
        },
        verifiers: Object.freeze({
          async verifyRuntimeIsolation() {
            operations.push([profileId, "runtime"]);
            return true;
          },
          async verifyVault() {
            operations.push([profileId, "vault"]);
            if (
              authority &&
              authority.activeOperationalKeyGeneration !== null
            ) {
              assert.ok(
                authority.activeOperationalKeyGeneration >
                  authority.randomCandidate
              );
              assert.ok(
                authority.activationMarkerGeneration <
                  authority.activeOperationalKeyGeneration
              );
            }
            instance.registry.vaultVerified = true;
            return true;
          },
          async verify2ACompatibility() {
            operations.push([profileId, "2a"]);
            assert.equal(instance.registry.vaultVerified, true);
            return true;
          }
        })
      });
    },
    schemaProfileDiagnostics() {
      return null;
    },
    async verifyRuntimeSchemaForProfile(configuration) {
      schemaValidations.push(Object.freeze({ ...configuration }));
      return Object.freeze({ valid: true });
    }
  });
  return Object.freeze({
    closed,
    created,
    facade,
    instances,
    operations,
    schemaValidations
  });
}

function lazyRestoreOwnershipDatabaseManagerFixture(options = {}) {
  const events = options.events || [];
  const owned = new Set(["ia4tube_social_local"]);
  const profiles = require(
    "../src/persistence/postgres/backup-restore"
  ).SCHEMA_PROFILES;
  const calls = {
    allowed: [],
    assertedCreated: [],
    assertedRemoved: [],
    connections: 0,
    created: [],
    poolRequests: [],
    profileVerifications: [],
    queries: 0,
    reconciled: [],
    removed: []
  };
  const isRestoreTarget = (database) =>
    String(database).includes("_disposable_restore_");
  const provisionerPool = Object.freeze({
    async connect() {
      calls.connections += 1;
      throw Object.assign(new Error("synthetic_pool_must_not_connect"), {
        code: "synthetic_pool_must_not_connect"
      });
    }
  });
  const manager = Object.freeze({
    isAllowedDatabase(database) {
      calls.allowed.push(database);
      if (isRestoreTarget(database)) {
        events.push("verifier_ownership_checked");
      }
      return owned.has(database);
    },
    getPools(database) {
      calls.poolRequests.push(database);
      return Object.freeze({ provisioner: provisionerPool, runtime: {} });
    },
    async create(identity) {
      calls.created.push(identity.database);
      if (isRestoreTarget(identity.database)) {
        events.push("lifecycle_create_started");
        if (options.createFailure) throw options.createFailure;
      }
      owned.add(identity.database);
      if (isRestoreTarget(identity.database)) {
        events.push("lifecycle_create_completed");
      }
      return Object.freeze({
        createdByThisRun: true,
        database: identity.database,
        host: identity.host,
        profileId: identity.profileId,
        runMarker: identity.runMarker
      });
    },
    async reconcile(identity) {
      calls.reconciled.push(identity.database);
      const databaseOwned = owned.has(identity.database);
      return Object.freeze({
        createdByThisRun: databaseOwned,
        database: identity.database,
        host: identity.host,
        profileId: identity.profileId,
        runMarker: identity.runMarker,
        status: databaseOwned ? "owned" : "absent"
      });
    },
    async assertCreated(proof) {
      calls.assertedCreated.push(proof.database);
      if (isRestoreTarget(proof.database)) {
        events.push("lifecycle_assert_created");
        if (options.assertCreatedFailure) {
          throw options.assertCreatedFailure;
        }
        if (options.assertCreatedResult === false) return false;
      }
      return owned.has(proof.database);
    },
    async remove(proof) {
      calls.removed.push(proof.database);
      if (isRestoreTarget(proof.database)) events.push("lifecycle_remove");
      owned.delete(proof.database);
      return true;
    },
    async assertRemoved(proof) {
      calls.assertedRemoved.push(proof.database);
      if (isRestoreTarget(proof.database)) {
        events.push("lifecycle_assert_removed");
      }
      return !owned.has(proof.database);
    },
    async applyProfile() {
      return true;
    },
    async verifyProfile(database, profileId) {
      calls.profileVerifications.push([database, profileId]);
      if (isRestoreTarget(database) && options.profileValidationFailure) {
        throw options.profileValidationFailure;
      }
      return profiles.find((profile) => profile.id === profileId);
    },
    async catalogFingerprint() {
      return "synthetic-catalog";
    },
    async nonSocialFingerprint() {
      return "synthetic-non-social";
    },
    async cleanupAll() {
      for (const database of [...owned]) {
        if (database !== "ia4tube_social_local") owned.delete(database);
      }
    }
  });
  return Object.freeze({
    calls,
    forget(database) {
      owned.delete(database);
    },
    manager,
    owned
  });
}

function lazyRestoreBehaviorFixture(options = {}) {
  const events = options.events || [];
  const calls = {
    closed: [],
    created: [],
    poolConnections: 0,
    poolConstructions: [],
    poolQueries: 0,
    operations: []
  };
  class SyntheticVerifierPool {
    constructor(configuration) {
      calls.poolConstructions.push(Object.freeze({
        database: configuration.database,
        host: configuration.host,
        max: configuration.max,
        port: configuration.port,
        ssl: configuration.ssl,
        user: configuration.user
      }));
    }
    async connect() {
      calls.poolConnections += 1;
      throw Object.assign(new Error("synthetic_verifier_pool_must_not_connect"), {
        code: "synthetic_verifier_pool_must_not_connect"
      });
    }
    async end() {}
  }
  const verifierPoolOptions = (databaseUrl, max) => {
    const connection = new URL(databaseUrl);
    for (const key of [...connection.searchParams.keys()]) {
      connection.searchParams.delete(key);
    }
    return Object.freeze({
      connectionString: connection.toString(),
      max,
      min: 0,
      ssl: Object.freeze({
        checkServerIdentity() {},
        minVersion: "TLSv1.2",
        rejectUnauthorized: true,
        servername: "local.ia4tube.invalid"
      })
    });
  };
  const facade = Object.freeze({
    createRestoreBehaviorVerifiers(configuration) {
      const migrationTarget = new URL(configuration.migrationDatabaseUrl);
      const database = decodeURIComponent(migrationTarget.pathname.slice(1));
      const profileId = configuration.expectedProfileId;
      calls.created.push(Object.freeze({ database, profileId }));
      events.push("verifier_created");
      if (options.createFailure) throw options.createFailure;
      const PoolClass = configuration.dependencies.PoolClass;
      new PoolClass(verifierPoolOptions(
        configuration.migrationDatabaseUrl,
        1
      ));
      new PoolClass(verifierPoolOptions(
        configuration.runtimeDatabaseUrl,
        2
      ));
      let closed = false;
      const operation = async (name, event, failure) => {
        calls.operations.push([database, profileId, name]);
        events.push(event);
        if (failure) throw failure;
        return true;
      };
      return Object.freeze({
        async close() {
          if (closed) return;
          closed = true;
          calls.closed.push([database, profileId]);
          events.push("verifier_closed");
          if (options.closeFailure) throw options.closeFailure;
        },
        verifiers: Object.freeze({
          verifyRuntimeIsolation: () => operation(
            "runtime",
            "runtime_isolation",
            options.runtimeFailure
          ),
          verifyVault: () => operation("vault", "vault", options.vaultFailure),
          verify2ACompatibility: () => operation(
            "2a",
            "compatibility_2a",
            options.compatibilityFailure
          )
        })
      });
    },
    schemaProfileDiagnostics() {
      return null;
    },
    async verifyRuntimeSchemaForProfile() {
      return Object.freeze({ valid: true });
    }
  });
  return Object.freeze({ calls, facade, PoolClass: SyntheticVerifierPool });
}

function lazyRestoreOwnershipPlanFixture(options = {}) {
  const events = options.events || [];
  const ownership = lazyRestoreOwnershipDatabaseManagerFixture({
    events,
    ...(options.database || {})
  });
  const behavior = lazyRestoreBehaviorFixture({
    events,
    ...(options.behavior || {})
  });
  const fixture = backupTransportFixture({
    precreateBackupDirectory: false,
    dependencies: {
      createBackupTransportBridge: createLogicalBackupTransportBridge,
      databaseManager: ownership.manager,
      restoreBehavior: behavior.facade
    },
    planOptions: { PoolClass: behavior.PoolClass }
  });
  return Object.freeze({ behavior, events, fixture, ownership });
}

test("schema profile selection returns only the exact canonical frozen profile", () => {
  const profiles = require("../src/persistence/postgres/backup-restore").SCHEMA_PROFILES;
  assert.equal(
    requireCanonicalSchemaProfile(profiles, "social-schema-0003"),
    profiles[0]
  );
  assert.equal(
    requireCanonicalSchemaProfile(profiles, "social-schema-0004"),
    profiles[1]
  );
  assert.equal(
    requireCanonicalSchemaProfile(profiles, "social-schema-0005"),
    profiles[2]
  );
  for (const [candidate, profileId] of [
    [profiles, "social-schema-unknown"],
    [[...profiles], "social-schema-0003"],
    [Object.freeze([profiles[0], profiles[0]]), "social-schema-0003"],
    [Object.freeze([Object.freeze({ id: "social-schema-0003" })]), "social-schema-0003"],
    [Object.freeze([{ ...profiles[0] }, profiles[1]]), "social-schema-0003"],
    [profiles, " social-schema-0003"]
  ]) {
    assert.throws(
      () => requireCanonicalSchemaProfile(candidate, profileId),
      {
        code: "windows_physical_schema_profile_invalid",
        name: "WindowsPhysicalPlanFailure"
      }
    );
  }
});

test("optional backup/restore provenance dependency requires the exact four-method router API", async () => {
  const base = {
    approval: LOCAL_PHYSICAL_APPROVAL,
    runMarker: RUN_MARKER,
    target: TARGET,
    state: {
      target: TARGET,
      materials: {},
      environmentId: "00000000-0000-4000-8000-000000000001"
    },
    paths: { ownedRoot: OWNED_ROOT },
    executables: EXECUTABLES,
    processRunner: { async run() { throw new Error("must_not_spawn"); } },
    PoolClass: class {},
    repositoryRoot: path.resolve(__dirname, ".."),
    randomBytes: (size) => Buffer.alloc(size, 7)
  };
  const databaseManager = provenanceDatabaseManager();
  for (const candidate of [
    null,
    {},
    { bindBackup() {}, bindRestore() {}, runBackup() {} },
    { bindBackup() {}, bindRestore() {}, runRestore() {} },
    { bindBackup: true, bindRestore() {}, runBackup() {}, runRestore() {} },
    { bindBackup() {}, bindRestore: true, runBackup() {}, runRestore() {} },
    { bindBackup() {}, bindRestore() {}, runBackup: true, runRestore() {} },
    { bindBackup() {}, bindRestore() {}, runBackup() {}, runRestore: true },
    { bindBackup() {}, bindRestore() {}, runBackup() {}, runRestore() {}, extra() {} },
    Object.assign(Object.create(null), {
      bindBackup() {},
      bindRestore() {},
      runBackup() {},
      runRestore() {}
    })
  ]) {
    assert.throws(
      () => createWindowsPhysicalPlans({
        ...base,
        dependencies: {
          databaseManager,
          runTool: async () => ({ code: 0 }),
          backupRestoreProvenance: candidate
        }
      }),
      {
        code: "windows_physical_backup_restore_provenance_invalid",
        name: "WindowsPhysicalPlanFailure"
      }
    );
  }

  const plans = createWindowsPhysicalPlans({
    ...base,
    dependencies: {
      databaseManager,
      runTool: async () => ({ code: 0 }),
      backupRestoreProvenance: provenanceRouterFixture().router
    }
  });
  await plans.destroy();
});

function defaultRestoreBehaviorFacadeFixture(options = {}) {
  const calls = {
    created: [],
    currentRepositoryFactory: [],
    currentRepositoryMethods: [],
    currentSchema: [],
    legacyRepositoryFactory: [],
    legacyRepositoryMethods: [],
    legacyLoad: [],
    legacySchema: []
  };
  const currentRepository = options.currentRepository || frozenMethodRepository(
    CURRENT_SOCIAL_REPOSITORY_METHODS,
    calls.currentRepositoryMethods,
    options.currentRepositoryFailures
  );
  const legacyRepository = options.legacyRepository || frozenMethodRepository(
    LEGACY_SOCIAL_REPOSITORY_METHODS,
    calls.legacyRepositoryMethods,
    options.legacyRepositoryFailures
  );
  const currentSocialRepository = Object.freeze({
    createSocialRepository(repositoryOptions) {
      calls.currentRepositoryFactory.push(repositoryOptions);
      return currentRepository;
    }
  });
  const legacy = Object.freeze({
    createCompanyScopedRepository() {},
    createSocialCredentialService() {},
    createSocialRepository(repositoryOptions) {
      calls.legacyRepositoryFactory.push(repositoryOptions);
      return legacyRepository;
    },
    createSocialVault() {},
    verifyRuntimeRole() {},
    async verifyRuntimeSchema(...args) {
      calls.legacySchema.push(args);
      if (options.legacySchemaFailure) throw options.legacySchemaFailure;
      return Object.freeze({ valid: true, profile: "0003" });
    }
  });
  const loaderFailure = options.loaderFailure;
  const restoreBehavior = Object.freeze({
    loadLegacy2ADependencies(root) {
      calls.legacyLoad.push(root);
      if (loaderFailure) throw loaderFailure;
      return legacy;
    },
    createRestoreBehaviorVerifiers(configuration) {
      calls.created.push(configuration);
      return Object.freeze({ configuration });
    }
  });
  const runtimeValidation = Object.freeze({
    async verifyRuntimeSchema(...args) {
      calls.currentSchema.push(args);
      if (options.currentSchemaFailure) throw options.currentSchemaFailure;
      return Object.freeze({ valid: true, profile: "0004" });
    }
  });
  const schemaProfiles = require(
    "../src/persistence/postgres/backup-restore"
  ).SCHEMA_PROFILES;
  const legacy2ARoot = path.resolve(
    "C:\\synthetic-legacy\\social-checkpoint-2a-postgres-vault-20260729"
  );
  const facade = createDefaultRestoreBehaviorFacade({
    currentSocialRepository,
    restoreBehavior,
    runtimeValidation,
    schemaProfiles,
    legacy2ARoot
  });
  return Object.freeze({
    calls,
    currentRepository,
    currentSocialRepository,
    facade,
    legacy,
    legacyRepository,
    legacy2ARoot
  });
}

test("default Windows restore facade binds legacy 0003, historical 0004 and current 0005 into both schema slots", async () => {
  const fixture = defaultRestoreBehaviorFacadeFixture();
  const PoolClass = class SyntheticPool {};
  const profile0003 = fixture.facade.createRestoreBehaviorVerifiers({
    expectedProfileId: "social-schema-0003",
    env: { SOCIAL_SCHEMA_PROFILE: "social-schema-0004" },
    dependencies: { PoolClass }
  }).configuration;
  const profile0004 = fixture.facade.createRestoreBehaviorVerifiers({
    expectedProfileId: "social-schema-0004",
    env: { SOCIAL_SCHEMA_PROFILE: "social-schema-0003" },
    dependencies: { PoolClass }
  }).configuration;
  const profile0005 = fixture.facade.createRestoreBehaviorVerifiers({
    expectedProfileId: "social-schema-0005",
    env: { SOCIAL_SCHEMA_PROFILE: "social-schema-0003" },
    dependencies: { PoolClass }
  }).configuration;

  assert.equal(fixture.calls.legacyLoad.length, 1);
  assert.equal(fixture.calls.legacyLoad[0], fixture.legacy2ARoot);
  assert.equal(Object.hasOwn(profile0003, "expectedProfileId"), false);
  assert.equal(Object.hasOwn(profile0004, "expectedProfileId"), false);
  assert.equal(Object.hasOwn(profile0005, "expectedProfileId"), false);
  assert.equal(profile0003.legacy2ARoot, fixture.legacy2ARoot);
  assert.equal(profile0004.legacy2ARoot, fixture.legacy2ARoot);
  assert.equal(profile0005.legacy2ARoot, fixture.legacy2ARoot);
  assert.equal(profile0003.dependencies.PoolClass, PoolClass);
  assert.equal(profile0004.dependencies.PoolClass, PoolClass);
  assert.equal(profile0005.dependencies.PoolClass, PoolClass);
  assert.equal(
    profile0003.dependencies.verifyRuntimeSchema,
    profile0003.legacyDependencies.verifyRuntimeSchema
  );
  assert.equal(
    profile0004.dependencies.verifyRuntimeSchema,
    profile0004.legacyDependencies.verifyRuntimeSchema
  );
  assert.equal(
    profile0005.dependencies.verifyRuntimeSchema,
    profile0005.legacyDependencies.verifyRuntimeSchema
  );
  for (const operation of [
    "createCompanyScopedRepository",
    "createSocialCredentialService",
    "createSocialRepository",
    "createSocialVault",
    "verifyRuntimeRole"
  ]) {
    assert.equal(profile0003.legacyDependencies[operation], fixture.legacy[operation]);
    assert.equal(profile0004.legacyDependencies[operation], fixture.legacy[operation]);
    assert.equal(profile0005.legacyDependencies[operation], fixture.legacy[operation]);
  }

  const observed0004 = Object.freeze({ observedProfile: "0004" });
  await profile0003.dependencies.verifyRuntimeSchema(
    observed0004,
    "synthetic_runtime"
  );
  await profile0003.legacyDependencies.verifyRuntimeSchema(
    observed0004,
    "synthetic_runtime"
  );
  assert.equal(fixture.calls.legacySchema.length, 2);
  assert.equal(fixture.calls.currentSchema.length, 0);

  const observed0003 = Object.freeze({ observedProfile: "0003" });
  await profile0004.dependencies.verifyRuntimeSchema(
    observed0003,
    "synthetic_runtime"
  );
  await profile0004.legacyDependencies.verifyRuntimeSchema(
    observed0003,
    "synthetic_runtime"
  );
  assert.equal(fixture.calls.legacySchema.length, 2);
  assert.equal(fixture.calls.currentSchema.length, 2);
  assert.equal(
    fixture.calls.currentSchema[0][2].expectedMigrationRows,
    require("../src/persistence/postgres/backup-restore").SCHEMA_PROFILES[1].migrationRows
  );

  await profile0005.dependencies.verifyRuntimeSchema(
    observed0003,
    "synthetic_runtime"
  );
  await profile0005.legacyDependencies.verifyRuntimeSchema(
    observed0003,
    "synthetic_runtime"
  );
  assert.equal(fixture.calls.currentSchema.length, 4);
  assert.equal(
    fixture.calls.currentSchema[2][2].expectedMigrationRows,
    require("../src/persistence/postgres/backup-restore").SCHEMA_PROFILES[2].migrationRows
  );

  await fixture.facade.verifyRuntimeSchemaForProfile({
    expectedProfileId: "social-schema-0004",
    pool: observed0003,
    role: "synthetic_runtime"
  });
  assert.equal(fixture.calls.currentSchema.length, 5);
  assert.equal(fixture.facade.schemaProfileDiagnostics(), null);
});

test("default Windows restore facade binds the 0003 repository bridge and leaves 0004/0005 current by identity", () => {
  const fixture = defaultRestoreBehaviorFacadeFixture();
  const profile0003 = fixture.facade.createRestoreBehaviorVerifiers({
    expectedProfileId: "social-schema-0003",
    dependencies: { PoolClass: class SyntheticPool0003 {} }
  }).configuration;
  const profile0004 = fixture.facade.createRestoreBehaviorVerifiers({
    expectedProfileId: "social-schema-0004",
    dependencies: { PoolClass: class SyntheticPool0004 {} }
  }).configuration;
  const profile0005 = fixture.facade.createRestoreBehaviorVerifiers({
    expectedProfileId: "social-schema-0005",
    dependencies: { PoolClass: class SyntheticPool0005 {} }
  }).configuration;

  assert.equal(
    profile0004.dependencies.createSocialRepository,
    fixture.currentSocialRepository.createSocialRepository
  );
  assert.equal(
    profile0005.dependencies.createSocialRepository,
    fixture.currentSocialRepository.createSocialRepository
  );
  assert.notEqual(
    profile0003.dependencies.createSocialRepository,
    fixture.currentSocialRepository.createSocialRepository
  );

  const repositoryOptions = Object.freeze({
    identityDerivationVersion: "v1",
    pool: Object.freeze({ connect() {} }),
    runtimeRole: "ia4tube_social_runtime"
  });
  const bridge = profile0003.dependencies.createSocialRepository(
    repositoryOptions
  );
  assert.equal(Object.getPrototypeOf(bridge), Object.prototype);
  assert.equal(Object.isFrozen(bridge), true);
  assert.deepEqual(
    Reflect.ownKeys(bridge).sort(),
    [...CURRENT_SOCIAL_REPOSITORY_METHODS].sort()
  );
  assert.equal(
    bridge.findEncryptedCredential,
    fixture.legacyRepository.findEncryptedCredential
  );
  for (const name of CURRENT_SOCIAL_REPOSITORY_METHODS) {
    const descriptor = Object.getOwnPropertyDescriptor(bridge, name);
    assert.equal(descriptor.enumerable, true);
    assert.equal(descriptor.configurable, false);
    assert.equal(descriptor.writable, false);
    assert.equal(typeof descriptor.value, "function");
    if (name !== "findEncryptedCredential") {
      assert.equal(bridge[name], fixture.currentRepository[name]);
    }
  }
  assert.deepEqual(fixture.calls.currentRepositoryFactory, [repositoryOptions]);
  assert.deepEqual(fixture.calls.legacyRepositoryFactory, [repositoryOptions]);
  assert.equal(
    profile0003.legacyDependencies.createSocialRepository,
    fixture.legacy.createSocialRepository
  );
  assert.equal(
    profile0004.legacyDependencies.createSocialRepository,
    fixture.legacy.createSocialRepository
  );
  assert.equal(
    profile0005.legacyDependencies.createSocialRepository,
    fixture.legacy.createSocialRepository
  );

  const current0004 = profile0004.dependencies.createSocialRepository(
    repositoryOptions
  );
  assert.equal(current0004, fixture.currentRepository);
  const current0005 = profile0005.dependencies.createSocialRepository(
    repositoryOptions
  );
  assert.equal(current0005, fixture.currentRepository);
  assert.deepEqual(
    fixture.calls.currentRepositoryFactory,
    [repositoryOptions, repositoryOptions, repositoryOptions]
  );
  assert.deepEqual(fixture.calls.legacyRepositoryFactory, [repositoryOptions]);
});

test("profile 0003 repository bridge refuses every non-closed repository shape", () => {
  const current = frozenMethodRepository(
    CURRENT_SOCIAL_REPOSITORY_METHODS,
    []
  );
  const legacy = frozenMethodRepository(
    LEGACY_SOCIAL_REPOSITORY_METHODS,
    []
  );
  const malformed = (repository) => {
    const nullPrototype = Object.assign(Object.create(null), repository);
    const withSymbol = { ...repository };
    withSymbol[Symbol("hidden_repository")] = async () => undefined;
    const withGetter = { ...repository };
    Object.defineProperty(withGetter, "findEncryptedCredential", {
      configurable: true,
      enumerable: true,
      get() {
        return repository.findEncryptedCredential;
      }
    });
    const missing = { ...repository };
    delete missing.findEncryptedCredential;
    return [
      { ...repository },
      Object.freeze(nullPrototype),
      Object.freeze({ ...repository, unexpectedMethod: async () => undefined }),
      Object.freeze(withSymbol),
      Object.freeze(withGetter),
      Object.freeze(missing),
      Object.freeze({ ...repository, findEncryptedCredential: true })
    ];
  };

  for (const candidate of malformed(current)) {
    assert.throws(
      () => createProfile0003SocialRepositoryBridge(candidate, legacy),
      {
        code: "windows_physical_current_social_repository_invalid",
        name: "WindowsPhysicalPlanFailure"
      }
    );
  }
  for (const candidate of malformed(legacy)) {
    assert.throws(
      () => createProfile0003SocialRepositoryBridge(current, candidate),
      {
        code: "windows_physical_2a_social_repository_invalid",
        name: "WindowsPhysicalPlanFailure"
      }
    );
  }
});

test("profile-bound repository reads propagate their selected error without fallback", async () => {
  const legacyFailure = Object.assign(new Error("legacy_read_failed"), {
    code: "42703"
  });
  const profile0003 = defaultRestoreBehaviorFacadeFixture({
    legacyRepositoryFailures: { findEncryptedCredential: legacyFailure }
  });
  const selected0003 = profile0003.facade.createRestoreBehaviorVerifiers({
    expectedProfileId: "social-schema-0003"
  }).configuration.dependencies.createSocialRepository({});
  await assert.rejects(
    selected0003.findEncryptedCredential({}),
    (error) => error === legacyFailure
  );
  assert.deepEqual(
    profile0003.calls.legacyRepositoryMethods.map(({ name }) => name),
    ["findEncryptedCredential"]
  );
  assert.deepEqual(profile0003.calls.currentRepositoryMethods, []);

  const currentFailure = Object.assign(new Error("current_read_failed"), {
    code: "42703"
  });
  const profile0004 = defaultRestoreBehaviorFacadeFixture({
    currentRepositoryFailures: { findEncryptedCredential: currentFailure }
  });
  const selected0004 = profile0004.facade.createRestoreBehaviorVerifiers({
    expectedProfileId: "social-schema-0004"
  }).configuration.dependencies.createSocialRepository({});
  await assert.rejects(
    selected0004.findEncryptedCredential({}),
    (error) => error === currentFailure
  );
  assert.deepEqual(
    profile0004.calls.currentRepositoryMethods.map(({ name }) => name),
    ["findEncryptedCredential"]
  );
  assert.deepEqual(profile0004.calls.legacyRepositoryFactory, []);
  assert.deepEqual(profile0004.calls.legacyRepositoryMethods, []);
});

test("default Windows repository selection refuses unknown profiles and caller factories before creation", () => {
  const fixture = defaultRestoreBehaviorFacadeFixture();
  assert.throws(
    () => fixture.facade.createRestoreBehaviorVerifiers({
      expectedProfileId: "social-schema-unknown",
      dependencies: { PoolClass: class SyntheticPool {} }
    }),
    {
      code: "windows_physical_schema_profile_invalid",
      name: "WindowsPhysicalPlanFailure"
    }
  );
  assert.throws(
    () => fixture.facade.createRestoreBehaviorVerifiers({
      expectedProfileId: "social-schema-0003",
      dependencies: {
        createSocialRepository() {
          throw new Error("caller_factory_must_not_run");
        }
      }
    }),
    {
      code: "windows_physical_restore_behavior_options_invalid",
      name: "WindowsPhysicalPlanFailure"
    }
  );
  assert.deepEqual(fixture.calls.created, []);
  assert.deepEqual(fixture.calls.legacyLoad, []);
  assert.deepEqual(fixture.calls.currentRepositoryFactory, []);
  assert.deepEqual(fixture.calls.legacyRepositoryFactory, []);
});

test("default Windows restore facade treats a validated legacy loader failure as terminal without fallback", () => {
  const loaderFailure = Object.assign(new Error("synthetic_loader_failure"), {
    code: "restore_behavior_2a_source_hash_mismatch"
  });
  const fixture = defaultRestoreBehaviorFacadeFixture({ loaderFailure });
  for (const profileId of [
    "social-schema-0003",
    "social-schema-0004",
    "social-schema-0005"
  ]) {
    assert.throws(
      () => fixture.facade.createRestoreBehaviorVerifiers({
        expectedProfileId: profileId,
        dependencies: { PoolClass: class SyntheticPool {} }
      }),
      (error) => error === loaderFailure
    );
  }
  assert.equal(fixture.calls.legacyLoad.length, 1);
  assert.equal(fixture.calls.created.length, 0);
  assert.equal(fixture.calls.currentSchema.length, 0);
  assert.equal(fixture.calls.legacySchema.length, 0);
});

test("restore ownership check exists once inside the first lazy get without retry", () => {
  const source = fs.readFileSync(
    path.resolve(
      __dirname,
      "../scripts/social-3a0p-local-windows-physical-plans.js"
    ),
    "utf8"
  );
  const start = source.indexOf(
    "function restoreVerifiers(database, expectedProfileId, ownershipLatch)"
  );
  const end = source.indexOf("function ensurePlanDirectories()", start);
  assert.ok(start >= 0);
  assert.ok(end > start);
  const body = source.slice(start, end);
  const ownershipChecks = body.match(
    /databaseManager\.isAllowedDatabase\(database\)/gu
  ) || [];
  assert.equal(ownershipChecks.length, 1);
  assert.ok(body.indexOf("const get = () =>") < body.indexOf(ownershipChecks[0]));
  assert.ok(
    body.indexOf(ownershipChecks[0]) <
      body.indexOf("requireRestoreBehaviorFacade(restoreBehavior)")
  );
  assert.match(body, /ownershipLatch\.isConfirmed\(\) !== true/u);
  assert.doesNotMatch(body, /\b(?:retry|setTimeout|setInterval|sleep)\b/iu);
  assert.doesNotMatch(body, /owned\.add/u);
});

test("Gate 5 restore ownership is lazy, assertion-latched and isolated per request", async () => {
  const item = lazyRestoreOwnershipPlanFixture();
  try {
    const prepared = await item.fixture.plans.prepareBackupRestore();
    const request0003 = prepared.restore0003;
    const request0004 = prepared.restore0004;
    const database0003 = request0003.lifecycle.database;
    const database0004 = request0004.lifecycle.database;
    assert.match(database0003, /_disposable_restore_0003_[0-9a-f]{12}$/u);
    assert.match(database0004, /_disposable_restore_0004_[0-9a-f]{12}$/u);
    assert.notEqual(database0003, database0004);
    assert.equal(item.ownership.owned.has(database0003), false);
    assert.equal(item.ownership.owned.has(database0004), false);
    assert.deepEqual(
      item.ownership.calls.allowed.filter((database) =>
        [database0003, database0004].includes(database)),
      []
    );
    assert.deepEqual(item.behavior.calls.created, []);
    assert.deepEqual(item.behavior.calls.poolConstructions, []);
    assert.equal(item.behavior.calls.poolConnections, 0);
    assert.equal(item.behavior.calls.poolQueries, 0);
    assert.equal(item.ownership.calls.connections, 0);
    assert.equal(item.ownership.calls.queries, 0);
    assert.equal(item.fixture.processStarts.length, 0);
    assert.equal(item.fixture.runToolCalls.length, 0);
    assert.equal(item.fixture.pgDumpStarts.length, 0);

    await assert.rejects(
      request0003.verifyRuntimeIsolation(),
      {
        code: "windows_physical_verifier_database_refused",
        name: "WindowsPhysicalPlanFailure"
      }
    );
    assert.deepEqual(item.behavior.calls.created, []);
    assert.deepEqual(item.behavior.calls.poolConstructions, []);

    const identity0003 = {
      database: request0003.lifecycle.database,
      host: request0003.lifecycle.host,
      profileId: request0003.lifecycle.profileId,
      runMarker: request0003.lifecycle.runMarker
    };
    const targetCreateCallsBefore = item.ownership.calls.created.length;
    for (const candidate of [
      { ...identity0003, database: "arbitrary_database" },
      { ...identity0003, database: `${database0003}_similar` },
      { ...identity0003, profileId: "social-schema-0004" },
      {
        ...identity0003,
        runMarker: "ia4tube-social-3a0p-physical-plan-other-run-0001"
      }
    ]) {
      await assert.rejects(
        Promise.resolve().then(() => request0003.lifecycle.create(candidate)),
        {
          code: "windows_physical_database_identity_invalid",
          name: "WindowsPhysicalPlanFailure"
        }
      );
    }
    assert.equal(
      item.ownership.calls.created.length,
      targetCreateCallsBefore
    );

    const proof0003 = await request0003.lifecycle.create(identity0003);
    assert.equal(item.ownership.owned.has(database0003), true);
    assert.equal(item.ownership.owned.has(database0004), false);
    await assert.rejects(
      request0003.verifyRuntimeIsolation(),
      { code: "windows_physical_verifier_database_refused" }
    );
    assert.deepEqual(item.behavior.calls.created, []);
    assert.deepEqual(item.behavior.calls.poolConstructions, []);
    assert.deepEqual(
      item.ownership.calls.allowed.filter((database) =>
        database === database0003),
      []
    );

    assert.equal(await request0003.lifecycle.assertCreated(proof0003), true);
    assert.equal(await request0003.verifyRuntimeIsolation(), true);
    assert.equal(await request0003.verifyVault(), true);
    assert.equal(await request0003.verify2ACompatibility(), true);
    assert.equal(item.behavior.calls.created.length, 1);
    assert.deepEqual(item.behavior.calls.created[0], {
      database: database0003,
      profileId: "social-schema-0003"
    });
    assert.deepEqual(
      item.ownership.calls.allowed.filter((database) =>
        database === database0003),
      [database0003]
    );
    assert.equal(item.behavior.calls.poolConstructions.length, 2);
    assert.deepEqual(
      item.behavior.calls.poolConstructions.map((pool) => [
        pool.database,
        pool.user,
        pool.max,
        pool.host,
        pool.port,
        pool.ssl
      ]),
      [
        [database0003, MIGRATION_LOGIN, 1, "127.0.0.1", 5432, false],
        [database0003, RUNTIME_LOGIN, 2, "127.0.0.1", 5432, false]
      ]
    );
    assert.equal(item.behavior.calls.poolConnections, 0);
    assert.equal(item.behavior.calls.poolQueries, 0);
    assert.equal(item.ownership.calls.connections, 0);
    assert.equal(item.ownership.calls.queries, 0);
    await request0003.closeVerifiers();
    await request0003.closeVerifiers();
    assert.deepEqual(item.behavior.calls.closed, [
      [database0003, "social-schema-0003"]
    ]);
    await assert.rejects(
      request0003.verifyVault(),
      { code: "windows_physical_restore_verifier_closed" }
    );

    const identity0004 = {
      database: request0004.lifecycle.database,
      host: request0004.lifecycle.host,
      profileId: request0004.lifecycle.profileId,
      runMarker: request0004.lifecycle.runMarker
    };
    let proof0004 = await request0004.lifecycle.create(identity0004);
    assert.equal(await request0004.lifecycle.assertCreated(proof0004), true);
    assert.equal(await request0004.lifecycle.remove(proof0004), true);
    await assert.rejects(
      request0004.verifyRuntimeIsolation(),
      { code: "windows_physical_verifier_database_refused" }
    );
    assert.equal(item.behavior.calls.created.length, 1);
    assert.equal(item.behavior.calls.poolConstructions.length, 2);
    assert.equal(await request0004.lifecycle.assertRemoved(proof0004), true);

    proof0004 = await request0004.lifecycle.create(identity0004);
    assert.equal(await request0004.lifecycle.assertCreated(proof0004), true);
    item.ownership.forget(database0004);
    await assert.rejects(
      request0004.verifyRuntimeIsolation(),
      { code: "windows_physical_verifier_database_refused" }
    );
    assert.equal(item.behavior.calls.created.length, 1);
    assert.equal(item.behavior.calls.poolConstructions.length, 2);

    proof0004 = await request0004.lifecycle.create(identity0004);
    await assert.rejects(
      request0004.verifyRuntimeIsolation(),
      { code: "windows_physical_verifier_database_refused" }
    );
    assert.equal(item.behavior.calls.created.length, 1);
    assert.equal(item.behavior.calls.poolConstructions.length, 2);
    assert.equal(await request0004.lifecycle.assertCreated(proof0004), true);
    assert.equal(await request0004.verifyRuntimeIsolation(), true);
    assert.equal(item.behavior.calls.created.length, 2);
    assert.deepEqual(
      item.behavior.calls.created.map((created) => created.database),
      [database0003, database0004]
    );
    assert.equal(item.behavior.calls.poolConstructions.length, 4);
    await request0004.closeVerifiers();
    assert.equal(item.behavior.calls.closed.length, 2);
    assert.equal(await request0003.lifecycle.remove(proof0003), true);
    assert.equal(await request0003.lifecycle.assertRemoved(proof0003), true);
    assert.equal(await request0004.lifecycle.remove(proof0004), true);
    assert.equal(await request0004.lifecycle.assertRemoved(proof0004), true);
  } finally {
    await destroyBackupTransportFixture(item.fixture);
  }
});

test("restore request profile binding requires exact canonical identities in both directions", () => {
  const profiles = require(
    "../src/persistence/postgres/backup-restore"
  ).SCHEMA_PROFILES;
  const [profile0003, profile0004, profile0005] = profiles;
  const sourcePlan = (profile) => Object.freeze({ profile });

  for (const profile of profiles) {
    const binding = assertRestoreRequestProfileBinding(
      profiles,
      sourcePlan(profile),
      profile
    );
    assert.equal(Object.isFrozen(binding), true);
    assert.equal(binding.sourceProfile, profile);
    assert.equal(binding.expectedProfile, profile);
  }

  for (const [sourceProfile, expectedProfile] of [
    [profile0003, profile0004],
    [profile0003, profile0005],
    [profile0004, profile0003],
    [profile0004, profile0005],
    [profile0005, profile0003],
    [profile0005, profile0004]
  ]) {
    assert.throws(
      () => assertRestoreRequestProfileBinding(
        profiles,
        sourcePlan(sourceProfile),
        expectedProfile
      ),
      {
        code: "local_backup_restore_cross_profile_refused",
        name: "LocalBackupRestoreFailure"
      }
    );
  }

  for (const candidate of [
    undefined,
    null,
    Object.freeze({}),
    Object.freeze({ profile: undefined }),
    Object.freeze({ profile: Object.freeze({ ...profile0003 }) })
  ]) {
    assert.throws(
      () => assertRestoreRequestProfileBinding(
        profiles,
        candidate,
        profile0003
      ),
      {
        code: "windows_physical_restore_source_plan_invalid",
        name: "WindowsPhysicalPlanFailure"
      }
    );
  }

  for (const candidate of [
    undefined,
    null,
    Object.freeze({ ...profile0003 }),
    Object.freeze({ id: "social-schema-unknown" })
  ]) {
    assert.throws(
      () => assertRestoreRequestProfileBinding(
        profiles,
        sourcePlan(profile0003),
        candidate
      ),
      {
        code: "windows_physical_restore_request_invalid",
        name: "WindowsPhysicalPlanFailure"
      }
    );
  }
});

test("restore request binds profiles before transport, configuration, lifecycle and verifiers", () => {
  const source = fs.readFileSync(
    path.resolve(
      __dirname,
      "../scripts/social-3a0p-local-windows-physical-plans.js"
    ),
    "utf8"
  ).replace(/\r\n/gu, "\n");
  const start = source.indexOf("  function restoreRequest(");
  const end = source.indexOf("  async function createRollbackAdapter()", start);
  assert.ok(start >= 0);
  assert.ok(end > start);
  const restoreRequest = source.slice(start, end);
  const binding = restoreRequest.indexOf(
    "assertRestoreRequestProfileBinding("
  );
  const transport = restoreRequest.indexOf(
    "requireBackupTransport(targetDatabase)"
  );
  const environment = restoreRequest.indexOf("connectionEnvironment(");
  const configuration = restoreRequest.indexOf("backup.loadRestoreConfig(");
  const latch = restoreRequest.indexOf(
    "createRestoreVerifierOwnershipLatch()"
  );
  const lifecycle = restoreRequest.indexOf("lifecycle(");
  const verifiers = restoreRequest.indexOf("restoreVerifiers(");
  const pools = restoreRequest.indexOf("databaseManager.getPools(");
  assert.ok(binding >= 0);
  assert.ok(transport > binding);
  assert.ok(environment > transport);
  assert.ok(configuration > environment);
  assert.ok(latch > configuration);
  assert.ok(lifecycle > latch);
  assert.ok(verifiers > lifecycle);
  assert.ok(pools > verifiers);
});

test("runtime relation inventories remain exact for historical 0003/0004 and current 0005", () => {
  const backup = require("../src/persistence/postgres/backup-restore");
  const runtime = require("../src/persistence/postgres/runtime-validation");
  const [profile0003, profile0004, profile0005] = backup.SCHEMA_PROFILES;
  const profile0003Relations = new Set([
    ...profile0003.rlsTables,
    "runtime_schema_contract"
  ]);
  const profile0004Relations = new Set([
    ...profile0004.rlsTables,
    "runtime_schema_contract"
  ]);
  const profile0005Relations = new Set([
    ...profile0005.rlsTables,
    "runtime_schema_contract"
  ]);
  const missingFrom0003 = [...profile0004Relations]
    .filter((relation) => !profile0003Relations.has(relation));

  assert.equal(profile0003Relations.size, 13);
  assert.equal(profile0004Relations.size, 16);
  assert.equal(profile0005Relations.size, 16);
  assert.deepEqual(missingFrom0003, [
    "social_idempotency_operations",
    "social_publications",
    "social_publication_attempts"
  ]);
  assert.deepEqual(runtime.TENANT_TABLES, profile0004.rlsTables);
  assert.deepEqual(runtime.TENANT_TABLES, profile0005.rlsTables);
  assert.deepEqual([...profile0005Relations], [...profile0004Relations]);

  const source = fs.readFileSync(
    path.resolve(__dirname, "../src/persistence/postgres/runtime-validation.js"),
    "utf8"
  ).replace(/\r\n/gu, "\n");
  assert.match(source, /\.\.\.TENANT_TABLES\.map\(\(table\) => \[table, "r"\]\)/u);
  assert.match(source, /entry\.owner_name !== ownerRole/u);
  assert.match(
    source,
    /tables\.rows\?\.length !== TENANT_TABLES\.length/u
  );
});

test("closing a prepared Gate 5 restore before first use remains connection-free", async () => {
  const item = lazyRestoreOwnershipPlanFixture();
  try {
    const prepared = await item.fixture.plans.prepareBackupRestore();
    const request = prepared.restore0004;
    const database = request.lifecycle.database;
    await request.closeVerifiers();
    await request.closeVerifiers();
    assert.deepEqual(item.behavior.calls.created, []);
    assert.deepEqual(item.behavior.calls.closed, []);
    assert.deepEqual(item.behavior.calls.poolConstructions, []);
    assert.equal(item.behavior.calls.poolConnections, 0);
    assert.equal(item.ownership.calls.connections, 0);
    assert.deepEqual(
      item.ownership.calls.allowed.filter((candidate) =>
        candidate === database),
      []
    );
    await assert.rejects(
      request.verifyRuntimeIsolation(),
      {
        code: "windows_physical_restore_verifier_closed",
        name: "WindowsPhysicalPlanFailure"
      }
    );
    assert.deepEqual(item.behavior.calls.created, []);
  } finally {
    await destroyBackupTransportFixture(item.fixture);
  }
});

test("synthetic profile restore orders ownership before one lazy verifier gate", async () => {
  const events = [];
  const item = lazyRestoreOwnershipPlanFixture({ events });
  try {
    const prepared = await item.fixture.plans.prepareBackupRestore();
    const request = prepared.restore0003;
    events.push("request_prepared");
    const evidence = await runProfileRestore({
      ...request,
      dependencies: {
        createPostgresBackupOperator() {
          return Object.freeze({ synthetic: true });
        },
        async runLogicalRestore(configuration) {
          events.push("restore_started");
          events.push("restore_completed");
          events.push("profile_validation_completed");
          assert.equal(await configuration.verifyRuntimeIsolation(), true);
          assert.equal(await configuration.verifyVault(), true);
          assert.equal(await configuration.verify2ACompatibility(), true);
          return successfulLogicalRestoreResult();
        }
      }
    });
    assert.equal(evidence.profileId, "social-schema-0003");
    assert.deepEqual(events, [
      "request_prepared",
      "lifecycle_create_started",
      "lifecycle_create_completed",
      "lifecycle_assert_created",
      "restore_started",
      "restore_completed",
      "profile_validation_completed",
      "verifier_ownership_checked",
      "verifier_created",
      "runtime_isolation",
      "vault",
      "compatibility_2a",
      "verifier_closed",
      "lifecycle_remove",
      "lifecycle_assert_removed"
    ]);
    assert.equal(item.behavior.calls.created.length, 1);
    assert.equal(item.behavior.calls.poolConstructions.length, 2);
    assert.equal(item.behavior.calls.poolConnections, 0);
    assert.equal(item.behavior.calls.poolQueries, 0);
    assert.equal(item.ownership.calls.connections, 0);
    assert.equal(item.ownership.calls.queries, 0);
    assert.equal(item.ownership.owned.has(request.lifecycle.database), false);
  } finally {
    await destroyBackupTransportFixture(item.fixture);
  }
});

test("restore verifier construction stays absent across every earlier failure boundary", async (t) => {
  const operatorDependencies = (runLogicalRestore) => ({
    createPostgresBackupOperator() {
      return Object.freeze({ synthetic: true });
    },
    runLogicalRestore
  });

  await t.test("lifecycle create failure", async () => {
    const failure = Object.assign(new Error("not persisted"), {
      code: "synthetic_lifecycle_create_failure"
    });
    const item = lazyRestoreOwnershipPlanFixture({
      database: { createFailure: failure }
    });
    try {
      const prepared = await item.fixture.plans.prepareBackupRestore();
      await assert.rejects(
        runProfileRestore({
          ...prepared.restore0003,
          dependencies: operatorDependencies(async () => {
            throw new Error("restore_must_not_start");
          })
        }),
        { code: failure.code }
      );
      assert.deepEqual(item.behavior.calls.created, []);
      assert.deepEqual(item.behavior.calls.poolConstructions, []);
      assert.equal(item.behavior.calls.poolConnections, 0);
    } finally {
      await destroyBackupTransportFixture(item.fixture);
    }
  });

  await t.test("assertCreated false", async () => {
    const item = lazyRestoreOwnershipPlanFixture({
      database: { assertCreatedResult: false }
    });
    try {
      const prepared = await item.fixture.plans.prepareBackupRestore();
      await assert.rejects(
        runProfileRestore({
          ...prepared.restore0003,
          dependencies: operatorDependencies(async () => {
            throw new Error("restore_must_not_start");
          })
        }),
        { code: "local_restore_disposable_create_unconfirmed" }
      );
      assert.deepEqual(item.behavior.calls.created, []);
      assert.deepEqual(item.behavior.calls.poolConstructions, []);
      assert.equal(item.behavior.calls.poolConnections, 0);
    } finally {
      await destroyBackupTransportFixture(item.fixture);
    }
  });

  await t.test("assertCreated exception remains exact and cannot arm ownership", async () => {
    const failure = Object.assign(new Error("not persisted"), {
      code: "synthetic_assert_created_failure"
    });
    const item = lazyRestoreOwnershipPlanFixture({
      database: { assertCreatedFailure: failure }
    });
    try {
      const prepared = await item.fixture.plans.prepareBackupRestore();
      const request = prepared.restore0003;
      const identity = {
        database: request.lifecycle.database,
        host: request.lifecycle.host,
        profileId: request.lifecycle.profileId,
        runMarker: request.lifecycle.runMarker
      };
      const proof = await request.lifecycle.create(identity);
      await assert.rejects(
        request.lifecycle.assertCreated(proof),
        (error) => error === failure && error.code === failure.code
      );
      await assert.rejects(
        request.verifyRuntimeIsolation(),
        { code: "windows_physical_verifier_database_refused" }
      );
      assert.deepEqual(item.behavior.calls.created, []);
      assert.deepEqual(item.behavior.calls.poolConstructions, []);
      assert.equal(item.behavior.calls.poolConnections, 0);
      assert.equal(await request.lifecycle.remove(proof), true);
      assert.equal(await request.lifecycle.assertRemoved(proof), true);
    } finally {
      await destroyBackupTransportFixture(item.fixture);
    }
  });

  await t.test("physical restore failure", async () => {
    const failure = Object.assign(new Error("not persisted"), {
      code: "synthetic_physical_restore_failure"
    });
    const item = lazyRestoreOwnershipPlanFixture();
    try {
      const prepared = await item.fixture.plans.prepareBackupRestore();
      await assert.rejects(
        runProfileRestore({
          ...prepared.restore0003,
          dependencies: operatorDependencies(async () => {
            throw failure;
          })
        }),
        { code: failure.code }
      );
      assert.deepEqual(item.behavior.calls.created, []);
      assert.deepEqual(item.behavior.calls.poolConstructions, []);
      assert.equal(item.behavior.calls.poolConnections, 0);
    } finally {
      await destroyBackupTransportFixture(item.fixture);
    }
  });

  await t.test("restored profile validation failure", async () => {
    const failure = Object.assign(new Error("not persisted"), {
      code: "synthetic_profile_validation_failure"
    });
    const item = lazyRestoreOwnershipPlanFixture({
      database: { profileValidationFailure: failure }
    });
    try {
      const prepared = await item.fixture.plans.prepareBackupRestore();
      await assert.rejects(
        runProfileRestore({
          ...prepared.restore0003,
          dependencies: operatorDependencies(async () =>
            successfulLogicalRestoreResult())
        }),
        { code: failure.code }
      );
      assert.deepEqual(item.behavior.calls.created, []);
      assert.deepEqual(item.behavior.calls.poolConstructions, []);
      assert.equal(item.behavior.calls.poolConnections, 0);
    } finally {
      await destroyBackupTransportFixture(item.fixture);
    }
  });

  await t.test("facade failure after ownership preserves its identity", async () => {
    const failure = Object.assign(new Error("not persisted"), {
      code: "synthetic_restore_facade_failure"
    });
    const item = lazyRestoreOwnershipPlanFixture({
      behavior: { createFailure: failure }
    });
    try {
      const prepared = await item.fixture.plans.prepareBackupRestore();
      const request = prepared.restore0003;
      const identity = {
        database: request.lifecycle.database,
        host: request.lifecycle.host,
        profileId: request.lifecycle.profileId,
        runMarker: request.lifecycle.runMarker
      };
      const proof = await request.lifecycle.create(identity);
      assert.equal(await request.lifecycle.assertCreated(proof), true);
      await assert.rejects(
        request.verifyRuntimeIsolation(),
        (error) => error === failure
      );
      assert.equal(item.behavior.calls.created.length, 1);
      assert.deepEqual(item.behavior.calls.poolConstructions, []);
      assert.equal(item.behavior.calls.poolConnections, 0);
      await request.closeVerifiers();
      assert.equal(await request.lifecycle.remove(proof), true);
      assert.equal(await request.lifecycle.assertRemoved(proof), true);
    } finally {
      await destroyBackupTransportFixture(item.fixture);
    }
  });

  await t.test("same-profile owner mismatch propagates and cannot be masked by close failure", async () => {
    const primary = Object.assign(new Error("not persisted"), {
      code: "postgres_relation_owner_mismatch"
    });
    const cleanup = Object.assign(new Error("not persisted"), {
      code: "synthetic_verifier_close_failure"
    });
    const item = lazyRestoreOwnershipPlanFixture({
      behavior: { closeFailure: cleanup, runtimeFailure: primary }
    });
    try {
      const prepared = await item.fixture.plans.prepareBackupRestore();
      await assert.rejects(
        runProfileRestore({
          ...prepared.restore0003,
          dependencies: operatorDependencies(async (configuration) => {
            await configuration.verifyRuntimeIsolation();
            throw new Error("unreachable");
          })
        }),
        (error) =>
          error.code === primary.code &&
          error.cleanupFailureCode === cleanup.code
      );
      assert.equal(item.behavior.calls.created.length, 1);
      assert.equal(item.behavior.calls.closed.length, 1);
      assert.equal(item.behavior.calls.poolConstructions.length, 2);
      assert.equal(item.behavior.calls.poolConnections, 0);
    } finally {
      await destroyBackupTransportFixture(item.fixture);
    }
  });
});

test("Gate 5 restore verifiers bind 0003, 0004 and 0005 across runtime, vault and 2A and close once", async () => {
  const behavior = profileAwareRestoreBehaviorFixture();
  const fixture = backupTransportFixture({
    precreateBackupDirectory: false,
    dependencies: {
      createBackupTransportBridge: createLogicalBackupTransportBridge,
      restoreBehavior: behavior.facade
    }
  });
  try {
    const prepared = await fixture.plans.prepareBackupRestore();
    for (const [request, profileId] of [
      [prepared.restore0003, "social-schema-0003"],
      [prepared.restore0004, "social-schema-0004"],
      [prepared.restore0005, "social-schema-0005"]
    ]) {
      const identity = {
        database: request.lifecycle.database,
        host: request.lifecycle.host,
        profileId: request.lifecycle.profileId,
        runMarker: request.lifecycle.runMarker
      };
      const proof = await request.lifecycle.create(identity);
      assert.equal(await request.lifecycle.assertCreated(proof), true);
      assert.equal(await request.verifyRuntimeIsolation(), true);
      assert.equal(await request.verifyVault(), true);
      assert.equal(await request.verify2ACompatibility(), true);
      await request.closeVerifiers();
      await request.closeVerifiers();
      await assert.rejects(
        Promise.resolve().then(() => request.verifyRuntimeIsolation()),
        {
          code: "windows_physical_restore_verifier_closed",
          name: "WindowsPhysicalPlanFailure"
        }
      );
      assert.equal(request.expectedProfile.id, profileId);
      assert.equal(await request.lifecycle.remove(proof), true);
      assert.equal(await request.lifecycle.assertRemoved(proof), true);
    }
    assert.deepEqual(behavior.created, [
      "social-schema-0003",
      "social-schema-0004",
      "social-schema-0005"
    ]);
    assert.deepEqual(behavior.operations, [
      ["social-schema-0003", "runtime"],
      ["social-schema-0003", "vault"],
      ["social-schema-0003", "2a"],
      ["social-schema-0004", "runtime"],
      ["social-schema-0004", "vault"],
      ["social-schema-0004", "2a"],
      ["social-schema-0005", "runtime"],
      ["social-schema-0005", "vault"],
      ["social-schema-0005", "2a"]
    ]);
    assert.deepEqual(behavior.closed, [
      "social-schema-0003",
      "social-schema-0004",
      "social-schema-0005"
    ]);
  } finally {
    await destroyBackupTransportFixture(fixture);
  }
});

test("Gate 5 executes independent 0003, 0004 and current 0005 restore verifier sequences through cleanup", async () => {
  const authorities = Object.freeze({
    "social-schema-0003": Object.freeze({
      activationMarkerGeneration: 0,
      activeOperationalKeyGeneration: null,
      randomCandidate: 1000000041
    }),
    "social-schema-0004": Object.freeze({
      activationMarkerGeneration: 3,
      activeOperationalKeyGeneration: 1900000000,
      randomCandidate: 1000000041
    }),
    "social-schema-0005": Object.freeze({
      activationMarkerGeneration: 4,
      activeOperationalKeyGeneration: 2000000000,
      randomCandidate: 1000000041
    })
  });
  const behavior = profileAwareRestoreBehaviorFixture({ authorities });
  const fixture = backupTransportFixture({
    precreateBackupDirectory: false,
    dependencies: {
      createBackupTransportBridge: createLogicalBackupTransportBridge,
      restoreBehavior: behavior.facade
    }
  });
  const routeOperations = [];
  try {
    const prepared = await fixture.plans.prepareBackupRestore();
    const requests = [
      [prepared.restore0003, "social-schema-0003"],
      [prepared.restore0004, "social-schema-0004"],
      [prepared.restore0005, "social-schema-0005"]
    ];
    assert.equal(new Set(requests.map(([request]) => request.pool)).size, 3);
    assert.equal(
      new Set(requests.map(([request]) => request.lifecycle.database)).size,
      3
    );

    for (const [request, profileId] of requests) {
      const result = await runProfileRestore({
        ...request,
        dependencies: {
          createPostgresBackupOperator(pool) {
            return Object.freeze({ pool });
          },
          async runLogicalRestore(configuration) {
            routeOperations.push([profileId, "transport"]);
            assert.equal(await configuration.verifyRuntimeIsolation(), true);
            assert.equal(await configuration.verifyVault(), true);
            assert.equal(await configuration.verify2ACompatibility(), true);
            return successfulLogicalRestoreResult();
          }
        }
      });
      assert.equal(result.profileId, profileId);
      assert.equal(result.disposableTargetRemoved, true);
      routeOperations.push([profileId, "cleanup"]);
    }

    assert.deepEqual(routeOperations, [
      ["social-schema-0003", "transport"],
      ["social-schema-0003", "cleanup"],
      ["social-schema-0004", "transport"],
      ["social-schema-0004", "cleanup"],
      ["social-schema-0005", "transport"],
      ["social-schema-0005", "cleanup"]
    ]);
    assert.deepEqual(behavior.created, [
      "social-schema-0003",
      "social-schema-0004",
      "social-schema-0005"
    ]);
    assert.deepEqual(behavior.operations, [
      ["social-schema-0003", "runtime"],
      ["social-schema-0003", "vault"],
      ["social-schema-0003", "2a"],
      ["social-schema-0004", "runtime"],
      ["social-schema-0004", "vault"],
      ["social-schema-0004", "2a"],
      ["social-schema-0005", "runtime"],
      ["social-schema-0005", "vault"],
      ["social-schema-0005", "2a"]
    ]);
    assert.deepEqual(behavior.closed, [
      "social-schema-0003",
      "social-schema-0004",
      "social-schema-0005"
    ]);
    assert.equal(behavior.instances.length, 3);
    for (let left = 0; left < behavior.instances.length; left += 1) {
      assert.deepEqual([...behavior.instances[left].buffer], [0, 0, 0, 0]);
      for (let right = left + 1; right < behavior.instances.length; right += 1) {
        assert.notEqual(behavior.instances[left].authority, behavior.instances[right].authority);
        assert.notEqual(behavior.instances[left].registry, behavior.instances[right].registry);
        assert.notEqual(behavior.instances[left].pool, behavior.instances[right].pool);
        assert.notEqual(behavior.instances[left].buffer, behavior.instances[right].buffer);
      }
    }
    assert.deepEqual(
      behavior.instances[1].authority,
      authorities["social-schema-0004"]
    );
    assert.deepEqual(
      behavior.instances[2].authority,
      authorities["social-schema-0005"]
    );
    assert.equal(fixture.processStarts.length, 0);
    assert.equal(fixture.runToolCalls.length, 0);
  } finally {
    await destroyBackupTransportFixture(fixture);
  }
});

test("profile verifier creation failure never falls back from current 0005", async () => {
  const behavior = profileAwareRestoreBehaviorFixture({
    failCreateForProfileId: "social-schema-0005"
  });
  const fixture = backupTransportFixture({
    precreateBackupDirectory: false,
    dependencies: {
      createBackupTransportBridge: createLogicalBackupTransportBridge,
      restoreBehavior: behavior.facade
    }
  });
  try {
    const prepared = await fixture.plans.prepareBackupRestore();
    const request = prepared.restore0005;
    const identity = {
      database: request.lifecycle.database,
      host: request.lifecycle.host,
      profileId: request.lifecycle.profileId,
      runMarker: request.lifecycle.runMarker
    };
    const proof = await request.lifecycle.create(identity);
    assert.equal(await request.lifecycle.assertCreated(proof), true);
    await assert.rejects(
      Promise.resolve().then(() =>
        request.verifyRuntimeIsolation()
      ),
      { code: "synthetic_profile_verifier_failure" }
    );
    assert.deepEqual(behavior.created, ["social-schema-0005"]);
    assert.deepEqual(behavior.operations, []);
    assert.deepEqual(behavior.closed, []);
    await request.closeVerifiers();
    assert.equal(await request.lifecycle.remove(proof), true);
    assert.equal(await request.lifecycle.assertRemoved(proof), true);
  } finally {
    await destroyBackupTransportFixture(fixture);
  }
});

test("rollback wires 0003 and requires the current 0004 schema verifier after reapply", async () => {
  const behavior = profileAwareRestoreBehaviorFixture();
  const runtimePool = Object.freeze({ kind: "synthetic-runtime-pool" });
  const events = [];
  const profiles = require("../src/persistence/postgres/backup-restore").SCHEMA_PROFILES;
  const databaseManager = {
    isAllowedDatabase() { return true; },
    getPools(database) {
      events.push(["get-pools", database]);
      return { provisioner: {}, runtime: runtimePool };
    },
    async applyProfile(database, profileId) {
      events.push(["apply", database, profileId]);
      return true;
    },
    async verifyProfile(database, profileId) {
      events.push(["verify-profile", database, profileId]);
      return profiles.find((profile) => profile.id === profileId);
    },
    async cleanupAll() {
      events.push(["cleanup"]);
    }
  };
  const fixture = backupTransportFixture({
    dependencies: {
      databaseManager,
      restoreBehavior: behavior.facade
    }
  });
  try {
    const rollback = await fixture.plans.createRollbackAdapter();
    assert.equal(await rollback.reapply0004(), true);
    assert.equal(await rollback.verify0004Checksum(), true);
    assert.equal(await rollback.verifyProfile0004(), true);
    assert.deepEqual(
      events.filter(([event]) => event === "apply" || event === "verify-profile")
        .map(([event, , profileId]) => [event, profileId]),
      [
        ["apply", "social-schema-0004"],
        ["verify-profile", "social-schema-0004"],
        ["verify-profile", "social-schema-0004"]
      ]
    );
    assert.equal(behavior.schemaValidations.length, 1);
    assert.deepEqual(
      Object.keys(behavior.schemaValidations[0]).sort(),
      ["expectedProfileId", "pool", "role"]
    );
    assert.equal(
      behavior.schemaValidations[0].expectedProfileId,
      "social-schema-0004"
    );
    assert.equal(behavior.schemaValidations[0].pool, runtimePool);
    assert.equal(
      behavior.schemaValidations[0].role,
      "ia4tube_social_runtime"
    );
    assert.deepEqual(behavior.created, []);

    const source = fs.readFileSync(
      path.resolve(__dirname, "../scripts/social-3a0p-local-windows-physical-plans.js"),
      "utf8"
    );
    assert.match(
      source,
      /restoreVerifiers\(\s*names\.rollbackRestore,\s*profile0003\.id,\s*restoreOwnershipLatch\s*\)/u
    );
  } finally {
    await destroyBackupTransportFixture(fixture);
  }
});

test("current backup chain rejects loopback verify-full in loadBackupConfig before pg_dump", async () => {
  const fixture = backupTransportFixture();
  try {
    const rollback = await fixture.plans.createRollbackAdapter();
    await assert.rejects(
      rollback.backup0003(),
      { code: "social_database_tls_hostname_invalid" }
    );
    assert.deepEqual(fixture.configLoads, [{
      sourceHost: "127.0.0.1",
      sourcePort: "5432",
      sourceSslmode: "verify-full",
      sourceExpectedHost: "127.0.0.1",
      operatorHost: "127.0.0.1",
      operatorPort: "5432",
      operatorSslmode: "verify-full",
      operatorExpectedHost: "127.0.0.1"
    }]);
    assert.equal(fixture.runToolCalls.length, 0);
    assert.equal(fixture.pgDumpStarts.length, 0);
    assert.equal(fixture.processStarts.length, 0);
  } finally {
    await destroyBackupTransportFixture(fixture);
  }
});

test("the shared backup core validates the profile catalog before external transport", () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "../src/persistence/postgres/backup-restore.js"),
    "utf8"
  );
  const start = source.indexOf("async function runLogicalBackup(");
  const end = source.indexOf(
    "async function withExtractedVersionedBundle(",
    start
  );
  assert.ok(start >= 0);
  assert.ok(end > start);
  const body = source.slice(start, end);
  const preflight = body.indexOf("await operator.preflight(config)");
  const validation = body.indexOf("const catalog = normalizeCatalogEvidence(");
  const catalog = body.indexOf("await operator.collectCatalogEvidence(");
  const firstTransport = body.indexOf("await runToolChecked(");
  const schemaTransport = body.indexOf("schemaDumpPlan(");
  assert.ok(preflight >= 0);
  assert.ok(validation > preflight);
  assert.ok(catalog > validation);
  assert.ok(firstTransport > catalog);
  assert.ok(schemaTransport > catalog);
  assert.equal(
    body.match(/await operator\.collectCatalogEvidence\(/gu)?.length,
    1
  );
});

test("backup plans require the fixed logical TLS identity and its bound internal-container transport", async () => {
  const logicalHost = "backup.local.ia4tube.invalid";
  const connectivityMode = "logical_dns_to_internal_container_v1";
  const bridgeCalls = [];
  const boundRunTools = new Map();
  const fixture = backupTransportFixture({
    precreateBackupDirectory: false,
    dependencies: {
      createBackupTransportBridge(contract) {
        bridgeCalls.push(Object.freeze({ ...contract }));
        assert.deepEqual(Object.keys(contract).sort(), [
          "database", "login", "runMarker", "targetFingerprint"
        ]);
        assert.equal(contract.login, MIGRATION_LOGIN);
        assert.equal(contract.runMarker, RUN_MARKER);
        assert.equal(Object.hasOwn(contract, "physicalHost"), false);
        const runTool = async () => ({ code: 0, stdout: "", stderr: "" });
        boundRunTools.set(contract.database, runTool);
        return Object.freeze({
          localBinding: Object.freeze({
            connectivityMode,
            logicalHost,
            logicalPort: 5432,
            physicalMode: "internal_container_loopback",
            physicalHost: "127.0.0.1",
            physicalPort: 5432,
            database: contract.database,
            login: contract.login,
            runMarker: contract.runMarker,
            targetFingerprint: contract.targetFingerprint,
            containerIdentityDigest: "c".repeat(64)
          }),
          runTool
        });
      }
    }
  });
  try {
    const prepared = await fixture.plans.prepareBackupRestore();
    const { resolveSchemaProfile } = require(
      "../src/persistence/postgres/backup-restore"
    );
    assert.deepEqual([
      ["backup0003", resolveSchemaProfile(prepared.backup0003.profileRows).id],
      ["restore0003", prepared.restore0003.expectedProfile.id],
      ["backup0004", resolveSchemaProfile(prepared.backup0004.profileRows).id],
      ["restore0004", prepared.restore0004.expectedProfile.id],
      ["backup0005", resolveSchemaProfile(prepared.backup0005.profileRows).id],
      ["restore0005", prepared.restore0005.expectedProfile.id]
    ], [
      ["backup0003", "social-schema-0003"],
      ["restore0003", "social-schema-0003"],
      ["backup0004", "social-schema-0004"],
      ["restore0004", "social-schema-0004"],
      ["backup0005", "social-schema-0005"],
      ["restore0005", "social-schema-0005"]
    ]);
    assert.equal(bridgeCalls.length, 6);
    assert.equal(fixture.configLoads.length, 3);
    assert.equal(fixture.restoreConfigLoads.length, 3);
    for (const load of fixture.configLoads) {
      assert.equal(load.sourceHost, logicalHost);
      assert.equal(load.sourcePort, "5432");
      assert.equal(load.sourceSslmode, "verify-full");
      assert.equal(load.sourceExpectedHost, logicalHost);
      assert.equal(load.operatorHost, logicalHost);
      assert.equal(load.operatorPort, "5432");
      assert.equal(load.operatorSslmode, "verify-full");
      assert.equal(load.operatorExpectedHost, logicalHost);
      assert.equal(load.postgresTlsServername, logicalHost);
    }
    for (const load of fixture.restoreConfigLoads) {
      assert.equal(load.targetHost, logicalHost);
      assert.equal(load.targetPort, "5432");
      assert.equal(load.targetSslmode, "verify-full");
      assert.equal(load.targetExpectedHost, logicalHost);
      assert.equal(load.operatorHost, logicalHost);
      assert.equal(load.operatorPort, "5432");
      assert.equal(load.operatorSslmode, "verify-full");
      assert.equal(load.operatorExpectedHost, logicalHost);
      assert.equal(load.postgresTlsServername, logicalHost);
    }
    for (const request of [
      prepared.backup0003,
      prepared.restore0003,
      prepared.backup0004,
      prepared.restore0004,
      prepared.backup0005,
      prepared.restore0005
    ]) {
      assert.equal(request.localBinding.connectivityMode, connectivityMode);
      assert.equal(request.localBinding.logicalHost, logicalHost);
      assert.equal(request.localBinding.logicalPort, 5432);
      assert.equal(request.localBinding.physicalMode, "internal_container_loopback");
      assert.equal(request.localBinding.physicalHost, "127.0.0.1");
      assert.equal(request.localBinding.physicalPort, 5432);
      assert.equal(request.localBinding.login, MIGRATION_LOGIN);
      assert.equal(request.localBinding.runMarker, RUN_MARKER);
      assert.match(request.localBinding.targetFingerprint, /^[0-9a-f]{64}$/);
      assert.equal(request.localBinding.containerIdentityDigest, "c".repeat(64));
      assert.equal(request.runTool, boundRunTools.get(request.localBinding.database));
      assert.equal(Object.hasOwn(request, "dependencies"), false);
    }
    assert.equal(fixture.runToolCalls.length, 0);
    assert.equal(fixture.pgDumpStarts.length, 0);
    assert.equal(fixture.processStarts.length, 0);
  } finally {
    await destroyBackupTransportFixture(fixture);
  }
});

test("provenance binds and consumes only exact Gate 1 and Gate 5 outer operations", async () => {
  const provenance = provenanceRouterFixture();
  let fixture;
  fixture = backupTransportFixture({
    precreateBackupDirectory: false,
    dependencies: {
      backupRestoreProvenance: provenance.router,
      createBackupTransportBridge: createLogicalBackupTransportBridge,
      databaseManager: provenanceDatabaseManager()
    }
  });
  try {
    const rollback = await fixture.plans.createRollbackAdapter();
    assert.equal(await rollback.captureCanonical0003(), true);
    assert.equal(await rollback.backup0003(), true);
    const proof = await rollback.createDisposable0003({
      host: "127.0.0.1",
      database: rollback.disposableDatabase,
      profileId: "social-schema-0003",
      runMarker: RUN_MARKER
    });
    assert.equal(await rollback.assertDisposable0003Created(proof), true);
    assert.equal(await rollback.restore0003(proof), true);
    await assert.rejects(
      rollback.verifyRestored0003(proof),
      { code: "windows_physical_restore_profile_validation_unconfirmed" }
    );

    const prepared = await fixture.plans.prepareBackupRestore();
    const gate5Requests = [
      [prepared.backup0003, "backup", successfulLogicalBackupResult()],
      [prepared.restore0003, "restore", successfulLogicalRestoreResult()],
      [prepared.backup0004, "backup", successfulLogicalBackupResult()],
      [prepared.restore0004, "restore", successfulLogicalRestoreResult()],
      [prepared.backup0005, "backup", successfulLogicalBackupResult()],
      [prepared.restore0005, "restore", successfulLogicalRestoreResult()]
    ];
    for (const [request, kind, expected] of gate5Requests) {
      assert.equal(Object.isFrozen(request), true);
      assert.equal(Object.hasOwn(request, "dependencies"), false);
      const runner = async (candidate) => {
        assert.equal(candidate, request);
        return expected;
      };
      assert.deepEqual(
        await (kind === "backup"
          ? provenance.router.runBackup(runner, request)
          : provenance.router.runRestore(runner, request)),
        expected
      );
    }

    assert.deepEqual(provenance.calls.map((call) => call.operation), [
      "rollback_backup_0003",
      "rollback_restore_0003",
      "gate5_backup_0003",
      "gate5_restore_0003",
      "gate5_backup_0004",
      "gate5_restore_0004",
      "gate5_backup_0005",
      "gate5_restore_0005"
    ]);
    for (const call of provenance.calls) {
      assert.equal(Object.isFrozen(call.request), true);
      assert.equal(Object.hasOwn(call.request, "operation"), false);
      assert.equal(Object.hasOwn(call.request, "provenance"), false);
    }

    const source = fs.readFileSync(
      path.resolve(__dirname, "../scripts/social-3a0p-local-windows-physical-plans.js"),
      "utf8"
    );
    const labels = new Set(
      [...source.matchAll(/"((?:rollback|gate5)_(?:backup|restore)_000[345])"/gu)]
        .map((match) => match[1])
    );
    assert.deepEqual([...labels].sort(), [
      "gate5_backup_0003",
      "gate5_backup_0004",
      "gate5_backup_0005",
      "gate5_restore_0003",
      "gate5_restore_0004",
      "gate5_restore_0005",
      "rollback_backup_0003",
      "rollback_restore_0003"
    ]);
    assert.match(
      source,
      /restoreRequest\(plan0003, names\.tamper, profile0003\)/u
    );
    assert.match(
      source,
      /restoreRequest\(plan0003, names\.cross, profile0004\)/u
    );
    assert.doesNotMatch(source, /(?:tamper|cross)_(?:backup|restore)_/u);
  } finally {
    await destroyBackupTransportFixture(fixture);
  }
});

test("rollback reuses only the closed confirmation from its tracked profile validation", async () => {
  let profileValidationCalls = 0;
  const profiles = require(
    "../src/persistence/postgres/backup-restore"
  ).SCHEMA_PROFILES;
  const databaseManager = Object.freeze({
    ...provenanceDatabaseManager(),
    async verifyProfile(_database, profileId) {
      profileValidationCalls += 1;
      return profiles.find((profile) => profile.id === profileId);
    }
  });
  const provenance = provenanceRouterFixture({
    confirmRollbackRestore: true
  });
  const fixture = backupTransportFixture({
    precreateBackupDirectory: false,
    dependencies: {
      backupRestoreProvenance: provenance.router,
      createBackupTransportBridge: createLogicalBackupTransportBridge,
      databaseManager
    }
  });
  try {
    const rollback = await fixture.plans.createRollbackAdapter();
    assert.equal(await rollback.captureCanonical0003(), true);
    assert.equal(await rollback.backup0003(), true);
    const proof = await rollback.createDisposable0003({
      host: "127.0.0.1",
      database: rollback.disposableDatabase,
      profileId: "social-schema-0003",
      runMarker: RUN_MARKER
    });
    assert.equal(await rollback.assertDisposable0003Created(proof), true);
    assert.equal(await rollback.restore0003(proof), true);
    assert.equal(profileValidationCalls, 1);
    assert.equal(await rollback.verifyRestored0003(proof), true);
    assert.equal(profileValidationCalls, 1);
  } finally {
    await destroyBackupTransportFixture(fixture);
  }
});

test("rollback rejects an invalid logical result before profile verification and preserves it over close", async () => {
  const closingFailure = Object.assign(new Error("not persisted"), {
    code: "synthetic_restore_verifier_close_failure"
  });
  const behavior = profileAwareRestoreBehaviorFixture({
    closeFailure: closingFailure
  });
  const provenance = provenanceRouterFixture({
    executeRollbackRestore: true
  });
  let profileValidationCalls = 0;
  const profiles = require(
    "../src/persistence/postgres/backup-restore"
  ).SCHEMA_PROFILES;
  const databaseManager = Object.freeze({
    ...provenanceDatabaseManager(),
    async verifyProfile(_database, profileId) {
      profileValidationCalls += 1;
      return profiles.find((profile) => profile.id === profileId);
    }
  });
  const fixture = backupTransportFixture({
    precreateBackupDirectory: false,
    backupOverrides: {
      async runLogicalRestore(request) {
        await request.verifyRuntimeIsolation();
        return Object.freeze({ ok: false });
      }
    },
    dependencies: {
      backupRestoreProvenance: provenance.router,
      createBackupTransportBridge: createLogicalBackupTransportBridge,
      databaseManager,
      restoreBehavior: behavior.facade
    }
  });
  try {
    const rollback = await fixture.plans.createRollbackAdapter();
    assert.equal(await rollback.captureCanonical0003(), true);
    assert.equal(await rollback.backup0003(), true);
    const proof = await rollback.createDisposable0003({
      host: "127.0.0.1",
      database: rollback.disposableDatabase,
      profileId: "social-schema-0003",
      runMarker: RUN_MARKER
    });
    assert.equal(await rollback.assertDisposable0003Created(proof), true);
    await assert.rejects(
      rollback.restore0003(proof),
      {
        code: "windows_physical_restore_execution_unconfirmed",
        name: "WindowsPhysicalPlanFailure"
      }
    );
    assert.equal(profileValidationCalls, 0);
    assert.deepEqual(behavior.closed, ["social-schema-0003"]);
  } finally {
    await destroyBackupTransportFixture(fixture);
  }
});

test("non-social verification keeps semantic or primary failure ahead of cleanup", async (t) => {
  async function createCase({
    observed = "non-social",
    fingerprintFailure,
    removeFailure,
    assertRemoved = true
  } = {}) {
    const events = [];
    let fingerprintCalls = 0;
    const databaseManager = Object.freeze({
      ...provenanceDatabaseManager(),
      async nonSocialFingerprint() {
        fingerprintCalls += 1;
        events.push(`fingerprint:${fingerprintCalls}`);
        if (fingerprintCalls === 1) return "non-social";
        if (fingerprintFailure) throw fingerprintFailure;
        return observed;
      },
      async remove() {
        events.push("remove");
        if (removeFailure) throw removeFailure;
        return true;
      },
      async assertRemoved() {
        events.push("assert-removed");
        return assertRemoved;
      }
    });
    const fixture = backupTransportFixture({
      precreateBackupDirectory: false,
      dependencies: { databaseManager }
    });
    const rollback = await fixture.plans.createRollbackAdapter();
    assert.equal(await rollback.captureCanonical0003(), true);
    return { events, fixture, rollback };
  }

  function callerAdapter(rollback) {
    const always = async () => true;
    return Object.freeze({
      markedDisposable: true,
      productionLike: false,
      disposableDatabase: rollback.disposableDatabase,
      runMarker: RUN_MARKER,
      captureCanonical0003: always,
      applyControlledFailing0004: always,
      verifyTransactionRollback: always,
      compareCanonical0003: always,
      backup0003: always,
      apply0004: always,
      async createDisposable0003(identity) {
        return Object.freeze({ ...identity, createdByThisRun: true });
      },
      async reconcileDisposable0003CreateFailure(identity) {
        return Object.freeze({
          ...identity,
          createdByThisRun: false,
          status: "absent"
        });
      },
      assertDisposable0003Created: always,
      restore0003: always,
      verifyRestored0003: always,
      removeDisposable0003: always,
      assertDisposable0003Removed: always,
      reapply0004: always,
      verify0004Checksum: always,
      verifyProfile0004: always,
      verifyNonSocialUnchanged: () => rollback.verifyNonSocialUnchanged()
    });
  }

  await t.test("changed result wins over remove failure at the canonical caller", async () => {
    const removeFailure = Object.assign(new Error("not persisted"), {
      code: "synthetic_source_remove_failure"
    });
    const item = await createCase({
      observed: "changed",
      removeFailure
    });
    try {
      await assert.rejects(
        runForwardOnlyRollbackGate({
          approval: LOCAL_PHYSICAL_APPROVAL,
          host: "127.0.0.1",
          runMarker: RUN_MARKER,
          adapter: callerAdapter(item.rollback)
        }),
        { code: "local_rollback_non_social_changed" }
      );
      assert.deepEqual(item.events, [
        "fingerprint:1",
        "fingerprint:2",
        "remove",
        "assert-removed"
      ]);
    } finally {
      await destroyBackupTransportFixture(item.fixture);
    }
  });

  await t.test("assertRemoved false becomes the closed cleanup code", async () => {
    const item = await createCase({ assertRemoved: false });
    try {
      await assert.rejects(
        item.rollback.verifyNonSocialUnchanged(),
        {
          code: "windows_physical_source_cleanup_unconfirmed",
          name: "WindowsPhysicalPlanFailure"
        }
      );
      assert.deepEqual(item.events, [
        "fingerprint:1",
        "fingerprint:2",
        "remove",
        "assert-removed"
      ]);
    } finally {
      await destroyBackupTransportFixture(item.fixture);
    }
  });

  await t.test("fingerprint exception wins while cleanup is still attempted", async () => {
    const primary = Object.assign(new Error("not persisted"), {
      code: "synthetic_non_social_fingerprint_failure"
    });
    const cleanup = Object.assign(new Error("not persisted"), {
      code: "synthetic_source_remove_failure"
    });
    const item = await createCase({
      fingerprintFailure: primary,
      removeFailure: cleanup
    });
    try {
      await assert.rejects(
        item.rollback.verifyNonSocialUnchanged(),
        (error) => error === primary
      );
      assert.deepEqual(item.events, [
        "fingerprint:1",
        "fingerprint:2",
        "remove",
        "assert-removed"
      ]);
    } finally {
      await destroyBackupTransportFixture(item.fixture);
    }
  });
});

test("provenance failures propagate unchanged without direct-runner fallback", async () => {
  const failures = new Map([
    ["rollback_backup_0003", Object.assign(new Error("synthetic backup provenance failure"), {
      code: "synthetic_backup_provenance_failure"
    })],
    ["rollback_restore_0003", Object.assign(new Error("synthetic restore provenance failure"), {
      code: "synthetic_restore_provenance_failure"
    })],
    ["gate5_restore_0004", Object.assign(new Error("synthetic gate5 provenance failure"), {
      code: "synthetic_gate5_provenance_failure"
    })]
  ]);
  const activeFailures = new Map([
    ["rollback_backup_0003", failures.get("rollback_backup_0003")]
  ]);
  const provenance = provenanceRouterFixture({ failures: activeFailures });
  const fixture = backupTransportFixture({
    precreateBackupDirectory: false,
    dependencies: {
      backupRestoreProvenance: provenance.router,
      createBackupTransportBridge: createLogicalBackupTransportBridge,
      databaseManager: provenanceDatabaseManager()
    }
  });
  try {
    const rollback = await fixture.plans.createRollbackAdapter();
    assert.equal(await rollback.captureCanonical0003(), true);
    await assert.rejects(
      rollback.backup0003(),
      (error) => error === failures.get("rollback_backup_0003")
    );
    assert.deepEqual(
      provenance.calls.map((call) => call.operation),
      ["rollback_backup_0003"]
    );

    activeFailures.delete("rollback_backup_0003");
    assert.equal(await rollback.backup0003(), true);
    const proof = await rollback.createDisposable0003({
      host: "127.0.0.1",
      database: rollback.disposableDatabase,
      profileId: "social-schema-0003",
      runMarker: RUN_MARKER
    });
    assert.equal(await rollback.assertDisposable0003Created(proof), true);
    activeFailures.set(
      "rollback_restore_0003",
      failures.get("rollback_restore_0003")
    );
    await assert.rejects(
      rollback.restore0003(proof),
      (error) => error === failures.get("rollback_restore_0003")
    );

    activeFailures.delete("rollback_restore_0003");
    activeFailures.set(
      "gate5_restore_0004",
      failures.get("gate5_restore_0004")
    );
    const prepared = await fixture.plans.prepareBackupRestore();
    await assert.rejects(
      provenance.router.runRestore(
        async () => successfulLogicalRestoreResult(),
        prepared.restore0004
      ),
      (error) => error === failures.get("gate5_restore_0004")
    );
    assert.equal(
      provenance.calls.filter((call) =>
        call.operation === "rollback_backup_0003").length,
      2
    );
    assert.equal(
      provenance.calls.filter((call) =>
        call.operation === "rollback_restore_0003").length,
      1
    );
    assert.equal(
      provenance.calls.filter((call) =>
        call.operation === "gate5_restore_0004").length,
      1
    );
  } finally {
    await destroyBackupTransportFixture(fixture);
  }
});

test("tamper cleanup preserves the primary and attempts close, unlink and reconciliation", async (t) => {
  const proxyFileSystem = (overrides) => new Proxy(fs, {
    get(target, property) {
      if (Object.hasOwn(overrides, property)) return overrides[property];
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  async function tamperFixture(
    overrides = {},
    reconciliationFailure,
    runFailure = Object.assign(new Error("not persisted"), {
      code: "backup_bundle_authentication_failed"
    }),
    observeRestore
  ) {
    let reconciliationCalls = 0;
    const reconciliationIdentities = [];
    const reconciliationResults = [];
    const restoreAttempts = [];
    const behavior = profileAwareRestoreBehaviorFixture();
    const databaseManager = Object.freeze({
      ...provenanceDatabaseManager(),
      async reconcile(identity) {
        reconciliationCalls += 1;
        reconciliationIdentities.push(identity);
        if (reconciliationFailure) throw reconciliationFailure;
        const result = Object.freeze({
          ...identity,
          status: "absent",
          createdByThisRun: false
        });
        reconciliationResults.push(result);
        return result;
      }
    });
    const fixture = backupTransportFixture({
      precreateBackupDirectory: false,
      dependencies: {
        createBackupTransportBridge: createLogicalBackupTransportBridge,
        databaseManager,
        fileSystem: proxyFileSystem(overrides),
        restoreBehavior: behavior.facade,
        async runProfileRestore(request) {
          restoreAttempts.push(request);
          if (observeRestore) await observeRestore(request);
          if (runFailure) throw runFailure;
          return { accepted: true };
        }
      }
    });
    const prepared = await fixture.plans.prepareBackupRestore();
    const bundleContent = Buffer.from("synthetic-encrypted-bundle", "utf8");
    fs.writeFileSync(
      prepared.backup0003.config.files.bundle,
      bundleContent,
      { flag: "wx", mode: 0o600 }
    );
    return {
      behavior,
      bundleContent,
      fixture,
      prepared,
      reconciliationCalls: () => reconciliationCalls,
      reconciliationIdentities,
      reconciliationResults,
      restoreAttempts,
      tamperedPath: `${prepared.backup0003.config.files.bundle}.tampered`
    };
  }

  await t.test("exact authentication refusal mutates only the last byte and completes every cleanup", async () => {
    const expectedRefusal = Object.assign(new Error("not persisted"), {
      code: "backup_bundle_authentication_failed"
    });
    const ioEvents = [];
    let item;
    item = await tamperFixture(
      {
        openSync(candidate, flags) {
          ioEvents.push(["open", candidate, flags]);
          return fs.openSync(candidate, flags);
        },
        readSync(descriptor, buffer, offset, length, position) {
          ioEvents.push(["read", offset, length, position]);
          return fs.readSync(
            descriptor,
            buffer,
            offset,
            length,
            position
          );
        },
        writeSync(descriptor, buffer, offset, length, position) {
          ioEvents.push([
            "write",
            offset,
            length,
            position,
            buffer[0]
          ]);
          return fs.writeSync(
            descriptor,
            buffer,
            offset,
            length,
            position
          );
        },
        fsyncSync(descriptor) {
          ioEvents.push(["fsync"]);
          return fs.fsyncSync(descriptor);
        },
        closeSync(descriptor) {
          ioEvents.push(["close"]);
          return fs.closeSync(descriptor);
        },
        unlinkSync(candidate) {
          ioEvents.push(["unlink", candidate]);
          return fs.unlinkSync(candidate);
        }
      },
      undefined,
      expectedRefusal,
      async (request) => {
        assert.equal(item.restoreAttempts.length, 1);
        assert.equal(request.expectedProfile.id, "social-schema-0003");
        assert.equal(request.config.bundlePath, item.tamperedPath);
        const tampered = fs.readFileSync(item.tamperedPath);
        assert.equal(tampered.length, item.bundleContent.length);
        assert.deepEqual(
          tampered.subarray(0, -1),
          item.bundleContent.subarray(0, -1)
        );
        assert.equal(
          tampered.at(-1),
          item.bundleContent.at(-1) ^ 0xff
        );
        assert.equal(
          fs.readFileSync(
            item.prepared.backup0003.config.files.bundle
          ).equals(item.bundleContent),
          true
        );
      }
    );
    try {
      assert.equal(
        await item.prepared.assertManifestTamperRefused(),
        true
      );
      assert.equal(item.restoreAttempts.length, 1);
      assert.deepEqual(ioEvents, [
        ["open", item.tamperedPath, "r+"],
        ["read", 0, 1, item.bundleContent.length - 1],
        [
          "write",
          0,
          1,
          item.bundleContent.length - 1,
          item.bundleContent.at(-1) ^ 0xff
        ],
        ["fsync"],
        ["close"],
        ["unlink", item.tamperedPath]
      ]);
      assert.equal(fs.existsSync(item.tamperedPath), false);
      assert.equal(item.reconciliationCalls(), 1);
      assert.equal(item.reconciliationIdentities.length, 1);
      assert.equal(item.reconciliationResults.length, 1);
      assert.equal(item.reconciliationResults[0].status, "absent");
      assert.deepEqual(item.behavior.created, []);
      assert.deepEqual(item.behavior.operations, []);
      assert.deepEqual(item.behavior.closed, []);
      assert.deepEqual(item.behavior.instances, []);
      for (const verifier of ["runtime", "vault", "2a"]) {
        assert.equal(
          item.behavior.operations.filter(
            (operation) => operation[1] === verifier
          ).length,
          0
        );
      }
      assert.equal(item.fixture.runToolCalls.length, 0);
      assert.equal(item.fixture.processStarts.length, 0);
      assert.equal(
        item.fixture.runToolCalls.filter((call) =>
          path.basename(String(call?.executable || "")) ===
            "pg_restore.exe"
        ).length,
        0
      );
    } finally {
      await destroyBackupTransportFixture(item.fixture);
    }
  });

  for (const code of [
    "restore_encrypted_bundle_invalid",
    "backup_bundle_header_invalid",
    "backup_bundle_source_fingerprint_mismatch",
    "backup_bundle_outro",
    null
  ]) {
    await t.test(
      code === null
        ? "an error without a code remains unexpected"
        : `${code} remains unexpected`,
      async () => {
        const unexpected = new Error("not persisted");
        if (code !== null) unexpected.code = code;
        const item = await tamperFixture(
          {},
          undefined,
          unexpected
        );
        try {
          await assert.rejects(
            item.prepared.assertManifestTamperRefused(),
            (error) => error === unexpected
          );
          assert.equal(item.restoreAttempts.length, 1);
          assert.equal(item.reconciliationCalls(), 1);
          assert.equal(item.reconciliationResults.length, 1);
          assert.equal(item.reconciliationResults[0].status, "absent");
          assert.equal(fs.existsSync(item.tamperedPath), false);
          assert.deepEqual(item.behavior.created, []);
          assert.deepEqual(item.behavior.operations, []);
          assert.equal(item.fixture.runToolCalls.length, 0);
          assert.equal(item.fixture.processStarts.length, 0);
        } finally {
          await destroyBackupTransportFixture(item.fixture);
        }
      }
    );
  }

  await t.test("primary plus unlink failure preserves the primary", async () => {
    const primary = Object.assign(new Error("not persisted"), {
      code: "synthetic_tamper_primary_failure"
    });
    const cleanup = Object.assign(new Error("not persisted"), {
      code: "synthetic_tamper_unlink_failure"
    });
    const reconciliation = Object.assign(new Error("not persisted"), {
      code: "synthetic_tamper_reconciliation_failure"
    });
    let unlinkCalls = 0;
    const item = await tamperFixture(
      {
        fstatSync() { throw primary; },
        unlinkSync() {
          unlinkCalls += 1;
          throw cleanup;
        }
      },
      reconciliation
    );
    try {
      await assert.rejects(
        item.prepared.assertManifestTamperRefused(),
        (error) => error === primary
      );
      assert.equal(unlinkCalls, 1);
      assert.equal(item.reconciliationCalls(), 1);
    } finally {
      await destroyBackupTransportFixture(item.fixture);
    }
  });

  await t.test("close failure still attempts unlink and reconciliation", async () => {
    const primary = Object.assign(new Error("not persisted"), {
      code: "synthetic_tamper_primary_failure"
    });
    const closing = Object.assign(new Error("not persisted"), {
      code: "synthetic_tamper_close_failure"
    });
    const events = [];
    const item = await tamperFixture({
      closeSync(descriptor) {
        events.push("close");
        fs.closeSync(descriptor);
        throw closing;
      },
      fstatSync() { throw primary; },
      unlinkSync(candidate) {
        events.push("unlink");
        return fs.unlinkSync(candidate);
      }
    });
    try {
      await assert.rejects(
        item.prepared.assertManifestTamperRefused(),
        (error) => error === primary
      );
      assert.deepEqual(events, ["close", "unlink"]);
      assert.equal(item.reconciliationCalls(), 1);
    } finally {
      await destroyBackupTransportFixture(item.fixture);
    }
  });

  await t.test("cleanup-only failure propagates the first cleanup", async () => {
    const cleanup = Object.assign(new Error("not persisted"), {
      code: "synthetic_tamper_unlink_failure"
    });
    let unlinkCalls = 0;
    const item = await tamperFixture({
      unlinkSync() {
        unlinkCalls += 1;
        throw cleanup;
      }
    });
    try {
      await assert.rejects(
        item.prepared.assertManifestTamperRefused(),
        (error) => error === cleanup
      );
      assert.equal(unlinkCalls, 1);
      assert.equal(item.reconciliationCalls(), 1);
    } finally {
      await destroyBackupTransportFixture(item.fixture);
    }
  });

  await t.test("reconciliation-only failure propagates after file cleanup", async () => {
    const reconciliation = Object.assign(new Error("not persisted"), {
      code: "synthetic_tamper_reconciliation_failure"
    });
    const item = await tamperFixture({}, reconciliation);
    try {
      await assert.rejects(
        item.prepared.assertManifestTamperRefused(),
        (error) => error === reconciliation
      );
      assert.equal(item.reconciliationCalls(), 1);
    } finally {
      await destroyBackupTransportFixture(item.fixture);
    }
  });

  await t.test("accepted tamper returns false after one attempt and complete cleanup", async () => {
    const item = await tamperFixture({}, undefined, null);
    try {
      assert.equal(
        await item.prepared.assertManifestTamperRefused(),
        false
      );
      assert.equal(item.restoreAttempts.length, 1);
      assert.equal(item.reconciliationCalls(), 1);
      assert.equal(item.reconciliationResults.length, 1);
      assert.equal(item.reconciliationResults[0].status, "absent");
      assert.equal(fs.existsSync(item.tamperedPath), false);
      assert.deepEqual(item.behavior.created, []);
      assert.deepEqual(item.behavior.operations, []);
      assert.equal(item.fixture.runToolCalls.length, 0);
      assert.equal(item.fixture.processStarts.length, 0);
    } finally {
      await destroyBackupTransportFixture(item.fixture);
    }
  });

  await t.test("accepted tamper returns false despite reconciliation failure", async () => {
    const reconciliation = Object.assign(new Error("not persisted"), {
      code: "synthetic_tamper_reconciliation_failure"
    });
    const item = await tamperFixture({}, reconciliation, null);
    try {
      assert.equal(await item.prepared.assertManifestTamperRefused(), false);
      assert.equal(item.restoreAttempts.length, 1);
      assert.equal(item.reconciliationCalls(), 1);
      assert.equal(fs.existsSync(item.tamperedPath), false);
    } finally {
      await destroyBackupTransportFixture(item.fixture);
    }
  });
});

test("tamper keeps its exact refusal while cross-profile guards request creation and reconciliation", () => {
  const source = fs.readFileSync(
    path.resolve(
      __dirname,
      "../scripts/social-3a0p-local-windows-physical-plans.js"
    ),
    "utf8"
  ).replace(/\r\n/gu, "\n");
  const section = (startMarker, endMarker) => {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start);
    assert.notEqual(start, -1);
    assert.notEqual(end, -1);
    return source.slice(start, end);
  };
  const tamper = section(
    "      async assertManifestTamperRefused() {",
    "      async assertCrossProfileRefused() {"
  );
  assert.match(
    tamper,
    /error\?\.code === "backup_bundle_authentication_failed"/u
  );
  assert.equal(
    [...tamper.matchAll(/backup_bundle_[a-z_]+/gu)].map(
      (match) => match[0]
    ).join("\n"),
    "backup_bundle_authentication_failed"
  );
  assert.doesNotMatch(tamper, /startsWith|restore_encrypted_bundle_invalid/u);

  const crossProfile = section(
    "      async assertCrossProfileRefused() {",
    "      async cleanup() {"
  );
  assert.match(
    crossProfile,
    /error\?\.code === "local_backup_restore_cross_profile_refused"/u
  );
  const protectedStart = crossProfile.indexOf("try {");
  const request = crossProfile.indexOf(
    "restoreRequest(plan0003, names.cross, profile0004)"
  );
  const started = crossProfile.indexOf("restoreStarted = true");
  const restore = crossProfile.indexOf("await runProfileRestoreImpl(request)");
  const reconcileGuard = crossProfile.indexOf("if (restoreStarted)");
  const reconcile = crossProfile.indexOf("databaseManager.reconcile(");
  assert.ok(protectedStart >= 0);
  assert.ok(request > protectedStart);
  assert.ok(started > request);
  assert.ok(restore > started);
  assert.ok(reconcileGuard > restore);
  assert.ok(reconcile > reconcileGuard);
  assert.doesNotMatch(crossProfile, /setTimeout|\bretry\b|\bsleep\b/u);
});

test("cross-profile is refused before transport, mutation, verifier construction or cleanup", async () => {
  const events = [];
  const ownership = lazyRestoreOwnershipDatabaseManagerFixture({ events });
  const behavior = lazyRestoreBehaviorFixture({ events });
  const bridgeCalls = [];
  const transportToolCalls = [];
  const restoreAttempts = [];
  const runtimeVerifierReceipts = [];
  const relationMismatch = Object.assign(new Error("not persisted"), {
    code: "postgres_relation_owner_mismatch"
  });
  const regression = Object.freeze({
    expectedProfile: "social-schema-0004",
    sourceProfile: "social-schema-0003",
    expectedRelationCount: 16,
    observedRelationCount: 13,
    missingRelationCount: 3,
    ownerMismatchCount: 0,
    kindMismatchCount: 0,
    unexpectedRelationCount: 0,
    missingRelations: Object.freeze([
      "social_idempotency_operations",
      "social_publications",
      "social_publication_attempts"
    ])
  });
  const fixture = backupTransportFixture({
    precreateBackupDirectory: false,
    planOptions: { PoolClass: behavior.PoolClass },
    dependencies: {
      createBackupTransportBridge(contract) {
        bridgeCalls.push(contract);
        const bridge = createLogicalBackupTransportBridge(contract);
        return Object.freeze({
          ...bridge,
          async runTool(plan) {
            transportToolCalls.push(plan);
            return Object.freeze({ code: 0, stdout: "", stderr: "" });
          }
        });
      },
      databaseManager: ownership.manager,
      restoreBehavior: behavior.facade,
      async runProfileRestore(request) {
        restoreAttempts.push(request);
        runtimeVerifierReceipts.push(regression);
        throw relationMismatch;
      }
    }
  });
  try {
    const prepared = await fixture.plans.prepareBackupRestore();
    const before = Object.freeze({
      bridgeCalls: bridgeCalls.length,
      created: ownership.calls.created.length,
      poolRequests: ownership.calls.poolRequests.length,
      restoreConfigLoads: fixture.restoreConfigLoads.length
    });

    assert.equal(await prepared.assertCrossProfileRefused(), true);

    assert.equal(bridgeCalls.length, before.bridgeCalls);
    assert.equal(fixture.restoreConfigLoads.length, before.restoreConfigLoads);
    assert.equal(ownership.calls.created.length, before.created);
    assert.equal(ownership.calls.poolRequests.length, before.poolRequests);
    assert.deepEqual(ownership.calls.reconciled, []);
    assert.equal(
      ownership.calls.created.some((database) => database.includes("_cross_")),
      false
    );
    assert.equal(
      ownership.calls.poolRequests.some((database) => database.includes("_cross_")),
      false
    );
    assert.equal(
      ownership.calls.removed.some((database) => database.includes("_cross_")),
      false
    );
    assert.deepEqual(restoreAttempts, []);
    assert.deepEqual(runtimeVerifierReceipts, []);
    assert.deepEqual(behavior.calls.created, []);
    assert.deepEqual(behavior.calls.poolConstructions, []);
    assert.deepEqual(behavior.calls.operations, []);
    assert.equal(behavior.calls.poolConnections, 0);
    assert.equal(ownership.calls.connections, 0);
    assert.deepEqual(transportToolCalls, []);
    assert.deepEqual(fixture.runToolCalls, []);
    assert.deepEqual(fixture.pgDumpStarts, []);
    assert.deepEqual(fixture.processStarts, []);
    assert.deepEqual(regression, {
      expectedProfile: "social-schema-0004",
      sourceProfile: "social-schema-0003",
      expectedRelationCount: 16,
      observedRelationCount: 13,
      missingRelationCount: 3,
      ownerMismatchCount: 0,
      kindMismatchCount: 0,
      unexpectedRelationCount: 0,
      missingRelations: [
        "social_idempotency_operations",
        "social_publications",
        "social_publication_attempts"
      ]
    });
    assert.notEqual(
      relationMismatch.code,
      "local_backup_restore_cross_profile_refused"
    );
  } finally {
    await destroyBackupTransportFixture(fixture);
  }
});

test("plan-directory rollback never overwrites the restore-work mkdir failure", async () => {
  const primary = Object.assign(new Error("not persisted"), {
    code: "synthetic_restore_work_mkdir_failure"
  });
  const cleanup = Object.assign(new Error("not persisted"), {
    code: "synthetic_backup_directory_rmdir_failure"
  });
  let rmdirCalls = 0;
  const fileSystem = new Proxy(fs, {
    get(target, property) {
      if (property === "mkdirSync") {
        return (candidate, options) => {
          if (path.basename(candidate) === "restore-work") throw primary;
          return fs.mkdirSync(candidate, options);
        };
      }
      if (property === "rmdirSync") {
        return () => {
          rmdirCalls += 1;
          throw cleanup;
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  const fixture = backupTransportFixture({
    precreateBackupDirectory: false,
    dependencies: { fileSystem }
  });
  try {
    await assert.rejects(
      fixture.plans.prepareBackupRestore(),
      (error) => error === primary
    );
    assert.equal(rmdirCalls, 1);
  } finally {
    await destroyBackupTransportFixture(fixture);
  }
});

test("backup preparation removes every source created before a profile apply failure", async () => {
  for (const failedProfileId of ["social-schema-0004", "social-schema-0005"]) {
    const failure = Object.assign(new Error("synthetic apply failure"), {
      code: `synthetic_${failedProfileId}_apply_failure`
    });
    const active = new Set();
    const created = [];
    const removed = [];
    const databaseManager = {
      isAllowedDatabase() { return true; },
      getPools() { return { provisioner: {} }; },
      async create(identity) {
        created.push(identity.profileId);
        active.add(identity.database);
        return Object.freeze({ ...identity, createdByThisRun: true });
      },
      async assertCreated(proof) { return active.has(proof.database); },
      async remove(proof) {
        removed.push(proof.profileId);
        active.delete(proof.database);
        return true;
      },
      async assertRemoved(proof) { return !active.has(proof.database); },
      async applyProfile(_database, profileId) {
        if (profileId === failedProfileId) throw failure;
        return true;
      },
      async cleanupAll() {}
    };
    const fixture = backupTransportFixture({
      precreateBackupDirectory: false,
      dependencies: {
        createBackupTransportBridge: createLogicalBackupTransportBridge,
        databaseManager
      }
    });
    try {
      await assert.rejects(
        fixture.plans.prepareBackupRestore(),
        (error) => error === failure
      );
      const expectedCreated = failedProfileId === "social-schema-0004"
        ? ["social-schema-0003", "social-schema-0004"]
        : ["social-schema-0003", "social-schema-0004", "social-schema-0005"];
      assert.deepEqual(created, expectedCreated);
      assert.deepEqual(removed, [...expectedCreated].reverse());
      assert.equal(active.size, 0);
    } finally {
      await destroyBackupTransportFixture(fixture);
    }
  }
});

test("backup source cleanup attempts older sources after the newest removal fails", async () => {
  const removalFailure = Object.assign(new Error("synthetic remove failure"), {
    code: "synthetic_0005_remove_failure"
  });
  const active = new Set();
  const removeAttempts = [];
  const databaseManager = {
    isAllowedDatabase() { return true; },
    getPools() { return { provisioner: {} }; },
    async create(identity) {
      active.add(identity.database);
      return Object.freeze({ ...identity, createdByThisRun: true });
    },
    async assertCreated(proof) { return active.has(proof.database); },
    async remove(proof) {
      removeAttempts.push(proof.profileId);
      if (proof.profileId === "social-schema-0005") throw removalFailure;
      active.delete(proof.database);
      return true;
    },
    async assertRemoved(proof) { return !active.has(proof.database); },
    async applyProfile() { return true; },
    async cleanupAll() {}
  };
  const fixture = backupTransportFixture({
    precreateBackupDirectory: false,
    dependencies: {
      createBackupTransportBridge: createLogicalBackupTransportBridge,
      databaseManager
    }
  });
  try {
    const prepared = await fixture.plans.prepareBackupRestore();
    await assert.rejects(prepared.cleanup(), (error) => error === removalFailure);
    assert.deepEqual(removeAttempts, [
      "social-schema-0005",
      "social-schema-0004",
      "social-schema-0003"
    ]);
    assert.equal(active.size, 1);
  } finally {
    await destroyBackupTransportFixture(fixture);
  }
});

test("backup preparation reconciles and removes a source after an ambiguous create failure", async () => {
  const createFailure = Object.assign(new Error("synthetic create failure"), {
    code: "synthetic_0004_create_failure"
  });
  const active = new Map();
  const removed = [];
  const databaseManager = {
    isAllowedDatabase() { return true; },
    getPools() { return { provisioner: {} }; },
    async create(identity) {
      active.set(identity.database, identity);
      if (identity.profileId === "social-schema-0004") throw createFailure;
      return Object.freeze({ ...identity, createdByThisRun: true });
    },
    async reconcile(identity) {
      return Object.freeze({
        ...identity,
        createdByThisRun: active.has(identity.database),
        status: active.has(identity.database) ? "owned" : "absent"
      });
    },
    async assertCreated(proof) { return active.has(proof.database); },
    async remove(proof) {
      removed.push(proof.profileId);
      active.delete(proof.database);
      return true;
    },
    async assertRemoved(proof) { return !active.has(proof.database); },
    async applyProfile() { return true; },
    async cleanupAll() {}
  };
  const fixture = backupTransportFixture({
    precreateBackupDirectory: false,
    dependencies: {
      createBackupTransportBridge: createLogicalBackupTransportBridge,
      databaseManager
    }
  });
  try {
    await assert.rejects(
      fixture.plans.prepareBackupRestore(),
      (error) => error === createFailure
    );
    assert.deepEqual(removed, ["social-schema-0004", "social-schema-0003"]);
    assert.equal(active.size, 0);
  } finally {
    await destroyBackupTransportFixture(fixture);
  }
});

test("local tool adapter converts verify-full to ssl=off only after exact run binding", async () => {
  const { calls, runner } = runnerFixture();
  const result = await runner(productPlan());
  assert.equal(result.code, 0);
  assert.equal(calls.length, 1);
  const invocation = calls[0];
  assert.equal(invocation.environment.PGHOST, "127.0.0.1");
  assert.equal(invocation.environment.PGPORT, "55432");
  assert.equal(invocation.environment.PGDATABASE, "ia4tube_social_local");
  assert.equal(invocation.environment.PGUSER, MIGRATION_LOGIN);
  assert.equal(invocation.environment.PGSSLMODE, "disable");
  assert.equal(invocation.environment.TEMP, OWNED_ROOT);
  assert.equal(invocation.environment.TMP, OWNED_ROOT);
  assert.equal(invocation.environment.TMPDIR, OWNED_ROOT);
  assert.equal(Object.hasOwn(invocation.environment, "PGSSLROOTCERT"), false);
  assert.equal(Object.hasOwn(invocation.environment, "SSL_CERT_FILE"), false);
  assert.deepEqual(invocation.secretValues, [
    "synthetic-secret-that-is-at-least-32-bytes-long"
  ]);
  assert.ok(Buffer.isBuffer(invocation.input));
});

test("local tool adapter refuses external host, wrong port, database and login before spawn", async () => {
  for (const envOverride of [
    { PGHOST: "database.example.test" },
    { PGPORT: "5432" },
    { PGDATABASE: "another_database" },
    { PGUSER: "another_login" }
  ]) {
    const { calls, runner } = runnerFixture();
    await assert.rejects(
      runner(productPlan({ env: { ...productPlan().env, ...envOverride } })),
      { code: "windows_local_tool_transport_refused" }
    );
    assert.equal(calls.length, 0);
  }
});

test("local tool adapter refuses missing approval, altered marker and conflicting environment", () => {
  const common = {
    target: TARGET,
    ownedRoot: OWNED_ROOT,
    processRunner: { async run() {} },
    executables: EXECUTABLES,
    allowedDatabases: ["ia4tube_social_local"],
    allowedLogins: [MIGRATION_LOGIN]
  };
  assert.throws(
    () => createLocalPgToolRunner({ ...common, approval: "wrong", runMarker: RUN_MARKER }),
    { code: "windows_physical_plan_approval_missing" }
  );
  assert.throws(
    () => createLocalPgToolRunner({ ...common, approval: LOCAL_PHYSICAL_APPROVAL, runMarker: "wrong" }),
    { code: "windows_physical_plan_run_marker_invalid" }
  );
  const binding = {
    approval: LOCAL_PHYSICAL_APPROVAL,
    runMarker: RUN_MARKER,
    target: TARGET,
    ownedRoot: OWNED_ROOT,
    allowedExecutables: new Set(Object.values(EXECUTABLES).map((item) => path.resolve(item).toLowerCase())),
    executables: {
      psql: path.resolve(EXECUTABLES.psql).toLowerCase(),
      pgDump: path.resolve(EXECUTABLES.pgDump).toLowerCase(),
      pgRestore: path.resolve(EXECUTABLES.pgRestore).toLowerCase()
    },
    allowedDatabases: new Set(["ia4tube_social_local"]),
    allowedLogins: new Set([MIGRATION_LOGIN])
  };
  assert.throws(
    () => assertLocalToolPlan(productPlan({
      env: { ...productPlan().env, DATABASE_URL: "forbidden" }
    }), binding),
    { code: "windows_local_tool_environment_refused" }
  );
});

test("offline pg_restore list is accepted without connection environment", async () => {
  const { calls, runner } = runnerFixture();
  const archive = path.join(OWNED_ROOT, "restore-work", "synthetic.dump");
  await runner({
    executable: EXECUTABLES.pgRestore,
    args: ["--list", archive],
    env: { SYSTEMROOT: "C:\\Windows", TEMP: "C:\\external" }
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].environment.PGSSLMODE, undefined);
  assert.deepEqual(calls[0].secretValues, []);
  assert.equal(calls[0].environment.TEMP, OWNED_ROOT);
});

test("connection override argv forms are refused before spawn", async () => {
  for (const argument of ["--host=external.invalid", "-h", "--port=5432", "-p", "--username=other", "-U", "--dbname=other", "-d"]) {
    const { calls, runner } = runnerFixture();
    await assert.rejects(
      runner(productPlan({ args: [...productPlan().args, argument] })),
      { code: "windows_local_tool_command_refused" }
    );
    assert.equal(calls.length, 0);
  }
});

test("ssl=off adapter refuses product plans that are already insecure or omit CA proof", async () => {
  for (const envOverride of [
    { PGSSLMODE: "disable" },
    { PGSSLROOTCERT: undefined },
    { SSL_CERT_FILE: undefined },
    { PGCHANNELBINDING: "prefer" }
  ]) {
    const { calls, runner } = runnerFixture();
    const env = { ...productPlan().env, ...envOverride };
    if (env.PGSSLROOTCERT === undefined) delete env.PGSSLROOTCERT;
    if (env.SSL_CERT_FILE === undefined) delete env.SSL_CERT_FILE;
    await assert.rejects(runner(productPlan({ env })), {
      code: "windows_local_tool_transport_refused"
    });
    assert.equal(calls.length, 0);
  }
});

test("physical plan factory is lazy, binds one marker and exposes concrete plans", async () => {
  const calls = [];
  const databaseManager = {
    isAllowedDatabase(database) { return database === "ia4tube_social_local"; },
    async cleanupAll() { calls.push("cleanup"); }
  };
  const plans = createWindowsPhysicalPlans({
    approval: LOCAL_PHYSICAL_APPROVAL,
    runMarker: RUN_MARKER,
    target: TARGET,
    state: { target: TARGET, materials: {}, environmentId: "00000000-0000-4000-8000-000000000001" },
    paths: { ownedRoot: OWNED_ROOT },
    executables: EXECUTABLES,
    processRunner: { async run() { throw new Error("must_not_run"); } },
    PoolClass: class {},
    repositoryRoot: path.resolve(__dirname, ".."),
    randomBytes: (size) => Buffer.alloc(size, 7),
    dependencies: {
      databaseManager,
      runTool: async () => { throw new Error("must_not_run"); }
    }
  });
  assert.equal(plans.runMarker, RUN_MARKER);
  assert.equal(typeof plans.createRollbackAdapter, "function");
  assert.equal(typeof plans.prepareBackupRestore, "function");
  assert.deepEqual(calls, []);
  const rollback = await plans.createRollbackAdapter({});
  assert.equal(rollback.runMarker, RUN_MARKER);
  assert.match(rollback.disposableDatabase, /^ia4tube_social_disposable_rollback_0003_[0-9a-f]{12}$/);
  await plans.destroy();
  assert.deepEqual(calls, ["cleanup"]);
});

test("default physical database manager injects the login verifier bridge only into the definitive verifier", async () => {
  const target = Object.freeze({ host: "127.0.0.1", port: 5432 });
  const events = [];
  const genericPoolOptions = [];
  const bridgeProvenance = Symbol("test-login-verifier-bridge");
  let databaseExists = false;
  let databaseMarker = "";
  let factoryCalls = 0;
  let bootstrapProvisionerPool;
  let originalProvisionerPool;
  let authorizedProvisionerPool;

  class GenericPhysicalPlanPool {
    constructor(options) {
      this.options = options;
      genericPoolOptions.push(options);
    }
    async connect() {
      const pool = this;
      return {
        async query(text) {
          const sql = String(text);
          if (sql.includes("FROM pg_catalog.pg_database database")) {
            return databaseExists
              ? { rowCount: 1, rows: [{ owner: PROVISIONER_LOGIN, marker: databaseMarker }] }
              : { rowCount: 0, rows: [] };
          }
          if (sql.startsWith("CREATE DATABASE")) {
            databaseExists = true;
            return { rowCount: 0, rows: [] };
          }
          if (sql.startsWith("COMMENT ON DATABASE")) {
            databaseMarker = sql.match(/ IS '([^']+)'$/u)?.[1] || "";
            return { rowCount: 0, rows: [] };
          }
          if (sql.startsWith("DROP DATABASE")) {
            databaseExists = false;
            databaseMarker = "";
            return { rowCount: 0, rows: [] };
          }
          if (sql.includes("SELECT rolname FROM pg_catalog.pg_roles")) {
            return {
              rowCount: 2,
              rows: [{ rolname: MIGRATION_LOGIN }, { rolname: RUNTIME_LOGIN }]
            };
          }
          events.push(["generic-query", pool.options.application_name || "none"]);
          return { rowCount: 0, rows: [] };
        },
        release() {}
      };
    }
    async end() { events.push(["generic-end", this.options.application_name || "none"]); }
  }
  class VerifierOnlyPool {}
  const loginBootstrap = {
    MIGRATOR_ROLE: "ia4tube_social_migrator",
    RUNTIME_ROLE: "ia4tube_social_runtime",
    MIGRATION_CONNECTION_LIMIT: 2,
    RUNTIME_CONNECTION_LIMIT: 9,
    targetFingerprint(value) {
      assert.equal(value.host, "127.0.0.1");
      assert.equal(value.port, "5432");
      return "f".repeat(64);
    },
    async bootstrapDatabaseLogins(pool, configuration) {
      events.push(["bootstrap", pool.constructor.name]);
      assert.equal(pool instanceof GenericPhysicalPlanPool, true);
      if (!bootstrapProvisionerPool) bootstrapProvisionerPool = configuration.provisionerPool;
      assert.equal(configuration.provisionerPool, bootstrapProvisionerPool);
      return { safe: true, created: { migration: false, runtime: false } };
    },
    async verifyProvisionedLoginCredentials(PoolClass, configuration) {
      events.push(["verify", PoolClass.name]);
      assert.equal(PoolClass, VerifierOnlyPool);
      assert.equal(configuration.provisionerPool, authorizedProvisionerPool);
      assert.notEqual(configuration.provisionerPool, originalProvisionerPool);
      assert.equal(configuration.provisionerPool[bridgeProvenance], true);
      return { safe: true, verified: 2 };
    }
  };
  const materials = Object.freeze({
    admin: Buffer.from("Synthetic-Admin-Credential-000000000!"),
    provisioner: Buffer.from("Synthetic-Provisioner-Credential-000!"),
    migration: Buffer.from("Synthetic-Migration-Credential-00000!"),
    runtime: Buffer.from("Synthetic-Runtime-Credential-0000000!")
  });
  const plans = createWindowsPhysicalPlans({
    approval: LOCAL_PHYSICAL_APPROVAL,
    runMarker: RUN_MARKER,
    target,
    state: {
      target,
      materials,
      environmentId: "00000000-0000-4000-8000-000000000001"
    },
    paths: { ownedRoot: OWNED_ROOT },
    executables: EXECUTABLES,
    processRunner: { async run() { throw new Error("must_not_spawn"); } },
    PoolClass: GenericPhysicalPlanPool,
    repositoryRoot: path.resolve(__dirname, ".."),
    randomBytes: (size) => Buffer.alloc(size, 9),
    dependencies: {
      loginBootstrap,
      createLoginCredentialVerifierBridge({ database, configuration }) {
        factoryCalls += 1;
        events.push(["bridge", database]);
        assert.equal(database, configuration.target.database);
        originalProvisionerPool = configuration.provisionerPool;
        assert.equal(originalProvisionerPool, bootstrapProvisionerPool);
        return {
          PoolClass: VerifierOnlyPool,
          authorizeProvisionerPool(provisionerPool) {
            assert.equal(provisionerPool, originalProvisionerPool);
            authorizedProvisionerPool = { ...provisionerPool };
            Object.defineProperty(authorizedProvisionerPool, bridgeProvenance, {
              enumerable: true,
              value: true
            });
            return Object.freeze(authorizedProvisionerPool);
          }
        };
      },
      runTool: async () => { throw new Error("must_not_run_tool"); }
    }
  });
  const rollback = await plans.createRollbackAdapter();
  const proof = await rollback.createDisposable0003({
    host: "127.0.0.1",
    database: rollback.disposableDatabase,
    profileId: "social-schema-0003",
    runMarker: RUN_MARKER
  });
  assert.equal(proof.createdByThisRun, true);
  assert.equal(factoryCalls, 1);
  assert.deepEqual(events.filter(([event]) => event === "bootstrap").map((entry) => entry[1]), [
    "GenericPhysicalPlanPool",
    "GenericPhysicalPlanPool"
  ]);
  assert.deepEqual(events.filter(([event]) => event === "verify"), [["verify", "VerifierOnlyPool"]]);
  assert.equal(
    genericPoolOptions.some((options) => /(?:migration|runtime)-login-check/u.test(String(options.application_name))),
    false
  );
  assert.equal(
    genericPoolOptions.some((options) => options.connectionString != null),
    false
  );
  await plans.destroy();
  assert.equal(databaseExists, false);
});

test("rollback lifecycle never accepts a proof from another run or database", async () => {
  let createCalls = 0;
  const databaseManager = {
    isAllowedDatabase: () => true,
    async create(identity) {
      createCalls += 1;
      return { createdByThisRun: true, ...identity };
    },
    async reconcile(identity) { return { ...identity, status: "absent", createdByThisRun: false }; },
    async assertCreated() { return true; },
    async remove() { return true; },
    async assertRemoved() { return true; },
    async cleanupAll() {}
  };
  const plans = createWindowsPhysicalPlans({
    approval: LOCAL_PHYSICAL_APPROVAL,
    runMarker: RUN_MARKER,
    target: TARGET,
    state: { target: TARGET, materials: {}, environmentId: "00000000-0000-4000-8000-000000000001" },
    paths: { ownedRoot: OWNED_ROOT },
    executables: EXECUTABLES,
    processRunner: { async run() {} },
    PoolClass: class {},
    repositoryRoot: path.resolve(__dirname, ".."),
    randomBytes: (size) => Buffer.alloc(size, 8),
    dependencies: { databaseManager, runTool: async () => ({ code: 0 }) }
  });
  const rollback = await plans.createRollbackAdapter({});
  const identity = {
    host: "127.0.0.1",
    database: rollback.disposableDatabase,
    profileId: "social-schema-0003",
    runMarker: RUN_MARKER
  };
  const proof = await rollback.createDisposable0003(identity);
  assert.equal(createCalls, 1);
  await assert.rejects(
    Promise.resolve().then(() => rollback.removeDisposable0003({
      ...proof,
      runMarker: "ia4tube-social-3a0p-another-run-0001"
    })),
    WindowsPhysicalPlanFailure
  );
  assert.equal(createCalls, 1);
  await plans.destroy();
});
