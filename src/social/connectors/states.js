"use strict";

const { connectorFail } = require("./errors");

const CONNECTION_STATES = Object.freeze([
  "disconnected",
  "authorization_pending",
  "connected",
  "reconnect_required",
  "disconnecting",
  "failed"
]);
const PUBLICATION_STATES = Object.freeze([
  "ready",
  "publishing",
  "provider_confirming",
  "published",
  "failed_temporary",
  "failed_permanent"
]);

const CONNECTION_TRANSITIONS = Object.freeze({
  disconnected: Object.freeze(["authorization_pending"]),
  authorization_pending: Object.freeze([
    "connected",
    "disconnected",
    "reconnect_required",
    "failed"
  ]),
  connected: Object.freeze([
    "reconnect_required",
    "disconnecting",
    "failed"
  ]),
  reconnect_required: Object.freeze([
    "authorization_pending",
    "disconnecting",
    "failed"
  ]),
  disconnecting: Object.freeze(["disconnected", "failed"]),
  failed: Object.freeze(["authorization_pending", "disconnecting"])
});

const PUBLICATION_TRANSITIONS = Object.freeze({
  ready: Object.freeze(["publishing"]),
  publishing: Object.freeze([
    "provider_confirming",
    "published",
    "failed_temporary",
    "failed_permanent"
  ]),
  provider_confirming: Object.freeze([
    "published",
    "failed_temporary",
    "failed_permanent"
  ]),
  published: Object.freeze([]),
  failed_temporary: Object.freeze(["publishing"]),
  failed_permanent: Object.freeze([])
});

function requireState(value, transitions) {
  if (!Object.hasOwn(transitions, value)) {
    connectorFail("state_transition_invalid");
  }
  return value;
}

function transition(current, next, transitions) {
  requireState(current, transitions);
  requireState(next, transitions);
  if (!transitions[current].includes(next)) {
    connectorFail("state_transition_invalid");
  }
  return next;
}

function transitionConnectionState(current, next) {
  return transition(current, next, CONNECTION_TRANSITIONS);
}

function transitionPublicationState(current, next) {
  return transition(current, next, PUBLICATION_TRANSITIONS);
}

const PROVIDER_REFERENCE_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,498}$/;
const SENSITIVE_REFERENCE_PATTERN =
  /(access[_-]?token|refresh[_-]?token|authorization|bearer|password|secret|oauth[_-]?code|api[_-]?key|ciphertext)/i;

function isSafeProviderReference(value) {
  return Boolean(
    typeof value === "string" &&
    PROVIDER_REFERENCE_PATTERN.test(value) &&
    !SENSITIVE_REFERENCE_PATTERN.test(value)
  );
}

function assertPublicationConfirmation(record = {}) {
  requireState(record.state, PUBLICATION_TRANSITIONS);
  const hasConfirmed =
    record.confirmedProviderReference !== undefined &&
    record.confirmedProviderReference !== null;
  if (
    record.state === "published"
      ? !isSafeProviderReference(record.confirmedProviderReference)
      : hasConfirmed
  ) {
    connectorFail("connector_contract_invalid");
  }
  if (
    record.reconciliationReference !== undefined &&
    record.reconciliationReference !== null &&
    !isSafeProviderReference(record.reconciliationReference)
  ) {
    connectorFail("connector_contract_invalid");
  }
  return record;
}

function isPublicationConfirmed(record = {}) {
  assertPublicationConfirmation(record);
  return record.state === "published";
}

module.exports = {
  CONNECTION_STATES,
  CONNECTION_TRANSITIONS,
  PUBLICATION_STATES,
  PUBLICATION_TRANSITIONS,
  assertPublicationConfirmation,
  isSafeProviderReference,
  isPublicationConfirmed,
  transitionConnectionState,
  transitionPublicationState
};
