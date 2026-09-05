"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const {
  assertNoAmbientPostgresEnvironment
} = require("./config");
const { SocialPostgresError, postgresFail } = require("./errors");
const { loadSystemPostgresTls } = require("./tls");
const { requireUuid } = require("./validation");

const STAGING_PROVISION_APPROVAL_PREFIX =
  "PROVISION_SOCIAL_POSTGRES_STAGING:";
const STAGING_DATABASE_PATTERN =
  /^ia4tube_social_staging(?:_[a-z0-9]+)*$/;
const PAID_STAGING_PUBLIC_TARGET = Object.freeze({
  environmentId: "f9001d31-5cb4-471b-87de-96ef7dc7bd4e",
  host: "dpg-d9l8u27qj5pc738k3rvg-a.oregon-postgres.render.com",
  port: "5432",
  database: "ia4tube_social_staging",
  provisionerLogin: "ia4tube_social_staging_user",
  migrationLogin: "ia4tube_social_staging_migration",
  runtimeLogin: "ia4tube_social_staging_runtime"
});
const LOGIN_PATTERN = /^[a-z][a-z0-9_]{2,62}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const STAGING_ROLES_SQL_SHA256 =
  "904952385bcffb8fa808ae00d73ca1a018e05b46ad7b3562b927d34ccdedd311";

function fail(code) {
  postgresFail(code, "Provisionamento PostgreSQL staging recusado.");
}

function requireText(value, code) {
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.trim()
  ) {
    fail(code);
  }
  return value;
}

function decodeUrlPart(value, code) {
  try {
    return decodeURIComponent(value);
  } catch {
    fail(code);
  }
}

function equalFingerprint(actual, expected) {
  if (
    !SHA256_PATTERN.test(String(actual || "")) ||
    !SHA256_PATTERN.test(String(expected || ""))
  ) {
    return false;
  }
  return crypto.timingSafeEqual(
    Buffer.from(actual, "hex"),
    Buffer.from(expected, "hex")
  );
}

function stagingProvisionTargetFingerprint(target) {
  return crypto
    .createHash("sha256")
    .update(
      [
        "ia4tube-social-staging-provision-v1",
        String(target.environmentId || "").toLowerCase(),
        String(target.host || "").toLowerCase(),
        String(target.port || "5432"),
        String(target.database || ""),
        String(target.provisionerLogin || "").toLowerCase(),
        "staging",
        "tls-verify-full"
      ].join("/")
    )
    .digest("hex");
}

function hiddenConnection(properties, connectionString) {
  const result = { ...properties };
  Object.defineProperty(result, "connectionString", {
    value: connectionString,
    enumerable: false,
    writable: false,
    configurable: false
  });
  return Object.freeze(result);
}

function loadStagingProvisionConfig(env = process.env) {
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    fail("staging_provision_tls_disabled");
  }
  assertNoAmbientPostgresEnvironment(
    env,
    "staging_provision_postgres_environment_override_forbidden"
  );

  const environmentId = requireUuid(
    env.SOCIAL_STAGING_PROVISION_EXPECTED_ENVIRONMENT_ID,
    "staging_provision_expected_environment_id"
  ).toLowerCase();
  const approval = requireText(
    env.SOCIAL_STAGING_PROVISION_APPROVED,
    "staging_provision_approval_missing"
  );
  if (
    environmentId !== PAID_STAGING_PUBLIC_TARGET.environmentId ||
    approval !== `${STAGING_PROVISION_APPROVAL_PREFIX}${environmentId}`
  ) {
    fail("staging_provision_approval_invalid");
  }

  const rawUrl = requireText(
    env.SOCIAL_STAGING_PROVISIONER_DATABASE_URL,
    "staging_provision_database_url_missing"
  );
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    fail("staging_provision_database_url_invalid");
  }
  const queryKeys = [...new Set(parsed.searchParams.keys())];
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !parsed.hostname ||
    !parsed.username ||
    !parsed.password ||
    !parsed.pathname ||
    parsed.pathname === "/" ||
    parsed.hash ||
    net.isIP(parsed.hostname) !== 0 ||
    !parsed.hostname.toLowerCase().endsWith(".render.com") ||
    queryKeys.length !== 1 ||
    queryKeys[0] !== "sslmode" ||
    parsed.searchParams.getAll("sslmode").length !== 1 ||
    parsed.searchParams.get("sslmode").toLowerCase() !== "verify-full"
  ) {
    fail("staging_provision_database_url_invalid");
  }

  const host = parsed.hostname.toLowerCase();
  const port = parsed.port || "5432";
  const database = decodeUrlPart(
    parsed.pathname.slice(1),
    "staging_provision_database_invalid"
  );
  const provisionerLogin = decodeUrlPart(
    parsed.username,
    "staging_provision_login_invalid"
  ).toLowerCase();
  if (
    !STAGING_DATABASE_PATTERN.test(database) ||
    !LOGIN_PATTERN.test(provisionerLogin) ||
    /(^|_)(?:prod|production|live|main)(_|$)/i.test(
      `${database}_${provisionerLogin}`
    )
  ) {
    fail("staging_provision_target_not_staging");
  }

  const expected = Object.freeze({
    host: requireText(
      env.SOCIAL_STAGING_PROVISION_EXPECTED_HOST,
      "staging_provision_expected_host_missing"
    ).toLowerCase(),
    port: requireText(
      env.SOCIAL_STAGING_PROVISION_EXPECTED_PORT,
      "staging_provision_expected_port_missing"
    ),
    database: requireText(
      env.SOCIAL_STAGING_PROVISION_EXPECTED_DATABASE,
      "staging_provision_expected_database_missing"
    ),
    provisionerLogin: requireText(
      env.SOCIAL_STAGING_PROVISION_EXPECTED_PROVISIONER_LOGIN,
      "staging_provision_expected_login_missing"
    ).toLowerCase()
  });
  if (
    expected.host !== host ||
    expected.port !== port ||
    expected.database !== database ||
    expected.provisionerLogin !== provisionerLogin ||
    host !== PAID_STAGING_PUBLIC_TARGET.host ||
    port !== PAID_STAGING_PUBLIC_TARGET.port ||
    database !== PAID_STAGING_PUBLIC_TARGET.database ||
    provisionerLogin !== PAID_STAGING_PUBLIC_TARGET.provisionerLogin
  ) {
    fail("staging_provision_target_mismatch");
  }

  const target = Object.freeze({
    environmentId,
    host,
    port,
    database,
    provisionerLogin
  });
  const fingerprint = stagingProvisionTargetFingerprint(target);
  const expectedFingerprint = requireText(
    env.SOCIAL_STAGING_PROVISION_EXPECTED_TARGET_FINGERPRINT,
    "staging_provision_target_fingerprint_missing"
  ).toLowerCase();
  if (!equalFingerprint(fingerprint, expectedFingerprint)) {
    fail("staging_provision_target_fingerprint_mismatch");
  }

  for (const key of [...parsed.searchParams.keys()]) {
    parsed.searchParams.delete(key);
  }
  return Object.freeze({
    target,
    targetFingerprint: fingerprint,
    pool: hiddenConnection(
      {
        ssl: loadSystemPostgresTls(env, host),
        max: 1,
        min: 0,
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 5000,
        query_timeout: 30000,
        application_name: "ia4tube-social-staging-provisioner",
        options: [
          "-c statement_timeout=25000",
          "-c lock_timeout=5000",
          "-c idle_in_transaction_session_timeout=5000",
          "-c search_path=pg_catalog"
        ].join(" "),
        allowExitOnIdle: false
      },
      parsed.toString()
    )
  });
}

function canonicalRolesSqlBody(options = {}) {
  const root = path.resolve(
    options.root || path.join(__dirname, "..", "..", "..")
  );
  const file = path.join(root, "db", "postgres", "roles.sql");
  const bytes = fs.readFileSync(file);
  const sqlHash = crypto.createHash("sha256").update(bytes).digest("hex");
  if (!equalFingerprint(sqlHash, STAGING_ROLES_SQL_SHA256)) {
    fail("staging_provision_roles_sql_hash_mismatch");
  }
  const sql = bytes.toString("utf8");
  const transactionControls =
    sql.match(
      /^\s*(?:BEGIN|START\s+TRANSACTION|COMMIT|ROLLBACK)\s*;\s*$/gim
    ) || [];
  if (
    transactionControls.length !== 2 ||
    transactionControls[0].trim().toUpperCase() !== "BEGIN;" ||
    transactionControls[1].trim().toUpperCase() !== "COMMIT;" ||
    sql.includes("\u0000") ||
    /\r/.test(sql)
  ) {
    fail("staging_provision_roles_sql_invalid");
  }
  const body = sql
    .replace(/^\s*BEGIN;\s*$/im, "")
    .replace(/^\s*COMMIT;\s*$/im, "");
  if (
    /(^|\n)\s*(?:BEGIN|START\s+TRANSACTION|COMMIT|ROLLBACK)\s*;/i.test(
      body
    )
  ) {
    fail("staging_provision_roles_sql_transaction_invalid");
  }
  return body;
}

async function inspectTargetIdentity(client, configuration) {
  const result = await client.query(
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
      "  session_role.rolcreaterole AS provisioner_createrole,",
      "  session_role.rolreplication AS provisioner_replication,",
      "  session_role.rolbypassrls AS provisioner_bypassrls",
      "FROM pg_catalog.pg_database database_info",
      "JOIN pg_catalog.pg_roles owner",
      "  ON owner.oid = database_info.datdba",
      "JOIN pg_catalog.pg_roles session_role",
      "  ON session_role.rolname = session_user",
      "WHERE database_info.datname = current_database()"
    ].join("\n")
  );
  const row = result.rows?.[0];
  if (
    result.rowCount !== 1 ||
    !row ||
    row.database_name !== configuration.target.database ||
    row.current_user_name !== configuration.target.provisionerLogin ||
    row.session_user_name !== configuration.target.provisionerLogin ||
    row.database_owner !== configuration.target.provisionerLogin ||
    row.version_num < 180000 ||
    row.version_num >= 190000 ||
    row.read_only !== "off" ||
    row.datistemplate ||
    !row.datallowconn ||
    !row.provisioner_canlogin ||
    row.provisioner_superuser ||
    !row.provisioner_createrole ||
    row.provisioner_replication ||
    row.provisioner_bypassrls
  ) {
    fail("staging_provision_database_identity_invalid");
  }
}

async function readExistingEnvironmentMarker(client) {
  let transactionStarted = false;
  try {
    await client.query("BEGIN");
    transactionStarted = true;
    await client.query(
      [
        "GRANT ia4tube_social_owner TO CURRENT_USER",
        "  WITH ADMIN FALSE, INHERIT FALSE, SET TRUE",
        "  GRANTED BY CURRENT_USER"
      ].join("\n")
    );
    await client.query("SET LOCAL ROLE ia4tube_social_owner");
    const marker = await client.query(
      [
        "SELECT environment_id::text, environment_name",
        "FROM ia4tube_migrations.environment_identity",
        "WHERE singleton = TRUE"
      ].join("\n")
    );
    await client.query("ROLLBACK");
    transactionStarted = false;
    return marker;
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch {
        fail("staging_provision_marker_read_rollback_failed");
      }
    }
    if (error instanceof SocialPostgresError) throw error;
    fail("staging_provision_marker_read_failed");
  }
}

async function inspectBaselineState(client, configuration) {
  const result = await client.query(
    [
      "SELECT",
      "  COUNT(*) FILTER (",
      "    WHERE namespace.nspname = 'ia4tube_migrations'",
      "  )::integer AS migration_schema_count,",
      "  COUNT(*) FILTER (",
      "    WHERE namespace.nspname IN (",
      "      'ia4tube_social', 'ia4tube_social_admin'",
      "    )",
      "  )::integer AS application_schema_count,",
      "  COUNT(*) FILTER (",
      "    WHERE namespace.nspname NOT IN (",
      "      'public', 'information_schema', 'pg_catalog',",
      "      'ia4tube_migrations'",
      "    )",
      "      AND namespace.nspname !~ '^pg_'",
      "  )::integer AS unexpected_schema_count",
      "FROM pg_catalog.pg_namespace namespace"
    ].join("\n")
  );
  const schemas = result.rows?.[0];
  const relations = await client.query(
    [
      "SELECT namespace.nspname AS schema_name,",
      "  relation.relname AS relation_name,",
      "  relation.relkind",
      "FROM pg_catalog.pg_class relation",
      "JOIN pg_catalog.pg_namespace namespace",
      "  ON namespace.oid = relation.relnamespace",
      "WHERE namespace.nspname NOT IN (",
      "  'pg_catalog', 'information_schema'",
      ")",
      "  AND namespace.nspname !~ '^pg_'",
      "ORDER BY namespace.nspname, relation.relname"
    ].join("\n")
  );
  if (
    !schemas ||
    Number(schemas.application_schema_count) !== 0 ||
    Number(schemas.unexpected_schema_count) !== 0
  ) {
    fail("staging_provision_target_not_baseline");
  }
  const migrationSchemaCount = Number(schemas.migration_schema_count);
  const rows = relations.rows || [];
  if (migrationSchemaCount === 0 && rows.length === 0) {
    return "pristine";
  }
  if (
    migrationSchemaCount !== 1 ||
    rows.length !== 3 ||
    rows.some(
      (row) =>
        row.schema_name !== "ia4tube_migrations" ||
        ![
          "environment_identity",
          "environment_identity_environment_id_key",
          "environment_identity_pkey"
        ].includes(row.relation_name) ||
        !["r", "i"].includes(row.relkind)
    )
  ) {
    fail("staging_provision_target_not_baseline");
  }
  const marker = await readExistingEnvironmentMarker(client);
  if (
    marker.rowCount !== 1 ||
    marker.rows?.[0]?.environment_id !==
      configuration.target.environmentId ||
    marker.rows?.[0]?.environment_name !== "staging"
  ) {
    fail("staging_provision_environment_marker_mismatch");
  }
  return "baseline";
}

async function provisionStagingBaseline(
  pool,
  configuration,
  options = {}
) {
  if (!pool || typeof pool.connect !== "function") {
    fail("staging_provision_pool_invalid");
  }
  const rolesSql = canonicalRolesSqlBody(options);
  const client = await pool.connect();
  let transactionStarted = false;
  let discardClient = false;
  try {
    await inspectTargetIdentity(client, configuration);
    const initialState = await inspectBaselineState(
      client,
      configuration
    );
    await client.query("BEGIN");
    transactionStarted = true;
    await client.query(rolesSql);
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
        ") VALUES (TRUE, $1, 'staging')",
        "ON CONFLICT (singleton) DO NOTHING"
      ].join("\n"),
      [configuration.target.environmentId]
    );
    const marker = await client.query(
      [
        "SELECT environment_id::text, environment_name",
        "FROM ia4tube_migrations.environment_identity",
        "WHERE singleton = TRUE"
      ].join("\n")
    );
    if (
      marker.rowCount !== 1 ||
      marker.rows?.[0]?.environment_id !==
        configuration.target.environmentId ||
      marker.rows?.[0]?.environment_name !== "staging"
    ) {
      fail("staging_provision_environment_marker_mismatch");
    }
    await client.query("RESET ROLE");
    await client.query(
      [
        "REVOKE ia4tube_social_owner FROM CURRENT_USER",
        "  GRANTED BY CURRENT_USER RESTRICT"
      ].join("\n")
    );
    const temporaryMembership = await client.query(
      [
        "SELECT NOT EXISTS (",
        "  SELECT 1",
        "  FROM pg_catalog.pg_auth_members membership",
        "  JOIN pg_catalog.pg_roles granted",
        "    ON granted.oid = membership.roleid",
        "  JOIN pg_catalog.pg_roles member",
        "    ON member.oid = membership.member",
        "  JOIN pg_catalog.pg_roles grantor",
        "    ON grantor.oid = membership.grantor",
        "  WHERE granted.rolname = 'ia4tube_social_owner'",
        "    AND member.rolname = session_user",
        "    AND grantor.rolname = session_user",
        ") AS removed"
      ].join("\n")
    );
    if (
      temporaryMembership.rowCount !== 1 ||
      temporaryMembership.rows?.[0]?.removed !== true
    ) {
      fail("staging_provision_temporary_membership_not_removed");
    }
    await client.query("COMMIT");
    transactionStarted = false;
    return Object.freeze({
      safe: true,
      changed: initialState === "pristine",
      baselineCanonical: true
    });
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch {
        discardClient = true;
        client.release(new Error("staging_provision_rollback_failed"));
        throw new SocialPostgresError(
          "staging_provision_rollback_failed",
          "Rollback do provisionamento staging nao foi confirmado."
        );
      }
    }
    if (
      error instanceof SocialPostgresError &&
      String(error.code || "").startsWith("staging_provision_")
    ) {
      throw error;
    }
    fail("staging_provision_failed");
  } finally {
    if (!discardClient && typeof client.release === "function") {
      client.release();
    }
  }
}

module.exports = {
  PAID_STAGING_PUBLIC_TARGET,
  STAGING_DATABASE_PATTERN,
  STAGING_PROVISION_APPROVAL_PREFIX,
  STAGING_ROLES_SQL_SHA256,
  canonicalRolesSqlBody,
  inspectBaselineState,
  inspectTargetIdentity,
  loadStagingProvisionConfig,
  provisionStagingBaseline,
  stagingProvisionTargetFingerprint
};
