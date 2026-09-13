-- iA4tube: optional local candidate. Not applied at startup or authorized for production.
-- Requires calendar migration 0001 and the existing social owner/runtime roles.
BEGIN;
SET LOCAL ROLE ia4tube_social_owner;
CREATE TABLE ia4tube_calendar.import_upload_state (
  company_id uuid PRIMARY KEY REFERENCES ia4tube_social.companies(id) ON DELETE RESTRICT,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  document jsonb NOT NULL CHECK (
    jsonb_typeof(document) = 'object' AND document->>'schema' = '1'
    AND octet_length(document::text) <= 8388608
  ),
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE ia4tube_calendar.import_upload_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE ia4tube_calendar.import_upload_state FORCE ROW LEVEL SECURITY;
CREATE POLICY calendar_import_owner_scope ON ia4tube_calendar.import_upload_state
  USING (company_id = nullif(current_setting('ia4tube.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('ia4tube.company_id', true), '')::uuid);
REVOKE ALL ON ia4tube_calendar.import_upload_state FROM PUBLIC;
GRANT SELECT, INSERT ON ia4tube_calendar.import_upload_state TO ia4tube_social_runtime;
GRANT UPDATE (revision, document, updated_at) ON ia4tube_calendar.import_upload_state TO ia4tube_social_runtime;
COMMIT;
