"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const {
  DIAGNOSTIC_KEYS,
  POWERSHELL_ARGUMENT_DIAGNOSTIC_FUNCTION,
  validateFileReplaceArgumentDiagnostic
} = require("../scripts/social-3a0p-local-file-replace-argument-diagnostic");

const PROTOCOL_VERSION = "IA4REC1";
const PROTOCOL_ERROR = "powershell_closed_transport_protocol_invalid";
const ARGUMENT_DIAGNOSTIC_FIELDS = Object.freeze([
  "event",
  "backupArgumentBound",
  "backupArgumentIsActualNull",
  "backupArgumentIsEmptyString",
  "backupArgumentIsWhitespace",
  "backupArgumentRuntimeTypeClass",
  "backupArgumentLengthClass",
  "replaceOverloadArity",
  "ignoreMetadataErrors",
  "sourceExists",
  "destinationExists",
  "sourceAndDestinationSameDirectory",
  "sourceAndDestinationSameVolume"
]);
const REFLECTION_SHAPE_FIELDS = Object.freeze([
  "argumentCountFour",
  "sourceAndDestinationStrings",
  "thirdSlotActualNull",
  "fourthSlotBoolean"
]);
const ARGUMENT_SCHEMAS = Object.freeze({
  untyped: ARGUMENT_DIAGNOSTIC_FIELDS,
  typed: ARGUMENT_DIAGNOSTIC_FIELDS,
  reflection: ARGUMENT_DIAGNOSTIC_FIELDS,
  reflectionShape: REFLECTION_SHAPE_FIELDS
});
const ARGUMENT_RECORDS = Object.freeze(Object.keys(ARGUMENT_SCHEMAS));
const ARGUMENT_LAYOUT = Object.freeze(ARGUMENT_RECORDS.flatMap((record) =>
  ARGUMENT_SCHEMAS[record].map((field) => Object.freeze({ record, field }))
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

function parseArgumentClosedTransport(input) {
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
    lines.length !== ARGUMENT_LAYOUT.length ||
    lines.some((line) => line.length === 0)
  ) {
    protocolFailure();
  }
  const values = Object.fromEntries(ARGUMENT_RECORDS.map((record) => [record, {}]));
  const seen = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    const parts = lines[index].split("|");
    if (parts.length !== 5) protocolFailure();
    const [version, record, field, type, payload] = parts;
    const expected = ARGUMENT_LAYOUT[index];
    if (
      version !== PROTOCOL_VERSION ||
      record !== expected.record ||
      field !== expected.field ||
      !Object.hasOwn(ARGUMENT_SCHEMAS, record) ||
      !ARGUMENT_SCHEMAS[record].includes(field)
    ) {
      protocolFailure();
    }
    const pair = `${record}\u0000${field}`;
    if (seen.has(pair) || Object.hasOwn(values[record], field)) protocolFailure();
    seen.add(pair);
    values[record][field] = decodeScalar(type, payload);
  }
  if (seen.size !== ARGUMENT_LAYOUT.length) protocolFailure();
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

function encodeArgumentFixture(records) {
  return ARGUMENT_LAYOUT.map(({ record, field }) => {
    const [type, payload] = encodeScalar(records[record][field]);
    return `${PROTOCOL_VERSION}|${record}|${field}|${type}|${payload}`;
  }).join("\n");
}

function powerShellArray(values) {
  return `@(${values.map((value) => `'${value}'`).join(",")})`;
}

const POWERSHELL_CLOSED_TRANSPORT_FUNCTION = [
  "function Write-IA4ClosedRecord($record,$field,$value){",
  `$records=${powerShellArray(ARGUMENT_RECORDS)};`,
  "if(-not ($records -ccontains [string]$record)){throw 'closed_transport_record_invalid'};",
  ...ARGUMENT_RECORDS.map((record, index) =>
    `${index === 0 ? "if" : "elseif"}($record -ceq '${record}'){$fields=${powerShellArray(ARGUMENT_SCHEMAS[record])}}`
  ),
  "else{throw 'closed_transport_record_invalid'};",
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

function powerShellEmission(record, variable, fields) {
  return fields.map((field) =>
    `Write-IA4ClosedRecord '${record}' '${field}' $${variable}.${field};`
  ).join("\n");
}

function runArgumentPowerShell(powershell, system32, script, environment) {
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
    return parseArgumentClosedTransport(result.stdout);
  } catch {
    throw new Error(PROTOCOL_ERROR);
  }
}

const ARGUMENT_FIXTURE = Object.freeze({
  untyped: Object.freeze({
    event: "evidence_file_replace_backup_argument",
    backupArgumentBound: true,
    backupArgumentIsActualNull: true,
    backupArgumentIsEmptyString: false,
    backupArgumentIsWhitespace: false,
    backupArgumentRuntimeTypeClass: "null",
    backupArgumentLengthClass: "null",
    replaceOverloadArity: 4,
    ignoreMetadataErrors: true,
    sourceExists: false,
    destinationExists: false,
    sourceAndDestinationSameDirectory: true,
    sourceAndDestinationSameVolume: true
  }),
  typed: Object.freeze({
    event: "evidence_file_replace_backup_argument",
    backupArgumentBound: true,
    backupArgumentIsActualNull: false,
    backupArgumentIsEmptyString: true,
    backupArgumentIsWhitespace: false,
    backupArgumentRuntimeTypeClass: "string",
    backupArgumentLengthClass: "zero",
    replaceOverloadArity: 4,
    ignoreMetadataErrors: true,
    sourceExists: false,
    destinationExists: false,
    sourceAndDestinationSameDirectory: true,
    sourceAndDestinationSameVolume: true
  }),
  reflection: Object.freeze({
    event: "evidence_file_replace_backup_argument",
    backupArgumentBound: true,
    backupArgumentIsActualNull: true,
    backupArgumentIsEmptyString: false,
    backupArgumentIsWhitespace: false,
    backupArgumentRuntimeTypeClass: "null",
    backupArgumentLengthClass: "null",
    replaceOverloadArity: 4,
    ignoreMetadataErrors: true,
    sourceExists: false,
    destinationExists: false,
    sourceAndDestinationSameDirectory: true,
    sourceAndDestinationSameVolume: true
  }),
  reflectionShape: Object.freeze({
    argumentCountFour: true,
    sourceAndDestinationStrings: true,
    thirdSlotActualNull: true,
    fourthSlotBoolean: true
  })
});

test("the IA4REC1 argument parser accepts only the closed canonical frame", async (t) => {
  assert.deepEqual(DIAGNOSTIC_KEYS, ARGUMENT_DIAGNOSTIC_FIELDS);
  const valid = encodeArgumentFixture(ARGUMENT_FIXTURE);
  for (const transport of [
    valid,
    `${valid}\n`,
    valid.replace(/\n/g, "\r\n"),
    `${valid.replace(/\n/g, "\r\n")}\r\n`
  ]) {
    const parsed = parseArgumentClosedTransport(transport);
    assert.equal(parsed.lineCount, 43);
    for (const record of ["untyped", "typed", "reflection"]) {
      assert.equal(validateFileReplaceArgumentDiagnostic(parsed.values[record]), true);
    }
    assert.deepEqual(parsed.values.reflectionShape, ARGUMENT_FIXTURE.reflectionShape);
  }

  const lines = valid.split("\n");
  const boolIndex = lines.findIndex((line) => line.includes("|bool|"));
  const intIndex = lines.findIndex((line) => line.includes("|int|"));
  const stringIndex = lines.findIndex((line) => line.includes("|string|"));
  const replaceAt = (index, value) => lines.with(index, value).join("\n");
  const cases = [
    ["non-string input", null],
    ["wrong version", lines.with(0, lines[0].replace("IA4REC1", "IA4REC2")).join("\n")],
    ["wrong version casing", lines.with(0, lines[0].replace("IA4REC1", "ia4rec1")).join("\n")],
    ["unknown record", lines.with(0, lines[0].replace("|untyped|", "|unknown|" )).join("\n")],
    ["record casing", lines.with(0, lines[0].replace("|untyped|", "|Untyped|" )).join("\n")],
    ["unknown field", lines.with(0, lines[0].replace("|event|", "|unknownField|" )).join("\n")],
    ["field casing", lines.with(0, lines[0].replace("|event|", "|Event|" )).join("\n")],
    ["unknown type", replaceAt(boolIndex, lines[boolIndex].replace("|bool|", "|float|"))],
    ["invalid bool", replaceAt(boolIndex, lines[boolIndex].replace(/\|bool\|[^|]+$/, "|bool|TRUE"))],
    ["positive integer sign", replaceAt(intIndex, lines[intIndex].replace(/\|int\|[^|]+$/, "|int|+4"))],
    ["integer leading zero", replaceAt(intIndex, lines[intIndex].replace(/\|int\|[^|]+$/, "|int|04"))],
    ["negative zero", replaceAt(intIndex, lines[intIndex].replace(/\|int\|[^|]+$/, "|int|-0"))],
    ["unsafe integer", replaceAt(intIndex, lines[intIndex].replace(/\|int\|[^|]+$/, "|int|9007199254740992"))],
    ["empty string", replaceAt(stringIndex, lines[stringIndex].replace(/\|string\|[^|]+$/, "|string|"))],
    ["string with space", replaceAt(stringIndex, lines[stringIndex].replace(/\|string\|[^|]+$/, "|string|not safe"))],
    ["string with pipe", replaceAt(stringIndex, lines[stringIndex].replace(/\|string\|[^|]+$/, "|string|not|safe"))],
    ["string with CR", replaceAt(stringIndex, lines[stringIndex].replace(/\|string\|[^|]+$/, "|string|not\rsafe"))],
    ["string with LF", replaceAt(stringIndex, lines[stringIndex].replace(/\|string\|[^|]+$/, "|string|not\nsafe"))],
    ["null with payload", replaceAt(stringIndex, lines[stringIndex].replace(/\|string\|[^|]+$/, "|null|payload"))],
    ["duplicate line", [...lines, lines[0]].join("\n")],
    ["missing field", lines.slice(1).join("\n")],
    ["extra field", [...lines, "IA4REC1|reflectionShape|extra|bool|true"].join("\n")],
    ["extra line", `${valid}\nIA4REC1|untyped|event|string|extra`],
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
    ["PostgreSQL URI", replaceAt(stringIndex, lines[stringIndex].replace(/\|string\|[^|]+$/, "|string|postgresql://host/db"))],
    ["NUL", `${valid}\u0000`],
    ["non-ASCII", replaceAt(stringIndex, lines[stringIndex].replace(/\|string\|[^|]+$/, "|string|inválido"))]
  ];
  for (const [name, input] of cases) {
    await t.test(name, () => {
      assert.throws(
        () => parseArgumentClosedTransport(input),
        { name: "Error", message: PROTOCOL_ERROR }
      );
    });
  }
});

test("the exact PowerShell helper observes null before binding and typed empty string distinctly", {
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
    POWERSHELL_ARGUMENT_DIAGNOSTIC_FUNCTION,
    POWERSHELL_CLOSED_TRANSPORT_FUNCTION,
    "$source=[IO.Path]::Combine($env:TEMP,'ia4-source.synthetic');",
    "$destination=[IO.Path]::Combine($env:TEMP,'ia4-destination.synthetic');",
    "$untyped=$null;",
    "$d1=New-IA4BackupArgumentDiagnostic $untyped $true 4 $true $source $destination;",
    "[string]$typed=$null;",
    "$d2=New-IA4BackupArgumentDiagnostic $typed $true 4 $true $source $destination;",
    "$arguments=[object[]]@($source,$destination,$null,$true);",
    "$d3=New-IA4BackupArgumentDiagnostic $arguments[2] $true $arguments.Length $arguments[3] $arguments[0] $arguments[1];",
    "$shape=[ordered]@{argumentCountFour=($arguments.Length-eq4);sourceAndDestinationStrings=(($arguments[0]-is[string])-and($arguments[1]-is[string]));thirdSlotActualNull=($null-eq$arguments[2]);fourthSlotBoolean=($arguments[3]-is[bool])};",
    powerShellEmission("untyped", "d1", ARGUMENT_DIAGNOSTIC_FIELDS),
    powerShellEmission("typed", "d2", ARGUMENT_DIAGNOSTIC_FIELDS),
    powerShellEmission("reflection", "d3", ARGUMENT_DIAGNOSTIC_FIELDS),
    powerShellEmission("reflectionShape", "shape", REFLECTION_SHAPE_FIELDS)
  ].join("\n");
  const parsed = runArgumentPowerShell(
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
  assert.equal(parsed.lineCount, 43);
  for (const key of ["untyped", "typed", "reflection"]) {
    assert.equal(validateFileReplaceArgumentDiagnostic(parsed.values[key]), true);
  }
  assert.equal(parsed.values.untyped.backupArgumentIsActualNull, true);
  assert.equal(parsed.values.typed.backupArgumentIsEmptyString, true);
  assert.equal(parsed.values.reflection.backupArgumentIsActualNull, true);
  assert.deepEqual(parsed.values.reflectionShape, {
    argumentCountFour: true,
    sourceAndDestinationStrings: true,
    thirdSlotActualNull: true,
    fourthSlotBoolean: true
  });
});
