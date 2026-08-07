"use strict";

// Incremental, sanitized evidence ledger for the local Social 3A-0P physical
// harness. Importing this module performs no I/O, opens no socket and starts no
// process. All filesystem and Windows ACL operations are deliberately injected
// so the caller can fail closed before PostgreSQL is touched.
const crypto = require("node:crypto");
const path = require("node:path");
const { PHASES } = require("./social-3a0p-local-harness-core");
const {
  bootstrapStageFailure,
  createBootstrapDiagnostic,
  validateBootstrapDiagnostic
} = require("./social-3a0p-local-evidence-bootstrap-diagnostic");
const {
  createPersistenceDiagnostic,
  persistenceStageFailure,
  validatePersistenceDiagnostic
} = require("./social-3a0p-local-evidence-persistence-diagnostic");
const {
  validateFileReplaceExceptionDiagnostic
} = require("./social-3a0p-local-file-replace-diagnostic");
const {
  validateFileReplaceArgumentDiagnostic
} = require("./social-3a0p-local-file-replace-argument-diagnostic");
const {
  createTempValidationFailureMetadata,
  createTempValidationDiagnostic,
  validateTempValidationDiagnostic
} = require("./social-3a0p-local-temp-validation-diagnostic");

const EXECUTION_PHASES = Object.freeze(PHASES.filter((phase) => phase !== "cleanup"));
const COMMIT = /^[0-9a-f]{40}$/;
const OPAQUE_RUN_ID = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const REPLACEMENT_TRANSACTION_ID = /^[0-9a-f]{32}$/;
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
  "prepareFileReplacement",
  "replaceFileAtomic",
  "finalizeFileReplacement",
  "rollbackFileReplacement",
  "removeOwnedTemporaryFile",
  "cleanupFailedInitialization"
]);

class EvidenceLedgerFailure extends Error {
  constructor(code, options = {}) {
    const normalized = canonicalCode(code, "evidence_ledger_failed");
    super(normalized);
    this.code = normalized;
    this.name = "EvidenceLedgerFailure";
    this.mustAbortPhysicalExecution = true;
    if (options.bootstrapDiagnostic) {
      validateBootstrapDiagnostic(options.bootstrapDiagnostic);
      Object.defineProperty(this, "bootstrapDiagnostic", {
        configurable: false,
        enumerable: false,
        writable: false,
        value: options.bootstrapDiagnostic
      });
    }
    if (options.persistenceDiagnostic) {
      validatePersistenceDiagnostic(options.persistenceDiagnostic);
      Object.defineProperty(this, "persistenceDiagnostic", {
        configurable: false,
        enumerable: false,
        writable: false,
        value: options.persistenceDiagnostic
      });
    }
    if (options.tempValidationDiagnostic) {
      validateTempValidationDiagnostic(options.tempValidationDiagnostic);
      Object.defineProperty(this, "tempValidationDiagnostic", {
        configurable: false,
        enumerable: false,
        writable: false,
        value: options.tempValidationDiagnostic
      });
    }
    if (options.fileReplaceDiagnostic) {
      validateFileReplaceExceptionDiagnostic(options.fileReplaceDiagnostic);
      Object.defineProperty(this, "fileReplaceDiagnostic", {
        configurable: false,
        enumerable: false,
        writable: false,
        value: options.fileReplaceDiagnostic
      });
    }
    if (options.fileReplaceArgumentDiagnostic) {
      validateFileReplaceArgumentDiagnostic(
        options.fileReplaceArgumentDiagnostic
      );
      Object.defineProperty(this, "fileReplaceArgumentDiagnostic", {
        configurable: false,
        enumerable: false,
        writable: false,
        value: options.fileReplaceArgumentDiagnostic
      });
    }
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
    if (!tempPath) {
      return Object.freeze({
        attempted: false,
        completed: false,
        error: null
      });
    }
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
      return Object.freeze({
        attempted: true,
        completed: true,
        error: null
      });
    } catch (error) {
      temporaryCleanupFailureCode ||= "evidence_ledger_temporary_cleanup_failed";
      state.temporaryCleanupFailureCode = temporaryCleanupFailureCode;
      state.residues = {
        ...state.residues,
        evidenceTemporaryFiles: Math.max(
          1,
          Number(state.residues.evidenceTemporaryFiles || 0)
        )
      };
      return Object.freeze({
        attempted: true,
        completed: false,
        error
      });
    }
  }

  async function inspectPersistenceFailureState(
    temporaryPath,
    backupPath,
    recoveryPath
  ) {
    let previousLedgerPreserved = false;
    let temporaryFilePresent = false;
    let backupFilePresent = false;
    let backupMatchesPreviousRevision = false;
    let recoveryFilePresent = false;
    try {
      if (
        lastPersistedSha256 !== null &&
        await adapters.exists(layout.evidencePath)
      ) {
        const previous = await adapters.readFile(layout.evidencePath);
        previousLedgerPreserved =
          Buffer.isBuffer(previous) &&
          hashBytes(previous) === lastPersistedSha256;
      }
    } catch {
      previousLedgerPreserved = false;
    }
    try {
      temporaryFilePresent = Boolean(
        temporaryPath && await adapters.exists(temporaryPath)
      );
    } catch {
      temporaryFilePresent = false;
    }
    try {
      backupFilePresent = Boolean(
        backupPath && await adapters.exists(backupPath)
      );
      if (backupFilePresent && lastPersistedSha256 !== null) {
        const backup = await adapters.readFile(backupPath);
        backupMatchesPreviousRevision =
          Buffer.isBuffer(backup) &&
          hashBytes(backup) === lastPersistedSha256;
      }
    } catch {
      backupMatchesPreviousRevision = false;
    }
    try {
      recoveryFilePresent = Boolean(
        recoveryPath && await adapters.exists(recoveryPath)
      );
    } catch {
      recoveryFilePresent = false;
    }
    return Object.freeze({
      previousLedgerPreserved,
      temporaryFilePresent,
      backupFilePresent,
      backupMatchesPreviousRevision,
      recoveryFilePresent
    });
  }

  async function persist({ bootstrap = false } = {}) {
    let bootstrapFailureCode = "evidence_ledger_first_revision_failed";
    let persistenceFailureStageCode =
      "evidence_second_revision_prepare_failed";
    const nextRevision = state.revision + 1;
    let temporaryPath = null;
    let backupPath = null;
    let recoveryPath = null;
    let payloadSha256 = null;
    let bytes = null;
    let replacementTransactionId = null;
    let replacementFinalized = false;
    let replacementOccurred = false;
    let tempValidationFailure = null;
    const captureTempValidationFailure = (
      stage,
      failureClass = "unknown",
      failureCode = "UNKNOWN",
      actualConditionClass = "unknown"
    ) => {
      tempValidationFailure = createTempValidationFailureMetadata({
        tempValidationStage: stage,
        sanitizedFailureClass: failureClass,
        sanitizedFailureCode: failureCode,
        actualConditionClass
      });
    };
    const replacement = {
      explicitBackupPrepared: false,
      explicitBackupValidated: false,
      explicitBackupMatchesPreviousRevision: false,
      newLedgerValidated: false,
      rollbackRequired: false,
      rollbackAttempted: false,
      rollbackCompleted: false,
      previousLedgerRestored: false,
      failedCandidatePreserved: false,
      failedCandidateRemovedAfterRestore: false,
      backupRemovedAfterValidation: false
    };

    try {
      const nextPayload = snapshotPayload(nextRevision);
      persistenceFailureStageCode =
        "evidence_second_revision_serialize_failed";
      const payloadJson = canonicalJson(nextPayload);
      payloadSha256 = hashBytes(Buffer.from(payloadJson, "utf8"));
      const document = canonicalJson({
        ...nextPayload,
        integritySha256: payloadSha256
      });
      bytes = Buffer.from(`${document}\n`, "utf8");
      const replacementSha256 = hashBytes(bytes);

      persistenceFailureStageCode = "evidence_second_revision_prepare_failed";
      let candidateNonce;
      try {
        candidateNonce = String(nonce() || "");
      } catch (error) {
        captureTempValidationFailure(
          "second_revision_temp_ownership_marker_validate",
          "ownership",
          "UNKNOWN",
          "unknown"
        );
        throw error;
      }
      if (!/^[0-9a-f]{16,64}$/.test(candidateNonce)) {
        captureTempValidationFailure(
          "second_revision_temp_ownership_marker_validate",
          "ownership",
          "MISMATCH",
          "mismatch"
        );
        fail("evidence_ledger_nonce_invalid");
      }
      let artifactStem;
      try {
        artifactStem = `.${path.basename(layout.evidencePath)}.${nextRevision}.${candidateNonce}`;
        temporaryPath = path.join(layout.evidenceRoot, `${artifactStem}.tmp`);
        backupPath = path.join(layout.evidenceRoot, `${artifactStem}.previous.bak`);
        recoveryPath = path.join(layout.evidenceRoot, `${artifactStem}.failed.bak`);
      } catch (error) {
        captureTempValidationFailure(
          "second_revision_temp_canonicalize",
          "filesystem",
          "UNKNOWN",
          "unknown"
        );
        throw error;
      }
      const replacementPaths = [
        temporaryPath,
        layout.evidencePath,
        backupPath,
        recoveryPath
      ];
      if (
        replacementPaths.some(
          (candidate) =>
            !path.isAbsolute(candidate) || path.resolve(candidate) !== candidate
        )
      ) {
        captureTempValidationFailure(
          "second_revision_temp_canonicalize",
          "filesystem",
          "EINVAL",
          "invalid"
        );
        fail("evidence_ledger_path_scope_refused");
      }
      if (
        !isWithin(temporaryPath, layout.evidenceRoot) ||
        !isWithin(backupPath, layout.evidenceRoot) ||
        !isWithin(recoveryPath, layout.evidenceRoot)
      ) {
        captureTempValidationFailure(
          "second_revision_temp_scope_validate",
          "harness_validation",
          "OUTSIDE_SCOPE",
          "outside_scope"
        );
        fail("evidence_ledger_path_scope_refused");
      }
      const replacementDirectories = replacementPaths.map(
        (candidate) => path.dirname(candidate).toLowerCase()
      );
      if (
        replacementDirectories.some(
          (candidate) => candidate !== replacementDirectories[0]
        )
      ) {
        captureTempValidationFailure(
          "second_revision_temp_same_directory_validate",
          "filesystem",
          "MISMATCH",
          "different"
        );
        fail("evidence_ledger_path_scope_refused");
      }
      const replacementVolumes = replacementPaths.map(
        (candidate) => path.parse(candidate).root.toLowerCase()
      );
      if (
        replacementVolumes.some(
          (candidate) => candidate !== replacementVolumes[0]
        )
      ) {
        captureTempValidationFailure(
          "second_revision_temp_same_volume_validate",
          "filesystem",
          "MISMATCH",
          "different"
        );
        fail("evidence_ledger_path_scope_refused");
      }

      bootstrapFailureCode = "evidence_root_reparse_detected";
      let noReparseComponents;
      try {
        noReparseComponents = await adapters.assertNoReparseComponents({
          controlledRoot: layout.controlledRoot,
          evidenceRoot: layout.evidenceRoot,
          cleanupRoot: layout.cleanupRoot,
          evidencePath: layout.evidencePath,
          temporaryPath,
          backupPath,
          recoveryPath
        });
      } catch (error) {
        captureTempValidationFailure(
          "second_revision_temp_reparse_audit",
          "filesystem",
          String(error?.code || "").toUpperCase(),
          "unknown"
        );
        throw error;
      }
      if (noReparseComponents !== true) {
        captureTempValidationFailure(
          "second_revision_temp_reparse_audit",
          "filesystem",
          "REPARSE_DETECTED",
          "present"
        );
        fail("evidence_ledger_reparse_refused");
      }
      bootstrapFailureCode = "evidence_ledger_first_revision_failed";
      let targetExists;
      try {
        targetExists = await adapters.exists(layout.evidencePath);
      } catch (error) {
        captureTempValidationFailure(
          "second_revision_previous_ledger_presence_validate",
          "filesystem",
          String(error?.code || "").toUpperCase(),
          "unknown"
        );
        throw error;
      }
      if (lastPersistedSha256 === null && targetExists) {
        fail("evidence_ledger_existing_target_refused");
      }
      if (lastPersistedSha256 !== null) {
        if (!targetExists) {
          captureTempValidationFailure(
            "second_revision_previous_ledger_presence_validate",
            "filesystem",
            "ENOENT",
            "absent"
          );
          fail("evidence_ledger_previous_revision_missing");
        }
        let previous;
        try {
          previous = await adapters.readFile(layout.evidencePath);
        } catch (error) {
          captureTempValidationFailure(
            "second_revision_previous_ledger_integrity_validate",
            "integrity",
            String(error?.code || "").toUpperCase(),
            "unknown"
          );
          throw error;
        }
        if (
          !Buffer.isBuffer(previous) ||
          hashBytes(previous) !== lastPersistedSha256
        ) {
          captureTempValidationFailure(
            "second_revision_previous_ledger_integrity_validate",
            "integrity",
            "HASH_MISMATCH",
            "mismatch"
          );
          fail("evidence_ledger_previous_revision_changed");
        }
      }

      persistenceFailureStageCode =
        "evidence_second_revision_temp_create_failed";
      bootstrapFailureCode = "evidence_ledger_first_write_failed";
      try {
        await adapters.writeFileCreateNew(temporaryPath, bytes);
      } catch (error) {
        throw persistenceStageFailure(
          error,
          error?.code === "EEXIST"
            ? "evidence_second_revision_temp_create_failed"
            : "evidence_second_revision_write_failed"
        );
      }

      persistenceFailureStageCode = "evidence_second_revision_flush_failed";
      bootstrapFailureCode = "evidence_ledger_flush_failed";
      try {
        await adapters.flushFile(temporaryPath);
      } catch (error) {
        captureTempValidationFailure(
          "second_revision_temp_handle_closed_validate",
          "filesystem",
          String(error?.systemErrorCode || error?.code || "").toUpperCase(),
          "open_or_unknown"
        );
        throw error;
      }

      persistenceFailureStageCode =
        "evidence_second_revision_pre_replace_validation_failed";
      bootstrapFailureCode = "evidence_root_acl_protection_failed";
      let aclApplied;
      try {
        aclApplied = await adapters.applyProtectedAcl(temporaryPath);
      } catch (error) {
        captureTempValidationFailure(
          "second_revision_temp_acl_validate",
          "acl",
          String(error?.code || "").toUpperCase(),
          "unknown"
        );
        throw error;
      }
      if (aclApplied !== true) {
        captureTempValidationFailure(
          "second_revision_temp_acl_validate",
          "acl",
          "ACL_INVALID",
          "invalid"
        );
        fail("evidence_ledger_acl_application_failed");
      }
      bootstrapFailureCode = "evidence_root_acl_validation_failed";
      let temporarySecurityProof;
      try {
        temporarySecurityProof = await adapters.inspectProtectedAcl(temporaryPath);
        exactKeys(
          temporarySecurityProof,
          REQUIRED_SECURITY_PROOF_KEYS,
          "evidence_ledger_acl_proof_schema_invalid"
        );
      } catch (error) {
        captureTempValidationFailure(
          "second_revision_temp_acl_validate",
          "acl",
          String(error?.code || "").toUpperCase(),
          "unknown"
        );
        throw error;
      }
      if (temporarySecurityProof.ownerCurrentUser !== true) {
        captureTempValidationFailure(
          "second_revision_temp_owner_validate",
          "ownership",
          "OWNER_INVALID",
          "invalid"
        );
        fail("evidence_ledger_acl_refused");
      }
      try {
        validateSecurityProof(temporarySecurityProof);
      } catch (error) {
        captureTempValidationFailure(
          "second_revision_temp_acl_validate",
          "acl",
          "ACL_INVALID",
          "invalid"
        );
        throw error;
      }
      let temporaryExists;
      try {
        temporaryExists = await adapters.exists(temporaryPath);
      } catch (error) {
        captureTempValidationFailure(
          "second_revision_temp_exists",
          "filesystem",
          String(error?.code || "").toUpperCase(),
          "unknown"
        );
        throw error;
      }
      if (temporaryExists !== true) {
        captureTempValidationFailure(
          "second_revision_temp_exists",
          "filesystem",
          "ENOENT",
          "absent"
        );
        fail("evidence_ledger_temporary_validation_failed");
      }
      let staged;
      try {
        staged = await adapters.readFile(temporaryPath);
      } catch (error) {
        captureTempValidationFailure(
          "second_revision_temp_regular_file_validate",
          "filesystem",
          String(error?.code || "").toUpperCase(),
          "unknown"
        );
        throw error;
      }
      if (!Buffer.isBuffer(staged)) {
        captureTempValidationFailure(
          "second_revision_temp_regular_file_validate",
          "filesystem",
          "MISMATCH",
          "invalid"
        );
        fail("evidence_ledger_temporary_validation_failed");
      }
      if (staged.length !== bytes.length) {
        captureTempValidationFailure(
          "second_revision_temp_size_validate",
          "integrity",
          "SIZE_MISMATCH",
          "mismatch"
        );
        fail("evidence_ledger_temporary_validation_failed");
      }
      if (!staged.equals(bytes) || hashBytes(staged) !== replacementSha256) {
        captureTempValidationFailure(
          "second_revision_temp_hash_validate",
          "integrity",
          "HASH_MISMATCH",
          "mismatch"
        );
        fail("evidence_ledger_temporary_validation_failed");
      }
      let temporaryDocument;
      try {
        temporaryDocument = JSON.parse(staged.toString("utf8"));
      } catch {
        captureTempValidationFailure(
          "second_revision_temp_parse",
          "serialization",
          "EINVAL",
          "invalid"
        );
        fail("evidence_ledger_temporary_validation_failed");
      }
      if (
        !temporaryDocument ||
        Object.getPrototypeOf(temporaryDocument) !== Object.prototype ||
        Object.keys(temporaryDocument).sort().join("\0") !==
          Object.keys(JSON.parse(document)).sort().join("\0")
      ) {
        captureTempValidationFailure(
          "second_revision_temp_structure_validate",
          "serialization",
          "MISMATCH",
          "invalid"
        );
        fail("evidence_ledger_temporary_validation_failed");
      }
      if (temporaryDocument.revision !== nextRevision) {
        captureTempValidationFailure(
          "second_revision_temp_revision_validate",
          "integrity",
          "REVISION_MISMATCH",
          "mismatch"
        );
        fail("evidence_ledger_temporary_validation_failed");
      }
      if (
        temporaryDocument.runId !== identity.runId ||
        temporaryDocument.harnessCommit !== identity.harnessCommit ||
        temporaryDocument.productCommit !== identity.productCommit
      ) {
        captureTempValidationFailure(
          "second_revision_temp_run_identity_validate",
          "integrity",
          "RUN_IDENTITY_MISMATCH",
          "mismatch"
        );
        fail("evidence_ledger_temporary_validation_failed");
      }

      persistenceFailureStageCode =
        "evidence_second_revision_replacement_prepare_failed";
      const prepared = await adapters.prepareFileReplacement({
        temporaryPath,
        targetPath: layout.evidencePath,
        backupPath,
        recoveryPath,
        expectedPreviousSha256: lastPersistedSha256,
        expectedReplacementSha256: replacementSha256
      });
      if (
        prepared &&
        REPLACEMENT_TRANSACTION_ID.test(String(prepared.transactionId || ""))
      ) {
        replacementTransactionId = prepared.transactionId;
      }
      exactKeys(
        prepared,
        ["transactionId", "hadPrevious"],
        "evidence_ledger_replacement_prepare_result_invalid"
      );
      if (
        !REPLACEMENT_TRANSACTION_ID.test(String(prepared.transactionId || "")) ||
        prepared.hadPrevious !== (lastPersistedSha256 !== null)
      ) {
        fail("evidence_ledger_replacement_prepare_result_invalid");
      }
      replacement.explicitBackupPrepared = prepared.hadPrevious;

      persistenceFailureStageCode =
        "evidence_second_revision_atomic_replace_failed";
      bootstrapFailureCode = "evidence_ledger_atomic_rename_failed";
      const promoted = await adapters.replaceFileAtomic({
        transactionId: replacementTransactionId
      });
      exactKeys(
        promoted,
        ["committed", "previousMatched"],
        "evidence_ledger_atomic_result_invalid"
      );
      if (promoted.committed !== true || promoted.previousMatched !== true) {
        fail("evidence_ledger_atomic_replace_failed");
      }
      replacementOccurred = true;
      if (prepared.hadPrevious) {
        replacement.explicitBackupValidated = true;
        replacement.explicitBackupMatchesPreviousRevision = true;
      }

      persistenceFailureStageCode = "evidence_second_revision_reopen_failed";
      if (
        await adapters.exists(temporaryPath) ||
        !(await adapters.exists(layout.evidencePath))
      ) {
        fail("evidence_ledger_atomic_replace_unconfirmed");
      }
      bootstrapFailureCode = "evidence_root_acl_validation_failed";
      validateSecurityProof(await adapters.inspectProtectedAcl(layout.evidencePath));
      bootstrapFailureCode = "evidence_ledger_reopen_failed";
      const persisted = await adapters.readFile(layout.evidencePath);

      persistenceFailureStageCode =
        "evidence_second_revision_verification_failed";
      if (!Buffer.isBuffer(persisted) || !persisted.equals(bytes)) {
        bootstrapFailureCode = "evidence_ledger_first_revision_failed";
        fail("evidence_ledger_persisted_bytes_mismatch");
      }
      let reopenedDocument;
      try {
        reopenedDocument = JSON.parse(persisted.toString("utf8"));
      } catch {
        fail("evidence_ledger_persisted_structure_invalid");
      }
      if (
        reopenedDocument.revision !== nextRevision ||
        reopenedDocument.integritySha256 !== payloadSha256
      ) {
        fail("evidence_ledger_persisted_structure_invalid");
      }

      persistenceFailureStageCode = "evidence_second_revision_hash_failed";
      const persistedSha256 = hashBytes(persisted);
      if (persistedSha256 !== replacementSha256) {
        fail("evidence_ledger_persisted_hash_mismatch");
      }
      replacement.newLedgerValidated = true;

      persistenceFailureStageCode = "evidence_second_revision_finalize_failed";
      const finalized = await adapters.finalizeFileReplacement({
        transactionId: replacementTransactionId
      });
      exactKeys(
        finalized,
        ["finalized", "previousRevisionBackupRemoved"],
        "evidence_ledger_replacement_finalize_result_invalid"
      );
      if (
        finalized.finalized !== true ||
        finalized.previousRevisionBackupRemoved !== prepared.hadPrevious
      ) {
        fail("evidence_ledger_replacement_finalize_result_invalid");
      }
      replacement.backupRemovedAfterValidation =
        finalized.previousRevisionBackupRemoved;
      replacementFinalized = true;
      replacementTransactionId = null;

      state.revision = nextRevision;
      lastPersistedSha256 = persistedSha256;
      return Object.freeze({
        code: "evidence_ledger_persisted",
        revision: nextRevision,
        evidenceSha256: lastPersistedSha256,
        payloadSha256,
        replacement: Object.freeze({ ...replacement })
      });
    } catch (error) {
      let rollbackFailure = null;
      if (replacementTransactionId && !replacementFinalized) {
        replacement.rollbackRequired = true;
        replacement.rollbackAttempted = true;
        try {
          const rolledBack = await adapters.rollbackFileReplacement({
            transactionId: replacementTransactionId
          });
          exactKeys(
            rolledBack,
            [
              "rollbackCompleted",
              "previousLedgerRestored",
              "failedCandidatePreserved",
              "failedCandidateRemovedAfterRestore"
            ],
            "evidence_ledger_replacement_rollback_result_invalid"
          );
          if (
            rolledBack.rollbackCompleted !== true ||
            rolledBack.previousLedgerRestored !== true ||
            typeof rolledBack.failedCandidatePreserved !== "boolean" ||
            typeof rolledBack.failedCandidateRemovedAfterRestore !== "boolean" ||
            (rolledBack.failedCandidateRemovedAfterRestore &&
              !rolledBack.failedCandidatePreserved)
          ) {
            fail("evidence_ledger_replacement_rollback_result_invalid");
          }
          replacement.rollbackCompleted = true;
          replacement.previousLedgerRestored = true;
          replacement.failedCandidatePreserved =
            rolledBack.failedCandidatePreserved;
          replacement.failedCandidateRemovedAfterRestore =
            rolledBack.failedCandidateRemovedAfterRestore;
          replacementTransactionId = null;
        } catch (rollbackError) {
          rollbackFailure = rollbackError;
          state.residues = {
            ...state.residues,
            evidenceRecoveryFiles: Math.max(
              1,
              Number(state.residues.evidenceRecoveryFiles || 0)
            )
          };
        }
      }
      const failureState = bootstrap
        ? null
        : await inspectPersistenceFailureState(
            temporaryPath,
            backupPath,
            recoveryPath
          );
      if (failureState) {
        if (replacement.explicitBackupPrepared) {
          replacement.explicitBackupValidated ||=
            failureState.backupMatchesPreviousRevision;
          replacement.explicitBackupMatchesPreviousRevision ||=
            failureState.backupMatchesPreviousRevision;
        }
        replacement.failedCandidatePreserved ||=
          failureState.recoveryFilePresent;
        if (failureState.backupFilePresent || failureState.recoveryFilePresent) {
          state.residues = {
            ...state.residues,
            evidenceRecoveryFiles: Math.max(
              Number(state.residues.evidenceRecoveryFiles || 0),
              Number(failureState.backupFilePresent) +
                Number(failureState.recoveryFilePresent)
            )
          };
        }
      }
      const cleanup = rollbackFailure
        ? Object.freeze({ attempted: false, completed: false, error: null })
        : await cleanupTemporary(temporaryPath);
      const effectiveBootstrapFailureCode =
        bootstrapFailureCode === "evidence_ledger_first_write_failed" &&
        (error?.code === "EEXIST" || error?.systemErrorCode === "EEXIST")
          ? "evidence_ledger_temp_create_failed"
          : bootstrapFailureCode;
      const stagedFailure = bootstrap
        ? bootstrapStageFailure(error, effectiveBootstrapFailureCode)
        : persistenceStageFailure(
            rollbackFailure ||
              (cleanup.attempted && !cleanup.completed ? cleanup.error : error),
            rollbackFailure
              ? "evidence_second_revision_rollback_failed"
              : cleanup.attempted && !cleanup.completed
                ? "evidence_second_revision_temp_cleanup_failed"
                : persistenceFailureStageCode
          );
      const code = bootstrap
        ? error instanceof EvidenceLedgerFailure
          ? error.code
          : "evidence_ledger_persistence_failed"
        : stagedFailure.failureCode;
      persistenceFailureCode ||= code;
      state.persistenceFailureCode = persistenceFailureCode;
      state.status = "failed";
      state.primaryFailureCode ||= persistenceFailureCode;
      if (bootstrap) throw stagedFailure;
      const diagnostic = createPersistenceDiagnostic({
        failure: stagedFailure,
        revisionNumber: nextRevision,
        previousLedgerPreserved: failureState.previousLedgerPreserved,
        temporaryFilePresent: failureState.temporaryFilePresent,
        cleanupAttempted: cleanup.attempted,
        cleanupCompleted: cleanup.completed,
        ...replacement
      });
      const observedTempValidationFailure =
        tempValidationFailure ||
        error?.tempValidationFailure ||
        (persistenceFailureStageCode ===
        "evidence_second_revision_replacement_prepare_failed"
          ? createTempValidationFailureMetadata({
              tempValidationStage:
                "second_revision_temp_unknown_validation_stage",
              sanitizedFailureClass: "unknown",
              sanitizedFailureCode: "UNKNOWN",
              actualConditionClass: "unknown"
            })
          : null);
      let tempValidationDiagnostic = null;
      if (
        nextRevision === 2 &&
        replacementOccurred === false &&
        replacement.explicitBackupPrepared === false &&
        replacement.rollbackRequired === false &&
        replacementTransactionId === null &&
        observedTempValidationFailure
      ) {
        try {
          tempValidationDiagnostic = createTempValidationDiagnostic({
            ...observedTempValidationFailure,
            previousLedgerPreserved:
              failureState.previousLedgerPreserved,
            temporaryFilePresent: failureState.temporaryFilePresent,
            cleanupAttempted: cleanup.attempted,
            cleanupCompleted: cleanup.completed
          });
        } catch {
          tempValidationDiagnostic = null;
        }
      }
      throw new EvidenceLedgerFailure(code, {
        persistenceDiagnostic: diagnostic,
        tempValidationDiagnostic,
        fileReplaceDiagnostic: stagedFailure.fileReplaceDiagnostic,
        fileReplaceArgumentDiagnostic:
          stagedFailure.fileReplaceArgumentDiagnostic
      });
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
      let bootstrapFailureCode = "evidence_root_create_failed";
      try {
        if (
          await adapters.prepareProtectedDirectory({
            controlledRoot: layout.controlledRoot,
            evidenceRoot: layout.evidenceRoot
          }) !== true
        ) {
          fail("evidence_ledger_root_preparation_failed");
        }
        bootstrapFailureCode = "evidence_root_reparse_detected";
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
        bootstrapFailureCode = "evidence_root_acl_validation_failed";
        validateSecurityProof(await adapters.inspectProtectedAcl(layout.evidenceRoot));
        tick();
        bootstrapFailureCode = "evidence_ledger_first_revision_failed";
        const result = await persist({ bootstrap: true });
        initialized = true;
        return result;
      } catch (error) {
        const failure = bootstrapStageFailure(error, bootstrapFailureCode);
        let cleanupCompleted = false;
        try {
          cleanupCompleted = await adapters.cleanupFailedInitialization({
            controlledRoot: layout.controlledRoot,
            evidenceRoot: layout.evidenceRoot,
            cleanupRoot: layout.cleanupRoot
          }) === true;
        } catch {
          cleanupCompleted = false;
        }
        const diagnostic = createBootstrapDiagnostic({
          failure,
          runId: identity.runId,
          cleanupAttempted: true,
          cleanupCompleted
        });
        const code = failure.failureCode;
        persistenceFailureCode ||= code;
        state.persistenceFailureCode = persistenceFailureCode;
        state.primaryFailureCode ||= persistenceFailureCode;
        state.status = "failed";
        throw new EvidenceLedgerFailure(code, { bootstrapDiagnostic: diagnostic });
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
