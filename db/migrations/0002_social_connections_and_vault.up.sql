CREATE TABLE ia4tube_social.social_connections (
  company_id UUID NOT NULL,
  id UUID NOT NULL,
  provider TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  connected_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  disconnected_at TIMESTAMPTZ,
  created_by_user_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revision BIGINT NOT NULL DEFAULT 1,
  PRIMARY KEY (company_id, id),
  CONSTRAINT social_connections_company_fk
    FOREIGN KEY (company_id)
    REFERENCES ia4tube_social.companies(id)
    ON DELETE RESTRICT,
  CONSTRAINT social_connections_creator_fk
    FOREIGN KEY (company_id, created_by_user_id)
    REFERENCES ia4tube_social.users(company_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT social_connections_provider_valid
    CHECK (provider ~ '^[a-z][a-z0-9_]{0,49}$'),
  CONSTRAINT social_connections_status_allowed
    CHECK (
      status IN (
        'pending',
        'active',
        'expired',
        'revoked',
        'disconnected',
        'error'
      )
    ),
  CONSTRAINT social_connections_revision_positive
    CHECK (revision > 0),
  CONSTRAINT social_connections_expiry_after_connection
    CHECK (
      expires_at IS NULL OR
      connected_at IS NULL OR
      expires_at > connected_at
    ),
  CONSTRAINT social_connections_terminal_timestamp_exclusive
    CHECK (num_nonnulls(revoked_at, disconnected_at) <= 1),
  CONSTRAINT social_connections_status_timestamp_consistent
    CHECK (
      (
        status = 'pending' AND
        connected_at IS NULL AND
        revoked_at IS NULL AND
        disconnected_at IS NULL
      ) OR
      (
        status = 'active' AND
        connected_at IS NOT NULL AND
        revoked_at IS NULL AND
        disconnected_at IS NULL
      ) OR
      (
        status = 'expired' AND
        expires_at IS NOT NULL AND
        revoked_at IS NULL AND
        disconnected_at IS NULL
      ) OR
      (
        status = 'revoked' AND
        revoked_at IS NOT NULL AND
        disconnected_at IS NULL
      ) OR
      (
        status = 'disconnected' AND
        disconnected_at IS NOT NULL AND
        revoked_at IS NULL
      ) OR
      (
        status = 'error' AND
        revoked_at IS NULL AND
        disconnected_at IS NULL
      )
    ),
  CONSTRAINT social_connections_provider_identity_unique
    UNIQUE (company_id, id, provider)
);

CREATE TABLE ia4tube_social.social_external_accounts (
  company_id UUID NOT NULL,
  id UUID NOT NULL,
  connection_id UUID NOT NULL,
  provider TEXT NOT NULL,
  external_id TEXT NOT NULL,
  username TEXT,
  display_name TEXT,
  account_type TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (company_id, id),
  CONSTRAINT social_external_accounts_connection_fk
    FOREIGN KEY (company_id, connection_id, provider)
    REFERENCES ia4tube_social.social_connections(company_id, id, provider)
    ON DELETE RESTRICT,
  CONSTRAINT social_external_accounts_provider_valid
    CHECK (provider ~ '^[a-z][a-z0-9_]{0,49}$'),
  CONSTRAINT social_external_accounts_external_id_not_blank
    CHECK (length(btrim(external_id)) BETWEEN 1 AND 500),
  CONSTRAINT social_external_accounts_username_valid
    CHECK (username IS NULL OR length(btrim(username)) BETWEEN 1 AND 200),
  CONSTRAINT social_external_accounts_display_name_valid
    CHECK (
      display_name IS NULL OR
      length(btrim(display_name)) BETWEEN 1 AND 300
    ),
  CONSTRAINT social_external_accounts_status_allowed
    CHECK (status IN ('active', 'unavailable', 'revoked')),
  CONSTRAINT social_external_accounts_provider_external_unique
    UNIQUE (company_id, provider, external_id),
  CONSTRAINT social_external_accounts_connection_id_unique
    UNIQUE (company_id, connection_id, id)
);

CREATE TABLE ia4tube_social.social_destinations (
  company_id UUID NOT NULL,
  id UUID NOT NULL,
  connection_id UUID NOT NULL,
  external_account_id UUID NOT NULL,
  destination_type TEXT NOT NULL,
  external_id TEXT NOT NULL,
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (company_id, id),
  CONSTRAINT social_destinations_connection_fk
    FOREIGN KEY (company_id, connection_id)
    REFERENCES ia4tube_social.social_connections(company_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT social_destinations_account_fk
    FOREIGN KEY (company_id, connection_id, external_account_id)
    REFERENCES ia4tube_social.social_external_accounts(
      company_id,
      connection_id,
      id
    )
    ON DELETE RESTRICT,
  CONSTRAINT social_destinations_type_valid
    CHECK (destination_type ~ '^[a-z][a-z0-9_]{0,49}$'),
  CONSTRAINT social_destinations_external_id_not_blank
    CHECK (length(btrim(external_id)) BETWEEN 1 AND 500),
  CONSTRAINT social_destinations_status_allowed
    CHECK (status IN ('active', 'unavailable', 'revoked')),
  CONSTRAINT social_destinations_external_unique
    UNIQUE (
      company_id,
      connection_id,
      destination_type,
      external_id
    )
);

CREATE TABLE ia4tube_social.social_connection_scopes (
  company_id UUID NOT NULL,
  connection_id UUID NOT NULL,
  scope TEXT NOT NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ,
  PRIMARY KEY (company_id, connection_id, scope),
  CONSTRAINT social_connection_scopes_connection_fk
    FOREIGN KEY (company_id, connection_id)
    REFERENCES ia4tube_social.social_connections(company_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT social_connection_scopes_scope_valid
    CHECK (length(btrim(scope)) BETWEEN 1 AND 200),
  CONSTRAINT social_connection_scopes_expiry_after_grant
    CHECK (expires_at IS NULL OR expires_at > granted_at)
);

CREATE TABLE ia4tube_social.social_oauth_transactions (
  company_id UUID NOT NULL,
  id UUID NOT NULL,
  provider TEXT NOT NULL,
  purpose TEXT NOT NULL,
  state_digest CHAR(64) NOT NULL,
  redirect_uri_digest CHAR(64) NOT NULL,
  initiated_by_user_id UUID NOT NULL,
  session_jti_digest CHAR(64) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (company_id, id),
  CONSTRAINT social_oauth_transactions_company_fk
    FOREIGN KEY (company_id)
    REFERENCES ia4tube_social.companies(id)
    ON DELETE RESTRICT,
  CONSTRAINT social_oauth_transactions_user_fk
    FOREIGN KEY (company_id, initiated_by_user_id)
    REFERENCES ia4tube_social.users(company_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT social_oauth_transactions_provider_valid
    CHECK (provider ~ '^[a-z][a-z0-9_]{0,49}$'),
  CONSTRAINT social_oauth_transactions_purpose_allowed
    CHECK (purpose IN ('connect', 'reconnect')),
  CONSTRAINT social_oauth_transactions_state_digest_format
    CHECK (state_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT social_oauth_transactions_redirect_digest_format
    CHECK (redirect_uri_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT social_oauth_transactions_jti_digest_format
    CHECK (session_jti_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT social_oauth_transactions_expiry_after_creation
    CHECK (expires_at > created_at),
  CONSTRAINT social_oauth_transactions_terminal_exclusive
    CHECK (num_nonnulls(consumed_at, cancelled_at) <= 1),
  CONSTRAINT social_oauth_transactions_state_unique
    UNIQUE (state_digest),
  CONSTRAINT social_oauth_transactions_provider_identity_unique
    UNIQUE (company_id, id, provider)
);

CREATE TABLE ia4tube_social.social_encrypted_credentials (
  company_id UUID NOT NULL,
  id UUID NOT NULL,
  provider TEXT NOT NULL,
  connection_id UUID,
  oauth_transaction_id UUID,
  credential_type TEXT NOT NULL,
  ciphertext BYTEA NOT NULL,
  nonce BYTEA NOT NULL,
  auth_tag BYTEA NOT NULL,
  key_version TEXT NOT NULL,
  aad_version SMALLINT NOT NULL,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revision BIGINT NOT NULL DEFAULT 1,
  PRIMARY KEY (company_id, id),
  CONSTRAINT social_encrypted_credentials_company_fk
    FOREIGN KEY (company_id)
    REFERENCES ia4tube_social.companies(id)
    ON DELETE RESTRICT,
  CONSTRAINT social_encrypted_credentials_connection_fk
    FOREIGN KEY (company_id, connection_id, provider)
    REFERENCES ia4tube_social.social_connections(company_id, id, provider)
    ON DELETE RESTRICT,
  CONSTRAINT social_encrypted_credentials_oauth_fk
    FOREIGN KEY (company_id, oauth_transaction_id, provider)
    REFERENCES ia4tube_social.social_oauth_transactions(
      company_id,
      id,
      provider
    )
    ON DELETE RESTRICT,
  CONSTRAINT social_encrypted_credentials_subject_exactly_one
    CHECK (num_nonnulls(connection_id, oauth_transaction_id) = 1),
  CONSTRAINT social_encrypted_credentials_provider_valid
    CHECK (provider ~ '^[a-z][a-z0-9_]{0,49}$'),
  CONSTRAINT social_encrypted_credentials_type_valid
    CHECK (credential_type ~ '^[a-z][a-z0-9_]{0,49}$'),
  CONSTRAINT social_encrypted_credentials_ciphertext_not_empty
    CHECK (octet_length(ciphertext) > 0),
  CONSTRAINT social_encrypted_credentials_nonce_size
    CHECK (octet_length(nonce) = 12),
  CONSTRAINT social_encrypted_credentials_tag_size
    CHECK (octet_length(auth_tag) = 16),
  CONSTRAINT social_encrypted_credentials_key_version_valid
    CHECK (key_version ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,49}$'),
  CONSTRAINT social_encrypted_credentials_aad_version
    CHECK (aad_version = 1),
  CONSTRAINT social_encrypted_credentials_revision_positive
    CHECK (revision > 0),
  CONSTRAINT social_encrypted_credentials_expiry_after_creation
    CHECK (expires_at IS NULL OR expires_at > created_at),
  CONSTRAINT social_encrypted_credentials_revocation_after_creation
    CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  CONSTRAINT social_encrypted_credentials_key_nonce_unique
    UNIQUE (key_version, nonce)
);

CREATE TABLE ia4tube_social.social_reauth_grants (
  company_id UUID NOT NULL,
  id UUID NOT NULL,
  user_id UUID NOT NULL,
  token_digest CHAR(64) NOT NULL,
  session_jti_digest CHAR(64) NOT NULL,
  action TEXT NOT NULL,
  provider TEXT NOT NULL,
  target_connection_id UUID,
  auth_version BIGINT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (company_id, id),
  CONSTRAINT social_reauth_grants_user_fk
    FOREIGN KEY (company_id, user_id)
    REFERENCES ia4tube_social.users(company_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT social_reauth_grants_connection_fk
    FOREIGN KEY (company_id, target_connection_id, provider)
    REFERENCES ia4tube_social.social_connections(company_id, id, provider)
    ON DELETE RESTRICT,
  CONSTRAINT social_reauth_grants_token_digest_format
    CHECK (token_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT social_reauth_grants_jti_digest_format
    CHECK (session_jti_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT social_reauth_grants_action_allowed
    CHECK (
      action IN (
        'social.connect',
        'social.disconnect',
        'social.revoke'
      )
    ),
  CONSTRAINT social_reauth_grants_provider_valid
    CHECK (provider ~ '^[a-z][a-z0-9_]{0,49}$'),
  CONSTRAINT social_reauth_grants_target_matches_action
    CHECK (
      (action = 'social.connect' AND target_connection_id IS NULL) OR
      (
        action IN ('social.disconnect', 'social.revoke') AND
        target_connection_id IS NOT NULL
      )
    ),
  CONSTRAINT social_reauth_grants_auth_version_positive
    CHECK (auth_version > 0),
  CONSTRAINT social_reauth_grants_expiry_bounded
    CHECK (
      expires_at > created_at AND
      expires_at <= created_at + INTERVAL '5 minutes'
    ),
  CONSTRAINT social_reauth_grants_token_unique
    UNIQUE (token_digest)
);

CREATE TABLE ia4tube_social.social_audit_events (
  company_id UUID NOT NULL,
  id UUID NOT NULL,
  event_id UUID NOT NULL,
  actor_user_id UUID,
  connection_id UUID,
  action TEXT NOT NULL,
  outcome TEXT NOT NULL,
  details_code TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (company_id, id),
  CONSTRAINT social_audit_events_company_fk
    FOREIGN KEY (company_id)
    REFERENCES ia4tube_social.companies(id)
    ON DELETE RESTRICT,
  CONSTRAINT social_audit_events_actor_fk
    FOREIGN KEY (company_id, actor_user_id)
    REFERENCES ia4tube_social.users(company_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT social_audit_events_connection_fk
    FOREIGN KEY (company_id, connection_id)
    REFERENCES ia4tube_social.social_connections(company_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT social_audit_events_action_valid
    CHECK (action ~ '^[a-z][a-z0-9_.]{1,99}$'),
  CONSTRAINT social_audit_events_outcome_allowed
    CHECK (outcome IN ('succeeded', 'rejected', 'failed')),
  CONSTRAINT social_audit_events_details_code_valid
    CHECK (
      details_code IS NULL OR
      details_code ~ '^[a-z][a-z0-9_]{0,99}$'
    ),
  CONSTRAINT social_audit_events_event_unique
    UNIQUE (company_id, event_id)
);

CREATE INDEX social_connections_company_provider_status_idx
  ON ia4tube_social.social_connections (company_id, provider, status);
CREATE INDEX social_oauth_transactions_expiry_idx
  ON ia4tube_social.social_oauth_transactions (expires_at)
  WHERE consumed_at IS NULL AND cancelled_at IS NULL;
CREATE INDEX social_credentials_rotation_idx
  ON ia4tube_social.social_encrypted_credentials (
    company_id,
    key_version,
    id
  )
  WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX social_credentials_active_connection_unique
  ON ia4tube_social.social_encrypted_credentials (
    company_id,
    connection_id,
    credential_type
  )
  WHERE connection_id IS NOT NULL AND revoked_at IS NULL;
CREATE UNIQUE INDEX social_credentials_active_oauth_unique
  ON ia4tube_social.social_encrypted_credentials (
    company_id,
    oauth_transaction_id,
    credential_type
  )
  WHERE oauth_transaction_id IS NOT NULL AND revoked_at IS NULL;
CREATE INDEX social_reauth_grants_expiry_idx
  ON ia4tube_social.social_reauth_grants (expires_at)
  WHERE consumed_at IS NULL;
CREATE INDEX social_audit_events_connection_time_idx
  ON ia4tube_social.social_audit_events (
    company_id,
    connection_id,
    occurred_at DESC
  );

ALTER TABLE ia4tube_social.social_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE ia4tube_social.social_connections FORCE ROW LEVEL SECURITY;
ALTER TABLE ia4tube_social.social_external_accounts
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE ia4tube_social.social_external_accounts
  FORCE ROW LEVEL SECURITY;
ALTER TABLE ia4tube_social.social_destinations ENABLE ROW LEVEL SECURITY;
ALTER TABLE ia4tube_social.social_destinations FORCE ROW LEVEL SECURITY;
ALTER TABLE ia4tube_social.social_connection_scopes
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE ia4tube_social.social_connection_scopes
  FORCE ROW LEVEL SECURITY;
ALTER TABLE ia4tube_social.social_oauth_transactions
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE ia4tube_social.social_oauth_transactions
  FORCE ROW LEVEL SECURITY;
ALTER TABLE ia4tube_social.social_encrypted_credentials
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE ia4tube_social.social_encrypted_credentials
  FORCE ROW LEVEL SECURITY;
ALTER TABLE ia4tube_social.social_reauth_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE ia4tube_social.social_reauth_grants FORCE ROW LEVEL SECURITY;
ALTER TABLE ia4tube_social.social_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ia4tube_social.social_audit_events FORCE ROW LEVEL SECURITY;

CREATE POLICY social_connections_company_scope
  ON ia4tube_social.social_connections
  USING (
    company_id =
      NULLIF(current_setting('ia4tube.company_id', true), '')::UUID
  )
  WITH CHECK (
    company_id =
      NULLIF(current_setting('ia4tube.company_id', true), '')::UUID
  );
CREATE POLICY social_external_accounts_company_scope
  ON ia4tube_social.social_external_accounts
  USING (
    company_id =
      NULLIF(current_setting('ia4tube.company_id', true), '')::UUID
  )
  WITH CHECK (
    company_id =
      NULLIF(current_setting('ia4tube.company_id', true), '')::UUID
  );
CREATE POLICY social_destinations_company_scope
  ON ia4tube_social.social_destinations
  USING (
    company_id =
      NULLIF(current_setting('ia4tube.company_id', true), '')::UUID
  )
  WITH CHECK (
    company_id =
      NULLIF(current_setting('ia4tube.company_id', true), '')::UUID
  );
CREATE POLICY social_connection_scopes_company_scope
  ON ia4tube_social.social_connection_scopes
  USING (
    company_id =
      NULLIF(current_setting('ia4tube.company_id', true), '')::UUID
  )
  WITH CHECK (
    company_id =
      NULLIF(current_setting('ia4tube.company_id', true), '')::UUID
  );
CREATE POLICY social_oauth_transactions_company_scope
  ON ia4tube_social.social_oauth_transactions
  USING (
    company_id =
      NULLIF(current_setting('ia4tube.company_id', true), '')::UUID
  )
  WITH CHECK (
    company_id =
      NULLIF(current_setting('ia4tube.company_id', true), '')::UUID
  );
CREATE POLICY social_encrypted_credentials_company_scope
  ON ia4tube_social.social_encrypted_credentials
  USING (
    company_id =
      NULLIF(current_setting('ia4tube.company_id', true), '')::UUID
  )
  WITH CHECK (
    company_id =
      NULLIF(current_setting('ia4tube.company_id', true), '')::UUID
  );
CREATE POLICY social_reauth_grants_company_scope
  ON ia4tube_social.social_reauth_grants
  USING (
    company_id =
      NULLIF(current_setting('ia4tube.company_id', true), '')::UUID
  )
  WITH CHECK (
    company_id =
      NULLIF(current_setting('ia4tube.company_id', true), '')::UUID
  );
CREATE POLICY social_audit_events_company_scope
  ON ia4tube_social.social_audit_events
  USING (
    company_id =
      NULLIF(current_setting('ia4tube.company_id', true), '')::UUID
  )
  WITH CHECK (
    company_id =
      NULLIF(current_setting('ia4tube.company_id', true), '')::UUID
  );

REVOKE ALL ON ALL TABLES IN SCHEMA ia4tube_social FROM PUBLIC;
GRANT SELECT, INSERT
  ON ia4tube_social.social_connections
  TO ia4tube_social_runtime;
GRANT UPDATE (
  status,
  connected_at,
  expires_at,
  revoked_at,
  disconnected_at,
  updated_at,
  revision
) ON ia4tube_social.social_connections TO ia4tube_social_runtime;

GRANT SELECT, INSERT
  ON ia4tube_social.social_external_accounts
  TO ia4tube_social_runtime;
GRANT UPDATE (
  username,
  display_name,
  account_type,
  status,
  updated_at
) ON ia4tube_social.social_external_accounts TO ia4tube_social_runtime;

GRANT SELECT, INSERT
  ON ia4tube_social.social_destinations
  TO ia4tube_social_runtime;
GRANT UPDATE (
  display_name,
  status,
  updated_at
) ON ia4tube_social.social_destinations TO ia4tube_social_runtime;

GRANT SELECT, INSERT, DELETE
  ON ia4tube_social.social_connection_scopes
  TO ia4tube_social_runtime;
GRANT UPDATE (expires_at)
  ON ia4tube_social.social_connection_scopes
  TO ia4tube_social_runtime;

GRANT SELECT, INSERT
  ON ia4tube_social.social_oauth_transactions
  TO ia4tube_social_runtime;
GRANT UPDATE (consumed_at, cancelled_at)
  ON ia4tube_social.social_oauth_transactions
  TO ia4tube_social_runtime;

GRANT SELECT, INSERT
  ON ia4tube_social.social_encrypted_credentials
  TO ia4tube_social_runtime;
GRANT UPDATE (
  ciphertext,
  nonce,
  auth_tag,
  key_version,
  expires_at,
  revoked_at,
  updated_at,
  revision
) ON ia4tube_social.social_encrypted_credentials
  TO ia4tube_social_runtime;

GRANT SELECT, INSERT
  ON ia4tube_social.social_reauth_grants
  TO ia4tube_social_runtime;
GRANT UPDATE (consumed_at)
  ON ia4tube_social.social_reauth_grants
  TO ia4tube_social_runtime;

GRANT SELECT, INSERT
  ON ia4tube_social.social_audit_events
  TO ia4tube_social_runtime;

CREATE VIEW ia4tube_social.runtime_schema_contract AS
SELECT version, checksum_sha256
FROM ia4tube_migrations.schema_migrations;

REVOKE ALL ON ia4tube_social.runtime_schema_contract FROM PUBLIC;
GRANT SELECT
  ON ia4tube_social.runtime_schema_contract
  TO ia4tube_social_runtime;
