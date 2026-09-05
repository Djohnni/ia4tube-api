"use strict";

const crypto = require("node:crypto");
const { complianceFail } = require("./errors");

const COMPLIANCE_KINDS = Object.freeze([
  "deauthorization",
  "data_deletion"
]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONFIRMATION_CODE_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

function requireUuid(value) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    complianceFail("meta_subject_mapping_invalid", 503);
  }
  return value.toLowerCase();
}

function requireKind(value) {
  if (!COMPLIANCE_KINDS.includes(value)) {
    complianceFail("meta_compliance_request_invalid");
  }
  return value;
}

function requireConfirmationCode(value, unavailable = false) {
  if (typeof value !== "string" || !CONFIRMATION_CODE_PATTERN.test(value)) {
    complianceFail(
      unavailable ? "meta_confirmation_unavailable" :
        "meta_compliance_repository_invalid",
      unavailable ? 404 : 503
    );
  }
  return value;
}

function normalizeStatusBaseUrl(value) {
  if (typeof value !== "string" || value.length > 2048) {
    complianceFail("meta_compliance_configuration_invalid", 503);
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    complianceFail("meta_compliance_configuration_invalid", 503);
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.pathname.endsWith("/")
  ) {
    complianceFail("meta_compliance_configuration_invalid", 503);
  }
  return url.toString();
}

function requireRepository(value) {
  if (
    !value ||
    typeof value.resolveMetaSubject !== "function" ||
    typeof value.executeComplianceRequest !== "function" ||
    typeof value.getComplianceStatus !== "function"
  ) {
    complianceFail("meta_compliance_repository_invalid", 503);
  }
  return value;
}

function opaqueConfirmationCode(randomBytes) {
  let bytes;
  try {
    bytes = randomBytes(24);
  } catch {
    complianceFail("meta_compliance_configuration_invalid", 503);
  }
  if (!Buffer.isBuffer(bytes) || bytes.length !== 24) {
    if (Buffer.isBuffer(bytes)) bytes.fill(0);
    complianceFail("meta_compliance_configuration_invalid", 503);
  }
  try {
    return requireConfirmationCode(bytes.toString("base64url"));
  } finally {
    bytes.fill(0);
  }
}

function requestEventKey(kind, requestDigest) {
  if (typeof requestDigest !== "string" || !/^[0-9a-f]{64}$/.test(requestDigest)) {
    complianceFail("meta_signed_request_invalid");
  }
  return crypto.createHash("sha256")
    .update("ia4tube-meta-compliance-event-v1\0", "utf8")
    .update(kind, "ascii")
    .update("\0", "ascii")
    .update(requestDigest, "ascii")
    .digest("hex");
}

function normalizeExecutionResult(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !["completed"].includes(value.status) ||
    typeof value.replayed !== "boolean" ||
    !Number.isSafeInteger(value.tokenMaterialsDeleted) ||
    value.tokenMaterialsDeleted < 0
  ) {
    complianceFail("meta_compliance_repository_invalid", 503);
  }
  return Object.freeze({
    status: "completed",
    confirmationCode: requireConfirmationCode(value.confirmationCode),
    replayed: value.replayed,
    tokenMaterialsDeleted: value.tokenMaterialsDeleted
  });
}

function createMetaComplianceService(options = {}) {
  const verifier = options.signedRequestVerifier;
  const repository = requireRepository(options.repository);
  const statusBaseUrl = normalizeStatusBaseUrl(options.publicStatusBaseUrl);
  const clock = options.clock || Date.now;
  const randomBytes = options.randomBytes || crypto.randomBytes;
  if (
    !verifier ||
    typeof verifier.verify !== "function" ||
    typeof clock !== "function" ||
    typeof randomBytes !== "function"
  ) {
    complianceFail("meta_compliance_configuration_invalid", 503);
  }

  async function execute(kindInput, signedRequest) {
    const kind = requireKind(kindInput);
    const verified = verifier.verify(signedRequest);
    const mapping = await repository.resolveMetaSubject({
      provider: verified.provider,
      externalUserId: verified.externalUserId
    });
    if (mapping === null || mapping === undefined) {
      complianceFail("meta_subject_unmapped", 404);
    }
    if (
      !mapping ||
      typeof mapping !== "object" ||
      Array.isArray(mapping)
    ) {
      complianceFail("meta_subject_mapping_invalid", 503);
    }
    const companyId = requireUuid(mapping.companyId);
    const userId = requireUuid(mapping.userId);
    const connectionId = requireUuid(mapping.connectionId);
    if (
      typeof mapping.subjectDigest !== "string" ||
      !/^[0-9a-f]{64}$/.test(mapping.subjectDigest)
    ) {
      complianceFail("meta_subject_mapping_invalid", 503);
    }
    const nowMs = Number(clock());
    if (!Number.isFinite(nowMs) || nowMs < 1) {
      complianceFail("meta_compliance_configuration_invalid", 503);
    }
    const eventKey = requestEventKey(kind, verified.requestDigest);
    const candidateConfirmationCode = opaqueConfirmationCode(randomBytes);
    const executed = normalizeExecutionResult(
      await repository.executeComplianceRequest({
        kind,
        eventKey,
        provider: verified.provider,
        companyId,
        userId,
        connectionId,
        subjectDigest: mapping.subjectDigest,
        occurredAt: new Date(nowMs).toISOString(),
        candidateConfirmationCode
      })
    );
    return Object.freeze({
      kind,
      status: executed.status,
      confirmationCode: executed.confirmationCode,
      statusUrl: `${statusBaseUrl}/${encodeURIComponent(executed.confirmationCode)}`,
      replayed: executed.replayed,
      tokenMaterialsDeleted: executed.tokenMaterialsDeleted
    });
  }

  async function handleDeauthorization({ signedRequest } = {}) {
    return execute("deauthorization", signedRequest);
  }

  async function handleDataDeletion({ signedRequest } = {}) {
    return execute("data_deletion", signedRequest);
  }

  async function getStatus({ confirmationCode } = {}) {
    const code = requireConfirmationCode(confirmationCode, true);
    const result = await repository.getComplianceStatus(code);
    if (result === null || result === undefined) {
      complianceFail("meta_confirmation_unavailable", 404);
    }
    if (
      !result ||
      typeof result !== "object" ||
      Array.isArray(result) ||
      result.status !== "completed"
    ) {
      complianceFail("meta_compliance_repository_invalid", 503);
    }
    return Object.freeze({ status: "completed" });
  }

  return Object.freeze({
    handleDataDeletion,
    handleDeauthorization,
    getStatus
  });
}

module.exports = {
  COMPLIANCE_KINDS,
  CONFIRMATION_CODE_PATTERN,
  createMetaComplianceService
};
