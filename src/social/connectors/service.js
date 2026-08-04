"use strict";

const crypto = require("node:crypto");
const {
  assertNoAuthorityFields,
  requireConnectorContext,
  requireUuid
} = require("./contract");
const {
  SocialConnectorError,
  connectorFail,
  normalizeConnectorError
} = require("./errors");
const {
  CONNECTION_STATES,
  PUBLICATION_STATES,
  assertPublicationConfirmation,
  transitionConnectionState,
  transitionPublicationState
} = require("./states");

const PROFESSIONAL_ACCOUNT_TYPES = new Set(["business", "creator"]);
const BLOCKING_CONNECTION_STATES = new Set([
  "authorization_pending",
  "connected",
  "reconnect_required",
  "disconnecting",
  "failed"
]);
const REQUIRED_SCOPE_METHODS = Object.freeze([
  "getConnection",
  "findBlockingConnection",
  "saveConnection",
  "activateConnectionFromAuthorization",
  "ensureDisconnected",
  "getPublication",
  "savePublication",
  "beginIdempotency",
  "completeIdempotency",
  "runExclusive"
]);

function strictObject(value, allowedKeys) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    connectorFail("connector_contract_invalid");
  }
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) {
      connectorFail("connector_contract_invalid");
    }
  }
  return value;
}

function operationUuid(value) {
  try {
    return requireUuid(value);
  } catch {
    connectorFail("connector_contract_invalid");
  }
}

function safeText(value, { max = 500, optional = false } = {}) {
  if (optional && (value === undefined || value === null)) return null;
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length < 1 ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    connectorFail("connector_contract_invalid");
  }
  return value;
}

function safeCaption(value) {
  if (value === undefined || value === null || value === "") return null;
  if (
    typeof value !== "string" ||
    value.length > 2200 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  ) {
    connectorFail("connector_contract_invalid");
  }
  return value;
}

function canonicalize(value) {
  if (value === null || ["string", "boolean"].includes(typeof value)) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    connectorFail("connector_contract_invalid");
  }
  const output = {};
  for (const key of Object.keys(value).sort()) {
    output[key] = canonicalize(value[key]);
  }
  return output;
}

function inputDigest(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalize(value)), "utf8")
    .digest("hex");
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function deepFreeze(value, visited = new Set()) {
  if (!value || typeof value !== "object" || visited.has(value)) return value;
  visited.add(value);
  for (const item of Object.values(value)) deepFreeze(item, visited);
  return Object.freeze(value);
}

function requireStoreScope(scope) {
  if (!scope || typeof scope !== "object") {
    connectorFail("connector_contract_invalid");
  }
  for (const method of REQUIRED_SCOPE_METHODS) {
    if (typeof scope[method] !== "function") {
      connectorFail("connector_contract_invalid");
    }
  }
  return scope;
}

function assertConnection(context, record) {
  if (
    !record ||
    typeof record !== "object" ||
    record.companyId !== context.companyId ||
    record.provider !== context.provider ||
    !CONNECTION_STATES.includes(record.state) ||
    !Number.isSafeInteger(record.revision) ||
    record.revision < 1
  ) {
    connectorFail("resource_unavailable");
  }
  operationUuid(record.id);
  return record;
}

function assertPublication(context, record) {
  if (
    !record ||
    typeof record !== "object" ||
    record.companyId !== context.companyId ||
    record.provider !== context.provider ||
    !PUBLICATION_STATES.includes(record.state) ||
    !Number.isSafeInteger(record.revision) ||
    record.revision < 1
  ) {
    connectorFail("resource_unavailable");
  }
  operationUuid(record.id);
  operationUuid(record.connectionId);
  assertPublicationConfirmation(record);
  return record;
}

function normalizeProfessionalAccount(account) {
  const source = strictObject(account, [
    "externalId",
    "username",
    "displayName",
    "accountType"
  ]);
  const normalized = Object.freeze({
    externalId: safeText(source.externalId, { max: 500 }),
    username: safeText(source.username, { max: 200 }),
    displayName: safeText(source.displayName, {
      max: 300,
      optional: true
    }),
    accountType: safeText(source.accountType, { max: 20 })
  });
  if (!PROFESSIONAL_ACCOUNT_TYPES.has(normalized.accountType)) {
    connectorFail("invalid_account_type");
  }
  return normalized;
}

function connectionView(record) {
  return deepFreeze({
    connectionId: record.id,
    provider: record.provider,
    state: record.state,
    account: record.account
      ? normalizeProfessionalAccount(record.account)
      : null,
    revision: record.revision
  });
}

function validateConnectionResult(context, value, includeAuthorization) {
  const keys = ["connectionId", "provider", "state", "account", "revision"];
  if (includeAuthorization) keys.push("authorizationHandle");
  const result = strictObject(value, keys);
  if (
    operationUuid(result.connectionId) !== result.connectionId ||
    result.provider !== context.provider ||
    !CONNECTION_STATES.includes(result.state) ||
    !Number.isSafeInteger(result.revision) ||
    result.revision < 1
  ) {
    connectorFail("connector_contract_invalid");
  }
  const normalized = {
    connectionId: result.connectionId,
    provider: result.provider,
    state: result.state,
    account: result.account
      ? normalizeProfessionalAccount(result.account)
      : null,
    revision: result.revision
  };
  if (includeAuthorization) {
    normalized.authorizationHandle = operationUuid(
      result.authorizationHandle
    );
  }
  return deepFreeze(normalized);
}

function validatePublicationResult(context, value) {
  const result = strictObject(value, [
    "publicationId",
    "connectionId",
    "provider",
    "state",
    "confirmedProviderReference",
    "reconciliationReference",
    "revision"
  ]);
  if (
    operationUuid(result.publicationId) !== result.publicationId ||
    operationUuid(result.connectionId) !== result.connectionId ||
    result.provider !== context.provider ||
    !PUBLICATION_STATES.includes(result.state) ||
    !Number.isSafeInteger(result.revision) ||
    result.revision < 1
  ) {
    connectorFail("connector_contract_invalid");
  }
  const normalized = {
    publicationId: result.publicationId,
    connectionId: result.connectionId,
    provider: result.provider,
    state: result.state,
    confirmedProviderReference:
      result.confirmedProviderReference === undefined ||
      result.confirmedProviderReference === null
        ? null
        : result.confirmedProviderReference,
    reconciliationReference:
      result.reconciliationReference === undefined ||
      result.reconciliationReference === null
        ? null
        : result.reconciliationReference,
    revision: result.revision
  };
  assertPublicationConfirmation({
    state: normalized.state,
    confirmedProviderReference: normalized.confirmedProviderReference,
    reconciliationReference: normalized.reconciliationReference
  });
  return deepFreeze(normalized);
}

function publicationView(record) {
  assertPublicationConfirmation(record);
  return deepFreeze({
    publicationId: record.id,
    connectionId: record.connectionId,
    provider: record.provider,
    state: record.state,
    confirmedProviderReference:
      record.confirmedProviderReference || null,
    reconciliationReference: record.reconciliationReference || null,
    revision: record.revision
  });
}

function createSocialConnectorService(options = {}) {
  const registry = options.registry;
  const store = options.store;
  const audit = options.audit;
  const media = options.media;
  const logger = options.logger;
  if (!registry || typeof registry.invoke !== "function") {
    connectorFail("connector_contract_invalid");
  }
  if (!store || typeof store.scope !== "function") {
    connectorFail("connector_contract_invalid");
  }
  if (!audit || typeof audit.append !== "function") {
    connectorFail("connector_contract_invalid");
  }
  if (!media || typeof media.resolveOwnedJpeg !== "function") {
    connectorFail("connector_contract_invalid");
  }

  function scopeFor(context) {
    return requireStoreScope(store.scope(context));
  }

  async function emit(
    context,
    action,
    outcome,
    detailsCode = null,
    references = {}
  ) {
    const event = Object.freeze({
      companyId: context.companyId,
      actorUserId: context.userId,
      provider: context.provider,
      auditEventId: context.auditEventId,
      correlationId: context.correlationId,
      connectionId: references.connectionId || null,
      publicationId: references.publicationId || null,
      action,
      outcome,
      detailsCode
    });
    await audit.append(context, event);
    if (logger && typeof logger.info === "function") {
      logger.info(Object.freeze({
        component: "social_connector",
        action,
        outcome,
        code: detailsCode,
        provider: context.provider,
        auditEventId: context.auditEventId,
        correlationId: context.correlationId
      }));
    }
  }

  async function runIdempotent(
    context,
    capability,
    operationId,
    payload,
    work,
    validateResult
  ) {
    if (typeof validateResult !== "function") {
      connectorFail("connector_contract_invalid");
    }
    const scope = scopeFor(context);
    const digestPayload = clone(payload);
    if (
      digestPayload &&
      typeof digestPayload === "object" &&
      !Array.isArray(digestPayload)
    ) {
      delete digestPayload.operationId;
    }
    const digest = inputDigest(digestPayload);
    const reservationInput = {
      capability,
      operationId,
      digest
    };
    if (capability === "publishImage") {
      reservationInput.payload = clone(payload);
    }
    const reservation = await scope.beginIdempotency(reservationInput);
    if (!reservation || typeof reservation !== "object") {
      connectorFail("connector_contract_invalid");
    }
    if (reservation.status === "completed") {
      if (reservation.errorCode) {
        throw new SocialConnectorError(reservation.errorCode);
      }
      return deepFreeze(clone(validateResult(clone(reservation.result))));
    }
    if (reservation.status === "pending") {
      connectorFail("provider_result_unknown");
    }
    if (reservation.status !== "acquired") {
      connectorFail("connector_contract_invalid");
    }
    try {
      const result = deepFreeze(clone(validateResult(await work(scope))));
      await scope.completeIdempotency({
        capability,
        operationId,
        digest,
        result: clone(result),
        errorCode: null
      });
      return result;
    } catch (error) {
      const normalized = normalizeConnectorError(error);
      await scope.completeIdempotency({
        capability,
        operationId,
        digest,
        result: null,
        errorCode: normalized.code
      });
      throw normalized;
    }
  }

  async function saveConnection(scope, context, record, previousRevision) {
    const saved = await scope.saveConnection(clone(record), previousRevision);
    return assertConnection(context, saved);
  }

  async function moveConnection(scope, context, record, nextState, patch = {}) {
    const next = {
      ...record,
      ...patch,
      state: transitionConnectionState(record.state, nextState),
      revision: record.revision + 1
    };
    return saveConnection(scope, context, next, record.revision);
  }

  async function savePublication(scope, context, record, previousRevision) {
    assertPublicationConfirmation(record);
    const saved = await scope.savePublication(clone(record), previousRevision);
    return assertPublication(context, saved);
  }

  async function movePublication(scope, context, record, nextState, patch = {}) {
    const next = {
      ...record,
      ...patch,
      state: transitionPublicationState(record.state, nextState),
      revision: record.revision + 1
    };
    return savePublication(scope, context, next, record.revision);
  }

  async function beginAuthorization(context, input = {}) {
    const trusted = requireConnectorContext(context);
    assertNoAuthorityFields(input);
    strictObject(input, ["operationId", "connectionId"]);
    const operationId = operationUuid(input.operationId);
    const connectionId = operationUuid(input.connectionId);
    try {
      const result = await runIdempotent(
        trusted,
        "beginAuthorization",
        operationId,
        { connectionId },
        async (scope) => {
          let connection = await scope.runExclusive(async (transactionScope) => {
            const exclusive = requireStoreScope(transactionScope);
            let reserved = await exclusive.getConnection(connectionId);
            if (reserved) {
              reserved = assertConnection(trusted, reserved);
            } else {
              const blocking = await exclusive.findBlockingConnection(
                trusted.provider,
                connectionId
              );
              if (blocking) connectorFail("active_connection_exists");
              reserved = await saveConnection(exclusive, trusted, {
                companyId: trusted.companyId,
                id: connectionId,
                provider: trusted.provider,
                state: "disconnected",
                account: null,
                revision: 1
              }, null);
            }
            const blocking = await exclusive.findBlockingConnection(
              trusted.provider,
              connectionId
            );
            if (
              blocking ||
              !["disconnected", "failed", "reconnect_required"].includes(
                reserved.state
              )
            ) {
              connectorFail("active_connection_exists");
            }
            return moveConnection(
              exclusive,
              trusted,
              reserved,
              "authorization_pending",
              { account: reserved.account || null }
            );
          });
          try {
            const providerResult = strictObject(
              await registry.invoke(trusted, "beginAuthorization", {
                connectionId,
                idempotencyKey: operationId
              }),
              ["state", "authorizationHandle"]
            );
            if (providerResult.state !== "authorization_pending") {
              connectorFail("provider_result_unknown");
            }
            return Object.freeze({
              ...connectionView(connection),
              authorizationHandle: operationUuid(
                providerResult.authorizationHandle
              )
            });
          } catch (error) {
            await moveConnection(scope, trusted, connection, "failed");
            throw error;
          }
        },
        (value) => validateConnectionResult(trusted, value, true)
      );
      await emit(trusted, "social.authorization.begin", "succeeded", null, {
        connectionId
      });
      return result;
    } catch (error) {
      const normalized = normalizeConnectorError(error);
      await emit(
        trusted,
        "social.authorization.begin",
        "failed",
        normalized.code,
        { connectionId }
      );
      throw normalized;
    }
  }

  async function discoverAccount(context, input = {}) {
    const trusted = requireConnectorContext(context);
    assertNoAuthorityFields(input);
    strictObject(input, ["operationId", "connectionId", "authorizationHandle"]);
    const operationId = operationUuid(input.operationId);
    const connectionId = operationUuid(input.connectionId);
    const authorizationHandle = operationUuid(input.authorizationHandle);
    try {
      const result = await runIdempotent(
        trusted,
        "discoverAccount",
        operationId,
        { connectionId, authorizationHandle },
        async (scope) => {
          let connection = assertConnection(
            trusted,
            await scope.getConnection(connectionId)
          );
          if (connection.state !== "authorization_pending") {
            connectorFail("state_transition_invalid");
          }
          try {
            const providerResult = strictObject(
              await registry.invoke(trusted, "discoverAccount", {
                authorizationHandle,
                connectionId,
                idempotencyKey: operationId
              }),
              ["account"]
            );
            const normalizedAccount = normalizeProfessionalAccount(
              providerResult.account
            );
            connection = await scope.runExclusive(async (transactionScope) => {
              const exclusive = requireStoreScope(transactionScope);
              const current = assertConnection(
                trusted,
                await exclusive.getConnection(connectionId)
              );
              if (current.state !== "authorization_pending") {
                connectorFail("state_transition_invalid");
              }
              const blocking = await exclusive.findBlockingConnection(
                trusted.provider,
                connectionId
              );
              if (blocking) connectorFail("active_connection_exists");
              return assertConnection(
                trusted,
                await exclusive.activateConnectionFromAuthorization(
                  {
                    companyId: trusted.companyId,
                    id: current.id,
                    provider: trusted.provider,
                    state: "connected",
                    account: normalizedAccount,
                    revision: current.revision + 1
                  },
                  current.revision,
                  authorizationHandle
                )
              );
            });
            return connectionView(connection);
          } catch (error) {
            const normalized = normalizeConnectorError(error);
            const nextState = [
              "authorization_cancelled",
              "authorization_expired"
            ].includes(normalized.code)
              ? "disconnected"
              : "failed";
            await moveConnection(scope, trusted, connection, nextState);
            throw normalized;
          }
        },
        (value) => validateConnectionResult(trusted, value, false)
      );
      await emit(trusted, "social.account.discover", "succeeded", null, {
        connectionId
      });
      return result;
    } catch (error) {
      const normalized = normalizeConnectorError(error);
      await emit(
        trusted,
        "social.account.discover",
        "failed",
        normalized.code,
        { connectionId }
      );
      throw normalized;
    }
  }

  function publicationInput(input) {
    strictObject(input, [
      "operationId",
      "publicationId",
      "connectionId",
      "image",
      "caption"
    ]);
    const image = strictObject(input.image, ["mediaId", "mimeType"]);
    if (image.mimeType !== "image/jpeg") {
      connectorFail("connector_contract_invalid");
    }
    return Object.freeze({
      operationId: operationUuid(input.operationId),
      publicationId: operationUuid(input.publicationId),
      connectionId: operationUuid(input.connectionId),
      image: Object.freeze({
        mediaId: safeText(image.mediaId, { max: 200 }),
        mimeType: "image/jpeg"
      }),
      caption: safeCaption(input.caption)
    });
  }

  function providerPublicationResult(value) {
    const result = strictObject(value, [
      "outcome",
      "confirmedProviderReference",
      "reconciliationReference"
    ]);
    const outcome = result.outcome;
    if (![
      "published",
      "provider_confirming",
      "failed_temporary",
      "failed_permanent"
    ].includes(outcome)) {
      connectorFail("provider_result_unknown");
    }
    const allowed = outcome === "published"
      ? ["outcome", "confirmedProviderReference"]
      : outcome === "provider_confirming"
        ? ["outcome", "reconciliationReference"]
        : ["outcome"];
    strictObject(result, allowed);
    return Object.freeze({
      outcome,
      confirmedProviderReference:
        outcome === "published"
          ? safeText(result.confirmedProviderReference, { max: 500 })
          : null,
      reconciliationReference:
        outcome === "provider_confirming"
          ? safeText(result.reconciliationReference, { max: 500 })
          : null
    });
  }

  async function applyPublicationResult(scope, context, publication, result) {
    if (publication.state === "published") {
      if (
        result.outcome === "published" &&
        result.confirmedProviderReference !==
          publication.confirmedProviderReference
      ) {
        connectorFail("provider_result_unknown");
      }
      return publication;
    }
    if (result.outcome === "provider_confirming") {
      if (publication.state === "provider_confirming") {
        if (
          publication.reconciliationReference &&
          result.reconciliationReference !==
            publication.reconciliationReference
        ) {
          connectorFail("provider_result_unknown");
        }
        return publication;
      }
      return movePublication(
        scope,
        context,
        publication,
        "provider_confirming",
        { reconciliationReference: result.reconciliationReference }
      );
    }
    return movePublication(scope, context, publication, result.outcome, {
      confirmedProviderReference: result.confirmedProviderReference,
      reconciliationReference:
        result.outcome === "published"
          ? publication.reconciliationReference || null
          : null,
      errorCode:
        result.outcome === "failed_temporary"
          ? "provider_temporary_failure"
          : result.outcome === "failed_permanent"
            ? "provider_permanent_failure"
            : null
    });
  }

  async function publishImage(context, input = {}) {
    const trusted = requireConnectorContext(context);
    assertNoAuthorityFields(input);
    const clean = publicationInput(input);
    try {
      const ownedMedia = await media.resolveOwnedJpeg(
        trusted,
        clean.image.mediaId
      );
      if (
        !ownedMedia ||
        typeof ownedMedia !== "object" ||
        ownedMedia.companyId !== trusted.companyId ||
        ownedMedia.mediaId !== clean.image.mediaId ||
        ownedMedia.mimeType !== "image/jpeg"
      ) {
        connectorFail("resource_unavailable");
      }
      const result = await runIdempotent(
        trusted,
        "publishImage",
        clean.operationId,
        clean,
        async (scope) => {
          const connection = assertConnection(
            trusted,
            await scope.getConnection(clean.connectionId)
          );
          if (connection.state !== "connected") {
            connectorFail("credential_unavailable");
          }
          let publication = await scope.getPublication(clean.publicationId);
          if (publication) {
            publication = assertPublication(trusted, publication);
            if (publication.connectionId !== clean.connectionId) {
              connectorFail("resource_unavailable");
            }
            if (publication.state === "failed_temporary") {
              publication = await movePublication(
                scope,
                trusted,
                publication,
                "publishing",
                { errorCode: null }
              );
            } else if (publication.state !== "ready") {
              connectorFail("state_transition_invalid");
            }
          } else {
            publication = await savePublication(scope, trusted, {
              companyId: trusted.companyId,
              id: clean.publicationId,
              connectionId: clean.connectionId,
              provider: trusted.provider,
              state: "ready",
              confirmedProviderReference: null,
              reconciliationReference: null,
              revision: 1
            }, null);
          }
          if (publication.state === "ready") {
            publication = await movePublication(
              scope,
              trusted,
              publication,
              "publishing"
            );
          }
          try {
            const rawProviderResult = await registry.invoke(
              trusted,
              "publishImage",
              {
                publicationId: clean.publicationId,
                connectionId: clean.connectionId,
                image: Object.freeze({
                  mediaId: ownedMedia.mediaId,
                  mimeType: "image/jpeg"
                }),
                caption: clean.caption,
                idempotencyKey: clean.operationId
              }
            );
            let providerResult;
            try {
              providerResult = providerPublicationResult(rawProviderResult);
            } catch {
              connectorFail("provider_result_unknown");
            }
            publication = await applyPublicationResult(
              scope,
              trusted,
              publication,
              providerResult
            );
            return publicationView(publication);
          } catch (error) {
            const normalized = normalizeConnectorError(error);
            if (publication.state === "publishing") {
              const nextState = [
                "provider_permanent_failure",
                "permission_missing"
              ].includes(normalized.code)
                ? "failed_permanent"
                : normalized.code === "provider_result_unknown"
                  ? "provider_confirming"
                  : "failed_temporary";
              await movePublication(
                scope,
                trusted,
                publication,
                nextState,
                {
                  errorCode: nextState.startsWith("failed_")
                    ? normalized.code
                    : null
                }
              );
            }
            if ([
              "authorization_expired",
              "credential_unavailable",
              "permission_missing"
            ].includes(normalized.code)) {
              await moveConnection(
                scope,
                trusted,
                connection,
                "reconnect_required"
              );
            }
            throw normalized;
          }
        },
        (value) => validatePublicationResult(trusted, value)
      );
      await emit(trusted, "social.publication.publish", "succeeded", null, {
        connectionId: clean.connectionId,
        publicationId: clean.publicationId
      });
      return result;
    } catch (error) {
      const normalized = normalizeConnectorError(error);
      await emit(
        trusted,
        "social.publication.publish",
        "failed",
        normalized.code,
        {
          connectionId: clean.connectionId,
          publicationId: clean.publicationId
        }
      );
      throw normalized;
    }
  }

  async function getPublicationStatus(context, input = {}) {
    const trusted = requireConnectorContext(context);
    assertNoAuthorityFields(input);
    strictObject(input, [
      "operationId",
      "publicationId",
      "providerReference"
    ]);
    const clean = Object.freeze({
      operationId: operationUuid(input.operationId),
      publicationId: operationUuid(input.publicationId),
      providerReference: safeText(input.providerReference, { max: 500 })
    });
    try {
      const result = await runIdempotent(
        trusted,
        "getPublicationStatus",
        clean.operationId,
        clean,
        async (scope) => {
          let publication = assertPublication(
            trusted,
            await scope.getPublication(clean.publicationId)
          );
          if (
            !publication.reconciliationReference ||
            publication.reconciliationReference !== clean.providerReference
          ) {
            connectorFail("resource_unavailable");
          }
          if (!["provider_confirming", "published"].includes(publication.state)) {
            connectorFail("state_transition_invalid");
          }
          let providerResult;
          try {
            const rawProviderResult = await registry.invoke(
              trusted,
              "getPublicationStatus",
              {
                publicationId: clean.publicationId,
                providerReference: clean.providerReference,
                idempotencyKey: clean.operationId
              }
            );
            try {
              providerResult = providerPublicationResult(rawProviderResult);
            } catch {
              connectorFail("provider_result_unknown");
            }
          } catch (error) {
            const normalized = normalizeConnectorError(error);
            throw normalized;
          }
          publication = await applyPublicationResult(
            scope,
            trusted,
            publication,
            providerResult
          );
          return publicationView(publication);
        },
        (value) => validatePublicationResult(trusted, value)
      );
      await emit(trusted, "social.publication.reconcile", "succeeded", null, {
        publicationId: clean.publicationId
      });
      return result;
    } catch (error) {
      const normalized = normalizeConnectorError(error);
      await emit(
        trusted,
        "social.publication.reconcile",
        "failed",
        normalized.code,
        { publicationId: clean.publicationId }
      );
      throw normalized;
    }
  }

  async function disconnect(context, input = {}) {
    const trusted = requireConnectorContext(context);
    assertNoAuthorityFields(input);
    strictObject(input, ["operationId", "connectionId", "revoke"]);
    if (input.revoke !== undefined && typeof input.revoke !== "boolean") {
      connectorFail("connector_contract_invalid");
    }
    const clean = Object.freeze({
      operationId: operationUuid(input.operationId),
      connectionId: operationUuid(input.connectionId),
      revoke: input.revoke === true
    });
    try {
      const result = await runIdempotent(
        trusted,
        "disconnect",
        clean.operationId,
        clean,
        async (scope) => {
          let connection = assertConnection(
            trusted,
            await scope.getConnection(clean.connectionId)
          );
          if (connection.state === "disconnected") {
            connection = assertConnection(
              trusted,
              await scope.ensureDisconnected(clean.connectionId)
            );
            return connectionView(connection);
          }
          if (connection.state === "authorization_pending") {
            connection = await moveConnection(
              scope,
              trusted,
              connection,
              "disconnected",
              { account: null }
            );
            return connectionView(connection);
          }
          if (!["connected", "reconnect_required", "failed"].includes(connection.state)) {
            connectorFail("state_transition_invalid");
          }
          connection = await moveConnection(
            scope,
            trusted,
            connection,
            "disconnecting"
          );
          try {
            const providerResult = strictObject(
              await registry.invoke(trusted, "disconnect", {
                connectionId: clean.connectionId,
                revoke: clean.revoke,
                idempotencyKey: clean.operationId
              }),
              ["outcome"]
            );
            if (!["disconnected", "revoked"].includes(providerResult.outcome)) {
              connectorFail("disconnect_failed");
            }
            connection = await moveConnection(
              scope,
              trusted,
              connection,
              "disconnected",
              { account: null }
            );
            return connectionView(connection);
          } catch {
            await moveConnection(scope, trusted, connection, "failed");
            connectorFail("disconnect_failed");
          }
        },
        (value) => validateConnectionResult(trusted, value, false)
      );
      await emit(trusted, "social.connection.disconnect", "succeeded", null, {
        connectionId: clean.connectionId
      });
      return result;
    } catch (error) {
      const normalized = normalizeConnectorError(error);
      await emit(
        trusted,
        "social.connection.disconnect",
        "failed",
        normalized.code,
        { connectionId: clean.connectionId }
      );
      throw normalized;
    }
  }

  return Object.freeze({
    beginAuthorization,
    discoverAccount,
    disconnect,
    getPublicationStatus,
    publishImage
  });
}

module.exports = {
  BLOCKING_CONNECTION_STATES,
  PROFESSIONAL_ACCOUNT_TYPES,
  createSocialConnectorService,
  inputDigest
};
