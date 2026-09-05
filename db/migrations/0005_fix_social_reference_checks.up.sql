ALTER TABLE ia4tube_social.social_publications
  DROP CONSTRAINT social_publications_confirmed_reference_valid;

ALTER TABLE ia4tube_social.social_publications
  ADD CONSTRAINT social_publications_confirmed_reference_valid
    CHECK (
      confirmed_provider_reference IS NULL OR
      (
        char_length(confirmed_provider_reference) BETWEEN 1 AND 499 AND
        confirmed_provider_reference ~ '^[A-Za-z0-9]' AND
        confirmed_provider_reference !~ '[^A-Za-z0-9._:-]' AND
        confirmed_provider_reference !~*
          '(access[_-]?token|refresh[_-]?token|authorization|bearer|password|secret|oauth[_-]?code|api[_-]?key|ciphertext)'
      )
    ) NOT VALID;

ALTER TABLE ia4tube_social.social_publications
  DROP CONSTRAINT social_publications_reconciliation_reference_valid;

ALTER TABLE ia4tube_social.social_publications
  ADD CONSTRAINT social_publications_reconciliation_reference_valid
    CHECK (
      reconciliation_reference IS NULL OR
      (
        char_length(reconciliation_reference) BETWEEN 1 AND 499 AND
        reconciliation_reference ~ '^[A-Za-z0-9]' AND
        reconciliation_reference !~ '[^A-Za-z0-9._:-]' AND
        reconciliation_reference !~*
          '(access[_-]?token|refresh[_-]?token|authorization|bearer|password|secret|oauth[_-]?code|api[_-]?key|ciphertext)'
      )
    ) NOT VALID;

ALTER TABLE ia4tube_social.social_publication_attempts
  DROP CONSTRAINT social_publication_attempts_reference_valid;

ALTER TABLE ia4tube_social.social_publication_attempts
  ADD CONSTRAINT social_publication_attempts_reference_valid
    CHECK (
      provider_reference IS NULL OR
      (
        char_length(provider_reference) BETWEEN 1 AND 499 AND
        provider_reference ~ '^[A-Za-z0-9]' AND
        provider_reference !~ '[^A-Za-z0-9._:-]' AND
        provider_reference !~*
          '(access[_-]?token|refresh[_-]?token|authorization|bearer|password|secret|oauth[_-]?code|api[_-]?key|ciphertext)'
      )
    ) NOT VALID;

ALTER TABLE ia4tube_social.social_publications
  VALIDATE CONSTRAINT social_publications_confirmed_reference_valid;

ALTER TABLE ia4tube_social.social_publications
  VALIDATE CONSTRAINT social_publications_reconciliation_reference_valid;

ALTER TABLE ia4tube_social.social_publication_attempts
  VALIDATE CONSTRAINT social_publication_attempts_reference_valid;
