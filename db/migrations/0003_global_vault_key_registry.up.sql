CREATE SCHEMA ia4tube_social_admin
  AUTHORIZATION ia4tube_social_owner;

REVOKE ALL ON SCHEMA ia4tube_social_admin FROM PUBLIC;
REVOKE ALL ON SCHEMA ia4tube_social_admin
  FROM ia4tube_social_runtime;

CREATE TABLE ia4tube_social_admin.vault_key_versions (
  key_version TEXT PRIMARY KEY,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT vault_key_versions_key_version_valid
    CHECK (key_version ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,49}$')
);

REVOKE ALL ON ia4tube_social_admin.vault_key_versions FROM PUBLIC;
REVOKE ALL ON ia4tube_social_admin.vault_key_versions
  FROM ia4tube_social_runtime;

INSERT INTO ia4tube_social_admin.vault_key_versions (key_version)
SELECT DISTINCT credential.key_version
FROM ia4tube_social.social_encrypted_credentials credential
ON CONFLICT (key_version) DO NOTHING;

ALTER TABLE ia4tube_social.social_encrypted_credentials
  ADD CONSTRAINT social_encrypted_credentials_key_version_fk
  FOREIGN KEY (key_version)
  REFERENCES ia4tube_social_admin.vault_key_versions(key_version)
  ON UPDATE RESTRICT
  ON DELETE RESTRICT;
