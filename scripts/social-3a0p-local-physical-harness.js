"use strict";

const path = require("node:path");
const {
  DEFAULT_PHASE_TIMEOUTS,
  DEFAULT_READINESS_TIMEOUTS,
  PHASES,
  fail,
  isLoopbackHost,
  runPhasedHarness,
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
  return Object.freeze({
    archivePath: path.resolve(descriptor.archivePath),
    expectedSha256: descriptor.expectedSha256,
    version: descriptor.version
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
  for (const [phase, adapterName] of Object.entries(PHASE_ADAPTERS)) {
    actions[phase] = (runtime) =>
      contract.adapters[adapterName](phaseInput(phase, contract, runtime));
  }
  actions["wait-for-readiness"] = async (runtime) => {
    const input = phaseInput("wait-for-readiness", contract, runtime);
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
  };
  return Object.freeze(actions);
}

async function runLocalPhysicalHarness(options) {
  const contract = controllerContract(options);
  const report = await runPhasedHarness({
    actions: createHarnessActions(contract),
    timeouts: contract.timeouts,
    heartbeat: options.heartbeat || (() => {}),
    now: options.now || Date.now,
    terminateTree: ({ phase }) =>
      contract.adapters.terminateProcessTree(
        Object.freeze({ phase, target: contract.target })
      )
  });
  try {
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
  runLocalPhysicalHarness,
  validateAdapters,
  validateLoopbackTarget,
  validatePackageDescriptor
};
