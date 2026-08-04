"use strict";

const crypto = require("node:crypto");
const { withTransaction } = require("./pool");
const { requireSafeLabel } = require("./validation");
const { assertInternalConnectorAudit } = require("./social-connector-audit");
const {
  requireConnectorContext,
  requireUuid
} = require("../../social/connectors/contract");
const {
  ERROR_DEFINITIONS,
  connectorFail
} = require("../../social/connectors/errors");

const PURPOSES = new Set(["connect", "reconnect"]);
const FAILURE_CODES = new Set(Object.keys(ERROR_DEFINITIONS));

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

function boundedSecret(value, { min, max }) {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length < min ||
    value.length > max ||
    /[\u0000-\u0020\u007f]/.test(value)
  ) {
    connectorFail("connector_contract_invalid");
  }
  return value;
}

function redirectUri(value) {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length < 1 ||
    value.length > 2048 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    connectorFail("connector_contract_invalid");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    connectorFail("connector_contract_invalid");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    parsed.href !== value
  ) {
    connectorFail("connector_contract_invalid");
  }
  return value;
}

function digest(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function expiresAt(value) {
  if (
    !(value instanceof Date) ||
    Number.isNaN(value.getTime()) ||
    value.getTime() <= Date.now()
  ) {
    connectorFail("connector_contract_invalid");
  }
  return new Date(value.getTime());
}

function terminalInput(input, includeFailure = false) {
  const allowed = ["authorizationHandle", "state", "redirectUri", "sessionJti"];
  if (includeFailure) allowed.push("failureCode");
  const source = strictObject(input, allowed);
  const clean = {
    id: uuid(source.authorizationHandle),
    stateDigest: digest(boundedSecret(source.state, { min: 32, max: 2048 })),
    redirectDigest: digest(redirectUri(source.redirectUri)),
    sessionDigest: digest(boundedSecret(source.sessionJti, { min: 16, max: 200 })),
    failureCode: null
  };
  if (includeFailure) {
    if (!FAILURE_CODES.has(source.failureCode)) {
      connectorFail("connector_contract_invalid");
    }
    clean.failureCode = source.failureCode;
  }
  return Object.freeze(clean);
}

async function appendOAuthAudit(client, context, input) {
  const audit = assertInternalConnectorAudit(
    input.action,
    input.outcome,
    input.detailsCode
  );
  await client.query(
    [
      "INSERT INTO ia4tube_social.social_audit_events (",
      " company_id,id,event_id,actor_user_id,connection_id,provider,",
      " correlation_id,action,outcome,details_code",
      ") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)"
    ].join("\n"),
    [
      context.companyId,
      crypto.randomUUID(),
      crypto.randomUUID(),
      context.userId,
      input.connectionId,
      context.provider,
      context.correlationId,
      audit.action,
      audit.outcome,
      audit.detailsCode
    ]
  );
}

function createPostgresOAuthRepository(options = {}) {
  const pool = options.pool;
  const role = requireSafeLabel(
    options.runtimeRole || "ia4tube_social_runtime",
    "runtime_role"
  );
  if (!pool || typeof pool.connect !== "function") {
    connectorFail("connector_contract_invalid");
  }

  function scope(rawContext) {
    const context = requireConnectorContext(rawContext);

    function run(operation) {
      return withTransaction(pool, operation, {
        companyId: context.companyId,
        role
      });
    }

    async function createAuthorization(input = {}) {
      const source = strictObject(input, [
        "authorizationHandle",
        "connectionId",
        "purpose",
        "state",
        "redirectUri",
        "sessionJti",
        "expiresAt"
      ]);
      if (!PURPOSES.has(source.purpose)) {
        connectorFail("connector_contract_invalid");
      }
      const clean = Object.freeze({
        id: uuid(source.authorizationHandle),
        connectionId: uuid(source.connectionId),
        purpose: source.purpose,
        stateDigest: digest(boundedSecret(source.state, { min: 32, max: 2048 })),
        redirectDigest: digest(redirectUri(source.redirectUri)),
        sessionDigest: digest(boundedSecret(source.sessionJti, { min: 16, max: 200 })),
        expiresAt: expiresAt(source.expiresAt)
      });
      return run(async (client) => {
        const expired = await client.query(
          [
            "UPDATE ia4tube_social.social_oauth_transactions",
            "SET failed_at = CURRENT_TIMESTAMP,",
            "  failure_code = 'authorization_expired'",
            "WHERE company_id = $1 AND connection_id = $2 AND provider = $3",
            "  AND consumed_at IS NULL AND cancelled_at IS NULL",
            "  AND failed_at IS NULL AND expires_at <= CURRENT_TIMESTAMP",
            "RETURNING connection_id"
          ].join("\n"),
          [context.companyId, clean.connectionId, context.provider]
        );
        for (const row of expired.rows || []) {
          await appendOAuthAudit(client, context, {
            connectionId: row.connection_id,
            action: "social.authorization.failed",
            outcome: "failed",
            detailsCode: "authorization_expired"
          });
        }
        const result = await client.query(
          [
            "INSERT INTO ia4tube_social.social_oauth_transactions (",
            "  company_id, id, connection_id, provider, purpose,",
            "  state_digest, redirect_uri_digest, initiated_by_user_id,",
            "  session_jti_digest, expires_at, audit_event_id, correlation_id",
            ") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
            "ON CONFLICT DO NOTHING",
            "RETURNING id, connection_id, purpose, expires_at"
          ].join("\n"),
          [
            context.companyId,
            clean.id,
            clean.connectionId,
            context.provider,
            clean.purpose,
            clean.stateDigest,
            clean.redirectDigest,
            context.userId,
            clean.sessionDigest,
            clean.expiresAt,
            context.auditEventId,
            context.correlationId
          ]
        );
        const row = result.rows?.[0];
        if (!row) connectorFail("idempotency_conflict");
        await appendOAuthAudit(client, context, {
          connectionId: row.connection_id,
          action: "social.authorization.started",
          outcome: "succeeded",
          detailsCode: `purpose_${row.purpose}`
        });
        return Object.freeze({
          authorizationHandle: row.id,
          connectionId: row.connection_id,
          purpose: row.purpose,
          expiresAt: new Date(row.expires_at),
          status: "pending"
        });
      });
    }

    async function finish(input, kind) {
      const clean = terminalInput(input, kind === "failed");
      const timestampColumn = kind === "consumed"
        ? "consumed_at"
        : kind === "cancelled"
          ? "cancelled_at"
          : "failed_at";
      return run(async (client) => {
        const result = await client.query(
          [
            "UPDATE ia4tube_social.social_oauth_transactions",
            `SET ${timestampColumn} = CURRENT_TIMESTAMP,`,
            "  failure_code = CASE WHEN $8::text IS NULL",
            "    THEN failure_code ELSE $8 END",
            "WHERE company_id = $1 AND id = $2 AND provider = $3",
            "  AND state_digest = $4 AND redirect_uri_digest = $5",
            "  AND session_jti_digest = $6",
            "  AND initiated_by_user_id = $7",
            "  AND consumed_at IS NULL AND cancelled_at IS NULL",
            "  AND failed_at IS NULL AND expires_at > CURRENT_TIMESTAMP",
            "RETURNING id, connection_id, purpose, expires_at"
          ].join("\n"),
          [
            context.companyId,
            clean.id,
            context.provider,
            clean.stateDigest,
            clean.redirectDigest,
            clean.sessionDigest,
            context.userId,
            clean.failureCode
          ]
        );
        const row = result.rows?.[0];
        if (!row) connectorFail("authorization_expired");
        await appendOAuthAudit(client, context, {
          connectionId: row.connection_id,
          action: `social.authorization.${kind}`,
          outcome: kind === "failed" ? "failed" : "succeeded",
          detailsCode: kind === "failed" ? clean.failureCode : null
        });
        return Object.freeze({
          authorizationHandle: row.id,
          connectionId: row.connection_id,
          purpose: row.purpose,
          expiresAt: new Date(row.expires_at),
          status: kind
        });
      });
    }

    return Object.freeze({
      createAuthorization,
      consumeAuthorization(input = {}) {
        return finish(input, "consumed");
      },
      cancelAuthorization(input = {}) {
        return finish(input, "cancelled");
      },
      failAuthorization(input = {}) {
        return finish(input, "failed");
      }
    });
  }

  return Object.freeze({ scope });
}

module.exports = {
  createPostgresOAuthRepository
};
