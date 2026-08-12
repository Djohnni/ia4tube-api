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
const {
  loadInstagramOAuthConfig
} = require("./oauth/instagram-config");
const {
  createInstagramOAuthStateEnvelope
} = require("./oauth/instagram-state-envelope");
const {
  createInstagramProvider
} = require("./oauth/instagram-provider");
const {
  createInstagramOAuthService
} = require("./oauth/instagram-oauth-service");

function createDisabledRuntime() {
  return Object.freeze({
    enabled: false,
    reason: "social_persistence_disabled"
  });
}

async function createSocialRuntime(options = {}) {
  const env = options.env || process.env;
  assertWebServiceDatabaseCredentialBoundary(env);
  const instagramConfig = loadInstagramOAuthConfig(env);
  const config = loadRuntimePostgresConfig(env);
  if (!config.enabled) {
    if (
      instagramConfig.instagramEnabled ||
      instagramConfig.externalConnectionEnabled
    ) {
      postgresFail(
        "social_instagram_persistence_required",
        "Persistencia social obrigatoria para OAuth Instagram."
      );
    }
    return createDisabledRuntime();
  }
  if (
    instagramConfig.externalConnectionEnabled &&
    !instagramConfig.instagramEnabled
  ) {
    postgresFail(
      "social_instagram_configuration_invalid",
      "Configuracao OAuth Instagram recusada."
    );
  }

  let identityConfig;
  let vaultKeyring;
  let pool;
  let vault;
  let instagramStateEnvelope;
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
    const oauthRepository = createPostgresOAuthRepository({
      pool,
      runtimeRole: config.role
    });
    const connectorPersistence = Object.freeze({
      audit: createPostgresConnectorAudit({
        pool,
        runtimeRole: config.role
      }),
      oauth: oauthRepository,
      store: createPostgresConnectorStore({
        pool,
        runtimeRole: config.role
      })
    });
    const authAdapter = createSocialAuthAdapter(identityConfig);
    let instagramOAuth = null;
    if (instagramConfig.enabled) {
      instagramStateEnvelope = createInstagramOAuthStateEnvelope({
        derivationKey: identityConfig.key,
        keyVersion: identityConfig.derivationVersion,
        redirectUri: instagramConfig.redirectUri,
        clock: options.clock || Date.now,
        randomBytes: options.randomBytes
      });
      const transport = options.instagramTransport || globalThis.fetch;
      const instagramProvider = createInstagramProvider({
        config: instagramConfig,
        transport,
        setTimeout: options.setTimeout,
        clearTimeout: options.clearTimeout
      });
      instagramOAuth = createInstagramOAuthService({
        config: instagramConfig,
        stateEnvelope: instagramStateEnvelope,
        provider: instagramProvider,
        oauthRepository,
        credentials,
        authAdapter,
        clock: options.clock || Date.now,
        randomUUID: options.randomUUID,
        environment: env.NODE_ENV === "test"
          ? "test"
          : env.NODE_ENV === "production"
            ? "production"
            : "staging"
      });
    }
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
      instagramOAuth,
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
        if (instagramStateEnvelope) instagramStateEnvelope.destroy();
        vault.destroy();
        identityConfig.key.fill(0);
        await closePostgresPool(pool);
      }
    });
  } catch (error) {
    if (instagramStateEnvelope) instagramStateEnvelope.destroy();
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
