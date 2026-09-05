"use strict";
const { lockSocialConnection } = require("./social-publication-guard");

const crypto = require("node:crypto");
const { withTransaction } = require("./pool");
const { complianceFail } = require("../../social/compliance/errors");
const {
  CONFIRMATION_CODE_PATTERN
} = require("../../social/compliance/meta-compliance-service");
const {
  META_EXTERNAL_USER_ID_PATTERN
} = require("../../social/compliance/meta-signed-request");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SUBJECT_DIGEST_VERSION = "hmac-sha256-app-secret-v1";
const TOKEN_CREDENTIAL_TYPES = Object.freeze([
  "instagram_user_access_token",
  "access_token"
]);

function fail(code = "meta_compliance_repository_invalid", statusCode = 503) {
  complianceFail(code, statusCode);
}

function uuid(value) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) fail();
  return value.toLowerCase();
}

function sha256(value) {
  if (
    typeof value !== "string" ||
    value !== value.toLowerCase() ||
    !SHA256_PATTERN.test(value)
  ) {
    fail();
  }
  return value;
}

function provider(value) {
  if (value !== "instagram") fail();
  return value;
}

function kind(value) {
  if (!['deauthorization', 'data_deletion'].includes(value)) fail();
  return value;
}

function canonicalTimestamp(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    fail();
  }
  return value;
}

function confirmationCode(value) {
  if (!CONFIRMATION_CODE_PATTERN.test(value || "")) fail();
  return value;
}

function requireAppSecret(value) {
  const bytes = Buffer.isBuffer(value)
    ? Buffer.from(value)
    : typeof value === "string"
      ? Buffer.from(value, "utf8")
      : Buffer.alloc(0);
  if (bytes.length < 16 || bytes.length > 4096) {
    bytes.fill(0);
    fail("meta_compliance_configuration_invalid");
  }
  return bytes;
}

function requirePool(value) {
  if (!value || typeof value.connect !== "function") fail();
  return value;
}

function requireRandomUuid(randomUUID) {
  let value;
  try {
    value = randomUUID();
  } catch {
    fail();
  }
  return uuid(value);
}

function createPostgresMetaComplianceRepository(options = {}) {
  const pool = requirePool(options.pool);
  const runtimeRole = options.runtimeRole || "ia4tube_social_runtime";
  if (runtimeRole !== "ia4tube_social_runtime") fail();
  const randomUUID = options.randomUUID || crypto.randomUUID;
  if (typeof randomUUID !== "function") fail();

  const appSecret = requireAppSecret(options.appSecret);
  const subjectKey = crypto
    .createHmac("sha256", appSecret)
    .update("ia4tube-meta-subject-key-v1\0", "utf8")
    .digest();
  appSecret.fill(0);
  let destroyed = false;

  function assertOpen() {
    if (destroyed) fail("meta_compliance_configuration_invalid");
  }

  function subjectMappingForExternalUser({
    provider: providerInput,
    externalUserId
  } = {}) {
    assertOpen();
    const cleanProvider = provider(providerInput);
    if (!META_EXTERNAL_USER_ID_PATTERN.test(externalUserId || "")) fail();
    const subjectDigest = crypto
      .createHmac("sha256", subjectKey)
      .update("ia4tube-meta-subject-v1\0", "utf8")
      .update(cleanProvider, "ascii")
      .update("\0", "ascii")
      .update(externalUserId, "ascii")
      .digest("hex");
    return Object.freeze({
      provider: cleanProvider,
      subjectDigest,
      digestVersion: SUBJECT_DIGEST_VERSION
    });
  }

  async function resolveMetaSubject(input = {}) {
    const mapping = subjectMappingForExternalUser(input);
    const result = await withTransaction(
      pool,
      (client) => client.query(
        [
          "SELECT company_id,user_id,connection_id",
          "FROM ia4tube_social.resolve_meta_subject_mapping($1,$2)"
        ].join("\n"),
        [mapping.provider, mapping.subjectDigest]
      ),
      { role: runtimeRole }
    );
    if (!Array.isArray(result.rows) || result.rows.length > 1) fail();
    const row = result.rows[0];
    if (!row) return null;
    return Object.freeze({
      companyId: uuid(row.company_id),
      userId: uuid(row.user_id),
      connectionId: uuid(row.connection_id),
      subjectDigest: mapping.subjectDigest
    });
  }

  function cleanExecutionInput(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) fail();
    const keys = Object.keys(input).sort();
    const expected = [
      "candidateConfirmationCode",
      "companyId",
      "connectionId",
      "eventKey",
      "kind",
      "occurredAt",
      "provider",
      "subjectDigest",
      "userId"
    ].sort();
    if (
      keys.length !== expected.length ||
      keys.some((key, index) => key !== expected[index])
    ) {
      fail();
    }
    return Object.freeze({
      kind: kind(input.kind),
      eventKey: sha256(input.eventKey),
      provider: provider(input.provider),
      companyId: uuid(input.companyId),
      userId: uuid(input.userId),
      connectionId: uuid(input.connectionId),
      subjectDigest: sha256(input.subjectDigest),
      occurredAt: canonicalTimestamp(input.occurredAt),
      candidateConfirmationCode: confirmationCode(
        input.candidateConfirmationCode
      )
    });
  }

  function validateReplay(row, input) {
    if (
      row.kind !== input.kind ||
      row.provider !== input.provider ||
      uuid(row.user_id) !== input.userId ||
      uuid(row.connection_id) !== input.connectionId ||
      sha256(String(row.subject_digest)) !== input.subjectDigest ||
      row.status !== "completed" ||
      !CONFIRMATION_CODE_PATTERN.test(row.confirmation_code || "")
    ) {
      fail("meta_compliance_idempotency_conflict", 409);
    }
    return Object.freeze({
      status: "completed",
      confirmationCode: row.confirmation_code,
      replayed: true,
      tokenMaterialsDeleted: 0
    });
  }

  async function executeComplianceRequest(inputValue = {}) {
    assertOpen();
    const input = cleanExecutionInput(inputValue);
    const requestId = requireRandomUuid(randomUUID);
    const auditId = requireRandomUuid(randomUUID);
    const auditEventId = requireRandomUuid(randomUUID);
    const confirmationDigest = crypto
      .createHash("sha256")
      .update("ia4tube-meta-confirmation-v1\0", "utf8")
      .update(input.candidateConfirmationCode, "ascii")
      .digest("hex");

    try {
      return await withTransaction(
        pool,
        async (client) => {
          // Revocation is never delayed by an uncertain publication. Serialize
          // against stage claims, then revoke to prevent any subsequent claim.
          await lockSocialConnection(client, input.companyId, input.provider);
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))",
            [`${input.provider}:${input.eventKey}`]
          );

          const existing = await client.query(
            [
              "SELECT provider,kind,subject_digest,user_id,connection_id,",
              " confirmation_code,status",
              "FROM ia4tube_social.social_compliance_requests",
              "WHERE company_id=$1 AND provider=$2 AND event_key=$3",
              "FOR UPDATE"
            ].join("\n"),
            [input.companyId, input.provider, input.eventKey]
          );
          if (existing.rows?.[0]) {
            return validateReplay(existing.rows[0], input);
          }

          const mapping = await client.query(
            [
              "SELECT user_id,connection_id,status",
              "FROM ia4tube_social.social_meta_subject_mappings",
              "WHERE company_id=$1 AND provider=$2 AND subject_digest=$3",
              "FOR UPDATE"
            ].join("\n"),
            [input.companyId, input.provider, input.subjectDigest]
          );
          const mappingRow = mapping.rows?.[0];
          if (
            !mappingRow ||
            uuid(mappingRow.user_id) !== input.userId ||
            uuid(mappingRow.connection_id) !== input.connectionId ||
            !["active", "revoked"].includes(mappingRow.status)
          ) {
            fail("meta_subject_mapping_invalid", 503);
          }

          await client.query(
            [
              "INSERT INTO ia4tube_social.social_compliance_requests (",
              " company_id,id,provider,kind,event_key,subject_digest,",
              " user_id,connection_id,confirmation_code,",
              " confirmation_code_digest,status,token_materials_deleted,",
              " requested_at",
              ") VALUES (",
              " $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'processing',0,",
              " LEAST($11::timestamptz,CURRENT_TIMESTAMP)",
              ")"
            ].join("\n"),
            [
              input.companyId,
              requestId,
              input.provider,
              input.kind,
              input.eventKey,
              input.subjectDigest,
              input.userId,
              input.connectionId,
              input.candidateConfirmationCode,
              confirmationDigest,
              input.occurredAt
            ]
          );

          const deleted = await client.query(
            [
              "DELETE FROM ia4tube_social.social_encrypted_credentials",
              "WHERE company_id=$1 AND provider=$2",
              " AND credential_type IN ('instagram_user_access_token','access_token')",
              " AND (",
              "   connection_id=$3 OR oauth_transaction_id IN (",
              "     SELECT oauth.id",
              "     FROM ia4tube_social.social_oauth_transactions AS oauth",
              "     WHERE oauth.company_id=$1 AND oauth.provider=$2",
              "       AND oauth.connection_id=$3",
              "   )",
              " )",
              "RETURNING id"
            ].join("\n"),
            [input.companyId, input.provider, input.connectionId]
          );
          const deletedCount = Number(deleted.rowCount || 0);
          if (!Number.isSafeInteger(deletedCount) || deletedCount < 0) fail();
          const detailsCode = deletedCount > 0
            ? "credential_material_deleted"
            : "credential_material_absent";

          await client.query(
            [
              "UPDATE ia4tube_social.social_connections",
              "SET status='revoked',revoked_at=CURRENT_TIMESTAMP,",
              " disconnected_at=NULL,updated_at=CURRENT_TIMESTAMP,",
              " revision=revision+1",
              "WHERE company_id=$1 AND id=$2 AND provider=$3",
              " AND status <> 'revoked'"
            ].join("\n"),
            [input.companyId, input.connectionId, input.provider]
          );

          await client.query(
            [
              "UPDATE ia4tube_social.social_meta_subject_mappings",
              "SET status='revoked',",
              " revoked_at=COALESCE(revoked_at,CURRENT_TIMESTAMP),",
              " updated_at=CURRENT_TIMESTAMP,revision=revision+1",
              "WHERE company_id=$1 AND provider=$2 AND subject_digest=$3",
              " AND status='active'"
            ].join("\n"),
            [input.companyId, input.provider, input.subjectDigest]
          );

          await client.query(
            [
              "INSERT INTO ia4tube_social.social_audit_events (",
              " company_id,id,event_id,actor_user_id,connection_id,provider,",
              " action,outcome,details_code,occurred_at",
              ") VALUES ($1,$2,$3,$4,$5,$6,$7,'succeeded',$8,$9)"
            ].join("\n"),
            [
              input.companyId,
              auditId,
              auditEventId,
              input.userId,
              input.connectionId,
              input.provider,
              input.kind === "data_deletion"
                ? "social.compliance.data_deletion"
                : "social.compliance.deauthorization",
              detailsCode,
              input.occurredAt
            ]
          );

          const completed = await client.query(
            [
              "UPDATE ia4tube_social.social_compliance_requests",
              "SET status='completed',details_code=$4,",
              " token_materials_deleted=$5,",
              " completed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP,",
              " revision=revision+1",
              "WHERE company_id=$1 AND id=$2 AND provider=$3",
              " AND status='processing'",
              "RETURNING confirmation_code"
            ].join("\n"),
            [
              input.companyId,
              requestId,
              input.provider,
              detailsCode,
              deletedCount
            ]
          );
          if (completed.rowCount !== 1) fail();
          return Object.freeze({
            status: "completed",
            confirmationCode: confirmationCode(
              completed.rows[0].confirmation_code
            ),
            replayed: false,
            tokenMaterialsDeleted: deletedCount
          });
        },
        { companyId: input.companyId, role: runtimeRole }
      );
    } catch (error) {
      if (error?.name === "MetaComplianceError") throw error;
      if (error?.code === "23505") {
        const constraint = String(error.constraint || "");
        if (constraint.includes("event_unique")) {
          fail("meta_compliance_idempotency_conflict", 409);
        }
        if (constraint.includes("confirmation")) {
          fail("meta_confirmation_collision", 503);
        }
      }
      fail("meta_compliance_unavailable", 503);
    }
  }

  async function getComplianceStatus(codeInput) {
    assertOpen();
    const code = confirmationCode(codeInput);
    const digest = crypto
      .createHash("sha256")
      .update("ia4tube-meta-confirmation-v1\0", "utf8")
      .update(code, "ascii")
      .digest("hex");
    const result = await withTransaction(
      pool,
      (client) => client.query(
        "SELECT status FROM ia4tube_social.resolve_compliance_status($1)",
        [digest]
      ),
      { role: runtimeRole }
    );
    if (!Array.isArray(result.rows) || result.rows.length > 1) fail();
    const row = result.rows[0];
    if (!row) return null;
    if (!['processing', 'completed', 'failed'].includes(row.status)) fail();
    return Object.freeze({ status: row.status });
  }

  function destroy() {
    if (!destroyed) subjectKey.fill(0);
    destroyed = true;
  }

  return Object.freeze({
    destroy,
    executeComplianceRequest,
    getComplianceStatus,
    resolveMetaSubject,
    subjectMappingForExternalUser
  });
}

module.exports = {
  SUBJECT_DIGEST_VERSION,
  TOKEN_CREDENTIAL_TYPES,
  createPostgresMetaComplianceRepository
};
