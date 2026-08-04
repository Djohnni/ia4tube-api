"use strict";

const crypto = require("node:crypto");
const { withTransaction } = require("./pool");
const { requireSafeLabel } = require("./validation");
const {
  requireConnectorContext,
  requireUuid
} = require("../../social/connectors/contract");
const {
  ERROR_DEFINITIONS,
  connectorFail
} = require("../../social/connectors/errors");

const ACTIONS = new Set([
  "social.authorization.begin",
  "social.account.discover",
  "social.publication.publish",
  "social.publication.reconcile",
  "social.connection.disconnect"
]);
const OUTCOMES = new Set(["succeeded", "rejected", "failed"]);
const DETAIL_CODES = new Set(Object.keys(ERROR_DEFINITIONS));
const INTERNAL_ACTION_DETAILS = Object.freeze({
  "social.connection.state_transition": new Set([
    "to_authorization_pending",
    "to_connected",
    "to_reconnect_required",
    "to_disconnecting",
    "to_disconnected",
    "to_failed"
  ]),
  "social.connection.disconnected": new Set([
    "account_revoked",
    "no_active_account"
  ]),
  "social.credential.removed": new Set(["credential_revoked"]),
  "social.credential.stored": new Set(["credential_encrypted"]),
  "social.credential.bound": new Set([
    "credential_bound_from_authorization"
  ]),
  "social.publication.created": new Set(["state_ready"]),
  "social.publication.attempt_recorded": new Set([
    "state_started",
    "state_provider_confirming",
    "state_published",
    "state_failed_temporary",
    "state_failed_permanent"
  ]),
  "social.publication.state_transition": new Set([
    "to_publishing",
    "to_provider_confirming",
    "to_published",
    "to_failed_temporary",
    "to_failed_permanent"
  ]),
  "social.authorization.started": new Set([
    "purpose_connect",
    "purpose_reconnect"
  ]),
  "social.authorization.consumed": new Set([null]),
  "social.authorization.cancelled": new Set([null]),
  "social.authorization.failed": DETAIL_CODES
});

function strictObject(value, allowedKeys) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    connectorFail("connector_contract_invalid");
  }
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!allowedKeys.includes(key) || !descriptor || descriptor.get || descriptor.set) {
      connectorFail("connector_contract_invalid");
    }
  }
  return value;
}

function uuid(value) {
  try {
    return requireUuid(value);
  } catch {
    connectorFail("connector_contract_invalid");
  }
}

function optionalUuid(value) {
  return value === undefined || value === null ? null : uuid(value);
}

function assertAuthority(context, source) {
  const comparisons = [
    ["companyId", context.companyId],
    ["actorUserId", context.userId],
    ["provider", context.provider],
    ["auditEventId", context.auditEventId],
    ["correlationId", context.correlationId]
  ];
  for (const [key, expected] of comparisons) {
    if (source[key] !== undefined && source[key] !== expected) {
      connectorFail("social_context_invalid");
    }
  }
}

function normalizedEvent(context, event) {
  const source = strictObject(event, [
    "companyId",
    "actorUserId",
    "provider",
    "auditEventId",
    "correlationId",
    "connectionId",
    "publicationId",
    "action",
    "outcome",
    "detailsCode"
  ]);
  assertAuthority(context, source);
  if (!ACTIONS.has(source.action) || !OUTCOMES.has(source.outcome)) {
    connectorFail("connector_contract_invalid");
  }
  const detailsCode = source.detailsCode == null ? null : source.detailsCode;
  if (
    (detailsCode !== null && !DETAIL_CODES.has(detailsCode)) ||
    (source.outcome === "succeeded" && detailsCode !== null) ||
    (source.outcome !== "succeeded" && detailsCode === null)
  ) {
    connectorFail("connector_contract_invalid");
  }
  return Object.freeze({
    eventId: context.auditEventId,
    correlationId: context.correlationId,
    connectionId: optionalUuid(source.connectionId),
    publicationId: optionalUuid(source.publicationId),
    action: source.action,
    outcome: source.outcome,
    detailsCode
  });
}

function assertInternalConnectorAudit(action, outcome, detailsCode) {
  const allowedDetails = INTERNAL_ACTION_DETAILS[action];
  const normalizedDetails = detailsCode == null ? null : detailsCode;
  if (
    !allowedDetails ||
    !OUTCOMES.has(outcome) ||
    !allowedDetails.has(normalizedDetails) ||
    (action === "social.authorization.failed"
      ? outcome !== "failed"
      : outcome !== "succeeded")
  ) {
    connectorFail("connector_contract_invalid");
  }
  return Object.freeze({
    action,
    outcome,
    detailsCode: normalizedDetails
  });
}

function sameEvent(row, context, event) {
  return Boolean(
    row &&
    row.event_id === event.eventId &&
    row.actor_user_id === context.userId &&
    row.provider === context.provider &&
    row.correlation_id === event.correlationId &&
    (row.connection_id || null) === event.connectionId &&
    (row.publication_id || null) === event.publicationId &&
    row.action === event.action &&
    row.outcome === event.outcome &&
    (row.details_code || null) === event.detailsCode
  );
}

async function resolveOwnedReferences(client, context, event) {
  if (!event.connectionId && !event.publicationId) return event;
  const result = await client.query(
    [
      "SELECT",
      " (SELECT connection.id",
      "  FROM ia4tube_social.social_connections connection",
      "  WHERE connection.company_id=$1 AND connection.id=$2",
      "    AND connection.provider=$4) AS connection_id,",
      " (SELECT publication.id",
      "  FROM ia4tube_social.social_publications publication",
      "  WHERE publication.company_id=$1 AND publication.id=$3",
      "    AND publication.provider=$4) AS publication_id,",
      " (SELECT publication.connection_id",
      "  FROM ia4tube_social.social_publications publication",
      "  WHERE publication.company_id=$1 AND publication.id=$3",
      "    AND publication.provider=$4) AS publication_connection_id"
    ].join("\n"),
    [
      context.companyId,
      event.connectionId,
      event.publicationId,
      context.provider
    ]
  );
  const row = result.rows?.[0] || {};
  let publicationId = row.publication_id || null;
  if (
    row.connection_id &&
    publicationId &&
    row.publication_connection_id !== row.connection_id
  ) {
    publicationId = null;
  }
  return Object.freeze({
    ...event,
    connectionId: row.connection_id || null,
    publicationId
  });
}

function createPostgresConnectorAudit(options = {}) {
  const pool = options.pool;
  const role = requireSafeLabel(
    options.runtimeRole || "ia4tube_social_runtime",
    "runtime_role"
  );
  if (!pool || typeof pool.connect !== "function") {
    connectorFail("connector_contract_invalid");
  }

  async function append(rawContext, rawEvent) {
    const context = requireConnectorContext(rawContext);
    const requestedEvent = normalizedEvent(context, rawEvent);
    return withTransaction(pool, async (client) => {
      const event = await resolveOwnedReferences(
        client,
        context,
        requestedEvent
      );
      const inserted = await client.query(
        [
          "INSERT INTO ia4tube_social.social_audit_events (",
          " company_id,id,event_id,actor_user_id,connection_id,publication_id,",
          " provider,correlation_id,action,outcome,details_code",
          ") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
          "ON CONFLICT (company_id,event_id) DO NOTHING",
          "RETURNING event_id"
        ].join("\n"),
        [
          context.companyId,
          crypto.randomUUID(),
          event.eventId,
          context.userId,
          event.connectionId,
          event.publicationId,
          context.provider,
          event.correlationId,
          event.action,
          event.outcome,
          event.detailsCode
        ]
      );
      if (!inserted.rows?.[0]) {
        const existing = await client.query(
          [
            "SELECT event_id,actor_user_id,connection_id,publication_id,",
            " provider,correlation_id,action,outcome,details_code",
            "FROM ia4tube_social.social_audit_events",
            "WHERE company_id=$1 AND event_id=$2"
          ].join("\n"),
          [context.companyId, event.eventId]
        );
        if (!sameEvent(existing.rows?.[0], context, event)) {
          connectorFail("idempotency_conflict");
        }
      }
      return Object.freeze({
        auditEventId: event.eventId,
        correlationId: event.correlationId,
        action: event.action,
        outcome: event.outcome
      });
    }, { companyId: context.companyId, role });
  }

  return Object.freeze({ append });
}

module.exports = {
  AUDIT_ACTIONS: Object.freeze([...ACTIONS]),
  INTERNAL_AUDIT_ACTIONS: Object.freeze(Object.keys(INTERNAL_ACTION_DETAILS)),
  assertInternalConnectorAudit,
  createPostgresConnectorAudit
};
