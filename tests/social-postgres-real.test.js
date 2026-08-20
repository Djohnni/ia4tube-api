"use strict";

const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");
const {
  databaseTargetFingerprint
} = require("../src/persistence/postgres/config");
const {
  createPhysicalPhaseEmitter,
  LOOPBACK_MODE,
  PostgresGateRefusal,
  RENDER_REMOTE_MODE,
  secureConnection,
  validateGateEnvironment
} = require("../scripts/run-real-postgres-tests");
const {
  ADVISORY_LOCK_ID,
  APPLY_APPROVAL,
  EXACT_FROM_PROFILE,
  EXACT_PENDING_MIGRATIONS,
  EXACT_TO_PROFILE,
  GLOBAL_VAULT_BACKFILL_POLICY,
  GLOBAL_VAULT_REGISTRY_MIGRATION,
  SOCIAL_CONNECTOR_PERSISTENCE_MIGRATION,
  compareMigrationState,
  createMigrationRunner,
  readManifest,
  sha256: migrationSha256,
  targetFingerprint
} = require("../src/persistence/postgres/migrations");
const {
  quoteIdentifier,
  verifyRuntimeRole,
  withTransaction
} = require("../src/persistence/postgres/pool");
const {
  verifyRuntimeSchema
} = require("../src/persistence/postgres/runtime-validation");
const {
  createSocialRepository
} = require("../src/persistence/postgres/social-repository");
const {
  createVaultKeyRegistryAdmin
} = require("../src/persistence/postgres/vault-key-registry-admin");
const {
  createSocialCredentialService
} = require("../src/social/credential-service");
const { createSocialReauthService } = require("../src/social/reauth");
const { createSocialVault } = require("../src/social/vault");
const {
  deriveVaultKeyVersion,
  vaultKeyringFingerprint
} = require("../src/social/vault-key-version");
const {
  createVaultKeyRotationService
} = require("../src/social/vault-key-rotation-service");

const OWNER_ROLE = "ia4tube_social_owner";
const MIGRATOR_ROLE = "ia4tube_social_migrator";
const RUNTIME_ROLE = "ia4tube_social_runtime";
const IDENTITY_VERSION = "v1";
const FOUNDATION_MIGRATION_VERSION =
  "0001_social_multitenant_foundation";
const EXACT_RECOVERY_REFERENCE = "synthetic-pg18-recovery-reference-0004";
const EXACT_RECOVERY_CAPTURED_AT = "2026-08-13T12:00:00.000Z";
const EXACT_PLAN_REQUEST = Object.freeze({
  fromProfile: EXACT_FROM_PROFILE,
  expectedPending: EXACT_PENDING_MIGRATIONS,
  toProfile: EXACT_TO_PROFILE
});
const EXACT_APPLY_REQUEST = Object.freeze({
  ...EXACT_PLAN_REQUEST,
  recoveryReference: EXACT_RECOVERY_REFERENCE,
  recoveryCapturedAt: EXACT_RECOVERY_CAPTURED_AT
});
const BACKFILL_VERSION_V1 = deriveVaultKeyVersion(
  101,
  Buffer.alloc(32, 101)
);
const BACKFILL_VERSION_V2 = deriveVaultKeyVersion(
  102,
  Buffer.alloc(32, 102)
);

const requiredByDedicatedRunner =
  process.env.SOCIAL_REAL_POSTGRES_REQUIRED === "true";
const skipReason =
  !requiredByDedicatedRunner
    ? "PostgreSQL real nao autorizado; use o gate dedicado."
    : false;

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function randomUuid() {
  return crypto.randomUUID();
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function systemChildEnvironment() {
  const result = {};
  for (const name of [
    "COMSPEC",
    "HOMEDRIVE",
    "HOMEPATH",
    "LOCALAPPDATA",
    "PATH",
    "Path",
    "PATHEXT",
    "SYSTEMDRIVE",
    "SYSTEMROOT",
    "SystemRoot",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "WINDIR"
  ]) {
    if (typeof process.env[name] === "string") result[name] = process.env[name];
  }
  return result;
}

function secretMarkers(configuration, extras = []) {
  const markers = new Set(extras.filter(Boolean).map(String));
  for (const raw of [
    configuration.provisionerUrl,
    configuration.migrationUrl,
    configuration.runtimeUrl
  ]) {
    if (!raw) continue;
    markers.add(String(raw));
    const parsed = new URL(raw);
    if (parsed.password) {
      markers.add(parsed.password);
      markers.add(decodeURIComponent(parsed.password));
    }
  }
  return [...markers].filter((value) => value.length >= 8);
}

function assertRedactedOutput(output, configuration, extras = []) {
  const text = String(output || "");
  for (const marker of secretMarkers(configuration, extras)) {
    assert.equal(
      text.includes(marker),
      false,
      "A saida do processo sintetico nao pode conter credenciais."
    );
  }
}

function migrationCliEnvironment(configuration) {
  const env = {
    ...systemChildEnvironment(),
    NODE_ENV: "test",
    SOCIAL_MIGRATIONS_DATABASE_URL: configuration.migrationUrl,
    SOCIAL_DATABASE_EXPECTED_TARGET_FINGERPRINT:
      databaseTargetFingerprint(new URL(configuration.migrationUrl)),
    SOCIAL_MIGRATIONS_EXPECTED_LOGIN:
      configuration.identities[1].username,
    SOCIAL_DATABASE_EXPECTED_RUNTIME_LOGIN:
      configuration.identities[2].username,
    SOCIAL_DATABASE_OWNER_ROLE: OWNER_ROLE,
    SOCIAL_DATABASE_MIGRATOR_ROLE: MIGRATOR_ROLE,
    SOCIAL_MIGRATION_ENVIRONMENT: configuration.target.environment,
    SOCIAL_MIGRATION_APPROVED: configuration.target.approval,
    SOCIAL_MIGRATION_PRODUCTION_APPROVAL: "",
    SOCIAL_MIGRATION_EXPECTED_ENVIRONMENT_ID:
      configuration.target.environmentId,
    SOCIAL_MIGRATION_TARGET_FINGERPRINT:
      configuration.approvalEnvironment
        .SOCIAL_MIGRATION_TARGET_FINGERPRINT
  };
  if (configuration.mode === LOOPBACK_MODE) {
    env.SOCIAL_DATABASE_ALLOW_INSECURE_LOCALHOST = "true";
  }
  return env;
}

function runMigrationCli(command, configuration, flags = []) {
  const result = spawnSync(
    process.execPath,
    [
      path.join(__dirname, "..", "scripts", "social-db-migrate.js"),
      command,
      ...flags
    ],
    {
      cwd: path.join(__dirname, ".."),
      env: migrationCliEnvironment(configuration),
      encoding: "utf8",
      windowsHide: true,
      timeout: 120000,
      maxBuffer: 1024 * 1024
    }
  );
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  assertRedactedOutput(output, configuration);
  assert.equal(
    result.error,
    undefined,
    `O comando CLI ${command} deve encerrar sem erro de processo.`
  );
  assert.equal(
    result.signal,
    null,
    `O comando CLI ${command} nao pode ser interrompido.`
  );
  assert.equal(
    result.status,
    0,
    `O comando CLI ${command} deve ser aprovado.`
  );
  let parsed;
  try {
    parsed = JSON.parse(String(result.stdout || "").trim());
  } catch {
    assert.fail(`O comando CLI ${command} deve retornar JSON valido.`);
  }
  assert.equal(parsed?.ok, true);
  assert.equal(parsed?.command, command);
  return parsed.result;
}

async function proveMigrationCli(configuration) {
  const manifest = readManifest();
  const status = runMigrationCli("status", configuration);
  assert.deepEqual(
    status.map((item) => item.state),
    manifest.map(() => "applied")
  );
  const validation = runMigrationCli("validate", configuration);
  assert.equal(validation.valid, true);
  assert.equal(validation.applied, manifest.length);
  assert.equal(validation.pending, 0);
  assert.deepEqual(
    validation.migrations.map((item) => item.checksum),
    manifest.map((item) => item.sha256)
  );
  assert.deepEqual(runMigrationCli("apply", configuration), []);
}

function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

function waitForChildExit(child, timeoutMilliseconds) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("synthetic_child_exit_timeout"));
    }, timeoutMilliseconds);
    const onExit = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    child.once("exit", onExit);
    child.once("error", onError);
    if (child.exitCode !== null || child.signalCode !== null) onExit();
  });
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  try {
    await waitForChildExit(child, 5000);
  } catch {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await waitForChildExit(child, 5000);
    }
  }
}

function createStartupProbeEnvironment(
  configuration,
  port,
  dataDirectory
) {
  const identityKey = crypto.randomBytes(32);
  const vaultKey = crypto.randomBytes(32);
  const jwtSecret = crypto.randomBytes(48).toString("base64url");
  const mediaSecret = crypto.randomBytes(48).toString("base64url");
  const vaultVersion = deriveVaultKeyVersion(1, vaultKey);
  const vaultKeysJson = JSON.stringify({
    [vaultVersion]: vaultKey.toString("base64")
  });
  const env = {
    ...systemChildEnvironment(),
    NODE_ENV: "test",
    PORT: String(port),
    DATA_DIR: dataDirectory,
    JWT_SECRET: jwtSecret,
    ORDER_MEDIA_SIGNING_SECRET: mediaSecret,
    BOT_ADMIN_WHATSAPP: "synthetic_admin",
    PUBLIC_API_BASE_URL: "https://normal-start-probe.invalid",
    PUBLIC_WEB_BASE_URL: "https://normal-start-probe.invalid",
    SOCIAL_PERSISTENCE_ENABLED: "true",
    DATABASE_URL: configuration.runtimeUrl,
    SOCIAL_DATABASE_EXPECTED_TARGET_FINGERPRINT:
      databaseTargetFingerprint(new URL(configuration.runtimeUrl)),
    SOCIAL_DATABASE_EXPECTED_RUNTIME_LOGIN:
      configuration.identities[2].username,
    SOCIAL_DATABASE_POOL_MAX: "3",
    SOCIAL_TENANT_NAMESPACE_UUID: crypto.randomUUID(),
    SOCIAL_IDENTITY_DERIVATION_VERSION: IDENTITY_VERSION,
    SOCIAL_IDENTITY_DERIVATION_KEY: identityKey.toString("base64"),
    SOCIAL_VAULT_ACTIVE_KEY_VERSION: vaultVersion,
    SOCIAL_VAULT_KEYS_JSON: vaultKeysJson,
    SOCIAL_VAULT_EXPECTED_KEYRING_FINGERPRINT:
      vaultKeyringFingerprint(vaultVersion, [vaultVersion]),
    FCM_TOKEN_REGISTRATION_ENABLED: "false",
    FCM_ART_READY_EVENT_ENABLED: "false",
    FCM_DELIVERY_ENABLED: "false",
    FCM_AUTOMATIC_NOTIFICATIONS_ENABLED: "false",
    FCM_MOCK: "false",
    IA4TUBE_ADMIN_FREE_ARTS_ENABLED: "false",
    IA4TUBE_ADMIN_FREE_ARTS_NOTIFICATIONS_ENABLED: "false",
    MP_ACCESS_TOKEN: "",
    OPENAI_API_KEY: "",
    BOT_RUNNER_TOKEN: "",
    BOT_RUNNER_TOKEN_NEXT: "",
    GOOGLE_CLIENT_ID: ""
  };
  if (configuration.mode === LOOPBACK_MODE) {
    env.SOCIAL_DATABASE_ALLOW_INSECURE_LOCALHOST = "true";
  }
  return Object.freeze({
    env,
    secrets: Object.freeze([
      jwtSecret,
      mediaSecret,
      env.SOCIAL_IDENTITY_DERIVATION_KEY,
      vaultKeysJson
    ]),
    destroy() {
      identityKey.fill(0);
      vaultKey.fill(0);
    }
  });
}

async function runStartupProbe(configuration, expectStarted) {
  const port = await reserveLoopbackPort();
  const dataDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "ia4tube-social-normal-start-")
  );
  const probe = createStartupProbeEnvironment(
    configuration,
    port,
    dataDirectory
  );
  const child = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: probe.env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  try {
    const startedAt = Date.now();
    while (
      !stdout.includes("API rodando na porta") &&
      child.exitCode === null &&
      Date.now() - startedAt < 15000
    ) {
      await delay(50);
    }
    if (expectStarted) {
      assert.equal(
        stdout.includes("API rodando na porta"),
        true,
        "O start sintetico deve chegar ao estado de escuta."
      );
    } else {
      if (child.exitCode === null) {
        await waitForChildExit(child, 1000).catch(() => undefined);
      }
      assert.equal(
        stdout.includes("API rodando na porta"),
        false,
        "O runtime sem migrations nao pode abrir a API."
      );
      assert.notEqual(
        child.exitCode,
        null,
        "O runtime sem migrations deve falhar fechado."
      );
      assert.notEqual(child.exitCode, 0);
    }
  } finally {
    await stopChild(child);
    assertRedactedOutput(
      `${stdout}${stderr}`,
      configuration,
      probe.secrets
    );
    probe.destroy();
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  }
}

async function proveStartupBoundary(
  provisionerPool,
  configuration,
  expectMigrated
) {
  const stateQuery = [
    "SELECT",
    "  (SELECT COUNT(*)::integer",
    "   FROM pg_catalog.pg_class relation",
    "   JOIN pg_catalog.pg_namespace namespace",
    "     ON namespace.oid = relation.relnamespace",
    "   WHERE namespace.nspname = 'ia4tube_migrations'",
    "     AND relation.relname = 'schema_migrations')",
    "    AS migration_ledger_count,",
    "  (SELECT COUNT(*)::integer",
    "   FROM pg_catalog.pg_namespace namespace",
    "   WHERE namespace.nspname = ANY($1::text[]))",
    "    AS application_schema_count"
  ].join("\n");
  const before = await provisionerPool.query(stateQuery, [
    ["ia4tube_social", "ia4tube_social_admin"]
  ]);
  if (expectMigrated) {
    assert.ok(before.rows[0].migration_ledger_count > 0);
    assert.equal(before.rows[0].application_schema_count, 2);
  } else {
    assert.deepEqual(before.rows[0], {
      migration_ledger_count: 0,
      application_schema_count: 0
    });
  }
  await runStartupProbe(configuration, expectMigrated);

  const after = await provisionerPool.query(stateQuery, [
    ["ia4tube_social", "ia4tube_social_admin"]
  ]);
  assert.deepEqual(after.rows[0], before.rows[0]);
}

function loadRealTestConfiguration() {
  let gate;
  try {
    gate = validateGateEnvironment(process.env);
  } catch (error) {
    assert.fail(
      error instanceof PostgresGateRefusal
        ? `O gate PostgreSQL recusou a configuracao: ${error.code}.`
        : "O gate PostgreSQL recusou a configuracao."
    );
  }
  assert.equal(
    process.env.SOCIAL_TEST_GATE_VALIDATED_FINGERPRINT,
    gate.fingerprint,
    "O teste real deve ser iniciado somente pelo runner validado."
  );

  const target = Object.freeze({
    environment: "test",
    environmentId: gate.environmentId,
    approval: APPLY_APPROVAL,
    productionApproval: "",
    host: gate.identities[1].host,
    port: gate.identities[1].port,
    database: gate.identities[1].database,
    username: gate.identities[1].username
  });
  return Object.freeze({
    ...gate,
    provisionerUrl: gate.urls[0],
    migrationUrl: gate.urls[1],
    runtimeUrl: gate.urls[2],
    target,
    approvalEnvironment: Object.freeze({
      SOCIAL_MIGRATION_TARGET_FINGERPRINT: targetFingerprint(target)
    })
  });
}

function createPool(
  connectionString,
  applicationName,
  max = 4,
  configuration
) {
  const secured = secureConnection(connectionString, configuration);
  return new Pool({
    connectionString: secured.connectionString,
    ssl: secured.ssl,
    application_name: applicationName,
    max,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 5000,
    query_timeout: 30000,
    options: [
      "-c statement_timeout=25000",
      "-c idle_in_transaction_session_timeout=5000",
      "-c lock_timeout=5000",
      "-c search_path=pg_catalog"
    ].join(" ")
  });
}

async function readDirectMembership(client, grantedRole, memberRole) {
  const result = await client.query(
    [
      "SELECT membership.admin_option,",
      "  membership.inherit_option, membership.set_option",
      "  FROM pg_catalog.pg_auth_members membership",
      "  JOIN pg_catalog.pg_roles granted",
      "    ON granted.oid = membership.roleid",
      "  JOIN pg_catalog.pg_roles member",
      "    ON member.oid = membership.member",
      "  WHERE granted.rolname = $1",
      "    AND member.rolname = $2"
    ].join("\n"),
    [grantedRole, memberRole]
  );
  assert.ok(
    result.rowCount <= 1,
    "A membership sintetica deve ser direta e unica."
  );
  if (result.rowCount === 0) {
    return Object.freeze({ exists: false });
  }
  const membership = result.rows[0];
  return Object.freeze({
    exists: true,
    adminOption: membership.admin_option,
    inheritOption: membership.inherit_option,
    setOption: membership.set_option
  });
}

function assertSafeDirectMembership(membership) {
  if (!membership.exists) return;
  assert.equal(membership.adminOption, false);
  assert.equal(membership.inheritOption, false);
  assert.equal(membership.setOption, true);
}

async function readDirectDatabasePrivileges(client, loginRole) {
  const result = await client.query(
    [
      "SELECT database_info.datname AS database_name,",
      "  database_owner.rolname AS database_owner_name,",
      "  expanded_acl.privilege_type,",
      "  expanded_acl.is_grantable,",
      "  grantor.rolname AS grantor_name",
      "FROM pg_catalog.pg_database database_info",
      "JOIN pg_catalog.pg_roles database_owner",
      "  ON database_owner.oid = database_info.datdba",
      "CROSS JOIN LATERAL pg_catalog.aclexplode(",
      "  COALESCE(database_info.datacl,",
      "    pg_catalog.acldefault('d', database_info.datdba))",
      ") expanded_acl",
      "JOIN pg_catalog.pg_roles grantee",
      "  ON grantee.oid = expanded_acl.grantee",
      "LEFT JOIN pg_catalog.pg_roles grantor",
      "  ON grantor.oid = expanded_acl.grantor",
      "WHERE database_info.datname = current_database()",
      "  AND grantee.rolname = $1",
      "ORDER BY expanded_acl.privilege_type"
    ].join("\n"),
    [loginRole]
  );
  return result.rows || [];
}

function assertSafeDirectDatabaseConnect(rows) {
  assert.equal(rows.length, 1);
  assert.equal(rows[0].privilege_type, "CONNECT");
  assert.equal(rows[0].is_grantable, false);
  assert.equal(rows[0].grantor_name, rows[0].database_owner_name);
}

async function ensureDirectDatabaseConnect(
  client,
  loginRole,
  membershipState,
  stateKey
) {
  let rows = await readDirectDatabasePrivileges(client, loginRole);
  if (rows.length === 0) {
    const databaseResult = await client.query(
      "SELECT current_database() AS database_name"
    );
    const databaseName = databaseResult.rows?.[0]?.database_name;
    membershipState[stateKey] = true;
    await client.query(
      `GRANT CONNECT ON DATABASE ${quoteIdentifier(
        databaseName
      )} TO ${quoteIdentifier(loginRole)}`
    );
    rows = await readDirectDatabasePrivileges(client, loginRole);
  }
  assertSafeDirectDatabaseConnect(rows);
}

async function proveExactDatabaseAcl(client, configuration) {
  const result = await client.query(
    [
      "SELECT",
      "  COALESCE(grantee.rolname, 'PUBLIC') AS grantee,",
      "  expanded_acl.privilege_type,",
      "  expanded_acl.is_grantable,",
      "  grantor.rolname AS grantor_name,",
      "  database_owner.rolname AS database_owner_name",
      "FROM pg_catalog.pg_database database_info",
      "JOIN pg_catalog.pg_roles database_owner",
      "  ON database_owner.oid = database_info.datdba",
      "CROSS JOIN LATERAL pg_catalog.aclexplode(",
      "  COALESCE(database_info.datacl,",
      "    pg_catalog.acldefault('d', database_info.datdba))",
      ") expanded_acl",
      "LEFT JOIN pg_catalog.pg_roles grantee",
      "  ON grantee.oid = expanded_acl.grantee",
      "LEFT JOIN pg_catalog.pg_roles grantor",
      "  ON grantor.oid = expanded_acl.grantor",
      "WHERE database_info.datname = current_database()",
      "  AND expanded_acl.grantee <> database_info.datdba",
      "ORDER BY grantee, expanded_acl.privilege_type"
    ].join("\n")
  );
  const actual = new Set(
    (result.rows || []).map(
      (row) =>
        `${row.grantee}|${row.privilege_type}|` +
        `${row.is_grantable}|${row.grantor_name}|` +
        row.database_owner_name
    )
  );
  const databaseOwner = result.rows?.[0]?.database_owner_name;
  assert.ok(databaseOwner);
  const expected = new Set([
    `${OWNER_ROLE}|CREATE|false|${databaseOwner}|${databaseOwner}`,
    `${configuration.identities[1].username}|CONNECT|false|` +
      `${databaseOwner}|${databaseOwner}`,
    `${configuration.identities[2].username}|CONNECT|false|` +
      `${databaseOwner}|${databaseOwner}`
  ]);
  assert.deepEqual(actual, expected);
}

async function preflightPhysicalTarget(pool, configuration) {
  const client = await pool.connect();
  try {
    const session = await client.query(
      [
        "SELECT current_database() AS database_name,",
        "  current_user AS current_user_name,",
        "  session_user AS session_user_name,",
        "  current_setting('server_version_num')::integer AS version_num,",
        "  current_setting('transaction_read_only') AS read_only,",
        "  database_info.datistemplate, database_info.datallowconn,",
        "  owner.rolname AS database_owner,",
        "  session_role.rolcanlogin AS provisioner_canlogin,",
        "  session_role.rolsuper AS provisioner_superuser,",
        "  session_role.rolcreatedb AS provisioner_createdb,",
        "  session_role.rolcreaterole AS provisioner_createrole,",
        "  session_role.rolinherit AS provisioner_inherit,",
        "  session_role.rolreplication AS provisioner_replication,",
        "  session_role.rolbypassrls AS provisioner_bypassrls,",
        "  has_database_privilege(",
        "    session_user, current_database(), 'CONNECT'",
        "  ) AS provisioner_connect,",
        "  has_database_privilege(",
        "    session_user, current_database(), 'TEMP'",
        "  ) AS provisioner_temp,",
        "  has_database_privilege(",
        "    session_user, current_database(), 'CREATE'",
        "  ) AS provisioner_create",
        "FROM pg_catalog.pg_database database_info",
        "JOIN pg_catalog.pg_roles owner",
        "  ON owner.oid = database_info.datdba",
        "JOIN pg_catalog.pg_roles session_role",
        "  ON session_role.rolname = session_user",
        "WHERE database_info.datname = current_database()"
      ].join("\n")
    );
    assert.equal(session.rowCount, 1);
    const row = session.rows[0];
    assert.equal(row.database_name, configuration.database);
    assert.equal(row.current_user_name, configuration.identities[0].username);
    assert.equal(row.session_user_name, configuration.identities[0].username);
    assert.equal(row.database_owner, configuration.identities[0].username);
    assert.equal(row.version_num >= 180000 && row.version_num < 190000, true);
    assert.equal(row.read_only, "off");
    assert.equal(row.datistemplate, false);
    assert.equal(row.datallowconn, true);
    assert.equal(row.provisioner_canlogin, true);
    assert.equal(row.provisioner_superuser, false);
    assert.equal(typeof row.provisioner_createdb, "boolean");
    assert.equal(row.provisioner_createrole, true);
    assert.equal(typeof row.provisioner_inherit, "boolean");
    assert.equal(row.provisioner_replication, false);
    assert.equal(row.provisioner_bypassrls, false);
    assert.equal(row.provisioner_connect, true);
    assert.equal(row.provisioner_temp, true);
    assert.equal(row.provisioner_create, true);

    const provisionerMemberships = await client.query(
      [
        "SELECT granted.rolname AS granted_role,",
        "  membership.admin_option, membership.inherit_option,",
        "  membership.set_option, grantor.rolsuper AS grantor_superuser,",
        "  granted.rolsuper AS granted_superuser,",
        "  granted.rolcreatedb AS granted_createdb,",
        "  granted.rolcreaterole AS granted_createrole,",
        "  granted.rolreplication AS granted_replication,",
        "  granted.rolbypassrls AS granted_bypassrls",
        "FROM pg_catalog.pg_auth_members membership",
        "JOIN pg_catalog.pg_roles granted",
        "  ON granted.oid = membership.roleid",
        "JOIN pg_catalog.pg_roles member",
        "  ON member.oid = membership.member",
        "JOIN pg_catalog.pg_roles grantor",
        "  ON grantor.oid = membership.grantor",
        "WHERE member.rolname = session_user",
        "ORDER BY granted.rolname"
      ].join("\n")
    );
    for (const membership of provisionerMemberships.rows) {
      if (
        configuration.identities
          .slice(1)
          .some((identity) => identity.username === membership.granted_role)
      ) {
        assert.equal(membership.admin_option, true);
        assert.equal(membership.inherit_option, false);
        assert.equal(membership.set_option, false);
        assert.equal(membership.grantor_superuser, true);
        assert.equal(membership.granted_superuser, false);
        assert.equal(membership.granted_createdb, false);
        assert.equal(membership.granted_createrole, false);
        assert.equal(membership.granted_replication, false);
        assert.equal(membership.granted_bypassrls, false);
      }
    }

    const logins = await client.query(
      [
        "SELECT rolname, rolcanlogin, rolsuper, rolcreatedb,",
        "  rolcreaterole, rolreplication, rolbypassrls",
        "FROM pg_catalog.pg_roles",
        "WHERE rolname = ANY($1::text[])",
        "ORDER BY rolname"
      ].join("\n"),
      [configuration.identities.map((identity) => identity.username)]
    );
    assert.equal(logins.rowCount, 3);
    const byName = new Map(logins.rows.map((login) => [login.rolname, login]));
    for (const identity of configuration.identities) {
      const login = byName.get(identity.username);
      assert.ok(login);
      assert.equal(login.rolcanlogin, true);
      assert.equal(login.rolsuper, false);
      assert.equal(login.rolreplication, false);
      assert.equal(login.rolbypassrls, false);
    }
    for (const identity of configuration.identities.slice(1)) {
      const login = byName.get(identity.username);
      assert.equal(login.rolcreatedb, false);
      assert.equal(login.rolcreaterole, false);
    }

    if (configuration.mode === LOOPBACK_MODE) return;

    const tls = await client.query(
      [
        "SELECT ssl, version, cipher",
        "FROM pg_catalog.pg_stat_ssl",
        "WHERE pid = pg_backend_pid()"
      ].join("\n")
    );
    assert.equal(tls.rowCount, 1);
    assert.equal(tls.rows[0].ssl, true);
    assert.match(String(tls.rows[0].version || ""), /^TLSv1\.[23]$/);
    assert.notEqual(String(tls.rows[0].cipher || ""), "");

    const canonicalRoles = await client.query(
      [
        "SELECT COUNT(*)::integer AS role_count,",
        "  COALESCE(BOOL_AND(",
        "    NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb",
        "    AND NOT rolcreaterole AND NOT rolinherit",
        "    AND NOT rolreplication AND NOT rolbypassrls",
        "  ), TRUE) AS attributes_safe",
        "FROM pg_catalog.pg_roles",
        "WHERE rolname = ANY($1::text[])"
      ].join("\n"),
      [[OWNER_ROLE, MIGRATOR_ROLE, RUNTIME_ROLE]]
    );
    assert.ok(
      [0, 3].includes(canonicalRoles.rows[0].role_count),
      "O cluster reutilizado deve ter zero ou todos os papeis canonicos."
    );
    assert.equal(canonicalRoles.rows[0].attributes_safe, true);

    const applicationSchemas = await client.query(
      [
        "SELECT",
        "  COUNT(*) FILTER (",
        "    WHERE nspname = 'ia4tube_migrations'",
        "  )::integer AS migration_schema_count,",
        "  COUNT(*) FILTER (",
        "    WHERE nspname IN (",
        "      'ia4tube_social', 'ia4tube_social_admin'",
        "    )",
        "  )::integer AS application_schema_count",
        "FROM pg_catalog.pg_namespace",
      ].join("\n"),
    );
    const schemaState = applicationSchemas.rows[0];

    const userRelations = await client.query(
      [
        "SELECT namespace.nspname AS schema_name,",
        "  relation.relname AS relation_name, relation.relkind",
        "FROM pg_catalog.pg_class relation",
        "JOIN pg_catalog.pg_namespace namespace",
        "  ON namespace.oid = relation.relnamespace",
        "WHERE namespace.nspname IN (",
        "  'ia4tube_migrations',",
        "  'ia4tube_social',",
        "  'ia4tube_social_admin'",
        ")",
        "ORDER BY namespace.nspname, relation.relname"
      ].join("\n")
    );
    const unexpectedRelations = await client.query(
      [
        "SELECT COUNT(*)::integer AS relation_count",
        "FROM pg_catalog.pg_class relation",
        "JOIN pg_catalog.pg_namespace namespace",
        "  ON namespace.oid = relation.relnamespace",
        "WHERE namespace.nspname NOT IN ('pg_catalog', 'information_schema')",
        "  AND namespace.nspname !~ '^pg_toast'",
        "  AND relation.relkind = ANY($1::\"char\"[])",
        "  AND NOT (",
        "    namespace.nspname = 'ia4tube_migrations'",
        "    AND relation.relname = ANY($2::text[])",
        "  )"
      ].join("\n"),
      [
        ["r", "p", "v", "m", "S", "f", "i"],
        []
      ]
    );
    assert.equal(unexpectedRelations.rows[0].relation_count, 0);
    assert.equal(schemaState.migration_schema_count, 0);
    assert.equal(schemaState.application_schema_count, 0);
    assert.deepEqual(userRelations.rows, []);
  } finally {
    client.release();
  }
}

async function proveDirectConnectIsRequired(pool, configuration) {
  const runtimeLogin = configuration.identities[2].username;
  const baseline = createPool(
    configuration.runtimeUrl,
    "ia4tube-social-connect-baseline",
    1,
    configuration
  );
  try {
    await baseline.query("SELECT 1");
  } finally {
    await baseline.end();
  }

  const provisioner = await pool.connect();
  let databaseName;
  try {
    const databaseResult = await provisioner.query(
      "SELECT current_database() AS database_name"
    );
    databaseName = databaseResult.rows?.[0]?.database_name;
    await provisioner.query(
      `REVOKE CONNECT ON DATABASE ${quoteIdentifier(
        databaseName
      )} FROM ${quoteIdentifier(runtimeLogin)}`
    );
  } finally {
    provisioner.release();
  }

  const denied = createPool(
    configuration.runtimeUrl,
    "ia4tube-social-connect-denied",
    1,
    configuration
  );
  try {
    await assert.rejects(
      denied.query("SELECT 1"),
      (error) => error?.code === "42501"
    );
  } finally {
    await denied.end();
    await pool.query(
      `GRANT CONNECT ON DATABASE ${quoteIdentifier(
        databaseName
      )} TO ${quoteIdentifier(runtimeLogin)}`
    );
  }

  const restored = createPool(
    configuration.runtimeUrl,
    "ia4tube-social-connect-restored",
    1,
    configuration
  );
  try {
    await restored.query("SELECT 1");
  } finally {
    await restored.end();
  }
}

async function proveProvisionerEffectiveAccess(pool) {
  const result = await pool.query(
    [
      "SELECT",
      "  role_info.rolinherit,",
      "  has_database_privilege(",
      "    session_user, current_database(), 'CONNECT'",
      "  ) AS database_connect,",
      "  has_database_privilege(",
      "    session_user, current_database(), 'TEMP'",
      "  ) AS database_temp,",
      "  has_database_privilege(",
      "    session_user, current_database(), 'CREATE'",
      "  ) AS database_create,",
      "  COALESCE((",
      "    SELECT has_table_privilege(",
      "      session_user, relation.oid, 'TRUNCATE'",
      "    )",
      "    FROM pg_catalog.pg_class relation",
      "    JOIN pg_catalog.pg_namespace namespace",
      "      ON namespace.oid = relation.relnamespace",
      "    WHERE namespace.nspname = 'ia4tube_social'",
      "      AND relation.relname = 'social_connections'",
      "  ), FALSE) AS table_truncate",
      "FROM pg_catalog.pg_roles role_info",
      "WHERE role_info.rolname = session_user"
    ].join("\n")
  );
  assert.equal(result.rowCount, 1);
  assert.equal(typeof result.rows[0].rolinherit, "boolean");
  assert.equal(result.rows[0].database_connect, true);
  assert.equal(result.rows[0].database_temp, true);
  assert.equal(result.rows[0].database_create, true);
  assert.equal(
    result.rows[0].table_truncate,
    false,
    "O provisioner nao deve herdar TRUNCATE nas tabelas sociais."
  );
}

async function provisionRolesAndMarker(
  pool,
  configuration,
  membershipState
) {
  const rolesSql = fs.readFileSync(
    path.join(__dirname, "..", "db", "postgres", "roles.sql"),
    "utf8"
  );
  const client = await pool.connect();
  let releaseError;
  try {
    try {
      await client.query(rolesSql);
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        rollbackError.cause = error;
        releaseError = rollbackError;
        throw rollbackError;
      }
      throw error;
    }
    await ensureDirectDatabaseConnect(
      client,
      configuration.identities[1].username,
      membershipState,
      "migratorConnect"
    );
    await ensureDirectDatabaseConnect(
      client,
      configuration.identities[2].username,
      membershipState,
      "runtimeConnect"
    );
    await proveExactDatabaseAcl(client, configuration);
    const migratorMembership = await readDirectMembership(
      client,
      MIGRATOR_ROLE,
      configuration.identities[1].username
    );
    assertSafeDirectMembership(migratorMembership);
    if (!migratorMembership.exists) {
      membershipState.migrator = true;
      await client.query(
        `GRANT ${quoteIdentifier(MIGRATOR_ROLE)} TO ${quoteIdentifier(
          configuration.identities[1].username
        )} WITH ADMIN FALSE, INHERIT FALSE, SET TRUE ` +
          "GRANTED BY CURRENT_USER"
      );
    }
    const runtimeMembership = await readDirectMembership(
      client,
      RUNTIME_ROLE,
      configuration.identities[2].username
    );
    assertSafeDirectMembership(runtimeMembership);
    if (!runtimeMembership.exists) {
      membershipState.runtime = true;
      await client.query(
        `GRANT ${quoteIdentifier(RUNTIME_ROLE)} TO ${quoteIdentifier(
          configuration.identities[2].username
        )} WITH ADMIN FALSE, INHERIT FALSE, SET TRUE ` +
          "GRANTED BY CURRENT_USER"
      );
    }

    await client.query("BEGIN");
    try {
      await client.query(
        [
          "GRANT ia4tube_social_owner TO CURRENT_USER",
          "  WITH ADMIN FALSE, INHERIT FALSE, SET TRUE",
          "  GRANTED BY CURRENT_USER"
        ].join("\n")
      );
      await client.query("SET LOCAL ROLE ia4tube_social_owner");
      await client.query(
        [
          "INSERT INTO ia4tube_migrations.environment_identity (",
          "  singleton, environment_id, environment_name",
          ") VALUES (TRUE, $1, $2)",
          "ON CONFLICT (singleton) DO NOTHING"
        ].join("\n"),
        [
          configuration.environmentId,
          configuration.target.environment
        ]
      );
      const marker = await client.query(
        [
          "SELECT environment_id::text, environment_name",
          "FROM ia4tube_migrations.environment_identity",
          "WHERE singleton = TRUE"
        ].join("\n")
      );
      assert.equal(marker.rowCount, 1);
      assert.equal(marker.rows[0].environment_id, configuration.environmentId);
      assert.equal(
        marker.rows[0].environment_name,
        configuration.target.environment
      );
      await client.query("RESET ROLE");
      await client.query(
        [
          "REVOKE ia4tube_social_owner FROM CURRENT_USER",
          "  GRANTED BY CURRENT_USER RESTRICT"
        ].join("\n")
      );
      await client.query("COMMIT");
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        rollbackError.cause = error;
        releaseError = rollbackError;
        throw rollbackError;
      }
      throw error;
    }
  } finally {
    client.release(releaseError);
  }

  const roleCheck = await pool.query(
    [
      "SELECT current_setting('server_version_num')::integer >= 180000",
      "  AND current_setting('server_version_num')::integer < 190000",
      "  AS postgres_version_supported,",
      "  rolname, rolcanlogin, rolsuper, rolcreatedb,",
      "  rolcreaterole, rolreplication, rolbypassrls",
      "FROM pg_catalog.pg_roles",
      "WHERE rolname = ANY($1::text[])",
      "ORDER BY rolname"
    ].join("\n"),
    [
      [
        configuration.identities[1].username,
        configuration.identities[2].username
      ]
    ]
  );
  assert.equal(roleCheck.rowCount, 2);
  for (const row of roleCheck.rows) {
    assert.equal(row.postgres_version_supported, true);
    assert.equal(row.rolcanlogin, true);
    assert.equal(row.rolsuper, false);
    assert.equal(row.rolcreatedb, false);
    assert.equal(row.rolcreaterole, false);
    assert.equal(row.rolreplication, false);
    assert.equal(row.rolbypassrls, false);
  }
}

async function revokeTestRoleMemberships(
  pool,
  configuration,
  membershipState
) {
  const failures = [];
  async function revoke(stateKey, sql) {
    if (!membershipState[stateKey]) return;
    try {
      await pool.query(sql);
      membershipState[stateKey] = false;
    } catch (error) {
      failures.push(error);
    }
  }

  if (membershipState.runtime) {
    await revoke(
      "runtime",
      `REVOKE ${quoteIdentifier(RUNTIME_ROLE)} FROM ${quoteIdentifier(
        configuration.identities[2].username
      )}`
    );
  }
  if (membershipState.migrator) {
    await revoke(
      "migrator",
      `REVOKE ${quoteIdentifier(MIGRATOR_ROLE)} FROM ${quoteIdentifier(
        configuration.identities[1].username
      )}`
    );
  }
  const databaseResult = await pool.query(
    "SELECT current_database() AS database_name"
  );
  const databaseName = databaseResult.rows?.[0]?.database_name;
  if (membershipState.runtimeConnect) {
    await revoke(
      "runtimeConnect",
      `REVOKE CONNECT ON DATABASE ${quoteIdentifier(
        databaseName
      )} FROM ${quoteIdentifier(configuration.identities[2].username)}`
    );
  }
  if (membershipState.migratorConnect) {
    await revoke(
      "migratorConnect",
      `REVOKE CONNECT ON DATABASE ${quoteIdentifier(
        databaseName
      )} FROM ${quoteIdentifier(configuration.identities[1].username)}`
    );
  }
  if (failures.length > 0) {
    throw new Error("synthetic_role_membership_cleanup_failed");
  }
}

async function proveFinalCleanup(configuration, createdState) {
  const observer = createPool(
    configuration.provisionerUrl,
    "ia4tube-final-cleanup-observer",
    1,
    configuration
  );
  try {
    let activity;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      activity = await observer.query(
        [
          "SELECT",
          "  COUNT(*)::integer AS session_count,",
          "  COUNT(*) FILTER (WHERE state = 'idle in transaction')::integer",
          "    AS idle_transaction_count,",
          "  COUNT(*) FILTER (WHERE EXISTS (",
          "    SELECT 1 FROM pg_catalog.pg_locks lock_info",
          "    WHERE lock_info.pid = activity.pid",
          "      AND lock_info.locktype = 'advisory'",
          "  ))::integer AS advisory_lock_count",
          "FROM pg_catalog.pg_stat_activity activity",
          "WHERE datname = current_database()",
          "  AND application_name LIKE 'ia4tube-social-%'"
        ].join("\n")
      );
      if (
        activity.rows[0].session_count === 0 &&
        activity.rows[0].idle_transaction_count === 0 &&
        activity.rows[0].advisory_lock_count === 0
      ) {
        break;
      }
      await delay(100);
    }
    assert.equal(activity.rows[0].session_count, 0);
    assert.equal(activity.rows[0].idle_transaction_count, 0);
    assert.equal(activity.rows[0].advisory_lock_count, 0);

    const selfGrantedOwner = await observer.query(
      [
        "SELECT COUNT(*)::integer AS membership_count",
        "FROM pg_catalog.pg_auth_members membership",
        "JOIN pg_catalog.pg_roles granted",
        "  ON granted.oid = membership.roleid",
        "JOIN pg_catalog.pg_roles member",
        "  ON member.oid = membership.member",
        "JOIN pg_catalog.pg_roles grantor",
        "  ON grantor.oid = membership.grantor",
        "WHERE granted.rolname = $1",
        "  AND member.rolname = $2",
        "  AND grantor.rolname = $2"
      ].join("\n"),
      [OWNER_ROLE, configuration.identities[0].username]
    );
    assert.equal(selfGrantedOwner.rows[0].membership_count, 0);

    for (const definition of [
      {
        role: MIGRATOR_ROLE,
        login: configuration.identities[1].username,
        created: createdState.migrator,
        connectCreated: createdState.migratorConnect
      },
      {
        role: RUNTIME_ROLE,
        login: configuration.identities[2].username,
        created: createdState.runtime,
        connectCreated: createdState.runtimeConnect
      }
    ]) {
      const membership = await readDirectMembership(
        observer,
        definition.role,
        definition.login
      );
      if (definition.created) {
        assert.equal(membership.exists, false);
      } else {
        assertSafeDirectMembership(membership);
      }

      const connect = await readDirectDatabasePrivileges(
        observer,
        definition.login
      );
      if (definition.connectCreated) {
        assert.equal(connect.length, 0);
      } else {
        assertSafeDirectDatabaseConnect(connect);
      }
    }
  } finally {
    await observer.end();
  }
}

function migrationRunner(pool, configuration, manifestOptions) {
  return createMigrationRunner({
    pool,
    ownerRole: OWNER_ROLE,
    migratorRole: MIGRATOR_ROLE,
    target: configuration.target,
    ...(manifestOptions ? { manifestOptions } : {})
  });
}

function temporaryMigrationManifest(migrations, suffix) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), `ia4tube-social-${suffix}-`)
  );
  const entries = [];
  for (const migration of migrations) {
    fs.writeFileSync(
      path.join(directory, migration.file),
      migration.sql,
      "utf8"
    );
    entries.push({
      version: migration.version,
      file: migration.file,
      sha256: migration.sha256
    });
  }
  const manifestPath = path.join(directory, "checksums.json");
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify({ format: 1, migrations: entries }, null, 2)}\n`,
    "utf8"
  );
  return Object.freeze({
    directory,
    manifestPath,
    options: Object.freeze({
      migrationsDirectory: directory,
      manifestPath
    })
  });
}

async function proveMigrationConcurrency(
  firstRunner,
  secondRunner,
  configuration,
  expectedVersions
) {
  const before = await firstRunner.inspect();
  assert.deepEqual(
    before
      .filter((item) => item.state === "pending")
      .map((item) => item.version),
    expectedVersions,
    "O conjunto pendente deve ser exato antes da concorrencia."
  );
  const runners = [firstRunner, secondRunner];
  const outcomes = await Promise.allSettled(
    runners.map((runner) =>
      runner.apply(configuration.approvalEnvironment)
    )
  );
  const rejected = outcomes
    .map((outcome, index) => ({ outcome, index }))
    .filter(({ outcome }) => outcome.status === "rejected");
  assert.ok(
    rejected.length <= 1,
    "No maximo um migrador concorrente pode sofrer timeout do lock."
  );
  for (const { outcome } of rejected) {
    assert.equal(
      outcome.reason?.code,
      "55P03",
      "Somente o timeout seguro do advisory lock pode recusar concorrencia."
    );
  }
  const applied = outcomes
    .filter((outcome) => outcome.status === "fulfilled")
    .flatMap((outcome) => outcome.value);
  assert.equal(applied.length, expectedVersions.length);
  assert.deepEqual(
    applied.map((item) => item.version).sort(),
    expectedVersions
  );
  if (rejected.length === 1) {
    const retry = await runners[rejected[0].index].apply(
      configuration.approvalEnvironment
    );
    assert.deepEqual(
      retry,
      [],
      "O migrador recusado pelo lock deve ser idempotente ao repetir."
    );
  }
}

async function proveAdvisoryLock(
  lockPool,
  runner,
  configuration,
  runnerApplicationName
) {
  const client = await lockPool.connect();
  let pending;
  let settled = false;
  let outcome;
  try {
    await client.query("SELECT pg_advisory_lock($1::bigint)", [
      ADVISORY_LOCK_ID
    ]);
    pending = runner.apply(configuration.approvalEnvironment).then(
      (result) => {
        settled = true;
        outcome = { result };
      },
      (error) => {
        settled = true;
        outcome = { error };
      }
    );
    let observedWaiting = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const activity = await client.query(
        [
          "SELECT EXISTS (",
          "  SELECT 1 FROM pg_catalog.pg_stat_activity",
          "  WHERE datname = current_database()",
          "    AND usename = session_user",
          "    AND pid <> pg_backend_pid()",
          "    AND application_name = $1",
          "    AND wait_event_type = 'Lock'",
          "    AND wait_event = 'advisory'",
          ") AS waiting"
        ].join("\n"),
        [runnerApplicationName]
      );
      if (activity.rows?.[0]?.waiting) {
        observedWaiting = true;
        break;
      }
      await delay(100);
    }
    assert.equal(
      observedWaiting,
      true,
      "O runner concorrente deve chegar ao advisory lock e aguardar."
    );
    assert.equal(settled, false);
  } finally {
    await client.query("SELECT pg_advisory_unlock($1::bigint)", [
      ADVISORY_LOCK_ID
    ]);
    client.release();
  }
  await pending;
  if (outcome.error) throw outcome.error;
  assert.deepEqual(outcome.result, []);
}

async function proveChecksums(
  migrationPool,
  runner
) {
  const manifest = readManifest();
  const validation = await runner.validate();
  assert.equal(validation.valid, true);
  assert.equal(validation.applied, manifest.length);
  assert.equal(validation.pending, 0);
  assert.deepEqual(
    validation.migrations.map((item) => item.checksum),
    manifest.map((item) => item.sha256)
  );

  await assert.rejects(
    withTransaction(
      migrationPool,
      (client) =>
        client.query(
          [
            "UPDATE ia4tube_migrations.schema_migrations",
            "SET checksum_sha256 = $1",
            "WHERE version = $2"
          ].join("\n"),
          ["0".repeat(64), manifest[0].version]
        ),
      { role: MIGRATOR_ROLE }
    ),
    (error) => error?.code === "42501"
  );

  const client = await migrationPool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE ${quoteIdentifier(OWNER_ROLE)}`);
    await client.query(
      [
        "UPDATE ia4tube_migrations.schema_migrations",
        "SET checksum_sha256 = $1",
        "WHERE version = $2"
      ].join("\n"),
      ["0".repeat(64), manifest[0].version]
    );
    const rows = await client.query(
      [
        "SELECT version, checksum_sha256",
        "FROM ia4tube_migrations.schema_migrations",
        "ORDER BY version"
      ].join("\n")
    );
    assert.throws(
      () => compareMigrationState(manifest, rows.rows),
      { code: "applied_migration_checksum_mismatch" }
    );
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
  assert.equal((await runner.validate()).valid, true);
}

async function proveTargetRefusals(
  migrationPool,
  configuration,
  runner
) {
  await assert.rejects(
    runner.apply({
      SOCIAL_MIGRATION_TARGET_FINGERPRINT: "0".repeat(64)
    }),
    { code: "migration_target_not_verified" }
  );

  const wrongTarget = Object.freeze({
    ...configuration.target,
    environmentId: randomUuid()
  });
  const wrongRunner = migrationRunner(migrationPool, {
    ...configuration,
    target: wrongTarget
  });
  await assert.rejects(
    wrongRunner.validate(),
    { code: "migration_environment_marker_mismatch" }
  );
  await assert.rejects(
    wrongRunner.apply({
      SOCIAL_MIGRATION_TARGET_FINGERPRINT:
        targetFingerprint(wrongTarget)
    }),
    { code: "migration_environment_marker_mismatch" }
  );
  assert.equal((await runner.validate()).valid, true);
}

async function proveMigrationRollback(
  migrationPool,
  configuration
) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "ia4tube-social-real-migration-")
  );
  const manifest = readManifest();
  try {
    const entries = [];
    for (const migration of manifest) {
      fs.copyFileSync(
        path.join(__dirname, "..", "db", "migrations", migration.file),
        path.join(directory, migration.file)
      );
      entries.push({
        version: migration.version,
        file: migration.file,
        sha256: migration.sha256
      });
    }
    const failedVersion = "9999_synthetic_rollback";
    const failedFile = `${failedVersion}.up.sql`;
    const failedSql = [
      "CREATE TABLE ia4tube_social.synthetic_rollback_probe (",
      "  id UUID PRIMARY KEY",
      ");",
      "SELECT ia4tube_intentionally_missing_function();",
      ""
    ].join("\n");
    fs.writeFileSync(path.join(directory, failedFile), failedSql, "utf8");
    entries.push({
      version: failedVersion,
      file: failedFile,
      sha256: migrationSha256(Buffer.from(failedSql, "utf8"))
    });
    const manifestPath = path.join(directory, "checksums.json");
    fs.writeFileSync(
      manifestPath,
      `${JSON.stringify({ format: 1, migrations: entries }, null, 2)}\n`,
      "utf8"
    );
    const runner = migrationRunner(migrationPool, configuration, {
      migrationsDirectory: directory,
      manifestPath
    });
    await assert.rejects(
      runner.apply(configuration.approvalEnvironment),
      (error) => error?.code === "42883"
    );
    const probe = await withTransaction(
      migrationPool,
      (client) =>
        client.query(
          [
            "SELECT",
            "  to_regclass('ia4tube_social.synthetic_rollback_probe') AS probe,",
            "  EXISTS (",
            "    SELECT 1 FROM ia4tube_migrations.schema_migrations",
            "    WHERE version = $1",
            "  ) AS recorded"
          ].join("\n"),
          [failedVersion]
        ),
      { role: OWNER_ROLE }
    );
    assert.equal(probe.rows[0].probe, null);
    assert.equal(probe.rows[0].recorded, false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function exactCliFlags({ apply = false } = {}) {
  return [
    `--from-profile=${EXACT_FROM_PROFILE}`,
    `--expect-pending=${SOCIAL_CONNECTOR_PERSISTENCE_MIGRATION}`,
    `--to-profile=${EXACT_TO_PROFILE}`,
    ...(apply
      ? [
          `--recovery-reference=${EXACT_RECOVERY_REFERENCE}`,
          `--recovery-captured-at=${EXACT_RECOVERY_CAPTURED_AT}`
        ]
      : [])
  ];
}

async function proveMigratorExplicitRoleBoundary(pool, physicalPhases) {
  physicalPhases.startExact0004Subphase("oid_catalog_lookup");
  const boundary = await pool.query(
    [
      "SELECT",
      "  NOT member.rolinherit AS login_noinherit,",
      "  NOT membership.inherit_option AS membership_noinherit,",
      "  membership.set_option AS set_role_allowed,",
      "  current_user = session_user AS login_role_active,",
      "  member.oid AS member_oid,",
      "  namespace.oid AS namespace_oid,",
      "  relation.oid AS relation_oid,",
      "  relation.relkind AS relation_kind,",
      "  NOT pg_catalog.has_schema_privilege(",
      "    member.oid, namespace.oid, 'USAGE'",
      "  ) AS direct_schema_usage_absent,",
      "  NOT pg_catalog.has_table_privilege(",
      "    member.oid, relation.oid, 'SELECT'",
      "  ) AS direct_ledger_select_absent",
      "FROM pg_catalog.pg_auth_members membership",
      "JOIN pg_catalog.pg_roles granted",
      "  ON granted.oid = membership.roleid",
      "JOIN pg_catalog.pg_roles member",
      "  ON member.oid = membership.member",
      "JOIN pg_catalog.pg_namespace namespace",
      "  ON namespace.nspname = 'ia4tube_migrations'",
      "JOIN pg_catalog.pg_class relation",
      "  ON relation.relnamespace = namespace.oid",
      "  AND relation.relname = 'schema_migrations'",
      "  AND relation.relkind = 'r'",
      "WHERE granted.rolname = $1",
      "  AND member.rolname = session_user",
      "  AND member.oid IS NOT NULL",
      "  AND namespace.oid IS NOT NULL",
      "  AND relation.oid IS NOT NULL"
    ].join("\n"),
    [MIGRATOR_ROLE]
  );
  physicalPhases.completeExact0004Subphase("oid_catalog_lookup");
  physicalPhases.startExact0004Subphase(
    "direct_privilege_boolean_check"
  );
  assert.equal(boundary.rowCount, 1);
  const {
    member_oid: memberOid,
    namespace_oid: namespaceOid,
    relation_oid: relationOid,
    relation_kind: relationKind,
    ...boundaryFacts
  } = boundary.rows[0];
  for (const oid of [memberOid, namespaceOid, relationOid]) {
    assert.equal(Number.isInteger(oid) && oid > 0, true);
  }
  assert.equal(relationKind, "r");
  assert.deepEqual(boundaryFacts, {
    login_noinherit: true,
    membership_noinherit: true,
    set_role_allowed: true,
    login_role_active: true,
    direct_schema_usage_absent: true,
    direct_ledger_select_absent: true
  });
  physicalPhases.completeExact0004Subphase(
    "direct_privilege_boolean_check"
  );

  const ledgerRead =
    "SELECT COUNT(*)::integer AS ledger_count " +
    "FROM ia4tube_migrations.schema_migrations";
  physicalPhases.startExact0004Subphase("direct_ledger_read_negative");
  await assert.rejects(
    async () => {
      try {
        await pool.query(ledgerRead);
      } catch (error) {
        const sanitized = new Error("migration_login_direct_ledger_refused");
        sanitized.code = error?.code === "42501" ? "42501" : "unknown";
        throw sanitized;
      }
    },
    (error) => error?.code === "42501"
  );
  physicalPhases.completeExact0004Subphase("direct_ledger_read_negative");
  physicalPhases.startExact0004Subphase("set_local_migrator_role");
  const allowed = await withTransaction(
    pool,
    (client) => {
      physicalPhases.completeExact0004Subphase("set_local_migrator_role");
      physicalPhases.startExact0004Subphase("role_ledger_read_positive");
      return client.query(ledgerRead);
    },
    { role: MIGRATOR_ROLE }
  );
  assert.equal(allowed.rowCount, 1);
  assert.equal(Number.isInteger(allowed.rows[0].ledger_count), true);
  physicalPhases.completeExact0004Subphase("role_ledger_read_positive");
}

async function readExactCatalogSnapshot(pool) {
  const result = await withTransaction(
    pool,
    (client) => client.query(
      [
      "SELECT jsonb_build_object(",
      "  'ledger', (",
      "    SELECT COALESCE(jsonb_agg(jsonb_build_array(",
      "      version, checksum_sha256) ORDER BY version), '[]'::jsonb)",
      "    FROM ia4tube_migrations.schema_migrations",
      "  ),",
      "  'relations', (",
      "    SELECT COALESCE(jsonb_agg(jsonb_build_array(",
      "      namespace.nspname, relation.relname, relation.relkind,",
      "      owner.rolname, relation.relrowsecurity,",
      "      relation.relforcerowsecurity, relation.relacl::text",
      "    ) ORDER BY namespace.nspname, relation.relname), '[]'::jsonb)",
      "    FROM pg_catalog.pg_class relation",
      "    JOIN pg_catalog.pg_namespace namespace",
      "      ON namespace.oid = relation.relnamespace",
      "    JOIN pg_catalog.pg_roles owner ON owner.oid = relation.relowner",
      "    WHERE namespace.nspname = ANY($1::text[])",
      "      AND relation.relkind IN ('r','p','v','m','S','f')",
      "  ),",
      "  'columns', (",
      "    SELECT COALESCE(jsonb_agg(jsonb_build_array(",
      "      namespace.nspname, relation.relname, attribute.attnum,",
      "      attribute.attname, pg_catalog.format_type(",
      "        attribute.atttypid, attribute.atttypmod),",
      "      attribute.attnotnull, attribute.attacl::text,",
      "      pg_catalog.pg_get_expr(default_value.adbin,",
      "        default_value.adrelid, true)",
      "    ) ORDER BY namespace.nspname, relation.relname, attribute.attnum),",
      "    '[]'::jsonb)",
      "    FROM pg_catalog.pg_attribute attribute",
      "    JOIN pg_catalog.pg_class relation",
      "      ON relation.oid = attribute.attrelid",
      "    JOIN pg_catalog.pg_namespace namespace",
      "      ON namespace.oid = relation.relnamespace",
      "    LEFT JOIN pg_catalog.pg_attrdef default_value",
      "      ON default_value.adrelid = attribute.attrelid",
      "      AND default_value.adnum = attribute.attnum",
      "    WHERE namespace.nspname = ANY($1::text[])",
      "      AND attribute.attnum > 0 AND NOT attribute.attisdropped",
      "  ),",
      "  'constraints', (",
      "    SELECT COALESCE(jsonb_agg(jsonb_build_array(",
      "      namespace.nspname, relation.relname, constraint_info.conname,",
      "      constraint_info.contype, constraint_info.convalidated,",
      "      pg_catalog.pg_get_constraintdef(constraint_info.oid, true)",
      "    ) ORDER BY namespace.nspname, relation.relname,",
      "      constraint_info.conname), '[]'::jsonb)",
      "    FROM pg_catalog.pg_constraint constraint_info",
      "    JOIN pg_catalog.pg_class relation",
      "      ON relation.oid = constraint_info.conrelid",
      "    JOIN pg_catalog.pg_namespace namespace",
      "      ON namespace.oid = relation.relnamespace",
      "    WHERE namespace.nspname = ANY($1::text[])",
      "  ),",
      "  'indexes', (",
      "    SELECT COALESCE(jsonb_agg(jsonb_build_array(",
      "      namespace.nspname, table_info.relname, index_info.relname,",
      "      pg_catalog.pg_get_indexdef(index_info.oid)",
      "    ) ORDER BY namespace.nspname, table_info.relname,",
      "      index_info.relname), '[]'::jsonb)",
      "    FROM pg_catalog.pg_index index_catalog",
      "    JOIN pg_catalog.pg_class table_info",
      "      ON table_info.oid = index_catalog.indrelid",
      "    JOIN pg_catalog.pg_class index_info",
      "      ON index_info.oid = index_catalog.indexrelid",
      "    JOIN pg_catalog.pg_namespace namespace",
      "      ON namespace.oid = table_info.relnamespace",
      "    WHERE namespace.nspname = ANY($1::text[])",
      "  ),",
      "  'policies', (",
      "    SELECT COALESCE(jsonb_agg(to_jsonb(policy_info)",
      "      ORDER BY schemaname, tablename, policyname), '[]'::jsonb)",
      "    FROM pg_catalog.pg_policies policy_info",
      "    WHERE schemaname = ANY($1::text[])",
      "  )",
      ")::text AS snapshot"
      ].join("\n"),
      [["ia4tube_migrations", "ia4tube_social", "ia4tube_social_admin"]]
    ),
    { role: MIGRATOR_ROLE }
  );
  assert.equal(result.rowCount, 1);
  return result.rows[0].snapshot;
}

async function insertExact0004Conflict(pool, fixture) {
  const conflictingConnectionId = randomUuid();
  await withTransaction(
    pool,
    (client) => client.query(
      [
        "INSERT INTO ia4tube_social.social_connections (",
        "  company_id, id, provider, created_by_user_id",
        ") VALUES ($1, $2, 'instagram', $3)"
      ].join("\n"),
      [fixture.companyId, conflictingConnectionId, fixture.userId]
    ),
    { role: OWNER_ROLE, companyId: fixture.companyId }
  );
  return conflictingConnectionId;
}

async function removeExact0004Conflict(pool, fixture, connectionId) {
  await withTransaction(
    pool,
    (client) => client.query(
      [
        "DELETE FROM ia4tube_social.social_connections",
        "WHERE company_id = $1 AND id = $2"
      ].join("\n"),
      [fixture.companyId, connectionId]
    ),
    { role: OWNER_ROLE, companyId: fixture.companyId }
  );
}

async function countExact0004Conflict(pool, fixture, connectionId) {
  const result = await withTransaction(
    pool,
    (client) => client.query(
      [
        "SELECT COUNT(*)::integer AS connection_count",
        "FROM ia4tube_social.social_connections",
        "WHERE company_id = $1 AND id = $2"
      ].join("\n"),
      [fixture.companyId, connectionId]
    ),
    { role: OWNER_ROLE, companyId: fixture.companyId }
  );
  return result.rows[0].connection_count;
}

async function countExact0004BlockingConnections(pool, fixture) {
  const result = await withTransaction(
    pool,
    (client) => client.query(
      [
        "SELECT COUNT(*)::integer AS connection_count",
        "FROM ia4tube_social.social_connections",
        "WHERE company_id = $1 AND provider = 'instagram'",
        "  AND status IN (",
        "    'pending', 'active', 'authorization_pending', 'connected',",
        "    'reconnect_required', 'disconnecting'",
        "  )"
      ].join("\n"),
      [fixture.companyId]
    ),
    { role: OWNER_ROLE, companyId: fixture.companyId }
  );
  return result.rows[0].connection_count;
}

async function readExact0004OwnerConnectionVisibility(pool) {
  const result = await withTransaction(
    pool,
    (client) => client.query(
      [
        "SELECT",
        "  current_setting('ia4tube.company_id', true)",
        "    AS company_id_setting,",
        "  current_setting('ia4tube.company_id', true) IS NULL",
        "    AS company_id_setting_absent,",
        "  (SELECT COUNT(*)::integer",
        "   FROM ia4tube_social.social_connections",
        "   WHERE provider = 'instagram'",
        "     AND status IN (",
        "       'pending', 'active', 'authorization_pending', 'connected',",
        "       'reconnect_required', 'disconnecting'",
        "     )) AS connection_count"
      ].join("\n")
    ),
    { role: OWNER_ROLE }
  );
  return Object.freeze({
    company_id_setting: result.rows[0].company_id_setting,
    company_id_setting_absent: result.rows[0].company_id_setting_absent,
    connection_count: result.rows[0].connection_count
  });
}

async function insertExact0004ExternalAccountConflict(pool, fixture) {
  const accountIds = Object.freeze([randomUuid(), randomUuid()]);
  await withTransaction(
    pool,
    (client) => client.query(
      [
        "INSERT INTO ia4tube_social.social_external_accounts (",
        "  company_id, id, connection_id, provider, external_id, username,",
        "  account_type, status",
        ") VALUES",
        "  ($1, $2, $4, 'instagram', $5, $6, 'business', 'active'),",
        "  ($1, $3, $4, 'instagram', $7, $8, 'business', 'active')"
      ].join("\n"),
      [
        fixture.companyId,
        accountIds[0],
        accountIds[1],
        fixture.connectionId,
        `exact-0004-external-${accountIds[0]}`,
        `exact_0004_${accountIds[0].replaceAll("-", "")}`,
        `exact-0004-external-${accountIds[1]}`,
        `exact_0004_${accountIds[1].replaceAll("-", "")}`
      ]
    ),
    { role: OWNER_ROLE, companyId: fixture.companyId }
  );
  return accountIds;
}

async function removeExact0004ExternalAccountConflict(pool, fixture, accountIds) {
  await withTransaction(
    pool,
    (client) => client.query(
      [
        "DELETE FROM ia4tube_social.social_external_accounts",
        "WHERE company_id = $1 AND id IN ($2, $3)"
      ].join("\n"),
      [fixture.companyId, ...accountIds]
    ),
    { role: OWNER_ROLE, companyId: fixture.companyId }
  );
}

async function countExact0004ActiveExternalAccounts(pool, fixture) {
  const result = await withTransaction(
    pool,
    (client) => client.query(
      [
        "SELECT COUNT(*)::integer AS account_count",
        "FROM ia4tube_social.social_external_accounts",
        "WHERE company_id = $1 AND connection_id = $2",
        "  AND provider = 'instagram' AND status = 'active'"
      ].join("\n"),
      [fixture.companyId, fixture.connectionId]
    ),
    { role: OWNER_ROLE, companyId: fixture.companyId }
  );
  return result.rows[0].account_count;
}

async function readExact0004OwnerExternalAccountVisibility(pool) {
  const result = await withTransaction(
    pool,
    (client) => client.query(
      [
        "SELECT",
        "  current_setting('ia4tube.company_id', true)",
        "    AS company_id_setting,",
        "  current_setting('ia4tube.company_id', true) IS NULL",
        "    AS company_id_setting_absent,",
        "  (SELECT COUNT(*)::integer",
        "   FROM ia4tube_social.social_external_accounts",
        "   WHERE provider = 'instagram' AND status = 'active')",
        "    AS account_count"
      ].join("\n")
    ),
    { role: OWNER_ROLE }
  );
  return Object.freeze({
    company_id_setting: result.rows[0].company_id_setting,
    company_id_setting_absent: result.rows[0].company_id_setting_absent,
    account_count: result.rows[0].account_count
  });
}

async function proveExact0004Route(
  migrationPoolA,
  migrationPoolB,
  configuration,
  companyWithLegacyConnection,
  physicalPhases
) {
  assert.equal(configuration.mode, LOOPBACK_MODE);
  const runnerA = migrationRunner(migrationPoolA, configuration);
  const runnerB = migrationRunner(migrationPoolB, configuration);
  await proveMigratorExplicitRoleBoundary(migrationPoolA, physicalPhases);
  physicalPhases.startExact0004Subphase("snapshot_before_plan");
  const beforePlan = await readExactCatalogSnapshot(migrationPoolA);
  physicalPhases.completeExact0004Subphase("snapshot_before_plan");
  physicalPhases.startExact0004Subphase("plan_exact");
  const plan = await runnerA.planExact(
    EXACT_PLAN_REQUEST,
    configuration.approvalEnvironment
  );
  assert.deepEqual(plan, {
    fromProfile: EXACT_FROM_PROFILE,
    toProfile: EXACT_TO_PROFILE,
    expectedPending: [SOCIAL_CONNECTOR_PERSISTENCE_MIGRATION],
    observedPending: [SOCIAL_CONNECTOR_PERSISTENCE_MIGRATION],
    planApproved: true
  });
  physicalPhases.completeExact0004Subphase("plan_exact");
  physicalPhases.startExact0004Subphase("plan_snapshot_compare");
  assert.equal(await readExactCatalogSnapshot(migrationPoolA), beforePlan);
  assert.deepEqual(
    runMigrationCli("plan-exact", configuration, exactCliFlags()),
    plan
  );
  assert.equal(await readExactCatalogSnapshot(migrationPoolA), beforePlan);
  physicalPhases.completeExact0004Subphase("plan_snapshot_compare");

  physicalPhases.startExact0004Subphase("synthetic_0005_negative");
  const manifest = readManifest();
  const futureSql = "SELECT 1;\n";
  const futureManifest = temporaryMigrationManifest(
    [
      ...manifest,
      {
        version: "0005_synthetic_future",
        file: "0005_synthetic_future.up.sql",
        sql: futureSql,
        sha256: migrationSha256(Buffer.from(futureSql, "utf8"))
      }
    ],
    "exact-0005-refusal"
  );
  try {
    const futureRunner = migrationRunner(
      migrationPoolA,
      configuration,
      futureManifest.options
    );
    await assert.rejects(
      futureRunner.planExact(
        EXACT_PLAN_REQUEST,
        configuration.approvalEnvironment
      ),
      { code: "exact_pending_set_mismatch" }
    );
    assert.equal(await readExactCatalogSnapshot(migrationPoolA), beforePlan);
  } finally {
    fs.rmSync(futureManifest.directory, { recursive: true, force: true });
  }
  physicalPhases.completeExact0004Subphase("synthetic_0005_negative");

  physicalPhases.startExact0004Subphase("conflicting_0004_negative");
  physicalPhases.markExact0004DatabaseMutationAttempted();
  const conflictId = await insertExact0004Conflict(
    migrationPoolA,
    companyWithLegacyConnection
  );
  try {
    assert.equal(
      await countExact0004BlockingConnections(
        migrationPoolA,
        companyWithLegacyConnection
      ),
      2
    );
    assert.deepEqual(
      await readExact0004OwnerConnectionVisibility(migrationPoolB),
      {
        company_id_setting: null,
        company_id_setting_absent: true,
        connection_count: 0
      },
      "FORCE RLS deve ocultar do owner sem company_id as duas conexoes fisicas."
    );
    const beforeRollback = await readExactCatalogSnapshot(migrationPoolA);
    physicalPhases.markExact0004ConflictingNegativeAttempted();
    const observedConflictingNegativePromise =
      physicalPhases.observeExact0004ConflictingNegative(
        runnerA.applyExact(
          EXACT_APPLY_REQUEST,
          configuration.approvalEnvironment
        )
      );
    await assert.rejects(
      observedConflictingNegativePromise,
      (error) => {
        const matched = error?.code === "23514";
        physicalPhases.markExact0004ConflictingNegativeAssertionMatched(
          matched
        );
        return matched;
      }
    );
    physicalPhases.completeExact0004Subphase(
      "conflicting_0004_negative"
    );
    physicalPhases.startExact0004Subphase("rollback_verification");
    assert.equal(
      await readExactCatalogSnapshot(migrationPoolA),
      beforeRollback,
      "A falha do preflight canonico deve reverter DDL e ledger da 0004."
    );
    const rollbackState = await withTransaction(
      migrationPoolA,
      (client) => client.query(
        [
          "WITH target_namespace AS (",
          "  SELECT namespace.oid",
          "  FROM pg_catalog.pg_namespace namespace",
          "  WHERE namespace.nspname = 'ia4tube_social'",
          "), target_relations AS (",
          "  SELECT relation.relname, relation.relkind",
          "  FROM target_namespace namespace",
          "  JOIN pg_catalog.pg_class relation",
          "    ON relation.relnamespace = namespace.oid",
          "  WHERE relation.relname IN (",
          "    'social_idempotency_operations',",
          "    'social_connections_instagram_blocking_company_unique',",
          "    'social_external_accounts_instagram_active_company_unique'",
          "  )",
          ")",
          "SELECT",
          "  (SELECT COUNT(*)::integer FROM target_namespace)",
          "    AS social_schema_count,",
          "  (SELECT COUNT(*)::integer FROM target_relations",
          "   WHERE relname = 'social_idempotency_operations')",
          "    AS new_table_count,",
          "  (SELECT COUNT(*)::integer FROM target_relations",
          "   WHERE relname =",
          "     'social_connections_instagram_blocking_company_unique')",
          "    AS blocking_connection_index_count,",
          "  (SELECT COUNT(*)::integer FROM target_relations",
          "   WHERE relname =",
          "     'social_external_accounts_instagram_active_company_unique')",
          "    AS active_account_index_count,",
          "  (SELECT COUNT(*)::integer FROM target_relations",
          "   WHERE (relname = 'social_idempotency_operations'",
          "     AND relkind <> 'r')",
          "     OR (relname IN (",
          "       'social_connections_instagram_blocking_company_unique',",
          "       'social_external_accounts_instagram_active_company_unique'",
          "     ) AND relkind <> 'i')) AS unexpected_relkind_count,",
          "  (SELECT COUNT(*)::integer",
          "   FROM ia4tube_migrations.schema_migrations",
          "   WHERE version = $1) AS ledger_row_count"
        ].join("\n"),
        [SOCIAL_CONNECTOR_PERSISTENCE_MIGRATION]
      ),
      { role: MIGRATOR_ROLE }
    );
    assert.equal(rollbackState.rowCount, 1);
    assert.deepEqual(rollbackState.rows, [{
      social_schema_count: 1,
      new_table_count: 0,
      blocking_connection_index_count: 0,
      active_account_index_count: 0,
      unexpected_relkind_count: 0,
      ledger_row_count: 0
    }]);
    assert.equal(
      await countExact0004Conflict(
        migrationPoolA,
        companyWithLegacyConnection,
        conflictId
      ),
      1,
      "A falha da 0004 nao pode alterar os dados preexistentes."
    );
    assert.equal(
      await countExact0004BlockingConnections(
        migrationPoolA,
        companyWithLegacyConnection
      ),
      2,
      "O rollback da 0004 deve preservar as duas conexoes conflitantes."
    );
  } finally {
    await removeExact0004Conflict(
      migrationPoolA,
      companyWithLegacyConnection,
      conflictId
    );
    assert.equal(
      await countExact0004Conflict(
        migrationPoolA,
        companyWithLegacyConnection,
        conflictId
      ),
      0
    );
    assert.equal(
      await countExact0004BlockingConnections(
        migrationPoolA,
        companyWithLegacyConnection
      ),
      1,
      "O cleanup deve restaurar a fixture de conexao original."
    );
  }
  physicalPhases.completeExact0004Subphase("rollback_verification");

  physicalPhases.startExact0004Subphase(
    "conflicting_external_account_0004_negative"
  );
  const externalAccountCountBefore = await countExact0004ActiveExternalAccounts(
    migrationPoolA,
    companyWithLegacyConnection
  );
  assert.equal(externalAccountCountBefore, 0);
  const conflictingExternalAccountIds =
    await insertExact0004ExternalAccountConflict(
      migrationPoolA,
      companyWithLegacyConnection
    );
  assert.equal(new Set(conflictingExternalAccountIds).size, 2);
  try {
    assert.equal(
      await countExact0004ActiveExternalAccounts(
        migrationPoolA,
        companyWithLegacyConnection
      ),
      2
    );
    assert.deepEqual(
      await readExact0004OwnerExternalAccountVisibility(migrationPoolB),
      {
        company_id_setting: null,
        company_id_setting_absent: true,
        account_count: 0
      },
      "FORCE RLS deve ocultar do owner sem company_id as duas contas fisicas."
    );
    const beforeExternalAccountRollback =
      await readExactCatalogSnapshot(migrationPoolA);
    await assert.rejects(
      runnerA.applyExact(
        EXACT_APPLY_REQUEST,
        configuration.approvalEnvironment
      ),
      (error) => error?.code === "23514"
    );
    physicalPhases.completeExact0004Subphase(
      "conflicting_external_account_0004_negative"
    );
    physicalPhases.startExact0004Subphase(
      "external_account_rollback_verification"
    );
    assert.equal(
      await readExactCatalogSnapshot(migrationPoolA),
      beforeExternalAccountRollback,
      "A falha do gate de contas deve reverter todo o DDL e ledger da 0004."
    );
    const externalAccountRollbackState = await withTransaction(
      migrationPoolA,
      (client) => client.query(
        [
          "SELECT",
          "  to_regclass('ia4tube_social.social_idempotency_operations')",
          "    IS NULL AS new_table_absent,",
          "  to_regclass(",
          "    'ia4tube_social.social_connections_instagram_blocking_company_unique'",
          "  ) IS NULL AS blocking_connection_index_absent,",
          "  to_regclass(",
          "    'ia4tube_social.social_external_accounts_instagram_active_company_unique'",
          "  ) IS NULL AS active_account_index_absent,",
          "  NOT EXISTS (",
          "    SELECT 1 FROM ia4tube_migrations.schema_migrations",
          "    WHERE version = $1",
          "  ) AS ledger_row_absent"
        ].join("\n"),
        [SOCIAL_CONNECTOR_PERSISTENCE_MIGRATION]
      ),
      { role: MIGRATOR_ROLE }
    );
    assert.deepEqual(externalAccountRollbackState.rows[0], {
      new_table_absent: true,
      blocking_connection_index_absent: true,
      active_account_index_absent: true,
      ledger_row_absent: true
    });
    assert.equal(
      await countExact0004ActiveExternalAccounts(
        migrationPoolA,
        companyWithLegacyConnection
      ),
      2,
      "O rollback da 0004 deve preservar as duas contas conflitantes."
    );
  } finally {
    await removeExact0004ExternalAccountConflict(
      migrationPoolA,
      companyWithLegacyConnection,
      conflictingExternalAccountIds
    );
    assert.equal(
      await countExact0004ActiveExternalAccounts(
        migrationPoolA,
        companyWithLegacyConnection
      ),
      externalAccountCountBefore,
      "O cleanup deve restaurar a fixture anterior ao conflito de contas."
    );
  }
  physicalPhases.completeExact0004Subphase(
    "external_account_rollback_verification"
  );

  await migrationPoolA.query("SET lock_timeout = 0");
  await migrationPoolB.query("SET lock_timeout = 0");
  physicalPhases.startExact0004Subphase("apply_exact");
  const outcomes = await Promise.allSettled([
    runnerA.applyExact(
      EXACT_APPLY_REQUEST,
      configuration.approvalEnvironment
    ),
    runnerB.applyExact(
      EXACT_APPLY_REQUEST,
      configuration.approvalEnvironment
    )
  ]);
  physicalPhases.completeExact0004Subphase("apply_exact");
  physicalPhases.startExact0004Subphase("concurrency");
  const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
  const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason?.code, "exact_pending_set_mismatch");
  const result = fulfilled[0].value;
  assert.equal(result.appliedMigration, SOCIAL_CONNECTOR_PERSISTENCE_MIGRATION);
  assert.equal(result.finalProfile, EXACT_TO_PROFILE);
  assert.equal(result.postCommitValidated, true);
  assert.equal(result.recoveryEvidenceExternallyVerified, false);
  assert.equal(result.recoveryReferenceDigest, digest(EXACT_RECOVERY_REFERENCE));
  assert.equal(JSON.stringify(result).includes(EXACT_RECOVERY_REFERENCE), false);
  physicalPhases.completeExact0004Subphase("concurrency");

  physicalPhases.startExact0004Subphase("final_snapshot");
  const final = await withTransaction(
    migrationPoolA,
    (client) => client.query(
      [
      "SELECT",
      "  (SELECT COUNT(*)::integer",
      "   FROM ia4tube_migrations.schema_migrations",
      "   WHERE version = $1) AS ledger_rows,",
      "  (SELECT COUNT(*)::integer",
      "   FROM pg_catalog.pg_class relation",
      "   JOIN pg_catalog.pg_namespace namespace",
      "     ON namespace.oid = relation.relnamespace",
      "   WHERE namespace.nspname = 'ia4tube_social'",
      "     AND relation.relname = ANY($2::text[])) AS connector_relations,",
      "  (SELECT COUNT(*)::integer",
      "   FROM pg_catalog.pg_index index_catalog",
      "   JOIN pg_catalog.pg_class relation",
      "     ON relation.oid = index_catalog.indexrelid",
      "   JOIN pg_catalog.pg_namespace namespace",
      "     ON namespace.oid = relation.relnamespace",
      "   WHERE namespace.nspname = 'ia4tube_social'",
      "     AND relation.relkind = 'i'",
      "     AND index_catalog.indisunique",
      "     AND index_catalog.indisvalid",
      "     AND index_catalog.indisready",
      "     AND relation.relname = ANY($3::text[])) AS connector_indexes"
      ].join("\n"),
      [
        SOCIAL_CONNECTOR_PERSISTENCE_MIGRATION,
        [
          "social_idempotency_operations",
          "social_publications",
          "social_publication_attempts"
        ],
        [
          "social_connections_instagram_blocking_company_unique",
          "social_external_accounts_instagram_active_company_unique"
        ]
      ]
    ),
    { role: MIGRATOR_ROLE }
  );
  assert.equal(final.rows[0].ledger_rows, 1);
  assert.equal(final.rows[0].connector_relations, 3);
  assert.equal(final.rows[0].connector_indexes, 2);
  await assert.rejects(
    runnerA.planExact(EXACT_PLAN_REQUEST, configuration.approvalEnvironment),
    { code: "exact_pending_set_mismatch" }
  );
  physicalPhases.completeExact0004Subphase("final_snapshot");
  return { runnerA, runnerB };
}

function tenantFixture(label) {
  return Object.freeze({
    label,
    companyId: randomUuid(),
    userId: randomUuid(),
    mappingId: randomUuid(),
    connectionId: randomUuid(),
    accountId: randomUuid(),
    destinationId: randomUuid(),
    oauthId: randomUuid(),
    credentialId: randomUuid(),
    reauthId: randomUuid(),
    idempotencyOperationId: randomUuid(),
    publicationId: randomUuid(),
    auditId: randomUuid(),
    eventId: randomUuid()
  });
}

async function seedCoreTenant(pool, fixture, passwordHash) {
  await withTransaction(
    pool,
    async (client) => {
      await client.query(
        [
          "INSERT INTO ia4tube_social.companies (",
          "  id, name, identity_derivation_version",
          ") VALUES ($1, $2, $3)"
        ].join("\n"),
        [fixture.companyId, `Synthetic Company ${fixture.label}`, IDENTITY_VERSION]
      );
      await client.query(
        [
          "INSERT INTO ia4tube_social.users (",
          "  company_id, id, login_key_digest, password_hash",
          ") VALUES ($1, $2, $3, $4)"
        ].join("\n"),
        [
          fixture.companyId,
          fixture.userId,
          digest(`synthetic-login-${fixture.label}`),
          passwordHash
        ]
      );
      await client.query(
        [
          "INSERT INTO ia4tube_social.company_memberships (",
          "  company_id, user_id, role",
          ") VALUES ($1, $2, 'owner')"
        ].join("\n"),
        [fixture.companyId, fixture.userId]
      );
      await client.query(
        [
          "INSERT INTO ia4tube_social.legacy_entity_mappings (",
          "  company_id, id, migration_version, source_system,",
          "  source_entity_type, source_entity_id_digest, source_sha256,",
          "  target_entity_type, target_entity_id",
          ") VALUES ($1, $2, $3, 'synthetic', 'user',",
          "  $4, $5, 'user', $6)"
        ].join("\n"),
        [
          fixture.companyId,
          fixture.mappingId,
          FOUNDATION_MIGRATION_VERSION,
          digest(`source-id-${fixture.label}`),
          digest(`source-json-${fixture.label}`),
          fixture.userId
        ]
      );
    },
    { role: OWNER_ROLE, companyId: fixture.companyId }
  );
}

async function seedPreRegistryCredential(pool, fixture, keyVersion) {
  const ciphertext = crypto
    .createHash("sha256")
    .update(`synthetic-backfill-ciphertext-${fixture.label}`)
    .digest();
  const nonce = crypto
    .createHash("sha256")
    .update(`synthetic-backfill-nonce-${fixture.label}`)
    .digest()
    .subarray(0, 12);
  const authTag = crypto
    .createHash("sha256")
    .update(`synthetic-backfill-tag-${fixture.label}`)
    .digest()
    .subarray(0, 16);
  await withTransaction(
    pool,
    async (client) => {
      await client.query(
        [
          "INSERT INTO ia4tube_social.social_connections (",
          "  company_id, id, provider, created_by_user_id",
          ") VALUES ($1, $2, 'instagram', $3)"
        ].join("\n"),
        [fixture.companyId, fixture.connectionId, fixture.userId]
      );
      await client.query(
        [
          "INSERT INTO ia4tube_social.social_encrypted_credentials (",
          "  company_id, id, provider, connection_id, credential_type,",
          "  ciphertext, nonce, auth_tag, key_version, aad_version",
          ") VALUES ($1, $2, 'instagram', $3, 'access_token',",
          "  $4, $5, $6, $7, 1)"
        ].join("\n"),
        [
          fixture.companyId,
          fixture.credentialId,
          fixture.connectionId,
          ciphertext,
          nonce,
          authTag,
          keyVersion
        ]
      );
    },
    { role: RUNTIME_ROLE, companyId: fixture.companyId }
  );
}

async function readPreRegistryCredentialSnapshot(pool, fixture) {
  const result = await withTransaction(
    pool,
    (client) =>
      client.query(
        [
          "SELECT company_id::text, id::text, provider,",
          "  connection_id::text, credential_type,",
          "  encode(ciphertext, 'hex') AS ciphertext_hex,",
          "  encode(nonce, 'hex') AS nonce_hex,",
          "  encode(auth_tag, 'hex') AS auth_tag_hex,",
          "  key_version, aad_version, revision",
          "FROM ia4tube_social.social_encrypted_credentials",
          "WHERE company_id = $1 AND id = $2"
        ].join("\n"),
        [fixture.companyId, fixture.credentialId]
      ),
    { role: RUNTIME_ROLE, companyId: fixture.companyId }
  );
  assert.equal(result.rowCount, 1);
  return digest(JSON.stringify(result.rows[0]));
}

async function provePreRegistryIsolation(
  migrationPool,
  runtimePool,
  companyC,
  companyD
) {
  const catalog = await migrationPool.query(
    [
      "SELECT",
      "  to_regnamespace('ia4tube_social_admin') IS NULL",
      "    AS admin_schema_absent,",
      "  NOT EXISTS (",
      "    SELECT 1 FROM pg_catalog.pg_constraint",
      "    WHERE conname = 'social_encrypted_credentials_key_version_fk'",
      "  ) AS key_fk_absent,",
      "  relation.relrowsecurity AS rls_enabled,",
      "  relation.relforcerowsecurity AS rls_forced",
      "FROM pg_catalog.pg_class relation",
      "JOIN pg_catalog.pg_namespace namespace",
      "  ON namespace.oid = relation.relnamespace",
      "WHERE namespace.nspname = 'ia4tube_social'",
      "  AND relation.relname = 'social_encrypted_credentials'"
    ].join("\n")
  );
  assert.equal(catalog.rowCount, 1);
  assert.equal(catalog.rows[0].admin_schema_absent, true);
  assert.equal(catalog.rows[0].key_fk_absent, true);
  assert.equal(catalog.rows[0].rls_enabled, true);
  assert.equal(catalog.rows[0].rls_forced, true);

  const ownerWithoutTenant = await withTransaction(
    migrationPool,
    (client) =>
      client.query(
        [
          "SELECT COUNT(*)::integer AS credential_count",
          "FROM ia4tube_social.social_encrypted_credentials"
        ].join("\n")
      ),
    { role: OWNER_ROLE }
  );
  assert.equal(ownerWithoutTenant.rows[0].credential_count, 0);

  for (const [own, other] of [
    [companyC, companyD],
    [companyD, companyC]
  ]) {
    const ownRows = await withTransaction(
      runtimePool,
      (client) =>
        client.query(
          [
            "SELECT id FROM ia4tube_social.social_encrypted_credentials",
            "WHERE company_id = $1 AND id = $2"
          ].join("\n"),
          [own.companyId, own.credentialId]
        ),
      { role: RUNTIME_ROLE, companyId: own.companyId }
    );
    assert.equal(ownRows.rowCount, 1);
    const crossRows = await withTransaction(
      runtimePool,
      (client) =>
        client.query(
          [
            "SELECT id FROM ia4tube_social.social_encrypted_credentials",
            "WHERE company_id = $1 AND id = $2"
          ].join("\n"),
          [other.companyId, other.credentialId]
        ),
      { role: RUNTIME_ROLE, companyId: own.companyId }
    );
    assert.equal(crossRows.rowCount, 0);
  }
}

async function provePopulated0003Rollback(
  migrationPool,
  runtimePool,
  configuration,
  companyC,
  companyD,
  snapshots
) {
  const manifest = readManifest();
  const migrationIndex = manifest.findIndex(
    (item) => item.version === GLOBAL_VAULT_REGISTRY_MIGRATION
  );
  assert.ok(migrationIndex >= 0);
  const migration = manifest[migrationIndex];
  const failedSql = [
    migration.sql.trimEnd(),
    "SELECT ia4tube_intentionally_missing_backfill_function();",
    ""
  ].join("\n");
  const failedMigration = Object.freeze({
    ...migration,
    sql: failedSql,
    sha256: migrationSha256(Buffer.from(failedSql, "utf8"))
  });
  const temporary = temporaryMigrationManifest(
    [...manifest.slice(0, migrationIndex), failedMigration],
    "0003-populated-rollback"
  );
  try {
    const runner = migrationRunner(
      migrationPool,
      configuration,
      temporary.options
    );
    await assert.rejects(
      runner.apply(configuration.approvalEnvironment),
      (error) => error?.code === "42883"
    );
  } finally {
    fs.rmSync(temporary.directory, { recursive: true, force: true });
  }

  const state = await withTransaction(
    migrationPool,
    (client) =>
      client.query(
        [
          "SELECT",
          "  to_regnamespace('ia4tube_social_admin') IS NULL",
          "    AS admin_schema_absent,",
          "  NOT EXISTS (",
          "    SELECT 1 FROM pg_catalog.pg_constraint",
          "    WHERE conname = 'social_encrypted_credentials_key_version_fk'",
          "  ) AS key_fk_absent,",
          "  NOT EXISTS (",
          "    SELECT 1 FROM pg_catalog.pg_policies",
          "    WHERE schemaname = 'ia4tube_social'",
          "      AND tablename = 'social_encrypted_credentials'",
          "      AND policyname = $1",
          "  ) AS transient_policy_absent,",
          "  (SELECT COUNT(*)::integer",
          "   FROM ia4tube_migrations.schema_migrations) AS ledger_count"
        ].join("\n"),
        [GLOBAL_VAULT_BACKFILL_POLICY]
      ),
    { role: OWNER_ROLE }
  );
  assert.equal(state.rows[0].admin_schema_absent, true);
  assert.equal(state.rows[0].key_fk_absent, true);
  assert.equal(state.rows[0].transient_policy_absent, true);
  assert.equal(state.rows[0].ledger_count, 2);
  assert.equal(
    await readPreRegistryCredentialSnapshot(runtimePool, companyC),
    snapshots.get(companyC.companyId)
  );
  assert.equal(
    await readPreRegistryCredentialSnapshot(runtimePool, companyD),
    snapshots.get(companyD.companyId)
  );
  await provePreRegistryIsolation(
    migrationPool,
    runtimePool,
    companyC,
    companyD
  );
}

async function provePopulated0003Success(
  migrationPool,
  runtimePool,
  runner,
  configuration,
  companyC,
  companyD,
  snapshots
) {
  const state = await migrationPool.query(
    [
      "SELECT",
      "  constraint_info.convalidated AS key_fk_validated,",
      "  NOT EXISTS (",
      "    SELECT 1 FROM pg_catalog.pg_policies",
      "    WHERE schemaname = 'ia4tube_social'",
      "      AND tablename = 'social_encrypted_credentials'",
      "      AND policyname = $1",
      "  ) AS transient_policy_absent,",
      "  relation.relrowsecurity AS rls_enabled,",
      "  relation.relforcerowsecurity AS rls_forced",
      "FROM pg_catalog.pg_constraint constraint_info",
      "JOIN pg_catalog.pg_class relation",
      "  ON relation.oid = constraint_info.conrelid",
      "WHERE constraint_info.conname =",
      "  'social_encrypted_credentials_key_version_fk'"
    ].join("\n"),
    [GLOBAL_VAULT_BACKFILL_POLICY]
  );
  assert.equal(state.rowCount, 1);
  assert.equal(state.rows[0].key_fk_validated, true);
  assert.equal(state.rows[0].transient_policy_absent, true);
  assert.equal(state.rows[0].rls_enabled, true);
  assert.equal(state.rows[0].rls_forced, true);

  const registry = await withTransaction(
    migrationPool,
    (client) =>
      client.query(
        [
          "SELECT key_version",
          "FROM ia4tube_social_admin.vault_key_versions",
          "ORDER BY key_version"
        ].join("\n")
      ),
    { role: OWNER_ROLE }
  );
  assert.deepEqual(
    registry.rows.map((row) => row.key_version),
    [BACKFILL_VERSION_V1]
  );
  assert.equal(
    await readPreRegistryCredentialSnapshot(runtimePool, companyC),
    snapshots.get(companyC.companyId)
  );
  assert.equal(
    await readPreRegistryCredentialSnapshot(runtimePool, companyD),
    snapshots.get(companyD.companyId)
  );
  assert.deepEqual(
    await runner.apply(configuration.approvalEnvironment),
    []
  );

  const keyRegistryAdmin = createVaultKeyRegistryAdmin({
    pool: migrationPool,
    ownerRole: OWNER_ROLE
  });
  await keyRegistryAdmin.register({ keyVersion: BACKFILL_VERSION_V2 });
  async function rotate(fixture) {
    const result = await withTransaction(
      runtimePool,
      (client) =>
        client.query(
          [
            "UPDATE ia4tube_social.social_encrypted_credentials",
            "SET key_version = $3,",
            "  revision = revision + 1, updated_at = CURRENT_TIMESTAMP",
            "WHERE company_id = $1 AND id = $2",
            "RETURNING key_version, revision"
          ].join("\n"),
          [
            fixture.companyId,
            fixture.credentialId,
            BACKFILL_VERSION_V2
          ]
        ),
      { role: RUNTIME_ROLE, companyId: fixture.companyId }
    );
    assert.equal(result.rowCount, 1);
    assert.equal(result.rows[0].key_version, BACKFILL_VERSION_V2);
    assert.equal(Number(result.rows[0].revision), 2);
  }
  await rotate(companyC);
  await assert.rejects(
    keyRegistryAdmin.retire({ keyVersion: BACKFILL_VERSION_V1 }),
    { code: "vault_key_version_in_use" }
  );
  const companyDOld = await withTransaction(
    runtimePool,
    (client) =>
      client.query(
        [
          "SELECT key_version",
          "FROM ia4tube_social.social_encrypted_credentials",
          "WHERE company_id = $1 AND id = $2"
        ].join("\n"),
        [companyD.companyId, companyD.credentialId]
      ),
    { role: RUNTIME_ROLE, companyId: companyD.companyId }
  );
  assert.equal(companyDOld.rows[0].key_version, BACKFILL_VERSION_V1);
  await rotate(companyD);
  assert.deepEqual(
    await keyRegistryAdmin.retire({ keyVersion: BACKFILL_VERSION_V1 }),
    { keyVersion: BACKFILL_VERSION_V1, retired: true }
  );
}

async function seedSocialTenant(pool, repository, fixture) {
  await repository.createConnection({
    companyId: fixture.companyId,
    id: fixture.connectionId,
    provider: "instagram",
    createdByUserId: fixture.userId
  });
  await withTransaction(
    pool,
    async (client) => {
      await client.query(
        [
          "UPDATE ia4tube_social.social_connections",
          "SET status = 'active', connected_at = CURRENT_TIMESTAMP",
          "WHERE company_id = $1 AND id = $2"
        ].join("\n"),
        [fixture.companyId, fixture.connectionId]
      );
      await client.query(
        [
          "INSERT INTO ia4tube_social.social_external_accounts (",
          "  company_id, id, connection_id, provider, external_id,",
          "  username, display_name, account_type",
          ") VALUES ($1, $2, $3, 'instagram', $4, $5, $6, 'business')"
        ].join("\n"),
        [
          fixture.companyId,
          fixture.accountId,
          fixture.connectionId,
          `external-${fixture.label}`,
          `synthetic_${fixture.label.toLowerCase()}`,
          `Synthetic Account ${fixture.label}`
        ]
      );
      await client.query(
        [
          "INSERT INTO ia4tube_social.social_destinations (",
          "  company_id, id, connection_id, external_account_id,",
          "  destination_type, external_id, display_name",
          ") VALUES ($1, $2, $3, $4, 'feed', $5, $6)"
        ].join("\n"),
        [
          fixture.companyId,
          fixture.destinationId,
          fixture.connectionId,
          fixture.accountId,
          `destination-${fixture.label}`,
          `Synthetic Destination ${fixture.label}`
        ]
      );
      await client.query(
        [
          "INSERT INTO ia4tube_social.social_connection_scopes (",
          "  company_id, connection_id, scope",
          ") VALUES ($1, $2, 'instagram_business_basic')"
        ].join("\n"),
        [fixture.companyId, fixture.connectionId]
      );
      await client.query(
        [
          "INSERT INTO ia4tube_social.social_oauth_transactions (",
          "  company_id, id, provider, purpose, state_digest,",
          "  redirect_uri_digest, initiated_by_user_id,",
          "  session_jti_digest, expires_at",
          ") VALUES ($1, $2, 'instagram', 'connect', $3, $4, $5, $6,",
          "  CURRENT_TIMESTAMP + INTERVAL '5 minutes')"
        ].join("\n"),
        [
          fixture.companyId,
          fixture.oauthId,
          digest(`state-${fixture.label}-${randomUuid()}`),
          digest(`redirect-${fixture.label}`),
          fixture.userId,
          digest(`session-${fixture.label}`)
        ]
      );
      const publicationHash = digest(
        `synthetic-publication-${fixture.label}`
      );
      await client.query(
        [
          "INSERT INTO ia4tube_social.social_idempotency_operations (",
          "  company_id, operation_id, provider, capability, request_hash",
          ") VALUES ($1, $2, 'instagram', 'publishImage', $3)"
        ].join("\n"),
        [
          fixture.companyId,
          fixture.idempotencyOperationId,
          publicationHash
        ]
      );
      await client.query(
        [
          "INSERT INTO ia4tube_social.social_publications (",
          "  company_id, id, connection_id, provider, media_reference,",
          "  media_metadata_digest, idempotency_key, request_hash",
          ") VALUES ($1, $2, $3, 'instagram', $4, $5, $6, $7)"
        ].join("\n"),
        [
          fixture.companyId,
          fixture.publicationId,
          fixture.connectionId,
          `synthetic-media-${fixture.label.toLowerCase()}`,
          digest(`synthetic-media-metadata-${fixture.label}`),
          fixture.idempotencyOperationId,
          publicationHash
        ]
      );
      await client.query(
        [
          "INSERT INTO ia4tube_social.social_publication_attempts (",
          "  company_id, publication_id, provider, attempt_number, state",
          ") VALUES ($1, $2, 'instagram', 1, 'started')"
        ].join("\n"),
        [fixture.companyId, fixture.publicationId]
      );
      await client.query(
        [
          "INSERT INTO ia4tube_social.social_audit_events (",
          "  company_id, id, event_id, actor_user_id, connection_id,",
          "  provider, action, outcome, details_code",
          ") VALUES ($1, $2, $3, $4, $5, 'instagram',",
          "  'social.test', 'succeeded', 'synthetic')"
        ].join("\n"),
        [
          fixture.companyId,
          fixture.auditId,
          fixture.eventId,
          fixture.userId,
          fixture.connectionId
        ]
      );
    },
    { role: RUNTIME_ROLE, companyId: fixture.companyId }
  );
}

async function seedSecondaryCredentialAndGrant(
  repository,
  fixture
) {
  await repository.createReauthGrant({
    companyId: fixture.companyId,
    id: fixture.reauthId,
    userId: fixture.userId,
    tokenDigest: digest(`grant-${fixture.label}-${randomUuid()}`),
    sessionJtiDigest: digest(`reauth-session-${fixture.label}`),
    action: "social.connect",
    provider: "instagram",
    targetConnectionId: null,
    authVersion: 1,
    expiresAt: new Date(Date.now() + 4 * 60 * 1000)
  });
}

async function proveTransactionRollback(pool, fixture) {
  const connectionId = randomUuid();
  await assert.rejects(
    withTransaction(
      pool,
      async (client) => {
        await client.query(
          [
            "INSERT INTO ia4tube_social.social_connections (",
            "  company_id, id, provider, created_by_user_id",
            ") VALUES ($1, $2, 'instagram', $3)"
          ].join("\n"),
          [fixture.companyId, connectionId, fixture.userId]
        );
        throw new Error("synthetic_transaction_rollback");
      },
      { role: RUNTIME_ROLE, companyId: fixture.companyId }
    ),
    /synthetic_transaction_rollback/
  );
  const result = await withTransaction(
    pool,
    (client) =>
      client.query(
        [
          "SELECT id FROM ia4tube_social.social_connections",
          "WHERE company_id = $1 AND id = $2"
        ].join("\n"),
        [fixture.companyId, connectionId]
      ),
    { role: RUNTIME_ROLE, companyId: fixture.companyId }
  );
  assert.equal(result.rowCount, 0);
}

async function provePoolContextCleanup(pool, fixture) {
  const scoped = await withTransaction(
    pool,
    (client) =>
      client.query(
        [
          "SELECT pg_backend_pid() AS backend_pid,",
          "  current_setting('ia4tube.company_id', true) AS company_id"
        ].join("\n")
      ),
    { role: RUNTIME_ROLE, companyId: fixture.companyId }
  );
  assert.equal(scoped.rows[0].company_id, fixture.companyId);

  const unscoped = await withTransaction(
    pool,
    (client) =>
      client.query(
        [
          "SELECT pg_backend_pid() AS backend_pid,",
          "  NULLIF(current_setting('ia4tube.company_id', true), '')",
          "    AS company_id,",
          "  (SELECT COUNT(*)::integer",
          "   FROM ia4tube_social.companies",
          "   WHERE id = $1) AS leaked_rows"
        ].join("\n"),
        [fixture.companyId]
      ),
    { role: RUNTIME_ROLE }
  );
  assert.equal(unscoped.rows[0].backend_pid, scoped.rows[0].backend_pid);
  assert.equal(unscoped.rows[0].company_id, null);
  assert.equal(unscoped.rows[0].leaked_rows, 0);
}

async function proveOwnerForceRls(migrationPool, companyA, companyB) {
  const selectCompanyA = (companyId) =>
    withTransaction(
      migrationPool,
      (client) =>
        client.query(
          [
            "SELECT id FROM ia4tube_social.companies",
            "WHERE id = $1"
          ].join("\n"),
          [companyA.companyId]
        ),
      {
        role: OWNER_ROLE,
        ...(companyId ? { companyId } : {})
      }
    );

  assert.equal(
    (await selectCompanyA(companyA.companyId)).rowCount,
    1,
    "O proprio owner deve enxergar somente a empresa do contexto."
  );
  assert.equal(
    (await selectCompanyA(companyB.companyId)).rowCount,
    0,
    "FORCE RLS deve impedir o owner de atravessar empresas."
  );
  assert.equal(
    (await selectCompanyA(null)).rowCount,
    0,
    "FORCE RLS deve falhar fechado para o owner sem contexto."
  );

  await assert.rejects(
    withTransaction(
      migrationPool,
      (client) =>
        client.query(
          [
            "INSERT INTO ia4tube_social.social_audit_events (",
            "  company_id, id, event_id, action, outcome, details_code",
            ") VALUES ($1, $2, $3,",
            "  'social.owner_rls', 'rejected', 'synthetic')"
          ].join("\n"),
          [companyA.companyId, randomUuid(), randomUuid()]
        ),
      { role: OWNER_ROLE, companyId: companyB.companyId }
    ),
    (error) => error?.code === "42501"
  );
}

async function proveMalformedTenantContext(runtimePool, companyA) {
  const client = await runtimePool.connect();
  let releaseError;
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE ${quoteIdentifier(RUNTIME_ROLE)}`);
    await client.query(
      "SELECT set_config('ia4tube.company_id', $1, true)",
      ["not-a-uuid"]
    );
    await assert.rejects(
      client.query(
        [
          "SELECT id FROM ia4tube_social.companies",
          "WHERE id = $1"
        ].join("\n"),
        [companyA.companyId]
      ),
      (error) => error?.code === "22P02"
    );
  } finally {
    try {
      await client.query("ROLLBACK");
    } catch (error) {
      releaseError = error;
    }
    client.release(releaseError);
  }

  const failClosed = await withTransaction(
    runtimePool,
    (connection) =>
      connection.query(
        [
          "SELECT COUNT(*)::integer AS leaked_rows",
          "FROM ia4tube_social.companies",
          "WHERE id = $1"
        ].join("\n"),
        [companyA.companyId]
      ),
    { role: RUNTIME_ROLE }
  );
  assert.equal(failClosed.rows[0].leaked_rows, 0);
}

async function proveConcurrentTenantTransactions(
  runtimePool,
  companyA,
  companyB
) {
  const first = await runtimePool.connect();
  const second = await runtimePool.connect();
  let firstStarted = false;
  let secondStarted = false;
  let firstReleaseError;
  let secondReleaseError;
  try {
    await first.query("BEGIN");
    firstStarted = true;
    await first.query(`SET LOCAL ROLE ${quoteIdentifier(RUNTIME_ROLE)}`);
    await first.query(
      "SELECT set_config('ia4tube.company_id', $1, true)",
      [companyA.companyId]
    );

    await second.query("BEGIN");
    secondStarted = true;
    await second.query(`SET LOCAL ROLE ${quoteIdentifier(RUNTIME_ROLE)}`);
    await second.query(
      "SELECT set_config('ia4tube.company_id', $1, true)",
      [companyB.companyId]
    );

    const tenantQuery = [
      "SELECT pg_backend_pid() AS backend_pid,",
      "  current_setting('ia4tube.company_id', true) AS company_id,",
      "  (SELECT COUNT(*)::integer FROM ia4tube_social.companies",
      "    WHERE id = $1) AS own_rows,",
      "  (SELECT COUNT(*)::integer FROM ia4tube_social.companies",
      "    WHERE id = $2) AS foreign_rows"
    ].join("\n");
    const [firstResult, secondResult] = await Promise.all([
      first.query(tenantQuery, [companyA.companyId, companyB.companyId]),
      second.query(tenantQuery, [companyB.companyId, companyA.companyId])
    ]);
    assert.notEqual(
      firstResult.rows[0].backend_pid,
      secondResult.rows[0].backend_pid
    );
    assert.equal(firstResult.rows[0].company_id, companyA.companyId);
    assert.equal(secondResult.rows[0].company_id, companyB.companyId);
    for (const result of [firstResult, secondResult]) {
      assert.equal(result.rows[0].own_rows, 1);
      assert.equal(result.rows[0].foreign_rows, 0);
    }

    await Promise.all([first.query("COMMIT"), second.query("COMMIT")]);
    firstStarted = false;
    secondStarted = false;
  } finally {
    if (firstStarted) {
      try {
        await first.query("ROLLBACK");
      } catch (error) {
        firstReleaseError = error;
      }
    }
    if (secondStarted) {
      try {
        await second.query("ROLLBACK");
      } catch (error) {
        secondReleaseError = error;
      }
    }
    first.release(firstReleaseError);
    second.release(secondReleaseError);
  }

  const noContext = await withTransaction(
    runtimePool,
    (client) =>
      client.query(
        [
          "SELECT COUNT(*)::integer AS leaked_rows",
          "FROM ia4tube_social.companies",
          "WHERE id = ANY($1::uuid[])"
        ].join("\n"),
        [[companyA.companyId, companyB.companyId]]
      ),
    { role: RUNTIME_ROLE }
  );
  assert.equal(noContext.rows[0].leaked_rows, 0);
}

async function proveRlsMutations(runtimePool, companyA, companyB) {
  const insertAudit = (companyContext, id, eventId) =>
    withTransaction(
      runtimePool,
      (client) =>
        client.query(
          [
            "INSERT INTO ia4tube_social.social_audit_events (",
            "  company_id, id, event_id, action, outcome, details_code",
            ") VALUES ($1, $2, $3,",
            "  'social.rls_insert', 'rejected', 'synthetic')",
            "RETURNING id"
          ].join("\n"),
          [companyA.companyId, id, eventId]
        ),
      {
        role: RUNTIME_ROLE,
        ...(companyContext ? { companyId: companyContext } : {})
      }
    );

  await assert.rejects(
    insertAudit(companyB.companyId, randomUuid(), randomUuid()),
    (error) => error?.code === "42501"
  );
  await assert.rejects(
    insertAudit(null, randomUuid(), randomUuid()),
    (error) => error?.code === "42501"
  );
  const ownInsert = await insertAudit(
    companyA.companyId,
    randomUuid(),
    randomUuid()
  );
  assert.equal(ownInsert.rowCount, 1);

  for (const companyContext of [companyB.companyId, null]) {
    const crossUpdate = await withTransaction(
      runtimePool,
      (client) =>
        client.query(
          [
            "UPDATE ia4tube_social.social_connections",
            "SET status = 'error'",
            "WHERE company_id = $1 AND id = $2",
            "RETURNING id"
          ].join("\n"),
          [companyA.companyId, companyA.connectionId]
        ),
      {
        role: RUNTIME_ROLE,
        ...(companyContext ? { companyId: companyContext } : {})
      }
    );
    assert.equal(crossUpdate.rowCount, 0);
  }
  const ownUpdate = await withTransaction(
    runtimePool,
    (client) =>
      client.query(
        [
          "UPDATE ia4tube_social.social_connections",
          "SET updated_at = CURRENT_TIMESTAMP",
          "WHERE company_id = $1 AND id = $2 AND status = 'active'",
          "RETURNING id"
        ].join("\n"),
        [companyA.companyId, companyA.connectionId]
      ),
    { role: RUNTIME_ROLE, companyId: companyA.companyId }
  );
  assert.equal(ownUpdate.rowCount, 1);

  const disposableScope = `synthetic_delete_${randomUuid()}`;
  const insertedScope = await withTransaction(
    runtimePool,
    (client) =>
      client.query(
        [
          "INSERT INTO ia4tube_social.social_connection_scopes (",
          "  company_id, connection_id, scope",
          ") VALUES ($1, $2, $3)",
          "RETURNING scope"
        ].join("\n"),
        [companyA.companyId, companyA.connectionId, disposableScope]
      ),
    { role: RUNTIME_ROLE, companyId: companyA.companyId }
  );
  assert.equal(insertedScope.rowCount, 1);

  for (const companyContext of [companyB.companyId, null]) {
    const crossDelete = await withTransaction(
      runtimePool,
      (client) =>
        client.query(
          [
            "DELETE FROM ia4tube_social.social_connection_scopes",
            "WHERE company_id = $1 AND connection_id = $2 AND scope = $3",
            "RETURNING scope"
          ].join("\n"),
          [companyA.companyId, companyA.connectionId, disposableScope]
        ),
      {
        role: RUNTIME_ROLE,
        ...(companyContext ? { companyId: companyContext } : {})
      }
    );
    assert.equal(crossDelete.rowCount, 0);
  }
  const ownDelete = await withTransaction(
    runtimePool,
    (client) =>
      client.query(
        [
          "DELETE FROM ia4tube_social.social_connection_scopes",
          "WHERE company_id = $1 AND connection_id = $2 AND scope = $3",
          "RETURNING scope"
        ].join("\n"),
        [companyA.companyId, companyA.connectionId, disposableScope]
      ),
    { role: RUNTIME_ROLE, companyId: companyA.companyId }
  );
  assert.equal(ownDelete.rowCount, 1);
}

async function proveVaultPersistence(
  migrationPool,
  runtimePool,
  repository,
  keyRegistryAdmin,
  companyA,
  companyB,
  redactedErrors
) {
  const keyV1 = crypto.randomBytes(32);
  const keyV2 = crypto.randomBytes(32);
  const versionV1 = deriveVaultKeyVersion(1, keyV1);
  const versionV2 = deriveVaultKeyVersion(2, keyV2);
  const readableVersions = [versionV1, versionV2];
  let vaultV1;
  let vaultV2;
  let v2OnlyVault;
  const plaintextA = `synthetic-access-token-A-${randomUuid()}`;
  const plaintextB = `synthetic-refresh-token-B-${randomUuid()}`;
  const envelopeFromRow = (row) =>
    Object.freeze({
      ciphertext: row.ciphertext,
      nonce: row.nonce,
      authTag: row.auth_tag,
      keyVersion: row.key_version,
      aadVersion: row.aad_version
    });
  const contextA = Object.freeze({
    companyId: companyA.companyId,
    provider: "instagram",
    credentialId: companyA.credentialId,
    credentialType: "access_token",
    subjectType: "connection",
    subjectId: companyA.connectionId
  });
  const contextB = Object.freeze({
    companyId: companyB.companyId,
    provider: "instagram",
    credentialId: companyB.credentialId,
    credentialType: "refresh_token",
    subjectType: "connection",
    subjectId: companyB.connectionId
  });

  try {
    vaultV1 = createSocialVault({
      keyring: {
        activeVersion: versionV1,
        keys: new Map([
          [versionV1, keyV1],
          [versionV2, keyV2]
        ])
      },
      expectedKeyringFingerprint: vaultKeyringFingerprint(
        versionV1,
        readableVersions
      )
    });
    vaultV2 = createSocialVault({
      keyring: {
        activeVersion: versionV2,
        keys: new Map([
          [versionV1, keyV1],
          [versionV2, keyV2]
        ])
      },
      expectedKeyringFingerprint: vaultKeyringFingerprint(
        versionV2,
        readableVersions
      )
    });
    await keyRegistryAdmin.register({ keyVersion: versionV1 });
    await keyRegistryAdmin.register({ keyVersion: versionV2 });
    const credentialsV1 = createSocialCredentialService({
      repository,
      vault: vaultV1
    });
    const credentialsV2 = createSocialCredentialService({
      repository,
      vault: vaultV2
    });
    const rotationService = createVaultKeyRotationService({
      credentialService: credentialsV2,
      keyRegistryAdmin,
      vault: vaultV2,
      backoff: async () => undefined
    });

    const [storedA, storedB] = await Promise.all([
      credentialsV1.store({
        ...contextA,
        connectionId: contextA.subjectId,
        plaintext: plaintextA
      }),
      credentialsV1.store({
        ...contextB,
        connectionId: contextB.subjectId,
        plaintext: plaintextB
      })
    ]);
    assert.equal(storedA.keyVersion, versionV1);
    assert.equal(storedB.keyVersion, versionV1);
    assert.equal(
      await credentialsV1.withDecryptedCredential(
        {
          companyId: companyA.companyId,
          credentialId: companyA.credentialId
        },
        (value) => value.toString("utf8") === plaintextA
      ),
      true
    );
    assert.equal(
      await credentialsV2.withDecryptedCredential(
        {
          companyId: companyB.companyId,
          credentialId: companyB.credentialId
        },
        (value) => value.toString("utf8") === plaintextB
      ),
      true,
      "A chave anterior deve continuar legivel durante a janela."
    );

    const raw = await withTransaction(
      migrationPool,
      (client) =>
        client.query(
          [
            "SELECT company_id, id, provider, connection_id,",
            "  oauth_transaction_id, credential_type, ciphertext, nonce,",
            "  auth_tag, key_version, aad_version, revision",
            "FROM ia4tube_social.social_encrypted_credentials",
            "WHERE company_id = $1 AND id = $2"
          ].join("\n"),
          [companyA.companyId, companyA.credentialId]
        ),
      { role: OWNER_ROLE, companyId: companyA.companyId }
    );
    assert.equal(raw.rowCount, 1);
    const originalA = Object.freeze({
      ...raw.rows[0],
      revision: Number(raw.rows[0].revision)
    });
    assert.equal(originalA.company_id, companyA.companyId);
    assert.equal(originalA.id, companyA.credentialId);
    assert.equal(originalA.provider, "instagram");
    assert.equal(originalA.connection_id, companyA.connectionId);
    assert.equal(originalA.oauth_transaction_id, null);
    assert.equal(originalA.credential_type, "access_token");
    assert.ok(originalA.ciphertext.length > 0);
    assert.equal(originalA.nonce.length, 12);
    assert.equal(originalA.auth_tag.length, 16);
    assert.equal(originalA.key_version, versionV1);
    assert.equal(originalA.aad_version, 1);
    assert.equal(originalA.revision, 1);
    assert.equal(JSON.stringify(raw.rows).includes(plaintextA), false);
    assert.equal(JSON.stringify(raw.rows).includes(plaintextB), false);
    assert.equal(
      Buffer.concat([
        originalA.ciphertext,
        originalA.nonce,
        originalA.auth_tag
      ]).includes(Buffer.from(plaintextA, "utf8")),
      false
    );

    const rawRefresh = await withTransaction(
      migrationPool,
      (client) =>
        client.query(
          [
            "SELECT company_id, id, provider, connection_id,",
            "  oauth_transaction_id, credential_type, ciphertext, nonce,",
            "  auth_tag, key_version, aad_version, revision",
            "FROM ia4tube_social.social_encrypted_credentials",
            "WHERE company_id = $1 AND id = $2"
          ].join("\n"),
          [companyB.companyId, companyB.credentialId]
        ),
      { role: OWNER_ROLE, companyId: companyB.companyId }
    );
    assert.equal(rawRefresh.rowCount, 1);
    const originalB = Object.freeze({
      ...rawRefresh.rows[0],
      revision: Number(rawRefresh.rows[0].revision)
    });
    assert.equal(originalB.company_id, companyB.companyId);
    assert.equal(originalB.id, companyB.credentialId);
    assert.equal(originalB.provider, "instagram");
    assert.equal(originalB.connection_id, companyB.connectionId);
    assert.equal(originalB.oauth_transaction_id, null);
    assert.equal(originalB.credential_type, "refresh_token");
    assert.ok(originalB.ciphertext.length > 0);
    assert.equal(originalB.nonce.length, 12);
    assert.equal(originalB.auth_tag.length, 16);
    assert.equal(originalB.key_version, versionV1);
    assert.equal(originalB.aad_version, 1);
    assert.equal(originalB.revision, 1);
    assert.equal(JSON.stringify(rawRefresh.rows).includes(plaintextA), false);
    assert.equal(JSON.stringify(rawRefresh.rows).includes(plaintextB), false);
    assert.equal(
      Buffer.concat([
        originalB.ciphertext,
        originalB.nonce,
        originalB.auth_tag
      ]).includes(Buffer.from(plaintextB, "utf8")),
      false
    );

    const aadMutations = [
      { ...contextA, companyId: companyB.companyId },
      { ...contextA, provider: "facebook" },
      { ...contextA, subjectId: companyB.connectionId },
      { ...contextA, credentialType: "refresh_token" },
      { ...contextA, credentialId: companyB.credentialId }
    ];
    for (const mutatedContext of aadMutations) {
      assert.throws(
        () => vaultV2.decrypt(envelopeFromRow(originalA), mutatedContext),
        (error) => {
          redactedErrors.push(String(error?.message || ""));
          return error?.code === "vault_authentication_failed";
        }
      );
    }

    await assert.rejects(
      repository.storeEncryptedCredential({
        companyId: companyB.companyId,
        id: randomUuid(),
        provider: "instagram",
        connectionId: companyB.connectionId,
        credentialType: "nonce_collision_probe",
        ciphertext: originalA.ciphertext,
        nonce: originalA.nonce,
        authTag: originalA.auth_tag,
        keyVersion: originalA.key_version,
        aadVersion: originalA.aad_version
      }),
      (error) => {
        redactedErrors.push(String(error?.message || ""));
        return (
          error?.code === "23505" &&
          error?.constraint ===
            "social_encrypted_credentials_key_nonce_unique"
        );
      }
    );

    const tamperCases = [
      {
        column: "ciphertext",
        expression:
          "set_byte(ciphertext, 0, (get_byte(ciphertext, 0) + 1) % 256)",
        original: Buffer.from(originalA.ciphertext)
      },
      {
        column: "nonce",
        expression: "set_byte(nonce, 0, (get_byte(nonce, 0) + 1) % 256)",
        original: Buffer.from(originalA.nonce)
      },
      {
        column: "auth_tag",
        expression:
          "set_byte(auth_tag, 0, (get_byte(auth_tag, 0) + 1) % 256)",
        original: Buffer.from(originalA.auth_tag)
      }
    ];
    for (const tamper of tamperCases) {
      await withTransaction(
        runtimePool,
        (client) =>
          client.query(
            [
              "UPDATE ia4tube_social.social_encrypted_credentials",
              `SET ${tamper.column} = ${tamper.expression}`,
              "WHERE company_id = $1 AND id = $2"
            ].join("\n"),
            [companyA.companyId, companyA.credentialId]
          ),
        { role: RUNTIME_ROLE, companyId: companyA.companyId }
      );
      try {
        await assert.rejects(
          credentialsV1.withDecryptedCredential(
            {
              companyId: companyA.companyId,
              credentialId: companyA.credentialId
            },
            () => true
          ),
          (error) => {
            redactedErrors.push(String(error?.message || ""));
            return error?.code === "vault_authentication_failed";
          }
        );
      } finally {
        await withTransaction(
          runtimePool,
          (client) =>
            client.query(
              [
                "UPDATE ia4tube_social.social_encrypted_credentials",
                `SET ${tamper.column} = $3`,
                "WHERE company_id = $1 AND id = $2"
              ].join("\n"),
              [
                companyA.companyId,
                companyA.credentialId,
                tamper.original
              ]
            ),
          { role: RUNTIME_ROLE, companyId: companyA.companyId }
        );
      }
      assert.equal(
        await credentialsV1.withDecryptedCredential(
          {
            companyId: companyA.companyId,
            credentialId: companyA.credentialId
          },
          (value) => value.toString("utf8") === plaintextA
        ),
        true
      );
    }

    const initialAuthority = await keyRegistryAdmin.withActiveVersion(
      { keyVersion: versionV1 },
      async (authority) => authority
    );
    assert.equal(
      initialAuthority.authority.activeKeyVersion,
      versionV1
    );
    assert.equal(initialAuthority.authority.generation, 1);

    const rotationBatch = await rotationService.rotateTenant({
      companyId: companyA.companyId,
      credentialIds: [companyA.credentialId],
      keyVersion: versionV2,
      expectedActiveKeyVersion: versionV1
    });
    assert.equal(rotationBatch.generation, 2);
    assert.equal(rotationBatch.credentials, 1);
    assert.equal(rotationBatch.changed, 1);
    const rotation = rotationBatch.results[0];
    assert.equal(rotation.changed, true);
    assert.equal(rotation.keyVersion, versionV2);
    assert.equal(rotation.revision, originalA.revision + 1);
    const currentAuthority = await keyRegistryAdmin.currentAuthority();
    assert.equal(currentAuthority.activeKeyVersion, versionV2);
    assert.equal(currentAuthority.generation, 2);
    assert.ok(currentAuthority.activatedAt);
    let rotatedA = await repository.findEncryptedCredential({
      companyId: companyA.companyId,
      credentialId: companyA.credentialId
    });
    assert.equal(rotatedA.key_version, versionV2);
    assert.equal(Number(rotatedA.revision), originalA.revision + 1);
    assert.equal(rotatedA.nonce.equals(originalA.nonce), false);
    assert.equal(rotatedA.ciphertext.equals(originalA.ciphertext), false);
    assert.equal(rotatedA.auth_tag.equals(originalA.auth_tag), false);
    assert.equal(
      await credentialsV2.withDecryptedCredential(
        {
          companyId: companyA.companyId,
          credentialId: companyA.credentialId
        },
        (value) => value.toString("utf8") === plaintextA
      ),
      true
    );

    const candidates = [
      vaultV2.encrypt(plaintextA, contextA),
      vaultV2.encrypt(plaintextA, contextA)
    ];
    const concurrentRotations = await Promise.allSettled(
      candidates.map((candidate) =>
        repository.rotateEncryptedCredential({
          companyId: companyA.companyId,
          credentialId: companyA.credentialId,
          ciphertext: candidate.ciphertext,
          nonce: candidate.nonce,
          authTag: candidate.authTag,
          keyVersion: candidate.keyVersion,
          expectedRevision: rotatedA.revision
        })
      )
    );
    const successfulRotations = concurrentRotations.filter(
      (result) => result.status === "fulfilled"
    );
    const rejectedRotations = concurrentRotations.filter(
      (result) => result.status === "rejected"
    );
    assert.equal(successfulRotations.length, 1);
    assert.equal(rejectedRotations.length, 1);
    assert.equal(
      rejectedRotations[0].reason?.code,
      "credential_rotation_conflict"
    );
    redactedErrors.push(
      String(rejectedRotations[0].reason?.message || "")
    );
    rotatedA = await repository.findEncryptedCredential({
      companyId: companyA.companyId,
      credentialId: companyA.credentialId
    });
    assert.equal(Number(rotatedA.revision), rotation.revision + 1);
    assert.equal(
      candidates.some((candidate) => candidate.nonce.equals(rotatedA.nonce)),
      true
    );
    assert.equal(
      await credentialsV2.withDecryptedCredential(
        {
          companyId: companyA.companyId,
          credentialId: companyA.credentialId
        },
        (value) => value.toString("utf8") === plaintextA
      ),
      true
    );

    assert.deepEqual(
      await credentialsV2.tenantKeyInventory({
        companyId: companyA.companyId
      }),
      [{ keyVersion: versionV2, credentialCount: 1 }]
    );
    await assert.rejects(
      rotationService.retire({ keyVersion: versionV1 }),
      { code: "vault_key_version_in_use" }
    );

    const oldB = await repository.findEncryptedCredential({
      companyId: companyB.companyId,
      credentialId: companyB.credentialId
    });
    assert.equal(oldB.key_version, versionV1);
    const oldBEnvelope = Object.freeze({
      ciphertext: Buffer.from(oldB.ciphertext),
      nonce: Buffer.from(oldB.nonce),
      authTag: Buffer.from(oldB.auth_tag),
      keyVersion: oldB.key_version,
      aadVersion: oldB.aad_version
    });
    const rotationBatchB = await rotationService.rotateTenant({
      companyId: companyB.companyId,
      credentialIds: [companyB.credentialId],
      keyVersion: versionV2,
      expectedActiveKeyVersion: versionV1
    });
    assert.equal(rotationBatchB.generation, 2);
    assert.equal(rotationBatchB.credentials, 1);
    assert.equal(rotationBatchB.changed, 1);
    const rotationB = rotationBatchB.results[0];
    assert.equal(rotationB.changed, true);
    assert.equal(rotationB.keyVersion, versionV2);
    assert.equal(rotationB.revision, Number(oldB.revision) + 1);
    const currentB = await repository.findEncryptedCredential({
      companyId: companyB.companyId,
      credentialId: companyB.credentialId
    });
    assert.equal(currentB.nonce.equals(oldB.nonce), false);
    assert.equal(
      await credentialsV2.withDecryptedCredential(
        {
          companyId: companyB.companyId,
          credentialId: companyB.credentialId
        },
        (value) => value.toString("utf8") === plaintextB
      ),
      true
    );
    assert.deepEqual(
      await credentialsV2.tenantKeyInventory({
        companyId: companyB.companyId
      }),
      [{ keyVersion: versionV2, credentialCount: 1 }]
    );

    const v1Usage = await Promise.all(
      [companyA.companyId, companyB.companyId].map((companyId) =>
        withTransaction(
          migrationPool,
          (client) =>
            client.query(
              [
                "SELECT COUNT(*)::integer AS usage_count",
                "FROM ia4tube_social.social_encrypted_credentials",
                "WHERE key_version = $1"
              ].join("\n"),
              [versionV1]
            ),
          { role: OWNER_ROLE, companyId }
        )
      )
    );
    assert.equal(
      v1Usage.reduce(
        (total, result) => total + result.rows[0].usage_count,
        0
      ),
      0
    );
    assert.deepEqual(
      await rotationService.retire({ keyVersion: versionV1 }),
      { keyVersion: versionV1, retired: true }
    );

    v2OnlyVault = createSocialVault({
      keyring: {
        activeVersion: versionV2,
        keys: new Map([[versionV2, keyV2]])
      },
      expectedKeyringFingerprint: vaultKeyringFingerprint(
        versionV2,
        [versionV2]
      )
    });
    assert.throws(
      () => v2OnlyVault.decrypt(oldBEnvelope, contextB),
      { code: "vault_key_version_unavailable" }
    );
    const currentBPlaintext = v2OnlyVault.decrypt(
      envelopeFromRow(currentB),
      contextB
    );
    try {
      assert.equal(currentBPlaintext.toString("utf8"), plaintextB);
    } finally {
      currentBPlaintext.fill(0);
    }

    const unusedKeyMaterial = crypto.randomBytes(32);
    const unusedKeyVersion = deriveVaultKeyVersion(
      99,
      unusedKeyMaterial
    );
    unusedKeyMaterial.fill(0);
    assert.deepEqual(
      await keyRegistryAdmin.register({ keyVersion: unusedKeyVersion }),
      { keyVersion: unusedKeyVersion, registered: true }
    );
    assert.deepEqual(
      await keyRegistryAdmin.retire({ keyVersion: unusedKeyVersion }),
      { keyVersion: unusedKeyVersion, retired: true }
    );

    return Object.freeze([plaintextA, plaintextB]);
  } finally {
    vaultV1?.destroy();
    vaultV2?.destroy();
    v2OnlyVault?.destroy();
    keyV1.fill(0);
    keyV2.fill(0);
  }
}

function sessionFor(fixture, overrides = {}) {
  return {
    tokenVersion: 2,
    issuer: "ia4tube-api",
    audience: "ia4tube-client",
    subject: `synthetic-${fixture.label}`,
    companyId: fixture.companyId,
    userId: fixture.userId,
    jti: `synthetic-session-${fixture.label}-0001`,
    ...overrides
  };
}

async function proveReauthentication(
  migrationPool,
  repository,
  companyA,
  companyB,
  password,
  redactedErrors
) {
  const service = createSocialReauthService({ repository });
  const target = {
    action: "social.disconnect",
    provider: "instagram",
    targetConnectionId: companyA.connectionId
  };
  const session = sessionFor(companyA);
  const grant = await service.issue({ session, password, ...target });

  const persisted = await withTransaction(
    migrationPool,
    (client) =>
      client.query(
        [
          "SELECT token_digest, session_jti_digest",
          "FROM ia4tube_social.social_reauth_grants",
          "WHERE company_id = $1 AND token_digest = $2"
        ].join("\n"),
        [companyA.companyId, digest(grant.token)]
      ),
    { role: OWNER_ROLE, companyId: companyA.companyId }
  );
  assert.equal(persisted.rowCount, 1);
  assert.equal(
    JSON.stringify(persisted.rows).includes(grant.token),
    false
  );

  for (const attempt of [
    {
      session: sessionFor(companyB),
      token: grant.token,
      ...target
    },
    {
      session: sessionFor(companyA, {
        jti: "synthetic-session-A-different"
      }),
      token: grant.token,
      ...target
    },
    {
      session,
      token: grant.token,
      ...target,
      action: "social.revoke"
    }
  ]) {
    await assert.rejects(
      service.consume(attempt),
      (error) => {
        redactedErrors.push(String(error?.message || ""));
        return error?.code === "reauth_grant_invalid";
      }
    );
  }

  assert.equal(
    (await service.consume({ session, token: grant.token, ...target }))
      .authorized,
    true
  );
  await assert.rejects(
    service.consume({ session, token: grant.token, ...target }),
    (error) => {
      redactedErrors.push(String(error?.message || ""));
      return error?.code === "reauth_grant_invalid";
    }
  );

  const expiringToken = crypto.randomBytes(32).toString("base64url");
  const databaseClock = await migrationPool.query(
    "SELECT CURRENT_TIMESTAMP AS now"
  );
  const databaseNow = new Date(databaseClock.rows[0].now);
  await repository.createReauthGrant({
    companyId: companyA.companyId,
    id: randomUuid(),
    userId: companyA.userId,
    tokenDigest: digest(expiringToken),
    sessionJtiDigest: digest(session.jti),
    action: "social.connect",
    provider: "instagram",
    targetConnectionId: null,
    authVersion: 1,
    expiresAt: new Date(databaseNow.getTime() + 3000)
  });
  await delay(4500);
  await assert.rejects(
    service.consume({
      session,
      token: expiringToken,
      action: "social.connect",
      provider: "instagram",
      targetConnectionId: null
    }),
    { code: "reauth_grant_invalid" }
  );

  await assert.rejects(
    service.consume({
      session: sessionFor(companyA, { tokenVersion: 1 }),
      token: grant.token,
      ...target
    }),
    { code: "reauth_session_invalid" }
  );
  return Object.freeze({ grantToken: grant.token, expiringToken });
}

const RLS_TABLES = Object.freeze([
  { table: "companies", tenantColumn: "id", selectColumn: "id" },
  { table: "users", tenantColumn: "company_id", selectColumn: "id" },
  {
    table: "company_memberships",
    tenantColumn: "company_id",
    selectColumn: "user_id"
  },
  {
    table: "legacy_entity_mappings",
    tenantColumn: "company_id",
    selectColumn: "id",
    runtimeSelect: false
  },
  {
    table: "social_connections",
    tenantColumn: "company_id",
    selectColumn: "id"
  },
  {
    table: "social_external_accounts",
    tenantColumn: "company_id",
    selectColumn: "id"
  },
  {
    table: "social_destinations",
    tenantColumn: "company_id",
    selectColumn: "id"
  },
  {
    table: "social_connection_scopes",
    tenantColumn: "company_id",
    selectColumn: "scope"
  },
  {
    table: "social_oauth_transactions",
    tenantColumn: "company_id",
    selectColumn: "id"
  },
  {
    table: "social_encrypted_credentials",
    tenantColumn: "company_id",
    selectColumn: "id"
  },
  {
    table: "social_reauth_grants",
    tenantColumn: "company_id",
    selectColumn: "id"
  },
  {
    table: "social_idempotency_operations",
    tenantColumn: "company_id",
    selectColumn: "operation_id"
  },
  {
    table: "social_publications",
    tenantColumn: "company_id",
    selectColumn: "id"
  },
  {
    table: "social_publication_attempts",
    tenantColumn: "company_id",
    selectColumn: "publication_id"
  },
  {
    table: "social_audit_events",
    tenantColumn: "company_id",
    selectColumn: "id"
  }
]);

async function proveAllRlsPolicies(
  provisionerPool,
  migrationPool,
  runtimePool,
  companyA,
  companyB
) {
  const catalog = await provisionerPool.query(
    [
      "SELECT table_class.relname, table_class.relrowsecurity,",
      "  table_class.relforcerowsecurity,",
      "  (SELECT COUNT(*)::integer",
      "   FROM pg_catalog.pg_policy policy",
      "   WHERE policy.polrelid = table_class.oid) AS policy_count,",
      "  COALESCE((",
      "    SELECT BOOL_AND(",
      "      policy.polcmd = '*'",
      "      AND policy.polpermissive",
      "      AND policy.polroles = ARRAY[0]::oid[]",
      "      AND policy.polqual IS NOT NULL",
      "      AND policy.polwithcheck IS NOT NULL",
      "    )",
      "    FROM pg_catalog.pg_policy policy",
      "    WHERE policy.polrelid = table_class.oid",
      "  ), FALSE) AS policy_complete",
      "FROM pg_catalog.pg_class table_class",
      "JOIN pg_catalog.pg_namespace namespace",
      "  ON namespace.oid = table_class.relnamespace",
      "WHERE namespace.nspname = 'ia4tube_social'",
      "  AND table_class.relkind = 'r'",
      "ORDER BY table_class.relname"
    ].join("\n")
  );
  const flags = new Map(
    catalog.rows.map((row) => [row.relname, row])
  );
  assert.deepEqual(
    [...flags.keys()].sort(),
    RLS_TABLES.map((definition) => definition.table).sort(),
    "Toda tabela fisica do schema social deve ter uma prova RLS explicita."
  );
  for (const definition of RLS_TABLES) {
    const row = flags.get(definition.table);
    assert.ok(row, `${definition.table} deve existir.`);
    assert.equal(row.relrowsecurity, true);
    assert.equal(row.relforcerowsecurity, true);
    assert.equal(row.policy_count, 1);
    assert.equal(row.policy_complete, true);

    for (const [pool, role] of [
      [runtimePool, RUNTIME_ROLE],
      [migrationPool, OWNER_ROLE]
    ]) {
      const active = await withTransaction(
        pool,
        (client) =>
          client.query(
            "SELECT row_security_active($1::regclass) AS active",
            [`ia4tube_social.${definition.table}`]
          ),
        { role, companyId: companyA.companyId }
      );
      assert.equal(
        active.rows[0].active,
        true,
        `row_security_active deve ser verdadeiro em ${definition.table}.`
      );
    }

    const query = [
      `SELECT ${definition.selectColumn}`,
      `FROM ia4tube_social.${definition.table}`,
      `WHERE ${definition.tenantColumn} = $1`
    ].join("\n");
    if (definition.runtimeSelect === false) {
      await assert.rejects(
        withTransaction(
          runtimePool,
          (client) => client.query(query, [companyA.companyId]),
          { role: RUNTIME_ROLE, companyId: companyA.companyId }
        ),
        (error) => error?.code === "42501"
      );
      continue;
    }

    const own = await withTransaction(
      runtimePool,
      (client) => client.query(query, [companyA.companyId]),
      { role: RUNTIME_ROLE, companyId: companyA.companyId }
    );
    assert.ok(own.rowCount > 0, `${definition.table} deve conter fixture A.`);

    const crossTenant = await withTransaction(
      runtimePool,
      (client) => client.query(query, [companyA.companyId]),
      { role: RUNTIME_ROLE, companyId: companyB.companyId }
    );
    assert.equal(crossTenant.rowCount, 0);

    const noContext = await withTransaction(
      runtimePool,
      (client) => client.query(query, [companyA.companyId]),
      { role: RUNTIME_ROLE }
    );
    assert.equal(noContext.rowCount, 0);
  }
}

test(
  "real PostgreSQL proves migrations, physical RLS, vault and reauthentication",
  { skip: skipReason, timeout: 900000 },
  async () => {
    const physicalPhases = createPhysicalPhaseEmitter();
    const configuration = loadRealTestConfiguration();
    const pools = [];
    const redactedErrors = [];
    const membershipState = {
      migrator: false,
      runtime: false,
      migratorConnect: false,
      runtimeConnect: false
    };
    const provisionerPool = createPool(
      configuration.provisionerUrl,
      "ia4tube-social-real-provisioner",
      2,
      configuration
    );
    pools.push(provisionerPool);

    try {
      physicalPhases.startMain("physical_target_preflight");
      await preflightPhysicalTarget(provisionerPool, configuration);
      physicalPhases.completeMain("physical_target_preflight");

      const migrationPoolA = createPool(
        configuration.migrationUrl,
        "ia4tube-social-real-migration-a",
        1,
        configuration
      );
      const migrationPoolB = createPool(
        configuration.migrationUrl,
        "ia4tube-social-real-migration-b",
        1,
        configuration
      );
      const runtimePool = createPool(
        configuration.runtimeUrl,
        "ia4tube-social-real-runtime",
        3,
        configuration
      );
      const contextPool = createPool(
        configuration.runtimeUrl,
        "ia4tube-social-real-context-cleanup",
        1,
        configuration
      );
      pools.push(migrationPoolA, migrationPoolB, runtimePool, contextPool);

      physicalPhases.startMain("role_provisioning");
      await provisionRolesAndMarker(
        provisionerPool,
        configuration,
        membershipState
      );
      physicalPhases.completeMain("role_provisioning");
      physicalPhases.startMain("direct_connect_boundary");
      await proveDirectConnectIsRequired(
        provisionerPool,
        configuration
      );
      physicalPhases.completeMain("direct_connect_boundary");
      physicalPhases.startMain("startup_unmigrated");
      await proveStartupBoundary(
        provisionerPool,
        configuration,
        false
      );
      physicalPhases.completeMain("startup_unmigrated");

      physicalPhases.startMain("migration_0001_0002");
      const manifest = readManifest();
      const prefixManifest = temporaryMigrationManifest(
        manifest.slice(0, 2),
        "0001-0002-prefix"
      );
      try {
        const prefixRunnerA = migrationRunner(
          migrationPoolA,
          configuration,
          prefixManifest.options
        );
        const prefixRunnerB = migrationRunner(
          migrationPoolB,
          configuration,
          prefixManifest.options
        );
        await proveMigrationConcurrency(
          prefixRunnerA,
          prefixRunnerB,
          configuration,
          manifest.slice(0, 2).map((migration) => migration.version)
        );
      } finally {
        fs.rmSync(prefixManifest.directory, {
          recursive: true,
          force: true
        });
      }
      physicalPhases.completeMain("migration_0001_0002");

      physicalPhases.startMain("pre_registry_seed");
      const companyC = tenantFixture("Backfill-C");
      const companyD = tenantFixture("Backfill-D");
      const backfillPasswordHash = await bcrypt.hash(
        `Synthetic-Backfill-Password-${randomUuid()}`,
        8
      );
      await seedCoreTenant(migrationPoolA, companyC, backfillPasswordHash);
      await seedCoreTenant(migrationPoolA, companyD, backfillPasswordHash);
      await seedPreRegistryCredential(
        runtimePool,
        companyC,
        BACKFILL_VERSION_V1
      );
      await seedPreRegistryCredential(
        runtimePool,
        companyD,
        BACKFILL_VERSION_V1
      );
      const backfillSnapshots = new Map([
        [
          companyC.companyId,
          await readPreRegistryCredentialSnapshot(runtimePool, companyC)
        ],
        [
          companyD.companyId,
          await readPreRegistryCredentialSnapshot(runtimePool, companyD)
        ]
      ]);
      await provePreRegistryIsolation(
        migrationPoolA,
        runtimePool,
        companyC,
        companyD
      );
      physicalPhases.completeMain("pre_registry_seed");
      physicalPhases.startMain("migration_0003_rollback");
      await provePopulated0003Rollback(
        migrationPoolA,
        runtimePool,
        configuration,
        companyC,
        companyD,
        backfillSnapshots
      );
      physicalPhases.completeMain("migration_0003_rollback");

      physicalPhases.startMain("migration_0003_apply");
      const registryMigrationIndex = manifest.findIndex(
        (migration) => migration.version === GLOBAL_VAULT_REGISTRY_MIGRATION
      );
      assert.ok(registryMigrationIndex >= 0);
      const registryManifest = temporaryMigrationManifest(
        manifest.slice(0, registryMigrationIndex + 1),
        "0001-0003-prefix"
      );
      try {
        const registryRunnerA = migrationRunner(
          migrationPoolA,
          configuration,
          registryManifest.options
        );
        const registryRunnerB = migrationRunner(
          migrationPoolB,
          configuration,
          registryManifest.options
        );
        await proveMigrationConcurrency(
          registryRunnerA,
          registryRunnerB,
          configuration,
          [GLOBAL_VAULT_REGISTRY_MIGRATION]
        );
        await provePopulated0003Success(
          migrationPoolA,
          runtimePool,
          registryRunnerA,
          configuration,
          companyC,
          companyD,
          backfillSnapshots
        );
      } finally {
        fs.rmSync(registryManifest.directory, {
          recursive: true,
          force: true
        });
      }
      physicalPhases.completeMain("migration_0003_apply");

      physicalPhases.startMain("exact_0004_plan_apply");
      let runnerA;
      let runnerB;
      if (configuration.mode === LOOPBACK_MODE) {
        ({ runnerA, runnerB } = await proveExact0004Route(
          migrationPoolA,
          migrationPoolB,
          configuration,
          companyC,
          physicalPhases
        ));
      } else {
        runnerA = migrationRunner(migrationPoolA, configuration);
        runnerB = migrationRunner(migrationPoolB, configuration);
        await proveMigrationConcurrency(
          runnerA,
          runnerB,
          configuration,
          manifest
            .slice(registryMigrationIndex + 1)
            .map((migration) => migration.version)
        );
      }
      physicalPhases.completeMain("exact_0004_plan_apply");
      physicalPhases.startMain("post_migration_validation");
      await proveAdvisoryLock(
        migrationPoolA,
        runnerB,
        configuration,
        "ia4tube-social-real-migration-b"
      );
      await proveChecksums(migrationPoolA, runnerA);
      const migrationPoolBIndex = pools.indexOf(migrationPoolB);
      assert.ok(migrationPoolBIndex >= 0);
      await migrationPoolB.end();
      pools.splice(migrationPoolBIndex, 1);
      physicalPhases.completeMain("post_migration_validation");
      physicalPhases.startMain("migration_cli");
      await proveMigrationCli(configuration);
      await proveProvisionerEffectiveAccess(provisionerPool);
      await proveTargetRefusals(
        migrationPoolA,
        configuration,
        runnerA
      );
      await proveMigrationRollback(
        migrationPoolA,
        configuration
      );
      physicalPhases.completeMain("migration_cli");

      physicalPhases.startMain("runtime_role_schema");
      await verifyRuntimeRole(runtimePool, RUNTIME_ROLE);
      await verifyRuntimeSchema(runtimePool, RUNTIME_ROLE);
      await proveStartupBoundary(
        provisionerPool,
        configuration,
        true
      );
      physicalPhases.completeMain("runtime_role_schema");
      physicalPhases.startMain("runtime_permission_negatives");
      await assert.rejects(
        verifyRuntimeRole(migrationPoolA, RUNTIME_ROLE),
        (error) =>
          error?.code === "42501" ||
          error?.code === "postgres_runtime_role_unsafe"
      );
      for (const forbiddenRole of [OWNER_ROLE, MIGRATOR_ROLE]) {
        await assert.rejects(
          withTransaction(
            runtimePool,
            (client) =>
              client.query(
                `SET LOCAL ROLE ${quoteIdentifier(forbiddenRole)}`
              )
          ),
          (error) => error?.code === "42501"
        );
      }
      await assert.rejects(
        withTransaction(
          runtimePool,
          (client) =>
            client.query(
              "CREATE TABLE ia4tube_social.synthetic_forbidden (id UUID)"
            ),
          { role: RUNTIME_ROLE }
        ),
        (error) => error?.code === "42501"
      );
      await assert.rejects(
        withTransaction(
          runtimePool,
          (client) =>
            client.query(
              "TRUNCATE ia4tube_social.social_connections"
            ),
          { role: RUNTIME_ROLE }
        ),
        (error) => error?.code === "42501"
      );
      await assert.rejects(
        withTransaction(
          runtimePool,
          (client) =>
            client.query(
              "SELECT key_version FROM " +
                "ia4tube_social_admin.vault_key_versions"
            ),
          { role: RUNTIME_ROLE }
        ),
        (error) => error?.code === "42501"
      );
      physicalPhases.completeMain("runtime_permission_negatives");

      physicalPhases.startMain("tenant_rls");
      const companyA = tenantFixture("A");
      const companyB = tenantFixture("B");
      const syntheticPassword = `Synthetic-Password-${randomUuid()}`;
      const passwordHash = await bcrypt.hash(syntheticPassword, 8);
      await seedCoreTenant(migrationPoolA, companyA, passwordHash);
      await seedCoreTenant(migrationPoolA, companyB, passwordHash);
      await provePoolContextCleanup(contextPool, companyA);
      const repository = createSocialRepository({
        pool: runtimePool,
        runtimeRole: RUNTIME_ROLE,
        identityDerivationVersion: IDENTITY_VERSION
      });
      const keyRegistryAdmin = createVaultKeyRegistryAdmin({
        pool: migrationPoolA,
        ownerRole: OWNER_ROLE
      });
      await seedSocialTenant(runtimePool, repository, companyA);
      await seedSocialTenant(runtimePool, repository, companyB);
      await seedSecondaryCredentialAndGrant(repository, companyB);
      await proveTransactionRollback(runtimePool, companyA);
      await proveOwnerForceRls(migrationPoolA, companyA, companyB);
      await proveMalformedTenantContext(runtimePool, companyA);
      await proveConcurrentTenantTransactions(
        runtimePool,
        companyA,
        companyB
      );
      await proveRlsMutations(runtimePool, companyA, companyB);
      physicalPhases.completeMain("tenant_rls");

      physicalPhases.startMain("vault_persistence");
      const credentialPlaintexts = await proveVaultPersistence(
        migrationPoolA,
        runtimePool,
        repository,
        keyRegistryAdmin,
        companyA,
        companyB,
        redactedErrors
      );
      physicalPhases.completeMain("vault_persistence");
      physicalPhases.startMain("reauthentication");
      const reauthSecrets = await proveReauthentication(
        migrationPoolA,
        repository,
        companyA,
        companyB,
        syntheticPassword,
        redactedErrors
      );
      await proveAllRlsPolicies(
        provisionerPool,
        migrationPoolA,
        runtimePool,
        companyA,
        companyB
      );

      for (const errorText of redactedErrors) {
        for (const plaintext of credentialPlaintexts) {
          assert.equal(errorText.includes(plaintext), false);
        }
        assert.equal(errorText.includes(syntheticPassword), false);
        assert.equal(errorText.includes(reauthSecrets.grantToken), false);
        assert.equal(errorText.includes(reauthSecrets.expiringToken), false);
      }
      physicalPhases.completeMain("reauthentication");
    } finally {
      physicalPhases.startCleanup();
      const createdState = { ...membershipState };
      const membershipCleanup = await Promise.allSettled([
        revokeTestRoleMemberships(
          provisionerPool,
          configuration,
          membershipState
        )
      ]);
      const closed = await Promise.allSettled(
        pools.map((pool) => pool.end())
      );
      const finalCleanup = await Promise.allSettled([
        proveFinalCleanup(configuration, createdState)
      ]);
      assert.equal(
        membershipCleanup.every(
          (result) => result.status === "fulfilled"
        ),
        true,
        "As memberships PostgreSQL sinteticas devem ser revogadas."
      );
      assert.equal(
        closed.every((result) => result.status === "fulfilled"),
        true,
        "Todos os pools PostgreSQL devem encerrar corretamente."
      );
      assert.equal(
        finalCleanup.every((result) => result.status === "fulfilled"),
        true,
        "Sessoes, locks e privilegios temporarios devem ser limpos."
      );
      physicalPhases.completeCleanup();
    }
  }
);
