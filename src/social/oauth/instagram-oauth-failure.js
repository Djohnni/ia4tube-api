"use strict";

const OAUTH_FAILURE_STAGES = Object.freeze({
  CODE_EXCHANGE: "code_exchange",
  TOKEN_EXTENSION_OR_VALIDATION: "token_extension_or_validation",
  PROFESSIONAL_ACCOUNT_DISCOVERY: "professional_account_discovery",
  CONTROLLED_ACCOUNT_VALIDATION: "controlled_account_validation",
  VAULT_STORE: "vault_store",
  CONNECTION_PERSISTENCE: "connection_persistence",
  ATOMIC_FINALIZATION: "atomic_finalization"
});

const STAGE_DETAILS = Object.freeze({
  [OAUTH_FAILURE_STAGES.CODE_EXCHANGE]: "provider_code_exchange_failed",
  [OAUTH_FAILURE_STAGES.TOKEN_EXTENSION_OR_VALIDATION]:
    "provider_token_extension_failed",
  [OAUTH_FAILURE_STAGES.PROFESSIONAL_ACCOUNT_DISCOVERY]:
    "provider_account_discovery_failed",
  [OAUTH_FAILURE_STAGES.CONTROLLED_ACCOUNT_VALIDATION]:
    "provider_account_ineligible",
  [OAUTH_FAILURE_STAGES.VAULT_STORE]: "token_vault_store_failed",
  [OAUTH_FAILURE_STAGES.CONNECTION_PERSISTENCE]:
    "connection_persistence_failed",
  [OAUTH_FAILURE_STAGES.ATOMIC_FINALIZATION]:
    "connection_finalization_failed"
});

const OAUTH_FAILURE_DETAIL_CODES = Object.freeze([
  ...new Set([
    ...Object.values(STAGE_DETAILS),
    "controlled_username_mismatch",
    "provider_permissions_missing"
  ])
]);

function classifyOAuthFailure(stage, error) {
  if (
    stage === OAUTH_FAILURE_STAGES.TOKEN_EXTENSION_OR_VALIDATION &&
    error?.code === "permission_missing"
  ) {
    return "provider_permissions_missing";
  }
  if (
    stage === OAUTH_FAILURE_STAGES.CONTROLLED_ACCOUNT_VALIDATION &&
    error?.code === "controlled_account_mismatch"
  ) {
    return "controlled_username_mismatch";
  }
  return STAGE_DETAILS[stage] || "connection_finalization_failed";
}

module.exports = {
  OAUTH_FAILURE_DETAIL_CODES,
  OAUTH_FAILURE_STAGES,
  classifyOAuthFailure
};
