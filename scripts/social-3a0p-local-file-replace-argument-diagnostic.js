"use strict";

const RUNTIME_TYPES = new Set([
  "null",
  "string",
  "other_reference_type",
  "unknown"
]);
const LENGTH_CLASSES = new Set([
  "null",
  "zero",
  "nonzero",
  "not_applicable"
]);
const DIAGNOSTIC_KEYS = Object.freeze([
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

const POWERSHELL_ARGUMENT_DIAGNOSTIC_FUNCTION = [
  "function New-IA4BackupArgumentDiagnostic($backup,[bool]$bound,[int]$arity,[bool]$ignore,[string]$source,[string]$destination){",
  "$isNull=$null-eq$backup;$runtime='unknown';$length='not_applicable';$empty=$false;$whitespace=$false;",
  "if($isNull){$runtime='null';$length='null'}",
  "elseif($backup-is[string]){$runtime='string';$empty=$backup.Length-eq0;$whitespace=(-not$empty)-and[string]::IsNullOrWhiteSpace($backup);$length=$(if($empty){'zero'}else{'nonzero'})}",
  "elseif($backup.GetType().IsValueType-eq$false){$runtime='other_reference_type'};",
  "$sourceFull=[IO.Path]::GetFullPath($source);$destinationFull=[IO.Path]::GetFullPath($destination);",
  "return [ordered]@{event='evidence_file_replace_backup_argument';backupArgumentBound=$bound;backupArgumentIsActualNull=$isNull;backupArgumentIsEmptyString=$empty;backupArgumentIsWhitespace=$whitespace;backupArgumentRuntimeTypeClass=$runtime;backupArgumentLengthClass=$length;replaceOverloadArity=$arity;ignoreMetadataErrors=$ignore;sourceExists=[IO.File]::Exists($sourceFull);destinationExists=[IO.File]::Exists($destinationFull);sourceAndDestinationSameDirectory=[string]::Equals([IO.Path]::GetDirectoryName($sourceFull),[IO.Path]::GetDirectoryName($destinationFull),[StringComparison]::OrdinalIgnoreCase);sourceAndDestinationSameVolume=[string]::Equals([IO.Path]::GetPathRoot($sourceFull),[IO.Path]::GetPathRoot($destinationFull),[StringComparison]::OrdinalIgnoreCase)}};"
].join("");

function classifyValue(value) {
  if (value === null) {
    return {
      backupArgumentIsActualNull: true,
      backupArgumentIsEmptyString: false,
      backupArgumentIsWhitespace: false,
      backupArgumentRuntimeTypeClass: "null",
      backupArgumentLengthClass: "null"
    };
  }
  if (typeof value === "string") {
    return {
      backupArgumentIsActualNull: false,
      backupArgumentIsEmptyString: value.length === 0,
      backupArgumentIsWhitespace: value.length > 0 && /^\s+$/.test(value),
      backupArgumentRuntimeTypeClass: "string",
      backupArgumentLengthClass: value.length === 0 ? "zero" : "nonzero"
    };
  }
  if ((typeof value === "object" || typeof value === "function") && value) {
    return {
      backupArgumentIsActualNull: false,
      backupArgumentIsEmptyString: false,
      backupArgumentIsWhitespace: false,
      backupArgumentRuntimeTypeClass: "other_reference_type",
      backupArgumentLengthClass: "not_applicable"
    };
  }
  return {
    backupArgumentIsActualNull: false,
    backupArgumentIsEmptyString: false,
    backupArgumentIsWhitespace: false,
    backupArgumentRuntimeTypeClass: "unknown",
    backupArgumentLengthClass: "not_applicable"
  };
}

function createFileReplaceArgumentDiagnostic({
  backupArgumentBound,
  backupArgument,
  replaceOverloadArity,
  ignoreMetadataErrors,
  sourceExists,
  destinationExists,
  sourceAndDestinationSameDirectory,
  sourceAndDestinationSameVolume
}) {
  const diagnostic = {
    event: "evidence_file_replace_backup_argument",
    backupArgumentBound: backupArgumentBound === true,
    ...classifyValue(backupArgument),
    replaceOverloadArity,
    ignoreMetadataErrors: ignoreMetadataErrors === true,
    sourceExists: sourceExists === true,
    destinationExists: destinationExists === true,
    sourceAndDestinationSameDirectory:
      sourceAndDestinationSameDirectory === true,
    sourceAndDestinationSameVolume: sourceAndDestinationSameVolume === true
  };
  validateFileReplaceArgumentDiagnostic(diagnostic);
  return Object.freeze(diagnostic);
}

function validateFileReplaceArgumentDiagnostic(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError("file_replace_argument_diagnostic_invalid");
  }
  const keys = Object.keys(value).sort();
  const expected = [...DIAGNOSTIC_KEYS].sort();
  const booleans = [
    "backupArgumentBound",
    "backupArgumentIsActualNull",
    "backupArgumentIsEmptyString",
    "backupArgumentIsWhitespace",
    "ignoreMetadataErrors",
    "sourceExists",
    "destinationExists",
    "sourceAndDestinationSameDirectory",
    "sourceAndDestinationSameVolume"
  ];
  const type = value.backupArgumentRuntimeTypeClass;
  const length = value.backupArgumentLengthClass;
  const typeShapeValid =
    (type !== "null" ||
      (value.backupArgumentIsActualNull &&
        !value.backupArgumentIsEmptyString &&
        !value.backupArgumentIsWhitespace &&
        length === "null")) &&
    (type !== "string" ||
      (!value.backupArgumentIsActualNull &&
        length !== "null" &&
        length !== "not_applicable" &&
        value.backupArgumentIsEmptyString === (length === "zero") &&
        !(value.backupArgumentIsEmptyString &&
          value.backupArgumentIsWhitespace))) &&
    (!["other_reference_type", "unknown"].includes(type) ||
      (!value.backupArgumentIsActualNull &&
        !value.backupArgumentIsEmptyString &&
        !value.backupArgumentIsWhitespace &&
        length === "not_applicable"));
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index]) ||
    value.event !== "evidence_file_replace_backup_argument" ||
    booleans.some((key) => typeof value[key] !== "boolean") ||
    !RUNTIME_TYPES.has(type) ||
    !LENGTH_CLASSES.has(length) ||
    !typeShapeValid ||
    value.backupArgumentBound !== true ||
    value.replaceOverloadArity !== 4
  ) {
    throw new TypeError("file_replace_argument_diagnostic_invalid");
  }
  return true;
}

function serializeFileReplaceArgumentDiagnostic(value) {
  validateFileReplaceArgumentDiagnostic(value);
  return JSON.stringify(value);
}

module.exports = {
  DIAGNOSTIC_KEYS,
  LENGTH_CLASSES,
  POWERSHELL_ARGUMENT_DIAGNOSTIC_FUNCTION,
  RUNTIME_TYPES,
  createFileReplaceArgumentDiagnostic,
  serializeFileReplaceArgumentDiagnostic,
  validateFileReplaceArgumentDiagnostic
};
