"use strict";

const { postgresFail } = require("../../persistence/postgres/errors");

const INSTAGRAM_PROVIDER = "instagram";
const INSTAGRAM_AUTHORIZATION_ENDPOINT =
  "https://www.instagram.com/oauth/authorize";
const INSTAGRAM_TOKEN_ENDPOINT =
  "https://api.instagram.com/oauth/access_token";
const INSTAGRAM_LONG_LIVED_TOKEN_ENDPOINT =
  "https://graph.instagram.com/access_token";
const INSTAGRAM_GRAPH_API_ORIGIN = "https://graph.instagram.com";
const INSTAGRAM_PROFESSIONAL_ACCOUNT_API_VERSION = "v25.0";
const INSTAGRAM_OAUTH_REDIRECT_URI =
  "https://ia4tube-api-staging-checkpoint-a.onrender.com" +
  "/v1/social/oauth/callback";
const INSTAGRAM_OAUTH_SCOPES = Object.freeze([
  "instagram_business_basic",
  "instagram_business_content_publish"
]);

const APP_ID_PATTERN = /^[0-9]{5,32}$/;
const GRAPH_API_VERSION_PATTERN = /^v[1-9][0-9]?\.[0-9]+$/;
const INSTAGRAM_USERNAME_PATTERN =
  /^[a-z0-9_](?:[a-z0-9_.]{0,28}[a-z0-9_])?$/;

function configFail(code = "social_instagram_configuration_invalid") {
  postgresFail(code, "Configuracao OAuth Instagram recusada.");
}

function strictFlag(env, name) {
  const value = env[name];
  if (value === undefined) return false;
  if (value === "true") return true;
  if (value === "false") return false;
  configFail("social_instagram_feature_flag_invalid");
}

function boundedString(value, { minimum, maximum, pattern } = {}) {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length < minimum ||
    value.length > maximum ||
    /[\u0000-\u0020\u007f]/.test(value) ||
    (pattern && !pattern.test(value))
  ) {
    configFail();
  }
  return value;
}

function normalizeExpectedUsername(value) {
  if (value === undefined) return null;
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length < 1 ||
    value.length > 31 ||
    /[\u0000-\u0020\u007f]/.test(value)
  ) {
    configFail();
  }
  const withoutAt = value.startsWith("@") ? value.slice(1) : value;
  const normalized = withoutAt.toLowerCase();
  if (
    !INSTAGRAM_USERNAME_PATTERN.test(normalized) ||
    normalized.includes("..")
  ) {
    configFail();
  }
  return normalized;
}

function disabledConfig(flags, expectedUsername) {
  return Object.freeze({
    enabled: false,
    provider: INSTAGRAM_PROVIDER,
    instagramEnabled: flags.instagramEnabled,
    externalConnectionEnabled: flags.externalConnectionEnabled,
    externalPublicationEnabled: false,
    appId: null,
    appSecret: null,
    expectedUsername,
    redirectUri: INSTAGRAM_OAUTH_REDIRECT_URI,
    graphApiVersion: null,
    authorizationEndpoint: INSTAGRAM_AUTHORIZATION_ENDPOINT,
    tokenEndpoint: INSTAGRAM_TOKEN_ENDPOINT,
    scopes: INSTAGRAM_OAUTH_SCOPES
  });
}

function loadInstagramOAuthConfig(env = process.env) {
  if (!env || typeof env !== "object" || Array.isArray(env)) configFail();

  const expectedUsername = normalizeExpectedUsername(
    env.SOCIAL_INSTAGRAM_EXPECTED_USERNAME
  );

  const flags = Object.freeze({
    instagramEnabled: strictFlag(env, "SOCIAL_INSTAGRAM_ENABLED"),
    externalConnectionEnabled: strictFlag(
      env,
      "SOCIAL_EXTERNAL_CONNECTION_ENABLED"
    ),
    externalPublicationEnabled: strictFlag(
      env,
      "SOCIAL_EXTERNAL_PUBLICATION_ENABLED"
    )
  });
  if (flags.externalPublicationEnabled) {
    configFail("social_instagram_publication_forbidden");
  }
  if (!flags.instagramEnabled) {
    return disabledConfig(flags, expectedUsername);
  }

  const appId = boundedString(env.INSTAGRAM_APP_ID, {
    minimum: 5,
    maximum: 32,
    pattern: APP_ID_PATTERN
  });
  const appSecret = boundedString(env.INSTAGRAM_APP_SECRET, {
    minimum: 16,
    maximum: 256
  });
  if (env.INSTAGRAM_OAUTH_REDIRECT_URI !== INSTAGRAM_OAUTH_REDIRECT_URI) {
    configFail("social_instagram_redirect_uri_invalid");
  }
  const graphApiVersion = boundedString(
    env.INSTAGRAM_GRAPH_API_VERSION,
    {
      minimum: 4,
      maximum: 16,
      pattern: GRAPH_API_VERSION_PATTERN
    }
  );

  return Object.freeze({
    enabled: flags.externalConnectionEnabled,
    provider: INSTAGRAM_PROVIDER,
    instagramEnabled: true,
    externalConnectionEnabled: flags.externalConnectionEnabled,
    externalPublicationEnabled: false,
    appId,
    appSecret,
    expectedUsername,
    redirectUri: INSTAGRAM_OAUTH_REDIRECT_URI,
    graphApiVersion,
    authorizationEndpoint: INSTAGRAM_AUTHORIZATION_ENDPOINT,
    tokenEndpoint: INSTAGRAM_TOKEN_ENDPOINT,
    scopes: INSTAGRAM_OAUTH_SCOPES
  });
}

module.exports = {
  GRAPH_API_VERSION_PATTERN,
  INSTAGRAM_AUTHORIZATION_ENDPOINT,
  INSTAGRAM_GRAPH_API_ORIGIN,
  INSTAGRAM_LONG_LIVED_TOKEN_ENDPOINT,
  INSTAGRAM_OAUTH_REDIRECT_URI,
  INSTAGRAM_OAUTH_SCOPES,
  INSTAGRAM_PROFESSIONAL_ACCOUNT_API_VERSION,
  INSTAGRAM_PROVIDER,
  INSTAGRAM_TOKEN_ENDPOINT,
  INSTAGRAM_USERNAME_PATTERN,
  loadInstagramOAuthConfig
};
