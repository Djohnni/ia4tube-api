CREATE FUNCTION ia4tube_social.ensure_official_owner(
  requested_company_id UUID,
  requested_user_id UUID,
  requested_identity_derivation_version TEXT
)
RETURNS TABLE (
  company_id UUID,
  user_id UUID,
  identity_derivation_version TEXT,
  role TEXT,
  auth_version BIGINT,
  created BOOLEAN
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $official_owner$
DECLARE
  existing_company ia4tube_social.companies%ROWTYPE;
  existing_user ia4tube_social.users%ROWTYPE;
  existing_membership ia4tube_social.company_memberships%ROWTYPE;
  company_count BIGINT;
  user_count BIGINT;
  membership_count BIGINT;
  expected_digest TEXT;
BEGIN
  IF requested_company_id IS NULL OR requested_user_id IS NULL OR
     requested_company_id::TEXT !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' OR
     requested_user_id::TEXT !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' OR
     requested_identity_derivation_version IS NULL OR
     requested_identity_derivation_version !~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,49}$' OR
     pg_catalog.current_setting('ia4tube.company_id', TRUE) IS DISTINCT FROM requested_company_id::TEXT OR
     pg_catalog.current_setting('ia4tube.user_id', TRUE) IS DISTINCT FROM requested_user_id::TEXT THEN
    RAISE EXCEPTION USING ERRCODE = 'PTB01', MESSAGE = 'official_owner_binding_conflict';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'ia4tube-social-official-owner-v1:' || requested_company_id::TEXT, 0
  ));
  PERFORM c.id FROM ia4tube_social.companies c
    WHERE c.id = requested_company_id FOR UPDATE;
  PERFORM u.id FROM ia4tube_social.users u
    WHERE u.company_id = requested_company_id ORDER BY u.id FOR UPDATE;
  PERFORM m.user_id FROM ia4tube_social.company_memberships m
    WHERE m.company_id = requested_company_id ORDER BY m.user_id FOR UPDATE;

  SELECT count(*) INTO company_count FROM ia4tube_social.companies c
    WHERE c.id = requested_company_id;
  SELECT count(*) INTO user_count FROM ia4tube_social.users u
    WHERE u.company_id = requested_company_id;
  SELECT count(*) INTO membership_count FROM ia4tube_social.company_memberships m
    WHERE m.company_id = requested_company_id;
  expected_digest := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    'ia4tube-social-official-owner-v1' || E'\n' || requested_company_id::TEXT || E'\n' ||
    requested_user_id::TEXT || E'\n' || requested_identity_derivation_version, 'UTF8'
  )), 'hex');

  IF company_count = 0 AND user_count = 0 AND membership_count = 0 THEN
    INSERT INTO ia4tube_social.companies (id, name, status, identity_derivation_version)
      VALUES (requested_company_id, 'IA4Tube', 'active', requested_identity_derivation_version);
    INSERT INTO ia4tube_social.users
      (company_id, id, login_key_digest, password_hash, status, auth_version)
      VALUES (requested_company_id, requested_user_id, expected_digest, NULL, 'active', 1);
    INSERT INTO ia4tube_social.company_memberships (company_id, user_id, role, status)
      VALUES (requested_company_id, requested_user_id, 'owner', 'active');
    RETURN QUERY SELECT requested_company_id, requested_user_id,
      requested_identity_derivation_version, 'owner'::TEXT, 1::BIGINT, TRUE;
    RETURN;
  END IF;

  IF company_count <> 1 OR user_count <> 1 OR membership_count <> 1 THEN
    RAISE EXCEPTION USING ERRCODE = 'PTB01', MESSAGE = 'official_owner_binding_conflict';
  END IF;
  SELECT c.* INTO existing_company FROM ia4tube_social.companies c
    WHERE c.id = requested_company_id;
  SELECT u.* INTO existing_user FROM ia4tube_social.users u
    WHERE u.company_id = requested_company_id;
  SELECT m.* INTO existing_membership FROM ia4tube_social.company_memberships m
    WHERE m.company_id = requested_company_id;
  IF existing_company.status <> 'active' OR existing_company.name <> 'IA4Tube' OR
     existing_company.identity_derivation_version <> requested_identity_derivation_version OR
     existing_user.id <> requested_user_id OR existing_user.status <> 'active' OR
     existing_user.login_key_digest <> expected_digest OR existing_user.password_hash IS NOT NULL OR
     existing_user.auth_version < 1 OR existing_user.auth_version > 9007199254740991 OR
     existing_membership.user_id <> requested_user_id OR existing_membership.status <> 'active' OR
     existing_membership.role <> 'owner' THEN
    RAISE EXCEPTION USING ERRCODE = 'PTB01', MESSAGE = 'official_owner_binding_conflict';
  END IF;
  RETURN QUERY SELECT requested_company_id, requested_user_id,
    requested_identity_derivation_version, 'owner'::TEXT, existing_user.auth_version, FALSE;
EXCEPTION WHEN unique_violation OR foreign_key_violation OR check_violation THEN
  RAISE EXCEPTION USING ERRCODE = 'PTB01', MESSAGE = 'official_owner_binding_conflict';
END;
$official_owner$;

ALTER FUNCTION ia4tube_social.ensure_official_owner(UUID, UUID, TEXT)
  OWNER TO ia4tube_social_owner;
REVOKE ALL ON FUNCTION ia4tube_social.ensure_official_owner(UUID, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ia4tube_social.ensure_official_owner(UUID, UUID, TEXT)
  TO ia4tube_social_runtime;
