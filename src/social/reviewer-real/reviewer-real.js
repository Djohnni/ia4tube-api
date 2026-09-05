"use strict";

const crypto = require("node:crypto");
const express = require("express");
const multer = require("multer");

const {
  createConnectorContext,
  requireUuid
} = require("../connectors/contract");
const { connectorFail } = require("../connectors/errors");
const { isAppReviewCompany, canExternalConnection, canExternalPublication } = require("../app-review-policy");
const { createConnectorRegistry } = require("../connectors/registry");
const { createSocialConnectorService } = require("../connectors/service");
const { PUBLICATION_STATES } = require("../connectors/states");
const { createConcurrencyLimiter } = require("../../security/runtime-security");
const {
  INSTAGRAM_OAUTH_SCOPES,
  INSTAGRAM_PROVIDER
} = require("../oauth/instagram-config");
const {
  canonicalPermalink,
  parseConfirmedReference
} = require("../publication/instagram-publication-connector");

const REAL_REVIEWER_ROUTE_PREFIX = "/v1/social/reviewer";
const REAL_REVIEWER_ENTRY_PATH = "/reviewer";
const REAL_REVIEWER_STAGING_ORIGIN =
  "https://ia4tube-api-staging-checkpoint-a.onrender.com";
const REAL_REVIEWER_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "connect-src 'self'",
  "font-src 'self' data:",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'self' data: blob:",
  "object-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'"
].join("; ");
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SAFE_MEDIA_REFERENCE = /^[A-Za-z0-9:_-]{20,200}$/;
const PROFESSIONAL_ACCOUNT_TYPES = new Set(["business", "creator"]);
const REVIEWER_MEDIA_MAX_BYTES = 8 * 1024 * 1024;
const REVIEWER_SOURCE_CAPTION_MAX_LENGTH = 2150;
const ERROR_STATUS = Object.freeze({
  connector_contract_invalid: 503,
  credential_unavailable: 503,
  external_capability_disabled: 503,
  idempotency_conflict: 409,
  permission_missing: 403,
  provider_permanent_failure: 502,
  provider_result_unknown: 502,
  provider_temporary_failure: 503,
  reviewer_media_invalid: 400,
  reviewer_media_limit_reached: 409,
  reviewer_media_storage_unavailable: 503,
  reviewer_media_too_large: 413,
  resource_unavailable: 404,
  social_authenticated_principal_invalid: 401,
  social_context_invalid: 403,
  state_transition_invalid: 409
});

function reviewerMediaError(code) {
  const error = new Error("Midia do revisor recusada.");
  error.code = code;
  return error;
}

function reviewerMediaFail(code) {
  throw reviewerMediaError(code);
}

function reviewerSourceCaption(value) {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length < 1 ||
    value.length > REVIEWER_SOURCE_CAPTION_MAX_LENGTH ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  ) {
    reviewerMediaFail("reviewer_media_invalid");
  }
  return value;
}

function exactTrue(value) {
  return value === "true";
}

function realReviewerUiGateState(env = process.env) {
  const environment = env.ENVIRONMENT === "staging";
  const origin = env.PUBLIC_API_BASE_URL === REAL_REVIEWER_STAGING_ORIGIN;
  const enabled = exactTrue(env.REAL_REVIEWER_UI_ENABLED);
  return Object.freeze({
    enabled: environment && origin && enabled,
    environment,
    origin,
    flag: enabled
  });
}

function isRealReviewerLoginHandoffUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ""), REAL_REVIEWER_STAGING_ORIGIN);
  } catch {
    return false;
  }
  const keys = [...parsed.searchParams.keys()];
  return parsed.pathname === "/app.html" &&
    !parsed.hash &&
    keys.length === 1 &&
    keys[0] === "gate5a_review_login" &&
    parsed.searchParams.getAll("gate5a_review_login").length === 1 &&
    parsed.searchParams.get("gate5a_review_login") === "1";
}

function isRecord(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  );
}

function exactRecord(value, keys, code = "connector_contract_invalid") {
  if (!isRecord(value)) connectorFail(code);
  const actual = Object.keys(value);
  if (
    actual.length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    connectorFail(code);
  }
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set) connectorFail(code);
  }
  return value;
}

function boundedText(value, maximum = 500) {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length < 1 ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    connectorFail("connector_contract_invalid");
  }
  return value;
}

function safeCaption(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 2200 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  ) {
    connectorFail("connector_contract_invalid");
  }
  return value;
}

function clientRequestId(value) {
  const clean = boundedText(value, 36).toLowerCase();
  if (!UUID_PATTERN.test(clean)) connectorFail("connector_contract_invalid");
  return clean;
}

function mediaReference(value) {
  const clean = boundedText(value, 200);
  if (!SAFE_MEDIA_REFERENCE.test(clean)) {
    connectorFail("connector_contract_invalid");
  }
  return clean;
}

function reviewerCaptionMarker(value) {
  const match = /^reviewer-jpeg:([0-9a-f]{64})$/.exec(String(value || ""));
  return match
    ? `#IA4Tube #IA4TubeReview_${match[1].slice(0, 24).toUpperCase()}`
    : null;
}

function reviewerMediaIdentity(input = {}) {
  const orderId = String(input.orderId || "");
  const jpegSha256 = String(input.jpegSha256 || "");
  const sourceCaption = input.caption;
  if (
    orderId.length < 1 ||
    orderId.length > 160 ||
    orderId === "." ||
    orderId === ".." ||
    /[\\/\u0000-\u001f\u007f]/.test(orderId) ||
    !/^[0-9a-f]{64}$/.test(jpegSha256) ||
    typeof sourceCaption !== "string" ||
    sourceCaption.length < 1 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(sourceCaption)
  ) {
    return null;
  }
  const digest = crypto
    .createHash("sha256")
    .update("ia4tube-real-reviewer-jpeg-v1\0", "utf8")
    .update(orderId, "utf8")
    .update("\0", "utf8")
    .update(jpegSha256, "ascii")
    .update("\0", "utf8")
    .update(sourceCaption, "utf8")
    .digest("hex");
  const mediaId = `reviewer-jpeg:${digest}`;
  const caption = `${sourceCaption}\n\n${reviewerCaptionMarker(mediaId)}`;
  return caption.length <= 2200
    ? Object.freeze({ mediaId, caption })
    : null;
}

function reviewerPublishedCandidateAuthorized(input) {
  const publication = input?.publication;
  const candidate = input?.candidate;
  const intentMarker = reviewerIntentMarker(publication?.mediaReference, publication?.id);
  const marker = intentMarker && publication?.caption?.endsWith(`\n\n${intentMarker}`)
    ? intentMarker
    : reviewerCaptionMarker(publication?.mediaReference);
  return Boolean(
    marker &&
    typeof publication?.caption === "string" &&
    typeof candidate?.caption === "string" &&
    candidate.caption === publication.caption &&
    candidate.caption.endsWith(`\n\n${marker}`)
  );
}

function reviewerIntentMarker(mediaId, publicationId) {
  if (!reviewerCaptionMarker(mediaId) || !UUID_PATTERN.test(String(publicationId || ""))) return null;
  const digest = crypto.createHash("sha256")
    .update(`ia4tube-review-intent-v1\0${mediaId}\0${publicationId}`, "utf8")
    .digest("hex").slice(0, 24).toUpperCase();
  return `#IA4Tube #IA4TubeReview_${digest}`;
}

function reviewerIntentCaption(mediaId, caption, publicationId) {
  const marker = reviewerIntentMarker(mediaId, publicationId);
  if (!marker) connectorFail("connector_contract_invalid");
  const oldSuffix = `\n\n${reviewerCaptionMarker(mediaId)}`;
  const source = caption.endsWith(oldSuffix) ? caption.slice(0, -oldSuffix.length) : caption;
  return safeCaption(`${source}\n\n${marker}`);
}

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

function publicDate(value, optional = false) {
  if (optional && value === null) return null;
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    connectorFail("resource_unavailable");
  }
  return value.toISOString();
}

function publicAccount(value) {
  if (value === null || value === undefined) return null;
  if (
    !isRecord(value) ||
    typeof value.username !== "string" ||
    value.username.length < 1 ||
    value.username.length > 200 ||
    !PROFESSIONAL_ACCOUNT_TYPES.has(value.accountType)
  ) {
    connectorFail("resource_unavailable");
  }
  return Object.freeze({
    username: `@${value.username.replace(/^@/, "")}`,
    accountType: value.accountType
  });
}

function publicMedia(value, expectedCompanyId) {
  if (
    !isRecord(value) ||
    value.companyId !== expectedCompanyId ||
    value.mimeType !== "image/jpeg" ||
    !Number.isSafeInteger(value.width) ||
    value.width < 1 ||
    !Number.isSafeInteger(value.height) ||
    value.height < 1
  ) {
    connectorFail("resource_unavailable");
  }
  const id = mediaReference(value.mediaId);
  const caption = safeCaption(value.caption);
  const thumbnailUrl = boundedText(value.thumbnailUrl, 1000);
  let parsed;
  try {
    parsed = new URL(thumbnailUrl);
  } catch {
    connectorFail("resource_unavailable");
  }
  const capabilityPrefix = `${REAL_REVIEWER_ROUTE_PREFIX}/media-capability/`;
  const capabilitySegments = parsed.pathname.startsWith(capabilityPrefix)
    ? parsed.pathname.slice(capabilityPrefix.length).split("/")
    : [];
  let capabilityMediaId = "";
  try {
    capabilityMediaId = decodeURIComponent(capabilitySegments[0] || "");
  } catch {
    connectorFail("resource_unavailable");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.origin !== REAL_REVIEWER_STAGING_ORIGIN ||
    capabilitySegments.length !== 5 ||
    capabilityMediaId !== id ||
    !/^[0-9]{10}$/.test(capabilitySegments[1] || "") ||
    !/^[A-Za-z0-9_-]{24}$/.test(capabilitySegments[2] || "") ||
    !/^[A-Za-z0-9_-]{39,251}$/.test(capabilitySegments[3] || "") ||
    !/^[A-Za-z0-9_-]{43}$/.test(capabilitySegments[4] || "") ||
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    parsed.search
  ) {
    connectorFail("resource_unavailable");
  }
  return Object.freeze({
    id,
    fileName: "preview_ia4tube.jpg",
    mimeType: "image/jpeg",
    width: value.width,
    height: value.height,
    thumbnailUrl,
    caption,
    owner: "Empresa autenticada"
  });
}

function publicAttempt(value) {
  if (!isRecord(value)) connectorFail("resource_unavailable");
  return Object.freeze({
    attemptNumber: value.attemptNumber,
    state: boundedText(value.state, 40),
    errorCode: value.errorCode === null
      ? null
      : boundedText(value.errorCode, 100),
    startedAt: publicDate(value.startedAt),
    finishedAt: publicDate(value.finishedAt, true),
    durationMs: value.durationMs
  });
}

function publicPublication(value, account = null) {
  if (
    !isRecord(value) ||
    !PUBLICATION_STATES.includes(value.state) ||
    !Array.isArray(value.attempts) ||
    value.attempts.length > 20
  ) {
    connectorFail("resource_unavailable");
  }
  const publicationId = requireUuid(value.id);
  const connectionId = requireUuid(value.connectionId);
  const state = ["ready", "publishing"].includes(value.state) ? "sending" : value.state;
  let providerMediaId = null;
  let permalink = null;
  let publishedAt = null;
  if (value.state === "published") {
    if (value.publishedAt === null) connectorFail("resource_unavailable");
    const confirmed = parseConfirmedReference(
      value.confirmedProviderReference
    );
    providerMediaId = confirmed.mediaId;
    permalink = canonicalPermalink(confirmed.permalink);
    publishedAt = new Date(
      confirmed.publishedEpochSeconds * 1000
    ).toISOString();
  } else if (value.confirmedProviderReference !== null) {
    connectorFail("resource_unavailable");
  }
  return Object.freeze({
    publicationId,
    connectionId,
    internalReference: publicationId,
    state,
    account: publicAccount(account),
    media: Object.freeze({
      id: mediaReference(value.mediaReference),
      fileName: "preview_ia4tube.jpg",
      mimeType: "image/jpeg"
    }),
    caption: safeCaption(value.caption),
    providerMediaId,
    permalink,
    publishedAt,
    createdAt: publicDate(value.createdAt),
    updatedAt: publicDate(value.updatedAt),
    revision: value.revision,
    attempts: Object.freeze(value.attempts.map(publicAttempt))
  });
}

function verifiedSession(input, authAdapter, randomUUID) {
  const source = exactRecord(input, ["verifiedClaims"]);
  const claims = source.verifiedClaims;
  if (!isRecord(claims)) {
    connectorFail("social_authenticated_principal_invalid");
  }
  const principal = authAdapter.fromVerifiedJwt(claims);
  const owner = boundedText(claims.whatsapp, 500);
  const context = createConnectorContext({
    principal,
    provider: INSTAGRAM_PROVIDER,
    environment: "staging",
    correlationId: requireUuid(randomUUID()),
    auditEventId: requireUuid(randomUUID())
  });
  return Object.freeze({ context, owner });
}

function requireConnectedAccount(value, context) {
  if (
    !isRecord(value) ||
    value.companyId !== context.companyId ||
    value.provider !== INSTAGRAM_PROVIDER ||
    value.state !== "connected" ||
    value.health !== "healthy" ||
    typeof value.activeCredentialId !== "string" ||
    !isRecord(value.account) ||
    !PROFESSIONAL_ACCOUNT_TYPES.has(value.account.accountType) ||
    !Array.isArray(value.grantedScopes) ||
    value.grantedScopes.length !== INSTAGRAM_OAUTH_SCOPES.length ||
    INSTAGRAM_OAUTH_SCOPES.some(
      (scope) => !value.grantedScopes.includes(scope)
    )
  ) {
    connectorFail("credential_unavailable");
  }
  requireUuid(value.id);
  return value;
}

function createInstagramRealReviewerService(options = {}) {
  const config = options.config;
  const authAdapter = options.authAdapter;
  const connectorStore = options.connectorStore;
  const connectorAudit = options.connectorAudit;
  const media = options.media;
  const createPublicationConnector = options.createPublicationConnector;
  const randomUUID = options.randomUUID || crypto.randomUUID;
  const activeSubmissions = new Set();
  const createConnectorService = options.createConnectorService || ((input) => {
    const registry = createConnectorRegistry({
      environment: "staging",
      gates: {
        externalConnectionEnabled: canExternalConnection(config, input.context),
        externalPublicationEnabled: canExternalPublication(config, input.context),
        enabledProviders: [INSTAGRAM_PROVIDER],
        companyAllowlist: [input.context.companyId]
      }
    });
    registry.register(createPublicationConnector(input.context, input.media));
    registry.seal();
    return createSocialConnectorService({
      registry,
      store: isAppReviewCompany(config, input.context.companyId)
        ? Object.freeze({ scope(context) {
          if (context !== input.context) connectorFail("resource_unavailable");
          const scoped = connectorStore.scope(context);
          if (typeof scoped.beginAppReviewIdempotency !== "function") {
            connectorFail("connector_contract_invalid");
          }
          return Object.freeze({ ...scoped, beginIdempotency: scoped.beginAppReviewIdempotency });
        } })
        : connectorStore,
      audit: connectorAudit,
      media: input.media,
      logger: options.logger
    });
  });
  if (
    !config ||
    config.provider !== INSTAGRAM_PROVIDER ||
    config.publicOrigin !== REAL_REVIEWER_STAGING_ORIGIN ||
    typeof config.externalConnectionEnabled !== "boolean" ||
    typeof config.externalPublicationEnabled !== "boolean" ||
    typeof authAdapter?.fromVerifiedJwt !== "function" ||
    typeof connectorStore?.scope !== "function" ||
    typeof connectorAudit?.append !== "function" ||
    typeof media?.listOwnedJpegs !== "function" ||
    typeof media?.resolveOwnedJpeg !== "function" ||
    typeof createPublicationConnector !== "function" ||
    typeof createConnectorService !== "function" ||
    typeof randomUUID !== "function"
  ) {
    connectorFail("connector_contract_invalid");
  }

  function session(input) {
    return verifiedSession(input, authAdapter, randomUUID);
  }

  function scopedMedia(current, publicationId = null) {
    return Object.freeze({
      async resolveOwnedJpeg(context, id) {
        if (context !== current.context) {
          connectorFail("resource_unavailable");
        }
        const owned = await media.resolveOwnedJpeg({
          context,
          owner: current.owner,
          mediaId: mediaReference(id)
        });
        if (
          !owned ||
          owned.companyId !== context.companyId ||
          owned.mediaId !== id ||
          owned.mimeType !== "image/jpeg"
        ) {
          connectorFail("resource_unavailable");
        }
        return publicationId && isAppReviewCompany(config, context.companyId)
          ? Object.freeze({ ...owned, caption: reviewerIntentCaption(id, owned.caption, publicationId) })
          : owned;
      }
    });
  }

  async function connectedAccount(current) {
    return requireConnectedAccount(
      await connectorStore.scope(current.context)
        .getCurrentConnectionDetails(),
      current.context
    );
  }

  async function listMedia(input = {}) {
    const current = session(input);
    const values = await media.listOwnedJpegs({
      context: current.context,
      owner: current.owner
    });
    if (!Array.isArray(values) || values.length > 20) {
      connectorFail("resource_unavailable");
    }
    return Object.freeze({
      ok: true,
      contentOwnerDerivedFromSession: true,
      media: Object.freeze(values.map(
        (value) => publicMedia(value, current.context.companyId)
      ))
    });
  }

  async function uploadMedia(input = {}) {
    const source = exactRecord(input, ["verifiedClaims", "bytes", "caption"]);
    const current = session({ verifiedClaims: source.verifiedClaims });
    const caption = reviewerSourceCaption(source.caption);
    if (
      !Buffer.isBuffer(source.bytes) ||
      source.bytes.length < 16
    ) {
      reviewerMediaFail("reviewer_media_invalid");
    }
    if (source.bytes.length > REVIEWER_MEDIA_MAX_BYTES) {
      reviewerMediaFail("reviewer_media_too_large");
    }
    if (typeof media.storeOwnedJpeg !== "function") {
      reviewerMediaFail("reviewer_media_storage_unavailable");
    }
    const stored = await media.storeOwnedJpeg({
      context: current.context,
      owner: current.owner,
      bytes: source.bytes,
      caption
    });
    return Object.freeze({
      ok: true,
      contentOwnerDerivedFromSession: true,
      media: publicMedia(stored, current.context.companyId)
    });
  }

  async function listPublications(input = {}) {
    const current = session(input);
    const scope = connectorStore.scope(current.context);
    const reviewTenant = isAppReviewCompany(config, current.context.companyId);
    const publicationId = deterministicUuid(
      current.context.companyId,
      "instagram-real-reviewer-publication:v1"
    );
    if (reviewTenant &&
        typeof scope.listAppReviewPublicationDetails !== "function") {
      connectorFail("connector_contract_invalid");
    }
    const details = reviewTenant
      ? await scope.listAppReviewPublicationDetails()
      : [await scope.getPublicationDetails(publicationId)].filter(Boolean);
    const publications = await Promise.all(details.map(async (value) => {
      const connection = await scope.getConnectionDetails(value.connectionId);
      return publicPublication(value, publicationAccount(value, connection));
    }));
    return Object.freeze({
      ok: true,
      canonicalPersistence: true,
      independentReview: reviewTenant,
      freshPublicationAvailable: reviewTenant && !details.some((item) =>
        ["ready", "publishing", "provider_confirming"].includes(item.state)),
      publications: Object.freeze(publications)
    });
  }

  async function publicationById(current, publicationId) {
    const cleanId = requireUuid(publicationId);
    const scope = connectorStore.scope(current.context);
    const details = await scope.getPublicationDetails(cleanId);
    if (!details) connectorFail("resource_unavailable");
    const connection = await scope.getConnectionDetails(details.connectionId);
    return publicPublication(details, publicationAccount(details, connection));
  }

  async function getPublication(input = {}) {
    const source = exactRecord(input, ["verifiedClaims", "publicationId"]);
    const current = session({ verifiedClaims: source.verifiedClaims });
    const expectedId = deterministicUuid(
      current.context.companyId,
      "instagram-real-reviewer-publication:v1"
    );
    if (!isAppReviewCompany(config, current.context.companyId) &&
        requireUuid(source.publicationId) !== expectedId) {
      connectorFail("resource_unavailable");
    }
    return Object.freeze({
      ok: true,
      canonicalPersistence: true,
      publication: await publicationById(current, source.publicationId)
    });
  }

  async function publish(input = {}) {
    const source = exactRecord(input, [
      "verifiedClaims",
      "mediaId",
      "clientRequestId"
    ]);
    const current = session({ verifiedClaims: source.verifiedClaims });
    if (!canExternalPublication(config, current.context)) {
      connectorFail("external_capability_disabled");
    }
    const scope = connectorStore.scope(current.context);
    if (isAppReviewCompany(config, current.context.companyId)) {
      if (typeof scope.listAppReviewPublicationDetails !== "function") {
        connectorFail("connector_contract_invalid");
      }
      const key = current.context.companyId;
      if (activeSubmissions.has(key)) connectorFail("state_transition_invalid");
      activeSubmissions.add(key);
      try { return await publishIntent(current, source, scope); }
      finally { activeSubmissions.delete(key); }
    }
    return publishIntent(current, source, scope);
  }

  async function publishIntent(current, source, scope) {
    const reviewTenant = isAppReviewCompany(config, current.context.companyId);
    const cleanMediaId = mediaReference(source.mediaId);
    const requestId = clientRequestId(source.clientRequestId);
    const connection = await connectedAccount(current);
    const publicationId = deterministicUuid(
      current.context.companyId,
      reviewTenant
        ? `instagram-app-review-publication:v1:${connection.id}:${connection.account.externalId}:${cleanMediaId}:${requestId}`
        : "instagram-real-reviewer-publication:v1"
    );
    const existing = await scope.getPublicationDetails(publicationId);
    if (existing) {
      if (["ready", "publishing", "provider_confirming", "published"].includes(
        existing.state
      )) {
        return Object.freeze({
          ok: true,
          duplicateSubmissionPrevented: true,
          publication: await publicationById(current, publicationId)
        });
      }
      if (existing.state !== "failed_temporary") {
        connectorFail("state_transition_invalid");
      }
    }
    if (reviewTenant) {
      const pending = (await scope.listAppReviewPublicationDetails()).find((item) =>
        item.id !== publicationId && ["ready", "publishing", "provider_confirming"].includes(item.state));
      if (pending) connectorFail("state_transition_invalid");
    }
    const reviewerMedia = scopedMedia(current, reviewTenant ? publicationId : null);
    const owned = await reviewerMedia.resolveOwnedJpeg(
      current.context,
      cleanMediaId
    );
    if (existing && (
      existing.connectionId !== connection.id ||
      existing.mediaReference !== cleanMediaId ||
      existing.caption !== owned.caption
    )) {
      connectorFail("resource_unavailable");
    }
    const connectorService = createConnectorService({
      context: current.context,
      media: reviewerMedia
    });
    if (typeof connectorService?.publishImage !== "function") {
      connectorFail("connector_contract_invalid");
    }
    const operationId = reviewTenant
      ? deterministicUuid(current.context.companyId,
        `instagram-review-submit:v1:${connection.id}:${connection.account.externalId}:${requestId}:${existing?.attempts?.length || 0}`)
      : deterministicUuid(publicationId, `manual-submit:${requestId}`);
    try {
      await connectorService.publishImage(current.context, {
        operationId,
        publicationId,
        connectionId: connection.id,
        image: Object.freeze({
          mediaId: cleanMediaId,
          mimeType: "image/jpeg"
        }),
        caption: safeCaption(owned.caption)
      });
    } catch (error) {
      if (error?.code !== "provider_result_unknown") throw error;
      const persisted = await scope.getPublicationDetails(publicationId);
      if (!persisted || persisted.state !== "provider_confirming") throw error;
    }
    return Object.freeze({
      ok: true,
      duplicateSubmissionPrevented: false,
      publication: await publicationById(current, publicationId)
    });
  }

  async function reconcile(input = {}) {
    const source = exactRecord(input, ["verifiedClaims", "publicationId"]);
    const current = session({ verifiedClaims: source.verifiedClaims });
    if (!canExternalPublication(config, current.context)) {
      connectorFail("external_capability_disabled");
    }
    const publicationId = requireUuid(source.publicationId);
    const expectedId = deterministicUuid(
      current.context.companyId,
      "instagram-real-reviewer-publication:v1"
    );
    if (!isAppReviewCompany(config, current.context.companyId) && publicationId !== expectedId) {
      connectorFail("resource_unavailable");
    }
    const scope = connectorStore.scope(current.context);
    const details = await scope.getPublicationDetails(publicationId);
    if (!details || details.state !== "provider_confirming") {
      connectorFail("state_transition_invalid");
    }
    const connection = await connectedAccount(current);
    if (details.connectionId !== connection.id) {
      connectorFail("resource_unavailable");
    }
    const reviewerMedia = scopedMedia(current, isAppReviewCompany(config, current.context.companyId)
      ? publicationId : null);
    const connectorService = createConnectorService({
      context: current.context,
      media: reviewerMedia
    });
    if (typeof connectorService?.getPublicationStatus !== "function") {
      connectorFail("connector_contract_invalid");
    }
    const providerReference = details.reconciliationReference;
    if (typeof providerReference !== "string") {
      connectorFail("provider_result_unknown");
    }
    const operationId = /^igc:armed:[0-9]{5,64}$/.test(providerReference)
      ? deterministicUuid(
        publicationId,
        `instagram-real-reviewer-media-publish:${providerReference}`
      )
      : requireUuid(randomUUID());
    try {
      await connectorService.getPublicationStatus(current.context, {
        operationId,
        publicationId,
        providerReference
      });
    } catch (error) {
      if (error?.code !== "provider_result_unknown") throw error;
      const persisted = await scope.getPublicationDetails(publicationId);
      if (!persisted || persisted.state !== "provider_confirming") throw error;
    }
    return Object.freeze({
      ok: true,
      publication: await publicationById(current, publicationId)
    });
  }

  return Object.freeze({
    getPublication,
    listMedia,
    listPublications,
    publish,
    reconcile,
    uploadMedia
  });
}

function publicationAccount(value, connection) {
  if (!isRecord(connection?.account)) return null;
  if (["ready", "publishing", "provider_confirming"].includes(value.state)) {
    return connection.account;
  }
  const publicationUpdatedAt = value.updatedAt instanceof Date
    ? value.updatedAt.getTime()
    : NaN;
  const connectionUpdatedAt = connection.updatedAt instanceof Date
    ? connection.updatedAt.getTime()
    : NaN;
  // A reconnect can attach another account to the same connection record.
  // If the connection changed after this terminal publication, omit the
  // account instead of relabelling immutable history with current data.
  return Number.isFinite(publicationUpdatedAt) &&
    Number.isFinite(connectionUpdatedAt) &&
    connectionUpdatedAt <= publicationUpdatedAt
    ? connection.account
    : null;
}

function emptyRecord(value) {
  return value == null || (isRecord(value) && Object.keys(value).length === 0);
}

function requireUser(req) {
  if (!isRecord(req?.user)) {
    connectorFail("social_authenticated_principal_invalid");
  }
  return req.user;
}

function assertEmptyRequest(req, parameterKeys = []) {
  if (
    !isRecord(req?.params) ||
    Object.keys(req.params).length !== parameterKeys.length ||
    parameterKeys.some((key) => !Object.hasOwn(req.params, key)) ||
    !emptyRecord(req?.query) ||
    !emptyRecord(req?.body)
  ) {
    connectorFail("social_context_invalid");
  }
}

function noStore(_req, res, next) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  return next();
}

function sendError(res, error) {
  const code = Object.hasOwn(ERROR_STATUS, error?.code)
    ? error.code
    : "connector_contract_invalid";
  return res.status(ERROR_STATUS[code]).json(Object.freeze({
    ok: false,
    code
  }));
}

const parseReviewerMediaMultipart = multer({
  storage: multer.memoryStorage(),
  limits: Object.freeze({
    // Multer marks a stream truncated when it reaches its configured ceiling.
    // One extra byte keeps the public 8 MiB limit inclusive; the service still
    // rejects every payload whose actual size exceeds REVIEWER_MEDIA_MAX_BYTES.
    fileSize: REVIEWER_MEDIA_MAX_BYTES + 1,
    files: 1,
    fields: 1,
    // Busboy counts the terminating boundary when enforcing this limit.
    // Three therefore admits exactly the one file + one text field contract.
    parts: 3,
    fieldNameSize: 32,
    fieldSize: 16 * 1024
  }),
  fileFilter(_req, file, callback) {
    if (
      file?.fieldname !== "jpeg" ||
      String(file?.mimetype || "").trim().toLowerCase() !== "image/jpeg"
    ) {
      return callback(reviewerMediaError("reviewer_media_invalid"));
    }
    return callback(null, true);
  }
}).single("jpeg");

function reviewerMediaMultipart(req, res, next) {
  return parseReviewerMediaMultipart(req, res, (error) => {
    if (!error) return next();
    if (Buffer.isBuffer(req.file?.buffer)) req.file.buffer.fill(0);
    const code = error instanceof multer.MulterError &&
      error.code === "LIMIT_FILE_SIZE"
      ? "reviewer_media_too_large"
      : "reviewer_media_invalid";
    return sendError(res, reviewerMediaError(code));
  });
}

function assertReviewerMediaUpload(req) {
  if (
    !emptyRecord(req?.query) ||
    !emptyRecord(req?.params) ||
    !isRecord(req?.body) ||
    Object.keys(req.body).length !== 1 ||
    !Object.hasOwn(req.body, "caption") ||
    !req.file ||
    req.file.fieldname !== "jpeg" ||
    req.file.mimetype !== "image/jpeg" ||
    !Buffer.isBuffer(req.file.buffer) ||
    req.file.size !== req.file.buffer.length
  ) {
    reviewerMediaFail("reviewer_media_invalid");
  }
}

function createInstagramRealReviewerRouter(options = {}) {
  if (
    typeof options.authenticate !== "function" ||
    typeof options.getService !== "function"
  ) {
    connectorFail("connector_contract_invalid");
  }
  const router = options.router || express.Router();
  const mediaUploadConcurrencyLimit = createConcurrencyLimiter({
    maxGlobal: 2,
    maxPerKey: 1,
    keyGenerator: (req) => req.user?.whatsapp || "unauthenticated",
    code: "reviewer_media_upload_in_progress",
    message: "Ja existe um JPEG sendo enviado para esta empresa."
  });

  function service() {
    const value = options.getService();
    if (
      !value ||
      typeof value.listMedia !== "function" ||
      typeof value.publish !== "function" ||
      typeof value.listPublications !== "function" ||
      typeof value.getPublication !== "function" ||
      typeof value.reconcile !== "function"
    ) {
      connectorFail("external_capability_disabled");
    }
    return value;
  }

  function route(handler) {
    return async (req, res) => {
      try {
        return await handler(req, res);
      } catch (error) {
        return sendError(res, error);
      }
    };
  }

  router.get("/media", noStore, options.authenticate, route(async (req, res) => {
    assertEmptyRequest(req);
    return res.status(200).json(await service().listMedia({
      verifiedClaims: requireUser(req)
    }));
  }));

  router.post(
    "/media",
    noStore,
    options.authenticate,
    mediaUploadConcurrencyLimit,
    reviewerMediaMultipart,
    route(async (req, res) => {
      const bytes = req.file?.buffer;
      try {
        assertReviewerMediaUpload(req);
        const currentService = service();
        if (typeof currentService.uploadMedia !== "function") {
          reviewerMediaFail("reviewer_media_storage_unavailable");
        }
        const result = await currentService.uploadMedia({
          verifiedClaims: requireUser(req),
          bytes,
          caption: req.body.caption
        });
        return res.status(201).json(result);
      } finally {
        if (Buffer.isBuffer(bytes)) bytes.fill(0);
        if (req.file) delete req.file.buffer;
      }
    })
  );

  router.post("/publications", noStore, options.authenticate, route(async (req, res) => {
    exactRecord(req.body, ["mediaId", "clientRequestId"]);
    if (!emptyRecord(req.query) || !emptyRecord(req.params)) {
      connectorFail("social_context_invalid");
    }
    const result = await service().publish({
      verifiedClaims: requireUser(req),
      mediaId: req.body.mediaId,
      clientRequestId: req.body.clientRequestId
    });
    return res.status(result.publication.state === "published" ? 201 : 202)
      .json(result);
  }));

  router.get("/publications", noStore, options.authenticate, route(async (req, res) => {
    assertEmptyRequest(req);
    return res.status(200).json(await service().listPublications({
      verifiedClaims: requireUser(req)
    }));
  }));

  router.get(
    "/publications/:publicationId",
    noStore,
    options.authenticate,
    route(async (req, res) => {
      assertEmptyRequest(req, ["publicationId"]);
      return res.status(200).json(await service().getPublication({
        verifiedClaims: requireUser(req),
        publicationId: req.params.publicationId
      }));
    })
  );

  router.post(
    "/publications/:publicationId/reconcile",
    noStore,
    options.authenticate,
    route(async (req, res) => {
      assertEmptyRequest(req, ["publicationId"]);
      const result = await service().reconcile({
        verifiedClaims: requireUser(req),
        publicationId: req.params.publicationId
      });
      return res.status(result.publication.state === "published" ? 200 : 202)
        .json(result);
    })
  );

  return router;
}

module.exports = {
  ERROR_STATUS,
  REAL_REVIEWER_CONTENT_SECURITY_POLICY,
  REAL_REVIEWER_ENTRY_PATH,
  REAL_REVIEWER_ROUTE_PREFIX,
  REAL_REVIEWER_STAGING_ORIGIN,
  createInstagramRealReviewerRouter,
  createInstagramRealReviewerService,
  deterministicUuid,
  isRealReviewerLoginHandoffUrl,
  publicPublication,
  reviewerCaptionMarker,
  reviewerIntentCaption,
  reviewerIntentMarker,
  reviewerMediaIdentity,
  reviewerPublishedCandidateAuthorized,
  realReviewerUiGateState
};
