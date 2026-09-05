"use strict";

const { postgresFail } = require("../persistence/postgres/errors");
const {
  CREDENTIAL_KEY_FOREIGN_KEY
} = require("../persistence/postgres/vault-key-registry-admin");
const {
  requirePositiveInteger,
  requireProvider,
  requireSafeLabel,
  requireUuid
} = require("../persistence/postgres/validation");
const {
  requireVaultKeyVersion
} = require("./vault-key-version");

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

function isConstraintError(error, code, constraint) {
  const visited = new Set();
  for (
    let candidate = error;
    candidate && !visited.has(candidate);
    candidate = candidate?.cause
  ) {
    visited.add(candidate);
    if (
      candidate?.code === code &&
      candidate?.constraint === constraint
    ) {
      return true;
    }
  }
  return false;
}

function strictObject(value, allowedKeys) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    postgresFail(
      "credential_operation_invalid",
      "Operacao com credencial recusada."
    );
  }
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !allowedKeys.includes(key) ||
      !descriptor ||
      descriptor.get ||
      descriptor.set
    ) {
      postgresFail(
        "credential_operation_invalid",
        "Operacao com credencial recusada."
      );
    }
  }
  return value;
}

function clearEnvelope(envelope) {
  if (!envelope || typeof envelope !== "object") return;
  for (const field of ["ciphertext", "nonce", "authTag"]) {
    if (Buffer.isBuffer(envelope[field])) envelope[field].fill(0);
  }
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
  const lifecycleFind =
    repository.findEncryptedCredentialForKeyRotation;
  const lifecycleRotate =
    repository.rotateEncryptedCredentialForKeyRotation;
  if (
    (typeof lifecycleFind === "function") !==
    (typeof lifecycleRotate === "function")
  ) {
    postgresFail(
      "credential_rotation_repository_incomplete",
      "Repositorio de rotacao administrativa incompleto."
    );
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
        if (
          isConstraintError(
            error,
            "23503",
            CREDENTIAL_KEY_FOREIGN_KEY
          )
        ) {
          postgresFail(
            "vault_active_key_not_registered",
            "Chave ativa do cofre nao registrada."
          );
        }
        const nonceCollision =
          isConstraintError(
            error,
            "23505",
            "social_encrypted_credentials_key_nonce_unique"
          );
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

  async function withEncryptedConnectionCredential(input = {}, operation) {
    const plaintextDescriptor = input && typeof input === "object"
      ? Object.getOwnPropertyDescriptor(input, "plaintext")
      : null;
    const plaintext = plaintextDescriptor &&
      !plaintextDescriptor.get && !plaintextDescriptor.set
      ? plaintextDescriptor.value
      : null;
    if (!Buffer.isBuffer(plaintext) || plaintext.length < 1) {
      postgresFail(
        "credential_plaintext_invalid",
        "Material da credencial recusado."
      );
    }
    let envelope;
    let sealed;
    try {
      if (typeof operation !== "function") {
        postgresFail(
          "credential_operation_required",
          "Operacao com credencial obrigatoria."
        );
      }
      const source = strictObject(input, [
        "companyId",
        "connectionId",
        "credentialId",
        "provider",
        "credentialType",
        "plaintext",
        "expiresAt"
      ]);
      const context = contextFromInput({
        companyId: source.companyId,
        connectionId: source.connectionId,
        credentialId: source.credentialId,
        provider: source.provider,
        credentialType: source.credentialType
      });
      const expiresAt = optionalExpiry(source.expiresAt);
      sealed = vault.encrypt(plaintext, context);
      envelope = Object.freeze({
        id: context.credentialId,
        credentialType: context.credentialType,
        ciphertext: sealed.ciphertext,
        nonce: sealed.nonce,
        authTag: sealed.authTag,
        keyVersion: sealed.keyVersion,
        aadVersion: sealed.aadVersion,
        expiresAt
      });
      try {
        return await operation(envelope);
      } catch (error) {
        if (
          isConstraintError(
            error,
            "23503",
            CREDENTIAL_KEY_FOREIGN_KEY
          )
        ) {
          postgresFail(
            "vault_active_key_not_registered",
            "Chave ativa do cofre nao registrada."
          );
        }
        if (
          isConstraintError(
            error,
            "23505",
            "social_encrypted_credentials_key_nonce_unique"
          )
        ) {
          postgresFail(
            "credential_nonce_collision",
            "Nonce criptografico indisponivel."
          );
        }
        throw error;
      }
    } finally {
      clearEnvelope(envelope || sealed);
      plaintext.fill(0);
    }
  }

  async function rotateUsing(
    { companyId, credentialId } = {},
    includeInactive
  ) {
    if (
      includeInactive &&
      (typeof lifecycleFind !== "function" ||
        typeof lifecycleRotate !== "function")
    ) {
      postgresFail(
        "credential_rotation_repository_required",
        "Repositorio de rotacao administrativa obrigatorio."
      );
    }
    const find = includeInactive
      ? lifecycleFind.bind(repository)
      : repository.findEncryptedCredential.bind(repository);
    const update = includeInactive
      ? lifecycleRotate.bind(repository)
      : repository.rotateEncryptedCredential.bind(repository);
    const row = await find({
      companyId,
      credentialId
    });
    const context = contextFromRow(row, { companyId, credentialId });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const result = vault.rotate(envelopeFromRow(row), context);
      if (!result.changed) {
        return Object.freeze({
          changed: false,
          keyVersion: requireVaultKeyVersion(
            result.envelope.keyVersion
          ),
          revision: requirePositiveInteger(
            row.revision,
            "credential_revision"
          )
        });
      }
      try {
        const updated = await update({
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
          keyVersion: requireVaultKeyVersion(updated?.key_version),
          revision: requirePositiveInteger(
            updated?.revision,
            "credential_revision"
          )
        });
      } catch (error) {
        if (
          isConstraintError(
            error,
            "23503",
            CREDENTIAL_KEY_FOREIGN_KEY
          )
        ) {
          postgresFail(
            "vault_active_key_not_registered",
            "Chave ativa do cofre nao registrada."
          );
        }
        const nonceCollision =
          isConstraintError(
            error,
            "23505",
            "social_encrypted_credentials_key_nonce_unique"
          );
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

  function rotate(input) {
    return rotateUsing(input, false);
  }

  function rotateForKeyLifecycle(input) {
    return rotateUsing(input, true);
  }

  async function tenantKeyInventory({ companyId } = {}) {
    return repository.listCredentialKeyVersions({ companyId });
  }

  return Object.freeze({
    rotate,
    rotateForKeyLifecycle,
    store,
    tenantKeyInventory,
    withDecryptedCredential,
    withEncryptedConnectionCredential
  });
}

module.exports = {
  contextFromInput,
  contextFromRow,
  clearEnvelope,
  createSocialCredentialService,
  envelopeFromRow,
  isConstraintError,
  optionalExpiry
};
