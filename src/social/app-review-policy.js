"use strict";

const { UUID_PATTERN } = require("../persistence/postgres/validation");
const { postgresFail } = require("../persistence/postgres/errors");
const { deriveSocialIdentity, parseIdentityConfig } = require("./identity");
const { CONTROLLED_GATE4_COMPANY_ID } = require("./publication/controlled-gate4-jpeg");

const APP_REVIEW_STAGING_ORIGIN =
  "https://ia4tube-api-staging-checkpoint-a.onrender.com";
const APP_REVIEW_LOGIN_PREFIX = "ia4tube_meta_app_review_";
const APP_REVIEW_LOGIN = `${APP_REVIEW_LOGIN_PREFIX}20260904`;

function expectedAppReviewCompanyId(env) {
  let identityConfig;
  try {
    identityConfig = parseIdentityConfig(env);
    return deriveSocialIdentity({
      namespaceUuid: identityConfig.namespaceUuid,
      derivationKey: identityConfig.key,
      derivationVersion: identityConfig.derivationVersion,
      legacyCompanyId: APP_REVIEW_LOGIN,
      legacyUserId: APP_REVIEW_LOGIN
    }).companyId;
  } catch {
    postgresFail("social_app_review_configuration_invalid",
      "Configuracao da empresa de revisao recusada.");
  } finally {
    if (identityConfig?.key) identityConfig.key.fill(0);
  }
}

function validCompanyId(value) {
  return typeof value === "string" && UUID_PATTERN.test(value) &&
    value !== "00000000-0000-0000-0000-000000000000";
}

function loadAppReviewPolicy(env) {
  const flag = env.META_APP_REVIEW_WINDOW_ENABLED;
  const configuredCompanyId = env.META_APP_REVIEW_COMPANY_ID;
  if (
    (flag !== undefined && flag !== "false" && flag !== "true") ||
    (configuredCompanyId !== undefined && (!validCompanyId(configuredCompanyId) ||
      configuredCompanyId.toLowerCase() === CONTROLLED_GATE4_COMPANY_ID)) ||
    (configuredCompanyId !== undefined && flag === undefined)
  ) {
    postgresFail("social_app_review_configuration_invalid",
      "Configuracao da empresa de revisao recusada.");
  }
  const expectedCompanyId = flag === undefined
    ? null
    : expectedAppReviewCompanyId(env);
  if (configuredCompanyId !== undefined &&
      configuredCompanyId.toLowerCase() !== expectedCompanyId) {
    postgresFail("social_app_review_configuration_invalid",
      "Configuracao da empresa de revisao recusada.");
  }
  const policy = Object.freeze({
    // The tenant is derived from the fixed product login. The environment may
    // repeat the UUID as an assertion, but it can never select another tenant.
    companyId: expectedCompanyId,
    enabled: flag === "true",
    environment: env.ENVIRONMENT || null,
    realReviewerUiEnabled: env.REAL_REVIEWER_UI_ENABLED === "true"
  });
  if (policy.enabled && (
    !policy.companyId || policy.environment !== "staging" ||
    !policy.realReviewerUiEnabled ||
    env.SOCIAL_INSTAGRAM_ENABLED !== "true" ||
    env.PUBLIC_API_BASE_URL !== APP_REVIEW_STAGING_ORIGIN
  )) {
    postgresFail("social_app_review_configuration_invalid",
      "Configuracao da empresa de revisao recusada.");
  }
  return policy;
}

// Identification remains stable when the review window is closed. This helper
// is not an authorization check and accepts only the server-derived company ID.
function isAppReviewCompany(config, companyId) {
  return validCompanyId(config?.appReview?.companyId) &&
    config.appReview.companyId.toLowerCase() !== CONTROLLED_GATE4_COMPANY_ID &&
    validCompanyId(companyId) &&
    config.appReview.companyId.toLowerCase() === companyId.toLowerCase();
}

function isAppReviewAccessEnabled(config, companyId) {
  return isAppReviewCompany(config, companyId) &&
    config.enabled === true && config.instagramEnabled === true &&
    config.appReview.enabled === true &&
    config.appReview.environment === "staging" &&
    config.appReview.realReviewerUiEnabled === true &&
    config.publicOrigin === APP_REVIEW_STAGING_ORIGIN;
}

function canExternalOperation(config, context, gate) {
  // Lazy loading avoids the config/state-envelope/auth-adapter import cycle.
  const { requireConnectorContext } = require("./connectors/contract");
  const trusted = requireConnectorContext(context, { provider: "instagram" });
  if (isAppReviewCompany(config, trusted.companyId)) {
    return trusted.environment === "staging" &&
      isAppReviewAccessEnabled(config, trusted.companyId);
  }
  return config?.[gate] === true;
}

function canExternalConnection(config, context) {
  return canExternalOperation(config, context, "externalConnectionEnabled");
}

function canExternalPublication(config, context) {
  return canExternalOperation(config, context, "externalPublicationEnabled");
}

module.exports = {
  APP_REVIEW_LOGIN,
  APP_REVIEW_LOGIN_PREFIX,
  APP_REVIEW_STAGING_ORIGIN,
  canExternalConnection,
  canExternalPublication,
  isAppReviewAccessEnabled,
  isAppReviewCompany,
  loadAppReviewPolicy
};
