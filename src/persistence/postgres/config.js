"use strict";

const { postgresFail } = require("./errors");
const { requireSafeLabel, requireUuid } = require("./validation");

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const SSL_QUERY_KEYS = [
  "sslmode",
  "sslcert",
  "sslkey",
  "sslrootcert"
];
const SOCIAL_OWNER_ROLE = "ia4tube_social_owner";
const SOCIAL_MIGRATOR_ROLE = "ia4tube_social_migrator";
const SOCIAL_RUNTIME_ROLE = "ia4tube_social_runtime";

function explicitTrue(value) {
  return String(value || "").trim().toLowerCase() === "true";
}

function boundedInteger(value, fallback, minimum, maximum, field) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < minimum ||
    parsed > maximum
  ) {
    postgresFail(`${field}_invalid`, "Limite PostgreSQL recusado.");
  }
  return parsed;
}

function parseDatabaseUrl(raw, field) {
  if (
    typeof raw !== "string" ||
    raw.length === 0 ||
    raw !== raw.trim()
  ) {
    postgresFail(`${field}_missing`, "Conexao PostgreSQL obrigatoria.");
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    postgresFail(`${field}_invalid`, "Conexao PostgreSQL recusada.");
  }

  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !parsed.hostname ||
    !parsed.pathname ||
    parsed.pathname === "/" ||
    !parsed.username
  ) {
    postgresFail(`${field}_invalid`, "Conexao PostgreSQL recusada.");
  }
  return parsed;
}

function requireCanonicalRole(value, expected, field) {
  const role = requireSafeLabel(value || expected, field);
  if (role !== expected) {
    postgresFail(
      `${field}_must_be_canonical`,
      "Role PostgreSQL social divergente."
    );
  }
  return role;
}

function decodeCa(raw) {
  if (!raw) return undefined;
  if (
    typeof raw !== "string" ||
    raw.length > 200000 ||
    !/^[A-Za-z0-9+/=\r\n]+$/.test(raw)
  ) {
    postgresFail("social_database_ca_invalid", "CA PostgreSQL recusada.");
  }
  const decoded = Buffer.from(raw.replace(/\s/g, ""), "base64").toString(
    "utf8"
  );
  if (
    !decoded.includes("-----BEGIN CERTIFICATE-----") ||
    !decoded.includes("-----END CERTIFICATE-----")
  ) {
    postgresFail("social_database_ca_invalid", "CA PostgreSQL recusada.");
  }
  return decoded;
}

function connectionSecurity(parsed, env) {
  const localInsecure =
    env.NODE_ENV === "test" &&
    explicitTrue(env.SOCIAL_DATABASE_ALLOW_INSECURE_LOCALHOST) &&
    LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase());

  const requestedMode = String(parsed.searchParams.get("sslmode") || "")
    .trim()
    .toLowerCase();
  if (requestedMode === "disable" && !localInsecure) {
    postgresFail(
      "social_database_tls_required",
      "TLS PostgreSQL e obrigatorio."
    );
  }

  for (const key of SSL_QUERY_KEYS) parsed.searchParams.delete(key);

  if (localInsecure) {
    return Object.freeze({ connectionString: parsed.toString(), ssl: false });
  }

  const ca = decodeCa(env.SOCIAL_DATABASE_CA_BASE64);
  return Object.freeze({
    connectionString: parsed.toString(),
    ssl: Object.freeze({
      rejectUnauthorized: true,
      ...(ca ? { ca } : {})
    })
  });
}

function commonPoolConfig(parsed, env, kind) {
  const security = connectionSecurity(parsed, env);
  const prefix =
    kind === "migration" ? "SOCIAL_MIGRATION" : "SOCIAL_DATABASE";
  const maxDefault = kind === "migration" ? 1 : 5;
  const maxCap = kind === "migration" ? 2 : 10;
  const max = boundedInteger(
    env[`${prefix}_POOL_MAX`],
    maxDefault,
    1,
    maxCap,
    "social_database_pool_max"
  );
  const connectionTimeoutMillis = boundedInteger(
    env[`${prefix}_CONNECT_TIMEOUT_MS`],
    5000,
    1000,
    30000,
    "social_database_connect_timeout"
  );
  const idleTimeoutMillis = boundedInteger(
    env[`${prefix}_IDLE_TIMEOUT_MS`],
    10000,
    1000,
    60000,
    "social_database_idle_timeout"
  );
  const statementTimeoutMillis = boundedInteger(
    env[`${prefix}_STATEMENT_TIMEOUT_MS`],
    kind === "migration" ? 60000 : 10000,
    1000,
    120000,
    "social_database_statement_timeout"
  );
  const queryTimeoutMillis = boundedInteger(
    env[`${prefix}_QUERY_TIMEOUT_MS`],
    kind === "migration" ? 65000 : 15000,
    statementTimeoutMillis,
    130000,
    "social_database_query_timeout"
  );
  const idleInTransactionTimeoutMillis = boundedInteger(
    env[`${prefix}_IDLE_TRANSACTION_TIMEOUT_MS`],
    5000,
    1000,
    30000,
    "social_database_idle_transaction_timeout"
  );

  return Object.freeze({
    ...security,
    max,
    min: 0,
    connectionTimeoutMillis,
    idleTimeoutMillis,
    query_timeout: queryTimeoutMillis,
    application_name:
      kind === "migration"
        ? "ia4tube-social-migrations"
        : "ia4tube-social-runtime",
    options: [
      `-c statement_timeout=${statementTimeoutMillis}`,
      `-c idle_in_transaction_session_timeout=${idleInTransactionTimeoutMillis}`,
      "-c lock_timeout=5000",
      "-c search_path=pg_catalog"
    ].join(" "),
    allowExitOnIdle: false
  });
}

function loadRuntimePostgresConfig(env = process.env) {
  const enabled = explicitTrue(env.SOCIAL_PERSISTENCE_ENABLED);
  if (!enabled) return Object.freeze({ enabled: false });

  const parsed = parseDatabaseUrl(env.DATABASE_URL, "database_url");
  return Object.freeze({
    enabled: true,
    role: requireCanonicalRole(
      env.SOCIAL_DATABASE_RUNTIME_ROLE,
      SOCIAL_RUNTIME_ROLE,
      "social_database_runtime_role"
    ),
    pool: commonPoolConfig(parsed, env, "runtime")
  });
}

function loadMigrationPostgresConfig(env = process.env) {
  const parsed = parseDatabaseUrl(
    env.SOCIAL_MIGRATIONS_DATABASE_URL,
    "social_migrations_database_url"
  );
  const runtimeRaw = String(env.DATABASE_URL || "").trim();
  if (runtimeRaw) {
    const runtimeParsed = parseDatabaseUrl(runtimeRaw, "database_url");
    const normalizedPrincipal = (value) =>
      [
        value.hostname.toLowerCase(),
        value.port || "5432",
        decodeURIComponent(value.pathname.slice(1)),
        decodeURIComponent(value.username).toLowerCase()
      ].join("/");
    if (normalizedPrincipal(runtimeParsed) === normalizedPrincipal(parsed)) {
      postgresFail(
        "migration_runtime_credentials_must_differ",
        "Credenciais de runtime e migration devem ser separadas."
      );
    }
  }
  return Object.freeze({
    enabled: true,
    ownerRole: requireCanonicalRole(
      env.SOCIAL_DATABASE_OWNER_ROLE,
      SOCIAL_OWNER_ROLE,
      "social_database_owner_role"
    ),
    migratorRole: requireCanonicalRole(
      env.SOCIAL_DATABASE_MIGRATOR_ROLE,
      SOCIAL_MIGRATOR_ROLE,
      "social_database_migrator_role"
    ),
    pool: commonPoolConfig(parsed, env, "migration"),
    target: Object.freeze({
      environment: requireSafeLabel(
        env.SOCIAL_MIGRATION_ENVIRONMENT,
        "social_migration_environment"
      ),
      approval: String(env.SOCIAL_MIGRATION_APPROVED || ""),
      productionApproval: String(
        env.SOCIAL_MIGRATION_PRODUCTION_APPROVAL || ""
      ),
      environmentId: requireUuid(
        env.SOCIAL_MIGRATION_EXPECTED_ENVIRONMENT_ID,
        "social_migration_expected_environment_id"
      ),
      host: parsed.hostname.toLowerCase(),
      port: parsed.port || "5432",
      database: decodeURIComponent(parsed.pathname.slice(1)),
      username: decodeURIComponent(parsed.username).toLowerCase()
    })
  });
}

module.exports = {
  LOOPBACK_HOSTS,
  SOCIAL_MIGRATOR_ROLE,
  SOCIAL_OWNER_ROLE,
  SOCIAL_RUNTIME_ROLE,
  explicitTrue,
  loadMigrationPostgresConfig,
  loadRuntimePostgresConfig,
  parseDatabaseUrl,
  requireCanonicalRole
};
