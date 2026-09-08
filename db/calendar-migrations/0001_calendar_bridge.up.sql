-- Optional, additive calendar extension. Never executed at application startup.
-- Apply only with a separately authorized migration session. Social migrations 0001..0008 are unchanged.
BEGIN;
SET LOCAL ROLE ia4tube_social_owner;
CREATE SCHEMA ia4tube_calendar AUTHORIZATION ia4tube_social_owner;
REVOKE ALL ON SCHEMA ia4tube_calendar FROM PUBLIC;
GRANT USAGE ON SCHEMA ia4tube_calendar TO ia4tube_social_runtime;
CREATE TABLE ia4tube_calendar.owner_state (
  company_id uuid PRIMARY KEY REFERENCES ia4tube_social.companies(id) ON DELETE RESTRICT,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object' AND document->>'schema' = '1'),
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE ia4tube_calendar.owner_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE ia4tube_calendar.owner_state FORCE ROW LEVEL SECURITY;
CREATE POLICY calendar_owner_scope ON ia4tube_calendar.owner_state
  USING (company_id = nullif(current_setting('ia4tube.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('ia4tube.company_id', true), '')::uuid);
REVOKE ALL ON ia4tube_calendar.owner_state FROM PUBLIC;
GRANT SELECT, INSERT ON ia4tube_calendar.owner_state TO ia4tube_social_runtime;
GRANT UPDATE (revision, document, updated_at) ON ia4tube_calendar.owner_state TO ia4tube_social_runtime;
COMMIT;
