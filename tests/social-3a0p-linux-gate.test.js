"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
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
  BASE_COMMIT,
  BRANCH,
  canonicalJson,
  containsMarkerInTree,
  createBackupTransportBridge,
  createDrainAwareRunTool,
  createGate1MigrationPoolLifecycle,
  createLinuxProfile0003PlansFacade,
  createLinuxRestoreConfigFacade,
  createPhaseRunner,
  createPhysicalPoolDrainTracker,
  createPrivatePlanPoolOptionsAdapter,
  createRoleScopedPlanPoolClass,
  createVerifiedLoginCredentialPoolBridge,
  evidenceSafe,
  failureCode,
  isLinuxRestoreDatabase,
  isRestoreEmptyTargetInventoryQuery,
  migrationEvidence,
  prepareLinuxRestoreTarget,
  publicBackupTransportEvidence,
  publicBootstrapEvidence,
  publicPlatformEvidence,
  retirePrimaryPoolsBeforeBackup,
  sanitizedFailureEvidence
} = require("../scripts/social-3a0p-linux-gate");

const ROOT = path.resolve(__dirname, "..");

test("evidence provenance matches the authorized workflow branch and parent", () => {
  const workflow = JSON.parse(fs.readFileSync(
    path.join(ROOT, ".github", "workflows", "social-3a0p-linux-physical-gates.yml"),
    "utf8"
  ));
  assert.deepEqual(workflow.on.push.branches, [BRANCH]);
  assert.equal(workflow.env.SOCIAL_3A0P_AUTHORIZED_PARENT, BASE_COMMIT);
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
  assert.deepEqual(fallback.firstFailure, { phase: "vault", code: "linux_gate_vault_failed" });
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
  let uuidCall = 0;
  const uuids = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222"
  ];
  const basePlans = {
    async prepareBackupRestore() {
      return {
        backup0003: { localBinding: { database: "ia4tube_social_disposable_source_0003_012345abcdef" } },
        restore0003: {
          localBinding: { database: "ia4tube_social_disposable_restore_0003_012345abcdef" },
          async verifyRestoredProfile() { events.push("profile-verified"); return { id: "social-schema-0003" }; }
        }
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
  assert.equal(events.filter((event) => String(event).startsWith("INSERT INTO")).length, 3);
  assert.deepEqual(await plan.restore0003.verifyRestoredProfile(), { id: "social-schema-0003" });
  assert.deepEqual(databases, [
    "ia4tube_social_disposable_source_0003_012345abcdef",
    "ia4tube_social_disposable_restore_0003_012345abcdef"
  ]);
  const evidence = adapter.evidence();
  assert.equal(evidence.profile0003SyntheticFixtureRestored, true);
  assert.equal(evidence.profile0003FixtureRows, 3);
  assert.match(evidence.profile0003FixtureIdentitySha256, /^[0-9a-f]{64}$/);
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
    'phase("rls_roles"',
    'phase("concurrency_oauth_idempotency"',
    'phase("vault"',
    'phase("backup_restore"'
  ].map((needle) => gate.indexOf(needle));
  assert.ok(order.every((index) => index >= 0));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});
