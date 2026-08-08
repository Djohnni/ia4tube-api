"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runLinuxDurabilityProof } = require("./social-3a0p-linux-durability");
const {
  DATABASE,
  IMAGE,
  IMAGE_DIGEST,
  LOOPBACK,
  MIGRATION_LOGIN,
  MIGRATOR_ROLE,
  OWNER_ROLE,
  PROVISIONER_LOGIN,
  RUNTIME_LOGIN,
  commandRunner,
  createLinuxPostgres
} = require("./social-3a0p-linux-postgres");
const {
  createRestoreBehaviorFacade,
  databaseContainsMarker,
  runConcurrencyOAuthIdempotencyGate,
  runPersistedVaultGate,
  runRlsAndRoleGate,
  runVaultSupplementalGate
} = require("./social-3a0p-linux-physical-gates");
const {
  assertSessionMetricsSafe,
  collectSessionMetrics,
  createPoolMetricsRegistry
} = require("./social-3a0p-local-runtime-evidence-metrics");

const BRANCH = "social/checkpoint-3a0p-linux-physical-gates-20260807";
const BASE_COMMIT = "36be098f926cc060ee89dff7874dab772a3ef22f";
const PRODUCT_COMMIT = "fcfc92419021dae5f77baad731c634b10c275c5b";
const MARKER = "[run-social-3a0p-linux-gate]";
const RUN_MARKER_PREFIX = "ia4tube-social-3a0p-linux-";
const EVIDENCE_FILE = "social-3a0p-linux-physical-gates-evidence.json";
const EVIDENCE_HASH_FILE = "social-3a0p-linux-physical-gates-evidence.sha256";
const SANITIZED_MARKER = ".sanitized-approved";
const LEGACY_2A_COMMIT = "9deb1e04249026a7046d44d6cbf4e2da87b9a0a4";
const PHYSICAL_POOL_DRAIN_TIMEOUT_MS = 10_000;
const SAFE_FAILURE = /^[a-z][a-z0-9_]{2,119}$/;
const SAFE_PHASE = new Set([
  "platform", "durability", "postgres", "bootstrap", "migrations", "rls_roles",
  "concurrency_oauth_idempotency", "vault", "backup_restore", "metrics", "secret_scan", "cleanup"
]);
const LINUX_RESTORE_DATABASE =
  /^ia4tube_social_disposable_(?:rollback_0003|restore_0003|restore_0004|tamper|cross)_[0-9a-f]{12}$/;
const RESTORE_APPLICATION_SCHEMAS = Object.freeze([
  "ia4tube_social",
  "ia4tube_social_admin",
  "ia4tube_migrations"
]);

class LinuxGateFailure extends Error {
  constructor(code) {
    super(code);
    this.name = "LinuxGateFailure";
    this.code = code;
  }
}

function fail(code) {
  throw new LinuxGateFailure(code);
}

function failureCode(error) {
  const candidate = String(error?.code || error?.message || "");
  return SAFE_FAILURE.test(candidate) ? candidate : "linux_gate_unclassified_failure";
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function exactDirectory(candidate, root, code) {
  if (typeof candidate !== "string" || typeof root !== "string") fail(code);
  const absolute = path.resolve(candidate);
  const base = path.resolve(root);
  const relative = path.relative(base, absolute);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail(code);
  return absolute;
}

function freeBytes(target) {
  const stat = fs.statfsSync(target);
  const value = BigInt(stat.bavail) * BigInt(stat.bsize);
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) fail("linux_gate_disk_metric_invalid");
  return Number(value);
}

function publicPlatformEvidence(runnerTemp, runCommand) {
  return Promise.all([
    runCommand("stat", ["-f", "-c", "%T", runnerTemp], {
      timeoutMs: 10_000,
      cwd: runnerTemp,
      failureCode: "linux_gate_filesystem_probe_failed"
    }),
    runCommand("npm", ["--version"], {
      timeoutMs: 10_000,
      cwd: runnerTemp,
      failureCode: "linux_gate_npm_version_probe_failed"
    })
  ]).then(([filesystem, npm]) => {
    const fsType = filesystem.stdout.trim().replaceAll("/", "-");
    const npmVersion = npm.stdout.trim();
    if (!/^[a-zA-Z0-9._-]{1,63}$/.test(fsType) || !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9._-]+)?$/.test(npmVersion)) {
      fail("linux_gate_platform_metric_invalid");
    }
    return Object.freeze({
      runner: "ubuntu-24.04",
      platform: process.platform,
      architecture: process.arch,
      kernel: os.release(),
      filesystem: fsType,
      node: process.version,
      npm: npmVersion
    });
  });
}

function evidenceSafe(value, depth = 0) {
  if (depth > 12) fail("linux_evidence_depth_invalid");
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value) && Number.isSafeInteger(value);
  if (typeof value === "string") {
    return value.length <= 300 && !/[\0\r\n\u0001-\u001f\u007f]/.test(value) &&
      !/(?:postgres(?:ql)?:\/\/|password=|bearer\s|-----BEGIN|github_pat_|ghp_|sk-[A-Za-z0-9]|eyJ[A-Za-z0-9_-]{10,}\.)/i.test(value);
  }
  if (Array.isArray(value)) return value.length <= 100 && value.every((item) => evidenceSafe(item, depth + 1));
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length > 100) return false;
  return Object.entries(value).every(([key, item]) => (
    /^[a-zA-Z][a-zA-Z0-9_]{0,79}$/.test(key) &&
    !/(password|connectionString|databaseUrl|rawState|token|secret|environmentVariables)/i.test(key) &&
    evidenceSafe(item, depth + 1)
  ));
}

function sanitizedFailureEvidence(source, code = "linux_evidence_sanitization_failed") {
  if (!SAFE_FAILURE.test(code)) fail("linux_evidence_failure_code_invalid");
  const original = source?.firstFailure;
  const firstFailure = original &&
    typeof original.phase === "string" && /^[a-z][a-z0-9_]{2,79}$/.test(original.phase) &&
    typeof original.code === "string" && SAFE_FAILURE.test(original.code)
    ? Object.freeze({ phase: original.phase, code: original.code })
    : Object.freeze({ phase: "secret_scan", code });
  const count = (name) => Number.isSafeInteger(source?.cleanup?.[name]) && source.cleanup[name] >= 0
    ? source.cleanup[name]
    : 1;
  const cleanup = Object.freeze({
    cleanupCompleted: source?.cleanup?.cleanupCompleted === true,
    containerResiduals: count("containerResiduals"),
    volumeResiduals: count("volumeResiduals"),
    networkResiduals: count("networkResiduals"),
    listenerResiduals: count("listenerResiduals"),
    temporaryRootResiduals: count("temporaryRootResiduals")
  });
  return Object.freeze({
    format: 1,
    kind: "ia4tube-social-3a0p-linux-physical-gates",
    branch: BRANCH,
    baseCommit: BASE_COMMIT,
    productCommit: PRODUCT_COMMIT,
    imageDigest: IMAGE_DIGEST,
    status: "failed",
    phases: Object.freeze([]),
    firstFailure,
    cleanupFailure: typeof source?.cleanupFailure === "string" && SAFE_FAILURE.test(source.cleanupFailure)
      ? source.cleanupFailure
      : null,
    cleanup,
    sanitizationFailure: true
  });
}

function containsMarkerInTree(root, markers) {
  const needles = markers.filter((value) => typeof value === "string" && value.length >= 16).map((value) => Buffer.from(value, "utf8"));
  let filesScanned = 0;
  let bytesScanned = 0;
  function scanFile(file, stat) {
    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const largest = Math.max(1, ...needles.map((needle) => needle.length));
    let carry = Buffer.alloc(0);
    const block = Buffer.alloc(1024 * 1024);
    try {
      while (true) {
        const read = fs.readSync(descriptor, block, 0, block.length, null);
        if (read === 0) break;
        bytesScanned += read;
        const combined = Buffer.concat([carry, block.subarray(0, read)]);
        if (needles.some((needle) => combined.indexOf(needle) >= 0)) return true;
        carry = Buffer.from(combined.subarray(Math.max(0, combined.length - largest + 1)));
      }
      filesScanned += 1;
      return false;
    } finally {
      carry.fill(0);
      block.fill(0);
      fs.closeSync(descriptor);
    }
  }
  function walk(directory) {
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) fail("linux_gate_scan_symlink_refused");
      if (stat.isDirectory()) {
        if (walk(target)) return true;
      } else if (stat.isFile() && scanFile(target, stat)) {
        return true;
      } else if (!stat.isFile()) {
        fail("linux_gate_scan_special_file_refused");
      }
    }
    return false;
  }
  const present = fs.existsSync(root) ? walk(root) : false;
  return Object.freeze({ present, filesScanned, bytesScanned });
}

function publicBootstrapEvidence(bootstrap) {
  const checks = bootstrap?.checks;
  if (
    !checks || Object.getPrototypeOf(checks) !== Object.prototype ||
    checks.roleBootstrapIdempotent !== true || checks.runtimePoolMax3 !== true ||
    checks.runtimePoolConfiguredMax !== 3 ||
    checks.syntheticCredentialsOnly !== true
  ) fail("linux_gate_bootstrap_evidence_invalid");
  return Object.freeze({
    roleBootstrapIdempotent: true,
    runtimePoolMax3: true,
    runtimePoolConfiguredMax: 3,
    syntheticCredentialsOnly: true
  });
}

function isMigrationLedgerQuery(text) {
  if (typeof text !== "string" || text.includes(";")) return false;
  const normalized = text
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s*,\s*/g, ",")
    .toLowerCase();
  return normalized === [
    "select version,checksum_sha256 as checksum",
    "from ia4tube_migrations.schema_migrations order by version"
  ].join(" ");
}

function isLinuxRestoreDatabase(database) {
  return typeof database === "string" && LINUX_RESTORE_DATABASE.test(database);
}

function isRestoreEmptyTargetInventoryQuery(text) {
  return typeof text === "string" &&
    /\bapplication_schema_count\b/i.test(text) &&
    /\buser_relation_count\b/i.test(text) &&
    /\buser_routine_count\b/i.test(text) &&
    /\bstandalone_user_type_count\b/i.test(text);
}

function exactCount(row, key, code) {
  const value = Number(row?.[key]);
  if (!Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
}

const RESTORE_TARGET_IDENTITY_SQL = [
  "SELECT",
  " current_database()=$1 AS database_exact,",
  " session_user=$2 AS login_exact,",
  " database_owner.rolname=$2 AS owner_exact",
  "FROM pg_catalog.pg_database database_info",
  "JOIN pg_catalog.pg_roles database_owner ON database_owner.oid=database_info.datdba",
  "WHERE database_info.datname=current_database()"
].join("\n");

const RESTORE_TARGET_CLUSTER_SNAPSHOT_SQL = [
  "SELECT COUNT(*)::integer AS role_count,",
  " jsonb_build_object(",
  "  'roles',COALESCE((",
  "   SELECT jsonb_agg(jsonb_build_array(role_info.rolname,role_info.rolcanlogin,role_info.rolsuper,role_info.rolcreatedb,role_info.rolcreaterole,role_info.rolinherit,role_info.rolreplication,role_info.rolbypassrls,role_info.rolconnlimit,role_info.rolpassword IS NOT NULL) ORDER BY role_info.rolname)",
  "   FROM pg_catalog.pg_roles role_info WHERE role_info.rolname=ANY($1::text[])",
  "  ),'[]'::jsonb),",
  "  'memberships',COALESCE((",
  "   SELECT jsonb_agg(jsonb_build_array(granted.rolname,member.rolname,grantor.rolname,membership.admin_option,membership.inherit_option,membership.set_option) ORDER BY granted.rolname,member.rolname,grantor.rolname)",
  "   FROM pg_catalog.pg_auth_members membership",
  "   JOIN pg_catalog.pg_roles granted ON granted.oid=membership.roleid",
  "   JOIN pg_catalog.pg_roles member ON member.oid=membership.member",
  "   JOIN pg_catalog.pg_roles grantor ON grantor.oid=membership.grantor",
  "   WHERE granted.rolname=ANY($1::text[]) OR member.rolname=ANY($1::text[])",
  "  ),'[]'::jsonb)",
  " )::text AS cluster_snapshot",
  "FROM pg_catalog.pg_roles WHERE rolname=ANY($1::text[])"
].join("\n");

const RESTORE_TARGET_INVENTORY_SQL = [
  "SELECT",
  " (SELECT COUNT(*)::integer FROM pg_catalog.pg_namespace WHERE nspname=ANY($1::text[])) AS application_schema_count,",
  " (SELECT COUNT(*)::integer FROM pg_catalog.pg_class relation JOIN pg_catalog.pg_namespace namespace ON namespace.oid=relation.relnamespace WHERE namespace.nspname=ANY($1::text[]) AND relation.relkind IN('r','p','v','m','S','f')) AS application_relation_count,",
  " (SELECT COUNT(*)::integer FROM pg_catalog.pg_class relation JOIN pg_catalog.pg_namespace namespace ON namespace.oid=relation.relnamespace WHERE namespace.nspname='ia4tube_migrations' AND relation.relname='environment_identity' AND relation.relkind IN('r','p')) AS environment_identity_count,",
  " (SELECT COUNT(*)::integer FROM pg_catalog.pg_namespace namespace WHERE namespace.nspname !~ '^pg_' AND namespace.nspname NOT IN('information_schema','public') AND NOT namespace.nspname=ANY($1::text[])) AS unexpected_schema_count,",
  " (SELECT COUNT(*)::integer FROM pg_catalog.pg_class relation JOIN pg_catalog.pg_namespace namespace ON namespace.oid=relation.relnamespace WHERE namespace.nspname !~ '^pg_' AND namespace.nspname<>'information_schema' AND NOT namespace.nspname=ANY($1::text[]) AND relation.relkind IN('r','p','v','m','S','f')) AS unexpected_relation_count,",
  " (SELECT COUNT(*)::integer FROM pg_catalog.pg_proc routine JOIN pg_catalog.pg_namespace namespace ON namespace.oid=routine.pronamespace WHERE namespace.nspname !~ '^pg_' AND namespace.nspname<>'information_schema' AND NOT namespace.nspname=ANY($1::text[])) AS unexpected_routine_count,",
  " (SELECT COUNT(*)::integer FROM pg_catalog.pg_type type_info JOIN pg_catalog.pg_namespace namespace ON namespace.oid=type_info.typnamespace WHERE namespace.nspname !~ '^pg_' AND namespace.nspname<>'information_schema' AND NOT namespace.nspname=ANY($1::text[]) AND type_info.typrelid=0 AND type_info.typtype IN('c','d','e','r','m')) AS unexpected_type_count"
].join("\n");

function validateRestoreTargetInventory(row, { allowBootstrap }) {
  const applicationSchemas = exactCount(row, "application_schema_count", "linux_gate_restore_inventory_invalid");
  const applicationRelations = exactCount(row, "application_relation_count", "linux_gate_restore_inventory_invalid");
  const environmentIdentity = exactCount(row, "environment_identity_count", "linux_gate_restore_inventory_invalid");
  const unexpected = [
    "unexpected_schema_count",
    "unexpected_relation_count",
    "unexpected_routine_count",
    "unexpected_type_count"
  ].map((key) => exactCount(row, key, "linux_gate_restore_inventory_invalid"));
  if (unexpected.some((count) => count !== 0)) fail("linux_gate_restore_target_unexpected_objects");
  const empty = applicationSchemas === 0 && applicationRelations === 0 && environmentIdentity === 0;
  const bootstrapOnly = applicationSchemas === 1 && applicationRelations === 1 && environmentIdentity === 1;
  if (!empty && (!allowBootstrap || !bootstrapOnly)) {
    fail("linux_gate_restore_target_bootstrap_footprint_invalid");
  }
  return empty;
}

async function prepareLinuxRestoreTarget({ database, query }) {
  if (!isLinuxRestoreDatabase(database) || typeof query !== "function") {
    fail("linux_gate_restore_target_contract_invalid");
  }
  const clusterRoles = [
    OWNER_ROLE,
    MIGRATOR_ROLE,
    "ia4tube_social_runtime",
    PROVISIONER_LOGIN,
    MIGRATION_LOGIN,
    RUNTIME_LOGIN
  ];
  let transactionStarted = false;
  try {
    await query("BEGIN");
    transactionStarted = true;
    const identity = await query(RESTORE_TARGET_IDENTITY_SQL, [database, PROVISIONER_LOGIN]);
    const identityRow = identity?.rows?.[0];
    if (identity?.rows?.length !== 1 || !identityRow.database_exact || !identityRow.login_exact || !identityRow.owner_exact) {
      fail("linux_gate_restore_target_identity_invalid");
    }
    const beforeCluster = await query(RESTORE_TARGET_CLUSTER_SNAPSHOT_SQL, [clusterRoles]);
    const beforeClusterRow = beforeCluster?.rows?.[0];
    if (
      exactCount(beforeClusterRow, "role_count", "linux_gate_restore_cluster_snapshot_invalid") !== clusterRoles.length ||
      typeof beforeClusterRow?.cluster_snapshot !== "string" || beforeClusterRow.cluster_snapshot.length < 2
    ) fail("linux_gate_restore_cluster_snapshot_invalid");
    const beforeInventory = await query(RESTORE_TARGET_INVENTORY_SQL, [RESTORE_APPLICATION_SCHEMAS]);
    validateRestoreTargetInventory(beforeInventory?.rows?.[0], { allowBootstrap: true });
    await query([
      `GRANT ${OWNER_ROLE} TO CURRENT_USER`,
      " WITH ADMIN FALSE, INHERIT FALSE, SET TRUE",
      " GRANTED BY CURRENT_USER"
    ].join("\n"));
    await query(`SET LOCAL ROLE ${OWNER_ROLE}`);
    for (const schema of RESTORE_APPLICATION_SCHEMAS) {
      await query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
    await query("RESET ROLE");
    await query([
      `REVOKE ${OWNER_ROLE} FROM CURRENT_USER`,
      " GRANTED BY CURRENT_USER RESTRICT"
    ].join("\n"));
    const afterCluster = await query(RESTORE_TARGET_CLUSTER_SNAPSHOT_SQL, [clusterRoles]);
    const afterClusterRow = afterCluster?.rows?.[0];
    if (
      exactCount(afterClusterRow, "role_count", "linux_gate_restore_cluster_snapshot_invalid") !== clusterRoles.length ||
      afterClusterRow.cluster_snapshot !== beforeClusterRow.cluster_snapshot
    ) fail("linux_gate_restore_cluster_identity_changed");
    const afterInventory = await query(RESTORE_TARGET_INVENTORY_SQL, [RESTORE_APPLICATION_SCHEMAS]);
    if (!validateRestoreTargetInventory(afterInventory?.rows?.[0], { allowBootstrap: false })) {
      fail("linux_gate_restore_target_not_empty");
    }
    await query("COMMIT");
    transactionStarted = false;
    return true;
  } catch (error) {
    if (transactionStarted) {
      try {
        await query("ROLLBACK");
      } catch {
        fail("linux_gate_restore_target_rollback_failed");
      }
    }
    throw error;
  }
}

function profile0003Fixture(randomUUID = crypto.randomUUID) {
  const companyId = randomUUID();
  const userId = randomUUID();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(companyId) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(userId) ||
    companyId === userId
  ) fail("linux_gate_profile0003_fixture_identity_invalid");
  return Object.freeze({
    companyId,
    userId,
    loginKeyDigest: crypto.createHash("sha256").update(`linux-profile-0003/${companyId}/${userId}`).digest("hex")
  });
}

async function profile0003Snapshot(pool, fixture, { seed, withTransactionImpl }) {
  if (!pool || typeof pool.query !== "function" || typeof withTransactionImpl !== "function") {
    fail("linux_gate_profile0003_fixture_pool_invalid");
  }
  return withTransactionImpl(pool, async (client) => {
    await client.query("SELECT pg_catalog.set_config('ia4tube.company_id',$1,true)", [fixture.companyId]);
    if (seed) {
      await client.query(
        "INSERT INTO ia4tube_social.companies(id,name,status,identity_derivation_version) VALUES($1,'Linux profile 0003 fixture','active','social-id-v1')",
        [fixture.companyId]
      );
      await client.query(
        "INSERT INTO ia4tube_social.users(company_id,id,login_key_digest,status,auth_version) VALUES($1,$2,$3,'active',1)",
        [fixture.companyId, fixture.userId, fixture.loginKeyDigest]
      );
      await client.query(
        "INSERT INTO ia4tube_social.company_memberships(company_id,user_id,role,status) VALUES($1,$2,'owner','active')",
        [fixture.companyId, fixture.userId]
      );
    }
    const result = await client.query([
      "SELECT",
      " (SELECT COUNT(*)::integer FROM ia4tube_social.companies WHERE id=$1) AS companies,",
      " (SELECT COUNT(*)::integer FROM ia4tube_social.users WHERE company_id=$1 AND id=$2 AND login_key_digest=$3) AS users,",
      " (SELECT COUNT(*)::integer FROM ia4tube_social.company_memberships WHERE company_id=$1 AND user_id=$2 AND role='owner') AS memberships,",
      " (SELECT COUNT(*)::integer FROM ia4tube_social.companies) AS tenant_companies,",
      " (SELECT COUNT(*)::integer FROM ia4tube_social.users WHERE company_id=$1) AS tenant_users,",
      " (SELECT COUNT(*)::integer FROM ia4tube_social.company_memberships WHERE company_id=$1) AS tenant_memberships"
    ].join("\n"), [fixture.companyId, fixture.userId, fixture.loginKeyDigest]);
    const row = result?.rows?.[0];
    const counts = [
      "companies", "users", "memberships", "tenant_companies", "tenant_users", "tenant_memberships"
    ].map((key) => exactCount(row, key, "linux_gate_profile0003_fixture_count_invalid"));
    if (
      result?.rows?.length !== 1 ||
      counts.slice(0, 3).some((count) => count !== 1) ||
      (seed && counts.some((count) => count !== 1))
    ) {
      fail(seed ? "linux_gate_profile0003_fixture_seed_invalid" : "linux_gate_profile0003_fixture_restore_invalid");
    }
    return Object.freeze({
      companies: counts[0],
      users: counts[1],
      memberships: counts[2],
      identitySha256: crypto.createHash("sha256")
        .update(canonicalJson({ companyId: fixture.companyId, userId: fixture.userId }))
        .digest("hex")
    });
  }, { role: OWNER_ROLE });
}

function createLinuxProfile0003PlansFacade({
  plans,
  makeMigrationPool,
  withTransactionImpl = require("../src/persistence/postgres/pool").withTransaction,
  randomUUID = crypto.randomUUID
}) {
  if (
    !plans || typeof plans.prepareBackupRestore !== "function" ||
    typeof makeMigrationPool !== "function" || typeof withTransactionImpl !== "function"
  ) fail("linux_gate_profile0003_plan_contract_invalid");
  const fixture = profile0003Fixture(randomUUID);
  let sourceSnapshot;
  let restoredSnapshot;
  let prepared = false;

  async function useMigrationPool(database, operation) {
    if (typeof database !== "string" || !database) fail("linux_gate_profile0003_database_invalid");
    const pool = makeMigrationPool(database);
    if (!pool || typeof pool.end !== "function") fail("linux_gate_profile0003_fixture_pool_invalid");
    const drain = createPhysicalPoolDrainTracker(pool);
    try {
      return await operation(pool);
    } finally {
      await drain.end(() => pool.end());
    }
  }

  const facade = Object.freeze({
    ...plans,
    async prepareBackupRestore(...args) {
      if (prepared) fail("linux_gate_profile0003_plan_reused");
      prepared = true;
      const plan = await plans.prepareBackupRestore(...args);
      const sourceDatabase = plan?.backup0003?.localBinding?.database;
      const restoreDatabase = plan?.restore0003?.localBinding?.database;
      const verifyRestoredProfile = plan?.restore0003?.verifyRestoredProfile;
      if (
        !/^ia4tube_social_disposable_source_0003_[0-9a-f]{12}$/.test(String(sourceDatabase || "")) ||
        !/^ia4tube_social_disposable_restore_0003_[0-9a-f]{12}$/.test(String(restoreDatabase || "")) ||
        typeof verifyRestoredProfile !== "function"
      ) fail("linux_gate_profile0003_plan_binding_invalid");
      sourceSnapshot = await useMigrationPool(sourceDatabase, (pool) => profile0003Snapshot(
        pool,
        fixture,
        { seed: true, withTransactionImpl }
      ));
      const restore0003 = Object.freeze({
        ...plan.restore0003,
        async verifyRestoredProfile() {
          const profile = await verifyRestoredProfile();
          restoredSnapshot = await useMigrationPool(restoreDatabase, (pool) => profile0003Snapshot(
            pool,
            fixture,
            { seed: false, withTransactionImpl }
          ));
          if (canonicalJson(restoredSnapshot) !== canonicalJson(sourceSnapshot)) {
            fail("linux_gate_profile0003_fixture_mismatch");
          }
          return profile;
        }
      });
      return Object.freeze({ ...plan, restore0003 });
    }
  });

  return Object.freeze({
    plans: facade,
    evidence() {
      if (!sourceSnapshot || !restoredSnapshot || canonicalJson(sourceSnapshot) !== canonicalJson(restoredSnapshot)) {
        fail("linux_gate_profile0003_fixture_evidence_invalid");
      }
      return Object.freeze({
        profile0003SyntheticFixtureRestored: true,
        profile0003FixtureRows: sourceSnapshot.companies + sourceSnapshot.users + sourceSnapshot.memberships,
        profile0003FixtureIdentitySha256: sourceSnapshot.identitySha256
      });
    }
  });
}

function createLinuxRestoreConfigFacade({ backupProduct, backupDirectory, fileSystem = fs }) {
  if (
    !backupProduct || typeof backupProduct.loadRestoreConfig !== "function" ||
    typeof backupDirectory !== "string" || !path.isAbsolute(backupDirectory)
  ) fail("linux_gate_restore_config_facade_invalid");
  const expectedDirectory = path.resolve(backupDirectory);
  const loadRestoreConfig = backupProduct.loadRestoreConfig.bind(backupProduct);
  return Object.freeze({
    ...backupProduct,
    loadRestoreConfig(environment, options) {
      const supplied = environment?.SOCIAL_RESTORE_BUNDLE;
      if (typeof supplied !== "string" || !path.isAbsolute(supplied)) {
        fail("linux_gate_restore_bundle_path_invalid");
      }
      const bundlePath = path.resolve(supplied);
      if (path.dirname(bundlePath) !== expectedDirectory) {
        fail("linux_gate_restore_bundle_path_invalid");
      }
      if (fileSystem.existsSync(bundlePath)) {
        return loadRestoreConfig(environment, options);
      }
      if (!/^profile-(?:0003|0004)-[0-9a-f]{12}\.ia4sb$/.test(path.basename(bundlePath))) {
        fail("linux_gate_restore_bundle_placeholder_refused");
      }
      let descriptor;
      let created = false;
      try {
        const directory = fileSystem.lstatSync(expectedDirectory);
        if (!directory.isDirectory() || directory.isSymbolicLink()) {
          fail("linux_gate_restore_bundle_directory_invalid");
        }
        descriptor = fileSystem.openSync(bundlePath, "wx", 0o600);
        created = true;
        fileSystem.closeSync(descriptor);
        descriptor = undefined;
        const placeholder = fileSystem.lstatSync(bundlePath);
        if (!placeholder.isFile() || placeholder.isSymbolicLink() || placeholder.size !== 0) {
          fail("linux_gate_restore_bundle_placeholder_invalid");
        }
        return loadRestoreConfig(environment, options);
      } finally {
        if (descriptor !== undefined) fileSystem.closeSync(descriptor);
        if (created && fileSystem.existsSync(bundlePath)) fileSystem.unlinkSync(bundlePath);
        if (created && fileSystem.existsSync(bundlePath)) {
          fail("linux_gate_restore_bundle_placeholder_cleanup_failed");
        }
      }
    }
  });
}

const physicalPoolDrainTrackers = new WeakMap();

function createPhysicalPoolDrainTracker(pool, options = {}) {
  const timeoutMs = options.timeoutMs ?? PHYSICAL_POOL_DRAIN_TIMEOUT_MS;
  if (
    !pool || typeof pool !== "object" || typeof pool.end !== "function" ||
    !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000
  ) fail("linux_gate_pool_physical_drain_contract_invalid");
  const existing = physicalPoolDrainTrackers.get(pool);
  if (existing) return existing;

  const observable = typeof pool.on === "function" && typeof pool.removeListener === "function";
  const initialClients = Array.isArray(pool._clients) ? pool._clients : [];
  if (initialClients.length !== 0 && !observable) {
    fail("linux_gate_pool_physical_drain_events_missing");
  }
  const connected = new Set(initialClients);
  const pendingRemovals = new Set();
  const waiters = new Set();
  let endPromise;

  function settleWaiters(client) {
    for (const waiter of [...waiters]) {
      waiter.remaining.delete(client);
      if (waiter.remaining.size === 0) {
        clearTimeout(waiter.timer);
        waiters.delete(waiter);
        waiter.resolve(true);
      }
    }
  }
  function onConnect(client) {
    if (client && typeof client === "object") connected.add(client);
  }
  function onAcquire(client) {
    if (client && typeof client === "object") connected.add(client);
  }
  function onRelease(error, client) {
    if (error && client && typeof client === "object") {
      connected.add(client);
      pendingRemovals.add(client);
    }
  }
  function onRemove(client) {
    connected.delete(client);
    pendingRemovals.delete(client);
    settleWaiters(client);
  }
  if (observable) {
    pool.on("connect", onConnect);
    pool.on("acquire", onAcquire);
    pool.on("release", onRelease);
    pool.on("remove", onRemove);
  }

  function waitFor(clients) {
    const remaining = new Set(clients);
    if (remaining.size === 0) return Object.freeze({ promise: Promise.resolve(true), cancel() {} });
    let resolveWaiter;
    const promise = new Promise((resolve, reject) => {
      resolveWaiter = resolve;
      const waiter = {
        remaining,
        resolve,
        timer: setTimeout(() => {
          waiters.delete(waiter);
          reject(new LinuxGateFailure("linux_gate_pool_physical_drain_timeout"));
        }, timeoutMs)
      };
      waiters.add(waiter);
    });
    return Object.freeze({
      promise,
      cancel() {
        const waiter = [...waiters].find((candidate) => candidate.remaining === remaining);
        if (!waiter) return;
        clearTimeout(waiter.timer);
        waiters.delete(waiter);
        resolveWaiter(false);
      }
    });
  }

  function detach() {
    if (!observable) return;
    pool.removeListener("connect", onConnect);
    pool.removeListener("acquire", onAcquire);
    pool.removeListener("release", onRelease);
    pool.removeListener("remove", onRemove);
  }

  const tracker = Object.freeze({
    async waitForPendingRemovals() {
      while (pendingRemovals.size !== 0) {
        await waitFor(pendingRemovals).promise;
      }
      return true;
    },
    pendingRemovalCount() {
      return pendingRemovals.size;
    },
    async end(endOperation = () => pool.end()) {
      if (typeof endOperation !== "function") fail("linux_gate_pool_physical_drain_contract_invalid");
      if (endPromise) return endPromise;
      const removal = waitFor(new Set([...connected, ...pendingRemovals]));
      let deadlineTimer;
      const deadline = new Promise((resolve, reject) => {
        deadlineTimer = setTimeout(() => {
          reject(new LinuxGateFailure("linux_gate_pool_physical_drain_timeout"));
        }, timeoutMs);
      });
      const operation = Promise.resolve().then(endOperation);
      const completion = Promise.all([operation, removal.promise]);
      endPromise = (async () => {
        try {
          const [result] = await Promise.race([completion, deadline]);
          detach();
          return result;
        } catch (error) {
          removal.cancel();
          detach();
          throw error;
        } finally {
          clearTimeout(deadlineTimer);
        }
      })();
      return endPromise;
    }
  });
  physicalPoolDrainTrackers.set(pool, tracker);
  return tracker;
}

function createDrainAwareRunTool(PlanPoolClass, runTool) {
  if (
    typeof PlanPoolClass?.awaitPendingRemovals !== "function" ||
    typeof runTool !== "function"
  ) fail("linux_gate_run_tool_drain_contract_invalid");
  return async (...args) => {
    await PlanPoolClass.awaitPendingRemovals();
    return runTool(...args);
  };
}

function retiredPoolHandle() {
  return Object.freeze({
    retired: true,
    async end() { return undefined; }
  });
}

function createGate1MigrationPoolLifecycle({ plans, state, createMigrationPool }) {
  if (
    !plans || typeof plans.createRollbackAdapter !== "function" ||
    !state?.pools?.migration || typeof state.pools.migration.end !== "function" ||
    !state?.pools?.runtime || typeof state.pools.runtime.end !== "function" ||
    typeof createMigrationPool !== "function"
  ) {
    fail("linux_gate_gate1_pool_lifecycle_invalid");
  }
  const primaryMigrationDrain = createPhysicalPoolDrainTracker(state.pools.migration);
  createPhysicalPoolDrainTracker(state.pools.runtime);
  let rollbackAdapterCreated = false;
  let migrationRetired = false;
  let migrationRecreated = false;

  const facade = Object.freeze({
    ...plans,
    async createRollbackAdapter(...args) {
      if (rollbackAdapterCreated) fail("linux_gate_gate1_rollback_adapter_reused");
      rollbackAdapterCreated = true;
      const adapter = await plans.createRollbackAdapter(...args);
      if (!adapter || typeof adapter.captureCanonical0003 !== "function") {
        fail("linux_gate_gate1_rollback_adapter_invalid");
      }
      let captureStarted = false;
      return Object.freeze({
        ...adapter,
        async captureCanonical0003(...captureArgs) {
          if (captureStarted || migrationRetired) {
            fail("linux_gate_gate1_capture_reused");
          }
          captureStarted = true;
          const migration = state.pools.migration;
          const runtime = state.pools.runtime;
          if (
            !migration || migration.retired === true || typeof migration.end !== "function" ||
            !runtime || typeof runtime.end !== "function"
          ) {
            fail("linux_gate_gate1_primary_pool_invalid");
          }
          let retirementFailed = false;
          try {
            await primaryMigrationDrain.end(() => migration.end());
          } catch {
            retirementFailed = true;
          }
          state.pools = Object.freeze({ migration: retiredPoolHandle(), runtime });
          migrationRetired = true;
          if (retirementFailed) fail("linux_gate_gate1_primary_pool_retirement_failed");
          return adapter.captureCanonical0003(...captureArgs);
        }
      });
    }
  });

  return Object.freeze({
    plans: facade,
    async recreateMigrationPoolForEvidence() {
      if (
        !migrationRetired || migrationRecreated ||
        state.pools?.migration?.retired !== true ||
        !state.pools?.runtime || typeof state.pools.runtime.end !== "function"
      ) {
        fail("linux_gate_gate1_migration_recreation_refused");
      }
      const replacement = createMigrationPool();
      const replacementDrain = replacement && typeof replacement.end === "function"
        ? createPhysicalPoolDrainTracker(replacement)
        : null;
      if (
        !replacement || typeof replacement.end !== "function" ||
        replacement.options?.user !== MIGRATION_LOGIN ||
        replacement.options?.database !== DATABASE ||
        Number(replacement.options?.max) !== 2
      ) {
        try { await replacementDrain?.end(() => replacement.end()); } catch {}
        fail("linux_gate_gate1_migration_replacement_invalid");
      }
      state.pools = Object.freeze({
        migration: replacement,
        runtime: state.pools.runtime
      });
      migrationRecreated = true;
      return true;
    }
  });
}

async function retirePrimaryPoolsBeforeBackup(state) {
  const migration = state?.pools?.migration;
  const runtime = state?.pools?.runtime;
  if (!migration || typeof migration.end !== "function" || !runtime || typeof runtime.end !== "function") {
    fail("linux_gate_primary_migration_pool_invalid");
  }
  const closed = await Promise.allSettled([
    createPhysicalPoolDrainTracker(migration).end(() => migration.end()),
    createPhysicalPoolDrainTracker(runtime).end(() => runtime.end())
  ]);
  if (closed.some((result) => result.status !== "fulfilled")) {
    fail("linux_gate_primary_pool_retirement_failed");
  }
  const retired = retiredPoolHandle();
  state.pools = Object.freeze({ migration: retired, runtime: retired });
  return true;
}

function createRoleScopedPlanPoolClass(
  BasePool,
  withTransactionImpl = require("../src/persistence/postgres/pool").withTransaction,
  createMigrationPool = null,
  prepareRestoreTarget = prepareLinuxRestoreTarget
) {
  if (
    typeof BasePool !== "function" || typeof withTransactionImpl !== "function" ||
    typeof prepareRestoreTarget !== "function"
  ) {
    fail("linux_gate_plan_pool_contract_invalid");
  }
  const instances = new Set();
  return class LinuxRoleScopedPlanPool extends BasePool {
    constructor(options) {
      super(options);
      this.linuxPhysicalDrain = createPhysicalPoolDrainTracker(this);
      this.linuxRestoreTargetPrepared = false;
      this.linuxRestoreTargetPreparing = null;
      instances.add(this);
    }

    query(...queryArgs) {
      const [text, values] = queryArgs;
      if (!isMigrationLedgerQuery(text)) return super.query(...queryArgs);
      const callback = typeof queryArgs.at(-1) === "function" ? queryArgs.at(-1) : null;
      const queryValues = typeof values === "function" ? undefined : values;
      const operation = () => {
        if (this.options?.user !== MIGRATION_LOGIN) fail("linux_gate_ledger_login_invalid");
        return withTransactionImpl(
          this,
          (client) => queryValues === undefined
            ? client.query(text)
            : client.query(text, queryValues),
          { role: MIGRATOR_ROLE }
        );
      };
      if (!callback) return Promise.resolve().then(operation);
      Promise.resolve().then(operation).then(
        (result) => callback(null, result),
        (error) => callback(error)
      );
      return undefined;
    }

    _wrapPlanClient(client) {
      if (!client || typeof client.release !== "function" || typeof client.query !== "function") {
        fail("linux_gate_plan_client_invalid");
      }
      const query = client.query.bind(client);
      client.query = (...queryArgs) => {
        const [text, values] = queryArgs;
        const restoreInventory = isRestoreEmptyTargetInventoryQuery(text);
        const ledger = isMigrationLedgerQuery(text) && this.options?.user === PROVISIONER_LOGIN;
        if (!restoreInventory && !ledger) {
          return query(...queryArgs);
        }
        const callback = typeof queryArgs.at(-1) === "function" ? queryArgs.at(-1) : null;
        const queryValues = typeof values === "function" ? undefined : values;
        const operation = async () => {
          if (restoreInventory) {
            if (!isLinuxRestoreDatabase(this.options?.database)) {
              fail("linux_gate_restore_target_database_invalid");
            }
            if (!this.linuxRestoreTargetPrepared) {
              if (!this.linuxRestoreTargetPreparing) {
                this.linuxRestoreTargetPreparing = Promise.resolve(prepareRestoreTarget({
                  database: this.options.database,
                  query
                })).then((prepared) => {
                  if (prepared !== true) fail("linux_gate_restore_target_preparation_unconfirmed");
                  this.linuxRestoreTargetPrepared = true;
                });
              }
              await this.linuxRestoreTargetPreparing;
            }
          }
          if (!ledger) return query(text, values);
          if (typeof createMigrationPool !== "function") fail("linux_gate_backup_catalog_role_missing");
          const migrationPool = createMigrationPool(this.options?.database);
          const migrationDrain = createPhysicalPoolDrainTracker(migrationPool);
          try {
            return await withTransactionImpl(
              migrationPool,
              (migrationClient) => queryValues === undefined
                ? migrationClient.query(text)
                : migrationClient.query(text, queryValues),
              { role: MIGRATOR_ROLE }
            );
          } finally {
            await migrationDrain.end(() => migrationPool.end());
          }
        };
        if (!callback) return operation();
        operation().then(
          (result) => callback(null, result),
          (error) => callback(error)
        );
        return undefined;
      };
      const release = client.release.bind(client);
      let released = false;
      client.release = (error) => {
        if (released) return undefined;
        released = true;
        return release(error || Object.assign(new Error("ephemeral plan connection"), {
          code: "linux_gate_plan_ephemeral_release"
        }));
      };
      return client;
    }

    connect(callback) {
      if (typeof callback === "function") {
        LinuxRoleScopedPlanPool.awaitPendingRemovals().then(
          () => super.connect((error, client) => {
            if (error) return callback(error);
            try {
              const wrapped = this._wrapPlanClient(client);
              return callback(null, wrapped, wrapped.release);
            } catch (wrapError) {
              try { client?.release?.(wrapError); } catch {}
              return callback(wrapError);
            }
          }),
          (error) => callback(error)
        );
        return undefined;
      }
      if (callback !== undefined) fail("linux_gate_plan_connect_contract_invalid");
      return LinuxRoleScopedPlanPool.awaitPendingRemovals()
        .then(() => super.connect())
        .then((client) => this._wrapPlanClient(client));
    }

    async end(...args) {
      try {
        return await this.linuxPhysicalDrain.end(() => super.end(...args));
      } finally {
        instances.delete(this);
      }
    }

    static async awaitPendingRemovals() {
      while (true) {
        const snapshot = [...instances];
        await Promise.all(snapshot.map((pool) => pool.linuxPhysicalDrain.waitForPendingRemovals()));
        if ([...instances].every((pool) => pool.linuxPhysicalDrain.pendingRemovalCount() === 0)) {
          return true;
        }
      }
    }

    static async closeAll() {
      const failures = [];
      for (const pool of [...instances]) {
        try { await pool.end(); } catch (error) { failures.push(error); }
      }
      if (failures.length !== 0 || instances.size !== 0) fail("linux_gate_plan_pool_cleanup_failed");
      return true;
    }
  };
}

async function materializeLegacy2ASource({ repositoryRoot, destination, runCommand }) {
  const manifest = require("../src/persistence/postgres/legacy-2a-source-manifest.json");
  const files = Object.keys(manifest.files || {}).sort();
  if (
    manifest.commit !== LEGACY_2A_COMMIT || files.length < 1 ||
    files.some((relative) => !/^[a-z0-9][a-z0-9._/-]{0,199}$/.test(relative) || relative.includes("..")) ||
    fs.existsSync(destination)
  ) fail("linux_gate_legacy_source_contract_invalid");
  fs.mkdirSync(destination, { recursive: false, mode: 0o700 });
  try {
    for (const relative of files) {
      const target = path.join(destination, ...relative.split("/"));
      const parent = path.dirname(target);
      fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
      const result = await runCommand("git", ["show", `${LEGACY_2A_COMMIT}:${relative}`], {
        timeoutMs: 30_000,
        cwd: repositoryRoot,
        failureCode: "linux_gate_legacy_source_materialization_failed"
      });
      fs.writeFileSync(target, result.stdout, { flag: "wx", mode: 0o600 });
    }
    const dependencies = path.join(repositoryRoot, "node_modules");
    if (!fs.statSync(dependencies).isDirectory()) fail("linux_gate_legacy_dependencies_missing");
    fs.symlinkSync(dependencies, path.join(destination, "node_modules"), "dir");
    const provenance = require("../src/persistence/postgres/restore-behavior-verifiers")
      .verifyLegacy2ASourceManifest(destination);
    if (provenance.commit !== LEGACY_2A_COMMIT || provenance.files !== files.length) {
      fail("linux_gate_legacy_source_identity_invalid");
    }
    return destination;
  } catch (error) {
    fs.rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

function proveMigrationManifestTamper(migrations, state) {
  const root = fs.mkdtempSync(path.join(state.workDirectory, "migration-checksum-tamper-"));
  let refused = false;
  try {
    const source = path.join(state.repositoryRoot, "db", "migrations");
    const manifest = JSON.parse(fs.readFileSync(path.join(source, "checksums.json"), "utf8"));
    for (const entry of manifest.migrations) {
      fs.copyFileSync(path.join(source, entry.file), path.join(root, entry.file), fs.constants.COPYFILE_EXCL);
    }
    const last = manifest.migrations.at(-1);
    last.sha256 = `${last.sha256[0] === "0" ? "1" : "0"}${last.sha256.slice(1)}`;
    fs.writeFileSync(path.join(root, "checksums.json"), `${JSON.stringify(manifest)}\n`, { flag: "wx", mode: 0o600 });
    try {
      migrations.readManifest({ migrationsDirectory: root, manifestPath: path.join(root, "checksums.json") });
    } catch (error) {
      refused = error?.code === "migration_checksum_mismatch";
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: false, maxRetries: 0 });
  }
  if (!refused || fs.existsSync(root)) fail("linux_gate_migration_checksum_tamper_not_refused");
  return true;
}

async function migrationEvidence(state, dependencies = {}) {
  const migrations = dependencies.migrations || require("../src/persistence/postgres/migrations");
  const withTransaction = dependencies.withTransaction || require("../src/persistence/postgres/pool").withTransaction;
  const target = {
    approval: migrations.APPLY_APPROVAL,
    productionApproval: "not-applicable-local-harness",
    environment: "local",
    environmentId: state.environmentId,
    host: LOOPBACK,
    port: String(state.target.port),
    database: DATABASE,
    username: MIGRATION_LOGIN
  };
  const runner = dependencies.migrationRunner || migrations.createMigrationRunner({
    pool: state.pools.migration,
    ownerRole: OWNER_ROLE,
    migratorRole: MIGRATOR_ROLE,
    target,
    manifestOptions: { root: state.repositoryRoot }
  });
  const reapplied = await runner.apply({ SOCIAL_MIGRATION_TARGET_FINGERPRINT: migrations.targetFingerprint(target) });
  const revalidated = await runner.validate();
  if (reapplied.length !== 0 || revalidated.valid !== true || revalidated.applied !== 4 || revalidated.pending !== 0) {
    fail("linux_gate_migration_reapply_invalid");
  }
  const checksumTamperRefused = (dependencies.proveTamper || proveMigrationManifestTamper)(migrations, state);
  return Promise.all([
    withTransaction(state.pools.migration, (client) => client.query([
      "SELECT version,checksum_sha256 AS checksum FROM ia4tube_migrations.schema_migrations ORDER BY version"
    ].join("\n")), { role: MIGRATOR_ROLE }),
    withTransaction(state.pools.migration, (client) => client.query([
      "SELECT",
      " to_regclass('ia4tube_social.social_idempotency_operations') IS NOT NULL AS idempotency,",
      " to_regclass('ia4tube_social.social_publications') IS NOT NULL AS publications,",
      " to_regclass('ia4tube_social.social_publication_attempts') IS NOT NULL AS attempts,",
      " (SELECT COUNT(*)::integer FROM pg_catalog.pg_indexes WHERE schemaname='ia4tube_social') AS indexes,",
      " (SELECT COUNT(*)::integer FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='ia4tube_social') AS constraints,",
      " (SELECT COUNT(*)::integer FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='ia4tube_social' AND c.relkind IN('r','p') AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)) AS rls_missing"
    ].join("\n")), { role: OWNER_ROLE })
  ]).then(([ledger, catalog]) => {
    const manifest = migrations.readManifest({ root: state.repositoryRoot });
    const expected = manifest.map((item) => ({ version: item.version, checksum: item.sha256 }));
    const actual = ledger.rows.map((item) => ({ version: item.version, checksum: item.checksum }));
    const row = catalog.rows?.[0];
    if (
      JSON.stringify(actual) !== JSON.stringify(expected) ||
      !row?.idempotency || !row?.publications || !row?.attempts ||
      Number(row.indexes) < 1 || Number(row.constraints) < 1 || Number(row.rls_missing) !== 0
    ) fail("linux_gate_migration_catalog_invalid");
    return Object.freeze({
      applied: actual.length,
      ledgerSha256: crypto.createHash("sha256").update(canonicalJson(actual)).digest("hex"),
      migration0004Checksum: actual.at(-1).checksum,
      requiredTablesPresent: true,
      indexes: Number(row.indexes),
      constraints: Number(row.constraints),
      rlsAndForceRls: true,
      checksumTamperRefused,
      idempotentReapply: true,
      controlledFailureRolledBack: true,
      restoredTo0003AndReapplied0004: true
    });
  });
}

function createPhaseRunner(evidence) {
  return async function phase(name, operation) {
    if (!SAFE_PHASE.has(name)) fail("linux_gate_phase_invalid");
    if (evidence.firstFailure) fail("linux_gate_phase_after_failure_refused");
    const started = Date.now();
    try {
      const result = await operation();
      evidence.phases.push({ name, status: "passed", durationMs: Date.now() - started, result });
      return result;
    } catch (error) {
      const code = failureCode(error);
      evidence.firstFailure = { phase: name, code };
      evidence.phases.push({ name, status: "failed", durationMs: Date.now() - started, code });
      throw error;
    }
  };
}

async function runLinuxGate(options = {}) {
  const runnerTemp = path.resolve(options.runnerTemp || process.env.RUNNER_TEMP || "");
  const repositoryRoot = path.resolve(options.repositoryRoot || path.join(__dirname, ".."));
  const runIdSource = options.runId || process.env.GITHUB_RUN_ID;
  const runId = `linux-${String(runIdSource || "").replace(/[^0-9]/g, "").slice(0, 30)}`;
  if (!/^linux-[0-9]{1,30}$/.test(runId)) fail("linux_gate_run_id_invalid");
  const evidenceDirectory = exactDirectory(
    options.evidenceDirectory || process.env.SOCIAL_3A0P_EVIDENCE_DIR || path.join(runnerTemp, "social-3a0p-linux-gate-evidence"),
    runnerTemp,
    "linux_gate_evidence_directory_invalid"
  );
  const evidencePath = path.join(evidenceDirectory, EVIDENCE_FILE);
  const hashPath = path.join(evidenceDirectory, EVIDENCE_HASH_FILE);
  const markerPath = options.sanitizationMarker || process.env.SOCIAL_3A0P_SANITIZATION_MARKER || path.join(evidenceDirectory, SANITIZED_MARKER);
  if (path.resolve(markerPath) !== path.resolve(path.join(evidenceDirectory, SANITIZED_MARKER))) fail("linux_gate_sanitization_marker_invalid");
  if (process.platform !== "linux" && options.allowNonLinux !== true) fail("linux_gate_linux_required");
  if (fs.existsSync(evidenceDirectory)) fail("linux_gate_evidence_collision");
  fs.mkdirSync(evidenceDirectory, { recursive: false, mode: 0o700 });
  const runCommand = options.runCommand || commandRunner();
  const poolMetrics = createPoolMetricsRegistry();
  const postgres = (options.createPostgres || createLinuxPostgres)({
    runnerTemp,
    runId,
    PoolClass: options.PoolClass || require("pg").Pool,
    metricsRegistry: poolMetrics,
    runCommand,
    randomBytes: options.randomBytes
  });
  const evidence = {
    format: 1,
    kind: "ia4tube-social-3a0p-linux-physical-gates",
    branch: BRANCH,
    baseCommit: BASE_COMMIT,
    productCommit: PRODUCT_COMMIT,
    imageDigest: IMAGE_DIGEST,
    status: "running",
    phases: [],
    firstFailure: null,
    cleanupFailure: null
  };
  let publishedEvidence = evidence;
  const phase = createPhaseRunner(evidence);
  const sensitiveMarkers = [
    postgres.materials.admin.toString("utf8"),
    postgres.materials.provisioner.toString("utf8"),
    postgres.materials.migration.toString("utf8"),
    postgres.materials.runtime.toString("utf8")
  ];
  let state;
  let plans;
  let profile0003Plans;
  let gates;
  let legacy2ARoot;
  let cleanupResult = null;
  let operationalFailure = null;
  let activePhase = "platform";
  let freeInitial = freeBytes(runnerTemp);
  let freeMinimum = freeInitial;
  let diskMonitorFailure = false;
  const recordCleanupFailure = (error) => {
    const code = failureCode(error);
    if (!evidence.cleanupFailure) evidence.cleanupFailure = code;
    if (!evidence.firstFailure) evidence.firstFailure = { phase: "cleanup", code };
    return code;
  };
  const sampleSpace = () => {
    try { freeMinimum = Math.min(freeMinimum, freeBytes(runnerTemp)); } catch { diskMonitorFailure = true; }
  };
  const diskMonitor = setInterval(sampleSpace, 500);
  diskMonitor.unref?.();
  try {
    evidence.platform = await publicPlatformEvidence(runnerTemp, runCommand);
    activePhase = "durability";
    await phase("durability", () => (options.runDurability || runLinuxDurabilityProof)({ runnerTemp }));
    sampleSpace();
    activePhase = "postgres";
    const postgresEvidence = await phase("postgres", () => postgres.start());
    sampleSpace();
    const environmentId = crypto.randomUUID();
    let bootstrap;
    let bootstrapEvidence;
    activePhase = "bootstrap";
    await phase("bootstrap", async () => {
      bootstrap = await postgres.bootstrap(repositoryRoot, environmentId);
      bootstrapEvidence = publicBootstrapEvidence(bootstrap);
      return bootstrapEvidence;
    });
    activePhase = "gate_setup";
    legacy2ARoot = await materializeLegacy2ASource({
      repositoryRoot,
      destination: path.join(postgres.runRoot, "legacy-2a-source"),
      runCommand
    });
    state = {
      target: { host: LOOPBACK, port: postgres.port },
      environmentId,
      repositoryRoot,
      workDirectory: postgres.workDirectory,
      materials: postgres.materials,
      pools: bootstrap.pools,
      PoolClass: postgres.InstrumentedPool,
      database: DATABASE,
      passwords: {
        [MIGRATION_LOGIN]: postgres.materials.migration.toString("utf8"),
        [RUNTIME_LOGIN]: postgres.materials.runtime.toString("utf8")
      }
    };
    const runMarker = `${RUN_MARKER_PREFIX}${crypto.createHash("sha256").update(runId).digest("hex").slice(0, 16)}`;
    const localBackup = require("./social-3a0p-local-backup-restore");
    const backupProduct = require("../src/persistence/postgres/backup-restore");
    let directoryFsyncBundles = 0;
    const linuxProfileBackup = (request) => localBackup.runProfileBackup({
      ...request,
      dependencies: {
        ...(request.dependencies || {}),
        async runLogicalBackup(args) {
          const result = await backupProduct.runLogicalBackup({ ...args, requireBundleDirectoryFsync: true });
          if (result.bundleDirectoryFsyncConfirmed !== true) fail("linux_gate_bundle_directory_fsync_unconfirmed");
          directoryFsyncBundles += 1;
          return result;
        }
      }
    });
    const PhysicalPlanPool = createRoleScopedPlanPoolClass(
      postgres.InstrumentedPool,
      require("../src/persistence/postgres/pool").withTransaction,
      (database) => postgres.makePool(
        database,
        MIGRATION_LOGIN,
        postgres.materials.migration,
        1,
        "ia4tube-social-3a0p-migration"
      )
    );
    const physicalRunTool = createDrainAwareRunTool(
      PhysicalPlanPool,
      postgres.createRunTool()
    );
    const windowsPlans = require("./social-3a0p-local-windows-physical-plans").createWindowsPhysicalPlans({
      approval: localBackup.LOCAL_PHYSICAL_APPROVAL,
      runMarker,
      target: state.target,
      state,
      paths: { ownedRoot: postgres.workDirectory },
      executables: { psql: "/usr/bin/psql", pgDump: "/usr/bin/pg_dump", pgRestore: "/usr/bin/pg_restore" },
      PoolClass: PhysicalPlanPool,
      repositoryRoot,
      randomBytes: options.randomBytes || crypto.randomBytes,
      dependencies: {
        backup: createLinuxRestoreConfigFacade({
          backupProduct,
          backupDirectory: path.join(postgres.workDirectory, "backups")
        }),
        runTool: physicalRunTool,
        restoreBehavior: createRestoreBehaviorFacade(legacy2ARoot)
      }
    });
    const gate1MigrationPools = createGate1MigrationPoolLifecycle({
      plans: windowsPlans,
      state,
      createMigrationPool: () => postgres.makePool(
        DATABASE,
        MIGRATION_LOGIN,
        postgres.materials.migration,
        2,
        "ia4tube-social-3a0p-migration"
      )
    });
    profile0003Plans = createLinuxProfile0003PlansFacade({
      plans: gate1MigrationPools.plans,
      makeMigrationPool: (database) => postgres.makePool(
        database,
        MIGRATION_LOGIN,
        postgres.materials.migration,
        1,
        "ia4tube-social-3a0p-migration"
      ),
      randomUUID: options.randomUUID || crypto.randomUUID
    });
    plans = profile0003Plans.plans;
    gates = require("./social-3a0p-local-connector-physical-gates").createConnectorPhysicalGates({
      plans,
      randomBytes: options.randomBytes || crypto.randomBytes,
      dependencies: { runProfileBackup: linuxProfileBackup }
    });
    gates.assertConfigured();
    activePhase = "migrations";
    await phase("migrations", async () => {
      const base = await gates.migration({ state });
      await gate1MigrationPools.recreateMigrationPoolForEvidence();
      const catalog = await migrationEvidence(state);
      return Object.freeze({ ...base, ...catalog });
    });
    sampleSpace();
    activePhase = "rls_roles";
    await phase("rls_roles", async () => {
      const base = await gates.rls({ state });
      const supplement = await runRlsAndRoleGate(state);
      return Object.freeze({ ...base, ...supplement });
    });
    activePhase = "concurrency_oauth_idempotency";
    await phase("concurrency_oauth_idempotency", async () => {
      const base = await gates.concurrency({ state });
      const supplement = await runConcurrencyOAuthIdempotencyGate(state, sensitiveMarkers);
      return Object.freeze({ ...base, ...supplement });
    });
    activePhase = "vault";
    await phase("vault", async () => {
      const base = await gates.vault({ state });
      const supplement = await runVaultSupplementalGate(state, sensitiveMarkers);
      const persisted = await runPersistedVaultGate(state, sensitiveMarkers, legacy2ARoot);
      return Object.freeze({ ...base, ...supplement, ...persisted });
    });
    activePhase = "backup_restore";
    await phase("backup_restore", async () => {
      await retirePrimaryPoolsBeforeBackup(state);
      const result = await gates.backupRestore({ state });
      if (directoryFsyncBundles !== 2) fail("linux_gate_bundle_directory_fsync_count_invalid");
      return Object.freeze({
        ...result,
        ...profile0003Plans.evidence(),
        bundleDirectoryFsyncConfirmed: true,
        bundleDirectoryFsyncCount: directoryFsyncBundles
      });
    });
    sampleSpace();
    activePhase = "plan_cleanup";
    await gates.destroy();
    gates = null;
    plans = null;
    await PhysicalPlanPool.closeAll();
    activePhase = "metrics";
    await phase("metrics", async () => {
      const admin = postgres.makePool("postgres", "ia4tube_social_local_admin", postgres.materials.admin, 1, "ia4tube-social-3a0p-administration");
      try {
        const sessions = await postgres.sessionRows(admin);
        const expectedSessions = new Map([
          [RUNTIME_LOGIN, Object.freeze({ category: "runtime", applicationName: "ia4tube-social-3a0p-runtime" })],
          [MIGRATION_LOGIN, Object.freeze({ category: "migration", applicationName: "ia4tube-social-3a0p-migration" })]
        ]);
        const ownedSessions = sessions.map((item) => {
          const expected = expectedSessions.get(item.role);
          if (!expected || item.applicationName !== expected.applicationName) fail("linux_gate_orphan_session_detected");
          return { pid: item.pid, category: expected.category, applicationName: expected.applicationName };
        });
        const sessionMetrics = collectSessionMetrics({
          sessions,
          roleCategories: {
            runtime: [RUNTIME_LOGIN],
            migration: [MIGRATION_LOGIN],
            provisioning: [PROVISIONER_LOGIN]
          },
          ownedSessions
        });
        assertSessionMetricsSafe(sessionMetrics);
        const poolEvidence = poolMetrics.snapshot();
        for (const pool of Object.values(state.pools)) {
          await createPhysicalPoolDrainTracker(pool).end(() => pool.end());
        }
        state.pools = {};
        const orphanSessionsAfterPoolClose = await postgres.orphanSessionCount(admin);
        if (orphanSessionsAfterPoolClose !== 0) fail("linux_gate_orphan_session_after_close");
        if (diskMonitorFailure) fail("linux_gate_disk_monitor_failed");
        return Object.freeze({
          pool: poolEvidence,
          sessions: sessionMetrics,
          runtimePoolConfiguredMax: bootstrapEvidence.runtimePoolConfiguredMax,
          orphanSessionsAfterPoolClose,
          orphanConnectionsZero: true,
          disk: {
            initialFreeBytes: freeInitial,
            minimumFreeBytes: freeMinimum,
            finalBeforeCleanupFreeBytes: freeBytes(runnerTemp)
          },
          postgres: postgresEvidence
        });
      } finally {
        await createPhysicalPoolDrainTracker(admin).end(() => admin.end());
      }
    });
    activePhase = "secret_scan";
    await phase("secret_scan", async () => {
      const scan = containsMarkerInTree(postgres.workDirectory, sensitiveMarkers);
      if (scan.present) fail("linux_gate_plaintext_found_in_files");
      const dataScan = await postgres.scanDataDirectoryMarkers(sensitiveMarkers);
      if (dataScan.markersPresent) fail("linux_gate_plaintext_found_in_pgdata");
      return Object.freeze({
        exactSyntheticMarkersAbsent: true,
        postgresDataMarkersAbsent: true,
        filesScanned: scan.filesScanned,
        bytesScanned: scan.bytesScanned,
        rawPostgresLogsAbsent: true,
        rawSqlAbsentFromEvidence: true
      });
    });
    evidence.status = "passed";
  } catch (error) {
    operationalFailure = error;
    evidence.status = "failed";
    if (!evidence.firstFailure) evidence.firstFailure = { phase: activePhase, code: failureCode(error) };
  } finally {
    clearInterval(diskMonitor);
    sampleSpace();
    try { await gates?.destroy?.(); } catch (error) {
      recordCleanupFailure(error);
    }
    try { await plans?.destroy?.(); } catch (error) {
      recordCleanupFailure(error);
    }
    if (state?.pools) {
      for (const pool of Object.values(state.pools)) {
        try {
          await createPhysicalPoolDrainTracker(pool).end(() => pool.end());
        } catch (error) {
          recordCleanupFailure(error);
        }
      }
    }
    const cleanupStarted = Date.now();
    try {
      cleanupResult = await postgres.cleanup();
      evidence.phases.push({ name: "cleanup", status: "passed", durationMs: Date.now() - cleanupStarted, result: cleanupResult });
    } catch (error) {
      const code = recordCleanupFailure(error);
      evidence.phases.push({ name: "cleanup", status: "failed", durationMs: Date.now() - cleanupStarted, code });
    }
    evidence.cleanup = cleanupResult || { cleanupCompleted: false };
    evidence.diskFinalFreeBytes = freeBytes(runnerTemp);
    evidence.status = evidence.status === "passed" && cleanupResult?.cleanupCompleted === true && !evidence.cleanupFailure
      ? "passed"
      : "failed";
    if (state?.passwords) {
      state.passwords[MIGRATION_LOGIN] = "";
      state.passwords[RUNTIME_LOGIN] = "";
    }
    if (!evidenceSafe(evidence)) {
      operationalFailure = operationalFailure || new LinuxGateFailure("linux_evidence_sanitization_failed");
      evidence.status = "failed";
      if (!evidence.firstFailure) evidence.firstFailure = { phase: "secret_scan", code: "linux_evidence_sanitization_failed" };
      publishedEvidence = sanitizedFailureEvidence(evidence);
    } else {
      publishedEvidence = evidence;
    }
    let serialized = `${canonicalJson(publishedEvidence)}\n`;
    if (sensitiveMarkers.some((marker) => typeof marker === "string" && marker.length >= 16 && serialized.includes(marker))) {
      operationalFailure = operationalFailure || new LinuxGateFailure("linux_evidence_secret_scan_failed");
      if (!evidence.firstFailure) evidence.firstFailure = { phase: "secret_scan", code: "linux_evidence_secret_scan_failed" };
      publishedEvidence = sanitizedFailureEvidence(evidence, "linux_evidence_secret_scan_failed");
      serialized = `${canonicalJson(publishedEvidence)}\n`;
    }
    if (!evidenceSafe(publishedEvidence) || sensitiveMarkers.some((marker) => (
      typeof marker === "string" && marker.length >= 16 && serialized.includes(marker)
    ))) fail("linux_evidence_sanitized_fallback_invalid");
    const digest = crypto.createHash("sha256").update(serialized).digest("hex");
    fs.writeFileSync(evidencePath, serialized, { flag: "wx", mode: 0o600 });
    fs.writeFileSync(hashPath, `${digest}  ${EVIDENCE_FILE}\n`, { flag: "wx", mode: 0o600 });
    fs.writeFileSync(markerPath, "sanitized-approved\n", { flag: "wx", mode: 0o600 });
    for (let index = 0; index < sensitiveMarkers.length; index += 1) sensitiveMarkers[index] = "";
  }
  const digest = fs.readFileSync(hashPath, "utf8").slice(0, 64);
  const ok = publishedEvidence.status === "passed" && fs.existsSync(markerPath) && !operationalFailure;
  return Object.freeze({
    ok,
    status: publishedEvidence.status,
    evidenceSha256: digest,
    firstFailure: publishedEvidence.firstFailure
  });
}

async function cleanupOnly(options = {}) {
  const runnerTemp = path.resolve(options.runnerTemp || process.env.RUNNER_TEMP || "");
  const runId = `linux-${String(options.runId || process.env.GITHUB_RUN_ID || "").replace(/[^0-9]/g, "").slice(0, 30)}`;
  if (!/^linux-[0-9]{1,30}$/.test(runId)) fail("linux_gate_run_id_invalid");
  const registry = createPoolMetricsRegistry();
  const postgres = createLinuxPostgres({ runnerTemp, runId, PoolClass: require("pg").Pool, metricsRegistry: registry });
  await postgres.cleanup();
  const evidenceDirectory = exactDirectory(
    options.evidenceDirectory || process.env.SOCIAL_3A0P_EVIDENCE_DIR || path.join(runnerTemp, "social-3a0p-linux-gate-evidence"),
    runnerTemp,
    "linux_gate_evidence_directory_invalid"
  );
  if (fs.existsSync(evidenceDirectory)) fs.rmSync(evidenceDirectory, { recursive: true, force: false, maxRetries: 0 });
  return Object.freeze({ cleanupCompleted: !fs.existsSync(evidenceDirectory) });
}

async function main() {
  const argument = process.argv.slice(2);
  if (argument.length !== 1 || !new Set(["--run", "--cleanup"]).has(argument[0])) fail("linux_gate_cli_invalid");
  if (argument[0] === "--cleanup") {
    const result = await cleanupOnly();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  const result = await runLinuxGate();
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${failureCode(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  BASE_COMMIT,
  BRANCH,
  EVIDENCE_FILE,
  EVIDENCE_HASH_FILE,
  LinuxGateFailure,
  MARKER,
  PRODUCT_COMMIT,
  SANITIZED_MARKER,
  canonicalJson,
  cleanupOnly,
  containsMarkerInTree,
  createDrainAwareRunTool,
  createGate1MigrationPoolLifecycle,
  createLinuxProfile0003PlansFacade,
  createLinuxRestoreConfigFacade,
  createPhaseRunner,
  createPhysicalPoolDrainTracker,
  createRoleScopedPlanPoolClass,
  evidenceSafe,
  failureCode,
  freeBytes,
  isLinuxRestoreDatabase,
  isRestoreEmptyTargetInventoryQuery,
  materializeLegacy2ASource,
  migrationEvidence,
  prepareLinuxRestoreTarget,
  profile0003Snapshot,
  proveMigrationManifestTamper,
  publicPlatformEvidence,
  publicBootstrapEvidence,
  retirePrimaryPoolsBeforeBackup,
  sanitizedFailureEvidence,
  runLinuxGate
};
