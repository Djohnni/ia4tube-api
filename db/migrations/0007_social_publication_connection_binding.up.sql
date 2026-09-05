ALTER TABLE ia4tube_social.social_publications
  ADD COLUMN bound_external_account_id UUID,
  ADD COLUMN expected_connection_revision BIGINT,
  ADD CONSTRAINT social_publications_binding_pair
    CHECK (
      (bound_external_account_id IS NULL) =
      (expected_connection_revision IS NULL)
    ),
  ADD CONSTRAINT social_publications_binding_revision_valid
    CHECK (
      expected_connection_revision IS NULL OR
      (
        expected_connection_revision >= 1 AND
        expected_connection_revision <= 9007199254740991
      )
    ),
  ADD CONSTRAINT social_publications_bound_account_fk
    FOREIGN KEY (company_id, connection_id, bound_external_account_id)
    REFERENCES ia4tube_social.social_external_accounts(company_id, connection_id, id)
    ON DELETE RESTRICT;

CREATE POLICY social_publications_bound_insert
  ON ia4tube_social.social_publications
  AS RESTRICTIVE
  FOR INSERT
  TO ia4tube_social_runtime
  WITH CHECK (
    bound_external_account_id IS NOT NULL AND
    expected_connection_revision IS NOT NULL
  );

CREATE POLICY social_publications_bound_update
  ON ia4tube_social.social_publications
  AS RESTRICTIVE
  FOR UPDATE
  TO ia4tube_social_runtime
  USING (
    bound_external_account_id IS NOT NULL AND
    expected_connection_revision IS NOT NULL
  )
  WITH CHECK (
    bound_external_account_id IS NOT NULL AND
    expected_connection_revision IS NOT NULL
  );
