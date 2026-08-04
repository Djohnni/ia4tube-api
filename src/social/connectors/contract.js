"use strict";

const {
  isAuthenticatedSocialPrincipal
} = require("../auth-adapter");
const {
  PROVIDER_PATTERN,
  UUID_PATTERN
} = require("../../persistence/postgres/validation");
const { connectorFail } = require("./errors");

const CONNECTOR_CAPABILITIES = Object.freeze([
  "beginAuthorization",
  "discoverAccount",
  "publishImage",
  "getPublicationStatus",
  "disconnect"
]);
const CAPABILITY_SET = new Set(CONNECTOR_CAPABILITIES);
const PROVIDER_IDENTIFIERS = Object.freeze(["instagram"]);
const PROVIDER_SET = new Set(PROVIDER_IDENTIFIERS);
const ENVIRONMENTS = new Set(["test", "staging", "production"]);
const AUTHORITY_FIELDS = new Set([
  "companyId",
  "company_id",
  "tenantId",
  "tenant_id",
  "userId",
  "user_id",
  "provider",
  "environment"
]);
const TRUSTED_CONTEXTS = new WeakSet();

function requireUuid(value) {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    !UUID_PATTERN.test(value) ||
    value.toLowerCase() === "00000000-0000-0000-0000-000000000000"
  ) {
    connectorFail("social_context_invalid");
  }
  return value.toLowerCase();
}

function requireProviderIdentifier(value) {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    !PROVIDER_PATTERN.test(value) ||
    !PROVIDER_SET.has(value)
  ) {
    connectorFail("provider_not_supported");
  }
  return value;
}

function requireEnvironment(value) {
  if (!ENVIRONMENTS.has(value)) connectorFail("social_context_invalid");
  return value;
}

function createConnectorContext({
  principal,
  provider,
  environment,
  correlationId,
  auditEventId
} = {}) {
  if (!isAuthenticatedSocialPrincipal(principal)) {
    connectorFail("social_context_invalid");
  }
  const context = Object.freeze({
    companyId: requireUuid(principal.companyId),
    userId: requireUuid(principal.userId),
    provider: requireProviderIdentifier(provider),
    environment: requireEnvironment(environment),
    correlationId: requireUuid(correlationId),
    auditEventId: requireUuid(auditEventId)
  });
  TRUSTED_CONTEXTS.add(context);
  return context;
}

function requireConnectorContext(context, expected = {}) {
  if (
    !context ||
    typeof context !== "object" ||
    !TRUSTED_CONTEXTS.has(context) ||
    !Object.isFrozen(context)
  ) {
    connectorFail("social_context_invalid");
  }
  if (
    expected.provider !== undefined &&
    context.provider !== expected.provider
  ) {
    connectorFail("resource_unavailable");
  }
  if (
    expected.environment !== undefined &&
    context.environment !== expected.environment
  ) {
    connectorFail("social_context_invalid");
  }
  return context;
}

function requireCapability(value) {
  if (!CAPABILITY_SET.has(value)) {
    connectorFail("capability_not_supported");
  }
  return value;
}

function assertNoAuthorityFields(
  value,
  visited = new Set(),
  depth = 0,
  budget = { nodes: 0 }
) {
  if (!value || typeof value !== "object") return value;
  budget.nodes += 1;
  if (
    depth > 8 ||
    budget.nodes > 100 ||
    visited.has(value)
  ) {
    connectorFail("connector_contract_invalid");
  }
  visited.add(value);
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set) {
      connectorFail("connector_contract_invalid");
    }
    if (AUTHORITY_FIELDS.has(key)) connectorFail("social_context_invalid");
    assertNoAuthorityFields(descriptor.value, visited, depth + 1, budget);
  }
  visited.delete(value);
  return value;
}

module.exports = {
  CONNECTOR_CAPABILITIES,
  PROVIDER_IDENTIFIERS,
  assertNoAuthorityFields,
  createConnectorContext,
  requireCapability,
  requireConnectorContext,
  requireEnvironment,
  requireProviderIdentifier,
  requireUuid
};
