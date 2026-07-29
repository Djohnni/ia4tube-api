"use strict";

const { postgresFail } = require("./errors");
const { withTransaction } = require("./pool");
const {
  requireKeyVersion,
  requirePositiveInteger,
  requireProvider,
  requireSafeLabel,
  requireSha256,
  requireUuid
} = require("./validation");

const {
  requireVaultKeyVersion
} = require("../../social/vault-key-version");

const REAUTH_ACTIONS = new Set([
  "social.connect",
  "social.disconnect",
  "social.revoke"
]);

function requireDate(value, field) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    postgresFail(`${field}_invalid`, "Data social recusada.");
  }
  return value;
}

function requireBuffer(value, length, field) {
  if (
    !Buffer.isBuffer(value) ||
    (length ? value.length !== length : value.length === 0)
  ) {
    postgresFail(`${field}_invalid`, "Envelope criptografico recusado.");
  }
  return Buffer.from(value);
}

function requireReauthAction(value) {
  if (!REAUTH_ACTIONS.has(value)) {
    postgresFail("reauth_action_invalid", "Acao de reautenticacao recusada.");
  }
  return value;
}

function freezeRow(row) {
  if (!row) return null;
  const copy = { ...row };
  for (const field of ["ciphertext", "nonce", "auth_tag"]) {
    if (Buffer.isBuffer(copy[field])) copy[field] = Buffer.from(copy[field]);
  }
  return Object.freeze(copy);
}

function createSocialRepository(options = {}) {
  const pool = options.pool;
  const role = requireSafeLabel(
    options.runtimeRole || "ia4tube_social_runtime",
    "runtime_role"
  );
  const identityDerivationVersion = requireKeyVersion(
    options.identityDerivationVersion
  );
  if (!pool || typeof pool.connect !== "function") {
    postgresFail("postgres_pool_required", "Pool PostgreSQL obrigatorio.");
  }

  function scoped(companyId, operation) {
    return withTransaction(pool, operation, {
      companyId: requireUuid(companyId, "company_id"),
      role
    });
  }

  async function createConnection(input = {}) {
    const companyId = requireUuid(input.companyId, "company_id");
    const id = requireUuid(input.id, "connection_id");
    const userId = requireUuid(input.createdByUserId, "user_id");
    const provider = requireProvider(input.provider);
    return scoped(companyId, async (client) => {
      const result = await client.query(
        [
          "INSERT INTO ia4tube_social.social_connections (",
          "  company_id, id, provider, created_by_user_id",
          ") VALUES ($1, $2, $3, $4)",
          "RETURNING company_id, id, provider, status, revision,",
          "  created_at, updated_at"
        ].join("\n"),
        [companyId, id, provider, userId]
      );
      return freezeRow(result.rows?.[0]);
    });
  }

  async function findConnection({ companyId, connectionId } = {}) {
    const scopedCompanyId = requireUuid(companyId, "company_id");
    const id = requireUuid(connectionId, "connection_id");
    return scoped(scopedCompanyId, async (client) => {
      const result = await client.query(
        [
          "SELECT company_id, id, provider, status, connected_at,",
          "  expires_at, revoked_at, disconnected_at, revision,",
          "  created_at, updated_at",
          "FROM ia4tube_social.social_connections",
          "WHERE company_id = $1 AND id = $2"
        ].join("\n"),
        [scopedCompanyId, id]
      );
      return freezeRow(result.rows?.[0]);
    });
  }

  async function storeEncryptedCredential(input = {}) {
    const companyId = requireUuid(input.companyId, "company_id");
    const id = requireUuid(input.id, "credential_id");
    const provider = requireProvider(input.provider);
    const credentialType = requireProvider(input.credentialType);
    const connectionId = input.connectionId
      ? requireUuid(input.connectionId, "connection_id")
      : null;
    const oauthTransactionId = input.oauthTransactionId
      ? requireUuid(input.oauthTransactionId, "oauth_transaction_id")
      : null;
    if (Number(Boolean(connectionId)) + Number(Boolean(oauthTransactionId)) !== 1) {
      postgresFail(
        "credential_subject_invalid",
        "Sujeito da credencial recusado."
      );
    }
    const ciphertext = requireBuffer(input.ciphertext, null, "ciphertext");
    const nonce = requireBuffer(input.nonce, 12, "nonce");
    const authTag = requireBuffer(input.authTag, 16, "auth_tag");
    const keyVersion = requireVaultKeyVersion(input.keyVersion);
    const aadVersion = requirePositiveInteger(
      input.aadVersion,
      "aad_version"
    );
    if (aadVersion !== 1) {
      postgresFail("aad_version_invalid", "Versao AAD recusada.");
    }
    const expiresAt =
      input.expiresAt === undefined || input.expiresAt === null
        ? null
        : requireDate(input.expiresAt, "expires_at");

    return scoped(companyId, async (client) => {
      const result = await client.query(
        [
          "INSERT INTO ia4tube_social.social_encrypted_credentials (",
          "  company_id, id, provider, connection_id,",
          "  oauth_transaction_id, credential_type, ciphertext, nonce,",
          "  auth_tag, key_version, aad_version, expires_at",
          ") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)",
          "RETURNING company_id, id, provider, connection_id,",
          "  oauth_transaction_id, credential_type, ciphertext, nonce,",
          "  auth_tag, key_version, aad_version, expires_at, revision"
        ].join("\n"),
        [
          companyId,
          id,
          provider,
          connectionId,
          oauthTransactionId,
          credentialType,
          ciphertext,
          nonce,
          authTag,
          keyVersion,
          aadVersion,
          expiresAt
        ]
      );
      return freezeRow(result.rows?.[0]);
    });
  }

  async function findEncryptedCredential(input = {}) {
    const companyId = requireUuid(input.companyId, "company_id");
    const id = requireUuid(input.credentialId, "credential_id");
    return scoped(companyId, async (client) => {
      const result = await client.query(
        [
          "SELECT credential.company_id, credential.id,",
          "  credential.provider, credential.connection_id,",
          "  credential.oauth_transaction_id, credential.credential_type,",
          "  credential.ciphertext, credential.nonce, credential.auth_tag,",
          "  credential.key_version, credential.aad_version,",
          "  credential.expires_at, credential.revision",
          "FROM ia4tube_social.social_encrypted_credentials credential",
          "LEFT JOIN ia4tube_social.social_connections connection",
          "  ON connection.company_id = credential.company_id",
          "  AND connection.id = credential.connection_id",
          "  AND connection.provider = credential.provider",
          "LEFT JOIN ia4tube_social.social_oauth_transactions oauth",
          "  ON oauth.company_id = credential.company_id",
          "  AND oauth.id = credential.oauth_transaction_id",
          "  AND oauth.provider = credential.provider",
          "WHERE credential.company_id = $1 AND credential.id = $2",
          "  AND credential.revoked_at IS NULL",
          "  AND (credential.expires_at IS NULL",
          "    OR credential.expires_at > CURRENT_TIMESTAMP)",
          "  AND (",
          "    (credential.connection_id IS NOT NULL",
          "      AND connection.status = 'active')",
          "    OR",
          "    (credential.oauth_transaction_id IS NOT NULL",
          "      AND oauth.consumed_at IS NULL",
          "      AND oauth.cancelled_at IS NULL",
          "      AND oauth.expires_at > CURRENT_TIMESTAMP)",
          "  )"
        ].join("\n"),
        [companyId, id]
      );
      return freezeRow(result.rows?.[0]);
    });
  }

  async function findEncryptedCredentialForKeyRotation(input = {}) {
    const companyId = requireUuid(input.companyId, "company_id");
    const id = requireUuid(input.credentialId, "credential_id");
    return scoped(companyId, async (client) => {
      const result = await client.query(
        [
          "SELECT company_id, id, provider, connection_id,",
          "  oauth_transaction_id, credential_type, ciphertext, nonce,",
          "  auth_tag, key_version, aad_version, expires_at,",
          "  revoked_at, revision",
          "FROM ia4tube_social.social_encrypted_credentials",
          "WHERE company_id = $1 AND id = $2"
        ].join("\n"),
        [companyId, id]
      );
      return freezeRow(result.rows?.[0]);
    });
  }

  async function rotateEncryptedCredential(input = {}) {
    const companyId = requireUuid(input.companyId, "company_id");
    const id = requireUuid(input.credentialId, "credential_id");
    const expectedRevision = requirePositiveInteger(
      input.expectedRevision,
      "expected_revision"
    );
    const ciphertext = requireBuffer(input.ciphertext, null, "ciphertext");
    const nonce = requireBuffer(input.nonce, 12, "nonce");
    const authTag = requireBuffer(input.authTag, 16, "auth_tag");
    const keyVersion = requireVaultKeyVersion(input.keyVersion);

    return scoped(companyId, async (client) => {
      const result = await client.query(
        [
          "UPDATE ia4tube_social.social_encrypted_credentials",
          "SET ciphertext = $3, nonce = $4, auth_tag = $5,",
          "  key_version = $6, revision = revision + 1,",
          "  updated_at = CURRENT_TIMESTAMP",
          "WHERE company_id = $1 AND id = $2",
          "  AND revision = $7 AND revoked_at IS NULL",
          "RETURNING company_id, id, provider, connection_id,",
          "  oauth_transaction_id, credential_type, ciphertext, nonce,",
          "  auth_tag, key_version, aad_version, expires_at, revision"
        ].join("\n"),
        [
          companyId,
          id,
          ciphertext,
          nonce,
          authTag,
          keyVersion,
          expectedRevision
        ]
      );
      if (!result.rows?.[0]) {
        postgresFail(
          "credential_rotation_conflict",
          "Rotacao concorrente recusada."
        );
      }
      return freezeRow(result.rows[0]);
    });
  }

  async function rotateEncryptedCredentialForKeyRotation(input = {}) {
    const companyId = requireUuid(input.companyId, "company_id");
    const id = requireUuid(input.credentialId, "credential_id");
    const expectedRevision = requirePositiveInteger(
      input.expectedRevision,
      "expected_revision"
    );
    const ciphertext = requireBuffer(input.ciphertext, null, "ciphertext");
    const nonce = requireBuffer(input.nonce, 12, "nonce");
    const authTag = requireBuffer(input.authTag, 16, "auth_tag");
    const keyVersion = requireVaultKeyVersion(input.keyVersion);

    return scoped(companyId, async (client) => {
      const result = await client.query(
        [
          "UPDATE ia4tube_social.social_encrypted_credentials",
          "SET ciphertext = $3, nonce = $4, auth_tag = $5,",
          "  key_version = $6, revision = revision + 1,",
          "  updated_at = CURRENT_TIMESTAMP",
          "WHERE company_id = $1 AND id = $2 AND revision = $7",
          "RETURNING company_id, id, provider, connection_id,",
          "  oauth_transaction_id, credential_type, ciphertext, nonce,",
          "  auth_tag, key_version, aad_version, expires_at,",
          "  revoked_at, revision"
        ].join("\n"),
        [
          companyId,
          id,
          ciphertext,
          nonce,
          authTag,
          keyVersion,
          expectedRevision
        ]
      );
      if (!result.rows?.[0]) {
        postgresFail(
          "credential_rotation_conflict",
          "Rotacao concorrente recusada."
        );
      }
      return freezeRow(result.rows[0]);
    });
  }

  async function listCredentialKeyVersions({ companyId } = {}) {
    const scopedCompanyId = requireUuid(companyId, "company_id");
    return scoped(scopedCompanyId, async (client) => {
      const result = await client.query(
        [
          "SELECT key_version, COUNT(*)::bigint AS credential_count",
          "FROM ia4tube_social.social_encrypted_credentials",
          "WHERE company_id = $1",
          "GROUP BY key_version",
          "ORDER BY key_version"
        ].join("\n"),
        [scopedCompanyId]
      );
      return Object.freeze(
        (result.rows || []).map((row) =>
          Object.freeze({
            keyVersion: requireVaultKeyVersion(row.key_version),
            credentialCount: requirePositiveInteger(
              row.credential_count,
              "credential_count"
            )
          })
        )
      );
    });
  }

  async function findReauthIdentity({ companyId, userId } = {}) {
    const scopedCompanyId = requireUuid(companyId, "company_id");
    const scopedUserId = requireUuid(userId, "user_id");
    return scoped(scopedCompanyId, async (client) => {
      const result = await client.query(
        [
          "SELECT user_account.password_hash, user_account.auth_version,",
          "  membership.role",
          "FROM ia4tube_social.users user_account",
          "JOIN ia4tube_social.company_memberships membership",
          "  ON membership.company_id = user_account.company_id",
          "  AND membership.user_id = user_account.id",
          "JOIN ia4tube_social.companies company",
          "  ON company.id = user_account.company_id",
          "WHERE user_account.company_id = $1",
          "  AND user_account.id = $2",
          "  AND user_account.status = 'active'",
          "  AND user_account.password_hash IS NOT NULL",
          "  AND membership.status = 'active'",
          "  AND membership.role IN ('owner', 'admin')",
          "  AND company.status = 'active'",
          "  AND company.identity_derivation_version = $3"
        ].join("\n"),
        [scopedCompanyId, scopedUserId, identityDerivationVersion]
      );
      return freezeRow(result.rows?.[0]);
    });
  }

  async function createReauthGrant(input = {}) {
    const companyId = requireUuid(input.companyId, "company_id");
    const id = requireUuid(input.id, "reauth_grant_id");
    const userId = requireUuid(input.userId, "user_id");
    const tokenDigest = requireSha256(input.tokenDigest, "token_digest");
    const sessionJtiDigest = requireSha256(
      input.sessionJtiDigest,
      "session_jti_digest"
    );
    const action = requireReauthAction(input.action);
    const provider = requireProvider(input.provider);
    const targetConnectionId = input.targetConnectionId
      ? requireUuid(input.targetConnectionId, "target_connection_id")
      : null;
    if (
      (action === "social.connect" && targetConnectionId) ||
      (action !== "social.connect" && !targetConnectionId)
    ) {
      postgresFail(
        "reauth_target_invalid",
        "Alvo de reautenticacao recusado."
      );
    }
    const authVersion = requirePositiveInteger(
      input.authVersion,
      "auth_version"
    );
    const expiresAt = requireDate(input.expiresAt, "expires_at");

    return scoped(companyId, async (client) => {
      const result = await client.query(
        [
          "INSERT INTO ia4tube_social.social_reauth_grants (",
          "  company_id, id, user_id, token_digest, session_jti_digest,",
          "  action, provider, target_connection_id, auth_version, expires_at",
          ") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
          "RETURNING company_id, id, user_id, action, provider,",
          "  target_connection_id, auth_version,",
          "  expires_at, created_at"
        ].join("\n"),
        [
          companyId,
          id,
          userId,
          tokenDigest,
          sessionJtiDigest,
          action,
          provider,
          targetConnectionId,
          authVersion,
          expiresAt
        ]
      );
      return freezeRow(result.rows?.[0]);
    });
  }

  async function consumeReauthGrant(input = {}) {
    const companyId = requireUuid(input.companyId, "company_id");
    const userId = requireUuid(input.userId, "user_id");
    const tokenDigest = requireSha256(input.tokenDigest, "token_digest");
    const sessionJtiDigest = requireSha256(
      input.sessionJtiDigest,
      "session_jti_digest"
    );
    const action = requireReauthAction(input.action);
    const provider = requireProvider(input.provider);
    const targetConnectionId = input.targetConnectionId
      ? requireUuid(input.targetConnectionId, "target_connection_id")
      : null;
    if (
      (action === "social.connect" && targetConnectionId) ||
      (action !== "social.connect" && !targetConnectionId)
    ) {
      postgresFail(
        "reauth_target_invalid",
        "Alvo de reautenticacao recusado."
      );
    }
    return scoped(companyId, async (client) => {
      const result = await client.query(
        [
          "UPDATE ia4tube_social.social_reauth_grants grant_record",
          "SET consumed_at = CURRENT_TIMESTAMP",
          "FROM ia4tube_social.users user_account,",
          "  ia4tube_social.company_memberships membership,",
          "  ia4tube_social.companies company",
          "WHERE grant_record.company_id = $1",
          "  AND grant_record.user_id = $2",
          "  AND grant_record.token_digest = $3",
          "  AND grant_record.session_jti_digest = $4",
          "  AND grant_record.action = $5",
          "  AND grant_record.provider = $6",
          "  AND grant_record.target_connection_id IS NOT DISTINCT FROM $7",
          "  AND grant_record.consumed_at IS NULL",
          "  AND grant_record.expires_at > CURRENT_TIMESTAMP",
          "  AND user_account.company_id = grant_record.company_id",
          "  AND user_account.id = grant_record.user_id",
          "  AND user_account.status = 'active'",
          "  AND user_account.auth_version = grant_record.auth_version",
          "  AND membership.company_id = grant_record.company_id",
          "  AND membership.user_id = grant_record.user_id",
          "  AND membership.status = 'active'",
          "  AND membership.role IN ('owner', 'admin')",
          "  AND company.id = grant_record.company_id",
          "  AND company.status = 'active'",
          "  AND company.identity_derivation_version = $8",
          "RETURNING grant_record.id, grant_record.company_id,",
          "  grant_record.user_id, grant_record.action,",
          "  grant_record.provider, grant_record.target_connection_id,",
          "  grant_record.consumed_at"
        ].join("\n"),
        [
          companyId,
          userId,
          tokenDigest,
          sessionJtiDigest,
          action,
          provider,
          targetConnectionId,
          identityDerivationVersion
        ]
      );
      return freezeRow(result.rows?.[0]);
    });
  }

  return Object.freeze({
    consumeReauthGrant,
    createConnection,
    createReauthGrant,
    findReauthIdentity,
    findConnection,
    findEncryptedCredential,
    findEncryptedCredentialForKeyRotation,
    listCredentialKeyVersions,
    rotateEncryptedCredential,
    rotateEncryptedCredentialForKeyRotation,
    storeEncryptedCredential
  });
}

module.exports = {
  REAUTH_ACTIONS,
  createSocialRepository
};
