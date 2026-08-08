"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  LOCAL_PHYSICAL_APPROVAL
} = require("../scripts/social-3a0p-local-backup-restore");
const {
  MIGRATION_LOGIN,
  PROVISIONER_LOGIN,
  RUNTIME_LOGIN,
  WindowsPhysicalPlanFailure,
  assertLocalToolPlan,
  createLocalPgToolRunner,
  createWindowsPhysicalPlans
} = require("../scripts/social-3a0p-local-windows-physical-plans");

const RUN_MARKER = "ia4tube-social-3a0p-physical-plan-test-0001";
const TARGET = Object.freeze({ host: "127.0.0.1", port: 55432 });
const OWNED_ROOT = path.resolve("C:\\synthetic-owned\\ia4tube-social-3a0p-plan-test");
const EXECUTABLES = Object.freeze({
  psql: path.join(OWNED_ROOT, "pgsql", "bin", "psql.exe"),
  pgDump: path.join(OWNED_ROOT, "pgsql", "bin", "pg_dump.exe"),
  pgRestore: path.join(OWNED_ROOT, "pgsql", "bin", "pg_restore.exe")
});

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
    async create(identity) { return Object.freeze({ ...identity, created: true }); },
    async applyProfile() { return true; },
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
    }
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
    assert.equal(bridgeCalls.length, 4);
    assert.equal(fixture.configLoads.length, 2);
    assert.equal(fixture.restoreConfigLoads.length, 2);
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
      prepared.restore0004
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
    }
    assert.equal(fixture.runToolCalls.length, 0);
    assert.equal(fixture.pgDumpStarts.length, 0);
    assert.equal(fixture.processStarts.length, 0);
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
