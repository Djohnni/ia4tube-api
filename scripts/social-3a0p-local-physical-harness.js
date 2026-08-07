"use strict";

const path = require("node:path");
const {
  DEFAULT_PHASE_TIMEOUTS,
  DEFAULT_READINESS_TIMEOUTS,
  HarnessFailure,
  PHASES,
  executeWithTimeout,
  fail,
  heartbeatEvent,
  isLoopbackHost,
  runPhasedHarness,
  validatePhaseResult,
  waitForReadiness
} = require("./social-3a0p-local-harness-core");

const PHYSICAL_APPROVAL = "RUN_SOCIAL_3A0P_LOCAL_POSTGRES_18_4";
const REQUIRED_POSTGRES_VERSION = "18.4";
const LOOPBACK_HOST = "127.0.0.1";
const LOCAL_READINESS_STEP_TIMEOUTS = Object.freeze({
  ...DEFAULT_READINESS_TIMEOUTS,
  listener: 20_000,
  pgIsReady: 20_000,
  adminConnection: 20_000
});

const PHASE_ADAPTERS = Object.freeze({
  preflight: "preflight",
  "validate-package": "validatePackage",
  "extract-package": "extractPackage",
  "initialize-cluster": "initializeCluster",
  "start-cluster": "startCluster",
  "bootstrap-roles": "bootstrapRoles",
  "establish-dpapi-custody": "establishDpapiCustody",
  "run-migration-gate": "runMigrationGate",
  "run-rls-gate": "runRlsGate",
  "run-concurrency-gate": "runConcurrencyGate",
  "run-vault-gate": "runVaultGate",
  "run-backup-restore-gate": "runBackupRestoreGate",
  "collect-sanitized-evidence": "collectSanitizedEvidence",
  cleanup: "cleanup"
});

const REQUIRED_ADAPTERS = Object.freeze([
  ...Object.values(PHASE_ADAPTERS),
  "createReadinessProbes",
  "finalizeSanitizedEvidence",
  "initializeEvidenceLedger",
  "transitionEvidenceLedger",
  "verifyPackageSourcePreserved",
  "terminateProcessTree"
]);

const FORBIDDEN_ADAPTERS = Object.freeze([
  "downloadPackage",
  "fetchPackage",
  "installPackage",
  "networkRequest"
]);

function requirePlainObject(value, code) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) fail(code);
  return value;
}

function validatePackageDescriptor(descriptor) {
  requirePlainObject(descriptor, "harness_package_descriptor_missing");
  if (descriptor.version !== REQUIRED_POSTGRES_VERSION) {
    fail("harness_postgres_version_mismatch");
  }
  if (
    typeof descriptor.archivePath !== "string" ||
    !descriptor.archivePath.trim() ||
    descriptor.archivePath !== descriptor.archivePath.trim() ||
    !path.isAbsolute(descriptor.archivePath) ||
    /^(?:\\\\|\/\/|\\\\\?\\|\\\\\.\\)/.test(descriptor.archivePath)
  ) {
    fail("harness_package_path_invalid");
  }
  if (
    typeof descriptor.expectedSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(descriptor.expectedSha256)
  ) {
    fail("harness_package_sha256_invalid");
  }
  if (
    typeof descriptor.sourceOwnedByRun !== "boolean" ||
    descriptor.workingCopyOwnedByRun !== true
  ) {
    fail("harness_package_ownership_invalid");
  }
  return Object.freeze({
    archivePath: path.resolve(descriptor.archivePath),
    expectedSha256: descriptor.expectedSha256,
    version: descriptor.version,
    sourceOwnedByRun: descriptor.sourceOwnedByRun,
    workingCopyOwnedByRun: true
  });
}

function validateLoopbackTarget(target) {
  requirePlainObject(target, "harness_loopback_target_missing");
  if (target.host !== LOOPBACK_HOST || !isLoopbackHost(target.host)) {
    fail("harness_loopback_host_refused");
  }
  if (
    !Number.isSafeInteger(target.port) ||
    target.port < 1024 ||
    target.port > 65535
  ) {
    fail("harness_loopback_port_invalid");
  }
  return Object.freeze({ host: LOOPBACK_HOST, port: target.port });
}

function validateAdapters(adapters) {
  requirePlainObject(adapters, "harness_adapters_missing");
  for (const name of FORBIDDEN_ADAPTERS) {
    if (Object.prototype.hasOwnProperty.call(adapters, name)) {
      fail("harness_network_adapter_refused");
    }
  }
  for (const name of REQUIRED_ADAPTERS) {
    if (typeof adapters[name] !== "function") {
      fail("harness_adapter_missing");
    }
  }
  return Object.freeze(
    Object.fromEntries(REQUIRED_ADAPTERS.map((name) => [name, adapters[name]]))
  );
}

function validateTimeouts(overrides = {}) {
  requirePlainObject(overrides, "harness_timeouts_invalid");
  for (const name of Object.keys(overrides)) {
    if (!PHASES.includes(name)) fail("harness_timeout_phase_unknown");
  }
  const timeouts = { ...DEFAULT_PHASE_TIMEOUTS, ...overrides };
  for (const timeoutMs of Object.values(timeouts)) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      fail("harness_timeout_invalid");
    }
  }
  return Object.freeze(timeouts);
}

function controllerContract(options) {
  requirePlainObject(options, "harness_options_invalid");
  if (options.approval !== PHYSICAL_APPROVAL) {
    fail("harness_explicit_approval_missing");
  }
  const packageDescriptor = validatePackageDescriptor(
    options.packageDescriptor
  );
  const target = validateLoopbackTarget(options.target);
  const adapters = validateAdapters(options.adapters);
  const timeouts = validateTimeouts(options.timeouts || {});
  const readinessOverrides = options.readinessStepTimeouts || {};
  requirePlainObject(
    readinessOverrides,
    "harness_readiness_timeout_invalid"
  );
  const readinessStepTimeouts = Object.freeze({
    ...LOCAL_READINESS_STEP_TIMEOUTS,
    ...readinessOverrides
  });
  for (const [name, timeoutMs] of Object.entries(readinessStepTimeouts)) {
    if (
      !Object.prototype.hasOwnProperty.call(DEFAULT_READINESS_TIMEOUTS, name) ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1
    ) {
      fail("harness_readiness_timeout_invalid");
    }
  }
  return Object.freeze({
    adapters,
    packageDescriptor,
    readinessStepTimeouts,
    target,
    timeouts
  });
}

function phaseInput(phase, contract, runtime) {
  return Object.freeze({
    context: runtime.context,
    heartbeat: runtime.heartbeat,
    packageDescriptor: contract.packageDescriptor,
    phase,
    signal: runtime.signal,
    target: contract.target
  });
}

function createHarnessActions(contract) {
  const actions = {};
  let ledgerInitialized = false;

  async function transition(event) {
    if (!ledgerInitialized) return null;
    return contract.adapters.transitionEvidenceLedger(Object.freeze(event));
  }

  async function executePhase(phase, runtime, operation) {
    const input = phaseInput(phase, contract, runtime);
    if (phase === "preflight") {
      await contract.adapters.initializeEvidenceLedger(input);
      ledgerInitialized = true;
    }
    if (phase === "cleanup") {
      let evidenceFailure = null;
      try {
        await transition({ kind: "started", phase });
      } catch (error) {
        evidenceFailure = error;
      }
      let result;
      try {
        result = validatePhaseResult(await operation(input));
      } catch (error) {
        throw error;
      }
      if (evidenceFailure) throw evidenceFailure;
      return result;
    }

    await transition({ kind: "started", phase });
    return validatePhaseResult(await operation(input));
  }

  for (const [phase, adapterName] of Object.entries(PHASE_ADAPTERS)) {
    actions[phase] = (runtime) => executePhase(
      phase,
      runtime,
      (input) => contract.adapters[adapterName](input)
    );
  }
  actions["wait-for-readiness"] = (runtime) => executePhase(
    "wait-for-readiness",
    runtime,
    async (input) => {
      const readiness = await contract.adapters.createReadinessProbes(input);
      requirePlainObject(readiness, "harness_readiness_adapter_invalid");
      return waitForReadiness({
        probes: readiness.probes,
        pid: readiness.pid,
        port: contract.target.port,
        stepTimeouts: contract.readinessStepTimeouts,
        heartbeat: runtime.heartbeat,
        signal: runtime.signal
      });
    }
  );
  actions.onPhaseSettled = (event) => transition({
    kind: "finished",
    phase: event.phase,
    status: event.status,
    code: event.status === "passed" ? event.result.code : event.code,
    result: event.result
  });
  return Object.freeze(actions);
}

async function runLocalPhysicalHarness(options) {
  const contract = controllerContract(options);
  const actions = createHarnessActions(contract);
  const report = await runPhasedHarness({
    actions,
    timeouts: contract.timeouts,
    heartbeat: options.heartbeat || (() => {}),
    now: options.now || Date.now,
    onPhaseSettled: actions.onPhaseSettled,
    terminateTree: ({ phase }) =>
      contract.adapters.terminateProcessTree(
        Object.freeze({ phase, target: contract.target })
      )
  });
  try {
    await verifyPackageSourcePreserved(contract);
    const finalization = contract.adapters.finalizeSanitizedEvidence(
      Object.freeze({ report })
    );
    if (finalization && typeof finalization.then === "function") {
      fail("harness_evidence_finalizer_async_refused");
    }
    requirePlainObject(finalization, "harness_evidence_finalizer_result_invalid");
    if (
      finalization.code !== "windows_evidence_finalized" ||
      finalization.checks?.closedReportApproved !== true ||
      finalization.checks?.canonicalEvidenceCreated !== true ||
      finalization.checks?.pendingEvidenceRemoved !== true
    ) {
      fail("harness_evidence_finalizer_result_invalid");
    }
  } catch (error) {
    if (error && typeof error === "object") error.report = report;
    throw error;
  }
  return report;
}

async function verifyPackageSourcePreserved(contract) {
  const sourceVerification = await contract.adapters.verifyPackageSourcePreserved(
    Object.freeze({ packageDescriptor: contract.packageDescriptor })
  );
  requirePlainObject(
    sourceVerification,
    "harness_package_source_verification_invalid"
  );
  const sourceChecks = sourceVerification.checks;
  const ownershipVerified = contract.packageDescriptor.sourceOwnedByRun
    ? sourceChecks?.packageSourceOwnedByRun === true &&
      sourceChecks?.runOwnedPackageRemoved === true &&
      sourceChecks?.externalPackageDeletionAttempted === false
    : sourceChecks?.packageSourceOwnedByRun === false &&
      sourceChecks?.externalPackagePreserved === true &&
      sourceChecks?.sourceHashUnchanged === true &&
      sourceChecks?.externalPackageDeletionAttempted === false;
  if (
    sourceVerification.code !== "windows_package_source_preserved" ||
    ownershipVerified !== true
  ) {
    fail("harness_package_source_verification_invalid");
  }
  return sourceVerification;
}

function createPreflightOnlyRecord({
  phase,
  status,
  code,
  result,
  startedOffsetMs,
  completedOffsetMs
}) {
  return Object.freeze({
    phase,
    status,
    startedOffsetMs,
    completedOffsetMs,
    durationMs: completedOffsetMs - startedOffsetMs,
    code,
    result
  });
}

function assertPreflightOnlyReport(report) {
  if (
    !report ||
    report.schemaVersion !== 1 ||
    !Array.isArray(report.phases) ||
    report.phases.length !== 2 ||
    report.phases[0]?.phase !== "preflight" ||
    report.phases[1]?.phase !== "cleanup" ||
    report.phases.some((record) => record.status === "running") ||
    report.lastCompletedPhase !== (
      report.phases[0].status === "passed" ? "preflight" : null
    ) ||
    report.ok !== (
      report.phases[0].status === "passed" &&
      report.phases[1].status === "passed" &&
      report.persistenceFailureCode === null
    )
  ) {
    fail("harness_preflight_only_report_invalid");
  }
  return true;
}

async function runLocalPreflightOnly(options) {
  const contract = controllerContract(options);
  const heartbeat = options.heartbeat || (() => {});
  const now = options.now || Date.now;
  const startedAt = now();
  const context = Object.freeze({ state: {}, resourceJournal: null });
  const phases = [];

  async function runPhase(phase, adapterName) {
    const phaseStartedAt = now();
    const startedOffsetMs = Math.max(0, phaseStartedAt - startedAt);
    let result = null;
    let failure = null;
    heartbeat(heartbeatEvent(phase, "phase_started", phaseStartedAt, now));
    try {
      result = validatePhaseResult(await executeWithTimeout({
        phase,
        timeoutMs: contract.timeouts[phase],
        operation: (signal) => contract.adapters[adapterName](phaseInput(
          phase,
          contract,
          {
            context,
            signal,
            heartbeat: (step) =>
              heartbeat(heartbeatEvent(phase, step, phaseStartedAt, now))
          }
        )),
        terminateTree: () => contract.adapters.terminateProcessTree(
          Object.freeze({ phase, target: contract.target })
        )
      }));
    } catch (error) {
      failure = error instanceof HarnessFailure
        ? error
        : new HarnessFailure(
          phase === "cleanup"
            ? "harness_cleanup_unexpected_failure"
            : "harness_phase_unexpected_failure"
        );
    }
    const record = createPreflightOnlyRecord({
      phase,
      status: failure ? "failed" : "passed",
      code: failure
        ? failure.code
        : phase === "cleanup" ? "cleanup_passed" : "phase_passed",
      result,
      startedOffsetMs,
      completedOffsetMs: Math.max(startedOffsetMs, now() - startedAt)
    });
    phases.push(record);
    return failure;
  }

  const primaryFailure = await runPhase("preflight", "preflight");
  const cleanupFailure = primaryFailure?.operationSettled === false
    ? new HarnessFailure("harness_cleanup_blocked_unsettled_operation")
    : await runPhase("cleanup", "cleanup");
  if (phases.at(-1)?.phase !== "cleanup") {
    const cleanupOffsetMs = Math.max(0, now() - startedAt);
    phases.push(createPreflightOnlyRecord({
      phase: "cleanup",
      status: "failed",
      code: cleanupFailure.code,
      result: null,
      startedOffsetMs: cleanupOffsetMs,
      completedOffsetMs: cleanupOffsetMs
    }));
  }
  const report = Object.freeze({
    schemaVersion: 1,
    ok: !primaryFailure && !cleanupFailure,
    primaryFailureCode: primaryFailure?.code || null,
    persistenceFailureCode: null,
    cleanupFailureCode: cleanupFailure?.code || null,
    lastCompletedPhase: phases[0]?.status === "passed" ? "preflight" : null,
    durationMs: Math.max(0, now() - startedAt),
    phases: Object.freeze([...phases])
  });
  assertPreflightOnlyReport(report);

  let sourceFailure = null;
  try {
    await verifyPackageSourcePreserved(contract);
  } catch (error) {
    sourceFailure = error;
  }
  for (const failure of [
    primaryFailure,
    cleanupFailure,
    sourceFailure
  ]) {
    if (failure) {
      if (failure && typeof failure === "object") failure.report = report;
      throw failure;
    }
  }
  return report;
}

async function commandLineEntry({ stderr = process.stderr } = {}) {
  stderr.write(
    '{"ok":false,"code":"harness_injected_adapters_required"}\n'
  );
  return 2;
}

if (require.main === module) {
  commandLineEntry()
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      process.stderr.write(
        '{"ok":false,"code":"harness_entry_failed"}\n'
      );
      process.exitCode = 2;
    });
}

module.exports = {
  FORBIDDEN_ADAPTERS,
  LOCAL_READINESS_STEP_TIMEOUTS,
  LOOPBACK_HOST,
  PHASE_ADAPTERS,
  PHYSICAL_APPROVAL,
  REQUIRED_ADAPTERS,
  REQUIRED_POSTGRES_VERSION,
  commandLineEntry,
  controllerContract,
  createHarnessActions,
  runLocalPreflightOnly,
  runLocalPhysicalHarness,
  validateAdapters,
  validateLoopbackTarget,
  validatePackageDescriptor
};
