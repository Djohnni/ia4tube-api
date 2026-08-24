"use strict";

// This operator proof is intentionally synthetic. It never reads a Render,
// Meta, production, or staging credential and it accepts only a loopback
// PostgreSQL 18 service supplied by the ephemeral GitHub runner.
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Pool } = require("pg");
const {
  APPLY_APPROVAL,
  EXACT_FROM_PROFILE,
  EXACT_PENDING_MIGRATIONS,
  EXACT_TO_PROFILE,
  SOCIAL_CONNECTOR_PERSISTENCE_MIGRATION,
  STAGING_EXACT_0004_SQL_SHA256,
  STAGING_EXACT_DATABASE_SERVICE_ID,
  STAGING_EXACT_WEB_SERVICE_ID,
  createMigrationRunner,
  readStagingExactCatalogSnapshot,
  stagingExactApprovalValue,
  stagingExactCatalogDigest,
  targetFingerprint
} = require("../src/persistence/postgres/migrations");
const {
  PAID_STAGING_PUBLIC_TARGET
} = require("../src/persistence/postgres/staging-provisioner");

const MODE = "synthetic_runner_local_only_v1";
const APPROVAL = "RUN_SOCIAL_STAGING_EXACT_0004_DISPOSABLE_PG18";
const IMAGE_DIGEST =
  "sha256:7e6103cf85f88f7a0eddb3ec0b1ba8940eba098ed118ade25a729ca9daee5568";
const OWNER_ROLE = "ia4tube_social_owner";
const MIGRATOR_ROLE = "ia4tube_social_migrator";
const RUNTIME_ROLE = "ia4tube_social_runtime";
const PROVISIONER_LOGIN = PAID_STAGING_PUBLIC_TARGET.provisionerLogin;
const MIGRATION_LOGIN = PAID_STAGING_PUBLIC_TARGET.migrationLogin;
const RUNTIME_LOGIN = PAID_STAGING_PUBLIC_TARGET.runtimeLogin;
const SYNTHETIC_ROLE_DROP_ORDER = Object.freeze([
  MIGRATION_LOGIN,
  RUNTIME_LOGIN,
  MIGRATOR_ROLE,
  RUNTIME_ROLE,
  OWNER_ROLE,
  PROVISIONER_LOGIN
]);
const TARGET_DATABASE = "ia4tube_social_test_exact_0004_target";
const REFERENCE_DATABASE = "ia4tube_social_test_exact_0004_reference";
const REFERENCE_MARKER = "00000000-0000-4000-8000-000000000004";
const ARTIFACT_FILES = Object.freeze([
  "catalog-0003.json",
  "catalog-0003.json.sha256",
  "catalog-0004.json",
  "catalog-0004.json.sha256",
  "evidence.json",
  "evidence.json.sha256"
]);
const RESIDUAL_KEYS = Object.freeze([
  "advisoryLocks",
  "databases",
  "roles",
  "sessions",
  "temporaryManifests"
]);
const SHA256 = /^[0-9a-f]{64}$/;

function fail(code, cause) {
  const error = new Error(code);
  error.code = code;
  if (cause) error.cause = cause;
  throw error;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function quoteIdentifier(value) {
  if (!/^[a-z][a-z0-9_]{2,62}$/.test(value)) {
    fail("staging_exact_disposable_identifier_invalid");
  }
  return `"${value}"`;
}

function quoteLiteral(value) {
  if (typeof value !== "string" || value.length < 16 || value.length > 256) {
    fail("staging_exact_disposable_secret_invalid");
  }
  return `'${value.replaceAll("'", "''")}'`;
}

function forbiddenEnvironmentName(name) {
  const upper = String(name || "").toUpperCase();
  return upper === "DATABASE_URL" ||
    upper.startsWith("SOCIAL_MIGRATIONS_DATABASE_") ||
    upper.startsWith("SOCIAL_RUNTIME_DATABASE_") ||
    upper.startsWith("SOCIAL_PROVISIONER_DATABASE_") ||
    upper.startsWith("RENDER_") ||
    upper.startsWith("META_") ||
    upper.startsWith("FACEBOOK_") ||
    upper.startsWith("INSTAGRAM_");
}

function assertEnvironmentBoundary(env) {
  if (
    env.SOCIAL_STAGING_EXACT_DISPOSABLE_MODE !== MODE ||
    env.SOCIAL_STAGING_EXACT_DISPOSABLE_APPROVED !== APPROVAL ||
    env.SOCIAL_STAGING_EXACT_POSTGRES_IMAGE_DIGEST !== IMAGE_DIGEST
  ) {
    fail("staging_exact_disposable_approval_refused");
  }
  const forbidden = Object.keys(env).filter(
    (name) => forbiddenEnvironmentName(name) &&
      typeof env[name] === "string" && env[name].trim() !== ""
  );
  if (forbidden.length !== 0) {
    fail("staging_exact_disposable_external_environment_refused");
  }
}

function parseLoopbackAdminUrl(env) {
  const raw = env.SOCIAL_STAGING_EXACT_DISPOSABLE_URL;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (error) {
    fail("staging_exact_disposable_url_invalid", error);
  }
  if (
    parsed.protocol !== "postgresql:" ||
    !new Set(["127.0.0.1", "localhost", "::1"]).has(parsed.hostname) ||
    parsed.port !== "5432" ||
    parsed.pathname !== "/postgres" ||
    parsed.username !== "postgres" ||
    parsed.password.length < 16 ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    fail("staging_exact_disposable_url_not_loopback_admin");
  }
  return parsed;
}

function databaseUrl(adminUrl, database, username) {
  const result = new URL(adminUrl.toString());
  result.pathname = `/${database}`;
  result.username = username;
  return result.toString();
}

function pool(connectionString, applicationName) {
  return new Pool({
    connectionString,
    ssl: false,
    max: 2,
    idleTimeoutMillis: 1_000,
    connectionTimeoutMillis: 10_000,
    application_name: applicationName
  });
}

async function bootstrapCluster(adminPool, password) {
  const roles = [OWNER_ROLE, MIGRATOR_ROLE, RUNTIME_ROLE];
  for (const role of roles) {
    await adminPool.query(
      `CREATE ROLE ${quoteIdentifier(role)} NOLOGIN NOSUPERUSER ` +
      "NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS"
    );
  }
  await adminPool.query(
    `CREATE ROLE ${quoteIdentifier(PROVISIONER_LOGIN)} LOGIN NOSUPERUSER ` +
    "NOCREATEDB CREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS " +
    `PASSWORD ${quoteLiteral(password)}`
  );
  for (const login of [MIGRATION_LOGIN, RUNTIME_LOGIN]) {
    await adminPool.query(
      `CREATE ROLE ${quoteIdentifier(login)} LOGIN NOSUPERUSER ` +
      "NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS " +
      `PASSWORD ${quoteLiteral(password)}`
    );
  }
  for (const role of roles) {
    await adminPool.query(
      `GRANT ${quoteIdentifier(role)} TO ` +
      `${quoteIdentifier(PROVISIONER_LOGIN)} WITH ADMIN TRUE, ` +
      "INHERIT FALSE, SET FALSE GRANTED BY CURRENT_USER"
    );
  }
  for (const database of [TARGET_DATABASE, REFERENCE_DATABASE]) {
    await adminPool.query(
      `CREATE DATABASE ${quoteIdentifier(database)} OWNER ` +
      quoteIdentifier(PROVISIONER_LOGIN)
    );
  }
}

async function provisionDatabase(
  provisionerPool,
  database,
  environmentId,
  environmentName,
  root
) {
  const rolesSql = fs.readFileSync(
    path.join(root, "db", "postgres", "roles.sql"),
    "utf8"
  );
  await provisionerPool.query(rolesSql);
  await provisionerPool.query(
    `GRANT CONNECT ON DATABASE ${quoteIdentifier(database)} TO ` +
    quoteIdentifier(MIGRATION_LOGIN)
  );
  await provisionerPool.query(
    `GRANT CONNECT ON DATABASE ${quoteIdentifier(database)} TO ` +
    quoteIdentifier(RUNTIME_LOGIN)
  );
  for (const [role, login] of [
    [MIGRATOR_ROLE, MIGRATION_LOGIN],
    [RUNTIME_ROLE, RUNTIME_LOGIN]
  ]) {
    await provisionerPool.query(
      `GRANT ${quoteIdentifier(role)} TO ${quoteIdentifier(login)} ` +
      "WITH ADMIN FALSE, INHERIT FALSE, SET TRUE GRANTED BY CURRENT_USER"
    );
  }
  const client = await provisionerPool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `GRANT ${quoteIdentifier(OWNER_ROLE)} TO CURRENT_USER ` +
      "WITH ADMIN FALSE, INHERIT FALSE, SET TRUE GRANTED BY CURRENT_USER"
    );
    await client.query(`SET LOCAL ROLE ${quoteIdentifier(OWNER_ROLE)}`);
    await client.query(
      [
        "INSERT INTO ia4tube_migrations.environment_identity (",
        "  singleton, environment_id, environment_name",
        ") VALUES (TRUE, $1, $2)"
      ].join("\n"),
      [environmentId, environmentName]
    );
    await client.query("RESET ROLE");
    await client.query(
      `REVOKE ${quoteIdentifier(OWNER_ROLE)} FROM CURRENT_USER ` +
      "GRANTED BY CURRENT_USER RESTRICT"
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function createBaselineManifest(root, runnerTemp) {
  const directory = fs.mkdtempSync(
    path.join(runnerTemp, "ia4tube-staging-exact-baseline-")
  );
  const sourceDirectory = path.join(root, "db", "migrations");
  const manifest = JSON.parse(
    fs.readFileSync(path.join(sourceDirectory, "checksums.json"), "utf8")
  );
  const migrations = manifest.migrations.slice(0, 3);
  if (
    manifest.format !== 1 ||
    migrations.length !== 3 ||
    migrations.some((entry, index) =>
      !entry.version.startsWith(`000${index + 1}_`)
    )
  ) {
    fail("staging_exact_disposable_baseline_manifest_invalid");
  }
  for (const entry of migrations) {
    fs.copyFileSync(
      path.join(sourceDirectory, entry.file),
      path.join(directory, entry.file),
      fs.constants.COPYFILE_EXCL
    );
  }
  const manifestPath = path.join(directory, "checksums.json");
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify({ format: 1, migrations }, null, 2)}\n`,
    { flag: "wx", mode: 0o600 }
  );
  return Object.freeze({ directory, manifestPath });
}

function localTarget(database, environmentId, environmentName) {
  return Object.freeze({
    environment: environmentName,
    environmentId,
    approval: APPLY_APPROVAL,
    productionApproval: "",
    host: "127.0.0.1",
    port: "5432",
    database,
    username: MIGRATION_LOGIN
  });
}

function stagingTarget() {
  return Object.freeze({
    environment: "staging",
    environmentId: PAID_STAGING_PUBLIC_TARGET.environmentId,
    approval: APPLY_APPROVAL,
    productionApproval: "",
    host: PAID_STAGING_PUBLIC_TARGET.host,
    port: PAID_STAGING_PUBLIC_TARGET.port,
    database: PAID_STAGING_PUBLIC_TARGET.database,
    username: PAID_STAGING_PUBLIC_TARGET.migrationLogin
  });
}

function runner(migrationPool, target, manifestOptions) {
  return createMigrationRunner({
    pool: migrationPool,
    ownerRole: OWNER_ROLE,
    migratorRole: MIGRATOR_ROLE,
    target,
    ...(manifestOptions ? { manifestOptions } : {})
  });
}

async function catalogSnapshot(migrationPool) {
  const client = await migrationPool.connect();
  try {
    return await readStagingExactCatalogSnapshot(client);
  } finally {
    client.release();
  }
}

function catalogCounts(snapshot) {
  return Object.freeze(Object.fromEntries(
    Object.entries(snapshot).map(([name, rows]) => [name, rows.length])
  ));
}

function stagingRequest(beforeDigest, afterDigest) {
  const executionPackageDigest = sha256(
    Buffer.from("synthetic-staging-exact-0004-package-v1", "utf8")
  );
  const recoveryEvidenceDigest = sha256(
    Buffer.from("synthetic-staging-exact-0004-recovery-v1", "utf8")
  );
  return Object.freeze({
    fromProfile: EXACT_FROM_PROFILE,
    toProfile: EXACT_TO_PROFILE,
    expectedPending: EXACT_PENDING_MIGRATIONS,
    recoveryReference: "synthetic-runner-local-pg18-0004",
    recoveryCapturedAt: "2026-08-24T00:00:00.000Z",
    migrationSha256: STAGING_EXACT_0004_SQL_SHA256,
    executionPackageDigest,
    recoveryEvidenceDigest,
    beforeCatalogSha256: beforeDigest,
    afterCatalogSha256: afterDigest,
    recoveryStatus: "AVAILABLE",
    recoveryConcurrentOperation: "NONE",
    renderWebServiceId: STAGING_EXACT_WEB_SERVICE_ID,
    renderDatabaseServiceId: STAGING_EXACT_DATABASE_SERVICE_ID,
    databaseMarkerUuid: PAID_STAGING_PUBLIC_TARGET.environmentId,
    stagingApproval: stagingExactApprovalValue(
      executionPackageDigest,
      recoveryEvidenceDigest
    )
  });
}

async function dropSyntheticResources(adminPool) {
  for (const database of [TARGET_DATABASE, REFERENCE_DATABASE]) {
    await adminPool.query(
      "SELECT pg_catalog.pg_terminate_backend(pid) " +
      "FROM pg_catalog.pg_stat_activity " +
      "WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database]
    );
    await adminPool.query(
      `DROP DATABASE IF EXISTS ${quoteIdentifier(database)}`
    );
  }
  for (const role of SYNTHETIC_ROLE_DROP_ORDER) {
    await adminPool.query(`DROP ROLE IF EXISTS ${quoteIdentifier(role)}`);
  }
}

async function residualCounts(adminPool, runnerTemp) {
  const databases = await adminPool.query(
    "SELECT COUNT(*)::integer AS count FROM pg_catalog.pg_database " +
    "WHERE datname = ANY($1::text[])",
    [[TARGET_DATABASE, REFERENCE_DATABASE]]
  );
  const roles = await adminPool.query(
    "SELECT COUNT(*)::integer AS count FROM pg_catalog.pg_roles " +
    "WHERE rolname = ANY($1::text[])",
    [[
      PROVISIONER_LOGIN,
      MIGRATION_LOGIN,
      RUNTIME_LOGIN,
      OWNER_ROLE,
      MIGRATOR_ROLE,
      RUNTIME_ROLE
    ]]
  );
  const sessions = await adminPool.query(
    "SELECT COUNT(*)::integer AS count FROM pg_catalog.pg_stat_activity " +
    "WHERE application_name LIKE 'ia4tube-staging-exact-disposable-%' " +
    "AND pid <> pg_backend_pid()"
  );
  const locks = await adminPool.query(
    "SELECT COUNT(*)::integer AS count FROM pg_catalog.pg_locks locks " +
    "JOIN pg_catalog.pg_stat_activity activity ON activity.pid = locks.pid " +
    "WHERE locks.locktype = 'advisory' AND " +
    "activity.application_name LIKE 'ia4tube-staging-exact-disposable-%'"
  );
  const temporaryManifests = fs.readdirSync(runnerTemp).filter(
    (name) => name.startsWith("ia4tube-staging-exact-baseline-")
  ).length;
  return Object.freeze({
    advisoryLocks: locks.rows[0].count,
    databases: databases.rows[0].count,
    roles: roles.rows[0].count,
    sessions: sessions.rows[0].count,
    temporaryManifests
  });
}

function writeJsonArtifact(directory, name, value) {
  const body = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(directory, name), body, {
    flag: "wx",
    mode: 0o600
  });
  const digest = sha256(body);
  fs.writeFileSync(
    path.join(directory, `${name}.sha256`),
    `${digest}  ${name}\n`,
    { flag: "wx", mode: 0o600 }
  );
  return digest;
}

function validateEvidence(evidence) {
  if (
    !evidence ||
    evidence.schemaVersion !== 1 ||
    evidence.proof !== "staging-exact-0004-disposable" ||
    evidence.synthetic !== true ||
    evidence.realStagingAccessed !== false ||
    evidence.renderAccessed !== false ||
    evidence.externalIntegrationsAccessed !== false ||
    evidence.postgres?.major !== 18 ||
    evidence.postgres?.imageDigest !== IMAGE_DIGEST ||
    evidence.route?.planReadOnly !== true ||
    evidence.route?.applyOnce !== true ||
    evidence.route?.syntheticTargetAdapter !== true ||
    evidence.route?.actualConnectionLoopback !== true ||
    evidence.route?.canonicalTargetMetadataOnly !== true ||
    evidence.route?.postCommitValidated !== true ||
    evidence.route?.secondApplyRefused !== true ||
    evidence.route?.recoveryEvidenceExternallyVerified !== false ||
    evidence.route?.migrationId !== SOCIAL_CONNECTOR_PERSISTENCE_MIGRATION ||
    evidence.route?.migrationSha256 !== STAGING_EXACT_0004_SQL_SHA256 ||
    evidence.catalogs?.profile0003?.profile !== EXACT_FROM_PROFILE ||
    evidence.catalogs?.profile0004?.profile !== EXACT_TO_PROFILE ||
    !SHA256.test(evidence.catalogs?.profile0003?.catalogSha256 || "") ||
    !SHA256.test(evidence.catalogs?.profile0004?.catalogSha256 || "") ||
    evidence.catalogs.profile0003.catalogSha256 ===
      evidence.catalogs.profile0004.catalogSha256 ||
    RESIDUAL_KEYS.some((key) => evidence.residuals?.[key] !== 0)
  ) {
    fail("staging_exact_disposable_evidence_invalid");
  }
  return true;
}

async function runProof(env, outputDirectory) {
  assertEnvironmentBoundary(env);
  const adminUrl = parseLoopbackAdminUrl(env);
  const root = path.resolve(__dirname, "..");
  const runnerTemp = path.resolve(env.RUNNER_TEMP || os.tmpdir());
  const output = path.resolve(outputDirectory);
  const relativeOutput = path.relative(runnerTemp, output);
  if (
    relativeOutput === "" ||
    relativeOutput === ".." ||
    relativeOutput.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeOutput) ||
    output.startsWith(`${root}${path.sep}`)
  ) {
    fail("staging_exact_disposable_output_path_invalid");
  }
  fs.mkdirSync(output, { recursive: false, mode: 0o700 });

  const adminPool = pool(
    adminUrl.toString(),
    "ia4tube-staging-exact-disposable-admin"
  );
  const pools = [];
  let baselineManifest;
  let snapshot0003;
  let snapshot0004;
  let routeResult;
  let secondApplyCode = null;
  let versionNum = 0;
  let primaryError;
  let cleanupError;
  try {
    const version = await adminPool.query(
      "SELECT current_setting('server_version_num')::integer AS version_num"
    );
    versionNum = version.rows[0].version_num;
    if (versionNum < 180000 || versionNum >= 190000) {
      fail("staging_exact_disposable_postgres_18_required");
    }
    await bootstrapCluster(adminPool, decodeURIComponent(adminUrl.password));

    const targetProvisioner = pool(
      databaseUrl(adminUrl, TARGET_DATABASE, PROVISIONER_LOGIN),
      "ia4tube-staging-exact-disposable-target-provisioner"
    );
    const referenceProvisioner = pool(
      databaseUrl(adminUrl, REFERENCE_DATABASE, PROVISIONER_LOGIN),
      "ia4tube-staging-exact-disposable-reference-provisioner"
    );
    pools.push(targetProvisioner, referenceProvisioner);
    await provisionDatabase(
      targetProvisioner,
      TARGET_DATABASE,
      PAID_STAGING_PUBLIC_TARGET.environmentId,
      "staging",
      root
    );
    await provisionDatabase(
      referenceProvisioner,
      REFERENCE_DATABASE,
      REFERENCE_MARKER,
      "test",
      root
    );
    await targetProvisioner.end();
    await referenceProvisioner.end();
    pools.splice(0, pools.length);

    const targetMigration = pool(
      databaseUrl(adminUrl, TARGET_DATABASE, MIGRATION_LOGIN),
      "ia4tube-staging-exact-disposable-target-migration"
    );
    const referenceMigration = pool(
      databaseUrl(adminUrl, REFERENCE_DATABASE, MIGRATION_LOGIN),
      "ia4tube-staging-exact-disposable-reference-migration"
    );
    pools.push(targetMigration, referenceMigration);
    baselineManifest = createBaselineManifest(root, runnerTemp);
    const manifestOptions = {
      migrationsDirectory: baselineManifest.directory,
      manifestPath: baselineManifest.manifestPath
    };
    const targetLocal = localTarget(
      TARGET_DATABASE,
      PAID_STAGING_PUBLIC_TARGET.environmentId,
      "staging"
    );
    const referenceLocal = localTarget(
      REFERENCE_DATABASE,
      REFERENCE_MARKER,
      "test"
    );
    await runner(targetMigration, targetLocal, manifestOptions).apply({
      SOCIAL_MIGRATION_TARGET_FINGERPRINT: targetFingerprint(targetLocal)
    });
    await runner(referenceMigration, referenceLocal, manifestOptions).apply({
      SOCIAL_MIGRATION_TARGET_FINGERPRINT: targetFingerprint(referenceLocal)
    });

    snapshot0003 = await catalogSnapshot(targetMigration);
    const target0003Digest = stagingExactCatalogDigest(snapshot0003);
    const reference0003 = await catalogSnapshot(referenceMigration);
    if (stagingExactCatalogDigest(reference0003) !== target0003Digest) {
      fail("staging_exact_disposable_0003_not_canonical");
    }

    const exactReference = runner(referenceMigration, referenceLocal);
    const exactEnv = {
      SOCIAL_MIGRATION_TARGET_FINGERPRINT: targetFingerprint(referenceLocal)
    };
    await exactReference.applyExact({
      fromProfile: EXACT_FROM_PROFILE,
      toProfile: EXACT_TO_PROFILE,
      expectedPending: EXACT_PENDING_MIGRATIONS,
      recoveryReference: "synthetic-reference-local-pg18-0004",
      recoveryCapturedAt: "2026-08-24T00:00:00.000Z"
    }, exactEnv);
    snapshot0004 = await catalogSnapshot(referenceMigration);
    const reference0004Digest = stagingExactCatalogDigest(snapshot0004);

    const canonicalTarget = stagingTarget();
    const stagingEnv = {
      SOCIAL_MIGRATION_TARGET_FINGERPRINT:
        targetFingerprint(canonicalTarget)
    };
    const request = stagingRequest(target0003Digest, reference0004Digest);
    const stagingRunner = runner(targetMigration, canonicalTarget);
    const beforePlanDigest = stagingExactCatalogDigest(
      await catalogSnapshot(targetMigration)
    );
    const plan = await stagingRunner.planStagingExact(request, stagingEnv);
    const afterPlanDigest = stagingExactCatalogDigest(
      await catalogSnapshot(targetMigration)
    );
    if (
      plan.readOnly !== true ||
      beforePlanDigest !== afterPlanDigest ||
      plan.beforeCatalogSha256 !== target0003Digest
    ) {
      fail("staging_exact_disposable_plan_mutated");
    }
    routeResult = await stagingRunner.applyStagingExact(request, stagingEnv);
    const targetAfter = await catalogSnapshot(targetMigration);
    if (stagingExactCatalogDigest(targetAfter) !== reference0004Digest) {
      fail("staging_exact_disposable_0004_not_canonical");
    }
    try {
      await stagingRunner.applyStagingExact(request, stagingEnv);
      fail("staging_exact_disposable_second_apply_accepted");
    } catch (error) {
      secondApplyCode = error?.code || "unknown";
      if (secondApplyCode !== "exact_pending_set_mismatch") throw error;
    }
  } catch (error) {
    primaryError = error;
  } finally {
    for (const activePool of pools.reverse()) {
      await activePool.end().catch((error) => {
        if (!cleanupError) cleanupError = error;
      });
    }
    if (baselineManifest) {
      try {
        fs.rmSync(baselineManifest.directory, { recursive: true, force: true });
      } catch (error) {
        if (!cleanupError) cleanupError = error;
      }
    }
    await dropSyntheticResources(adminPool).catch((error) => {
      if (!cleanupError) cleanupError = error;
    });
  }

  let residuals;
  try {
    residuals = await residualCounts(adminPool, runnerTemp);
  } catch (error) {
    if (!cleanupError) cleanupError = error;
  } finally {
    await adminPool.end().catch((error) => {
      if (!cleanupError) cleanupError = error;
    });
  }
  if (
    cleanupError ||
    !residuals ||
    RESIDUAL_KEYS.some((key) => residuals[key] !== 0)
  ) {
    fail("staging_exact_disposable_cleanup_incomplete");
  }
  if (primaryError) throw primaryError;

  const catalog0003FileSha256 = writeJsonArtifact(
    output,
    "catalog-0003.json",
    {
      schemaVersion: 1,
      synthetic: true,
      profile: EXACT_FROM_PROFILE,
      catalogSha256: stagingExactCatalogDigest(snapshot0003),
      snapshot: snapshot0003
    }
  );
  const catalog0004FileSha256 = writeJsonArtifact(
    output,
    "catalog-0004.json",
    {
      schemaVersion: 1,
      synthetic: true,
      profile: EXACT_TO_PROFILE,
      catalogSha256: stagingExactCatalogDigest(snapshot0004),
      snapshot: snapshot0004
    }
  );
  const evidence = {
    schemaVersion: 1,
    proof: "staging-exact-0004-disposable",
    synthetic: true,
    realStagingAccessed: false,
    renderAccessed: false,
    externalIntegrationsAccessed: false,
    commit: String(env.GITHUB_SHA || "local-static-proof"),
    branch: String(env.GITHUB_REF_NAME || "local-static-proof"),
    postgres: { major: 18, versionNum, imageDigest: IMAGE_DIGEST },
    route: {
      planReadOnly: true,
      applyOnce: true,
      syntheticTargetAdapter: true,
      actualConnectionLoopback: true,
      canonicalTargetMetadataOnly: true,
      postCommitValidated: routeResult.postCommitValidated === true,
      secondApplyRefused: secondApplyCode === "exact_pending_set_mismatch",
      secondApplyCode,
      recoveryEvidenceExternallyVerified:
        routeResult.recoveryEvidenceExternallyVerified,
      migrationId: SOCIAL_CONNECTOR_PERSISTENCE_MIGRATION,
      migrationSha256: STAGING_EXACT_0004_SQL_SHA256
    },
    catalogs: {
      profile0003: {
        profile: EXACT_FROM_PROFILE,
        catalogSha256: stagingExactCatalogDigest(snapshot0003),
        artifactSha256: catalog0003FileSha256,
        counts: catalogCounts(snapshot0003)
      },
      profile0004: {
        profile: EXACT_TO_PROFILE,
        catalogSha256: stagingExactCatalogDigest(snapshot0004),
        artifactSha256: catalog0004FileSha256,
        counts: catalogCounts(snapshot0004)
      }
    },
    residuals
  };
  validateEvidence(evidence);
  writeJsonArtifact(output, "evidence.json", evidence);
  return evidence;
}

function verifyArtifacts(directory) {
  const output = path.resolve(directory);
  const actual = fs.readdirSync(output).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...ARTIFACT_FILES].sort())) {
    fail("staging_exact_disposable_artifact_inventory_invalid");
  }
  for (const name of ["catalog-0003.json", "catalog-0004.json", "evidence.json"]) {
    const file = path.join(output, name);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      fail("staging_exact_disposable_artifact_file_invalid");
    }
    const body = fs.readFileSync(file);
    const expectedSidecar = `${sha256(body)}  ${name}\n`;
    if (fs.readFileSync(`${file}.sha256`, "utf8") !== expectedSidecar) {
      fail("staging_exact_disposable_artifact_hash_invalid");
    }
  }
  const evidence = JSON.parse(
    fs.readFileSync(path.join(output, "evidence.json"), "utf8")
  );
  validateEvidence(evidence);
  const serialized = JSON.stringify(evidence);
  if (/postgresql:\/\/|password|secret|token|render\.com/i.test(serialized)) {
    fail("staging_exact_disposable_artifact_not_sanitized");
  }
  return true;
}

function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 2) {
    fail("staging_exact_disposable_argv_invalid");
  }
  const mode = argv[0];
  const match = /^--output=(.+)$/.exec(argv[1]);
  if (!new Set(["--run", "--verify"]).has(mode) || !match) {
    fail("staging_exact_disposable_argv_invalid");
  }
  return Object.freeze({ mode, output: match[1] });
}

async function main({
  env = process.env,
  argv = process.argv.slice(2),
  stdout = process.stdout,
  stderr = process.stderr
} = {}) {
  try {
    const command = parseArguments(argv);
    if (command.mode === "--run") {
      const evidence = await runProof(env, command.output);
      stdout.write(`${JSON.stringify({
        ok: true,
        synthetic: evidence.synthetic,
        profileBefore: evidence.catalogs.profile0003.profile,
        profileAfter: evidence.catalogs.profile0004.profile,
        zeroResidual: true
      })}\n`);
    } else {
      verifyArtifacts(command.output);
      stdout.write("{\"ok\":true,\"artifactsVerified\":true}\n");
    }
    return 0;
  } catch (error) {
    stderr.write(`${JSON.stringify({
      ok: false,
      code: error?.code || "staging_exact_disposable_failed"
    })}\n`);
    return 1;
  }
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; });
}

module.exports = {
  APPROVAL,
  ARTIFACT_FILES,
  IMAGE_DIGEST,
  MODE,
  RESIDUAL_KEYS,
  SYNTHETIC_ROLE_DROP_ORDER,
  forbiddenEnvironmentName,
  main,
  parseArguments,
  parseLoopbackAdminUrl,
  validateEvidence,
  verifyArtifacts
};
