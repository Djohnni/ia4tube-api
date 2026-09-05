"use strict";

const crypto = require("node:crypto");
const { complianceFail } = require("./errors");
const {
  CONFIRMATION_CODE_PATTERN
} = require("./meta-compliance-service");
const {
  META_EXTERNAL_USER_ID_PATTERN
} = require("./meta-signed-request");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function uuid(value) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    complianceFail("meta_compliance_repository_invalid", 503);
  }
  return value.toLowerCase();
}

function subjectKey(provider, externalUserId) {
  if (
    provider !== "instagram" ||
    !META_EXTERNAL_USER_ID_PATTERN.test(externalUserId || "")
  ) {
    complianceFail("meta_compliance_repository_invalid", 503);
  }
  return `${provider}:${externalUserId}`;
}

function syntheticSubjectDigest(provider, externalUserId) {
  return crypto.createHash("sha256")
    .update("ia4tube-meta-synthetic-subject-v1\0", "utf8")
    .update(provider, "ascii")
    .update("\0", "ascii")
    .update(externalUserId, "ascii")
    .digest("hex");
}

function createInMemoryMetaComplianceRepository(options = {}) {
  const randomUUID = options.randomUUID || crypto.randomUUID;
  if (typeof randomUUID !== "function") {
    complianceFail("meta_compliance_repository_invalid", 503);
  }
  const mappings = new Map();
  for (const entry of options.subjectMappings || []) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      complianceFail("meta_compliance_repository_invalid", 503);
    }
    const key = subjectKey(entry.provider, entry.externalUserId);
    if (mappings.has(key)) {
      complianceFail("meta_subject_mapping_ambiguous", 503);
    }
    mappings.set(key, Object.freeze({
      companyId: uuid(entry.companyId),
      userId: uuid(entry.userId),
      connectionId: uuid(entry.connectionId),
      subjectDigest: syntheticSubjectDigest(
        entry.provider,
        entry.externalUserId
      )
    }));
  }

  const tokenMaterials = new Map();
  for (const entry of options.tokenMaterials || []) {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      entry.provider !== "instagram" ||
      !Buffer.isBuffer(entry.material) ||
      entry.material.length < 1
    ) {
      complianceFail("meta_compliance_repository_invalid", 503);
    }
    const companyId = uuid(entry.companyId);
    const connectionId = uuid(entry.connectionId);
    const id = uuid(entry.id);
    const key = `${companyId}:${id}`;
    if (tokenMaterials.has(key)) {
      complianceFail("meta_compliance_repository_invalid", 503);
    }
    tokenMaterials.set(key, {
      companyId,
      connectionId,
      provider: "instagram",
      material: entry.material
    });
  }

  const operations = new Map();
  const confirmations = new Map();
  const audits = [];

  async function resolveMetaSubject({ provider, externalUserId } = {}) {
    return mappings.get(subjectKey(provider, externalUserId)) || null;
  }

  async function executeComplianceRequest(input = {}) {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      !["deauthorization", "data_deletion"].includes(input.kind) ||
      typeof input.eventKey !== "string" ||
      !/^[0-9a-f]{64}$/.test(input.eventKey) ||
      input.provider !== "instagram" ||
      typeof input.occurredAt !== "string" ||
      !Number.isFinite(Date.parse(input.occurredAt)) ||
      !CONFIRMATION_CODE_PATTERN.test(input.candidateConfirmationCode || "")
    ) {
      complianceFail("meta_compliance_repository_invalid", 503);
    }
    const companyId = uuid(input.companyId);
    const userId = uuid(input.userId);
    const connectionId = uuid(input.connectionId);
    const previous = operations.get(input.eventKey);
    if (previous) {
      if (
        previous.kind !== input.kind ||
        previous.companyId !== companyId ||
        previous.userId !== userId ||
        previous.connectionId !== connectionId
      ) {
        complianceFail("meta_compliance_idempotency_conflict", 409);
      }
      return Object.freeze({
        status: "completed",
        confirmationCode: previous.confirmationCode,
        replayed: true,
        tokenMaterialsDeleted: 0
      });
    }

    if (confirmations.has(input.candidateConfirmationCode)) {
      complianceFail("meta_confirmation_collision", 503);
    }
    const eventId = uuid(randomUUID());
    const tokenKeys = [];
    for (const [key, token] of tokenMaterials) {
      if (
        token.companyId !== companyId ||
        token.connectionId !== connectionId ||
        token.provider !== input.provider
      ) {
        continue;
      }
      tokenKeys.push(key);
    }
    const audit = Object.freeze({
      eventId,
      companyId,
      connectionId,
      actorUserId: userId,
      action: input.kind === "data_deletion"
        ? "social.compliance.data_deletion"
        : "social.compliance.deauthorization",
      outcome: "succeeded",
      detailsCode: tokenKeys.length > 0
        ? "credential_material_deleted"
        : "credential_material_absent",
      occurredAt: input.occurredAt
    });

    for (const key of tokenKeys) {
      const token = tokenMaterials.get(key);
      token.material.fill(0);
      tokenMaterials.delete(key);
    }

    const record = Object.freeze({
      kind: input.kind,
      companyId,
      userId,
      connectionId,
      confirmationCode: input.candidateConfirmationCode,
      status: "completed"
    });
    operations.set(input.eventKey, record);
    confirmations.set(record.confirmationCode, Object.freeze({
      status: "completed"
    }));
    audits.push(audit);
    return Object.freeze({
      status: "completed",
      confirmationCode: record.confirmationCode,
      replayed: false,
      tokenMaterialsDeleted: tokenKeys.length
    });
  }

  async function getComplianceStatus(confirmationCode) {
    if (!CONFIRMATION_CODE_PATTERN.test(confirmationCode || "")) return null;
    return confirmations.get(confirmationCode) || null;
  }

  function snapshot() {
    const tokensByCompany = {};
    for (const token of tokenMaterials.values()) {
      tokensByCompany[token.companyId] =
        Number(tokensByCompany[token.companyId] || 0) + 1;
    }
    return Object.freeze({
      operationCount: operations.size,
      confirmationCount: confirmations.size,
      tokenMaterialCount: tokenMaterials.size,
      tokensByCompany: Object.freeze({ ...tokensByCompany }),
      audits: Object.freeze(audits.map((event) => Object.freeze({ ...event })))
    });
  }

  function destroy() {
    for (const token of tokenMaterials.values()) token.material.fill(0);
    tokenMaterials.clear();
    operations.clear();
    confirmations.clear();
    audits.length = 0;
    mappings.clear();
  }

  return Object.freeze({
    resolveMetaSubject,
    executeComplianceRequest,
    getComplianceStatus,
    snapshot,
    destroy
  });
}

module.exports = {
  createInMemoryMetaComplianceRepository
};
