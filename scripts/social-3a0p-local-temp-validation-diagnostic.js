"use strict";

const TEMP_VALIDATION_DIAGNOSTIC_KEYS = Object.freeze([
  "scenario",
  "revisionNumber",
  "replacementOccurred",
  "tempValidationStage",
  "sanitizedFailureClass",
  "sanitizedFailureCode",
  "expectedConditionClass",
  "actualConditionClass",
  "previousLedgerPreserved",
  "temporaryFilePresent",
  "backupPrepared",
  "rollbackRequired",
  "cleanupAttempted",
  "cleanupCompleted"
]);

const TEMP_VALIDATION_FAILURE_METADATA_KEYS = Object.freeze([
  "tempValidationStage",
  "sanitizedFailureClass",
  "sanitizedFailureCode",
  "actualConditionClass"
]);

const TEMP_FILE_VALIDATION_STAGES = Object.freeze([
  "second_revision_temp_canonicalize",
  "second_revision_temp_scope_validate",
  "second_revision_temp_ownership_marker_validate",
  "second_revision_temp_exists",
  "second_revision_temp_regular_file_validate",
  "second_revision_temp_reparse_audit",
  "second_revision_temp_hardlink_validate",
  "second_revision_temp_owner_validate",
  "second_revision_temp_acl_validate",
  "second_revision_temp_same_directory_validate",
  "second_revision_temp_same_volume_validate",
  "second_revision_temp_handle_closed_validate",
  "second_revision_temp_size_validate",
  "second_revision_temp_hash_validate",
  "second_revision_temp_parse",
  "second_revision_temp_structure_validate",
  "second_revision_temp_revision_validate",
  "second_revision_temp_run_identity_validate",
  "second_revision_temp_unknown_validation_stage"
]);

const PREVIOUS_LEDGER_VALIDATION_STAGES = Object.freeze([
  "second_revision_previous_ledger_presence_validate",
  "second_revision_previous_ledger_integrity_validate"
]);

const TEMP_VALIDATION_STAGES = Object.freeze([
  ...TEMP_FILE_VALIDATION_STAGES,
  ...PREVIOUS_LEDGER_VALIDATION_STAGES
]);

const TEMP_VALIDATION_FAILURE_CLASSES = Object.freeze([
  "filesystem",
  "acl",
  "ownership",
  "integrity",
  "serialization",
  "process",
  "harness_validation",
  "unknown"
]);

const TEMP_VALIDATION_FAILURE_CODES = Object.freeze([
  "EACCES",
  "EPERM",
  "EBUSY",
  "ENOENT",
  "EEXIST",
  "EINVAL",
  "ENOTEMPTY",
  "MISMATCH",
  "OUTSIDE_SCOPE",
  "REPARSE_DETECTED",
  "HARDLINK_COUNT_INVALID",
  "ACL_INVALID",
  "OWNER_INVALID",
  "HASH_MISMATCH",
  "SIZE_MISMATCH",
  "REVISION_MISMATCH",
  "RUN_IDENTITY_MISMATCH",
  "UNKNOWN"
]);

const TEMP_VALIDATION_CONDITION_CLASSES = Object.freeze([
  "match",
  "mismatch",
  "present",
  "absent",
  "valid",
  "invalid",
  "inside_scope",
  "outside_scope",
  "same",
  "different",
  "closed",
  "open_or_unknown",
  "not_applicable",
  "unknown"
]);

const COMMON_FAILURE_CODES = Object.freeze([
  "EACCES",
  "EPERM",
  "EBUSY",
  "ENOENT",
  "EEXIST",
  "EINVAL",
  "ENOTEMPTY",
  "UNKNOWN"
]);

const STAGE_DEFINITIONS = Object.freeze({
  second_revision_temp_canonicalize: Object.freeze({
    expected: "valid",
    actual: Object.freeze(["invalid", "unknown"]),
    semanticCodes: Object.freeze([])
  }),
  second_revision_temp_scope_validate: Object.freeze({
    expected: "inside_scope",
    actual: Object.freeze(["outside_scope", "unknown"]),
    semanticCodes: Object.freeze(["OUTSIDE_SCOPE"])
  }),
  second_revision_temp_ownership_marker_validate: Object.freeze({
    expected: "valid",
    actual: Object.freeze(["absent", "invalid", "mismatch", "unknown"]),
    semanticCodes: Object.freeze(["MISMATCH", "OWNER_INVALID"])
  }),
  second_revision_temp_exists: Object.freeze({
    expected: "present",
    actual: Object.freeze(["absent", "unknown"]),
    semanticCodes: Object.freeze([])
  }),
  second_revision_temp_regular_file_validate: Object.freeze({
    expected: "valid",
    actual: Object.freeze(["absent", "invalid", "unknown"]),
    semanticCodes: Object.freeze(["MISMATCH"])
  }),
  second_revision_temp_reparse_audit: Object.freeze({
    expected: "absent",
    actual: Object.freeze(["present", "unknown"]),
    semanticCodes: Object.freeze(["REPARSE_DETECTED"])
  }),
  second_revision_temp_hardlink_validate: Object.freeze({
    expected: "valid",
    actual: Object.freeze(["invalid", "unknown"]),
    semanticCodes: Object.freeze(["HARDLINK_COUNT_INVALID"])
  }),
  second_revision_temp_owner_validate: Object.freeze({
    expected: "valid",
    actual: Object.freeze(["invalid", "unknown"]),
    semanticCodes: Object.freeze(["OWNER_INVALID"])
  }),
  second_revision_temp_acl_validate: Object.freeze({
    expected: "valid",
    actual: Object.freeze(["invalid", "unknown"]),
    semanticCodes: Object.freeze(["ACL_INVALID"])
  }),
  second_revision_temp_same_directory_validate: Object.freeze({
    expected: "same",
    actual: Object.freeze(["different", "unknown"]),
    semanticCodes: Object.freeze(["MISMATCH"])
  }),
  second_revision_temp_same_volume_validate: Object.freeze({
    expected: "same",
    actual: Object.freeze(["different", "unknown"]),
    semanticCodes: Object.freeze(["MISMATCH"])
  }),
  second_revision_temp_handle_closed_validate: Object.freeze({
    expected: "closed",
    actual: Object.freeze(["open_or_unknown", "unknown"]),
    semanticCodes: Object.freeze([])
  }),
  second_revision_temp_size_validate: Object.freeze({
    expected: "match",
    actual: Object.freeze(["mismatch", "unknown"]),
    semanticCodes: Object.freeze(["SIZE_MISMATCH"])
  }),
  second_revision_temp_hash_validate: Object.freeze({
    expected: "match",
    actual: Object.freeze(["mismatch", "unknown"]),
    semanticCodes: Object.freeze(["HASH_MISMATCH"])
  }),
  second_revision_temp_parse: Object.freeze({
    expected: "valid",
    actual: Object.freeze(["invalid", "unknown"]),
    semanticCodes: Object.freeze([])
  }),
  second_revision_temp_structure_validate: Object.freeze({
    expected: "valid",
    actual: Object.freeze(["invalid", "unknown"]),
    semanticCodes: Object.freeze(["MISMATCH"])
  }),
  second_revision_temp_revision_validate: Object.freeze({
    expected: "match",
    actual: Object.freeze(["mismatch", "unknown"]),
    semanticCodes: Object.freeze(["REVISION_MISMATCH"])
  }),
  second_revision_temp_run_identity_validate: Object.freeze({
    expected: "match",
    actual: Object.freeze(["mismatch", "unknown"]),
    semanticCodes: Object.freeze(["RUN_IDENTITY_MISMATCH"])
  }),
  second_revision_temp_unknown_validation_stage: Object.freeze({
    expected: "not_applicable",
    actual: Object.freeze(["unknown"]),
    semanticCodes: Object.freeze([])
  }),
  second_revision_previous_ledger_presence_validate: Object.freeze({
    expected: "present",
    actual: Object.freeze(["absent", "unknown"]),
    semanticCodes: Object.freeze([])
  }),
  second_revision_previous_ledger_integrity_validate: Object.freeze({
    expected: "match",
    actual: Object.freeze(["mismatch", "unknown"]),
    semanticCodes: Object.freeze(["HASH_MISMATCH"])
  })
});

const TEMP_VALIDATION_STAGE_CONTRACT = Object.freeze(
  Object.fromEntries(
    Object.entries(STAGE_DEFINITIONS).map(([stage, definition]) => [
      stage,
      Object.freeze({
        expectedConditionClass: definition.expected,
        actualConditionClasses: definition.actual,
        sanitizedFailureCodes: Object.freeze([
          ...COMMON_FAILURE_CODES,
          ...definition.semanticCodes
        ])
      })
    ])
  )
);

const FAILURE_CLASS_SET = new Set(TEMP_VALIDATION_FAILURE_CLASSES);
const FAILURE_CODE_SET = new Set(TEMP_VALIDATION_FAILURE_CODES);
const CONDITION_CLASS_SET = new Set(TEMP_VALIDATION_CONDITION_CLASSES);
const UNKNOWN_STAGE = "second_revision_temp_unknown_validation_stage";
const INVALID_DIAGNOSTIC = "evidence_temp_validation_diagnostic_invalid";

function failInvalid() {
  throw new TypeError(INVALID_DIAGNOSTIC);
}

function exactDataProperties(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) {
    failInvalid();
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== TEMP_VALIDATION_DIAGNOSTIC_KEYS.length ||
    keys.some((key) => typeof key !== "string") ||
    [...keys].sort().some(
      (key, index) => key !== [...TEMP_VALIDATION_DIAGNOSTIC_KEYS].sort()[index]
    )
  ) {
    failInvalid();
  }
  const snapshot = {};
  for (const key of TEMP_VALIDATION_DIAGNOSTIC_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor ||
      descriptor.enumerable !== true ||
      !Object.hasOwn(descriptor, "value") ||
      descriptor.get ||
      descriptor.set
    ) {
      failInvalid();
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function validateTempValidationDiagnostic(value) {
  const snapshot = exactDataProperties(value);
  const stage = snapshot.tempValidationStage;
  if (!Object.hasOwn(STAGE_DEFINITIONS, stage)) failInvalid();
  const definition = STAGE_DEFINITIONS[stage];
  if (
    snapshot.scenario !== "normal_persistence" ||
    snapshot.revisionNumber !== 2 ||
    snapshot.replacementOccurred !== false ||
    !FAILURE_CLASS_SET.has(snapshot.sanitizedFailureClass) ||
    !FAILURE_CODE_SET.has(snapshot.sanitizedFailureCode) ||
    !CONDITION_CLASS_SET.has(snapshot.expectedConditionClass) ||
    !CONDITION_CLASS_SET.has(snapshot.actualConditionClass) ||
    snapshot.expectedConditionClass !== definition.expected ||
    !definition.actual.includes(snapshot.actualConditionClass) ||
    !Object.hasOwn(TEMP_VALIDATION_STAGE_CONTRACT, stage) ||
    !TEMP_VALIDATION_STAGE_CONTRACT[
      stage
    ].sanitizedFailureCodes.includes(snapshot.sanitizedFailureCode) ||
    (definition.semanticCodes.includes(snapshot.sanitizedFailureCode) &&
      snapshot.actualConditionClass === "unknown") ||
    typeof snapshot.previousLedgerPreserved !== "boolean" ||
    typeof snapshot.temporaryFilePresent !== "boolean" ||
    snapshot.backupPrepared !== false ||
    snapshot.rollbackRequired !== false ||
    typeof snapshot.cleanupAttempted !== "boolean" ||
    typeof snapshot.cleanupCompleted !== "boolean" ||
    (snapshot.cleanupCompleted && !snapshot.cleanupAttempted)
  ) {
    failInvalid();
  }
  return true;
}

function normalizedStage(value) {
  return Object.hasOwn(STAGE_DEFINITIONS, value) ? value : UNKNOWN_STAGE;
}

function normalizedFailureClass(value) {
  return FAILURE_CLASS_SET.has(value) ? value : "unknown";
}

function normalizedFailureCode(stage, value) {
  const candidate = String(value || "").toUpperCase();
  return FAILURE_CODE_SET.has(candidate) &&
    TEMP_VALIDATION_STAGE_CONTRACT[stage].sanitizedFailureCodes.includes(candidate)
    ? candidate
    : "UNKNOWN";
}

function normalizedActualCondition(stage, value) {
  return STAGE_DEFINITIONS[stage].actual.includes(value) ? value : "unknown";
}

function createTempValidationFailureMetadata(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const tempValidationStage = normalizedStage(
    source.tempValidationStage || source.stage
  );
  const metadata = {
    tempValidationStage,
    sanitizedFailureClass: normalizedFailureClass(
      source.sanitizedFailureClass || source.failureClass
    ),
    sanitizedFailureCode: normalizedFailureCode(
      tempValidationStage,
      source.sanitizedFailureCode || source.failureCode
    ),
    actualConditionClass: normalizedActualCondition(
      tempValidationStage,
      source.actualConditionClass
    )
  };
  const probe = createTempValidationDiagnostic({
    ...metadata,
    previousLedgerPreserved: false,
    temporaryFilePresent: false,
    cleanupAttempted: false,
    cleanupCompleted: false
  });
  if (
    Reflect.ownKeys(metadata).length !==
      TEMP_VALIDATION_FAILURE_METADATA_KEYS.length ||
    !TEMP_VALIDATION_FAILURE_METADATA_KEYS.every((key) =>
      Object.hasOwn(metadata, key)
    ) ||
    probe.tempValidationStage !== metadata.tempValidationStage ||
    probe.sanitizedFailureClass !== metadata.sanitizedFailureClass ||
    probe.sanitizedFailureCode !== metadata.sanitizedFailureCode ||
    probe.actualConditionClass !== metadata.actualConditionClass
  ) {
    failInvalid();
  }
  return Object.freeze(metadata);
}

function attachTempValidationFailure(error, input = {}) {
  const failure = error instanceof Error
    ? error
    : new Error("evidence_temp_validation_stage_failed");
  const metadata = createTempValidationFailureMetadata(input);
  Object.defineProperty(failure, "tempValidationFailure", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: metadata
  });
  return failure;
}

function createTempValidationDiagnostic(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const tempValidationStage = normalizedStage(
    source.tempValidationStage || source.stage
  );
  const cleanupAttempted = source.cleanupAttempted === true;
  const diagnostic = {
    scenario: "normal_persistence",
    revisionNumber: 2,
    replacementOccurred: false,
    tempValidationStage,
    sanitizedFailureClass: normalizedFailureClass(
      source.sanitizedFailureClass || source.failureClass
    ),
    sanitizedFailureCode: normalizedFailureCode(
      tempValidationStage,
      source.sanitizedFailureCode || source.failureCode
    ),
    expectedConditionClass: STAGE_DEFINITIONS[tempValidationStage].expected,
    actualConditionClass: normalizedActualCondition(
      tempValidationStage,
      source.actualConditionClass
    ),
    previousLedgerPreserved: source.previousLedgerPreserved === true,
    temporaryFilePresent: source.temporaryFilePresent === true,
    backupPrepared: false,
    rollbackRequired: false,
    cleanupAttempted,
    cleanupCompleted: cleanupAttempted && source.cleanupCompleted === true
  };
  validateTempValidationDiagnostic(diagnostic);
  return Object.freeze(diagnostic);
}

function serializeTempValidationDiagnostic(value) {
  const snapshot = exactDataProperties(value);
  validateTempValidationDiagnostic(snapshot);
  return JSON.stringify(snapshot);
}

module.exports = {
  COMMON_FAILURE_CODES,
  PREVIOUS_LEDGER_VALIDATION_STAGES,
  TEMP_FILE_VALIDATION_STAGES,
  TEMP_VALIDATION_CONDITION_CLASSES,
  TEMP_VALIDATION_DIAGNOSTIC_KEYS,
  TEMP_VALIDATION_FAILURE_METADATA_KEYS,
  TEMP_VALIDATION_FAILURE_CLASSES,
  TEMP_VALIDATION_FAILURE_CODES,
  TEMP_VALIDATION_STAGES,
  TEMP_VALIDATION_STAGE_CONTRACT,
  attachTempValidationFailure,
  createTempValidationFailureMetadata,
  createTempValidationDiagnostic,
  serializeTempValidationDiagnostic,
  validateTempValidationDiagnostic
};
