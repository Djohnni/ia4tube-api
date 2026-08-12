"use strict";

const crypto = require("node:crypto");
const { postgresFail } = require("../../persistence/postgres/errors");
const {
  assertNoAuthorityFields,
  createConnectorContext,
  requireConnectorContext,
  requireUuid
} = require("../connectors/contract");
const {
  INSTAGRAM_OAUTH_REDIRECT_URI,
  INSTAGRAM_PROVIDER
} = require("./instagram-config");

const INSTAGRAM_OAUTH_RETURN_PATH_ID = "social_connections";
const INSTAGRAM_OAUTH_CREDENTIAL_TYPE = "instagram_user_access_token";
const CALLBACK_ERROR_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const PURPOSES = new Set(["connect", "reconnect"]);

function oauthFail(code) {
  postgresFail(code, "Operacao OAuth Instagram recusada.");
}

function strictRecord(value, expectedKeys) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    oauthFail("social_oauth_callback_invalid");
  }
  const keys = Object.keys(value);
  if (
    keys.length !== expectedKeys.length ||
    expectedKeys.some((key) => !Object.hasOwn(value, key))
  ) {
    oauthFail("social_oauth_callback_invalid");
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set) {
      oauthFail("social_oauth_callback_invalid");
    }
  }
  return value;
}

function requirePurpose(value) {
  if (!PURPOSES.has(value)) oauthFail("social_oauth_callback_invalid");
  return value;
}

function requireCallbackError(value) {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    !CALLBACK_ERROR_PATTERN.test(value)
  ) {
    oauthFail("social_oauth_callback_invalid");
  }
  return value;
}

function requireCode(value) {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length < 1 ||
    value.length > 2048 ||
    /[\u0000-\u0020\u007f]/.test(value)
  ) {
    oauthFail("social_oauth_callback_invalid");
  }
  return value;
}

function requireRevision(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    oauthFail("social_oauth_state_binding_mismatch");
  }
  return parsed;
}

function requireClock(clock) {
  const now = typeof clock === "function" ? clock : clock?.now;
  if (typeof now !== "function") oauthFail("social_oauth_callback_invalid");
  return () => {
    const value = now.call(clock);
    const milliseconds = value instanceof Date ? value.getTime() : value;
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
      oauthFail("social_oauth_callback_invalid");
    }
    return milliseconds;
  };
}

function requireDependencies(options) {
  const required = [
    [options.config, "enabled"],
    [options.stateEnvelope, "seal"],
    [options.stateEnvelope, "open"],
    [options.stateEnvelope, "openForCallback"],
    [options.provider, "buildAuthorizationUrl"],
    [options.provider, "exchangeCode"],
    [options.oauthRepository, "scope"],
    [options.credentials, "withEncryptedConnectionCredential"],
    [options.authAdapter, "fromVerifiedJwt"],
    [options.authAdapter, "fromAuthenticatedOAuthState"]
  ];
  if (
    options.config?.enabled !== true ||
    options.config?.provider !== INSTAGRAM_PROVIDER ||
    options.config?.redirectUri !== INSTAGRAM_OAUTH_REDIRECT_URI ||
    required.some(([owner, method]) =>
      method === "enabled"
        ? !owner
        : typeof owner?.[method] !== "function"
    )
  ) {
    oauthFail("social_instagram_configuration_invalid");
  }
}

function requireOAuthScope(value) {
  const methods = [
    "createAuthorizationWithPendingConnection",
    "consumeAuthorization",
    "cancelAuthorization",
    "expireAuthorization",
    "failAuthorizationConnection",
    "storeConsumedAuthorizationCredential"
  ];
  if (!value || methods.some((method) => typeof value[method] !== "function")) {
    oauthFail("social_instagram_configuration_invalid");
  }
  return value;
}

function persistenceFailure(error, expired = false) {
  if (expired) oauthFail("social_oauth_state_expired");
  if (error?.code === "social_oauth_state_already_consumed") {
    oauthFail("social_oauth_state_already_consumed");
  }
  if (error?.code === "authorization_cancelled") {
    oauthFail("social_oauth_state_cancelled");
  }
  oauthFail("social_oauth_state_binding_mismatch");
}

function createInstagramOAuthService(options = {}) {
  requireDependencies(options);
  const now = requireClock(options.clock || Date.now);
  const randomUuid = options.randomUUID || crypto.randomUUID;
  if (typeof randomUuid !== "function") {
    oauthFail("social_instagram_configuration_invalid");
  }
  const environment = ["test", "staging", "production"].includes(
    options.environment
  )
    ? options.environment
    : "production";

  function contextFor(principal) {
    return createConnectorContext({
      principal,
      provider: INSTAGRAM_PROVIDER,
      environment,
      correlationId: randomUuid(),
      auditEventId: randomUuid()
    });
  }

  async function authorize(input = {}) {
    const source = strictRecord(input, ["verifiedClaims", "purpose"]);
    assertNoAuthorityFields({ purpose: source.purpose });
    const purpose = requirePurpose(source.purpose);
    const principal = options.authAdapter.fromVerifiedJwt(
      source.verifiedClaims
    );
    const context = contextFor(principal);
    const authorizationHandle = randomUuid();
    const connectionId = randomUuid();
    const state = options.stateEnvelope.seal({
      purpose,
      companyId: context.companyId,
      userId: context.userId,
      sessionJti: principal.jti,
      authorizationHandle,
      returnPathId: INSTAGRAM_OAUTH_RETURN_PATH_ID
    });
    const authenticatedState = options.stateEnvelope.open(state);
    const authorizationUrl = options.provider.buildAuthorizationUrl({ state });
    const oauth = requireOAuthScope(options.oauthRepository.scope(context));
    let created;
    try {
      created = await oauth.createAuthorizationWithPendingConnection({
        authorizationHandle,
        connectionId,
        purpose,
        state,
        redirectUri: INSTAGRAM_OAUTH_REDIRECT_URI,
        sessionJti: principal.jti,
        expiresAt: new Date(authenticatedState.expiresAt)
      });
    } catch (error) {
      if (
        ["active_connection_exists", "idempotency_conflict"].includes(
          error?.code
        )
      ) {
        throw error;
      }
      persistenceFailure(error);
    }
    let persistedConnectionId;
    try {
      persistedConnectionId = requireUuid(created?.connectionId);
    } catch {
      oauthFail("social_oauth_state_binding_mismatch");
    }
    if (
      created?.authorizationHandle !== authorizationHandle ||
      (purpose === "connect" && persistedConnectionId !== connectionId) ||
      created?.purpose !== purpose ||
      created?.status !== "pending" ||
      !Number.isSafeInteger(Number(created?.revision)) ||
      Number(created.revision) < 1
    ) {
      oauthFail("social_oauth_state_binding_mismatch");
    }
    return Object.freeze({
      ok: true,
      provider: INSTAGRAM_PROVIDER,
      status: "authorization_pending",
      authorizationUrl,
      returnPathId: INSTAGRAM_OAUTH_RETURN_PATH_ID
    });
  }

  async function failConnection(
    oauth,
    input,
    terminalStatus,
    fallbackCode
  ) {
    try {
      await oauth.failAuthorizationConnection({
        authorizationHandle: input.authorizationHandle,
        connectionId: input.connectionId,
        purpose: input.purpose,
        expectedRevision: requireRevision(input.connectionRevision),
        terminalStatus,
        failureCode: terminalStatus === "cancelled"
          ? "authorization_cancelled"
          : terminalStatus === "expired"
            ? "authorization_expired"
            : "provider_result_unknown"
      });
    } catch {
      oauthFail(fallbackCode);
    }
  }

  async function callback(input = {}) {
    const source = strictRecord(input, ["state", "code", "error"]);
    if (
      Number(source.code !== null) + Number(source.error !== null) !== 1
    ) {
      oauthFail("social_oauth_callback_invalid");
    }
    if (source.code !== null) requireCode(source.code);
    if (source.error !== null) requireCallbackError(source.error);
    const payload = options.stateEnvelope.openForCallback(source.state);
    const principal = options.authAdapter.fromAuthenticatedOAuthState(payload);
    const context = requireConnectorContext(contextFor(principal), {
      provider: INSTAGRAM_PROVIDER,
      environment
    });
    const oauth = requireOAuthScope(options.oauthRepository.scope(context));
    const terminal = Object.freeze({
      authorizationHandle: payload.authorizationHandle,
      state: source.state,
      redirectUri: INSTAGRAM_OAUTH_REDIRECT_URI,
      sessionJti: payload.sessionJti,
      purpose: payload.purpose
    });

    const callbackNow = now();
    const observedAt = new Date(callbackNow);
    if (payload.expiresAt <= callbackNow) {
      let expired;
      try {
        expired = await oauth.expireAuthorization({
          ...terminal,
          observedAt
        });
      } catch (error) {
        persistenceFailure(error, true);
      }
      await failConnection(oauth, {
        ...payload,
        connectionId: expired.connectionId,
        connectionRevision: requireRevision(expired.connectionRevision)
      }, "expired", "social_oauth_state_binding_mismatch");
      oauthFail("social_oauth_state_expired");
    }

    if (source.error !== null) {
      let cancelled;
      try {
        cancelled = await oauth.cancelAuthorization({
          ...terminal,
          observedAt
        });
      } catch (error) {
        persistenceFailure(error);
      }
      await failConnection(oauth, {
        ...payload,
        connectionId: cancelled.connectionId,
        connectionRevision: requireRevision(cancelled.connectionRevision)
      }, "cancelled", "social_oauth_state_binding_mismatch");
      oauthFail("social_oauth_state_cancelled");
    }

    let consumed;
    try {
      consumed = await oauth.consumeAuthorization({
        ...terminal,
        observedAt
      });
    } catch (error) {
      persistenceFailure(error);
    }

    let token;
    try {
      const exchanged = await options.provider.exchangeCode({
        code: source.code
      });
      if (!Buffer.isBuffer(exchanged?.accessToken)) {
        oauthFail("social_oauth_exchange_failed");
      }
      token = exchanged.accessToken;
      await options.credentials.withEncryptedConnectionCredential({
        companyId: context.companyId,
        connectionId: consumed.connectionId,
        credentialId: payload.authorizationHandle,
        provider: INSTAGRAM_PROVIDER,
        credentialType: INSTAGRAM_OAUTH_CREDENTIAL_TYPE,
        plaintext: token,
        expiresAt: null
      }, (credentialEnvelope) =>
        oauth.storeConsumedAuthorizationCredential({
          authorizationHandle: payload.authorizationHandle,
          connectionId: consumed.connectionId,
          purpose: payload.purpose,
          expectedRevision: requireRevision(consumed.connectionRevision)
        }, credentialEnvelope)
      );
    } catch (error) {
      await failConnection(oauth, {
        ...payload,
        connectionId: consumed.connectionId,
        connectionRevision: requireRevision(consumed.connectionRevision)
      }, "consumed", "social_oauth_exchange_failed");
      if (error?.code === "social_oauth_exchange_failed") throw error;
      oauthFail("social_oauth_exchange_failed");
    } finally {
      if (Buffer.isBuffer(token)) token.fill(0);
    }

    return Object.freeze({
      ok: true,
      provider: INSTAGRAM_PROVIDER,
      status: "authorization_completed",
      returnPathId: payload.returnPathId
    });
  }

  return Object.freeze({ authorize, callback });
}

module.exports = {
  INSTAGRAM_OAUTH_CREDENTIAL_TYPE,
  INSTAGRAM_OAUTH_RETURN_PATH_ID,
  createInstagramOAuthService
};
