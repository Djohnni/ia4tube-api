-- iA4tube LOCAL CANDIDATE ONLY. Not authorized/applied to any remote database.
-- Administrator must separately provision ia4tube_media_capacity_runtime with
-- NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE and a dedicated protected pool.
-- Never grant that role to the tenant-facing ia4tube_social_runtime principal.
-- This migration creates no credentials and does not enable workers or billing.
BEGIN;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ia4tube_media_capacity_runtime'
    AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreatedb AND NOT rolcreaterole) THEN
    RAISE EXCEPTION 'Restricted media capacity role must be provisioned separately';
  END IF;
  IF pg_has_role('ia4tube_social_runtime','ia4tube_media_capacity_runtime','MEMBER') THEN
    RAISE EXCEPTION 'Tenant runtime must not inherit global capacity role';
  END IF;
  IF pg_has_role('ia4tube_media_capacity_runtime','ia4tube_social_runtime','MEMBER') OR
     pg_has_role('ia4tube_media_capacity_runtime','ia4tube_social_owner','MEMBER') THEN
    RAISE EXCEPTION 'Global capacity coordinator must not inherit tenant data access';
  END IF;
END $$;
SET LOCAL ROLE ia4tube_social_owner;
CREATE TABLE ia4tube_calendar.global_media_capacity (
  singleton smallint PRIMARY KEY CHECK (singleton=1),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision>0),
  document jsonb NOT NULL CHECK (jsonb_typeof(document)='object' AND document->>'schema'='1'
    AND octet_length(document::text)<=8388608),
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO ia4tube_calendar.global_media_capacity(singleton,document)
  VALUES(1,'{"schema":1,"paused":false,"sequence":0,"dispatchSequence":0,"jobs":{}}'::jsonb);
ALTER TABLE ia4tube_calendar.global_media_capacity ENABLE ROW LEVEL SECURITY;
ALTER TABLE ia4tube_calendar.global_media_capacity FORCE ROW LEVEL SECURITY;
CREATE POLICY media_capacity_coordinator_scope ON ia4tube_calendar.global_media_capacity
  TO ia4tube_media_capacity_runtime USING (singleton=1) WITH CHECK (singleton=1);
REVOKE ALL ON ia4tube_calendar.global_media_capacity FROM PUBLIC,ia4tube_social_runtime;
GRANT USAGE ON SCHEMA ia4tube_calendar TO ia4tube_media_capacity_runtime;
GRANT SELECT ON ia4tube_calendar.global_media_capacity TO ia4tube_media_capacity_runtime;
GRANT UPDATE(document,revision,updated_at) ON ia4tube_calendar.global_media_capacity TO ia4tube_media_capacity_runtime;
COMMIT;
