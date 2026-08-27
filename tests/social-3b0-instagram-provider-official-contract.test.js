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
  createInstagramProvider
} = require("../src/social/oauth/instagram-provider");

const APP_SECRET = "synthetic-provider-contract-app-secret";
const SHORT_TOKEN = "synthetic-short-lived-token";
const LONG_TOKEN = "synthetic-long-lived-token";
const USER_ID = "17841400000000001";
const LARGE_NUMERIC_USER_ID = "17841498765432109";
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
  exchanged.accessToken.fill(0);
});

test("official comma-delimited permissions remain supported", async () => {
  const provider = providerWithTransport(async () => jsonResponse({
    data: [{
      access_token: SHORT_TOKEN,
      user_id: USER_ID,
      permissions: INSTAGRAM_OAUTH_SCOPES.join(",")
    }]
  }));
  const exchanged = await provider.exchangeCode({ code: "synthetic-code" });
  assert.deepEqual(exchanged.grantedScopes, INSTAGRAM_OAUTH_SCOPES);
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
      "user_id,username,name,account_type"
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

test("unsupported accounts, mismatched users and transport detail fail closed", async () => {
  for (const remoteType of ["Creator", "BUSINESS", "Personal", "business"]) {
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
      { code: "social_oauth_exchange_failed" }
    );
    assert.equal(calls, 1);
    token.fill(0);
  }

  const mismatchToken = Buffer.from(LONG_TOKEN);
  const mismatch = providerWithTransport(async () => jsonResponse({
    user_id: "17841400000000002",
    username: "ia4tube_empresas",
    name: "IA4Tube Empresas",
    account_type: "Business"
  }));
  await assert.rejects(
    mismatch.discoverProfessionalAccount({
      accessToken: mismatchToken,
      userId: USER_ID
    }),
    { code: "social_oauth_exchange_failed" }
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
