"use strict";

const crypto = require("node:crypto");
const {
  assertNoAmbientPostgresEnvironment
} = require("./config");
const { postgresFail, SocialPostgresError } = require("./errors");

const BOOTSTRAP_APPROVAL = "BOOTSTRAP_SOCIAL_DATABASE_LOGINS";
const BOOTSTRAP_LOCK_ID = "49703484320260729";
const OWNER_ROLE = "ia4tube_social_owner";
const MIGRATOR_ROLE = "ia4tube_social_migrator";
const RUNTIME_ROLE = "ia4tube_social_runtime";
const MIGRATION_CONNECTION_LIMIT = 2;
const RUNTIME_CONNECTION_LIMIT = 9;
const RESERVED_ROLES = new Set([OWNER_ROLE, MIGRATOR_ROLE, RUNTIME_ROLE]);
const LOGIN_NAME_PATTERN = /^[a-z][a-z0-9_]{2,62}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

const INFRASTRUCTURE_SQL = [
  "/* ia4tube_social_login_bootstrap_infrastructure */",
  "SELECT",
  "  current_setting('server_version_num')::integer >= 180000",
  "    AND current_setting('server_version_num')::integer < 190000",
  "    AS postgres_version_supported,",
  "  session_user = database_owner.rolname",
  "    AS provisioner_is_database_owner,",
  "  provisioner.rolcanlogin",
  "    AND NOT provisioner.rolsuper",
  "    AND provisioner.rolcreaterole",
  "    AND NOT provisioner.rolreplication",
  "    AND NOT provisioner.rolbypassrls",
  "    AS provisioner_safe,",
  "  NOT EXISTS (",
  "    SELECT 1",
  "    FROM pg_catalog.aclexplode(",
  "      COALESCE(",
  "        database_info.datacl,",
  "        pg_catalog.acldefault('d', database_info.datdba)",
  "      )",
  "    ) database_acl",
  "    WHERE database_acl.grantee = 0",
  "  ) AS public_database_acl_absent,",
  "  NOT EXISTS (",
  "    SELECT 1",
  "    FROM pg_catalog.pg_namespace public_schema",
  "    CROSS JOIN LATERAL pg_catalog.aclexplode(",
  "      COALESCE(",
  "        public_schema.nspacl,",
  "        pg_catalog.acldefault('n', public_schema.nspowner)",
  "      )",
  "    ) schema_acl",
  "    WHERE public_schema.nspname = 'public'",
  "      AND schema_acl.grantee = 0",
  "      AND schema_acl.privilege_type = 'CREATE'",
  "  ) AS public_schema_create_absent,",
  "  (",
  "    SELECT COUNT(*) = 3",
  "      AND BOOL_AND(",
  "        NOT role_info.rolcanlogin",
  "        AND NOT role_info.rolsuper",
  "        AND NOT role_info.rolcreatedb",
  "        AND NOT role_info.rolcreaterole",
  "        AND NOT role_info.rolinherit",
  "        AND NOT role_info.rolreplication",
  "        AND NOT role_info.rolbypassrls",
  "      )",
  "    FROM pg_catalog.pg_roles role_info",
  "    WHERE role_info.rolname = ANY($1::text[])",
  "  ) AS nologin_roles_exact,",
  "  (",
  "    SELECT COUNT(*) = 3",
  "      AND BOOL_AND(",
  "        membership.admin_option",
  "        AND NOT membership.inherit_option",
  "        AND NOT membership.set_option",
  "        AND member.oid = database_info.datdba",
  "        AND grantor.rolsuper",
  "      )",
  "    FROM pg_catalog.pg_auth_members membership",
  "    JOIN pg_catalog.pg_roles granted",
  "      ON granted.oid = membership.roleid",
  "    JOIN pg_catalog.pg_roles member",
  "      ON member.oid = membership.member",
  "    JOIN pg_catalog.pg_roles grantor",
  "      ON grantor.oid = membership.grantor",
  "    WHERE granted.rolname = ANY($1::text[])",
  "      AND member.oid = database_info.datdba",
  "  ) AS provisioner_admin_memberships_exact,",
  "  NOT EXISTS (",
  "    SELECT 1",
  "    FROM pg_catalog.pg_auth_members membership",
  "    JOIN pg_catalog.pg_roles granted",
  "      ON granted.oid = membership.roleid",
  "    JOIN pg_catalog.pg_roles member",
  "      ON member.oid = membership.member",
  "    JOIN pg_catalog.pg_roles grantor",
  "      ON grantor.oid = membership.grantor",
  "    WHERE granted.rolname = ANY($1::text[])",
  "      AND NOT (",
  "        (",
  "          member.oid = database_info.datdba",
  "          AND membership.admin_option",
  "          AND NOT membership.inherit_option",
  "          AND NOT membership.set_option",
  "          AND grantor.rolsuper",
  "        ) OR (",
  "          granted.rolname = $2",
  "          AND member.rolname = $3",
  "          AND NOT membership.admin_option",
  "          AND NOT membership.inherit_option",
  "          AND membership.set_option",
  "          AND grantor.oid = database_info.datdba",
  "        ) OR (",
  "          granted.rolname = $3",
  "          AND member.rolname = $5",
  "          AND NOT membership.admin_option",
  "          AND NOT membership.inherit_option",
  "          AND membership.set_option",
  "          AND grantor.oid = database_info.datdba",
  "        ) OR (",
  "          granted.rolname = $4",
  "          AND member.rolname = $6",
  "          AND NOT membership.admin_option",
  "          AND NOT membership.inherit_option",
  "          AND membership.set_option",
  "          AND grantor.oid = database_info.datdba",
  "        )",
  "      )",
  "  ) AS canonical_role_memberships_restricted,",
  "  (",
  "    SELECT COUNT(*) = 1",
  "      AND BOOL_AND(",
  "        NOT membership.admin_option",
  "        AND NOT membership.inherit_option",
  "        AND membership.set_option",
  "        AND grantor.oid = database_info.datdba",
  "      )",
  "    FROM pg_catalog.pg_auth_members membership",
  "    JOIN pg_catalog.pg_roles granted",
  "      ON granted.oid = membership.roleid",
  "    JOIN pg_catalog.pg_roles member",
  "      ON member.oid = membership.member",
  "    JOIN pg_catalog.pg_roles grantor",
  "      ON grantor.oid = membership.grantor",
  "    WHERE granted.rolname = $2",
  "      AND member.rolname = $3",
  "  ) AS owner_migrator_membership_exact,",
  "  (",
  "    SELECT COUNT(*) = 1",
  "      AND BOOL_AND(",
  "        granted.rolname = $2",
  "        AND member.rolname = $3",
  "        AND NOT membership.admin_option",
  "        AND NOT membership.inherit_option",
  "        AND membership.set_option",
  "      )",
  "      AND pg_catalog.pg_has_role($3, $2, 'MEMBER')",
  "      AND NOT pg_catalog.pg_has_role($4, $2, 'MEMBER')",
  "      AND NOT pg_catalog.pg_has_role($4, $3, 'MEMBER')",
  "      AND NOT pg_catalog.pg_has_role($2, $3, 'MEMBER')",
  "      AND NOT pg_catalog.pg_has_role($2, $4, 'MEMBER')",
  "      AND NOT pg_catalog.pg_has_role($3, $4, 'MEMBER')",
  "    FROM pg_catalog.pg_auth_members membership",
  "    JOIN pg_catalog.pg_roles granted",
  "      ON granted.oid = membership.roleid",
  "    JOIN pg_catalog.pg_roles member",
  "      ON member.oid = membership.member",
  "    WHERE member.rolname = ANY($1::text[])",
  "  ) AS canonical_role_topology_exact",
  "FROM pg_catalog.pg_database database_info",
  "JOIN pg_catalog.pg_roles database_owner",
  "  ON database_owner.oid = database_info.datdba",
  "JOIN pg_catalog.pg_roles provisioner",
  "  ON provisioner.rolname = session_user",
  "WHERE database_info.datname = current_database()"
].join("\n");

const LOGIN_INSPECTION_SQL = [
  "/* ia4tube_social_login_bootstrap_login */",
  "SELECT",
  "  login.rolcanlogin AS can_login,",
  "  login.rolsuper AS superuser,",
  "  login.rolcreatedb AS create_database,",
  "  login.rolcreaterole AS create_role,",
  "  login.rolinherit AS inherit,",
  "  login.rolreplication AS replication,",
  "  login.rolbypassrls AS bypass_rls,",
  "  login.rolconnlimit AS connection_limit,",
  "  login.rolconnlimit = $3 AS connection_limit_exact,",
  "  login.rolvaliduntil IS NULL AS valid_until_absent,",
  "  login.rolconfig IS NULL AS role_config_absent,",
  "  login.rolpassword IS NOT NULL AS password_present,",
  "  (",
  "    SELECT COUNT(*)",
  "    FROM pg_catalog.pg_auth_members membership",
  "    WHERE membership.member = login.oid",
  "  ) AS direct_membership_count,",
  "  (",
  "    SELECT COUNT(*) = 1",
  "      AND BOOL_AND(",
  "        NOT membership.admin_option",
  "        AND NOT membership.inherit_option",
  "        AND membership.set_option",
  "        AND granted.rolname = $2",
  "        AND NOT granted.rolcanlogin",
  "        AND grantor.oid = database_info.datdba",
  "      )",
  "    FROM pg_catalog.pg_auth_members membership",
  "    JOIN pg_catalog.pg_roles granted",
  "      ON granted.oid = membership.roleid",
  "    JOIN pg_catalog.pg_roles grantor",
  "      ON grantor.oid = membership.grantor",
  "    WHERE membership.member = login.oid",
  "  ) AS expected_membership_exact,",
  "  (",
  "    SELECT COUNT(*)",
  "    FROM pg_catalog.pg_auth_members membership",
  "    WHERE membership.roleid = login.oid",
  "  ) AS role_members_count,",
  "  (",
  "    SELECT COUNT(*) = 1",
  "      AND BOOL_AND(",
  "        membership.admin_option",
  "        AND NOT membership.inherit_option",
  "        AND NOT membership.set_option",
  "        AND member.oid = database_info.datdba",
  "        AND grantor.rolsuper",
  "      )",
  "    FROM pg_catalog.pg_auth_members membership",
  "    JOIN pg_catalog.pg_roles member",
  "      ON member.oid = membership.member",
  "    JOIN pg_catalog.pg_roles grantor",
  "      ON grantor.oid = membership.grantor",
  "    WHERE membership.roleid = login.oid",
  "  ) AS role_administration_exact,",
  "  (",
  "    SELECT COUNT(*)",
  "    FROM pg_catalog.aclexplode(",
  "      COALESCE(",
  "        database_info.datacl,",
  "        pg_catalog.acldefault('d', database_info.datdba)",
  "      )",
  "    ) database_acl",
  "    WHERE database_acl.grantee = login.oid",
  "  ) AS direct_database_acl_count,",
  "  (",
  "    SELECT COUNT(*) = 1",
  "      AND BOOL_AND(",
  "        database_acl.privilege_type = 'CONNECT'",
  "        AND NOT database_acl.is_grantable",
  "        AND database_acl.grantor = database_info.datdba",
  "      )",
  "    FROM pg_catalog.aclexplode(",
  "      COALESCE(",
  "        database_info.datacl,",
  "        pg_catalog.acldefault('d', database_info.datdba)",
  "      )",
  "    ) database_acl",
  "    WHERE database_acl.grantee = login.oid",
  "  ) AS direct_connect_exact,",
  "  pg_catalog.has_database_privilege(",
  "    login.oid, database_info.oid, 'CREATE'",
  "  ) AS database_create,",
  "  pg_catalog.has_database_privilege(",
  "    login.oid, database_info.oid, 'TEMP'",
  "  ) AS database_temp,",
  "  EXISTS (",
  "    SELECT 1",
  "    FROM pg_catalog.pg_namespace namespace",
  "    WHERE namespace.nspname !~ '^pg_'",
  "      AND namespace.nspname <> 'information_schema'",
  "      AND pg_catalog.has_schema_privilege(",
  "        login.oid, namespace.oid, 'CREATE'",
  "      )",
  "  ) AS schema_create,",
  "  EXISTS (",
  "    SELECT 1 FROM pg_catalog.pg_database owned_database",
  "    WHERE owned_database.datdba = login.oid",
  "  ) OR EXISTS (",
  "    SELECT 1 FROM pg_catalog.pg_namespace namespace",
  "    WHERE namespace.nspowner = login.oid",
  "  ) OR EXISTS (",
  "    SELECT 1 FROM pg_catalog.pg_class relation",
  "    WHERE relation.relowner = login.oid",
  "  ) OR EXISTS (",
  "    SELECT 1 FROM pg_catalog.pg_proc procedure",
  "    WHERE procedure.proowner = login.oid",
  "  ) OR EXISTS (",
  "    SELECT 1 FROM pg_catalog.pg_type type_info",
  "    WHERE type_info.typowner = login.oid",
  "  ) AS owns_objects,",
  "  EXISTS (",
  "    SELECT 1",
  "    FROM pg_catalog.pg_shdepend shared_dependency",
  "    WHERE shared_dependency.refclassid = 'pg_catalog.pg_authid'::regclass",
  "      AND shared_dependency.refobjid = login.oid",
  "      AND shared_dependency.deptype = 'o'",
  "  ) AS cluster_ownership_dependency,",
  "  EXISTS (",
  "    SELECT 1",
  "    FROM pg_catalog.pg_class relation",
  "    JOIN pg_catalog.pg_namespace namespace",
  "      ON namespace.oid = relation.relnamespace",
  "    WHERE relation.relkind IN ('r', 'p')",
  "      AND namespace.nspname !~ '^pg_'",
  "      AND namespace.nspname <> 'information_schema'",
  "      AND pg_catalog.has_table_privilege(",
  "        login.oid, relation.oid, 'TRUNCATE'",
  "      )",
  "  ) AS table_truncate",
  "FROM pg_catalog.pg_roles login",
  "JOIN pg_catalog.pg_database database_info",
  "  ON database_info.datname = current_database()",
  "WHERE login.rolname = $1"
].join("\n");

function fail(code) {
  postgresFail(code, "Bootstrap de logins PostgreSQL recusado.");
}

function requireString(value, code) {
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.trim()
  ) {
    fail(code);
  }
  return value;
}

function requireLoginName(value, field) {
  const name = requireString(value, `${field}_missing`);
  if (
    !LOGIN_NAME_PATTERN.test(name) ||
    name.startsWith("pg_") ||
    RESERVED_ROLES.has(name)
  ) {
    fail(`${field}_invalid`);
  }
  return name;
}

function requireStrongPassword(value, field, loginName) {
  const password = requireString(value, `${field}_missing`);
  if (
    password.length < 32 ||
    password.length > 256 ||
    /[\s\x00-\x1f\x7f]/.test(password) ||
    !/[a-z]/.test(password) ||
    !/[A-Z]/.test(password) ||
    !/[0-9]/.test(password) ||
    !/[^A-Za-z0-9]/.test(password) ||
    password.toLowerCase().includes(loginName.toLowerCase())
  ) {
    fail(`${field}_weak`);
  }
  return password;
}

function secretsEqual(left, right) {
  const leftDigest = crypto.createHash("sha256").update(left).digest();
  const rightDigest = crypto.createHash("sha256").update(right).digest();
  try {
    return crypto.timingSafeEqual(leftDigest, rightDigest);
  } finally {
    leftDigest.fill(0);
    rightDigest.fill(0);
  }
}

function decodeUrlComponent(value, code) {
  try {
    return decodeURIComponent(value);
  } catch {
    fail(code);
  }
}

function quoteIdentifier(value) {
  if (!LOGIN_NAME_PATTERN.test(value)) fail("postgres_identifier_invalid");
  return `"${value}"`;
}

function freezeWithHiddenSecret(properties, name, value) {
  const result = { ...properties };
  Object.defineProperty(result, name, {
    value,
    enumerable: false,
    writable: false,
    configurable: false
  });
  return Object.freeze(result);
}

function targetFingerprint(target) {
  return crypto
    .createHash("sha256")
    .update(
      [
        "ia4tube-social-login-bootstrap-v1",
        target.host,
        target.port,
        target.database,
        target.provisionerLogin,
        target.migrationLogin,
        target.runtimeLogin,
        "tls-verify-full"
      ].join("/")
    )
    .digest("hex");
}

function safeFingerprintEqual(actual, expected) {
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

function loadLoginBootstrapConfig(env = process.env) {
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    fail("login_bootstrap_tls_disabled");
  }
  assertNoAmbientPostgresEnvironment(
    env,
    "login_bootstrap_postgres_environment_override_forbidden"
  );
  if (
    requireString(
      env.SOCIAL_LOGIN_BOOTSTRAP_APPROVED,
      "login_bootstrap_approval_missing"
    ) !== BOOTSTRAP_APPROVAL
  ) {
    fail("login_bootstrap_approval_invalid");
  }

  const rawUrl = requireString(
    env.SOCIAL_LOGIN_BOOTSTRAP_PROVISIONER_DATABASE_URL,
    "login_bootstrap_provisioner_url_missing"
  );
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    fail("login_bootstrap_provisioner_url_invalid");
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
    queryKeys.length !== 1 ||
    queryKeys[0] !== "sslmode" ||
    parsed.searchParams.getAll("sslmode").length !== 1 ||
    parsed.searchParams.get("sslmode").toLowerCase() !== "verify-full"
  ) {
    fail("login_bootstrap_provisioner_url_invalid");
  }

  const host = parsed.hostname.toLowerCase();
  const port = parsed.port || "5432";
  const database = decodeUrlComponent(
    parsed.pathname.slice(1),
    "login_bootstrap_database_invalid"
  );
  if (!LOGIN_NAME_PATTERN.test(database)) {
    fail("login_bootstrap_database_invalid");
  }
  const provisionerLogin = decodeUrlComponent(
    parsed.username,
    "login_bootstrap_provisioner_login_invalid"
  ).toLowerCase();
  const provisionerPassword = decodeUrlComponent(
    parsed.password,
    "login_bootstrap_provisioner_password_invalid"
  );
  const expectedHost = requireString(
    env.SOCIAL_LOGIN_BOOTSTRAP_EXPECTED_HOST,
    "login_bootstrap_expected_host_missing"
  ).toLowerCase();
  const expectedDatabase = requireString(
    env.SOCIAL_LOGIN_BOOTSTRAP_EXPECTED_DATABASE,
    "login_bootstrap_expected_database_missing"
  );
  const expectedProvisioner = requireString(
    env.SOCIAL_LOGIN_BOOTSTRAP_EXPECTED_PROVISIONER_LOGIN,
    "login_bootstrap_expected_provisioner_missing"
  ).toLowerCase();
  if (
    host !== expectedHost ||
    database !== expectedDatabase ||
    provisionerLogin !== expectedProvisioner
  ) {
    fail("login_bootstrap_target_mismatch");
  }

  const migrationLogin = requireLoginName(
    env.SOCIAL_LOGIN_BOOTSTRAP_MIGRATION_LOGIN,
    "login_bootstrap_migration_login"
  );
  const runtimeLogin = requireLoginName(
    env.SOCIAL_LOGIN_BOOTSTRAP_RUNTIME_LOGIN,
    "login_bootstrap_runtime_login"
  );
  if (
    migrationLogin === runtimeLogin ||
    migrationLogin === provisionerLogin ||
    runtimeLogin === provisionerLogin
  ) {
    fail("login_bootstrap_logins_must_be_distinct");
  }
  const migrationPassword = requireStrongPassword(
    env.SOCIAL_LOGIN_BOOTSTRAP_MIGRATION_PASSWORD,
    "login_bootstrap_migration_password",
    migrationLogin
  );
  const runtimePassword = requireStrongPassword(
    env.SOCIAL_LOGIN_BOOTSTRAP_RUNTIME_PASSWORD,
    "login_bootstrap_runtime_password",
    runtimeLogin
  );
  if (secretsEqual(migrationPassword, runtimePassword)) {
    fail("login_bootstrap_passwords_must_be_distinct");
  }
  if (
    secretsEqual(migrationPassword, provisionerPassword) ||
    secretsEqual(runtimePassword, provisionerPassword)
  ) {
    fail("login_bootstrap_passwords_must_be_distinct");
  }

  const publicTarget = Object.freeze({
    host,
    port,
    database,
    provisionerLogin,
    migrationLogin,
    runtimeLogin
  });
  const actualFingerprint = targetFingerprint(publicTarget);
  const expectedFingerprint = requireString(
    env.SOCIAL_LOGIN_BOOTSTRAP_EXPECTED_TARGET_FINGERPRINT,
    "login_bootstrap_target_fingerprint_missing"
  ).toLowerCase();
  if (!safeFingerprintEqual(actualFingerprint, expectedFingerprint)) {
    fail("login_bootstrap_target_fingerprint_mismatch");
  }

  for (const key of [...parsed.searchParams.keys()]) {
    parsed.searchParams.delete(key);
  }
  const provisionerPool = freezeWithHiddenSecret(
    {
      ssl: Object.freeze({
        rejectUnauthorized: true,
        minVersion: "TLSv1.2",
        servername: host
      }),
      max: 1,
      min: 0,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 5000,
      query_timeout: 15000,
      application_name: "ia4tube-social-login-bootstrap",
      options: [
        "-c statement_timeout=10000",
        "-c lock_timeout=5000",
        "-c idle_in_transaction_session_timeout=5000",
        "-c search_path=pg_catalog"
      ].join(" "),
      allowExitOnIdle: false
    },
    "connectionString",
    parsed.toString()
  );
  return Object.freeze({
    target: publicTarget,
    targetFingerprint: actualFingerprint,
    provisionerPool,
    migration: freezeWithHiddenSecret(
      {
        login: migrationLogin,
        role: MIGRATOR_ROLE,
        connectionLimit: MIGRATION_CONNECTION_LIMIT
      },
      "password",
      migrationPassword
    ),
    runtime: freezeWithHiddenSecret(
      {
        login: runtimeLogin,
        role: RUNTIME_ROLE,
        connectionLimit: RUNTIME_CONNECTION_LIMIT
      },
      "password",
      runtimePassword
    )
  });
}

function validateInfrastructureSnapshot(row) {
  if (
    !row ||
    !row.postgres_version_supported ||
    !row.provisioner_is_database_owner ||
    !row.provisioner_safe ||
    !row.public_database_acl_absent ||
    !row.public_schema_create_absent ||
    !row.nologin_roles_exact ||
    !row.provisioner_admin_memberships_exact ||
    !row.canonical_role_memberships_restricted ||
    !row.owner_migrator_membership_exact ||
    !row.canonical_role_topology_exact
  ) {
    fail("login_bootstrap_infrastructure_drift");
  }
}

function validatePermanentInfrastructureSnapshot(row) {
  if (
    !row ||
    !row.public_database_acl_absent ||
    !row.public_schema_create_absent ||
    !row.nologin_roles_exact ||
    !row.provisioner_admin_memberships_exact ||
    !row.canonical_role_memberships_restricted ||
    !row.owner_migrator_membership_exact ||
    !row.canonical_role_topology_exact
  ) {
    fail("login_bootstrap_permanent_topology_drift");
  }
}

function asCount(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : -1;
}

function validateLoginSnapshot(row) {
  if (
    !row ||
    !row.can_login ||
    row.superuser ||
    row.create_database ||
    row.create_role ||
    row.inherit ||
    row.replication ||
    row.bypass_rls ||
    !row.connection_limit_exact ||
    !row.valid_until_absent ||
    !row.role_config_absent ||
    !row.password_present ||
    asCount(row.direct_membership_count) !== 1 ||
    !row.expected_membership_exact ||
    asCount(row.role_members_count) !== 1 ||
    !row.role_administration_exact ||
    asCount(row.direct_database_acl_count) !== 1 ||
    !row.direct_connect_exact ||
    row.database_create ||
    row.database_temp ||
    row.schema_create ||
    row.owns_objects ||
    row.cluster_ownership_dependency ||
    row.table_truncate
  ) {
    fail("login_bootstrap_login_drift");
  }
}

function validateExistingLoginSnapshot(row, entry) {
  if (row?.connection_limit_exact) {
    validateLoginSnapshot(row);
    return false;
  }
  if (
    entry.role === MIGRATOR_ROLE &&
    asCount(row?.connection_limit) === 1 &&
    entry.connectionLimit === MIGRATION_CONNECTION_LIMIT
  ) {
    validateLoginSnapshot({
      ...row,
      connection_limit_exact: true
    });
    return true;
  }
  validateLoginSnapshot(row);
  return false;
}

function validateBootstrapConfiguration(configuration) {
  if (
    !configuration ||
    !configuration.target ||
    !configuration.migration ||
    !configuration.runtime
  ) {
    fail("login_bootstrap_configuration_invalid");
  }
  if (!LOGIN_NAME_PATTERN.test(configuration.target.database)) {
    fail("login_bootstrap_database_invalid");
  }
  const migrationLogin = requireLoginName(
    configuration.migration.login,
    "login_bootstrap_migration_login"
  );
  const runtimeLogin = requireLoginName(
    configuration.runtime.login,
    "login_bootstrap_runtime_login"
  );
  if (
    configuration.migration.role !== MIGRATOR_ROLE ||
    configuration.runtime.role !== RUNTIME_ROLE
  ) {
    fail("login_bootstrap_role_mapping_invalid");
  }
  if (
    configuration.migration.connectionLimit !==
      MIGRATION_CONNECTION_LIMIT ||
    configuration.runtime.connectionLimit !== RUNTIME_CONNECTION_LIMIT
  ) {
    fail("login_bootstrap_connection_limit_invalid");
  }
  if (migrationLogin === runtimeLogin) {
    fail("login_bootstrap_logins_must_be_distinct");
  }
  if (
    configuration.target.migrationLogin !== migrationLogin ||
    configuration.target.runtimeLogin !== runtimeLogin
  ) {
    fail("login_bootstrap_configuration_target_mismatch");
  }
  const migrationPassword = requireStrongPassword(
    configuration.migration.password,
    "login_bootstrap_migration_password",
    migrationLogin
  );
  const runtimePassword = requireStrongPassword(
    configuration.runtime.password,
    "login_bootstrap_runtime_password",
    runtimeLogin
  );
  if (secretsEqual(migrationPassword, runtimePassword)) {
    fail("login_bootstrap_passwords_must_be_distinct");
  }
}

function loginPoolConfig(configuration, entry) {
  const parsed = new URL(configuration.provisionerPool.connectionString);
  parsed.username = entry.login;
  parsed.password = entry.password;
  return Object.freeze({
    ...configuration.provisionerPool,
    connectionString: parsed.toString(),
    application_name:
      entry.role === MIGRATOR_ROLE
        ? "ia4tube-social-migration-login-check"
        : "ia4tube-social-runtime-login-check"
  });
}

async function verifyOneLoginCredential(PoolClass, configuration, entry) {
  let pool;
  let client;
  let transactionStarted = false;
  try {
    pool = new PoolClass(loginPoolConfig(configuration, entry));
    client = await pool.connect();
    const session = await client.query(
      [
        "SELECT",
        "  session_user = $1 AS login_exact,",
        "  current_user = session_user AS role_not_assumed,",
        "  current_database() = $2 AS database_exact,",
        "  current_setting('is_superuser') = 'off' AS superuser_absent,",
        "  NOT pg_catalog.has_database_privilege(",
        "    session_user, current_database(), 'CREATE'",
        "  ) AS database_create_absent,",
        "  NOT pg_catalog.has_database_privilege(",
        "    session_user, current_database(), 'TEMP'",
        "  ) AS database_temp_absent"
      ].join("\n"),
      [entry.login, configuration.target.database]
    );
    const row = session.rows?.[0];
    if (
      !row ||
      !row.login_exact ||
      !row.role_not_assumed ||
      !row.database_exact ||
      !row.superuser_absent ||
      !row.database_create_absent ||
      !row.database_temp_absent
    ) {
      fail("login_bootstrap_credential_verification_failed");
    }

    await client.query("BEGIN");
    transactionStarted = true;
    await client.query(`SET LOCAL ROLE ${quoteIdentifier(entry.role)}`);
    const assumed = await client.query(
      [
        "SELECT",
        "  session_user = $1 AS login_exact,",
        "  current_user = $2 AS role_exact"
      ].join("\n"),
      [entry.login, entry.role]
    );
    const assumedRow = assumed.rows?.[0];
    if (!assumedRow?.login_exact || !assumedRow?.role_exact) {
      fail("login_bootstrap_credential_verification_failed");
    }
    await client.query("ROLLBACK");
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted && client) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Refuse with a stable code below. Driver errors can include config.
      }
    }
    if (
      error instanceof SocialPostgresError &&
      error.code === "login_bootstrap_credential_verification_failed"
    ) {
      throw error;
    }
    fail("login_bootstrap_credential_verification_failed");
  } finally {
    if (client && typeof client.release === "function") {
      try {
        client.release();
      } catch {
        // Never expose driver state from cleanup.
      }
    }
    if (pool && typeof pool.end === "function") {
      try {
        await pool.end();
      } catch {
        // Do not expose connection configuration through close errors.
      }
    }
  }
}

async function verifyProvisionedLoginCredentials(
  PoolClass,
  configuration
) {
  if (typeof PoolClass !== "function") {
    fail("login_bootstrap_pool_class_invalid");
  }
  validateBootstrapConfiguration(configuration);
  await verifyOneLoginCredential(
    PoolClass,
    configuration,
    configuration.migration
  );
  await verifyOneLoginCredential(
    PoolClass,
    configuration,
    configuration.runtime
  );
  return Object.freeze({ safe: true, verified: 2 });
}

async function inspectInfrastructure(client, configuration) {
  const result = await client.query(INFRASTRUCTURE_SQL, [
    [OWNER_ROLE, MIGRATOR_ROLE, RUNTIME_ROLE],
    OWNER_ROLE,
    MIGRATOR_ROLE,
    RUNTIME_ROLE,
    configuration.migration.login,
    configuration.runtime.login
  ]);
  const row = result.rows?.[0];
  validateInfrastructureSnapshot(row);
  return row;
}

async function inspectLogin(client, entry) {
  const result = await client.query(LOGIN_INSPECTION_SQL, [
    entry.login,
    entry.role,
    entry.connectionLimit
  ]);
  return result.rows?.[0] || null;
}

function permanentLoginEntries(input) {
  if (!input || typeof input !== "object") {
    fail("login_bootstrap_permanent_logins_invalid");
  }
  const migrationLogin = requireLoginName(
    input.migrationLogin,
    "login_bootstrap_migration_login"
  );
  const runtimeLogin = requireLoginName(
    input.runtimeLogin,
    "login_bootstrap_runtime_login"
  );
  if (migrationLogin === runtimeLogin) {
    fail("login_bootstrap_logins_must_be_distinct");
  }
  return Object.freeze([
    Object.freeze({
      kind: "migration",
      login: migrationLogin,
      role: MIGRATOR_ROLE,
      connectionLimit: MIGRATION_CONNECTION_LIMIT
    }),
    Object.freeze({
      kind: "runtime",
      login: runtimeLogin,
      role: RUNTIME_ROLE,
      connectionLimit: RUNTIME_CONNECTION_LIMIT
    })
  ]);
}

async function inspectPermanentDatabaseLogins(client, input) {
  if (!client || typeof client.query !== "function") {
    fail("login_bootstrap_client_invalid");
  }
  const entries = permanentLoginEntries(input);
  const infrastructure = await client.query(INFRASTRUCTURE_SQL, [
    [OWNER_ROLE, MIGRATOR_ROLE, RUNTIME_ROLE],
    OWNER_ROLE,
    MIGRATOR_ROLE,
    RUNTIME_ROLE,
    entries[0].login,
    entries[1].login
  ]);
  validatePermanentInfrastructureSnapshot(infrastructure.rows?.[0]);
  const result = {};
  for (const entry of entries) {
    const snapshot = await inspectLogin(client, entry);
    validateLoginSnapshot(snapshot);
    result[entry.kind] = Object.freeze({
      login: entry.login,
      role: entry.role,
      connectionLimit: entry.connectionLimit,
      validated: true
    });
  }
  return Object.freeze(result);
}

async function createLogin(client, entry, database) {
  await client.query(
    [
      "SELECT",
      "  pg_catalog.set_config(",
      "    'ia4tube.login_bootstrap.login', $1, true",
      "  ) IS NOT NULL AS login_configured,",
      "  pg_catalog.set_config(",
      "    'ia4tube.login_bootstrap.password', $2, true",
      "  ) IS NOT NULL AS password_configured"
    ].join("\n"),
    [entry.login, entry.password]
  );
  try {
    await client.query(
      [
        "DO $ia4tube_login_bootstrap$",
        "DECLARE",
        "  bootstrap_login TEXT :=",
        "    current_setting('ia4tube.login_bootstrap.login');",
        "  bootstrap_password TEXT :=",
        "    current_setting('ia4tube.login_bootstrap.password');",
        "BEGIN",
        "  IF EXISTS (",
        "    SELECT 1 FROM pg_catalog.pg_roles",
        "    WHERE rolname = bootstrap_login",
        "  ) THEN",
        "    RAISE EXCEPTION 'ia4tube_social_login_race_detected';",
        "  END IF;",
        "  EXECUTE format(",
        "    'CREATE ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB ' ||",
        "    'NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS ' ||",
        `    'CONNECTION LIMIT ${entry.connectionLimit} PASSWORD %L',`,
        "    bootstrap_login, bootstrap_password",
        "  );",
        "END",
        "$ia4tube_login_bootstrap$;"
      ].join("\n")
    );
  } finally {
    await client.query(
      [
        "SELECT",
        "  pg_catalog.set_config(",
        "    'ia4tube.login_bootstrap.password', '', true",
        "  ) = '' AS password_cleared"
      ].join("\n")
    );
  }

  await client.query(
    [
      `GRANT ${quoteIdentifier(entry.role)} TO ${quoteIdentifier(entry.login)}`,
      "  WITH ADMIN FALSE, INHERIT FALSE, SET TRUE",
      "  GRANTED BY CURRENT_USER"
    ].join("\n")
  );
  await client.query(
    [
      `GRANT CONNECT ON DATABASE ${quoteIdentifier(database)}`,
      `  TO ${quoteIdentifier(entry.login)}`
    ].join("\n")
  );
}

async function updateLegacyMigrationConnectionLimit(client, entry) {
  if (
    entry.role !== MIGRATOR_ROLE ||
    entry.connectionLimit !== MIGRATION_CONNECTION_LIMIT
  ) {
    fail("login_bootstrap_connection_limit_upgrade_invalid");
  }
  await client.query(
    `ALTER ROLE ${quoteIdentifier(entry.login)} ` +
      `CONNECTION LIMIT ${MIGRATION_CONNECTION_LIMIT}`
  );
}

async function bootstrapDatabaseLogins(pool, configuration) {
  if (!pool || typeof pool.connect !== "function") {
    fail("login_bootstrap_pool_invalid");
  }
  validateBootstrapConfiguration(configuration);

  const client = await pool.connect();
  let transactionStarted = false;
  let discardClient = false;
  try {
    await client.query("BEGIN");
    transactionStarted = true;
    await client.query("SET LOCAL password_encryption = 'scram-sha-256'");
    await client.query("SET LOCAL createrole_self_grant = ''");
    await client.query(
      "SELECT pg_catalog.pg_advisory_xact_lock($1::bigint)",
      [BOOTSTRAP_LOCK_ID]
    );
    await inspectInfrastructure(client, configuration);

    const entries = [configuration.migration, configuration.runtime];
    const before = [];
    const connectionLimitUpgrades = [];
    for (const entry of entries) {
      const snapshot = await inspectLogin(client, entry);
      const needsUpgrade = snapshot
        ? validateExistingLoginSnapshot(snapshot, entry)
        : false;
      before.push(snapshot);
      connectionLimitUpgrades.push(needsUpgrade);
    }

    const created = [];
    for (let index = 0; index < entries.length; index += 1) {
      if (before[index]) {
        if (connectionLimitUpgrades[index]) {
          await updateLegacyMigrationConnectionLimit(
            client,
            entries[index]
          );
        }
        created.push(false);
        continue;
      }
      await createLogin(client, entries[index], configuration.target.database);
      created.push(true);
    }

    await inspectInfrastructure(client, configuration);
    for (const entry of entries) {
      validateLoginSnapshot(
        await inspectLogin(client, entry)
      );
    }
    await client.query("COMMIT");
    transactionStarted = false;
    return Object.freeze({
      safe: true,
      created: Object.freeze({
        migration: created[0],
        runtime: created[1]
      }),
      migrationConnectionLimitUpdated: connectionLimitUpgrades[0]
    });
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch {
        discardClient = true;
        if (typeof client.release === "function") {
          client.release(new Error("login_bootstrap_rollback_failed"));
        }
        throw new SocialPostgresError(
          "login_bootstrap_rollback_failed",
          "Rollback do bootstrap PostgreSQL nao foi confirmado."
        );
      }
    }
    if (
      error instanceof SocialPostgresError &&
      String(error.code || "").startsWith("login_bootstrap_")
    ) {
      throw error;
    }
    fail("login_bootstrap_failed");
  } finally {
    if (!discardClient && typeof client.release === "function") {
      client.release();
    }
  }
}

module.exports = {
  BOOTSTRAP_APPROVAL,
  BOOTSTRAP_LOCK_ID,
  INFRASTRUCTURE_SQL,
  LOGIN_INSPECTION_SQL,
  MIGRATION_CONNECTION_LIMIT,
  MIGRATOR_ROLE,
  OWNER_ROLE,
  RUNTIME_ROLE,
  RUNTIME_CONNECTION_LIMIT,
  bootstrapDatabaseLogins,
  inspectPermanentDatabaseLogins,
  loadLoginBootstrapConfig,
  targetFingerprint,
  validateBootstrapConfiguration,
  validateInfrastructureSnapshot,
  validateExistingLoginSnapshot,
  validatePermanentInfrastructureSnapshot,
  validateLoginSnapshot,
  verifyProvisionedLoginCredentials
};
