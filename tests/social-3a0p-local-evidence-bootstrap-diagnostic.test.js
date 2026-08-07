"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  DIAGNOSTIC_KEYS,
  EvidenceBootstrapStageFailure,
  FAILURE_STAGE,
  bootstrapStageFailure,
  createBootstrapDiagnostic,
  serializeBootstrapDiagnostic,
  validateBootstrapDiagnostic
} = require("../scripts/social-3a0p-local-evidence-bootstrap-diagnostic");

const RUN_ID = "11111111-1111-4111-8111-111111111111";

test("bootstrap diagnostic has an exact allowlisted schema and no raw material", () => {
  const raw = Object.assign(
    new Error("C:\\Users\\private\\secret.txt bearer raw-token"),
    {
      code: "harness_process_environment_key_refused",
      stack: "raw-stack C:\\Users\\private"
    }
  );
  const failure = bootstrapStageFailure(
    raw,
    "evidence_parent_validation_failed"
  );
  const diagnostic = createBootstrapDiagnostic({
    failure,
    runId: RUN_ID,
    cleanupAttempted: true,
    cleanupCompleted: true
  });
  assert.deepEqual(Object.keys(diagnostic).sort(), [...DIAGNOSTIC_KEYS].sort());
  assert.equal(diagnostic.event, "evidence_ledger_bootstrap_failure");
  assert.equal(diagnostic.bootstrapStage, "parent_validation");
  assert.equal(
    diagnostic.sanitizedFailureCode,
    "evidence_parent_validation_failed"
  );
  assert.equal(diagnostic.systemErrorClass, "harness_validation");
  assert.equal(diagnostic.systemErrorCode, "UNKNOWN");
  assert.equal(validateBootstrapDiagnostic(diagnostic), true);
  const serialized = serializeBootstrapDiagnostic(diagnostic);
  assert.doesNotMatch(serialized, /Users|private|secret|bearer|raw-token|stack/i);
});

test("every bootstrap stage has a stable allowlisted failure code", () => {
  for (const [failureCode, bootstrapStage] of Object.entries(FAILURE_STAGE)) {
    const diagnostic = createBootstrapDiagnostic({
      failure: new EvidenceBootstrapStageFailure({
        failureCode,
        systemErrorClass: "unknown",
        systemErrorCode: "UNKNOWN"
      }),
      runId: RUN_ID,
      cleanupAttempted: true,
      cleanupCompleted: false
    });
    assert.equal(diagnostic.sanitizedFailureCode, failureCode);
    assert.equal(diagnostic.bootstrapStage, bootstrapStage);
  }
});

test("only allowlisted operating-system codes cross the bootstrap boundary", () => {
  for (const [code, systemErrorClass] of [
    ["EACCES", "permission"],
    ["EPERM", "permission"],
    ["EEXIST", "filesystem"],
    ["ENOENT", "filesystem"],
    ["EINVAL", "path"],
    ["EBUSY", "filesystem"]
  ]) {
    const failure = bootstrapStageFailure(
      Object.assign(new Error("raw must stay private"), { code }),
      "evidence_ledger_first_write_failed"
    );
    assert.equal(failure.systemErrorCode, code);
    assert.equal(failure.systemErrorClass, systemErrorClass);
  }
  const unknown = bootstrapStageFailure(
    Object.assign(new Error("raw"), { code: "ENOSPC_PRIVATE_DETAIL" }),
    "evidence_ledger_first_write_failed"
  );
  assert.equal(unknown.systemErrorCode, "UNKNOWN");
  assert.equal(unknown.systemErrorClass, "unknown");
});

test("diagnostic validation rejects extra keys, mismatched stages and impossible cleanup", () => {
  const valid = createBootstrapDiagnostic({
    failure: new EvidenceBootstrapStageFailure({
      failureCode: "evidence_ledger_flush_failed",
      systemErrorClass: "filesystem",
      systemErrorCode: "EBUSY"
    }),
    runId: RUN_ID,
    cleanupAttempted: true,
    cleanupCompleted: false
  });
  for (const invalid of [
    { ...valid, rawMessage: "private" },
    { ...valid, bootstrapStage: "rename" },
    { ...valid, sanitizedFailureCode: "not_allowlisted" },
    { ...valid, systemErrorCode: "ENOSPC" },
    { ...valid, cleanupAttempted: false, cleanupCompleted: true }
  ]) {
    assert.throws(
      () => validateBootstrapDiagnostic(invalid),
      /evidence_bootstrap_diagnostic_invalid/
    );
  }
});
