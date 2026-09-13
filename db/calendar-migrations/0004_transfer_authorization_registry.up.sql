-- iA4tube LOCAL CANDIDATE ONLY. Not applied to any remote database.
-- A separate administrator must provision ia4tube_media_transfer_runtime and
-- its dedicated pool. No login, credential, function, worker or gate is created.
BEGIN;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ia4tube_media_transfer_runtime'
    AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication) THEN
    RAISE EXCEPTION 'Restricted media transfer role must be provisioned separately';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname<>'ia4tube_media_transfer_runtime'
    AND pg_has_role('ia4tube_media_transfer_runtime',r.oid,'MEMBER')) THEN
    RAISE EXCEPTION 'Media transfer registry role must not inherit other roles';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname IN ('ia4tube_social_runtime','ia4tube_media_capacity_runtime')
    AND pg_has_role(r.oid,'ia4tube_media_transfer_runtime','MEMBER')) THEN
    RAISE EXCEPTION 'Tenant and capacity roles must not inherit the transfer registry role';
  END IF;
END $$;
SET LOCAL ROLE ia4tube_social_owner;
CREATE TABLE ia4tube_calendar.transfer_authorization_registry (
  singleton smallint PRIMARY KEY CHECK (singleton=1),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision>0),
  document jsonb NOT NULL CHECK (jsonb_typeof(document)='object' AND document->>'schema'='1'
    AND jsonb_typeof(document->'grants')='object' AND octet_length(document::text)<=8388608
    AND jsonb_array_length(jsonb_path_query_array(document,'$.grants.keyvalue()'))<=4096),
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO ia4tube_calendar.transfer_authorization_registry(singleton,document)
  VALUES(1,'{"schema":1,"grants":{}}'::jsonb);
ALTER TABLE ia4tube_calendar.transfer_authorization_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE ia4tube_calendar.transfer_authorization_registry FORCE ROW LEVEL SECURITY;
-- Exact singleton scope for a trusted coordinator, NOT per-grant or tenant RLS.
-- The application resolves one SHA-256 dictionary key inside this bounded ledger.
CREATE POLICY media_transfer_registry_scope ON ia4tube_calendar.transfer_authorization_registry
  TO ia4tube_media_transfer_runtime USING (singleton=1) WITH CHECK (singleton=1);
REVOKE ALL ON ia4tube_calendar.transfer_authorization_registry FROM PUBLIC,ia4tube_social_runtime;
GRANT USAGE ON SCHEMA ia4tube_calendar TO ia4tube_media_transfer_runtime;
GRANT SELECT ON ia4tube_calendar.transfer_authorization_registry TO ia4tube_media_transfer_runtime;
GRANT UPDATE(document,revision,updated_at) ON ia4tube_calendar.transfer_authorization_registry TO ia4tube_media_transfer_runtime;
COMMIT;
