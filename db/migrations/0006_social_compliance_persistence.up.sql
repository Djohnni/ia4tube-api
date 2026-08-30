CREATE TABLE ia4tube_social.social_meta_subject_mappings (
  company_id UUID NOT NULL,
  provider TEXT NOT NULL,
  subject_digest CHAR(64) NOT NULL,
  digest_version TEXT NOT NULL,
  user_id UUID NOT NULL,
  connection_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revision BIGINT NOT NULL DEFAULT 1,
  PRIMARY KEY (company_id, provider, subject_digest),
  CONSTRAINT social_meta_subject_mappings_company_fk
    FOREIGN KEY (company_id)
    REFERENCES ia4tube_social.companies(id)
    ON DELETE RESTRICT,
  CONSTRAINT social_meta_subject_mappings_user_fk
    FOREIGN KEY (company_id, user_id)
    REFERENCES ia4tube_social.users(company_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT social_meta_subject_mappings_connection_fk
    FOREIGN KEY (company_id, connection_id, provider)
    REFERENCES ia4tube_social.social_connections(company_id, id, provider)
    ON DELETE RESTRICT,
  CONSTRAINT social_meta_subject_mappings_subject_global_unique
    UNIQUE (provider, subject_digest),
  CONSTRAINT social_meta_subject_mappings_provider_valid
    CHECK (provider ~ '^[a-z][a-z0-9_]{0,49}$'),
  CONSTRAINT social_meta_subject_mappings_digest_format
    CHECK (subject_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT social_meta_subject_mappings_digest_version_valid
    CHECK (digest_version = 'hmac-sha256-app-secret-v1'),
  CONSTRAINT social_meta_subject_mappings_status_allowed
    CHECK (status IN ('active', 'revoked')),
  CONSTRAINT social_meta_subject_mappings_status_timestamp_consistent
    CHECK (
      (status = 'active' AND revoked_at IS NULL) OR
      (
        status = 'revoked' AND
        revoked_at IS NOT NULL AND
        revoked_at >= created_at
      )
    ),
  CONSTRAINT social_meta_subject_mappings_revision_positive
    CHECK (revision > 0),
  CONSTRAINT social_meta_subject_mappings_update_order
    CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX social_meta_subject_mappings_active_connection_unique
  ON ia4tube_social.social_meta_subject_mappings (
    company_id,
    connection_id,
    provider
  )
  WHERE status = 'active';

CREATE TABLE ia4tube_social.social_compliance_requests (
  company_id UUID NOT NULL,
  id UUID NOT NULL,
  provider TEXT NOT NULL,
  kind TEXT NOT NULL,
  event_key CHAR(64) NOT NULL,
  subject_digest CHAR(64) NOT NULL,
  user_id UUID NOT NULL,
  connection_id UUID NOT NULL,
  confirmation_code TEXT NOT NULL,
  confirmation_code_digest CHAR(64) NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing',
  details_code TEXT,
  token_materials_deleted INTEGER NOT NULL DEFAULT 0,
  requested_at TIMESTAMPTZ NOT NULL,
  processing_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revision BIGINT NOT NULL DEFAULT 1,
  PRIMARY KEY (company_id, id),
  CONSTRAINT social_compliance_requests_company_fk
    FOREIGN KEY (company_id)
    REFERENCES ia4tube_social.companies(id)
    ON DELETE RESTRICT,
  CONSTRAINT social_compliance_requests_user_fk
    FOREIGN KEY (company_id, user_id)
    REFERENCES ia4tube_social.users(company_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT social_compliance_requests_connection_fk
    FOREIGN KEY (company_id, connection_id, provider)
    REFERENCES ia4tube_social.social_connections(company_id, id, provider)
    ON DELETE RESTRICT,
  CONSTRAINT social_compliance_requests_subject_fk
    FOREIGN KEY (company_id, provider, subject_digest)
    REFERENCES ia4tube_social.social_meta_subject_mappings(
      company_id,
      provider,
      subject_digest
    )
    ON DELETE RESTRICT,
  CONSTRAINT social_compliance_requests_event_unique
    UNIQUE (provider, event_key),
  CONSTRAINT social_compliance_requests_confirmation_unique
    UNIQUE (confirmation_code),
  CONSTRAINT social_compliance_requests_confirmation_digest_unique
    UNIQUE (confirmation_code_digest),
  CONSTRAINT social_compliance_requests_provider_valid
    CHECK (provider ~ '^[a-z][a-z0-9_]{0,49}$'),
  CONSTRAINT social_compliance_requests_kind_allowed
    CHECK (kind IN ('deauthorization', 'data_deletion')),
  CONSTRAINT social_compliance_requests_event_key_format
    CHECK (event_key ~ '^[0-9a-f]{64}$'),
  CONSTRAINT social_compliance_requests_subject_digest_format
    CHECK (subject_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT social_compliance_requests_confirmation_code_valid
    CHECK (confirmation_code ~ '^[A-Za-z0-9_-]{32,128}$'),
  CONSTRAINT social_compliance_requests_confirmation_digest_format
    CHECK (confirmation_code_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT social_compliance_requests_status_allowed
    CHECK (status IN ('processing', 'completed', 'failed')),
  CONSTRAINT social_compliance_requests_details_code_valid
    CHECK (
      details_code IS NULL OR
      details_code ~ '^[a-z][a-z0-9_]{0,99}$'
    ),
  CONSTRAINT social_compliance_requests_deleted_count_nonnegative
    CHECK (token_materials_deleted >= 0),
  CONSTRAINT social_compliance_requests_status_timestamp_consistent
    CHECK (
      (
        status = 'processing' AND
        completed_at IS NULL AND
        details_code IS NULL AND
        token_materials_deleted = 0
      ) OR
      (
        status IN ('completed', 'failed') AND
        completed_at IS NOT NULL AND
        details_code IS NOT NULL
      )
    ),
  CONSTRAINT social_compliance_requests_processing_order
    CHECK (processing_at >= requested_at),
  CONSTRAINT social_compliance_requests_completion_order
    CHECK (completed_at IS NULL OR completed_at >= processing_at),
  CONSTRAINT social_compliance_requests_update_order
    CHECK (created_at >= requested_at AND updated_at >= created_at),
  CONSTRAINT social_compliance_requests_revision_positive
    CHECK (revision > 0)
);

CREATE INDEX social_compliance_requests_company_connection_time_idx
  ON ia4tube_social.social_compliance_requests (
    company_id,
    connection_id,
    requested_at DESC
  );

CREATE INDEX social_compliance_requests_company_status_time_idx
  ON ia4tube_social.social_compliance_requests (
    company_id,
    status,
    requested_at,
    id
  );

ALTER TABLE ia4tube_social.social_meta_subject_mappings
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE ia4tube_social.social_meta_subject_mappings
  FORCE ROW LEVEL SECURITY;
ALTER TABLE ia4tube_social.social_compliance_requests
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE ia4tube_social.social_compliance_requests
  FORCE ROW LEVEL SECURITY;

CREATE POLICY social_meta_subject_mappings_company_scope
  ON ia4tube_social.social_meta_subject_mappings
  USING (
    company_id =
      NULLIF(current_setting('ia4tube.company_id', true), '')::UUID
  )
  WITH CHECK (
    company_id =
      NULLIF(current_setting('ia4tube.company_id', true), '')::UUID
  );

CREATE POLICY social_meta_subject_mappings_owner_resolver
  ON ia4tube_social.social_meta_subject_mappings
  FOR SELECT
  TO ia4tube_social_owner
  USING (TRUE);

CREATE POLICY social_compliance_requests_company_scope
  ON ia4tube_social.social_compliance_requests
  USING (
    company_id =
      NULLIF(current_setting('ia4tube.company_id', true), '')::UUID
  )
  WITH CHECK (
    company_id =
      NULLIF(current_setting('ia4tube.company_id', true), '')::UUID
  );

CREATE POLICY social_compliance_requests_owner_resolver
  ON ia4tube_social.social_compliance_requests
  FOR SELECT
  TO ia4tube_social_owner
  USING (TRUE);

CREATE FUNCTION ia4tube_social.resolve_meta_subject_mapping(
  requested_provider TEXT,
  requested_subject_digest TEXT
)
RETURNS TABLE (
  company_id UUID,
  user_id UUID,
  connection_id UUID
)
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $resolve_meta_subject_mapping$
  SELECT
    mapping.company_id,
    mapping.user_id,
    mapping.connection_id
  FROM ia4tube_social.social_meta_subject_mappings AS mapping
  WHERE requested_provider ~ '^[a-z][a-z0-9_]{0,49}$'
    AND requested_subject_digest ~ '^[0-9a-f]{64}$'
    AND mapping.provider = requested_provider
    AND mapping.subject_digest = requested_subject_digest
$resolve_meta_subject_mapping$;

CREATE FUNCTION ia4tube_social.resolve_compliance_status(
  requested_confirmation_digest TEXT
)
RETURNS TABLE (status TEXT)
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $resolve_compliance_status$
  SELECT request.status
  FROM ia4tube_social.social_compliance_requests AS request
  WHERE requested_confirmation_digest ~ '^[0-9a-f]{64}$'
    AND request.confirmation_code_digest = requested_confirmation_digest
$resolve_compliance_status$;

REVOKE ALL ON ia4tube_social.social_meta_subject_mappings FROM PUBLIC;
REVOKE ALL ON ia4tube_social.social_compliance_requests FROM PUBLIC;
REVOKE ALL ON FUNCTION ia4tube_social.resolve_meta_subject_mapping(
  TEXT,
  TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION ia4tube_social.resolve_compliance_status(
  TEXT
) FROM PUBLIC;

GRANT SELECT, INSERT
  ON ia4tube_social.social_meta_subject_mappings
  TO ia4tube_social_runtime;
GRANT UPDATE (
  user_id,
  connection_id,
  status,
  revoked_at,
  updated_at,
  revision
) ON ia4tube_social.social_meta_subject_mappings
  TO ia4tube_social_runtime;

GRANT SELECT, INSERT
  ON ia4tube_social.social_compliance_requests
  TO ia4tube_social_runtime;
GRANT UPDATE (
  status,
  details_code,
  token_materials_deleted,
  completed_at,
  updated_at,
  revision
) ON ia4tube_social.social_compliance_requests
  TO ia4tube_social_runtime;

GRANT DELETE
  ON ia4tube_social.social_encrypted_credentials
  TO ia4tube_social_runtime;

GRANT EXECUTE ON FUNCTION ia4tube_social.resolve_meta_subject_mapping(
  TEXT,
  TEXT
) TO ia4tube_social_runtime;
GRANT EXECUTE ON FUNCTION ia4tube_social.resolve_compliance_status(
  TEXT
) TO ia4tube_social_runtime;
