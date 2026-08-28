"use strict";

const crypto = require("node:crypto");
const {
  createConnectorContext,
  requireUuid
} = require("../connectors/contract");
const { connectorFail } = require("../connectors/errors");
const { createConnectorRegistry } = require("../connectors/registry");
const { createSocialConnectorService } = require("../connectors/service");
const {
  INSTAGRAM_OAUTH_SCOPES,
  INSTAGRAM_PROVIDER
} = require("../oauth/instagram-config");
const {
  CONTROLLED_GATE4_COMPANY_ID,
  CONTROLLED_GATE4_JPEG_SHA256,
  CONTROLLED_GATE4_STAGING_ORIGIN,
  CONTROLLED_GATE4_USER_ID,
  controlledGate4MediaReference
} = require("./controlled-gate4-jpeg");
const {
  INSTAGRAM_GATE4_CAPTION,
  parseConfirmedReference
} = require("./instagram-publication-connector");

function deterministicUuid(namespace, label) {
  const digest = crypto
    .createHash("sha256")
    .update(`${namespace}:${label}`, "utf8")
    .digest();
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  digest.fill(0);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20)
  ].join("-");
}

function sha256Json(value) {
  return crypto.createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

function publicDate(value) {
  if (value === null || value === undefined) return null;
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    connectorFail("resource_unavailable");
  }
  return value.toISOString();
}

function publicAttempt(value) {
  return Object.freeze({
    attemptNumber: value.attemptNumber,
    state: value.state,
    errorCode: value.errorCode,
    providerReference: value.providerReference,
    startedAt: publicDate(value.startedAt),
    finishedAt: publicDate(value.finishedAt),
    durationMs: value.durationMs
  });
}

function verifiedClaimsInput(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).length !== 1 ||
    !Object.hasOwn(value, "verifiedClaims")
  ) {
    connectorFail("social_context_invalid");
  }
  return value.verifiedClaims;
}

function createInstagramPublicationService(options = {}) {
  const config = options.config;
  const authAdapter = options.authAdapter;
  const connectorStore = options.connectorStore;
  const connectorAudit = options.connectorAudit;
  const credentials = options.credentials;
  const media = options.media;
  const publicationConnector = options.publicationConnector;
  const randomUUID = options.randomUUID || crypto.randomUUID;
  const clock = options.clock || Date.now;
  const expectedCompanyId = options.expectedCompanyId ||
    CONTROLLED_GATE4_COMPANY_ID;
  const expectedUserId = options.expectedUserId || CONTROLLED_GATE4_USER_ID;
  if (
    !config ||
    config.provider !== INSTAGRAM_PROVIDER ||
    config.publicOrigin !== CONTROLLED_GATE4_STAGING_ORIGIN ||
    config.expectedUsername !== "ia4tube_empresas" ||
    typeof config.externalPublicationEnabled !== "boolean" ||
    typeof authAdapter?.fromVerifiedJwt !== "function" ||
    typeof connectorStore?.scope !== "function" ||
    typeof connectorAudit?.append !== "function" ||
    typeof credentials?.withDecryptedCredential !== "function" ||
    typeof media?.resolveOwnedJpeg !== "function" ||
    !publicationConnector ||
    typeof randomUUID !== "function" ||
    typeof clock !== "function"
  ) {
    connectorFail("connector_contract_invalid");
  }
  requireUuid(expectedCompanyId);
  requireUuid(expectedUserId);

  const operationId = deterministicUuid(
    expectedCompanyId,
    `instagram-gate4-operation:${CONTROLLED_GATE4_JPEG_SHA256}`
  );
  const publicationId = deterministicUuid(
    expectedCompanyId,
    `instagram-gate4-publication:${CONTROLLED_GATE4_JPEG_SHA256}`
  );
  const registry = createConnectorRegistry({
    environment: "staging",
    gates: {
      externalConnectionEnabled: config.externalConnectionEnabled,
      externalPublicationEnabled: config.externalPublicationEnabled,
      enabledProviders: [INSTAGRAM_PROVIDER],
      companyAllowlist: [expectedCompanyId]
    }
  });
  registry.register(publicationConnector);
  registry.seal();
  const connectorService = createSocialConnectorService({
    registry,
    store: connectorStore,
    audit: connectorAudit,
    media,
    logger: options.logger
  });
  let publicationWindowExpiresAt = 0;

  function publicationWindowArmed() {
    const now = Number(clock());
    if (!Number.isFinite(now) || now >= publicationWindowExpiresAt) {
      publicationWindowExpiresAt = 0;
      return false;
    }
    return true;
  }

  function contextFor(verifiedClaims) {
    const principal = authAdapter.fromVerifiedJwt(verifiedClaims);
    if (
      principal.companyId !== expectedCompanyId ||
      principal.userId !== expectedUserId
    ) {
      connectorFail("external_capability_disabled");
    }
    return createConnectorContext({
      principal,
      provider: INSTAGRAM_PROVIDER,
      environment: "staging",
      correlationId: requireUuid(randomUUID()),
      auditEventId: requireUuid(randomUUID())
    });
  }

  function requireConnection(value, context) {
    if (
      !value ||
      value.companyId !== context.companyId ||
      value.provider !== INSTAGRAM_PROVIDER ||
      value.state !== "connected" ||
      value.health !== "healthy" ||
      !/^[0-9]{5,64}$/.test(value.account?.externalId || "") ||
      value.account?.username !== "ia4tube_empresas" ||
      value.account?.accountType !== "business" ||
      typeof value.activeCredentialId !== "string" ||
      !Array.isArray(value.grantedScopes) ||
      INSTAGRAM_OAUTH_SCOPES.some(
        (scope) => !value.grantedScopes.includes(scope)
      )
    ) {
      connectorFail("credential_unavailable");
    }
    requireUuid(value.id);
    requireUuid(value.activeCredentialId);
    return value;
  }

  async function currentConnection(context) {
    return requireConnection(
      await connectorStore.scope(context).getCurrentConnectionDetails(),
      context
    );
  }

  async function summaryFor(context, connection) {
    const scope = connectorStore.scope(context);
    if (typeof scope.getPublicationSnapshot !== "function") {
      connectorFail("connector_contract_invalid");
    }
    const snapshot = await scope.getPublicationSnapshot(
      publicationId,
      connection.id
    );
    const details = snapshot?.publication || null;
    const publicationCount = snapshot?.publicationCount;
    if (!Number.isSafeInteger(publicationCount) || publicationCount < 0) {
      connectorFail("resource_unavailable");
    }
    const mediaReference = controlledGate4MediaReference(connection.account);
    const expectedMediaMetadataDigest = sha256Json({
      mediaId: mediaReference,
      mimeType: "image/jpeg"
    });
    const expectedRequestHash = sha256Json({
      caption: INSTAGRAM_GATE4_CAPTION,
      connectionId: connection.id,
      image: {
        mediaId: mediaReference,
        mimeType: "image/jpeg"
      },
      publicationId
    });
    let providerMediaId = null;
    let permalink = null;
    let providerPublishedAt = null;
    if (details?.state === "published") {
      const confirmed = parseConfirmedReference(
        details.confirmedProviderReference
      );
      providerMediaId = confirmed.mediaId;
      permalink = confirmed.permalink;
      providerPublishedAt = new Date(
        confirmed.publishedEpochSeconds * 1000
      ).toISOString();
    }
    if (details && (
      details.companyId !== context.companyId ||
      details.connectionId !== connection.id ||
      details.provider !== INSTAGRAM_PROVIDER ||
      details.mediaReference !== mediaReference ||
      details.mediaMetadataDigest !== expectedMediaMetadataDigest ||
      details.caption !== INSTAGRAM_GATE4_CAPTION ||
      details.idempotencyKey !== operationId ||
      details.requestHash !== expectedRequestHash ||
      (details.state === "published" && details.publishedAt === null)
    )) {
      connectorFail("resource_unavailable");
    }
    return Object.freeze({
      ok: true,
      targetUsername: "@ia4tube_empresas",
      controlledJpegSha256: CONTROLLED_GATE4_JPEG_SHA256.toUpperCase(),
      externalPublicationEnabled:
        config.externalPublicationEnabled &&
        details === null &&
        publicationWindowArmed(),
      publicationCount,
      publication: details
        ? Object.freeze({
          publicationId: details.id,
          connectionId: details.connectionId,
          internalReference: details.id,
          state: details.state,
          providerMediaId,
          permalink,
          publishedAt: providerPublishedAt,
          createdAt: publicDate(details.createdAt),
          updatedAt: publicDate(details.updatedAt),
          revision: details.revision,
          attempts: Object.freeze(details.attempts.map(publicAttempt))
        })
        : null
    });
  }

  async function getSummary(input = {}) {
    const context = contextFor(verifiedClaimsInput(input));
    const connection = await currentConnection(context);
    return summaryFor(context, connection);
  }

  async function arm(input = {}) {
    if (config.externalPublicationEnabled !== true) {
      connectorFail("external_capability_disabled");
    }
    const context = contextFor(verifiedClaimsInput(input));
    const connection = await currentConnection(context);
    const existing = await summaryFor(context, connection);
    if (existing.publication) connectorFail("state_transition_invalid");
    const now = Number(clock());
    if (!Number.isFinite(now) || now < 1) {
      connectorFail("resource_unavailable");
    }
    publicationWindowExpiresAt = now + 5 * 60 * 1000;
    return summaryFor(context, connection);
  }

  async function publish(input = {}) {
    const context = contextFor(verifiedClaimsInput(input));
    const connection = await currentConnection(context);
    const existing = await summaryFor(context, connection);
    if (existing.publication) return existing;
    if (
      config.externalPublicationEnabled !== true ||
      !publicationWindowArmed()
    ) {
      connectorFail("external_capability_disabled");
    }
    publicationWindowExpiresAt = 0;
    const mediaReference = controlledGate4MediaReference(connection.account);
    try {
      await connectorService.publishImage(context, {
        operationId,
        publicationId,
        connectionId: connection.id,
        image: Object.freeze({
          mediaId: mediaReference,
          mimeType: "image/jpeg"
        }),
        caption: INSTAGRAM_GATE4_CAPTION
      });
    } catch (error) {
      if (error?.code !== "provider_result_unknown") throw error;
      const details = await connectorStore.scope(context)
        .getPublicationDetails(publicationId);
      if (details?.state !== "provider_confirming") throw error;
    }
    return summaryFor(context, connection);
  }

  async function reconcile(input = {}) {
    if (config.externalPublicationEnabled !== true) {
      connectorFail("external_capability_disabled");
    }
    const context = contextFor(verifiedClaimsInput(input));
    const connection = await currentConnection(context);
    const scope = connectorStore.scope(context);
    let details = await scope.getPublicationDetails(publicationId);
    if (!details) connectorFail("resource_unavailable");
    for (let step = 0; step < 2; step += 1) {
      if (details.state !== "provider_confirming") break;
      const providerReference = details.reconciliationReference;
      if (!providerReference) connectorFail("provider_result_unknown");
      const armed = /^igc:armed:[0-9]{5,64}$/.test(providerReference);
      const reconciliationOperationId = armed
        ? deterministicUuid(
          publicationId,
          `instagram-gate4-media-publish:${providerReference}`
        )
        : requireUuid(randomUUID());
      try {
        await connectorService.getPublicationStatus(context, {
          operationId: reconciliationOperationId,
          publicationId,
          providerReference
        });
      } catch (error) {
        if (error?.code !== "provider_result_unknown") throw error;
        details = await scope.getPublicationDetails(publicationId);
        if (!details || details.state !== "provider_confirming") throw error;
        break;
      }
      const next = await scope.getPublicationDetails(publicationId);
      if (!next) connectorFail("resource_unavailable");
      const progressedToArmed =
        !armed && /^igc:armed:[0-9]{5,64}$/.test(
          next.reconciliationReference || ""
        );
      details = next;
      if (!progressedToArmed) break;
    }
    if (!["provider_confirming", "published"].includes(details.state)) {
      connectorFail("state_transition_invalid");
    }
    return summaryFor(context, connection);
  }

  return Object.freeze({
    arm,
    getSummary,
    publish,
    reconcile
  });
}

module.exports = {
  createInstagramPublicationService,
  deterministicUuid
};
