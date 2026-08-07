"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const test = require("node:test");
const { PHASES } = require("../scripts/social-3a0p-local-harness-core");
const {
  EvidenceLedgerFailure,
  createSanitizedEvidenceLedger
} = require("../scripts/social-3a0p-local-evidence-ledger");
const {
  bootstrapStageFailure,
  validateBootstrapDiagnostic
} = require("../scripts/social-3a0p-local-evidence-bootstrap-diagnostic");
const {
  persistenceStageFailure,
  validatePersistenceDiagnostic
} = require("../scripts/social-3a0p-local-evidence-persistence-diagnostic");
const {
  createFileReplaceExceptionDiagnostic
} = require("../scripts/social-3a0p-local-file-replace-diagnostic");
const {
  createFileReplaceArgumentDiagnostic
} = require("../scripts/social-3a0p-local-file-replace-argument-diagnostic");
const {
  validateTempValidationDiagnostic
} = require("../scripts/social-3a0p-local-temp-validation-diagnostic");

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const HARNESS_COMMIT = "a".repeat(40);
const PRODUCT_COMMIT = "b".repeat(40);
const EXECUTION_PHASES = PHASES.filter((phase) => phase !== "cleanup");

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function securityProof(overrides = {}) {
  return {
    ownerCurrentUser: true,
    inheritanceProtected: true,
    currentUserFullControl: true,
    systemFullControl: true,
    administratorsFullControl: true,
    explicitAllowRuleCount: 3,
    currentUserAllowRuleCount: 1,
    systemAllowRuleCount: 1,
    administratorsAllowRuleCount: 1,
    inheritedRuleCount: 0,
    denyRuleCount: 0,
    unexpectedAllowRuleCount: 0,
    ...overrides
  };
}

function fakeFilesystem(options = {}) {
  const files = new Map();
  const secured = new Set();
  const calls = [];
  let replaceCount = 0;
  let flushCount = 0;
  let readCount = 0;
  let writeCount = 0;
  let prepareCount = 0;
  let finalizeCount = 0;
  let rollbackCount = 0;
  const transactions = new Map();
  const adapter = {
    async prepareProtectedDirectory(input) {
      calls.push(["prepareProtectedDirectory", input]);
      if (options.prepareError) throw options.prepareError;
      return options.prepareResult !== false;
    },
    async assertNoReparseComponents(input) {
      calls.push(["assertNoReparseComponents", input]);
      if (options.reparseError) throw options.reparseError;
      return options.reparse !== true;
    },
    async inspectProtectedAcl(target) {
      calls.push(["inspectProtectedAcl", target]);
      if (options.inspectError) throw options.inspectError;
      if (options.rootAcl && target === options.evidenceRoot) return options.rootAcl;
      if (options.fileAcl && target !== options.evidenceRoot) return options.fileAcl;
      return securityProof();
    },
    async exists(target) {
      return files.has(target);
    },
    async readFile(target) {
      readCount += 1;
      if (options.failReadAt === readCount) {
        throw Object.assign(new Error("synthetic read failure"), { code: "EBUSY" });
      }
      if (!files.has(target)) throw Object.assign(new Error("synthetic missing"), { code: "ENOENT" });
      return Buffer.from(files.get(target));
    },
    async writeFileCreateNew(target, bytes) {
      writeCount += 1;
      calls.push(["writeFileCreateNew", target]);
      if (options.writeError) throw options.writeError;
      if (options.failWriteAt === writeCount) {
        throw Object.assign(
          new Error("synthetic write failure"),
          { code: options.writeFailureCode || "EBUSY" }
        );
      }
      if (files.has(target)) throw Object.assign(new Error("synthetic exists"), { code: "EEXIST" });
      files.set(target, Buffer.from(bytes));
    },
    async flushFile(target) {
      flushCount += 1;
      calls.push(["flushFile", target]);
      if (options.failFlushAt === flushCount) throw new Error("synthetic flush failure");
      return true;
    },
    async applyProtectedAcl(target) {
      calls.push(["applyProtectedAcl", target]);
      if (options.applyAclError) throw options.applyAclError;
      if (options.applyAclResult === false) return false;
      secured.add(target);
      return true;
    },
    async prepareFileReplacement(input) {
      prepareCount += 1;
      calls.push(["prepareFileReplacement", input]);
      if (options.failPrepareAt === prepareCount) {
        throw new Error("synthetic prepare failure");
      }
      const {
        temporaryPath,
        targetPath,
        backupPath,
        recoveryPath,
        expectedPreviousSha256,
        expectedReplacementSha256
      } = input;
      const hadPrevious = expectedPreviousSha256 !== null;
      const targetMatches = hadPrevious
        ? files.has(targetPath) &&
          sha256(files.get(targetPath)) === expectedPreviousSha256
        : !files.has(targetPath);
      if (
        !files.has(temporaryPath) ||
        sha256(files.get(temporaryPath)) !== expectedReplacementSha256 ||
        !targetMatches ||
        files.has(backupPath) ||
        files.has(recoveryPath)
      ) {
        throw new Error("synthetic prepare refused");
      }
      const transactionId = prepareCount.toString(16).padStart(32, "0");
      transactions.set(transactionId, {
        ...input,
        hadPrevious,
        state: "prepared"
      });
      return { transactionId, hadPrevious };
    },
    async replaceFileAtomic({ transactionId }) {
      replaceCount += 1;
      calls.push(["replaceFileAtomic", transactionId]);
      const transaction = transactions.get(transactionId);
      if (!transaction) throw new Error("synthetic transaction missing");
      if (options.replaceErrorAt === replaceCount) throw options.replaceError;
      if (options.failReplaceAt === replaceCount) {
        return { committed: false, previousMatched: false };
      }
      if (transaction.hadPrevious) {
        files.set(
          transaction.backupPath,
          Buffer.from(files.get(transaction.targetPath))
        );
        secured.add(transaction.backupPath);
      }
      files.set(
        transaction.targetPath,
        Buffer.from(files.get(transaction.temporaryPath))
      );
      files.delete(transaction.temporaryPath);
      secured.delete(transaction.temporaryPath);
      secured.add(transaction.targetPath);
      calls.push(["adapterPostReplaceNativeAudit", "target"]);
      if (transaction.hadPrevious) {
        calls.push(["adapterPostReplaceNativeAudit", "backup"]);
      }
      transaction.state = "committed";
      if (options.replaceErrorAfterMutationAt === replaceCount) {
        throw options.replaceErrorAfterMutation ||
          new Error("synthetic post-mutation replace failure");
      }
      return { committed: true, previousMatched: true };
    },
    async finalizeFileReplacement({ transactionId }) {
      finalizeCount += 1;
      calls.push(["finalizeFileReplacement", transactionId]);
      const transaction = transactions.get(transactionId);
      if (!transaction) throw new Error("synthetic transaction missing");
      if (options.failFinalizeAt === finalizeCount) {
        throw new Error("synthetic finalize failure");
      }
      if (transaction.hadPrevious) {
        files.delete(transaction.backupPath);
        secured.delete(transaction.backupPath);
      }
      transactions.delete(transactionId);
      return {
        finalized: true,
        previousRevisionBackupRemoved: transaction.hadPrevious
      };
    },
    async rollbackFileReplacement({ transactionId }) {
      rollbackCount += 1;
      calls.push(["rollbackFileReplacement", transactionId]);
      const transaction = transactions.get(transactionId);
      if (!transaction) throw new Error("synthetic transaction missing");
      if (options.failRollbackAt === rollbackCount) {
        throw new Error("synthetic rollback failure");
      }
      let failedCandidatePreserved = false;
      if (transaction.hadPrevious) {
        if (files.has(transaction.backupPath)) {
          files.set(
            transaction.recoveryPath,
            Buffer.from(files.get(transaction.targetPath))
          );
          secured.add(transaction.recoveryPath);
          files.set(
            transaction.targetPath,
            Buffer.from(files.get(transaction.backupPath))
          );
          files.delete(transaction.backupPath);
          secured.delete(transaction.backupPath);
          failedCandidatePreserved = true;
          calls.push(["adapterPostRollbackNativeAudit", "target"]);
          files.delete(transaction.recoveryPath);
          secured.delete(transaction.recoveryPath);
          calls.push(["adapterRollbackCandidateCleanup", "recovery"]);
        }
      } else if (files.has(transaction.targetPath)) {
        files.delete(transaction.targetPath);
        secured.delete(transaction.targetPath);
        failedCandidatePreserved = true;
      }
      transactions.delete(transactionId);
      return {
        rollbackCompleted: true,
        previousLedgerRestored: true,
        failedCandidatePreserved,
        failedCandidateRemovedAfterRestore: failedCandidatePreserved
      };
    },
    async removeOwnedTemporaryFile({ temporaryPath }) {
      calls.push(["removeOwnedTemporaryFile", temporaryPath]);
      if (options.failTemporaryRemoval === true) {
        throw new Error("synthetic temporary removal failure");
      }
      files.delete(temporaryPath);
      secured.delete(temporaryPath);
      return true;
    },
    async cleanupFailedInitialization(input) {
      calls.push(["cleanupFailedInitialization", input]);
      return options.failInitializationCleanup !== true && files.size === 0;
    }
  };
  return { adapter, calls, files, secured, transactions };
}

function fixture(options = {}) {
  const controlledRoot = path.resolve("C:\\synthetic-social-3a0p-gate");
  const evidenceRoot = path.join(controlledRoot, "evidence-ledger");
  const cleanupRoot = path.join(controlledRoot, "ia4tube-social-3a0p-Ab12Z9");
  const filesystem = fakeFilesystem({ evidenceRoot, ...options });
  let milliseconds = Date.UTC(2026, 7, 5, 12, 0, 0);
  const ledger = createSanitizedEvidenceLedger({
    runId: RUN_ID,
    harnessCommit: HARNESS_COMMIT,
    productCommit: PRODUCT_COMMIT,
    controlledRoot,
    evidenceRoot,
    cleanupRoot,
    adapters: filesystem.adapter,
    now: () => {
      milliseconds += 100;
      return milliseconds;
    },
    nonce: () => "c".repeat(16)
  });
  return { ledger, filesystem, controlledRoot, evidenceRoot, cleanupRoot };
}

function documentAt(ledger, filesystem) {
  const bytes = filesystem.files.get(ledger.paths.evidencePath);
  assert.ok(Buffer.isBuffer(bytes));
  return JSON.parse(bytes.toString("utf8"));
}

function expectCode(code) {
  return (error) =>
    error instanceof EvidenceLedgerFailure &&
    error.code === code &&
    error.message === code &&
    error.mustAbortPhysicalExecution === true;
}

function expectPersistenceFailure(code, stage) {
  return (error) =>
    expectCode(code)(error) &&
    validatePersistenceDiagnostic(error.persistenceDiagnostic) === true &&
    error.persistenceDiagnostic.sanitizedFailureCode === code &&
    error.persistenceDiagnostic.persistenceStage === stage;
}

test("initial evidence is atomically published outside the cleanup root with protected ACL", async () => {
  const { ledger, filesystem, evidenceRoot, cleanupRoot } = fixture();
  const result = await ledger.initialize({
    metrics: { package: { build: "18.4-2", bytes: 337445815 } },
    residues: { knownTemporaryRoots: 0 }
  });
  assert.equal(result.code, "evidence_ledger_persisted");
  assert.equal(result.revision, 1);
  assert.equal(path.dirname(ledger.paths.evidencePath), evidenceRoot);
  assert.equal(ledger.paths.evidencePath.startsWith(cleanupRoot), false);
  const persisted = documentAt(ledger, filesystem);
  const integritySha256 = persisted.integritySha256;
  delete persisted.integritySha256;
  assert.equal(sha256(Buffer.from(JSON.stringify(persisted))), integritySha256);
  assert.equal(persisted.revision, 1);
  assert.equal(persisted.status, "initialized");
  assert.deepEqual(persisted.metrics.package, { build: "18.4-2", bytes: 337445815 });
  assert.ok(filesystem.calls.some(([name]) => name === "flushFile"));
  assert.ok(filesystem.calls.some(([name]) => name === "applyProtectedAcl"));
  assert.ok(filesystem.calls.some(([name]) => name === "replaceFileAtomic"));
  assert.equal(
    [...filesystem.files.keys()].some((candidate) => candidate.endsWith(".tmp")),
    false
  );
});

test("a preflight failure is durable before phase 14 and cleanup augments the same ledger", async () => {
  const { ledger, filesystem } = fixture();
  await ledger.initialize();
  await ledger.beginPhase("preflight", {
    metrics: { preflight: { freeBytes: 8000000000, processCount: 0 } },
    residues: { knownTemporaryRoots: 1 }
  });
  await ledger.finishPhase("preflight", {
    status: "failed",
    code: "preflight_residue_detected"
  });
  let persisted = documentAt(ledger, filesystem);
  assert.equal(persisted.primaryFailureCode, "preflight_residue_detected");
  assert.equal(persisted.phases.length, 1);
  assert.equal(persisted.phases[0].status, "failed");
  assert.equal(persisted.lastCompletedPhase, null);
  assert.equal(persisted.cleanup.started, false);

  await ledger.beginCleanup({ residues: { knownTemporaryRoots: 0 } });
  await ledger.finishCleanup({
    status: "passed",
    code: "cleanup_passed",
    metrics: { cleanup: { processCount: 0, listenerCount: 0 } }
  });
  persisted = documentAt(ledger, filesystem);
  assert.equal(persisted.status, "failed");
  assert.equal(persisted.cleanup.started, true);
  assert.equal(persisted.cleanup.completed, true);
  assert.equal(persisted.cleanup.status, "passed");
  assert.equal(persisted.residues.knownTemporaryRoots, 0);
});

test("the same incremental contract persists sanitized failure evidence for every physical phase", async (t) => {
  for (const failedPhase of EXECUTION_PHASES) {
    await t.test(failedPhase, async () => {
      const { ledger, filesystem } = fixture();
      await ledger.initialize();
      for (const phase of EXECUTION_PHASES) {
        await ledger.beginPhase(phase);
        if (phase === failedPhase) {
          await ledger.finishPhase(phase, {
            status: "failed",
            code: `${phase.replaceAll("-", "_")}_synthetic_failure`
          });
          break;
        }
        await ledger.finishPhase(phase, {
          status: "passed",
          code: `${phase.replaceAll("-", "_")}_passed`
        });
      }
      const persisted = documentAt(ledger, filesystem);
      assert.equal(persisted.phases.at(-1).phase, failedPhase);
      assert.equal(persisted.phases.at(-1).status, "failed");
      assert.equal(
        persisted.primaryFailureCode,
        `${failedPhase.replaceAll("-", "_")}_synthetic_failure`
      );
    });
  }
});

test("atomic replacement failure preserves the preceding revision and removes the partial temp file", async () => {
  const { ledger, filesystem } = fixture({ failReplaceAt: 3 });
  await ledger.initialize();
  await ledger.beginPhase("preflight");
  const before = Buffer.from(filesystem.files.get(ledger.paths.evidencePath));
  let failure;
  await assert.rejects(
    ledger.finishPhase("preflight", {
      status: "failed",
      code: "preflight_synthetic_failure"
    }),
    (error) => {
      failure = error;
      return expectPersistenceFailure(
        "evidence_second_revision_atomic_replace_failed",
        "second_revision_atomic_replace"
      )(error);
    }
  );
  assert.equal(failure.persistenceDiagnostic.previousLedgerPreserved, true);
  assert.equal(failure.persistenceDiagnostic.temporaryFilePresent, true);
  assert.equal(failure.persistenceDiagnostic.cleanupAttempted, true);
  assert.equal(failure.persistenceDiagnostic.cleanupCompleted, true);
  assert.equal(failure.tempValidationDiagnostic, undefined);
  assert.deepEqual(filesystem.files.get(ledger.paths.evidencePath), before);
  assert.equal(
    ledger.getPersistenceFailureCode(),
    "evidence_second_revision_atomic_replace_failed"
  );
  assert.equal(
    [...filesystem.files.keys()].some((candidate) => candidate.endsWith(".tmp")),
    false
  );
  assert.ok(
    filesystem.calls.some(([name]) => name === "removeOwnedTemporaryFile")
  );
});

test("three complete snapshots use explicit backups and finalize only after validation", async () => {
  const { ledger, filesystem } = fixture();
  const first = await ledger.initialize();
  const firstBytes = Buffer.from(filesystem.files.get(ledger.paths.evidencePath));
  const second = await ledger.recordAvailableEvidence({
    metrics: { proof: { revision: 2 } }
  });
  const secondBytes = Buffer.from(filesystem.files.get(ledger.paths.evidencePath));
  const third = await ledger.recordAvailableEvidence({
    metrics: { proof: { revision: 3 } }
  });
  const thirdBytes = Buffer.from(filesystem.files.get(ledger.paths.evidencePath));
  assert.deepEqual([first.revision, second.revision, third.revision], [1, 2, 3]);
  assert.equal(first.replacement.explicitBackupPrepared, false);
  for (const result of [second, third]) {
    assert.equal(result.replacement.explicitBackupPrepared, true);
    assert.equal(result.replacement.explicitBackupValidated, true);
    assert.equal(
      result.replacement.explicitBackupMatchesPreviousRevision,
      true
    );
    assert.equal(result.replacement.newLedgerValidated, true);
    assert.equal(result.replacement.backupRemovedAfterValidation, true);
    assert.equal(result.replacement.rollbackRequired, false);
  }
  assert.notEqual(sha256(firstBytes), sha256(secondBytes));
  assert.notEqual(sha256(secondBytes), sha256(thirdBytes));
  assert.equal(documentAt(ledger, filesystem).revision, 3);
  assert.equal(
    [...filesystem.files.keys()].some((candidate) =>
      /\.(?:tmp|previous\.bak|failed\.bak)$/.test(candidate)
    ),
    false
  );
  const operations = filesystem.calls.map(([name]) => name);
  assert.equal(operations.filter((name) => name === "prepareFileReplacement").length, 3);
  assert.equal(operations.filter((name) => name === "finalizeFileReplacement").length, 3);
  assert.equal(operations.includes("rollbackFileReplacement"), false);
});

test("ledger orchestration follows the approved replace-audit-validate order without a second multipath audit", async () => {
  const { ledger, filesystem } = fixture();
  await ledger.initialize();
  filesystem.calls.length = 0;

  await ledger.recordAvailableEvidence({
    metrics: { proof: { revision: 2 } }
  });

  const operations = filesystem.calls.map(([name]) => name);
  const replaceIndex = operations.indexOf("replaceFileAtomic");
  const targetAuditIndex = operations.indexOf("adapterPostReplaceNativeAudit");
  const finalizeIndex = operations.indexOf("finalizeFileReplacement");
  assert.ok(replaceIndex >= 0);
  assert.ok(targetAuditIndex > replaceIndex);
  assert.ok(finalizeIndex > targetAuditIndex);
  assert.equal(
    operations
      .slice(replaceIndex + 1)
      .filter((name) => name === "assertNoReparseComponents")
      .length,
    0
  );
});

test("a failure after promotion rolls back atomically to the preceding bytes", async () => {
  const { ledger, filesystem } = fixture({ failReadAt: 5 });
  await ledger.initialize();
  const before = Buffer.from(filesystem.files.get(ledger.paths.evidencePath));
  let failure;
  await assert.rejects(
    ledger.recordAvailableEvidence({ metrics: { proof: { revision: 2 } } }),
    (error) => {
      failure = error;
      return expectPersistenceFailure(
        "evidence_second_revision_reopen_failed",
        "second_revision_reopen"
      )(error);
    }
  );
  assert.deepEqual(filesystem.files.get(ledger.paths.evidencePath), before);
  assert.equal(ledger.snapshot().revision, 1);
  assert.equal(failure.persistenceDiagnostic.rollbackRequired, true);
  assert.equal(failure.persistenceDiagnostic.rollbackAttempted, true);
  assert.equal(failure.persistenceDiagnostic.rollbackCompleted, true);
  assert.equal(failure.persistenceDiagnostic.previousLedgerRestored, true);
  assert.equal(failure.persistenceDiagnostic.previousLedgerPreserved, true);
  assert.equal(failure.persistenceDiagnostic.failedCandidatePreserved, true);
  assert.equal(
    failure.persistenceDiagnostic.failedCandidateRemovedAfterRestore,
    true
  );
  assert.equal(
    [...filesystem.files.keys()].some((candidate) =>
      /\.(?:tmp|previous\.bak|failed\.bak)$/.test(candidate)
    ),
    false
  );
});

test("rollback conformance preserves the approved replace-audit-rollback-audit-cleanup order", async () => {
  const { ledger, filesystem } = fixture({ failReadAt: 5 });
  await ledger.initialize();
  const previous = Buffer.from(filesystem.files.get(ledger.paths.evidencePath));
  filesystem.calls.length = 0;

  await assert.rejects(
    ledger.recordAvailableEvidence({ metrics: { proof: { revision: 2 } } }),
    expectPersistenceFailure(
      "evidence_second_revision_reopen_failed",
      "second_revision_reopen"
    )
  );

  const operations = filesystem.calls.map(([name]) => name);
  const ordered = [
    "replaceFileAtomic",
    "adapterPostReplaceNativeAudit",
    "rollbackFileReplacement",
    "adapterPostRollbackNativeAudit",
    "adapterRollbackCandidateCleanup"
  ].map((name) => operations.indexOf(name));
  assert.ok(ordered.every((index) => index >= 0));
  assert.deepEqual([...ordered].sort((left, right) => left - right), ordered);
  assert.deepEqual(filesystem.files.get(ledger.paths.evidencePath), previous);
  assert.equal(
    [...filesystem.files.keys()].some((candidate) =>
      /\.(?:tmp|previous\.bak|failed\.bak)$/.test(candidate)
    ),
    false
  );
});

test("an exception after File.Replace is reconciled by the same transaction rollback", async () => {
  const { ledger, filesystem } = fixture({
    replaceErrorAfterMutationAt: 2,
    replaceErrorAfterMutation: new Error("synthetic opaque replace exit")
  });
  await ledger.initialize();
  const before = Buffer.from(filesystem.files.get(ledger.paths.evidencePath));
  let failure;
  await assert.rejects(ledger.recordAvailableEvidence(), (error) => {
    failure = error;
    return expectPersistenceFailure(
      "evidence_second_revision_atomic_replace_failed",
      "second_revision_atomic_replace"
    )(error);
  });
  assert.deepEqual(filesystem.files.get(ledger.paths.evidencePath), before);
  assert.equal(failure.persistenceDiagnostic.rollbackCompleted, true);
  assert.equal(failure.persistenceDiagnostic.previousLedgerRestored, true);
  assert.equal(filesystem.transactions.size, 0);
});

test("finalize failure rolls back and never advances the in-memory revision", async () => {
  const { ledger, filesystem } = fixture({ failFinalizeAt: 2 });
  await ledger.initialize();
  const before = Buffer.from(filesystem.files.get(ledger.paths.evidencePath));
  let failure;
  await assert.rejects(ledger.recordAvailableEvidence(), (error) => {
    failure = error;
    return expectPersistenceFailure(
      "evidence_second_revision_finalize_failed",
      "second_revision_finalize"
    )(error);
  });
  assert.deepEqual(filesystem.files.get(ledger.paths.evidencePath), before);
  assert.equal(ledger.snapshot().revision, 1);
  assert.equal(failure.persistenceDiagnostic.newLedgerValidated, true);
  assert.equal(failure.persistenceDiagnostic.rollbackCompleted, true);
  assert.equal(failure.persistenceDiagnostic.previousLedgerRestored, true);
  assert.equal(failure.persistenceDiagnostic.backupRemovedAfterValidation, false);
  assert.equal(filesystem.transactions.size, 0);
});

test("rollback failure preserves the valid backup and reports a sanitized recovery residue", async () => {
  const { ledger, filesystem } = fixture({
    failFinalizeAt: 2,
    failRollbackAt: 1
  });
  await ledger.initialize();
  const before = Buffer.from(filesystem.files.get(ledger.paths.evidencePath));
  let failure;
  await assert.rejects(ledger.recordAvailableEvidence(), (error) => {
    failure = error;
    return expectPersistenceFailure(
      "evidence_second_revision_rollback_failed",
      "second_revision_rollback"
    )(error);
  });
  assert.notDeepEqual(filesystem.files.get(ledger.paths.evidencePath), before);
  const backups = [...filesystem.files.entries()].filter(([candidate]) =>
    candidate.endsWith(".previous.bak")
  );
  assert.equal(backups.length, 1);
  assert.deepEqual(backups[0][1], before);
  assert.equal(ledger.snapshot().revision, 1);
  assert.equal(ledger.snapshot().residues.evidenceRecoveryFiles, 1);
  assert.equal(failure.persistenceDiagnostic.rollbackAttempted, true);
  assert.equal(failure.persistenceDiagnostic.rollbackCompleted, false);
  assert.equal(failure.persistenceDiagnostic.previousLedgerRestored, false);
  assert.equal(failure.persistenceDiagnostic.explicitBackupValidated, true);
  assert.equal(
    failure.persistenceDiagnostic.explicitBackupMatchesPreviousRevision,
    true
  );
  assert.equal(failure.persistenceDiagnostic.cleanupAttempted, false);
  assert.doesNotMatch(JSON.stringify(failure.persistenceDiagnostic), /Users|\\|secret|stack/i);
});

test("concurrent persistence is deterministically refused without revision collision", async () => {
  const { ledger, filesystem } = fixture();
  await ledger.initialize();
  const first = ledger.beginPhase("preflight");
  await assert.rejects(
    ledger.recordAvailableEvidence({ metrics: { proof: { concurrent: true } } }),
    expectCode("evidence_ledger_concurrent_update_refused")
  );
  const result = await first;
  assert.equal(result.revision, 2);
  assert.equal(documentAt(ledger, filesystem).revision, 2);
  assert.equal(filesystem.transactions.size, 0);
});

test("sanitized File.Replace exception evidence crosses the ledger boundary without raw data", async () => {
  const fileReplaceDiagnostic = createFileReplaceExceptionDiagnostic({
    exception: {
      type: "System.Management.Automation.MethodInvocationException",
      hresult: "0x80131501",
      innerException: {
        type: "System.IO.IOException",
        hresult: "0x80070020",
        message: "C:\\Users\\private\\ledger.json"
      }
    },
    powershellCategory: "InvalidOperation",
    fullyQualifiedErrorId: "MethodInvocationException"
  });
  const fileReplaceArgumentDiagnostic = createFileReplaceArgumentDiagnostic({
    backupArgumentBound: true,
    backupArgument: "protected-backup",
    replaceOverloadArity: 4,
    ignoreMetadataErrors: true,
    sourceExists: true,
    destinationExists: true,
    sourceAndDestinationSameDirectory: true,
    sourceAndDestinationSameVolume: true
  });
  const raw = Object.assign(new Error("private raw error"), {
    systemErrorClass: "filesystem",
    systemErrorCode: "EBUSY"
  });
  Object.defineProperty(raw, "fileReplaceDiagnostic", {
    value: fileReplaceDiagnostic
  });
  Object.defineProperty(raw, "fileReplaceArgumentDiagnostic", {
    value: fileReplaceArgumentDiagnostic
  });
  const staged = persistenceStageFailure(
    raw,
    "evidence_second_revision_atomic_replace_failed"
  );
  const { ledger, filesystem } = fixture({
    replaceErrorAt: 2,
    replaceError: staged
  });
  await ledger.initialize();
  const before = Buffer.from(filesystem.files.get(ledger.paths.evidencePath));
  let failure;
  await assert.rejects(ledger.beginPhase("preflight"), (error) => {
    failure = error;
    return expectPersistenceFailure(
      "evidence_second_revision_atomic_replace_failed",
      "second_revision_atomic_replace"
    )(error);
  });
  assert.deepEqual(failure.fileReplaceDiagnostic, fileReplaceDiagnostic);
  assert.deepEqual(
    failure.fileReplaceArgumentDiagnostic,
    fileReplaceArgumentDiagnostic
  );
  assert.deepEqual(filesystem.files.get(ledger.paths.evidencePath), before);
  assert.equal(
    [...filesystem.files.keys()].some((candidate) => candidate.endsWith(".tmp")),
    false
  );
  assert.doesNotMatch(
    JSON.stringify({
      persistenceDiagnostic: failure.persistenceDiagnostic,
      fileReplaceDiagnostic: failure.fileReplaceDiagnostic,
      fileReplaceArgumentDiagnostic: failure.fileReplaceArgumentDiagnostic
    }),
    /Users|private|ledger\.json|raw error/i
  );
});

test("file fsync failure is fail-closed, preserves prior evidence and removes the temp file", async () => {
  const { ledger, filesystem } = fixture({ failFlushAt: 2 });
  await ledger.initialize();
  const before = Buffer.from(filesystem.files.get(ledger.paths.evidencePath));
  await assert.rejects(
    ledger.beginPhase("preflight"),
    expectPersistenceFailure(
      "evidence_second_revision_flush_failed",
      "second_revision_flush"
    )
  );
  assert.deepEqual(filesystem.files.get(ledger.paths.evidencePath), before);
  assert.equal(
    [...filesystem.files.keys()].some((candidate) => candidate.endsWith(".tmp")),
    false
  );
});

test("temporary removal failure is recorded in memory as a sanitized residue and remains fail-closed", async () => {
  const { ledger, filesystem } = fixture({
    failFlushAt: 2,
    failTemporaryRemoval: true
  });
  await ledger.initialize();
  const before = Buffer.from(filesystem.files.get(ledger.paths.evidencePath));
  await assert.rejects(
    ledger.beginPhase("preflight"),
    expectPersistenceFailure(
      "evidence_second_revision_temp_cleanup_failed",
      "second_revision_temp_cleanup"
    )
  );
  assert.deepEqual(filesystem.files.get(ledger.paths.evidencePath), before);
  assert.equal(
    ledger.getPersistenceFailureCode(),
    "evidence_second_revision_temp_cleanup_failed"
  );
  assert.equal(
    ledger.getTemporaryCleanupFailureCode(),
    "evidence_ledger_temporary_cleanup_failed"
  );
  const memory = ledger.snapshot();
  assert.equal(
    memory.temporaryCleanupFailureCode,
    "evidence_ledger_temporary_cleanup_failed"
  );
  assert.equal(memory.residues.evidenceTemporaryFiles, 1);
  assert.equal(
    [...filesystem.files.keys()].some((candidate) => candidate.endsWith(".tmp")),
    true
  );
  assert.doesNotMatch(memory.temporaryCleanupFailureCode, /path|user|secret/i);
});

test("a persistence error stays authoritative even if cleanup can later be recorded", async () => {
  const { ledger, filesystem } = fixture({ failReplaceAt: 3 });
  await ledger.initialize();
  await ledger.beginPhase("preflight");
  await assert.rejects(
    ledger.finishPhase("preflight", {
      status: "failed",
      code: "preflight_synthetic_failure"
    }),
    expectPersistenceFailure(
      "evidence_second_revision_atomic_replace_failed",
      "second_revision_atomic_replace"
    )
  );
  await ledger.beginCleanup();
  await ledger.finishCleanup({ status: "passed", code: "cleanup_passed" });
  const persisted = documentAt(ledger, filesystem);
  assert.equal(
    persisted.persistenceFailureCode,
    "evidence_second_revision_atomic_replace_failed"
  );
  assert.equal(persisted.status, "failed");
  assert.equal(persisted.cleanup.completed, true);
});

test("a cleanup failure is appended without erasing the earlier phase failure", async () => {
  const { ledger, filesystem } = fixture();
  await ledger.initialize();
  await ledger.beginPhase("preflight");
  await ledger.finishPhase("preflight", {
    status: "failed",
    code: "preflight_synthetic_failure"
  });
  await ledger.beginCleanup({ residues: { knownTemporaryRoots: 1 } });
  await ledger.finishCleanup({
    status: "failed",
    code: "cleanup_residue_remained",
    residues: { knownTemporaryRoots: 1 },
    metrics: { cleanup: { processCount: 0, listenerCount: 0 } }
  });
  const persisted = documentAt(ledger, filesystem);
  assert.equal(persisted.primaryFailureCode, "preflight_synthetic_failure");
  assert.equal(persisted.cleanup.completed, true);
  assert.equal(persisted.cleanup.status, "failed");
  assert.equal(persisted.cleanup.failureCode, "cleanup_residue_remained");
  assert.equal(persisted.residues.knownTemporaryRoots, 1);
});

test("root ACL drift blocks initialization before any evidence file is created", async () => {
  const { ledger, filesystem } = fixture({
    rootAcl: securityProof({ unexpectedAllowRuleCount: 1 })
  });
  await assert.rejects(
    ledger.initialize(),
    expectCode("evidence_root_acl_validation_failed")
  );
  assert.equal(filesystem.files.size, 0);
});

test("ACL proof requires exactly one full-control rule for each approved principal", async (t) => {
  for (const [name, drift] of [
    ["system missing", { systemFullControl: false, systemAllowRuleCount: 0, explicitAllowRuleCount: 2 }],
    ["administrator incomplete", { administratorsFullControl: false }],
    ["duplicate current user", { currentUserAllowRuleCount: 2, explicitAllowRuleCount: 4 }],
    ["unexpected fourth identity", { unexpectedAllowRuleCount: 1, explicitAllowRuleCount: 4 }]
  ]) {
    await t.test(name, async () => {
      const { ledger, filesystem } = fixture({
        rootAcl: securityProof(drift)
      });
      await assert.rejects(
        ledger.initialize(),
        expectCode("evidence_root_acl_validation_failed")
      );
      assert.equal(filesystem.files.size, 0);
    });
  }
});

test("file ACL failure removes the owned temp and never promotes it", async () => {
  const { ledger, filesystem } = fixture({
    fileAcl: securityProof({ inheritanceProtected: false })
  });
  await assert.rejects(
    ledger.initialize(),
    expectCode("evidence_root_acl_validation_failed")
  );
  assert.equal(filesystem.files.size, 0);
  assert.ok(
    filesystem.calls.some(([name]) => name === "removeOwnedTemporaryFile")
  );
});

test("a reparse component is refused before a write", async () => {
  const { ledger, filesystem } = fixture({ reparse: true });
  await assert.rejects(
    ledger.initialize(),
    expectCode("evidence_root_reparse_detected")
  );
  assert.equal(
    filesystem.calls.some(([name]) => name === "writeFileCreateNew"),
    false
  );
});

test("secret-shaped keys and values are refused without disclosing input", async () => {
  const { ledger, filesystem } = fixture();
  await ledger.initialize();
  const before = Buffer.from(filesystem.files.get(ledger.paths.evidencePath));
  for (const metrics of [
    { runtime: { databaseUrl: "synthetic" } },
    { runtime: { label: "postgresql://synthetic:synthetic@invalid/db" } },
    { runtime: { label: "Bearer synthetic-material" } }
  ]) {
    let failure;
    try {
      await ledger.recordAvailableEvidence({ metrics });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure instanceof EvidenceLedgerFailure);
    assert.doesNotMatch(failure.message, /postgres|bearer|synthetic-material/i);
  }
  assert.deepEqual(filesystem.files.get(ledger.paths.evidencePath), before);
});

test("an unexpected pre-existing target is refused rather than overwritten", async () => {
  const { ledger, filesystem } = fixture();
  filesystem.files.set(ledger.paths.evidencePath, Buffer.from("unowned"));
  await assert.rejects(
    ledger.initialize(),
    expectCode("evidence_ledger_first_revision_failed")
  );
  assert.equal(filesystem.files.get(ledger.paths.evidencePath).toString(), "unowned");
});

test("tampering with the prior revision blocks the next update before replacement", async () => {
  const { ledger, filesystem } = fixture();
  await ledger.initialize();
  filesystem.files.set(ledger.paths.evidencePath, Buffer.from("tampered"));
  let failure;
  await assert.rejects(
    ledger.beginPhase("preflight"),
    (error) => {
      failure = error;
      return expectPersistenceFailure(
        "evidence_second_revision_prepare_failed",
        "second_revision_prepare"
      )(error);
    }
  );
  assert.equal(
    validateTempValidationDiagnostic(failure.tempValidationDiagnostic),
    true
  );
  assert.deepEqual(failure.tempValidationDiagnostic, {
    scenario: "normal_persistence",
    revisionNumber: 2,
    replacementOccurred: false,
    tempValidationStage:
      "second_revision_previous_ledger_integrity_validate",
    sanitizedFailureClass: "integrity",
    sanitizedFailureCode: "HASH_MISMATCH",
    expectedConditionClass: "match",
    actualConditionClass: "mismatch",
    previousLedgerPreserved: false,
    temporaryFilePresent: false,
    backupPrepared: false,
    rollbackRequired: false,
    cleanupAttempted: true,
    cleanupCompleted: true
  });
  assert.doesNotMatch(
    JSON.stringify(failure.tempValidationDiagnostic),
    /tampered|synthetic-social|Users|\\/i
  );
  assert.equal(filesystem.files.get(ledger.paths.evidencePath).toString(), "tampered");
});

test("a later write failure never inherits a successful prior-integrity stage", async () => {
  const { ledger } = fixture({ failWriteAt: 2, writeFailureCode: "EBUSY" });
  await ledger.initialize();
  let failure;
  await assert.rejects(ledger.beginPhase("preflight"), (error) => {
    failure = error;
    return expectPersistenceFailure(
      "evidence_second_revision_write_failed",
      "second_revision_write"
    )(error);
  });
  assert.equal(failure.tempValidationDiagnostic, undefined);
});

test("a second-revision close or flush failure is classified before replacement", async () => {
  const { ledger } = fixture({ failFlushAt: 2 });
  await ledger.initialize();
  let failure;
  await assert.rejects(ledger.beginPhase("preflight"), (error) => {
    failure = error;
    return expectPersistenceFailure(
      "evidence_second_revision_flush_failed",
      "second_revision_flush"
    )(error);
  });
  assert.equal(
    validateTempValidationDiagnostic(failure.tempValidationDiagnostic),
    true
  );
  assert.equal(
    failure.tempValidationDiagnostic.tempValidationStage,
    "second_revision_temp_handle_closed_validate"
  );
  assert.equal(failure.tempValidationDiagnostic.sanitizedFailureCode, "UNKNOWN");
  assert.equal(failure.tempValidationDiagnostic.replacementOccurred, false);
});

test("the original pre-spawn environment failure is classified without raw details", async () => {
  const raw = Object.assign(
    new Error("C:\\Users\\private\\raw-message"),
    { code: "harness_process_environment_key_refused" }
  );
  const { ledger, filesystem } = fixture({
    prepareError: bootstrapStageFailure(
      raw,
      "evidence_parent_validation_failed"
    )
  });
  let failure;
  try {
    await ledger.initialize();
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof EvidenceLedgerFailure);
  assert.equal(failure.code, "evidence_parent_validation_failed");
  assert.equal(validateBootstrapDiagnostic(failure.bootstrapDiagnostic), true);
  assert.equal(failure.bootstrapDiagnostic.bootstrapStage, "parent_validation");
  assert.equal(
    failure.bootstrapDiagnostic.systemErrorClass,
    "harness_validation"
  );
  assert.equal(failure.bootstrapDiagnostic.systemErrorCode, "UNKNOWN");
  assert.equal(failure.bootstrapDiagnostic.cleanupAttempted, true);
  assert.equal(failure.bootstrapDiagnostic.cleanupCompleted, true);
  assert.doesNotMatch(JSON.stringify(failure.bootstrapDiagnostic), /Users|private|raw/i);
  assert.ok(
    filesystem.calls.some(([name]) => name === "cleanupFailedInitialization")
  );
});

test("bootstrap stages fail closed and attempt partial cleanup", async (t) => {
  const cases = [
    [
      "root create",
      { prepareResult: false },
      "evidence_root_create_failed",
      true
    ],
    [
      "root reparse",
      { reparse: true },
      "evidence_root_reparse_detected",
      true
    ],
    [
      "root owner mismatch",
      { rootAcl: securityProof({ ownerCurrentUser: false }) },
      "evidence_root_acl_validation_failed",
      true
    ],
    [
      "inherited ACL",
      { rootAcl: securityProof({ inheritanceProtected: false, inheritedRuleCount: 1 }) },
      "evidence_root_acl_validation_failed",
      true
    ],
    [
      "deny ACL",
      { rootAcl: securityProof({ denyRuleCount: 1 }) },
      "evidence_root_acl_validation_failed",
      true
    ],
    [
      "temporary create",
      {
        writeError: bootstrapStageFailure(
          Object.assign(new Error("synthetic"), { code: "EEXIST" }),
          "evidence_ledger_temp_create_failed"
        )
      },
      "evidence_ledger_temp_create_failed",
      true
    ],
    [
      "first write",
      { failWriteAt: 1, writeFailureCode: "EBUSY" },
      "evidence_ledger_first_write_failed",
      true
    ],
    [
      "first flush",
      { failFlushAt: 1 },
      "evidence_ledger_flush_failed",
      true
    ],
    [
      "file ACL protection",
      { applyAclResult: false },
      "evidence_root_acl_protection_failed",
      true
    ],
    [
      "first atomic rename",
      { failReplaceAt: 1 },
      "evidence_ledger_atomic_rename_failed",
      true
    ],
    [
      "first reopen",
      { failReadAt: 2 },
      "evidence_ledger_reopen_failed",
      true
    ]
  ];
  for (const [name, options, expectedCode, cleanupCompleted] of cases) {
    await t.test(name, async () => {
      const { ledger } = fixture(options);
      let failure;
      try {
        await ledger.initialize();
      } catch (error) {
        failure = error;
      }
      assert.ok(failure instanceof EvidenceLedgerFailure);
      assert.equal(failure.code, expectedCode);
      assert.equal(validateBootstrapDiagnostic(failure.bootstrapDiagnostic), true);
      assert.equal(failure.bootstrapDiagnostic.cleanupAttempted, true);
      assert.equal(
        failure.bootstrapDiagnostic.cleanupCompleted,
        cleanupCompleted
      );
    });
  }
});

test("failed initialization cleanup is reported without replacing the primary stage", async () => {
  const { ledger } = fixture({
    prepareResult: false,
    failInitializationCleanup: true
  });
  let failure;
  try {
    await ledger.initialize();
  } catch (error) {
    failure = error;
  }
  assert.equal(failure.code, "evidence_root_create_failed");
  assert.equal(failure.bootstrapDiagnostic.cleanupAttempted, true);
  assert.equal(failure.bootstrapDiagnostic.cleanupCompleted, false);
});

test("phase ordering and exact active-phase matching are enforced", async () => {
  const { ledger } = fixture();
  await ledger.initialize();
  await assert.rejects(
    ledger.beginPhase("validate-package"),
    expectCode("evidence_ledger_phase_sequence_invalid")
  );
  await ledger.beginPhase("preflight");
  await assert.rejects(
    ledger.finishPhase("validate-package", {
      status: "passed",
      code: "validate_package_passed"
    }),
    expectCode("evidence_ledger_phase_finish_refused")
  );
});

test("evidence root may not overlap the cleanup root", () => {
  const controlledRoot = path.resolve("C:\\synthetic-overlap");
  const cleanupRoot = path.join(controlledRoot, "owned-run");
  const filesystem = fakeFilesystem({ evidenceRoot: path.join(cleanupRoot, "evidence") });
  assert.throws(
    () => createSanitizedEvidenceLedger({
      runId: RUN_ID,
      harnessCommit: HARNESS_COMMIT,
      productCommit: PRODUCT_COMMIT,
      controlledRoot,
      cleanupRoot,
      evidenceRoot: path.join(cleanupRoot, "evidence"),
      adapters: filesystem.adapter
    }),
    expectCode("evidence_ledger_path_scope_refused")
  );
});

test("noncanonical identity and commit inputs fail before filesystem access", () => {
  const controlledRoot = path.resolve("C:\\synthetic-identity");
  const evidenceRoot = path.join(controlledRoot, "evidence");
  const cleanupRoot = path.join(controlledRoot, "owned-run");
  const filesystem = fakeFilesystem({ evidenceRoot });
  for (const input of [
    { runId: RUN_ID, productCommit: PRODUCT_COMMIT },
    { runId: RUN_ID, harnessCommit: HARNESS_COMMIT },
    { runId: "customer-42", harnessCommit: HARNESS_COMMIT, productCommit: PRODUCT_COMMIT },
    { runId: RUN_ID, harnessCommit: "A".repeat(40), productCommit: PRODUCT_COMMIT },
    { runId: RUN_ID, harnessCommit: HARNESS_COMMIT, productCommit: "short" }
  ]) {
    assert.throws(
      () => createSanitizedEvidenceLedger({
        ...input,
        controlledRoot,
        evidenceRoot,
        cleanupRoot,
        adapters: filesystem.adapter
      }),
      (error) => error instanceof EvidenceLedgerFailure
    );
  }
  assert.equal(filesystem.calls.length, 0);
});
