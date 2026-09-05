ALTER TABLE ia4tube_social.social_connections
  DROP CONSTRAINT social_connections_status_allowed,
  DROP CONSTRAINT social_connections_status_timestamp_consistent,
  ADD CONSTRAINT social_connections_status_allowed
    CHECK (
      status IN (
        'pending',
        'active',
        'expired',
        'revoked',
        'disconnected',
        'error',
        'authorization_pending',
        'connected',
        'reconnect_required',
        'disconnecting',
        'failed'
      )
    ),
  ADD CONSTRAINT social_connections_status_timestamp_consistent
    CHECK (
      (
        status IN ('pending', 'authorization_pending') AND
        connected_at IS NULL AND
        revoked_at IS NULL AND
        disconnected_at IS NULL
      ) OR
      (
        status IN ('active', 'connected') AND
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
        status IN ('error', 'disconnecting', 'failed') AND
        revoked_at IS NULL AND
        disconnected_at IS NULL
      ) OR
      (
        status = 'reconnect_required' AND
        revoked_at IS NULL AND
        disconnected_at IS NULL
      )
    );

DO $social_connector_blocking_connection_gate$
BEGIN
  CREATE UNIQUE INDEX social_connections_instagram_blocking_company_unique
    ON ia4tube_social.social_connections (company_id)
    WHERE provider = 'instagram'
      AND status IN (
        'pending',
        'active',
        'authorization_pending',
        'connected',
        'reconnect_required',
        'disconnecting'
      );
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'social_connector_blocking_connection_conflict';
END
$social_connector_blocking_connection_gate$;

DO $social_connector_active_account_gate$
BEGIN
  CREATE UNIQUE INDEX social_external_accounts_instagram_active_company_unique
    ON ia4tube_social.social_external_accounts (company_id)
    WHERE provider = 'instagram' AND status = 'active';
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'social_connector_active_account_conflict';
END
$social_connector_active_account_gate$;

ALTER TABLE ia4tube_social.social_external_accounts
  ADD CONSTRAINT social_external_accounts_instagram_professional
    CHECK (
      provider <> 'instagram' OR
      (
        account_type IN ('business', 'creator') AND
        username IS NOT NULL
      )
    ) NOT VALID;

ALTER TABLE ia4tube_social.social_oauth_transactions
  ADD COLUMN connection_id UUID,
  ADD COLUMN failed_at TIMESTAMPTZ,
  ADD COLUMN failure_code TEXT,
  ADD COLUMN audit_event_id UUID,
  ADD COLUMN correlation_id UUID,
  ADD CONSTRAINT social_oauth_transactions_connection_fk
    FOREIGN KEY (company_id, connection_id, provider)
    REFERENCES ia4tube_social.social_connections(company_id, id, provider)
    ON DELETE RESTRICT
    NOT VALID,
  ADD CONSTRAINT social_oauth_transactions_context_all_or_none
    CHECK (
      (
        connection_id IS NULL AND
        audit_event_id IS NULL AND
        correlation_id IS NULL
      ) OR
      (
        connection_id IS NOT NULL AND
        audit_event_id IS NOT NULL AND
        correlation_id IS NOT NULL
      )
    ),
  ADD CONSTRAINT social_oauth_transactions_failure_pair
    CHECK (
      (failed_at IS NULL AND failure_code IS NULL) OR
      (failed_at IS NOT NULL AND failure_code IS NOT NULL)
    ),
  ADD CONSTRAINT social_oauth_transactions_failure_code_valid
    CHECK (
      failure_code IS NULL OR
      failure_code ~ '^[a-z][a-z0-9_]{0,99}$'
    ),
  ADD CONSTRAINT social_oauth_transactions_failure_after_creation
    CHECK (failed_at IS NULL OR failed_at >= created_at),
  ADD CONSTRAINT social_oauth_transactions_terminal_extended_exclusive
    CHECK (num_nonnulls(consumed_at, cancelled_at, failed_at) <= 1);

CREATE UNIQUE INDEX social_oauth_transactions_open_connection_unique
  ON ia4tube_social.social_oauth_transactions (
    company_id,
    connection_id,
    provider
  )
  WHERE connection_id IS NOT NULL
    AND consumed_at IS NULL
    AND cancelled_at IS NULL
    AND failed_at IS NULL;

CREATE INDEX social_oauth_transactions_correlation_idx
  ON ia4tube_social.social_oauth_transactions (
    company_id,
    correlation_id
  )
  WHERE correlation_id IS NOT NULL;

CREATE TABLE ia4tube_social.social_idempotency_operations (
  company_id UUID NOT NULL,
  operation_id UUID NOT NULL,
  provider TEXT NOT NULL,
  capability TEXT NOT NULL,
  request_hash CHAR(64) NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  result_payload JSONB,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revision BIGINT NOT NULL DEFAULT 1,
  PRIMARY KEY (company_id, operation_id),
  CONSTRAINT social_idempotency_operations_company_fk
    FOREIGN KEY (company_id)
    REFERENCES ia4tube_social.companies(id)
    ON DELETE RESTRICT,
  CONSTRAINT social_idempotency_operations_provider_valid
    CHECK (provider ~ '^[a-z][a-z0-9_]{0,49}$'),
  CONSTRAINT social_idempotency_operations_capability_allowed
    CHECK (
      capability IN (
        'beginAuthorization',
        'discoverAccount',
        'publishImage',
        'getPublicationStatus',
        'disconnect'
      )
    ),
  CONSTRAINT social_idempotency_operations_request_hash_format
    CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT social_idempotency_operations_status_allowed
    CHECK (status IN ('pending', 'completed')),
  CONSTRAINT social_idempotency_operations_result_object
    CHECK (
      result_payload IS NULL OR
      (
        jsonb_typeof(result_payload) = 'object' AND
        octet_length(result_payload::TEXT) <= 8192
      )
    ),
  CONSTRAINT social_idempotency_operations_error_code_valid
    CHECK (
      error_code IS NULL OR
      error_code ~ '^[a-z][a-z0-9_]{0,99}$'
    ),
  CONSTRAINT social_idempotency_operations_completion_consistent
    CHECK (
      (
        status = 'pending' AND
        result_payload IS NULL AND
        error_code IS NULL
      ) OR
      (
        status = 'completed' AND
        num_nonnulls(result_payload, error_code) = 1
      )
    ),
  CONSTRAINT social_idempotency_operations_revision_positive
    CHECK (revision > 0),
  CONSTRAINT social_idempotency_operations_update_order
    CHECK (updated_at >= created_at),
  CONSTRAINT social_idempotency_operations_request_identity_unique
    UNIQUE (company_id, operation_id, provider, request_hash)
);

CREATE TABLE ia4tube_social.social_publications (
  company_id UUID NOT NULL,
  id UUID NOT NULL,
  connection_id UUID NOT NULL,
  provider TEXT NOT NULL,
  media_reference TEXT NOT NULL,
  media_metadata_digest CHAR(64) NOT NULL,
  caption TEXT,
  state TEXT NOT NULL DEFAULT 'ready',
  idempotency_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  confirmed_provider_reference TEXT,
  reconciliation_reference TEXT,
  error_code TEXT,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revision BIGINT NOT NULL DEFAULT 1,
  PRIMARY KEY (company_id, id),
  CONSTRAINT social_publications_company_fk
    FOREIGN KEY (company_id)
    REFERENCES ia4tube_social.companies(id)
    ON DELETE RESTRICT,
  CONSTRAINT social_publications_connection_fk
    FOREIGN KEY (company_id, connection_id, provider)
    REFERENCES ia4tube_social.social_connections(company_id, id, provider)
    ON DELETE RESTRICT,
  CONSTRAINT social_publications_idempotency_fk
    FOREIGN KEY (company_id, idempotency_key, provider, request_hash)
    REFERENCES ia4tube_social.social_idempotency_operations(
      company_id,
      operation_id,
      provider,
      request_hash
    )
    ON DELETE RESTRICT,
  CONSTRAINT social_publications_provider_valid
    CHECK (provider ~ '^[a-z][a-z0-9_]{0,49}$'),
  CONSTRAINT social_publications_media_reference_valid
    CHECK (
      length(media_reference) BETWEEN 1 AND 200 AND
      media_reference = btrim(media_reference) AND
      media_reference !~ '[\\/?#[:cntrl:]]'
    ),
  CONSTRAINT social_publications_media_metadata_digest_format
    CHECK (media_metadata_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT social_publications_caption_valid
    CHECK (caption IS NULL OR length(caption) <= 2200),
  CONSTRAINT social_publications_state_allowed
    CHECK (
      state IN (
        'ready',
        'publishing',
        'provider_confirming',
        'published',
        'failed_temporary',
        'failed_permanent'
      )
    ),
  CONSTRAINT social_publications_request_hash_format
    CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT social_publications_confirmed_reference_valid
    CHECK (
      confirmed_provider_reference IS NULL OR
      (
        confirmed_provider_reference ~
          '^[A-Za-z0-9][A-Za-z0-9._:-]{0,499}$' AND
        confirmed_provider_reference !~*
          '(access[_-]?token|refresh[_-]?token|authorization|bearer|password|secret|oauth[_-]?code|api[_-]?key|ciphertext)'
      )
    ),
  CONSTRAINT social_publications_reconciliation_reference_valid
    CHECK (
      reconciliation_reference IS NULL OR
      (
        reconciliation_reference ~
          '^[A-Za-z0-9][A-Za-z0-9._:-]{0,499}$' AND
        reconciliation_reference !~*
          '(access[_-]?token|refresh[_-]?token|authorization|bearer|password|secret|oauth[_-]?code|api[_-]?key|ciphertext)'
      )
    ),
  CONSTRAINT social_publications_error_code_valid
    CHECK (
      error_code IS NULL OR
      error_code ~ '^[a-z][a-z0-9_]{0,99}$'
    ),
  CONSTRAINT social_publications_confirmation_consistent
    CHECK (
      (
        state = 'published' AND
        confirmed_provider_reference IS NOT NULL AND
        published_at IS NOT NULL
      ) OR
      (
        state <> 'published' AND
        confirmed_provider_reference IS NULL AND
        published_at IS NULL
      )
    ),
  CONSTRAINT social_publications_reconciliation_consistent
    CHECK (
      reconciliation_reference IS NULL OR
      state IN ('provider_confirming', 'published')
    ),
  CONSTRAINT social_publications_error_state_consistent
    CHECK (
      error_code IS NULL OR
      state IN ('failed_temporary', 'failed_permanent')
    ),
  CONSTRAINT social_publications_publication_after_creation
    CHECK (published_at IS NULL OR published_at >= created_at),
  CONSTRAINT social_publications_revision_positive
    CHECK (revision > 0),
  CONSTRAINT social_publications_update_order
    CHECK (updated_at >= created_at),
  CONSTRAINT social_publications_provider_identity_unique
    UNIQUE (company_id, id, provider),
  CONSTRAINT social_publications_idempotency_unique
    UNIQUE (company_id, idempotency_key)
);

CREATE TABLE ia4tube_social.social_publication_attempts (
  company_id UUID NOT NULL,
  publication_id UUID NOT NULL,
  provider TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'started',
  error_code TEXT,
  provider_reference TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TIMESTAMPTZ,
  duration_ms BIGINT,
  retry_after TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revision BIGINT NOT NULL DEFAULT 1,
  PRIMARY KEY (company_id, publication_id, attempt_number),
  CONSTRAINT social_publication_attempts_publication_fk
    FOREIGN KEY (company_id, publication_id, provider)
    REFERENCES ia4tube_social.social_publications(company_id, id, provider)
    ON DELETE RESTRICT,
  CONSTRAINT social_publication_attempts_provider_valid
    CHECK (provider ~ '^[a-z][a-z0-9_]{0,49}$'),
  CONSTRAINT social_publication_attempts_number_positive
    CHECK (attempt_number > 0),
  CONSTRAINT social_publication_attempts_state_allowed
    CHECK (
      state IN (
        'started',
        'provider_confirming',
        'published',
        'failed_temporary',
        'failed_permanent'
      )
    ),
  CONSTRAINT social_publication_attempts_error_code_valid
    CHECK (
      error_code IS NULL OR
      error_code ~ '^[a-z][a-z0-9_]{0,99}$'
    ),
  CONSTRAINT social_publication_attempts_reference_valid
    CHECK (
      provider_reference IS NULL OR
      (
        provider_reference ~
          '^[A-Za-z0-9][A-Za-z0-9._:-]{0,499}$' AND
        provider_reference !~*
          '(access[_-]?token|refresh[_-]?token|authorization|bearer|password|secret|oauth[_-]?code|api[_-]?key|ciphertext)'
      )
    ),
  CONSTRAINT social_publication_attempts_completion_consistent
    CHECK (
      (
        state = 'started' AND
        finished_at IS NULL AND
        duration_ms IS NULL AND
        error_code IS NULL
      ) OR
      (
        state <> 'started' AND
        finished_at IS NOT NULL AND
        duration_ms IS NOT NULL
      )
    ),
  CONSTRAINT social_publication_attempts_result_consistent
    CHECK (
      (
        state = 'published' AND
        provider_reference IS NOT NULL AND
        error_code IS NULL
      ) OR
      (
        state = 'provider_confirming' AND
        error_code IS NULL
      ) OR
      (
        state IN ('failed_temporary', 'failed_permanent') AND
        provider_reference IS NULL AND
        error_code IS NOT NULL
      ) OR
      state = 'started'
    ),
  CONSTRAINT social_publication_attempts_duration_nonnegative
    CHECK (duration_ms IS NULL OR duration_ms >= 0),
  CONSTRAINT social_publication_attempts_finish_after_start
    CHECK (finished_at IS NULL OR finished_at >= started_at),
  CONSTRAINT social_publication_attempts_retry_consistent
    CHECK (
      retry_after IS NULL OR
      (
        state = 'failed_temporary' AND
        finished_at IS NOT NULL AND
        retry_after >= finished_at
      )
    ),
  CONSTRAINT social_publication_attempts_revision_positive
    CHECK (revision > 0),
  CONSTRAINT social_publication_attempts_update_order
    CHECK (updated_at >= created_at)
);

ALTER TABLE ia4tube_social.social_audit_events
  ADD COLUMN provider TEXT,
  ADD COLUMN correlation_id UUID,
  ADD COLUMN publication_id UUID,
  ADD CONSTRAINT social_audit_events_provider_valid
    CHECK (
      provider IS NULL OR
      provider ~ '^[a-z][a-z0-9_]{0,49}$'
    ),
  ADD CONSTRAINT social_audit_events_reference_provider_present
    CHECK (
      (
        connection_id IS NULL AND
        publication_id IS NULL
      ) OR
      provider IS NOT NULL
    )
    NOT VALID,
  ADD CONSTRAINT social_audit_events_connection_provider_fk
    FOREIGN KEY (company_id, connection_id, provider)
    REFERENCES ia4tube_social.social_connections(company_id, id, provider)
    ON DELETE RESTRICT
    NOT VALID,
  ADD CONSTRAINT social_audit_events_publication_provider_fk
    FOREIGN KEY (company_id, publication_id, provider)
    REFERENCES ia4tube_social.social_publications(company_id, id, provider)
    ON DELETE RESTRICT
    NOT VALID;

CREATE INDEX social_idempotency_operations_pending_idx
  ON ia4tube_social.social_idempotency_operations (
    company_id,
    provider,
    created_at
  )
  WHERE status = 'pending';

CREATE INDEX social_publications_connection_state_idx
  ON ia4tube_social.social_publications (
    company_id,
    connection_id,
    state,
    updated_at DESC
  );

CREATE UNIQUE INDEX social_publications_confirmed_reference_unique
  ON ia4tube_social.social_publications (
    company_id,
    provider,
    confirmed_provider_reference
  )
  WHERE confirmed_provider_reference IS NOT NULL;

CREATE INDEX social_publication_attempts_state_idx
  ON ia4tube_social.social_publication_attempts (
    company_id,
    publication_id,
    state,
    attempt_number DESC
  );

CREATE INDEX social_audit_events_correlation_idx
  ON ia4tube_social.social_audit_events (
    company_id,
    correlation_id,
    occurred_at DESC
  )
  WHERE correlation_id IS NOT NULL;

ALTER TABLE ia4tube_social.social_idempotency_operations
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE ia4tube_social.social_idempotency_operations
  FORCE ROW LEVEL SECURITY;
ALTER TABLE ia4tube_social.social_publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE ia4tube_social.social_publications FORCE ROW LEVEL SECURITY;
ALTER TABLE ia4tube_social.social_publication_attempts
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE ia4tube_social.social_publication_attempts
  FORCE ROW LEVEL SECURITY;

CREATE POLICY social_idempotency_operations_company_scope
  ON ia4tube_social.social_idempotency_operations
  USING (
    company_id =
      NULLIF(current_setting('ia4tube.company_id', true), '')::UUID
  )
  WITH CHECK (
    company_id =
      NULLIF(current_setting('ia4tube.company_id', true), '')::UUID
  );

CREATE POLICY social_publications_company_scope
  ON ia4tube_social.social_publications
  USING (
    company_id =
      NULLIF(current_setting('ia4tube.company_id', true), '')::UUID
  )
  WITH CHECK (
    company_id =
      NULLIF(current_setting('ia4tube.company_id', true), '')::UUID
  );

CREATE POLICY social_publication_attempts_company_scope
  ON ia4tube_social.social_publication_attempts
  USING (
    company_id =
      NULLIF(current_setting('ia4tube.company_id', true), '')::UUID
  )
  WITH CHECK (
    company_id =
      NULLIF(current_setting('ia4tube.company_id', true), '')::UUID
  );

REVOKE ALL ON ia4tube_social.social_idempotency_operations FROM PUBLIC;
REVOKE ALL ON ia4tube_social.social_publications FROM PUBLIC;
REVOKE ALL ON ia4tube_social.social_publication_attempts FROM PUBLIC;

GRANT SELECT, INSERT
  ON ia4tube_social.social_idempotency_operations
  TO ia4tube_social_runtime;
GRANT UPDATE (
  status,
  result_payload,
  error_code,
  updated_at,
  revision
) ON ia4tube_social.social_idempotency_operations
  TO ia4tube_social_runtime;

GRANT SELECT, INSERT
  ON ia4tube_social.social_publications
  TO ia4tube_social_runtime;
GRANT UPDATE (
  state,
  confirmed_provider_reference,
  reconciliation_reference,
  error_code,
  published_at,
  updated_at,
  revision
) ON ia4tube_social.social_publications
  TO ia4tube_social_runtime;

GRANT SELECT, INSERT
  ON ia4tube_social.social_publication_attempts
  TO ia4tube_social_runtime;
GRANT UPDATE (
  state,
  error_code,
  provider_reference,
  finished_at,
  duration_ms,
  retry_after,
  updated_at,
  revision
) ON ia4tube_social.social_publication_attempts
  TO ia4tube_social_runtime;

GRANT UPDATE (failed_at, failure_code)
  ON ia4tube_social.social_oauth_transactions
  TO ia4tube_social_runtime;

GRANT UPDATE (connection_id, oauth_transaction_id)
  ON ia4tube_social.social_encrypted_credentials
  TO ia4tube_social_runtime;
