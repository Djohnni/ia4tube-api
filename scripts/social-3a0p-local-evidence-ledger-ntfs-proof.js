"use strict";

// Narrow, opt-in NTFS proof for the evidence ledger only. This module does not
// import the PostgreSQL entrypoint, product persistence, networking or package
// handling code.
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  createProcessRunner,
  terminateProcessTree
} = require("./social-3a0p-local-process");
const {
  REQUIRED_ADAPTERS,
  createSanitizedEvidenceLedger
} = require("./social-3a0p-local-evidence-ledger");
const {
  createWindowsEvidenceLedgerAdapters
} = require("./social-3a0p-local-windows-evidence-ledger-adapters");
const {
  serializeBootstrapDiagnostic
} = require("./social-3a0p-local-evidence-bootstrap-diagnostic");
const {
  serializePersistenceDiagnostic
} = require("./social-3a0p-local-evidence-persistence-diagnostic");
const {
  serializeFileReplaceExceptionDiagnostic
} = require("./social-3a0p-local-file-replace-diagnostic");
const {
  serializeFileReplaceArgumentDiagnostic
} = require("./social-3a0p-local-file-replace-argument-diagnostic");
const {
  serializeTempValidationDiagnostic
} = require("./social-3a0p-local-temp-validation-diagnostic");

const PHYSICAL_LEDGER_APPROVAL = "RUN_SOCIAL_3A0P_LEDGER_NTFS_PROOF";
const ROOT_PREFIX = "ia4tube-social-3a0p-ledger-proof-";
const COMMIT = /^[0-9a-f]{40}$/;
const KERNEL_SYSTEM_ROOT = "\\\\?\\GLOBALROOT\\SystemRoot";
const NORMAL_REVISION_DIAGNOSTIC_ONLY = false;
const NORMAL_REVISION_STAGES = Object.freeze([
  "normal_revision2_pre_replace",
  "normal_revision2_replace_outcome_unconfirmed",
  "normal_revision2_post_replace_reparse_audit",
  "normal_revision2_post_replace_temp_absence_check",
  "normal_revision2_post_replace_target_presence_check",
  "normal_revision2_post_replace_acl_validation",
  "normal_revision2_post_replace_target_reopen",
  "normal_revision2_post_replace_verification_or_finalize",
  "normal_revision2_unattributed"
]);
const NORMAL_FAILURE_CLASSES = new Set([
  "filesystem",
  "acl",
  "process",
  "powershell",
  "harness_validation",
  "unknown"
]);
const NORMAL_FAILURE_CODES = new Set([
  "EACCES",
  "EPERM",
  "EBUSY",
  "ENOENT",
  "EEXIST",
  "EINVAL",
  "ENOTEMPTY",
  "UNKNOWN"
]);
const REPLACEMENT_AUDIT_KEYS = Object.freeze([
  "explicitBackupPreparedCount",
  "explicitBackupValidatedCount",
  "explicitBackupMatchesPreviousRevisionCount",
  "newLedgerValidatedCount",
  "rollbackAttemptedCount",
  "rollbackCompletedCount",
  "previousLedgerRestoredCount",
  "failedCandidatePreservedCount",
  "failedCandidateRemovedAfterRestoreCount",
  "backupRemovedAfterValidationCount",
  "openTransactionCount"
]);
const NORMAL_REVISION_WRAPPER_METHODS = Object.freeze([
  ...REQUIRED_ADAPTERS,
  "getReplacementAudit"
]);
const NORMAL_REVISION_DIAGNOSTIC_KEYS = Object.freeze([
  "event",
  "scenario",
  "revisionNumber",
  "normalPersistenceStage",
  "sanitizedFailureClass",
  "sanitizedFailureCode"
]);

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function samePath(left, right) {
  return path.resolve(String(left || "")).toLowerCase() ===
    path.resolve(String(right || "")).toLowerCase();
}

function validateNormalRevisionDiagnostic(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError("ledger_ntfs_normal_diagnostic_invalid");
  }
  const keys = Object.keys(value).sort();
  const expected = [...NORMAL_REVISION_DIAGNOSTIC_KEYS].sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index]) ||
    value.event !== "evidence_ledger_normal_revision_failure" ||
    value.scenario !== "normal_persistence" ||
    value.revisionNumber !== 2 ||
    !NORMAL_REVISION_STAGES.includes(value.normalPersistenceStage) ||
    !NORMAL_FAILURE_CLASSES.has(value.sanitizedFailureClass) ||
    !NORMAL_FAILURE_CODES.has(value.sanitizedFailureCode)
  ) {
    throw new TypeError("ledger_ntfs_normal_diagnostic_invalid");
  }
  return true;
}

function allowedFailureCode(value) {
  const candidate = String(value || "").toUpperCase();
  return NORMAL_FAILURE_CODES.has(candidate) ? candidate : "UNKNOWN";
}

function normalFailureMetadata({ stage, adapterFailure, observedFailure }) {
  const persistence = observedFailure?.persistenceDiagnostic;
  const adapterCode = String(adapterFailure?.code || "");
  const sanitizedFailureCode = allowedFailureCode(
    adapterCode || persistence?.systemErrorCode
  );
  let sanitizedFailureClass = "unknown";
  if (/^harness_process_[a-z0-9_]+$/.test(adapterCode)) {
    sanitizedFailureClass = "powershell";
  } else if (
    stage === "normal_revision2_post_replace_acl_validation" &&
    ["EACCES", "EPERM", "UNKNOWN"].includes(sanitizedFailureCode)
  ) {
    sanitizedFailureClass = "acl";
  } else {
    const sourceClass = String(persistence?.systemErrorClass || "");
    if (sourceClass === "filesystem") sanitizedFailureClass = "filesystem";
    else if (sourceClass === "harness_validation") {
      sanitizedFailureClass = "harness_validation";
    } else if (sourceClass === "process") sanitizedFailureClass = "process";
    else if (["permission", "path", "platform"].includes(sourceClass)) {
      sanitizedFailureClass = "filesystem";
    }
  }
  return Object.freeze({ sanitizedFailureClass, sanitizedFailureCode });
}

function createNormalRevisionDiagnostic({
  stage,
  adapterFailure = null,
  observedFailure
}) {
  const normalPersistenceStage = NORMAL_REVISION_STAGES.includes(stage)
    ? stage
    : "normal_revision2_unattributed";
  const diagnostic = {
    event: "evidence_ledger_normal_revision_failure",
    scenario: "normal_persistence",
    revisionNumber: 2,
    normalPersistenceStage,
    ...normalFailureMetadata({
      stage: normalPersistenceStage,
      adapterFailure,
      observedFailure
    })
  };
  validateNormalRevisionDiagnostic(diagnostic);
  return Object.freeze(diagnostic);
}

function serializeNormalRevisionDiagnostic(value) {
  validateNormalRevisionDiagnostic(value);
  return JSON.stringify(value);
}

function securityProofLooksValid(value) {
  return Boolean(
    value &&
    value.ownerCurrentUser === true &&
    value.inheritanceProtected === true &&
    value.currentUserFullControl === true &&
    value.systemFullControl === true &&
    value.administratorsFullControl === true &&
    value.explicitAllowRuleCount === 3 &&
    value.currentUserAllowRuleCount === 1 &&
    value.systemAllowRuleCount === 1 &&
    value.administratorsAllowRuleCount === 1 &&
    value.inheritedRuleCount === 0 &&
    value.denyRuleCount === 0 &&
    value.unexpectedAllowRuleCount === 0
  );
}

function confirmedAtomicReplaceResult(value) {
  try {
    if (!value || Object.getPrototypeOf(value) !== Object.prototype) return false;
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== 2 ||
      !keys.includes("committed") ||
      !keys.includes("previousMatched")
    ) {
      return false;
    }
    for (const key of ["committed", "previousMatched"]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        !descriptor ||
        descriptor.enumerable !== true ||
        !Object.hasOwn(descriptor, "value") ||
        descriptor.get ||
        descriptor.set ||
        descriptor.value !== true
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function validatedReplacementAuditSnapshot(value) {
  let invalid = false;
  const snapshot = {};
  try {
    if (
      !value ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      !Object.isFrozen(value)
    ) {
      invalid = true;
    } else {
      const ownKeys = Reflect.ownKeys(value);
      if (
        ownKeys.length !== REPLACEMENT_AUDIT_KEYS.length ||
        ownKeys.some(
          (key) =>
            typeof key !== "string" ||
            !REPLACEMENT_AUDIT_KEYS.includes(key)
        )
      ) {
        invalid = true;
      }
      for (const key of REPLACEMENT_AUDIT_KEYS) {
        if (invalid) break;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (
          !descriptor ||
          descriptor.enumerable !== true ||
          !Object.hasOwn(descriptor, "value") ||
          descriptor.get ||
          descriptor.set ||
          !Number.isSafeInteger(descriptor.value) ||
          descriptor.value < 0
        ) {
          invalid = true;
          break;
        }
        snapshot[key] = descriptor.value;
      }
    }
  } catch {
    invalid = true;
  }
  if (invalid) fail("ledger_ntfs_replacement_audit_invalid");
  return Object.freeze(snapshot);
}

function createNormalRevision2StageTrackingAdapters(adapters, evidencePath) {
  const replacementAuditDescriptor = adapters &&
    Object.getOwnPropertyDescriptor(adapters, "getReplacementAudit");
  if (
    !replacementAuditDescriptor ||
    typeof replacementAuditDescriptor.value !== "function" ||
    replacementAuditDescriptor.get ||
    replacementAuditDescriptor.set
  ) {
    fail("ledger_ntfs_replacement_audit_method_missing");
  }
  const readOriginalReplacementAudit = replacementAuditDescriptor.value;
  let trackedTransactionId = null;
  let temporaryPath = null;
  let trackingState = "waiting";
  let currentStage = "normal_revision2_pre_replace";
  let adapterFailure = null;
  const wrapped = Object.fromEntries(
    REQUIRED_ADAPTERS.map((name) => [
      name,
      (...args) => Reflect.apply(adapters[name], adapters, args)
    ])
  );
  Object.defineProperty(wrapped, "getReplacementAudit", {
    configurable: false,
    enumerable: true,
    writable: false,
    value() {
      let value;
      try {
        value = Reflect.apply(readOriginalReplacementAudit, adapters, []);
      } catch {
        fail("ledger_ntfs_replacement_audit_read_failed");
      }
      return validatedReplacementAuditSnapshot(value);
    }
  });

  function lockFailure(stage, error = null) {
    if (trackingState !== "failed") {
      currentStage = stage;
      adapterFailure = error
        ? Object.freeze({ code: String(error?.code || "") })
        : null;
      trackingState = "failed";
    }
  }

  wrapped.prepareFileReplacement = async (input) => {
    const prepared = await adapters.prepareFileReplacement(input);
    if (trackingState === "waiting" && prepared.hadPrevious === true) {
      trackedTransactionId = prepared.transactionId;
      temporaryPath = input.temporaryPath;
      trackingState = "prepared";
    }
    return prepared;
  };

  wrapped.replaceFileAtomic = async (input) => {
    const trackedReplacement =
      trackingState === "prepared" &&
      input?.transactionId === trackedTransactionId;
    if (!trackedReplacement) return adapters.replaceFileAtomic(input);

    trackingState = "replace_outcome_unconfirmed";
    currentStage = "normal_revision2_replace_outcome_unconfirmed";
    try {
      const result = await adapters.replaceFileAtomic(input);
      if (confirmedAtomicReplaceResult(result)) {
        trackingState = "post_replace";
        currentStage = "normal_revision2_post_replace_temp_absence_check";
      } else {
        lockFailure(currentStage);
      }
      return result;
    } catch (error) {
      lockFailure(currentStage, error);
      throw error;
    }
  };

  wrapped.assertNoReparseComponents = async (input) => {
    if (trackingState !== "post_replace") {
      return adapters.assertNoReparseComponents(input);
    }
    currentStage = "normal_revision2_post_replace_reparse_audit";
    try {
      const result = await adapters.assertNoReparseComponents(input);
      if (result === true) {
        currentStage = "normal_revision2_post_replace_temp_absence_check";
      } else {
        lockFailure(currentStage);
      }
      return result;
    } catch (error) {
      lockFailure(currentStage, error);
      throw error;
    }
  };

  wrapped.exists = async (target) => {
    if (trackingState !== "post_replace") return adapters.exists(target);
    const isTemporary = samePath(target, temporaryPath);
    const isTarget = samePath(target, evidencePath);
    if (
      currentStage === "normal_revision2_post_replace_temp_absence_check" &&
      isTemporary
    ) {
      try {
        const result = await adapters.exists(target);
        if (result === false) {
          currentStage = "normal_revision2_post_replace_target_presence_check";
        } else {
          lockFailure(currentStage);
        }
        return result;
      } catch (error) {
        lockFailure(currentStage, error);
        throw error;
      }
    }
    if (
      currentStage === "normal_revision2_post_replace_target_presence_check" &&
      isTarget
    ) {
      try {
        const result = await adapters.exists(target);
        if (result === true) {
          currentStage = "normal_revision2_post_replace_acl_validation";
        } else {
          lockFailure(currentStage);
        }
        return result;
      } catch (error) {
        lockFailure(currentStage, error);
        throw error;
      }
    }
    return adapters.exists(target);
  };

  wrapped.inspectProtectedAcl = async (target) => {
    if (
      trackingState !== "post_replace" ||
      currentStage !== "normal_revision2_post_replace_acl_validation" ||
      !samePath(target, evidencePath)
    ) {
      return adapters.inspectProtectedAcl(target);
    }
    try {
      const result = await adapters.inspectProtectedAcl(target);
      if (!securityProofLooksValid(result)) lockFailure(currentStage);
      return result;
    } catch (error) {
      lockFailure(currentStage, error);
      throw error;
    }
  };

  wrapped.readFile = async (target) => {
    if (
      trackingState !== "post_replace" ||
      currentStage !== "normal_revision2_post_replace_acl_validation" ||
      !samePath(target, evidencePath)
    ) {
      return adapters.readFile(target);
    }
    currentStage = "normal_revision2_post_replace_target_reopen";
    try {
      const result = await adapters.readFile(target);
      currentStage =
        "normal_revision2_post_replace_verification_or_finalize";
      trackingState = "completed";
      return result;
    } catch (error) {
      lockFailure(currentStage, error);
      throw error;
    }
  };

  return Object.freeze({
    adapters: Object.freeze(wrapped),
    createFailureDiagnostic(observedFailure) {
      return createNormalRevisionDiagnostic({
        stage: currentStage,
        adapterFailure,
        observedFailure
      });
    },
    snapshot() {
      return Object.freeze({
        trackingState,
        normalPersistenceStage: currentStage,
        adapterFailureCaptured: adapterFailure !== null
      });
    }
  });
}

function canonicalUnder(candidate, parent, code) {
  const resolved = path.resolve(candidate);
  const root = path.resolve(parent);
  const relative = path.relative(root, resolved);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    fail(code);
  }
  return resolved;
}

function systemPaths() {
  let systemRoot;
  try {
    systemRoot = fs.realpathSync.native(KERNEL_SYSTEM_ROOT);
  } catch {
    fail("ledger_ntfs_system_root_invalid");
  }
  const system32 = path.join(systemRoot, "System32");
  const powershell = path.join(
    system32,
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  const taskkill = path.join(system32, "taskkill.exe");
  for (const executable of [powershell, taskkill]) {
    const item = fs.lstatSync(executable);
    if (!item.isFile() || item.isSymbolicLink()) {
      fail("ledger_ntfs_system_executable_invalid");
    }
  }
  return Object.freeze({ powershell, system32, systemRoot, taskkill });
}

function safeEnvironment({ cleanupRoot, paths }) {
  return Object.freeze({
    ComSpec: path.join(paths.system32, "cmd.exe"),
    PATH: [paths.system32, path.dirname(paths.powershell)].join(path.delimiter),
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    SystemDrive: path.parse(paths.systemRoot).root.replace(/[\\\/]$/, ""),
    SystemRoot: paths.systemRoot,
    TEMP: cleanupRoot,
    TMP: cleanupRoot,
    TMPDIR: cleanupRoot,
    WINDIR: paths.systemRoot
  });
}

function parseProof(value, code) {
  let parsed;
  try {
    parsed = JSON.parse(String(value || "").trim());
  } catch {
    fail(code);
  }
  if (!parsed || Object.getPrototypeOf(parsed) !== Object.prototype) fail(code);
  return parsed;
}

async function tokenAndSystemProof({
  processRunner,
  powershell,
  environment,
  controlledRoot,
  tempParent,
  label
}) {
  const result = await processRunner.run({
    executable: powershell,
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      [
        "$ErrorActionPreference='Stop';",
        "$p=[IO.Path]::GetFullPath($env:IA4TUBE_LEDGER_PROOF_ROOT);",
        "$parent=[IO.Path]::GetFullPath($env:IA4TUBE_LEDGER_PROOF_PARENT);",
        "$me=[Security.Principal.WindowsIdentity]::GetCurrent();",
        "$principal=New-Object Security.Principal.WindowsPrincipal($me);",
        "$owner=([Security.Principal.NTAccount](Get-Acl -LiteralPath $p).Owner).Translate([Security.Principal.SecurityIdentifier]).Value;",
        "$rootItem=Get-Item -LiteralPath $p -Force;",
        "$postgresProcesses=@(Get-Process -Name postgres -ErrorAction SilentlyContinue).Count;",
        "$postgresServices=@(Get-Service -ErrorAction SilentlyContinue|Where-Object{$_.Name-match'postgres' -or $_.DisplayName-match'postgres'}).Count;",
        "[ordered]@{nonElevated=(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator));tokenOwnsRoot=($owner-eq$me.User.Value);canonicalUnderTemp=($p.StartsWith($parent+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase));rootReparse=(($rootItem.Attributes-band[IO.FileAttributes]::ReparsePoint)-ne0);postgresProcesses=$postgresProcesses;postgresServices=$postgresServices;postgresListeners=($(if($postgresProcesses-eq0){0}else{-1}))}|ConvertTo-Json -Compress"
      ].join("")
    ],
    cwd: controlledRoot,
    environment: {
      ...environment,
      IA4TUBE_LEDGER_PROOF_ROOT: controlledRoot,
      IA4TUBE_LEDGER_PROOF_PARENT: tempParent
    },
    allowedEnvironmentNames: [
      "IA4TUBE_LEDGER_PROOF_ROOT",
      "IA4TUBE_LEDGER_PROOF_PARENT"
    ],
    timeoutMs: 15_000,
    label
  });
  const proof = parseProof(result.stdoutSanitized, "ledger_ntfs_system_proof_invalid");
  if (
    proof.nonElevated !== true ||
    proof.tokenOwnsRoot !== true ||
    proof.canonicalUnderTemp !== true ||
    proof.rootReparse !== false ||
    proof.postgresProcesses !== 0 ||
    proof.postgresServices !== 0 ||
    proof.postgresListeners !== 0
  ) {
    fail("ledger_ntfs_system_state_refused");
  }
  return Object.freeze(proof);
}

function assertNoReparseTree(target) {
  const item = fs.lstatSync(target);
  if (item.isSymbolicLink()) fail("ledger_ntfs_cleanup_reparse_refused");
  if (item.isDirectory()) {
    for (const child of fs.readdirSync(target)) {
      assertNoReparseTree(path.join(target, child));
    }
  }
}

function validateSyntheticFailureIdentity(value) {
  if (
    !value ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).sort().join("\0") !== "code\0nonce\0stage" ||
    !/^[0-9a-f]{32}$/.test(value.nonce) ||
    value.stage !== "post_replace_read" ||
    value.code !== "EBUSY"
  ) {
    fail("ledger_ntfs_synthetic_failure_identity_invalid");
  }
  return true;
}

function createOneShotPostReplaceReadFailureAdapters(
  adapters,
  evidencePath,
  failureIdentity
) {
  validateSyntheticFailureIdentity(failureIdentity);
  const expectedIdentity = Object.freeze({ ...failureIdentity });
  let armedTransactionId = null;
  let postReplaceReadPending = false;
  let injected = false;
  let observedIdentity = null;
  const wrapped = Object.fromEntries(
    REQUIRED_ADAPTERS.map((name) => [
      name,
      (...args) => Reflect.apply(adapters[name], adapters, args)
    ])
  );
  wrapped.prepareFileReplacement = async (input) => {
    const prepared = await adapters.prepareFileReplacement(input);
    if (prepared.hadPrevious === true) {
      armedTransactionId = prepared.transactionId;
    }
    return prepared;
  };
  wrapped.replaceFileAtomic = async (input) => {
    const result = await adapters.replaceFileAtomic(input);
    if (input.transactionId === armedTransactionId) {
      postReplaceReadPending = true;
    }
    return result;
  };
  wrapped.readFile = async (target) => {
    if (
      postReplaceReadPending &&
      !injected &&
      path.resolve(target).toLowerCase() === path.resolve(evidencePath).toLowerCase()
    ) {
      injected = true;
      postReplaceReadPending = false;
      observedIdentity = expectedIdentity;
      const error = new Error("synthetic_post_replace_read_failure");
      error.code = expectedIdentity.code;
      throw error;
    }
    return adapters.readFile(target);
  };
  return Object.freeze({
    adapters: Object.freeze(wrapped),
    wasInjected: () => injected,
    matchesInjectionIdentity(candidate) {
      validateSyntheticFailureIdentity(candidate);
      return Boolean(
        observedIdentity &&
        observedIdentity.nonce === candidate.nonce &&
        observedIdentity.stage === candidate.stage &&
        observedIdentity.code === candidate.code
      );
    }
  });
}

async function cleanupProofRoot({ controlledRoot, tempParent, ledgerRoots }) {
  const safeRoot = canonicalUnder(
    controlledRoot,
    tempParent,
    "ledger_ntfs_cleanup_scope_refused"
  );
  if (!path.basename(safeRoot).startsWith(ROOT_PREFIX)) {
    fail("ledger_ntfs_cleanup_scope_refused");
  }
  if (!fs.existsSync(safeRoot)) return true;
  assertNoReparseTree(safeRoot);
  const rootEntries = fs.readdirSync(safeRoot).sort();
  if (!Array.isArray(ledgerRoots) || ledgerRoots.length < 1) {
    fail("ledger_ntfs_cleanup_inventory_refused");
  }
  const allowedRootEntries = ledgerRoots
    .flatMap(({ cleanupRoot, evidenceRoot }) => [
      cleanupRoot,
      evidenceRoot
    ])
    .filter((candidate) => fs.existsSync(candidate))
    .map((candidate) => path.basename(candidate))
    .sort();
  if (
    rootEntries.length !== allowedRootEntries.length ||
    rootEntries.some((entry, index) => entry !== allowedRootEntries[index])
  ) {
    fail("ledger_ntfs_cleanup_inventory_refused");
  }
  for (const { cleanupRoot, evidenceRoot } of ledgerRoots) {
    if (fs.existsSync(cleanupRoot)) {
      const cleanupEntries = fs.readdirSync(cleanupRoot);
      if (cleanupEntries.length !== 0) {
        fail("ledger_ntfs_cleanup_inventory_refused");
      }
    }
    if (fs.existsSync(evidenceRoot)) {
      const evidenceEntries = fs.readdirSync(evidenceRoot);
      if (
        evidenceEntries.length !== 1 ||
        !/^[0-9a-f-]{32,36}-incremental-evidence\.json$/.test(evidenceEntries[0])
      ) {
        fail("ledger_ntfs_cleanup_inventory_refused");
      }
      await fsp.unlink(path.join(evidenceRoot, evidenceEntries[0]));
      await fsp.rmdir(evidenceRoot);
    }
    if (fs.existsSync(cleanupRoot)) await fsp.rmdir(cleanupRoot);
  }
  await fsp.rmdir(safeRoot);
  return !fs.existsSync(safeRoot);
}

async function runPhysicalLedgerProof({ harnessCommit, productCommit }) {
  if (process.platform !== "win32") fail("ledger_ntfs_platform_refused");
  if (!COMMIT.test(harnessCommit) || !COMMIT.test(productCommit)) {
    fail("ledger_ntfs_commit_invalid");
  }
  const tempParent = fs.realpathSync.native(os.tmpdir());
  const controlledRoot = fs.mkdtempSync(path.join(tempParent, ROOT_PREFIX));
  const cleanupRoot = path.join(controlledRoot, "owned-run");
  const evidenceRoot = path.join(controlledRoot, "evidence-ledger");
  const rollbackCleanupRoot = path.join(controlledRoot, "rollback-owned-run");
  const rollbackEvidenceRoot = path.join(
    controlledRoot,
    "rollback-evidence-ledger"
  );
  const ledgerRoots = [
    { cleanupRoot, evidenceRoot },
    { cleanupRoot: rollbackCleanupRoot, evidenceRoot: rollbackEvidenceRoot }
  ];
  fs.mkdirSync(cleanupRoot);
  fs.mkdirSync(rollbackCleanupRoot);
  const paths = systemPaths();
  const environment = safeEnvironment({ cleanupRoot, paths });
  const processRunner = createProcessRunner({
    allowedExecutables: [paths.powershell],
    terminateTree: (pid) => terminateProcessTree(pid, {
      taskkillPath: paths.taskkill,
      timeoutMs: 5_000
    })
  });
  const runId = crypto.randomUUID();
  let cleanupCompleted = false;
  let failure;
  try {
    const before = await tokenAndSystemProof({
      processRunner,
      powershell: paths.powershell,
      environment,
      controlledRoot,
      tempParent,
      label: "ledger_ntfs_preflight"
    });
    const baseAdapters = createWindowsEvidenceLedgerAdapters({
      controlledRoot,
      evidenceRoot,
      cleanupRoot,
      powershell: paths.powershell,
      processRunner,
      environment
    });
    const normalRevisionTracker =
      createNormalRevision2StageTrackingAdapters(
        baseAdapters,
        path.join(evidenceRoot, `${runId}-incremental-evidence.json`)
      );
    const adapters = normalRevisionTracker.adapters;
    const ledger = createSanitizedEvidenceLedger({
      runId,
      harnessCommit,
      productCommit,
      controlledRoot,
      evidenceRoot,
      cleanupRoot,
      adapters
    });
    const first = await ledger.initialize({
      metrics: { ntfsProof: { synthetic: true, externalCalls: 0 } },
      residues: { temporaryFiles: 0 }
    });
    if (first.revision !== 1) fail("ledger_ntfs_first_revision_invalid");
    const rootAcl = await adapters.inspectProtectedAcl(evidenceRoot);
    const fileAcl = await adapters.inspectProtectedAcl(ledger.paths.evidencePath);
    for (const proof of [rootAcl, fileAcl]) {
      if (
        proof.ownerCurrentUser !== true ||
        proof.inheritanceProtected !== true ||
        proof.explicitAllowRuleCount !== 3 ||
        proof.inheritedRuleCount !== 0 ||
        proof.denyRuleCount !== 0 ||
        proof.unexpectedAllowRuleCount !== 0
      ) {
        fail("ledger_ntfs_acl_invalid");
      }
    }
    const firstBytes = await fsp.readFile(ledger.paths.evidencePath);
    const firstSha256 = crypto.createHash("sha256").update(firstBytes).digest("hex");
    let second;
    try {
      second = await ledger.recordAvailableEvidence({
        metrics: { ntfsProof: { synthetic: true, externalCalls: 0, revision: 2 } }
      });
    } catch (error) {
      const normalRevisionDiagnostic =
        normalRevisionTracker.createFailureDiagnostic(error);
      Object.defineProperty(error, "normalRevisionDiagnostic", {
        configurable: false,
        enumerable: false,
        writable: false,
        value: normalRevisionDiagnostic
      });
      throw error;
    }
    if (
      second.revision !== 2 ||
      second.replacement.explicitBackupPrepared !== true ||
      second.replacement.explicitBackupValidated !== true ||
      second.replacement.explicitBackupMatchesPreviousRevision !== true ||
      second.replacement.newLedgerValidated !== true ||
      second.replacement.backupRemovedAfterValidation !== true ||
      fs.readdirSync(evidenceRoot).length !== 1
    ) {
      fail("ledger_ntfs_second_revision_invalid");
    }
    const secondBytes = await fsp.readFile(ledger.paths.evidencePath);
    const secondSha256 = crypto
      .createHash("sha256")
      .update(secondBytes)
      .digest("hex");
    const third = await ledger.recordAvailableEvidence({
      metrics: {
        ntfsProof: {
          synthetic: true,
          externalCalls: 0,
          revision: 3,
          validatedRevisions: 3
        }
      }
    });
    if (
      third.revision !== 3 ||
      third.replacement.explicitBackupPrepared !== true ||
      third.replacement.explicitBackupValidated !== true ||
      third.replacement.explicitBackupMatchesPreviousRevision !== true ||
      third.replacement.newLedgerValidated !== true ||
      third.replacement.backupRemovedAfterValidation !== true ||
      fs.readdirSync(evidenceRoot).length !== 1
    ) {
      fail("ledger_ntfs_third_revision_invalid");
    }
    const finalBytes = await fsp.readFile(ledger.paths.evidencePath);
    const parsed = JSON.parse(finalBytes.toString("utf8"));
    const finalSha256 = crypto.createHash("sha256").update(finalBytes).digest("hex");
    const integritySha256 = parsed.integritySha256;
    delete parsed.integritySha256;
    const recomputedIntegritySha256 = crypto
      .createHash("sha256")
      .update(JSON.stringify(parsed), "utf8")
      .digest("hex");
    const finalAcl = await adapters.inspectProtectedAcl(ledger.paths.evidencePath);
    const replacementAudit = adapters.getReplacementAudit();
    if (
      parsed.revision !== 3 ||
      integritySha256 !== recomputedIntegritySha256 ||
      third.evidenceSha256 !== finalSha256 ||
      third.payloadSha256 !== integritySha256 ||
      firstSha256 === secondSha256 ||
      secondSha256 === finalSha256 ||
      finalAcl.ownerCurrentUser !== true ||
      finalAcl.inheritanceProtected !== true ||
      finalAcl.explicitAllowRuleCount !== 3 ||
      finalAcl.inheritedRuleCount !== 0 ||
      finalAcl.denyRuleCount !== 0 ||
      finalAcl.unexpectedAllowRuleCount !== 0 ||
      fs.readdirSync(evidenceRoot).some((name) =>
        /\.(?:tmp|previous\.bak|failed\.bak)$/.test(name)
      ) ||
      replacementAudit.explicitBackupPreparedCount !== 2 ||
      replacementAudit.explicitBackupValidatedCount !== 2 ||
      replacementAudit.explicitBackupMatchesPreviousRevisionCount !== 2 ||
      replacementAudit.newLedgerValidatedCount !== 3 ||
      replacementAudit.backupRemovedAfterValidationCount !== 2 ||
      replacementAudit.rollbackAttemptedCount !== 0 ||
      replacementAudit.openTransactionCount !== 0
    ) {
      fail("ledger_ntfs_persisted_revision_invalid");
    }

    if (NORMAL_REVISION_DIAGNOSTIC_ONLY) {
      const after = await tokenAndSystemProof({
        processRunner,
        powershell: paths.powershell,
        environment,
        controlledRoot,
        tempParent,
        label: "ledger_ntfs_normal_diagnostic_postflight"
      });
      cleanupCompleted = await cleanupProofRoot({
        controlledRoot,
        tempParent,
        ledgerRoots
      });
      if (!cleanupCompleted) fail("ledger_ntfs_cleanup_unconfirmed");
      return Object.freeze({
        ok: true,
        diagnosticOnly: true,
        normalPersistenceScenarioPassed: true,
        syntheticScenarioExecuted: false,
        firstRevision: first.revision,
        secondRevision: second.revision,
        thirdRevision: third.revision,
        explicitBackupPreparedCount:
          replacementAudit.explicitBackupPreparedCount,
        explicitBackupValidatedCount:
          replacementAudit.explicitBackupValidatedCount,
        explicitBackupMatchesPreviousRevisionCount:
          replacementAudit.explicitBackupMatchesPreviousRevisionCount,
        backupRemovedAfterValidationCount:
          replacementAudit.backupRemovedAfterValidationCount,
        temporaryFilesRemaining: 0,
        backupFilesRemaining: 0,
        postgresProcessesBefore: before.postgresProcesses,
        postgresProcessesAfter: after.postgresProcesses,
        postgresServicesBefore: before.postgresServices,
        postgresServicesAfter: after.postgresServices,
        postgresListenersBefore: before.postgresListeners,
        postgresListenersAfter: after.postgresListeners,
        externalCalls: 0,
        cleanupCompleted
      });
    }

    const rollbackRunId = crypto.randomUUID();
    const rollbackEnvironment = safeEnvironment({
      cleanupRoot: rollbackCleanupRoot,
      paths
    });
    const rollbackBaseAdapters = createWindowsEvidenceLedgerAdapters({
      controlledRoot,
      evidenceRoot: rollbackEvidenceRoot,
      cleanupRoot: rollbackCleanupRoot,
      powershell: paths.powershell,
      processRunner,
      environment: rollbackEnvironment
    });
    const rollbackFailureIdentity = Object.freeze({
      nonce: crypto.randomBytes(16).toString("hex"),
      stage: "post_replace_read",
      code: "EBUSY"
    });
    const injectedAdapters = createOneShotPostReplaceReadFailureAdapters(
      rollbackBaseAdapters,
      path.join(
        rollbackEvidenceRoot,
        `${rollbackRunId}-incremental-evidence.json`
      ),
      rollbackFailureIdentity
    );
    const rollbackLedger = createSanitizedEvidenceLedger({
      runId: rollbackRunId,
      harnessCommit,
      productCommit,
      controlledRoot,
      evidenceRoot: rollbackEvidenceRoot,
      cleanupRoot: rollbackCleanupRoot,
      adapters: injectedAdapters.adapters
    });
    const rollbackFirst = await rollbackLedger.initialize({
      metrics: { ntfsRollbackProof: { synthetic: true, externalCalls: 0 } },
      residues: { temporaryFiles: 0 }
    });
    if (rollbackFirst.revision !== 1) {
      fail("ledger_ntfs_rollback_first_revision_invalid");
    }
    const rollbackBeforeBytes = await fsp.readFile(
      rollbackLedger.paths.evidencePath
    );
    const rollbackBeforeSha256 = crypto
      .createHash("sha256")
      .update(rollbackBeforeBytes)
      .digest("hex");
    let rollbackFailure;
    try {
      await rollbackLedger.recordAvailableEvidence({
        metrics: {
          ntfsRollbackProof: {
            synthetic: true,
            externalCalls: 0,
            injectedAfterReplace: true
          }
        }
      });
    } catch (error) {
      rollbackFailure = error;
    }
    const rollbackAfterBytes = await fsp.readFile(
      rollbackLedger.paths.evidencePath
    );
    const rollbackAfterSha256 = crypto
      .createHash("sha256")
      .update(rollbackAfterBytes)
      .digest("hex");
    const rollbackAudit = rollbackBaseAdapters.getReplacementAudit();
    const rollbackDiagnostic = rollbackFailure?.persistenceDiagnostic;
    const rollbackAcl = await rollbackBaseAdapters.inspectProtectedAcl(
      rollbackLedger.paths.evidencePath
    );
    if (
      !rollbackFailure ||
      rollbackFailure.code !== "evidence_second_revision_reopen_failed" ||
      !rollbackDiagnostic ||
      rollbackDiagnostic.rollbackRequired !== true ||
      rollbackDiagnostic.rollbackAttempted !== true ||
      rollbackDiagnostic.rollbackCompleted !== true ||
      rollbackDiagnostic.previousLedgerRestored !== true ||
      rollbackDiagnostic.previousLedgerPreserved !== true ||
      rollbackDiagnostic.failedCandidatePreserved !== true ||
      rollbackDiagnostic.failedCandidateRemovedAfterRestore !== true ||
      injectedAdapters.wasInjected() !== true ||
      injectedAdapters.matchesInjectionIdentity(rollbackFailureIdentity) !== true ||
      rollbackLedger.snapshot().revision !== 1 ||
      !rollbackAfterBytes.equals(rollbackBeforeBytes) ||
      rollbackAfterSha256 !== rollbackBeforeSha256 ||
      rollbackAudit.explicitBackupPreparedCount !== 1 ||
      rollbackAudit.explicitBackupValidatedCount !== 1 ||
      rollbackAudit.explicitBackupMatchesPreviousRevisionCount !== 1 ||
      rollbackAudit.rollbackAttemptedCount !== 1 ||
      rollbackAudit.rollbackCompletedCount !== 1 ||
      rollbackAudit.previousLedgerRestoredCount !== 1 ||
      rollbackAudit.failedCandidatePreservedCount !== 1 ||
      rollbackAudit.failedCandidateRemovedAfterRestoreCount !== 1 ||
      rollbackAudit.openTransactionCount !== 0 ||
      rollbackAcl.ownerCurrentUser !== true ||
      rollbackAcl.inheritanceProtected !== true ||
      rollbackAcl.explicitAllowRuleCount !== 3 ||
      fs.readdirSync(rollbackEvidenceRoot).length !== 1
    ) {
      fail("ledger_ntfs_physical_rollback_invalid");
    }
    const after = await tokenAndSystemProof({
      processRunner,
      powershell: paths.powershell,
      environment,
      controlledRoot,
      tempParent,
      label: "ledger_ntfs_postflight"
    });
    cleanupCompleted = await cleanupProofRoot({
      controlledRoot,
      tempParent,
      ledgerRoots
    });
    if (!cleanupCompleted) fail("ledger_ntfs_cleanup_unconfirmed");
    return Object.freeze({
      ok: true,
      nonElevated: before.nonElevated,
      sameTokenOwner: before.tokenOwnsRoot && after.tokenOwnsRoot,
      canonicalUnderTemp: before.canonicalUnderTemp && after.canonicalUnderTemp,
      rootReparseDetected: before.rootReparse || after.rootReparse,
      explicitAclRules: rootAcl.explicitAllowRuleCount,
      inheritedAclRules: rootAcl.inheritedRuleCount,
      denyAclRules: rootAcl.denyRuleCount,
      unexpectedAclRules: rootAcl.unexpectedAllowRuleCount,
      firstRevision: first.revision,
      secondRevision: second.revision,
      thirdRevision: third.revision,
      firstBytes: firstBytes.length,
      secondBytes: secondBytes.length,
      finalBytes: finalBytes.length,
      firstSha256,
      secondSha256,
      finalSha256,
      temporaryFilesRemaining: 0,
      backupFilesRemaining: 0,
      explicitBackupPreparedCount:
        replacementAudit.explicitBackupPreparedCount,
      explicitBackupValidatedCount:
        replacementAudit.explicitBackupValidatedCount,
      explicitBackupMatchesPreviousRevisionCount:
        replacementAudit.explicitBackupMatchesPreviousRevisionCount,
      backupRemovedAfterValidationCount:
        replacementAudit.backupRemovedAfterValidationCount,
      rollbackPhysicalApproved: true,
      rollbackPreviousBytes: rollbackBeforeBytes.length,
      rollbackRestoredBytes: rollbackAfterBytes.length,
      rollbackPreviousSha256: rollbackBeforeSha256,
      rollbackRestoredSha256: rollbackAfterSha256,
      rollbackAttemptedCount: rollbackAudit.rollbackAttemptedCount,
      rollbackCompletedCount: rollbackAudit.rollbackCompletedCount,
      failedCandidateRemovedAfterRestoreCount:
        rollbackAudit.failedCandidateRemovedAfterRestoreCount,
      postgresProcessesBefore: before.postgresProcesses,
      postgresProcessesAfter: after.postgresProcesses,
      postgresServicesBefore: before.postgresServices,
      postgresServicesAfter: after.postgresServices,
      postgresListenersBefore: before.postgresListeners,
      postgresListenersAfter: after.postgresListeners,
      externalCalls: 0,
      cleanupCompleted
    });
  } catch (error) {
    failure = error;
    if (error?.normalRevisionDiagnostic) {
      process.stderr.write(
        `${serializeNormalRevisionDiagnostic(error.normalRevisionDiagnostic)}\n`
      );
    }
    if (error?.bootstrapDiagnostic) {
      process.stderr.write(`${serializeBootstrapDiagnostic(error.bootstrapDiagnostic)}\n`);
    }
    if (error?.tempValidationDiagnostic) {
      process.stderr.write(
        `${serializeTempValidationDiagnostic(error.tempValidationDiagnostic)}\n`
      );
    }
    if (error?.persistenceDiagnostic) {
      process.stderr.write(
        `${serializePersistenceDiagnostic(error.persistenceDiagnostic)}\n`
      );
    }
    if (error?.fileReplaceDiagnostic) {
      process.stderr.write(
        `${serializeFileReplaceExceptionDiagnostic(error.fileReplaceDiagnostic)}\n`
      );
    }
    if (error?.fileReplaceArgumentDiagnostic) {
      process.stderr.write(
        `${serializeFileReplaceArgumentDiagnostic(
          error.fileReplaceArgumentDiagnostic
        )}\n`
      );
    }
    throw error;
  } finally {
    if (!cleanupCompleted && fs.existsSync(controlledRoot)) {
      try {
        cleanupCompleted = await cleanupProofRoot({
          controlledRoot,
          tempParent,
          ledgerRoots
        });
      } catch {
        if (failure && !failure.cleanupFailureCode) {
          failure.cleanupFailureCode = "ledger_ntfs_cleanup_failed";
        }
      }
    }
  }
}

function parseCommandLine(argv) {
  if (
    !Array.isArray(argv) ||
    argv.length !== 2 ||
    argv[0] !== "--approval" ||
    argv[1] !== PHYSICAL_LEDGER_APPROVAL
  ) {
    fail("ledger_ntfs_approval_missing");
  }
  return true;
}

if (require.main === module) {
  (async () => {
    try {
      parseCommandLine(process.argv.slice(2));
      const result = await runPhysicalLedgerProof({
        harnessCommit: "867ace527ef1d6632d12cc45a1cdf3fe6a39e62c",
        productCommit: "fcfc92419021dae5f77baad731c634b10c275c5b"
      });
      process.stdout.write(`${JSON.stringify(result)}\n`);
      process.exitCode = 0;
    } catch (error) {
      process.stderr.write(`${JSON.stringify({
        ok: false,
        code: /^[a-z][a-z0-9_]{2,95}$/.test(String(error?.code || ""))
          ? error.code
          : "ledger_ntfs_proof_failed",
        cleanupFailureCode: /^[a-z][a-z0-9_]{2,95}$/.test(
          String(error?.cleanupFailureCode || "")
        ) ? error.cleanupFailureCode : null
      })}\n`);
      process.exitCode = 2;
    }
  })();
}

module.exports = {
  NORMAL_REVISION_DIAGNOSTIC_ONLY,
  NORMAL_REVISION_STAGES,
  NORMAL_REVISION_WRAPPER_METHODS,
  PHYSICAL_LEDGER_APPROVAL,
  REPLACEMENT_AUDIT_KEYS,
  createOneShotPostReplaceReadFailureAdapters,
  createNormalRevision2StageTrackingAdapters,
  createNormalRevisionDiagnostic,
  parseCommandLine,
  runPhysicalLedgerProof,
  serializeNormalRevisionDiagnostic,
  validateNormalRevisionDiagnostic
};
