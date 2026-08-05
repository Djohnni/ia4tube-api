"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { AsyncLocalStorage } = require("node:async_hooks");

const PHASES = Object.freeze([
  "preflight",
  "validate-package",
  "extract-package",
  "initialize-cluster",
  "start-cluster",
  "wait-for-readiness",
  "bootstrap-roles",
  "establish-dpapi-custody",
  "run-migration-gate",
  "run-rls-gate",
  "run-concurrency-gate",
  "run-vault-gate",
  "run-backup-restore-gate",
  "collect-sanitized-evidence",
  "cleanup"
]);

const DEFAULT_PHASE_TIMEOUTS = Object.freeze({
  preflight: 30_000,
  "validate-package": 120_000,
  "extract-package": 15 * 60_000,
  "initialize-cluster": 15 * 60_000,
  "start-cluster": 120_000,
  "wait-for-readiness": 120_000,
  "bootstrap-roles": 120_000,
  "establish-dpapi-custody": 60_000,
  "run-migration-gate": 20 * 60_000,
  "run-rls-gate": 15 * 60_000,
  "run-concurrency-gate": 15 * 60_000,
  "run-vault-gate": 15 * 60_000,
  "run-backup-restore-gate": 30 * 60_000,
  "collect-sanitized-evidence": 60_000,
  cleanup: 10 * 60_000
});

const DEFAULT_READINESS_TIMEOUTS = Object.freeze({
  process: 5_000,
  listener: 30_000,
  pgIsReady: 30_000,
  adminConnection: 30_000,
  selectOne: 10_000,
  serverVersion: 10_000,
  closeSession: 5_000
});
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

const LOOPBACK_HOST = "127.0.0.1";
const LOOPBACK_AUTHORIZATION = "SOCIAL_DATABASE_ALLOW_INSECURE_LOCALHOST";
const SAFE_SYSTEM_ENVIRONMENT = Object.freeze([
  "ComSpec",
  "PATH",
  "PATHEXT",
  "SystemDrive",
  "SystemRoot",
  "TEMP",
  "TMP",
  "WINDIR"
]);
const PHASE_STATUS = new Set(["running", "passed", "failed"]);
const RESULT_KEYS = new Set([
  "code",
  "checks",
  "counts",
  "hashes",
  "metrics",
  "inventory",
  "pendencies"
]);
const REPORT_KEYS = new Set([
  "schemaVersion",
  "ok",
  "primaryFailureCode",
  "cleanupFailureCode",
  "lastCompletedPhase",
  "durationMs",
  "phases"
]);
const PHASE_RECORD_KEYS = new Set([
  "phase",
  "status",
  "startedOffsetMs",
  "completedOffsetMs",
  "durationMs",
  "code",
  "result"
]);
const SECRET_KEY =
  /(authorization|ciphertext|credential|database.?url|password|private.?key|secret|state.?raw|token)/i;
const SECRET_VALUE = Object.freeze([
  /postgres(?:ql)?:\/\//i,
  /authorization\s*[:=]/i,
  /bearer\s+[a-z0-9._~-]+/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /(?:password|secret|token)\s*[:=]/i
]);
const OWNED_ROOT_PROOFS = new WeakSet();
const CANONICAL_CODE = /^[a-z][a-z0-9_]{2,95}$/;
const CANONICAL_NAME = /^[a-z][a-z0-9-]{1,63}$/;
const CANONICAL_DETAIL_KEY = /^[a-z][a-zA-Z0-9]{1,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;

class HarnessFailure extends Error {
  constructor(code, options = {}) {
    super(canonicalCode(code));
    this.code = canonicalCode(code);
    this.name = "HarnessFailure";
    if (options.terminationConfirmed === true || options.terminationConfirmed === false) {
      this.terminationConfirmed = options.terminationConfirmed;
    }
    if (options.operationSettled === true || options.operationSettled === false) {
      this.operationSettled = options.operationSettled;
    }
    if (typeof options.cleanupFailureCode === "string") {
      this.cleanupFailureCode = canonicalCode(options.cleanupFailureCode);
    }
    if (options.cleanupResult) this.cleanupResult = options.cleanupResult;
  }
}

function canonicalCode(value, fallback = "harness_failed") {
  const candidate = String(value || "");
  return CANONICAL_CODE.test(candidate) ? candidate : fallback;
}

function fail(code) {
  throw new HarnessFailure(code);
}

function requirePositiveTimeout(value, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 60 * 60_000) {
    fail(`${String(label).replaceAll("-", "_")}_timeout_invalid`);
  }
  return value;
}

function requirePositivePid(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail("harness_process_pid_invalid");
  }
  return value;
}

function isLoopbackHost(host) {
  return host === LOOPBACK_HOST;
}

function assertLoopbackAuthorization(environment, host) {
  if (host !== LOOPBACK_HOST) fail("harness_loopback_host_refused");
  if (environment?.[LOOPBACK_AUTHORIZATION] !== "true") {
    fail("harness_loopback_authorization_missing");
  }
  return true;
}

function readEnvironmentValue(environment, requestedName) {
  const matches = Object.keys(environment || {}).filter(
    (name) => name.toLowerCase() === requestedName.toLowerCase()
  );
  if (matches.length > 1) fail("harness_system_environment_ambiguous");
  return matches.length === 1 ? environment[matches[0]] : undefined;
}

function safeSystemEnvironment(environment = process.env) {
  const result = {};
  for (const name of SAFE_SYSTEM_ENVIRONMENT) {
    const value = readEnvironmentValue(environment, name);
    if (typeof value === "string" && value && !value.includes("\0")) {
      result[name] = value;
    }
  }
  return result;
}

function buildAllowlistedEnvironment({
  systemEnvironment = process.env,
  values = {},
  allowedNames = [],
  requiredNames = []
} = {}) {
  if (!Array.isArray(allowedNames) || !Array.isArray(requiredNames)) {
    fail("harness_child_environment_contract_invalid");
  }
  const allowed = new Set(allowedNames);
  const result = safeSystemEnvironment(systemEnvironment);
  for (const [name, value] of Object.entries(values)) {
    if (!allowed.has(name)) fail("harness_child_environment_key_refused");
    if (typeof value !== "string" || !value || value.includes("\0")) {
      fail("harness_child_environment_value_invalid");
    }
    result[name] = value;
  }
  for (const name of requiredNames) {
    if (!allowed.has(name) || typeof result[name] !== "string") {
      fail("harness_child_environment_required_missing");
    }
  }
  return Object.freeze(result);
}

function buildMigrationCliEnvironment({
  systemEnvironment,
  configuration,
  values,
  loopbackAuthorization
}) {
  if (!configuration || !values || configuration.mode !== "loopback") {
    fail("harness_migration_environment_invalid");
  }
  assertLoopbackAuthorization(
    { [LOOPBACK_AUTHORIZATION]: loopbackAuthorization },
    configuration.host
  );
  let migrationTarget;
  try {
    migrationTarget = new URL(values.migrationUrl);
  } catch {
    fail("harness_migration_url_invalid");
  }
  let migrationUsername;
  let migrationDatabase;
  try {
    migrationUsername = decodeURIComponent(migrationTarget.username);
    migrationDatabase = decodeURIComponent(migrationTarget.pathname.slice(1));
  } catch {
    fail("harness_migration_url_invalid");
  }
  if (
    !["postgres:", "postgresql:"].includes(migrationTarget.protocol) ||
    migrationTarget.hostname !== LOOPBACK_HOST ||
    migrationTarget.port !== String(configuration.port) ||
    migrationUsername !== values.migrationLogin ||
    migrationDatabase !== configuration.database
  ) {
    fail("harness_migration_url_target_mismatch");
  }
  const childValues = {
    NODE_ENV: "test",
    SOCIAL_MIGRATIONS_DATABASE_URL: values.migrationUrl,
    SOCIAL_DATABASE_EXPECTED_TARGET_FINGERPRINT:
      values.expectedTargetFingerprint,
    SOCIAL_MIGRATIONS_EXPECTED_LOGIN: values.migrationLogin,
    SOCIAL_DATABASE_EXPECTED_RUNTIME_LOGIN: values.runtimeLogin,
    SOCIAL_DATABASE_OWNER_ROLE: values.ownerRole,
    SOCIAL_DATABASE_MIGRATOR_ROLE: values.migratorRole,
    SOCIAL_MIGRATION_ENVIRONMENT: values.environment,
    SOCIAL_MIGRATION_APPROVED: values.approval,
    SOCIAL_MIGRATION_PRODUCTION_APPROVAL: "not-applicable-local-harness",
    SOCIAL_MIGRATION_EXPECTED_ENVIRONMENT_ID: values.environmentId,
    SOCIAL_MIGRATION_TARGET_FINGERPRINT: values.targetFingerprint,
    [LOOPBACK_AUTHORIZATION]: "true"
  };
  const allowedNames = Object.keys(childValues);
  return buildAllowlistedEnvironment({
    systemEnvironment,
    values: childValues,
    allowedNames,
    requiredNames: allowedNames
  });
}

function assertNoSecret(value, key = "root") {
  if (SECRET_KEY.test(key)) fail("harness_evidence_secret_key_refused");
  if (typeof value === "string") {
    if (SECRET_VALUE.some((pattern) => pattern.test(value))) {
      fail("harness_evidence_secret_value_refused");
    }
  }
}

function assertScalar(value, key) {
  assertNoSecret(value, key);
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    (typeof value === "string" && value.length <= 160)
  ) {
    return true;
  }
  fail("harness_evidence_value_invalid");
}

function assertDetailMap(value, kind) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) {
    fail("harness_evidence_value_invalid");
  }
  for (const [key, item] of Object.entries(value)) {
    if (!CANONICAL_DETAIL_KEY.test(key) || SECRET_KEY.test(key)) {
      fail("harness_evidence_key_invalid");
    }
    if (kind === "hashes") {
      if (typeof item !== "string" || !SHA256.test(item)) {
        fail("harness_evidence_hash_invalid");
      }
    } else if (kind === "counts" || kind === "metrics") {
      if (typeof item !== "number" || !Number.isFinite(item) || item < 0) {
        fail("harness_evidence_metric_invalid");
      }
    } else if (kind === "checks") {
      if (typeof item !== "boolean") fail("harness_evidence_check_invalid");
    } else {
      assertScalar(item, key);
    }
  }
  return true;
}

function validatePhaseResult(value) {
  const result = value === undefined ? { code: "phase_ok" } : value;
  if (!result || Object.getPrototypeOf(result) !== Object.prototype) {
    fail("harness_evidence_result_invalid");
  }
  for (const key of Object.keys(result)) {
    if (!RESULT_KEYS.has(key)) fail("harness_evidence_result_key_refused");
  }
  if (typeof result.code !== "string" || !CANONICAL_CODE.test(result.code)) {
    fail("harness_evidence_result_code_invalid");
  }
  for (const key of ["checks", "counts", "hashes", "metrics"]) {
    if (result[key] !== undefined) assertDetailMap(result[key], key);
  }
  for (const key of ["inventory", "pendencies"]) {
    if (result[key] !== undefined) {
      if (
        !Array.isArray(result[key]) ||
        result[key].some(
          (item) => typeof item !== "string" || !CANONICAL_NAME.test(item)
        )
      ) {
        fail("harness_evidence_inventory_invalid");
      }
    }
  }
  return Object.freeze({
    ...result,
    ...(result.checks && { checks: Object.freeze({ ...result.checks }) }),
    ...(result.counts && { counts: Object.freeze({ ...result.counts }) }),
    ...(result.hashes && { hashes: Object.freeze({ ...result.hashes }) }),
    ...(result.metrics && { metrics: Object.freeze({ ...result.metrics }) }),
    ...(result.inventory && { inventory: Object.freeze([...result.inventory]) }),
    ...(result.pendencies && { pendencies: Object.freeze([...result.pendencies]) })
  });
}

function exactKeys(value, expected, code) {
  const keys = Object.keys(value);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
    fail(code);
  }
}

function assertClosedEvidenceReport(report) {
  if (!report || Object.getPrototypeOf(report) !== Object.prototype) {
    fail("harness_evidence_report_invalid");
  }
  exactKeys(report, REPORT_KEYS, "harness_evidence_report_schema_invalid");
  if (report.schemaVersion !== 1 || typeof report.ok !== "boolean") {
    fail("harness_evidence_report_invalid");
  }
  if (
    (report.primaryFailureCode !== null &&
      !CANONICAL_CODE.test(report.primaryFailureCode)) ||
    (report.cleanupFailureCode !== null &&
      !CANONICAL_CODE.test(report.cleanupFailureCode)) ||
    (report.lastCompletedPhase !== null &&
      !PHASES.includes(report.lastCompletedPhase)) ||
    !Number.isFinite(report.durationMs) ||
    report.durationMs < 0 ||
    !Array.isArray(report.phases)
  ) {
    fail("harness_evidence_report_invalid");
  }
  for (const record of report.phases) {
    if (!record || Object.getPrototypeOf(record) !== Object.prototype) {
      fail("harness_evidence_phase_invalid");
    }
    exactKeys(record, PHASE_RECORD_KEYS, "harness_evidence_phase_schema_invalid");
    if (
      !PHASES.includes(record.phase) ||
      !PHASE_STATUS.has(record.status) ||
      !CANONICAL_CODE.test(record.code) ||
      !Number.isFinite(record.startedOffsetMs) ||
      !Number.isFinite(record.completedOffsetMs) ||
      !Number.isFinite(record.durationMs) ||
      record.startedOffsetMs < 0 ||
      record.completedOffsetMs < record.startedOffsetMs ||
      record.durationMs !== record.completedOffsetMs - record.startedOffsetMs
    ) {
      fail("harness_evidence_phase_invalid");
    }
    if (record.result !== null) validatePhaseResult(record.result);
  }
  if (report.phases.length < 1 || report.phases.at(-1)?.phase !== "cleanup") {
    fail("harness_evidence_phase_sequence_invalid");
  }
  const execution = report.phases.slice(0, -1);
  const expected = PHASES.slice(0, execution.length);
  if (
    execution.some((record, index) => record.phase !== expected[index]) ||
    execution.filter((record) => record.status === "failed").length > 1 ||
    execution.some((record, index) =>
      record.status === "failed" && index !== execution.length - 1
    ) ||
    execution.some((record) => record.status === "running")
  ) {
    fail("harness_evidence_phase_sequence_invalid");
  }
  for (let index = 1; index < report.phases.length; index += 1) {
    if (
      report.phases[index].startedOffsetMs <
      report.phases[index - 1].completedOffsetMs
    ) {
      fail("harness_evidence_phase_sequence_invalid");
    }
  }
  const cleanup = report.phases.at(-1);
  const executionFailure = execution.find((record) => record.status === "failed");
  const lastPassed = [...execution].reverse().find((record) => record.status === "passed");
  if (
    report.ok !== (!executionFailure && cleanup.status === "passed") ||
    report.primaryFailureCode !== (executionFailure?.code || null) ||
    report.cleanupFailureCode !== (cleanup.status === "failed" ? cleanup.code : null) ||
    report.lastCompletedPhase !== (lastPassed?.phase || null) ||
    (!executionFailure && execution.length !== PHASES.length - 1)
  ) {
    fail("harness_evidence_report_coherence_invalid");
  }
  return true;
}

function heartbeatEvent(phase, step, startedAt, now = Date.now) {
  if (!PHASES.includes(phase) || !CANONICAL_CODE.test(step)) {
    fail("harness_heartbeat_invalid");
  }
  return Object.freeze({
    phase,
    status: "running",
    step,
    elapsedMs: Math.max(0, now() - startedAt)
  });
}

function startPeriodicHeartbeat({
  phase,
  startedAt,
  heartbeat,
  intervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
  now = Date.now,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval
}) {
  requirePositiveTimeout(intervalMs, "heartbeat");
  if (
    !PHASES.includes(phase) ||
    typeof heartbeat !== "function" ||
    typeof now !== "function" ||
    typeof setIntervalImpl !== "function" ||
    typeof clearIntervalImpl !== "function"
  ) {
    fail("harness_heartbeat_configuration_invalid");
  }
  const timer = setIntervalImpl(() => {
    try {
      heartbeat(heartbeatEvent(phase, "phase_heartbeat", startedAt, now));
    } catch {
      // Telemetry must not alter the authoritative result of a phase.
    }
  }, intervalMs);
  if (timer && typeof timer.unref === "function") timer.unref();
  return () => clearIntervalImpl(timer);
}

async function boundedTermination(terminateTree, phase, timeoutMs = 5_000) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => terminateTree({ phase })),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      })
    ]).then((value) => value === true);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function executeWithTimeout({
  phase,
  timeoutMs,
  operation,
  terminateTree = async () => true,
  terminationTimeoutMs = 5_000,
  settlementTimeoutMs = terminationTimeoutMs,
  invalidate = () => {}
}) {
  requirePositiveTimeout(timeoutMs, phase);
  requirePositiveTimeout(terminationTimeoutMs, "termination");
  requirePositiveTimeout(settlementTimeoutMs, "settlement");
  if (
    typeof operation !== "function" ||
    typeof terminateTree !== "function" ||
    typeof invalidate !== "function"
  ) {
    fail("harness_operation_invalid");
  }
  const controller = new AbortController();
  let timer;
  let timedOut = false;
  let settled = false;
  const operationPromise = Promise.resolve().then(() => operation(controller.signal));
  const observedOperation = operationPromise.finally(() => {
    settled = true;
  });
  observedOperation.catch(() => {});
  const timeoutPromise = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      invalidate();
      controller.abort();
      reject(new HarnessFailure(`${phase.replaceAll("-", "_")}_timeout`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([observedOperation, timeoutPromise]);
  } catch (error) {
    if (!timedOut) throw error;
    const terminationConfirmed = await boundedTermination(
      terminateTree,
      phase,
      terminationTimeoutMs
    );
    let settlementTimer;
    if (!settled) {
      await Promise.race([
        observedOperation.then(
          () => true,
          () => true
        ),
        new Promise((resolve) => {
          settlementTimer = setTimeout(() => resolve(false), settlementTimeoutMs);
        })
      ]);
      clearTimeout(settlementTimer);
    }
    const operationSettled = settled;
    const prefix = phase.replaceAll("-", "_");
    const code = !terminationConfirmed
      ? `${prefix}_timeout_termination_unconfirmed`
      : !operationSettled
        ? `${prefix}_timeout_operation_unsettled`
        : `${prefix}_timeout`;
    throw new HarnessFailure(code, {
      terminationConfirmed,
      operationSettled
    });
  } finally {
    clearTimeout(timer);
  }
}

function createLeasedState(leaseStorage) {
  const target = Object.create(null);
  const requireActiveLease = () => {
    const lease = leaseStorage.getStore();
    if (!lease || lease.active !== true) fail("harness_phase_lease_inactive");
  };
  return new Proxy(target, {
    set(object, key, value) {
      requireActiveLease();
      object[key] = value;
      return true;
    },
    deleteProperty(object, key) {
      requireActiveLease();
      return Reflect.deleteProperty(object, key);
    },
    defineProperty(object, key, descriptor) {
      requireActiveLease();
      return Reflect.defineProperty(object, key, descriptor);
    },
    setPrototypeOf() {
      fail("harness_phase_state_prototype_refused");
    }
  });
}

function createPhaseLease(phase) {
  const lease = {
    phase,
    active: true,
    invalidate() {
      lease.active = false;
    },
    assertActive() {
      if (!lease.active) fail("harness_phase_lease_inactive");
      return true;
    },
    commit(callback) {
      lease.assertActive();
      if (typeof callback !== "function") fail("harness_phase_commit_invalid");
      return callback();
    }
  };
  return lease;
}

function createPhaseRecord(phase, harnessStartedAt, now) {
  return {
    phase,
    status: "running",
    startedOffsetMs: Math.max(0, now() - harnessStartedAt),
    completedOffsetMs: 0,
    durationMs: 0,
    code: "phase_running",
    result: null
  };
}

function finishPhaseRecord(record, harnessStartedAt, now, status, code, result) {
  record.status = status;
  record.completedOffsetMs = Math.max(
    record.startedOffsetMs,
    now() - harnessStartedAt
  );
  record.durationMs = record.completedOffsetMs - record.startedOffsetMs;
  record.code = canonicalCode(code);
  record.result = result;
  return Object.freeze({ ...record });
}

async function runPhasedHarness({
  actions,
  timeouts = DEFAULT_PHASE_TIMEOUTS,
  now = Date.now,
  heartbeat = () => {},
  terminateTree = async () => true,
  heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  terminationTimeoutMs = 5_000,
  settlementTimeoutMs = terminationTimeoutMs
}) {
  if (!actions || typeof actions !== "object" || typeof now !== "function") {
    fail("harness_actions_invalid");
  }
  for (const phase of PHASES) {
    requirePositiveTimeout(timeouts?.[phase], phase);
  }
  const harnessStartedAt = now();
  const phaseRecords = [];
  const leaseStorage = new AsyncLocalStorage();
  const context = {
    state: createLeasedState(leaseStorage),
    resourceJournal: actions.resourceJournal || null
  };
  let primaryFailure = null;
  let cleanupFailure = null;
  let cleanupPermitted = true;

  for (const phase of PHASES.slice(0, -1)) {
    const record = createPhaseRecord(phase, harnessStartedAt, now);
    const phaseStartedAt = now();
    const lease = createPhaseLease(phase);
    let stopHeartbeat = () => {};
    try {
      if (typeof actions[phase] !== "function") {
        fail("harness_phase_action_missing");
      }
      heartbeat(heartbeatEvent(phase, "phase_started", phaseStartedAt, now));
      stopHeartbeat = startPeriodicHeartbeat({
        phase,
        startedAt: phaseStartedAt,
        heartbeat,
        intervalMs: heartbeatIntervalMs,
        now,
        setIntervalImpl,
        clearIntervalImpl
      });
      const value = await executeWithTimeout({
        phase,
        timeoutMs: timeouts[phase],
        operation: (signal) =>
          leaseStorage.run(lease, () =>
            actions[phase]({
              context,
              lease,
              signal,
              heartbeat: (step) =>
                heartbeat(heartbeatEvent(phase, step, phaseStartedAt, now))
            })
          ),
        terminateTree,
        invalidate: () => lease.invalidate(),
        terminationTimeoutMs,
        settlementTimeoutMs
      });
      phaseRecords.push(
        finishPhaseRecord(
          record,
          harnessStartedAt,
          now,
          "passed",
          "phase_passed",
          validatePhaseResult(value)
        )
      );
    } catch (error) {
      primaryFailure =
        error instanceof HarnessFailure
          ? error
          : new HarnessFailure("harness_phase_unexpected_failure");
      if (primaryFailure.operationSettled === false) cleanupPermitted = false;
      phaseRecords.push(
        finishPhaseRecord(
          record,
          harnessStartedAt,
          now,
          "failed",
          primaryFailure.code,
          null
        )
      );
      break;
    } finally {
      lease.invalidate();
      stopHeartbeat();
    }
  }

  const cleanupRecord = createPhaseRecord("cleanup", harnessStartedAt, now);
  const cleanupStartedAt = now();
  const cleanupLease = createPhaseLease("cleanup");
  let stopCleanupHeartbeat = () => {};
  try {
    if (!cleanupPermitted) {
      fail("harness_cleanup_blocked_unsettled_operation");
    }
    if (typeof actions.cleanup !== "function") {
      fail("harness_cleanup_action_missing");
    }
    heartbeat(heartbeatEvent("cleanup", "phase_started", cleanupStartedAt, now));
    stopCleanupHeartbeat = startPeriodicHeartbeat({
      phase: "cleanup",
      startedAt: cleanupStartedAt,
      heartbeat,
      intervalMs: heartbeatIntervalMs,
      now,
      setIntervalImpl,
      clearIntervalImpl
    });
    const value = await executeWithTimeout({
      phase: "cleanup",
      timeoutMs: timeouts.cleanup,
      operation: (signal) =>
        leaseStorage.run(cleanupLease, () =>
          actions.cleanup({
            context,
            lease: cleanupLease,
            signal,
            heartbeat: (step) =>
              heartbeat(
                heartbeatEvent("cleanup", step, cleanupStartedAt, now)
              )
          })
        ),
      terminateTree,
      invalidate: () => cleanupLease.invalidate(),
      terminationTimeoutMs,
      settlementTimeoutMs
    });
    phaseRecords.push(
      finishPhaseRecord(
        cleanupRecord,
        harnessStartedAt,
        now,
        "passed",
        "cleanup_passed",
        validatePhaseResult(value)
      )
    );
  } catch (error) {
    cleanupFailure =
      error instanceof HarnessFailure
        ? error
        : new HarnessFailure("harness_cleanup_unexpected_failure");
    phaseRecords.push(
      finishPhaseRecord(
        cleanupRecord,
        harnessStartedAt,
        now,
        "failed",
        cleanupFailure.code,
        null
      )
    );
  } finally {
    cleanupLease.invalidate();
    stopCleanupHeartbeat();
  }

  const report = Object.freeze({
    schemaVersion: 1,
    ok: primaryFailure === null && cleanupFailure === null,
    primaryFailureCode: primaryFailure?.code || null,
    cleanupFailureCode: cleanupFailure?.code || null,
    lastCompletedPhase:
      [...phaseRecords]
        .reverse()
        .find(
          (record) =>
            record.status === "passed" && record.phase !== "cleanup"
        )?.phase || null,
    durationMs: Math.max(0, now() - harnessStartedAt),
    phases: Object.freeze([...phaseRecords])
  });
  assertClosedEvidenceReport(report);
  if (primaryFailure) {
    primaryFailure.report = report;
    throw primaryFailure;
  }
  if (cleanupFailure) {
    cleanupFailure.report = report;
    throw cleanupFailure;
  }
  return report;
}

function throwIfAborted(signal) {
  if (signal?.aborted === true) fail("harness_readiness_aborted");
}

async function withDeadline(
  operation,
  timeoutMs,
  timeoutCode,
  signal = null,
  lateResultCleanup = null
) {
  requirePositiveTimeout(timeoutMs, timeoutCode);
  if (lateResultCleanup !== null && typeof lateResultCleanup !== "function") {
    fail("harness_deadline_cleanup_invalid");
  }
  let timer;
  let onAbort;
  let deadlineExpired = false;
  throwIfAborted(signal);
  const rawOperation = Promise.resolve().then(operation);
  if (lateResultCleanup) {
    rawOperation.then(
      (value) => {
        if (deadlineExpired) {
          Promise.resolve(lateResultCleanup(value)).catch(() => {});
        }
      },
      () => {}
    );
  }
  try {
    return await Promise.race([
      rawOperation,
      new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          deadlineExpired = true;
          reject(new HarnessFailure(timeoutCode));
        }, timeoutMs);
      }),
      new Promise((resolve, reject) => {
        if (!signal) return;
        onAbort = () => {
          deadlineExpired = true;
          reject(new HarnessFailure("harness_readiness_aborted"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
      })
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

async function waitUntil({
  step,
  timeoutMs,
  pollMs,
  now,
  sleep,
  processAlive,
  probe,
  heartbeat,
  signal,
  acceptResult = (value) => value === true,
  lateResultCleanup = null
}) {
  const startedAt = now();
  while (now() - startedAt < timeoutMs) {
    throwIfAborted(signal);
    if ((await withDeadline(processAlive, Math.min(timeoutMs, 1_000),
      "harness_readiness_process_probe_timeout", signal)) !== true) {
      fail("harness_readiness_process_exited");
    }
    const result = await withDeadline(
      probe,
      Math.max(1, Math.min(timeoutMs - (now() - startedAt), 5_000)),
      `harness_readiness_${step}_probe_timeout`,
      signal,
      lateResultCleanup
    );
    if (acceptResult(result)) return result;
    heartbeat(step);
    await sleep(pollMs);
  }
  fail(`harness_readiness_${step}_timeout`);
}

async function waitForReadiness({
  probes,
  pid,
  port,
  stepTimeouts = DEFAULT_READINESS_TIMEOUTS,
  pollMs = 250,
  now = Date.now,
  sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
  heartbeat = () => {},
  signal = null
}) {
  requirePositivePid(pid);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    fail("harness_readiness_port_invalid");
  }
  if (!probes || typeof probes !== "object") {
    fail("harness_readiness_probes_invalid");
  }
  for (const name of ["processAlive", "listeners", "pgIsReady", "openAdminSession"]) {
    if (typeof probes[name] !== "function") {
      fail("harness_readiness_probe_missing");
    }
  }
  for (const step of Object.keys(DEFAULT_READINESS_TIMEOUTS)) {
    requirePositiveTimeout(stepTimeouts[step], `readiness_${step}`);
  }

  throwIfAborted(signal);
  const processAlive = () => probes.processAlive(pid, { signal });
  if (
    (await withDeadline(
      processAlive,
      stepTimeouts.process,
      "harness_readiness_process_probe_timeout",
      signal
    )) !== true
  ) {
    fail("harness_readiness_process_exited");
  }

  await waitUntil({
    step: "listener",
    timeoutMs: stepTimeouts.listener,
    pollMs,
    now,
    sleep,
    processAlive,
    heartbeat,
    signal,
    probe: async () => {
      const listeners = await probes.listeners(pid, { signal });
      if (!Array.isArray(listeners)) fail("harness_listener_probe_invalid");
      for (const listener of listeners) {
        if (
          listener?.address !== LOOPBACK_HOST ||
          Number(listener.port) !== port ||
          Number(listener.pid) !== pid
        ) {
          fail("harness_external_listener_detected");
        }
      }
      return listeners.length === 1;
    }
  });

  await waitUntil({
    step: "pg_isready",
    timeoutMs: stepTimeouts.pgIsReady,
    pollMs,
    now,
    sleep,
    processAlive,
    heartbeat,
    signal,
    probe: () => probes.pgIsReady({ host: LOOPBACK_HOST, port, pid, signal })
  });

  const closeLateSession = async (candidate) => {
    if (candidate && typeof candidate.close === "function") {
      await withDeadline(
        () => candidate.close(),
        stepTimeouts.closeSession,
        "harness_readiness_late_session_close_timeout"
      ).catch(() => {});
    }
  };
  let session;
  let primaryFailure = null;
  try {
    const candidate = await waitUntil({
      step: "admin_connection",
      timeoutMs: stepTimeouts.adminConnection,
      pollMs,
      now,
      sleep,
      processAlive,
      heartbeat,
      signal,
      acceptResult: (value) => value !== null && value !== undefined,
      lateResultCleanup: closeLateSession,
      probe: () => probes.openAdminSession({
          host: LOOPBACK_HOST,
          port,
          pid,
          signal
        })
    });
    if (
      typeof candidate.selectOne !== "function" ||
      typeof candidate.serverVersion !== "function" ||
      typeof candidate.close !== "function"
    ) {
      await closeLateSession(candidate);
      fail("harness_admin_session_invalid");
    }
    session = candidate;
    if ((await processAlive()) !== true) {
      fail("harness_readiness_process_exited");
    }
    const selected = await withDeadline(
      () => session.selectOne(),
      stepTimeouts.selectOne,
      "harness_readiness_select_one_timeout",
      signal
    );
    if (selected !== 1) fail("harness_select_one_failed");
    const version = await withDeadline(
      () => session.serverVersion(),
      stepTimeouts.serverVersion,
      "harness_readiness_server_version_timeout",
      signal
    );
    if (version !== "18.4") fail("harness_postgres_version_mismatch");
  } catch (error) {
    primaryFailure =
      error instanceof HarnessFailure
        ? error
        : new HarnessFailure("harness_readiness_unexpected_failure");
  } finally {
    if (session) {
      try {
        await withDeadline(
          () => session.close(),
          stepTimeouts.closeSession,
          "harness_readiness_session_close_timeout"
        );
      } catch {
        if (!primaryFailure) {
          primaryFailure = new HarnessFailure(
            "harness_readiness_session_close_failed"
          );
        }
      }
    }
  }
  if (primaryFailure) throw primaryFailure;
  return Object.freeze({
    code: "readiness_passed",
    checks: Object.freeze({
      processActive: true,
      loopbackListener: true,
      pgIsReady: true,
      adminConnection: true,
      selectOne: true,
      postgresVersionExact: true,
      sessionClosed: true
    }),
    metrics: Object.freeze({ postgresMajor: 18, postgresMinor: 4 })
  });
}

async function establishDpapiCustody({ adapter, material, custodyPath, ownedRoot }) {
  if (
    !adapter ||
    typeof adapter.protectAndVerify !== "function" ||
    !Buffer.isBuffer(material) ||
    material.length < 32 ||
    typeof custodyPath !== "string" ||
    !custodyPath ||
    typeof ownedRoot !== "string" ||
    !ownedRoot
  ) {
    fail("harness_dpapi_configuration_invalid");
  }
  try {
    assertOwnedPath(custodyPath, ownedRoot);
  } catch (error) {
    material.fill(0);
    throw error;
  }
  let primaryFailure = null;
  let cleanupFailure = null;
  let custodyCreatedByThisRun = false;
  let temporaryCustodyRemoved = false;
  let result;
  try {
    result = await adapter.protectAndVerify({
      material,
      custodyPath,
      scope: "CurrentUser"
    });
    custodyCreatedByThisRun = result?.custodyCreatedByThisRun === true;
    temporaryCustodyRemoved = result?.temporaryCustodyRemoved === true;
    if (
      !result ||
      result.dpapiProtected !== true ||
      result.roundTripVerified !== true ||
      result.plaintextPersisted !== false ||
      result.scope !== "CurrentUser" ||
      result.custodyCreatedByThisRun !== true
    ) {
      fail("harness_dpapi_round_trip_failed");
    }
  } catch (error) {
    primaryFailure =
      error instanceof HarnessFailure
        ? error
        : new HarnessFailure("harness_dpapi_operation_failed");
  } finally {
    if (custodyCreatedByThisRun && !temporaryCustodyRemoved) {
      try {
        if (
          typeof adapter.remove !== "function" ||
          (await adapter.remove(custodyPath)) !== true
        ) {
          throw new HarnessFailure("harness_dpapi_cleanup_unconfirmed");
        }
        temporaryCustodyRemoved = true;
      } catch (error) {
        cleanupFailure =
          error instanceof HarnessFailure
            ? error
            : new HarnessFailure("harness_dpapi_cleanup_unconfirmed");
      }
    }
    material.fill(0);
  }
  if (primaryFailure && cleanupFailure) {
    throw new HarnessFailure(primaryFailure.code, {
      cleanupFailureCode: cleanupFailure.code
    });
  }
  if (primaryFailure) throw primaryFailure;
  if (cleanupFailure) throw cleanupFailure;
  result = Object.freeze({
    ...result,
    temporaryCustodyRemoved
  });
  return Object.freeze({
    code: "dpapi_custody_passed",
    checks: Object.freeze({
      dpapiProtected: true,
      roundTripVerified: true,
      plaintextPersisted: false,
      temporaryCustodyRemoved: true,
      currentUserScope: true
    })
  });
}

function roleBootstrapContract() {
  return Object.freeze({
    idempotent: true,
    authentication: "scram-sha-256",
    roles: Object.freeze({
      provisioner: Object.freeze({
        superuser: false,
        bypassRls: false,
        createDatabase: false,
        createRole: true
      }),
      migration: Object.freeze({
        superuser: false,
        bypassRls: false,
        createDatabase: false,
        createRole: false,
        provisioningPrivileges: false
      }),
      runtime: Object.freeze({
        superuser: false,
        bypassRls: false,
        createDatabase: false,
        createRole: false,
        migrationPrivileges: false
      })
    })
  });
}

function rollbackContract() {
  return Object.freeze({
    downMigrationCreated: false,
    architecture: "forward-only",
    transactional: Object.freeze([
      "start-from-0001-0003",
      "apply-controlled-failing-0004",
      "verify-transaction-rollback",
      "compare-canonical-0001-0003"
    ]),
    operational: Object.freeze([
      "bundle-0001-0003",
      "apply-0004-on-source",
      "restore-0001-0003-to-disposable-database",
      "verify-schema-rls-indexes-constraints",
      "remove-disposable-database"
    ]),
    reapply: Object.freeze([
      "apply-0004",
      "verify-0004-checksum",
      "verify-0001-0004-schema",
      "verify-no-non-social-change"
    ])
  });
}

function windowsBackupRestoreContract() {
  return Object.freeze({
    profiles: Object.freeze(["social-schema-0003", "social-schema-0004"]),
    fileFsync: "must-be-physically-confirmed",
    directoryFsync: "pending-linux-durability-gate",
    noFollow: "pending-linux-durability-gate",
    crossProfileRefused: true,
    tamperedManifestRefused: true,
    restoredDatabaseMustBeDisposable: true
  });
}

function normalizeForComparison(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function assertOwnedTemporaryRoot(root, parent, fileSystem = fs) {
  if (typeof root !== "string" || typeof parent !== "string") {
    fail("harness_temporary_root_refused");
  }
  const resolvedRoot = path.resolve(root);
  const resolvedParent = path.resolve(parent);
  if (
    normalizeForComparison(path.dirname(resolvedRoot)) !==
      normalizeForComparison(resolvedParent) ||
    !path.basename(resolvedRoot).startsWith("ia4tube-social-3a0p-")
  ) {
    fail("harness_temporary_root_refused");
  }
  if (fileSystem.existsSync(resolvedRoot)) {
    const stat = fileSystem.lstatSync(resolvedRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      fail("harness_temporary_root_reparse_refused");
    }
  }
  return resolvedRoot;
}

function createOwnedTemporaryRoot({
  parent,
  fileSystem = fs,
  prefix = "ia4tube-social-3a0p-"
}) {
  if (
    typeof parent !== "string" ||
    !parent ||
    /^(?:\\\\|\/\/|\\\\\?\\|\\\\\.\\)/.test(parent) ||
    prefix !== "ia4tube-social-3a0p-" ||
    typeof fileSystem.mkdtempSync !== "function" ||
    typeof fileSystem.lstatSync !== "function"
  ) {
    fail("harness_temporary_parent_invalid");
  }
  const resolvedParent = path.resolve(parent);
  const parentStat = fileSystem.lstatSync(resolvedParent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    fail("harness_temporary_parent_reparse_refused");
  }
  const root = fileSystem.mkdtempSync(path.join(resolvedParent, prefix));
  try {
    assertOwnedTemporaryRoot(root, resolvedParent, fileSystem);
  } catch (error) {
    try {
      fileSystem.rmdirSync?.(root);
    } catch {
      // Never switch to recursive deletion for a root that failed validation.
    }
    throw error;
  }
  const proof = Object.freeze({ root, parent: resolvedParent });
  OWNED_ROOT_PROOFS.add(proof);
  return proof;
}

function consumeOwnedTemporaryRootProof(ownershipProof, root, parent) {
  if (
    !ownershipProof ||
    !OWNED_ROOT_PROOFS.has(ownershipProof) ||
    path.resolve(root) !== ownershipProof.root ||
    path.resolve(parent) !== ownershipProof.parent
  ) {
    fail("harness_resource_ownership_unproven");
  }
  OWNED_ROOT_PROOFS.delete(ownershipProof);
  return true;
}

function assertOwnedPath(target, ownedRoot) {
  const resolvedTarget = path.resolve(target);
  const resolvedRoot = path.resolve(ownedRoot);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (
    relative === "" ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    fail("harness_resource_path_refused");
  }
  return resolvedTarget;
}

function assertNoReparsePoints(target, ownedRoot, fileSystem = fs) {
  const resolvedTarget =
    normalizeForComparison(target) === normalizeForComparison(ownedRoot)
      ? path.resolve(target)
      : assertOwnedPath(target, ownedRoot);
  if (!fileSystem.existsSync(resolvedTarget)) return true;
  const stat = fileSystem.lstatSync(resolvedTarget);
  if (stat.isSymbolicLink()) fail("harness_reparse_point_refused");
  if (stat.isDirectory()) {
    for (const child of fileSystem.readdirSync(resolvedTarget)) {
      assertNoReparsePoints(path.join(resolvedTarget, child), ownedRoot, fileSystem);
    }
  }
  return true;
}

function removeOwnedTree(root, parent, fileSystem = fs) {
  const ownedRoot = assertOwnedTemporaryRoot(root, parent, fileSystem);
  if (!fileSystem.existsSync(ownedRoot)) return true;
  assertNoReparsePoints(ownedRoot, ownedRoot, fileSystem);
  function remove(entry) {
    const stat = fileSystem.lstatSync(entry);
    if (stat.isSymbolicLink()) fail("harness_reparse_point_refused");
    if (stat.isDirectory()) {
      for (const child of fileSystem.readdirSync(entry)) {
        remove(path.join(entry, child));
      }
      fileSystem.rmdirSync(entry);
      return;
    }
    fileSystem.unlinkSync(entry);
  }
  remove(ownedRoot);
  return !fileSystem.existsSync(ownedRoot);
}

function removeOwnedEntry(target, ownedRoot, fileSystem = fs) {
  const safeTarget = assertOwnedPath(target, ownedRoot);
  if (!fileSystem.existsSync(safeTarget)) return true;
  assertNoReparsePoints(safeTarget, ownedRoot, fileSystem);
  const remove = (entry) => {
    const stat = fileSystem.lstatSync(entry);
    if (stat.isSymbolicLink()) fail("harness_reparse_point_refused");
    if (stat.isDirectory()) {
      for (const child of fileSystem.readdirSync(entry)) {
        remove(path.join(entry, child));
      }
      fileSystem.rmdirSync(entry);
    } else {
      fileSystem.unlinkSync(entry);
    }
  };
  remove(safeTarget);
  return !fileSystem.existsSync(safeTarget);
}

function createResourceJournal({
  ownedRoot,
  parent,
  ownershipProof,
  fileSystem = fs,
  terminateProcessTree,
  terminationTimeoutMs = 5_000
}) {
  consumeOwnedTemporaryRootProof(ownershipProof, ownedRoot, parent);
  const root = assertOwnedTemporaryRoot(ownedRoot, parent, fileSystem);
  if (typeof terminateProcessTree !== "function") {
    fail("harness_resource_terminator_missing");
  }
  requirePositiveTimeout(terminationTimeoutMs, "resource_termination");
  const processes = new Set();
  const resources = [];
  let sealed = false;
  return Object.freeze({
    registerProcess(pid) {
      if (sealed) fail("harness_resource_journal_sealed");
      processes.add(requirePositivePid(pid));
      return pid;
    },
    unregisterProcess(pid) {
      processes.delete(requirePositivePid(pid));
      return true;
    },
    registerPath(target) {
      if (sealed) fail("harness_resource_journal_sealed");
      const safeTarget = assertOwnedPath(target, root);
      resources.push(safeTarget);
      return safeTarget;
    },
    processIds() {
      return Object.freeze([...processes]);
    },
    async cleanup() {
      sealed = true;
      let processesAttempted = 0;
      let processesTerminated = 0;
      let processFailures = 0;
      for (const pid of [...processes].reverse()) {
        processesAttempted += 1;
        let timer;
        const attempt = Promise.resolve()
          .then(() => terminateProcessTree(pid))
          .then((value) => value === true)
          .catch(() => false);
        const confirmed = await Promise.race([
          attempt,
          new Promise((resolve) => {
            timer = setTimeout(() => resolve(false), terminationTimeoutMs);
          })
        ]);
        clearTimeout(timer);
        if (confirmed !== true) {
          processFailures += 1;
          continue;
        }
        processes.delete(pid);
        processesTerminated += 1;
      }
      let pathsAttempted = 0;
      let pathsRemoved = 0;
      let pathFailures = 0;
      if (processFailures === 0) {
        for (const target of [...new Set(resources)].reverse()) {
          pathsAttempted += 1;
          try {
            if (removeOwnedEntry(target, root, fileSystem)) pathsRemoved += 1;
            else pathFailures += 1;
          } catch {
            pathFailures += 1;
          }
        }
      }
      let rootFailures = 0;
      if (processFailures === 0) {
        try {
          if (fileSystem.existsSync(root)) removeOwnedTree(root, parent, fileSystem);
        } catch {
          rootFailures = 1;
        }
      }
      let ownedRootRemoved = false;
      try {
        ownedRootRemoved = !fileSystem.existsSync(root);
      } catch {
        rootFailures = 1;
      }
      const failed = processFailures > 0 || pathFailures > 0 || rootFailures > 0 || !ownedRootRemoved;
      const result = Object.freeze({
        code: failed ? "resource_cleanup_incomplete" : "resource_cleanup_passed",
        counts: Object.freeze({
          processesAttempted,
          processesTerminated,
          processFailures,
          pathsAttempted,
          pathsRemoved,
          pathFailures,
          rootFailures
        }),
        checks: Object.freeze({
          allProcessesTerminated: processFailures === 0,
          allPathsRemoved: pathFailures === 0,
          ownedRootRemoved,
          filesystemCleanupDeferred: processFailures > 0
        })
      });
      if (failed) {
        throw new HarnessFailure("harness_resource_cleanup_incomplete", {
          cleanupResult: result
        });
      }
      return result;
    }
  });
}

module.exports = {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_PHASE_TIMEOUTS,
  DEFAULT_READINESS_TIMEOUTS,
  HarnessFailure,
  LOOPBACK_AUTHORIZATION,
  LOOPBACK_HOST,
  PHASES,
  assertClosedEvidenceReport,
  assertLoopbackAuthorization,
  assertNoReparsePoints,
  assertOwnedPath,
  assertOwnedTemporaryRoot,
  buildAllowlistedEnvironment,
  buildMigrationCliEnvironment,
  canonicalCode,
  createResourceJournal,
  createOwnedTemporaryRoot,
  consumeOwnedTemporaryRootProof,
  establishDpapiCustody,
  executeWithTimeout,
  fail,
  heartbeatEvent,
  isLoopbackHost,
  removeOwnedTree,
  roleBootstrapContract,
  rollbackContract,
  runPhasedHarness,
  safeSystemEnvironment,
  startPeriodicHeartbeat,
  validatePhaseResult,
  waitForReadiness,
  windowsBackupRestoreContract
};
