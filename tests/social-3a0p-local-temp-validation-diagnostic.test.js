"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
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
} = require("../scripts/social-3a0p-local-temp-validation-diagnostic");

const INVALID_DIAGNOSTIC = "evidence_temp_validation_diagnostic_invalid";

const STAGE_CASES = Object.freeze({
  second_revision_temp_canonicalize: Object.freeze({
    failureClass: "filesystem",
    failureCode: "EINVAL",
    actual: "invalid"
  }),
  second_revision_temp_scope_validate: Object.freeze({
    failureClass: "filesystem",
    failureCode: "OUTSIDE_SCOPE",
    actual: "outside_scope"
  }),
  second_revision_temp_ownership_marker_validate: Object.freeze({
    failureClass: "ownership",
    failureCode: "MISMATCH",
    actual: "mismatch"
  }),
  second_revision_temp_exists: Object.freeze({
    failureClass: "filesystem",
    failureCode: "ENOENT",
    actual: "absent"
  }),
  second_revision_temp_regular_file_validate: Object.freeze({
    failureClass: "filesystem",
    failureCode: "MISMATCH",
    actual: "invalid"
  }),
  second_revision_temp_reparse_audit: Object.freeze({
    failureClass: "filesystem",
    failureCode: "REPARSE_DETECTED",
    actual: "present"
  }),
  second_revision_temp_hardlink_validate: Object.freeze({
    failureClass: "ownership",
    failureCode: "HARDLINK_COUNT_INVALID",
    actual: "invalid"
  }),
  second_revision_temp_owner_validate: Object.freeze({
    failureClass: "ownership",
    failureCode: "OWNER_INVALID",
    actual: "invalid"
  }),
  second_revision_temp_acl_validate: Object.freeze({
    failureClass: "acl",
    failureCode: "ACL_INVALID",
    actual: "invalid"
  }),
  second_revision_temp_same_directory_validate: Object.freeze({
    failureClass: "filesystem",
    failureCode: "MISMATCH",
    actual: "different"
  }),
  second_revision_temp_same_volume_validate: Object.freeze({
    failureClass: "filesystem",
    failureCode: "MISMATCH",
    actual: "different"
  }),
  second_revision_temp_handle_closed_validate: Object.freeze({
    failureClass: "filesystem",
    failureCode: "EBUSY",
    actual: "open_or_unknown"
  }),
  second_revision_temp_size_validate: Object.freeze({
    failureClass: "integrity",
    failureCode: "SIZE_MISMATCH",
    actual: "mismatch"
  }),
  second_revision_temp_hash_validate: Object.freeze({
    failureClass: "integrity",
    failureCode: "HASH_MISMATCH",
    actual: "mismatch"
  }),
  second_revision_temp_parse: Object.freeze({
    failureClass: "serialization",
    failureCode: "EINVAL",
    actual: "invalid"
  }),
  second_revision_temp_structure_validate: Object.freeze({
    failureClass: "serialization",
    failureCode: "MISMATCH",
    actual: "invalid"
  }),
  second_revision_temp_revision_validate: Object.freeze({
    failureClass: "integrity",
    failureCode: "REVISION_MISMATCH",
    actual: "mismatch"
  }),
  second_revision_temp_run_identity_validate: Object.freeze({
    failureClass: "integrity",
    failureCode: "RUN_IDENTITY_MISMATCH",
    actual: "mismatch"
  }),
  second_revision_temp_unknown_validation_stage: Object.freeze({
    failureClass: "unknown",
    failureCode: "UNKNOWN",
    actual: "unknown"
  }),
  second_revision_previous_ledger_presence_validate: Object.freeze({
    failureClass: "filesystem",
    failureCode: "ENOENT",
    actual: "absent"
  }),
  second_revision_previous_ledger_integrity_validate: Object.freeze({
    failureClass: "integrity",
    failureCode: "HASH_MISMATCH",
    actual: "mismatch"
  })
});

function diagnosticFor(stage, overrides = {}) {
  const fixture = STAGE_CASES[stage];
  return createTempValidationDiagnostic({
    tempValidationStage: stage,
    sanitizedFailureClass: fixture.failureClass,
    sanitizedFailureCode: fixture.failureCode,
    actualConditionClass: fixture.actual,
    previousLedgerPreserved:
      !PREVIOUS_LEDGER_VALIDATION_STAGES.includes(stage),
    temporaryFilePresent: true,
    cleanupAttempted: true,
    cleanupCompleted: true,
    ...overrides
  });
}

function expectInvalid(value) {
  assert.throws(() => validateTempValidationDiagnostic(value), {
    name: "TypeError",
    message: INVALID_DIAGNOSTIC
  });
}

test("the diagnostic exports the exact closed stage and value vocabularies", () => {
  assert.equal(TEMP_FILE_VALIDATION_STAGES.length, 19);
  assert.deepEqual(TEMP_FILE_VALIDATION_STAGES, [
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
  assert.deepEqual(PREVIOUS_LEDGER_VALIDATION_STAGES, [
    "second_revision_previous_ledger_presence_validate",
    "second_revision_previous_ledger_integrity_validate"
  ]);
  assert.deepEqual(TEMP_VALIDATION_STAGES, [
    ...TEMP_FILE_VALIDATION_STAGES,
    ...PREVIOUS_LEDGER_VALIDATION_STAGES
  ]);
  assert.equal(new Set(TEMP_VALIDATION_STAGES).size, 21);
  assert.deepEqual(TEMP_VALIDATION_DIAGNOSTIC_KEYS, [
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
  assert.deepEqual(TEMP_VALIDATION_FAILURE_METADATA_KEYS, [
    "tempValidationStage",
    "sanitizedFailureClass",
    "sanitizedFailureCode",
    "actualConditionClass"
  ]);
  assert.deepEqual(TEMP_VALIDATION_FAILURE_CLASSES, [
    "filesystem",
    "acl",
    "ownership",
    "integrity",
    "serialization",
    "process",
    "harness_validation",
    "unknown"
  ]);
  assert.deepEqual(TEMP_VALIDATION_FAILURE_CODES, [
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
  assert.deepEqual(TEMP_VALIDATION_CONDITION_CLASSES, [
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
  for (const value of [
    TEMP_FILE_VALIDATION_STAGES,
    PREVIOUS_LEDGER_VALIDATION_STAGES,
    TEMP_VALIDATION_STAGES,
    TEMP_VALIDATION_DIAGNOSTIC_KEYS,
    TEMP_VALIDATION_FAILURE_METADATA_KEYS,
    TEMP_VALIDATION_FAILURE_CLASSES,
    TEMP_VALIDATION_FAILURE_CODES,
    TEMP_VALIDATION_CONDITION_CLASSES,
    TEMP_VALIDATION_STAGE_CONTRACT
  ]) {
    assert.equal(Object.isFrozen(value), true);
  }
});

test("failure metadata is exact, frozen and attached without becoming enumerable", () => {
  const metadata = createTempValidationFailureMetadata({
    tempValidationStage: "second_revision_temp_hardlink_validate",
    sanitizedFailureClass: "ownership",
    sanitizedFailureCode: "HARDLINK_COUNT_INVALID",
    actualConditionClass: "invalid",
    path: "C:\\Users\\private\\ledger.json"
  });
  assert.deepEqual(Object.keys(metadata), TEMP_VALIDATION_FAILURE_METADATA_KEYS);
  assert.equal(Object.isFrozen(metadata), true);
  const error = attachTempValidationFailure(
    Object.assign(new Error("private raw material"), { code: "raw" }),
    metadata
  );
  assert.deepEqual(error.tempValidationFailure, metadata);
  assert.equal(
    Object.prototype.propertyIsEnumerable.call(error, "tempValidationFailure"),
    false
  );
  assert.doesNotMatch(JSON.stringify(error), /private|ledger|hardlink/i);
});

test("every temporary and previous-ledger stage produces an exact diagnostic", async (t) => {
  assert.deepEqual(Object.keys(STAGE_CASES), TEMP_VALIDATION_STAGES);
  for (const stage of TEMP_VALIDATION_STAGES) {
    await t.test(stage, () => {
      const diagnostic = diagnosticFor(stage);
      const contract = TEMP_VALIDATION_STAGE_CONTRACT[stage];
      assert.equal(validateTempValidationDiagnostic(diagnostic), true);
      assert.equal(Object.isFrozen(diagnostic), true);
      assert.deepEqual(Object.keys(diagnostic), TEMP_VALIDATION_DIAGNOSTIC_KEYS);
      assert.equal(diagnostic.scenario, "normal_persistence");
      assert.equal(diagnostic.revisionNumber, 2);
      assert.equal(diagnostic.replacementOccurred, false);
      assert.equal(diagnostic.tempValidationStage, stage);
      assert.equal(
        diagnostic.expectedConditionClass,
        contract.expectedConditionClass
      );
      assert.equal(
        contract.actualConditionClasses.includes(
          diagnostic.actualConditionClass
        ),
        true
      );
      assert.equal(
        contract.sanitizedFailureCodes.includes(
          diagnostic.sanitizedFailureCode
        ),
        true
      );
      assert.equal(
        diagnostic.previousLedgerPreserved,
        !PREVIOUS_LEDGER_VALIDATION_STAGES.includes(stage)
      );
      assert.equal(diagnostic.backupPrepared, false);
      assert.equal(diagnostic.rollbackRequired, false);
      assert.deepEqual(
        JSON.parse(serializeTempValidationDiagnostic(diagnostic)),
        diagnostic
      );
    });
  }
});

test("every stage accepts each of its closed actual-condition and failure-code values", () => {
  for (const stage of TEMP_VALIDATION_STAGES) {
    const contract = TEMP_VALIDATION_STAGE_CONTRACT[stage];
    for (const actualConditionClass of contract.actualConditionClasses) {
      const semanticCode = STAGE_CASES[stage].failureCode;
      assert.equal(
        validateTempValidationDiagnostic(
          diagnosticFor(stage, {
            actualConditionClass,
            sanitizedFailureCode:
              actualConditionClass === "unknown" &&
              !COMMON_FAILURE_CODES.includes(semanticCode)
                ? "UNKNOWN"
                : semanticCode
          })
        ),
        true
      );
    }
    for (const sanitizedFailureCode of contract.sanitizedFailureCodes) {
      assert.equal(
        validateTempValidationDiagnostic(
          diagnosticFor(stage, { sanitizedFailureCode })
        ),
        true
      );
    }
  }
  for (const sanitizedFailureClass of TEMP_VALIDATION_FAILURE_CLASSES) {
    assert.equal(
      validateTempValidationDiagnostic(
        diagnosticFor("second_revision_temp_canonicalize", {
          sanitizedFailureClass
        })
      ),
      true
    );
  }
  assert.deepEqual(
    COMMON_FAILURE_CODES,
    [
      "EACCES",
      "EPERM",
      "EBUSY",
      "ENOENT",
      "EEXIST",
      "EINVAL",
      "ENOTEMPTY",
      "UNKNOWN"
    ]
  );
});

test("known but stage-incompatible conditions and semantic codes are refused", () => {
  const acl = diagnosticFor("second_revision_temp_acl_validate");
  expectInvalid({ ...acl, expectedConditionClass: "match" });
  expectInvalid({ ...acl, actualConditionClass: "mismatch" });
  expectInvalid({ ...acl, sanitizedFailureCode: "HASH_MISMATCH" });

  const scope = diagnosticFor("second_revision_temp_scope_validate");
  expectInvalid({ ...scope, actualConditionClass: "invalid" });
  expectInvalid({ ...scope, sanitizedFailureCode: "ACL_INVALID" });

  const previous = diagnosticFor(
    "second_revision_previous_ledger_integrity_validate"
  );
  expectInvalid({ ...previous, actualConditionClass: "absent" });
  expectInvalid({ ...previous, sanitizedFailureCode: "REVISION_MISMATCH" });
  expectInvalid({
    ...previous,
    actualConditionClass: "unknown",
    sanitizedFailureCode: "HASH_MISMATCH"
  });
});

test("inherited stage names cannot bypass the closed validator", () => {
  const valid = diagnosticFor("second_revision_temp_hash_validate");
  Object.defineProperty(Object.prototype, "synthetic_inherited_stage", {
    configurable: true,
    value: TEMP_VALIDATION_STAGE_CONTRACT.second_revision_temp_hash_validate
  });
  try {
    expectInvalid({
      ...valid,
      tempValidationStage: "synthetic_inherited_stage"
    });
  } finally {
    delete Object.prototype.synthetic_inherited_stage;
  }
});

test("unknown stages, classes, codes and conditions cannot enter the public schema", () => {
  const valid = diagnosticFor("second_revision_temp_hash_validate");
  for (const invalid of [
    { ...valid, tempValidationStage: "second_revision_temp_private_path" },
    { ...valid, sanitizedFailureClass: "permission" },
    { ...valid, sanitizedFailureCode: "EIO" },
    { ...valid, expectedConditionClass: "expected_hash_value" },
    { ...valid, actualConditionClass: "C:\\Users\\private\\ledger.json" }
  ]) {
    expectInvalid(invalid);
    assert.throws(() => serializeTempValidationDiagnostic(invalid), {
      message: INVALID_DIAGNOSTIC
    });
  }
});

test("the validator enforces pre-replacement and cleanup invariants", () => {
  const temp = diagnosticFor("second_revision_temp_hash_validate");
  const previous = diagnosticFor(
    "second_revision_previous_ledger_integrity_validate"
  );
  for (const invalid of [
    { ...temp, scenario: "synthetic_fault" },
    { ...temp, revisionNumber: 3 },
    { ...temp, replacementOccurred: true },
    { ...temp, temporaryFilePresent: "true" },
    { ...temp, backupPrepared: true },
    { ...temp, rollbackRequired: true },
    { ...temp, cleanupAttempted: "true" },
    { ...temp, cleanupCompleted: "true" },
    { ...temp, cleanupAttempted: false, cleanupCompleted: true }
  ]) {
    expectInvalid(invalid);
  }
  assert.equal(
    validateTempValidationDiagnostic({
      ...temp,
      previousLedgerPreserved: false
    }),
    true
  );
  assert.equal(
    validateTempValidationDiagnostic({
      ...previous,
      previousLedgerPreserved: true
    }),
    true
  );
});

test("missing, enumerable, hidden, symbol and accessor properties are refused", () => {
  const valid = diagnosticFor("second_revision_temp_hash_validate");

  const missing = { ...valid };
  delete missing.cleanupCompleted;
  expectInvalid(missing);
  expectInvalid({ ...valid, message: "raw" });

  const hidden = { ...valid };
  Object.defineProperty(hidden, "path", {
    enumerable: false,
    value: "C:\\Users\\private\\ledger.json"
  });
  expectInvalid(hidden);

  const symbol = { ...valid };
  symbol[Symbol("raw")] = "secret";
  expectInvalid(symbol);

  const accessor = { ...valid };
  Object.defineProperty(accessor, "scenario", {
    enumerable: true,
    get() {
      return "normal_persistence";
    }
  });
  expectInvalid(accessor);

  expectInvalid(Object.assign(Object.create(null), valid));
  expectInvalid(null);
  expectInvalid([]);
});

test("the factory normalizes untrusted values without leaking raw material", () => {
  const diagnostic = createTempValidationDiagnostic({
    stage: "private-stage C:\\Users\\private\\ledger.json",
    failureClass: "SID S-1-5-21-999",
    failureCode: "HASH=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    actualConditionClass: "private-path",
    expectedConditionClass: "raw-hash",
    scenario: "synthetic_fault",
    revisionNumber: 999,
    replacementOccurred: true,
    backupPrepared: true,
    rollbackRequired: true,
    temporaryFilePresent: false,
    cleanupAttempted: false,
    cleanupCompleted: true,
    message: "token=must-not-escape",
    path: "C:\\Users\\private\\ledger.json",
    hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    sid: "S-1-5-21-999"
  });
  assert.deepEqual(diagnostic, {
    scenario: "normal_persistence",
    revisionNumber: 2,
    replacementOccurred: false,
    tempValidationStage: "second_revision_temp_unknown_validation_stage",
    sanitizedFailureClass: "unknown",
    sanitizedFailureCode: "UNKNOWN",
    expectedConditionClass: "not_applicable",
    actualConditionClass: "unknown",
    previousLedgerPreserved: false,
    temporaryFilePresent: false,
    backupPrepared: false,
    rollbackRequired: false,
    cleanupAttempted: false,
    cleanupCompleted: false
  });
  assert.doesNotMatch(
    serializeTempValidationDiagnostic(diagnostic),
    /Users|private|ledger\.json|S-1-5|token|aaaa|hash|message|path|sid/i
  );
});

test("the factory canonicalizes known codes and preserves no caller-owned object", () => {
  const input = {
    tempValidationStage: "second_revision_temp_hash_validate",
    sanitizedFailureClass: "integrity",
    sanitizedFailureCode: "hash_mismatch",
    actualConditionClass: "mismatch",
    temporaryFilePresent: true,
    cleanupAttempted: true,
    cleanupCompleted: true
  };
  const diagnostic = createTempValidationDiagnostic(input);
  assert.equal(diagnostic.sanitizedFailureCode, "HASH_MISMATCH");
  input.sanitizedFailureCode = "ACL_INVALID";
  input.actualConditionClass = "valid";
  assert.equal(diagnostic.sanitizedFailureCode, "HASH_MISMATCH");
  assert.equal(diagnostic.actualConditionClass, "mismatch");
  assert.equal(validateTempValidationDiagnostic(diagnostic), true);
});
