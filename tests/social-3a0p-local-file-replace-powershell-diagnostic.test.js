"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const {
  DIAGNOSTIC_KEYS,
  POWERSHELL_DIAGNOSTIC_FUNCTIONS,
  validateFileReplaceExceptionDiagnostic
} = require("../scripts/social-3a0p-local-file-replace-diagnostic");

const PROTOCOL_VERSION = "IA4REC1";
const PROTOCOL_ERROR = "powershell_closed_transport_protocol_invalid";
const EXCEPTION_DIAGNOSTIC_FIELDS = Object.freeze([
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
const EXCEPTION_RECORDS = Object.freeze([
  "exception1",
  "exception2",
  "exception3"
]);
const EXCEPTION_LAYOUT = Object.freeze(EXCEPTION_RECORDS.flatMap((record) =>
  EXCEPTION_DIAGNOSTIC_FIELDS.map((field) => Object.freeze({ record, field }))
));
const STRING_PAYLOAD = /^[A-Za-z0-9_.:-]+$/;
const INTEGER_PAYLOAD = /^(?:0|-?[1-9][0-9]*)$/;
const FORBIDDEN_PROTOCOL_CONTENT = Object.freeze([
  /SENSITIVE_CANARY/i,
  /Message/i,
  /Stack/i,
  /Users/i,
  /SID/i,
  /password/i,
  /passwd/i,
  /token/i,
  /secret/i,
  /credential/i,
  /Authorization/i,
  /Bearer/i,
  /postgres(?:ql)?:\/\//i,
  /S-[0-9]+(?:-[0-9]+)+/i,
  /(?:^|[|\n])(?:[A-Za-z]:|\\\\)/,
  /[\\/](?:Users|home)[\\/]/i
]);

function protocolFailure() {
  throw new Error(PROTOCOL_ERROR);
}

function decodeScalar(type, payload) {
  if (type === "null") {
    if (payload !== "") protocolFailure();
    return null;
  }
  if (type === "bool") {
    if (payload !== "true" && payload !== "false") protocolFailure();
    return payload === "true";
  }
  if (type === "int") {
    if (!INTEGER_PAYLOAD.test(payload)) protocolFailure();
    const value = Number(payload);
    if (!Number.isSafeInteger(value)) protocolFailure();
    return value;
  }
  if (type === "string") {
    if (!STRING_PAYLOAD.test(payload)) protocolFailure();
    return payload;
  }
  protocolFailure();
}

function parseExceptionClosedTransport(input) {
  if (typeof input !== "string" || input.length === 0) protocolFailure();
  if (/[^\x0A\x0D\x20-\x7E]/.test(input)) protocolFailure();
  if (FORBIDDEN_PROTOCOL_CONTENT.some((pattern) => pattern.test(input))) {
    protocolFailure();
  }
  let normalized = input.replace(/\r\n/g, "\n");
  if (normalized.includes("\r")) protocolFailure();
  if (normalized.endsWith("\n")) {
    normalized = normalized.slice(0, -1);
    if (normalized.endsWith("\n")) protocolFailure();
  }
  const lines = normalized.split("\n");
  if (
    lines.length !== EXCEPTION_LAYOUT.length ||
    lines.some((line) => line.length === 0)
  ) {
    protocolFailure();
  }
  const values = Object.fromEntries(EXCEPTION_RECORDS.map((record) => [record, {}]));
  const seen = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    const parts = lines[index].split("|");
    if (parts.length !== 5) protocolFailure();
    const [version, record, field, type, payload] = parts;
    const expected = EXCEPTION_LAYOUT[index];
    if (
      version !== PROTOCOL_VERSION ||
      record !== expected.record ||
      field !== expected.field ||
      !EXCEPTION_RECORDS.includes(record) ||
      !EXCEPTION_DIAGNOSTIC_FIELDS.includes(field)
    ) {
      protocolFailure();
    }
    const pair = `${record}\u0000${field}`;
    if (seen.has(pair) || Object.hasOwn(values[record], field)) protocolFailure();
    seen.add(pair);
    values[record][field] = decodeScalar(type, payload);
  }
  if (seen.size !== EXCEPTION_LAYOUT.length) protocolFailure();
  return Object.freeze({ lineCount: lines.length, values });
}

function encodeScalar(value) {
  if (value === null) return ["null", ""];
  if (typeof value === "boolean") return ["bool", String(value)];
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return ["int", String(value)];
  }
  if (typeof value === "string" && STRING_PAYLOAD.test(value)) {
    return ["string", value];
  }
  protocolFailure();
}

function encodeExceptionFixture(records) {
  return EXCEPTION_LAYOUT.map(({ record, field }) => {
    const [type, payload] = encodeScalar(records[record][field]);
    return `${PROTOCOL_VERSION}|${record}|${field}|${type}|${payload}`;
  }).join("\n");
}

function powerShellArray(values) {
  return `@(${values.map((value) => `'${value}'`).join(",")})`;
}

const POWERSHELL_CLOSED_TRANSPORT_FUNCTION = [
  "function Write-IA4ClosedRecord($record,$field,$value){",
  `$records=${powerShellArray(EXCEPTION_RECORDS)};`,
  `$fields=${powerShellArray(EXCEPTION_DIAGNOSTIC_FIELDS)};`,
  "if(-not ($records -ccontains [string]$record)){throw 'closed_transport_record_invalid'};",
  "if(-not ($fields -ccontains [string]$field)){throw 'closed_transport_field_invalid'};",
  "$type='';$payload='';",
  "if($null-eq$value){$type='null';$payload=''}",
  "elseif($value-is[bool]){$type='bool';$payload=$(if($value){'true'}else{'false'})}",
  "elseif($value-is[int]){$type='int';$payload=([int]$value).ToString([Globalization.CultureInfo]::InvariantCulture);if($payload-cnotmatch'^(?:0|-?[1-9][0-9]*)$'){throw 'closed_transport_int_invalid'}}",
  "elseif($value-is[string]){$type='string';$payload=[string]$value;if($payload-cnotmatch'^[A-Za-z0-9_.:-]+$'){throw 'closed_transport_string_invalid'}}",
  "else{throw 'closed_transport_type_invalid'};",
  "$forbidden=@('SENSITIVE_CANARY','Message','Stack','Users','SID','password','passwd','token','secret','credential','Authorization','Bearer');",
  "foreach($item in $forbidden){if($payload.IndexOf($item,[StringComparison]::OrdinalIgnoreCase)-ge0){throw 'closed_transport_payload_forbidden'}};",
  "if($payload-match'S-[0-9]+(?:-[0-9]+)+'){throw 'closed_transport_payload_forbidden'};",
  "if($payload-cmatch'^[A-Za-z]:'){throw 'closed_transport_payload_forbidden'};",
  "if($payload-cmatch'postgres(?:ql)?://'){throw 'closed_transport_payload_forbidden'};",
  "[Console]::Out.WriteLine('IA4REC1|'+$record+'|'+$field+'|'+$type+'|'+$payload)",
  "};"
].join("\n");

function powerShellEmission(record, variable) {
  return EXCEPTION_DIAGNOSTIC_FIELDS.map((field) =>
    `Write-IA4ClosedRecord '${record}' '${field}' $${variable}.${field};`
  ).join("\n");
}

function runExceptionPowerShell(powershell, system32, script, environment) {
  let result;
  try {
    result = spawnSync(
      powershell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      {
        cwd: system32,
        encoding: "utf8",
        timeout: 20_000,
        windowsHide: true,
        shell: false,
        env: environment
      }
    );
  } catch {
    throw new Error("powershell_closed_transport_spawn_failed");
  }
  if (result?.error?.code === "ETIMEDOUT") {
    throw new Error("powershell_closed_transport_timeout");
  }
  if (result?.error) throw new Error("powershell_closed_transport_spawn_failed");
  if (result?.signal !== null) {
    throw new Error("powershell_closed_transport_signal_refused");
  }
  if (!Number.isInteger(result?.status)) {
    throw new Error("powershell_closed_transport_status_missing");
  }
  if (result.status !== 0) {
    throw new Error("powershell_closed_transport_process_failed");
  }
  if (result.stderr !== "") {
    throw new Error("powershell_closed_transport_stderr_refused");
  }
  try {
    return parseExceptionClosedTransport(result.stdout);
  } catch {
    throw new Error(PROTOCOL_ERROR);
  }
}

const EXCEPTION_FIXTURE = Object.freeze({
  exception1: Object.freeze({
    event: "evidence_file_replace_exception",
    outerExceptionType: "System.Management.Automation.MethodInvocationException",
    outerHResult: "0x80131501",
    innerExceptionType1: "System.IO.IOException",
    innerHResult1: "0x80131620",
    innerExceptionType2: null,
    innerHResult2: null,
    innerExceptionType3: null,
    innerHResult3: null,
    chainTruncated: false,
    effectiveExceptionType: "System.IO.IOException",
    effectiveHResult: "0x80131620",
    nativeErrorCode: null,
    win32Code: null,
    win32Symbol: null,
    powershellCategory: "InvalidOperation",
    fullyQualifiedErrorId: "MethodInvocationException"
  }),
  exception2: Object.freeze({
    event: "evidence_file_replace_exception",
    outerExceptionType: "System.Exception",
    outerHResult: "0x80131500",
    innerExceptionType1: "System.Exception",
    innerHResult1: "0x80131500",
    innerExceptionType2: "System.Exception",
    innerHResult2: "0x80131500",
    innerExceptionType3: "System.Exception",
    innerHResult3: "0x80131500",
    chainTruncated: true,
    effectiveExceptionType: "System.Exception",
    effectiveHResult: "0x80131500",
    nativeErrorCode: null,
    win32Code: null,
    win32Symbol: null,
    powershellCategory: "NotSpecified",
    fullyQualifiedErrorId: "other_error_id"
  }),
  exception3: Object.freeze({
    event: "evidence_file_replace_exception",
    outerExceptionType: "System.ComponentModel.Win32Exception",
    outerHResult: "0x80004005",
    innerExceptionType1: null,
    innerHResult1: null,
    innerExceptionType2: null,
    innerHResult2: null,
    innerExceptionType3: null,
    innerHResult3: null,
    chainTruncated: false,
    effectiveExceptionType: "System.ComponentModel.Win32Exception",
    effectiveHResult: "0x80004005",
    nativeErrorCode: 32,
    win32Code: 32,
    win32Symbol: "ERROR_SHARING_VIOLATION",
    powershellCategory: "ResourceBusy",
    fullyQualifiedErrorId: "other_error_id"
  })
});

test("the IA4REC1 exception parser accepts only the closed canonical frame", async (t) => {
  assert.deepEqual(DIAGNOSTIC_KEYS, EXCEPTION_DIAGNOSTIC_FIELDS);
  const valid = encodeExceptionFixture(EXCEPTION_FIXTURE);
  for (const transport of [
    valid,
    `${valid}\n`,
    valid.replace(/\n/g, "\r\n"),
    `${valid.replace(/\n/g, "\r\n")}\r\n`
  ]) {
    const parsed = parseExceptionClosedTransport(transport);
    assert.equal(parsed.lineCount, 51);
    for (const record of EXCEPTION_RECORDS) {
      assert.equal(validateFileReplaceExceptionDiagnostic(parsed.values[record]), true);
    }
  }

  const lines = valid.split("\n");
  const boolIndex = lines.findIndex((line) => line.includes("|bool|"));
  const intIndex = lines.findIndex((line) => line.includes("|int|"));
  const stringIndex = lines.findIndex((line) => line.includes("|string|"));
  const nullIndex = lines.findIndex((line) => line.endsWith("|null|"));
  const replaceAt = (index, value) => lines.with(index, value).join("\n");
  const cases = [
    ["non-string input", null],
    ["wrong version", lines.with(0, lines[0].replace("IA4REC1", "IA4REC2")).join("\n")],
    ["wrong version casing", lines.with(0, lines[0].replace("IA4REC1", "ia4rec1")).join("\n")],
    ["unknown record", lines.with(0, lines[0].replace("|exception1|", "|unknown|" )).join("\n")],
    ["record casing", lines.with(0, lines[0].replace("|exception1|", "|Exception1|" )).join("\n")],
    ["unknown field", lines.with(0, lines[0].replace("|event|", "|unknownField|" )).join("\n")],
    ["field casing", lines.with(0, lines[0].replace("|event|", "|Event|" )).join("\n")],
    ["unknown type", replaceAt(boolIndex, lines[boolIndex].replace("|bool|", "|float|"))],
    ["invalid bool", replaceAt(boolIndex, lines[boolIndex].replace(/\|bool\|[^|]+$/, "|bool|TRUE"))],
    ["positive integer sign", replaceAt(intIndex, lines[intIndex].replace(/\|int\|[^|]+$/, "|int|+32"))],
    ["integer leading zero", replaceAt(intIndex, lines[intIndex].replace(/\|int\|[^|]+$/, "|int|032"))],
    ["negative zero", replaceAt(intIndex, lines[intIndex].replace(/\|int\|[^|]+$/, "|int|-0"))],
    ["unsafe integer", replaceAt(intIndex, lines[intIndex].replace(/\|int\|[^|]+$/, "|int|9007199254740992"))],
    ["empty string", replaceAt(stringIndex, lines[stringIndex].replace(/\|string\|[^|]+$/, "|string|"))],
    ["string with space", replaceAt(stringIndex, lines[stringIndex].replace(/\|string\|[^|]+$/, "|string|not safe"))],
    ["string with pipe", replaceAt(stringIndex, lines[stringIndex].replace(/\|string\|[^|]+$/, "|string|not|safe"))],
    ["string with CR", replaceAt(stringIndex, lines[stringIndex].replace(/\|string\|[^|]+$/, "|string|not\rsafe"))],
    ["string with LF", replaceAt(stringIndex, lines[stringIndex].replace(/\|string\|[^|]+$/, "|string|not\nsafe"))],
    ["null with payload", replaceAt(nullIndex, `${lines[nullIndex]}payload`)],
    ["duplicate line", [...lines, lines[0]].join("\n")],
    ["missing field", lines.slice(1).join("\n")],
    ["extra field", [...lines, "IA4REC1|exception3|extra|bool|true"].join("\n")],
    ["extra line", `${valid}\nIA4REC1|exception1|event|string|extra`],
    ["altered order", [lines[1], lines[0], ...lines.slice(2)].join("\n")],
    ["intermediate empty line", [lines[0], "", ...lines.slice(1)].join("\n")],
    ["two final terminators", `${valid}\n\n`],
    ["lone CR", `${valid}\r`],
    ["canary", replaceAt(stringIndex, lines[stringIndex].replace(/\|string\|[^|]+$/, "|string|SENSITIVE_CANARY"))],
    ["Windows path", replaceAt(stringIndex, lines[stringIndex].replace(/\|string\|[^|]+$/, "|string|C:\\private"))],
    ["user path", replaceAt(stringIndex, lines[stringIndex].replace(/\|string\|[^|]+$/, "|string|C:\\Users\\private"))],
    ["drive-relative path", replaceAt(stringIndex, lines[stringIndex].replace(/\|string\|[^|]+$/, "|string|C:private"))],
    ["canonical SID", replaceAt(stringIndex, lines[stringIndex].replace(/\|string\|[^|]+$/, "|string|S-1-5-21-100"))],
    ["embedded SID", replaceAt(stringIndex, lines[stringIndex].replace(/\|string\|[^|]+$/, "|string|prefixS-1-5-21-100suffix"))],
    ["lowercase SID", replaceAt(stringIndex, lines[stringIndex].replace(/\|string\|[^|]+$/, "|string|s-1-5-21-100"))],
    ["secret word", replaceAt(stringIndex, lines[stringIndex].replace(/\|string\|[^|]+$/, "|string|secret"))],
    ["underscored secret", replaceAt(stringIndex, lines[stringIndex].replace(/\|string\|[^|]+$/, "|string|client_secret"))],
    ["suffixed token", replaceAt(stringIndex, lines[stringIndex].replace(/\|string\|[^|]+$/, "|string|BearerToken"))],
    ["stack suffix", replaceAt(stringIndex, lines[stringIndex].replace(/\|string\|[^|]+$/, "|string|StackTrace"))],
    ["PostgreSQL URI", replaceAt(stringIndex, lines[stringIndex].replace(/\|string\|[^|]+$/, "|string|postgres://host/db"))],
    ["NUL", `${valid}\u0000`],
    ["non-ASCII", replaceAt(stringIndex, lines[stringIndex].replace(/\|string\|[^|]+$/, "|string|inválido"))]
  ];
  for (const [name, input] of cases) {
    await t.test(name, () => {
      assert.throws(
        () => parseExceptionClosedTransport(input),
        { name: "Error", message: PROTOCOL_ERROR }
      );
    });
  }
});

test("the exact PowerShell sanitizer walks synthetic exceptions without file I/O", {
  skip: process.platform !== "win32"
}, () => {
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const system32 = path.join(systemRoot, "System32");
  const powershell = path.join(
    system32,
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  const script = [
    "$ErrorActionPreference='Stop';",
    POWERSHELL_DIAGNOSTIC_FUNCTIONS,
    POWERSHELL_CLOSED_TRANSPORT_FUNCTION,
    "$io=[IO.IOException]::new('SENSITIVE_CANARY');",
    "$outer=[Management.Automation.MethodInvocationException]::new('SENSITIVE_CANARY',$io);",
    "$r1=[Management.Automation.ErrorRecord]::new($outer,'MethodInvocationException',[Management.Automation.ErrorCategory]::InvalidOperation,$null);",
    "$d1=New-IA4FileReplaceDiagnostic $r1;",
    "$fifth=[IO.IOException]::new('SENSITIVE_CANARY');",
    "$fourth=[Exception]::new('SENSITIVE_CANARY',$fifth);",
    "$third=[Exception]::new('SENSITIVE_CANARY',$fourth);",
    "$second=[Exception]::new('SENSITIVE_CANARY',$third);",
    "$first=[Exception]::new('SENSITIVE_CANARY',$second);",
    "$r2=[Management.Automation.ErrorRecord]::new($first,'SyntheticChain',[Management.Automation.ErrorCategory]::NotSpecified,$null);",
    "$d2=New-IA4FileReplaceDiagnostic $r2;",
    "$win=[ComponentModel.Win32Exception]::new(32,'SENSITIVE_CANARY');",
    "$r3=[Management.Automation.ErrorRecord]::new($win,'Win32Synthetic',[Management.Automation.ErrorCategory]::ResourceBusy,$null);",
    "$d3=New-IA4FileReplaceDiagnostic $r3;",
    powerShellEmission("exception1", "d1"),
    powerShellEmission("exception2", "d2"),
    powerShellEmission("exception3", "d3")
  ].join("\n");
  const parsed = runExceptionPowerShell(
    powershell,
    system32,
    script,
    {
      ComSpec: path.join(system32, "cmd.exe"),
      PATH: [system32, path.dirname(powershell)].join(path.delimiter),
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      SystemDrive: path.parse(systemRoot).root.replace(/[\\/]$/, ""),
      SystemRoot: systemRoot,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      WINDIR: systemRoot
    }
  );
  assert.equal(parsed.lineCount, 51);
  const values = EXCEPTION_RECORDS.map((record) => parsed.values[record]);
  for (const value of values) {
    assert.equal(validateFileReplaceExceptionDiagnostic(value), true);
  }
  assert.equal(values[0].outerExceptionType,
    "System.Management.Automation.MethodInvocationException");
  assert.equal(values[0].innerExceptionType1, "System.IO.IOException");
  assert.equal(values[1].chainTruncated, true);
  assert.equal(values[1].innerExceptionType3, "System.Exception");
  assert.equal(values[2].effectiveExceptionType,
    "System.ComponentModel.Win32Exception");
  assert.equal(values[2].nativeErrorCode, 32);
  assert.equal(values[2].win32Code, 32);
  assert.equal(values[2].win32Symbol, "ERROR_SHARING_VIOLATION");
});
