"use strict";

const {
  validateFileReplaceExceptionDiagnostic
} = require("./social-3a0p-local-file-replace-diagnostic");
const {
  validateFileReplaceArgumentDiagnostic
} = require("./social-3a0p-local-file-replace-argument-diagnostic");

const FAILURE_STAGE = Object.freeze({
  evidence_second_revision_prepare_failed: "second_revision_prepare",
  evidence_second_revision_serialize_failed: "second_revision_serialize",
  evidence_second_revision_temp_validation_failed: "second_revision_temp_validate",
  evidence_second_revision_temp_create_failed: "second_revision_temp_create",
  evidence_second_revision_write_failed: "second_revision_write",
  evidence_second_revision_flush_failed: "second_revision_flush",
  evidence_second_revision_close_failed: "second_revision_close",
  evidence_second_revision_pre_replace_validation_failed:
    "second_revision_pre_replace_validate",
  evidence_second_revision_replacement_prepare_failed:
    "second_revision_replacement_prepare",
  evidence_second_revision_atomic_replace_failed:
    "second_revision_atomic_replace",
  evidence_second_revision_reopen_failed: "second_revision_reopen",
  evidence_second_revision_verification_failed: "second_revision_verify",
  evidence_second_revision_hash_failed: "second_revision_hash",
  evidence_second_revision_finalize_failed: "second_revision_finalize",
  evidence_second_revision_rollback_failed: "second_revision_rollback",
  evidence_second_revision_temp_cleanup_failed:
    "second_revision_temp_cleanup"
});

const FAILURE_CODES = new Set(Object.keys(FAILURE_STAGE));
const SYSTEM_ERROR_CODES = new Set([
  "EACCES",
  "EPERM",
  "EBUSY",
  "EEXIST",
  "ENOENT",
  "EINVAL",
  "ENOTEMPTY",
  "UNKNOWN"
]);
const SYSTEM_ERROR_CLASSES = new Set([
  "filesystem",
  "permission",
  "path",
  "platform",
  "process",
  "harness_validation",
  "unknown"
]);
const DIAGNOSTIC_KEYS = Object.freeze([
  "event",
  "persistenceStage",
  "sanitizedFailureCode",
  "systemErrorClass",
  "systemErrorCode",
  "revisionNumber",
  "previousLedgerPreserved",
  "temporaryFilePresent",
  "cleanupAttempted",
  "cleanupCompleted",
  "explicitBackupPrepared",
  "explicitBackupValidated",
  "explicitBackupMatchesPreviousRevision",
  "newLedgerValidated",
  "rollbackRequired",
  "rollbackAttempted",
  "rollbackCompleted",
  "previousLedgerRestored",
  "failedCandidatePreserved",
  "failedCandidateRemovedAfterRestore",
  "backupRemovedAfterValidation"
]);

class EvidencePersistenceStageFailure extends Error {
  constructor({ failureCode, systemErrorClass, systemErrorCode }) {
    if (!FAILURE_CODES.has(failureCode)) {
      throw new TypeError("evidence_persistence_failure_code_invalid");
    }
    if (!SYSTEM_ERROR_CLASSES.has(systemErrorClass)) {
      throw new TypeError("evidence_persistence_system_error_class_invalid");
    }
    if (!SYSTEM_ERROR_CODES.has(systemErrorCode)) {
      throw new TypeError("evidence_persistence_system_error_code_invalid");
    }
    super(failureCode);
    this.name = "EvidencePersistenceStageFailure";
    this.failureCode = failureCode;
    this.persistenceStage = FAILURE_STAGE[failureCode];
    this.systemErrorClass = systemErrorClass;
    this.systemErrorCode = systemErrorCode;
  }
}

function systemMetadata(error) {
  const providedClass = String(error?.systemErrorClass || "");
  const providedCode = String(error?.systemErrorCode || "").toUpperCase();
  if (
    SYSTEM_ERROR_CLASSES.has(providedClass) &&
    SYSTEM_ERROR_CODES.has(providedCode)
  ) {
    return {
      systemErrorClass: providedClass,
      systemErrorCode: providedCode
    };
  }

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
  if (/^(?:evidence|windows_evidence)_[a-z0-9_]+$/.test(canonical)) {
    return { systemErrorClass: "process", systemErrorCode: "UNKNOWN" };
  }
  return { systemErrorClass: "unknown", systemErrorCode: "UNKNOWN" };
}

function persistenceStageFailure(error, failureCode) {
  if (error instanceof EvidencePersistenceStageFailure) return error;
  const failure = new EvidencePersistenceStageFailure({
    failureCode,
    ...systemMetadata(error)
  });
  if (error?.fileReplaceDiagnostic) {
    validateFileReplaceExceptionDiagnostic(error.fileReplaceDiagnostic);
    Object.defineProperty(failure, "fileReplaceDiagnostic", {
      configurable: false,
      enumerable: false,
      writable: false,
      value: error.fileReplaceDiagnostic
    });
  }
  if (error?.fileReplaceArgumentDiagnostic) {
    validateFileReplaceArgumentDiagnostic(error.fileReplaceArgumentDiagnostic);
    Object.defineProperty(failure, "fileReplaceArgumentDiagnostic", {
      configurable: false,
      enumerable: false,
      writable: false,
      value: error.fileReplaceArgumentDiagnostic
    });
  }
  return failure;
}

function validatePersistenceDiagnostic(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError("evidence_persistence_diagnostic_invalid");
  }
  const keys = Object.keys(value).sort();
  const expected = [...DIAGNOSTIC_KEYS].sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index]) ||
    value.event !== "evidence_ledger_persistence_failure" ||
    !FAILURE_CODES.has(value.sanitizedFailureCode) ||
    value.persistenceStage !== FAILURE_STAGE[value.sanitizedFailureCode] ||
    !SYSTEM_ERROR_CLASSES.has(value.systemErrorClass) ||
    !SYSTEM_ERROR_CODES.has(value.systemErrorCode) ||
    !Number.isSafeInteger(value.revisionNumber) ||
    value.revisionNumber < 2 ||
    typeof value.previousLedgerPreserved !== "boolean" ||
    typeof value.temporaryFilePresent !== "boolean" ||
    typeof value.cleanupAttempted !== "boolean" ||
    typeof value.cleanupCompleted !== "boolean" ||
    typeof value.explicitBackupPrepared !== "boolean" ||
    typeof value.explicitBackupValidated !== "boolean" ||
    typeof value.explicitBackupMatchesPreviousRevision !== "boolean" ||
    typeof value.newLedgerValidated !== "boolean" ||
    typeof value.rollbackRequired !== "boolean" ||
    typeof value.rollbackAttempted !== "boolean" ||
    typeof value.rollbackCompleted !== "boolean" ||
    typeof value.previousLedgerRestored !== "boolean" ||
    typeof value.failedCandidatePreserved !== "boolean" ||
    typeof value.failedCandidateRemovedAfterRestore !== "boolean" ||
    typeof value.backupRemovedAfterValidation !== "boolean" ||
    (value.cleanupCompleted && !value.cleanupAttempted) ||
    (value.explicitBackupValidated && !value.explicitBackupPrepared) ||
    (value.explicitBackupMatchesPreviousRevision &&
      !value.explicitBackupValidated) ||
    (value.rollbackAttempted && !value.rollbackRequired) ||
    (value.rollbackCompleted && !value.rollbackAttempted) ||
    (value.rollbackCompleted && !value.previousLedgerRestored) ||
    (value.previousLedgerRestored && !value.rollbackCompleted) ||
    (value.previousLedgerRestored && !value.previousLedgerPreserved) ||
    (value.failedCandidatePreserved && !value.rollbackAttempted) ||
    (value.failedCandidateRemovedAfterRestore &&
      (!value.failedCandidatePreserved || !value.rollbackCompleted)) ||
    (value.backupRemovedAfterValidation &&
      (!value.explicitBackupMatchesPreviousRevision ||
        !value.newLedgerValidated ||
        value.rollbackRequired))
  ) {
    throw new TypeError("evidence_persistence_diagnostic_invalid");
  }
  return true;
}

function createPersistenceDiagnostic({
  failure,
  revisionNumber,
  previousLedgerPreserved,
  temporaryFilePresent,
  cleanupAttempted,
  cleanupCompleted,
  explicitBackupPrepared = false,
  explicitBackupValidated = false,
  explicitBackupMatchesPreviousRevision = false,
  newLedgerValidated = false,
  rollbackRequired = false,
  rollbackAttempted = false,
  rollbackCompleted = false,
  previousLedgerRestored = false,
  failedCandidatePreserved = false,
  failedCandidateRemovedAfterRestore = false,
  backupRemovedAfterValidation = false
}) {
  if (!(failure instanceof EvidencePersistenceStageFailure)) {
    throw new TypeError("evidence_persistence_failure_invalid");
  }
  const diagnostic = {
    event: "evidence_ledger_persistence_failure",
    persistenceStage: failure.persistenceStage,
    sanitizedFailureCode: failure.failureCode,
    systemErrorClass: failure.systemErrorClass,
    systemErrorCode: failure.systemErrorCode,
    revisionNumber,
    previousLedgerPreserved: previousLedgerPreserved === true,
    temporaryFilePresent: temporaryFilePresent === true,
    cleanupAttempted: cleanupAttempted === true,
    cleanupCompleted: cleanupCompleted === true,
    explicitBackupPrepared: explicitBackupPrepared === true,
    explicitBackupValidated: explicitBackupValidated === true,
    explicitBackupMatchesPreviousRevision:
      explicitBackupMatchesPreviousRevision === true,
    newLedgerValidated: newLedgerValidated === true,
    rollbackRequired: rollbackRequired === true,
    rollbackAttempted: rollbackAttempted === true,
    rollbackCompleted: rollbackCompleted === true,
    previousLedgerRestored: previousLedgerRestored === true,
    failedCandidatePreserved: failedCandidatePreserved === true,
    failedCandidateRemovedAfterRestore:
      failedCandidateRemovedAfterRestore === true,
    backupRemovedAfterValidation: backupRemovedAfterValidation === true
  };
  validatePersistenceDiagnostic(diagnostic);
  return Object.freeze(diagnostic);
}

function serializePersistenceDiagnostic(value) {
  validatePersistenceDiagnostic(value);
  return JSON.stringify(value);
}

module.exports = {
  DIAGNOSTIC_KEYS,
  EvidencePersistenceStageFailure,
  FAILURE_STAGE,
  SYSTEM_ERROR_CLASSES,
  SYSTEM_ERROR_CODES,
  createPersistenceDiagnostic,
  persistenceStageFailure,
  serializePersistenceDiagnostic,
  validatePersistenceDiagnostic
};
