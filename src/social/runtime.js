"use strict";

const path = require("node:path");

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
  createPostgresMetaComplianceRepository
} = require("../persistence/postgres/meta-compliance-repository");
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
const {
  CONTROLLED_GATE4_STAGING_ORIGIN,
  createControlledGate4JpegMedia
} = require("./publication/controlled-gate4-jpeg");
const {
  createInstagramPublicationConnector
} = require("./publication/instagram-publication-connector");
const {
  createInstagramPublicationService
} = require("./publication/instagram-publication-service");
const {
  createInstagramRealReviewerService,
  reviewerPublishedCandidateAuthorized
} = require("./reviewer-real/reviewer-real");
const {
  createMetaComplianceService,
  createMetaSignedRequestVerifier
} = require("./compliance");

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
  let metaComplianceRepository;
  let metaSignedRequestVerifier;
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
    const connectorStore = createPostgresConnectorStore({
      pool,
      runtimeRole: config.role
    });
    const connectorAudit = createPostgresConnectorAudit({
      pool,
      runtimeRole: config.role
    });
    const connectorPersistence = Object.freeze({
      audit: connectorAudit,
      oauth: oauthRepository,
      store: connectorStore
    });
    const authAdapter = createSocialAuthAdapter(identityConfig);
    let instagramOAuth = null;
    let instagramPublication = null;
    let instagramReviewer = null;
    let metaCompliance = null;
    if (instagramConfig.enabled) {
      metaComplianceRepository = createPostgresMetaComplianceRepository({
        pool,
        runtimeRole: config.role,
        appSecret: instagramConfig.appSecret,
        randomUUID: options.randomUUID
      });
      if (typeof instagramConfig.publicOrigin === "string") {
        metaSignedRequestVerifier = createMetaSignedRequestVerifier({
          appSecret: instagramConfig.appSecret,
          clock: options.clock || Date.now
        });
        metaCompliance = createMetaComplianceService({
          signedRequestVerifier: metaSignedRequestVerifier,
          repository: metaComplianceRepository,
          publicStatusBaseUrl:
            `${instagramConfig.publicOrigin}/v1/social/compliance/meta/` +
            "data-deletion/status",
          clock: options.clock || Date.now,
          randomBytes: options.randomBytes
        });
      }
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
        logger: options.logger,
        clock: options.clock || Date.now,
        setTimeout: options.setTimeout,
        clearTimeout: options.clearTimeout
      });
      instagramOAuth = createInstagramOAuthService({
        config: instagramConfig,
        stateEnvelope: instagramStateEnvelope,
        provider: instagramProvider,
        oauthRepository,
        connectorStore,
        credentials,
        authAdapter,
        metaComplianceRepository,
        clock: options.clock || Date.now,
        randomUUID: options.randomUUID,
        environment: env.NODE_ENV === "test"
          ? "test"
          : env.NODE_ENV === "production"
            ? "production"
            : "staging"
      });
      if (
        instagramConfig.publicOrigin === CONTROLLED_GATE4_STAGING_ORIGIN &&
        instagramConfig.expectedUsername === "ia4tube_empresas"
      ) {
        const publicDirectory = options.publicDirectory || path.resolve(
          __dirname,
          "..",
          "..",
          "public"
        );
        const controlledMedia = createControlledGate4JpegMedia({
          publicDirectory,
          publicOrigin: instagramConfig.publicOrigin
        });
        const publicationTransport = options.instagramPublicationTransport ||
          globalThis.fetch;
        const publicationConnector = createInstagramPublicationConnector({
          config: instagramConfig,
          store: connectorStore,
          credentials,
          media: controlledMedia,
          transport: publicationTransport,
          clock: options.clock || Date.now,
          setTimeout: options.setTimeout,
          clearTimeout: options.clearTimeout,
          sleep: options.publicationSleep
        });
        instagramPublication = createInstagramPublicationService({
          config: instagramConfig,
          authAdapter,
          connectorStore,
          connectorAudit,
          credentials,
          media: controlledMedia,
          publicationConnector,
          logger: options.logger,
          clock: options.clock || Date.now,
          randomUUID: options.randomUUID
        });
      }
    }
    if (options.realReviewerEnabled === true) {
      if (!instagramConfig.instagramEnabled) {
        postgresFail(
          "social_instagram_configuration_invalid",
          "Configuracao do revisor real recusada."
        );
      }
      const publicationTransport = options.instagramPublicationTransport ||
        globalThis.fetch;
      instagramReviewer = createInstagramRealReviewerService({
        config: instagramConfig,
        authAdapter,
        connectorStore,
        connectorAudit,
        media: options.realReviewerMedia,
        createPublicationConnector(expectedContext, media) {
          return createInstagramPublicationConnector({
            config: instagramConfig,
            store: connectorStore,
            credentials,
            media,
            transport: publicationTransport,
            clock: options.clock || Date.now,
            setTimeout: options.setTimeout,
            clearTimeout: options.clearTimeout,
            sleep: options.publicationSleep,
            authorizeContext: (candidate) => candidate === expectedContext,
            authorizeConnection(connection) {
              return (
                ["business", "creator"].includes(
                  connection.account?.accountType
                ) &&
                (
                  instagramConfig.expectedUsername === null ||
                  connection.account?.username ===
                    instagramConfig.expectedUsername
                )
              );
            },
            authorizePublicationRequest: () => true,
            authorizePublication(input) {
              return (
                typeof input.caption === "string" &&
                input.owned.caption === input.caption
              );
            },
            allowOperationReferenceReconciliation: false,
            reconciliationLookbackMs: 30 * 1000,
            authorizePublishedCandidate: reviewerPublishedCandidateAuthorized
          });
        },
        logger: options.logger,
        clock: options.clock || Date.now,
        randomUUID: options.randomUUID
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
      instagramPublication,
      instagramReviewer,
      metaCompliance,
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
        if (metaSignedRequestVerifier) metaSignedRequestVerifier.destroy();
        if (metaComplianceRepository) metaComplianceRepository.destroy();
        vault.destroy();
        identityConfig.key.fill(0);
        await closePostgresPool(pool);
      }
    });
  } catch (error) {
    if (instagramStateEnvelope) instagramStateEnvelope.destroy();
    if (metaSignedRequestVerifier) metaSignedRequestVerifier.destroy();
    if (metaComplianceRepository) metaComplianceRepository.destroy();
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
