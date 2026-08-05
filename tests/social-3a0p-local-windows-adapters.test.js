"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  ADMIN_LOGIN,
  LOCAL_DATABASE,
  POSTGRES_VERSION,
  PROVISIONER_LOGIN,
  canonicalArchiveEntry,
  createWindowsHarnessInvocation,
  createWindowsPhysicalAdapters,
  firewallFingerprintPowerShell,
  pendingPhysicalProofs,
  validateArchiveListings
} = require("../scripts/social-3a0p-local-windows-adapters");
const {
  PHYSICAL_APPROVAL,
  controllerContract,
  runLocalPhysicalHarness
} = require("../scripts/social-3a0p-local-physical-harness");
const {
  createOwnedTemporaryRoot
} = require("../scripts/social-3a0p-local-harness-core");

const HASH = "a".repeat(64);
const BUNDLE_0003_HASH = "b".repeat(64);
const BUNDLE_0004_HASH = "c".repeat(64);

function directory() {
  return { isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false };
}

function file(size = 13) {
  return {
    size,
    isDirectory: () => false,
    isFile: () => true,
    isSymbolicLink: () => false
  };
}

function systemSnapshot(clean) {
  return clean
    ? { clean: true, processes: 0, services: 0, listeners: 0 }
    : { clean: false, processes: 1, services: 1, listeners: 1 };
}

function syntheticOwnershipProof(parent, root) {
  return createOwnedTemporaryRoot({
    parent,
    fileSystem: {
      existsSync: () => true,
      lstatSync: () => directory(),
      mkdtempSync: () => root
    }
  });
}

function canonicalEvidencePath(ownedRoot) {
  return path.join(
    path.dirname(ownedRoot),
    `${path.basename(ownedRoot)}-incremental-evidence`,
    "canonical-evidence.json"
  );
}

function childOwnershipProof(pid, executablePath, isActive = () => true) {
  return Object.freeze({
    pid,
    executablePath,
    isOriginalProcessActive: isActive
  });
}

function gateResults() {
  return {
    assertConfigured() { return true; },
    migration: async () => ({ physicalExecution: true, syntheticOnly: true, profile0004: true, transactionalRollback: true, nonSocialUnchanged: true, migrationsApplied: 4 }),
    rls: async () => ({ physicalExecution: true, syntheticOnly: true, tenantIsolation: true, missingContextRefused: true, tamperedContextRefused: true, forceRls: true, syntheticCompanies: 2 }),
    concurrency: async () => ({ physicalExecution: true, syntheticOnly: true, concurrencySafe: true, oauthSynthetic: true, idempotencySafe: true, externalCallsAbsent: true }),
    vault: async () => ({ physicalExecution: true, syntheticOnly: true, aes256Gcm: true, aadBound: true, roundTrip: true, rotation: true, plaintextAbsent: true }),
    backupRestore: async () => ({
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
      bundle0003Size: 123,
      bundle0003Sha256: BUNDLE_0003_HASH,
      bundle0003Tables: 6,
      bundle0003RlsPolicies: 8,
      bundle0004Size: 234,
      bundle0004Sha256: BUNDLE_0004_HASH,
      bundle0004Tables: 8,
      bundle0004RlsPolicies: 10
    }),
    async destroy() {}
  };
}

function fixture(overrides = {}) {
  const ownedParent = path.resolve("C:\\synthetic-harness-parent");
  const ownedRoot = path.join(ownedParent, "ia4tube-social-3a0p-Ab12Z9");
  const ownershipProof = syntheticOwnershipProof(ownedParent, ownedRoot);
  const repositoryRoot = path.resolve(__dirname, "..");
  const archivePath = path.join(
    ownedRoot,
    "postgresql-18.4-2-windows-x64-binaries.zip"
  );
  const calls = {
    process: [],
    queries: [],
    pools: [],
    writes: [],
    directories: [],
    removed: [],
    renamed: [],
    files: new Map(),
    ledger: [],
    callbackConnects: 0,
    releases: 0,
    stopped: false
  };
  calls.files.set(archivePath, Buffer.from("synthetic-zip", "utf8"));
  const storage = {
    async access() {},
    async appendFile(target, value) { calls.writes.push({ target, value }); },
    async assertTreeSafe() { return true; },
    async exists(target) { return calls.files.has(target); },
    async hashFile() { return HASH; },
    async lstat(target) { return target === ownedRoot ? directory() : file(); },
    async mkdir(target) { calls.directories.push(target); },
    async readFile(target) {
      if (calls.files.has(target)) return calls.files.get(target);
      if (target.endsWith("postmaster.pid")) return "4242\n";
      if (target.endsWith("roles.sql")) return "BEGIN; SELECT 1; COMMIT;";
      return "";
    },
    async readdir() { return [path.basename(archivePath)]; },
    async rename(source, destination) {
      if (!calls.files.has(source) || calls.files.has(destination)) {
        throw new Error("synthetic_rename_refused");
      }
      calls.files.set(destination, calls.files.get(source));
      calls.files.delete(source);
      calls.renamed.push({ source, destination });
    },
    async rm(target) { calls.removed.push(target); },
    async stat() { return file(); },
    async statfs() {
      const values = overrides.statfsFreeBytes || [9_000, 8_000, 7_000, 8_500, 9_200];
      const index = Math.min(calls.statfsReads || 0, values.length - 1);
      calls.statfsReads = (calls.statfsReads || 0) + 1;
      return { bavail: values[index], bsize: 1 };
    },
    async unlink(target) {
      if (!calls.files.delete(target)) throw new Error("synthetic_unlink_missing");
      calls.removed.push(target);
    },
    async writeFile(target, value, options) {
      if (options?.flag === "wx" && calls.files.has(target)) {
        throw new Error("synthetic_write_exists");
      }
      calls.files.set(target, value);
      calls.writes.push({ target, value, options });
    },
    existsSync(target) { return calls.files.has(target); },
    readFileSync(target) {
      if (!calls.files.has(target)) throw new Error("synthetic_read_missing");
      return calls.files.get(target);
    },
    renameSync(source, destination) {
      if (!calls.files.has(source) || calls.files.has(destination)) {
        throw new Error("synthetic_rename_refused");
      }
      calls.files.set(destination, calls.files.get(source));
      calls.files.delete(source);
      calls.renamed.push({ source, destination });
    },
    unlinkSync(target) {
      if (!calls.files.delete(target)) throw new Error("synthetic_unlink_missing");
      calls.removed.push(target);
    },
    writeFileSync(target, value, options) {
      if (options?.flag === "wx" && calls.files.has(target)) {
        throw new Error("synthetic_write_exists");
      }
      calls.files.set(target, value);
      calls.writes.push({ target, value, options });
    },
    async removeOwnedTree(target, parent) { calls.removed.push({ target, parent }); return true; }
  };
  const processRunner = {
    async run(spec) {
      calls.process.push(spec);
      if (spec.label === "postgres_stop") calls.stopped = true;
      if (spec.label === "postgres_version") return { stdoutSanitized: "postgres (PostgreSQL) 18.4" };
      return { stdoutSanitized: "" };
    }
  };
  const archive = {
    async list() {
      return [
        "pgsql/bin/initdb.exe",
        "pgsql/bin/pg_ctl.exe",
        "pgsql/bin/pg_isready.exe",
        "pgsql/bin/postgres.exe",
        "pgsql/bin/pg_dump.exe",
        "pgsql/bin/pg_restore.exe",
        "pgsql/bin/psql.exe"
      ];
    },
    async extract() { return true; }
  };
  const systemProbe = {
    async assertClean() { return systemSnapshot(true); },
    async protectAndAuditRoot() {
      return {
        ownerCurrentUser: true,
        inheritanceProtected: true,
        explicitRuleCount: 3,
        inheritedRuleCount: 0,
        denyRuleCount: 0,
        unexpectedAllowRuleCount: 0
      };
    },
    async firewallFingerprint() {
      return { sha256: "d".repeat(64), profileCount: 3, ruleCount: 12 };
    },
    async residualProcesses() { return []; },
    async processAlive(pid) { return pid === 4242 && !calls.stopped; },
    async processIdentity(pid) {
      return pid === 4242 && !calls.stopped ? {
        pid,
        executablePath: path.join(ownedRoot, "pgsql", "bin", "postgres.exe"),
        creationDate: "20260804220000.000000-180"
      } : null;
    },
    async listeners(pid) { return calls.stopped ? [] : [{ address: "127.0.0.1", port: 55432, pid }]; }
  };
  class FakePool {
    constructor(options) {
      this.options = options;
      this.totalCount = 0;
      this.idleCount = 0;
      this.waitingCount = 0;
      this.listeners = new Map();
      calls.pools.push(options);
    }
    on(name, listener) {
      const current = this.listeners.get(name) || [];
      current.push(listener);
      this.listeners.set(name, current);
      return this;
    }
    emit(name, ...args) {
      for (const listener of this.listeners.get(name) || []) listener(...args);
    }
    connect(callback) {
      this.totalCount = Math.max(this.totalCount, 1);
      this.idleCount = 0;
      const release = () => {
        calls.releases += 1;
        this.emit("release", null, client);
        this.idleCount = this.totalCount;
      };
      const syntheticProcessId = typeof overrides.fakeProcessId === "function"
        ? overrides.fakeProcessId(this.options)
        : overrides.fakeProcessId;
      const client = {
        ...(Number.isSafeInteger(syntheticProcessId)
          ? { processID: syntheticProcessId }
          : {}),
        async query(sql, values) {
          const text = String(sql);
          calls.queries.push({ text, values });
          if (text === "SELECT 1::integer AS value") return { rowCount: 1, rows: [{ value: 1 }] };
           if (text === "SHOW server_version") return { rowCount: 1, rows: [{ server_version: "18.4" }] };
          if (text === "SHOW data_checksums") return { rowCount: 1, rows: [{ data_checksums: "on" }] };
          if (text.includes("FROM pg_catalog.pg_stat_activity")) return { rowCount: 0, rows: [] };
          if (text.includes("FROM pg_catalog.pg_roles WHERE rolname=$1")) return { rowCount: 0, rows: [] };
          if (text.includes("FROM pg_catalog.pg_database database")) return { rowCount: 0, rows: [] };
          if (text.includes("FROM ia4tube_migrations.environment_identity")) {
            return { rowCount: 1, rows: [{ environment_id: "11111111-1111-4111-8111-111111111111", environment_name: "local" }] };
          }
          return { rowCount: 1, rows: [{ ok: true }] };
        },
        release
      };
      if (typeof callback === "function") {
        calls.callbackConnects += 1;
        callback(null, client, release);
        return undefined;
      }
      return Promise.resolve(client);
    }
    query(sql, values, callback) {
      let parameters = values;
      let done = callback;
      if (typeof values === "function") {
        done = values;
        parameters = undefined;
      }
      const pending = new Promise((resolve, reject) => {
        this.connect(async (error, client, release) => {
          if (error) return reject(error);
          try {
            const result = await client.query(sql, parameters);
            release();
            resolve(result);
          } catch (queryError) {
            release();
            reject(queryError);
          }
        });
      });
      if (typeof done === "function") {
        pending.then((result) => done(null, result), done);
        return undefined;
      }
      return pending;
    }
    async end() {
      this.totalCount = 0;
      this.idleCount = 0;
      this.waitingCount = 0;
    }
  }
  let bootstrapCount = 0;
  const product = {
    MIGRATOR_ROLE: "ia4tube_social_migrator",
    RUNTIME_ROLE: "ia4tube_social_runtime",
    MIGRATION_CONNECTION_LIMIT: 2,
    RUNTIME_CONNECTION_LIMIT: 9,
    targetFingerprint: () => "c".repeat(64),
    async bootstrapDatabaseLogins() {
      bootstrapCount += 1;
      return { safe: true, created: { migration: bootstrapCount === 1, runtime: bootstrapCount === 1 } };
    },
    async verifyProvisionedLoginCredentials() { return { verified: 2 }; }
  };
  const dpapi = {
    async protectAndVerify() {
      return { dpapiProtected: true, roundTripVerified: true, plaintextPersisted: false, scope: "CurrentUser", custodyCreatedByThisRun: true, temporaryCustodyRemoved: true };
    },
    async remove(target) { calls.removed.push(target); return true; }
  };
  const evidenceLedger = {
    async initialize(payload) {
      calls.ledger.push({ kind: "initialize", payload });
      return { code: "evidence_ledger_initialized" };
    },
    async beginPhase(phase) {
      calls.ledger.push({ kind: "started", phase });
      return { code: "evidence_phase_started" };
    },
    async finishPhase(phase, payload) {
      calls.ledger.push({ kind: "finished", phase, payload });
      return { code: "evidence_phase_finished" };
    },
    async beginCleanup() {
      calls.ledger.push({ kind: "started", phase: "cleanup" });
      return { code: "evidence_cleanup_started" };
    },
    async finishCleanup(payload) {
      calls.ledger.push({ kind: "finished", phase: "cleanup", payload });
      return { code: "evidence_cleanup_finished" };
    }
  };
  const adapterOptions = {
    ownedRoot,
    ownedParent,
    ownershipProof,
    repositoryRoot,
    harnessCommit: "d".repeat(40),
    productCommit: "e".repeat(40),
    sourcePackageVerifier: overrides.sourcePackageVerifier || (async () => ({
      externalPackagePreserved: true,
      sourceHashUnchanged: true
    })),
    platform: "win32",
    executables: {
      powershell: path.resolve("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"),
      tar: path.resolve("C:\\Windows\\System32\\tar.exe"),
      taskkill: path.resolve("C:\\Windows\\System32\\taskkill.exe")
    },
    dependencies: {
      archive,
      dpapi,
      evidenceLedger,
      physicalGates: gateResults(),
      PoolClass: FakePool,
      processRunner,
      product,
      randomBytes: (size) => Buffer.alloc(size, 0x41),
      randomUUID: () => "11111111-1111-4111-8111-111111111111",
      storage,
      systemProbe,
      terminateProcessTree: async () => { calls.stopped = true; return true; },
      ...overrides.dependencies,
      systemProbe: { ...systemProbe, ...(overrides.dependencies?.systemProbe || {}) }
    }
  };
  const adapters = createWindowsPhysicalAdapters(adapterOptions);
  const input = {
    context: { state: {} },
    target: { host: "127.0.0.1", port: 55432 },
    packageDescriptor: {
      archivePath,
      expectedSha256: HASH,
      version: POSTGRES_VERSION,
      sourceOwnedByRun: false,
      workingCopyOwnedByRun: true
    },
    signal: new AbortController().signal
  };
  return { adapterOptions, adapters, archive, archivePath, calls, dpapi, input, ownedParent, ownedRoot, storage, systemProbe };
}

async function prepareEvidenceCollection(base) {
  await base.adapters.preflight(base.input);
  await base.adapters.validatePackage(base.input);
  await base.adapters.extractPackage(base.input);
  await base.adapters.initializeCluster(base.input);
  await base.adapters.bootstrapRoles(base.input);
}

test("physical proofs remain explicitly pending until a real harness run", () => {
  assert.deepEqual(pendingPhysicalProofs(), {
    physicalExecutionOccurred: false,
    postgresAccessed: false,
    networkAccessed: false,
    proofs: pendingPhysicalProofs().proofs
  });
  assert.ok(pendingPhysicalProofs().proofs.length >= 10);
});

test("adapter executes the complete physical lifecycle with injected fakes only", async () => {
  const { adapters, archivePath, calls, input, ownedRoot } = fixture();
  const run = runLocalPhysicalHarness({
    approval: PHYSICAL_APPROVAL,
    adapters,
    packageDescriptor: input.packageDescriptor,
    target: input.target
  });
  const report = await run;
  assert.equal(report.ok, true);
  const finalPath = canonicalEvidencePath(ownedRoot);
  const pendingPath = `${finalPath}.pending`;
  assert.ok(calls.pools.some((entry) => entry.database === "postgres" && entry.user === ADMIN_LOGIN));
  assert.ok(calls.pools.some((entry) => entry.database === LOCAL_DATABASE && entry.user === PROVISIONER_LOGIN));
  assert.ok(calls.queries.some((entry) => entry.text.includes("CREATE DATABASE")));
  const queryText = calls.queries.map((entry) => entry.text).join("\n");
  assert.doesNotMatch(queryText, /Aa1!/);
  assert.ok(calls.process.every((entry) => !entry.args.join(" ").includes("Aa1!")));
  assert.ok(calls.process.every((entry) =>
    entry.environment.TEMP === ownedRoot &&
    entry.environment.TMP === ownedRoot &&
    entry.environment.TMPDIR === ownedRoot
  ));
  assert.equal(calls.files.has(pendingPath), false);
  assert.equal(calls.files.has(`${finalPath}.finalizing`), false);
  assert.equal(calls.files.has(finalPath), true);
  const evidence = JSON.parse(calls.files.get(finalPath));
  assert.equal(evidence.status, "complete");
  assert.equal(evidence.physicalExecution, true);
  assert.equal(evidence.closedReport.ok, true);
  assert.equal(evidence.closedReport.phases.at(-1).phase, "cleanup");
  assert.equal(evidence.closedReport.phases.at(-1).status, "passed");
  const startEvidence = evidence.closedReport.phases.find(
    (entry) => entry.phase === "start-cluster"
  );
  assert.equal(startEvidence.result.counts.postmasterPid, 4242);
  assert.equal(
    evidence.closedReport.phases.at(-1).result.checks.workingPackageRemoved,
    true
  );
  assert.equal(
    evidence.closedReport.phases.at(-1).result.checks.firewallUnchanged,
    true
  );
  assert.equal(
    evidence.closedReport.phases.at(-1).result.checks.systemClean,
    true
  );
  const cleanupEvidence = evidence.closedReport.phases.at(-1).result;
  assert.equal(cleanupEvidence.counts.postgresProcessesRemaining, 0);
  assert.equal(cleanupEvidence.counts.postgresServicesRemaining, 0);
  assert.equal(cleanupEvidence.counts.postgresListenersRemaining, 0);
  assert.equal(cleanupEvidence.counts.helperProcessesRemaining, 0);
  assert.equal(cleanupEvidence.counts.temporaryCustodiesRemaining, 0);
  assert.equal(cleanupEvidence.counts.residualOwnedPostgresProcesses, 0);
  assert.equal(cleanupEvidence.counts.diskMinimumObservedFreeBytes, 7_000);
  assert.equal(cleanupEvidence.checks.primaryDatabaseRemoved, true);
  assert.equal(cleanupEvidence.checks.restorationDatabasesRemoved, true);
  assert.equal(cleanupEvidence.checks.clusterRemoved, true);
  assert.equal(cleanupEvidence.checks.binariesRemoved, true);
  assert.equal(cleanupEvidence.checks.sourcePackageExternal, true);
  assert.equal(cleanupEvidence.checks.workingPackageOwnedByRun, true);
  assert.equal(
    evidence.closedReport.phases.at(-1).result.hashes.firewallBeforeSha256,
    evidence.closedReport.phases.at(-1).result.hashes.firewallAfterSha256
  );
  assert.equal(calls.removed.includes(archivePath), true);
  assert.equal(
    evidence.closedReport.phases.at(-1).result.checks.sanitizedEvidencePrepared,
    true
  );
  const persistedHash = evidence.evidenceSha256;
  delete evidence.evidenceSha256;
  assert.equal(
    persistedHash,
    crypto.createHash("sha256").update(JSON.stringify(evidence)).digest("hex")
  );
  assert.ok(!calls.files.get(finalPath).includes("Aa1!"));
  assert.throws(
    () => adapters.finalizeSanitizedEvidence({ report }),
    { code: "windows_harness_evidence_finalize_state_invalid" }
  );
  assert.equal(calls.files.has(finalPath), true);
});

test("ZIP criado pela execução é removido sem consultar verificador de fonte externa", async () => {
  let externalVerifierCalls = 0;
  const base = fixture({
    sourcePackageVerifier: async () => {
      externalVerifierCalls += 1;
      throw new Error("external_verifier_must_not_run");
    }
  });
  base.input.packageDescriptor = {
    ...base.input.packageDescriptor,
    sourceOwnedByRun: true
  };

  const report = await runLocalPhysicalHarness({
    approval: PHYSICAL_APPROVAL,
    adapters: base.adapters,
    packageDescriptor: base.input.packageDescriptor,
    target: base.input.target
  });

  assert.equal(report.ok, true);
  assert.equal(externalVerifierCalls, 0);
  assert.equal(base.calls.removed.includes(base.archivePath), true);
  const cleanup = report.phases.at(-1).result;
  assert.equal(cleanup.checks.packageSourceOwnedByRun, true);
  assert.equal(cleanup.checks.sourcePackageExternal, false);
  assert.equal(cleanup.checks.workingPackageRemoved, true);
});

test("readiness uses the bootstrap database before the product database exists", async () => {
  const { adapters, calls, input } = fixture();
  await adapters.preflight(input);
  await adapters.validatePackage(input);
  await adapters.extractPackage(input);
  await adapters.initializeCluster(input);
  await adapters.startCluster(input);
  const readiness = await adapters.createReadinessProbes(input);
  await readiness.probes.openAdminSession();
  assert.equal(calls.pools.at(-1).database, "postgres");
  const probe = calls.process.find((entry) => entry.label === "postgres_pg_isready");
  await readiness.probes.pgIsReady();
  assert.equal(calls.process.find((entry) => entry.label === "postgres_pg_isready").args.includes("postgres"), true);
  assert.equal(probe, undefined);
});

test("role bootstrap requires an explicit measured created-count", async () => {
  for (const createdCount of [undefined, -1, 3, 0.5]) {
    const base = fixture({ dependencies: {
      roleBootstrap: async () => ({
        physicalExecution: true,
        syntheticOnly: true,
        idempotent: true,
        runtimeSafe: true,
        migrationSafe: true,
        scramVerified: true,
        ...(createdCount === undefined ? {} : { createdCount })
      })
    } });
    await base.adapters.preflight(base.input);
    await base.adapters.validatePackage(base.input);
    await base.adapters.extractPackage(base.input);
    await base.adapters.initializeCluster(base.input);
    await assert.rejects(
      base.adapters.bootstrapRoles(base.input),
      { code: "windows_harness_role_bootstrap_measurement_invalid" }
    );
  }
});

test("an aborted phase cannot continue mutating after an awaited operation", async () => {
  const controller = new AbortController();
  const base = fixture({
    dependencies: {
      archive: {
        async list() {
          controller.abort();
          return [
            "pgsql/bin/initdb.exe",
            "pgsql/bin/pg_ctl.exe",
            "pgsql/bin/pg_isready.exe",
            "pgsql/bin/postgres.exe",
            "pgsql/bin/pg_dump.exe",
            "pgsql/bin/pg_restore.exe",
            "pgsql/bin/psql.exe"
          ];
        },
        async extract() { throw new Error("must_not_run"); }
      }
    }
  });
  base.input.signal = controller.signal;
  await assert.rejects(base.adapters.validatePackage(base.input), { code: "windows_harness_phase_aborted" });
});

test("the production adapter loads concrete connector gates at physical preflight", async () => {
  let factoryCalled = false;
  const base = fixture({ dependencies: {
    physicalGates: undefined,
    connectorGateFactory() {
      factoryCalled = true;
      return gateResults();
    }
  } });
  assert.equal(factoryCalled, false);
  await base.adapters.preflight(base.input);
  assert.equal(factoryCalled, true);
  assert.equal(typeof base.adapters.runMigrationGate, "function");
  assert.equal(typeof base.adapters.runBackupRestoreGate, "function");
});

test("preflight records package and ACL evidence and preserves it on a real adapter failure", async () => {
  const base = fixture({
    dependencies: {
      systemProbe: {
        async assertClean() { return systemSnapshot(false); }
      }
    }
  });
  let failure;
  try {
    await base.adapters.preflight(base.input);
  } catch (error) {
    failure = error;
  }
  assert.equal(failure.code, "windows_harness_postgres_activity_detected");
  assert.equal(
    failure.partialResult.code,
    "windows_preflight_partial_evidence"
  );
  assert.equal(failure.partialResult.counts.packageBytes, 13);
  assert.equal(failure.partialResult.counts.packageBuild, 2);
  assert.equal(failure.partialResult.counts.rootAclExplicitRules, 3);
  assert.equal(failure.partialResult.counts.rootAclInheritedRules, 0);
  assert.equal(failure.partialResult.counts.rootAclDenyRules, 0);
  assert.equal(failure.partialResult.counts.rootAclUnexpectedAllowRules, 0);
  assert.equal(failure.partialResult.checks.rootAclOwnerCurrentUser, true);
  assert.equal(failure.partialResult.checks.rootAclInheritanceProtected, true);
  assert.equal(failure.partialResult.checks.packageSourceOwnedByRun, false);
  assert.ok(
    failure.partialResult.inventory.includes(
      "postgresql-18-4-2-windows-x64-binaries-zip"
    )
  );
  assert.ok(failure.partialResult.inventory.includes("build-2"));
  assert.ok(failure.partialResult.inventory.includes("source-external"));
  assert.match(failure.partialResult.hashes.firewallBeforeSha256, /^[a-f0-9]{64}$/);
});

test("cluster evidence contains the loopback address, port, PID, and version", async () => {
  const base = fixture();
  await base.adapters.preflight(base.input);
  await base.adapters.validatePackage(base.input);
  await base.adapters.extractPackage(base.input);
  await base.adapters.initializeCluster(base.input);
  const result = await base.adapters.startCluster(base.input);
  assert.equal(result.counts.clusterPort, 55432);
  assert.equal(result.counts.postmasterPid, 4242);
  assert.equal(result.metrics.postgresMajor, 18);
  assert.equal(result.metrics.postgresMinor, 4);
  assert.equal(result.checks.clusterAddressLoopback, true);
  assert.ok(result.inventory.includes("address-127-0-0-1"));
  assert.ok(result.inventory.includes("postgresql-18-4"));
});

test("package hash and archive traversal are rejected before extraction", async () => {
  const badHash = fixture();
  badHash.storage.hashFile = async () => "f".repeat(64);
  let hashFailure;
  try {
    await badHash.adapters.validatePackage(badHash.input);
  } catch (error) {
    hashFailure = error;
  }
  assert.equal(hashFailure.code, "windows_harness_archive_sha256_mismatch");
  assert.equal(
    hashFailure.partialResult.code,
    "windows_validate_package_partial_evidence"
  );
  assert.equal(hashFailure.partialResult.hashes.archiveSha256, "f".repeat(64));

  const traversal = fixture();
  traversal.archive.list = async () => [
    "pgsql/bin/initdb.exe",
    "pgsql/bin/pg_ctl.exe",
    "pgsql/bin/pg_isready.exe",
    "pgsql/bin/pg_dump.exe",
    "pgsql/bin/pg_restore.exe",
    "pgsql/bin/psql.exe",
    "pgsql/../outside/postgres.exe"
  ];
  await assert.rejects(traversal.adapters.validatePackage(traversal.input), { code: "windows_harness_archive_entry_invalid" });
});

test("archive inventory accepts only preflighted regular files and directories", () => {
  const entries = validateArchiveListings(
    "pgsql/\npgsql/bin/postgres.exe\n",
    "drwxr-xr-x  0 0 0 0 Aug 04 12:00 pgsql/\n-rwxr-xr-x  0 0 0 1 Aug 04 12:00 pgsql/bin/postgres.exe\n"
  );
  assert.deepEqual(entries, ["pgsql", "pgsql/bin/postgres.exe"]);

  for (const mode of ["lrwxrwxrwx", "hrw-r--r--", "crw-r--r--", "brw-r--r--", "prw-r--r--", "srw-r--r--"]) {
    assert.throws(
      () => validateArchiveListings(
        "pgsql/bin/postgres.exe\n",
        `${mode}  0 0 0 1 Aug 04 12:00 pgsql/bin/postgres.exe\n`
      ),
      { code: "windows_harness_archive_entry_type_refused" }
    );
  }
  assert.throws(
    () => validateArchiveListings(
      "pgsql/\npgsql/bin/postgres.exe\n",
      "drwxr-xr-x  0 0 0 0 Aug 04 12:00 pgsql/\n"
    ),
    { code: "windows_harness_archive_type_inventory_invalid" }
  );
  assert.throws(
    () => validateArchiveListings(
      "pgsql/bin/postgres.exe\n",
      "not-a-mode pgsql/bin/postgres.exe\n"
    ),
    { code: "windows_harness_archive_entry_type_refused" }
  );
  for (const unsafe of [
    "pgsql/bin/postgres.exe::",
    "pgsql/.. /outside.exe",
    "pgsql/CON/postgres.exe",
    "pgsql/COM¹/postgres.exe",
    "pgsql/bin./postgres.exe",
    "pgsql/bin/postgres.exe ",
    "pgsql\\bin\\postgres.exe",
    "C:/pgsql/bin/postgres.exe"
  ]) {
    assert.throws(
      () => canonicalArchiveEntry(unsafe),
      { code: "windows_harness_archive_entry_invalid" }
    );
  }
});

test("default extraction binds the approved hash to one locked safe ZIP reader", async () => {
  const entries = [
    "pgsql/bin/initdb.exe",
    "pgsql/bin/pg_ctl.exe",
    "pgsql/bin/pg_isready.exe",
    "pgsql/bin/postgres.exe",
    "pgsql/bin/pg_dump.exe",
    "pgsql/bin/pg_restore.exe",
    "pgsql/bin/psql.exe"
  ];
  const base = fixture({ dependencies: {
    archive: undefined,
    processRunner: {
      async run(spec) {
        base.calls.process.push(spec);
        if (spec.label === "archive_list") {
          return { stdoutSanitized: `${entries.join("\n")}\n` };
        }
        if (spec.label === "archive_list_types") {
          return {
            stdoutSanitized: entries
              .map((entry) => `-rwxr-xr-x  0 0 0 1 Aug 04 12:00 ${entry}`)
              .join("\n") + "\n"
          };
        }
        if (spec.label === "postgres_version") {
          return { stdoutSanitized: "postgres (PostgreSQL) 18.4" };
        }
        return { stdoutSanitized: "" };
      }
    }
  } });
  await base.adapters.preflight(base.input);
  await base.adapters.validatePackage(base.input);
  await base.adapters.extractPackage(base.input);

  const extraction = base.calls.process.find((call) => call.label === "archive_extract");
  assert.ok(extraction);
  assert.equal(extraction.executable.toLowerCase().endsWith("powershell.exe"), true);
  assert.equal(extraction.args.includes(base.input.packageDescriptor.expectedSha256), true);
  assert.equal(
    extraction.args.some((argument) =>
      argument.endsWith("social-3a0p-local-safe-zip-extract.ps1")
    ),
    true
  );
  assert.equal(
    base.calls.process.some((call) =>
      call.label === "archive_extract" && call.executable.toLowerCase().endsWith("tar.exe")
    ),
    false
  );

  const extractorSource = fs.readFileSync(
    path.join(base.adapterOptions.repositoryRoot, "scripts", "social-3a0p-local-safe-zip-extract.ps1"),
    "utf8"
  );
  assert.match(extractorSource, /FileShare\]::Read/);
  assert.match(extractorSource, /ComputeHash\(\$stream\)/);
  assert.match(extractorSource, /archive_entry_type_refused/);
  assert.match(extractorSource, /FileMode\]::CreateNew/);
  assert.match(extractorSource, /ReparsePoint/);
});

test("archive bytes changed after validation are refused before extraction", async () => {
  const base = fixture();
  let hashReads = 0;
  base.storage.hashFile = async () => {
    hashReads += 1;
    return hashReads === 1 ? HASH : "f".repeat(64);
  };
  await base.adapters.preflight(base.input);
  await base.adapters.validatePackage(base.input);
  await assert.rejects(base.adapters.extractPackage(base.input), {
    code: "windows_harness_archive_sha256_mismatch"
  });
  assert.equal(base.calls.process.some((call) => call.label === "archive_extract"), false);
});

test("DPAPI evidence must prove CurrentUser round-trip with no plaintext", async () => {
  const base = fixture();
  await base.adapters.preflight(base.input);
  await base.adapters.validatePackage(base.input);
  await base.adapters.extractPackage(base.input);
  await base.adapters.initializeCluster(base.input);
  base.dpapi.protectAndVerify = async () => ({
    dpapiProtected: true,
    roundTripVerified: true,
    plaintextPersisted: true,
    scope: "CurrentUser",
    custodyCreatedByThisRun: true,
    temporaryCustodyRemoved: true
  });
  await assert.rejects(base.adapters.establishDpapiCustody(base.input), { code: "harness_dpapi_round_trip_failed" });
});

test("a pre-existing evidence file is refused instead of overwritten", async () => {
  const base = fixture();
  base.storage.exists = async () => true;
  await assert.rejects(base.adapters.preflight(base.input), { code: "windows_harness_evidence_path_exists" });
  assert.equal(base.calls.writes.length, 0);
});

test("cleanup failure leaves only explicitly pending evidence", async () => {
  const base = fixture();
  await prepareEvidenceCollection(base);
  await base.adapters.collectSanitizedEvidence(base.input);
  base.storage.removeOwnedTree = async () => false;

  await assert.rejects(base.adapters.cleanup(base.input), {
    code: "windows_harness_cleanup_owned_root_unconfirmed"
  });
  const finalPath = canonicalEvidencePath(base.ownedRoot);
  const pendingPath = `${finalPath}.pending`;
  assert.equal(base.calls.files.has(finalPath), false);
  assert.equal(base.calls.files.has(`${finalPath}.finalizing`), false);
  const pending = JSON.parse(base.calls.files.get(pendingPath));
  assert.equal(pending.status, "pending_cleanup");
  assert.equal(pending.physicalExecution, false);
});

test("successful cleanup alone cannot promote canonical physical evidence", async () => {
  const base = fixture();
  await prepareEvidenceCollection(base);
  await base.adapters.collectSanitizedEvidence(base.input);
  const cleanup = await base.adapters.cleanup(base.input);

  const finalPath = canonicalEvidencePath(base.ownedRoot);
  const pendingPath = `${finalPath}.pending`;
  assert.equal(cleanup.checks.sanitizedEvidencePrepared, true);
  assert.equal(base.calls.files.has(finalPath), false);
  assert.equal(base.calls.files.has(`${finalPath}.finalizing`), false);
  const pending = JSON.parse(base.calls.files.get(pendingPath));
  assert.equal(pending.status, "pending_cleanup");
  assert.equal(pending.physicalExecution, false);
});

test("failed atomic promotion restores non-approving pending evidence", async () => {
  const base = fixture();
  base.storage.renameSync = () => {
    throw new Error("synthetic_atomic_rename_failed");
  };

  await assert.rejects(runLocalPhysicalHarness({
    approval: PHYSICAL_APPROVAL,
    adapters: base.adapters,
    packageDescriptor: base.input.packageDescriptor,
    target: base.input.target
  }), {
    code: "windows_harness_evidence_finalize_failed"
  });
  const finalPath = canonicalEvidencePath(base.ownedRoot);
  const pendingPath = `${finalPath}.pending`;
  assert.equal(base.calls.files.has(finalPath), false);
  assert.equal(base.calls.files.has(`${finalPath}.finalizing`), false);
  const pending = JSON.parse(base.calls.files.get(pendingPath));
  assert.equal(pending.status, "pending_cleanup");
  assert.equal(pending.physicalExecution, false);
});

test("failure before evidence collection cannot create final physical evidence", async () => {
  const base = fixture();
  await base.adapters.preflight(base.input);
  const cleanup = await base.adapters.cleanup(base.input);
  assert.equal(cleanup.checks.sanitizedEvidencePrepared, false);
  const finalPath = canonicalEvidencePath(base.ownedRoot);
  assert.equal(base.calls.files.has(finalPath), false);
  assert.equal(base.calls.files.has(`${finalPath}.pending`), false);
});

test("cleanup preserves the owned tree when postmaster termination is unconfirmed", async () => {
  const base = fixture({ dependencies: {
    systemProbe: {
      async assertClean() { return systemSnapshot(true); },
      async processAlive() { return true; },
      async processIdentity(pid) {
        return {
          pid,
          executablePath: path.resolve("C:\\synthetic-harness-parent\\ia4tube-social-3a0p-Ab12Z9\\pgsql\\bin\\postgres.exe"),
          creationDate: "20260804220000.000000-180"
        };
      },
      async listeners(pid) { return [{ address: "127.0.0.1", port: 55432, pid }]; }
    },
    terminateProcessTree: async () => false
  } });
  await base.adapters.preflight(base.input);
  await base.adapters.validatePackage(base.input);
  await base.adapters.extractPackage(base.input);
  await base.adapters.initializeCluster(base.input);
  await base.adapters.startCluster(base.input);
  await assert.rejects(base.adapters.cleanup(base.input), { code: "windows_harness_cleanup_process_failed" });
  assert.equal(
    base.calls.removed.some((entry) => entry?.target === base.ownedRoot),
    false
  );
});

test("cleanup never terminates a process that reused the postmaster PID", async () => {
  let cleanChecks = 0;
  let identityReads = 0;
  let terminationCalls = 0;
  const expectedExecutable = path.resolve(
    "C:\\synthetic-harness-parent\\ia4tube-social-3a0p-Ab12Z9\\pgsql\\bin\\postgres.exe"
  );
  const base = fixture({ dependencies: {
    systemProbe: {
      async assertClean() {
        cleanChecks += 1;
        return systemSnapshot(cleanChecks === 1);
      },
      async processIdentity(pid) {
        identityReads += 1;
        if (identityReads === 1) {
          return {
            pid,
            executablePath: expectedExecutable,
            creationDate: "20260804220000.000000-180"
          };
        }
        return {
          pid,
          executablePath: path.resolve("C:\\Windows\\System32\\notepad.exe"),
          creationDate: "20260804220100.000000-180"
        };
      },
      async listeners() { return []; }
    },
    terminateProcessTree: async () => {
      terminationCalls += 1;
      return true;
    }
  } });
  await base.adapters.preflight(base.input);
  await base.adapters.validatePackage(base.input);
  await base.adapters.extractPackage(base.input);
  await base.adapters.initializeCluster(base.input);
  await base.adapters.startCluster(base.input);
  await assert.rejects(
    base.adapters.cleanup(base.input),
    { code: "windows_harness_cleanup_process_failed" }
  );
  assert.equal(terminationCalls, 0);
  assert.equal(
    base.calls.removed.some((entry) => entry?.target === base.ownedRoot),
    false
  );
});

test("controller termination covers every active harness child PID", async () => {
  let journal;
  const terminated = [];
  const active = new Set([5101, 5102, 5103, 5104]);
  const helperExecutable = path.resolve(
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
  );
  const base = fixture({ dependencies: {
    processRunner: undefined,
    createProcessRunner(options) {
      journal = options.resourceJournal;
      return {
        async run() { return { stdoutSanitized: "" }; }
      };
    },
    terminateProcessTree: async (pid) => {
      terminated.push(pid);
      active.delete(pid);
      return true;
    },
    systemProbe: {
      async processIdentity(pid) {
        return active.has(pid)
          ? { pid, executablePath: helperExecutable, creationDate: "synthetic" }
          : null;
      }
    }
  } });
  await base.adapters.preflight(base.input);
  for (const pid of active) {
    journal.registerProcess(
      pid,
      childOwnershipProof(pid, helperExecutable)
    );
  }
  assert.equal(await base.adapters.terminateProcessTree(), true);
  assert.deepEqual(terminated.sort(), [5101, 5102, 5103, 5104]);
  const cleanup = await base.adapters.cleanup(base.input);
  assert.equal(cleanup.counts.processTreesTerminated, 4);
});

test("controller não declara helper encerrado sem confirmar ausência do PID", async () => {
  let journal;
  const helperExecutable = path.resolve(
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
  );
  const base = fixture({ dependencies: {
    processRunner: undefined,
    createProcessRunner(options) {
      journal = options.resourceJournal;
      return {
        async run() { return { stdoutSanitized: "" }; }
      };
    },
    systemProbe: {
      async processIdentity(pid) {
        return {
          pid,
          executablePath: helperExecutable,
          creationDate: "20260804220000.000000-180"
        };
      }
    },
    terminateProcessTree: async () => true
  } });
  await base.adapters.preflight(base.input);
  journal.registerProcess(
    5201,
    childOwnershipProof(5201, helperExecutable)
  );

  assert.equal(await base.adapters.terminateProcessTree(), false);
  await assert.rejects(
    base.adapters.cleanup(base.input),
    (error) => {
      assert.equal(error.code, "windows_harness_cleanup_child_process_failed");
      assert.equal(error.partialResult.counts.processTreesTerminated, 0);
      assert.equal(error.partialResult.counts.helperProcessesRemaining, 1);
      return true;
    }
  );
});

test("preflight refuses a missing, zero, or noncanonical package build", async () => {
  for (const fileName of [
    "postgresql-18.4-windows-x64-binaries.zip",
    "postgresql-18.4-0-windows-x64-binaries.zip",
    "PostgreSQL-18.4-2-windows-x64-binaries.zip"
  ]) {
    const base = fixture();
    base.input.packageDescriptor = {
      ...base.input.packageDescriptor,
      archivePath: path.join(base.ownedRoot, fileName)
    };
    await assert.rejects(
      base.adapters.preflight(base.input),
      { code: "windows_harness_archive_build_invalid" }
    );
  }
});

test("controller never terminates a reused helper PID after its owned child has exited, even for the same executable", async () => {
  let journal;
  let terminationCalls = 0;
  const helperExecutable = path.resolve(
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
  );
  const base = fixture({ dependencies: {
    processRunner: undefined,
    createProcessRunner(options) {
      journal = options.resourceJournal;
      return { async run() { return { stdoutSanitized: "" }; } };
    },
    systemProbe: {
      async processIdentity(pid) {
        return {
          pid,
          executablePath: helperExecutable,
          creationDate: "reused"
        };
      }
    },
    terminateProcessTree: async () => {
      terminationCalls += 1;
      return true;
    }
  } });
  await base.adapters.preflight(base.input);
  journal.registerProcess(
    5301,
    childOwnershipProof(5301, helperExecutable, () => false)
  );

  assert.equal(await base.adapters.terminateProcessTree(), true);
  assert.equal(terminationCalls, 0);
  const cleanup = await base.adapters.cleanup(base.input);
  assert.equal(cleanup.counts.helperProcessesRemaining, 0);
});

test("controller refuses an active helper whose executable identity changed", async () => {
  let journal;
  let terminationCalls = 0;
  const helperExecutable = path.resolve(
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
  );
  const base = fixture({ dependencies: {
    processRunner: undefined,
    createProcessRunner(options) {
      journal = options.resourceJournal;
      return { async run() { return { stdoutSanitized: "" }; } };
    },
    systemProbe: {
      async processIdentity(pid) {
        return {
          pid,
          executablePath: path.resolve("C:\\Windows\\System32\\tar.exe"),
          creationDate: "changed"
        };
      }
    },
    terminateProcessTree: async () => {
      terminationCalls += 1;
      return true;
    }
  } });
  await base.adapters.preflight(base.input);
  journal.registerProcess(
    5302,
    childOwnershipProof(5302, helperExecutable)
  );

  assert.equal(await base.adapters.terminateProcessTree(), false);
  assert.equal(terminationCalls, 0);
});

test("ambiguous start preserves the owned root when PID and compensation are unconfirmed", async () => {
  let startAttempted = false;
  const base = fixture({ dependencies: {
    processRunner: {
      async run(spec) {
        if (spec.label === "postgres_start") {
          startAttempted = true;
          return { stdoutSanitized: "" };
        }
        if (spec.label === "postgres_start_compensation") {
          throw new Error("synthetic_compensation_failed");
        }
        if (spec.label === "postgres_version") {
          return { stdoutSanitized: "postgres (PostgreSQL) 18.4" };
        }
        return { stdoutSanitized: "" };
      }
    },
    systemProbe: {
      async assertClean() { return systemSnapshot(!startAttempted); },
      async processAlive() { return false; },
      async listeners() { return []; }
    }
  } });
  const originalReadFile = base.storage.readFile;
  base.storage.readFile = async (target) =>
    target.endsWith("postmaster.pid") ? "not-a-pid\n" : originalReadFile(target);
  await base.adapters.preflight(base.input);
  await base.adapters.validatePackage(base.input);
  await base.adapters.extractPackage(base.input);
  await base.adapters.initializeCluster(base.input);
  await assert.rejects(base.adapters.startCluster(base.input), {
    code: "windows_harness_start_compensation_unconfirmed"
  });
  await assert.rejects(base.adapters.cleanup(base.input), {
    code: "windows_harness_cleanup_process_unconfirmed"
  });
  assert.equal(
    base.calls.removed.some((entry) => entry?.target === base.ownedRoot),
    false
  );
});

test("a failed pg_ctl start is reconciled before cleanup may remove the root", async () => {
  let startAttempted = false;
  const base = fixture({ dependencies: {
    processRunner: {
      async run(spec) {
        if (spec.label === "postgres_start") {
          startAttempted = true;
          throw new Error("synthetic_start_failed");
        }
        if (spec.label === "postgres_version") {
          return { stdoutSanitized: "postgres (PostgreSQL) 18.4" };
        }
        return { stdoutSanitized: "" };
      }
    },
    systemProbe: {
      async assertClean() { return systemSnapshot(!startAttempted); },
      async processAlive() { return false; },
      async listeners() { return []; }
    }
  } });
  await base.adapters.preflight(base.input);
  await base.adapters.validatePackage(base.input);
  await base.adapters.extractPackage(base.input);
  await base.adapters.initializeCluster(base.input);
  await assert.rejects(base.adapters.startCluster(base.input), {
    code: "windows_harness_start_compensation_unconfirmed"
  });
  await assert.rejects(base.adapters.cleanup(base.input), {
    code: "windows_harness_cleanup_process_unconfirmed"
  });
  assert.equal(
    base.calls.removed.some((entry) => entry?.target === base.ownedRoot),
    false
  );
});

test("cleanup fails closed when owned-root removal is not confirmed", async () => {
  const base = fixture();
  base.storage.removeOwnedTree = async () => false;
  await assert.rejects(base.adapters.cleanup(base.input), {
    code: "windows_harness_cleanup_owned_root_unconfirmed"
  });
});

test("physical backup gate rejects malformed per-profile metrics through the hardened collector", async () => {
  const gates = gateResults();
  gates.backupRestore = async () => ({
    ...(await gateResults().backupRestore()),
    bundle0004Sha256: "malformed"
  });
  const base = fixture({ dependencies: { physicalGates: gates } });
  await assert.rejects(
    base.adapters.runBackupRestoreGate(base.input),
    { code: "harness_bundle_sha256_invalid" }
  );
});

test("tracked Pool.connect preserves the callback contract used by pg-pool.query", async () => {
  const gates = gateResults();
  let throwingConsumerCalls = 0;
  gates.migration = async ({ state }) => {
    assert.throws(
      () => state.pools.runtime.connect(() => {
        throwingConsumerCalls += 1;
        throw new Error("synthetic_consumer_failure");
      }),
      /synthetic_consumer_failure/
    );
    const result = await state.pools.runtime.query("SELECT 1::integer AS value");
    assert.equal(result.rows[0].value, 1);
    return {
      physicalExecution: true,
      syntheticOnly: true,
      profile0004: true,
      transactionalRollback: true,
      nonSocialUnchanged: true,
      migrationsApplied: 4
    };
  };
  const base = fixture({ dependencies: { physicalGates: gates } });
  await prepareEvidenceCollection(base);
  await base.adapters.runMigrationGate(base.input);
  assert.ok(base.calls.callbackConnects >= 1);
  assert.equal(throwingConsumerCalls, 1);
});

test("Promise tracking failure releases the acquired client exactly once", async () => {
  let syntheticProcessId;
  const base = fixture({ fakeProcessId: () => syntheticProcessId });
  await prepareEvidenceCollection(base);
  syntheticProcessId = 6101;
  const runtimeClient = await base.input.context.state.windowsPhysical.pools.runtime.connect();
  const releasesBefore = base.calls.releases;
  await assert.rejects(
    base.input.context.state.windowsPhysical.pools.migration.connect(),
    { code: "windows_harness_session_ownership_conflict" }
  );
  assert.equal(base.calls.releases, releasesBefore + 1);
  runtimeClient.release();
});

test("pool release refreshes simultaneous active metrics before another pool acquires", async () => {
  const base = fixture();
  await prepareEvidenceCollection(base);
  const state = base.input.context.state.windowsPhysical;
  const runtimeClient = await state.pools.runtime.connect();
  runtimeClient.release();
  const migrationClient = await state.pools.migration.connect();
  migrationClient.release();
  const evidence = await base.adapters.collectSanitizedEvidence(base.input);
  assert.equal(evidence.metrics.poolPeakActiveGlobal, 1);
  assert.ok(evidence.metrics.poolPeakTotalGlobal >= 2);
});

test("firewall fingerprint probe sorts every multi-value filter without mutation", () => {
  const script = firewallFingerprintPowerShell();
  assert.match(script, /\[ordered\]@\{/);
  for (const field of [
    "$a.LocalAddress",
    "$a.RemoteAddress",
    "$p.Protocol",
    "$p.LocalPort",
    "$p.RemotePort",
    "$p.IcmpType",
    "$p.DynamicTarget",
    "$x.Program",
    "$x.Package",
    "$s.Service",
    "$i.InterfaceAlias",
    "$t.InterfaceType",
    "$q.Authentication",
    "$q.Encryption",
    "$q.OverrideBlockRules",
    "$q.LocalUser",
    "$q.RemoteUser",
    "$q.RemoteMachine",
    "$r.Platform"
  ]) {
    assert.match(script, new RegExp(
      field.replace(/[.$]/g, "\\$&") + "\\|Sort-Object"
    ));
  }
  assert.doesNotMatch(script, /Set-NetFirewall|New-NetFirewall|Remove-NetFirewall/);
});

test("cleanup recusa firewall alterado depois da execução", async () => {
  let reads = 0;
  const base = fixture({ dependencies: {
    systemProbe: {
      async firewallFingerprint() {
        reads += 1;
        return {
          sha256: (reads === 1 ? "d" : "e").repeat(64),
          profileCount: 3,
          ruleCount: 12
        };
      }
    }
  } });
  await base.adapters.preflight(base.input);
  await assert.rejects(base.adapters.cleanup(base.input), {
    code: "windows_harness_firewall_changed"
  });
});

test("cleanup repete a prova global e recusa processo, serviço ou listener residual", async () => {
  let cleanReads = 0;
  const base = fixture({ dependencies: {
    systemProbe: {
      async assertClean() {
        cleanReads += 1;
        return systemSnapshot(cleanReads === 1);
      }
    }
  } });
  await base.adapters.preflight(base.input);
  await assert.rejects(base.adapters.cleanup(base.input), {
    code: "windows_harness_cleanup_system_not_clean"
  });
  assert.equal(cleanReads, 2);
});

test("cleanup preserves explicit nonzero process, service and listener counts in partial evidence", async () => {
  let cleanReads = 0;
  const base = fixture({ dependencies: {
    systemProbe: {
      async assertClean() {
        cleanReads += 1;
        return cleanReads === 1
          ? { clean: true, processes: 0, services: 0, listeners: 0 }
          : { clean: false, processes: 2, services: 1, listeners: 3 };
      }
    }
  } });
  await base.adapters.preflight(base.input);
  await assert.rejects(
    base.adapters.cleanup(base.input),
    (error) => {
      assert.equal(error.code, "windows_harness_cleanup_system_not_clean");
      assert.equal(error.partialResult.counts.postgresProcessesRemaining, 2);
      assert.equal(error.partialResult.counts.postgresServicesRemaining, 1);
      assert.equal(error.partialResult.counts.postgresListenersRemaining, 3);
      assert.equal(error.partialResult.checks.processesZero, false);
      assert.equal(error.partialResult.checks.servicesZero, false);
      assert.equal(error.partialResult.checks.listenersZero, false);
      return true;
    }
  );
});

test("cleanup does not serialize unmeasured disk checkpoints as zero", async () => {
  const base = fixture();
  let cleanup;
  await assert.rejects(
    base.adapters.cleanup(base.input),
    (error) => {
      cleanup = error.partialResult;
      return error.code === "windows_harness_firewall_changed";
    }
  );
  assert.equal(Object.hasOwn(cleanup.counts, "diskInitialFreeBytes"), false);
  assert.equal(Object.hasOwn(cleanup.counts, "diskBeforeExtractionFreeBytes"), false);
  assert.equal(cleanup.counts.diskMinimumObservedFreeBytes, 8_000);
});

test("missing disk probe fields fail closed instead of becoming zero", async () => {
  const base = fixture();
  base.storage.statfs = async () => ({ bavail: null, bsize: null });
  await assert.rejects(
    base.adapters.preflight(base.input),
    { code: "windows_harness_space_probe_invalid" }
  );
});

test("invocation helper composes the real controller with explicit local package metadata", () => {
  const base = fixture();
  const invocation = createWindowsHarnessInvocation({
    approval: PHYSICAL_APPROVAL,
    adapterOptions: {
      ...base.adapterOptions,
      ownershipProof: syntheticOwnershipProof(base.ownedParent, base.ownedRoot)
    },
    packageDescriptor: base.input.packageDescriptor,
    target: base.input.target
  });
  const contract = controllerContract(invocation);
  assert.equal(contract.packageDescriptor.version, "18.4");
  assert.equal(contract.target.host, "127.0.0.1");
  assert.equal(typeof contract.adapters.preflight, "function");
  assert.equal(Object.hasOwn(contract.adapters, "downloadPackage"), false);
});
