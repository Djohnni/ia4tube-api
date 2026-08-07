"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  createWindowsEvidenceLedgerAdapters
} = require("../scripts/social-3a0p-local-windows-evidence-ledger-adapters");
const {
  createFileReplaceExceptionDiagnostic
} = require("../scripts/social-3a0p-local-file-replace-diagnostic");
const {
  createFileReplaceArgumentDiagnostic
} = require("../scripts/social-3a0p-local-file-replace-argument-diagnostic");

const POWERSHELL = path.resolve(
  "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
);

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function expectTempValidationFailure(stage, failureCode, actualConditionClass) {
  return (error) => {
    assert.deepEqual(error.tempValidationFailure, {
      tempValidationStage: stage,
      sanitizedFailureClass:
        stage.includes("owner") || stage.includes("hardlink")
          ? "ownership"
          : stage.includes("acl")
            ? "acl"
            : "filesystem",
      sanitizedFailureCode: failureCode,
      actualConditionClass
    });
    assert.doesNotMatch(
      JSON.stringify(error.tempValidationFailure),
      /Users|\\|ledger\.json|S-1-5|password|token/i
    );
    return true;
  };
}

function replacementPaths(target, revision, nonce = "a".repeat(16)) {
  const stem = `.${path.basename(target)}.${revision}.${nonce}`;
  return {
    temporaryPath: path.join(path.dirname(target), `${stem}.tmp`),
    backupPath: path.join(path.dirname(target), `${stem}.previous.bak`),
    recoveryPath: path.join(path.dirname(target), `${stem}.failed.bak`)
  };
}

async function prepareReplacement(base, {
  target,
  revision,
  bytes,
  expectedPreviousSha256
}) {
  const paths = replacementPaths(target, revision);
  await base.adapter.writeFileCreateNew(paths.temporaryPath, bytes);
  await base.adapter.flushFile(paths.temporaryPath);
  await base.adapter.applyProtectedAcl(paths.temporaryPath);
  const prepared = await base.adapter.prepareFileReplacement({
    ...paths,
    targetPath: target,
    expectedPreviousSha256,
    expectedReplacementSha256: sha256(bytes)
  });
  return { ...paths, ...prepared };
}

function fixture(options = {}) {
  const controlledRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "ia4tube-h2-evidence-adapter-")
  );
  const evidenceRoot = path.join(controlledRoot, "evidence");
  const cleanupRoot = path.join(controlledRoot, "owned-run");
  fs.mkdirSync(cleanupRoot);
  const processRunner = {
    async run(spec) {
      const target = spec.environment.IA4TUBE_EVIDENCE_TARGET;
      if (spec.label === "evidence_reparse_audit") {
        return {
          stdoutSanitized: JSON.stringify({
            ok: true,
            reparsePointDetected: false
          })
        };
      }
      if (spec.label === "evidence_acl_prepare") fs.mkdirSync(target);
      if (["evidence_atomic_replace", "evidence_atomic_rollback"].includes(spec.label)) {
        if (
          spec.label === "evidence_atomic_replace" &&
          options.atomicReplaceDiagnostic
        ) {
          return {
            stdoutSanitized: JSON.stringify({
              ok: false,
              argumentDiagnostic: options.atomicReplaceArgumentDiagnostic,
              exceptionDiagnostic: options.atomicReplaceDiagnostic
            })
          };
        }
        const source = spec.environment.IA4TUBE_EVIDENCE_SOURCE;
        const backup = spec.environment.IA4TUBE_EVIDENCE_BACKUP;
        fs.copyFileSync(target, backup, fs.constants.COPYFILE_EXCL);
        fs.rmSync(target);
        fs.renameSync(source, target);
        return {
          stdoutSanitized: JSON.stringify({
            ok: true,
            argumentDiagnostic: createFileReplaceArgumentDiagnostic({
              backupArgumentBound: true,
              backupArgument: "protected-backup",
              replaceOverloadArity: 4,
              ignoreMetadataErrors: true,
              sourceExists: true,
              destinationExists: true,
              sourceAndDestinationSameDirectory: true,
              sourceAndDestinationSameVolume: true
            })
          })
        };
      }
      if (spec.label === "evidence_acl_inspect") {
        return {
          stdoutSanitized: JSON.stringify(options.aclProof || {
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
            unexpectedAllowRuleCount: 0
          })
        };
      }
      return { stdoutSanitized: "{\"ok\":true}" };
    }
  };
  const adapter = createWindowsEvidenceLedgerAdapters({
    controlledRoot,
    evidenceRoot,
    cleanupRoot,
    powershell: POWERSHELL,
    processRunner,
    environment: {}
  });
  return { adapter, cleanupRoot, controlledRoot, evidenceRoot };
}

test("adapter persiste, sincroniza e substitui evidência atomicamente dentro da raiz protegida", async () => {
  const base = fixture();
  try {
    assert.equal(await base.adapter.prepareProtectedDirectory({
      controlledRoot: base.controlledRoot,
      evidenceRoot: base.evidenceRoot
    }), true);
    const target = path.join(base.evidenceRoot, "ledger.json");
    const first = Buffer.from("first", "utf8");
    const firstPrepared = await prepareReplacement(base, {
      target,
      revision: 1,
      bytes: first,
      expectedPreviousSha256: null
    });
    assert.deepEqual(
      await base.adapter.replaceFileAtomic({
        transactionId: firstPrepared.transactionId
      }),
      { committed: true, previousMatched: true }
    );
    assert.deepEqual(
      await base.adapter.finalizeFileReplacement({
        transactionId: firstPrepared.transactionId
      }),
      { finalized: true, previousRevisionBackupRemoved: false }
    );
    assert.deepEqual(await base.adapter.readFile(target), first);

    const second = Buffer.from("second", "utf8");
    const wrongPaths = replacementPaths(target, 2);
    await base.adapter.writeFileCreateNew(wrongPaths.temporaryPath, second);
    await base.adapter.applyProtectedAcl(wrongPaths.temporaryPath);
    await assert.rejects(
      base.adapter.prepareFileReplacement({
        ...wrongPaths,
        targetPath: target,
        expectedPreviousSha256: "0".repeat(64),
        expectedReplacementSha256: sha256(second)
      }),
      { code: "windows_evidence_previous_revision_mismatch" }
    );
    assert.deepEqual(await base.adapter.readFile(target), first);
    await base.adapter.removeOwnedTemporaryFile({
      temporaryPath: wrongPaths.temporaryPath,
      evidenceRoot: base.evidenceRoot
    });
    const secondPrepared = await prepareReplacement(base, {
      target,
      revision: 2,
      bytes: second,
      expectedPreviousSha256: sha256(first)
    });
    assert.deepEqual(
      await base.adapter.replaceFileAtomic({
        transactionId: secondPrepared.transactionId
      }),
      { committed: true, previousMatched: true }
    );
    assert.equal(fs.existsSync(secondPrepared.backupPath), true);
    assert.deepEqual(fs.readFileSync(secondPrepared.backupPath), first);
    assert.deepEqual(
      await base.adapter.finalizeFileReplacement({
        transactionId: secondPrepared.transactionId
      }),
      { finalized: true, previousRevisionBackupRemoved: true }
    );
    assert.equal(fs.existsSync(secondPrepared.backupPath), false);
    assert.deepEqual(await base.adapter.readFile(target), second);
    const acl = await base.adapter.inspectProtectedAcl(target);
    assert.equal(acl.inheritanceProtected, true);
    assert.equal(acl.ownerCurrentUser, true);
    assert.deepEqual(base.adapter.getReplacementAudit(), {
      explicitBackupPreparedCount: 1,
      explicitBackupValidatedCount: 1,
      explicitBackupMatchesPreviousRevisionCount: 1,
      newLedgerValidatedCount: 2,
      rollbackAttemptedCount: 0,
      rollbackCompletedCount: 0,
      previousLedgerRestoredCount: 0,
      failedCandidatePreservedCount: 0,
      failedCandidateRemovedAfterRestoreCount: 0,
      backupRemovedAfterValidationCount: 1,
      openTransactionCount: 0
    });
  } finally {
    fs.rmSync(base.controlledRoot, { recursive: true, force: true });
  }
});

test("adapter recusa escopo externo e remoção de arquivo que não seja temporário owned", async () => {
  const base = fixture();
  try {
    await base.adapter.prepareProtectedDirectory({
      controlledRoot: base.controlledRoot,
      evidenceRoot: base.evidenceRoot
    });
    await assert.rejects(
      base.adapter.writeFileCreateNew(
        path.join(base.controlledRoot, "outside.json"),
        Buffer.from("x")
      ),
      { code: "windows_evidence_write_target_refused" }
    );
    await assert.rejects(
      base.adapter.removeOwnedTemporaryFile({
        temporaryPath: path.join(base.evidenceRoot, "ledger.json"),
        evidenceRoot: base.evidenceRoot
      }),
      { code: "windows_evidence_temporary_remove_refused" }
    );
  } finally {
    fs.rmSync(base.controlledRoot, { recursive: true, force: true });
  }
});

test("o próprio controlledRoot reparse é recusado antes de qualquer ACL ou escrita", async () => {
  let processCalls = 0;
  const controlledRoot = path.resolve("C:\\synthetic-controlled-root");
  const adapter = createWindowsEvidenceLedgerAdapters({
    controlledRoot,
    evidenceRoot: path.join(controlledRoot, "evidence"),
    cleanupRoot: path.join(controlledRoot, "owned-run"),
    powershell: POWERSHELL,
    processRunner: { async run() { processCalls += 1; return { stdoutSanitized: "{}" }; } },
    environment: {},
    fileSystem: {
      existsSync: () => false,
      promises: {
        async lstat() { return { isSymbolicLink: () => true }; }
      }
    }
  });
  await assert.rejects(
    adapter.prepareProtectedDirectory({
      controlledRoot,
      evidenceRoot: path.join(controlledRoot, "evidence")
    }),
    { failureCode: "evidence_parent_validation_failed" }
  );
  assert.equal(processCalls, 0);
});

test("reparse NTFS não exposto como symlink também é recusado", async () => {
  let aclCalls = 0;
  let reparseCalls = 0;
  const controlledRoot = path.resolve("C:\\synthetic-nonsymlink-reparse");
  const adapter = createWindowsEvidenceLedgerAdapters({
    controlledRoot,
    evidenceRoot: path.join(controlledRoot, "evidence"),
    cleanupRoot: path.join(controlledRoot, "owned-run"),
    powershell: POWERSHELL,
    processRunner: {
      async run(spec) {
        if (spec.label === "evidence_reparse_audit") {
          reparseCalls += 1;
          return {
            stdoutSanitized: JSON.stringify({
              ok: false,
              reparsePointDetected: true
            })
          };
        }
        aclCalls += 1;
        return { stdoutSanitized: "{\"ok\":true}" };
      }
    },
    environment: {},
    fileSystem: {
      existsSync: () => false,
      promises: {
        async lstat() { return { isSymbolicLink: () => false }; }
      }
    }
  });
  await assert.rejects(
    adapter.prepareProtectedDirectory({
      controlledRoot,
      evidenceRoot: path.join(controlledRoot, "evidence")
    }),
    { failureCode: "evidence_parent_validation_failed" }
  );
  assert.equal(reparseCalls, 1);
  assert.equal(aclCalls, 0);
});

test("adapter propagates only the validated sanitized File.Replace exception chain", async () => {
  const exceptionDiagnostic = createFileReplaceExceptionDiagnostic({
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
  const argumentDiagnostic = createFileReplaceArgumentDiagnostic({
    backupArgumentBound: true,
    backupArgument: "protected-backup",
    replaceOverloadArity: 4,
    ignoreMetadataErrors: true,
    sourceExists: true,
    destinationExists: true,
    sourceAndDestinationSameDirectory: true,
    sourceAndDestinationSameVolume: true
  });
  const base = fixture({
    atomicReplaceArgumentDiagnostic: argumentDiagnostic,
    atomicReplaceDiagnostic: exceptionDiagnostic
  });
  try {
    await base.adapter.prepareProtectedDirectory({
      controlledRoot: base.controlledRoot,
      evidenceRoot: base.evidenceRoot
    });
    const target = path.join(base.evidenceRoot, "ledger.json");
    const first = Buffer.from("first", "utf8");
    const firstPrepared = await prepareReplacement(base, {
      target,
      revision: 1,
      bytes: first,
      expectedPreviousSha256: null
    });
    await base.adapter.replaceFileAtomic({
      transactionId: firstPrepared.transactionId
    });
    await base.adapter.finalizeFileReplacement({
      transactionId: firstPrepared.transactionId
    });
    const second = Buffer.from("second", "utf8");
    const secondPrepared = await prepareReplacement(base, {
      target,
      revision: 2,
      bytes: second,
      expectedPreviousSha256: sha256(first)
    });
    let failure;
    await assert.rejects(
      base.adapter.replaceFileAtomic({
        transactionId: secondPrepared.transactionId
      }),
      (error) => {
        failure = error;
        return error.failureCode ===
          "evidence_second_revision_atomic_replace_failed";
      }
    );
    assert.equal(failure.systemErrorClass, "filesystem");
    assert.equal(failure.systemErrorCode, "EBUSY");
    assert.deepEqual(failure.fileReplaceDiagnostic, exceptionDiagnostic);
    assert.deepEqual(
      failure.fileReplaceArgumentDiagnostic,
      argumentDiagnostic
    );
    assert.deepEqual(await base.adapter.readFile(target), first);
    assert.equal(fs.existsSync(secondPrepared.temporaryPath), true);
    assert.deepEqual(
      await base.adapter.rollbackFileReplacement({
        transactionId: secondPrepared.transactionId
      }),
      {
        rollbackCompleted: true,
        previousLedgerRestored: true,
        failedCandidatePreserved: false,
        failedCandidateRemovedAfterRestore: false
      }
    );
    assert.doesNotMatch(JSON.stringify(failure), /Users|private|ledger\.json/i);
  } finally {
    fs.rmSync(base.controlledRoot, { recursive: true, force: true });
  }
});

test("missing parent and pre-existing evidence root fail at distinct bootstrap stages", async () => {
  const controlledRoot = path.resolve("C:\\synthetic-missing-parent");
  const missingAdapter = createWindowsEvidenceLedgerAdapters({
    controlledRoot,
    evidenceRoot: path.join(controlledRoot, "evidence"),
    cleanupRoot: path.join(controlledRoot, "owned-run"),
    powershell: POWERSHELL,
    processRunner: { async run() { throw new Error("must not run"); } },
    environment: {},
    fileSystem: {
      existsSync: () => false,
      promises: {
        async lstat() {
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        }
      }
    }
  });
  await assert.rejects(
    missingAdapter.prepareProtectedDirectory({
      controlledRoot,
      evidenceRoot: path.join(controlledRoot, "evidence")
    }),
    (error) =>
      error.failureCode === "evidence_parent_validation_failed" &&
      error.systemErrorCode === "UNKNOWN"
  );

  const base = fixture();
  try {
    fs.mkdirSync(base.evidenceRoot);
    await assert.rejects(
      base.adapter.prepareProtectedDirectory({
        controlledRoot: base.controlledRoot,
        evidenceRoot: base.evidenceRoot
      }),
      (error) =>
        error.failureCode === "evidence_root_create_failed" &&
        error.systemErrorCode === "EEXIST"
    );
    assert.equal(fs.existsSync(base.evidenceRoot), true);
  } finally {
    fs.rmSync(base.controlledRoot, { recursive: true, force: true });
  }
});

test("intermediate reparse is refused before ACL preparation", async () => {
  let lstatCount = 0;
  let processCalls = 0;
  const controlledRoot = path.resolve("C:\\synthetic-intermediate-reparse");
  const adapter = createWindowsEvidenceLedgerAdapters({
    controlledRoot,
    evidenceRoot: path.join(controlledRoot, "evidence"),
    cleanupRoot: path.join(controlledRoot, "owned-run"),
    powershell: POWERSHELL,
    processRunner: {
      async run() {
        processCalls += 1;
        return { stdoutSanitized: "{}" };
      }
    },
    environment: {},
    fileSystem: {
      existsSync: () => false,
      promises: {
        async lstat() {
          lstatCount += 1;
          return { isSymbolicLink: () => lstatCount === 2 };
        }
      }
    }
  });
  await assert.rejects(
    adapter.assertNoReparseComponents({
      controlledRoot,
      evidenceRoot: path.join(controlledRoot, "evidence")
    }),
    { code: "windows_evidence_reparse_refused" }
  );
  assert.equal(processCalls, 1);
});

test("failed-initialization cleanup removes only an empty protected evidence root", async () => {
  const base = fixture();
  try {
    await base.adapter.prepareProtectedDirectory({
      controlledRoot: base.controlledRoot,
      evidenceRoot: base.evidenceRoot
    });
    assert.equal(await base.adapter.cleanupFailedInitialization({
      controlledRoot: base.controlledRoot,
      evidenceRoot: base.evidenceRoot,
      cleanupRoot: base.cleanupRoot
    }), true);
    assert.equal(fs.existsSync(base.evidenceRoot), false);

    await base.adapter.prepareProtectedDirectory({
      controlledRoot: base.controlledRoot,
      evidenceRoot: base.evidenceRoot
    });
    fs.writeFileSync(path.join(base.evidenceRoot, "foreign.txt"), "synthetic");
    await assert.rejects(
      base.adapter.cleanupFailedInitialization({
        controlledRoot: base.controlledRoot,
        evidenceRoot: base.evidenceRoot,
        cleanupRoot: base.cleanupRoot
      }),
      { failureCode: "evidence_ledger_partial_cleanup_failed" }
    );
    assert.equal(fs.readFileSync(path.join(base.evidenceRoot, "foreign.txt"), "utf8"), "synthetic");
  } finally {
    fs.rmSync(base.controlledRoot, { recursive: true, force: true });
  }
});

test("transactional rollback restores the previous bytes and removes only the rejected candidate", async () => {
  const base = fixture();
  try {
    await base.adapter.prepareProtectedDirectory({
      controlledRoot: base.controlledRoot,
      evidenceRoot: base.evidenceRoot
    });
    const target = path.join(base.evidenceRoot, "ledger.json");
    const first = Buffer.from("first", "utf8");
    const firstPrepared = await prepareReplacement(base, {
      target,
      revision: 1,
      bytes: first,
      expectedPreviousSha256: null
    });
    await base.adapter.replaceFileAtomic({
      transactionId: firstPrepared.transactionId
    });
    await base.adapter.finalizeFileReplacement({
      transactionId: firstPrepared.transactionId
    });
    const second = Buffer.from("second", "utf8");
    const secondPrepared = await prepareReplacement(base, {
      target,
      revision: 2,
      bytes: second,
      expectedPreviousSha256: sha256(first)
    });
    await base.adapter.replaceFileAtomic({
      transactionId: secondPrepared.transactionId
    });
    assert.deepEqual(fs.readFileSync(target), second);
    assert.deepEqual(fs.readFileSync(secondPrepared.backupPath), first);
    assert.deepEqual(
      await base.adapter.rollbackFileReplacement({
        transactionId: secondPrepared.transactionId
      }),
      {
        rollbackCompleted: true,
        previousLedgerRestored: true,
        failedCandidatePreserved: true,
        failedCandidateRemovedAfterRestore: true
      }
    );
    assert.deepEqual(fs.readFileSync(target), first);
    assert.equal(fs.existsSync(secondPrepared.backupPath), false);
    assert.equal(fs.existsSync(secondPrepared.recoveryPath), false);
    assert.equal(fs.existsSync(secondPrepared.temporaryPath), false);
    assert.equal(base.adapter.getReplacementAudit().openTransactionCount, 0);
    assert.equal(base.adapter.getReplacementAudit().rollbackCompletedCount, 1);
    assert.equal(base.adapter.getReplacementAudit().previousLedgerRestoredCount, 1);
  } finally {
    fs.rmSync(base.controlledRoot, { recursive: true, force: true });
  }
});

test("external, cross-run, swapped and pre-existing replacement artifacts are refused", async () => {
  const base = fixture();
  try {
    await base.adapter.prepareProtectedDirectory({
      controlledRoot: base.controlledRoot,
      evidenceRoot: base.evidenceRoot
    });
    const target = path.join(base.evidenceRoot, "ledger.json");
    const bytes = Buffer.from("first", "utf8");
    const paths = replacementPaths(target, 1);
    await base.adapter.writeFileCreateNew(paths.temporaryPath, bytes);
    await base.adapter.applyProtectedAcl(paths.temporaryPath);
    await assert.rejects(
      base.adapter.prepareFileReplacement({
        ...paths,
        backupPath: path.join(base.controlledRoot, "outside.previous.bak"),
        targetPath: target,
        expectedPreviousSha256: null,
        expectedReplacementSha256: sha256(bytes)
      }),
      (error) => {
        assert.equal(error.code, "windows_evidence_backup_target_refused");
        assert.deepEqual(error.tempValidationFailure, {
          tempValidationStage: "second_revision_temp_scope_validate",
          sanitizedFailureClass: "harness_validation",
          sanitizedFailureCode: "OUTSIDE_SCOPE",
          actualConditionClass: "outside_scope"
        });
        return true;
      }
    );
    await assert.rejects(
      base.adapter.prepareFileReplacement({
        ...paths,
        backupPath: path.join(
          base.evidenceRoot,
          ".other-run-incremental-evidence.json.1.aaaaaaaaaaaaaaaa.previous.bak"
        ),
        targetPath: target,
        expectedPreviousSha256: null,
        expectedReplacementSha256: sha256(bytes)
      }),
      (error) => {
        assert.equal(
          error.code,
          "windows_evidence_replacement_path_contract_refused"
        );
        assert.equal(
          error.tempValidationFailure.tempValidationStage,
          "second_revision_temp_ownership_marker_validate"
        );
        return true;
      }
    );
    await assert.rejects(
      base.adapter.prepareFileReplacement({
        ...paths,
        temporaryPath: path.join(
          base.evidenceRoot,
          ".other-run-incremental-evidence.json.1.aaaaaaaaaaaaaaaa.tmp"
        ),
        targetPath: target,
        expectedPreviousSha256: null,
        expectedReplacementSha256: sha256(bytes)
      }),
      { code: "windows_evidence_replacement_path_contract_refused" }
    );
    fs.writeFileSync(paths.backupPath, "foreign-synthetic");
    await assert.rejects(
      base.adapter.prepareFileReplacement({
        ...paths,
        targetPath: target,
        expectedPreviousSha256: null,
        expectedReplacementSha256: sha256(bytes)
      }),
      { code: "windows_evidence_backup_preexisting_refused" }
    );
    assert.equal(fs.readFileSync(paths.backupPath, "utf8"), "foreign-synthetic");
    assert.equal(fs.existsSync(paths.temporaryPath), true);
    assert.equal(fs.existsSync(target), false);
  } finally {
    fs.rmSync(base.controlledRoot, { recursive: true, force: true });
  }
});

test("temporary validation exposes exact sanitized existence, type, hardlink, owner and ACL stages", async (t) => {
  await t.test("missing", async () => {
    const base = fixture();
    try {
      await base.adapter.prepareProtectedDirectory({
        controlledRoot: base.controlledRoot,
        evidenceRoot: base.evidenceRoot
      });
      const target = path.join(base.evidenceRoot, "ledger.json");
      const paths = replacementPaths(target, 1);
      await assert.rejects(
        base.adapter.prepareFileReplacement({
          ...paths,
          targetPath: target,
          expectedPreviousSha256: null,
          expectedReplacementSha256: sha256(Buffer.from("missing"))
        }),
        expectTempValidationFailure(
          "second_revision_temp_exists",
          "ENOENT",
          "absent"
        )
      );
    } finally {
      fs.rmSync(base.controlledRoot, { recursive: true, force: true });
    }
  });

  await t.test("directory", async () => {
    const base = fixture();
    try {
      await base.adapter.prepareProtectedDirectory({
        controlledRoot: base.controlledRoot,
        evidenceRoot: base.evidenceRoot
      });
      const target = path.join(base.evidenceRoot, "ledger.json");
      const paths = replacementPaths(target, 1);
      fs.mkdirSync(paths.temporaryPath);
      await assert.rejects(
        base.adapter.prepareFileReplacement({
          ...paths,
          targetPath: target,
          expectedPreviousSha256: null,
          expectedReplacementSha256: sha256(Buffer.from("directory"))
        }),
        expectTempValidationFailure(
          "second_revision_temp_regular_file_validate",
          "MISMATCH",
          "invalid"
        )
      );
    } finally {
      fs.rmSync(base.controlledRoot, { recursive: true, force: true });
    }
  });

  await t.test("hardlink", async () => {
    const base = fixture();
    try {
      await base.adapter.prepareProtectedDirectory({
        controlledRoot: base.controlledRoot,
        evidenceRoot: base.evidenceRoot
      });
      const target = path.join(base.evidenceRoot, "ledger.json");
      const paths = replacementPaths(target, 1);
      const bytes = Buffer.from("hardlink", "utf8");
      await base.adapter.writeFileCreateNew(paths.temporaryPath, bytes);
      await base.adapter.flushFile(paths.temporaryPath);
      fs.linkSync(paths.temporaryPath, `${paths.temporaryPath}.owned-link`);
      await assert.rejects(
        base.adapter.prepareFileReplacement({
          ...paths,
          targetPath: target,
          expectedPreviousSha256: null,
          expectedReplacementSha256: sha256(bytes)
        }),
        expectTempValidationFailure(
          "second_revision_temp_hardlink_validate",
          "HARDLINK_COUNT_INVALID",
          "invalid"
        )
      );
    } finally {
      fs.rmSync(base.controlledRoot, { recursive: true, force: true });
    }
  });

  for (const [name, aclProof, stage, code] of [
    [
      "owner",
      {
        ownerCurrentUser: false,
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
        unexpectedAllowRuleCount: 0
      },
      "second_revision_temp_owner_validate",
      "OWNER_INVALID"
    ],
    [
      "ACL",
      {
        ownerCurrentUser: true,
        inheritanceProtected: false,
        currentUserFullControl: true,
        systemFullControl: true,
        administratorsFullControl: true,
        explicitAllowRuleCount: 3,
        currentUserAllowRuleCount: 1,
        systemAllowRuleCount: 1,
        administratorsAllowRuleCount: 1,
        inheritedRuleCount: 1,
        denyRuleCount: 0,
        unexpectedAllowRuleCount: 0
      },
      "second_revision_temp_acl_validate",
      "ACL_INVALID"
    ]
  ]) {
    await t.test(name, async () => {
      const base = fixture({ aclProof });
      try {
        await base.adapter.prepareProtectedDirectory({
          controlledRoot: base.controlledRoot,
          evidenceRoot: base.evidenceRoot
        });
        const target = path.join(base.evidenceRoot, "ledger.json");
        const paths = replacementPaths(target, 1);
        const bytes = Buffer.from(name, "utf8");
        await base.adapter.writeFileCreateNew(paths.temporaryPath, bytes);
        await base.adapter.flushFile(paths.temporaryPath);
        await base.adapter.applyProtectedAcl(paths.temporaryPath);
        await assert.rejects(
          base.adapter.prepareFileReplacement({
            ...paths,
            targetPath: target,
            expectedPreviousSha256: null,
            expectedReplacementSha256: sha256(bytes)
          }),
          expectTempValidationFailure(stage, code, "invalid")
        );
      } finally {
        fs.rmSync(base.controlledRoot, { recursive: true, force: true });
      }
    });
  }
});

test("replacement transaction ids are one-shot", async () => {
  const base = fixture();
  try {
    await base.adapter.prepareProtectedDirectory({
      controlledRoot: base.controlledRoot,
      evidenceRoot: base.evidenceRoot
    });
    const target = path.join(base.evidenceRoot, "ledger.json");
    const prepared = await prepareReplacement(base, {
      target,
      revision: 1,
      bytes: Buffer.from("first", "utf8"),
      expectedPreviousSha256: null
    });
    await base.adapter.replaceFileAtomic({ transactionId: prepared.transactionId });
    await base.adapter.finalizeFileReplacement({ transactionId: prepared.transactionId });
    await assert.rejects(
      base.adapter.finalizeFileReplacement({ transactionId: prepared.transactionId }),
      { code: "windows_evidence_replacement_transaction_refused" }
    );
    await assert.rejects(
      base.adapter.rollbackFileReplacement({ transactionId: prepared.transactionId }),
      { code: "windows_evidence_replacement_transaction_refused" }
    );
    await assert.rejects(
      base.adapter.replaceFileAtomic({ transactionId: "f".repeat(32) }),
      { code: "windows_evidence_replacement_transaction_refused" }
    );
  } finally {
    fs.rmSync(base.controlledRoot, { recursive: true, force: true });
  }
});

test("a reparse point on the explicit backup path is refused before replacement", async () => {
  const controlledRoot = path.resolve("C:\\synthetic-backup-reparse");
  const evidenceRoot = path.join(controlledRoot, "evidence");
  const cleanupRoot = path.join(controlledRoot, "owned-run");
  const backupPath = path.join(
    evidenceRoot,
    ".ledger.json.2.aaaaaaaaaaaaaaaa.previous.bak"
  );
  const audited = [];
  const adapter = createWindowsEvidenceLedgerAdapters({
    controlledRoot,
    evidenceRoot,
    cleanupRoot,
    powershell: POWERSHELL,
    processRunner: {
      async run(spec) {
        if (spec.label !== "evidence_reparse_audit") {
          throw new Error("unexpected synthetic operation");
        }
        const candidate = path.resolve(
          spec.environment.IA4TUBE_EVIDENCE_TARGET
        );
        audited.push(candidate);
        const detected = candidate.toLowerCase() === backupPath.toLowerCase();
        return {
          stdoutSanitized: JSON.stringify({
            ok: !detected,
            reparsePointDetected: detected
          })
        };
      }
    },
    environment: {},
    fileSystem: {
      existsSync: () => false,
      promises: {
        async lstat() {
          return {
            isSymbolicLink: () => false,
            isFile: () => false,
            nlink: 1
          };
        }
      }
    }
  });
  await assert.rejects(
    adapter.assertNoReparseComponents({
      controlledRoot,
      evidenceRoot,
      backupPath
    }),
    { code: "windows_evidence_reparse_refused" }
  );
  assert.ok(audited.some((candidate) =>
    candidate.toLowerCase() === backupPath.toLowerCase()
  ));
});

test("the definitive adapter uses a nonempty explicit backup without reflection or forced move", () => {
  const source = fs.readFileSync(
    require.resolve(
      "../scripts/social-3a0p-local-windows-evidence-ledger-adapters"
    ),
    "utf8"
  );
  assert.match(
    source,
    /\$backupArgument=\[IO\.Path\]::GetFullPath\(\$env:IA4TUBE_EVIDENCE_BACKUP\)/
  );
  assert.match(
    source,
    /\[IO\.File\]::Replace\(\$env:IA4TUBE_EVIDENCE_SOURCE,\$env:IA4TUBE_EVIDENCE_TARGET,\$backupArgument,\$true\)/
  );
  assert.doesNotMatch(
    source,
    /\$backupArgument=\$null|Move-Item\s+-Force|File\.Move|GetMethod|InvokeMember|P\/Invoke/i
  );
});
