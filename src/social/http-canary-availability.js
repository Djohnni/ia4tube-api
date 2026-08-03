"use strict";

const { explicitTrue } = require("../persistence/postgres/config");
const { requireUuid } = require("../persistence/postgres/validation");

const HTTP_CANARY_ROUTE = "/bot/social/runtime-canary";
const HTTP_CANARY_APPROVAL = "RUN_SOCIAL_RUNTIME_CANARY_STAGING";
const HTTP_CANARY_BRANCH =
  "social/checkpoint-2b-http-canary-20260803";
const HTTP_CANARY_REPOSITORY = "djohnni/ia4tube-api";
const HTTP_CANARY_SERVICE_ID = "srv-d9itiiurnols73fsbmmg";
const HTTP_CANARY_SERVICE_NAME = "ia4tube-api-staging-checkpoint-a";
const HTTP_CANARY_HOSTNAME =
  "ia4tube-api-staging-checkpoint-a.onrender.com";
const HTTP_CANARY_PUBLIC_ORIGIN = `https://${HTTP_CANARY_HOSTNAME}`;
const HTTP_CANARY_ENVIRONMENT_ID =
  "f9001d31-5cb4-471b-87de-96ef7dc7bd4e";
const HTTP_CANARY_DATABASE_HOST =
  "dpg-d9l8u27qj5pc738k3rvg-a.oregon-postgres.render.com";
const HTTP_CANARY_DATABASE_NAME = "ia4tube_social_staging";
const HTTP_CANARY_RUNTIME_LOGIN = "ia4tube_social_staging_runtime";
const SHA40 = /^[0-9a-f]{40}$/;

function disabledAvailability(options = {}) {
  return Object.freeze({
    enabled: false,
    requested: options.requested === true,
    invalid: options.invalid === true
  });
}

function exact(value, expected) {
  return String(value || "") === expected;
}

function normalizedRepository(value) {
  return String(value || "").trim().toLowerCase();
}

function parseTarget(env) {
  let parsed;
  let database;
  let login;
  try {
    parsed = new URL(env.DATABASE_URL);
    database = decodeURIComponent(parsed.pathname.slice(1));
    login = decodeURIComponent(parsed.username);
  } catch {
    return null;
  }
  const query = [...parsed.searchParams.entries()];
  if (
    parsed.protocol !== "postgres:" &&
    parsed.protocol !== "postgresql:"
  ) {
    return null;
  }
  if (
    parsed.hostname.toLowerCase() !== HTTP_CANARY_DATABASE_HOST ||
    (parsed.port || "5432") !== "5432" ||
    database !== HTTP_CANARY_DATABASE_NAME ||
    login !== HTTP_CANARY_RUNTIME_LOGIN ||
    query.length !== 1 ||
    query[0][0] !== "sslmode" ||
    query[0][1] !== "verify-full"
  ) {
    return null;
  }
  return Object.freeze({ database, login });
}

function resolveHttpCanaryTarget(env = process.env) {
  if (!explicitTrue(env.SOCIAL_RUNTIME_HTTP_CANARY_ENABLED)) {
    return disabledAvailability();
  }

  // A different Render service (including production) must never gain this
  // route merely because the feature flag was copied there. Once the unique
  // staging service ID matches, every remaining mismatch is a configuration
  // error and must fail startup rather than silently hiding a requested gate.
  if (!exact(env.RENDER_SERVICE_ID, HTTP_CANARY_SERVICE_ID)) {
    return disabledAvailability({ requested: true });
  }

  const expectedCommit = String(
    env.SOCIAL_RUNTIME_HTTP_CANARY_COMMIT || ""
  );
  if (
    !SHA40.test(expectedCommit) ||
    !exact(env.RENDER_GIT_COMMIT, expectedCommit) ||
    !exact(env.SOCIAL_RUNTIME_CANARY_APPROVED, HTTP_CANARY_APPROVAL) ||
    !exact(env.SOCIAL_RUNTIME_CANARY_ENVIRONMENT, "staging") ||
    !exact(
      env.SOCIAL_RUNTIME_CANARY_EXPECTED_ENVIRONMENT_ID,
      HTTP_CANARY_ENVIRONMENT_ID
    ) ||
    !explicitTrue(env.SOCIAL_PERSISTENCE_ENABLED) ||
    !exact(env.SOCIAL_DATABASE_POOL_MAX, "3") ||
    !explicitTrue(env.RENDER) ||
    !exact(env.NODE_ENV, "production") ||
    !exact(env.RENDER_SERVICE_NAME, HTTP_CANARY_SERVICE_NAME) ||
    !exact(env.RENDER_SERVICE_TYPE, "web") ||
    !exact(env.RENDER_EXTERNAL_HOSTNAME, HTTP_CANARY_HOSTNAME) ||
    normalizedRepository(env.RENDER_GIT_REPO_SLUG) !==
      HTTP_CANARY_REPOSITORY ||
    !exact(env.RENDER_GIT_BRANCH, HTTP_CANARY_BRANCH) ||
    !exact(env.PUBLIC_API_BASE_URL, HTTP_CANARY_PUBLIC_ORIGIN) ||
    !exact(
      env.SOCIAL_DATABASE_EXPECTED_RUNTIME_LOGIN,
      HTTP_CANARY_RUNTIME_LOGIN
    ) ||
    !parseTarget(env)
  ) {
    return disabledAvailability({ requested: true, invalid: true });
  }

  let companyA;
  let companyB;
  try {
    companyA = requireUuid(
      env.SOCIAL_RUNTIME_CANARY_COMPANY_A_ID,
      "social_runtime_canary_company_a"
    );
    companyB = requireUuid(
      env.SOCIAL_RUNTIME_CANARY_COMPANY_B_ID,
      "social_runtime_canary_company_b"
    );
  } catch {
    return disabledAvailability({ requested: true, invalid: true });
  }
  if (companyA === companyB) {
    return disabledAvailability({ requested: true, invalid: true });
  }

  return Object.freeze({
    enabled: true,
    requested: true,
    invalid: false,
    companyA,
    companyB
  });
}

function resolveHttpCanaryAvailability(options = {}) {
  const env = options.env || process.env;
  const internalTokens = Array.isArray(options.internalTokens)
    ? options.internalTokens
    : [];
  const target = resolveHttpCanaryTarget(env);
  if (
    !target.enabled ||
    !internalTokens.some(
      (token) =>
        typeof token === "string" &&
        token === token.trim() &&
        token.length >= 32
    )
  ) {
    if (target.invalid || target.enabled) {
      return disabledAvailability({ requested: true, invalid: true });
    }
    return target;
  }
  return target;
}

module.exports = {
  HTTP_CANARY_APPROVAL,
  HTTP_CANARY_BRANCH,
  HTTP_CANARY_DATABASE_HOST,
  HTTP_CANARY_DATABASE_NAME,
  HTTP_CANARY_ENVIRONMENT_ID,
  HTTP_CANARY_HOSTNAME,
  HTTP_CANARY_PUBLIC_ORIGIN,
  HTTP_CANARY_REPOSITORY,
  HTTP_CANARY_ROUTE,
  HTTP_CANARY_RUNTIME_LOGIN,
  HTTP_CANARY_SERVICE_ID,
  HTTP_CANARY_SERVICE_NAME,
  resolveHttpCanaryAvailability,
  resolveHttpCanaryTarget
};
