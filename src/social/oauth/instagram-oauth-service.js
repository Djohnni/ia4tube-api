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
const {
  OAUTH_FAILURE_STAGES,
  classifyOAuthFailure
} = require("./instagram-oauth-failure");

const INSTAGRAM_OAUTH_RETURN_PATH_ID = "social_connections";
const INSTAGRAM_OAUTH_CREDENTIAL_TYPE = "instagram_user_access_token";
const CALLBACK_ERROR_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const INSTAGRAM_USERNAME_PATTERN = /^[a-zA-Z0-9._]{1,30}$/;
const PURPOSES = new Set(["connect", "reconnect"]);
const PROFESSIONAL_ACCOUNT_TYPES = new Set(["business", "creator"]);
const CONNECTION_STATES = new Set([
  "authorization_pending",
  "connected",
  "reconnect_required",
  "disconnecting",
  "disconnected",
  "failed"
]);
const CONNECTION_HEALTH = new Set([
  "healthy",
  "authorization_pending",
  "reconnect_required",
  "disconnecting",
  "disconnected",
  "failed"
]);
const AUTHORIZATION_STATUSES = new Set([
  "authorization_pending",
  "authorization_processing",
  "authorization_completed",
  "authorization_cancelled",
  "authorization_expired",
  "authorization_failed"
]);
const CALLBACK_FAILURE_CODES = new Set([
  "active_connection_exists",
  "controlled_account_mismatch",
  "invalid_account_type",
  "permission_missing",
  "provider_permanent_failure",
  "provider_result_unknown",
  "provider_temporary_failure",
  "social_oauth_exchange_failed"
]);

function coherentStateHealth(state, health) {
  return state === "connected"
    ? health === "healthy" || health === "reconnect_required"
    : health === state;
}

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

function requireConnectionId(value) {
  try {
    return requireUuid(value);
  } catch {
    oauthFail("resource_unavailable");
  }
}

function publicDate(value) {
  if (value === null || value === undefined) return null;
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    oauthFail("resource_unavailable");
  }
  return value.toISOString();
}

function publicConnection(value) {
  if (!value || typeof value !== "object") oauthFail("resource_unavailable");
  const connectionId = requireConnectionId(value.id);
  if (
    value.provider !== INSTAGRAM_PROVIDER ||
    !CONNECTION_STATES.has(value.state) ||
    !CONNECTION_HEALTH.has(value.health) ||
    !coherentStateHealth(value.state, value.health)
  ) {
    oauthFail("resource_unavailable");
  }
  let username = null;
  let accountType = null;
  if (value.account !== null && value.account !== undefined) {
    if (
      typeof value.account !== "object" ||
      typeof value.account.username !== "string" ||
      !INSTAGRAM_USERNAME_PATTERN.test(value.account.username) ||
      !PROFESSIONAL_ACCOUNT_TYPES.has(value.account.accountType)
    ) {
      oauthFail("resource_unavailable");
    }
    username = `@${value.account.username}`;
    accountType = value.account.accountType;
  }
  return Object.freeze({
    connectionId,
    provider: INSTAGRAM_PROVIDER,
    username,
    accountType,
    state: value.state,
    createdAt: publicDate(value.createdAt),
    connectedAt: publicDate(value.connectedAt),
    updatedAt: publicDate(value.updatedAt),
    disconnectedAt: publicDate(value.disconnectedAt),
    health: value.health
  });
}

function requireGrantedScopes(value, requiredScopes) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
    oauthFail("permission_missing");
  }
  const granted = new Set();
  for (const scope of value) {
    if (
      typeof scope !== "string" ||
      scope !== scope.trim() ||
      !/^[a-z][a-z0-9_]{1,99}$/.test(scope)
    ) {
      oauthFail("permission_missing");
    }
    granted.add(scope);
  }
  if (requiredScopes.some((scope) => !granted.has(scope))) {
    oauthFail("permission_missing");
  }
  return Object.freeze([...granted].sort());
}

function requireProfessionalAccount(value, expectedUsername) {
  const account = strictRecord(value, [
    "userId",
    "username",
    "name",
    "accountType"
  ]);
  if (
    typeof account.userId !== "string" ||
    account.userId.length < 1 ||
    account.userId.length > 500 ||
    typeof account.username !== "string" ||
    !INSTAGRAM_USERNAME_PATTERN.test(account.username) ||
    !PROFESSIONAL_ACCOUNT_TYPES.has(account.accountType) ||
    (account.name !== null &&
      (typeof account.name !== "string" || account.name.length > 300))
  ) {
    oauthFail("invalid_account_type");
  }
  if (
    expectedUsername !== null &&
    account.username.toLowerCase() !== expectedUsername.toLowerCase()
  ) {
    oauthFail("controlled_account_mismatch");
  }
  return Object.freeze({
    externalId: account.userId,
    username: account.username,
    displayName: account.name,
    accountType: account.accountType
  });
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
    [options.provider, "exchangeLongLivedToken"],
    [options.provider, "discoverProfessionalAccount"],
    [options.oauthRepository, "scope"],
    [options.connectorStore, "scope"],
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
    "getAuthorizationStatus"
  ];
  if (!value || methods.some((method) => typeof value[method] !== "function")) {
    oauthFail("social_instagram_configuration_invalid");
  }
  return value;
}

function requireConnectorStoreScope(value) {
  const methods = [
    "activateConnectionWithCredential",
    "disconnectConnectionLocally",
    "getConnectionDetails",
    "getCurrentConnectionDetails",
    "runExclusive"
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
  const expectedUsername = options.config.expectedUsername ?? null;
  if (
    expectedUsername !== null &&
    (typeof expectedUsername !== "string" ||
      !INSTAGRAM_USERNAME_PATTERN.test(expectedUsername))
  ) {
    oauthFail("social_instagram_configuration_invalid");
  }

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
      connectionId: persistedConnectionId,
      expiresAt: publicDate(created.expiresAt),
      authorizationUrl,
      returnPathId: INSTAGRAM_OAUTH_RETURN_PATH_ID
    });
  }

  async function failConnection(
    oauth,
    input,
    terminalStatus,
    fallbackCode,
    consumedFailureCode = null
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
            : consumedFailureCode
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
    const store = requireConnectorStoreScope(options.connectorStore.scope(context));
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

    let shortLivedToken;
    let longLivedToken;
    let discoveredAccount;
    let failureStage = OAUTH_FAILURE_STAGES.CODE_EXCHANGE;
    try {
      const exchanged = await options.provider.exchangeCode({
        code: source.code
      });
      if (Buffer.isBuffer(exchanged?.accessToken)) {
        shortLivedToken = exchanged.accessToken;
      }
      if (
        !Buffer.isBuffer(shortLivedToken) ||
        shortLivedToken.length < 1 ||
        typeof exchanged.userId !== "string" ||
        exchanged.userId.length < 1 ||
        exchanged.userId.length > 500
      ) {
        oauthFail("social_oauth_exchange_failed");
      }
      failureStage = OAUTH_FAILURE_STAGES.TOKEN_EXTENSION_OR_VALIDATION;
      const grantedScopes = requireGrantedScopes(
        exchanged.grantedScopes,
        options.config.scopes
      );
      const extended = await options.provider.exchangeLongLivedToken({
        accessToken: shortLivedToken
      });
      if (Buffer.isBuffer(extended?.accessToken)) {
        longLivedToken = extended.accessToken;
      }
      if (
        !Buffer.isBuffer(longLivedToken) ||
        longLivedToken.length < 1 ||
        !(extended.expiresAt instanceof Date) ||
        Number.isNaN(extended.expiresAt.getTime()) ||
        extended.expiresAt.getTime() <= callbackNow
      ) {
        oauthFail("social_oauth_exchange_failed");
      }
      failureStage = OAUTH_FAILURE_STAGES.PROFESSIONAL_ACCOUNT_DISCOVERY;
      const providerAccount = await options.provider.discoverProfessionalAccount({
        accessToken: longLivedToken,
        userId: exchanged.userId,
        correlationId: context.correlationId
      });
      failureStage = OAUTH_FAILURE_STAGES.CONTROLLED_ACCOUNT_VALIDATION;
      discoveredAccount = requireProfessionalAccount(
        providerAccount,
        expectedUsername
      );
      const expectedRevision = requireRevision(consumed.connectionRevision);
      failureStage = OAUTH_FAILURE_STAGES.CONNECTION_PERSISTENCE;
      await store.runExclusive(async (transactionalStore) => {
        requireConnectorStoreScope(transactionalStore);
        failureStage = OAUTH_FAILURE_STAGES.VAULT_STORE;
        return options.credentials.withEncryptedConnectionCredential({
          companyId: context.companyId,
          connectionId: consumed.connectionId,
          credentialId: payload.authorizationHandle,
          provider: INSTAGRAM_PROVIDER,
          credentialType: INSTAGRAM_OAUTH_CREDENTIAL_TYPE,
          plaintext: longLivedToken,
          expiresAt: extended.expiresAt
        }, async (credentialEnvelope) => {
          failureStage = OAUTH_FAILURE_STAGES.CONNECTION_PERSISTENCE;
          const activated = await transactionalStore
            .activateConnectionWithCredential({
              companyId: context.companyId,
              id: consumed.connectionId,
              provider: INSTAGRAM_PROVIDER,
              state: "connected",
              account: discoveredAccount,
              revision: expectedRevision + 1
            }, expectedRevision, credentialEnvelope, {
              grantedScopes
            });
          failureStage = OAUTH_FAILURE_STAGES.ATOMIC_FINALIZATION;
          const activatedConnection = activated?.connection;
          if (
            requireConnectionId(activatedConnection?.id) !==
              consumed.connectionId ||
            activatedConnection?.state !== "connected" ||
            activatedConnection?.account?.externalId !==
              discoveredAccount.externalId
          ) {
            oauthFail("provider_result_unknown");
          }
          return activated;
        });
      });
    } catch (error) {
      await failConnection(oauth, {
        ...payload,
        connectionId: consumed.connectionId,
        connectionRevision: requireRevision(consumed.connectionRevision)
      }, "consumed", "social_oauth_exchange_failed",
      classifyOAuthFailure(failureStage, error));
      if (CALLBACK_FAILURE_CODES.has(error?.code)) throw error;
      oauthFail("social_oauth_exchange_failed");
    } finally {
      if (Buffer.isBuffer(shortLivedToken)) shortLivedToken.fill(0);
      if (Buffer.isBuffer(longLivedToken)) longLivedToken.fill(0);
    }

    return Object.freeze({
      ok: true,
      provider: INSTAGRAM_PROVIDER,
      status: "authorization_completed",
      connectionId: consumed.connectionId,
      connectionState: "connected",
      username: `@${discoveredAccount.username}`,
      accountType: discoveredAccount.accountType,
      returnPathId: payload.returnPathId
    });
  }

  function authenticatedContext(verifiedClaims) {
    const principal = options.authAdapter.fromVerifiedJwt(verifiedClaims);
    return Object.freeze({
      context: contextFor(principal),
      principal
    });
  }

  async function getCurrentConnection(input = {}) {
    const source = strictRecord(input, ["verifiedClaims"]);
    const { context } = authenticatedContext(source.verifiedClaims);
    const store = requireConnectorStoreScope(options.connectorStore.scope(context));
    const current = await store.getCurrentConnectionDetails();
    return Object.freeze({
      ok: true,
      connection: current ? publicConnection(current) : null
    });
  }

  async function getConnection(input = {}) {
    const source = strictRecord(input, ["verifiedClaims", "connectionId"]);
    const connectionId = requireConnectionId(source.connectionId);
    const { context } = authenticatedContext(source.verifiedClaims);
    const store = requireConnectorStoreScope(options.connectorStore.scope(context));
    const connection = await store.getConnectionDetails(connectionId);
    if (!connection) oauthFail("resource_unavailable");
    return Object.freeze({
      ok: true,
      connection: publicConnection(connection)
    });
  }

  async function getConnectionHealth(input = {}) {
    const result = await getConnection(input);
    return Object.freeze({
      ok: true,
      connectionId: result.connection.connectionId,
      provider: result.connection.provider,
      state: result.connection.state,
      health: result.connection.health,
      checkedAt: new Date(now()).toISOString()
    });
  }

  async function getAuthorizationStatus(input = {}) {
    const source = strictRecord(input, ["verifiedClaims", "connectionId"]);
    const connectionId = requireConnectionId(source.connectionId);
    const { context } = authenticatedContext(source.verifiedClaims);
    const oauth = requireOAuthScope(options.oauthRepository.scope(context));
    const authorization = await oauth.getAuthorizationStatus(connectionId);
    if (
      !authorization ||
      authorization.connectionId !== connectionId ||
      !PURPOSES.has(authorization.purpose) ||
      !AUTHORIZATION_STATUSES.has(authorization.status)
    ) {
      oauthFail("resource_unavailable");
    }
    return Object.freeze({
      ok: true,
      authorization: Object.freeze({
        connectionId,
        purpose: authorization.purpose,
        status: authorization.status,
        expiresAt: publicDate(authorization.expiresAt)
      })
    });
  }

  async function disconnect(input = {}) {
    const source = strictRecord(input, [
      "verifiedClaims",
      "connectionId"
    ]);
    const connectionId = requireConnectionId(source.connectionId);
    const { context } = authenticatedContext(source.verifiedClaims);
    const store = requireConnectorStoreScope(options.connectorStore.scope(context));
    const disconnected = await store.disconnectConnectionLocally(connectionId);
    if (!disconnected) oauthFail("resource_unavailable");
    return Object.freeze({
      ok: true,
      connection: publicConnection(disconnected)
    });
  }

  return Object.freeze({
    authorize,
    callback,
    disconnect,
    getAuthorizationStatus,
    getConnection,
    getConnectionHealth,
    getCurrentConnection
  });
}

module.exports = {
  INSTAGRAM_OAUTH_CREDENTIAL_TYPE,
  INSTAGRAM_OAUTH_RETURN_PATH_ID,
  createInstagramOAuthService
};
