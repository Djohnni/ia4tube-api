"use strict";

const pg = require("pg");
const { postgresFail, SocialPostgresError } = require("./errors");
const { requireSafeLabel, requireUuid } = require("./validation");

const SET_COMPANY_SCOPE_SQL =
  "SELECT set_config('ia4tube.company_id', $1, true)";

function quoteIdentifier(value) {
  const safe = requireSafeLabel(value, "postgres_role");
  return `"${safe.replace(/"/g, '""')}"`;
}

function safePoolLogger(logger, code) {
  if (!logger || typeof logger.error !== "function") return;
  logger.error(Object.freeze({ component: "social_postgres", code }));
}

function createPostgresPool(poolConfig, options = {}) {
  if (!poolConfig || typeof poolConfig !== "object") {
    postgresFail("postgres_pool_config_required", "Pool PostgreSQL recusado.");
  }
  const PoolClass = options.PoolClass || pg.Pool;
  const pool = new PoolClass(poolConfig);
  if (!pool || typeof pool.connect !== "function") {
    postgresFail("postgres_pool_invalid", "Pool PostgreSQL recusado.");
  }
  if (typeof pool.on === "function") {
    pool.on("error", () =>
      safePoolLogger(options.logger, "unexpected_idle_client_error")
    );
  }
  return pool;
}

function requireClient(client) {
  if (
    !client ||
    typeof client.query !== "function" ||
    typeof client.release !== "function"
  ) {
    postgresFail("postgres_client_invalid", "Cliente PostgreSQL recusado.");
  }
  return client;
}

async function inspectSessionPrincipalAccess(client) {
  const result = await client.query(
    [
      "SELECT",
      "  pg_get_userbyid(database_info.datdba)",
      "    IN (current_user, session_user) AS owns_database,",
      "  has_database_privilege(",
      "    current_user, current_database(), 'CREATE'",
      "  ) OR has_database_privilege(",
      "    session_user, current_database(), 'CREATE'",
      "  ) AS database_create,",
      "  EXISTS (",
      "    SELECT 1",
      "    FROM pg_catalog.pg_namespace namespace",
      "    WHERE namespace.nspname IN (",
      "      'ia4tube_social', 'ia4tube_social_admin',",
      "      'ia4tube_migrations'",
      "    )",
      "      AND pg_get_userbyid(namespace.nspowner)",
      "        IN (current_user, session_user)",
      "  ) AS owns_schema,",
      "  EXISTS (",
      "    SELECT 1",
      "    FROM pg_catalog.pg_namespace namespace",
      "    WHERE namespace.nspname IN (",
      "      'ia4tube_social', 'ia4tube_social_admin',",
      "      'ia4tube_migrations'",
      "    )",
      "      AND (",
      "        has_schema_privilege(current_user, namespace.oid, 'CREATE')",
      "        OR has_schema_privilege(",
      "          session_user, namespace.oid, 'CREATE'",
      "        )",
      "      )",
      "  ) AS schema_create,",
      "  EXISTS (",
      "    SELECT 1",
      "    FROM pg_catalog.pg_class relation",
      "    JOIN pg_catalog.pg_namespace namespace",
      "      ON namespace.oid = relation.relnamespace",
      "    WHERE namespace.nspname IN (",
      "      'ia4tube_social', 'ia4tube_social_admin',",
      "      'ia4tube_migrations'",
      "    )",
      "      AND pg_get_userbyid(relation.relowner)",
      "        IN (current_user, session_user)",
      "  ) AS owns_relation,",
      "  EXISTS (",
      "    SELECT 1",
      "    FROM pg_catalog.pg_proc procedure",
      "    JOIN pg_catalog.pg_namespace namespace",
      "      ON namespace.oid = procedure.pronamespace",
      "    WHERE namespace.nspname IN (",
      "      'ia4tube_social', 'ia4tube_social_admin',",
      "      'ia4tube_migrations'",
      "    )",
      "      AND pg_get_userbyid(procedure.proowner)",
      "        IN (current_user, session_user)",
      "  ) AS owns_function,",
      "  EXISTS (",
      "    SELECT 1",
      "    FROM pg_catalog.pg_type type_info",
      "    JOIN pg_catalog.pg_namespace namespace",
      "      ON namespace.oid = type_info.typnamespace",
      "    WHERE namespace.nspname IN (",
      "      'ia4tube_social', 'ia4tube_social_admin',",
      "      'ia4tube_migrations'",
      "    )",
      "      AND pg_get_userbyid(type_info.typowner)",
      "        IN (current_user, session_user)",
      "  ) AS owns_type,",
      "  EXISTS (",
      "    SELECT 1",
      "    FROM pg_catalog.pg_class relation",
      "    JOIN pg_catalog.pg_namespace namespace",
      "      ON namespace.oid = relation.relnamespace",
      "    WHERE namespace.nspname IN (",
      "      'ia4tube_social', 'ia4tube_social_admin'",
      "    )",
      "      AND relation.relkind IN ('r', 'p')",
      "      AND (",
      "        has_table_privilege(current_user, relation.oid, 'TRUNCATE')",
      "        OR has_table_privilege(",
      "          session_user, relation.oid, 'TRUNCATE'",
      "        )",
      "      )",
      "  ) AS table_truncate",
      "FROM pg_catalog.pg_database database_info",
      "WHERE database_info.datname = current_database()"
    ].join("\n")
  );
  return result.rows?.[0] || null;
}

function principalAccessIsUnsafe(access) {
  return (
    !access ||
    access.owns_database ||
    access.database_create ||
    access.owns_schema ||
    access.schema_create ||
    access.owns_relation ||
    access.owns_function ||
    access.owns_type ||
    access.table_truncate
  );
}

async function withTransaction(pool, operation, options = {}) {
  if (!pool || typeof pool.connect !== "function") {
    postgresFail("postgres_pool_required", "Pool PostgreSQL obrigatorio.");
  }
  if (typeof operation !== "function") {
    postgresFail(
      "postgres_operation_required",
      "Operacao PostgreSQL obrigatoria."
    );
  }

  const client = requireClient(await pool.connect());
  let started = false;
  let discarded = false;
  try {
    await client.query("BEGIN");
    started = true;
    if (options.role) {
      await client.query(`SET LOCAL ROLE ${quoteIdentifier(options.role)}`);
    }
    if (options.companyId) {
      await client.query(SET_COMPANY_SCOPE_SQL, [
        requireUuid(options.companyId, "company_id")
      ]);
    }
    const result = await operation(client);
    await client.query("COMMIT");
    started = false;
    return result;
  } catch (error) {
    if (started) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackFailure) {
        client.release(rollbackFailure);
        discarded = true;
        throw new SocialPostgresError(
          "postgres_rollback_failed",
          "Rollback PostgreSQL nao foi confirmado.",
          error
        );
      }
    }
    throw error;
  } finally {
    if (!discarded) client.release();
  }
}

async function verifyRuntimeRole(pool, role) {
  return withTransaction(
    pool,
    async (client) => {
      const flags = await client.query(
        [
          "SELECT",
          "  current_setting('server_version_num')::integer >= 180000",
          "    AND current_setting('server_version_num')::integer < 190000",
          "    AS postgres_version_supported,",
          "  active.rolcanlogin AS active_canlogin,",
          "  active.rolsuper AS active_superuser,",
          "  active.rolcreatedb AS active_createdb,",
          "  active.rolcreaterole AS active_createrole,",
          "  active.rolinherit AS active_inherit,",
          "  active.rolreplication AS active_replication,",
          "  active.rolbypassrls AS active_bypassrls,",
          "  login.rolsuper AS login_superuser,",
          "  login.rolcreatedb AS login_createdb,",
          "  login.rolcreaterole AS login_createrole,",
          "  login.rolreplication AS login_replication,",
          "  login.rolbypassrls AS login_bypassrls,",
          "  database_owner.rolcanlogin",
          "    AND NOT database_owner.rolsuper",
          "    AND database_owner.rolcreaterole",
          "    AND NOT database_owner.rolreplication",
          "    AND NOT database_owner.rolbypassrls",
          "    AS database_owner_safe,",
          "  session_user <> database_owner.rolname",
          "    AS login_is_separate,",
          "  (",
          "    SELECT COUNT(*) = 1",
          "      AND BOOL_AND(",
          "        expanded_acl.privilege_type = 'CONNECT'",
          "        AND NOT expanded_acl.is_grantable",
          "        AND expanded_acl.grantor = database_info.datdba",
          "      )",
          "    FROM pg_catalog.aclexplode(",
          "      COALESCE(database_info.datacl,",
          "        pg_catalog.acldefault('d', database_info.datdba))",
          "    ) expanded_acl",
          "    WHERE expanded_acl.grantee = login.oid",
          "  ) AS direct_connect_exact,",
          "  NOT EXISTS (",
          "    SELECT 1",
          "    FROM pg_catalog.aclexplode(",
          "      COALESCE(database_info.datacl,",
          "        pg_catalog.acldefault('d', database_info.datdba))",
          "    ) expanded_acl",
          "    WHERE expanded_acl.grantee = 0",
          "  ) AS public_database_acl_absent,",
          "  NOT pg_catalog.has_database_privilege(",
          "    session_user, current_database(), 'TEMP'",
          "  ) AS database_temp_absent,",
          "  pg_has_role(session_user, $1, 'MEMBER') AS runtime_member,",
          "  pg_has_role(session_user, 'ia4tube_social_owner', 'MEMBER')",
          "    AS owner_member,",
          "  pg_has_role(session_user, 'ia4tube_social_migrator', 'MEMBER')",
          "    AS migrator_member,",
          "  EXISTS (",
          "    SELECT 1",
          "    FROM pg_catalog.pg_roles reachable",
          "    WHERE pg_has_role(session_user, reachable.rolname, 'MEMBER')",
          "      AND reachable.rolname NOT IN (session_user, current_user)",
          "  ) AS unexpected_membership,",
          "  (",
          "    SELECT COUNT(*) = 2",
          "      AND COUNT(*) FILTER (",
          "        WHERE member.rolname = session_user",
          "          AND NOT membership.admin_option",
          "          AND NOT membership.inherit_option",
          "          AND membership.set_option",
          "          AND grantor.oid = database_info.datdba",
          "      ) = 1",
          "      AND COUNT(*) FILTER (",
          "        WHERE member.oid = database_info.datdba",
          "          AND membership.admin_option",
          "          AND NOT membership.inherit_option",
          "          AND NOT membership.set_option",
          "          AND grantor.rolsuper",
          "      ) = 1",
          "    FROM pg_catalog.pg_auth_members membership",
          "    JOIN pg_catalog.pg_roles granted",
          "      ON granted.oid = membership.roleid",
          "    JOIN pg_catalog.pg_roles member",
          "      ON member.oid = membership.member",
          "    JOIN pg_catalog.pg_roles grantor",
          "      ON grantor.oid = membership.grantor",
          "    WHERE granted.rolname = $1",
          "  ) AS runtime_members_exact",
          "FROM pg_catalog.pg_roles active",
          "JOIN pg_catalog.pg_roles login ON login.rolname = session_user",
          "JOIN pg_catalog.pg_database database_info",
          "  ON database_info.datname = current_database()",
          "JOIN pg_catalog.pg_roles database_owner",
          "  ON database_owner.oid = database_info.datdba",
          "WHERE active.rolname = current_user"
        ].join("\n")
        ,
        [role]
      );
      const row = flags.rows && flags.rows[0];
      if (
        !row ||
        !row.postgres_version_supported ||
        row.active_canlogin ||
        row.active_superuser ||
        row.active_createdb ||
        row.active_createrole ||
        row.active_inherit ||
        row.active_replication ||
        row.active_bypassrls ||
        row.login_superuser ||
        row.login_createdb ||
        row.login_createrole ||
        row.login_replication ||
        row.login_bypassrls ||
        !row.database_owner_safe ||
        !row.login_is_separate ||
        !row.direct_connect_exact ||
        !row.public_database_acl_absent ||
        !row.database_temp_absent ||
        !row.runtime_member ||
        row.owner_member ||
        row.migrator_member ||
        row.unexpected_membership ||
        !row.runtime_members_exact
      ) {
        postgresFail(
          "postgres_runtime_role_unsafe",
          "Role PostgreSQL de runtime recusada."
        );
      }

      const access = await inspectSessionPrincipalAccess(client);
      if (principalAccessIsUnsafe(access)) {
        postgresFail(
          "postgres_runtime_role_is_owner",
          "Principal PostgreSQL de runtime recusada."
        );
      }
      return Object.freeze({
        safe: true,
        superuser: false,
        bypassRls: false,
        ownsTables: false
      });
    },
    { role }
  );
}

async function closePostgresPool(pool) {
  if (!pool || typeof pool.end !== "function") {
    postgresFail("postgres_pool_invalid", "Pool PostgreSQL recusado.");
  }
  await pool.end();
}

module.exports = {
  SET_COMPANY_SCOPE_SQL,
  closePostgresPool,
  createPostgresPool,
  inspectSessionPrincipalAccess,
  principalAccessIsUnsafe,
  quoteIdentifier,
  verifyRuntimeRole,
  withTransaction
};
