"use strict";

const crypto = require("node:crypto");
const { withTransaction } = require("./pool");
const { postgresFail } = require("./errors");
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
const DIGEST_HEX_PATTERN = /^[0-9a-f]{64}$/;
const DIGEST_BYTES = 32;
const CREDENTIAL_TYPE_PATTERN = /^[a-z][a-z0-9_]{0,49}$/;
const KEY_VERSION_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,49}$/;
const TERMINAL_STATUSES = new Set(["consumed", "cancelled", "expired"]);

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

function purpose(value) {
  if (!PURPOSES.has(value)) {
    connectorFail("connector_contract_invalid");
  }
  return value;
}

function optionalPurpose(value, required = false) {
  if (value === undefined) {
    if (required) connectorFail("connector_contract_invalid");
    return null;
  }
  return purpose(value);
}

function fixedDigest(value) {
  const bytes = Buffer.alloc(DIGEST_BYTES);
  const valid = typeof value === "string" && DIGEST_HEX_PATTERN.test(value);
  if (valid) Buffer.from(value, "hex").copy(bytes);
  return Object.freeze({ bytes, valid });
}

function timingSafeDigestEqual(leftValue, rightValue) {
  const left = fixedDigest(leftValue);
  const right = fixedDigest(rightValue);
  try {
    return crypto.timingSafeEqual(left.bytes, right.bytes) &&
      left.valid && right.valid;
  } finally {
    left.bytes.fill(0);
    right.bytes.fill(0);
  }
}

function authorizationBindingsMatch(row, clean) {
  const stateMatches = timingSafeDigestEqual(
    row?.state_digest,
    clean.stateDigest
  );
  const redirectMatches = timingSafeDigestEqual(
    row?.redirect_uri_digest,
    clean.redirectDigest
  );
  const sessionMatches = timingSafeDigestEqual(
    row?.session_jti_digest,
    clean.sessionDigest
  );
  return Boolean(row && stateMatches && redirectMatches && sessionMatches);
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

function optionalExpiry(value) {
  if (value === undefined || value === null) return null;
  return expiresAt(value);
}

function positiveInteger(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    connectorFail("connector_contract_invalid");
  }
  return parsed;
}

function observedAt(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    connectorFail("connector_contract_invalid");
  }
  return new Date(value.getTime());
}

function authorizationInput(input) {
  const source = strictObject(input, [
    "authorizationHandle",
    "connectionId",
    "purpose",
    "state",
    "redirectUri",
    "sessionJti",
    "expiresAt"
  ]);
  return Object.freeze({
    id: uuid(source.authorizationHandle),
    connectionId: uuid(source.connectionId),
    purpose: purpose(source.purpose),
    stateDigest: digest(boundedSecret(source.state, { min: 32, max: 2048 })),
    redirectDigest: digest(redirectUri(source.redirectUri)),
    sessionDigest: digest(boundedSecret(source.sessionJti, { min: 16, max: 200 })),
    expiresAt: expiresAt(source.expiresAt)
  });
}

function consumedCredentialInput(input) {
  const source = strictObject(input, [
    "authorizationHandle",
    "connectionId",
    "purpose",
    "expectedRevision"
  ]);
  return Object.freeze({
    authorizationHandle: uuid(source.authorizationHandle),
    connectionId: uuid(source.connectionId),
    purpose: purpose(source.purpose),
    expectedRevision: positiveInteger(source.expectedRevision)
  });
}

function failedConnectionInput(input) {
  const source = strictObject(input, [
    "authorizationHandle",
    "connectionId",
    "purpose",
    "expectedRevision",
    "failureCode",
    "terminalStatus"
  ]);
  if (
    !FAILURE_CODES.has(source.failureCode) ||
    !TERMINAL_STATUSES.has(source.terminalStatus) ||
    (source.terminalStatus === "cancelled" &&
      source.failureCode !== "authorization_cancelled") ||
    (source.terminalStatus === "expired" &&
      source.failureCode !== "authorization_expired")
  ) {
    connectorFail("connector_contract_invalid");
  }
  return Object.freeze({
    authorizationHandle: uuid(source.authorizationHandle),
    connectionId: uuid(source.connectionId),
    purpose: purpose(source.purpose),
    expectedRevision: positiveInteger(source.expectedRevision),
    failureCode: source.failureCode,
    terminalStatus: source.terminalStatus
  });
}

function terminalStatusPredicate(status) {
  if (status === "consumed") {
    return [
      "  AND consumed_at IS NOT NULL",
      "  AND cancelled_at IS NULL AND failed_at IS NULL"
    ];
  }
  if (status === "cancelled") {
    return [
      "  AND cancelled_at IS NOT NULL",
      "  AND consumed_at IS NULL AND failed_at IS NULL"
    ];
  }
  if (status === "expired") {
    return [
      "  AND failed_at IS NOT NULL",
      "  AND failure_code='authorization_expired'",
      "  AND consumed_at IS NULL AND cancelled_at IS NULL"
    ];
  }
  connectorFail("connector_contract_invalid");
}

function encryptedCredentialEnvelope(value) {
  const source = strictObject(value, [
    "id",
    "credentialType",
    "ciphertext",
    "nonce",
    "authTag",
    "keyVersion",
    "aadVersion",
    "expiresAt"
  ]);
  if (
    typeof source.credentialType !== "string" ||
    !CREDENTIAL_TYPE_PATTERN.test(source.credentialType) ||
    !Buffer.isBuffer(source.ciphertext) ||
    source.ciphertext.length < 1 ||
    source.ciphertext.length > 65536 ||
    !Buffer.isBuffer(source.nonce) ||
    source.nonce.length !== 12 ||
    !Buffer.isBuffer(source.authTag) ||
    source.authTag.length !== 16 ||
    typeof source.keyVersion !== "string" ||
    !KEY_VERSION_PATTERN.test(source.keyVersion) ||
    source.aadVersion !== 1
  ) {
    connectorFail("connector_contract_invalid");
  }
  const expiration = optionalExpiry(source.expiresAt);
  return Object.freeze({
    id: uuid(source.id),
    credentialType: source.credentialType,
    ciphertext: Buffer.from(source.ciphertext),
    nonce: Buffer.from(source.nonce),
    authTag: Buffer.from(source.authTag),
    keyVersion: source.keyVersion,
    aadVersion: 1,
    expiresAt: expiration
  });
}

function clearCredentialEnvelope(envelope) {
  for (const field of ["ciphertext", "nonce", "authTag"]) {
    if (Buffer.isBuffer(envelope?.[field])) envelope[field].fill(0);
  }
}

function terminalInput(
  input,
  includeFailure = false,
  requirePurpose = false,
  requireObservedAt = false
) {
  const allowed = [
    "authorizationHandle",
    "state",
    "redirectUri",
    "sessionJti",
    "purpose"
  ];
  if (includeFailure) allowed.push("failureCode");
  allowed.push("observedAt");
  const source = strictObject(input, allowed);
  const clean = {
    id: uuid(source.authorizationHandle),
    purpose: optionalPurpose(source.purpose, requirePurpose),
    stateDigest: digest(boundedSecret(source.state, { min: 32, max: 2048 })),
    redirectDigest: digest(redirectUri(source.redirectUri)),
    sessionDigest: digest(boundedSecret(source.sessionJti, { min: 16, max: 200 })),
    failureCode: null,
    observedAt: source.observedAt === undefined
      ? null
      : observedAt(source.observedAt)
  };
  if (requireObservedAt && clean.observedAt === null) {
    connectorFail("connector_contract_invalid");
  }
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

    async function expirePendingAuthorizations(client) {
      const expired = await client.query(
        [
          "UPDATE ia4tube_social.social_oauth_transactions",
          "SET failed_at=CURRENT_TIMESTAMP,",
          "  failure_code='authorization_expired'",
          "WHERE company_id=$1 AND provider=$2",
          "  AND consumed_at IS NULL AND cancelled_at IS NULL",
          "  AND failed_at IS NULL AND expires_at <= CURRENT_TIMESTAMP",
          "RETURNING connection_id"
        ].join("\n"),
        [context.companyId, context.provider]
      );
      for (const row of expired.rows || []) {
        await appendOAuthAudit(client, context, {
          connectionId: row.connection_id,
          action: "social.authorization.failed",
          outcome: "failed",
          detailsCode: "authorization_expired"
        });
      }
    }

    async function recoverTerminalPendingConnections(client) {
      const recoverable = await client.query(
        [
          "SELECT c.id,c.revision,terminal.authorization_id,",
          "  terminal.purpose,terminal.consumed_at,terminal.expires_at",
          "FROM ia4tube_social.social_connections c",
          "JOIN LATERAL (",
          "  SELECT o.id AS authorization_id,o.purpose,o.consumed_at,",
          "    o.expires_at,",
          "    COALESCE(o.consumed_at,o.cancelled_at,o.failed_at) AS terminal_at",
          "  FROM ia4tube_social.social_oauth_transactions o",
          "  WHERE o.company_id=c.company_id AND o.connection_id=c.id",
          "    AND o.provider=c.provider",
          "    AND num_nonnulls(o.consumed_at,o.cancelled_at,o.failed_at)=1",
          "  ORDER BY terminal_at DESC,o.created_at DESC,o.id DESC",
          "  LIMIT 1",
          ") terminal ON TRUE",
          "WHERE c.company_id=$1 AND c.provider=$2",
          "  AND c.status='authorization_pending'",
          "  AND NOT EXISTS (",
          "    SELECT 1 FROM ia4tube_social.social_oauth_transactions open_oauth",
          "    WHERE open_oauth.company_id=c.company_id",
          "      AND open_oauth.connection_id=c.id",
          "      AND open_oauth.provider=c.provider",
          "      AND open_oauth.consumed_at IS NULL",
          "      AND open_oauth.cancelled_at IS NULL",
          "      AND open_oauth.failed_at IS NULL",
          "  )",
          "  AND (terminal.consumed_at IS NULL",
          "    OR terminal.expires_at <= CURRENT_TIMESTAMP)",
          "  AND NOT EXISTS (",
          "    SELECT 1 FROM ia4tube_social.social_encrypted_credentials credential",
          "    WHERE credential.company_id=c.company_id",
          "      AND credential.connection_id=c.id",
          "      AND credential.provider=c.provider",
          "      AND credential.id=terminal.authorization_id",
          "      AND credential.revoked_at IS NULL",
          "  )",
          "FOR UPDATE OF c"
        ].join("\n"),
        [context.companyId, context.provider]
      );
      for (const row of recoverable.rows || []) {
        const targetStatus = row.purpose === "reconnect"
          ? "reconnect_required"
          : "failed";
        if (!PURPOSES.has(row.purpose)) connectorFail("connector_contract_invalid");
        const recovered = await client.query(
          [
            "UPDATE ia4tube_social.social_connections",
            "SET status=$4,connected_at=NULL,expires_at=NULL,revoked_at=NULL,",
            "  disconnected_at=NULL,updated_at=CURRENT_TIMESTAMP,",
            "  revision=revision+1",
            "WHERE company_id=$1 AND id=$2 AND provider=$3",
            "  AND status='authorization_pending' AND revision=$5",
            "RETURNING id,revision"
          ].join("\n"),
          [
            context.companyId,
            row.id,
            context.provider,
            targetStatus,
            positiveInteger(row.revision)
          ]
        );
        if (!recovered.rows?.[0]) connectorFail("state_transition_invalid");
        if (row.consumed_at) {
          await appendOAuthAudit(client, context, {
            connectionId: row.id,
            action: "social.authorization.failed",
            outcome: "failed",
            detailsCode: "provider_result_unknown"
          });
        }
        await appendOAuthAudit(client, context, {
          connectionId: row.id,
          action: "social.connection.state_transition",
          outcome: "succeeded",
          detailsCode: targetStatus === "reconnect_required"
            ? "to_reconnect_required"
            : "to_failed"
        });
      }
    }

    async function createAuthorization(input = {}) {
      const clean = authorizationInput(input);
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

    async function createAuthorizationWithPendingConnection(input = {}) {
      const clean = authorizationInput(input);
      return run(async (client) => {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
          [`${context.companyId}:${context.provider}`]
        );
        await expirePendingAuthorizations(client);
        await recoverTerminalPendingConnections(client);
        let connectionRow;
        if (clean.purpose === "reconnect") {
          const reconnect = await client.query(
            [
              "SELECT id,revision",
              "FROM ia4tube_social.social_connections",
              "WHERE company_id=$1 AND provider=$2",
              "  AND status='reconnect_required'",
              "FOR UPDATE"
            ].join("\n"),
            [context.companyId, context.provider]
          );
          if (reconnect.rows?.length !== 1) {
            connectorFail("active_connection_exists");
          }
          const current = reconnect.rows[0];
          const transitioned = await client.query(
            [
              "UPDATE ia4tube_social.social_connections",
              "SET status='authorization_pending',connected_at=NULL,",
              "  expires_at=NULL,revoked_at=NULL,disconnected_at=NULL,",
              "  updated_at=CURRENT_TIMESTAMP,revision=revision+1",
              "WHERE company_id=$1 AND id=$2 AND provider=$3",
              "  AND status='reconnect_required' AND revision=$4",
              "RETURNING id,revision"
            ].join("\n"),
            [
              context.companyId,
              current.id,
              context.provider,
              positiveInteger(current.revision)
            ]
          );
          connectionRow = transitioned.rows?.[0];
          if (!connectionRow) connectorFail("state_transition_invalid");
        } else {
          const connection = await client.query(
            [
              "INSERT INTO ia4tube_social.social_connections (",
              "  company_id, id, provider, status, created_by_user_id, revision",
              ") VALUES ($1,$2,$3,'authorization_pending',$4,1)",
              "ON CONFLICT DO NOTHING",
              "RETURNING id, revision"
            ].join("\n"),
            [
              context.companyId,
              clean.connectionId,
              context.provider,
              context.userId
            ]
          );
          connectionRow = connection.rows?.[0];
          if (!connectionRow) connectorFail("active_connection_exists");
        }
        const authorization = await client.query(
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
            connectionRow.id,
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
        const authorizationRow = authorization.rows?.[0];
        if (!authorizationRow) connectorFail("idempotency_conflict");
        await appendOAuthAudit(client, context, {
          connectionId: connectionRow.id,
          action: "social.connection.state_transition",
          outcome: "succeeded",
          detailsCode: "to_authorization_pending"
        });
        await appendOAuthAudit(client, context, {
          connectionId: connectionRow.id,
          action: "social.authorization.started",
          outcome: "succeeded",
          detailsCode: `purpose_${authorizationRow.purpose}`
        });
        return Object.freeze({
          authorizationHandle: authorizationRow.id,
          connectionId: authorizationRow.connection_id,
          purpose: authorizationRow.purpose,
          expiresAt: new Date(authorizationRow.expires_at),
          status: "pending",
          revision: positiveInteger(connectionRow.revision)
        });
      });
    }

    async function storeConsumedAuthorizationCredential(
      input = {},
      credentialEnvelope
    ) {
      const clean = consumedCredentialInput(input);
      const credential = encryptedCredentialEnvelope(credentialEnvelope);
      try {
        if (credential.id !== clean.authorizationHandle) {
          connectorFail("connector_contract_invalid");
        }
        return await run(async (client) => {
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
            [`${context.companyId}:${context.provider}`]
          );
          const authorization = await client.query(
            [
              "SELECT id, connection_id, purpose",
              "FROM ia4tube_social.social_oauth_transactions",
              "WHERE company_id=$1 AND id=$2 AND provider=$3",
              "  AND connection_id=$4 AND initiated_by_user_id=$5",
              "  AND purpose=$6 AND consumed_at IS NOT NULL",
              "  AND cancelled_at IS NULL AND failed_at IS NULL",
              "FOR UPDATE"
            ].join("\n"),
            [
              context.companyId,
              clean.authorizationHandle,
              context.provider,
              clean.connectionId,
              context.userId,
              clean.purpose
            ]
          );
          if (authorization.rows?.length !== 1) {
            connectorFail("authorization_expired");
          }
          const connectionValues = [
            context.companyId,
            clean.connectionId,
            context.provider
          ];
          const revisionPredicate = clean.expectedRevision === null
            ? null
            : `  AND revision=$${connectionValues.push(clean.expectedRevision)}`;
          const connection = await client.query(
            [
              "SELECT id, revision",
              "FROM ia4tube_social.social_connections",
              "WHERE company_id=$1 AND id=$2 AND provider=$3",
              "  AND status='authorization_pending'",
              revisionPredicate,
              "FOR UPDATE"
            ].filter(Boolean).join("\n"),
            connectionValues
          );
          if (connection.rows?.length !== 1) {
            connectorFail("state_transition_invalid");
          }
          const previous = await client.query(
            [
              "UPDATE ia4tube_social.social_encrypted_credentials",
              "SET revoked_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP,",
              "  revision=revision+1",
              "WHERE company_id=$1 AND connection_id=$2 AND provider=$3",
              "  AND credential_type=$4 AND revoked_at IS NULL",
              "RETURNING id"
            ].join("\n"),
            [
              context.companyId,
              clean.connectionId,
              context.provider,
              credential.credentialType
            ]
          );
          const stored = await client.query(
            [
              "INSERT INTO ia4tube_social.social_encrypted_credentials (",
              "  company_id,id,provider,connection_id,credential_type,",
              "  ciphertext,nonce,auth_tag,key_version,aad_version,expires_at",
              ") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
              "ON CONFLICT DO NOTHING",
              "RETURNING id,credential_type,key_version,aad_version,",
              "  expires_at,revision"
            ].join("\n"),
            [
              context.companyId,
              credential.id,
              context.provider,
              clean.connectionId,
              credential.credentialType,
              credential.ciphertext,
              credential.nonce,
              credential.authTag,
              credential.keyVersion,
              credential.aadVersion,
              credential.expiresAt
            ]
          );
          const storedRow = stored.rows?.[0];
          if (!storedRow) connectorFail("idempotency_conflict");
          if (Number(previous.rowCount || 0) > 0) {
            await appendOAuthAudit(client, context, {
              connectionId: clean.connectionId,
              action: "social.credential.removed",
              outcome: "succeeded",
              detailsCode: "credential_revoked"
            });
          }
          await appendOAuthAudit(client, context, {
            connectionId: clean.connectionId,
            action: "social.credential.stored",
            outcome: "succeeded",
            detailsCode: "credential_encrypted"
          });
          return Object.freeze({
            authorizationHandle: clean.authorizationHandle,
            connectionId: clean.connectionId,
            purpose: clean.purpose,
            status: "credential_stored",
            revision: positiveInteger(connection.rows[0].revision),
            credential: Object.freeze({
              id: storedRow.id,
              credentialType: storedRow.credential_type,
              keyVersion: storedRow.key_version,
              aadVersion: positiveInteger(storedRow.aad_version),
              expiresAt: storedRow.expires_at
                ? new Date(storedRow.expires_at)
                : null,
              revision: positiveInteger(storedRow.revision)
            })
          });
        });
      } finally {
        clearCredentialEnvelope(credential);
      }
    }

    async function failAuthorizationConnection(input = {}) {
      const clean = failedConnectionInput(input);
      const terminalPredicate = terminalStatusPredicate(clean.terminalStatus);
      return run(async (client) => {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
          [`${context.companyId}:${context.provider}`]
        );
        const authorization = await client.query(
          [
            "SELECT id, connection_id, purpose",
            "FROM ia4tube_social.social_oauth_transactions",
            "WHERE company_id=$1 AND id=$2 AND provider=$3",
            "  AND connection_id=$4 AND initiated_by_user_id=$5",
            "  AND purpose=$6",
            ...terminalPredicate,
            "FOR UPDATE"
          ].join("\n"),
          [
            context.companyId,
            clean.authorizationHandle,
            context.provider,
            clean.connectionId,
            context.userId,
            clean.purpose
          ]
        );
        if (authorization.rows?.length !== 1) {
          connectorFail("authorization_expired");
        }
        const targetStatus = clean.purpose === "reconnect"
          ? "reconnect_required"
          : "failed";
        const failedValues = [
          context.companyId,
          clean.connectionId,
          context.provider,
          targetStatus
        ];
        const revisionPredicate = clean.expectedRevision === null
          ? null
          : `  AND revision=$${failedValues.push(clean.expectedRevision)}`;
        const failed = await client.query(
          [
            "UPDATE ia4tube_social.social_connections",
            "SET status=$4,connected_at=NULL,expires_at=NULL,revoked_at=NULL,",
            "  disconnected_at=NULL,updated_at=CURRENT_TIMESTAMP,",
            "  revision=revision+1",
            "WHERE company_id=$1 AND id=$2 AND provider=$3",
            "  AND status='authorization_pending'",
            revisionPredicate,
            "RETURNING id,revision"
          ].filter(Boolean).join("\n"),
          failedValues
        );
        const failedRow = failed.rows?.[0];
        if (!failedRow) connectorFail("state_transition_invalid");
        await appendOAuthAudit(client, context, {
          connectionId: clean.connectionId,
          action: "social.authorization.failed",
          outcome: "failed",
          detailsCode: clean.failureCode
        });
        await appendOAuthAudit(client, context, {
          connectionId: clean.connectionId,
          action: "social.connection.state_transition",
          outcome: "succeeded",
          detailsCode: targetStatus === "reconnect_required"
            ? "to_reconnect_required"
            : "to_failed"
        });
        return Object.freeze({
          authorizationHandle: clean.authorizationHandle,
          connectionId: failedRow.id,
          purpose: clean.purpose,
          terminalStatus: clean.terminalStatus,
          failureCode: clean.failureCode,
          status: targetStatus,
          revision: positiveInteger(failedRow.revision)
        });
      });
    }

    async function finish(input, kind) {
      const clean = terminalInput(
        input,
        kind === "failed",
        kind === "expired",
        kind === "expired"
      );
      const timestampColumn = kind === "consumed"
        ? "consumed_at"
        : kind === "cancelled"
          ? "cancelled_at"
          : "failed_at";
      const failureCode = kind === "expired"
        ? "authorization_expired"
        : clean.failureCode;
      const purposePredicate = clean.purpose === null
        ? null
        : "  AND purpose = $5";
      const identityValues = [
        context.companyId,
        clean.id,
        context.provider,
        context.userId
      ];
      if (clean.purpose !== null) identityValues.push(clean.purpose);
      const observedAtParameter = clean.observedAt !== null
        ? identityValues.length + 1
        : null;
      const expiryPredicate = kind === "expired"
        ? `expires_at <= $${observedAtParameter}`
        : clean.observedAt === null
          ? "expires_at > CURRENT_TIMESTAMP"
          : `expires_at > $${observedAtParameter}`;
      const updateValues = [...identityValues];
      if (clean.observedAt !== null) updateValues.push(clean.observedAt);
      const failureCodeParameter = updateValues.length + 1;
      updateValues.push(failureCode);
      return run(async (client) => {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
          [`${context.companyId}:${context.provider}`]
        );
        const selected = await client.query(
          [
            "SELECT id, connection_id, purpose, state_digest,",
            "  redirect_uri_digest, session_jti_digest, expires_at,",
            "  consumed_at, cancelled_at, failed_at, failure_code",
            "FROM ia4tube_social.social_oauth_transactions",
            "WHERE company_id = $1 AND id = $2 AND provider = $3",
            "  AND initiated_by_user_id = $4",
            purposePredicate,
            "FOR UPDATE"
          ].filter(Boolean).join("\n"),
          identityValues
        );
        const selectedRow = selected.rows?.[0];
        if (!authorizationBindingsMatch(selectedRow, clean)) {
          connectorFail("authorization_expired");
        }
        if (selectedRow.consumed_at) {
          postgresFail(
            "social_oauth_state_already_consumed",
            "Autorizacao OAuth ja consumida."
          );
        }
        if (
          selectedRow.cancelled_at ||
          selectedRow.failure_code === "authorization_cancelled"
        ) {
          connectorFail("authorization_cancelled");
        }
        const result = await client.query(
          [
            "UPDATE ia4tube_social.social_oauth_transactions",
            `SET ${timestampColumn} = CURRENT_TIMESTAMP,`,
            `  failure_code = $${failureCodeParameter}`,
            "WHERE company_id = $1 AND id = $2 AND provider = $3",
            "  AND initiated_by_user_id = $4",
            purposePredicate,
            "  AND consumed_at IS NULL AND cancelled_at IS NULL",
            `  AND failed_at IS NULL AND ${expiryPredicate}`,
            "RETURNING id, connection_id, purpose, expires_at"
          ].filter(Boolean).join("\n"),
          updateValues
        );
        const row = result.rows?.[0];
        if (!row) connectorFail("authorization_expired");
        let connectionRevision = null;
        if (clean.observedAt !== null) {
          const connection = await client.query(
            [
              "SELECT id,revision",
              "FROM ia4tube_social.social_connections",
              "WHERE company_id=$1 AND id=$2 AND provider=$3",
              "  AND status='authorization_pending'",
              "FOR UPDATE"
            ].join("\n"),
            [context.companyId, row.connection_id, context.provider]
          );
          if (connection.rows?.length !== 1) {
            connectorFail("state_transition_invalid");
          }
          connectionRevision = positiveInteger(connection.rows[0].revision);
        }
        await appendOAuthAudit(client, context, {
          connectionId: row.connection_id,
          action: kind === "expired"
            ? "social.authorization.failed"
            : `social.authorization.${kind}`,
          outcome: ["failed", "expired"].includes(kind)
            ? "failed"
            : "succeeded",
          detailsCode: ["failed", "expired"].includes(kind)
            ? failureCode
            : null
        });
        return Object.freeze({
          authorizationHandle: row.id,
          connectionId: row.connection_id,
          purpose: row.purpose,
          expiresAt: new Date(row.expires_at),
          status: kind,
          ...(connectionRevision === null
            ? {}
            : { connectionRevision })
        });
      });
    }

    return Object.freeze({
      createAuthorization,
      createAuthorizationWithPendingConnection,
      consumeAuthorization(input = {}) {
        return finish(input, "consumed");
      },
      cancelAuthorization(input = {}) {
        return finish(input, "cancelled");
      },
      failAuthorization(input = {}) {
        return finish(input, "failed");
      },
      expireAuthorization(input = {}) {
        return finish(input, "expired");
      },
      failAuthorizationConnection,
      storeConsumedAuthorizationCredential
    });
  }

  return Object.freeze({ scope });
}

module.exports = {
  createPostgresOAuthRepository
};
