"use strict";

const crypto = require("node:crypto");

const FAILURE_STAGE = Object.freeze({
  evidence_parent_validation_failed: "parent_validation",
  evidence_root_create_failed: "root_create",
  evidence_root_canonicalization_failed: "root_canonicalization",
  evidence_root_outside_allowed_scope: "root_scope_validation",
  evidence_root_reparse_detected: "root_reparse_validation",
  evidence_root_owner_resolution_failed: "root_owner_resolution",
  evidence_root_owner_validation_failed: "root_owner_validation",
  evidence_root_acl_protection_failed: "root_acl_protection",
  evidence_root_acl_validation_failed: "root_acl_validation",
  evidence_ledger_temp_create_failed: "ledger_temp_create",
  evidence_ledger_first_write_failed: "ledger_first_write",
  evidence_ledger_flush_failed: "ledger_flush",
  evidence_ledger_atomic_rename_failed: "ledger_atomic_rename",
  evidence_ledger_reopen_failed: "ledger_reopen",
  evidence_ledger_first_revision_failed: "ledger_first_revision",
  evidence_ledger_partial_cleanup_failed: "partial_cleanup"
});
const FAILURE_CODES = new Set(Object.keys(FAILURE_STAGE));
const SYSTEM_ERROR_CODES = new Set([
  "EACCES",
  "EPERM",
  "EEXIST",
  "ENOENT",
  "EINVAL",
  "EBUSY",
  "UNKNOWN"
]);
const SYSTEM_ERROR_CLASSES = new Set([
  "filesystem",
  "permission",
  "path",
  "process",
  "harness_validation",
  "unknown"
]);
const DIAGNOSTIC_KEYS = Object.freeze([
  "event",
  "bootstrapStage",
  "sanitizedFailureCode",
  "systemErrorClass",
  "systemErrorCode",
  "runIdHashPrefix",
  "cleanupAttempted",
  "cleanupCompleted"
]);

class EvidenceBootstrapStageFailure extends Error {
  constructor({ failureCode, systemErrorClass, systemErrorCode }) {
    if (!FAILURE_CODES.has(failureCode)) {
      throw new TypeError("evidence_bootstrap_failure_code_invalid");
    }
    if (!SYSTEM_ERROR_CLASSES.has(systemErrorClass)) {
      throw new TypeError("evidence_bootstrap_system_error_class_invalid");
    }
    if (!SYSTEM_ERROR_CODES.has(systemErrorCode)) {
      throw new TypeError("evidence_bootstrap_system_error_code_invalid");
    }
    super(failureCode);
    this.name = "EvidenceBootstrapStageFailure";
    this.failureCode = failureCode;
    this.bootstrapStage = FAILURE_STAGE[failureCode];
    this.systemErrorClass = systemErrorClass;
    this.systemErrorCode = systemErrorCode;
  }
}

function systemMetadata(error) {
  const candidate = String(error?.code || "").toUpperCase();
  if (SYSTEM_ERROR_CODES.has(candidate) && candidate !== "UNKNOWN") {
    const systemErrorClass = ["EACCES", "EPERM"].includes(candidate)
      ? "permission"
      : candidate === "EINVAL"
        ? "path"
        : "filesystem";
    return { systemErrorClass, systemErrorCode: candidate };
  }
  const canonical = String(error?.code || "");
  if (/^harness_process_[a-z0-9_]+$/.test(canonical)) {
    return {
      systemErrorClass: "harness_validation",
      systemErrorCode: "UNKNOWN"
    };
  }
  if (/^(?:evidence_acl|evidence_reparse|windows_evidence)_[a-z0-9_]+$/.test(canonical)) {
    return { systemErrorClass: "process", systemErrorCode: "UNKNOWN" };
  }
  return { systemErrorClass: "unknown", systemErrorCode: "UNKNOWN" };
}

function bootstrapStageFailure(error, failureCode) {
  if (error instanceof EvidenceBootstrapStageFailure) return error;
  return new EvidenceBootstrapStageFailure({
    failureCode,
    ...systemMetadata(error)
  });
}

function validateBootstrapDiagnostic(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError("evidence_bootstrap_diagnostic_invalid");
  }
  const keys = Object.keys(value).sort();
  const expected = [...DIAGNOSTIC_KEYS].sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index]) ||
    value.event !== "evidence_ledger_bootstrap_failure" ||
    !FAILURE_CODES.has(value.sanitizedFailureCode) ||
    value.bootstrapStage !== FAILURE_STAGE[value.sanitizedFailureCode] ||
    !SYSTEM_ERROR_CLASSES.has(value.systemErrorClass) ||
    !SYSTEM_ERROR_CODES.has(value.systemErrorCode) ||
    !/^[0-9a-f]{12}$/.test(value.runIdHashPrefix) ||
    typeof value.cleanupAttempted !== "boolean" ||
    typeof value.cleanupCompleted !== "boolean" ||
    (value.cleanupCompleted && !value.cleanupAttempted)
  ) {
    throw new TypeError("evidence_bootstrap_diagnostic_invalid");
  }
  return true;
}

function createBootstrapDiagnostic({
  failure,
  runId,
  cleanupAttempted,
  cleanupCompleted
}) {
  if (!(failure instanceof EvidenceBootstrapStageFailure)) {
    throw new TypeError("evidence_bootstrap_failure_invalid");
  }
  const runIdHashPrefix = crypto
    .createHash("sha256")
    .update(String(runId || ""), "utf8")
    .digest("hex")
    .slice(0, 12);
  const diagnostic = {
    event: "evidence_ledger_bootstrap_failure",
    bootstrapStage: failure.bootstrapStage,
    sanitizedFailureCode: failure.failureCode,
    systemErrorClass: failure.systemErrorClass,
    systemErrorCode: failure.systemErrorCode,
    runIdHashPrefix,
    cleanupAttempted: cleanupAttempted === true,
    cleanupCompleted: cleanupCompleted === true
  };
  validateBootstrapDiagnostic(diagnostic);
  return Object.freeze(diagnostic);
}

function serializeBootstrapDiagnostic(value) {
  validateBootstrapDiagnostic(value);
  return JSON.stringify(value);
}

module.exports = {
  DIAGNOSTIC_KEYS,
  EvidenceBootstrapStageFailure,
  FAILURE_STAGE,
  SYSTEM_ERROR_CLASSES,
  SYSTEM_ERROR_CODES,
  bootstrapStageFailure,
  createBootstrapDiagnostic,
  serializeBootstrapDiagnostic,
  validateBootstrapDiagnostic
};
