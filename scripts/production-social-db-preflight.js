"use strict";

// Operator-only catalogue inspection. Never imported by the HTTP runtime.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { loadSystemPostgresTls } = require("../src/persistence/postgres/tls");
const { databaseTargetFingerprint } = require("../src/persistence/postgres/config");

const TARGET = Object.freeze({
  resourceId: "dpg-dae4tmf40ujc73dr2dog-a",
  internalHostname: "dpg-dae4tmf40ujc73dr2dog-a",
  // Observed in the official resource URL; never inferred from the short host.
  externalHostname: "dpg-dae4tmf40ujc73dr2dog-a.oregon-postgres.render.com",
  port: 5432,
  database: "ia4tube_social_production",
  fingerprint: "6d21299b8c02250cf3493128557f52ff95e83397cba4d92dccaa52996485c17c"
});
const READ_APPROVAL = "INSPECT_IA4TUBE_SOCIAL_PRODUCTION_CATALOG";
const CANONICAL_ROLES = Object.freeze([
  "ia4tube_social_owner", "ia4tube_social_migrator", "ia4tube_social_runtime"
]);
const MIGRATIONS = Object.freeze([
  ["0001_social_multitenant_foundation", "ecab91eb1b915378b6d98edfa66c929c3558054349fbda8b25dbf274191a21bb"],
  ["0002_social_connections_and_vault", "72b05e7de90cd2d7742b5622bc92f9e9d78168317b9b7d547a5adb1b918d722d"],
  ["0003_global_vault_key_registry", "28e63269e5d31ebd05b49f24194be706d3e65eed3fa7f6b39f9051cfc9b96db7"],
  ["0004_social_connector_persistence", "91f6efc611903c40e16bd37828d5b9c1a03dfae222e1d13b5dc97f81ffde1b5d"],
  ["0005_fix_social_reference_checks", "ddac4a02cecfd5247432687289001aa3198cce4dccab4e45cedc4cff26e5da93"],
  ["0006_social_compliance_persistence", "f07eb68d37e8fec372e4b712447a113cba5d6ae6395492bb5678cc13d74948e7"],
  ["0007_social_publication_connection_binding", "4747e001e3057b12facabb74f2529272d8c9cd4e933f55322ee9e3bc82483464"]
].map(([version, sha256]) => Object.freeze({ version, file: `${version}.up.sql`, sha256 })));

const SQL = Object.freeze({
  begin: "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
  rollback: "ROLLBACK",
  identity: `SELECT
    current_database() AS database_name,
    current_setting('server_version_num')::integer AS server_version_num,
    current_setting('transaction_read_only') AS transaction_read_only,
    current_setting('transaction_isolation') AS transaction_isolation,
    (current_user = $1 AND session_user = $1) AS principal_matches,
    (d.datdba = r.oid) AS session_is_database_owner,
    r.rolsuper AS session_superuser, r.rolbypassrls AS session_bypass_rls,
    r.rolcreaterole AS session_create_role, r.rolcreatedb AS session_create_database,
    COALESCE((SELECT ssl FROM pg_catalog.pg_stat_ssl
      WHERE pid = pg_catalog.pg_backend_pid()), false) AS ssl_in_use
    FROM pg_catalog.pg_database d
    JOIN pg_catalog.pg_roles r ON r.rolname = current_user
    WHERE d.datname = current_database()`,
  catalogue: `WITH user_namespaces AS (
      SELECT oid, nspname FROM pg_catalog.pg_namespace
      WHERE nspname !~ '^pg_' AND nspname <> 'information_schema'
    ), ledger AS (
      SELECT c.oid, c.relkind FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'ia4tube_migrations' AND c.relname = 'schema_migrations'
    ), marker AS (
      SELECT c.oid, c.relkind FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'ia4tube_migrations' AND c.relname = 'environment_identity'
    ) SELECT
    (SELECT count(*)::integer FROM user_namespaces
      WHERE nspname IN ('ia4tube_social', 'ia4tube_social_admin', 'ia4tube_migrations')) AS social_schema_count,
    (SELECT count(*)::integer FROM user_namespaces
      WHERE nspname NOT IN ('public', 'ia4tube_social', 'ia4tube_social_admin', 'ia4tube_migrations')) AS other_schema_count,
    (SELECT count(*)::integer FROM pg_catalog.pg_class c
      JOIN user_namespaces n ON n.oid = c.relnamespace) AS user_relation_count,
    (SELECT count(*)::integer FROM pg_catalog.pg_class c
      JOIN user_namespaces n ON n.oid = c.relnamespace
      WHERE n.nspname NOT IN ('ia4tube_social', 'ia4tube_social_admin', 'ia4tube_migrations')) AS other_relation_count,
    (SELECT count(*)::integer FROM pg_catalog.pg_proc p
      JOIN user_namespaces n ON n.oid = p.pronamespace
      WHERE n.nspname NOT IN ('ia4tube_social', 'ia4tube_social_admin', 'ia4tube_migrations')) AS other_function_count,
    (SELECT count(*)::integer FROM pg_catalog.pg_type t
      JOIN user_namespaces n ON n.oid = t.typnamespace
      WHERE n.nspname NOT IN ('ia4tube_social', 'ia4tube_social_admin', 'ia4tube_migrations')) AS other_type_count,
    (SELECT count(*)::integer FROM pg_catalog.pg_extension WHERE extname <> 'plpgsql') AS other_extension_count,
    EXISTS(SELECT 1 FROM ledger) AS ledger_exists,
    COALESCE((SELECT relkind = 'r' FROM ledger), false) AS ledger_is_table,
    COALESCE((SELECT pg_catalog.has_table_privilege(current_user, oid, 'SELECT') FROM ledger), false) AS ledger_readable,
    EXISTS(SELECT 1 FROM marker) AS marker_exists,
    COALESCE((SELECT relkind = 'r' FROM marker), false) AS marker_is_table,
    COALESCE((SELECT pg_catalog.has_table_privilege(current_user, oid, 'SELECT') FROM marker), false) AS marker_readable,
    EXISTS(SELECT 1 FROM pg_catalog.pg_database d,
      LATERAL pg_catalog.aclexplode(COALESCE(d.datacl, pg_catalog.acldefault('d', d.datdba))) a
      WHERE d.datname = current_database() AND a.grantee = 0 AND a.privilege_type = 'CONNECT') AS public_database_connect,
    EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n,
      LATERAL pg_catalog.aclexplode(COALESCE(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) a
      WHERE n.nspname = 'public' AND a.grantee = 0 AND a.privilege_type = 'CREATE') AS public_schema_create`,
  roles: `SELECT r.rolname AS role_name, r.rolcanlogin AS can_login,
    r.rolsuper AS is_superuser, r.rolbypassrls AS bypass_rls,
    r.rolcreatedb AS create_database, r.rolcreaterole AS create_role,
    r.rolinherit AS inherits, r.rolreplication AS replication,
    (SELECT count(*)::integer FROM pg_catalog.pg_auth_members m WHERE m.roleid = r.oid) AS member_count
    FROM pg_catalog.pg_roles r WHERE r.rolname = ANY($1::text[]) ORDER BY r.rolname`,
  ledger: "SELECT version, checksum_sha256 FROM ia4tube_migrations.schema_migrations ORDER BY version LIMIT 8",
  marker: "SELECT environment_id::text, environment_name FROM ia4tube_migrations.environment_identity LIMIT 2"
});

const FAILURE_CODES = new Set([
  "production_preflight_inspect_only", "production_preflight_approval_missing",
  "production_preflight_external_hostname_unconfirmed", "production_preflight_connection_invalid",
  "production_preflight_environment_override_refused", "production_preflight_manifest_invalid",
  "production_preflight_local_checksum_mismatch", "production_preflight_catalogue_invalid",
  "production_preflight_target_mismatch", "production_preflight_postgres_18_required",
  "production_preflight_read_only_required", "production_preflight_tls_required",
  "production_preflight_ledger_mismatch", "production_preflight_marker_mismatch",
  "production_preflight_dependency_unavailable", "production_preflight_connection_failed",
  "production_preflight_query_failed", "production_preflight_cleanup_unconfirmed"
]);

class PreflightFailure extends Error {
  constructor(code) { super(code); this.name = "PreflightFailure"; this.code = code; }
}
function refuse(code) { throw new PreflightFailure(code); }
function safeFailure(error) {
  return error instanceof PreflightFailure && FAILURE_CODES.has(error.code)
    ? error : new PreflightFailure("production_preflight_query_failed");
}
function parseCommand(args) {
  if (!Array.isArray(args) || args.length !== 1 || args[0] !== "inspect") {
    refuse("production_preflight_inspect_only");
  }
  return "inspect";
}

function assertNoAmbientOverrides(env) {
  const forbidden = new Set([
    "NODE_OPTIONS", "NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "OPENSSL_CONF", "OPENSSL_MODULES"
  ]);
  for (const [name, value] of Object.entries(env)) {
    if (String(value || "").trim() && (forbidden.has(name.toUpperCase()) || /^PG[A-Z0-9_]+$/i.test(name))) {
      refuse("production_preflight_environment_override_refused");
    }
  }
}

function parseConnection(value, externalHostname) {
  if (!externalHostname) refuse("production_preflight_external_hostname_unconfirmed");
  if (typeof value !== "string" || value !== value.trim() || /[\u0000-\u0020\u007f]/.test(value)) {
    refuse("production_preflight_connection_invalid");
  }
  let url;
  try { url = new URL(value); } catch { refuse("production_preflight_connection_invalid"); }
  const parameters = [...url.searchParams.entries()];
  if (!["postgres:", "postgresql:"].includes(url.protocol) || url.hostname !== externalHostname ||
      url.port !== String(TARGET.port) || url.pathname !== `/${TARGET.database}` || url.hash ||
      !url.username || !url.password || parameters.length !== 1 ||
      parameters[0][0] !== "sslmode" || parameters[0][1] !== "verify-full") {
    refuse("production_preflight_connection_invalid");
  }
  let user, password;
  try { user = decodeURIComponent(url.username); password = decodeURIComponent(url.password); }
  catch { refuse("production_preflight_connection_invalid"); }
  if (!/^[a-z][a-z0-9_]{2,62}$/.test(user) || !password || /[\u0000-\u001f\u007f]/.test(password)) {
    refuse("production_preflight_connection_invalid");
  }
  return Object.freeze({ host: externalHostname, port: TARGET.port, database: TARGET.database, user, password });
}

function loadConnectionOptions(env = process.env) {
  assertNoAmbientOverrides(env);
  if (env.PRODUCTION_SOCIAL_PREFLIGHT_APPROVED !== READ_APPROVAL) {
    refuse("production_preflight_approval_missing");
  }
  const connection = parseConnection(env.PRODUCTION_SOCIAL_PREFLIGHT_DATABASE_URL, TARGET.externalHostname);
  if (databaseTargetFingerprint(new URL(env.PRODUCTION_SOCIAL_PREFLIGHT_DATABASE_URL)) !== TARGET.fingerprint) {
    refuse("production_preflight_target_mismatch");
  }
  let ssl;
  try { ssl = loadSystemPostgresTls(env, connection.host); }
  catch { refuse("production_preflight_tls_required"); }
  return Object.freeze({
    ...connection, ssl,
    connectionTimeoutMillis: 5000,
    query_timeout: 10000,
    application_name: "ia4tube-production-social-catalog-preflight",
    options: "-c default_transaction_read_only=on -c statement_timeout=10000 -c lock_timeout=5000 -c idle_in_transaction_session_timeout=10000 -c search_path=pg_catalog"
  });
}

function verifyLocalManifest({
  directory = path.join(__dirname, "..", "db", "migrations"),
  readFile = fs.readFileSync
} = {}) {
  let manifest;
  try { manifest = JSON.parse(readFile(path.join(directory, "checksums.json"), "utf8")); }
  catch { refuse("production_preflight_manifest_invalid"); }
  if (manifest?.format !== 1 || !Array.isArray(manifest.migrations) || manifest.migrations.length !== MIGRATIONS.length) {
    refuse("production_preflight_manifest_invalid");
  }
  MIGRATIONS.forEach((expected, index) => {
    const actual = manifest.migrations[index];
    if (!actual || Object.keys(actual).sort().join(",") !== "file,sha256,version" ||
        actual.version !== expected.version || actual.file !== expected.file || actual.sha256 !== expected.sha256) {
      refuse("production_preflight_manifest_invalid");
    }
    let bytes;
    try { bytes = readFile(path.join(directory, expected.file)); }
    catch { refuse("production_preflight_local_checksum_mismatch"); }
    if (crypto.createHash("sha256").update(bytes).digest("hex") !== expected.sha256) {
      refuse("production_preflight_local_checksum_mismatch");
    }
  });
  return true;
}

function rows(result, maximum) {
  if (!result || !Array.isArray(result.rows) || result.rows.length > maximum) {
    refuse("production_preflight_catalogue_invalid");
  }
  return result.rows;
}
function one(result) {
  const values = rows(result, 1);
  if (values.length !== 1) refuse("production_preflight_catalogue_invalid");
  return values[0];
}
function boolean(value) {
  if (typeof value !== "boolean") refuse("production_preflight_catalogue_invalid");
  return value;
}
function count(value) {
  if (!Number.isSafeInteger(value) || value < 0) refuse("production_preflight_catalogue_invalid");
  return value;
}

function summarizeSnapshot({ identity, catalogue, roles, ledger, marker }) {
  if (!identity || !catalogue || !Array.isArray(roles) || roles.length > 3 ||
      (ledger !== null && !Array.isArray(ledger)) || (marker !== null && !Array.isArray(marker))) {
    refuse("production_preflight_catalogue_invalid");
  }
  if (identity.database_name !== TARGET.database || identity.principal_matches !== true) {
    refuse("production_preflight_target_mismatch");
  }
  if (!Number.isSafeInteger(identity.server_version_num) || identity.server_version_num < 180000 || identity.server_version_num >= 190000) {
    refuse("production_preflight_postgres_18_required");
  }
  if (identity.transaction_read_only !== "on" || identity.transaction_isolation !== "repeatable read") {
    refuse("production_preflight_read_only_required");
  }
  if (identity.ssl_in_use !== true) refuse("production_preflight_tls_required");
  const counts = Object.fromEntries([
    "social_schema_count", "other_schema_count", "user_relation_count", "other_relation_count",
    "other_function_count", "other_type_count", "other_extension_count"
  ].map((name) => [name, count(catalogue[name])]));
  const flags = Object.fromEntries([
    "ledger_exists", "ledger_is_table", "ledger_readable", "marker_exists", "marker_is_table",
    "marker_readable", "public_database_connect", "public_schema_create"
  ].map((name) => [name, boolean(catalogue[name])]));
  if ((!flags.ledger_exists && (flags.ledger_is_table || flags.ledger_readable)) ||
      (!flags.marker_exists && (flags.marker_is_table || flags.marker_readable)) ||
      (flags.ledger_exists && !flags.ledger_is_table) || (flags.marker_exists && !flags.marker_is_table)) {
    refuse("production_preflight_catalogue_invalid");
  }
  const seenRoles = new Set();
  const roleSummary = roles.map((role) => {
    if (!CANONICAL_ROLES.includes(role.role_name) || seenRoles.has(role.role_name)) {
      refuse("production_preflight_catalogue_invalid");
    }
    seenRoles.add(role.role_name);
    return {
      role: role.role_name,
      restrictedNoLoginAttributes: ["can_login", "is_superuser", "bypass_rls", "create_database", "create_role", "inherits", "replication"]
        .map((key) => boolean(role[key])).every((value) => !value),
      memberCount: count(role.member_count)
    };
  });
  if (ledger !== null) {
    if (!flags.ledger_readable || ledger.length > MIGRATIONS.length) refuse("production_preflight_ledger_mismatch");
    ledger.forEach((row, index) => {
      const expected = MIGRATIONS[index];
      if (row.version !== expected.version || row.checksum_sha256 !== expected.sha256) {
        refuse("production_preflight_ledger_mismatch");
      }
    });
  }
  let markerVerified = false;
  if (marker !== null) {
    if (!flags.marker_readable || marker.length !== 1 || marker[0].environment_name !== "production" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(marker[0].environment_id)) {
      refuse("production_preflight_marker_mismatch");
    }
    markerVerified = true;
  }
  const baselineCandidate = counts.social_schema_count === 0 && counts.user_relation_count === 0 &&
    counts.other_schema_count === 0 && counts.other_function_count === 0 && counts.other_type_count === 0 &&
    counts.other_extension_count === 0 && roles.length === 0 && !flags.ledger_exists && !flags.marker_exists;
  const blockers = [
    "recovery_not_proven_by_this_preflight",
    "production_apply_not_exposed_by_readonly_operator",
    "production_0005_0006_route_review_required",
    "production_0007_isolated_recovery_and_review_required",
    "runtime_rls_and_cross_tenant_behavior_not_proven"
  ];
  if (counts.other_schema_count || counts.other_relation_count || counts.other_function_count ||
      counts.other_type_count || counts.other_extension_count) blockers.push("unexpected_catalogue_objects_require_review");
  if (flags.ledger_exists && !flags.ledger_readable) blockers.push("migration_ledger_read_with_authorized_principal_required");
  if (flags.marker_exists && !flags.marker_readable) blockers.push("environment_marker_read_with_authorized_principal_required");
  if (roles.some((role) => ["can_login", "is_superuser", "bypass_rls", "create_database", "create_role", "inherits", "replication"].some((key) => role[key]))) {
    blockers.push("canonical_role_attributes_require_review");
  }
  return Object.freeze({
    format: 1, ok: true, operation: "catalogue-inspection", readOnly: true, applyAvailable: false,
    expectedTarget: TARGET,
    postgresVersionNum: identity.server_version_num,
    session: {
      databaseOwner: boolean(identity.session_is_database_owner),
      superuser: boolean(identity.session_superuser), bypassRls: boolean(identity.session_bypass_rls),
      createRole: boolean(identity.session_create_role), createDatabase: boolean(identity.session_create_database),
      sslInUse: true, readOnlyRepeatableRead: true
    },
    catalogue: counts, acl: { publicDatabaseConnect: flags.public_database_connect, publicSchemaCreate: flags.public_schema_create },
    canonicalRoles: roleSummary, baselineCandidate, environmentMarkerPresent: flags.marker_exists,
    environmentMarkerProductionAndUuidValid: markerVerified,
    environmentIdentityComparedWithApprovedUuid: false,
    ledgerPresent: flags.ledger_exists, ledgerChecksumsVerified: ledger !== null,
    appliedMigrations: ledger === null ? null : MIGRATIONS.slice(0, ledger.length).map((entry) => entry.version),
    pendingMigrations: ledger === null && flags.ledger_exists ? null : MIGRATIONS.slice(ledger?.length || 0).map((entry) => entry.version),
    blockers
  });
}

async function inspectConnectedClient(client, principal) {
  let transactionOpen = false;
  try {
    await client.query(SQL.begin);
    transactionOpen = true;
    const identity = one(await client.query(SQL.identity, [principal]));
    // Verify target before any application-owned ledger/marker is considered.
    if (identity.database_name !== TARGET.database || identity.principal_matches !== true) refuse("production_preflight_target_mismatch");
    if (!Number.isSafeInteger(identity.server_version_num) || identity.server_version_num < 180000 || identity.server_version_num >= 190000) refuse("production_preflight_postgres_18_required");
    if (identity.transaction_read_only !== "on" || identity.transaction_isolation !== "repeatable read") refuse("production_preflight_read_only_required");
    if (identity.ssl_in_use !== true) refuse("production_preflight_tls_required");
    const catalogue = one(await client.query(SQL.catalogue));
    const roles = rows(await client.query(SQL.roles, [CANONICAL_ROLES]), 3);
    const ledger = catalogue.ledger_exists === true && catalogue.ledger_is_table === true && catalogue.ledger_readable === true
      ? rows(await client.query(SQL.ledger), 8) : null;
    const marker = catalogue.marker_exists === true && catalogue.marker_is_table === true && catalogue.marker_readable === true
      ? rows(await client.query(SQL.marker), 2) : null;
    const summary = summarizeSnapshot({ identity, catalogue, roles, ledger, marker });
    await client.query(SQL.rollback);
    transactionOpen = false;
    return summary;
  } catch (error) {
    if (transactionOpen) {
      try { await client.query(SQL.rollback); }
      catch { refuse("production_preflight_cleanup_unconfirmed"); }
    }
    throw safeFailure(error);
  }
}

async function main(args = process.argv.slice(2), env = process.env) {
  parseCommand(args);
  const connectionOptions = loadConnectionOptions(env);
  verifyLocalManifest();
  let Client;
  try { ({ Client } = require("pg")); }
  catch { refuse("production_preflight_dependency_unavailable"); }
  const client = new Client(connectionOptions);
  return inspectClientLifecycle(client, connectionOptions.user);
}

async function inspectClientLifecycle(client, principal) {
  // pg may emit an idle/transport error outside a query Promise. Never let its
  // raw diagnostic reach an unhandled EventEmitter error or the operator log.
  let asynchronousError = false;
  client.on("error", () => { asynchronousError = true; });
  let connected = false;
  let report;
  try {
    try { await client.connect(); connected = true; }
    catch { refuse("production_preflight_connection_failed"); }
    if (asynchronousError) refuse("production_preflight_connection_failed");
    const guardedClient = {
      async query(statement, parameters) {
        if (asynchronousError && statement !== SQL.rollback) refuse("production_preflight_query_failed");
        const result = await client.query(statement, parameters);
        if (asynchronousError && statement !== SQL.rollback) refuse("production_preflight_query_failed");
        return result;
      }
    };
    report = await inspectConnectedClient(guardedClient, principal);
  } finally {
    try { await client.end(); }
    catch { if (connected) refuse("production_preflight_cleanup_unconfirmed"); }
  }
  if (asynchronousError) refuse("production_preflight_query_failed");
  return report;
}

// For a private stdin/pipe wrapper: no URL in argv, no global environment change.
// The caller must catch with safeFailure(), never print the input or raw errors.
async function inspectProductionDatabase({ url, approval } = {}) {
  return main(["inspect"], {
    ...process.env,
    PRODUCTION_SOCIAL_PREFLIGHT_APPROVED: approval,
    PRODUCTION_SOCIAL_PREFLIGHT_DATABASE_URL: url
  });
}

if (require.main === module) {
  main().then((report) => { process.stdout.write(`${JSON.stringify(report)}\n`); }).catch((error) => {
    process.stdout.write(`${JSON.stringify({ ok: false, readOnly: true, applyAvailable: false, code: safeFailure(error).code })}\n`);
    process.exitCode = 2;
  });
}

module.exports = {
  TARGET, READ_APPROVAL, CANONICAL_ROLES, MIGRATIONS, SQL,
  parseCommand, parseConnection, loadConnectionOptions, verifyLocalManifest,
  summarizeSnapshot, inspectConnectedClient, inspectClientLifecycle, inspectProductionDatabase, safeFailure, main
};
