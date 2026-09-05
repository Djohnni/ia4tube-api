"use strict";

const ERROR_DEFINITIONS = Object.freeze({
  provider_not_supported: Object.freeze({ retryable: false }),
  capability_not_supported: Object.freeze({ retryable: false }),
  authorization_cancelled: Object.freeze({ retryable: false }),
  authorization_expired: Object.freeze({ retryable: false }),
  invalid_account_type: Object.freeze({ retryable: false }),
  controlled_account_mismatch: Object.freeze({ retryable: false }),
  permission_missing: Object.freeze({ retryable: false }),
  credential_unavailable: Object.freeze({ retryable: false }),
  provider_temporary_failure: Object.freeze({ retryable: true }),
  provider_permanent_failure: Object.freeze({ retryable: false }),
  provider_result_unknown: Object.freeze({ retryable: false }),
  disconnect_failed: Object.freeze({ retryable: true }),
  connector_contract_invalid: Object.freeze({ retryable: false }),
  connector_registration_duplicate: Object.freeze({ retryable: false }),
  social_context_invalid: Object.freeze({ retryable: false }),
  resource_unavailable: Object.freeze({ retryable: false }),
  state_transition_invalid: Object.freeze({ retryable: false }),
  active_connection_exists: Object.freeze({ retryable: false }),
  idempotency_conflict: Object.freeze({ retryable: false }),
  synthetic_connector_forbidden: Object.freeze({ retryable: false }),
  external_capability_disabled: Object.freeze({ retryable: false })
});

const NORMALIZED_PROVIDER_ERROR_CODES = Object.freeze([
  "provider_not_supported",
  "capability_not_supported",
  "authorization_cancelled",
  "authorization_expired",
  "invalid_account_type",
  "controlled_account_mismatch",
  "permission_missing",
  "credential_unavailable",
  "provider_temporary_failure",
  "provider_permanent_failure",
  "provider_result_unknown",
  "disconnect_failed"
]);
const CORRELATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class SocialConnectorError extends Error {
  constructor(code) {
    const definition = ERROR_DEFINITIONS[code];
    if (!definition) {
      throw new TypeError("Codigo de erro social invalido.");
    }
    super("Operacao social recusada.");
    this.name = "SocialConnectorError";
    this.code = code;
    this.retryable = definition.retryable;
  }
}

function connectorFail(code) {
  throw new SocialConnectorError(code);
}

function normalizeConnectorError(error, fallback = "provider_result_unknown") {
  if (
    error instanceof SocialConnectorError &&
    Object.hasOwn(ERROR_DEFINITIONS, error.code)
  ) {
    return new SocialConnectorError(error.code);
  }
  return new SocialConnectorError(
    Object.hasOwn(ERROR_DEFINITIONS, fallback)
      ? fallback
      : "provider_result_unknown"
  );
}

function publicConnectorError(error, correlationId) {
  const normalized = normalizeConnectorError(error);
  return Object.freeze({
    code: normalized.code,
    retryable: normalized.retryable,
    correlationId:
      typeof correlationId === "string" &&
      CORRELATION_ID_PATTERN.test(correlationId)
        ? correlationId.toLowerCase()
        : null
  });
}

module.exports = {
  ERROR_DEFINITIONS,
  NORMALIZED_PROVIDER_ERROR_CODES,
  SocialConnectorError,
  connectorFail,
  normalizeConnectorError,
  publicConnectorError
};
