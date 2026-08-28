"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  INSTAGRAM_GRAPH_API_ORIGIN,
  INSTAGRAM_LONG_LIVED_TOKEN_ENDPOINT,
  INSTAGRAM_OAUTH_REDIRECT_URI,
  INSTAGRAM_OAUTH_SCOPES,
  INSTAGRAM_PROFESSIONAL_ACCOUNT_API_VERSION,
  INSTAGRAM_TOKEN_ENDPOINT,
  loadInstagramOAuthConfig
} = require("../src/social/oauth/instagram-config");
const {
  createInstagramProvider,
  sanitizeInstagramDiscoveryEvidence
} = require("../src/social/oauth/instagram-provider");

const APP_SECRET = "synthetic-provider-contract-app-secret";
const SHORT_TOKEN = "synthetic-short-lived-token";
const LONG_TOKEN = "synthetic-long-lived-token";
const USER_ID = "17841400000000001";
const PROFESSIONAL_USER_ID = "17841400000000991";
const LARGE_NUMERIC_USER_ID = "17841498765432109";
const CORRELATION_ID = "10000000-0000-4000-8000-000000000099";
const OBSERVED_AT = 1_800_000_000_000;
const EXPIRES_IN = 5_184_000;

function enabledEnvironment(overrides = {}) {
  return {
    SOCIAL_INSTAGRAM_ENABLED: "true",
    SOCIAL_EXTERNAL_CONNECTION_ENABLED: "true",
    SOCIAL_EXTERNAL_PUBLICATION_ENABLED: "false",
    INSTAGRAM_APP_ID: "100000000000001",
    INSTAGRAM_APP_SECRET: APP_SECRET,
    INSTAGRAM_OAUTH_REDIRECT_URI,
    INSTAGRAM_GRAPH_API_VERSION: INSTAGRAM_PROFESSIONAL_ACCOUNT_API_VERSION,
    ...overrides
  };
}

function jsonTextResponse(serialized, overrides = {}) {
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

function jsonResponse(body, overrides = {}) {
  return jsonTextResponse(JSON.stringify(body), overrides);
}

function providerWithTransport(transport, overrides = {}) {
  return createInstagramProvider({
    config: loadInstagramOAuthConfig(enabledEnvironment()),
    transport,
    clock: () => OBSERVED_AT,
    ...overrides
  });
}

function discoveryHarness(transport, overrides = {}) {
  const evidence = [];
  const provider = providerWithTransport(transport, {
    logger: { info(event) { evidence.push(event); } },
    ...overrides
  });
  async function discover() {
    const accessToken = Buffer.from(LONG_TOKEN);
    try {
      return await provider.discoverProfessionalAccount({
        accessToken,
        userId: USER_ID,
        correlationId: CORRELATION_ID
      });
    } finally {
      accessToken.fill(0);
    }
  }
  return { discover, evidence };
}

function accountDiscoveryHarness(accountType, overrides = {}) {
  return discoveryHarness(async () => jsonResponse({
    user_id: USER_ID,
    username: "ia4tube_empresas",
    name: "IA4Tube Empresas",
    account_type: accountType,
    ...overrides
  }));
}

async function assertEligibleAccountType(remoteType, expectedType) {
  const harness = accountDiscoveryHarness(remoteType);
  const account = await harness.discover();
  assert.equal(account.accountType, expectedType);
  assert.equal(harness.evidence.length, 1);
  assert.equal(harness.evidence[0].accountTypeRaw, remoteType);
  assert.equal(harness.evidence[0].accountTypeNormalized, expectedType);
  assert.equal(harness.evidence[0].accountTypeEligible, true);
}

test("optional expected username is canonical without a hardcoded account", () => {
  assert.equal(
    loadInstagramOAuthConfig({}).expectedUsername,
    null
  );
  assert.equal(
    loadInstagramOAuthConfig({
      SOCIAL_INSTAGRAM_EXPECTED_USERNAME: "@Ia4Tube.Empresas"
    }).expectedUsername,
    "ia4tube.empresas"
  );
  assert.equal(
    loadInstagramOAuthConfig(enabledEnvironment({
      SOCIAL_INSTAGRAM_EXPECTED_USERNAME: "Ia4Tube_Empresas"
    })).expectedUsername,
    "ia4tube_empresas"
  );
  for (const invalid of [
    "@",
    "@@ia4tube",
    ".ia4tube",
    "ia4tube.",
    "ia4tube..empresas",
    "ia4tube empresas",
    "a".repeat(31)
  ]) {
    assert.throws(
      () => loadInstagramOAuthConfig({
        SOCIAL_INSTAGRAM_EXPECTED_USERNAME: invalid
      }),
      { code: "social_instagram_configuration_invalid" }
    );
  }
});

test("official code exchange unwraps data and returns canonical granted scopes", async () => {
  const calls = [];
  const evidence = [];
  const provider = providerWithTransport(async (url, options) => {
    calls.push({ url, options });
    return jsonResponse({
      data: [{
        access_token: SHORT_TOKEN,
        user_id: USER_ID,
        permissions: [
          INSTAGRAM_OAUTH_SCOPES[1],
          INSTAGRAM_OAUTH_SCOPES[0],
          INSTAGRAM_OAUTH_SCOPES[1]
        ]
      }]
    });
  }, {
    logger: {
      info(event) {
        evidence.push(event);
      }
    }
  });

  const exchanged = await provider.exchangeCode({ code: "synthetic-code" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, INSTAGRAM_TOKEN_ENDPOINT);
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(Object.keys(exchanged), [
    "accessToken",
    "userId",
    "grantedScopes"
  ]);
  assert.deepEqual(exchanged.accessToken, Buffer.from(SHORT_TOKEN));
  assert.equal(exchanged.userId, USER_ID);
  assert.deepEqual(exchanged.grantedScopes, INSTAGRAM_OAUTH_SCOPES);
  assert.equal(Object.isFrozen(exchanged.grantedScopes), true);
  assert.deepEqual(evidence, [{
    component: "social_instagram_oauth",
    event: "provider_scope_evidence",
    responseFormat: "data_envelope",
    permissionsFormat: "array",
    grantedScopeNames: INSTAGRAM_OAUTH_SCOPES
  }]);
  exchanged.accessToken.fill(0);
});

test("official comma-delimited permissions remain supported", async () => {
  const evidence = [];
  const provider = providerWithTransport(async () => jsonResponse({
    data: [{
      access_token: SHORT_TOKEN,
      user_id: USER_ID,
      permissions: ` ${INSTAGRAM_OAUTH_SCOPES.join(", ")} `
    }]
  }), {
    logger: {
      info(event) {
        evidence.push(event);
      }
    }
  });
  const exchanged = await provider.exchangeCode({ code: "synthetic-code" });
  assert.deepEqual(exchanged.grantedScopes, INSTAGRAM_OAUTH_SCOPES);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].responseFormat, "data_envelope");
  assert.equal(evidence[0].permissionsFormat, "csv_string");
  assert.deepEqual(evidence[0].grantedScopeNames, INSTAGRAM_OAUTH_SCOPES);
  exchanged.accessToken.fill(0);
});

test("captured flat permission array reaches the final scope gate", async () => {
  const evidence = [];
  const provider = providerWithTransport(async () => jsonResponse({
    access_token: SHORT_TOKEN,
    user_id: USER_ID,
    permissions: INSTAGRAM_OAUTH_SCOPES
  }), {
    logger: {
      info(event) {
        evidence.push(event);
      }
    }
  });

  const exchanged = await provider.exchangeCode({ code: "synthetic-code" });
  assert.deepEqual(Object.keys(exchanged), [
    "accessToken",
    "userId",
    "grantedScopes"
  ]);
  assert.deepEqual(exchanged.grantedScopes, INSTAGRAM_OAUTH_SCOPES);
  assert.deepEqual(evidence, [{
    component: "social_instagram_oauth",
    event: "provider_scope_evidence",
    responseFormat: "flat_object",
    permissionsFormat: "array",
    grantedScopeNames: INSTAGRAM_OAUTH_SCOPES
  }]);
  exchanged.accessToken.fill(0);
});

test("flat permission arrays trim spaces and deduplicate names", async () => {
  const evidence = [];
  const provider = providerWithTransport(async () => jsonResponse({
    access_token: SHORT_TOKEN,
    user_id: USER_ID,
    permissions: [
      ` ${INSTAGRAM_OAUTH_SCOPES[1]} `,
      INSTAGRAM_OAUTH_SCOPES[0],
      INSTAGRAM_OAUTH_SCOPES[1]
    ]
  }), {
    logger: { info(event) { evidence.push(event); } }
  });

  const exchanged = await provider.exchangeCode({ code: "synthetic-code" });
  assert.deepEqual(exchanged.grantedScopes, INSTAGRAM_OAUTH_SCOPES);
  assert.deepEqual(evidence[0].grantedScopeNames, INSTAGRAM_OAUTH_SCOPES);
  exchanged.accessToken.fill(0);
});

test("partial envelope evidence preserves the provider contract", async () => {
  const evidence = [];
  const provider = providerWithTransport(async () => jsonResponse({
    data: [{
      access_token: SHORT_TOKEN,
      user_id: USER_ID,
      permissions: [INSTAGRAM_OAUTH_SCOPES[0]]
    }]
  }), {
    logger: { info(event) { evidence.push(event); } }
  });

  const exchanged = await provider.exchangeCode({ code: "synthetic-code" });
  assert.deepEqual(exchanged.grantedScopes, [INSTAGRAM_OAUTH_SCOPES[0]]);
  assert.equal(evidence.length, 1);
  assert.deepEqual(evidence[0].grantedScopeNames, [INSTAGRAM_OAUTH_SCOPES[0]]);
  exchanged.accessToken.fill(0);
});

test("unsupported flat permissions are logged and rejected", async () => {
  const evidence = [];
  const provider = providerWithTransport(async () => jsonResponse({
    access_token: SHORT_TOKEN,
    user_id: USER_ID,
    permissions: null
  }), {
    logger: { info(event) { evidence.push(event); } }
  });

  await assert.rejects(
    provider.exchangeCode({ code: "synthetic-code" }),
    { code: "social_oauth_exchange_failed" }
  );
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].responseFormat, "flat_object");
  assert.equal(evidence[0].permissionsFormat, "unsupported");
  assert.deepEqual(evidence[0].grantedScopeNames, []);
});

test("an additional permission cannot replace or hide required scopes", async () => {
  const evidence = [];
  const extraScope = "instagram_business_manage_comments";
  const provider = providerWithTransport(async () => jsonResponse({
    data: [{
      access_token: SHORT_TOKEN,
      user_id: USER_ID,
      permissions: [...INSTAGRAM_OAUTH_SCOPES, extraScope]
    }]
  }), {
    logger: { info(event) { evidence.push(event); } }
  });

  const exchanged = await provider.exchangeCode({ code: "synthetic-code" });
  assert.deepEqual(
    exchanged.grantedScopes,
    Object.freeze([...INSTAGRAM_OAUTH_SCOPES, extraScope].sort())
  );
  assert.deepEqual(evidence, [{
    component: "social_instagram_oauth",
    event: "provider_scope_evidence",
    responseFormat: "data_envelope",
    permissionsFormat: "array",
    grantedScopeNames: INSTAGRAM_OAUTH_SCOPES
  }]);
  exchanged.accessToken.fill(0);
});

test("numeric 64-bit user_id remains exact through exchange and discovery", async () => {
  const responses = [
    jsonTextResponse(
      `{"data":[{"access_token":${JSON.stringify(SHORT_TOKEN)},` +
      `"user_id":${LARGE_NUMERIC_USER_ID},` +
      `"permissions":${JSON.stringify(INSTAGRAM_OAUTH_SCOPES.join(","))}}]}`
    ),
    jsonTextResponse(
      `{"user_id":${LARGE_NUMERIC_USER_ID},` +
      `"username":"ia4tube_empresas","name":null,` +
      `"account_type":"Business"}`
    )
  ];
  let calls = 0;
  const provider = providerWithTransport(async () => responses[calls++]);

  const exchanged = await provider.exchangeCode({ code: "synthetic-code" });
  assert.equal(exchanged.userId, LARGE_NUMERIC_USER_ID);
  assert.notEqual(
    exchanged.userId,
    String(Number(LARGE_NUMERIC_USER_ID))
  );
  const account = await provider.discoverProfessionalAccount({
    accessToken: exchanged.accessToken,
    userId: exchanged.userId
  });
  assert.equal(account.userId, LARGE_NUMERIC_USER_ID);
  assert.equal(account.accountType, "business");
  assert.equal(calls, 2);
  exchanged.accessToken.fill(0);
});

test("short-lived token is exchanged once at graph.instagram.com", async () => {
  const calls = [];
  const shortLived = Buffer.from(SHORT_TOKEN);
  const provider = providerWithTransport(async (url, options) => {
    calls.push({ url, options });
    return jsonResponse({
      access_token: LONG_TOKEN,
      token_type: "bearer",
      expires_in: EXPIRES_IN
    });
  });

  const exchanged = await provider.exchangeLongLivedToken({
    accessToken: shortLived
  });
  assert.equal(calls.length, 1);
  const requested = new URL(calls[0].url);
  assert.equal(
    requested.origin + requested.pathname,
    INSTAGRAM_LONG_LIVED_TOKEN_ENDPOINT
  );
  assert.equal(requested.searchParams.get("grant_type"), "ig_exchange_token");
  assert.equal(requested.searchParams.get("client_secret"), APP_SECRET);
  assert.equal(requested.searchParams.get("access_token"), SHORT_TOKEN);
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.body, undefined);
  assert.deepEqual(Object.keys(exchanged), [
    "accessToken",
    "expiresIn",
    "expiresAt"
  ]);
  assert.deepEqual(exchanged.accessToken, Buffer.from(LONG_TOKEN));
  assert.equal(exchanged.expiresIn, EXPIRES_IN);
  assert.equal(
    exchanged.expiresAt.getTime(),
    OBSERVED_AT + EXPIRES_IN * 1000
  );
  assert.deepEqual(shortLived, Buffer.from(SHORT_TOKEN));
  exchanged.accessToken.fill(0);
  shortLived.fill(0);
});

test("professional discovery uses v25.0 fields, Bearer and exact type mapping", async () => {
  for (const [remoteType, accountType] of [
    ["Business", "business"],
    ["Media_Creator", "creator"]
  ]) {
    const calls = [];
    const longLived = Buffer.from(LONG_TOKEN);
    const provider = providerWithTransport(async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({
        user_id: USER_ID,
        username: "Ia4Tube.Empresas",
        name: "IA4Tube Empresas",
        account_type: remoteType
      });
    });
    const account = await provider.discoverProfessionalAccount({
      accessToken: longLived,
      userId: USER_ID
    });
    assert.equal(calls.length, 1);
    const requested = new URL(calls[0].url);
    assert.equal(requested.origin, INSTAGRAM_GRAPH_API_ORIGIN);
    assert.equal(
      requested.pathname,
      `/${INSTAGRAM_PROFESSIONAL_ACCOUNT_API_VERSION}/me`
    );
    assert.equal(
      requested.searchParams.get("fields"),
      "id,user_id,username,name,account_type"
    );
    assert.equal(requested.searchParams.has("access_token"), false);
    assert.equal(requested.searchParams.has("client_secret"), false);
    assert.equal(
      calls[0].options.headers.authorization,
      `Bearer ${LONG_TOKEN}`
    );
    assert.deepEqual(account, {
      userId: USER_ID,
      username: "ia4tube.empresas",
      name: "IA4Tube Empresas",
      accountType
    });
    assert.deepEqual(longLived, Buffer.from(LONG_TOKEN));
    longLived.fill(0);
  }
});

test("professional discovery normalizes an absent display name to null", async () => {
  for (const name of [undefined, null, ""]) {
    const body = {
      user_id: USER_ID,
      username: "ia4tube_empresas",
      account_type: "Business"
    };
    if (name !== undefined) body.name = name;
    const provider = providerWithTransport(async () => jsonResponse(body));
    const token = Buffer.from(LONG_TOKEN);
    const account = await provider.discoverProfessionalAccount({
      accessToken: token,
      userId: USER_ID
    });
    assert.equal(account.name, null);
    token.fill(0);
  }
});

test("discovery observability classifies a request that was not sent", async () => {
  let transportCalls = 0;
  const harness = discoveryHarness(async () => {
    transportCalls += 1;
    return jsonResponse({});
  }, {
    setTimeout(callback) {
      callback();
      return 1;
    },
    clearTimeout() {}
  });
  await assert.rejects(harness.discover(), {
    code: "provider_account_discovery_request_not_sent"
  });
  assert.equal(transportCalls, 0);
  assert.equal(harness.evidence.length, 1);
  assert.equal(harness.evidence[0].requestStarted, false);
  assert.equal(harness.evidence[0].responseReceived, false);
  assert.equal(harness.evidence[0].retryable, false);
});

test("discovery observability classifies timeout", async () => {
  let transportCalls = 0;
  let timerCallback;
  const harness = discoveryHarness(async (url, options) => {
    transportCalls += 1;
    return new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        reject(new Error("synthetic aborted transport"));
      }, { once: true });
    });
  }, {
    setTimeout(callback) {
      timerCallback = callback;
      return 1;
    },
    clearTimeout() {}
  });
  const pending = harness.discover();
  void pending.catch(() => {});
  for (let attempt = 0; attempt < 20 && transportCalls === 0; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(transportCalls, 1);
  timerCallback();
  await assert.rejects(pending, {
    code: "provider_account_discovery_timeout"
  });
  assert.equal(harness.evidence.length, 1);
  assert.equal(harness.evidence[0].requestStarted, true);
  assert.equal(harness.evidence[0].responseReceived, false);
  assert.equal(harness.evidence[0].retryable, true);
  assert.equal(harness.evidence[0].correlationId, CORRELATION_ID);
});

test("discovery observability classifies transport failure", async () => {
  const harness = discoveryHarness(async () => {
    throw new Error("synthetic private transport detail");
  });
  await assert.rejects(harness.discover(), {
    code: "provider_account_discovery_transport_failed"
  });
  assert.equal(harness.evidence[0].retryable, true);
  assert.equal(harness.evidence[0].requestStarted, true);
  assert.equal(harness.evidence[0].responseReceived, false);
});

test("discovery observability classifies HTTP rejection with safe provider metadata", async () => {
  const harness = discoveryHarness(async () => jsonResponse({
    error: {
      message: "private provider message",
      type: "OAuthException",
      code: 100,
      error_subcode: 33,
      fbtrace_id: "TRACE_ABC_123",
      is_transient: false
    }
  }, { status: 400 }));
  await assert.rejects(harness.discover(), {
    code: "provider_account_discovery_http_rejected"
  });
  assert.deepEqual(harness.evidence[0], {
    component: "social_instagram_oauth",
    event: "provider_account_discovery_evidence",
    stage: "provider_account_discovery",
    outcome: "failed",
    failureCode: "provider_account_discovery_http_rejected",
    requestStarted: true,
    responseReceived: true,
    httpStatus: 400,
    contentType: "application/json",
    responseFormat: "direct_object",
    topLevelFields: ["error"],
    dataItemCount: null,
    providerErrorType: "OAuthException",
    providerErrorCode: "100",
    providerErrorSubcode: "33",
    providerTraceId: "TRACE_ABC_123",
    providerRequestId: null,
    accountTypeRaw: null,
    accountTypeNormalized: null,
    accountTypeEligible: null,
    retryable: false,
    correlationId: CORRELATION_ID,
    durationMs: 0
  });
});

test("discovery observability classifies unexpected Content-Type", async () => {
  const harness = discoveryHarness(async () => ({
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    body: "not inspected"
  }));
  await assert.rejects(harness.discover(), {
    code: "provider_account_discovery_invalid_content_type"
  });
  assert.equal(harness.evidence[0].contentType, "text/html");
  assert.equal(harness.evidence[0].responseReceived, true);
});

test("discovery observability classifies invalid JSON", async () => {
  const harness = discoveryHarness(async () => jsonTextResponse("{invalid"));
  await assert.rejects(harness.discover(), {
    code: "provider_account_discovery_invalid_json"
  });
  assert.equal(harness.evidence[0].responseFormat, "invalid_json");
});

test("discovery observability classifies incompatible response shape", async () => {
  const harness = discoveryHarness(async () => jsonResponse({
    data: [{
      user_id: USER_ID,
      username: "ia4tube_empresas",
      account_type: "Business"
    }]
  }));
  await assert.rejects(harness.discover(), {
    code: "provider_account_discovery_invalid_shape"
  });
  assert.equal(harness.evidence[0].responseFormat, "data_envelope");
  assert.deepEqual(harness.evidence[0].topLevelFields, ["data"]);
  assert.equal(harness.evidence[0].dataItemCount, 1);
});

test("discovery observability classifies a missing user id", async () => {
  const harness = discoveryHarness(async () => jsonResponse({
    username: "ia4tube_empresas",
    account_type: "Business"
  }));
  await assert.rejects(harness.discover(), {
    code: "provider_account_discovery_missing_id"
  });
});

test("discovery observability classifies a missing username", async () => {
  const harness = discoveryHarness(async () => jsonResponse({
    user_id: USER_ID,
    account_type: "Business"
  }));
  await assert.rejects(harness.discover(), {
    code: "provider_account_discovery_missing_username"
  });
});

test("discovery observability classifies an ineligible account type", async () => {
  const harness = discoveryHarness(async () => jsonResponse({
    user_id: USER_ID,
    username: "ia4tube_empresas",
    account_type: "Personal"
  }));
  await assert.rejects(harness.discover(), {
    code: "provider_account_discovery_account_ineligible"
  });
  assert.equal(harness.evidence[0].accountTypeRaw, "Personal");
  assert.equal(harness.evidence[0].accountTypeNormalized, null);
  assert.equal(harness.evidence[0].accountTypeEligible, false);
  assert.equal(harness.evidence[0].retryable, false);
});

test("discovery observability preserves the current valid response contract", async () => {
  const harness = discoveryHarness(async () => jsonResponse({
    user_id: USER_ID,
    username: "Ia4Tube_Empresas",
    name: "IA4Tube Empresas",
    account_type: "Business",
    data: []
  }));
  const result = await harness.discover();
  assert.deepEqual(result, {
    userId: USER_ID,
    username: "ia4tube_empresas",
    name: "IA4Tube Empresas",
    accountType: "business"
  });
  assert.equal(harness.evidence[0].outcome, "succeeded");
  assert.equal(harness.evidence[0].failureCode, null);
  assert.equal(harness.evidence[0].accountTypeRaw, "Business");
  assert.equal(harness.evidence[0].accountTypeNormalized, "business");
  assert.equal(harness.evidence[0].accountTypeEligible, true);
  assert.equal(harness.evidence[0].requestStarted, true);
  assert.equal(harness.evidence[0].responseReceived, true);
});

test("discovery observability never exposes response, token or authorization secrets", async () => {
  const secret = "secret-provider-material-must-not-survive";
  const harness = discoveryHarness(async () => jsonResponse({
    error: {
      message: secret,
      type: APP_SECRET,
      code: 190,
      error_subcode: 463,
      fbtrace_id: LONG_TOKEN
    },
    private_material: secret
  }, {
    status: 401,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${secret}`,
      "x-fb-request-id": LONG_TOKEN,
      "x-private-token": secret
    }
  }));
  let failure;
  try {
    await harness.discover();
  } catch (error) {
    failure = error;
  }
  assert.equal(failure?.code, "provider_account_discovery_http_rejected");
  const serialized = JSON.stringify({
    error: {
      name: failure?.name,
      code: failure?.code,
      message: failure?.message,
      evidence: failure?.evidence
    },
    evidence: harness.evidence
  });
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes(LONG_TOKEN), false);
  assert.equal(serialized.includes(APP_SECRET), false);
  assert.equal(serialized.includes("https://"), false);
  assert.equal(serialized.toLowerCase().includes("authorization"), false);
  assert.equal(serialized.toLowerCase().includes("access_token"), false);
  assert.deepEqual(harness.evidence[0].topLevelFields, [
    "error",
    "private_material"
  ]);
  const resanitized = sanitizeInstagramDiscoveryEvidence({
    ...harness.evidence[0],
    accountTypeRaw: secret,
    accountTypeNormalized: secret,
    providerErrorCode: secret,
    providerErrorSubcode: secret,
    rawBody: secret,
    authorization: `Bearer ${secret}`
  });
  assert.equal(JSON.stringify(resanitized).includes(secret), false);
  assert.equal(resanitized.accountTypeRaw, null);
  assert.equal(resanitized.accountTypeNormalized, null);
  assert.equal(sanitizeInstagramDiscoveryEvidence({
    ...harness.evidence[0],
    requestStarted: false,
    responseReceived: true
  }), null);
});

test("account type focal 01 BUSINESS maps to business", async () => {
  await assertEligibleAccountType("BUSINESS", "business");
});

test("account type focal 02 Business maps to business", async () => {
  await assertEligibleAccountType("Business", "business");
});

test("account type focal 03 business maps to business", async () => {
  await assertEligibleAccountType("business", "business");
});

test("account type focal 04 Creator aliases map to creator", async () => {
  for (const remoteType of ["CREATOR", "Creator", "creator"]) {
    await assertEligibleAccountType(remoteType, "creator");
  }
});

test("account type focal 05 Media_Creator aliases map to creator", async () => {
  for (const remoteType of [
    "MEDIA_CREATOR",
    "Media_Creator",
    "media_creator"
  ]) {
    await assertEligibleAccountType(remoteType, "creator");
  }
});

test("account type focal 06 surrounding spaces are trimmed canonically", async () => {
  await assertEligibleAccountType("  BUSINESS  ", "business");
});

test("account type focal 07 PERSONAL remains ineligible", async () => {
  const harness = accountDiscoveryHarness("PERSONAL");
  await assert.rejects(harness.discover(), {
    code: "provider_account_discovery_account_ineligible"
  });
  assert.equal(harness.evidence[0].accountTypeRaw, "PERSONAL");
  assert.equal(harness.evidence[0].accountTypeNormalized, null);
  assert.equal(harness.evidence[0].accountTypeEligible, false);
});

test("account type focal 08 closed allowlist rejects unsupported strings", async () => {
  for (const remoteType of [
    "CONSUMER",
    "UNKNOWN",
    "UNSUPPORTED",
    "unsupported",
    "PROFESSIONAL"
  ]) {
    const harness = accountDiscoveryHarness(remoteType);
    await assert.rejects(harness.discover(), {
      code: "provider_account_discovery_account_ineligible"
    });
    assert.equal(harness.evidence[0].accountTypeRaw, remoteType);
    assert.equal(harness.evidence[0].accountTypeNormalized, null);
    assert.equal(harness.evidence[0].accountTypeEligible, false);
  }
  const empty = accountDiscoveryHarness("");
  await assert.rejects(empty.discover(), {
    code: "provider_account_discovery_account_ineligible"
  });
});

test("account type focal 09 missing account_type fails closed", async () => {
  const harness = discoveryHarness(async () => jsonResponse({
    user_id: USER_ID,
    username: "ia4tube_empresas",
    name: "IA4Tube Empresas"
  }));
  await assert.rejects(harness.discover(), {
    code: "provider_account_discovery_invalid_shape"
  });
  assert.equal(harness.evidence[0].accountTypeRaw, null);
  assert.equal(harness.evidence[0].accountTypeNormalized, null);
  assert.equal(harness.evidence[0].accountTypeEligible, null);
});

test("account type focal 10 non-string account_type is ineligible", async () => {
  for (const remoteType of [{ type: "BUSINESS" }, ["BUSINESS"], 1]) {
    const harness = accountDiscoveryHarness(remoteType);
    await assert.rejects(harness.discover(), {
      code: "provider_account_discovery_account_ineligible"
    });
    assert.equal(harness.evidence[0].accountTypeRaw, null);
    assert.equal(harness.evidence[0].accountTypeNormalized, null);
    assert.equal(harness.evidence[0].accountTypeEligible, false);
  }
});

test("account type focal 11 real direct object keeps distinct official IDs", async () => {
  const harness = discoveryHarness(async () => jsonResponse({
    account_type: "BUSINESS",
    id: USER_ID,
    name: "IA4Tube Empresas",
    user_id: PROFESSIONAL_USER_ID,
    username: "ia4tube_empresas"
  }));
  const account = await harness.discover();
  assert.deepEqual(account, {
    userId: PROFESSIONAL_USER_ID,
    username: "ia4tube_empresas",
    name: "IA4Tube Empresas",
    accountType: "business"
  });
  assert.deepEqual(harness.evidence[0].topLevelFields, [
    "account_type",
    "id",
    "name",
    "user_id",
    "username"
  ]);
  assert.equal(harness.evidence[0].accountTypeRaw, "BUSINESS");
  assert.equal(harness.evidence[0].accountTypeNormalized, "business");
  assert.equal(harness.evidence[0].accountTypeEligible, true);
});

test("account type focal 12 incompatible app-scoped id fails closed", async () => {
  const harness = discoveryHarness(async () => jsonResponse({
    account_type: "BUSINESS",
    id: "17841400000000002",
    name: "IA4Tube Empresas",
    user_id: PROFESSIONAL_USER_ID,
    username: "ia4tube_empresas"
  }));
  await assert.rejects(harness.discover(), {
    code: "provider_account_discovery_invalid_shape"
  });
  assert.equal(harness.evidence[0].accountTypeRaw, "BUSINESS");

  const missingBinding = discoveryHarness(async () => jsonResponse({
    account_type: "BUSINESS",
    name: "IA4Tube Empresas",
    user_id: PROFESSIONAL_USER_ID,
    username: "ia4tube_empresas"
  }));
  await assert.rejects(missingBinding.discover(), {
    code: "provider_account_discovery_invalid_shape"
  });
});

test("account type focal 13 raw value is exact and controls never survive", async () => {
  const valid = accountDiscoveryHarness("Creator");
  await valid.discover();
  assert.equal(valid.evidence[0].accountTypeRaw, "Creator");
  assert.equal(valid.evidence[0].accountTypeNormalized, "creator");
  assert.equal(valid.evidence[0].accountTypeEligible, true);

  const controlled = accountDiscoveryHarness("BUSI\u0000NESS");
  await assert.rejects(controlled.discover(), {
    code: "provider_account_discovery_account_ineligible"
  });
  assert.equal(controlled.evidence[0].accountTypeRaw, null);
  assert.equal(JSON.stringify(controlled.evidence).includes("\u0000"), false);
});

test("account type focal 14 discovery evidence excludes OAuth secrets", async () => {
  const oauthCode = "synthetic-oauth-code-private";
  const oauthState = "synthetic-oauth-state-private";
  const authorization = `Bearer ${LONG_TOKEN}`;
  const harness = accountDiscoveryHarness("BUSINESS", {
    access_token: LONG_TOKEN,
    authorization,
    code: oauthCode,
    state: oauthState
  });
  await harness.discover();
  const serialized = JSON.stringify(harness.evidence);
  for (const forbidden of [LONG_TOKEN, oauthCode, oauthState, authorization]) {
    assert.equal(serialized.includes(forbidden), false);
  }
  assert.deepEqual(harness.evidence[0].topLevelFields, [
    "account_type",
    "name",
    "user_id",
    "username"
  ]);
  const resanitized = sanitizeInstagramDiscoveryEvidence({
    ...harness.evidence[0],
    topLevelFields: [
      ...harness.evidence[0].topLevelFields,
      "access_token",
      "authorization",
      "code",
      "state"
    ]
  });
  assert.deepEqual(resanitized.topLevelFields, harness.evidence[0].topLevelFields);
});

test("unsupported accounts, mismatched identities and transport detail fail closed", async () => {
  for (const remoteType of ["Personal", "CONSUMER", "UNKNOWN", "unsupported"]) {
    let calls = 0;
    const token = Buffer.from(LONG_TOKEN);
    const provider = providerWithTransport(async () => {
      calls += 1;
      return jsonResponse({
        user_id: USER_ID,
        username: "ia4tube_empresas",
        name: "IA4Tube Empresas",
        account_type: remoteType
      });
    });
    await assert.rejects(
      provider.discoverProfessionalAccount({
        accessToken: token,
        userId: USER_ID
      }),
      { code: "provider_account_discovery_account_ineligible" }
    );
    assert.equal(calls, 1);
    token.fill(0);
  }

  const mismatchToken = Buffer.from(LONG_TOKEN);
  const mismatch = providerWithTransport(async () => jsonResponse({
    id: "17841400000000002",
    user_id: PROFESSIONAL_USER_ID,
    username: "ia4tube_empresas",
    name: "IA4Tube Empresas",
    account_type: "Business"
  }));
  await assert.rejects(
    mismatch.discoverProfessionalAccount({
      accessToken: mismatchToken,
      userId: USER_ID
    }),
    { code: "provider_account_discovery_invalid_shape" }
  );
  mismatchToken.fill(0);

  let calls = 0;
  const shortLived = Buffer.from(SHORT_TOKEN);
  const failing = providerWithTransport(async (url) => {
    calls += 1;
    throw new Error(`synthetic upstream detail ${url}`);
  });
  let failure;
  try {
    await failing.exchangeLongLivedToken({ accessToken: shortLived });
  } catch (error) {
    failure = error;
  }
  assert.equal(failure?.code, "social_oauth_exchange_failed");
  assert.equal(calls, 1);
  assert.equal(String(failure?.message).includes(APP_SECRET), false);
  assert.equal(String(failure?.stack).includes(APP_SECRET), false);
  assert.equal(String(failure?.stack).includes(SHORT_TOKEN), false);
  shortLived.fill(0);
});
