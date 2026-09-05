-- Run once with a PostgreSQL provisioner that is allowed to create roles.
-- No secret or environment-specific login role belongs in this file.
BEGIN;
SET LOCAL createrole_self_grant = '';

DO $postgres_version$
BEGIN
  IF current_setting('server_version_num')::integer < 180000 OR
     current_setting('server_version_num')::integer >= 190000
  THEN
    RAISE EXCEPTION 'ia4tube_social_postgres_18_required';
  END IF;
END
$postgres_version$;

DO $provisioner$
DECLARE
  provisioner RECORD;
BEGIN
  SELECT
    database_owner.rolname,
    database_owner.rolcanlogin,
    database_owner.rolsuper,
    database_owner.rolcreaterole,
    database_owner.rolreplication,
    database_owner.rolbypassrls
  INTO provisioner
  FROM pg_catalog.pg_database database_info
  JOIN pg_catalog.pg_roles database_owner
    ON database_owner.oid = database_info.datdba
  WHERE database_info.datname = current_database();

  IF provisioner.rolname IS NULL OR
     provisioner.rolname <> session_user OR
     NOT provisioner.rolcanlogin OR
     provisioner.rolsuper OR
     NOT provisioner.rolcreaterole OR
     provisioner.rolreplication OR
     provisioner.rolbypassrls
  THEN
    RAISE EXCEPTION 'ia4tube_social_provisioner_invalid';
  END IF;
END
$provisioner$;

DO $roles$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'ia4tube_social_owner'
  ) THEN
    CREATE ROLE ia4tube_social_owner
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
      NOREPLICATION NOBYPASSRLS;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'ia4tube_social_migrator'
  ) THEN
    CREATE ROLE ia4tube_social_migrator
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
      NOREPLICATION NOBYPASSRLS;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'ia4tube_social_runtime'
  ) THEN
    CREATE ROLE ia4tube_social_runtime
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
      NOREPLICATION NOBYPASSRLS;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname IN (
      'ia4tube_social_owner',
      'ia4tube_social_migrator',
      'ia4tube_social_runtime'
    )
      AND (
        rolcanlogin OR
        rolsuper OR
        rolcreatedb OR
        rolcreaterole OR
        rolinherit OR
        rolreplication OR
        rolbypassrls
      )
  ) THEN
    RAISE EXCEPTION 'ia4tube_social_role_attributes_invalid';
  END IF;
END
$roles$;

DO $implicit_role_administration$
BEGIN
  IF (
    SELECT COUNT(*) <> 3
    FROM pg_catalog.pg_auth_members membership
    JOIN pg_catalog.pg_roles granted
      ON granted.oid = membership.roleid
    JOIN pg_catalog.pg_roles member
      ON member.oid = membership.member
    JOIN pg_catalog.pg_roles grantor
      ON grantor.oid = membership.grantor
    JOIN pg_catalog.pg_database database_info
      ON database_info.datname = current_database()
    WHERE granted.rolname IN (
      'ia4tube_social_owner',
      'ia4tube_social_migrator',
      'ia4tube_social_runtime'
    )
      AND member.oid = database_info.datdba
      AND membership.admin_option
      AND NOT membership.inherit_option
      AND NOT membership.set_option
      AND grantor.rolsuper
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members membership
    JOIN pg_catalog.pg_roles granted
      ON granted.oid = membership.roleid
    JOIN pg_catalog.pg_roles member
      ON member.oid = membership.member
    JOIN pg_catalog.pg_roles grantor
      ON grantor.oid = membership.grantor
    JOIN pg_catalog.pg_database database_info
      ON database_info.datname = current_database()
    WHERE granted.rolname IN (
      'ia4tube_social_owner',
      'ia4tube_social_migrator',
      'ia4tube_social_runtime'
    )
      AND membership.admin_option
      AND NOT (
        member.oid = database_info.datdba
        AND NOT membership.inherit_option
        AND NOT membership.set_option
        AND grantor.rolsuper
      )
  )
  THEN
    RAISE EXCEPTION 'ia4tube_social_role_administration_invalid';
  END IF;
END
$implicit_role_administration$;

GRANT ia4tube_social_owner TO ia4tube_social_migrator
  WITH ADMIN FALSE, INHERIT FALSE, SET TRUE
  GRANTED BY CURRENT_USER;

DO $role_memberships$
BEGIN
  IF
    NOT pg_has_role(
      'ia4tube_social_migrator',
      'ia4tube_social_owner',
      'MEMBER'
    ) OR
    pg_has_role(
      'ia4tube_social_owner',
      'ia4tube_social_migrator',
      'MEMBER'
    ) OR
    pg_has_role(
      'ia4tube_social_owner',
      'ia4tube_social_runtime',
      'MEMBER'
    ) OR
    pg_has_role(
      'ia4tube_social_runtime',
      'ia4tube_social_owner',
      'MEMBER'
    ) OR
    pg_has_role(
      'ia4tube_social_runtime',
      'ia4tube_social_migrator',
      'MEMBER'
    ) OR
    pg_has_role(
      'ia4tube_social_migrator',
      'ia4tube_social_runtime',
      'MEMBER'
    ) OR
    (
      SELECT
        COUNT(*) <> 2 OR
        COALESCE(
          BOOL_OR(
            NOT (
              (
                member.oid = database_info.datdba
                AND membership.admin_option
                AND NOT membership.inherit_option
                AND NOT membership.set_option
                AND grantor.rolsuper
              ) OR (
                member.rolname = 'ia4tube_social_migrator'
                AND NOT membership.admin_option
                AND NOT membership.inherit_option
                AND membership.set_option
                AND grantor.oid = database_info.datdba
              )
            )
          ),
          TRUE
        )
      FROM pg_catalog.pg_auth_members membership
      JOIN pg_catalog.pg_roles granted
        ON granted.oid = membership.roleid
      JOIN pg_catalog.pg_roles member
        ON member.oid = membership.member
      JOIN pg_catalog.pg_roles grantor
        ON grantor.oid = membership.grantor
      JOIN pg_catalog.pg_database database_info
        ON database_info.datname = current_database()
      WHERE granted.rolname = 'ia4tube_social_owner'
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_roles granted
      WHERE granted.rolname IN (
        'ia4tube_social_migrator',
        'ia4tube_social_runtime'
      )
        AND (
          SELECT COUNT(*) NOT BETWEEN 1 AND 2 OR
            COUNT(*) FILTER (
              WHERE member.oid = database_info.datdba
                AND membership.admin_option
                AND NOT membership.inherit_option
                AND NOT membership.set_option
                AND grantor.rolsuper
            ) <> 1 OR
            COUNT(*) FILTER (
              WHERE NOT membership.admin_option
                AND NOT membership.inherit_option
                AND membership.set_option
                AND member.rolcanlogin
                AND NOT member.rolsuper
                AND NOT member.rolcreatedb
                AND NOT member.rolcreaterole
                AND NOT member.rolreplication
                AND NOT member.rolbypassrls
                AND member.oid <> database_info.datdba
                AND grantor.oid = database_info.datdba
            ) <> COUNT(*) - 1
          FROM pg_catalog.pg_auth_members membership
          JOIN pg_catalog.pg_roles member
            ON member.oid = membership.member
          JOIN pg_catalog.pg_roles grantor
            ON grantor.oid = membership.grantor
          JOIN pg_catalog.pg_database database_info
            ON database_info.datname = current_database()
          WHERE membership.roleid = granted.oid
        )
    )
  THEN
    RAISE EXCEPTION 'ia4tube_social_role_memberships_invalid';
  END IF;
END
$role_memberships$;

DO $database_acl$
BEGIN
  EXECUTE format(
    'REVOKE ALL ON DATABASE %I FROM PUBLIC',
    current_database()
  );
  EXECUTE format(
    'GRANT CREATE ON DATABASE %I TO ia4tube_social_owner',
    current_database()
  );
END
$database_acl$;

-- CONNECT must be granted directly, by the environment provisioner, to the
-- distinct migration and runtime LOGIN roles. Their memberships deliberately
-- use INHERIT FALSE, so granting CONNECT only to these group roles is invalid.

REVOKE CREATE ON SCHEMA public FROM PUBLIC;

GRANT ia4tube_social_owner TO CURRENT_USER
  WITH ADMIN FALSE, INHERIT FALSE, SET TRUE
  GRANTED BY CURRENT_USER;
SET LOCAL ROLE ia4tube_social_owner;

CREATE SCHEMA IF NOT EXISTS ia4tube_migrations
  AUTHORIZATION ia4tube_social_owner;
ALTER SCHEMA ia4tube_migrations OWNER TO ia4tube_social_owner;
REVOKE ALL ON SCHEMA ia4tube_migrations FROM PUBLIC;
REVOKE ALL ON SCHEMA ia4tube_migrations FROM ia4tube_social_migrator;
GRANT USAGE ON SCHEMA ia4tube_migrations TO ia4tube_social_migrator;

CREATE TABLE IF NOT EXISTS ia4tube_migrations.environment_identity (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE,
  environment_id UUID NOT NULL UNIQUE,
  environment_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT environment_identity_singleton
    CHECK (singleton),
  CONSTRAINT environment_identity_name_valid
    CHECK (environment_name IN ('local', 'test', 'staging', 'production'))
);
ALTER TABLE ia4tube_migrations.environment_identity
  OWNER TO ia4tube_social_owner;
REVOKE ALL ON ia4tube_migrations.environment_identity FROM PUBLIC;
REVOKE ALL ON ia4tube_migrations.environment_identity
  FROM ia4tube_social_migrator;
GRANT SELECT ON ia4tube_migrations.environment_identity
  TO ia4tube_social_migrator;

RESET ROLE;
REVOKE ia4tube_social_owner FROM CURRENT_USER
  GRANTED BY CURRENT_USER RESTRICT;

DO $temporary_membership_removed$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members membership
    JOIN pg_catalog.pg_roles granted
      ON granted.oid = membership.roleid
    JOIN pg_catalog.pg_roles member
      ON member.oid = membership.member
    JOIN pg_catalog.pg_roles grantor
      ON grantor.oid = membership.grantor
    WHERE granted.rolname = 'ia4tube_social_owner'
      AND member.rolname = session_user
      AND grantor.rolname = session_user
  ) THEN
    RAISE EXCEPTION 'ia4tube_social_temporary_membership_not_removed';
  END IF;
END
$temporary_membership_removed$;

COMMIT;
