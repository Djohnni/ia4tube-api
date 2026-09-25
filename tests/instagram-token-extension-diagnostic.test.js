"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  INSTAGRAM_AUTHORIZATION_ENDPOINT,
  INSTAGRAM_OAUTH_REDIRECT_URI,
  INSTAGRAM_OAUTH_SCOPES,
  INSTAGRAM_PROVIDER,
  INSTAGRAM_TOKEN_ENDPOINT
} = require("../src/social/oauth/instagram-config");
const {
  INSTAGRAM_EXCHANGE_TIMEOUT_MS,
  INSTAGRAM_LONG_LIVED_EXCHANGE_TIMEOUT_MS,
  createInstagramProvider
} = require("../src/social/oauth/instagram-provider");
const {
  OAUTH_FAILURE_DETAIL_CODES,
  OAUTH_FAILURE_STAGES,
  TOKEN_EXTENSION_FAILURE_CODES,
  classifyOAuthFailure
} = require("../src/social/oauth/instagram-oauth-failure");

const SHORT_TOKEN = "synthetic_short_token_not_a_credential";
const LONG_TOKEN = "synthetic_long_token_not_a_credential";
const SECRET = "synthetic_app_secret_not_a_credential";

const config = Object.freeze({
  environment: "test",
  enabled: true,
  instagramEnabled: true,
  externalConnectionEnabled: true,
  externalPublicationEnabled: false,
  provider: INSTAGRAM_PROVIDER,
  redirectUri: INSTAGRAM_OAUTH_REDIRECT_URI,
  authorizationEndpoint: INSTAGRAM_AUTHORIZATION_ENDPOINT,
  tokenEndpoint: INSTAGRAM_TOKEN_ENDPOINT,
  expectedUsername: null,
  scopes: INSTAGRAM_OAUTH_SCOPES,
  appId: "12345678901234",
  appSecret: SECRET,
  graphApiVersion: "v25.0"
});

function response(status, body, contentType = "application/json") {
  return { status, headers: { "content-type": contentType }, body };
}

async function extensionFailure(transport, expectedCode, timeoutMs) {
  const provider = createInstagramProvider({ config, transport, timeoutMs });
  const shortToken = Buffer.from(SHORT_TOKEN);
  await assert.rejects(
    provider.exchangeLongLivedToken({ accessToken: shortToken }),
    (error) => {
      assert.equal(error.code, expectedCode);
      assert.equal(error.message, "Troca OAuth Instagram recusada.");
      assert.equal(error.cause, undefined);
      assert.doesNotMatch(JSON.stringify(error), /synthetic_(?:short|long|app)/);
      assert.equal(classifyOAuthFailure(
        OAUTH_FAILURE_STAGES.TOKEN_EXTENSION_OR_VALIDATION,
        error
      ), expectedCode);
      assert.equal(OAUTH_FAILURE_DETAIL_CODES.includes(expectedCode), true);
      return true;
    }
  );
  assert.equal(shortToken.toString(), SHORT_TOKEN);
}

test("token extension preserves the valid exchange contract", async () => {
  const provider = createInstagramProvider({
    config,
    transport: async () => response(200, JSON.stringify({
      access_token: LONG_TOKEN,
      token_type: "bearer",
      expires_in: 3600
    })),
    clock: () => 1730000000000
  });
  const result = await provider.exchangeLongLivedToken({
    accessToken: Buffer.from(SHORT_TOKEN)
  });
  assert.equal(result.accessToken.toString(), LONG_TOKEN);
  assert.equal(result.expiresIn, 3600);
  assert.equal(result.expiresAt.toISOString(), "2024-10-27T04:33:20.000Z");
  result.accessToken.fill(0);
});

test("only the long-lived exchange receives a 15-second default budget", async () => {
  const deadlines = [];
  const provider = createInstagramProvider({
    config,
    transport: async (url) => url === INSTAGRAM_TOKEN_ENDPOINT
      ? response(200, JSON.stringify({
        access_token: SHORT_TOKEN, user_id: "1234567890",
        permissions: INSTAGRAM_OAUTH_SCOPES
      }))
      : response(200, JSON.stringify({
        access_token: LONG_TOKEN, token_type: "bearer", expires_in: 3600
      })),
    setTimeout: (_callback, delay) => {
      deadlines.push(delay);
      return 1;
    },
    clearTimeout: () => {},
    clock: () => 1730000000000
  });
  const short = await provider.exchangeCode({ code: "synthetic_code" });
  short.accessToken.fill(0);
  const long = await provider.exchangeLongLivedToken({
    accessToken: Buffer.from(SHORT_TOKEN)
  });
  long.accessToken.fill(0);
  assert.deepEqual(deadlines, [
    INSTAGRAM_EXCHANGE_TIMEOUT_MS,
    INSTAGRAM_LONG_LIVED_EXCHANGE_TIMEOUT_MS
  ]);
  assert.equal(INSTAGRAM_LONG_LIVED_EXCHANGE_TIMEOUT_MS, 15000);
});

test("token extension stores only fixed HTTP classifications", async () => {
  for (const [status, code] of [
    [400, "provider_token_extension_http_400"],
    [401, "provider_token_extension_http_401"],
    [403, "provider_token_extension_http_403"],
    [429, "provider_token_extension_http_429"],
    [422, "provider_token_extension_http_4xx"],
    [503, "provider_token_extension_http_5xx"],
    [302, "provider_token_extension_http_rejected"]
  ]) {
    await extensionFailure(async () => response(status, JSON.stringify({
      error: { message: `${SHORT_TOKEN} ${SECRET}` }
    })), code);
  }
});

test("token extension distinguishes timeout, transport and response shape safely", async () => {
  await extensionFailure(async () => new Promise(() => {}),
    "provider_token_extension_timeout", 10);
  await extensionFailure(async () => {
    throw new Error(`${SHORT_TOKEN} ${SECRET}`);
  }, "provider_token_extension_transport_failed");
  await extensionFailure(async () => response(200, "{}", "text/html"),
    "provider_token_extension_invalid_content_type");
  await extensionFailure(async () => response(200, "{not-json}"),
    "provider_token_extension_invalid_json");
  await extensionFailure(async () => response(200, JSON.stringify({
    access_token: LONG_TOKEN, token_type: "bearer", expires_in: 3600,
    unexpected: SHORT_TOKEN
  })), "provider_token_extension_invalid_shape");
  await extensionFailure(async () => response(200, ""),
    "provider_token_extension_invalid_response");
});

test("invalid local expiry is classified without retaining a returned token", async () => {
  const provider = createInstagramProvider({
    config,
    transport: async () => response(200, JSON.stringify({
      access_token: LONG_TOKEN, token_type: "bearer", expires_in: 3600
    })),
    clock: () => Number.NaN
  });
  await assert.rejects(provider.exchangeLongLivedToken({
    accessToken: Buffer.from(SHORT_TOKEN)
  }), (error) => {
    assert.equal(error.code, "provider_token_extension_invalid_expiry");
    assert.doesNotMatch(JSON.stringify(error), /synthetic_(?:short|long|app)/);
    return true;
  });
});

test("untrusted failure codes never become audit details", () => {
  assert.equal(TOKEN_EXTENSION_FAILURE_CODES.length, 14);
  const fake = { code: `provider_token_extension_${SHORT_TOKEN}` };
  assert.equal(classifyOAuthFailure(
    OAUTH_FAILURE_STAGES.TOKEN_EXTENSION_OR_VALIDATION, fake
  ), "provider_token_extension_failed");
});
