"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const {
  INSTAGRAM_AUTHORIZATION_ENDPOINT,
  INSTAGRAM_OAUTH_REDIRECT_URI,
  INSTAGRAM_OAUTH_SCOPES,
  INSTAGRAM_TOKEN_ENDPOINT,
  loadInstagramOAuthConfig
} = require("../src/social/oauth/instagram-config");
const {
  INSTAGRAM_OAUTH_STATE_CSRF_BYTES,
  INSTAGRAM_OAUTH_STATE_HKDF_INFO,
  INSTAGRAM_OAUTH_STATE_HKDF_SALT,
  INSTAGRAM_OAUTH_STATE_IV_BYTES,
  INSTAGRAM_OAUTH_STATE_MAX_LENGTH,
  INSTAGRAM_OAUTH_STATE_TAG_BYTES,
  INSTAGRAM_OAUTH_STATE_TTL_MS,
  createInstagramOAuthStateEnvelope,
  isAuthenticatedInstagramOAuthState
} = require("../src/social/oauth/instagram-state-envelope");
const {
  INSTAGRAM_EXCHANGE_MAX_RESPONSE_BYTES,
  createInstagramProvider
} = require("../src/social/oauth/instagram-provider");

const IDENTITY_KEY = Buffer.alloc(32, 0x37);
const KEY_VERSION = "identity.v1";
const KEY_VERSION_SEGMENT = Buffer.from(KEY_VERSION, "utf8")
  .toString("base64url");
const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const AUTHORIZATION_HANDLE =
  "33333333-3333-4333-8333-333333333333";
const SESSION_JTI = "synthetic-session-jti-0001";
const SYNTHETIC_APP_SECRET =
  "synthetic-not-authenticable-app-material";

function enabledEnvironment(overrides = {}) {
  return {
    SOCIAL_INSTAGRAM_ENABLED: "true",
    SOCIAL_EXTERNAL_CONNECTION_ENABLED: "true",
    SOCIAL_EXTERNAL_PUBLICATION_ENABLED: "false",
    INSTAGRAM_APP_ID: "100000000000001",
    INSTAGRAM_APP_SECRET: SYNTHETIC_APP_SECRET,
    INSTAGRAM_OAUTH_REDIRECT_URI,
    INSTAGRAM_GRAPH_API_VERSION: "v23.0",
    ...overrides
  };
}

function issuedInput(overrides = {}) {
  return {
    purpose: "connect",
    companyId: COMPANY_ID,
    userId: USER_ID,
    sessionJti: SESSION_JTI,
    authorizationHandle: AUTHORIZATION_HANDLE,
    returnPathId: "social_connections",
    ...overrides
  };
}

function deterministicRandomBytes(size) {
  return Buffer.alloc(size, size);
}

function createEnvelope(options = {}) {
  return createInstagramOAuthStateEnvelope({
    derivationKey: IDENTITY_KEY,
    keyVersion: KEY_VERSION,
    redirectUri: INSTAGRAM_OAUTH_REDIRECT_URI,
    clock: () => 1_800_000_000_000,
    randomBytes: deterministicRandomBytes,
    ...options
  });
}

function response(body, overrides = {}) {
  const serialized = typeof body === "string" ? body : JSON.stringify(body);
  return {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-length": String(Buffer.byteLength(serialized))
    },
    body: serialized,
    ...overrides
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createManualTimer() {
  let active;
  let latestHandle;
  let setCalls = 0;
  let clearCalls = 0;
  let fireCalls = 0;
  return {
    setTimeout(callback, delay) {
      assert.equal(typeof callback, "function");
      assert.equal(Number.isSafeInteger(delay), true);
      assert.equal(active, undefined);
      latestHandle = Object.freeze({ id: ++setCalls });
      active = { callback, handle: latestHandle };
      return latestHandle;
    },
    clearTimeout(handle) {
      assert.equal(handle, latestHandle);
      clearCalls += 1;
      if (active?.handle === handle) active = undefined;
    },
    fire() {
      assert.ok(active);
      const { callback } = active;
      active = undefined;
      fireCalls += 1;
      callback();
    },
    snapshot() {
      return Object.freeze({
        setCalls,
        clearCalls,
        fireCalls,
        activeTimers: active ? 1 : 0
      });
    }
  };
}

async function settleUntil(predicate) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.equal(predicate(), true);
}

function streamingResponse(reader, overrides = {}) {
  let getReaderCalls = 0;
  return {
    response: {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8"
      },
      body: {
        getReader() {
          getReaderCalls += 1;
          return reader;
        }
      },
      ...overrides
    },
    getReaderCalls: () => getReaderCalls
  };
}

function flipBase64url(value) {
  const replacement = value[0] === "A" ? "B" : "A";
  return replacement + value.slice(1);
}

function forgeState({
  expiresAt = 1_800_000_000_000 + INSTAGRAM_OAUTH_STATE_TTL_MS,
  aadRedirectUri = INSTAGRAM_OAUTH_REDIRECT_URI
} = {}) {
  const payload = Buffer.from(JSON.stringify({
    version: "v1",
    provider: "instagram",
    purpose: "connect",
    companyId: COMPANY_ID,
    userId: USER_ID,
    sessionJti: SESSION_JTI,
    authorizationHandle: AUTHORIZATION_HANDLE,
    issuedAt: 1_800_000_000_000,
    expiresAt,
    returnPathId: "social_connections",
    csrfNonce: Buffer.alloc(
      INSTAGRAM_OAUTH_STATE_CSRF_BYTES,
      INSTAGRAM_OAUTH_STATE_CSRF_BYTES
    ).toString("base64url")
  }), "utf8");
  const aad = Buffer.from(JSON.stringify({
    product: "ia4tube",
    version: "v1",
    provider: "instagram",
    purpose: "oauth",
    redirectUri: aadRedirectUri,
    keyVersion: KEY_VERSION
  }), "utf8");
  const key = Buffer.from(crypto.hkdfSync(
    "sha256",
    IDENTITY_KEY,
    Buffer.from(INSTAGRAM_OAUTH_STATE_HKDF_SALT),
    Buffer.from(INSTAGRAM_OAUTH_STATE_HKDF_INFO),
    32
  ));
  const iv = Buffer.alloc(INSTAGRAM_OAUTH_STATE_IV_BYTES, 0x29);
  let ciphertext;
  let tag;
  try {
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv, {
      authTagLength: INSTAGRAM_OAUTH_STATE_TAG_BYTES
    });
    cipher.setAAD(aad);
    ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
    tag = cipher.getAuthTag();
    return [
      "v1",
      KEY_VERSION_SEGMENT,
      iv.toString("base64url"),
      ciphertext.toString("base64url"),
      tag.toString("base64url")
    ].join(".");
  } finally {
    payload.fill(0);
    aad.fill(0);
    key.fill(0);
    iv.fill(0);
    if (ciphertext) ciphertext.fill(0);
    if (tag) tag.fill(0);
  }
}

test("Instagram OAuth configuration defaults every external gate off", () => {
  const config = loadInstagramOAuthConfig({});
  assert.equal(config.enabled, false);
  assert.equal(config.instagramEnabled, false);
  assert.equal(config.externalConnectionEnabled, false);
  assert.equal(config.externalPublicationEnabled, false);
  assert.equal(config.appId, null);
  assert.equal(config.appSecret, null);
  assert.equal(config.redirectUri, INSTAGRAM_OAUTH_REDIRECT_URI);
  assert.deepEqual(config.scopes, INSTAGRAM_OAUTH_SCOPES);
  assert.equal(Object.isFrozen(config), true);
});

test("Instagram OAuth flags are exact and publication is staging-only", () => {
  for (const invalid of ["", "TRUE", " true", "false ", "1", true]) {
    assert.throws(
      () => loadInstagramOAuthConfig({
        SOCIAL_INSTAGRAM_ENABLED: invalid
      }),
      { code: "social_instagram_feature_flag_invalid" }
    );
  }
  assert.throws(
    () => loadInstagramOAuthConfig({
      SOCIAL_EXTERNAL_PUBLICATION_ENABLED: "true"
    }),
    { code: "social_instagram_publication_forbidden" }
  );
  const readOnlyPublication = loadInstagramOAuthConfig(enabledEnvironment({
    SOCIAL_EXTERNAL_PUBLICATION_ENABLED: "false",
    SOCIAL_INSTAGRAM_EXPECTED_USERNAME: "@ia4tube_empresas",
    PUBLIC_API_BASE_URL:
      "https://ia4tube-api-staging-checkpoint-a.onrender.com"
  }));
  assert.equal(readOnlyPublication.enabled, true);
  assert.equal(readOnlyPublication.externalConnectionEnabled, true);
  assert.equal(readOnlyPublication.externalPublicationEnabled, false);
  assert.equal(
    readOnlyPublication.publicOrigin,
    "https://ia4tube-api-staging-checkpoint-a.onrender.com"
  );
  const publication = loadInstagramOAuthConfig(enabledEnvironment({
    SOCIAL_EXTERNAL_PUBLICATION_ENABLED: "true",
    SOCIAL_INSTAGRAM_EXPECTED_USERNAME: "@ia4tube_empresas",
    PUBLIC_API_BASE_URL:
      "https://ia4tube-api-staging-checkpoint-a.onrender.com"
  }));
  assert.equal(publication.externalPublicationEnabled, true);
  assert.equal(
    publication.publicOrigin,
    "https://ia4tube-api-staging-checkpoint-a.onrender.com"
  );
  for (const override of [
    { SOCIAL_INSTAGRAM_EXPECTED_USERNAME: "@another_account" },
    { PUBLIC_API_BASE_URL: "https://example.invalid" },
    { SOCIAL_EXTERNAL_CONNECTION_ENABLED: "false" }
  ]) {
    assert.throws(
      () => loadInstagramOAuthConfig(enabledEnvironment({
        SOCIAL_EXTERNAL_PUBLICATION_ENABLED: "true",
        SOCIAL_INSTAGRAM_EXPECTED_USERNAME: "@ia4tube_empresas",
        PUBLIC_API_BASE_URL:
          "https://ia4tube-api-staging-checkpoint-a.onrender.com",
        ...override
      })),
      { code: "social_instagram_publication_forbidden" }
    );
  }
});

test("enabled Instagram OAuth configuration is closed to exact public values", () => {
  const config = loadInstagramOAuthConfig(enabledEnvironment());
  assert.equal(config.enabled, true);
  assert.equal(config.authorizationEndpoint, INSTAGRAM_AUTHORIZATION_ENDPOINT);
  assert.equal(config.tokenEndpoint, INSTAGRAM_TOKEN_ENDPOINT);
  assert.equal(config.redirectUri, INSTAGRAM_OAUTH_REDIRECT_URI);
  assert.deepEqual(config.scopes, [
    "instagram_business_basic",
    "instagram_business_content_publish"
  ]);

  for (const override of [
    { INSTAGRAM_APP_ID: "synthetic-app" },
    { INSTAGRAM_APP_SECRET: "short" },
    { INSTAGRAM_OAUTH_REDIRECT_URI: `${INSTAGRAM_OAUTH_REDIRECT_URI}/other` },
    { INSTAGRAM_GRAPH_API_VERSION: "latest" }
  ]) {
    assert.throws(() => loadInstagramOAuthConfig(
      enabledEnvironment(override)
    ));
  }
});

test("state envelope uses the authorized HKDF domain and protected compact form", () => {
  assert.equal(
    INSTAGRAM_OAUTH_STATE_HKDF_SALT,
    "ia4tube-social-oauth-state-v1"
  );
  assert.equal(
    INSTAGRAM_OAUTH_STATE_HKDF_INFO,
    "instagram-oauth-state-envelope"
  );
  const envelope = createEnvelope();
  const state = envelope.seal(issuedInput());
  const segments = state.split(".");
  assert.equal(segments.length, 5);
  assert.equal(segments[0], "v1");
  assert.equal(segments[1], KEY_VERSION_SEGMENT);
  assert.equal(Buffer.from(segments[1], "base64url").toString("utf8"), KEY_VERSION);
  assert.equal(
    Buffer.from(segments[2], "base64url").length,
    INSTAGRAM_OAUTH_STATE_IV_BYTES
  );
  assert.equal(
    Buffer.from(segments[4], "base64url").length,
    INSTAGRAM_OAUTH_STATE_TAG_BYTES
  );
  assert.ok(state.length <= INSTAGRAM_OAUTH_STATE_MAX_LENGTH);
  for (const protectedValue of [
    COMPANY_ID,
    USER_ID,
    SESSION_JTI,
    AUTHORIZATION_HANDLE
  ]) {
    assert.equal(state.includes(protectedValue), false);
  }

  const opened = envelope.open(state);
  assert.equal(isAuthenticatedInstagramOAuthState(opened), true);
  assert.equal(isAuthenticatedInstagramOAuthState({ ...opened }), false);
  assert.equal(Object.isFrozen(opened), true);
  assert.deepEqual(opened, {
    version: "v1",
    provider: "instagram",
    purpose: "connect",
    companyId: COMPANY_ID,
    userId: USER_ID,
    sessionJti: SESSION_JTI,
    authorizationHandle: AUTHORIZATION_HANDLE,
    issuedAt: 1_800_000_000_000,
    expiresAt: 1_800_000_000_000 + INSTAGRAM_OAUTH_STATE_TTL_MS,
    returnPathId: "social_connections",
    csrfNonce: Buffer.alloc(
      INSTAGRAM_OAUTH_STATE_CSRF_BYTES,
      INSTAGRAM_OAUTH_STATE_CSRF_BYTES
    ).toString("base64url")
  });
  assert.equal(
    Buffer.from(opened.csrfNonce, "base64url").length,
    INSTAGRAM_OAUTH_STATE_CSRF_BYTES
  );
  envelope.destroy();
});

test("state envelope rejects IV, ciphertext, tag, key version and encoding tampering", () => {
  const envelope = createEnvelope();
  const state = envelope.seal(issuedInput());
  const original = state.split(".");
  const candidates = [
    [original[0], original[1], flipBase64url(original[2]), original[3], original[4]],
    [original[0], original[1], original[2], flipBase64url(original[3]), original[4]],
    [original[0], original[1], original[2], original[3], flipBase64url(original[4])],
    [
      original[0],
      Buffer.from("unknown.v1", "utf8").toString("base64url"),
      original[2],
      original[3],
      original[4]
    ],
    [original[0], KEY_VERSION, original[2], original[3], original[4]],
    [original[0], `${KEY_VERSION_SEGMENT}=`, original[2], original[3], original[4]],
    [original[0], original[1], "not=base64url", original[3], original[4]],
    original.slice(0, 4)
  ];
  for (const segments of candidates) {
    for (const open of [
      envelope.open,
      envelope.openForCallback
    ]) {
      assert.throws(
        () => open(segments.join(".")),
        { code: "social_oauth_state_invalid" }
      );
    }
  }
  envelope.destroy();
});

test("state envelope enforces future skew, expiry, return allowlist and lifetime", () => {
  let now = 1_800_000_000_000;
  const envelope = createEnvelope({ clock: () => now });
  const state = envelope.seal(issuedInput());
  assert.throws(
    () => envelope.seal(issuedInput({ returnPathId: "https_external" })),
    { code: "social_oauth_state_invalid" }
  );
  now += INSTAGRAM_OAUTH_STATE_TTL_MS;
  assert.throws(
    () => envelope.open(state),
    { code: "social_oauth_state_expired" }
  );
  const callbackPayload = envelope.openForCallback(state);
  assert.equal(
    isAuthenticatedInstagramOAuthState(callbackPayload),
    true
  );
  assert.deepEqual(Object.keys(callbackPayload), [
    "version",
    "provider",
    "purpose",
    "companyId",
    "userId",
    "sessionJti",
    "authorizationHandle",
    "issuedAt",
    "expiresAt",
    "returnPathId",
    "csrfNonce"
  ]);
  assert.equal(callbackPayload.expiresAt <= now, true);
  envelope.destroy();
  assert.throws(
    () => envelope.open(state),
    { code: "social_oauth_state_invalid" }
  );
  assert.throws(
    () => envelope.openForCallback(state),
    { code: "social_oauth_state_invalid" }
  );

  const producer = createEnvelope({ clock: () => 100_000 });
  const futureState = producer.seal(issuedInput());
  const consumer = createEnvelope({ clock: () => 0 });
  assert.throws(
    () => consumer.open(futureState),
    { code: "social_oauth_state_invalid" }
  );
  assert.throws(
    () => consumer.openForCallback(futureState),
    { code: "social_oauth_state_invalid" }
  );
  producer.destroy();
  consumer.destroy();
});

test("callback opening does not relax AAD or maximum TTL validation", () => {
  const envelope = createEnvelope();
  const invalidStates = [
    forgeState({
      aadRedirectUri: `${INSTAGRAM_OAUTH_REDIRECT_URI}/other`
    }),
    forgeState({
      expiresAt:
        1_800_000_000_000 + INSTAGRAM_OAUTH_STATE_TTL_MS + 1
    })
  ];
  for (const state of invalidStates) {
    assert.throws(
      () => envelope.open(state),
      { code: "social_oauth_state_invalid" }
    );
    assert.throws(
      () => envelope.openForCallback(state),
      { code: "social_oauth_state_invalid" }
    );
  }
  envelope.destroy();
});

test("state subkey is deterministic for the root and separated from another root", () => {
  const state = createEnvelope().seal(issuedInput());
  const matching = createEnvelope();
  assert.equal(matching.open(state).companyId, COMPANY_ID);
  matching.destroy();

  const otherRoot = createEnvelope({
    derivationKey: Buffer.alloc(32, 0x38)
  });
  assert.throws(
    () => otherRoot.open(state),
    { code: "social_oauth_state_invalid" }
  );
  assert.throws(
    () => otherRoot.openForCallback(state),
    { code: "social_oauth_state_invalid" }
  );
  otherRoot.destroy();
});

test("provider builds the official URL without transport or secret exposure", () => {
  let calls = 0;
  const config = loadInstagramOAuthConfig(enabledEnvironment());
  const provider = createInstagramProvider({
    config,
    transport: async () => {
      calls += 1;
      throw new Error("transport must not run");
    }
  });
  const state = createEnvelope().seal(issuedInput());
  const authorizationUrl = provider.buildAuthorizationUrl({ state });
  const parsed = new URL(authorizationUrl);
  assert.equal(parsed.origin + parsed.pathname, INSTAGRAM_AUTHORIZATION_ENDPOINT);
  assert.equal(parsed.searchParams.get("client_id"), config.appId);
  assert.equal(
    parsed.searchParams.get("redirect_uri"),
    INSTAGRAM_OAUTH_REDIRECT_URI
  );
  assert.equal(parsed.searchParams.get("response_type"), "code");
  assert.equal(parsed.searchParams.get("state"), state);
  assert.deepEqual(
    parsed.searchParams.get("scope").split(","),
    INSTAGRAM_OAUTH_SCOPES
  );
  assert.equal(parsed.searchParams.get("enable_fb_login"), "0");
  assert.equal(parsed.searchParams.has("force_authentication"), false);
  assert.equal(parsed.searchParams.has("force_reauth"), false);
  assert.equal(authorizationUrl.includes(SYNTHETIC_APP_SECRET), false);
  assert.equal(calls, 0);
});

test("provider exchanges one code through injected transport and sanitizes output", async () => {
  const config = loadInstagramOAuthConfig(enabledEnvironment());
  const calls = [];
  const evidence = [];
  const timer = createManualTimer();
  const provider = createInstagramProvider({
    config,
    logger: {
      info(event) {
        evidence.push(event);
      }
    },
    setTimeout: timer.setTimeout,
    clearTimeout: timer.clearTimeout,
    transport: async (url, options) => {
      calls.push({ url, options });
      return response({
        access_token: "synthetic-token-not-authenticable",
        user_id: "synthetic-instagram-user-001",
        ignored_remote_field: "ignored"
      });
    }
  });
  const result = await provider.exchangeCode({
    code: "synthetic-code-not-authenticable"
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, INSTAGRAM_TOKEN_ENDPOINT);
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.signal instanceof AbortSignal, true);
  assert.equal(
    calls[0].options.headers["content-type"],
    "application/x-www-form-urlencoded"
  );
  const form = new URLSearchParams(calls[0].options.body);
  assert.equal(form.get("client_id"), config.appId);
  assert.equal(form.get("client_secret"), SYNTHETIC_APP_SECRET);
  assert.equal(form.get("grant_type"), "authorization_code");
  assert.equal(form.get("redirect_uri"), INSTAGRAM_OAUTH_REDIRECT_URI);
  assert.equal(form.get("code"), "synthetic-code-not-authenticable");
  assert.deepEqual(
    result.accessToken,
    Buffer.from("synthetic-token-not-authenticable")
  );
  assert.equal(result.userId, "synthetic-instagram-user-001");
  assert.deepEqual(Object.keys(result), [
    "accessToken",
    "userId",
    "grantedScopes"
  ]);
  assert.deepEqual(result.grantedScopes, []);
  assert.deepEqual(evidence, [{
    component: "social_instagram_oauth",
    event: "provider_scope_evidence",
    responseFormat: "flat_object",
    permissionsFormat: "absent",
    grantedScopeNames: []
  }]);
  assert.deepEqual(timer.snapshot(), {
    setCalls: 1,
    clearCalls: 1,
    fireCalls: 0,
    activeTimers: 0
  });
  result.accessToken.fill(0);
});

test("provider rejects unsafe remote responses without exposing their body", async () => {
  const rawRemote = "remote-private-material-must-not-escape";
  const cases = [
    response({ access_token: "synthetic", user_id: "user" }, { status: 429 }),
    response({ access_token: "synthetic", user_id: "user" }, {
      headers: { "content-type": "text/plain" }
    }),
    response("{not-json"),
    response({ user_id: "user" }),
    response({ access_token: "synthetic" }),
    response({ access_token: "", user_id: "user" }),
    response(rawRemote, {
      headers: {
        "content-type": "application/json",
        "content-length": String(INSTAGRAM_EXCHANGE_MAX_RESPONSE_BYTES + 1)
      }
    })
  ];
  for (const remoteResponse of cases) {
    const timer = createManualTimer();
    const provider = createInstagramProvider({
      config: loadInstagramOAuthConfig(enabledEnvironment()),
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
      transport: async () => remoteResponse
    });
    let failure;
    try {
      await provider.exchangeCode({ code: "synthetic-code" });
    } catch (error) {
      failure = error;
    }
    assert.equal(failure?.code, "social_oauth_exchange_failed");
    assert.equal(String(failure?.message).includes(rawRemote), false);
    assert.equal(String(failure?.stack).includes(rawRemote), false);
    assert.equal(String(failure?.stack).includes(SYNTHETIC_APP_SECRET), false);
    assert.deepEqual(timer.snapshot(), {
      setCalls: 1,
      clearCalls: 1,
      fireCalls: 0,
      activeTimers: 0
    });
  }
});

test("provider timeout aborts the single request and never retries", async () => {
  let calls = 0;
  let aborted = false;
  let pendingTransports = 0;
  const timer = createManualTimer();
  const provider = createInstagramProvider({
    config: loadInstagramOAuthConfig(enabledEnvironment()),
    timeoutMs: 5000,
    setTimeout: timer.setTimeout,
    clearTimeout: timer.clearTimeout,
    transport: async (url, options) => {
      calls += 1;
      pendingTransports += 1;
      return new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          aborted = true;
          pendingTransports -= 1;
          reject(new Error("synthetic transport aborted"));
        }, { once: true });
      });
    }
  });
  const exchange = provider.exchangeCode({
    code: "synthetic-timeout-code"
  });
  await settleUntil(() => calls === 1);
  timer.fire();
  await assert.rejects(
    exchange,
    { code: "social_oauth_exchange_failed" }
  );
  assert.equal(calls, 1);
  assert.equal(aborted, true);
  assert.equal(pendingTransports, 0);
  assert.deepEqual(timer.snapshot(), {
    setCalls: 1,
    clearCalls: 1,
    fireCalls: 1,
    activeTimers: 0
  });
});

test("provider timeout covers a blocked response body with one total budget", async () => {
  let transportCalls = 0;
  let readCalls = 0;
  let cancelCalls = 0;
  let releaseCalls = 0;
  let pendingReads = 0;
  let transportSignal;
  let blockedRead;
  const timer = createManualTimer();
  const reader = {
    read() {
      readCalls += 1;
      pendingReads += 1;
      blockedRead = deferred();
      return blockedRead.promise.finally(() => {
        pendingReads -= 1;
      });
    },
    cancel() {
      cancelCalls += 1;
      const abortError = new Error("synthetic blocked body aborted");
      abortError.name = "AbortError";
      blockedRead?.reject(abortError);
      return Promise.resolve();
    },
    releaseLock() {
      releaseCalls += 1;
    }
  };
  const streamed = streamingResponse(reader);
  const provider = createInstagramProvider({
    config: loadInstagramOAuthConfig(enabledEnvironment()),
    timeoutMs: 5000,
    setTimeout: timer.setTimeout,
    clearTimeout: timer.clearTimeout,
    transport: async (url, options) => {
      transportCalls += 1;
      transportSignal = options.signal;
      return streamed.response;
    }
  });
  const exchange = provider.exchangeCode({
    code: "synthetic-blocked-body-code"
  });
  await settleUntil(() => readCalls === 1);
  assert.deepEqual(timer.snapshot(), {
    setCalls: 1,
    clearCalls: 0,
    fireCalls: 0,
    activeTimers: 1
  });
  timer.fire();
  await assert.rejects(exchange, { code: "social_oauth_exchange_failed" });
  await settleUntil(() => pendingReads === 0);
  assert.equal(transportCalls, 1);
  assert.equal(streamed.getReaderCalls(), 1);
  assert.equal(readCalls, 1);
  assert.equal(cancelCalls, 1);
  assert.equal(releaseCalls, 1);
  assert.equal(pendingReads, 0);
  assert.equal(transportSignal.aborted, true);
  assert.deepEqual(timer.snapshot(), {
    setCalls: 1,
    clearCalls: 1,
    fireCalls: 1,
    activeTimers: 0
  });
});

test("provider accepts a streamed body that completes before the same deadline", async () => {
  const serialized = Buffer.from(JSON.stringify({
    access_token: "synthetic-stream-token",
    user_id: "synthetic-stream-user"
  }));
  const firstRead = deferred();
  let readCalls = 0;
  let cancelCalls = 0;
  let releaseCalls = 0;
  const timer = createManualTimer();
  const reader = {
    read() {
      readCalls += 1;
      if (readCalls === 1) return firstRead.promise;
      return Promise.resolve({ done: true });
    },
    cancel() {
      cancelCalls += 1;
      return Promise.resolve();
    },
    releaseLock() {
      releaseCalls += 1;
    }
  };
  const streamed = streamingResponse(reader);
  const provider = createInstagramProvider({
    config: loadInstagramOAuthConfig(enabledEnvironment()),
    timeoutMs: 5000,
    setTimeout: timer.setTimeout,
    clearTimeout: timer.clearTimeout,
    transport: async () => streamed.response
  });
  const exchange = provider.exchangeCode({
    code: "synthetic-before-deadline-code"
  });
  await settleUntil(() => readCalls === 1);
  assert.equal(timer.snapshot().setCalls, 1);
  firstRead.resolve({ done: false, value: serialized });
  const result = await exchange;
  assert.equal(result.userId, "synthetic-stream-user");
  assert.deepEqual(result.accessToken, Buffer.from("synthetic-stream-token"));
  assert.equal(streamed.getReaderCalls(), 1);
  assert.equal(readCalls, 2);
  assert.equal(cancelCalls, 0);
  assert.equal(releaseCalls, 1);
  assert.deepEqual(timer.snapshot(), {
    setCalls: 1,
    clearCalls: 1,
    fireCalls: 0,
    activeTimers: 0
  });
  result.accessToken.fill(0);
  serialized.fill(0);
});

test("provider preserves arrayBuffer and text transport response compatibility", async () => {
  const variants = [
    {
      name: "arrayBuffer",
      response: {
        status: 200,
        headers: { "content-type": "application/json" },
        arrayBuffer: async () => Buffer.from(JSON.stringify({
          access_token: "synthetic-array-buffer-token",
          user_id: "synthetic-array-buffer-user"
        }))
      },
      expectedToken: "synthetic-array-buffer-token",
      expectedUser: "synthetic-array-buffer-user"
    },
    {
      name: "text",
      response: {
        status: 200,
        headers: { "content-type": "application/json" },
        text: async () => JSON.stringify({
          access_token: "synthetic-text-token",
          user_id: "synthetic-text-user"
        })
      },
      expectedToken: "synthetic-text-token",
      expectedUser: "synthetic-text-user"
    }
  ];
  for (const variant of variants) {
    let transportCalls = 0;
    const timer = createManualTimer();
    const provider = createInstagramProvider({
      config: loadInstagramOAuthConfig(enabledEnvironment()),
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
      transport: async () => {
        transportCalls += 1;
        return variant.response;
      }
    });
    const result = await provider.exchangeCode({
      code: `synthetic-${variant.name}-code`
    });
    assert.equal(transportCalls, 1);
    assert.equal(result.userId, variant.expectedUser);
    assert.deepEqual(result.accessToken, Buffer.from(variant.expectedToken));
    assert.deepEqual(timer.snapshot(), {
      setCalls: 1,
      clearCalls: 1,
      fireCalls: 0,
      activeTimers: 0
    });
    result.accessToken.fill(0);
  }
});

test("provider applies the same deadline to a blocked arrayBuffer response", async () => {
  let transportCalls = 0;
  let arrayBufferCalls = 0;
  let pendingBodies = 0;
  let transportSignal;
  let blockedBody;
  const timer = createManualTimer();
  const provider = createInstagramProvider({
    config: loadInstagramOAuthConfig(enabledEnvironment()),
    timeoutMs: 5000,
    setTimeout: timer.setTimeout,
    clearTimeout: timer.clearTimeout,
    transport: async (url, options) => {
      transportCalls += 1;
      transportSignal = options.signal;
      blockedBody = deferred();
      options.signal.addEventListener("abort", () => {
        const abortError = new Error("synthetic arrayBuffer aborted");
        abortError.name = "AbortError";
        blockedBody.reject(abortError);
      }, { once: true });
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        arrayBuffer() {
          arrayBufferCalls += 1;
          pendingBodies += 1;
          return blockedBody.promise.finally(() => {
            pendingBodies -= 1;
          });
        }
      };
    }
  });
  const exchange = provider.exchangeCode({
    code: "synthetic-blocked-array-buffer-code"
  });
  await settleUntil(() => arrayBufferCalls === 1);
  timer.fire();
  await assert.rejects(exchange, { code: "social_oauth_exchange_failed" });
  await settleUntil(() => pendingBodies === 0);
  assert.equal(transportCalls, 1);
  assert.equal(arrayBufferCalls, 1);
  assert.equal(pendingBodies, 0);
  assert.equal(transportSignal.aborted, true);
  assert.deepEqual(timer.snapshot(), {
    setCalls: 1,
    clearCalls: 1,
    fireCalls: 1,
    activeTimers: 0
  });
});

test("provider cancels an oversized streamed body without retry", async () => {
  let transportCalls = 0;
  let readCalls = 0;
  let cancelCalls = 0;
  let releaseCalls = 0;
  const timer = createManualTimer();
  const oversized = Buffer.alloc(INSTAGRAM_EXCHANGE_MAX_RESPONSE_BYTES + 1, 0x61);
  const reader = {
    read() {
      readCalls += 1;
      return Promise.resolve({ done: false, value: oversized });
    },
    cancel() {
      cancelCalls += 1;
      return Promise.resolve();
    },
    releaseLock() {
      releaseCalls += 1;
    }
  };
  const streamed = streamingResponse(reader);
  const provider = createInstagramProvider({
    config: loadInstagramOAuthConfig(enabledEnvironment()),
    setTimeout: timer.setTimeout,
    clearTimeout: timer.clearTimeout,
    transport: async () => {
      transportCalls += 1;
      return streamed.response;
    }
  });
  await assert.rejects(
    provider.exchangeCode({ code: "synthetic-oversized-body-code" }),
    { code: "social_oauth_exchange_failed" }
  );
  assert.equal(transportCalls, 1);
  assert.equal(readCalls, 1);
  assert.equal(cancelCalls, 1);
  assert.equal(releaseCalls, 1);
  assert.deepEqual(timer.snapshot(), {
    setCalls: 1,
    clearCalls: 1,
    fireCalls: 0,
    activeTimers: 0
  });
  oversized.fill(0);
});

test("provider normalizes an external AbortError without firing its timer", async () => {
  let calls = 0;
  const timer = createManualTimer();
  const provider = createInstagramProvider({
    config: loadInstagramOAuthConfig(enabledEnvironment()),
    setTimeout: timer.setTimeout,
    clearTimeout: timer.clearTimeout,
    transport: async () => {
      calls += 1;
      const abortError = new Error("synthetic external abort detail");
      abortError.name = "AbortError";
      throw abortError;
    }
  });
  await assert.rejects(
    provider.exchangeCode({ code: "synthetic-external-abort-code" }),
    { code: "social_oauth_exchange_failed" }
  );
  assert.equal(calls, 1);
  assert.deepEqual(timer.snapshot(), {
    setCalls: 1,
    clearCalls: 1,
    fireCalls: 0,
    activeTimers: 0
  });
});

test("provider refuses construction while connection gates are disabled", () => {
  const disabled = loadInstagramOAuthConfig({});
  assert.throws(
    () => createInstagramProvider({
      config: disabled,
      transport: async () => response({})
    }),
    { code: "social_oauth_exchange_failed" }
  );
});
