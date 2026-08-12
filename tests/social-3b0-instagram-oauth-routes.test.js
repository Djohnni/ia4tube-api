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
        throw errorWithCode("social_oauth_exchange_failed");
      }
      assert.equal(code, "synthetic-code");
      const accessToken = Buffer.from(TOKEN_TEXT);
      tokenReferences.push(accessToken);
      return Object.freeze({ accessToken, userId: "synthetic-user" });
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
        expiresAt: null
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
  const service = createInstagramOAuthService({
    config: Object.freeze({
      enabled: true,
      provider: INSTAGRAM_PROVIDER,
      redirectUri: INSTAGRAM_OAUTH_REDIRECT_URI
    }),
    stateEnvelope: options.stateEnvelope || envelope,
    provider,
    oauthRepository,
    credentials,
    authAdapter,
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
    returnPathId: "social_connections"
  });
  assert.equal(harness.exchangeCalls, 1);
  assert.equal(harness.credentialCalls, 1);
  assert.deepEqual(harness.events.slice(-4), [
    "consume_authorization",
    "exchange_code",
    "encrypt_credential",
    "store_credential"
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
  const harness = makeHarness({ exchangeFailure: true });
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
    post(routePath, ...handlers) { routes[`POST ${routePath}`] = handlers; }
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
