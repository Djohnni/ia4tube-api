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

const POWERSHELL = path.resolve(
  "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
);

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function fixture() {
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
      if (spec.label === "evidence_atomic_replace") {
        fs.rmSync(target);
        fs.renameSync(spec.environment.IA4TUBE_EVIDENCE_TEMP, target);
      }
      if (spec.label === "evidence_acl_inspect") {
        return {
          stdoutSanitized: JSON.stringify({
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
    const firstTemporary = path.join(base.evidenceRoot, ".first.tmp");
    const first = Buffer.from("first", "utf8");
    await base.adapter.writeFileCreateNew(firstTemporary, first);
    await base.adapter.flushFile(firstTemporary);
    await base.adapter.applyProtectedAcl(firstTemporary);
    assert.deepEqual(
      await base.adapter.replaceFileAtomic({
        temporaryPath: firstTemporary,
        targetPath: target,
        expectedPreviousSha256: null
      }),
      { committed: true, previousMatched: true }
    );
    assert.deepEqual(await base.adapter.readFile(target), first);

    const secondTemporary = path.join(base.evidenceRoot, ".second.tmp");
    const second = Buffer.from("second", "utf8");
    await base.adapter.writeFileCreateNew(secondTemporary, second);
    await assert.rejects(
      base.adapter.replaceFileAtomic({
        temporaryPath: secondTemporary,
        targetPath: target,
        expectedPreviousSha256: "0".repeat(64)
      }),
      { code: "windows_evidence_previous_revision_mismatch" }
    );
    assert.deepEqual(await base.adapter.readFile(target), first);
    assert.deepEqual(
      await base.adapter.replaceFileAtomic({
        temporaryPath: secondTemporary,
        targetPath: target,
        expectedPreviousSha256: sha256(first)
      }),
      { committed: true, previousMatched: true }
    );
    assert.deepEqual(await base.adapter.readFile(target), second);
    const acl = await base.adapter.inspectProtectedAcl(target);
    assert.equal(acl.inheritanceProtected, true);
    assert.equal(acl.ownerCurrentUser, true);
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
    assert.throws(
      () => base.adapter.writeFileCreateNew(
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
    { code: "windows_evidence_reparse_refused" }
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
    { code: "windows_evidence_reparse_refused" }
  );
  assert.equal(reparseCalls, 1);
  assert.equal(aclCalls, 0);
});
