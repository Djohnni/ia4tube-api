"use strict";

const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { spawnSync } = require("node:child_process");
const {
  POWERSHELL_ARGUMENT_DIAGNOSTIC_FUNCTION
} = require("./social-3a0p-local-file-replace-argument-diagnostic");
const {
  POWERSHELL_DIAGNOSTIC_FUNCTIONS
} = require("./social-3a0p-local-file-replace-diagnostic");

const PROFILE_IDS = Object.freeze([
  "P0_BASE",
  "P1_SYSTEM_MODULE_PATH",
  "P2_SYSTEM_MODULE_PATH_CACHE_NUL",
  "P3_USER_CACHE_PATHS",
  "P4_USER_HOME_PATHS",
  "P5_CLOSED_COMPLETE",
  "P6_CLOSED_COMPLETE_CACHE_NUL"
]);
const OPERATION_IDS = Object.freeze(["STARTUP", "UTILITY", "EXACT_HELPERS"]);
const BASE_ENVIRONMENT_KEYS = Object.freeze([
  "ComSpec",
  "PATH",
  "PATHEXT",
  "SystemDrive",
  "SystemRoot",
  "TEMP",
  "TMP",
  "WINDIR"
]);
const USER_CACHE_KEYS = Object.freeze(["LOCALAPPDATA", "APPDATA"]);
const USER_HOME_KEYS = Object.freeze([
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "LOCALAPPDATA",
  "APPDATA"
]);
const TIMEOUT_MS = 20_000;
const MAX_BUFFER_BYTES = 64 * 1024;
const CAPTURED_CODE = "windows_powershell_environment_profile_captured";
const UNRESOLVED_CODE = "windows_powershell_environment_profile_unresolved";
const FORBIDDEN_CHILD_OUTPUT =
  /SENSITIVE_CANARY|Users|password|token|secret|credential/i;
const RUN_OPTION_KEYS = new Set([
  "platform",
  "sourceEnvironment",
  "spawnSyncImpl"
]);
const CLI_OPTION_KEYS = new Set([...RUN_OPTION_KEYS, "writeLineImpl"]);

class WindowsPowerShellEnvironmentProbeError extends Error {
  constructor(code = "windows_powershell_environment_probe_failed") {
    super(code);
    this.name = "WindowsPowerShellEnvironmentProbeError";
    this.code = code;
  }
}

function fail(code = "windows_powershell_environment_probe_failed") {
  throw new WindowsPowerShellEnvironmentProbeError(code);
}

function assertClosedOptions(options, allowed) {
  if (
    !options ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    Object.keys(options).some((key) => !allowed.has(key))
  ) {
    fail("windows_powershell_environment_probe_options_invalid");
  }
}

function hasEnvironmentValue(environment, key) {
  return (
    Object.hasOwn(environment, key) &&
    typeof environment[key] === "string" &&
    environment[key].length > 0
  );
}

function exactEnvironment(base, additions = {}) {
  return Object.freeze({ ...base, ...additions });
}

function windowsContext(sourceEnvironment) {
  if (
    !sourceEnvironment ||
    typeof sourceEnvironment !== "object" ||
    Array.isArray(sourceEnvironment)
  ) {
    fail("windows_powershell_environment_probe_source_environment_invalid");
  }
  const rawSystemRoot = sourceEnvironment.SystemRoot || "C:\\Windows";
  if (
    typeof rawSystemRoot !== "string" ||
    rawSystemRoot.includes("\0") ||
    !path.win32.isAbsolute(rawSystemRoot) ||
    !/^[A-Za-z]:\\/.test(rawSystemRoot)
  ) {
    fail("windows_powershell_environment_probe_system_root_invalid");
  }
  const systemRoot = path.win32.normalize(rawSystemRoot);
  const system32 = path.win32.join(systemRoot, "System32");
  const powershellDirectory = path.win32.join(
    system32,
    "WindowsPowerShell",
    "v1.0"
  );
  const powershell = path.win32.join(powershellDirectory, "powershell.exe");
  const modulePath = path.win32.join(powershellDirectory, "Modules");
  if (!path.win32.isAbsolute(powershell) || !path.win32.isAbsolute(system32)) {
    fail("windows_powershell_environment_probe_path_invalid");
  }
  const baseEnvironment = Object.freeze({
    ComSpec: path.win32.join(system32, "cmd.exe"),
    PATH: [system32, powershellDirectory].join(";"),
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    SystemDrive: path.win32.parse(systemRoot).root.replace(/[\\/]$/, ""),
    SystemRoot: systemRoot,
    TEMP: sourceEnvironment.TEMP,
    TMP: sourceEnvironment.TMP,
    WINDIR: systemRoot
  });
  if (
    Object.keys(baseEnvironment).length !== BASE_ENVIRONMENT_KEYS.length ||
    BASE_ENVIRONMENT_KEYS.some((key) => !Object.hasOwn(baseEnvironment, key))
  ) {
    fail("windows_powershell_environment_probe_base_environment_invalid");
  }
  return Object.freeze({
    baseEnvironment,
    modulePath,
    powershell,
    system32,
    systemRoot
  });
}

function userValues(sourceEnvironment, keys) {
  if (keys.some((key) => !hasEnvironmentValue(sourceEnvironment, key))) {
    return null;
  }
  return Object.fromEntries(keys.map((key) => [key, sourceEnvironment[key]]));
}

function buildWindowsPowerShellProfiles(sourceEnvironment) {
  const context = windowsContext(sourceEnvironment);
  const p3Values = userValues(sourceEnvironment, USER_CACHE_KEYS);
  const p4Values = userValues(sourceEnvironment, USER_HOME_KEYS);
  const base = context.baseEnvironment;
  const profiles = [
    {
      id: "P0_BASE",
      available: true,
      environment: exactEnvironment(base)
    },
    {
      id: "P1_SYSTEM_MODULE_PATH",
      available: true,
      environment: exactEnvironment(base, { PSModulePath: context.modulePath })
    },
    {
      id: "P2_SYSTEM_MODULE_PATH_CACHE_NUL",
      available: true,
      environment: exactEnvironment(base, {
        PSModulePath: context.modulePath,
        PSModuleAnalysisCachePath: "NUL"
      })
    },
    {
      id: "P3_USER_CACHE_PATHS",
      available: p3Values !== null,
      environment: p3Values === null ? null : exactEnvironment(base, p3Values)
    },
    {
      id: "P4_USER_HOME_PATHS",
      available: p4Values !== null,
      environment: p4Values === null ? null : exactEnvironment(base, p4Values)
    },
    {
      id: "P5_CLOSED_COMPLETE",
      available: p4Values !== null,
      environment: p4Values === null
        ? null
        : exactEnvironment(base, {
            ...p4Values,
            PSModulePath: context.modulePath
          })
    },
    {
      id: "P6_CLOSED_COMPLETE_CACHE_NUL",
      available: p4Values !== null,
      environment: p4Values === null
        ? null
        : exactEnvironment(base, {
            ...p4Values,
            PSModulePath: context.modulePath,
            PSModuleAnalysisCachePath: "NUL"
          })
    }
  ].map((profile) => Object.freeze(profile));
  if (
    profiles.length !== PROFILE_IDS.length ||
    profiles.some((profile, index) => profile.id !== PROFILE_IDS[index])
  ) {
    fail("windows_powershell_environment_probe_profiles_invalid");
  }
  return Object.freeze({ context, profiles: Object.freeze(profiles) });
}

const UTILITY_SCRIPT = [
  "$ErrorActionPreference='Stop';",
  "[ordered]@{ok=$true}|ConvertTo-Json -Compress"
].join("");

const EXACT_HELPERS_SCRIPT = [
  "$ErrorActionPreference='Stop';",
  POWERSHELL_ARGUMENT_DIAGNOSTIC_FUNCTION,
  POWERSHELL_DIAGNOSTIC_FUNCTIONS,
  "$source=[IO.Path]::Combine($env:TEMP,'ia4-source.synthetic');",
  "$destination=[IO.Path]::Combine($env:TEMP,'ia4-destination.synthetic');",
  "$untyped=$null;",
  "$a1=New-IA4BackupArgumentDiagnostic $untyped $true 4 $true $source $destination;",
  "[string]$typed=$null;",
  "$a2=New-IA4BackupArgumentDiagnostic $typed $true 4 $true $source $destination;",
  "$arguments=[object[]]@($source,$destination,$null,$true);",
  "$a3=New-IA4BackupArgumentDiagnostic $arguments[2] $true $arguments.Length $arguments[3] $arguments[0] $arguments[1];",
  "$shape=[ordered]@{argumentCountFour=($arguments.Length-eq4);sourceAndDestinationStrings=(($arguments[0]-is[string])-and($arguments[1]-is[string]));thirdSlotActualNull=($null-eq$arguments[2]);fourthSlotBoolean=($arguments[3]-is[bool])};",
  "$argumentHelper=(($a1.event-eq'evidence_file_replace_backup_argument')-and($a2.event-eq'evidence_file_replace_backup_argument')-and($a3.event-eq'evidence_file_replace_backup_argument')-and$a1.backupArgumentBound-and$a1.backupArgumentIsActualNull-and($a1.backupArgumentRuntimeTypeClass-eq'null')-and($a1.backupArgumentLengthClass-eq'null')-and$a2.backupArgumentBound-and$a2.backupArgumentIsEmptyString-and($a2.backupArgumentRuntimeTypeClass-eq'string')-and($a2.backupArgumentLengthClass-eq'zero')-and$a3.backupArgumentIsActualNull-and($a3.replaceOverloadArity-eq4)-and$a3.ignoreMetadataErrors-and$shape.argumentCountFour-and$shape.sourceAndDestinationStrings-and$shape.thirdSlotActualNull-and$shape.fourthSlotBoolean);",
  "$io=[IO.IOException]::new('SENSITIVE_CANARY');",
  "$outer=[Management.Automation.MethodInvocationException]::new('SENSITIVE_CANARY',$io);",
  "$r1=[Management.Automation.ErrorRecord]::new($outer,'MethodInvocationException',[Management.Automation.ErrorCategory]::InvalidOperation,$null);",
  "$e1=New-IA4FileReplaceDiagnostic $r1;",
  "$fifth=[IO.IOException]::new('SENSITIVE_CANARY');",
  "$fourth=[Exception]::new('SENSITIVE_CANARY',$fifth);",
  "$third=[Exception]::new('SENSITIVE_CANARY',$fourth);",
  "$second=[Exception]::new('SENSITIVE_CANARY',$third);",
  "$first=[Exception]::new('SENSITIVE_CANARY',$second);",
  "$r2=[Management.Automation.ErrorRecord]::new($first,'SyntheticChain',[Management.Automation.ErrorCategory]::NotSpecified,$null);",
  "$e2=New-IA4FileReplaceDiagnostic $r2;",
  "$win=[ComponentModel.Win32Exception]::new(32,'SENSITIVE_CANARY');",
  "$r3=[Management.Automation.ErrorRecord]::new($win,'Win32Synthetic',[Management.Automation.ErrorCategory]::ResourceBusy,$null);",
  "$e3=New-IA4FileReplaceDiagnostic $r3;",
  "$exceptionHelper=(($e1.event-eq'evidence_file_replace_exception')-and($e1.outerExceptionType-eq'System.Management.Automation.MethodInvocationException')-and($e1.innerExceptionType1-eq'System.IO.IOException')-and$e2.chainTruncated-and($e2.innerExceptionType3-eq'System.Exception')-and($e3.effectiveExceptionType-eq'System.ComponentModel.Win32Exception')-and($e3.nativeErrorCode-eq32)-and($e3.win32Code-eq32)-and($e3.win32Symbol-eq'ERROR_SHARING_VIOLATION'));",
  "('argumentHelper='+([bool]$argumentHelper).ToString().ToLowerInvariant());",
  "('exceptionHelper='+([bool]$exceptionHelper).ToString().ToLowerInvariant())"
].join("");

const OPERATIONS = Object.freeze([
  Object.freeze({ id: "STARTUP", script: "exit 0" }),
  Object.freeze({ id: "UTILITY", script: UTILITY_SCRIPT }),
  Object.freeze({ id: "EXACT_HELPERS", script: EXACT_HELPERS_SCRIPT })
]);

function statusClass(result) {
  if (!result || !Number.isInteger(result.status)) return "null";
  return result.status === 0 ? "zero" : "nonzero";
}

function elapsedClass(elapsedMilliseconds, timedOut) {
  if (timedOut) return "timeout";
  if (elapsedMilliseconds < 1_000) return "under_1s";
  if (elapsedMilliseconds < 5_000) return "1_to_5s";
  return "5_to_20s";
}

function exactJsonObject(stdout, expected) {
  if (typeof stdout !== "string" || stdout.trim().length === 0) return false;
  let parsed;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return false;
  }
  if (!parsed || Object.getPrototypeOf(parsed) !== Object.prototype) {
    return false;
  }
  const expectedKeys = Object.keys(expected).sort();
  const actualKeys = Object.keys(parsed).sort();
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index]) &&
    expectedKeys.every((key) => parsed[key] === expected[key])
  );
}

function operationOutputIsValid(operationId, stdout) {
  if (operationId === "STARTUP") return stdout === "";
  if (operationId === "UTILITY") {
    return exactJsonObject(stdout, { ok: true });
  }
  if (operationId === "EXACT_HELPERS") {
    return (
      !FORBIDDEN_CHILD_OUTPUT.test(stdout) &&
      [
        "argumentHelper=true\nexceptionHelper=true",
        "argumentHelper=true\nexceptionHelper=true\n",
        "argumentHelper=true\r\nexceptionHelper=true",
        "argumentHelper=true\r\nexceptionHelper=true\r\n"
      ].includes(stdout)
    );
  }
  return false;
}

function runOperation({ context, environment, operation, spawnSyncImpl }) {
  const startedAt = performance.now();
  let result;
  try {
    result = spawnSyncImpl(
      context.powershell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", operation.script],
      {
        cwd: context.system32,
        encoding: "utf8",
        env: environment,
        maxBuffer: MAX_BUFFER_BYTES,
        shell: false,
        timeout: TIMEOUT_MS,
        windowsHide: true
      }
    );
  } catch {
    result = null;
  }
  const elapsedMilliseconds = Math.max(0, performance.now() - startedAt);
  const timedOut = result?.error?.code === "ETIMEDOUT";
  const signalPresent = typeof result?.signal === "string" && result.signal.length > 0;
  const started = Boolean(
    (Number.isInteger(result?.pid) && result.pid > 0) ||
    timedOut ||
    signalPresent ||
    Number.isInteger(result?.status)
  );
  const childContractValid = Boolean(
    result &&
    result.error === undefined &&
    result.status === 0 &&
    result.signal === null &&
    result.stderr === "" &&
    typeof result.stdout === "string" &&
    !FORBIDDEN_CHILD_OUTPUT.test(result.stderr) &&
    operationOutputIsValid(operation.id, result.stdout)
  );
  return Object.freeze({
    profile: null,
    operation: operation.id,
    started,
    completed: childContractValid,
    timeout: timedOut,
    statusClass: statusClass(result),
    signalPresent,
    elapsedClass: elapsedClass(elapsedMilliseconds, timedOut)
  });
}

function unavailableOperation(profileId, operationId) {
  return Object.freeze({
    profile: profileId,
    operation: operationId,
    started: false,
    completed: false,
    timeout: false,
    statusClass: "unavailable",
    signalPresent: false,
    elapsedClass: "under_1s"
  });
}

function runWindowsPowerShellEnvironmentProbe(options = {}) {
  assertClosedOptions(options, RUN_OPTION_KEYS);
  const platform = Object.hasOwn(options, "platform")
    ? options.platform
    : process.platform;
  const sourceEnvironment = Object.hasOwn(options, "sourceEnvironment")
    ? options.sourceEnvironment
    : process.env;
  const spawnSyncImpl = Object.hasOwn(options, "spawnSyncImpl")
    ? options.spawnSyncImpl
    : spawnSync;
  if (platform !== "win32" || typeof spawnSyncImpl !== "function") {
    fail("windows_powershell_environment_probe_precondition_invalid");
  }
  const { context, profiles } = buildWindowsPowerShellProfiles(sourceEnvironment);
  const results = [];
  for (const profile of profiles) {
    for (const operation of OPERATIONS) {
      if (!profile.available) {
        results.push(unavailableOperation(profile.id, operation.id));
        continue;
      }
      const result = runOperation({
        context,
        environment: profile.environment,
        operation,
        spawnSyncImpl
      });
      results.push(Object.freeze({ ...result, profile: profile.id }));
    }
  }
  const approvedProfiles = PROFILE_IDS.filter((profileId) =>
    OPERATION_IDS.every((operationId) =>
      results.some((result) =>
        result.profile === profileId &&
        result.operation === operationId &&
        result.completed === true
      )
    )
  );
  return Object.freeze({
    results: Object.freeze(results),
    approvedProfiles: Object.freeze(approvedProfiles),
    minimumApprovedProfile: approvedProfiles[0] || null,
    finalCode: approvedProfiles.length > 0 ? CAPTURED_CODE : UNRESOLVED_CODE
  });
}

function formatWindowsPowerShellEnvironmentProbe(report) {
  const lines = [];
  for (const result of report.results) {
    lines.push(`powershell_env_probe_profile=${result.profile}`);
    lines.push(`powershell_env_probe_operation=${result.operation}`);
    lines.push(`powershell_env_probe_started=${result.started}`);
    lines.push(`powershell_env_probe_completed=${result.completed}`);
    lines.push(`powershell_env_probe_timeout=${result.timeout}`);
    lines.push(`powershell_env_probe_status_class=${result.statusClass}`);
    lines.push(`powershell_env_probe_signal_present=${result.signalPresent}`);
    lines.push(`powershell_env_probe_elapsed_class=${result.elapsedClass}`);
  }
  for (const profileId of report.approvedProfiles) {
    lines.push(`windows_powershell_env_probe_approved_profile=${profileId}`);
  }
  if (report.minimumApprovedProfile !== null) {
    lines.push(
      `windows_powershell_minimum_approved_profile=${report.minimumApprovedProfile}`
    );
  }
  lines.push(report.finalCode);
  return lines.join("\n");
}

function runWindowsPowerShellEnvironmentProbeCli(options = {}) {
  assertClosedOptions(options, CLI_OPTION_KEYS);
  const writeLineImpl = options.writeLineImpl || ((line) => process.stdout.write(line));
  if (typeof writeLineImpl !== "function") {
    fail("windows_powershell_environment_probe_writer_invalid");
  }
  const runOptions = Object.fromEntries(
    Object.entries(options).filter(([key]) => RUN_OPTION_KEYS.has(key))
  );
  let output;
  try {
    output = formatWindowsPowerShellEnvironmentProbe(
      runWindowsPowerShellEnvironmentProbe(runOptions)
    );
  } catch {
    output = UNRESOLVED_CODE;
  }
  writeLineImpl(`${output}\n`);
  return 1;
}

if (require.main === module) {
  process.exitCode = runWindowsPowerShellEnvironmentProbeCli();
}

module.exports = {
  BASE_ENVIRONMENT_KEYS,
  CAPTURED_CODE,
  EXACT_HELPERS_SCRIPT,
  OPERATION_IDS,
  OPERATIONS,
  PROFILE_IDS,
  TIMEOUT_MS,
  UNRESOLVED_CODE,
  UTILITY_SCRIPT,
  WindowsPowerShellEnvironmentProbeError,
  buildWindowsPowerShellProfiles,
  formatWindowsPowerShellEnvironmentProbe,
  runWindowsPowerShellEnvironmentProbe,
  runWindowsPowerShellEnvironmentProbeCli
};
