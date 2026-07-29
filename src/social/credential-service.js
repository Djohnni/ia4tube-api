"use strict";

const { postgresFail } = require("../persistence/postgres/errors");
const {
  requireKeyVersion,
  requirePositiveInteger,
  requireProvider,
  requireSafeLabel,
  requireUuid
} = require("../persistence/postgres/validation");

function contextFromInput(input = {}) {
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
  return Object.freeze({
    companyId: requireUuid(input.companyId, "company_id"),
    provider: requireProvider(input.provider),
    credentialId: requireUuid(input.credentialId, "credential_id"),
    credentialType: requireSafeLabel(
      input.credentialType,
      "credential_type"
    ),
    subjectType: connectionId ? "connection" : "oauth_transaction",
    subjectId: connectionId || oauthTransactionId
  });
}

function contextFromRow(row, expected = {}) {
  if (!row) {
    postgresFail("credential_not_found", "Credencial social indisponivel.");
  }
  const context = contextFromInput({
    companyId: row.company_id,
    provider: row.provider,
    credentialId: row.id,
    credentialType: row.credential_type,
    connectionId: row.connection_id,
    oauthTransactionId: row.oauth_transaction_id
  });
  if (
    context.companyId !== requireUuid(expected.companyId, "company_id") ||
    context.credentialId !==
      requireUuid(expected.credentialId, "credential_id")
  ) {
    postgresFail(
      "credential_context_mismatch",
      "Contexto da credencial recusado."
    );
  }
  return context;
}

function envelopeFromRow(row) {
  return Object.freeze({
    ciphertext: row.ciphertext,
    nonce: row.nonce,
    authTag: row.auth_tag,
    keyVersion: row.key_version,
    aadVersion: row.aad_version
  });
}

function optionalExpiry(value) {
  if (value === undefined || value === null) return null;
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    postgresFail(
      "credential_expiry_invalid",
      "Validade da credencial recusada."
    );
  }
  return value;
}

function createSocialCredentialService(options = {}) {
  const repository = options.repository;
  const vault = options.vault;
  if (
    !repository ||
    typeof repository.storeEncryptedCredential !== "function" ||
    typeof repository.findEncryptedCredential !== "function" ||
    typeof repository.rotateEncryptedCredential !== "function" ||
    typeof repository.listCredentialKeyVersions !== "function"
  ) {
    postgresFail(
      "credential_repository_required",
      "Repositorio de credenciais obrigatorio."
    );
  }
  if (
    !vault ||
    typeof vault.encrypt !== "function" ||
    typeof vault.decrypt !== "function" ||
    typeof vault.rotate !== "function"
  ) {
    postgresFail("social_vault_required", "Cofre social obrigatorio.");
  }

  async function store(input = {}) {
    const context = contextFromInput(input);
    const expiresAt = optionalExpiry(input.expiresAt);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const envelope = vault.encrypt(input.plaintext, context);
      try {
        const stored = await repository.storeEncryptedCredential({
          companyId: context.companyId,
          id: context.credentialId,
          provider: context.provider,
          connectionId:
            context.subjectType === "connection" ? context.subjectId : null,
          oauthTransactionId:
            context.subjectType === "oauth_transaction"
              ? context.subjectId
              : null,
          credentialType: context.credentialType,
          ciphertext: envelope.ciphertext,
          nonce: envelope.nonce,
          authTag: envelope.authTag,
          keyVersion: envelope.keyVersion,
          aadVersion: envelope.aadVersion,
          expiresAt
        });
        return Object.freeze({
          companyId: context.companyId,
          credentialId: context.credentialId,
          provider: context.provider,
          credentialType: context.credentialType,
          keyVersion: envelope.keyVersion,
          revision: requirePositiveInteger(
            stored?.revision,
            "credential_revision"
          ),
          expiresAt:
            stored?.expires_at === undefined ||
            stored?.expires_at === null
              ? expiresAt
              : optionalExpiry(stored.expires_at)
        });
      } catch (error) {
        const constraint =
          error?.constraint || error?.cause?.constraint || "";
        const nonceCollision =
          error?.code === "23505" &&
          constraint ===
            "social_encrypted_credentials_key_nonce_unique";
        if (!nonceCollision || attempt === 3) {
          if (nonceCollision) {
            postgresFail(
              "credential_nonce_collision",
              "Nonce criptografico indisponivel."
            );
          }
          throw error;
        }
      }
    }
    postgresFail(
      "credential_nonce_collision",
      "Nonce criptografico indisponivel."
    );
  }

  async function withDecryptedCredential(
    { companyId, credentialId } = {},
    operation
  ) {
    if (typeof operation !== "function") {
      postgresFail(
        "credential_operation_required",
        "Operacao com credencial obrigatoria."
      );
    }
    const row = await repository.findEncryptedCredential({
      companyId,
      credentialId
    });
    const context = contextFromRow(row, { companyId, credentialId });
    const plaintext = vault.decrypt(envelopeFromRow(row), context);
    try {
      return await operation(plaintext);
    } finally {
      plaintext.fill(0);
    }
  }

  async function rotate({ companyId, credentialId } = {}) {
    const row = await repository.findEncryptedCredential({
      companyId,
      credentialId
    });
    const context = contextFromRow(row, { companyId, credentialId });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const result = vault.rotate(envelopeFromRow(row), context);
      if (!result.changed) {
        return Object.freeze({
          changed: false,
          keyVersion: requireKeyVersion(result.envelope.keyVersion),
          revision: requirePositiveInteger(
            row.revision,
            "credential_revision"
          )
        });
      }
      try {
        const updated = await repository.rotateEncryptedCredential({
          companyId: context.companyId,
          credentialId: context.credentialId,
          ciphertext: result.envelope.ciphertext,
          nonce: result.envelope.nonce,
          authTag: result.envelope.authTag,
          keyVersion: result.envelope.keyVersion,
          expectedRevision: row.revision
        });
        return Object.freeze({
          changed: true,
          keyVersion: requireKeyVersion(updated?.key_version),
          revision: requirePositiveInteger(
            updated?.revision,
            "credential_revision"
          )
        });
      } catch (error) {
        const constraint =
          error?.constraint || error?.cause?.constraint || "";
        const nonceCollision =
          error?.code === "23505" &&
          constraint ===
            "social_encrypted_credentials_key_nonce_unique";
        if (!nonceCollision || attempt === 3) {
          if (nonceCollision) {
            postgresFail(
              "credential_nonce_collision",
              "Nonce criptografico indisponivel."
            );
          }
          throw error;
        }
      }
    }
    postgresFail(
      "credential_nonce_collision",
      "Nonce criptografico indisponivel."
    );
  }

  async function tenantKeyInventory({ companyId } = {}) {
    return repository.listCredentialKeyVersions({ companyId });
  }

  return Object.freeze({
    rotate,
    store,
    tenantKeyInventory,
    withDecryptedCredential
  });
}

module.exports = {
  contextFromInput,
  contextFromRow,
  createSocialCredentialService,
  envelopeFromRow,
  optionalExpiry
};
