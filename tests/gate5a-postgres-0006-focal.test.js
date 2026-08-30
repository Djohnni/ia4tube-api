"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { Pool } = require("pg");

const migrations = require("../src/persistence/postgres/migrations");
const loginBootstrap = require("../src/persistence/postgres/login-bootstrap");
const {
  withTransaction
} = require("../src/persistence/postgres/pool");
const {
  createPostgresConnectorStore
} = require("../src/persistence/postgres/social-connector-store");
const {
  createPostgresMetaComplianceRepository
} = require("../src/persistence/postgres/meta-compliance-repository");
const {
  createSocialAuthAdapter
} = require("../src/social/auth-adapter");
const {
  createConnectorContext
} = require("../src/social/connectors/contract");
const {
  createMetaComplianceService
} = require("../src/social/compliance/meta-compliance-service");
const {
  createMetaSignedRequestVerifier
} = require("../src/social/compliance/meta-signed-request");
const {
  SESSION_AUDIENCE,
  SESSION_ISSUER
} = require("../src/social/reauth");

const ROOT = path.resolve(__dirname, "..");
const POSTGRES_BIN = process.platform === "linux"
  ? "/usr/lib/postgresql/18/bin"
  : "C:\\IA4Tube_Recovery\\Tools\\PostgreSQL-18.6-1-Portable\\bin";
const ADMISSION =
  "I_AUTHORIZE_ONE_DISPOSABLE_POSTGRES_18_6_GATE5A_0006_RUN";
const DATABASE = "ia4tube_social_test_gate5a_0006";
const ADMIN_LOGIN = "postgres";
const PROVISIONER_LOGIN = "gate5a_provisioner";
const MIGRATION_LOGIN = "gate5a_migration_login";
const RUNTIME_LOGIN = "gate5a_runtime_login";
const KEY_VERSION = "gate5a-synthetic-v1";
const EXTERNAL_A = "17841400000000001";
const EXTERNAL_B = "17841400000000002";
const OWNER_ROLE = loginBootstrap.OWNER_ROLE;
const MIGRATOR_ROLE = loginBootstrap.MIGRATOR_ROLE;
const RUNTIME_ROLE = loginBootstrap.RUNTIME_ROLE;
const AUTHORIZED =
  process.env.IA4TUBE_GATE5A_0006_PHYSICAL_APPROVED === ADMISSION;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function postgresBinary(name) {
  const resolved = path.join(
    POSTGRES_BIN,
    process.platform === "win32" ? `${name}.exe` : name
  );
  if (!fs.statSync(resolved).isFile()) fail("gate5a_portable_binary_missing");
  return resolved;
}

function run(binary, args, code, timeout = 60000) {
  const result = childProcess.spawnSync(binary, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout
  });
  if (result.error || result.status !== 0) fail(code);
  return String(result.stdout || "").trim();
}

function strongSecret() {
  return `Aa1!${crypto.randomBytes(36).toString("base64url")}`;
}

function quoteIdentifier(value) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) {
    fail("gate5a_identifier_invalid");
  }
  return `"${value}"`;
}

function hidden(properties, name, value) {
  const result = { ...properties };
  Object.defineProperty(result, name, {
    value,
    enumerable: false,
    writable: false,
    configurable: false
  });
  return Object.freeze(result);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function connectionUrl({ port, database, user, password }) {
  const url = new URL(`postgresql://127.0.0.1:${port}/${database}`);
  url.username = user;
  url.password = password;
  return url.toString();
}

function poolOptions({ port, database, user, password, max, name }) {
  return Object.freeze({
    host: "127.0.0.1",
    port,
    database,
    user,
    password,
    ssl: false,
    max,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 5000,
    application_name: name,
    options: [
      "-c statement_timeout=30000",
      "-c lock_timeout=5000",
      "-c idle_in_transaction_session_timeout=15000",
      "-c search_path=pg_catalog"
    ].join(" ")
  });
}

async function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else if (!Number.isSafeInteger(port) || port < 1024) {
          reject(new Error("gate5a_loopback_port_invalid"));
        } else resolve(port);
      });
    });
  });
}

function safeRemoveDisposableRoot(root) {
  const resolved = path.resolve(root);
  const temp = path.resolve(os.tmpdir());
  if (
    path.dirname(resolved).toLowerCase() !== temp.toLowerCase() ||
    !/^ia4tube-gate5a-pg18-/.test(path.basename(resolved))
  ) {
    fail("gate5a_disposable_root_refused");
  }
  fs.rmSync(resolved, { recursive: true, force: false });
}

async function createDisposableCluster(password) {
  const observedVersion = run(
    postgresBinary("postgres"),
    ["--version"],
    "gate5a_postgres_version_probe_failed"
  );
  if (!/^postgres \(PostgreSQL\) 18\.6(?:$|[ \t])/.test(observedVersion)) {
    fail("gate5a_postgres_version_mismatch");
  }
  const version = "postgres (PostgreSQL) 18.6";

  const port = await reserveLoopbackPort();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-gate5a-pg18-"));
  const data = path.join(root, "data");
  const passwordFile = path.join(root, "initdb-password.txt");
  const log = path.join(root, "postgres.log");
  let started = false;
  let starts = 0;
  let restarts = 0;

  function pgControlStatus() {
    if (!fs.existsSync(data)) return false;
    const result = childProcess.spawnSync(
      postgresBinary("pg_ctl"),
      ["-D", data, "status"],
      { encoding: "utf8", windowsHide: true, timeout: 10000 }
    );
    return !result.error && result.status === 0;
  }

  function reconcileStop() {
    const pidPath = path.join(data, "postmaster.pid");
    if (!started && !pgControlStatus() && !fs.existsSync(pidPath)) return;
    const fast = childProcess.spawnSync(
      postgresBinary("pg_ctl"),
      ["-D", data, "-m", "fast", "-w", "stop"],
      { encoding: "utf8", windowsHide: true, timeout: 90000 }
    );
    if (
      (fast.error || fast.status !== 0) &&
      (pgControlStatus() || fs.existsSync(pidPath))
    ) {
      const immediate = childProcess.spawnSync(
        postgresBinary("pg_ctl"),
        ["-D", data, "-m", "immediate", "-w", "stop"],
        { encoding: "utf8", windowsHide: true, timeout: 90000 }
      );
      if (
        (immediate.error || immediate.status !== 0) &&
        (pgControlStatus() || fs.existsSync(pidPath))
      ) {
        fail("gate5a_pg_cleanup_stop_unconfirmed");
      }
    }
    if (pgControlStatus() || fs.existsSync(pidPath)) {
      fail("gate5a_pg_cleanup_stop_unconfirmed");
    }
    started = false;
  }

  function start() {
    if (started) fail("gate5a_cluster_already_started");
    const result = childProcess.spawnSync(
      postgresBinary("pg_ctl"),
      [
        "-D",
        data,
        "-l",
        log,
        "-o",
        [
          `-p ${port}`,
          "-h 127.0.0.1",
          "-c ssl=off",
          "-c fsync=on",
          "-c synchronous_commit=on",
          "-c full_page_writes=on",
          "-c password_encryption=scram-sha-256",
          "-c max_connections=40",
          "-c shared_buffers=32MB",
          "-c logging_collector=off",
          "-c log_min_messages=warning",
          ...(process.platform === "linux"
            ? ["-c unix_socket_directories=''"]
            : [])
        ].join(" "),
        "-w",
        "start"
      ],
      { encoding: "utf8", windowsHide: true, timeout: 90000 }
    );
    started = pgControlStatus() || fs.existsSync(path.join(data, "postmaster.pid"));
    if (result.error || result.status !== 0 || !started) {
      fail("gate5a_pg_start_failed");
    }
    starts += 1;
  }

  function restart() {
    const pidPath = path.join(data, "postmaster.pid");
    if (!started || !pgControlStatus()) {
      fail("gate5a_pg_restart_source_not_running");
    }
    const stopped = childProcess.spawnSync(
      postgresBinary("pg_ctl"),
      ["-D", data, "-m", "fast", "-w", "stop"],
      { encoding: "utf8", windowsHide: true, timeout: 90000 }
    );
    started = pgControlStatus() || fs.existsSync(pidPath);
    if (stopped.error || stopped.status !== 0 || started) {
      fail("gate5a_pg_restart_stop_failed");
    }
    start();
    restarts += 1;
  }

  function cleanup() {
    reconcileStop();
    if (pgControlStatus() || fs.existsSync(path.join(data, "postmaster.pid"))) {
      fail("gate5a_pg_cleanup_stop_unconfirmed");
    }
    safeRemoveDisposableRoot(root);
    if (fs.existsSync(root)) fail("gate5a_pg_cleanup_root_present");
    const readiness = childProcess.spawnSync(
      postgresBinary("pg_isready"),
      ["-h", "127.0.0.1", "-p", String(port), "-d", "postgres"],
      { encoding: "utf8", windowsHide: true, timeout: 10000 }
    );
    if (readiness.error || readiness.status === 0) {
      fail("gate5a_pg_cleanup_readiness_invalid");
    }
    return Object.freeze({ starts, restarts, removed: true });
  }

  try {
    fs.writeFileSync(passwordFile, password, {
      encoding: "utf8",
      mode: 0o600
    });
    try {
      run(
        postgresBinary("initdb"),
        [
          "-D",
          data,
          `--username=${ADMIN_LOGIN}`,
          `--pwfile=${passwordFile}`,
          "--auth-local=scram-sha-256",
          "--auth-host=scram-sha-256",
          "--encoding=UTF8",
          "--locale=C",
          "--data-checksums",
          "--no-instructions"
        ],
        "gate5a_initdb_failed",
        90000
      );
    } finally {
      fs.rmSync(passwordFile, { force: true });
    }
    start();
    return Object.freeze({ cleanup, data, port, restart, root, version });
  } catch (creationFailure) {
    try {
      cleanup();
    } catch {
      const cleanupFailure = new Error(
        "gate5a_disposable_cleanup_failed_during_creation"
      );
      cleanupFailure.code = "gate5a_disposable_cleanup_failed_during_creation";
      cleanupFailure.cause = creationFailure;
      throw cleanupFailure;
    }
    throw creationFailure;
  }
}

async function provisionDatabase(cluster, secrets) {
  const adminPool = new Pool(poolOptions({
    port: cluster.port,
    database: "postgres",
    user: ADMIN_LOGIN,
    password: secrets.admin,
    max: 1,
    name: "ia4tube-gate5a-admin"
  }));
  let admin;
  let adminFailure;
  let adminCleanupFailure;
  let transaction = false;
  try {
    admin = await adminPool.connect();
    await admin.query("BEGIN");
    transaction = true;
    await admin.query("SET LOCAL password_encryption='scram-sha-256'");
    await admin.query(
      [
        "SELECT",
        " pg_catalog.set_config('ia4tube.gate5a.login',$1,true),",
        " pg_catalog.set_config('ia4tube.gate5a.password',$2,true)"
      ].join("\n"),
      [PROVISIONER_LOGIN, secrets.provisioner]
    );
    await admin.query(
      [
        "DO $gate5a_provisioner$",
        "DECLARE",
        " login_name TEXT := current_setting('ia4tube.gate5a.login');",
        " login_password TEXT := current_setting('ia4tube.gate5a.password');",
        "BEGIN",
        " IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=login_name) THEN",
        "  RAISE EXCEPTION 'gate5a_provisioner_collision';",
        " END IF;",
        " EXECUTE format(",
        "  'CREATE ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB CREATEROLE ' ||",
        "  'NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD %L',",
        "  login_name,login_password",
        " );",
        "END",
        "$gate5a_provisioner$;"
      ].join("\n")
    );
    await admin.query("COMMIT");
    transaction = false;
    await admin.query(
      `CREATE DATABASE ${quoteIdentifier(DATABASE)} ` +
        `OWNER ${quoteIdentifier(PROVISIONER_LOGIN)} ` +
        "TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'"
    );
  } catch (error) {
    if (transaction && admin) await admin.query("ROLLBACK").catch(() => {});
    adminFailure = error;
  } finally {
    if (admin) {
      const client = admin;
      admin = null;
      try { client.release(); } catch (error) { adminCleanupFailure = error; }
    }
    try { await adminPool.end(); } catch (error) { adminCleanupFailure = error; }
  }
  if (adminCleanupFailure) {
    const error = new Error("gate5a_admin_pool_cleanup_failed");
    error.code = "gate5a_admin_pool_cleanup_failed";
    error.cause = adminFailure || adminCleanupFailure;
    throw error;
  }
  if (adminFailure) throw adminFailure;

  const provisionerOptions = poolOptions({
    port: cluster.port,
    database: DATABASE,
    user: PROVISIONER_LOGIN,
    password: secrets.provisioner,
    max: 1,
    name: "ia4tube-gate5a-provisioner"
  });
  const provisionerPool = new Pool(provisionerOptions);
  const bootstrapTarget = Object.freeze({
    host: "127.0.0.1",
    port: String(cluster.port),
    database: DATABASE,
    provisionerLogin: PROVISIONER_LOGIN,
    migrationLogin: MIGRATION_LOGIN,
    runtimeLogin: RUNTIME_LOGIN
  });
  const bootstrapConfiguration = Object.freeze({
    target: bootstrapTarget,
    targetFingerprint: loginBootstrap.targetFingerprint(bootstrapTarget),
    provisionerPool: Object.freeze({
      ...provisionerOptions,
      connectionString: connectionUrl({
        port: cluster.port,
        database: DATABASE,
        user: PROVISIONER_LOGIN,
        password: secrets.provisioner
      })
    }),
    migration: hidden({
      login: MIGRATION_LOGIN,
      role: MIGRATOR_ROLE,
      connectionLimit: loginBootstrap.MIGRATION_CONNECTION_LIMIT
    }, "password", secrets.migration),
    runtime: hidden({
      login: RUNTIME_LOGIN,
      role: RUNTIME_ROLE,
      connectionLimit: loginBootstrap.RUNTIME_CONNECTION_LIMIT
    }, "password", secrets.runtime)
  });
  let provisioner;
  let provisionerFailure;
  let provisionerCleanupFailure;
  try {
    try {
      provisioner = await provisionerPool.connect();
      await provisioner.query(
        fs.readFileSync(
          path.join(ROOT, "db", "postgres", "roles.sql"),
          "utf8"
        )
      );
      await provisioner.query("BEGIN");
      try {
        await provisioner.query(
          "GRANT ia4tube_social_owner TO CURRENT_USER " +
            "WITH ADMIN FALSE, INHERIT FALSE, SET TRUE GRANTED BY CURRENT_USER"
        );
        await provisioner.query("SET LOCAL ROLE ia4tube_social_owner");
        await provisioner.query(
          [
            "INSERT INTO ia4tube_migrations.environment_identity (",
            " singleton,environment_id,environment_name",
            ") VALUES(TRUE,$1,'test')"
          ].join("\n"),
          [secrets.environmentId]
        );
        await provisioner.query("RESET ROLE");
        await provisioner.query(
          "REVOKE ia4tube_social_owner FROM CURRENT_USER " +
            "GRANTED BY CURRENT_USER RESTRICT"
        );
        await provisioner.query("COMMIT");
      } catch (error) {
        await provisioner.query("ROLLBACK").catch(() => {});
        throw error;
      }
    } finally {
      if (provisioner) {
        const client = provisioner;
        provisioner = null;
        client.release();
      }
    }

    const bootstrapped = await loginBootstrap.bootstrapDatabaseLogins(
      provisionerPool,
      bootstrapConfiguration
    );
    assert.deepEqual(bootstrapped.created, { migration: true, runtime: true });
    assert.deepEqual(
      await loginBootstrap.verifyProvisionedLoginCredentials(
        Pool,
        bootstrapConfiguration
      ),
      { safe: true, verified: 2 }
    );
  } catch (error) {
    provisionerFailure = error;
  } finally {
    if (provisioner) {
      const client = provisioner;
      provisioner = null;
      try { client.release(); } catch (error) { provisionerCleanupFailure = error; }
    }
    try {
      await provisionerPool.end();
    } catch (error) {
      provisionerCleanupFailure = error;
    }
  }
  if (provisionerCleanupFailure) {
    const error = new Error("gate5a_provisioner_pool_cleanup_failed");
    error.code = "gate5a_provisioner_pool_cleanup_failed";
    error.cause = provisionerFailure || provisionerCleanupFailure;
    throw error;
  }
  if (provisionerFailure) throw provisionerFailure;
  return bootstrapConfiguration;
}

async function makeApplicationPools(cluster, secrets) {
  const result = {};
  try {
    result.migration = new Pool(poolOptions({
      port: cluster.port,
      database: DATABASE,
      user: MIGRATION_LOGIN,
      password: secrets.migration,
      max: 2,
      name: "ia4tube-gate5a-migration"
    }));
    result.runtime = new Pool(poolOptions({
      port: cluster.port,
      database: DATABASE,
      user: RUNTIME_LOGIN,
      password: secrets.runtime,
      max: 3,
      name: "ia4tube-gate5a-runtime"
    }));
    return result;
  } catch (error) {
    await closePools(result).catch(() => {});
    throw error;
  }
}

async function closePools(pools) {
  const unique = [...new Set(
    Object.values(pools || {}).filter((pool) => pool && typeof pool.end === "function")
  )];
  await Promise.all(unique.map((pool) => pool.end()));
}

function createPrefixManifest(cluster) {
  const destination = path.join(cluster.root, "prefix-0005", "db", "migrations");
  fs.mkdirSync(destination, { recursive: true });
  const manifest = JSON.parse(
    fs.readFileSync(path.join(ROOT, "db", "migrations", "checksums.json"), "utf8")
  );
  const firstFive = manifest.migrations.slice(0, 5);
  assert.equal(firstFive.length, 5);
  assert.equal(firstFive[4].version, "0005_fix_social_reference_checks");
  for (const entry of firstFive) {
    fs.copyFileSync(
      path.join(ROOT, "db", "migrations", entry.file),
      path.join(destination, entry.file)
    );
  }
  fs.writeFileSync(
    path.join(destination, "checksums.json"),
    `${JSON.stringify({ format: 1, migrations: firstFive }, null, 2)}\n`,
    "utf8"
  );
  return path.join(cluster.root, "prefix-0005");
}

function migrationTarget(cluster, environmentId) {
  return Object.freeze({
    environment: "test",
    environmentId,
    host: "127.0.0.1",
    port: String(cluster.port),
    database: DATABASE,
    username: MIGRATION_LOGIN,
    approval: migrations.APPLY_APPROVAL
  });
}

function migrationEnvironment(target) {
  return Object.freeze({
    SOCIAL_MIGRATION_TARGET_FINGERPRINT: migrations.targetFingerprint(target)
  });
}

async function physicalProfile(pool, profile) {
  const client = await pool.connect();
  try {
    return await migrations.withRoleTransaction(client, MIGRATOR_ROLE, () =>
      migrations.verifySocialPhysicalProfile(
        client,
        profile,
        OWNER_ROLE,
        RUNTIME_ROLE
      )
    );
  } finally {
    client.release();
  }
}

async function ledgerSnapshot(pool) {
  return withTransaction(
    pool,
    (client) => client.query(
      [
        "SELECT COUNT(*)::integer AS total,",
        " COUNT(*) FILTER (WHERE version=$1)::integer AS compliance_count",
        "FROM ia4tube_migrations.schema_migrations"
      ].join("\n"),
      [migrations.SOCIAL_COMPLIANCE_PERSISTENCE_MIGRATION]
    ),
    { role: MIGRATOR_ROLE }
  );
}

async function proveSyntheticRollback(pool, migration) {
  const client = await pool.connect();
  let transaction = false;
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    transaction = true;
    await client.query(`SET LOCAL ROLE ${quoteIdentifier(OWNER_ROLE)}`);
    await client.query(migration.sql);
    await client.query(
      [
        "INSERT INTO ia4tube_migrations.schema_migrations (",
        " version,checksum_sha256,execution_ms",
        ") VALUES($1,$2,0)"
      ].join("\n"),
      [migration.version, migration.sha256]
    );
    await client.query(`SET LOCAL ROLE ${quoteIdentifier(MIGRATOR_ROLE)}`);
    const inside = await migrations.verifySocialPhysicalProfile(
      client,
      migrations.COMPLIANCE_TO_PROFILE,
      OWNER_ROLE,
      RUNTIME_ROLE
    );
    assert.equal(inside.profile, migrations.COMPLIANCE_TO_PROFILE);
    await client.query("ROLLBACK");
    transaction = false;
  } catch (error) {
    if (transaction) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  const after = await ledgerSnapshot(pool);
  assert.equal(after.rows[0].total, 5);
  assert.equal(after.rows[0].compliance_count, 0);
  const absent = await withTransaction(
    pool,
    (client) => client.query(
      [
        "SELECT",
        " to_regclass('ia4tube_social.social_meta_subject_mappings') IS NULL",
        "  AS mappings_absent,",
        " to_regclass('ia4tube_social.social_compliance_requests') IS NULL",
        "  AS requests_absent"
      ].join("\n")
    ),
    { role: MIGRATOR_ROLE }
  );
  assert.equal(absent.rows[0].mappings_absent, true);
  assert.equal(absent.rows[0].requests_absent, true);
  assert.equal(
    (await physicalProfile(pool, migrations.COMPLIANCE_FROM_PROFILE)).profile,
    migrations.COMPLIANCE_FROM_PROFILE
  );
}

function createFixture(
  identityConfig,
  label,
  legacyId,
  externalId,
  accountType,
  nonceByte
) {
  const authAdapter = createSocialAuthAdapter(identityConfig);
  const principal = authAdapter.fromVerifiedJwt({
    token_version: 2,
    iss: SESSION_ISSUER,
    aud: SESSION_AUDIENCE,
    jti: `gate5a-synthetic-jwt-${label}-000001`,
    sub: legacyId,
    whatsapp: legacyId,
    company_id: legacyId
  });
  const context = createConnectorContext({
    principal,
    provider: "instagram",
    environment: "test",
    correlationId: crypto.randomUUID(),
    auditEventId: crypto.randomUUID()
  });
  return Object.freeze({
    label,
    context,
    companyId: principal.companyId,
    userId: principal.userId,
    connectionId: crypto.randomUUID(),
    accountId: crypto.randomUUID(),
    credentialId: crypto.randomUUID(),
    externalId,
    accountType,
    nonceByte,
    ciphertext: crypto.createHash("sha256")
      .update(`gate5a-synthetic-ciphertext-${label}`)
      .digest()
  });
}

async function seedTenant(pool, fixture) {
  await withTransaction(
    pool,
    async (client) => {
      await client.query(
        [
          "INSERT INTO ia4tube_social.companies (",
          " id,name,identity_derivation_version",
          ") VALUES($1,$2,'social-id-v1')"
        ].join("\n"),
        [fixture.companyId, `Gate5A Synthetic Company ${fixture.label}`]
      );
      await client.query(
        [
          "INSERT INTO ia4tube_social.users (",
          " company_id,id,login_key_digest",
          ") VALUES($1,$2,$3)"
        ].join("\n"),
        [fixture.companyId, fixture.userId, sha256(`login-${fixture.label}`)]
      );
      await client.query(
        [
          "INSERT INTO ia4tube_social.company_memberships (",
          " company_id,user_id,role",
          ") VALUES($1,$2,'owner')"
        ].join("\n"),
        [fixture.companyId, fixture.userId]
      );
      await client.query(
        [
          "INSERT INTO ia4tube_social.social_connections (",
          " company_id,id,provider,status,connected_at,created_by_user_id",
          ") VALUES($1,$2,'instagram','connected',CURRENT_TIMESTAMP,$3)"
        ].join("\n"),
        [fixture.companyId, fixture.connectionId, fixture.userId]
      );
      await client.query(
        [
          "INSERT INTO ia4tube_social.social_external_accounts (",
          " company_id,id,connection_id,provider,external_id,username,",
          " display_name,account_type,status",
          ") VALUES($1,$2,$3,'instagram',$4,$5,$6,$7,'active')"
        ].join("\n"),
        [
          fixture.companyId,
          fixture.accountId,
          fixture.connectionId,
          fixture.externalId,
          `gate5a_${fixture.label.toLowerCase()}`,
          `Gate5A Synthetic ${fixture.label}`,
          fixture.accountType
        ]
      );
      await client.query(
        [
          "INSERT INTO ia4tube_social.social_encrypted_credentials (",
          " company_id,id,provider,connection_id,credential_type,",
          " ciphertext,nonce,auth_tag,key_version,aad_version",
          ") VALUES($1,$2,'instagram',$3,'instagram_user_access_token',",
          " $4,$5,$6,$7,1)"
        ].join("\n"),
        [
          fixture.companyId,
          fixture.credentialId,
          fixture.connectionId,
          fixture.ciphertext,
          Buffer.alloc(12, fixture.nonceByte),
          Buffer.alloc(16, fixture.nonceByte + 1),
          KEY_VERSION
        ]
      );
    },
    { role: OWNER_ROLE, companyId: fixture.companyId }
  );
}

async function seedSyntheticState(pool, fixtures) {
  await withTransaction(
    pool,
    (client) => client.query(
      "INSERT INTO ia4tube_social_admin.vault_key_versions(key_version) VALUES($1)",
      [KEY_VERSION]
    ),
    { role: OWNER_ROLE }
  );
  for (const fixture of fixtures) await seedTenant(pool, fixture);
}

function signedRequest(externalId, issuedAt, secret) {
  const payload = Buffer.from(JSON.stringify({
    algorithm: "HMAC-SHA256",
    issued_at: issuedAt,
    user_id: externalId
  }), "utf8").toString("base64url");
  const signature = crypto.createHmac("sha256", secret)
    .update(payload, "ascii")
    .digest("base64url");
  return `${signature}.${payload}`;
}

function complianceRuntime(pool, now, appSecret) {
  const repository = createPostgresMetaComplianceRepository({
    pool,
    runtimeRole: RUNTIME_ROLE,
    appSecret
  });
  const verifier = createMetaSignedRequestVerifier({
    appSecret,
    clock: () => now,
    maxAgeSeconds: 3600,
    futureSkewSeconds: 60
  });
  const service = createMetaComplianceService({
    signedRequestVerifier: verifier,
    repository,
    publicStatusBaseUrl:
      "https://staging.example.invalid/v1/social/compliance/meta/data-deletion/status",
    clock: () => now
  });
  return Object.freeze({ repository, service, verifier });
}

async function installLegacyMappings(runtimePool, repository, a, b) {
  const storeA = createPostgresConnectorStore({
    pool: runtimePool,
    runtimeRole: RUNTIME_ROLE
  }).scope(a.context);
  const storeB = createPostgresConnectorStore({
    pool: runtimePool,
    runtimeRole: RUNTIME_ROLE
  }).scope(b.context);
  const mappingA = repository.subjectMappingForExternalUser({
    provider: "instagram",
    externalUserId: a.externalId
  });
  const mappingB = repository.subjectMappingForExternalUser({
    provider: "instagram",
    externalUserId: b.externalId
  });
  const concurrent = await Promise.all([
    storeA.ensureLegacyComplianceSubjectMapping({
      connectionId: a.connectionId,
      externalUserId: a.externalId,
      subjectMapping: mappingA
    }),
    storeA.ensureLegacyComplianceSubjectMapping({
      connectionId: a.connectionId,
      externalUserId: a.externalId,
      subjectMapping: mappingA
    })
  ]);
  assert.deepEqual(
    concurrent.map((item) => item.created).sort(),
    [false, true]
  );
  assert.deepEqual(
    await storeB.ensureLegacyComplianceSubjectMapping({
      connectionId: b.connectionId,
      externalUserId: b.externalId,
      subjectMapping: mappingB
    }),
    { created: true }
  );
}

async function tenantIsolationSnapshot(pool, a, b) {
  const ownA = await withTransaction(
    pool,
    (client) => client.query(
      [
        "SELECT",
        " (SELECT COUNT(*)::integer FROM ia4tube_social.social_meta_subject_mappings) AS mappings,",
        " (SELECT COUNT(*)::integer FROM ia4tube_social.social_compliance_requests) AS requests,",
        " (SELECT COUNT(*)::integer FROM ia4tube_social.social_encrypted_credentials) AS credentials"
      ].join("\n")
    ),
    { role: RUNTIME_ROLE, companyId: a.companyId }
  );
  const ownB = await withTransaction(
    pool,
    (client) => client.query(
      [
        "SELECT",
        " (SELECT COUNT(*)::integer FROM ia4tube_social.social_meta_subject_mappings) AS mappings,",
        " (SELECT COUNT(*)::integer FROM ia4tube_social.social_compliance_requests) AS requests,",
        " (SELECT COUNT(*)::integer FROM ia4tube_social.social_encrypted_credentials) AS credentials"
      ].join("\n")
    ),
    { role: RUNTIME_ROLE, companyId: b.companyId }
  );
  const cross = await withTransaction(
    pool,
    (client) => client.query(
      [
        "SELECT COUNT(*)::integer AS count",
        "FROM ia4tube_social.social_meta_subject_mappings",
        "WHERE company_id=$1"
      ].join("\n"),
      [b.companyId]
    ),
    { role: RUNTIME_ROLE, companyId: a.companyId }
  );
  const missing = await withTransaction(
    pool,
    (client) => client.query(
      "SELECT COUNT(*)::integer AS count FROM ia4tube_social.social_meta_subject_mappings"
    ),
    { role: RUNTIME_ROLE }
  );
  assert.equal(cross.rows[0].count, 0);
  assert.equal(missing.rows[0].count, 0);
  return Object.freeze({ ownA: ownA.rows[0], ownB: ownB.rows[0] });
}

async function authoritativeSnapshot(cluster, secrets, a, b) {
  const pool = new Pool(poolOptions({
    port: cluster.port,
    database: DATABASE,
    user: ADMIN_LOGIN,
    password: secrets.admin,
    max: 1,
    name: "ia4tube-gate5a-readonly-evidence"
  }));
  try {
    const result = await pool.query(
      [
        "SELECT",
        " (SELECT COUNT(*)::integer FROM ia4tube_social.social_encrypted_credentials WHERE company_id=$1) AS credentials_a,",
        " (SELECT COUNT(*)::integer FROM ia4tube_social.social_encrypted_credentials WHERE company_id=$2) AS credentials_b,",
        " (SELECT COUNT(*)::integer FROM ia4tube_social.social_compliance_requests WHERE company_id=$1) AS requests_a,",
        " (SELECT COUNT(*)::integer FROM ia4tube_social.social_compliance_requests WHERE company_id=$2) AS requests_b,",
        " (SELECT COUNT(*)::integer FROM ia4tube_social.social_audit_events WHERE company_id=$1 AND action LIKE 'social.compliance.%') AS audits_a,",
        " (SELECT COUNT(*)::integer FROM ia4tube_social.social_audit_events WHERE company_id=$2 AND action LIKE 'social.compliance.%') AS audits_b,",
        " (SELECT COUNT(*)::integer FROM ia4tube_social.social_publications) AS publications,",
        " (SELECT status FROM ia4tube_social.social_connections WHERE company_id=$1 AND id=$3) AS connection_a_status,",
        " (SELECT status FROM ia4tube_social.social_connections WHERE company_id=$2 AND id=$4) AS connection_b_status,",
        " (SELECT status FROM ia4tube_social.social_meta_subject_mappings WHERE company_id=$1) AS mapping_a_status,",
        " (SELECT status FROM ia4tube_social.social_meta_subject_mappings WHERE company_id=$2) AS mapping_b_status,",
        " (SELECT encode(ciphertext,'hex') FROM ia4tube_social.social_encrypted_credentials WHERE company_id=$2) AS ciphertext_b_hex,",
        " (SELECT COALESCE(jsonb_agg(to_jsonb(audit)),'[]'::jsonb)::text FROM ia4tube_social.social_audit_events audit WHERE company_id=$1 AND action LIKE 'social.compliance.%') AS audit_json"
      ].join("\n"),
      [a.companyId, b.companyId, a.connectionId, b.connectionId]
    );
    return result.rows[0];
  } finally {
    await pool.end();
  }
}

test(
  "Gate 5A: PostgreSQL 18.6 disposable focal proves migration 0006 and compliance persistence",
  { skip: !AUTHORIZED, timeout: 600000 },
  async () => {
    const secrets = {
      admin: strongSecret(),
      provisioner: strongSecret(),
      migration: strongSecret(),
      runtime: strongSecret(),
      environmentId: crypto.randomUUID(),
      appSecret: crypto.randomBytes(32),
      identityKey: crypto.randomBytes(32)
    };
    let cluster;
    let pools = {};
    let compliance;
    let evidence;
    let primaryFailure;
    let cleanupFailure;
    let cleanupEvidence;
    try {
      cluster = await createDisposableCluster(secrets.admin);
      await provisionDatabase(cluster, secrets);
      pools = await makeApplicationPools(cluster, secrets);

      const target = migrationTarget(cluster, secrets.environmentId);
      const env = migrationEnvironment(target);
      const prefixRoot = createPrefixManifest(cluster);
      const prefixRunner = migrations.createMigrationRunner({
        pool: pools.migration,
        ownerRole: OWNER_ROLE,
        migratorRole: MIGRATOR_ROLE,
        target,
        manifestOptions: { root: prefixRoot }
      });
      const prefixApplied = await prefixRunner.apply(env);
      assert.equal(prefixApplied.length, 5);
      assert.equal(
        (await physicalProfile(pools.migration, migrations.COMPLIANCE_FROM_PROFILE)).profile,
        migrations.COMPLIANCE_FROM_PROFILE
      );

      const identityConfig = Object.freeze({
        namespaceUuid: "41cb8c58-0bf4-4bd9-83b2-3f2f96dfe29f",
        key: secrets.identityKey,
        derivationVersion: "social-id-v1"
      });
      const a = createFixture(
        identityConfig,
        "A",
        "gate5a-synthetic-company-a",
        EXTERNAL_A,
        "business",
        17
      );
      const b = createFixture(
        identityConfig,
        "B",
        "gate5a-synthetic-company-b",
        EXTERNAL_B,
        "creator",
        33
      );
      await seedSyntheticState(pools.migration, [a, b]);

      const fullManifest = migrations.readManifest();
      const migration0006 = fullManifest.find(
        (entry) => entry.version === migrations.SOCIAL_COMPLIANCE_PERSISTENCE_MIGRATION
      );
      assert.ok(migration0006);
      const request = Object.freeze({
        fromProfile: migrations.COMPLIANCE_FROM_PROFILE,
        toProfile: migrations.COMPLIANCE_TO_PROFILE,
        expectedPending: migrations.COMPLIANCE_PENDING_MIGRATIONS,
        migrationSha256: migrations.STAGING_COMPLIANCE_0006_SQL_SHA256
      });
      const runner = migrations.createMigrationRunner({
        pool: pools.migration,
        ownerRole: OWNER_ROLE,
        migratorRole: MIGRATOR_ROLE,
        target
      });
      const beforePlanLedger = await ledgerSnapshot(pools.migration);
      const plan = await runner.planMetaCompliance(request, env);
      const afterPlanLedger = await ledgerSnapshot(pools.migration);
      assert.equal(plan.readOnly, true);
      assert.equal(plan.planApproved, true);
      assert.deepEqual(plan.observedPending, [
        migrations.SOCIAL_COMPLIANCE_PERSISTENCE_MIGRATION
      ]);
      assert.equal(beforePlanLedger.rows[0].total, 5);
      assert.equal(afterPlanLedger.rows[0].total, 5);

      await proveSyntheticRollback(pools.migration, migration0006);

      const applied = await runner.applyMetaCompliance(request, env);
      assert.equal(applied.appliedMigration, migration0006.version);
      assert.equal(applied.finalProfile, migrations.COMPLIANCE_TO_PROFILE);
      assert.equal(applied.postCommitValidated, true);
      const appliedLedger = await ledgerSnapshot(pools.migration);
      assert.equal(appliedLedger.rows[0].total, 6);
      assert.equal(appliedLedger.rows[0].compliance_count, 1);
      let secondApplicationRefused = false;
      try {
        await runner.applyMetaCompliance(request, env);
      } catch (error) {
        assert.equal(error.code, "migration_compliance_pending_set_mismatch");
        secondApplicationRefused = true;
      }
      assert.equal(secondApplicationRefused, true);
      const afterRefusalLedger = await ledgerSnapshot(pools.migration);
      assert.equal(afterRefusalLedger.rows[0].total, 6);
      assert.equal(afterRefusalLedger.rows[0].compliance_count, 1);

      const now = Date.now();
      compliance = complianceRuntime(pools.runtime, now, secrets.appSecret);
      await installLegacyMappings(pools.runtime, compliance.repository, a, b);
      const isolatedBefore = await tenantIsolationSnapshot(pools.runtime, a, b);
      assert.deepEqual(isolatedBefore.ownA, {
        mappings: 1,
        requests: 0,
        credentials: 1
      });
      assert.deepEqual(isolatedBefore.ownB, {
        mappings: 1,
        requests: 0,
        credentials: 1
      });

      const signed = signedRequest(
        a.externalId,
        Math.floor(now / 1000),
        secrets.appSecret
      );
      const deauthorization = await compliance.service.handleDeauthorization({
        signedRequest: signed
      });
      assert.equal(deauthorization.kind, "deauthorization");
      assert.equal(deauthorization.replayed, false);
      assert.equal(deauthorization.tokenMaterialsDeleted, 1);
      assert.match(deauthorization.confirmationCode, /^[A-Za-z0-9_-]{32}$/);

      const deletion = await compliance.service.handleDataDeletion({
        signedRequest: signed
      });
      assert.equal(deletion.kind, "data_deletion");
      assert.equal(deletion.replayed, false);
      assert.equal(deletion.tokenMaterialsDeleted, 0);
      assert.notEqual(deletion.confirmationCode, deauthorization.confirmationCode);
      assert.match(deletion.confirmationCode, /^[A-Za-z0-9_-]{32}$/);
      const replay = await compliance.service.handleDataDeletion({
        signedRequest: signed
      });
      assert.equal(replay.replayed, true);
      assert.equal(replay.tokenMaterialsDeleted, 0);
      assert.equal(replay.confirmationCode, deletion.confirmationCode);
      assert.deepEqual(
        await compliance.service.getStatus({
          confirmationCode: deletion.confirmationCode
        }),
        { status: "completed" }
      );
      await assert.rejects(
        compliance.service.getStatus({ confirmationCode: "Z".repeat(32) }),
        (error) => error.code === "meta_confirmation_unavailable" &&
          error.statusCode === 404
      );

      const isolatedAfter = await tenantIsolationSnapshot(pools.runtime, a, b);
      assert.deepEqual(isolatedAfter.ownA, {
        mappings: 1,
        requests: 2,
        credentials: 0
      });
      assert.deepEqual(isolatedAfter.ownB, {
        mappings: 1,
        requests: 0,
        credentials: 1
      });

      compliance.verifier.destroy();
      compliance.repository.destroy();
      compliance = null;
      await closePools(pools);
      pools = {};
      cluster.restart();
      pools = await makeApplicationPools(cluster, secrets);

      const afterRestart = complianceRuntime(
        pools.runtime,
        now,
        secrets.appSecret
      );
      compliance = afterRestart;
      assert.deepEqual(
        await compliance.service.getStatus({
          confirmationCode: deletion.confirmationCode
        }),
        { status: "completed" }
      );
      const replayAfterRestart = await compliance.service.handleDataDeletion({
        signedRequest: signed
      });
      assert.equal(replayAfterRestart.replayed, true);
      assert.equal(replayAfterRestart.tokenMaterialsDeleted, 0);
      assert.equal(
        replayAfterRestart.confirmationCode,
        deletion.confirmationCode
      );
      assert.equal(
        (await physicalProfile(pools.migration, migrations.COMPLIANCE_TO_PROFILE)).profile,
        migrations.COMPLIANCE_TO_PROFILE
      );
      const postRestartRunner = migrations.createMigrationRunner({
        pool: pools.migration,
        ownerRole: OWNER_ROLE,
        migratorRole: MIGRATOR_ROLE,
        target
      });
      const validated = await postRestartRunner.validate();
      assert.equal(validated.applied, 6);
      assert.equal(validated.pending, 0);

      const authoritative = await authoritativeSnapshot(cluster, secrets, a, b);
      assert.deepEqual(
        {
          credentialsA: authoritative.credentials_a,
          credentialsB: authoritative.credentials_b,
          requestsA: authoritative.requests_a,
          requestsB: authoritative.requests_b,
          auditsA: authoritative.audits_a,
          auditsB: authoritative.audits_b,
          publications: authoritative.publications
        },
        {
          credentialsA: 0,
          credentialsB: 1,
          requestsA: 2,
          requestsB: 0,
          auditsA: 2,
          auditsB: 0,
          publications: 0
        }
      );
      assert.equal(authoritative.connection_a_status, "revoked");
      assert.equal(authoritative.connection_b_status, "connected");
      assert.equal(authoritative.mapping_a_status, "revoked");
      assert.equal(authoritative.mapping_b_status, "active");
      assert.equal(authoritative.ciphertext_b_hex, b.ciphertext.toString("hex"));
      for (const forbidden of [
        a.externalId,
        signed,
        signed.split(".")[0],
        deauthorization.confirmationCode,
        deletion.confirmationCode
      ]) {
        assert.equal(authoritative.audit_json.includes(forbidden), false);
      }

      evidence = Object.freeze({
        postgresVersion: cluster.version,
        initialProfile: migrations.COMPLIANCE_FROM_PROFILE,
        planReadOnly: true,
        rollbackSynthetic: true,
        appliedExactlyOnce: true,
        ledger0006ExactlyOnce: true,
        secondApplicationRefused: true,
        finalProfile: migrations.COMPLIANCE_TO_PROFILE,
        pendingAfter: 0,
        tenantIsolationAB: true,
        deauthorizationThenDataDeletion: true,
        replaySafe: true,
        opaqueStatus: true,
        syntheticCredentialRowsBeforeAfter: "2/1",
        targetedSyntheticCredentialDeleted: true,
        crossTenantDeletion: false,
        publicationsCreated: 0,
        persistenceAfterRestart: true,
        externalMetaCalls: 0,
        externalInstagramCalls: 0,
        externalPublicationCalls: 0,
        realDataUsed: false
      });
    } catch (error) {
      primaryFailure = error;
    } finally {
      if (compliance) {
        try { compliance.verifier.destroy(); } catch {}
        try { compliance.repository.destroy(); } catch {}
      }
      try {
        await closePools(pools);
      } catch (error) {
        cleanupFailure = error;
      }
      if (cluster) {
        try {
          cleanupEvidence = cluster.cleanup();
        } catch (error) {
          cleanupFailure = error;
        }
      }
      secrets.appSecret.fill(0);
      secrets.identityKey.fill(0);
    }

    if (cleanupFailure) {
      const failure = new Error("gate5a_disposable_cleanup_failed");
      failure.code = "gate5a_disposable_cleanup_failed";
      failure.cause = primaryFailure || cleanupFailure;
      throw failure;
    }
    if (primaryFailure) throw primaryFailure;
    assert.deepEqual(cleanupEvidence, { starts: 2, restarts: 1, removed: true });
    process.stdout.write(`${JSON.stringify({
      gate: "GATE5A_POSTGRES_0006_FOCAL",
      result: "PASS",
      ...evidence,
      disposableClusterRemoved: cleanupEvidence.removed
    })}\n`);
  }
);
