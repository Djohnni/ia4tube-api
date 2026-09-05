"use strict";

const {
  canExternalPublication,
  isAppReviewCompany
} = require("../app-review-policy");

const {
  requireConnectorContext,
  requireUuid
} = require("../connectors/contract");
const {
  SocialConnectorError,
  connectorFail
} = require("../connectors/errors");
const { isSafeProviderReference } = require("../connectors/states");
const { normalizeConnectionBinding } = require("./connection-binding");
const {
  INSTAGRAM_GRAPH_API_ORIGIN,
  INSTAGRAM_OAUTH_SCOPES,
  INSTAGRAM_PROVIDER
} = require("../oauth/instagram-config");
const {
  CONTROLLED_GATE4_COMPANY_ID,
  CONTROLLED_GATE4_USER_ID,
  controlledGate4MediaReference,
  isControlledGate4MediaReference
} = require("./controlled-gate4-jpeg");

const INSTAGRAM_PUBLICATION_TIMEOUT_MS = 10000;
const INSTAGRAM_PUBLICATION_MAX_RESPONSE_BYTES = 64 * 1024;
const INSTAGRAM_PUBLICATION_POLL_ATTEMPTS = 8;
const INSTAGRAM_PUBLICATION_POLL_INTERVAL_MS = 1500;
const INSTAGRAM_PUBLICATION_RECONCILIATION_LOOKBACK_MS = 5 * 60 * 1000;
const INSTAGRAM_MEDIA_ID_PATTERN = /^[0-9]{5,64}$/;
const INSTAGRAM_GATE4_CAPTION = [
  "IA4Tube",
  "",
  "Publicação controlada de validação do fluxo oficial do Instagram.",
  "",
  "#IA4Tube #IA4TubeGate4_4B9224FEE69B707F"
].join("\n");
const SAFE_STATUS_CODES = new Set([
  "EXPIRED",
  "ERROR",
  "FINISHED",
  "IN_PROGRESS",
  "PUBLISHED"
]);

class AmbiguousProviderMutation extends Error {
  constructor() {
    super("Resultado externo indeterminado.");
    this.name = "AmbiguousProviderMutation";
  }
}

function strictObject(value, allowedKeys) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    connectorFail("connector_contract_invalid");
  }
  const keys = Object.keys(value);
  if (
    keys.length !== allowedKeys.length ||
    allowedKeys.some((key) => !Object.hasOwn(value, key))
  ) {
    connectorFail("connector_contract_invalid");
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set) {
      connectorFail("connector_contract_invalid");
    }
  }
  return value;
}

function numericMediaId(value) {
  const clean = typeof value === "string" ? value : "";
  if (!INSTAGRAM_MEDIA_ID_PATTERN.test(clean)) {
    connectorFail("provider_result_unknown");
  }
  return clean;
}

function rethrowDefinitiveProviderError(error) {
  if (
    error instanceof SocialConnectorError &&
    [
      "credential_unavailable",
      "permission_missing",
      "provider_permanent_failure"
    ].includes(error.code)
  ) {
    throw error;
  }
}

function safeReference(value) {
  if (!isSafeProviderReference(value)) {
    connectorFail("provider_result_unknown");
  }
  return value;
}

function operationReference(publicationId) {
  return safeReference(`igo:${requireUuid(publicationId).replaceAll("-", "")}`);
}

function containerReference(stage, containerId) {
  if (!new Set(["created", "armed", "submitted"]).has(stage)) {
    connectorFail("connector_contract_invalid");
  }
  return safeReference(`igc:${stage}:${numericMediaId(containerId)}`);
}

function knownMediaReference(mediaId) {
  return safeReference(`igm:known:${numericMediaId(mediaId)}`);
}

function canonicalPermalink(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    connectorFail("provider_result_unknown");
  }
  const match = parsed.pathname.match(/^\/p\/([A-Za-z0-9_-]{3,100})\/?$/);
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "www.instagram.com" ||
    parsed.port ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !match
  ) {
    connectorFail("provider_result_unknown");
  }
  return `https://www.instagram.com/p/${match[1]}/`;
}

function confirmedReference(mediaId, permalink, clock = Date.now) {
  const id = numericMediaId(mediaId);
  const canonical = canonicalPermalink(permalink);
  const epochSeconds = Math.floor(Number(clock()) / 1000);
  if (!Number.isSafeInteger(epochSeconds) || epochSeconds < 1) {
    connectorFail("provider_result_unknown");
  }
  const encoded = Buffer.from(canonical, "utf8").toString("hex");
  return safeReference(`igm:${id}:${encoded}:${epochSeconds}`);
}

function parseConfirmedReference(value) {
  const clean = safeReference(value);
  const match = clean.match(/^igm:([0-9]{5,64}):([0-9a-f]+):([0-9]{1,16})$/);
  if (!match || match[2].length % 2 !== 0) {
    connectorFail("resource_unavailable");
  }
  let permalink;
  try {
    permalink = Buffer.from(match[2], "hex").toString("utf8");
  } catch {
    connectorFail("resource_unavailable");
  }
  let canonical;
  try {
    canonical = canonicalPermalink(permalink);
  } catch {
    connectorFail("resource_unavailable");
  }
  const publishedEpochSeconds = Number(match[3]);
  if (
    !Number.isSafeInteger(publishedEpochSeconds) ||
    publishedEpochSeconds < 1 ||
    confirmedReference(match[1], canonical, () => publishedEpochSeconds * 1000) !==
      clean
  ) {
    connectorFail("resource_unavailable");
  }
  return Object.freeze({
    mediaId: match[1],
    permalink: canonical,
    publishedEpochSeconds
  });
}

function responseHeader(response, name) {
  if (response?.headers && typeof response.headers.get === "function") {
    const value = response.headers.get(name);
    return value == null ? null : String(value);
  }
  if (!response?.headers || typeof response.headers !== "object") return null;
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(response.headers)) {
    if (String(key).toLowerCase() === target) return String(value);
  }
  return null;
}

async function responseBytes(response) {
  if (typeof response?.arrayBuffer === "function") {
    return Buffer.from(await response.arrayBuffer());
  }
  if (Buffer.isBuffer(response?.body)) return Buffer.from(response.body);
  if (typeof response?.body === "string") return Buffer.from(response.body);
  if (typeof response?.text === "function") {
    return Buffer.from(await response.text(), "utf8");
  }
  connectorFail("provider_result_unknown");
}

function providerErrorCode(value) {
  const candidate = value?.error?.code;
  return Number.isSafeInteger(candidate) ? candidate : null;
}

function classifyRejectedResponse(status, decoded) {
  const providerCode = providerErrorCode(decoded);
  if (status === 401 || providerCode === 190) {
    connectorFail("credential_unavailable");
  }
  if (status === 403 || [10, 200, 299].includes(providerCode)) {
    connectorFail("permission_missing");
  }
  connectorFail("provider_permanent_failure");
}

function parseJsonRecord(bytes) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length < 2 ||
    bytes.length > INSTAGRAM_PUBLICATION_MAX_RESPONSE_BYTES
  ) {
    connectorFail("provider_result_unknown");
  }
  let decoded;
  try {
    decoded = JSON.parse(bytes.toString("utf8"));
  } catch {
    connectorFail("provider_result_unknown");
  }
  if (
    !decoded ||
    typeof decoded !== "object" ||
    Array.isArray(decoded) ||
    Object.getPrototypeOf(decoded) !== Object.prototype
  ) {
    connectorFail("provider_result_unknown");
  }
  return decoded;
}

function requireConnection(connection, context, authorizeConnection) {
  if (
    !connection ||
    connection.companyId !== context.companyId ||
    connection.provider !== INSTAGRAM_PROVIDER ||
    connection.state !== "connected" ||
    connection.health !== "healthy" ||
    typeof connection.account?.username !== "string" ||
    connection.account.username.length < 1 ||
    connection.account.username.length > 200 ||
    !["business", "creator"].includes(connection.account?.accountType) ||
    !INSTAGRAM_MEDIA_ID_PATTERN.test(connection.account?.externalId || "") ||
    typeof connection.activeCredentialId !== "string" ||
    !Array.isArray(connection.grantedScopes) ||
    INSTAGRAM_OAUTH_SCOPES.some(
      (scope) => !connection.grantedScopes.includes(scope)
    ) ||
    authorizeConnection(connection, context) !== true
  ) {
    connectorFail("credential_unavailable");
  }
  requireUuid(connection.id);
  requireUuid(connection.activeCredentialId);
  return connection;
}

function requireToken(value) {
  if (!Buffer.isBuffer(value) || value.length < 1 || value.length > 8192) {
    connectorFail("credential_unavailable");
  }
  for (const byte of value) {
    if (byte < 0x21 || byte > 0x7e) connectorFail("credential_unavailable");
  }
  return value;
}

function createInstagramPublicationConnector(options = {}) {
  const config = options.config;
  const store = options.store;
  const credentials = options.credentials;
  const media = options.media;
  const transport = options.transport || globalThis.fetch;
  const clock = options.clock || Date.now;
  const setTimer = options.setTimeout || setTimeout;
  const clearTimer = options.clearTimeout || clearTimeout;
  const sleep = options.sleep || ((milliseconds) => new Promise(
    (resolve) => setTimer(resolve, milliseconds)
  ));
  const timeoutMs = options.timeoutMs ?? INSTAGRAM_PUBLICATION_TIMEOUT_MS;
  const pollAttempts = options.pollAttempts ??
    INSTAGRAM_PUBLICATION_POLL_ATTEMPTS;
  const pollIntervalMs = options.pollIntervalMs ??
    INSTAGRAM_PUBLICATION_POLL_INTERVAL_MS;
  const expectedCompanyId = options.expectedCompanyId ||
    CONTROLLED_GATE4_COMPANY_ID;
  const expectedUserId = options.expectedUserId || CONTROLLED_GATE4_USER_ID;
  const expectedUsername = options.expectedUsername || "ia4tube_empresas";
  const authorizeContext = options.authorizeContext || ((context) => (
    context.companyId === expectedCompanyId && context.userId === expectedUserId
  ));
  const authorizeConnection = options.authorizeConnection || ((connection) => (
    connection.account?.username === expectedUsername &&
    connection.account?.accountType === "business"
  ));
  const authorizePublicationRequest = options.authorizePublicationRequest ||
    ((input) => (
      isControlledGate4MediaReference(input.image.mediaId) &&
      input.caption === INSTAGRAM_GATE4_CAPTION
    ));
  const authorizePublication = options.authorizePublication || ((input) => (
    isControlledGate4MediaReference(input.image.mediaId) &&
    input.caption === INSTAGRAM_GATE4_CAPTION &&
    input.image.mediaId === controlledGate4MediaReference(
      input.connection.account
    )
  ));
  const authorizePublishedCandidate = options.authorizePublishedCandidate ||
    (() => true);
  const allowOperationReferenceReconciliation =
    options.allowOperationReferenceReconciliation === undefined
      ? true
      : options.allowOperationReferenceReconciliation;
  const reconciliationLookbackMs =
    options.reconciliationLookbackMs === undefined
      ? INSTAGRAM_PUBLICATION_RECONCILIATION_LOOKBACK_MS
      : options.reconciliationLookbackMs;
  if (
    !config ||
    config.provider !== INSTAGRAM_PROVIDER ||
    config.graphApiVersion == null ||
    config.publicOrigin == null ||
    typeof store?.scope !== "function" ||
    typeof credentials?.withDecryptedCredential !== "function" ||
    typeof media?.resolveOwnedJpeg !== "function" ||
    typeof transport !== "function" ||
    typeof clock !== "function" ||
    typeof setTimer !== "function" ||
    typeof clearTimer !== "function" ||
    typeof sleep !== "function" ||
    typeof authorizeContext !== "function" ||
    typeof authorizeConnection !== "function" ||
    typeof authorizePublicationRequest !== "function" ||
    typeof authorizePublication !== "function" ||
    typeof authorizePublishedCandidate !== "function" ||
    typeof allowOperationReferenceReconciliation !== "boolean" ||
    !Number.isSafeInteger(reconciliationLookbackMs) ||
    reconciliationLookbackMs < 0 ||
    reconciliationLookbackMs > INSTAGRAM_PUBLICATION_RECONCILIATION_LOOKBACK_MS ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 30000 ||
    !Number.isSafeInteger(pollAttempts) ||
    pollAttempts < 1 ||
    pollAttempts > 20 ||
    !Number.isSafeInteger(pollIntervalMs) ||
    pollIntervalMs < 0 ||
    pollIntervalMs > 5000
  ) {
    connectorFail("connector_contract_invalid");
  }

  function trustedContext(value) {
    const context = requireConnectorContext(value, {
      provider: INSTAGRAM_PROVIDER,
      environment: config.environment || "staging"
    });
    if (authorizeContext(context) !== true) {
      connectorFail("external_capability_disabled");
    }
    // Legacy Gate 4 gating remains in its connector registry. The separate
    // review window must additionally be checked at the provider boundary.
    if (isAppReviewCompany(config, context.companyId) &&
      !canExternalPublication(config, context)) {
      connectorFail("external_capability_disabled");
    }
    return context;
  }

  function graphUrl(pathname, query = null) {
    if (
      typeof pathname !== "string" ||
      !pathname.startsWith("/") ||
      pathname.includes("?")
    ) {
      connectorFail("connector_contract_invalid");
    }
    const url = new URL(
      `/${config.graphApiVersion}${pathname}`,
      INSTAGRAM_GRAPH_API_ORIGIN
    );
    if (query) {
      for (const [name, value] of Object.entries(query)) {
        url.searchParams.set(name, String(value));
      }
    }
    return url.toString();
  }

  async function requestJson(accessToken, request) {
    const token = requireToken(accessToken).toString("utf8");
    const controller = new AbortController();
    const timedOut = Symbol("timed_out");
    let timer;
    let response;
    let bytes;
    const deadline = new Promise((resolve) => {
      timer = setTimer(() => {
        controller.abort();
        resolve(timedOut);
      }, timeoutMs);
    });
    try {
      const headers = {
        accept: "application/json",
        authorization: `Bearer ${token}`
      };
      if (request.body !== undefined) {
        headers["content-type"] = "application/x-www-form-urlencoded";
      }
      const pending = Promise.resolve().then(() => transport(
        request.url,
        Object.freeze({
          method: request.method,
          headers: Object.freeze(headers),
          body: request.body,
          redirect: "error",
          signal: controller.signal
        })
      ));
      response = await Promise.race([pending, deadline]);
      if (response === timedOut) {
        if (request.mutation) throw new AmbiguousProviderMutation();
        connectorFail("provider_temporary_failure");
      }
      if (!response || !Number.isSafeInteger(response.status)) {
        if (request.mutation) throw new AmbiguousProviderMutation();
        connectorFail("provider_temporary_failure");
      }
      const contentType = String(responseHeader(response, "content-type") || "")
        .split(";", 1)[0]
        .trim()
        .toLowerCase();
      if (contentType !== "application/json") {
        if (request.mutation && response.status >= 500) {
          throw new AmbiguousProviderMutation();
        }
        connectorFail("provider_result_unknown");
      }
      bytes = await responseBytes(response);
      const decoded = parseJsonRecord(bytes);
      if (response.status !== 200) {
        if (
          request.mutation &&
          (response.status === 408 || response.status === 429 ||
            response.status >= 500)
        ) {
          throw new AmbiguousProviderMutation();
        }
        if ([408, 429].includes(response.status) || response.status >= 500) {
          connectorFail("provider_temporary_failure");
        }
        classifyRejectedResponse(response.status, decoded);
      }
      return decoded;
    } catch (error) {
      if (
        error instanceof AmbiguousProviderMutation ||
        error instanceof SocialConnectorError
      ) {
        throw error;
      }
      if (request.mutation) throw new AmbiguousProviderMutation();
      connectorFail("provider_temporary_failure");
    } finally {
      if (timer !== undefined) clearTimer(timer);
      if (bytes) bytes.fill(0);
      response = null;
    }
  }

  async function withConnectionCredential(context, connectionId, operation, bound = null) {
    const scoped = store.scope(context);
    if ((context.environment === "production" || config.publicationBindingRequired === true) && !bound) {
      connectorFail("publication_binding_invalid");
    }
    const snapshot = bound
      ? await scoped.verifyPublicationExecutionBinding(bound.publicationId, bound.binding)
      : null;
    const connection = requireConnection(
      snapshot ? snapshot.connection : await scoped.getConnectionDetails(connectionId),
      context,
      authorizeConnection
    );
    if (connection.id !== connectionId) connectorFail("resource_unavailable");
    return credentials.withDecryptedCredential({
      companyId: context.companyId,
      credentialId: connection.activeCredentialId
    }, async (accessToken) => operation(connection, requireToken(accessToken), snapshot?.publication || null));
  }

  async function claimStage(context, source, connection, stage, containerId) {
    if (!source.binding) return null;
    const reservation = await store.scope(context).claimPublicationStage({
      publicationId: source.publicationId, binding: source.binding, stage,
      ...(containerId ? { containerId } : {})
    });
    if (!reservation?.acquired) connectorFail("provider_result_unknown");
    // Never use a token captured for a different credential generation. Account
    // writers share the claim lock; compliance can revoke future claims.
    if (reservation.connection.activeCredentialId !== connection.activeCredentialId) {
      connectorFail("publication_binding_conflict");
    }
    return reservation;
  }

  async function getContainerStatus(accessToken, containerId) {
    const result = await requestJson(accessToken, {
      method: "GET",
      mutation: false,
      url: graphUrl(`/${numericMediaId(containerId)}`, {
        fields: "status_code,status"
      })
    });
    const statusCode = String(result.status_code || "").toUpperCase();
    if (!SAFE_STATUS_CODES.has(statusCode)) return "IN_PROGRESS";
    return statusCode;
  }

  async function getMedia(accessToken, mediaId) {
    const id = numericMediaId(mediaId);
    const result = await requestJson(accessToken, {
      method: "GET",
      mutation: false,
      url: graphUrl(`/${id}`, { fields: "id,permalink,timestamp" })
    });
    const publishedAtMs = new Date(result.timestamp).getTime();
    if (!Number.isFinite(publishedAtMs)) {
      connectorFail("provider_result_unknown");
    }
    const returnedId = numericMediaId(result.id);
    if (returnedId !== id) connectorFail("provider_result_unknown");
    return Object.freeze({
      mediaId: returnedId,
      permalink: canonicalPermalink(result.permalink),
      publishedAtMs
    });
  }

  async function findPublishedByCaption(
    accessToken,
    connection,
    publication
  ) {
    let result;
    try {
      result = await requestJson(accessToken, {
        method: "GET",
        mutation: false,
        url: graphUrl(`/${numericMediaId(connection.account.externalId)}/media`, {
          fields: "id,caption,permalink,timestamp",
          limit: "25"
        })
      });
    } catch (error) {
      rethrowDefinitiveProviderError(error);
      return null;
    }
    if (!Array.isArray(result.data) || result.data.length > 25) return null;
    const observedAtMs = Number(clock());
    if (!Number.isFinite(observedAtMs)) return null;
    const earliest = publication.createdAt.getTime() - reconciliationLookbackMs;
    const latest = observedAtMs + 5 * 60 * 1000;
    const matches = [];
    for (const item of result.data) {
      if (
        !item ||
        typeof item !== "object" ||
        item.caption !== publication.caption ||
        typeof item.timestamp !== "string"
      ) {
        continue;
      }
      const timestamp = new Date(item.timestamp).getTime();
      if (
        !Number.isFinite(timestamp) ||
        timestamp < earliest ||
        timestamp > latest
      ) {
        continue;
      }
      try {
        const candidate = Object.freeze({
          caption: item.caption,
          mediaId: numericMediaId(item.id),
          permalink: canonicalPermalink(item.permalink),
          publishedAtMs: timestamp
        });
        let authorized = false;
        try {
          authorized = authorizePublishedCandidate(Object.freeze({
            connection,
            publication,
            candidate
          })) === true;
        } catch {
          authorized = false;
        }
        if (authorized) matches.push(candidate);
      } catch {
        // A malformed candidate cannot confirm an external publication.
      }
    }
    return matches.length === 1 ? matches[0] : null;
  }

  async function publishImage(rawContext, input = {}) {
    const context = trustedContext(rawContext);
    const source = strictObject(input, [
      "publicationId",
      "connectionId",
      "image",
      "caption",
      "idempotencyKey", "binding"
    ]);
    const image = strictObject(source.image, ["mediaId", "mimeType"]);
    const publicationId = requireUuid(source.publicationId);
    const connectionId = requireUuid(source.connectionId);
    const bound = source.binding ? { publicationId, binding: normalizeConnectionBinding(source.binding) } : null;
    requireUuid(source.idempotencyKey);
    if (
      image.mimeType !== "image/jpeg" ||
      !(source.caption === null || (
        typeof source.caption === "string" &&
        source.caption.length <= 2200 &&
        !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(source.caption)
      )) ||
      authorizePublicationRequest(Object.freeze({
        image: Object.freeze({ ...image }),
        caption: source.caption
      })) !== true
    ) {
      connectorFail("connector_contract_invalid");
    }
    return withConnectionCredential(
      context,
      connectionId,
      async (connection, accessToken, publicationSnapshot) => {
        const owned = await media.resolveOwnedJpeg(context, image.mediaId);
        if (
          !owned ||
          typeof owned !== "object" ||
          owned.companyId !== context.companyId ||
          owned.mediaId !== image.mediaId ||
          owned.mimeType !== "image/jpeg" ||
          typeof owned.publicUrl !== "string" ||
          !owned.publicUrl.startsWith(`${config.publicOrigin}/`)
        ) {
          connectorFail("resource_unavailable");
        }
        if (bound && (publicationSnapshot.mediaReference !== image.mediaId ||
            publicationSnapshot.caption !== source.caption ||
            publicationSnapshot.idempotencyKey !== source.idempotencyKey ||
            publicationSnapshot.mediaMetadataDigest !== owned.metadataDigest)) {
          connectorFail("publication_intent_conflict");
        }
        if (authorizePublication(Object.freeze({
          context,
          connection,
          image: Object.freeze({ ...image }),
          caption: source.caption,
          owned
        })) !== true) {
          connectorFail("resource_unavailable");
        }
        const body = new URLSearchParams();
        body.set("image_url", owned.publicUrl);
        body.set("caption", source.caption);
        const createClaim = await claimStage(context, source, connection, "create_container");
        let containerId;
        try {
          const created = await requestJson(accessToken, {
            method: "POST",
            mutation: true,
            url: graphUrl(`/${connection.account.externalId}/media`),
            body: body.toString()
          });
          containerId = numericMediaId(created.id);
        } catch (error) {
          if (error instanceof AmbiguousProviderMutation ||
              error?.code === "provider_result_unknown") {
            return Object.freeze({
              outcome: "provider_confirming",
              reconciliationReference: operationReference(publicationId)
            });
          }
          throw error;
        }
        if (createClaim) {
          await store.scope(context).recordPublicationStageReference({ publicationId,
            expectedReference: createClaim.reference, containerId });
        }
        let ready = false;
        for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
          let status;
          try {
            status = await getContainerStatus(accessToken, containerId);
          } catch {
            return Object.freeze({
              outcome: "provider_confirming",
              reconciliationReference: containerReference(
                "created",
                containerId
              )
            });
          }
          if (status === "PUBLISHED") {
            const publication = await store.scope(context)
              .getPublicationDetails(publicationId);
            const alreadyPublished = publication
              ? await findPublishedByCaption(
                accessToken,
                connection,
                publication
              )
              : null;
            if (alreadyPublished) {
              return Object.freeze({
                outcome: "published",
                confirmedProviderReference: confirmedReference(
                  alreadyPublished.mediaId,
                  alreadyPublished.permalink,
                  () => alreadyPublished.publishedAtMs
                )
              });
            }
            return Object.freeze({
              outcome: "provider_confirming",
              reconciliationReference: containerReference(
                "submitted",
                containerId
              )
            });
          }
          if (status === "FINISHED") {
            ready = true;
            break;
          }
          if (["ERROR", "EXPIRED"].includes(status)) {
            return Object.freeze({ outcome: "failed_permanent" });
          }
          if (attempt + 1 < pollAttempts) await sleep(pollIntervalMs);
        }
        if (!ready) {
          return Object.freeze({
            outcome: "provider_confirming",
            reconciliationReference: containerReference("created", containerId)
          });
        }
        const publishBody = new URLSearchParams();
        publishBody.set("creation_id", containerId);
        await claimStage(context, source, connection, "publish_container", containerId);
        let mediaId;
        try {
          const published = await requestJson(accessToken, {
            method: "POST",
            mutation: true,
            url: graphUrl(`/${connection.account.externalId}/media_publish`),
            body: publishBody.toString()
          });
          mediaId = numericMediaId(published.id);
        } catch (error) {
          if (error instanceof AmbiguousProviderMutation ||
              error?.code === "provider_result_unknown") {
            return Object.freeze({
              outcome: "provider_confirming",
              reconciliationReference: containerReference(
                "submitted",
                containerId
              )
            });
          }
          throw error;
        }
        try {
          const mediaRecord = await getMedia(accessToken, mediaId);
          return Object.freeze({
            outcome: "published",
            confirmedProviderReference: confirmedReference(
              mediaRecord.mediaId,
              mediaRecord.permalink,
              () => mediaRecord.publishedAtMs
            )
          });
        } catch {
          return Object.freeze({
            outcome: "provider_confirming",
            reconciliationReference: knownMediaReference(mediaId)
          });
        }
      }, bound
    );
  }

  async function getPublicationStatus(rawContext, input = {}) {
    const context = trustedContext(rawContext);
    const source = strictObject(input, [
      "publicationId",
      "providerReference",
      "idempotencyKey", "binding"
    ]);
    const publicationId = requireUuid(source.publicationId);
    const bound = source.binding ? { publicationId, binding: normalizeConnectionBinding(source.binding) } : null;
    if ((context.environment === "production" || config.publicationBindingRequired === true) && !bound) {
      connectorFail("publication_binding_invalid");
    }
    requireUuid(source.idempotencyKey);
    const providerReference = safeReference(source.providerReference);
    const publication = await store.scope(context).getPublicationDetails(
      publicationId
    );
    if (
      !publication ||
      publication.reconciliationReference !== providerReference ||
      publication.state !== "provider_confirming"
    ) {
      connectorFail("resource_unavailable");
    }
    if (
      /^igo:[0-9a-f]{32}$/.test(providerReference) &&
      !allowOperationReferenceReconciliation
    ) {
      return Object.freeze({
        outcome: "provider_confirming",
        reconciliationReference: providerReference
      });
    }
    return withConnectionCredential(
      context,
      publication.connectionId,
      async (connection, accessToken) => {
        let confirmed = null;
        const known = providerReference.match(/^igm:known:([0-9]{5,64})$/);
        if (known) {
          try {
            confirmed = await getMedia(accessToken, known[1]);
          } catch (error) {
            rethrowDefinitiveProviderError(error);
            confirmed = null;
          }
        } else {
          const container = providerReference.match(
            /^igc:(created|armed|submitted):([0-9]{5,64})$/
          );
          if (container?.[1] === "created") {
            try {
              const status = await getContainerStatus(accessToken, container[2]);
              if (["ERROR", "EXPIRED"].includes(status)) {
                return Object.freeze({ outcome: "failed_permanent" });
              }
              if (status === "PUBLISHED") {
                confirmed = await findPublishedByCaption(
                  accessToken,
                  connection,
                  publication
                );
                if (!confirmed) {
                  return Object.freeze({
                    outcome: "provider_confirming",
                    reconciliationReference: containerReference(
                      "submitted",
                      container[2]
                    )
                  });
                }
              } else if (status === "FINISHED") {
                return Object.freeze({
                  outcome: "provider_confirming",
                  reconciliationReference: containerReference(
                    "armed",
                    container[2]
                  )
                });
              }
            } catch (error) {
              rethrowDefinitiveProviderError(error);
              confirmed = null;
            }
          } else if (container?.[1] === "armed") {
            const publishBody = new URLSearchParams();
            publishBody.set("creation_id", container[2]);
            await claimStage(context, source, connection, "publish_container", container[2]);
            let mediaId;
            try {
              const published = await requestJson(accessToken, {
                method: "POST",
                mutation: true,
                url: graphUrl(
                  `/${connection.account.externalId}/media_publish`
                ),
                body: publishBody.toString()
              });
              mediaId = numericMediaId(published.id);
            } catch (error) {
              if (error instanceof AmbiguousProviderMutation ||
                  error?.code === "provider_result_unknown") {
                return Object.freeze({
                  outcome: "provider_confirming",
                  reconciliationReference: containerReference(
                    "submitted",
                    container[2]
                  )
                });
              }
              throw error;
            }
            try {
              confirmed = await getMedia(accessToken, mediaId);
            } catch {
              return Object.freeze({
                outcome: "provider_confirming",
                reconciliationReference: knownMediaReference(mediaId)
              });
            }
          } else if (container?.[1] === "submitted" ||
                     (allowOperationReferenceReconciliation &&
                      /^igo:[0-9a-f]{32}$/.test(providerReference))) {
            confirmed = await findPublishedByCaption(
              accessToken,
              connection,
              publication
            );
          } else {
            connectorFail("resource_unavailable");
          }
        }
        if (!confirmed) {
          return Object.freeze({
            outcome: "provider_confirming",
            reconciliationReference: providerReference
          });
        }
        return Object.freeze({
          outcome: "published",
          confirmedProviderReference: confirmedReference(
            confirmed.mediaId,
            confirmed.permalink,
            () => confirmed.publishedAtMs
          )
        });
      }, bound
    );
  }

  return Object.freeze({
    provider: INSTAGRAM_PROVIDER,
    capabilities: Object.freeze([
      "publishImage",
      "getPublicationStatus"
    ]),
    external: true,
    synthetic: false,
    testOnly: false,
    getPublicationStatus,
    publishImage
  });
}

module.exports = {
  AmbiguousProviderMutation,
  INSTAGRAM_GATE4_CAPTION,
  INSTAGRAM_PUBLICATION_POLL_ATTEMPTS,
  INSTAGRAM_PUBLICATION_POLL_INTERVAL_MS,
  INSTAGRAM_PUBLICATION_TIMEOUT_MS,
  canonicalPermalink,
  confirmedReference,
  createInstagramPublicationConnector,
  parseConfirmedReference
};
