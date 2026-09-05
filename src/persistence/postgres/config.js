"use strict";

const crypto = require("node:crypto");
const { postgresFail } = require("./errors");
const {
  assertSystemTrustOnly,
  loadSystemPostgresTls
} = require("./tls");
const { requireSafeLabel, requireUuid } = require("./validation");

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const ALLOWED_DATABASE_QUERY_KEY = "sslmode";
const DATABASE_NAME_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;
const DATABASE_LOGIN_PATTERN = /^[a-z][a-z0-9_]{2,62}$/;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const SOCIAL_OWNER_ROLE = "ia4tube_social_owner";
const SOCIAL_MIGRATOR_ROLE = "ia4tube_social_migrator";
const SOCIAL_RUNTIME_ROLE = "ia4tube_social_runtime";
const OPERATOR_DATABASE_MARKER_PATTERN =
  /(?:^|_)(?:BACKUP|RESTORE|BOOTSTRAP|SIZING|TEST|MIGRATIONS?|PROVISIONER|ROTATIONS?|OPERATOR)(?:_|$)/;
const OPERATOR_SECRET_TOKEN_PATTERN =
  /(?:^|_)(?:PASSWORDS?|SECRETS?|KEYS?|TOKENS?)(?:_|$)/;
const WEB_SERVICE_LIBPQ_ENVIRONMENT_NAMES = new Set([
  "PGAPPNAME",
  "PGCHANNELBINDING",
  "PGCLIENTENCODING",
  "PGCONNECT_TIMEOUT",
  "PGDATABASE",
  "PGDATESTYLE",
  "PGGEQO",
  "PGGSSDELEGATION",
  "PGGSSENCMODE",
  "PGGSSLIB",
  "PGHOST",
  "PGHOSTADDR",
  "PGKEEPALIVES",
  "PGKEEPALIVES_COUNT",
  "PGKEEPALIVES_IDLE",
  "PGKEEPALIVES_INTERVAL",
  "PGKRBSRVNAME",
  "PGLOADBALANCEHOSTS",
  "PGLOCALEDIR",
  "PGMAXPROTOCOLVERSION",
  "PGMINPROTOCOLVERSION",
  "PGOPTIONS",
  "PGPASSWORD",
  "PGPASSFILE",
  "PGPORT",
  "PGREQUIREAUTH",
  "PGREQUIREPEER",
  "PGREQUIRESSL",
  "PGSERVICE",
  "PGSERVICEFILE",
  "PGSSLCRL",
  "PGSSLCRLDIR",
  "PGSSLCERT",
  "PGSSLCERTMODE",
  "PGSSLCOMPRESSION",
  "PGSSLKEY",
  "PGSSLMAXPROTOCOLVERSION",
  "PGSSLMINPROTOCOLVERSION",
  "PGSSLMODE",
  "PGSSLNEGOTIATION",
  "PGSSLROOTCERT",
  "PGSSLSNI",
  "PGSYSCONFDIR",
  "PGTARGETSESSIONATTRS",
  "PGTCPUSER_TIMEOUT",
  "PGTZ",
  "PGUSER"
]);
const WEB_SERVICE_OPERATOR_SECRET_NAMES = new Set([
  "SOCIAL_BACKUP_BUNDLE_KEY",
  "SOCIAL_LOGIN_BOOTSTRAP_MIGRATION_PASSWORD",
  "SOCIAL_LOGIN_BOOTSTRAP_RUNTIME_PASSWORD"
]);
const WEB_SERVICE_OPERATOR_ENVIRONMENT_PREFIXES = Object.freeze([
  "SOCIAL_VAULT_ROTATION_"
]);
const POSTGRES_ENVIRONMENT_NAME_PATTERN = /^PG[A-Z0-9_]+$/;

function explicitTrue(value) {
  return String(value || "").trim().toLowerCase() === "true";
}

function hasConfiguredValue(value) {
  return value !== undefined &&
    value !== null &&
    String(value).trim().length > 0;
}

function assertNoAmbientPostgresEnvironment(
  env,
  code = "postgres_environment_override_forbidden"
) {
  for (const [name, value] of Object.entries(env || {})) {
    if (
      POSTGRES_ENVIRONMENT_NAME_PATTERN.test(
        String(name || "").toUpperCase()
      ) &&
      hasConfiguredValue(value)
    ) {
      postgresFail(
        code,
        "Override ambiental PostgreSQL recusado."
      );
    }
  }
  return true;
}

function isOperatorDatabaseUrlName(normalizedName) {
  const tokens = normalizedName.split("_").filter(Boolean);
  return (
    tokens.includes("URL") &&
    (tokens.includes("DATABASE") || tokens.includes("DB"))
  );
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
    !parsed.username ||
    parsed.hash
  ) {
    postgresFail(`${field}_invalid`, "Conexao PostgreSQL recusada.");
  }
  databaseName(parsed, field);
  return parsed;
}

function databaseName(parsed, field = "social_database") {
  const encoded = String(parsed?.pathname || "").slice(1);
  let decoded;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    postgresFail(
      `${field}_database_invalid`,
      "Nome do banco PostgreSQL recusado."
    );
  }
  if (
    decoded !== encoded ||
    !DATABASE_NAME_PATTERN.test(decoded)
  ) {
    postgresFail(
      `${field}_database_invalid`,
      "Nome do banco PostgreSQL recusado."
    );
  }
  return decoded;
}

function normalizedDatabaseUsername(parsed) {
  let login;
  try {
    login = decodeURIComponent(parsed.username);
  } catch {
    postgresFail(
      "social_database_login_invalid",
      "Login PostgreSQL recusado."
    );
  }
  return requireCanonicalDatabaseLogin(login, "social_database_login");
}

function requireCanonicalDatabaseLogin(value, field) {
  const login = requireSafeLabel(value, field);
  if (login !== login.toLowerCase()) {
    postgresFail(
      `${field}_must_be_canonical`,
      "Login PostgreSQL deve usar a forma canonica."
    );
  }
  if (!DATABASE_LOGIN_PATTERN.test(login)) {
    postgresFail(`${field}_invalid`, "Login PostgreSQL recusado.");
  }
  return login;
}

function databaseTargetFingerprint(parsed) {
  const database = databaseName(parsed, "social_database_target");
  return crypto
    .createHash("sha256")
    .update(
      [
        "ia4tube-social-database-target-v1",
        parsed.hostname.toLowerCase(),
        parsed.port || "5432",
        database
      ].join("/")
    )
    .digest("hex");
}

function requireExpectedTargetFingerprint(env, parsed) {
  const expected =
    typeof env.SOCIAL_DATABASE_EXPECTED_TARGET_FINGERPRINT === "string"
      ? env.SOCIAL_DATABASE_EXPECTED_TARGET_FINGERPRINT
      : "";
  const actual = databaseTargetFingerprint(parsed);
  const expectedFormatValid = FINGERPRINT_PATTERN.test(expected);
  const fingerprintsEqual =
    expectedFormatValid &&
    crypto.timingSafeEqual(
      Buffer.from(actual, "hex"),
      Buffer.from(expected, "hex")
    );
  if (!fingerprintsEqual) {
    postgresFail(
      "social_database_expected_target_fingerprint_mismatch",
      "Destino publico PostgreSQL diverge da identidade esperada."
    );
  }
  return actual;
}

function requireRemotePassword(parsed, field) {
  if (
    !LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase()) &&
    !parsed.password
  ) {
    postgresFail(
      `${field}_password_required`,
      "Senha da conexao PostgreSQL remota e obrigatoria."
    );
  }
}

function requireCanonicalExpectedLogin(env, name, field) {
  return requireCanonicalDatabaseLogin(env[name], field);
}

function requireExpectedLogin(env, name, actual, field) {
  const expected = requireCanonicalExpectedLogin(env, name, field);
  if (expected !== actual) {
    postgresFail(
      `${field}_mismatch`,
      "Login PostgreSQL diverge da identidade esperada."
    );
  }
  return expected;
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

function connectionSecurity(parsed, env) {
  const localInsecure =
    env.NODE_ENV === "test" &&
    explicitTrue(env.SOCIAL_DATABASE_ALLOW_INSECURE_LOCALHOST) &&
    LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase());

  // Keep channel_binding outside this allowlist. pg-connection-string accepts
  // it as an opaque query key, but node-postgres does not implement libpq's
  // strict channel_binding=require semantics from that key.
  const queryEntries = [...parsed.searchParams.entries()];
  if (
    queryEntries.some(([name]) => name !== ALLOWED_DATABASE_QUERY_KEY) ||
    parsed.searchParams.getAll(ALLOWED_DATABASE_QUERY_KEY).length > 1
  ) {
    postgresFail(
      "social_database_connection_parameter_forbidden",
      "Parametro de conexao PostgreSQL recusado."
    );
  }
  const requestedMode = String(
    parsed.searchParams.get(ALLOWED_DATABASE_QUERY_KEY) || ""
  )
    .trim()
    .toLowerCase();
  if (
    requestedMode &&
    (
      (localInsecure && requestedMode !== "disable") ||
      (!localInsecure && requestedMode !== "verify-full")
    )
  ) {
    postgresFail(
      "social_database_tls_mode_invalid",
      "Modo TLS PostgreSQL recusado."
    );
  }

  parsed.search = "";

  if (localInsecure) {
    return Object.freeze({ connectionString: parsed.toString(), ssl: false });
  }

  return Object.freeze({
    connectionString: parsed.toString(),
    ssl: loadSystemPostgresTls(
      env,
      parsed.hostname.toLowerCase()
    )
  });
}

function commonPoolConfig(parsed, env, kind) {
  const security = connectionSecurity(parsed, env);
  const prefix =
    kind === "migration" ? "SOCIAL_MIGRATION" : "SOCIAL_DATABASE";
  const maxDefault = kind === "migration" ? 1 : 3;
  const maxCap = kind === "migration" ? 1 : 3;
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
  const lockTimeoutMillis = boundedInteger(
    env[`${prefix}_LOCK_TIMEOUT_MS`],
    Math.min(5000, statementTimeoutMillis),
    250,
    Math.min(30000, statementTimeoutMillis),
    "social_database_lock_timeout"
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
      `-c lock_timeout=${lockTimeoutMillis}`,
      "-c search_path=pg_catalog"
    ].join(" "),
    allowExitOnIdle: false
  });
}

function loadRuntimePostgresConfig(env = process.env) {
  const enabled = explicitTrue(env.SOCIAL_PERSISTENCE_ENABLED);
  if (!enabled) return Object.freeze({ enabled: false });

  const parsed = parseDatabaseUrl(env.DATABASE_URL, "database_url");
  requireRemotePassword(parsed, "database_url");
  const targetFingerprint = requireExpectedTargetFingerprint(env, parsed);
  const login = normalizedDatabaseUsername(parsed);
  requireExpectedLogin(
    env,
    "SOCIAL_DATABASE_EXPECTED_RUNTIME_LOGIN",
    login,
    "social_database_expected_runtime_login"
  );
  return Object.freeze({
    enabled: true,
    login,
    targetFingerprint,
    role: requireCanonicalRole(
      env.SOCIAL_DATABASE_RUNTIME_ROLE,
      SOCIAL_RUNTIME_ROLE,
      "social_database_runtime_role"
    ),
    pool: commonPoolConfig(parsed, env, "runtime")
  });
}

function loadMigrationPostgresConfig(env = process.env) {
  if (typeof env.DATABASE_URL === "string" && env.DATABASE_URL.trim()) {
    postgresFail(
      "migration_runtime_database_credential_forbidden",
      "Credencial PostgreSQL de runtime recusada no job de migration."
    );
  }
  const parsed = parseDatabaseUrl(
    env.SOCIAL_MIGRATIONS_DATABASE_URL,
    "social_migrations_database_url"
  );
  const ownerRole = requireCanonicalRole(
    env.SOCIAL_DATABASE_OWNER_ROLE,
    SOCIAL_OWNER_ROLE,
    "social_database_owner_role"
  );
  const migratorRole = requireCanonicalRole(
    env.SOCIAL_DATABASE_MIGRATOR_ROLE,
    SOCIAL_MIGRATOR_ROLE,
    "social_database_migrator_role"
  );
  requireRemotePassword(parsed, "social_migrations_database_url");
  const targetFingerprint = requireExpectedTargetFingerprint(env, parsed);
  const migrationLogin = normalizedDatabaseUsername(parsed);
  const runtimeLogin = requireCanonicalExpectedLogin(
    env,
    "SOCIAL_DATABASE_EXPECTED_RUNTIME_LOGIN",
    "social_database_expected_runtime_login"
  );
  requireExpectedLogin(
    env,
    "SOCIAL_MIGRATIONS_EXPECTED_LOGIN",
    migrationLogin,
    "social_migrations_expected_login"
  );
  if (
    runtimeLogin === migrationLogin
  ) {
    postgresFail(
      "migration_runtime_credentials_must_differ",
      "Credenciais de runtime e migration devem ser separadas."
    );
  }
  return Object.freeze({
    enabled: true,
    targetFingerprint,
    ownerRole,
    migratorRole,
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
      database: databaseName(parsed, "social_migrations_database_url"),
      username: migrationLogin
    })
  });
}

function assertWebServiceDatabaseCredentialBoundary(env = process.env) {
  // These switches affect the whole Node process. Refuse them even while
  // social persistence is disabled so a future enablement cannot inherit an
  // already-weakened trust policy.
  assertSystemTrustOnly(env);
  assertNoAmbientPostgresEnvironment(
    env,
    "web_service_libpq_environment_override_forbidden"
  );
  for (const [name, value] of Object.entries(env)) {
    const normalizedName = String(name || "").toUpperCase();
    if (
      WEB_SERVICE_OPERATOR_SECRET_NAMES.has(normalizedName) &&
      hasConfiguredValue(value)
    ) {
      postgresFail(
        "web_service_operator_secret_forbidden",
        "Segredo operacional recusado no Web Service."
      );
    }
    if (
      WEB_SERVICE_OPERATOR_ENVIRONMENT_PREFIXES.some((prefix) =>
        normalizedName.startsWith(prefix)
      ) &&
      hasConfiguredValue(value)
    ) {
      postgresFail(
        "web_service_operator_environment_forbidden",
        "Configuracao operacional recusada no Web Service."
      );
    }
    if (
      WEB_SERVICE_LIBPQ_ENVIRONMENT_NAMES.has(normalizedName) &&
      hasConfiguredValue(value)
    ) {
      postgresFail(
        "web_service_libpq_environment_override_forbidden",
        "Override ambiental libpq recusado no Web Service."
      );
    }
    if (
      OPERATOR_DATABASE_MARKER_PATTERN.test(normalizedName) &&
      (
        OPERATOR_SECRET_TOKEN_PATTERN.test(normalizedName) ||
        isOperatorDatabaseUrlName(normalizedName)
      ) &&
      hasConfiguredValue(value)
    ) {
      postgresFail(
        isOperatorDatabaseUrlName(normalizedName)
          ? "web_service_privileged_database_credential_forbidden"
          : "web_service_privileged_operator_secret_forbidden",
        "Credencial operacional privilegiada recusada no Web Service."
      );
    }
  }

  if (!explicitTrue(env.SOCIAL_PERSISTENCE_ENABLED)) {
    if (hasConfiguredValue(env.DATABASE_URL)) {
      postgresFail(
        "web_service_runtime_database_credential_disabled",
        "Credencial PostgreSQL recusada com persistencia social desativada."
      );
    }
    return true;
  }

  // Reuse the complete runtime parser so the Web Service boundary and the
  // pool cannot disagree about password, target, login, role or TLS policy.
  // loadRuntimePostgresConfig never calls this boundary.
  loadRuntimePostgresConfig(env);
  return true;
}

module.exports = {
  LOOPBACK_HOSTS,
  SOCIAL_MIGRATOR_ROLE,
  SOCIAL_OWNER_ROLE,
  SOCIAL_RUNTIME_ROLE,
  assertNoAmbientPostgresEnvironment,
  assertWebServiceDatabaseCredentialBoundary,
  databaseTargetFingerprint,
  explicitTrue,
  loadMigrationPostgresConfig,
  loadRuntimePostgresConfig,
  parseDatabaseUrl,
  requireCanonicalRole
};
