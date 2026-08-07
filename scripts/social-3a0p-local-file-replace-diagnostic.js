"use strict";

const EXCEPTION_TYPES = new Set([
  "System.Management.Automation.MethodInvocationException",
  "System.Management.Automation.MethodException",
  "System.IO.IOException",
  "System.UnauthorizedAccessException",
  "System.ArgumentException",
  "System.ArgumentNullException",
  "System.NotSupportedException",
  "System.PlatformNotSupportedException",
  "System.Security.SecurityException",
  "System.ComponentModel.Win32Exception",
  "System.Exception",
  "other_exception_type",
  "unknown"
]);

const WIN32_SYMBOLS = new Map([
  [2, "ERROR_FILE_NOT_FOUND"],
  [3, "ERROR_PATH_NOT_FOUND"],
  [5, "ERROR_ACCESS_DENIED"],
  [17, "ERROR_NOT_SAME_DEVICE"],
  [32, "ERROR_SHARING_VIOLATION"],
  [80, "ERROR_FILE_EXISTS"],
  [87, "ERROR_INVALID_PARAMETER"],
  [183, "ERROR_ALREADY_EXISTS"],
  [1175, "ERROR_UNABLE_TO_REMOVE_REPLACED"],
  [1176, "ERROR_UNABLE_TO_MOVE_REPLACEMENT"],
  [1177, "ERROR_UNABLE_TO_MOVE_REPLACEMENT_2"]
]);

const POWERSHELL_CATEGORIES = new Set([
  "NotSpecified",
  "OpenError",
  "CloseError",
  "DeviceError",
  "DeadlockDetected",
  "InvalidArgument",
  "InvalidData",
  "InvalidOperation",
  "InvalidResult",
  "InvalidType",
  "MetadataError",
  "NotImplemented",
  "NotInstalled",
  "ObjectNotFound",
  "OperationStopped",
  "OperationTimeout",
  "SyntaxError",
  "ParserError",
  "PermissionDenied",
  "ResourceBusy",
  "ResourceExists",
  "ResourceUnavailable",
  "ReadError",
  "WriteError",
  "FromStdErr",
  "SecurityError",
  "ProtocolError",
  "ConnectionError",
  "AuthenticationError",
  "LimitsExceeded",
  "QuotaExceeded",
  "NotEnabled",
  "other_error_category"
]);

const HRESULT = /^0x[0-9A-F]{8}$/;
const SAFE_ERROR_IDS = new Set([
  "ArgumentException",
  "ArgumentNullException",
  "IOException",
  "MethodException",
  "MethodInvocationException",
  "NotSupportedException",
  "PlatformNotSupportedException",
  "SecurityException",
  "TargetInvocationException",
  "UnauthorizedAccessException",
  "Win32Exception",
  "other_error_id"
]);
const DIAGNOSTIC_KEYS = Object.freeze([
  "event",
  "outerExceptionType",
  "outerHResult",
  "innerExceptionType1",
  "innerHResult1",
  "innerExceptionType2",
  "innerHResult2",
  "innerExceptionType3",
  "innerHResult3",
  "chainTruncated",
  "effectiveExceptionType",
  "effectiveHResult",
  "nativeErrorCode",
  "win32Code",
  "win32Symbol",
  "powershellCategory",
  "fullyQualifiedErrorId"
]);

const POWERSHELL_DIAGNOSTIC_FUNCTIONS = [
  "function Get-IA4SafeExceptionType([Exception]$x){",
  "if($null-eq$x){return $null};$n=$x.GetType().FullName;",
  "$a=@('System.Management.Automation.MethodInvocationException','System.Management.Automation.MethodException','System.IO.IOException','System.UnauthorizedAccessException','System.ArgumentException','System.ArgumentNullException','System.NotSupportedException','System.PlatformNotSupportedException','System.Security.SecurityException','System.ComponentModel.Win32Exception','System.Exception');",
  "if($a-contains$n){return $n};return 'other_exception_type'};",
  "function Get-IA4SafeHResult([Exception]$x){",
  "if($null-eq$x){return $null};$b=[BitConverter]::GetBytes([int]$x.HResult);$u=[BitConverter]::ToUInt32($b,0);return ('0x{0:X8}'-f$u)};",
  "function Get-IA4Win32Evidence([Exception]$x,[string]$h){",
  "$c=$null;$native=$false;if($x-is[ComponentModel.Win32Exception]){$c=[int]$x.NativeErrorCode;$native=$true}",
  "elseif($h-match'^0x[0-9A-F]{8}$'){$u=[Convert]::ToUInt32($h.Substring(2),16);$mask=[Convert]::ToUInt32('FFFF0000',16);$facility=[Convert]::ToUInt32('80070000',16);if((($u-band$mask)-eq$facility)){$c=[int]($u-band0xffff)}};",
  "if($null-eq$c){return [ordered]@{nativeErrorCode=$null;win32Code=$null;win32Symbol=$null}};",
  "$m=@{2='ERROR_FILE_NOT_FOUND';3='ERROR_PATH_NOT_FOUND';5='ERROR_ACCESS_DENIED';17='ERROR_NOT_SAME_DEVICE';32='ERROR_SHARING_VIOLATION';80='ERROR_FILE_EXISTS';87='ERROR_INVALID_PARAMETER';183='ERROR_ALREADY_EXISTS';1175='ERROR_UNABLE_TO_REMOVE_REPLACED';1176='ERROR_UNABLE_TO_MOVE_REPLACEMENT';1177='ERROR_UNABLE_TO_MOVE_REPLACEMENT_2'};",
  "if($m.ContainsKey($c)){return [ordered]@{nativeErrorCode=$(if($native){$c}else{$null});win32Code=$c;win32Symbol=$m[$c]}};",
  "return [ordered]@{nativeErrorCode=$(if($native){'win32_other'}else{$null});win32Code='win32_other';win32Symbol='win32_other'}};",
  "function Get-IA4SafeCategory($r){$v=[string]$r.CategoryInfo.Category;$a=@('NotSpecified','OpenError','CloseError','DeviceError','DeadlockDetected','InvalidArgument','InvalidData','InvalidOperation','InvalidResult','InvalidType','MetadataError','NotImplemented','NotInstalled','ObjectNotFound','OperationStopped','OperationTimeout','SyntaxError','ParserError','PermissionDenied','ResourceBusy','ResourceExists','ResourceUnavailable','ReadError','WriteError','FromStdErr','SecurityError','ProtocolError','ConnectionError','AuthenticationError','LimitsExceeded','QuotaExceeded','NotEnabled');if($a-contains$v){return $v};return 'other_error_category'};",
  "function Get-IA4SafeErrorId($r){$v=[string]$r.FullyQualifiedErrorId;$a=@('ArgumentException','ArgumentNullException','IOException','MethodException','MethodInvocationException','NotSupportedException','PlatformNotSupportedException','SecurityException','TargetInvocationException','UnauthorizedAccessException','Win32Exception');if($a-contains$v){return $v};return 'other_error_id'};",
  "function New-IA4FileReplaceDiagnostic($r){",
  "$items=@();$current=$r.Exception;for($i=0;$i-lt4-and$null-ne$current;$i++){$items+=,[pscustomobject]@{type=(Get-IA4SafeExceptionType $current);hresult=(Get-IA4SafeHResult $current);exception=$current};$current=$current.InnerException};",
  "if($items.Count-eq0){$items+=,[pscustomobject]@{type='unknown';hresult=$null;exception=$null}};",
  "$effective=$items[$items.Count-1];$w=Get-IA4Win32Evidence $effective.exception $effective.hresult;",
  "return [ordered]@{event='evidence_file_replace_exception';outerExceptionType=$items[0].type;outerHResult=$items[0].hresult;innerExceptionType1=$(if($items.Count-gt1){$items[1].type}else{$null});innerHResult1=$(if($items.Count-gt1){$items[1].hresult}else{$null});innerExceptionType2=$(if($items.Count-gt2){$items[2].type}else{$null});innerHResult2=$(if($items.Count-gt2){$items[2].hresult}else{$null});innerExceptionType3=$(if($items.Count-gt3){$items[3].type}else{$null});innerHResult3=$(if($items.Count-gt3){$items[3].hresult}else{$null});chainTruncated=($null-ne$current);effectiveExceptionType=$effective.type;effectiveHResult=$effective.hresult;nativeErrorCode=$w.nativeErrorCode;win32Code=$w.win32Code;win32Symbol=$w.win32Symbol;powershellCategory=(Get-IA4SafeCategory $r);fullyQualifiedErrorId=(Get-IA4SafeErrorId $r)}};"
].join("");

function normalizedExceptionType(value) {
  const candidate = String(value || "unknown");
  return EXCEPTION_TYPES.has(candidate) ? candidate : "other_exception_type";
}

function normalizedHResult(value) {
  if (typeof value === "string" && HRESULT.test(value)) return value;
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  return `0x${(value >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
}

function normalizedCategory(value) {
  const candidate = String(value || "");
  return POWERSHELL_CATEGORIES.has(candidate)
    ? candidate
    : "other_error_category";
}

function normalizedErrorId(value) {
  const candidate = String(value || "");
  return SAFE_ERROR_IDS.has(candidate) ? candidate : "other_error_id";
}

function win32Evidence(code) {
  if (!Number.isInteger(code) || code < 0) {
    return { win32Code: null, win32Symbol: null };
  }
  const symbol = WIN32_SYMBOLS.get(code);
  return symbol
    ? { win32Code: code, win32Symbol: symbol }
    : { win32Code: "win32_other", win32Symbol: "win32_other" };
}

function win32FromHResult(value) {
  if (!HRESULT.test(String(value || ""))) {
    return { win32Code: null, win32Symbol: null };
  }
  const unsigned = Number.parseInt(value.slice(2), 16) >>> 0;
  if (((unsigned & 0xffff0000) >>> 0) !== 0x80070000) {
    return { win32Code: null, win32Symbol: null };
  }
  return win32Evidence(unsigned & 0xffff);
}

function exceptionRecord(value) {
  if (!value || typeof value !== "object") return null;
  return {
    type: normalizedExceptionType(value.type || value.name),
    hresult: normalizedHResult(value.hresult),
    innerException: value.innerException || null,
    nativeErrorCode: Number.isInteger(value.nativeErrorCode)
      ? value.nativeErrorCode
      : null
  };
}

function createFileReplaceExceptionDiagnostic({
  exception,
  powershellCategory,
  fullyQualifiedErrorId
}) {
  const records = [];
  let current = exception;
  for (let index = 0; index < 4 && current; index += 1) {
    const record = exceptionRecord(current);
    if (!record) break;
    records.push(record);
    current = record.innerException;
  }
  if (records.length === 0) {
    records.push({
      type: "unknown",
      hresult: null,
      innerException: null,
      nativeErrorCode: null
    });
  }
  const effective = records.at(-1);
  const nativeErrorCode =
    effective.type === "System.ComponentModel.Win32Exception" &&
    Number.isInteger(effective.nativeErrorCode)
      ? win32Evidence(effective.nativeErrorCode).win32Code
      : null;
  const win32 = nativeErrorCode !== null
    ? {
        win32Code: nativeErrorCode,
        win32Symbol: nativeErrorCode === "win32_other"
          ? "win32_other"
          : WIN32_SYMBOLS.get(nativeErrorCode)
      }
    : win32FromHResult(effective.hresult);
  const diagnostic = {
    event: "evidence_file_replace_exception",
    outerExceptionType: records[0].type,
    outerHResult: records[0].hresult,
    innerExceptionType1: records[1]?.type || null,
    innerHResult1: records[1]?.hresult || null,
    innerExceptionType2: records[2]?.type || null,
    innerHResult2: records[2]?.hresult || null,
    innerExceptionType3: records[3]?.type || null,
    innerHResult3: records[3]?.hresult || null,
    chainTruncated: current !== null && current !== undefined,
    effectiveExceptionType: effective.type,
    effectiveHResult: effective.hresult,
    nativeErrorCode,
    win32Code: win32.win32Code,
    win32Symbol: win32.win32Symbol,
    powershellCategory: normalizedCategory(powershellCategory),
    fullyQualifiedErrorId: normalizedErrorId(fullyQualifiedErrorId)
  };
  validateFileReplaceExceptionDiagnostic(diagnostic);
  return Object.freeze(diagnostic);
}

function validateFileReplaceExceptionDiagnostic(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError("file_replace_exception_diagnostic_invalid");
  }
  const keys = Object.keys(value).sort();
  const expected = [...DIAGNOSTIC_KEYS].sort();
  const typeFields = [
    value.outerExceptionType,
    value.innerExceptionType1,
    value.innerExceptionType2,
    value.innerExceptionType3,
    value.effectiveExceptionType
  ];
  const hresultFields = [
    value.outerHResult,
    value.innerHResult1,
    value.innerHResult2,
    value.innerHResult3,
    value.effectiveHResult
  ];
  const validWin32Code =
    value.win32Code === null ||
    value.win32Code === "win32_other" ||
    WIN32_SYMBOLS.has(value.win32Code);
  const validNative =
    value.nativeErrorCode === null ||
    value.nativeErrorCode === "win32_other" ||
    WIN32_SYMBOLS.has(value.nativeErrorCode);
  const expectedSymbol = value.win32Code === null
    ? null
    : value.win32Code === "win32_other"
      ? "win32_other"
      : WIN32_SYMBOLS.get(value.win32Code);
  const chainShapeValid =
    (value.innerExceptionType1 !== null ||
      (value.innerHResult1 === null &&
        value.innerExceptionType2 === null &&
        value.innerHResult2 === null &&
        value.innerExceptionType3 === null &&
        value.innerHResult3 === null)) &&
    (value.innerExceptionType2 !== null ||
      (value.innerHResult2 === null &&
        value.innerExceptionType3 === null &&
        value.innerHResult3 === null)) &&
    (value.innerExceptionType3 !== null || value.innerHResult3 === null);
  const deepestType =
    value.innerExceptionType3 ||
    value.innerExceptionType2 ||
    value.innerExceptionType1 ||
    value.outerExceptionType;
  const deepestHResult =
    value.innerExceptionType3 !== null
      ? value.innerHResult3
      : value.innerExceptionType2 !== null
        ? value.innerHResult2
        : value.innerExceptionType1 !== null
          ? value.innerHResult1
          : value.outerHResult;
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index]) ||
    value.event !== "evidence_file_replace_exception" ||
    !EXCEPTION_TYPES.has(value.outerExceptionType) ||
    typeFields.some((item) => item !== null && !EXCEPTION_TYPES.has(item)) ||
    hresultFields.some((item) => item !== null && !HRESULT.test(item)) ||
    typeof value.chainTruncated !== "boolean" ||
    !chainShapeValid ||
    value.effectiveExceptionType !== deepestType ||
    value.effectiveHResult !== deepestHResult ||
    !validNative ||
    (value.effectiveExceptionType !== "System.ComponentModel.Win32Exception" &&
      value.nativeErrorCode !== null) ||
    !validWin32Code ||
    value.win32Symbol !== expectedSymbol ||
    !POWERSHELL_CATEGORIES.has(value.powershellCategory) ||
    !SAFE_ERROR_IDS.has(value.fullyQualifiedErrorId)
  ) {
    throw new TypeError("file_replace_exception_diagnostic_invalid");
  }
  return true;
}

function systemMetadataFromFileReplaceDiagnostic(value) {
  validateFileReplaceExceptionDiagnostic(value);
  const win32Map = new Map([
    [2, { systemErrorClass: "filesystem", systemErrorCode: "ENOENT" }],
    [3, { systemErrorClass: "filesystem", systemErrorCode: "ENOENT" }],
    [5, { systemErrorClass: "permission", systemErrorCode: "EACCES" }],
    [17, { systemErrorClass: "filesystem", systemErrorCode: "UNKNOWN" }],
    [32, { systemErrorClass: "filesystem", systemErrorCode: "EBUSY" }],
    [80, { systemErrorClass: "filesystem", systemErrorCode: "EEXIST" }],
    [87, { systemErrorClass: "path", systemErrorCode: "EINVAL" }],
    [183, { systemErrorClass: "filesystem", systemErrorCode: "EEXIST" }],
    [1175, { systemErrorClass: "filesystem", systemErrorCode: "UNKNOWN" }],
    [1176, { systemErrorClass: "filesystem", systemErrorCode: "UNKNOWN" }],
    [1177, { systemErrorClass: "filesystem", systemErrorCode: "UNKNOWN" }]
  ]);
  if (typeof value.win32Code === "number") return win32Map.get(value.win32Code);
  if (value.win32Code === "win32_other") {
    return { systemErrorClass: "filesystem", systemErrorCode: "UNKNOWN" };
  }
  if (value.effectiveExceptionType === "System.UnauthorizedAccessException") {
    return { systemErrorClass: "permission", systemErrorCode: "EACCES" };
  }
  if (value.effectiveExceptionType === "System.Security.SecurityException") {
    return { systemErrorClass: "permission", systemErrorCode: "EPERM" };
  }
  if (
    value.effectiveExceptionType === "System.ArgumentException" ||
    value.effectiveExceptionType === "System.ArgumentNullException"
  ) {
    return { systemErrorClass: "path", systemErrorCode: "EINVAL" };
  }
  if (
    value.effectiveExceptionType === "System.NotSupportedException" ||
    value.effectiveExceptionType === "System.PlatformNotSupportedException"
  ) {
    return { systemErrorClass: "platform", systemErrorCode: "UNKNOWN" };
  }
  if (
    value.effectiveExceptionType === "System.IO.IOException" ||
    value.effectiveExceptionType === "System.ComponentModel.Win32Exception"
  ) {
    return { systemErrorClass: "filesystem", systemErrorCode: "UNKNOWN" };
  }
  return { systemErrorClass: "unknown", systemErrorCode: "UNKNOWN" };
}

function serializeFileReplaceExceptionDiagnostic(value) {
  validateFileReplaceExceptionDiagnostic(value);
  return JSON.stringify(value);
}

module.exports = {
  DIAGNOSTIC_KEYS,
  EXCEPTION_TYPES,
  POWERSHELL_DIAGNOSTIC_FUNCTIONS,
  POWERSHELL_CATEGORIES,
  WIN32_SYMBOLS,
  createFileReplaceExceptionDiagnostic,
  serializeFileReplaceExceptionDiagnostic,
  systemMetadataFromFileReplaceDiagnostic,
  validateFileReplaceExceptionDiagnostic
};
