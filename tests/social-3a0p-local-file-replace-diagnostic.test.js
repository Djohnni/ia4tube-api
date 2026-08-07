"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  DIAGNOSTIC_KEYS,
  createFileReplaceExceptionDiagnostic,
  serializeFileReplaceExceptionDiagnostic,
  systemMetadataFromFileReplaceDiagnostic,
  validateFileReplaceExceptionDiagnostic
} = require("../scripts/social-3a0p-local-file-replace-diagnostic");

function exception(type, hresult, innerException = null, extra = {}) {
  return {
    type,
    hresult,
    innerException,
    message: "C:\\Users\\private\\ledger.json token=must-not-escape",
    stack: "private stack",
    sid: "S-1-5-private",
    ...extra
  };
}

function diagnosticFor(root, overrides = {}) {
  return createFileReplaceExceptionDiagnostic({
    exception: root,
    powershellCategory: "InvalidOperation",
    fullyQualifiedErrorId: "MethodInvocationException",
    ...overrides
  });
}

test("MethodInvocationException wrapping IOException exposes only the allowlisted chain", () => {
  const diagnostic = diagnosticFor(
    exception(
      "System.Management.Automation.MethodInvocationException",
      "0x80131501",
      exception("System.IO.IOException", "0x80070020")
    )
  );
  assert.deepEqual(Object.keys(diagnostic).sort(), [...DIAGNOSTIC_KEYS].sort());
  assert.equal(diagnostic.outerExceptionType,
    "System.Management.Automation.MethodInvocationException");
  assert.equal(diagnostic.innerExceptionType1, "System.IO.IOException");
  assert.equal(diagnostic.effectiveExceptionType, "System.IO.IOException");
  assert.equal(diagnostic.effectiveHResult, "0x80070020");
  assert.equal(diagnostic.win32Code, 32);
  assert.equal(diagnostic.win32Symbol, "ERROR_SHARING_VIOLATION");
  assert.deepEqual(systemMetadataFromFileReplaceDiagnostic(diagnostic), {
    systemErrorClass: "filesystem",
    systemErrorCode: "EBUSY"
  });
  const serialized = serializeFileReplaceExceptionDiagnostic(diagnostic);
  assert.doesNotMatch(serialized, /Users|private|ledger|message|stack|sid|token/i);
});

test("two and three InnerException levels are retained and a longer chain is truncated", () => {
  const depthThree = diagnosticFor(
    exception("System.Exception", "0x80131500",
      exception("System.Management.Automation.MethodException", "0x80131501",
        exception("System.Exception", "0x80131500",
          exception("System.IO.IOException", "0x80070057"))))
  );
  assert.equal(depthThree.innerExceptionType1,
    "System.Management.Automation.MethodException");
  assert.equal(depthThree.innerExceptionType2, "System.Exception");
  assert.equal(depthThree.innerExceptionType3, "System.IO.IOException");
  assert.equal(depthThree.chainTruncated, false);
  assert.equal(depthThree.effectiveHResult, "0x80070057");
  assert.equal(depthThree.win32Code, 87);

  const truncated = diagnosticFor(
    exception("System.Exception", "0x80131500",
      exception("System.Exception", "0x80131500",
        exception("System.Exception", "0x80131500",
          exception("System.Exception", "0x80131500",
            exception("System.IO.IOException", "0x80070020")))))
  );
  assert.equal(truncated.chainTruncated, true);
  assert.equal(truncated.effectiveExceptionType, "System.Exception");
  assert.equal(truncated.win32Code, null);
});

test("direct exception types and Win32Exception NativeErrorCode are classified deterministically", () => {
  const unauthorized = diagnosticFor(
    exception("System.UnauthorizedAccessException", "0x80070005")
  );
  assert.equal(unauthorized.win32Code, 5);
  assert.equal(unauthorized.win32Symbol, "ERROR_ACCESS_DENIED");
  assert.deepEqual(systemMetadataFromFileReplaceDiagnostic(unauthorized), {
    systemErrorClass: "permission",
    systemErrorCode: "EACCES"
  });

  const platform = diagnosticFor(
    exception("System.PlatformNotSupportedException", "0x80131539")
  );
  assert.equal(platform.innerExceptionType1, null);
  assert.equal(platform.win32Code, null);
  assert.deepEqual(systemMetadataFromFileReplaceDiagnostic(platform), {
    systemErrorClass: "platform",
    systemErrorCode: "UNKNOWN"
  });

  const win32 = diagnosticFor(
    exception(
      "System.ComponentModel.Win32Exception",
      "0x80004005",
      null,
      { nativeErrorCode: 5 }
    )
  );
  assert.equal(win32.nativeErrorCode, 5);
  assert.equal(win32.win32Code, 5);
  assert.equal(win32.win32Symbol, "ERROR_ACCESS_DENIED");
});

test("recognized replacement HRESULTs and non-Win32 HRESULTs never use low words indiscriminately", () => {
  const cases = [
    ["0x80070497", 1175, "ERROR_UNABLE_TO_REMOVE_REPLACED"],
    ["0x80070498", 1176, "ERROR_UNABLE_TO_MOVE_REPLACEMENT"],
    ["0x80070499", 1177, "ERROR_UNABLE_TO_MOVE_REPLACEMENT_2"]
  ];
  for (const [hresult, code, symbol] of cases) {
    const value = diagnosticFor(exception("System.IO.IOException", hresult));
    assert.equal(value.win32Code, code);
    assert.equal(value.win32Symbol, symbol);
  }
  const nonWin32 = diagnosticFor(
    exception("System.IO.IOException", "0x80130020")
  );
  assert.equal(nonWin32.win32Code, null);
  assert.equal(nonWin32.win32Symbol, null);
});

test("unknown types and unrecognized Win32 codes collapse without disclosing raw values", () => {
  const unknownType = diagnosticFor(
    exception("Vendor.Secret.PathException", "0x80131500"),
    {
      powershellCategory: "C:\\private\\category",
      fullyQualifiedErrorId: "token=private"
    }
  );
  assert.equal(unknownType.outerExceptionType, "other_exception_type");
  assert.equal(unknownType.powershellCategory, "other_error_category");
  assert.equal(unknownType.fullyQualifiedErrorId, "other_error_id");

  const otherWin32 = diagnosticFor(
    exception("System.IO.IOException", "0x80071234")
  );
  assert.equal(otherWin32.win32Code, "win32_other");
  assert.equal(otherWin32.win32Symbol, "win32_other");
  assert.equal(validateFileReplaceExceptionDiagnostic(otherWin32), true);
  assert.throws(
    () => validateFileReplaceExceptionDiagnostic({ ...otherWin32, Message: "raw" }),
    /file_replace_exception_diagnostic_invalid/
  );
});
