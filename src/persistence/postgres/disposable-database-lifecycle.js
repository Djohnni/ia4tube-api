"use strict";

const crypto = require("node:crypto");
const net = require("node:net");
const {
  assertNoAmbientPostgresEnvironment
} = require("./config");
const { SocialPostgresError, postgresFail } = require("./errors");
const { loadSystemPostgresTls } = require("./tls");
const { requireUuid } = require("./validation");
const {
  PAID_STAGING_PUBLIC_TARGET
} = require("./staging-provisioner");
const {
  inspectPermanentDatabaseLogins
} = require("./login-bootstrap");

const DISPOSABLE_DATABASE_NAME =
  "ia4tube_social_staging_disposable_gate_20260729";
const RESTORE_DISPOSABLE_DATABASE_NAME =
  "ia4tube_social_disposable_restore_20260729";
const CREATE_APPROVAL_PREFIX =
  "CREATE_SOCIAL_POSTGRES_DISPOSABLE:";
const DROP_APPROVAL_PREFIX =
  "DROP_SOCIAL_POSTGRES_DISPOSABLE:";
const RESTORE_CREATE_APPROVAL_PREFIX =
  "CREATE_SOCIAL_POSTGRES_RESTORE_DISPOSABLE:";
const RESTORE_DROP_APPROVAL_PREFIX =
  "DROP_SOCIAL_POSTGRES_RESTORE_DISPOSABLE:";
const ALLOWED_ACTIONS = new Set(["create", "drop"]);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const DISPOSABLE_TARGETS = Object.freeze({
  [DISPOSABLE_DATABASE_NAME]: Object.freeze({
    purpose: "physical-gate",
    database: DISPOSABLE_DATABASE_NAME,
    markerVersion:
      "ia4tube-social-staging-disposable-lifecycle-v1",
    createApprovalPrefix: CREATE_APPROVAL_PREFIX,
    dropApprovalPrefix: DROP_APPROVAL_PREFIX,
    restoreTopology: false
  }),
  [RESTORE_DISPOSABLE_DATABASE_NAME]: Object.freeze({
    purpose: "backup-restore",
    database: RESTORE_DISPOSABLE_DATABASE_NAME,
    markerVersion:
      "ia4tube-social-restore-disposable-lifecycle-v1",
    createApprovalPrefix: RESTORE_CREATE_APPROVAL_PREFIX,
    dropApprovalPrefix: RESTORE_DROP_APPROVAL_PREFIX,
    restoreTopology: true
  })
});
const RESTORE_TOPOLOGY_MUTATIONS = Object.freeze([
  `REVOKE ALL ON DATABASE "${RESTORE_DISPOSABLE_DATABASE_NAME}" FROM PUBLIC`,
  `REVOKE ALL ON DATABASE "${RESTORE_DISPOSABLE_DATABASE_NAME}" FROM ` +
    '"ia4tube_social_owner", "ia4tube_social_migrator", ' +
    '"ia4tube_social_runtime", ' +
    `"${PAID_STAGING_PUBLIC_TARGET.migrationLogin}", ` +
    `"${PAID_STAGING_PUBLIC_TARGET.runtimeLogin}"`,
  `GRANT CREATE ON DATABASE "${RESTORE_DISPOSABLE_DATABASE_NAME}" ` +
    'TO "ia4tube_social_owner"',
  `GRANT CONNECT ON DATABASE "${RESTORE_DISPOSABLE_DATABASE_NAME}" ` +
    `TO "${PAID_STAGING_PUBLIC_TARGET.migrationLogin}", ` +
    `"${PAID_STAGING_PUBLIC_TARGET.runtimeLogin}"`,
  "REVOKE CREATE ON SCHEMA public FROM PUBLIC"
]);
const RESTORE_TOPOLOGY_INSPECTION_SQL = [
  "SELECT",
  "  current_database() = $1 AS database_exact,",
  "  session_user = $2 AS provisioner_exact,",
  "  database_owner.rolname = $2 AS owner_exact,",
  "  (",
  "    SELECT COUNT(*) = 3",
  "      AND BOOL_AND(",
  "        database_acl.grantor = database_info.datdba",
  "        AND NOT database_acl.is_grantable",
  "        AND (",
  "          (",
  "            grantee.rolname = 'ia4tube_social_owner'",
  "            AND database_acl.privilege_type = 'CREATE'",
  "          ) OR (",
  "            grantee.rolname = $3",
  "            AND database_acl.privilege_type = 'CONNECT'",
  "          ) OR (",
  "            grantee.rolname = $4",
  "            AND database_acl.privilege_type = 'CONNECT'",
  "          )",
  "        )",
  "      )",
  "    FROM pg_catalog.aclexplode(",
  "      COALESCE(",
  "        database_info.datacl,",
  "        pg_catalog.acldefault('d', database_info.datdba)",
  "      )",
  "    ) database_acl",
  "    LEFT JOIN pg_catalog.pg_roles grantee",
  "      ON grantee.oid = database_acl.grantee",
  "    WHERE database_acl.grantee <> database_info.datdba",
  "  ) AS non_owner_database_acl_exact,",
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
  "  pg_catalog.has_database_privilege(",
  "    'ia4tube_social_owner', database_info.oid, 'CREATE'",
  "  ) AS owner_create_present,",
  "  pg_catalog.has_database_privilege(",
  "    $3, database_info.oid, 'CONNECT'",
  "  ) AND NOT pg_catalog.has_database_privilege(",
  "    $3, database_info.oid, 'CREATE'",
  "  ) AND NOT pg_catalog.has_database_privilege(",
  "    $3, database_info.oid, 'TEMP'",
  "  ) AS migration_database_acl_exact,",
  "  pg_catalog.has_database_privilege(",
  "    $4, database_info.oid, 'CONNECT'",
  "  ) AND NOT pg_catalog.has_database_privilege(",
  "    $4, database_info.oid, 'CREATE'",
  "  ) AND NOT pg_catalog.has_database_privilege(",
  "    $4, database_info.oid, 'TEMP'",
  "  ) AS runtime_database_acl_exact,",
  "  NOT EXISTS (",
  "    SELECT 1",
  "    FROM pg_catalog.pg_namespace namespace",
  "    WHERE namespace.nspname IN (",
  "      'ia4tube_social',",
  "      'ia4tube_social_admin',",
  "      'ia4tube_migrations'",
  "    )",
  "  ) AS application_schemas_absent,",
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
  "  ) AS public_schema_create_absent",
  "FROM pg_catalog.pg_database database_info",
  "JOIN pg_catalog.pg_roles database_owner",
  "  ON database_owner.oid = database_info.datdba",
  "WHERE database_info.datname = current_database()"
].join("\n");

function fail(code) {
  postgresFail(
    code,
    "Ciclo do banco PostgreSQL descartavel recusado."
  );
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

function requireDisposableTarget(database = DISPOSABLE_DATABASE_NAME) {
  const target = Object.prototype.hasOwnProperty.call(
    DISPOSABLE_TARGETS,
    database
  )
    ? DISPOSABLE_TARGETS[database]
    : null;
  if (!target) {
    fail("staging_disposable_expected_target_mismatch");
  }
  return target;
}

function disposableDatabaseTargetFingerprint(
  database = DISPOSABLE_DATABASE_NAME
) {
  const target = requireDisposableTarget(database);
  return crypto
    .createHash("sha256")
    .update(
      [
        target.markerVersion,
        PAID_STAGING_PUBLIC_TARGET.environmentId,
        PAID_STAGING_PUBLIC_TARGET.host,
        PAID_STAGING_PUBLIC_TARGET.port,
        PAID_STAGING_PUBLIC_TARGET.database,
        target.database,
        PAID_STAGING_PUBLIC_TARGET.provisionerLogin,
        target.purpose,
        "postgresql-18",
        "tls-verify-full"
      ].join("/")
    )
    .digest("hex");
}

function disposableDatabaseLifecycleMarker(
  database = DISPOSABLE_DATABASE_NAME
) {
  const target = requireDisposableTarget(database);
  return (
    `${target.markerVersion}:` +
    disposableDatabaseTargetFingerprint(target.database)
  );
}

function createDatabaseSql(database) {
  const target = requireDisposableTarget(database);
  return (
    `CREATE DATABASE "${target.database}" ` +
    `WITH OWNER = "${PAID_STAGING_PUBLIC_TARGET.provisionerLogin}" ` +
    "TEMPLATE = template0 ENCODING = 'UTF8'"
  );
}

function commentDatabaseSql(database) {
  const target = requireDisposableTarget(database);
  return (
    `COMMENT ON DATABASE "${target.database}" IS '` +
    `${disposableDatabaseLifecycleMarker(target.database)}'`
  );
}

function dropDatabaseSql(database) {
  const target = requireDisposableTarget(database);
  return `DROP DATABASE "${target.database}" WITH (FORCE)`;
}

function hiddenPoolConfig(properties, connectionString) {
  const result = { ...properties };
  Object.defineProperty(result, "connectionString", {
    value: connectionString,
    enumerable: false,
    writable: false,
    configurable: false
  });
  return Object.freeze(result);
}

function poolConfig(env, connectionString, database, applicationName) {
  return hiddenPoolConfig(
    {
      ssl: loadSystemPostgresTls(
        env,
        PAID_STAGING_PUBLIC_TARGET.host
      ),
      max: 1,
      min: 0,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 5000,
      query_timeout: 30000,
      application_name: applicationName,
      options: [
        "-c statement_timeout=25000",
        "-c lock_timeout=5000",
        "-c idle_in_transaction_session_timeout=5000",
        "-c search_path=pg_catalog"
      ].join(" "),
      database
    },
    connectionString
  );
}

function expectedApproval(
  action,
  environmentId,
  fingerprint,
  target
) {
  const prefix =
    action === "create"
      ? target.createApprovalPrefix
      : target.dropApprovalPrefix;
  return `${prefix}${environmentId}:${fingerprint}`;
}

function loadDisposableDatabaseLifecycleConfig(env = process.env) {
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    fail("staging_disposable_tls_disabled");
  }
  assertNoAmbientPostgresEnvironment(
    env,
    "staging_disposable_postgres_environment_override_forbidden"
  );

  const action = requireText(
    env.SOCIAL_STAGING_DISPOSABLE_DATABASE_ACTION,
    "staging_disposable_action_missing"
  ).toLowerCase();
  if (
    !ALLOWED_ACTIONS.has(action) ||
    action !== env.SOCIAL_STAGING_DISPOSABLE_DATABASE_ACTION
  ) {
    fail("staging_disposable_action_invalid");
  }

  const environmentId = requireUuid(
    env.SOCIAL_STAGING_DISPOSABLE_EXPECTED_ENVIRONMENT_ID,
    "staging_disposable_expected_environment_id"
  ).toLowerCase();
  const expectedHost = requireText(
    env.SOCIAL_STAGING_DISPOSABLE_EXPECTED_HOST,
    "staging_disposable_expected_host_missing"
  ).toLowerCase();
  const expectedPort = requireText(
    env.SOCIAL_STAGING_DISPOSABLE_EXPECTED_PORT,
    "staging_disposable_expected_port_missing"
  );
  const expectedParentDatabase = requireText(
    env.SOCIAL_STAGING_DISPOSABLE_EXPECTED_PARENT_DATABASE,
    "staging_disposable_expected_parent_database_missing"
  );
  const expectedDisposableDatabase = requireText(
    env.SOCIAL_STAGING_DISPOSABLE_EXPECTED_DATABASE,
    "staging_disposable_expected_database_missing"
  );
  const disposableTarget = requireDisposableTarget(
    expectedDisposableDatabase
  );
  const expectedProvisionerLogin = requireText(
    env.SOCIAL_STAGING_DISPOSABLE_EXPECTED_PROVISIONER_LOGIN,
    "staging_disposable_expected_login_missing"
  );

  if (
    environmentId !== PAID_STAGING_PUBLIC_TARGET.environmentId ||
    expectedHost !== PAID_STAGING_PUBLIC_TARGET.host ||
    expectedPort !== PAID_STAGING_PUBLIC_TARGET.port ||
    expectedParentDatabase !== PAID_STAGING_PUBLIC_TARGET.database ||
    expectedDisposableDatabase !== disposableTarget.database ||
    expectedProvisionerLogin !==
      PAID_STAGING_PUBLIC_TARGET.provisionerLogin
  ) {
    fail("staging_disposable_expected_target_mismatch");
  }

  const fingerprint = disposableDatabaseTargetFingerprint(
    disposableTarget.database
  );
  const suppliedFingerprint = requireText(
    env.SOCIAL_STAGING_DISPOSABLE_EXPECTED_TARGET_FINGERPRINT,
    "staging_disposable_target_fingerprint_missing"
  );
  if (!equalFingerprint(fingerprint, suppliedFingerprint)) {
    fail("staging_disposable_target_fingerprint_mismatch");
  }
  const approval = requireText(
    env.SOCIAL_STAGING_DISPOSABLE_DATABASE_APPROVED,
    "staging_disposable_approval_missing"
  );
  if (
    approval !==
    expectedApproval(
      action,
      environmentId,
      fingerprint,
      disposableTarget
    )
  ) {
    fail("staging_disposable_approval_invalid");
  }

  const rawUrl = requireText(
    env.SOCIAL_STAGING_DISPOSABLE_PROVISIONER_DATABASE_URL,
    "staging_disposable_provisioner_url_missing"
  );
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    fail("staging_disposable_provisioner_url_invalid");
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
    queryKeys.length !== 1 ||
    queryKeys[0] !== "sslmode" ||
    parsed.searchParams.getAll("sslmode").length !== 1 ||
    parsed.searchParams.get("sslmode").toLowerCase() !== "verify-full"
  ) {
    fail("staging_disposable_provisioner_url_invalid");
  }

  const host = parsed.hostname.toLowerCase();
  const port = parsed.port || "5432";
  const parentDatabase = decodeUrlPart(
    parsed.pathname.slice(1),
    "staging_disposable_parent_database_invalid"
  );
  const provisionerLogin = decodeUrlPart(
    parsed.username,
    "staging_disposable_provisioner_login_invalid"
  );
  if (
    host !== PAID_STAGING_PUBLIC_TARGET.host ||
    port !== PAID_STAGING_PUBLIC_TARGET.port ||
    parentDatabase !== PAID_STAGING_PUBLIC_TARGET.database ||
    provisionerLogin !==
      PAID_STAGING_PUBLIC_TARGET.provisionerLogin
  ) {
    fail("staging_disposable_target_mismatch");
  }

  for (const key of [...parsed.searchParams.keys()]) {
    parsed.searchParams.delete(key);
  }
  const parentUrl = parsed.toString();
  const disposableUrl = new URL(parentUrl);
  disposableUrl.pathname = `/${disposableTarget.database}`;

  return Object.freeze({
    action,
    purpose: disposableTarget.purpose,
    restoreTopology: disposableTarget.restoreTopology,
    targetFingerprint: fingerprint,
    permanentLogins: disposableTarget.restoreTopology
      ? Object.freeze({
          migrationLogin: PAID_STAGING_PUBLIC_TARGET.migrationLogin,
          runtimeLogin: PAID_STAGING_PUBLIC_TARGET.runtimeLogin
        })
      : null,
    target: Object.freeze({
      environmentId,
      host,
      port,
      parentDatabase,
      disposableDatabase: disposableTarget.database,
      provisionerLogin
    }),
    parentPool: poolConfig(
      env,
      parentUrl,
      parentDatabase,
      "ia4tube-social-disposable-parent"
    ),
    disposablePool: poolConfig(
      env,
      disposableUrl.toString(),
      disposableTarget.database,
      disposableTarget.restoreTopology
        ? "ia4tube-social-restore-disposable-identity"
        : "ia4tube-social-disposable-identity"
    )
  });
}

async function inspectSessionIdentity(
  client,
  configuration,
  expectedDatabase
) {
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
      "  session_role.rolcreatedb AS provisioner_createdb,",
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
    row.database_name !== expectedDatabase ||
    row.current_user_name !==
      configuration.target.provisionerLogin ||
    row.session_user_name !==
      configuration.target.provisionerLogin ||
    row.database_owner !== configuration.target.provisionerLogin ||
    Number(row.version_num) < 180000 ||
    Number(row.version_num) >= 190000 ||
    row.read_only !== "off" ||
    row.datistemplate ||
    !row.datallowconn ||
    !row.provisioner_canlogin ||
    row.provisioner_superuser ||
    !row.provisioner_createdb ||
    !row.provisioner_createrole ||
    row.provisioner_replication ||
    row.provisioner_bypassrls
  ) {
    fail("staging_disposable_database_identity_invalid");
  }
  return true;
}

async function inspectDisposableCatalog(client, configuration) {
  const result = await client.query(
    [
      "SELECT database_info.datname AS database_name,",
      "  owner.rolname AS database_owner,",
      "  pg_catalog.pg_encoding_to_char(",
      "    database_info.encoding",
      "  ) AS database_encoding,",
      "  database_info.datistemplate,",
      "  database_info.datallowconn,",
      "  pg_catalog.shobj_description(",
      "    database_info.oid, 'pg_database'",
      "  ) AS lifecycle_marker",
      "FROM pg_catalog.pg_database database_info",
      "JOIN pg_catalog.pg_roles owner",
      "  ON owner.oid = database_info.datdba",
      "WHERE database_info.datname = $1"
    ].join("\n"),
    [configuration.target.disposableDatabase]
  );
  if (result.rowCount === 0) return null;
  const row = result.rows?.[0];
  if (
    result.rowCount !== 1 ||
    !row ||
    row.database_name !== configuration.target.disposableDatabase ||
    row.database_owner !== configuration.target.provisionerLogin ||
    row.database_encoding !== "UTF8" ||
    row.datistemplate ||
    !row.datallowconn
  ) {
    fail("staging_disposable_catalog_identity_invalid");
  }
  return row;
}

function assertDisposableLifecycleMarker(
  row,
  database = DISPOSABLE_DATABASE_NAME
) {
  if (
    !row ||
    row.lifecycle_marker !==
      disposableDatabaseLifecycleMarker(database)
  ) {
    fail("staging_disposable_lifecycle_marker_mismatch");
  }
  return true;
}

function assertPools(parentPool, disposablePool) {
  if (
    !parentPool ||
    typeof parentPool.connect !== "function" ||
    !disposablePool ||
    typeof disposablePool.connect !== "function"
  ) {
    fail("staging_disposable_pool_invalid");
  }
}

function releaseClient(client) {
  if (client && typeof client.release === "function") {
    client.release();
  }
}

async function closeDisposablePool(pool, lifecycleState) {
  if (!pool || typeof pool.end !== "function") {
    fail("staging_disposable_pool_close_failed");
  }
  try {
    await pool.end();
  } catch {
    fail("staging_disposable_pool_close_failed");
  }
  if (lifecycleState && typeof lifecycleState === "object") {
    lifecycleState.disposablePoolClosed = true;
  }
}

function preserveLifecycleError(error, fallbackCode) {
  if (
    error instanceof SocialPostgresError &&
    String(error.code || "").startsWith("staging_disposable_")
  ) {
    throw error;
  }
  fail(fallbackCode);
}

async function verifyDisposableConnection(
  disposablePool,
  configuration
) {
  let client;
  try {
    client = await disposablePool.connect();
    await inspectSessionIdentity(
      client,
      configuration,
      configuration.target.disposableDatabase
    );
    return true;
  } catch (error) {
    preserveLifecycleError(
      error,
      "staging_disposable_verification_failed"
    );
  } finally {
    releaseClient(client);
  }
}

function validateRestoreTopologySnapshot(row) {
  if (
    !row ||
    !row.database_exact ||
    !row.provisioner_exact ||
    !row.owner_exact ||
    !row.non_owner_database_acl_exact ||
    !row.public_database_acl_absent ||
    !row.owner_create_present ||
    !row.migration_database_acl_exact ||
    !row.runtime_database_acl_exact ||
    !row.application_schemas_absent ||
    !row.public_schema_create_absent
  ) {
    fail("staging_disposable_restore_topology_invalid");
  }
  return true;
}

async function inspectRestoreTopology(client, configuration) {
  if (
    !client ||
    typeof client.query !== "function" ||
    configuration?.restoreTopology !== true ||
    configuration?.target?.disposableDatabase !==
      RESTORE_DISPOSABLE_DATABASE_NAME ||
    configuration?.permanentLogins?.migrationLogin !==
      PAID_STAGING_PUBLIC_TARGET.migrationLogin ||
    configuration?.permanentLogins?.runtimeLogin !==
      PAID_STAGING_PUBLIC_TARGET.runtimeLogin
  ) {
    fail("staging_disposable_restore_topology_config_invalid");
  }
  const result = await client.query(
    RESTORE_TOPOLOGY_INSPECTION_SQL,
    [
      RESTORE_DISPOSABLE_DATABASE_NAME,
      PAID_STAGING_PUBLIC_TARGET.provisionerLogin,
      PAID_STAGING_PUBLIC_TARGET.migrationLogin,
      PAID_STAGING_PUBLIC_TARGET.runtimeLogin
    ]
  );
  if (result.rowCount !== 1) {
    fail("staging_disposable_restore_topology_invalid");
  }
  validateRestoreTopologySnapshot(result.rows?.[0]);
  return true;
}

async function prepareRestoreTopology(
  disposablePool,
  configuration
) {
  if (
    !disposablePool ||
    typeof disposablePool.connect !== "function" ||
    configuration?.action !== "create" ||
    configuration?.restoreTopology !== true ||
    configuration?.target?.disposableDatabase !==
      RESTORE_DISPOSABLE_DATABASE_NAME
  ) {
    fail("staging_disposable_restore_topology_config_invalid");
  }

  let client;
  let transactionStarted = false;
  let discardClient = false;
  try {
    client = await disposablePool.connect();
    await inspectSessionIdentity(
      client,
      configuration,
      RESTORE_DISPOSABLE_DATABASE_NAME
    );
    await client.query("BEGIN");
    transactionStarted = true;
    for (const statement of RESTORE_TOPOLOGY_MUTATIONS) {
      await client.query(statement);
    }
    await inspectPermanentDatabaseLogins(
      client,
      configuration.permanentLogins
    );
    await inspectRestoreTopology(client, configuration);
    await client.query("COMMIT");
    transactionStarted = false;
    return Object.freeze({
      safe: true,
      restoreTopologyPrepared: true
    });
  } catch (error) {
    if (transactionStarted && client) {
      try {
        await client.query("ROLLBACK");
      } catch {
        discardClient = true;
        if (typeof client.release === "function") {
          client.release(
            new Error(
              "staging_disposable_restore_topology_rollback_failed"
            )
          );
        }
        fail(
          "staging_disposable_restore_topology_rollback_failed"
        );
      }
    }
    preserveLifecycleError(
      error,
      "staging_disposable_restore_topology_failed"
    );
  } finally {
    if (
      !discardClient &&
      client &&
      typeof client.release === "function"
    ) {
      client.release();
    }
  }
}

async function createDisposableDatabase(
  parentPool,
  disposablePool,
  configuration
) {
  assertPools(parentPool, disposablePool);
  if (configuration?.action !== "create") {
    fail("staging_disposable_create_action_invalid");
  }

  let parentClient;
  try {
    parentClient = await parentPool.connect();
    await inspectSessionIdentity(
      parentClient,
      configuration,
      configuration.target.parentDatabase
    );
    const before = await inspectDisposableCatalog(
      parentClient,
      configuration
    );
    if (before !== null) {
      fail("staging_disposable_create_target_exists");
    }
    if (configuration.restoreTopology) {
      await inspectPermanentDatabaseLogins(
        parentClient,
        configuration.permanentLogins
      );
    }
    await parentClient.query(
      createDatabaseSql(
        configuration.target.disposableDatabase
      )
    );
    const created = await inspectDisposableCatalog(
      parentClient,
      configuration
    );
    if (created === null) {
      fail("staging_disposable_create_not_confirmed");
    }
    await parentClient.query(
      commentDatabaseSql(
        configuration.target.disposableDatabase
      )
    );
    const marked = await inspectDisposableCatalog(
      parentClient,
      configuration
    );
    assertDisposableLifecycleMarker(
      marked,
      configuration.target.disposableDatabase
    );
  } catch (error) {
    preserveLifecycleError(
      error,
      "staging_disposable_create_failed"
    );
  } finally {
    releaseClient(parentClient);
  }

  await verifyDisposableConnection(disposablePool, configuration);
  if (configuration.restoreTopology) {
    await prepareRestoreTopology(disposablePool, configuration);
    return Object.freeze({
      safe: true,
      created: true,
      identityVerified: true,
      restoreTopologyPrepared: true
    });
  }
  return Object.freeze({
    safe: true,
    created: true,
    identityVerified: true
  });
}

async function dropDisposableDatabase(
  parentPool,
  disposablePool,
  configuration,
  lifecycleState = {}
) {
  assertPools(parentPool, disposablePool);
  if (configuration?.action !== "drop") {
    fail("staging_disposable_drop_action_invalid");
  }

  let parentClient;
  try {
    parentClient = await parentPool.connect();
    await inspectSessionIdentity(
      parentClient,
      configuration,
      configuration.target.parentDatabase
    );
    const before = await inspectDisposableCatalog(
      parentClient,
      configuration
    );
    if (before === null) {
      fail("staging_disposable_drop_target_absent");
    }
    assertDisposableLifecycleMarker(
      before,
      configuration.target.disposableDatabase
    );

    await verifyDisposableConnection(disposablePool, configuration);
    await closeDisposablePool(disposablePool, lifecycleState);
    const rechecked = await inspectDisposableCatalog(
      parentClient,
      configuration
    );
    if (rechecked === null) {
      fail("staging_disposable_drop_identity_changed");
    }
    assertDisposableLifecycleMarker(
      rechecked,
      configuration.target.disposableDatabase
    );

    const terminated = await parentClient.query(
      [
        "SELECT pg_catalog.pg_terminate_backend(",
        "  activity.pid",
        ") AS terminated",
        "FROM pg_catalog.pg_stat_activity activity",
        "WHERE activity.datname = $1",
        "  AND activity.pid <> pg_catalog.pg_backend_pid()",
        "ORDER BY activity.pid"
      ].join("\n"),
      [configuration.target.disposableDatabase]
    );
    if (
      (terminated.rows || []).some(
        (row) => row?.terminated !== true
      )
    ) {
      fail("staging_disposable_session_termination_failed");
    }

    await parentClient.query(
      dropDatabaseSql(
        configuration.target.disposableDatabase
      )
    );
    const after = await inspectDisposableCatalog(
      parentClient,
      configuration
    );
    if (after !== null) {
      fail("staging_disposable_drop_not_confirmed");
    }
  } catch (error) {
    preserveLifecycleError(
      error,
      "staging_disposable_drop_failed"
    );
  } finally {
    releaseClient(parentClient);
  }

  return Object.freeze({
    safe: true,
    dropped: true,
    identityVerified: true,
    sessionsTerminated: true,
    absenceConfirmed: true,
    disposablePoolClosed: true
  });
}

module.exports = {
  CREATE_APPROVAL_PREFIX,
  DISPOSABLE_DATABASE_NAME,
  DROP_APPROVAL_PREFIX,
  RESTORE_CREATE_APPROVAL_PREFIX,
  RESTORE_DISPOSABLE_DATABASE_NAME,
  RESTORE_DROP_APPROVAL_PREFIX,
  RESTORE_TOPOLOGY_INSPECTION_SQL,
  RESTORE_TOPOLOGY_MUTATIONS,
  assertDisposableLifecycleMarker,
  closeDisposablePool,
  createDisposableDatabase,
  disposableDatabaseLifecycleMarker,
  disposableDatabaseTargetFingerprint,
  dropDisposableDatabase,
  inspectDisposableCatalog,
  inspectRestoreTopology,
  inspectSessionIdentity,
  loadDisposableDatabaseLifecycleConfig,
  prepareRestoreTopology,
  validateRestoreTopologySnapshot
};
