"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const { createSocialAuthAdapter } = require("../src/social/auth-adapter");
const { SESSION_AUDIENCE, SESSION_ISSUER } = require("../src/social/reauth");
const { createConnectorContext } = require("../src/social/connectors/contract");
const {
  APP_REVIEW_LOGIN,
  APP_REVIEW_STAGING_ORIGIN,
  canExternalConnection,
  canExternalPublication,
  isAppReviewCompany
} = require("../src/social/app-review-policy");
const {
  INSTAGRAM_OAUTH_REDIRECT_URI,
  INSTAGRAM_OAUTH_SCOPES,
  INSTAGRAM_TOKEN_ENDPOINT,
  loadInstagramOAuthConfig
} = require("../src/social/oauth/instagram-config");
const { createInstagramProvider } = require("../src/social/oauth/instagram-provider");
const { createInstagramOAuthService } = require("../src/social/oauth/instagram-oauth-service");
const { PUBLIC_ERROR_STATUS } = require("../src/social/oauth/instagram-oauth-router");
const { createInstagramOAuthStateEnvelope } = require("../src/social/oauth/instagram-state-envelope");
const { CONTROLLED_GATE4_COMPANY_ID } = require("../src/social/publication/controlled-gate4-jpeg");

const NOW = 1_800_000_000_000;
const KEY = Buffer.alloc(32, 0x4b);
const SHORT_TOKEN = "synthetic-app-review-short-token";
const LONG_TOKEN = "synthetic-app-review-long-token";
const APP_SECRET = "synthetic-app-review-app-secret";
const USER_ID = "17841400000000001";
const AUTH = createSocialAuthAdapter({
  namespaceUuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  derivationVersion: "identity-v1",
  key: KEY
});

function claims(company = APP_REVIEW_LOGIN) {
  return {
    token_version: 2,
    iss: SESSION_ISSUER,
    aud: SESSION_AUDIENCE,
    jti: "synthetic-review-session-00000001",
    sub: company,
    whatsapp: company,
    company_id: company
  };
}

const REVIEW_COMPANY = AUTH.fromVerifiedJwt(claims()).companyId;

function environment(overrides = {}) {
  return {
    ENVIRONMENT: "staging",
    NODE_ENV: "production",
    PUBLIC_API_BASE_URL: APP_REVIEW_STAGING_ORIGIN,
    REAL_REVIEWER_UI_ENABLED: "true",
    SOCIAL_INSTAGRAM_ENABLED: "true",
    SOCIAL_INSTAGRAM_EXPECTED_USERNAME: "ia4tube_empresas",
    SOCIAL_EXTERNAL_CONNECTION_ENABLED: "false",
    SOCIAL_EXTERNAL_PUBLICATION_ENABLED: "false",
    SOCIAL_TENANT_NAMESPACE_UUID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    SOCIAL_IDENTITY_DERIVATION_VERSION: "identity-v1",
    SOCIAL_IDENTITY_DERIVATION_KEY: KEY.toString("base64"),
    META_APP_REVIEW_COMPANY_ID: REVIEW_COMPANY,
    META_APP_REVIEW_WINDOW_ENABLED: "true",
    INSTAGRAM_APP_ID: "100000000000001",
    INSTAGRAM_APP_SECRET: APP_SECRET,
    INSTAGRAM_OAUTH_REDIRECT_URI,
    INSTAGRAM_GRAPH_API_VERSION: "v25.0",
    ...overrides
  };
}

function context(company, contextEnvironment = "staging") {
  return createConnectorContext({
    principal: AUTH.fromVerifiedJwt(claims(company)),
    provider: "instagram",
    environment: contextEnvironment,
    correlationId: crypto.randomUUID(),
    auditEventId: crypto.randomUUID()
  });
}

function jsonResponse(value) {
  return { status: 200, headers: { "content-type": "application/json" },
    body: JSON.stringify(value) };
}

function harness(options = {}) {
  const config = loadInstagramOAuthConfig(environment(options.env));
  const requests = [];
  const tenantScopes = [];
  const stored = [];
  const failures = [];
  let appReviewDisconnectCalls = 0;
  let authorization;
  let consumed = false;
  const provider = createInstagramProvider({
    config,
    clock: () => NOW,
    transport: async (url) => {
      requests.push(new URL(url).pathname);
      if (url === INSTAGRAM_TOKEN_ENDPOINT) {
        return jsonResponse({ data: [{ access_token: SHORT_TOKEN,
          user_id: USER_ID, permissions: options.scopes || INSTAGRAM_OAUTH_SCOPES }] });
      }
      if (new URL(url).pathname === "/access_token") {
        return jsonResponse({ access_token: LONG_TOKEN, token_type: "bearer",
          expires_in: 5_184_000 });
      }
      if (new URL(url).pathname === "/v25.0/me") {
        return jsonResponse({ user_id: USER_ID,
          username: options.username || "meta_reviewer_own_account",
          name: "Synthetic professional reviewer", account_type: options.accountType || "BUSINESS" });
      }
      assert.fail("Unexpected injected provider path; real network is forbidden");
    }
  });
  const envelope = createInstagramOAuthStateEnvelope({
    derivationKey: KEY,
    keyVersion: "identity-v1",
    redirectUri: INSTAGRAM_OAUTH_REDIRECT_URI,
    clock: () => NOW
  });
  const oauthScope = {
    async createAuthorizationWithPendingConnection(input) {
      authorization = input;
      return { ...input, revision: 1, status: "pending" };
    },
    async consumeAuthorization(input) {
      if (consumed) throw Object.assign(new Error("consumed"),
        { code: "social_oauth_state_already_consumed" });
      assert.equal(input.state, authorization.state);
      consumed = true;
      return { connectionId: authorization.connectionId, connectionRevision: 1 };
    },
    async cancelAuthorization() { assert.fail("Unexpected cancellation"); },
    async expireAuthorization() { assert.fail("Unexpected expiration"); },
    async failAuthorizationConnection(input) { failures.push(input); },
    async getAuthorizationStatus() { return null; }
  };
  const storeScope = {
    async activateConnectionWithCredential(record, revision, credential, activation) {
      assert.equal(revision, 1);
      assert.equal(credential.syntheticEncrypted, true);
      stored.push({ record, activation });
      return { connection: record };
    },
    async disconnectConnectionLocally() { assert.fail("App Review must use guarded disconnect"); },
    async disconnectAppReviewConnectionLocally(id) {
      appReviewDisconnectCalls += 1;
      assert.equal(id, "57000000-0000-4000-8000-000000000099");
      if (options.disconnectBlocked) {
        throw Object.assign(new Error("active publication"), {
          code: "state_transition_invalid"
        });
      }
      assert.fail("No successful disconnect in focal");
    },
    async getConnectionDetails() { return null; },
    async getCurrentConnectionDetails() { return null; },
    async runExclusive(operation) { return operation(storeScope); }
  };
  const service = createInstagramOAuthService({
    config,
    stateEnvelope: envelope,
    provider,
    oauthRepository: { scope(value) { tenantScopes.push(value.companyId); return oauthScope; } },
    connectorStore: { scope(value) { tenantScopes.push(value.companyId); return storeScope; } },
    authAdapter: AUTH,
    credentials: {
      async withEncryptedConnectionCredential(input, operation) {
        assert.equal(input.companyId, stored.length ? stored[0].record.companyId : tenantScopes[0]);
        assert.equal(input.plaintext.toString(), LONG_TOKEN);
        try { return await operation({ syntheticEncrypted: true }); }
        finally { input.plaintext.fill(0); }
      }
    },
    clock: () => NOW,
    environment: options.contextEnvironment || "staging"
  });
  return { config, service, provider, envelope, requests, tenantScopes, stored, failures,
    appReviewDisconnectCalls: () => appReviewDisconnectCalls };
}

async function begin(h, company = APP_REVIEW_LOGIN) {
  const result = await h.service.authorize({ verifiedClaims: claims(company), purpose: "connect" });
  const url = new URL(result.authorizationUrl);
  assert.equal(url.origin, "https://www.instagram.com");
  assert.equal(url.pathname, "/oauth/authorize");
  assert.equal(url.searchParams.get("scope"), INSTAGRAM_OAUTH_SCOPES.join(","));
  return url.searchParams.get("state");
}

test("review policy is strictly opt-in, exact staging only, and cannot select Gate 4", () => {
  assert.equal(loadInstagramOAuthConfig({}).appReview.enabled, false);
  assert.equal(loadInstagramOAuthConfig({}).appReview.companyId, null);
  const closedDerived = loadInstagramOAuthConfig(environment({
    META_APP_REVIEW_COMPANY_ID: undefined,
    META_APP_REVIEW_WINDOW_ENABLED: "false"
  }));
  assert.equal(closedDerived.appReview.enabled, false);
  assert.equal(closedDerived.appReview.companyId, REVIEW_COMPANY);
  assert.equal(isAppReviewCompany(closedDerived, REVIEW_COMPANY), true);
  const openDerived = loadInstagramOAuthConfig(environment({
    META_APP_REVIEW_COMPANY_ID: undefined
  }));
  assert.equal(openDerived.appReview.enabled, true);
  assert.equal(openDerived.appReview.companyId, REVIEW_COMPANY);
  for (const env of [
    { META_APP_REVIEW_WINDOW_ENABLED: "TRUE" },
    { META_APP_REVIEW_WINDOW_ENABLED: "1" },
    { META_APP_REVIEW_COMPANY_ID: "arbitrary-customer" },
    { META_APP_REVIEW_COMPANY_ID: "00000000-0000-0000-0000-000000000000" },
    { META_APP_REVIEW_COMPANY_ID: "11111111-1111-4111-8111-111111111111" },
    { META_APP_REVIEW_COMPANY_ID: CONTROLLED_GATE4_COMPANY_ID },
    { META_APP_REVIEW_WINDOW_ENABLED: undefined, META_APP_REVIEW_COMPANY_ID: REVIEW_COMPANY },
    { ENVIRONMENT: "production" },
    { ENVIRONMENT: undefined },
    { REAL_REVIEWER_UI_ENABLED: "false" },
    { SOCIAL_INSTAGRAM_ENABLED: "false" },
    { PUBLIC_API_BASE_URL: "https://example.com" },
    { PUBLIC_API_BASE_URL: `${APP_REVIEW_STAGING_ORIGIN}/` }
  ]) {
    assert.throws(() => loadInstagramOAuthConfig(environment(env)),
      { code: "social_app_review_configuration_invalid" });
  }
});

test("only branded server-derived staging review context opens both operations", () => {
  const config = loadInstagramOAuthConfig(environment());
  const own = context(APP_REVIEW_LOGIN);
  assert.equal(isAppReviewCompany(config, REVIEW_COMPANY), true);
  assert.equal(isAppReviewCompany(config, CONTROLLED_GATE4_COMPANY_ID), false);
  for (const can of [canExternalConnection, canExternalPublication]) {
    assert.equal(can(config, own), true);
    assert.equal(can(config, context("other-tenant")), false);
    assert.equal(can(config, context(APP_REVIEW_LOGIN, "production")), false);
    assert.equal(can(config, context(APP_REVIEW_LOGIN, "test")), false);
    assert.throws(() => can(config, Object.freeze({ ...own })),
      { code: "social_context_invalid" });
    const closed = loadInstagramOAuthConfig(environment({
      META_APP_REVIEW_WINDOW_ENABLED: "false",
      SOCIAL_EXTERNAL_CONNECTION_ENABLED: "true",
      SOCIAL_EXTERNAL_PUBLICATION_ENABLED: "true"
    }));
    assert.equal(isAppReviewCompany(closed, own.companyId), true);
    assert.equal(can(closed, own), false);
    assert.equal(can(closed, context("other-tenant")), true);
  }
});

for (const [accountType, expected] of [["BUSINESS", "business"], ["MEDIA_CREATOR", "creator"]]) {
  test(`review OAuth official roundtrip accepts own ${expected} and persists exact scopes with zero browser secrets`, async () => {
    const h = harness({ accountType });
    try {
      const state = await begin(h);
      const result = await h.service.callback({ state, code: "synthetic-review-code", error: null });
      assert.equal(result.status, "authorization_completed");
      assert.equal(result.username, "@meta_reviewer_own_account");
      assert.equal(result.accountType, expected);
      assert.equal(h.requests.length, 3);
      assert.equal(h.stored.length, 1);
      assert.equal(h.stored[0].record.companyId, REVIEW_COMPANY);
      assert.deepEqual(h.stored[0].activation.grantedScopes, INSTAGRAM_OAUTH_SCOPES);
      assert.ok(h.tenantScopes.every((value) => value === REVIEW_COMPANY));
      for (const secret of [SHORT_TOKEN, LONG_TOKEN, APP_SECRET]) {
        assert.equal(JSON.stringify(result).includes(secret), false);
      }
      await assert.rejects(() => h.service.callback({ state, code: "synthetic-review-code", error: null }),
        { code: "social_oauth_state_already_consumed" });
      assert.equal(h.requests.length, 3);
    } finally { h.envelope.destroy(); }
  });
}

test("review rejects personal account, missing permission and extras before credential persistence", async () => {
  for (const options of [
    { accountType: "PERSONAL" },
    { scopes: [INSTAGRAM_OAUTH_SCOPES[0]] },
    { scopes: [...INSTAGRAM_OAUTH_SCOPES, "instagram_business_manage_messages"] }
  ]) {
    const h = harness(options);
    try {
      const state = await begin(h);
      await assert.rejects(() => h.service.callback({ state, code: "synthetic-review-code", error: null }));
      assert.equal(h.stored.length, 0);
      assert.equal(h.failures.length, 1);
    } finally { h.envelope.destroy(); }
  }
});

test("other tenant, forged authority and production context never reach provider or persistence", async () => {
  const h = harness();
  try {
    await assert.rejects(() => begin(h, "other-tenant"), { code: "external_capability_disabled" });
    await assert.rejects(() => h.service.authorize({
      verifiedClaims: claims("other-tenant"), purpose: "connect", companyId: REVIEW_COMPANY
    }));
    await assert.rejects(() => h.service.authorize({
      verifiedClaims: { ...claims("other-tenant"), company_id: APP_REVIEW_LOGIN }, purpose: "connect"
    }), { code: "social_authenticated_principal_invalid" });
    assert.equal(h.requests.length, 0);
    assert.equal(h.tenantScopes.length, 0);
    const fakeContext = Object.freeze({ ...context(APP_REVIEW_LOGIN) });
    await assert.rejects(() => h.provider.exchangeCode({ code: "synthetic-code" }, fakeContext));
    await assert.rejects(() => h.provider.exchangeCode({ code: "synthetic-code" }));
    assert.equal(h.requests.length, 0);
  } finally { h.envelope.destroy(); }
  const production = harness({ contextEnvironment: "production" });
  try {
    await assert.rejects(() => begin(production), { code: "external_capability_disabled" });
    assert.equal(production.requests.length, 0);
    assert.equal(production.tenantScopes.length, 0);
  } finally { production.envelope.destroy(); }
});

test("closed review window blocks authorization and pending callback without changing stored state", async () => {
  const h = harness();
  const closed = harness({ env: { META_APP_REVIEW_WINDOW_ENABLED: "false" } });
  try {
    const state = await begin(h);
    await assert.rejects(() => begin(closed), { code: "external_capability_disabled" });
    await assert.rejects(() => closed.service.callback({ state, code: "synthetic-code", error: null }),
      { code: "external_capability_disabled" });
    assert.equal(closed.requests.length, 0);
    assert.equal(closed.tenantScopes.length, 0);
  } finally { h.envelope.destroy(); closed.envelope.destroy(); }
});

test("App Review disconnect propagates the atomic active-publication conflict", async () => {
  const h = harness({ disconnectBlocked: true });
  try {
    await assert.rejects(h.service.disconnect({
      verifiedClaims: claims(APP_REVIEW_LOGIN),
      connectionId: "57000000-0000-4000-8000-000000000099"
    }), { code: "state_transition_invalid" });
    assert.equal(h.appReviewDisconnectCalls(), 1);
    assert.equal(PUBLIC_ERROR_STATUS.state_transition_invalid, 409);
    assert.equal(h.requests.length, 0);
  } finally {
    h.envelope.destroy();
  }
});

test("legacy tenant retains controlled username requirement when its normal gate is open", async () => {
  const h = harness({ env: { SOCIAL_EXTERNAL_CONNECTION_ENABLED: "true" } });
  try {
    const state = await begin(h, "legacy-gate4-like-tenant");
    await assert.rejects(() => h.service.callback({ state, code: "synthetic-code", error: null }),
      { code: "controlled_account_mismatch" });
    assert.equal(h.stored.length, 0);
  } finally { h.envelope.destroy(); }
});
