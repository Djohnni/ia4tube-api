"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createFileReplaceArgumentDiagnostic,
  serializeFileReplaceArgumentDiagnostic,
  validateFileReplaceArgumentDiagnostic
} = require("../scripts/social-3a0p-local-file-replace-argument-diagnostic");

function diagnostic(backupArgument) {
  return createFileReplaceArgumentDiagnostic({
    backupArgumentBound: true,
    backupArgument,
    replaceOverloadArity: 4,
    ignoreMetadataErrors: true,
    sourceExists: true,
    destinationExists: true,
    sourceAndDestinationSameDirectory: true,
    sourceAndDestinationSameVolume: true
  });
}

test("argument diagnostic distinguishes actual null, empty, whitespace and reference values", () => {
  const actualNull = diagnostic(null);
  assert.equal(actualNull.backupArgumentRuntimeTypeClass, "null");
  assert.equal(actualNull.backupArgumentIsActualNull, true);
  assert.equal(actualNull.backupArgumentLengthClass, "null");

  const empty = diagnostic("");
  assert.equal(empty.backupArgumentRuntimeTypeClass, "string");
  assert.equal(empty.backupArgumentIsEmptyString, true);
  assert.equal(empty.backupArgumentLengthClass, "zero");

  const whitespace = diagnostic(" ");
  assert.equal(whitespace.backupArgumentIsWhitespace, true);
  assert.equal(whitespace.backupArgumentLengthClass, "nonzero");

  const reference = diagnostic({ opaque: true });
  assert.equal(reference.backupArgumentRuntimeTypeClass, "other_reference_type");
  assert.equal(reference.backupArgumentLengthClass, "not_applicable");
});

test("argument diagnostic is exact, fail-closed and contains no argument value", () => {
  const value = diagnostic("SENSITIVE_PATH_CANARY");
  assert.equal(validateFileReplaceArgumentDiagnostic(value), true);
  const serialized = serializeFileReplaceArgumentDiagnostic(value);
  assert.doesNotMatch(serialized, /SENSITIVE_PATH_CANARY|Users|\\\\|\//i);

  assert.throws(
    () => validateFileReplaceArgumentDiagnostic({ ...value, rawValue: "x" }),
    { message: "file_replace_argument_diagnostic_invalid" }
  );
  assert.throws(
    () => validateFileReplaceArgumentDiagnostic({
      ...value,
      backupArgumentIsActualNull: true
    }),
    { message: "file_replace_argument_diagnostic_invalid" }
  );
});
