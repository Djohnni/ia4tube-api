BEGIN;

CREATE TABLE schema_migrations (
  version TEXT PRIMARY KEY,
  checksum_sha256 CHAR(64) NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  execution_ms BIGINT,
  CONSTRAINT schema_migrations_version_not_blank
    CHECK (length(btrim(version)) > 0),
  CONSTRAINT schema_migrations_checksum_sha256_format
    CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT schema_migrations_execution_ms_nonnegative
    CHECK (execution_ms IS NULL OR execution_ms >= 0)
);

CREATE TABLE companies (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT companies_name_not_blank
    CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  CONSTRAINT companies_status_allowed
    CHECK (status IN ('active', 'suspended', 'archived'))
);

CREATE TABLE users (
  id UUID PRIMARY KEY,
  login_key TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  auth_version BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login_at TIMESTAMPTZ,
  CONSTRAINT users_login_key_not_blank
    CHECK (length(btrim(login_key)) BETWEEN 1 AND 320),
  CONSTRAINT users_password_hash_not_blank
    CHECK (length(btrim(password_hash)) > 0),
  CONSTRAINT users_status_allowed
    CHECK (status IN ('active', 'locked', 'disabled')),
  CONSTRAINT users_auth_version_positive
    CHECK (auth_version > 0)
);

CREATE TABLE company_memberships (
  company_id UUID NOT NULL,
  user_id UUID NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (company_id, user_id),
  CONSTRAINT company_memberships_company_fk
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT,
  CONSTRAINT company_memberships_user_fk
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT company_memberships_role_allowed
    CHECK (role IN ('owner', 'admin', 'member')),
  CONSTRAINT company_memberships_status_allowed
    CHECK (status IN ('active', 'invited', 'disabled'))
);

CREATE INDEX company_memberships_user_company_idx
  ON company_memberships (user_id, company_id);

CREATE TABLE legacy_entity_mappings (
  id UUID PRIMARY KEY,
  migration_version TEXT NOT NULL,
  company_id UUID NOT NULL,
  source_system TEXT NOT NULL,
  source_entity_type TEXT NOT NULL,
  source_entity_id TEXT NOT NULL,
  source_sha256 CHAR(64) NOT NULL,
  target_entity_type TEXT NOT NULL,
  target_entity_id UUID NOT NULL,
  migrated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT legacy_entity_mappings_migration_fk
    FOREIGN KEY (migration_version)
    REFERENCES schema_migrations(version)
    ON DELETE RESTRICT,
  CONSTRAINT legacy_entity_mappings_company_fk
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT,
  CONSTRAINT legacy_entity_mappings_source_system_not_blank
    CHECK (length(btrim(source_system)) BETWEEN 1 AND 100),
  CONSTRAINT legacy_entity_mappings_source_type_not_blank
    CHECK (length(btrim(source_entity_type)) BETWEEN 1 AND 100),
  CONSTRAINT legacy_entity_mappings_source_id_not_blank
    CHECK (length(btrim(source_entity_id)) BETWEEN 1 AND 500),
  CONSTRAINT legacy_entity_mappings_source_sha256_format
    CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT legacy_entity_mappings_target_type_not_blank
    CHECK (length(btrim(target_entity_type)) BETWEEN 1 AND 100),
  CONSTRAINT legacy_entity_mappings_source_unique
    UNIQUE (
      migration_version,
      company_id,
      source_system,
      source_entity_type,
      source_entity_id
    ),
  CONSTRAINT legacy_entity_mappings_target_unique
    UNIQUE (company_id, target_entity_type, target_entity_id)
);

CREATE INDEX legacy_entity_mappings_company_source_idx
  ON legacy_entity_mappings (
    company_id,
    source_system,
    source_entity_type
  );

ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE companies FORCE ROW LEVEL SECURITY;
ALTER TABLE company_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE legacy_entity_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_entity_mappings FORCE ROW LEVEL SECURITY;

CREATE POLICY companies_company_scope
  ON companies
  USING (
    id = NULLIF(current_setting('ia4tube.company_id', true), '')::UUID
  )
  WITH CHECK (
    id = NULLIF(current_setting('ia4tube.company_id', true), '')::UUID
  );

CREATE POLICY company_memberships_company_scope
  ON company_memberships
  USING (
    company_id =
      NULLIF(current_setting('ia4tube.company_id', true), '')::UUID
  )
  WITH CHECK (
    company_id =
      NULLIF(current_setting('ia4tube.company_id', true), '')::UUID
  );

CREATE POLICY legacy_entity_mappings_company_scope
  ON legacy_entity_mappings
  USING (
    company_id =
      NULLIF(current_setting('ia4tube.company_id', true), '')::UUID
  )
  WITH CHECK (
    company_id =
      NULLIF(current_setting('ia4tube.company_id', true), '')::UUID
  );

COMMIT;
