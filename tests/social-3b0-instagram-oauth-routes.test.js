"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createSocialAuthAdapter } = require("../src/social/auth-adapter");
const {
  SESSION_AUDIENCE,
  SESSION_ISSUER
} = require("../src/social/reauth");
const {
  INSTAGRAM_OAUTH_REDIRECT_URI,
  INSTAGRAM_OAUTH_SCOPES,
  INSTAGRAM_PROVIDER
} = require("../src/social/oauth/instagram-config");
const {
  INSTAGRAM_OAUTH_STATE_TTL_MS,
  createInstagramOAuthStateEnvelope
} = require("../src/social/oauth/instagram-state-envelope");
const {
  createInstagramOAuthService
} = require("../src/social/oauth/instagram-oauth-service");
const {
  createInstagramOAuthRouter,
  parseCallbackQuery
} = require("../src/social/oauth/instagram-oauth-router");

const ROOT_KEY = Buffer.alloc(32, 0x51);
const UUIDS = Object.freeze([
  "10000000-0000-4000-8000-000000000001",
  "10000000-0000-4000-8000-000000000002",
  "10000000-0000-4000-8000-000000000003",
  "10000000-0000-4000-8000-000000000004",
  "10000000-0000-4000-8000-000000000005",
  "10000000-0000-4000-8000-000000000006",
  "10000000-0000-4000-8000-000000000007",
  "10000000-0000-4000-8000-000000000008",
  "10000000-0000-4000-8000-000000000009",
  "10000000-0000-4000-8000-00000000000a",
  "10000000-0000-4000-8000-00000000000b",
  "10000000-0000-4000-8000-00000000000c"
]);
const TOKEN_TEXT = "synthetic-never-authenticable-instagram-token";
const SHORT_TOKEN_TEXT = "synthetic-short-lived-instagram-token";
const REQUIRED_SCOPES = INSTAGRAM_OAUTH_SCOPES;

function errorWithCode(code) {
  return Object.assign(new Error("closed"), { code });
}

function claims() {
  return {
    token_version: 2,
    iss: SESSION_ISSUER,
    aud: SESSION_AUDIENCE,
    jti: "synthetic-session-jti-00000001",
    sub: "tenant-alpha",
    whatsapp: "tenant-alpha",
    company_id: "tenant-alpha"
  };
}

function makeHarness(options = {}) {
  let milliseconds = options.now || 1_800_000_000_000;
  let uuidIndex = 0;
  let createdInput = null;
  let createdConnectionId = null;
  let createdConnectionRevision = null;
  let expiredInput = null;
  let consumed = false;
  let exchangeCalls = 0;
  let credentialCalls = 0;
  const events = [];
  const contexts = [];
  const tokenReferences = [];
  const settlementInputs = [];
  const storageInputs = [];
  const failureInputs = [];
  const discoveryInputs = [];
  const legacyMappingInputs = [];
  const mappingDigestInputs = [];
  const envelope = createInstagramOAuthStateEnvelope({
    derivationKey: ROOT_KEY,
    keyVersion: "identity-v1",
    redirectUri: INSTAGRAM_OAUTH_REDIRECT_URI,
    clock: () => milliseconds,
    randomBytes: (size) => Buffer.alloc(size, 0x2a)
  });
  const authAdapter = createSocialAuthAdapter({
    namespaceUuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    derivationVersion: "identity-v1",
    key: ROOT_KEY
  });
  const scoped = {
    async createAuthorizationWithPendingConnection(input) {
      events.push("persist_authorization");
      createdInput = input;
      createdConnectionId = options.persistedConnectionId || input.connectionId;
      createdConnectionRevision = options.createdRevision || 1;
      if (options.createFailure) throw errorWithCode(options.createFailure);
      return Object.freeze({
        authorizationHandle: input.authorizationHandle,
        connectionId: createdConnectionId,
        purpose: input.purpose,
        expiresAt: input.expiresAt,
        revision: createdConnectionRevision,
        status: "pending"
      });
    },
    async consumeAuthorization(input) {
      events.push("consume_authorization");
      settlementInputs.push({ kind: "consumed", input });
      if (options.consumeFailure || consumed) {
        throw errorWithCode(
          options.consumeFailure || "social_oauth_state_already_consumed"
        );
      }
      consumed = true;
      return Object.freeze({
        authorizationHandle: input.authorizationHandle,
        connectionId: createdConnectionId,
        purpose: input.purpose,
        status: "consumed",
        connectionRevision: createdConnectionRevision
      });
    },
    async cancelAuthorization(input) {
      events.push("cancel_authorization");
      settlementInputs.push({ kind: "cancelled", input });
      consumed = true;
      return Object.freeze({
        authorizationHandle: input.authorizationHandle,
        connectionId: createdConnectionId,
        purpose: input.purpose,
        status: "cancelled",
        connectionRevision: createdConnectionRevision
      });
    },
    async expireAuthorization(input) {
      events.push("expire_authorization");
      settlementInputs.push({ kind: "expired", input });
      expiredInput = input;
      consumed = true;
      return Object.freeze({
        authorizationHandle: input.authorizationHandle,
        connectionId: createdConnectionId,
        purpose: input.purpose,
        status: "expired",
        connectionRevision: createdConnectionRevision
      });
    },
    async storeConsumedAuthorizationCredential(input, credentialEnvelope) {
      events.push("store_credential");
      storageInputs.push(input);
      assert.equal(input.authorizationHandle, createdInput.authorizationHandle);
      assert.equal(input.connectionId, createdConnectionId);
      assert.equal(input.purpose, createdInput.purpose);
      assert.equal(input.expectedRevision, createdConnectionRevision);
      assert.equal(credentialEnvelope.id, input.authorizationHandle);
      assert.equal(Buffer.isBuffer(credentialEnvelope.ciphertext), true);
      return Object.freeze({ credentialId: credentialEnvelope.id, revision: 1 });
    },
    async failAuthorizationConnection(input) {
      events.push(`fail_connection_${input.terminalStatus}`);
      failureInputs.push(input);
      if (options.failConnectionFailure) {
        throw errorWithCode(options.failConnectionFailure);
      }
      assert.equal(input.expectedRevision, createdConnectionRevision);
      return Object.freeze({ status: "failed" });
    },
    async getAuthorizationStatus() {
      return Object.freeze({
        connectionId: createdConnectionId,
        purpose: createdInput?.purpose || "connect",
        status: consumed
          ? "authorization_completed"
          : "authorization_pending",
        expiresAt: createdInput?.expiresAt || new Date(milliseconds + 60000)
      });
    }
  };
  const oauthRepository = {
    scope(context) {
      contexts.push(context);
      if (options.scopeFailure) throw errorWithCode(options.scopeFailure);
      return scoped;
    }
  };
  const provider = {
    buildAuthorizationUrl({ state }) {
      events.push("build_authorization_url");
      const url = new URL("https://www.instagram.com/oauth/authorize");
      url.searchParams.set("state", state);
      return url.toString();
    },
    async exchangeCode({ code }) {
      events.push("exchange_code");
      exchangeCalls += 1;
      if (options.exchangeFailure) {
        const failure = errorWithCode("social_oauth_exchange_failed");
        if (options.exchangeFailureSecret) {
          failure.message = options.exchangeFailureSecret;
          failure.body = options.exchangeFailureSecret;
        }
        throw failure;
      }
      assert.equal(code, "synthetic-code");
      const accessToken = Buffer.from(SHORT_TOKEN_TEXT);
      tokenReferences.push(accessToken);
      return Object.freeze({
        accessToken,
        userId: options.invalidExchangeUserId ? "" : "synthetic-user",
        grantedScopes: options.grantedScopes ?? REQUIRED_SCOPES
      });
    },
    async exchangeLongLivedToken({ accessToken }) {
      events.push("exchange_long_lived_token");
      assert.equal(accessToken.toString("utf8"), SHORT_TOKEN_TEXT);
      if (options.longLivedFailure) {
        throw errorWithCode("social_oauth_exchange_failed");
      }
      const token = Buffer.from(TOKEN_TEXT);
      tokenReferences.push(token);
      return Object.freeze({
        accessToken: token,
        expiresIn: 5_184_000,
        expiresAt: options.invalidLongLivedExpiry
          ? new Date(milliseconds - 1)
          : new Date(milliseconds + 5_184_000_000)
      });
    },
    async discoverProfessionalAccount({ accessToken, userId, correlationId }) {
      events.push("discover_professional_account");
      discoveryInputs.push({ correlationId });
      if (options.discoveryFailure) {
        throw errorWithCode(
          options.discoveryFailureCode || "provider_permanent_failure"
        );
      }
      assert.equal(accessToken.toString("utf8"), TOKEN_TEXT);
      assert.equal(userId, "synthetic-user");
      return Object.freeze({
        userId: options.discoveredUserId || userId,
        username: options.discoveredUsername || "ia4tube_empresas",
        name: "IA4Tube Empresas",
        accountType: options.accountType || "business"
      });
    }
  };
  const connectorScoped = {
    async activateConnectionWithCredential(
      record,
      expectedRevision,
      credentialEnvelope,
      activation
    ) {
      events.push("activate_connection");
      storageInputs.push({ record, expectedRevision, activation });
      if (options.activationFailure) {
        throw errorWithCode(options.activationFailure);
      }
      assert.equal(expectedRevision, createdConnectionRevision);
      assert.equal(record.id, createdConnectionId);
      assert.equal(record.state, "connected");
      assert.deepEqual(
        activation.grantedScopes,
        options.expectedActivationScopes ?? REQUIRED_SCOPES
      );
      assert.equal(credentialEnvelope.id, createdInput.authorizationHandle);
      assert.equal(Buffer.isBuffer(credentialEnvelope.ciphertext), true);
      return Object.freeze({
        connection: Object.freeze({
          companyId: record.companyId,
          id: options.activationResultMismatch ? UUIDS[10] : record.id,
          provider: record.provider,
          state: record.state,
          account: record.account,
          revision: record.revision
        }),
        credential: Object.freeze({ id: credentialEnvelope.id }),
        grantedScopes: activation.grantedScopes
      });
    },
    async disconnectConnectionLocally() {
      throw errorWithCode("resource_unavailable");
    },
    async getConnectionDetails() {
      return options.connectionDetails || null;
    },
    async getCurrentConnectionDetails() {
      return options.connectionDetails || null;
    },
    async ensureLegacyComplianceSubjectMapping(input) {
      legacyMappingInputs.push(input);
      if (options.legacyMappingFailure) {
        throw errorWithCode(options.legacyMappingFailure);
      }
      return Object.freeze({ created: legacyMappingInputs.length === 1 });
    },
    async runExclusive(operation) {
      events.push("exclusive_begin");
      try {
        if (options.exclusiveBeginFailure) {
          throw errorWithCode("database_unavailable");
        }
        const result = await operation(connectorScoped);
        if (options.exclusiveCommitFailure) {
          events.push("exclusive_commit_failure");
          throw errorWithCode("database_unavailable");
        }
        events.push("exclusive_commit");
        return result;
      } catch (error) {
        events.push("exclusive_rollback");
        throw error;
      }
    }
  };
  const connectorStore = {
    scope() {
      return connectorScoped;
    }
  };
  const credentials = {
    async withEncryptedConnectionCredential(input, operation) {
      events.push("encrypt_credential");
      credentialCalls += 1;
      assert.equal(input.connectionId, createdConnectionId);
      assert.equal(input.provider, INSTAGRAM_PROVIDER);
      assert.equal(input.plaintext.toString("utf8"), TOKEN_TEXT);
      assert.equal(input.credentialId, createdInput.authorizationHandle);
      const credentialEnvelope = {
        id: input.credentialId,
        provider: input.provider,
        credentialType: input.credentialType,
        ciphertext: Buffer.alloc(32, 0xa1),
        nonce: Buffer.alloc(12, 0xa2),
        authTag: Buffer.alloc(16, 0xa3),
        keyVersion: "vault-v1",
        aadVersion: 1,
        expiresAt: input.expiresAt
      };
      try {
        if (options.vaultFailure) throw errorWithCode("vault_failed");
        return await operation(credentialEnvelope);
      } finally {
        input.plaintext.fill(0);
        credentialEnvelope.ciphertext.fill(0);
        credentialEnvelope.nonce.fill(0);
        credentialEnvelope.authTag.fill(0);
      }
    }
  };
  const metaComplianceRepository = options.enableMetaCompliance
    ? Object.freeze({
        subjectMappingForExternalUser(input) {
          mappingDigestInputs.push(input);
          return Object.freeze({
            provider: "instagram",
            subjectDigest: "a".repeat(64),
            digestVersion: "hmac-sha256-app-secret-v1"
          });
        }
      })
    : undefined;
  const service = createInstagramOAuthService({
    config: Object.freeze({
      enabled: true,
      provider: INSTAGRAM_PROVIDER,
      redirectUri: INSTAGRAM_OAUTH_REDIRECT_URI,
      expectedUsername: options.expectedUsername || null,
      scopes: REQUIRED_SCOPES
    }),
    stateEnvelope: options.stateEnvelope || envelope,
    provider,
    oauthRepository,
    connectorStore,
    credentials,
    authAdapter,
    metaComplianceRepository,
    clock: () => milliseconds,
    randomUUID() {
      const value = UUIDS[uuidIndex % UUIDS.length];
      uuidIndex += 1;
      return value;
    },
    environment: "test"
  });
  return {
    service,
    envelope,
    events,
    contexts,
    tokenReferences,
    settlementInputs,
    storageInputs,
    failureInputs,
    discoveryInputs,
    legacyMappingInputs,
    mappingDigestInputs,
    get createdInput() { return createdInput; },
    get exchangeCalls() { return exchangeCalls; },
    get credentialCalls() { return credentialCalls; },
    get expiredInput() { return expiredInput; },
    advance(value) { milliseconds += value; }
  };
}

async function authorize(harness, purpose = "connect") {
  const result = await harness.service.authorize({
    verifiedClaims: claims(),
    purpose
  });
  const state = new URL(result.authorizationUrl).searchParams.get("state");
  assert.equal(typeof state, "string");
  return { result, state };
}

test("authorize persists an encrypted-state transaction before exposing its URL", async () => {
  const harness = makeHarness();
  const { result, state } = await authorize(harness);
  assert.deepEqual(result, {
    ok: true,
    provider: "instagram",
    status: "authorization_pending",
    connectionId: result.connectionId,
    expiresAt: result.expiresAt,
    authorizationUrl: result.authorizationUrl,
    returnPathId: "social_connections"
  });
  assert.deepEqual(harness.events.slice(0, 2), [
    "build_authorization_url",
    "persist_authorization"
  ]);
  assert.equal(harness.createdInput.state, state);
  assert.equal(harness.createdInput.redirectUri, INSTAGRAM_OAUTH_REDIRECT_URI);
  assert.equal(harness.createdInput.sessionJti, claims().jti);
  assert.equal(harness.createdInput.purpose, "connect");
  assert.equal(harness.createdInput.expiresAt instanceof Date, true);
  const opened = harness.envelope.open(state);
  assert.equal(opened.companyId, harness.contexts[0].companyId);
  assert.equal(opened.userId, harness.contexts[0].userId);
  assert.equal(opened.sessionJti, claims().jti);
  assert.equal(result.authorizationUrl.includes(TOKEN_TEXT), false);
});

test("reconnect reuses the repository-selected blocking connection", async () => {
  const persistedConnectionId = UUIDS[11];
  const harness = makeHarness({
    persistedConnectionId,
    createdRevision: 7
  });
  const { state } = await authorize(harness, "reconnect");
  assert.equal(harness.createdInput.purpose, "reconnect");
  const result = await harness.service.callback({
    state,
    code: "synthetic-code",
    error: null
  });
  assert.equal(result.status, "authorization_completed");
  assert.equal(harness.exchangeCalls, 1);
  assert.equal(harness.credentialCalls, 1);
  assert.equal(harness.storageInputs[0].expectedRevision, 7);
  assert.equal(
    harness.settlementInputs[0].input.observedAt.getTime(),
    1_800_000_000_000
  );
});

test("callback authenticates state before tenant scope and stores one connection-bound token", async () => {
  const harness = makeHarness();
  const { state } = await authorize(harness);
  const result = await harness.service.callback({
    state,
    code: "synthetic-code",
    error: null
  });
  assert.deepEqual(result, {
    ok: true,
    provider: "instagram",
    status: "authorization_completed",
    connectionId: result.connectionId,
    connectionState: "connected",
    username: "@ia4tube_empresas",
    accountType: "business",
    returnPathId: "social_connections"
  });
  assert.equal(harness.exchangeCalls, 1);
  assert.equal(harness.credentialCalls, 1);
  assert.deepEqual(harness.events.slice(-8), [
    "consume_authorization",
    "exchange_code",
    "exchange_long_lived_token",
    "discover_professional_account",
    "exclusive_begin",
    "encrypt_credential",
    "activate_connection",
    "exclusive_commit"
  ]);
  assert.equal(harness.contexts[1].companyId, harness.contexts[0].companyId);
  assert.equal(harness.contexts[1].userId, harness.contexts[0].userId);
  assert.equal(JSON.stringify(result).includes(TOKEN_TEXT), false);
  assert.equal(
    harness.tokenReferences.every((token) => token.every((byte) => byte === 0)),
    true
  );
});

test("invalid state performs no tenant lookup, exchange, credential or publication", async () => {
  let scopeCalls = 0;
  const harness = makeHarness({
    stateEnvelope: {
      seal() { throw errorWithCode("social_oauth_state_invalid"); },
      open() { throw errorWithCode("social_oauth_state_invalid"); },
      openForCallback() { throw errorWithCode("social_oauth_state_invalid"); }
    }
  });
  harness.service = harness.service;
  const originalScopeCount = harness.contexts.length;
  await assert.rejects(
    harness.service.callback({ state: "invalid", code: "code", error: null }),
    { code: "social_oauth_state_invalid" }
  );
  scopeCalls += harness.contexts.length - originalScopeCount;
  assert.equal(scopeCalls, 0);
  assert.equal(harness.exchangeCalls, 0);
  assert.equal(harness.credentialCalls, 0);
  assert.equal(harness.events.length, 0);
});

test("persisted binding mismatch is uniform and never reaches exchange", async () => {
  const harness = makeHarness({ consumeFailure: "authorization_expired" });
  const { state } = await authorize(harness);
  await assert.rejects(
    harness.service.callback({
      state,
      code: "synthetic-code",
      error: null
    }),
    { code: "social_oauth_state_binding_mismatch" }
  );
  assert.equal(harness.exchangeCalls, 0);
  assert.equal(harness.credentialCalls, 0);
});

test("two concurrent callbacks consume once and exchange once", async () => {
  const harness = makeHarness();
  const { state } = await authorize(harness);
  const results = await Promise.allSettled([
    harness.service.callback({ state, code: "synthetic-code", error: null }),
    harness.service.callback({ state, code: "synthetic-code", error: null })
  ]);
  assert.deepEqual(results.map((item) => item.status).sort(), [
    "fulfilled",
    "rejected"
  ]);
  const rejected = results.find((item) => item.status === "rejected");
  assert.equal(rejected.reason.code, "social_oauth_state_already_consumed");
  assert.equal(harness.exchangeCalls, 1);
  assert.equal(harness.credentialCalls, 1);
});

test("provider cancellation terminalizes without exchange or token storage", async () => {
  const harness = makeHarness();
  const { state } = await authorize(harness);
  await assert.rejects(
    harness.service.callback({ state, code: null, error: "access_denied" }),
    { code: "social_oauth_state_cancelled" }
  );
  assert.equal(harness.exchangeCalls, 0);
  assert.equal(harness.credentialCalls, 0);
  assert.ok(harness.events.includes("cancel_authorization"));
  assert.ok(harness.events.includes("fail_connection_cancelled"));
  assert.equal(harness.failureInputs[0].expectedRevision, 1);
  assert.equal(
    harness.settlementInputs[0].input.observedAt.getTime(),
    1_800_000_000_000
  );
});

test("expired state terminalizes without exchange and cannot be renewed", async () => {
  const harness = makeHarness();
  const { state } = await authorize(harness);
  harness.advance(INSTAGRAM_OAUTH_STATE_TTL_MS);
  await assert.rejects(
    harness.service.callback({ state, code: "synthetic-code", error: null }),
    { code: "social_oauth_state_expired" }
  );
  assert.equal(harness.exchangeCalls, 0);
  assert.equal(harness.credentialCalls, 0);
  assert.ok(harness.events.includes("expire_authorization"));
  assert.ok(harness.events.includes("fail_connection_expired"));
  assert.equal(harness.failureInputs[0].expectedRevision, 1);
  assert.equal(
    harness.expiredInput.observedAt.getTime(),
    1_800_000_000_000 + INSTAGRAM_OAUTH_STATE_TTL_MS
  );
});

test("connection terminalization failure is never swallowed", async () => {
  const cancelled = makeHarness({ failConnectionFailure: "database_unavailable" });
  const cancelledState = (await authorize(cancelled)).state;
  await assert.rejects(
    cancelled.service.callback({
      state: cancelledState,
      code: null,
      error: "access_denied"
    }),
    { code: "social_oauth_state_binding_mismatch" }
  );
  assert.equal(cancelled.exchangeCalls, 0);

  const expired = makeHarness({ failConnectionFailure: "database_unavailable" });
  const expiredState = (await authorize(expired)).state;
  expired.advance(INSTAGRAM_OAUTH_STATE_TTL_MS);
  await assert.rejects(
    expired.service.callback({
      state: expiredState,
      code: "synthetic-code",
      error: null
    }),
    { code: "social_oauth_state_binding_mismatch" }
  );
  assert.equal(expired.exchangeCalls, 0);

  const consumed = makeHarness({
    exchangeFailure: true,
    failConnectionFailure: "database_unavailable"
  });
  const consumedState = (await authorize(consumed)).state;
  await assert.rejects(
    consumed.service.callback({
      state: consumedState,
      code: "synthetic-code",
      error: null
    }),
    { code: "social_oauth_exchange_failed" }
  );
  assert.equal(consumed.exchangeCalls, 1);
});

test("exchange failure leaves state consumed and never retries the provider", async () => {
  const secretMarker = "secret-provider-body-must-not-survive";
  const harness = makeHarness({
    exchangeFailure: true,
    exchangeFailureSecret: secretMarker
  });
  const { state } = await authorize(harness);
  await assert.rejects(
    harness.service.callback({ state, code: "synthetic-code", error: null }),
    { code: "social_oauth_exchange_failed" }
  );
  await assert.rejects(
    harness.service.callback({ state, code: "synthetic-code", error: null }),
    { code: "social_oauth_state_already_consumed" }
  );
  assert.equal(harness.exchangeCalls, 1);
  assert.equal(harness.credentialCalls, 0);
  assert.ok(harness.events.includes("fail_connection_consumed"));
  assert.equal(harness.failureInputs[0].expectedRevision, 1);
  assert.equal(
    harness.failureInputs[0].failureCode,
    "provider_code_exchange_failed"
  );
  assert.equal(JSON.stringify(harness.failureInputs).includes(secretMarker), false);
});

test("callback persists the professional id separately from the app-scoped exchange id", async () => {
  const professionalUserId = "synthetic-professional-user";
  const harness = makeHarness({ discoveredUserId: professionalUserId });
  const { state } = await authorize(harness);
  const result = await harness.service.callback({
    state,
    code: "synthetic-code",
    error: null
  });
  assert.equal(result.status, "authorization_completed");
  assert.equal(result.connectionState, "connected");
  const activation = harness.storageInputs.find((input) => input.record);
  assert.equal(activation.record.account.externalId, professionalUserId);
  assert.deepEqual(activation.activation.grantedScopes, REQUIRED_SCOPES);
  assert.equal(harness.discoveryInputs.length, 1);
});

test("long-lived token failure is classified before discovery or storage", async () => {
  const harness = makeHarness({ longLivedFailure: true });
  const { state } = await authorize(harness);
  await assert.rejects(
    harness.service.callback({ state, code: "synthetic-code", error: null }),
    { code: "social_oauth_exchange_failed" }
  );
  assert.equal(harness.credentialCalls, 0);
  assert.equal(harness.storageInputs.length, 0);
  assert.equal(
    harness.failureInputs[0].failureCode,
    "provider_token_extension_failed"
  );
});

test("malformed token-bearing provider results zero every returned buffer", async () => {
  const invalidExchange = makeHarness({ invalidExchangeUserId: true });
  const invalidExchangeState = (await authorize(invalidExchange)).state;
  await assert.rejects(
    invalidExchange.service.callback({
      state: invalidExchangeState,
      code: "synthetic-code",
      error: null
    }),
    { code: "social_oauth_exchange_failed" }
  );
  assert.equal(
    invalidExchange.tokenReferences.every(
      (token) => token.every((byte) => byte === 0)
    ),
    true
  );
  assert.equal(
    invalidExchange.failureInputs[0].failureCode,
    "provider_code_exchange_failed"
  );

  const invalidExtended = makeHarness({ invalidLongLivedExpiry: true });
  const invalidExtendedState = (await authorize(invalidExtended)).state;
  await assert.rejects(
    invalidExtended.service.callback({
      state: invalidExtendedState,
      code: "synthetic-code",
      error: null
    }),
    { code: "social_oauth_exchange_failed" }
  );
  assert.equal(
    invalidExtended.tokenReferences.every(
      (token) => token.every((byte) => byte === 0)
    ),
    true
  );
  assert.equal(
    invalidExtended.failureInputs[0].failureCode,
    "provider_token_extension_failed"
  );
});

test("professional account and controlled username gates fail closed before vault storage", async () => {
  const personal = makeHarness({ accountType: "personal" });
  const personalState = (await authorize(personal)).state;
  await assert.rejects(
    personal.service.callback({
      state: personalState,
      code: "synthetic-code",
      error: null
    }),
    { code: "invalid_account_type" }
  );
  assert.equal(personal.credentialCalls, 0);
  assert.ok(personal.events.includes("fail_connection_consumed"));
  assert.equal(
    personal.failureInputs[0].failureCode,
    "provider_account_ineligible"
  );

  const controlled = makeHarness({
    expectedUsername: "ia4tube_empresas",
    discoveredUsername: "another_professional_account"
  });
  const controlledState = (await authorize(controlled)).state;
  await assert.rejects(
    controlled.service.callback({
      state: controlledState,
      code: "synthetic-code",
      error: null
    }),
    { code: "controlled_account_mismatch" }
  );
  assert.equal(controlled.credentialCalls, 0);
  assert.equal(
    controlled.failureInputs[0].failureCode,
    "controlled_username_mismatch"
  );
});

test("required scope gate accepts normalized required subsets and extras", async (t) => {
  const extraScope = "instagram_business_manage_comments";
  const cases = [
    ["exact", REQUIRED_SCOPES, REQUIRED_SCOPES],
    ["reversed", [...REQUIRED_SCOPES].reverse(), REQUIRED_SCOPES],
    [
      "duplicated",
      [REQUIRED_SCOPES[1], REQUIRED_SCOPES[0], REQUIRED_SCOPES[1]],
      REQUIRED_SCOPES
    ],
    [
      "additional",
      [extraScope, ...REQUIRED_SCOPES],
      Object.freeze([...REQUIRED_SCOPES, extraScope].sort())
    ]
  ];

  for (const [name, grantedScopes, expectedActivationScopes] of cases) {
    await t.test(name, async () => {
      const harness = makeHarness({
        grantedScopes,
        expectedActivationScopes
      });
      const state = (await authorize(harness)).state;
      const result = await harness.service.callback({
        state,
        code: "synthetic-code",
        error: null
      });
      assert.equal(result.status, "authorization_completed");
      assert.equal(harness.credentialCalls, 1);
      assert.equal(harness.failureInputs.length, 0);
    });
  }
});

test("missing or legacy scopes fail without a credential or account", async (t) => {
  const cases = [
    ["missing basic", [REQUIRED_SCOPES[1]]],
    ["missing publish", [REQUIRED_SCOPES[0]]],
    ["legacy names", ["instagram_basic", "instagram_content_publish"]]
  ];

  for (const [name, grantedScopes] of cases) {
    await t.test(name, async () => {
      const harness = makeHarness({ grantedScopes });
      const state = (await authorize(harness)).state;
      await assert.rejects(
        harness.service.callback({
          state,
          code: "synthetic-code",
          error: null
        }),
        { code: "permission_missing" }
      );
      assert.equal(harness.credentialCalls, 0);
      assert.equal(harness.storageInputs.length, 0);
      assert.equal(
        harness.failureInputs[0].failureCode,
        "provider_permissions_missing"
      );
    });
  }
});

test("discovery observability maps every typed failure into the audit handoff", async () => {
  const codes = [
    "provider_account_discovery_request_not_sent",
    "provider_account_discovery_timeout",
    "provider_account_discovery_transport_failed",
    "provider_account_discovery_http_rejected",
    "provider_account_discovery_invalid_content_type",
    "provider_account_discovery_invalid_json",
    "provider_account_discovery_invalid_shape",
    "provider_account_discovery_missing_id",
    "provider_account_discovery_missing_username",
    "provider_account_discovery_account_ineligible"
  ];
  for (const code of codes) {
    const discovery = makeHarness({
      discoveryFailure: true,
      discoveryFailureCode: code
    });
    const discoveryState = (await authorize(discovery)).state;
    await assert.rejects(
      discovery.service.callback({
        state: discoveryState,
        code: "synthetic-code",
        error: null
      }),
      { code: "social_oauth_exchange_failed" }
    );
    assert.equal(discovery.credentialCalls, 0);
    assert.equal(discovery.storageInputs.length, 0);
    assert.equal(discovery.failureInputs[0].failureCode, code);
    assert.equal(
      discovery.discoveryInputs[0].correlationId,
      discovery.contexts[1].correlationId
    );
  }
});

test("vault failure is classified and leaves no committed credential", async () => {
  const harness = makeHarness({ vaultFailure: true });
  const { state } = await authorize(harness);
  await assert.rejects(
    harness.service.callback({ state, code: "synthetic-code", error: null }),
    { code: "social_oauth_exchange_failed" }
  );
  assert.equal(harness.credentialCalls, 1);
  assert.equal(harness.storageInputs.length, 0);
  assert.equal(harness.events.includes("exclusive_commit"), false);
  assert.ok(harness.events.includes("exclusive_rollback"));
  assert.equal(
    harness.failureInputs[0].failureCode,
    "token_vault_store_failed"
  );
  assert.equal(
    harness.tokenReferences.every((token) => token.every((byte) => byte === 0)),
    true
  );
});

test("activation failure cannot expose or retain an orphan token", async () => {
  const harness = makeHarness({ activationFailure: "state_transition_invalid" });
  const { state } = await authorize(harness);
  await assert.rejects(
    harness.service.callback({ state, code: "synthetic-code", error: null }),
    { code: "social_oauth_exchange_failed" }
  );
  assert.equal(harness.credentialCalls, 1);
  assert.equal(harness.storageInputs.length, 1);
  assert.ok(harness.events.includes("fail_connection_consumed"));
  assert.equal(
    harness.tokenReferences.every((token) => token.every((byte) => byte === 0)),
    true
  );
  assert.ok(harness.events.includes("exclusive_rollback"));
  assert.equal(harness.events.includes("exclusive_commit"), false);
  assert.equal(
    harness.failureInputs[0].failureCode,
    "connection_persistence_failed"
  );
});

test("activation result is validated before the exclusive transaction commits", async () => {
  const harness = makeHarness({ activationResultMismatch: true });
  const { state } = await authorize(harness);
  await assert.rejects(
    harness.service.callback({ state, code: "synthetic-code", error: null }),
    { code: "provider_result_unknown" }
  );
  const rollback = harness.events.indexOf("exclusive_rollback");
  const terminal = harness.events.indexOf("fail_connection_consumed");
  assert.ok(rollback > harness.events.indexOf("activate_connection"));
  assert.ok(terminal > rollback);
  assert.equal(harness.events.includes("exclusive_commit"), false);
  assert.equal(
    harness.failureInputs[0].failureCode,
    "connection_finalization_failed"
  );
});

test("exclusive transaction boundaries retain persistence and finalization stages", async () => {
  const begin = makeHarness({ exclusiveBeginFailure: true });
  const beginState = (await authorize(begin)).state;
  await assert.rejects(
    begin.service.callback({ state: beginState, code: "synthetic-code", error: null }),
    { code: "social_oauth_exchange_failed" }
  );
  assert.equal(
    begin.failureInputs[0].failureCode,
    "connection_persistence_failed"
  );
  assert.equal(begin.events.includes("exclusive_commit"), false);

  const commit = makeHarness({ exclusiveCommitFailure: true });
  const commitState = (await authorize(commit)).state;
  await assert.rejects(
    commit.service.callback({
      state: commitState,
      code: "synthetic-code",
      error: null
    }),
    { code: "social_oauth_exchange_failed" }
  );
  assert.equal(
    commit.failureInputs[0].failureCode,
    "connection_finalization_failed"
  );
  assert.ok(commit.events.includes("exclusive_rollback"));
  assert.equal(commit.events.includes("exclusive_commit"), false);
  assert.equal(
    commit.tokenReferences.every((token) => token.every((byte) => byte === 0)),
    true
  );
});

test("service refuses incoherent connection state and health", async () => {
  const harness = makeHarness({
    connectionDetails: Object.freeze({
      id: UUIDS[8],
      provider: "instagram",
      state: "disconnected",
      account: null,
      createdAt: new Date("2026-08-12T10:00:00.000Z"),
      connectedAt: null,
      updatedAt: new Date("2026-08-12T10:01:00.000Z"),
      disconnectedAt: new Date("2026-08-12T10:01:00.000Z"),
      health: "healthy"
    })
  });
  await assert.rejects(
    harness.service.getConnection({
      verifiedClaims: claims(),
      connectionId: UUIDS[8]
    }),
    { code: "resource_unavailable" }
  );
});

test("existing connected account gets a fail-closed compliance mapping without another OAuth", async () => {
  const connectionDetails = Object.freeze({
    id: UUIDS[8],
    provider: "instagram",
    state: "connected",
    account: Object.freeze({
      externalId: "synthetic-professional-user",
      username: "ia4tube_empresas",
      displayName: "IA4Tube Empresas",
      accountType: "business"
    }),
    createdAt: new Date("2026-08-12T10:00:00.000Z"),
    connectedAt: new Date("2026-08-12T10:01:00.000Z"),
    updatedAt: new Date("2026-08-12T10:02:00.000Z"),
    disconnectedAt: null,
    health: "healthy"
  });
  const harness = makeHarness({
    connectionDetails,
    enableMetaCompliance: true
  });
  const current = await harness.service.getCurrentConnection({
    verifiedClaims: claims()
  });
  const exact = await harness.service.getConnection({
    verifiedClaims: claims(),
    connectionId: UUIDS[8]
  });
  assert.equal(current.connection.connectionId, UUIDS[8]);
  assert.equal(exact.connection.connectionId, UUIDS[8]);
  assert.equal(Object.hasOwn(current.connection, "externalId"), false);
  assert.deepEqual(harness.mappingDigestInputs, [
    { provider: "instagram", externalUserId: "synthetic-professional-user" },
    { provider: "instagram", externalUserId: "synthetic-professional-user" }
  ]);
  assert.deepEqual(harness.legacyMappingInputs, [
    {
      connectionId: UUIDS[8],
      externalUserId: "synthetic-professional-user",
      subjectMapping: {
        provider: "instagram",
        subjectDigest: "a".repeat(64),
        digestVersion: "hmac-sha256-app-secret-v1"
      }
    },
    {
      connectionId: UUIDS[8],
      externalUserId: "synthetic-professional-user",
      subjectMapping: {
        provider: "instagram",
        subjectDigest: "a".repeat(64),
        digestVersion: "hmac-sha256-app-secret-v1"
      }
    }
  ]);
  assert.equal(harness.exchangeCalls, 0);
  assert.equal(harness.credentialCalls, 0);

  const disconnected = makeHarness({
    enableMetaCompliance: true,
    connectionDetails: Object.freeze({
      ...connectionDetails,
      state: "disconnected",
      account: null,
      connectedAt: null,
      disconnectedAt: new Date("2026-08-12T10:03:00.000Z"),
      health: "disconnected"
    })
  });
  await disconnected.service.getCurrentConnection({ verifiedClaims: claims() });
  assert.deepEqual(disconnected.legacyMappingInputs, []);
  assert.deepEqual(disconnected.mappingDigestInputs, []);
});

test("an existing blocking connection rejects authorization before provider access", async () => {
  const harness = makeHarness({ createFailure: "active_connection_exists" });
  await assert.rejects(
    harness.service.authorize({ verifiedClaims: claims(), purpose: "connect" }),
    { code: "active_connection_exists" }
  );
  assert.equal(harness.exchangeCalls, 0);
  assert.equal(harness.credentialCalls, 0);
  assert.equal(harness.storageInputs.length, 0);
});

test("callback query is exact, duplicate-free and authority-free", () => {
  assert.deepEqual(
    parseCallbackQuery("/v1/social/oauth/callback?state=abc&code=xyz"),
    { state: "abc", code: "xyz", error: null }
  );
  assert.deepEqual(
    parseCallbackQuery(
      "/v1/social/oauth/callback?state=abc&error=access_denied" +
      "&error_reason=user_denied&error_description=synthetic"
    ),
    { state: "abc", code: null, error: "access_denied" }
  );
  for (const query of [
    "?code=x",
    "?state=a",
    "?state=a&state=b&code=x",
    "?state=a&code=x&error=access_denied",
    "?state=a&code=x&company_id=forged",
    "?state=a&code=x&user_id=forged",
    "?state=a&code=x&session_jti=forged",
    "?state=a&code=x&authorizationHandle=forged",
    "?state=a&code=x&returnPath=https%3A%2F%2Fexample.invalid",
    "?state=a&error=access_denied&error_reason=other",
    "?state=a&error=other&error_reason=user_denied",
    "?state=a&code=x&error_reason=user_denied",
    "?state=a&error_reason=user_denied",
    "?state=a&error=access_denied&error_reason=user_denied" +
      "&error_reason=user_denied"
  ]) {
    assert.throws(
      () => parseCallbackQuery(`/v1/social/oauth/callback${query}`),
      { code: "social_oauth_callback_invalid" }
    );
  }
});

function fakeResponse() {
  return {
    headers: {},
    statusCode: null,
    payload: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.payload = value; return value; }
  };
}

test("callback route has no Bearer middleware and never returns remote description", async () => {
  const routes = {};
  const router = {
    get(routePath, ...handlers) { routes[`GET ${routePath}`] = handlers; },
    post(routePath, ...handlers) { routes[`POST ${routePath}`] = handlers; },
    delete(routePath, ...handlers) { routes[`DELETE ${routePath}`] = handlers; }
  };
  let callbackInput;
  const service = {
    async authorize() { return { ok: true }; },
    async callback(input) {
      callbackInput = input;
      return { ok: true, status: "authorization_completed" };
    }
  };
  createInstagramOAuthRouter({
    router,
    authenticate(_req, _res, next) { return next(); },
    getService() { return service; }
  });
  assert.equal(routes["POST /connections/instagram/authorization"].length, 3);
  assert.equal(routes["GET /connections/instagram"].length, 3);
  assert.equal(routes["GET /connections/instagram/:connectionId"].length, 3);
  assert.equal(
    routes["GET /connections/instagram/:connectionId/authorization"].length,
    3
  );
  assert.equal(
    routes["GET /connections/instagram/:connectionId/health"].length,
    3
  );
  assert.equal(routes["DELETE /connections/instagram/:connectionId"].length, 3);
  assert.equal(routes["GET /oauth/callback"].length, 2);
  const [cache, callbackHandler] = routes["GET /oauth/callback"];
  const req = {
    originalUrl:
      "/v1/social/oauth/callback?state=synthetic-state" +
      "&error=access_denied&error_reason=user_denied" +
      "&error_description=remote-sensitive-context",
    headers: {}
  };
  const res = fakeResponse();
  let nextCalls = 0;
  cache(req, res, () => { nextCalls += 1; });
  await callbackHandler(req, res);
  assert.equal(nextCalls, 1);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["Cache-Control"], "no-store");
  assert.deepEqual(callbackInput, {
    state: "synthetic-state",
    code: null,
    error: "access_denied"
  });
  assert.equal(JSON.stringify(res.payload).includes("remote-sensitive"), false);
});

test("server mounts the local OAuth contract without a callback Bearer guard", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "server.js"),
    "utf8"
  );
  assert.match(source, /app\.use\("\/v1\/social", createInstagramOAuthRouter/);
  assert.match(
    source,
    /routePath === "\/v1\/social\/connections\/instagram\/authorization"/
  );
  assert.doesNotMatch(source, /GET \/v1\/social\/oauth\/callback.*auth/s);
  assert.match(source, /path: req\.path/);
  assert.match(source, /sanitizeInstagramDiscoveryEvidence\(event\)/);
  assert.match(source, /\[social\]\[oauth-account-discovery\]/);
  const routerSource = fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "src",
      "social",
      "oauth",
      "instagram-oauth-router.js"
    ),
    "utf8"
  );
  assert.doesNotMatch(routerSource, /console\.|logger\.|req\.query/);
  assert.doesNotMatch(routerSource, /json\([^)]*error_description/s);
});

function connectionRouteHarness(overrides = {}) {
  const routes = {};
  const calls = [];
  const connectionId = UUIDS[8];
  const connected = Object.freeze({
    connectionId,
    provider: "instagram",
    username: "@ia4tube_empresas",
    accountType: "business",
    state: "connected",
    createdAt: "2026-08-12T10:00:00.000Z",
    connectedAt: "2026-08-12T10:01:00.000Z",
    updatedAt: "2026-08-12T10:01:00.000Z",
    disconnectedAt: null,
    health: "healthy"
  });
  const disconnected = Object.freeze({
    ...connected,
    username: null,
    accountType: null,
    state: "disconnected",
    updatedAt: "2026-08-12T10:02:00.000Z",
    disconnectedAt: "2026-08-12T10:02:00.000Z",
    health: "disconnected"
  });
  const service = {
    async authorize() { return { ok: true }; },
    async callback() { return { ok: true }; },
    async getCurrentConnection(input) {
      calls.push(["getCurrentConnection", input]);
      return { ok: true, connection: connected };
    },
    async getConnection(input) {
      calls.push(["getConnection", input]);
      return { ok: true, connection: connected };
    },
    async getAuthorizationStatus(input) {
      calls.push(["getAuthorizationStatus", input]);
      return Object.freeze({
        ok: true,
        authorization: Object.freeze({
          connectionId,
          purpose: "connect",
          status: "authorization_completed",
          expiresAt: "2027-01-02T03:04:05.000Z"
        })
      });
    },
    async getConnectionHealth(input) {
      calls.push(["getConnectionHealth", input]);
      return Object.freeze({
        ok: true,
        connectionId,
        provider: "instagram",
        state: "connected",
        health: "healthy",
        checkedAt: "2026-08-12T10:03:00.000Z"
      });
    },
    async disconnect(input) {
      calls.push(["disconnect", input]);
      return { ok: true, connection: disconnected };
    },
    ...overrides
  };
  const router = {
    get(routePath, ...handlers) { routes[`GET ${routePath}`] = handlers; },
    post(routePath, ...handlers) { routes[`POST ${routePath}`] = handlers; },
    delete(routePath, ...handlers) { routes[`DELETE ${routePath}`] = handlers; }
  };
  createInstagramOAuthRouter({
    router,
    authenticate(_req, _res, next) { return next(); },
    getService() { return service; }
  });
  return { calls, connected, connectionId, disconnected, routes, service };
}

function connectionRequest(input = {}) {
  const headers = Object.fromEntries(
    Object.entries(input.headers || {}).map(([key, value]) => [
      key.toLowerCase(),
      value
    ])
  );
  return {
    user: Object.hasOwn(input, "user") ? input.user : claims(),
    auth: input.auth,
    params: input.params || {},
    query: input.query || {},
    body: input.body,
    headers,
    get(name) { return headers[String(name).toLowerCase()]; }
  };
}

async function invokeAuthenticatedRoute(handlers, req) {
  const res = fakeResponse();
  let middlewareCalls = 0;
  handlers[0](req, res, () => { middlewareCalls += 1; });
  handlers[1](req, res, () => { middlewareCalls += 1; });
  assert.equal(middlewareCalls, 2);
  await handlers[2](req, res);
  assert.equal(res.headers["Cache-Control"], "no-store");
  return res;
}

test("authenticated connection routes pass only middleware-verified claims as authority", async () => {
  const harness = connectionRouteHarness();

  const current = await invokeAuthenticatedRoute(
    harness.routes["GET /connections/instagram"],
    connectionRequest()
  );
  assert.equal(current.statusCode, 200);
  assert.deepEqual(current.payload, {
    ok: true,
    connection: harness.connected
  });

  const detail = await invokeAuthenticatedRoute(
    harness.routes["GET /connections/instagram/:connectionId"],
    connectionRequest({ params: { connectionId: harness.connectionId } })
  );
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.payload.connection.username, "@ia4tube_empresas");

  const authorization = await invokeAuthenticatedRoute(
    harness.routes[
      "GET /connections/instagram/:connectionId/authorization"
    ],
    connectionRequest({ params: { connectionId: harness.connectionId } })
  );
  assert.deepEqual(authorization.payload, {
    ok: true,
    authorization: {
      connectionId: harness.connectionId,
      provider: "instagram",
      purpose: "connect",
      status: "authorization_completed",
      expiresAt: "2027-01-02T03:04:05.000Z"
    }
  });

  const health = await invokeAuthenticatedRoute(
    harness.routes["GET /connections/instagram/:connectionId/health"],
    connectionRequest({ params: { connectionId: harness.connectionId } })
  );
  assert.deepEqual(health.payload, {
    ok: true,
    connectionId: harness.connectionId,
    provider: "instagram",
    state: "connected",
    health: "healthy",
    checkedAt: "2026-08-12T10:03:00.000Z"
  });

  const removed = await invokeAuthenticatedRoute(
    harness.routes["DELETE /connections/instagram/:connectionId"],
    connectionRequest({
      params: { connectionId: harness.connectionId }
    })
  );
  assert.deepEqual(removed.payload, {
    ok: true,
    connection: harness.disconnected
  });
  const removedAgain = await invokeAuthenticatedRoute(
    harness.routes["DELETE /connections/instagram/:connectionId"],
    connectionRequest({ params: { connectionId: harness.connectionId } })
  );
  assert.deepEqual(removedAgain.payload, removed.payload);

  assert.deepEqual(harness.calls, [
    ["getCurrentConnection", { verifiedClaims: claims() }],
    ["getConnection", {
      verifiedClaims: claims(),
      connectionId: harness.connectionId
    }],
    ["getAuthorizationStatus", {
      verifiedClaims: claims(),
      connectionId: harness.connectionId
    }],
    ["getConnectionHealth", {
      verifiedClaims: claims(),
      connectionId: harness.connectionId
    }],
    ["disconnect", {
      verifiedClaims: claims(),
      connectionId: harness.connectionId
    }],
    ["disconnect", {
      verifiedClaims: claims(),
      connectionId: harness.connectionId
    }]
  ]);
});

test("connection routes reject forged authority and malformed ids before service access", async () => {
  const harness = connectionRouteHarness();
  const detailHandlers =
    harness.routes["GET /connections/instagram/:connectionId"];
  const deleteHandlers =
    harness.routes["DELETE /connections/instagram/:connectionId"];

  for (const req of [
    connectionRequest({
      params: { connectionId: harness.connectionId },
      query: { company_id: "forged-company" }
    }),
    connectionRequest({
      params: { connectionId: "not-a-uuid" }
    }),
    connectionRequest({
      user: null,
      params: { connectionId: harness.connectionId }
    })
  ]) {
    const res = await invokeAuthenticatedRoute(detailHandlers, req);
    assert.ok([400, 401].includes(res.statusCode));
    assert.deepEqual(Object.keys(res.payload).sort(), ["code", "ok"]);
  }

  for (const req of [
    connectionRequest({
      params: { connectionId: harness.connectionId },
      body: { userId: "forged-user" }
    })
  ]) {
    const res = await invokeAuthenticatedRoute(deleteHandlers, req);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.payload, {
      ok: false,
      code: "social_connection_request_invalid"
    });
  }
  assert.deepEqual(harness.calls, []);
});

test("connection routes fail closed on cross-tenant absence and secret-shaped service output", async () => {
  const unavailable = errorWithCode("resource_unavailable");
  const missingHarness = connectionRouteHarness({
    async getConnection() { throw unavailable; }
  });
  const missing = await invokeAuthenticatedRoute(
    missingHarness.routes["GET /connections/instagram/:connectionId"],
    connectionRequest({
      params: { connectionId: missingHarness.connectionId }
    })
  );
  assert.deepEqual(missing.payload, {
    ok: false,
    code: "resource_unavailable"
  });
  assert.equal(missing.statusCode, 404);

  const secretHarness = connectionRouteHarness({
    async getConnection() {
      return {
        ok: true,
        connection: {
          ...connectionRouteHarness().connected,
          accessToken: "synthetic-secret-that-must-not-escape"
        }
      };
    }
  });
  const refused = await invokeAuthenticatedRoute(
    secretHarness.routes["GET /connections/instagram/:connectionId"],
    connectionRequest({ params: { connectionId: secretHarness.connectionId } })
  );
  assert.equal(refused.statusCode, 503);
  assert.deepEqual(refused.payload, {
    ok: false,
    code: "social_connection_response_invalid"
  });
  assert.equal(JSON.stringify(refused.payload).includes("synthetic-secret"), false);

  const emptyHarness = connectionRouteHarness({
    async getCurrentConnection(input) {
      emptyHarness.calls.push(["getCurrentConnection", input]);
      return { ok: true, connection: null };
    }
  });
  const empty = await invokeAuthenticatedRoute(
    emptyHarness.routes["GET /connections/instagram"],
    connectionRequest()
  );
  assert.deepEqual(empty.payload, { ok: true, connection: null });

  for (const [method, response] of [
    ["getConnection", {
      ok: true,
      connection: { ...secretHarness.connected, health: "disconnected" }
    }],
    ["getConnectionHealth", {
      ok: true,
      connectionId: secretHarness.connectionId,
      provider: "instagram",
      state: "disconnected",
      health: "healthy",
      checkedAt: "2026-08-12T10:03:00.000Z"
    }]
  ]) {
    const mismatchHarness = connectionRouteHarness({
      async [method]() { return response; }
    });
    const route = method === "getConnection"
      ? "GET /connections/instagram/:connectionId"
      : "GET /connections/instagram/:connectionId/health";
    const mismatch = await invokeAuthenticatedRoute(
      mismatchHarness.routes[route],
      connectionRequest({
        params: { connectionId: mismatchHarness.connectionId }
      })
    );
    assert.deepEqual(mismatch.payload, {
      ok: false,
      code: "social_connection_response_invalid"
    });
  }
});
