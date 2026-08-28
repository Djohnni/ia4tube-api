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
  CONNECTION_STATES,
  PUBLICATION_STATES,
  assertPublicationConfirmation,
  isSafeProviderReference,
  transitionConnectionState,
  transitionPublicationState
} = require("../../social/connectors/states");
const {
  ERROR_DEFINITIONS,
  connectorFail
} = require("../../social/connectors/errors");

const CAPABILITIES = new Set([
  "beginAuthorization",
  "discoverAccount",
  "publishImage",
  "getPublicationStatus",
  "disconnect"
]);
const BLOCKING_CONNECTION_STATES = Object.freeze([
  "pending",
  "active",
  "authorization_pending",
  "connected",
  "reconnect_required",
  "disconnecting"
]);
const PROFESSIONAL_ACCOUNT_TYPES = new Set(["business", "creator"]);
const ERROR_CODES = new Set(Object.keys(ERROR_DEFINITIONS));
const LOCAL_CONNECTION_HEALTH = new Set([
  "authorization_pending",
  "disconnected",
  "disconnecting",
  "failed",
  "healthy",
  "reconnect_required"
]);
const PUBLICATION_ATTEMPT_STATES = new Set([
  "started",
  "provider_confirming",
  "published",
  "failed_temporary",
  "failed_permanent"
]);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_CODE_PATTERN = /^[a-z][a-z0-9_]{0,99}$/;
const KEY_VERSION_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,49}$/;
const SENSITIVE_KEY_PATTERN =
  /(access.?token|refresh.?token|password|secret|authorization.?header|oauth.?code|ciphertext|private.?key|api.?key)/i;
const PERSISTED_CONNECTION_STATE = Object.freeze({
  pending: "authorization_pending",
  active: "connected",
  expired: "reconnect_required",
  revoked: "disconnected",
  error: "failed",
  disconnected: "disconnected",
  authorization_pending: "authorization_pending",
  connected: "connected",
  reconnect_required: "reconnect_required",
  disconnecting: "disconnecting",
  failed: "failed"
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

function positiveInteger(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    connectorFail("connector_contract_invalid");
  }
  return parsed;
}

function nonNegativeInteger(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    connectorFail("resource_unavailable");
  }
  return parsed;
}

function digest(value) {
  if (
    typeof value !== "string" ||
    value !== value.toLowerCase() ||
    !SHA256_PATTERN.test(value)
  ) {
    connectorFail("connector_contract_invalid");
  }
  return value;
}

function safeText(value, { max = 500, optional = false } = {}) {
  if (optional && (value === undefined || value === null)) return null;
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length < 1 ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    connectorFail("connector_contract_invalid");
  }
  return value;
}

function caption(value) {
  if (value === undefined || value === null || value === "") return null;
  if (
    typeof value !== "string" ||
    value.length > 2200 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  ) {
    connectorFail("connector_contract_invalid");
  }
  return value;
}

function mediaReference(value) {
  const clean = safeText(value, { max: 200 });
  if (/[\\/?#]/.test(clean)) connectorFail("connector_contract_invalid");
  return clean;
}

function authorizationHandle(value) {
  return uuid(value);
}

function providerReference(value) {
  if (!isSafeProviderReference(value)) {
    connectorFail("connector_contract_invalid");
  }
  return value;
}

function dateOrNull(value) {
  if (value === undefined || value === null) return null;
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    connectorFail("connector_contract_invalid");
  }
  return new Date(value.getTime());
}

function databaseDate(value, optional = true) {
  if (value === undefined || value === null) {
    if (optional) return null;
    connectorFail("resource_unavailable");
  }
  const parsed = value instanceof Date
    ? new Date(value.getTime())
    : new Date(value);
  if (Number.isNaN(parsed.getTime())) connectorFail("resource_unavailable");
  return parsed;
}

function scopeNames(value, optional = false) {
  if (optional && value === undefined) return null;
  if (!Array.isArray(value) || value.length > 100) {
    connectorFail("connector_contract_invalid");
  }
  const scopes = value.map((item) => safeText(item, { max: 200 }));
  return Object.freeze([...new Set(scopes)].sort());
}

function activationOptions(value) {
  if (value === undefined) {
    return Object.freeze({ grantedScopes: null });
  }
  const source = strictObject(value, ["grantedScopes"]);
  return Object.freeze({
    grantedScopes: scopeNames(source.grantedScopes, true)
  });
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
  const credentialType = safeText(source.credentialType, { max: 50 });
  if (!SAFE_CODE_PATTERN.test(credentialType)) {
    connectorFail("connector_contract_invalid");
  }
  if (
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
  const expiration = dateOrNull(source.expiresAt);
  if (expiration && expiration.getTime() <= Date.now()) {
    connectorFail("connector_contract_invalid");
  }
  return Object.freeze({
    id: uuid(source.id),
    credentialType,
    ciphertext: Buffer.from(source.ciphertext),
    nonce: Buffer.from(source.nonce),
    authTag: Buffer.from(source.authTag),
    keyVersion: source.keyVersion,
    aadVersion: 1,
    expiresAt: expiration
  });
}

function providerFor(context, value = context.provider) {
  if (value !== context.provider) connectorFail("resource_unavailable");
  return value;
}

function companyFor(context, value = context.companyId) {
  if (value !== context.companyId) connectorFail("resource_unavailable");
  return value;
}

function accountRecord(value) {
  if (value === undefined || value === null) return null;
  const source = strictObject(value, [
    "externalId",
    "username",
    "displayName",
    "accountType"
  ]);
  const type = safeText(source.accountType, { max: 20 });
  if (!PROFESSIONAL_ACCOUNT_TYPES.has(type)) {
    connectorFail("invalid_account_type");
  }
  return Object.freeze({
    externalId: safeText(source.externalId, { max: 500 }),
    username: safeText(source.username, { max: 200 }),
    displayName: safeText(source.displayName, { max: 300, optional: true }),
    accountType: type
  });
}

function rowRevision(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    connectorFail("resource_unavailable");
  }
  return parsed;
}

function connectionFromRow(row) {
  if (!row) return null;
  const result = {
    companyId: row.company_id,
    id: row.id,
    provider: row.provider,
    state: PERSISTED_CONNECTION_STATE[row.status],
    account: row.external_account_id
      ? {
        externalId: row.external_id,
        username: row.username,
        displayName: row.display_name,
        accountType: row.account_type
      }
      : null,
    revision: rowRevision(row.revision)
  };
  if (!result.state || !CONNECTION_STATES.includes(result.state)) {
    connectorFail("resource_unavailable");
  }
  if (result.account) result.account = accountRecord(result.account);
  return Object.freeze(result);
}

function localConnectionHealth(row, state, expiresAt) {
  let health = state;
  if (state === "connected") {
    const observedAt = databaseDate(row.observed_at, false);
    const tokenUsable = Boolean(
      row.active_credential_id &&
      (!expiresAt || expiresAt.getTime() > observedAt.getTime())
    );
    health = row.external_account_status === "active" && tokenUsable
      ? "healthy"
      : "reconnect_required";
  }
  if (!LOCAL_CONNECTION_HEALTH.has(health)) {
    connectorFail("resource_unavailable");
  }
  return health;
}

function connectionDetailsFromRow(row) {
  if (!row) return null;
  const state = PERSISTED_CONNECTION_STATE[row.status];
  if (!state || !CONNECTION_STATES.includes(state)) {
    connectorFail("resource_unavailable");
  }
  const account = row.external_account_id &&
    row.external_account_status === "active"
    ? accountRecord({
      externalId: row.external_id,
      username: row.username,
      displayName: row.display_name,
      accountType: row.account_type
    })
    : null;
  const connectionExpiry = databaseDate(row.expires_at);
  const credentialExpiry = databaseDate(row.credential_expires_at);
  const expiresAt = connectionExpiry && credentialExpiry
    ? new Date(Math.min(
      connectionExpiry.getTime(),
      credentialExpiry.getTime()
    ))
    : credentialExpiry || connectionExpiry;
  return Object.freeze({
    companyId: row.company_id,
    id: row.id,
    provider: row.provider,
    state,
    account,
    revision: rowRevision(row.revision),
    createdAt: databaseDate(row.created_at, false),
    connectedAt: databaseDate(row.connected_at),
    updatedAt: databaseDate(row.updated_at, false),
    disconnectedAt: databaseDate(row.disconnected_at),
    expiresAt,
    health: localConnectionHealth(row, state, expiresAt),
    grantedScopes: scopeNames(row.granted_scopes || []),
    activeCredentialId: row.active_credential_id
      ? uuid(row.active_credential_id)
      : null
  });
}

function publicationFromRow(row) {
  if (!row) return null;
  const result = {
    companyId: row.company_id,
    id: row.id,
    connectionId: row.connection_id,
    provider: row.provider,
    state: row.state,
    confirmedProviderReference: row.confirmed_provider_reference || null,
    reconciliationReference: row.reconciliation_reference || null,
    errorCode: row.error_code || null,
    revision: rowRevision(row.revision)
  };
  if (!PUBLICATION_STATES.includes(result.state)) {
    connectorFail("resource_unavailable");
  }
  assertPublicationConfirmation(result);
  return Object.freeze(result);
}

function publicationAttemptFromRow(row) {
  const state = safeText(row.state, { max: 50 });
  if (!PUBLICATION_ATTEMPT_STATES.has(state)) {
    connectorFail("resource_unavailable");
  }
  return Object.freeze({
    attemptNumber: positiveInteger(row.attempt_number),
    state,
    errorCode: errorCode(row.error_code),
    providerReference: row.provider_reference == null
      ? null
      : providerReference(row.provider_reference),
    startedAt: databaseDate(row.started_at, false),
    finishedAt: databaseDate(row.finished_at),
    durationMs: row.duration_ms == null
      ? null
      : nonNegativeInteger(row.duration_ms)
  });
}

function publicationDetailsFromRow(row, attemptRows = []) {
  if (!row) return null;
  const base = publicationFromRow(row);
  return Object.freeze({
    ...base,
    mediaReference: mediaReference(row.media_reference),
    mediaMetadataDigest: digest(row.media_metadata_digest),
    caption: caption(row.caption),
    idempotencyKey: uuid(row.idempotency_key),
    requestHash: digest(row.request_hash),
    publishedAt: databaseDate(row.published_at),
    createdAt: databaseDate(row.created_at, false),
    updatedAt: databaseDate(row.updated_at, false),
    attempts: Object.freeze(attemptRows.map(publicationAttemptFromRow))
  });
}

function canonicalMediaDigest(image) {
  return crypto.createHash("sha256").update(JSON.stringify({
    mediaId: image.mediaId,
    mimeType: image.mimeType
  }), "utf8").digest("hex");
}

function publishPayload(record, operationId, requestHash) {
  const payload = strictObject(record, [
    "operationId",
    "publicationId",
    "connectionId",
    "image",
    "caption"
  ]);
  if (uuid(payload.operationId) !== operationId) {
    connectorFail("idempotency_conflict");
  }
  const image = strictObject(payload.image, ["mediaId", "mimeType"]);
  if (image.mimeType !== "image/jpeg") {
    connectorFail("connector_contract_invalid");
  }
  const mediaId = mediaReference(image.mediaId);
  return Object.freeze({
    id: uuid(payload.publicationId),
    connectionId: uuid(payload.connectionId),
    mediaReference: mediaId,
    mediaMetadataDigest: canonicalMediaDigest({
      mediaId,
      mimeType: "image/jpeg"
    }),
    caption: caption(payload.caption),
    idempotencyKey: operationId,
    requestHash
  });
}

function sanitizeJson(value, visited = new Set(), depth = 0, budget = { n: 0 }) {
  budget.n += 1;
  if (budget.n > 100 || depth > 8) connectorFail("connector_contract_invalid");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length > 2200 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
      connectorFail("connector_contract_invalid");
    }
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (visited.has(value) || value.length > 50) connectorFail("connector_contract_invalid");
    visited.add(value);
    const output = value.map((item) => sanitizeJson(item, visited, depth + 1, budget));
    visited.delete(value);
    return output;
  }
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype || visited.has(value)) {
    connectorFail("connector_contract_invalid");
  }
  visited.add(value);
  const output = {};
  for (const key of Object.keys(value).sort()) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set || SENSITIVE_KEY_PATTERN.test(key)) {
      connectorFail("connector_contract_invalid");
    }
    output[key] = sanitizeJson(descriptor.value, visited, depth + 1, budget);
  }
  visited.delete(value);
  return output;
}

function safeResultPayload(value, capability, expectedProvider) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    connectorFail("connector_contract_invalid");
  }
  const clean = sanitizeJson(value);
  if (["beginAuthorization", "discoverAccount", "disconnect"].includes(capability)) {
    const keys = ["connectionId", "provider", "state", "account", "revision"];
    if (capability === "beginAuthorization") keys.push("authorizationHandle");
    strictObject(clean, keys);
    if (keys.some((key) => !Object.hasOwn(clean, key))) {
      connectorFail("connector_contract_invalid");
    }
    uuid(clean.connectionId);
    if (
      clean.provider !== expectedProvider ||
      !CONNECTION_STATES.includes(clean.state)
    ) {
      connectorFail("connector_contract_invalid");
    }
    positiveInteger(clean.revision);
    if (clean.account !== null) accountRecord(clean.account);
    if (capability === "beginAuthorization") {
      authorizationHandle(clean.authorizationHandle);
    }
  } else if (["publishImage", "getPublicationStatus"].includes(capability)) {
    const keys = [
      "publicationId",
      "connectionId",
      "provider",
      "state",
      "confirmedProviderReference",
      "reconciliationReference",
      "revision"
    ];
    strictObject(clean, keys);
    if (keys.some((key) => !Object.hasOwn(clean, key))) {
      connectorFail("connector_contract_invalid");
    }
    uuid(clean.publicationId);
    uuid(clean.connectionId);
    if (
      clean.provider !== expectedProvider ||
      !PUBLICATION_STATES.includes(clean.state)
    ) {
      connectorFail("connector_contract_invalid");
    }
    positiveInteger(clean.revision);
    if (clean.confirmedProviderReference != null) {
      providerReference(clean.confirmedProviderReference);
    }
    if (clean.reconciliationReference != null) {
      providerReference(clean.reconciliationReference);
    }
    assertPublicationConfirmation(clean);
  } else {
    connectorFail("capability_not_supported");
  }
  if (Buffer.byteLength(JSON.stringify(clean), "utf8") > 8192) {
    connectorFail("connector_contract_invalid");
  }
  return clean;
}

function errorCode(value, optional = true) {
  if (optional && (value === undefined || value === null)) return null;
  if (!ERROR_CODES.has(value)) connectorFail("connector_contract_invalid");
  return value;
}

function connectionInput(context, record, expectedRevision) {
  const source = strictObject(record, [
    "companyId", "id", "provider", "state", "account", "revision"
  ]);
  companyFor(context, source.companyId);
  providerFor(context, source.provider);
  if (!CONNECTION_STATES.includes(source.state)) {
    connectorFail("state_transition_invalid");
  }
  const revision = positiveInteger(source.revision);
  if (expectedRevision === null) {
    if (revision !== 1) connectorFail("state_transition_invalid");
  } else if (positiveInteger(expectedRevision) + 1 !== revision) {
    connectorFail("state_transition_invalid");
  }
  const account = accountRecord(source.account);
  if (source.state === "connected" && !account) {
    connectorFail("invalid_account_type");
  }
  return Object.freeze({
    companyId: context.companyId,
    id: uuid(source.id),
    provider: context.provider,
    state: source.state,
    account,
    revision
  });
}

function publicationInput(context, record, expectedRevision) {
  const source = strictObject(record, [
    "companyId", "id", "connectionId", "provider", "state",
    "confirmedProviderReference", "reconciliationReference", "errorCode",
    "revision", "mediaReference", "mediaMetadataDigest", "caption",
    "idempotencyKey", "requestHash"
  ]);
  companyFor(context, source.companyId);
  providerFor(context, source.provider);
  if (!PUBLICATION_STATES.includes(source.state)) {
    connectorFail("state_transition_invalid");
  }
  const revision = positiveInteger(source.revision);
  if (expectedRevision === null) {
    if (revision !== 1) connectorFail("state_transition_invalid");
  } else if (positiveInteger(expectedRevision) + 1 !== revision) {
    connectorFail("state_transition_invalid");
  }
  const clean = {
    companyId: context.companyId,
    id: uuid(source.id),
    connectionId: uuid(source.connectionId),
    provider: context.provider,
    state: source.state,
    confirmedProviderReference: source.confirmedProviderReference == null
      ? null
      : providerReference(source.confirmedProviderReference),
    reconciliationReference: source.reconciliationReference == null
      ? null
      : providerReference(source.reconciliationReference),
    errorCode: errorCode(source.errorCode),
    revision,
    mediaReference: source.mediaReference == null
      ? null
      : mediaReference(source.mediaReference),
    mediaMetadataDigest: source.mediaMetadataDigest == null
      ? null
      : digest(source.mediaMetadataDigest),
    caption: caption(source.caption),
    idempotencyKey: source.idempotencyKey == null
      ? null
      : uuid(source.idempotencyKey),
    requestHash: source.requestHash == null ? null : digest(source.requestHash)
  };
  assertPublicationConfirmation(clean);
  return Object.freeze(clean);
}

const CONNECTION_SELECT = [
  "SELECT connection.company_id, connection.id, connection.provider,",
  "  connection.status, connection.revision,",
  "  account.id AS external_account_id, account.external_id,",
  "  account.username, account.display_name, account.account_type",
  "FROM ia4tube_social.social_connections connection",
  "LEFT JOIN LATERAL (",
  "  SELECT candidate.id, candidate.external_id, candidate.username,",
  "    candidate.display_name, candidate.account_type",
  "  FROM ia4tube_social.social_external_accounts candidate",
  "  WHERE candidate.company_id = connection.company_id",
  "    AND candidate.connection_id = connection.id",
  "    AND candidate.provider = connection.provider",
  "    AND candidate.status = 'active'",
  "  ORDER BY candidate.updated_at DESC, candidate.id",
  "  LIMIT 1",
  ") account ON TRUE"
].join("\n");

const CONNECTION_DETAILS_SELECT = [
  "SELECT connection.company_id, connection.id, connection.provider,",
  "  connection.status, connection.revision, connection.created_at,",
  "  connection.connected_at, connection.updated_at,",
  "  connection.disconnected_at, connection.expires_at,",
  "  account.id AS external_account_id, account.external_id,",
  "  account.username, account.display_name, account.account_type,",
  "  account.status AS external_account_status,",
  "  credential.id AS active_credential_id,",
  "  credential.expires_at AS credential_expires_at,",
  "  ARRAY(",
  "    SELECT granted.scope",
  "    FROM ia4tube_social.social_connection_scopes granted",
  "    WHERE granted.company_id=connection.company_id",
  "      AND granted.connection_id=connection.id",
  "      AND (granted.expires_at IS NULL OR",
  "        granted.expires_at > CURRENT_TIMESTAMP)",
  "    ORDER BY granted.scope",
  "  ) AS granted_scopes,",
  "  CURRENT_TIMESTAMP AS observed_at",
  "FROM ia4tube_social.social_connections connection",
  "LEFT JOIN LATERAL (",
  "  SELECT id,external_id,username,display_name,account_type,status",
  "  FROM ia4tube_social.social_external_accounts",
  "  WHERE company_id=connection.company_id",
  "    AND connection_id=connection.id AND provider=connection.provider",
  "  ORDER BY (status='active') DESC,updated_at DESC,id",
  "  LIMIT 1",
  ") account ON TRUE",
  "LEFT JOIN LATERAL (",
  "  SELECT id,expires_at",
  "  FROM ia4tube_social.social_encrypted_credentials",
  "  WHERE company_id=connection.company_id",
  "    AND connection_id=connection.id AND provider=connection.provider",
  "    AND credential_type IN ('instagram_user_access_token','access_token')",
  "    AND revoked_at IS NULL",
  "  ORDER BY (credential_type='instagram_user_access_token') DESC,",
  "    (expires_at IS NULL) DESC,expires_at DESC,updated_at DESC,id",
  "  LIMIT 1",
  ") credential ON TRUE"
].join("\n");

const PUBLICATION_SELECT = [
  "SELECT company_id, id, connection_id, provider, state,",
  "  confirmed_provider_reference, reconciliation_reference,",
  "  error_code, revision",
  "FROM ia4tube_social.social_publications"
].join("\n");

const PUBLICATION_DETAILS_SELECT = [
  "SELECT company_id, id, connection_id, provider, media_reference,",
  "  media_metadata_digest, caption, state, confirmed_provider_reference,",
  "  reconciliation_reference, error_code, published_at, created_at,",
  "  updated_at, revision, idempotency_key, request_hash",
  "FROM ia4tube_social.social_publications"
].join("\n");

async function loadConnection(client, context, id, lock = false) {
  const result = await client.query(
    `${CONNECTION_SELECT}\nWHERE connection.company_id = $1 AND connection.id = $2` +
      ` AND connection.provider = $3${lock ? "\nFOR UPDATE OF connection" : ""}`,
    [context.companyId, uuid(id), context.provider]
  );
  return connectionFromRow(result.rows?.[0]);
}

async function loadConnectionDetails(client, context, id, lock = false) {
  const result = await client.query(
    `${CONNECTION_DETAILS_SELECT}\n` +
      "WHERE connection.company_id=$1 AND connection.id=$2" +
      " AND connection.provider=$3" +
      `${lock ? "\nFOR UPDATE OF connection" : ""}`,
    [context.companyId, uuid(id), context.provider]
  );
  return connectionDetailsFromRow(result.rows?.[0]);
}

async function loadCurrentConnectionDetails(client, context) {
  const result = await client.query(
    `${CONNECTION_DETAILS_SELECT}\n` +
      "WHERE connection.company_id=$1 AND connection.provider=$2\n" +
      "ORDER BY (connection.status=ANY($3::text[])) DESC," +
      " connection.updated_at DESC,connection.id\nLIMIT 1",
    [context.companyId, context.provider, BLOCKING_CONNECTION_STATES]
  );
  return connectionDetailsFromRow(result.rows?.[0]);
}

async function loadPublication(client, context, id, lock = false) {
  const result = await client.query(
    `${PUBLICATION_SELECT}\nWHERE company_id = $1 AND id = $2 AND provider = $3` +
      `${lock ? "\nFOR UPDATE" : ""}`,
    [context.companyId, uuid(id), context.provider]
  );
  return publicationFromRow(result.rows?.[0]);
}

async function loadPublicationDetails(client, context, id) {
  const publicationId = uuid(id);
  const result = await client.query(
    `${PUBLICATION_DETAILS_SELECT}\n` +
      "WHERE company_id=$1 AND id=$2 AND provider=$3",
    [context.companyId, publicationId, context.provider]
  );
  if (!result.rows?.[0]) return null;
  const attempts = await client.query(
    [
      "SELECT attempt_number,state,error_code,provider_reference,",
      "  started_at,finished_at,duration_ms",
      "FROM ia4tube_social.social_publication_attempts",
      "WHERE company_id=$1 AND publication_id=$2 AND provider=$3",
      "ORDER BY attempt_number"
    ].join("\n"),
    [context.companyId, publicationId, context.provider]
  );
  return publicationDetailsFromRow(result.rows[0], attempts.rows || []);
}

async function loadPublicationSnapshot(
  client,
  context,
  id,
  connectionId
) {
  const publicationId = uuid(id);
  const cleanConnectionId = uuid(connectionId);
  const result = await client.query(
    [
      "SELECT publication.*,",
      "  (SELECT COUNT(*)::bigint",
      "   FROM ia4tube_social.social_publications counted",
      "   WHERE counted.company_id=$1 AND counted.connection_id=$3",
      "     AND counted.provider=$4 AND counted.state='published')",
      "    AS publication_count,",
      "  COALESCE((",
      "    SELECT jsonb_agg(jsonb_build_object(",
      "      'attempt_number',attempt.attempt_number,",
      "      'state',attempt.state,'error_code',attempt.error_code,",
      "      'provider_reference',attempt.provider_reference,",
      "      'started_at',attempt.started_at,",
      "      'finished_at',attempt.finished_at,",
      "      'duration_ms',attempt.duration_ms",
      "    ) ORDER BY attempt.attempt_number)",
      "    FROM ia4tube_social.social_publication_attempts attempt",
      "    WHERE attempt.company_id=$1 AND attempt.publication_id=$2",
      "      AND attempt.provider=$4",
      "  ), '[]'::jsonb) AS attempts",
      "FROM (SELECT 1) anchor",
      "LEFT JOIN LATERAL (",
      `  ${PUBLICATION_DETAILS_SELECT}`,
      "  WHERE company_id=$1 AND id=$2 AND provider=$4",
      "  LIMIT 1",
      ") publication ON TRUE"
    ].join("\n"),
    [context.companyId, publicationId, cleanConnectionId, context.provider]
  );
  const row = result.rows?.[0];
  if (!row) connectorFail("resource_unavailable");
  const attempts = row.attempts;
  if (!Array.isArray(attempts) || attempts.length > 100) {
    connectorFail("resource_unavailable");
  }
  return Object.freeze({
    publication: row.id
      ? publicationDetailsFromRow(row, attempts)
      : null,
    publicationCount: nonNegativeInteger(row.publication_count)
  });
}

async function appendInternalAudit(client, context, input) {
  const audit = assertInternalConnectorAudit(
    input.action,
    "succeeded",
    input.detailsCode
  );
  await client.query(
    [
      "INSERT INTO ia4tube_social.social_audit_events (",
      "  company_id, id, event_id, actor_user_id, connection_id,",
      "  publication_id, provider, correlation_id, action, outcome, details_code",
      ") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'succeeded', $10)"
    ].join("\n"),
    [
      context.companyId,
      crypto.randomUUID(),
      crypto.randomUUID(),
      context.userId,
      input.connectionId || null,
      input.publicationId || null,
      context.provider,
      context.correlationId,
      audit.action,
      audit.detailsCode
    ]
  );
}

async function upsertProfessionalAccount(client, context, connectionId, account) {
  const accountId = crypto.randomUUID();
  await client.query(
    [
      "UPDATE ia4tube_social.social_external_accounts",
      "SET status = 'revoked', updated_at = CURRENT_TIMESTAMP",
      "WHERE company_id = $1 AND provider = $2",
      "  AND external_id <> $3 AND status = 'active'"
    ].join("\n"),
    [context.companyId, context.provider, account.externalId]
  );
  const result = await client.query(
    [
      "INSERT INTO ia4tube_social.social_external_accounts (",
      "  company_id, id, connection_id, provider, external_id, username,",
      "  display_name, account_type, status",
      ") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active')",
      "ON CONFLICT (company_id, provider, external_id) DO UPDATE SET",
      "  username = EXCLUDED.username,",
      "  display_name = EXCLUDED.display_name,",
      "  account_type = EXCLUDED.account_type,",
      "  status = 'active',",
      "  updated_at = CURRENT_TIMESTAMP",
      "WHERE social_external_accounts.connection_id = EXCLUDED.connection_id",
      "RETURNING id"
    ].join("\n"),
    [
      context.companyId,
      accountId,
      connectionId,
      context.provider,
      account.externalId,
      account.username,
      account.displayName,
      account.accountType
    ]
  );
  if (!result.rows?.[0]) connectorFail("active_connection_exists");
}

async function replaceGrantedScopes(
  client,
  context,
  connectionId,
  grantedScopes,
  expiresAt
) {
  if (grantedScopes === null) return;
  await client.query(
    [
      "UPDATE ia4tube_social.social_connection_scopes",
      "SET expires_at=GREATEST(",
      "  CURRENT_TIMESTAMP,granted_at + INTERVAL '1 microsecond'",
      ")",
      "WHERE company_id=$1 AND connection_id=$2",
      "  AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)"
    ].join("\n"),
    [context.companyId, connectionId]
  );
  if (grantedScopes.length < 1) return;
  await client.query(
    [
      "INSERT INTO ia4tube_social.social_connection_scopes (",
      "  company_id,connection_id,scope,expires_at",
      ") SELECT $1,$2,scope,$4",
      "FROM unnest($3::text[]) AS granted(scope)",
      "ON CONFLICT (company_id,connection_id,scope) DO UPDATE SET",
      "  expires_at=EXCLUDED.expires_at"
    ].join("\n"),
    [context.companyId, connectionId, grantedScopes, expiresAt]
  );
}

async function revokeConnectionMaterial(client, context, connectionId) {
  const accounts = await client.query(
    [
      "UPDATE ia4tube_social.social_external_accounts",
      "SET status = 'revoked', updated_at = CURRENT_TIMESTAMP",
      "WHERE company_id = $1 AND connection_id = $2 AND provider = $3",
      "  AND status <> 'revoked'"
    ].join("\n"),
    [context.companyId, connectionId, context.provider]
  );
  const credentials = await client.query(
    [
      "UPDATE ia4tube_social.social_encrypted_credentials",
      "SET revoked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP,",
      "  revision = revision + 1",
      "WHERE company_id = $1 AND connection_id = $2 AND provider = $3",
      "  AND revoked_at IS NULL"
    ].join("\n"),
    [context.companyId, connectionId, context.provider]
  );
  const scopes = await client.query(
    [
      "UPDATE ia4tube_social.social_connection_scopes",
      "SET expires_at=GREATEST(",
      "  CURRENT_TIMESTAMP,granted_at + INTERVAL '1 microsecond'",
      ")",
      "WHERE company_id=$1 AND connection_id=$2",
      "  AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)"
    ].join("\n"),
    [context.companyId, connectionId]
  );
  return Object.freeze({
    accountsRevoked: Number(accounts.rowCount || 0),
    credentialsRevoked: Number(credentials.rowCount || 0),
    scopesRevoked: Number(scopes.rowCount || 0)
  });
}

function createPostgresConnectorStore(options = {}) {
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

    function createScope(boundClient = null, assertActive = () => true) {
      function execute(operation) {
        if (!assertActive()) connectorFail("connector_contract_invalid");
        if (boundClient) return operation(boundClient);
        return withTransaction(pool, operation, {
          companyId: context.companyId,
          role
        });
      }

      const methods = {
        async getCurrentConnectionDetails() {
          return execute((client) => loadCurrentConnectionDetails(
            client,
            context
          ));
        },

        async getConnectionDetails(id) {
          return execute((client) => loadConnectionDetails(
            client,
            context,
            id
          ));
        },

        async disconnectConnectionLocally(id) {
          const connectionId = uuid(id);
          return execute(async (client) => {
            await client.query(
              "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
              [`${context.companyId}:${context.provider}`]
            );
            let current = await loadConnectionDetails(
              client,
              context,
              connectionId,
              true
            );
            if (!current) connectorFail("resource_unavailable");
            const route = ["connected", "reconnect_required", "failed"]
              .includes(current.state)
              ? ["disconnecting", "disconnected"]
              : current.state === "disconnected"
                ? []
                : ["disconnected"];
            for (const nextState of route) {
              transitionConnectionState(current.state, nextState);
              const updated = await client.query(
                [
                  "UPDATE ia4tube_social.social_connections",
                  "SET status=$4,expires_at=CASE WHEN $4='disconnected'",
                  "    THEN NULL ELSE expires_at END,",
                  "  revoked_at=NULL,",
                  "  disconnected_at=CASE WHEN $4='disconnected'",
                  "    THEN COALESCE(disconnected_at,CURRENT_TIMESTAMP)",
                  "    ELSE NULL END,",
                  "  updated_at=CURRENT_TIMESTAMP,revision=$5",
                  "WHERE company_id=$1 AND id=$2 AND provider=$3",
                  "  AND revision=$6 RETURNING id"
                ].join("\n"),
                [
                  context.companyId,
                  connectionId,
                  context.provider,
                  nextState,
                  current.revision + 1,
                  current.revision
                ]
              );
              if (!updated.rows?.[0]) connectorFail("state_transition_invalid");
              await appendInternalAudit(client, context, {
                action: "social.connection.state_transition",
                connectionId,
                detailsCode: `to_${nextState}`
              });
              current = Object.freeze({
                ...current,
                state: nextState,
                revision: current.revision + 1
              });
            }
            const revoked = await revokeConnectionMaterial(
              client,
              context,
              connectionId
            );
            if (route.length > 0 || revoked.accountsRevoked > 0) {
              await appendInternalAudit(client, context, {
                action: "social.connection.disconnected",
                connectionId,
                detailsCode: revoked.accountsRevoked > 0
                  ? "account_revoked"
                  : "no_active_account"
              });
            }
            if (revoked.credentialsRevoked > 0) {
              await appendInternalAudit(client, context, {
                action: "social.credential.removed",
                connectionId,
                detailsCode: "credential_revoked"
              });
            }
            return loadConnectionDetails(client, context, connectionId);
          });
        },

        async getConnection(id) {
          return execute((client) => loadConnection(client, context, id));
        },

        async ensureDisconnected(id) {
          const connectionId = uuid(id);
          return execute(async (client) => {
            const current = await loadConnection(
              client,
              context,
              connectionId,
              true
            );
            if (!current || current.state !== "disconnected") {
              connectorFail("state_transition_invalid");
            }
            const revoked = await revokeConnectionMaterial(
              client,
              context,
              connectionId
            );
            if (revoked.accountsRevoked > 0) {
              await appendInternalAudit(client, context, {
                action: "social.connection.disconnected",
                connectionId,
                detailsCode: "account_revoked"
              });
            }
            if (revoked.credentialsRevoked > 0) {
              await appendInternalAudit(client, context, {
                action: "social.credential.removed",
                connectionId,
                detailsCode: "credential_revoked"
              });
            }
            return loadConnection(client, context, connectionId);
          });
        },

        async findBlockingConnection(provider, excludeConnectionId) {
          providerFor(context, provider);
          const excluded = uuid(excludeConnectionId);
          return execute(async (client) => {
            const result = await client.query(
              `${CONNECTION_SELECT}\nWHERE connection.company_id = $1` +
                " AND connection.provider = $2 AND connection.id <> $3" +
                " AND (connection.status = ANY($4::text[]) OR EXISTS (" +
                "SELECT 1 FROM ia4tube_social.social_external_accounts active_account " +
                "WHERE active_account.company_id = connection.company_id " +
                "AND active_account.connection_id = connection.id " +
                "AND active_account.provider = connection.provider " +
                "AND active_account.status = 'active'))" +
                " ORDER BY connection.updated_at DESC, connection.id LIMIT 1",
              [
                context.companyId,
                context.provider,
                excluded,
                BLOCKING_CONNECTION_STATES
              ]
            );
            return connectionFromRow(result.rows?.[0]);
          });
        },

        async saveConnection(record, expectedRevision) {
          const clean = connectionInput(context, record, expectedRevision);
          if (clean.state === "connected") {
            connectorFail("credential_unavailable");
          }
          return execute(async (client) => {
            const current = await loadConnection(client, context, clean.id, true);
            if (expectedRevision === null) {
              if (current) connectorFail("state_transition_invalid");
              const inserted = await client.query(
                [
                  "INSERT INTO ia4tube_social.social_connections (",
                  "  company_id, id, provider, status, created_by_user_id,",
                  "  connected_at, disconnected_at, revision",
                  ") VALUES ($1, $2, $3, $4, $5,",
                  "  NULL,",
                  "  CASE WHEN $4 = 'disconnected' THEN CURRENT_TIMESTAMP END, $6)",
                  "ON CONFLICT DO NOTHING RETURNING id"
                ].join("\n"),
                [
                  context.companyId,
                  clean.id,
                  context.provider,
                  clean.state,
                  context.userId,
                  clean.revision
                ]
              );
              if (!inserted.rows?.[0]) connectorFail("state_transition_invalid");
            } else {
              if (!current || current.revision !== expectedRevision) {
                connectorFail("state_transition_invalid");
              }
              transitionConnectionState(current.state, clean.state);
              const updated = await client.query(
                [
                  "UPDATE ia4tube_social.social_connections",
                  "SET status = $4,",
                  "  connected_at = CASE",
                  "    WHEN $4 = 'authorization_pending' THEN NULL",
                  "    ELSE connected_at END,",
                  "  expires_at = CASE WHEN $4 = 'authorization_pending'",
                  "    THEN NULL ELSE expires_at END,",
                  "  revoked_at = NULL,",
                  "  disconnected_at = CASE WHEN $4 = 'disconnected'",
                  "    THEN CURRENT_TIMESTAMP ELSE NULL END,",
                  "  updated_at = CURRENT_TIMESTAMP, revision = $5",
                  "WHERE company_id = $1 AND id = $2 AND provider = $3",
                  "  AND revision = $6 RETURNING id"
                ].join("\n"),
                [
                  context.companyId,
                  clean.id,
                  context.provider,
                  clean.state,
                  clean.revision,
                  expectedRevision
                ]
              );
              if (!updated.rows?.[0]) connectorFail("state_transition_invalid");
              await appendInternalAudit(client, context, {
                action: "social.connection.state_transition",
                connectionId: clean.id,
                detailsCode: `to_${clean.state}`
              });
            }
            if (clean.state === "disconnected") {
              const revoked = await revokeConnectionMaterial(
                client,
                context,
                clean.id
              );
              await appendInternalAudit(client, context, {
                action: "social.connection.disconnected",
                connectionId: clean.id,
                detailsCode: revoked.accountsRevoked > 0
                  ? "account_revoked"
                  : "no_active_account"
              });
              if (revoked.credentialsRevoked > 0) {
                await appendInternalAudit(client, context, {
                  action: "social.credential.removed",
                  connectionId: clean.id,
                  detailsCode: "credential_revoked"
                });
              }
            }
            return loadConnection(client, context, clean.id);
          });
        },

        async activateConnectionWithCredential(
          record,
          expectedRevision,
          credentialEnvelope,
          optionsValue
        ) {
          const clean = connectionInput(context, record, expectedRevision);
          const credential = encryptedCredentialEnvelope(credentialEnvelope);
          const activation = activationOptions(optionsValue);
          if (clean.state !== "connected" || !clean.account) {
            connectorFail("state_transition_invalid");
          }
          return execute(async (client) => {
            await client.query(
              "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
              [`${context.companyId}:${context.provider}`]
            );
            const current = await loadConnection(client, context, clean.id, true);
            if (!current || current.revision !== expectedRevision) {
              connectorFail("state_transition_invalid");
            }
            transitionConnectionState(current.state, "connected");
            const updated = await client.query(
              [
                "UPDATE ia4tube_social.social_connections",
                "SET status='connected',",
                " connected_at=COALESCE(connected_at,CURRENT_TIMESTAMP),",
                " expires_at=$6,revoked_at=NULL,disconnected_at=NULL,",
                " updated_at=CURRENT_TIMESTAMP,revision=$4",
                "WHERE company_id=$1 AND id=$2 AND provider=$3",
                " AND revision=$5 RETURNING id"
              ].join("\n"),
              [
                context.companyId,
                clean.id,
                context.provider,
                clean.revision,
                expectedRevision,
                credential.expiresAt
              ]
            );
            if (!updated.rows?.[0]) connectorFail("state_transition_invalid");
            await upsertProfessionalAccount(
              client,
              context,
              clean.id,
              clean.account
            );
            const previousCredentials = await client.query(
              [
                "UPDATE ia4tube_social.social_encrypted_credentials",
                "SET revoked_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP,",
                " revision=revision+1",
                "WHERE company_id=$1 AND connection_id=$2 AND provider=$3",
                " AND credential_type=$4 AND revoked_at IS NULL",
                "RETURNING id"
              ].join("\n"),
              [
                context.companyId,
                clean.id,
                context.provider,
                credential.credentialType
              ]
            );
            if (Number(previousCredentials.rowCount || 0) > 0) {
              await appendInternalAudit(client, context, {
                action: "social.credential.removed",
                connectionId: clean.id,
                detailsCode: "credential_revoked"
              });
            }
            const storedCredential = await client.query(
              [
                "INSERT INTO ia4tube_social.social_encrypted_credentials (",
                " company_id,id,provider,connection_id,credential_type,",
                " ciphertext,nonce,auth_tag,key_version,aad_version,expires_at",
                ") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
                "ON CONFLICT DO NOTHING",
                "RETURNING id,credential_type,key_version,aad_version,revision,expires_at"
              ].join("\n"),
              [
                context.companyId,
                credential.id,
                context.provider,
                clean.id,
                credential.credentialType,
                credential.ciphertext,
                credential.nonce,
                credential.authTag,
                credential.keyVersion,
                credential.aadVersion,
                credential.expiresAt
              ]
            );
            const credentialRow = storedCredential.rows?.[0];
            if (!credentialRow) connectorFail("idempotency_conflict");
            await replaceGrantedScopes(
              client,
              context,
              clean.id,
              activation.grantedScopes,
              credential.expiresAt
            );
            await appendInternalAudit(client, context, {
              action: "social.connection.state_transition",
              connectionId: clean.id,
              detailsCode: "to_connected"
            });
            await appendInternalAudit(client, context, {
              action: "social.credential.stored",
              connectionId: clean.id,
              detailsCode: "credential_encrypted"
            });
            return Object.freeze({
              connection: await loadConnection(client, context, clean.id),
              credential: Object.freeze({
                id: credentialRow.id,
                credentialType: credentialRow.credential_type,
                keyVersion: credentialRow.key_version,
                aadVersion: Number(credentialRow.aad_version),
                revision: rowRevision(credentialRow.revision),
                expiresAt: credentialRow.expires_at
                  ? new Date(credentialRow.expires_at)
                  : null
              }),
              grantedScopes: activation.grantedScopes || Object.freeze([])
            });
          });
        },

        async activateConnectionFromAuthorization(
          record,
          expectedRevision,
          authorizationHandleValue
        ) {
          const clean = connectionInput(context, record, expectedRevision);
          const authorizationId = authorizationHandle(
            authorizationHandleValue
          );
          if (clean.state !== "connected" || !clean.account) {
            connectorFail("state_transition_invalid");
          }
          return execute(async (client) => {
            await client.query(
              "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
              [`${context.companyId}:${context.provider}`]
            );
            const current = await loadConnection(client, context, clean.id, true);
            if (!current || current.revision !== expectedRevision) {
              connectorFail("state_transition_invalid");
            }
            transitionConnectionState(current.state, "connected");

            const authorization = await client.query(
              [
                "SELECT id",
                "FROM ia4tube_social.social_oauth_transactions",
                "WHERE company_id=$1 AND id=$2 AND provider=$3",
                " AND connection_id=$4",
                " AND initiated_by_user_id=$5",
                " AND consumed_at IS NOT NULL",
                " AND cancelled_at IS NULL AND failed_at IS NULL",
                "FOR UPDATE"
              ].join("\n"),
              [
                context.companyId,
                authorizationId,
                context.provider,
                clean.id,
                context.userId
              ]
            );
            if (authorization.rows?.length !== 1) {
              connectorFail("authorization_expired");
            }

            const credentials = await client.query(
              [
                "SELECT id, revision",
                "FROM ia4tube_social.social_encrypted_credentials",
                "WHERE company_id=$1 AND oauth_transaction_id=$2",
                " AND provider=$3 AND connection_id IS NULL",
                " AND credential_type='access_token' AND revoked_at IS NULL",
                " AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)",
                "FOR UPDATE"
              ].join("\n"),
              [context.companyId, authorizationId, context.provider]
            );
            if (credentials.rows?.length !== 1) {
              connectorFail("credential_unavailable");
            }
            const credential = credentials.rows[0];
            const credentialId = uuid(credential.id);
            const credentialRevision = rowRevision(credential.revision);

            const updated = await client.query(
              [
                "UPDATE ia4tube_social.social_connections",
                "SET status='connected',",
                " connected_at=COALESCE(connected_at,CURRENT_TIMESTAMP),",
                " expires_at=NULL,revoked_at=NULL,disconnected_at=NULL,",
                " updated_at=CURRENT_TIMESTAMP,revision=$4",
                "WHERE company_id=$1 AND id=$2 AND provider=$3",
                " AND revision=$5 RETURNING id"
              ].join("\n"),
              [
                context.companyId,
                clean.id,
                context.provider,
                clean.revision,
                expectedRevision
              ]
            );
            if (!updated.rows?.[0]) connectorFail("state_transition_invalid");
            await upsertProfessionalAccount(
              client,
              context,
              clean.id,
              clean.account
            );

            const previousCredentials = await client.query(
              [
                "UPDATE ia4tube_social.social_encrypted_credentials",
                "SET revoked_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP,",
                " revision=revision+1",
                "WHERE company_id=$1 AND connection_id=$2 AND provider=$3",
                " AND credential_type='access_token' AND revoked_at IS NULL",
                " AND id<>$4",
                "RETURNING id"
              ].join("\n"),
              [
                context.companyId,
                clean.id,
                context.provider,
                credentialId
              ]
            );
            if (Number(previousCredentials.rowCount || 0) > 0) {
              await appendInternalAudit(client, context, {
                action: "social.credential.removed",
                connectionId: clean.id,
                detailsCode: "credential_revoked"
              });
            }

            const rebound = await client.query(
              [
                "UPDATE ia4tube_social.social_encrypted_credentials",
                "SET connection_id=$4,oauth_transaction_id=NULL,",
                " updated_at=CURRENT_TIMESTAMP,revision=revision+1",
                "WHERE company_id=$1 AND id=$2 AND provider=$3",
                " AND oauth_transaction_id=$5 AND connection_id IS NULL",
                " AND credential_type='access_token' AND revoked_at IS NULL",
                " AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)",
                " AND revision=$6 RETURNING id"
              ].join("\n"),
              [
                context.companyId,
                credentialId,
                context.provider,
                clean.id,
                authorizationId,
                credentialRevision
              ]
            );
            if (!rebound.rows?.[0]) connectorFail("credential_unavailable");
            await appendInternalAudit(client, context, {
              action: "social.connection.state_transition",
              connectionId: clean.id,
              detailsCode: "to_connected"
            });
            await appendInternalAudit(client, context, {
              action: "social.credential.bound",
              connectionId: clean.id,
              detailsCode: "credential_bound_from_authorization"
            });
            return loadConnection(client, context, clean.id);
          });
        },

        async getPublication(id) {
          return execute((client) => loadPublication(client, context, id));
        },

        async getPublicationDetails(id) {
          return execute((client) => loadPublicationDetails(
            client,
            context,
            id
          ));
        },

        async getPublicationSnapshot(id, connectionId) {
          return execute((client) => loadPublicationSnapshot(
            client,
            context,
            id,
            connectionId
          ));
        },

        async countPublishedPublications(connectionId) {
          const cleanConnectionId = uuid(connectionId);
          return execute(async (client) => {
            const result = await client.query(
              [
                "SELECT COUNT(*)::bigint AS publication_count",
                "FROM ia4tube_social.social_publications",
                "WHERE company_id=$1 AND connection_id=$2 AND provider=$3",
                "  AND state='published'"
              ].join("\n"),
              [context.companyId, cleanConnectionId, context.provider]
            );
            return nonNegativeInteger(
              result.rows?.[0]?.publication_count ?? 0
            );
          });
        },

        async savePublication(record, expectedRevision) {
          const clean = publicationInput(context, record, expectedRevision);
          return execute(async (client) => {
            const current = await loadPublication(client, context, clean.id, true);
            if (expectedRevision === null) {
              if (
                current ||
                !clean.mediaReference ||
                !clean.mediaMetadataDigest ||
                !clean.idempotencyKey ||
                !clean.requestHash ||
                clean.state !== "ready"
              ) {
                connectorFail("state_transition_invalid");
              }
              const inserted = await client.query(
                [
                  "INSERT INTO ia4tube_social.social_publications (",
                  "  company_id, id, connection_id, provider, media_reference,",
                  "  media_metadata_digest, caption, state, idempotency_key,",
                  "  request_hash, revision",
                  ") VALUES ($1,$2,$3,$4,$5,$6,$7,'ready',$8,$9,1)",
                  "ON CONFLICT DO NOTHING RETURNING id"
                ].join("\n"),
                [
                  context.companyId, clean.id, clean.connectionId,
                  context.provider, clean.mediaReference,
                  clean.mediaMetadataDigest, clean.caption,
                  clean.idempotencyKey, clean.requestHash
                ]
              );
              if (!inserted.rows?.[0]) connectorFail("state_transition_invalid");
            } else {
              if (
                !current ||
                current.revision !== expectedRevision ||
                current.connectionId !== clean.connectionId
              ) {
                connectorFail("state_transition_invalid");
              }
              const confirmationReferenceProgress =
                current.state === "provider_confirming" &&
                clean.state === "provider_confirming" &&
                typeof current.reconciliationReference === "string" &&
                typeof clean.reconciliationReference === "string" &&
                current.reconciliationReference !==
                  clean.reconciliationReference &&
                clean.confirmedProviderReference === null &&
                clean.errorCode === null;
              if (!confirmationReferenceProgress) {
                transitionPublicationState(current.state, clean.state);
              }
              const updated = await client.query(
                [
                  "UPDATE ia4tube_social.social_publications",
                  "SET state = $4, confirmed_provider_reference = $5,",
                  "  reconciliation_reference = $6, error_code = $7,",
                  "  published_at = CASE WHEN $4 = 'published'",
                  "    THEN COALESCE(published_at, CURRENT_TIMESTAMP) ELSE published_at END,",
                  "  updated_at = CURRENT_TIMESTAMP, revision = $8",
                  "WHERE company_id = $1 AND id = $2 AND provider = $3",
                  "  AND revision = $9 RETURNING id"
                ].join("\n"),
                [
                  context.companyId, clean.id, context.provider, clean.state,
                  clean.confirmedProviderReference,
                  clean.reconciliationReference,
                  clean.errorCode,
                  clean.revision,
                  expectedRevision
                ]
              );
              if (!updated.rows?.[0]) connectorFail("state_transition_invalid");
              if (clean.state === "publishing") {
                const nextAttempt = await client.query(
                  [
                    "SELECT COALESCE(MAX(attempt_number), 0)::bigint + 1 AS next_attempt",
                    "FROM ia4tube_social.social_publication_attempts",
                    "WHERE company_id = $1 AND publication_id = $2"
                  ].join("\n"),
                  [context.companyId, clean.id]
                );
                await client.query(
                  [
                    "INSERT INTO ia4tube_social.social_publication_attempts (",
                    "  company_id, publication_id, provider, attempt_number, state",
                    ") VALUES ($1, $2, $3, $4, 'started')"
                  ].join("\n"),
                  [
                    context.companyId,
                    clean.id,
                    context.provider,
                    positiveInteger(nextAttempt.rows?.[0]?.next_attempt)
                  ]
                );
                await appendInternalAudit(client, context, {
                  action: "social.publication.attempt_recorded",
                  connectionId: clean.connectionId,
                  publicationId: clean.id,
                  detailsCode: "state_started"
                });
              } else if (current.state === "publishing" || current.state === "provider_confirming") {
                const reference = clean.state === "published"
                  ? clean.confirmedProviderReference
                  : clean.state === "provider_confirming"
                    ? clean.reconciliationReference
                    : null;
                const attempt = await client.query(
                  [
                    "UPDATE ia4tube_social.social_publication_attempts",
                    "SET state = $4, error_code = $5, provider_reference = $6,",
                  "  finished_at = COALESCE(finished_at, CURRENT_TIMESTAMP),",
                  "  duration_ms = COALESCE(duration_ms, GREATEST(0, FLOOR(EXTRACT(EPOCH FROM",
                  "      (CURRENT_TIMESTAMP - started_at)) * 1000)::bigint)),",
                    "  updated_at = CURRENT_TIMESTAMP, revision = revision + 1",
                    "WHERE company_id = $1 AND publication_id = $2 AND provider = $3",
                    "  AND attempt_number = (",
                    "    SELECT MAX(candidate.attempt_number)",
                    "    FROM ia4tube_social.social_publication_attempts candidate",
                    "    WHERE candidate.company_id = $1",
                    "      AND candidate.publication_id = $2",
                    "      AND candidate.state IN ('started', 'provider_confirming')",
                    "  )",
                    "  AND state = $7 RETURNING attempt_number"
                  ].join("\n"),
                  [
                    context.companyId,
                    clean.id,
                    context.provider,
                    clean.state,
                    clean.errorCode,
                    reference,
                    current.state === "publishing" ? "started" : "provider_confirming"
                  ]
                );
                if (!attempt.rows?.[0]) connectorFail("state_transition_invalid");
                await appendInternalAudit(client, context, {
                  action: "social.publication.attempt_recorded",
                  connectionId: clean.connectionId,
                  publicationId: clean.id,
                  detailsCode: `state_${clean.state}`
                });
              }
              await appendInternalAudit(client, context, {
                action: "social.publication.state_transition",
                connectionId: clean.connectionId,
                publicationId: clean.id,
                detailsCode: `to_${clean.state}`
              });
            }
            return loadPublication(client, context, clean.id);
          });
        },

        async beginIdempotency(record) {
          const source = strictObject(record, [
            "capability", "operationId", "digest", "payload"
          ]);
          if (!CAPABILITIES.has(source.capability)) {
            connectorFail("capability_not_supported");
          }
          const operationId = uuid(source.operationId);
          const requestHash = digest(source.digest);
          const publication = source.capability === "publishImage"
            ? publishPayload(source.payload, operationId, requestHash)
            : null;
          if (source.capability !== "publishImage" && source.payload !== undefined) {
            connectorFail("connector_contract_invalid");
          }
          return execute(async (client) => {
            if (publication) {
              await client.query(
                "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
                [`${context.companyId}:${context.provider}`]
              );
            }
            const inserted = await client.query(
              [
                "INSERT INTO ia4tube_social.social_idempotency_operations (",
                "  company_id, operation_id, provider, capability, request_hash, status",
                ") VALUES ($1, $2, $3, $4, $5, 'pending')",
                "ON CONFLICT (company_id, operation_id) DO NOTHING",
                "RETURNING operation_id"
              ].join("\n"),
              [
                context.companyId,
                operationId,
                context.provider,
                source.capability,
                requestHash
              ]
            );
            if (inserted.rows?.[0]) {
              if (publication) {
                const prior = await client.query(
                  [
                    "SELECT connection_id,provider,media_reference,",
                    " media_metadata_digest,caption,state,request_hash",
                    "FROM ia4tube_social.social_publications",
                    "WHERE company_id=$1 AND id=$2 FOR UPDATE"
                  ].join("\n"),
                  [context.companyId, publication.id]
                );
                const priorRow = prior.rows?.[0];
                if (priorRow) {
                  if (
                    priorRow.connection_id !== publication.connectionId ||
                    priorRow.provider !== context.provider ||
                    priorRow.media_reference !== publication.mediaReference ||
                    priorRow.media_metadata_digest !== publication.mediaMetadataDigest ||
                    (priorRow.caption || null) !== publication.caption ||
                    priorRow.request_hash !== requestHash
                  ) {
                    connectorFail("idempotency_conflict");
                  }
                  if (priorRow.state !== "failed_temporary") {
                    connectorFail("state_transition_invalid");
                  }
                } else {
                  const ready = await client.query(
                    [
                      "INSERT INTO ia4tube_social.social_publications (",
                      "  company_id, id, connection_id, provider, media_reference,",
                      "  media_metadata_digest, caption, state, idempotency_key,",
                      "  request_hash, revision",
                      ") SELECT $1,$2,$3,$4,$5,$6,$7,'ready',$8,$9,1",
                      "FROM ia4tube_social.social_connections connection",
                      "WHERE connection.company_id = $1 AND connection.id = $3",
                      "  AND connection.provider = $4",
                      "  AND connection.status IN ('active', 'connected')",
                      "RETURNING id"
                    ].join("\n"),
                    [
                      context.companyId,
                      publication.id,
                      publication.connectionId,
                      context.provider,
                      publication.mediaReference,
                      publication.mediaMetadataDigest,
                      publication.caption,
                      operationId,
                      requestHash
                    ]
                  );
                  if (!ready.rows?.[0]) connectorFail("credential_unavailable");
                  await appendInternalAudit(client, context, {
                    action: "social.publication.created",
                    connectionId: publication.connectionId,
                    publicationId: publication.id,
                    detailsCode: "state_ready"
                  });
                }
              }
              return Object.freeze({ status: "acquired" });
            }
            const existing = await client.query(
              [
                "SELECT provider, capability, request_hash, status,",
                "  result_payload, error_code",
                "FROM ia4tube_social.social_idempotency_operations",
                "WHERE company_id = $1 AND operation_id = $2"
              ].join("\n"),
              [context.companyId, operationId]
            );
            const row = existing.rows?.[0];
            if (
              !row ||
              row.provider !== context.provider ||
              row.capability !== source.capability ||
              row.request_hash !== requestHash
            ) {
              connectorFail("idempotency_conflict");
            }
            if (row.status === "pending") {
              return Object.freeze({ status: "pending" });
            }
            if (row.status !== "completed") connectorFail("idempotency_conflict");
            return Object.freeze({
              status: "completed",
              result: row.result_payload == null
                ? null
                : safeResultPayload(
                  row.result_payload,
                  source.capability,
                  context.provider
                ),
              errorCode: errorCode(row.error_code)
            });
          });
        },

        async completeIdempotency(record) {
          const source = strictObject(record, [
            "capability", "operationId", "digest", "result", "errorCode"
          ]);
          if (!CAPABILITIES.has(source.capability)) {
            connectorFail("capability_not_supported");
          }
          const operationId = uuid(source.operationId);
          const requestHash = digest(source.digest);
          const cleanError = errorCode(source.errorCode);
          const cleanResult = source.result == null
            ? null
            : safeResultPayload(
              source.result,
              source.capability,
              context.provider
            );
          if (Boolean(cleanResult) === Boolean(cleanError)) {
            connectorFail("connector_contract_invalid");
          }
          return execute(async (client) => {
            const updated = await client.query(
              [
                "UPDATE ia4tube_social.social_idempotency_operations",
                "SET status = 'completed', result_payload = $6::jsonb,",
                "  error_code = $7, updated_at = CURRENT_TIMESTAMP,",
                "  revision = revision + 1",
                "WHERE company_id = $1 AND operation_id = $2",
                "  AND provider = $3 AND capability = $4",
                "  AND request_hash = $5 AND status = 'pending'",
                "RETURNING status, result_payload, error_code"
              ].join("\n"),
              [
                context.companyId,
                operationId,
                context.provider,
                source.capability,
                requestHash,
                cleanResult == null ? null : JSON.stringify(cleanResult),
                cleanError
              ]
            );
            if (!updated.rows?.[0]) {
              const existing = await client.query(
                [
                  "SELECT provider, capability, request_hash, status,",
                  "  result_payload, error_code",
                  "FROM ia4tube_social.social_idempotency_operations",
                  "WHERE company_id = $1 AND operation_id = $2"
                ].join("\n"),
                [context.companyId, operationId]
              );
              const row = existing.rows?.[0];
              const storedResult = row?.result_payload == null
                ? null
                : safeResultPayload(
                  row.result_payload,
                  source.capability,
                  context.provider
                );
              if (
                !row || row.provider !== context.provider ||
                row.capability !== source.capability ||
                row.request_hash !== requestHash || row.status !== "completed" ||
                JSON.stringify(storedResult) !== JSON.stringify(cleanResult) ||
                (row.error_code || null) !== cleanError
              ) {
                connectorFail("idempotency_conflict");
              }
            }
            return Object.freeze({ status: "completed" });
          });
        },

        async runExclusive(operation) {
          if (typeof operation !== "function") {
            connectorFail("connector_contract_invalid");
          }
          if (boundClient) return operation(methods);
          return withTransaction(pool, async (client) => {
            await client.query(
              "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
              [`${context.companyId}:${context.provider}`]
            );
            let active = true;
            const txScope = createScope(client, () => active);
            try {
              return await operation(txScope);
            } finally {
              active = false;
            }
          }, { companyId: context.companyId, role });
        }
      };
      return Object.freeze(methods);
    }

    return createScope();
  }

  return Object.freeze({ scope });
}

module.exports = {
  BLOCKING_CONNECTION_STATES,
  createPostgresConnectorStore
};
