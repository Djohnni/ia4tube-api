"use strict";

const {
  assertWebServiceDatabaseCredentialBoundary,
  loadRuntimePostgresConfig
} = require("../persistence/postgres/config");
const {
  closePostgresPool,
  createPostgresPool,
  verifyRuntimeRole
} = require("../persistence/postgres/pool");
const {
  verifyRuntimeSchema
} = require("../persistence/postgres/runtime-validation");
const {
  createCompanyScopedRepository
} = require("../persistence/postgres/company-scoped-repository");
const {
  createSocialRepository
} = require("../persistence/postgres/social-repository");
const {
  createPostgresConnectorAudit
} = require("../persistence/postgres/social-connector-audit");
const {
  createPostgresConnectorStore
} = require("../persistence/postgres/social-connector-store");
const {
  createPostgresOAuthRepository
} = require("../persistence/postgres/social-oauth-repository");
const {
  deriveSocialIdentity,
  parseIdentityConfig
} = require("./identity");
const {
  createSocialCredentialService
} = require("./credential-service");
const { createSocialReauthService } = require("./reauth");
const { createSocialAuthAdapter } = require("./auth-adapter");
const {
  createSocialVault,
  parseVaultKeyring
} = require("./vault");
const { postgresFail } = require("../persistence/postgres/errors");
const {
  assertSocialSecretSeparation
} = require("./secret-separation");

function createDisabledRuntime() {
  return Object.freeze({
    enabled: false,
    reason: "social_persistence_disabled"
  });
}

async function createSocialRuntime(options = {}) {
  const env = options.env || process.env;
  assertWebServiceDatabaseCredentialBoundary(env);
  const config = loadRuntimePostgresConfig(env);
  if (!config.enabled) return createDisabledRuntime();

  let identityConfig;
  let vaultKeyring;
  let pool;
  let vault;
  try {
    identityConfig = parseIdentityConfig(env);
    vaultKeyring = parseVaultKeyring(env);
    assertSocialSecretSeparation({
      vaultKeyring,
      identityKey: identityConfig.key,
      env
    });
    pool = createPostgresPool(config.pool, {
      logger: options.logger,
      PoolClass: options.PoolClass
    });
    await verifyRuntimeRole(pool, config.role);
    await verifyRuntimeSchema(pool, config.role);
    const companies = createCompanyScopedRepository({
      pool,
      runtimeRole: config.role,
      identityDerivationVersion: identityConfig.derivationVersion
    });
    const social = createSocialRepository({
      pool,
      runtimeRole: config.role,
      identityDerivationVersion: identityConfig.derivationVersion
    });
    vault = createSocialVault({
      keyring: vaultKeyring,
      expectedKeyringFingerprint: vaultKeyring.fingerprint
    });
    for (const key of vaultKeyring.keys.values()) key.fill(0);
    vaultKeyring.keys.clear();
    const credentials = createSocialCredentialService({
      repository: social,
      vault
    });
    const reauth = createSocialReauthService({ repository: social });
    const connectorPersistence = Object.freeze({
      audit: createPostgresConnectorAudit({
        pool,
        runtimeRole: config.role
      }),
      oauth: createPostgresOAuthRepository({
        pool,
        runtimeRole: config.role
      }),
      store: createPostgresConnectorStore({
        pool,
        runtimeRole: config.role
      })
    });
    const authAdapter = createSocialAuthAdapter(identityConfig);
    let closed = false;
    function assertOpen() {
      if (closed) {
        postgresFail(
          "social_runtime_closed",
          "Runtime social indisponivel."
        );
      }
    }
    return Object.freeze({
      enabled: true,
      companies,
      connectorPersistence,
      credentials,
      reauth,
      auth: Object.freeze({
        fromVerifiedJwt(claims) {
          assertOpen();
          return authAdapter.fromVerifiedJwt(claims);
        }
      }),
      deriveIdentity(legacyCompanyId, legacyUserId) {
        assertOpen();
        return deriveSocialIdentity({
          namespaceUuid: identityConfig.namespaceUuid,
          derivationKey: identityConfig.key,
          derivationVersion: identityConfig.derivationVersion,
          legacyCompanyId,
          legacyUserId
        });
      },
      async close() {
        if (closed) return;
        closed = true;
        vault.destroy();
        identityConfig.key.fill(0);
        await closePostgresPool(pool);
      }
    });
  } catch (error) {
    if (vault) vault.destroy();
    if (vaultKeyring) {
      for (const key of vaultKeyring.keys.values()) key.fill(0);
      vaultKeyring.keys.clear();
    }
    if (identityConfig) identityConfig.key.fill(0);
    if (pool) {
      try {
        await closePostgresPool(pool);
      } catch (cleanupError) {
        cleanupError.cause = error;
        throw cleanupError;
      }
    }
    throw error;
  }
}

module.exports = {
  createSocialRuntime
};
