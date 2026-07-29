"use strict";

const { postgresFail } = require("./errors");
const { withTransaction } = require("./pool");
const {
  requireKeyVersion,
  requireSafeLabel
} = require("./validation");

const SOCIAL_OWNER_ROLE = "ia4tube_social_owner";
const VAULT_KEY_REGISTRY =
  "ia4tube_social_admin.vault_key_versions";
const CREDENTIAL_KEY_FOREIGN_KEY =
  "social_encrypted_credentials_key_version_fk";

function createVaultKeyRegistryAdmin(options = {}) {
  const pool = options.pool;
  const ownerRole = requireSafeLabel(
    options.ownerRole || SOCIAL_OWNER_ROLE,
    "postgres_owner_role"
  );
  if (ownerRole !== SOCIAL_OWNER_ROLE) {
    postgresFail(
      "vault_key_admin_role_must_be_canonical",
      "Role administrativa do cofre recusada."
    );
  }
  if (!pool || typeof pool.connect !== "function") {
    postgresFail("postgres_pool_required", "Pool PostgreSQL obrigatorio.");
  }

  function asOwner(operation) {
    return withTransaction(pool, operation, { role: ownerRole });
  }

  async function register({ keyVersion } = {}) {
    const version = requireKeyVersion(keyVersion);
    return asOwner(async (client) => {
      const result = await client.query(
        [
          `INSERT INTO ${VAULT_KEY_REGISTRY} (key_version)`,
          "VALUES ($1)",
          "ON CONFLICT (key_version) DO NOTHING",
          "RETURNING key_version"
        ].join("\n"),
        [version]
      );
      return Object.freeze({
        keyVersion: version,
        registered: result.rowCount === 1
      });
    });
  }

  async function retire({ keyVersion } = {}) {
    const version = requireKeyVersion(keyVersion);
    try {
      return await asOwner(async (client) => {
        const result = await client.query(
          [
            `DELETE FROM ${VAULT_KEY_REGISTRY}`,
            "WHERE key_version = $1",
            "RETURNING key_version"
          ].join("\n"),
          [version]
        );
        if (result.rowCount !== 1) {
          postgresFail(
            "vault_key_version_not_registered",
            "Versao de chave nao registrada."
          );
        }
        return Object.freeze({
          keyVersion: version,
          retired: true
        });
      });
    } catch (error) {
      if (
        error?.code === "23503" &&
        error?.constraint === CREDENTIAL_KEY_FOREIGN_KEY
      ) {
        postgresFail(
          "vault_key_version_in_use",
          "Versao de chave ainda referenciada.",
          error
        );
      }
      throw error;
    }
  }

  return Object.freeze({ register, retire });
}

module.exports = {
  CREDENTIAL_KEY_FOREIGN_KEY,
  SOCIAL_OWNER_ROLE,
  VAULT_KEY_REGISTRY,
  createVaultKeyRegistryAdmin
};
