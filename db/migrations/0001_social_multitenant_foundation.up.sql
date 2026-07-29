CREATE SCHEMA ia4tube_social AUTHORIZATION ia4tube_social_owner;

REVOKE ALL ON SCHEMA ia4tube_social FROM PUBLIC;
GRANT USAGE ON SCHEMA ia4tube_social TO ia4tube_social_runtime;

CREATE TABLE ia4tube_social.companies (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  identity_derivation_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT companies_name_not_blank
    CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  CONSTRAINT companies_status_allowed
    CHECK (status IN ('active', 'suspended', 'archived')),
  CONSTRAINT companies_identity_derivation_version_valid
    CHECK (
      identity_derivation_version ~
        '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,49}$'
    )
);

CREATE TABLE ia4tube_social.users (
  company_id UUID NOT NULL,
  id UUID NOT NULL,
  login_key_digest CHAR(64) NOT NULL,
  password_hash TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  auth_version BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login_at TIMESTAMPTZ,
  PRIMARY KEY (company_id, id),
  CONSTRAINT users_company_fk
    FOREIGN KEY (company_id)
    REFERENCES ia4tube_social.companies(id)
    ON DELETE RESTRICT,
  CONSTRAINT users_login_key_digest_format
    CHECK (login_key_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT users_password_hash_valid
    CHECK (password_hash IS NULL OR length(btrim(password_hash)) > 0),
  CONSTRAINT users_status_allowed
    CHECK (status IN ('active', 'locked', 'disabled')),
  CONSTRAINT users_auth_version_positive
    CHECK (auth_version > 0),
  CONSTRAINT users_login_company_unique
    UNIQUE (company_id, login_key_digest)
);

CREATE TABLE ia4tube_social.company_memberships (
  company_id UUID NOT NULL,
  user_id UUID NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (company_id, user_id),
  CONSTRAINT company_memberships_company_fk
    FOREIGN KEY (company_id)
    REFERENCES ia4tube_social.companies(id)
    ON DELETE RESTRICT,
  CONSTRAINT company_memberships_user_fk
    FOREIGN KEY (company_id, user_id)
    REFERENCES ia4tube_social.users(company_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT company_memberships_role_allowed
    CHECK (role IN ('owner', 'admin', 'member')),
  CONSTRAINT company_memberships_status_allowed
    CHECK (status IN ('active', 'invited', 'disabled'))
);

CREATE INDEX company_memberships_user_company_idx
  ON ia4tube_social.company_memberships (user_id, company_id);

CREATE TABLE ia4tube_social.legacy_entity_mappings (
  company_id UUID NOT NULL,
  id UUID NOT NULL,
  migration_version TEXT NOT NULL,
  source_system TEXT NOT NULL,
  source_entity_type TEXT NOT NULL,
  source_entity_id_digest CHAR(64) NOT NULL,
  source_sha256 CHAR(64) NOT NULL,
  target_entity_type TEXT NOT NULL,
  target_entity_id UUID NOT NULL,
  migrated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (company_id, id),
  CONSTRAINT legacy_entity_mappings_company_fk
    FOREIGN KEY (company_id)
    REFERENCES ia4tube_social.companies(id)
    ON DELETE RESTRICT,
  CONSTRAINT legacy_entity_mappings_migration_fk
    FOREIGN KEY (migration_version)
    REFERENCES ia4tube_migrations.schema_migrations(version)
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT legacy_entity_mappings_migration_not_blank
    CHECK (length(btrim(migration_version)) BETWEEN 1 AND 100),
  CONSTRAINT legacy_entity_mappings_source_system_not_blank
    CHECK (length(btrim(source_system)) BETWEEN 1 AND 100),
  CONSTRAINT legacy_entity_mappings_source_type_not_blank
    CHECK (length(btrim(source_entity_type)) BETWEEN 1 AND 100),
  CONSTRAINT legacy_entity_mappings_source_id_digest_format
    CHECK (source_entity_id_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT legacy_entity_mappings_source_sha256_format
    CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT legacy_entity_mappings_target_type_not_blank
    CHECK (length(btrim(target_entity_type)) BETWEEN 1 AND 100),
  CONSTRAINT legacy_entity_mappings_source_unique
    UNIQUE (
      company_id,
      migration_version,
      source_system,
      source_entity_type,
      source_entity_id_digest
    ),
  CONSTRAINT legacy_entity_mappings_target_unique
    UNIQUE (company_id, target_entity_type, target_entity_id)
);

ALTER TABLE ia4tube_social.companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE ia4tube_social.companies FORCE ROW LEVEL SECURITY;
ALTER TABLE ia4tube_social.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE ia4tube_social.users FORCE ROW LEVEL SECURITY;
ALTER TABLE ia4tube_social.company_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE ia4tube_social.company_memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE ia4tube_social.legacy_entity_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE ia4tube_social.legacy_entity_mappings FORCE ROW LEVEL SECURITY;

CREATE POLICY companies_company_scope
  ON ia4tube_social.companies
  USING (
    id = NULLIF(current_setting('ia4tube.company_id', true), '')::UUID
  )
  WITH CHECK (
    id = NULLIF(current_setting('ia4tube.company_id', true), '')::UUID
  );

CREATE POLICY users_company_scope
  ON ia4tube_social.users
  USING (
    company_id =
      NULLIF(current_setting('ia4tube.company_id', true), '')::UUID
  )
  WITH CHECK (
    company_id =
      NULLIF(current_setting('ia4tube.company_id', true), '')::UUID
  );

CREATE POLICY company_memberships_company_scope
  ON ia4tube_social.company_memberships
  USING (
    company_id =
      NULLIF(current_setting('ia4tube.company_id', true), '')::UUID
  )
  WITH CHECK (
    company_id =
      NULLIF(current_setting('ia4tube.company_id', true), '')::UUID
  );

CREATE POLICY legacy_entity_mappings_company_scope
  ON ia4tube_social.legacy_entity_mappings
  USING (
    company_id =
      NULLIF(current_setting('ia4tube.company_id', true), '')::UUID
  )
  WITH CHECK (
    company_id =
      NULLIF(current_setting('ia4tube.company_id', true), '')::UUID
  );

REVOKE ALL ON ALL TABLES IN SCHEMA ia4tube_social FROM PUBLIC;
GRANT SELECT (
  id,
  name,
  status,
  identity_derivation_version,
  created_at,
  updated_at
) ON ia4tube_social.companies TO ia4tube_social_runtime;
GRANT SELECT (
  company_id,
  id,
  password_hash,
  status,
  auth_version
) ON ia4tube_social.users TO ia4tube_social_runtime;
GRANT SELECT (
  company_id,
  user_id,
  role,
  status,
  created_at,
  updated_at
) ON ia4tube_social.company_memberships TO ia4tube_social_runtime;

ALTER DEFAULT PRIVILEGES FOR ROLE ia4tube_social_owner
  IN SCHEMA ia4tube_social
  REVOKE ALL ON TABLES FROM PUBLIC;
