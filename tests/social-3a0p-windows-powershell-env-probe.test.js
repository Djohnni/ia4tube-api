"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  POWERSHELL_ARGUMENT_DIAGNOSTIC_FUNCTION
} = require("../scripts/social-3a0p-local-file-replace-argument-diagnostic");
const {
  POWERSHELL_DIAGNOSTIC_FUNCTIONS
} = require("../scripts/social-3a0p-local-file-replace-diagnostic");
const {
  BASE_ENVIRONMENT_KEYS,
  CAPTURED_CODE,
  EXACT_HELPERS_SCRIPT,
  OPERATION_IDS,
  OPERATIONS,
  PROFILE_IDS,
  TIMEOUT_MS,
  UNRESOLVED_CODE,
  buildWindowsPowerShellProfiles,
  formatWindowsPowerShellEnvironmentProbe,
  runWindowsPowerShellEnvironmentProbe,
  runWindowsPowerShellEnvironmentProbeCli
} = require("../scripts/social-3a0p-windows-powershell-env-probe");

const SCRIPT_PATH = path.join(
  __dirname,
  "..",
  "scripts",
  "social-3a0p-windows-powershell-env-probe.js"
);

function syntheticEnvironment() {
  return {
    SystemRoot: "C:\\Windows",
    TEMP: "C:\\SyntheticTemp",
    TMP: "C:\\SyntheticTmp",
    LOCALAPPDATA: "C:\\Users\\Synthetic\\AppData\\Local",
    APPDATA: "C:\\Users\\Synthetic\\AppData\\Roaming",
    USERPROFILE: "C:\\Users\\Synthetic",
    HOMEDRIVE: "C:",
    HOMEPATH: "\\Users\\Synthetic",
    UNAUTHORIZED_SECRET: "environment-value-must-not-be-forwarded",
    GITHUB_TOKEN: "token-value-must-not-be-forwarded"
  };
}

function operationFromArgs(args) {
  assert.deepEqual(args.slice(0, 4), [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command"
  ]);
  return OPERATIONS.find((operation) => operation.script === args[4]);
}

function successfulResult(operationId) {
  const stdout = operationId === "STARTUP"
    ? ""
    : operationId === "UTILITY"
      ? '{"ok":true}\r\n'
      : "argumentHelper=true\r\nexceptionHelper=true\r\n";
  return {
    error: undefined,
    status: 0,
    signal: null,
    stdout,
    stderr: ""
  };
}

function syntheticSpawn(calls, replacement) {
  return (executable, args, options) => {
    const operation = operationFromArgs(args);
    assert.ok(operation, "operation must be one of the three closed probes");
    const call = { executable, args, options, operationId: operation.id };
    calls.push(call);
    const custom = replacement?.(call, calls.length - 1);
    return custom === undefined ? successfulResult(operation.id) : custom;
  };
}

function runSynthetic(replacement, environment = syntheticEnvironment()) {
  const calls = [];
  const report = runWindowsPowerShellEnvironmentProbe({
    platform: "win32",
    sourceEnvironment: environment,
    spawnSyncImpl: syntheticSpawn(calls, replacement)
  });
  return { calls, report };
}

function resultAt(report, profile, operation) {
  return report.results.find(
    (result) => result.profile === profile && result.operation === operation
  );
}

function keys(environment) {
  return Object.keys(environment).sort();
}

test("1. the closed profile inventory is exactly P0 through P6", () => {
  const { profiles } = buildWindowsPowerShellProfiles(syntheticEnvironment());
  assert.deepEqual(profiles.map(({ id }) => id), PROFILE_IDS);
  assert.deepEqual(PROFILE_IDS, [
    "P0_BASE",
    "P1_SYSTEM_MODULE_PATH",
    "P2_SYSTEM_MODULE_PATH_CACHE_NUL",
    "P3_USER_CACHE_PATHS",
    "P4_USER_HOME_PATHS",
    "P5_CLOSED_COMPLETE",
    "P6_CLOSED_COMPLETE_CACHE_NUL"
  ]);
});

test("2. profiles and operations run in deterministic nested order", () => {
  const { report } = runSynthetic();
  assert.deepEqual(
    report.results.map(({ profile, operation }) => `${profile}:${operation}`),
    PROFILE_IDS.flatMap((profile) =>
      OPERATION_IDS.map((operation) => `${profile}:${operation}`)
    )
  );
});

test("3. the profile inventory contains no duplicate", () => {
  assert.equal(new Set(PROFILE_IDS).size, PROFILE_IDS.length);
  const { report } = runSynthetic();
  const pairs = report.results.map(({ profile, operation }) =>
    `${profile}:${operation}`
  );
  assert.equal(new Set(pairs).size, pairs.length);
});

test("4. no profile inherits the source environment wholesale", () => {
  const sourceEnvironment = syntheticEnvironment();
  const { profiles } = buildWindowsPowerShellProfiles(sourceEnvironment);
  for (const profile of profiles) {
    assert.notEqual(profile.environment, sourceEnvironment);
    assert.equal(
      profile.environment === null ||
        Object.hasOwn(profile.environment, "UNAUTHORIZED_SECRET"),
      false
    );
    assert.equal(
      profile.environment === null || Object.hasOwn(profile.environment, "GITHUB_TOKEN"),
      false
    );
  }
});

test("5. P0 contains exactly the eight authorized base keys", () => {
  const { profiles } = buildWindowsPowerShellProfiles(syntheticEnvironment());
  assert.deepEqual(keys(profiles[0].environment), [...BASE_ENVIRONMENT_KEYS].sort());
});

test("6. P1 adds only the system PSModulePath", () => {
  const { context, profiles } = buildWindowsPowerShellProfiles(
    syntheticEnvironment()
  );
  assert.deepEqual(keys(profiles[1].environment), [
    ...BASE_ENVIRONMENT_KEYS,
    "PSModulePath"
  ].sort());
  assert.equal(profiles[1].environment.PSModulePath, context.modulePath);
  assert.equal(profiles[1].environment.PSModulePath.includes("Users"), false);
});

test("7. P2 adds only NUL analysis cache over P1", () => {
  const { profiles } = buildWindowsPowerShellProfiles(syntheticEnvironment());
  assert.deepEqual(keys(profiles[2].environment), [
    ...keys(profiles[1].environment),
    "PSModuleAnalysisCachePath"
  ].sort());
  assert.equal(profiles[2].environment.PSModuleAnalysisCachePath, "NUL");
});

test("8. P3 adds only LOCALAPPDATA and APPDATA", () => {
  const source = syntheticEnvironment();
  const { profiles } = buildWindowsPowerShellProfiles(source);
  assert.deepEqual(keys(profiles[3].environment), [
    ...BASE_ENVIRONMENT_KEYS,
    "LOCALAPPDATA",
    "APPDATA"
  ].sort());
  assert.equal(profiles[3].environment.LOCALAPPDATA, source.LOCALAPPDATA);
  assert.equal(profiles[3].environment.APPDATA, source.APPDATA);
});

test("9. P4 adds exactly the five defined user paths", () => {
  const { profiles } = buildWindowsPowerShellProfiles(syntheticEnvironment());
  assert.deepEqual(keys(profiles[4].environment), [
    ...BASE_ENVIRONMENT_KEYS,
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "LOCALAPPDATA",
    "APPDATA"
  ].sort());
});

test("10. P5 adds only system PSModulePath over P4", () => {
  const { context, profiles } = buildWindowsPowerShellProfiles(
    syntheticEnvironment()
  );
  assert.deepEqual(keys(profiles[5].environment), [
    ...keys(profiles[4].environment),
    "PSModulePath"
  ].sort());
  assert.equal(profiles[5].environment.PSModulePath, context.modulePath);
});

test("11. P6 adds only NUL analysis cache over P5", () => {
  const { profiles } = buildWindowsPowerShellProfiles(syntheticEnvironment());
  assert.deepEqual(keys(profiles[6].environment), [
    ...keys(profiles[5].environment),
    "PSModuleAnalysisCachePath"
  ].sort());
  assert.equal(profiles[6].environment.PSModuleAnalysisCachePath, "NUL");
});

test("12. public output contains only closed fields and never environment values", () => {
  const source = syntheticEnvironment();
  const { report } = runSynthetic(undefined, source);
  const output = formatWindowsPowerShellEnvironmentProbe(report);
  for (const value of Object.values(source)) {
    assert.equal(output.includes(value), false);
  }
  const allowedLine = /^(?:powershell_env_probe_(?:profile=P[0-6]_[A-Z0-9_]+|operation=(?:STARTUP|UTILITY|EXACT_HELPERS)|started=(?:true|false)|completed=(?:true|false)|timeout=(?:true|false)|status_class=(?:zero|nonzero|null|unavailable)|signal_present=(?:true|false)|elapsed_class=(?:under_1s|1_to_5s|5_to_20s|timeout))|windows_powershell_env_probe_approved_profile=P[0-6]_[A-Z0-9_]+|windows_powershell_minimum_approved_profile=P[0-6]_[A-Z0-9_]+|windows_powershell_environment_profile_(?:captured|unresolved))$/;
  for (const line of output.split("\n")) assert.match(line, allowedLine);
});

test("13. every available profile and operation spawns exactly once", () => {
  const { calls, report } = runSynthetic();
  assert.equal(calls.length, PROFILE_IDS.length * OPERATION_IDS.length);
  assert.equal(report.results.length, calls.length);
  for (const operationId of OPERATION_IDS) {
    assert.equal(calls.filter(({ operationId: id }) => id === operationId).length, 7);
  }
});

test("14. a timeout is classified and never retried", () => {
  const { calls, report } = runSynthetic((_call, index) =>
    index === 0
      ? {
          error: Object.assign(new Error("private timeout detail"), {
            code: "ETIMEDOUT"
          }),
          status: null,
          signal: "SIGTERM",
          stdout: "",
          stderr: "private timeout detail"
        }
      : undefined
  );
  assert.equal(calls.length, 21);
  assert.deepEqual(resultAt(report, "P0_BASE", "STARTUP"), {
    profile: "P0_BASE",
    operation: "STARTUP",
    started: true,
    completed: false,
    timeout: true,
    statusClass: "null",
    signalPresent: true,
    elapsedClass: "timeout"
  });
  assert.equal(formatWindowsPowerShellEnvironmentProbe(report).includes("private"), false);
});

test("15. a thrown spawn error fails closed and never retries", () => {
  const calls = [];
  const spawnSyncImpl = syntheticSpawn(calls, (_call, index) => {
    if (index === 0) throw new Error("private spawn detail");
    return undefined;
  });
  const report = runWindowsPowerShellEnvironmentProbe({
    platform: "win32",
    sourceEnvironment: syntheticEnvironment(),
    spawnSyncImpl
  });
  assert.equal(calls.length, 21);
  assert.equal(resultAt(report, "P0_BASE", "STARTUP").completed, false);
  assert.equal(resultAt(report, "P0_BASE", "STARTUP").started, false);
  assert.equal(resultAt(report, "P0_BASE", "STARTUP").statusClass, "null");
  assert.equal(formatWindowsPowerShellEnvironmentProbe(report).includes("private"), false);
});

test("a returned ENOENT does not claim that PowerShell started and is not retried", () => {
  const { calls, report } = runSynthetic((_call, index) =>
    index === 0
      ? {
          error: { code: "ENOENT" },
          status: null,
          signal: null,
          stdout: "",
          stderr: "private executable detail"
        }
      : undefined
  );
  assert.equal(calls.length, 21);
  const result = resultAt(report, "P0_BASE", "STARTUP");
  assert.equal(result.started, false);
  assert.equal(result.completed, false);
  assert.equal(result.timeout, false);
  assert.equal(result.statusClass, "null");
  assert.equal(formatWindowsPowerShellEnvironmentProbe(report).includes("private"), false);
});

test("16. null status fails closed", () => {
  const { report } = runSynthetic((_call, index) =>
    index === 0
      ? { error: undefined, status: null, signal: null, stdout: "", stderr: "" }
      : undefined
  );
  const result = resultAt(report, "P0_BASE", "STARTUP");
  assert.equal(result.statusClass, "null");
  assert.equal(result.completed, false);
});

test("17. any signal fails closed", () => {
  const { report } = runSynthetic((_call, index) =>
    index === 0
      ? { error: undefined, status: 0, signal: "SIGTERM", stdout: "", stderr: "" }
      : undefined
  );
  const result = resultAt(report, "P0_BASE", "STARTUP");
  assert.equal(result.signalPresent, true);
  assert.equal(result.completed, false);
});

test("18. unexpected stdout fails closed", () => {
  const { report } = runSynthetic((_call, index) =>
    index === 0
      ? { ...successfulResult("STARTUP"), stdout: "unexpected" }
      : undefined
  );
  assert.equal(resultAt(report, "P0_BASE", "STARTUP").completed, false);
});

test("19. unexpected stderr fails closed and is not published", () => {
  const { report } = runSynthetic((_call, index) =>
    index === 0
      ? { ...successfulResult("STARTUP"), stderr: "private stderr" }
      : undefined
  );
  assert.equal(resultAt(report, "P0_BASE", "STARTUP").completed, false);
  assert.equal(formatWindowsPowerShellEnvironmentProbe(report).includes("private"), false);
});

test("20. a synthetic secret in helper output is refused and never published", () => {
  const { report } = runSynthetic((call) =>
    call.operationId === "EXACT_HELPERS"
      ? {
          ...successfulResult("EXACT_HELPERS"),
          stdout: "SENSITIVE_CANARY"
        }
      : undefined
  );
  assert.equal(report.approvedProfiles.length, 0);
  assert.equal(formatWindowsPowerShellEnvironmentProbe(report).includes("SENSITIVE_CANARY"), false);
});

test("21. a user path in helper output is refused and never published", () => {
  const { report } = runSynthetic((call) =>
    call.operationId === "EXACT_HELPERS"
      ? {
          ...successfulResult("EXACT_HELPERS"),
          stdout: "C:\\Users\\Synthetic\\private"
        }
      : undefined
  );
  assert.equal(report.approvedProfiles.length, 0);
  assert.equal(formatWindowsPowerShellEnvironmentProbe(report).includes("Users"), false);
});

test("22. every child keeps shell=false and separate arguments", () => {
  const { calls } = runSynthetic();
  for (const { args, options } of calls) {
    assert.equal(options.shell, false);
    assert.equal(args.length, 5);
    assert.equal(args.includes("-EncodedCommand"), false);
    assert.equal(args.includes("cmd.exe"), false);
    assert.equal(options.timeout, TIMEOUT_MS);
    assert.equal(options.windowsHide, true);
  }
});

test("23. every child cwd is the exact System32 directory", () => {
  const { calls } = runSynthetic();
  for (const { options } of calls) assert.equal(options.cwd, "C:\\Windows\\System32");
});

test("24. every child uses the absolute SystemRoot PowerShell executable", () => {
  const { calls } = runSynthetic();
  for (const { executable } of calls) {
    assert.equal(path.win32.isAbsolute(executable), true);
    assert.equal(
      executable,
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
    );
  }
});

test("25. the probe has no repository file creation primitive", () => {
  const source = fs.readFileSync(SCRIPT_PATH, "utf8");
  assert.doesNotMatch(
    source,
    /(?:writeFile|appendFile|createWriteStream|mkdir|mkdtemp|File\.Replace)/
  );
});

test("26. the probe contains no artifact operation", () => {
  const source = fs.readFileSync(SCRIPT_PATH, "utf8");
  assert.doesNotMatch(source, /(?:upload-artifact|download-artifact|artifact)/i);
});

test("27. the probe cannot execute npm test", () => {
  const source = fs.readFileSync(SCRIPT_PATH, "utf8");
  assert.doesNotMatch(source, /(?:npm(?:\.cmd)?\s+test|run-node-tests)/i);
});

test("28. the probe cannot execute a physical gate", () => {
  const source = fs.readFileSync(SCRIPT_PATH, "utf8");
  assert.doesNotMatch(source, /(?:social-3a0p-linux-gate|physical[_ -]gate)/i);
});

test("missing user values publish unavailable rows without spawning", () => {
  const environment = syntheticEnvironment();
  delete environment.APPDATA;
  const { calls, report } = runSynthetic(undefined, environment);
  assert.equal(calls.length, 9);
  for (const profileId of PROFILE_IDS.slice(3)) {
    for (const operationId of OPERATION_IDS) {
      assert.deepEqual(resultAt(report, profileId, operationId), {
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
  }
});

test("P3 remains available when only a P4-specific user value is absent", () => {
  const environment = syntheticEnvironment();
  delete environment.USERPROFILE;
  const { profiles } = buildWindowsPowerShellProfiles(environment);
  assert.equal(profiles[3].available, true);
  assert.deepEqual(profiles.slice(4).map(({ available }) => available), [
    false,
    false,
    false
  ]);
});

test("the exact operation reuses both helpers and all original synthetic fixtures", () => {
  assert.equal(EXACT_HELPERS_SCRIPT.includes(POWERSHELL_ARGUMENT_DIAGNOSTIC_FUNCTION), true);
  assert.equal(EXACT_HELPERS_SCRIPT.includes(POWERSHELL_DIAGNOSTIC_FUNCTIONS), true);
  for (const fixture of [
    "ia4-source.synthetic",
    "ia4-destination.synthetic",
    "MethodInvocationException",
    "SyntheticChain",
    "Win32Synthetic",
    "ERROR_SHARING_VIOLATION"
  ]) {
    assert.equal(EXACT_HELPERS_SCRIPT.includes(fixture), true, fixture);
  }
  assert.equal(EXACT_HELPERS_SCRIPT.includes("argumentHelper="), true);
  assert.equal(EXACT_HELPERS_SCRIPT.includes("exceptionHelper="), true);
  assert.doesNotMatch(EXACT_HELPERS_SCRIPT, /File\.Replace/);
});

test("only the exact UTILITY JSON and two EXACT_HELPERS lines complete", () => {
  const { report } = runSynthetic((call) => {
    if (call.operationId === "UTILITY") {
      return { ...successfulResult("UTILITY"), stdout: '{"ok":true,"extra":false}' };
    }
    if (call.operationId === "EXACT_HELPERS") {
      return {
        ...successfulResult("EXACT_HELPERS"),
        stdout: "argumentHelper=true\r\nexceptionHelper=false\r\n"
      };
    }
    return undefined;
  });
  assert.equal(report.results.some((result) => result.operation === "UTILITY" && result.completed), false);
  assert.equal(report.results.some((result) => result.operation === "EXACT_HELPERS" && result.completed), false);
});

test("EXACT_HELPERS refuses extra, reordered, JSON, and mixed-ending output", () => {
  const invalidOutputs = [
    "argumentHelper=true\r\nexceptionHelper=true\r\nextra=true\r\n",
    "argumentHelper=true\r\nexceptionHelper=true\n",
    " argumentHelper=true\r\nexceptionHelper=true\r\n",
    "argumentHelper=true\r\nexceptionHelper=true\r\n\r\n",
    "exceptionHelper=true\r\nargumentHelper=true\r\n",
    "argumentHelper=true\r\nexceptionHelper=false\r\n",
    '{"argumentHelper":true,"exceptionHelper":true}\r\n'
  ];
  let exactIndex = 0;
  const { report } = runSynthetic((call) => {
    if (call.operationId !== "EXACT_HELPERS") return undefined;
    const stdout = invalidOutputs[exactIndex];
    exactIndex += 1;
    return { ...successfulResult("EXACT_HELPERS"), stdout };
  });
  assert.equal(exactIndex, invalidOutputs.length);
  assert.deepEqual(report.approvedProfiles, []);
});

test("EXACT_HELPERS accepts only the four closed LF and CRLF forms", () => {
  const validOutputs = [
    "argumentHelper=true\nexceptionHelper=true",
    "argumentHelper=true\nexceptionHelper=true\n",
    "argumentHelper=true\r\nexceptionHelper=true",
    "argumentHelper=true\r\nexceptionHelper=true\r\n"
  ];
  let exactIndex = 0;
  const { report } = runSynthetic((call) => {
    if (call.operationId !== "EXACT_HELPERS") return undefined;
    const stdout = validOutputs[exactIndex % validOutputs.length];
    exactIndex += 1;
    return { ...successfulResult("EXACT_HELPERS"), stdout };
  });
  assert.equal(exactIndex, PROFILE_IDS.length);
  assert.deepEqual(report.approvedProfiles, PROFILE_IDS);
});

test("profile approval requires all three completed operations", () => {
  const failedCallIndexes = new Set([0, 4, 8]);
  const { report } = runSynthetic((call, index) =>
    failedCallIndexes.has(index)
      ? { ...successfulResult(call.operationId), status: 2 }
      : undefined
  );
  assert.deepEqual(report.approvedProfiles, PROFILE_IDS.slice(3));
  assert.equal(report.minimumApprovedProfile, "P3_USER_CACHE_PATHS");
  assert.equal(report.finalCode, CAPTURED_CODE);
  assert.equal(resultAt(report, "P0_BASE", "STARTUP").completed, false);
  assert.equal(
    resultAt(report, "P1_SYSTEM_MODULE_PATH", "UTILITY").completed,
    false
  );
  assert.equal(
    resultAt(report, "P2_SYSTEM_MODULE_PATH_CACHE_NUL", "EXACT_HELPERS")
      .completed,
    false
  );
});

test("no validated EXACT_HELPERS produces the closed unresolved result", () => {
  const { report } = runSynthetic((call) =>
    call.operationId === "EXACT_HELPERS"
      ? { ...successfulResult("EXACT_HELPERS"), status: 1 }
      : undefined
  );
  assert.deepEqual(report.approvedProfiles, []);
  assert.equal(report.minimumApprovedProfile, null);
  assert.equal(report.finalCode, UNRESOLVED_CODE);
  const output = formatWindowsPowerShellEnvironmentProbe(report);
  assert.equal(output.includes("minimum_approved_profile"), false);
  assert.match(output, new RegExp(`${UNRESOLVED_CODE}$`));
});

test("the CLI publishes only the sanitized report and intentionally exits nonzero", () => {
  let publicOutput = "";
  const calls = [];
  const exitCode = runWindowsPowerShellEnvironmentProbeCli({
    platform: "win32",
    sourceEnvironment: syntheticEnvironment(),
    spawnSyncImpl: syntheticSpawn(calls),
    writeLineImpl(line) {
      publicOutput += line;
    }
  });
  assert.equal(exitCode, 1);
  assert.equal(calls.length, 21);
  assert.match(publicOutput, new RegExp(`${CAPTURED_CODE}\\n$`));
  assert.doesNotMatch(publicOutput, /SyntheticTemp|Users|token-value|environment-value/);
});

test("dependency injection is closed to unknown options and non-Windows platforms", () => {
  assert.throws(
    () => runWindowsPowerShellEnvironmentProbe({ untrusted: true }),
    { code: "windows_powershell_environment_probe_options_invalid" }
  );
  let calls = 0;
  assert.throws(
    () => runWindowsPowerShellEnvironmentProbe({
      platform: "linux",
      sourceEnvironment: syntheticEnvironment(),
      spawnSyncImpl() {
        calls += 1;
      }
    }),
    { code: "windows_powershell_environment_probe_precondition_invalid" }
  );
  assert.equal(calls, 0);
});
