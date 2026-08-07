"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  DIAGNOSTIC_KEYS,
  FAILURE_STAGE,
  SYSTEM_ERROR_CODES,
  createPersistenceDiagnostic,
  persistenceStageFailure,
  serializePersistenceDiagnostic,
  validatePersistenceDiagnostic
} = require("../scripts/social-3a0p-local-evidence-persistence-diagnostic");

test("persistence diagnostic is exact, closed and contains only sanitized fields", () => {
  const raw = Object.assign(
    new Error("C:\\Users\\private\\ledger.json password=not-for-output"),
    { code: "EACCES", stack: "secret stack" }
  );
  const failure = persistenceStageFailure(
    raw,
    "evidence_second_revision_atomic_replace_failed"
  );
  const diagnostic = createPersistenceDiagnostic({
    failure,
    revisionNumber: 2,
    previousLedgerPreserved: true,
    temporaryFilePresent: true,
    cleanupAttempted: true,
    cleanupCompleted: true
  });
  assert.deepEqual(Object.keys(diagnostic).sort(), [...DIAGNOSTIC_KEYS].sort());
  assert.equal(validatePersistenceDiagnostic(diagnostic), true);
  assert.equal(
    diagnostic.persistenceStage,
    "second_revision_atomic_replace"
  );
  assert.equal(diagnostic.systemErrorClass, "permission");
  assert.equal(diagnostic.systemErrorCode, "EACCES");
  const serialized = serializePersistenceDiagnostic(diagnostic);
  assert.doesNotMatch(serialized, /Users|private|password|stack|ledger\.json/i);
});

test("every persistence stage has one stable code and allowlisted OS metadata", () => {
  assert.equal(Object.keys(FAILURE_STAGE).length, 16);
  assert.deepEqual(
    [...SYSTEM_ERROR_CODES].sort(),
    [
      "EACCES",
      "EBUSY",
      "EEXIST",
      "EINVAL",
      "ENOENT",
      "ENOTEMPTY",
      "EPERM",
      "UNKNOWN"
    ]
  );
  for (const failureCode of Object.keys(FAILURE_STAGE)) {
    const failure = persistenceStageFailure(new Error("raw"), failureCode);
    const diagnostic = createPersistenceDiagnostic({
      failure,
      revisionNumber: 2,
      previousLedgerPreserved: true,
      temporaryFilePresent: false,
      cleanupAttempted: true,
      cleanupCompleted: true
    });
    assert.equal(diagnostic.sanitizedFailureCode, failureCode);
    assert.equal(diagnostic.persistenceStage, FAILURE_STAGE[failureCode]);
    assert.equal(diagnostic.systemErrorCode, "UNKNOWN");
  }
});

test("unknown OS codes collapse to UNKNOWN and extra or inconsistent fields are refused", () => {
  const failure = persistenceStageFailure(
    Object.assign(new Error("raw"), { code: "RAW_WINDOWS_CODE" }),
    "evidence_second_revision_write_failed"
  );
  const diagnostic = createPersistenceDiagnostic({
    failure,
    revisionNumber: 7,
    previousLedgerPreserved: false,
    temporaryFilePresent: false,
    cleanupAttempted: false,
    cleanupCompleted: false
  });
  assert.equal(diagnostic.systemErrorCode, "UNKNOWN");
  assert.throws(
    () => validatePersistenceDiagnostic({ ...diagnostic, rawMessage: "secret" }),
    /evidence_persistence_diagnostic_invalid/
  );
  assert.throws(
    () => validatePersistenceDiagnostic({ ...diagnostic, cleanupCompleted: true }),
    /evidence_persistence_diagnostic_invalid/
  );
  assert.throws(
    () => validatePersistenceDiagnostic({ ...diagnostic, revisionNumber: 1 }),
    /evidence_persistence_diagnostic_invalid/
  );
  assert.throws(
    () => validatePersistenceDiagnostic({
      ...diagnostic,
      rollbackCompleted: true
    }),
    /evidence_persistence_diagnostic_invalid/
  );
  assert.throws(
    () => validatePersistenceDiagnostic({
      ...diagnostic,
      rollbackRequired: true,
      rollbackAttempted: true,
      rollbackCompleted: true,
      previousLedgerRestored: true,
      previousLedgerPreserved: false
    }),
    /evidence_persistence_diagnostic_invalid/
  );
  assert.throws(
    () => validatePersistenceDiagnostic({
      ...diagnostic,
      failedCandidateRemovedAfterRestore: true
    }),
    /evidence_persistence_diagnostic_invalid/
  );
});
