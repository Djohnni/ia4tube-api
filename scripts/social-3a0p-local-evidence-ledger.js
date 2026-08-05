"use strict";

// Incremental, sanitized evidence ledger for the local Social 3A-0P physical
// harness. Importing this module performs no I/O, opens no socket and starts no
// process. All filesystem and Windows ACL operations are deliberately injected
// so the caller can fail closed before PostgreSQL is touched.
const crypto = require("node:crypto");
const path = require("node:path");
const { PHASES } = require("./social-3a0p-local-harness-core");

const EXECUTION_PHASES = Object.freeze(PHASES.filter((phase) => phase !== "cleanup"));
const COMMIT = /^[0-9a-f]{40}$/;
const OPAQUE_RUN_ID = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const CODE = /^[a-z][a-z0-9_]{2,95}$/;
const DETAIL_KEY = /^[a-z][a-zA-Z0-9]{1,63}$/;
const SAFE_LABEL = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const SECRET_KEY = /(?:authorization|ciphertext|credential|database.?url|password|private.?key|secret|state.?raw|token)/i;
const SECRET_VALUE = Object.freeze([
  /postgres(?:ql)?:\/\//i,
  /authorization\s*[:=]/i,
  /bearer\s+[a-z0-9._~-]+/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /(?:password|secret|token)\s*[:=]/i
]);
const REQUIRED_SECURITY_PROOF_KEYS = Object.freeze([
  "ownerCurrentUser",
  "inheritanceProtected",
  "currentUserFullControl",
  "systemFullControl",
  "administratorsFullControl",
  "explicitAllowRuleCount",
  "currentUserAllowRuleCount",
  "systemAllowRuleCount",
  "administratorsAllowRuleCount",
  "inheritedRuleCount",
  "denyRuleCount",
  "unexpectedAllowRuleCount"
]);
const REQUIRED_ADAPTERS = Object.freeze([
  "prepareProtectedDirectory",
  "assertNoReparseComponents",
  "inspectProtectedAcl",
  "exists",
  "readFile",
  "writeFileCreateNew",
  "flushFile",
  "applyProtectedAcl",
  "replaceFileAtomic",
  "removeOwnedTemporaryFile"
]);

class EvidenceLedgerFailure extends Error {
  constructor(code) {
    const normalized = canonicalCode(code, "evidence_ledger_failed");
    super(normalized);
    this.code = normalized;
    this.name = "EvidenceLedgerFailure";
    this.mustAbortPhysicalExecution = true;
  }
}

function canonicalCode(value, fallback) {
  const candidate = String(value || "");
  return CODE.test(candidate) ? candidate : fallback;
}

function fail(code) {
  throw new EvidenceLedgerFailure(code);
}

function plainObject(value, code) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) fail(code);
  return value;
}

function exactKeys(value, expected, code) {
  const keys = Object.keys(plainObject(value, code)).sort();
  const wanted = [...expected].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    fail(code);
  }
}

function isWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function canonicalAbsolute(value, code) {
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    value.includes("\0") ||
    /^(?:\\\\\?\\|\\\\\.\\)/.test(value)
  ) {
    fail(code);
  }
  return path.resolve(value);
}

function validateLayout({ controlledRoot, evidenceRoot, cleanupRoot, runId }) {
  const controlled = canonicalAbsolute(controlledRoot, "evidence_ledger_controlled_root_invalid");
  const evidence = canonicalAbsolute(evidenceRoot, "evidence_ledger_root_invalid");
  const cleanup = canonicalAbsolute(cleanupRoot, "evidence_ledger_cleanup_root_invalid");
  if (
    evidence.toLowerCase() === controlled.toLowerCase() ||
    !isWithin(evidence, controlled) ||
    !isWithin(cleanup, controlled) ||
    isWithin(evidence, cleanup) ||
    isWithin(cleanup, evidence)
  ) {
    fail("evidence_ledger_path_scope_refused");
  }
  const evidencePath = path.join(evidence, `${runId}-incremental-evidence.json`);
  if (!isWithin(evidencePath, evidence)) fail("evidence_ledger_path_scope_refused");
  return Object.freeze({
    controlledRoot: controlled,
    evidenceRoot: evidence,
    cleanupRoot: cleanup,
    evidencePath
  });
}

function validateAdapters(candidate) {
  const adapters = plainObject(candidate, "evidence_ledger_adapters_missing");
  for (const name of REQUIRED_ADAPTERS) {
    if (typeof adapters[name] !== "function") fail("evidence_ledger_adapter_missing");
  }
  return Object.freeze(
    Object.fromEntries(REQUIRED_ADAPTERS.map((name) => [name, adapters[name]]))
  );
}

function validateSecurityProof(proof) {
  exactKeys(
    proof,
    REQUIRED_SECURITY_PROOF_KEYS,
    "evidence_ledger_acl_proof_schema_invalid"
  );
  if (
    proof.ownerCurrentUser !== true ||
    proof.inheritanceProtected !== true ||
    proof.currentUserFullControl !== true ||
    proof.systemFullControl !== true ||
    proof.administratorsFullControl !== true ||
    proof.explicitAllowRuleCount !== 3 ||
    proof.currentUserAllowRuleCount !== 1 ||
    proof.systemAllowRuleCount !== 1 ||
    proof.administratorsAllowRuleCount !== 1 ||
    proof.inheritedRuleCount !== 0 ||
    proof.denyRuleCount !== 0 ||
    proof.unexpectedAllowRuleCount !== 0
  ) {
    fail("evidence_ledger_acl_refused");
  }
  return true;
}

function assertSanitizedString(value) {
  if (
    typeof value !== "string" ||
    value.length > 160 ||
    value.includes("\0") ||
    SECRET_VALUE.some((pattern) => pattern.test(value))
  ) {
    fail("evidence_ledger_secret_or_unsafe_value_refused");
  }
}

function assertSanitizedTree(value, key = "root", depth = 0) {
  if (depth > 8 || SECRET_KEY.test(key)) {
    fail("evidence_ledger_secret_or_unsafe_key_refused");
  }
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) fail("evidence_ledger_metric_invalid");
    return true;
  }
  if (typeof value === "string") {
    assertSanitizedString(value);
    return true;
  }
  if (Array.isArray(value)) {
    if (value.length > 128) fail("evidence_ledger_array_invalid");
    for (const item of value) assertSanitizedTree(item, key, depth + 1);
    return true;
  }
  plainObject(value, "evidence_ledger_value_invalid");
  if (Object.keys(value).length > 128) fail("evidence_ledger_object_invalid");
  for (const [childKey, child] of Object.entries(value)) {
    if (!DETAIL_KEY.test(childKey) || SECRET_KEY.test(childKey)) {
      fail("evidence_ledger_secret_or_unsafe_key_refused");
    }
    assertSanitizedTree(child, childKey, depth + 1);
  }
  return true;
}

function validateMetricPatch(value) {
  const metrics = plainObject(value, "evidence_ledger_metrics_invalid");
  assertSanitizedTree(metrics, "metrics");
  for (const item of flattenValues(metrics)) {
    if (typeof item === "string" && !SAFE_LABEL.test(item)) {
      fail("evidence_ledger_metric_label_invalid");
    }
  }
  return metrics;
}

function* flattenValues(value) {
  if (Array.isArray(value)) {
    for (const item of value) yield* flattenValues(item);
  } else if (value && Object.getPrototypeOf(value) === Object.prototype) {
    for (const item of Object.values(value)) yield* flattenValues(item);
  } else {
    yield value;
  }
}

function mergePlain(base, patch) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    merged[key] = (
      value && Object.getPrototypeOf(value) === Object.prototype &&
      merged[key] && Object.getPrototypeOf(merged[key]) === Object.prototype
    ) ? mergePlain(merged[key], value) : value;
  }
  return merged;
}

function validateResidues(value) {
  const residues = plainObject(value, "evidence_ledger_residues_invalid");
  for (const [key, count] of Object.entries(residues)) {
    if (
      !DETAIL_KEY.test(key) ||
      SECRET_KEY.test(key) ||
      !Number.isSafeInteger(count) ||
      count < 0
    ) {
      fail("evidence_ledger_residues_invalid");
    }
  }
  return residues;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])])
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function hashBytes(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function nowMilliseconds(clock, previous) {
  const observed = Number(clock());
  if (!Number.isSafeInteger(observed) || observed < 0) {
    fail("evidence_ledger_clock_invalid");
  }
  return Math.max(previous, observed);
}

function iso(milliseconds) {
  return new Date(milliseconds).toISOString();
}

function requiredCommit(value, code) {
  if (!COMMIT.test(String(value))) fail(code);
  return String(value);
}

function validateIdentity({ runId, harnessCommit, productCommit }) {
  if (!OPAQUE_RUN_ID.test(String(runId || ""))) fail("evidence_ledger_run_id_invalid");
  return Object.freeze({
    runId,
    harnessCommit: requiredCommit(
      harnessCommit,
      "evidence_ledger_harness_commit_invalid"
    ),
    productCommit: requiredCommit(
      productCommit,
      "evidence_ledger_product_commit_invalid"
    )
  });
}

function createSanitizedEvidenceLedger(options = {}) {
  const identity = validateIdentity(options);
  const layout = validateLayout({ ...options, runId: identity.runId });
  const adapters = validateAdapters(options.adapters);
  const clock = typeof options.now === "function" ? options.now : Date.now;
  const nonce = typeof options.nonce === "function"
    ? options.nonce
    : () => crypto.randomBytes(8).toString("hex");
  let lastObservedMs = nowMilliseconds(clock, 0);
  const startedMs = lastObservedMs;
  let initialized = false;
  let mutating = false;
  let lastPersistedSha256 = null;
  let persistenceFailureCode = null;
  let temporaryCleanupFailureCode = null;
  const phaseStartMilliseconds = new Map();
  const state = {
    schemaVersion: 1,
    runId: identity.runId,
    harnessCommit: identity.harnessCommit,
    productCommit: identity.productCommit,
    revision: 0,
    status: "initialized",
    startedAtUtc: iso(startedMs),
    updatedAtUtc: iso(startedMs),
    durationMs: 0,
    currentPhase: null,
    lastCompletedPhase: null,
    primaryFailureCode: null,
    persistenceFailureCode: null,
    temporaryCleanupFailureCode: null,
    cleanup: {
      started: false,
      completed: false,
      status: "not_started",
      failureCode: null
    },
    residues: {},
    metrics: {},
    phases: [],
    externalSystemsChanged: false
  };

  function tick() {
    lastObservedMs = nowMilliseconds(clock, lastObservedMs);
    state.updatedAtUtc = iso(lastObservedMs);
    state.durationMs = lastObservedMs - startedMs;
    return lastObservedMs;
  }

  function snapshotPayload(nextRevision = state.revision) {
    const payload = clone({ ...state, revision: nextRevision });
    assertSanitizedTree(payload);
    return canonicalize(payload);
  }

  async function cleanupTemporary(tempPath) {
    if (!tempPath) return true;
    try {
      if (await adapters.exists(tempPath)) {
        const removed = await adapters.removeOwnedTemporaryFile({
          temporaryPath: tempPath,
          evidenceRoot: layout.evidenceRoot
        });
        if (removed !== true || await adapters.exists(tempPath)) {
          throw new EvidenceLedgerFailure(
            "evidence_ledger_temporary_cleanup_failed"
          );
        }
      }
      return true;
    } catch {
      temporaryCleanupFailureCode ||= "evidence_ledger_temporary_cleanup_failed";
      state.temporaryCleanupFailureCode = temporaryCleanupFailureCode;
      state.residues = {
        ...state.residues,
        evidenceTemporaryFiles: Math.max(
          1,
          Number(state.residues.evidenceTemporaryFiles || 0)
        )
      };
      return false;
    }
  }

  async function persist() {
    const nextRevision = state.revision + 1;
    const nextPayload = snapshotPayload(nextRevision);
    const payloadJson = canonicalJson(nextPayload);
    const payloadSha256 = hashBytes(Buffer.from(payloadJson, "utf8"));
    const document = canonicalJson({
      ...nextPayload,
      integritySha256: payloadSha256
    });
    const bytes = Buffer.from(`${document}\n`, "utf8");
    const candidateNonce = String(nonce() || "");
    if (!/^[0-9a-f]{16,64}$/.test(candidateNonce)) {
      fail("evidence_ledger_nonce_invalid");
    }
    const temporaryPath = path.join(
      layout.evidenceRoot,
      `.${path.basename(layout.evidencePath)}.${nextRevision}.${candidateNonce}.tmp`
    );
    if (!isWithin(temporaryPath, layout.evidenceRoot)) {
      fail("evidence_ledger_path_scope_refused");
    }

    try {
      if (
        await adapters.assertNoReparseComponents({
          controlledRoot: layout.controlledRoot,
          evidenceRoot: layout.evidenceRoot,
          cleanupRoot: layout.cleanupRoot,
          evidencePath: layout.evidencePath,
          temporaryPath
        }) !== true
      ) {
        fail("evidence_ledger_reparse_refused");
      }
      const targetExists = await adapters.exists(layout.evidencePath);
      if (lastPersistedSha256 === null && targetExists) {
        fail("evidence_ledger_existing_target_refused");
      }
      if (lastPersistedSha256 !== null) {
        if (!targetExists) fail("evidence_ledger_previous_revision_missing");
        const previous = await adapters.readFile(layout.evidencePath);
        if (hashBytes(previous) !== lastPersistedSha256) {
          fail("evidence_ledger_previous_revision_changed");
        }
      }
      await adapters.writeFileCreateNew(temporaryPath, bytes);
      await adapters.flushFile(temporaryPath);
      if (await adapters.applyProtectedAcl(temporaryPath) !== true) {
        fail("evidence_ledger_acl_application_failed");
      }
      validateSecurityProof(await adapters.inspectProtectedAcl(temporaryPath));
      const promoted = await adapters.replaceFileAtomic({
        temporaryPath,
        targetPath: layout.evidencePath,
        expectedPreviousSha256: lastPersistedSha256
      });
      exactKeys(
        promoted,
        ["committed", "previousMatched"],
        "evidence_ledger_atomic_result_invalid"
      );
      if (promoted.committed !== true || promoted.previousMatched !== true) {
        fail("evidence_ledger_atomic_replace_failed");
      }
      if (
        await adapters.exists(temporaryPath) ||
        !(await adapters.exists(layout.evidencePath))
      ) {
        fail("evidence_ledger_atomic_replace_unconfirmed");
      }
      validateSecurityProof(await adapters.inspectProtectedAcl(layout.evidencePath));
      const persisted = await adapters.readFile(layout.evidencePath);
      if (!Buffer.isBuffer(persisted) || !persisted.equals(bytes)) {
        fail("evidence_ledger_persisted_bytes_mismatch");
      }
      state.revision = nextRevision;
      lastPersistedSha256 = hashBytes(persisted);
      return Object.freeze({
        code: "evidence_ledger_persisted",
        revision: nextRevision,
        evidenceSha256: lastPersistedSha256,
        payloadSha256
      });
    } catch (error) {
      const temporaryCleaned = await cleanupTemporary(temporaryPath);
      const code = error instanceof EvidenceLedgerFailure
        ? error.code
        : "evidence_ledger_persistence_failed";
      persistenceFailureCode ||= code;
      state.persistenceFailureCode = persistenceFailureCode;
      state.status = "failed";
      state.primaryFailureCode ||= persistenceFailureCode;
      throw new EvidenceLedgerFailure(
        temporaryCleaned ? code : temporaryCleanupFailureCode
      );
    }
  }

  async function mutate(callback) {
    if (mutating) fail("evidence_ledger_concurrent_update_refused");
    mutating = true;
    try {
      return await callback();
    } finally {
      mutating = false;
    }
  }

  function requireInitialized() {
    if (!initialized) fail("evidence_ledger_not_initialized");
  }

  function applyEvidence({ metrics = {}, residues = {} } = {}) {
    const safeMetrics = validateMetricPatch(metrics);
    const safeResidues = validateResidues(residues);
    state.metrics = mergePlain(state.metrics, safeMetrics);
    state.residues = { ...state.residues, ...safeResidues };
  }

  async function initialize({ metrics = {}, residues = {} } = {}) {
    return mutate(async () => {
      if (initialized) fail("evidence_ledger_already_initialized");
      applyEvidence({ metrics, residues });
      try {
        if (
          await adapters.prepareProtectedDirectory({
            controlledRoot: layout.controlledRoot,
            evidenceRoot: layout.evidenceRoot
          }) !== true
        ) {
          fail("evidence_ledger_root_preparation_failed");
        }
        if (
          await adapters.assertNoReparseComponents({
            controlledRoot: layout.controlledRoot,
            evidenceRoot: layout.evidenceRoot,
            cleanupRoot: layout.cleanupRoot,
            evidencePath: layout.evidencePath,
            temporaryPath: null
          }) !== true
        ) {
          fail("evidence_ledger_reparse_refused");
        }
        validateSecurityProof(await adapters.inspectProtectedAcl(layout.evidenceRoot));
        tick();
        const result = await persist();
        initialized = true;
        return result;
      } catch (error) {
        const code = error instanceof EvidenceLedgerFailure
          ? error.code
          : "evidence_ledger_initialization_failed";
        persistenceFailureCode ||= code;
        state.persistenceFailureCode = persistenceFailureCode;
        state.primaryFailureCode ||= persistenceFailureCode;
        state.status = "failed";
        throw new EvidenceLedgerFailure(code);
      }
    });
  }

  async function beginPhase(phase, evidence = {}) {
    return mutate(async () => {
      requireInitialized();
      if (phase === "cleanup") return beginCleanup(evidence, true);
      if (
        !EXECUTION_PHASES.includes(phase) ||
        state.currentPhase !== null ||
        state.primaryFailureCode !== null ||
        state.cleanup.started
      ) {
        fail("evidence_ledger_phase_start_refused");
      }
      const nextPhase = EXECUTION_PHASES[state.phases.length];
      if (phase !== nextPhase) fail("evidence_ledger_phase_sequence_invalid");
      applyEvidence(evidence);
      const started = tick();
      state.currentPhase = phase;
      state.status = "running";
      state.phases.push({
        phase,
        status: "running",
        startedAtUtc: iso(started),
        completedAtUtc: null,
        durationMs: 0,
        code: "phase_running"
      });
      phaseStartMilliseconds.set(phase, started);
      return persist();
    });
  }

  async function finishPhase(phase, { status, code, metrics = {}, residues = {} } = {}) {
    return mutate(async () => {
      requireInitialized();
      if (
        !EXECUTION_PHASES.includes(phase) ||
        state.currentPhase !== phase ||
        !["passed", "failed"].includes(status)
      ) {
        fail("evidence_ledger_phase_finish_refused");
      }
      const safeCode = canonicalCode(
        code,
        status === "passed" ? "phase_passed" : "harness_phase_failed"
      );
      if (safeCode !== String(code || "")) fail("evidence_ledger_phase_code_invalid");
      applyEvidence({ metrics, residues });
      const completed = tick();
      const record = state.phases.at(-1);
      record.status = status;
      record.completedAtUtc = iso(completed);
      record.durationMs = completed - phaseStartMilliseconds.get(phase);
      record.code = safeCode;
      state.currentPhase = null;
      if (status === "passed") {
        state.lastCompletedPhase = phase;
      } else {
        state.primaryFailureCode = safeCode;
        state.status = "failed";
      }
      return persist();
    });
  }

  async function beginCleanup(evidence = {}, alreadyMutating = false) {
    const operation = async () => {
      requireInitialized();
      if (state.currentPhase !== null || state.cleanup.started) {
        fail("evidence_ledger_cleanup_start_refused");
      }
      applyEvidence(evidence);
      tick();
      state.cleanup.started = true;
      state.cleanup.status = "running";
      state.status = state.primaryFailureCode ? "failed" : "running";
      return persist();
    };
    return alreadyMutating ? operation() : mutate(operation);
  }

  async function finishCleanup({ status, code, metrics = {}, residues = {} } = {}) {
    return mutate(async () => {
      requireInitialized();
      if (
        !state.cleanup.started ||
        state.cleanup.completed ||
        !["passed", "failed"].includes(status)
      ) {
        fail("evidence_ledger_cleanup_finish_refused");
      }
      const safeCode = canonicalCode(
        code,
        status === "passed" ? "cleanup_passed" : "harness_cleanup_failed"
      );
      if (safeCode !== String(code || "")) fail("evidence_ledger_cleanup_code_invalid");
      applyEvidence({ metrics, residues });
      tick();
      state.cleanup.completed = true;
      state.cleanup.status = status;
      state.cleanup.failureCode = status === "failed" ? safeCode : null;
      if (status === "failed") {
        state.primaryFailureCode ||= safeCode;
        state.status = "failed";
      } else if (!state.primaryFailureCode && !persistenceFailureCode) {
        state.status = state.phases.length === EXECUTION_PHASES.length
          ? "complete"
          : "stopped";
      } else {
        state.status = "failed";
      }
      return persist();
    });
  }

  async function recordAvailableEvidence(evidence = {}) {
    return mutate(async () => {
      requireInitialized();
      applyEvidence(evidence);
      tick();
      return persist();
    });
  }

  function sanitizedSnapshot() {
    return Object.freeze(clone(snapshotPayload()));
  }

  return Object.freeze({
    initialize,
    beginPhase,
    finishPhase,
    beginCleanup,
    finishCleanup,
    recordAvailableEvidence,
    snapshot: sanitizedSnapshot,
    getPersistenceFailureCode: () => persistenceFailureCode,
    getTemporaryCleanupFailureCode: () => temporaryCleanupFailureCode,
    paths: Object.freeze({ ...layout })
  });
}

module.exports = {
  EvidenceLedgerFailure,
  REQUIRED_ADAPTERS,
  REQUIRED_SECURITY_PROOF_KEYS,
  createSanitizedEvidenceLedger
};
