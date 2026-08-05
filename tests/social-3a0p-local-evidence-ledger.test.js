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
  const adapter = {
    async prepareProtectedDirectory(input) {
      calls.push(["prepareProtectedDirectory", input]);
      return options.prepareResult !== false;
    },
    async assertNoReparseComponents(input) {
      calls.push(["assertNoReparseComponents", input]);
      return options.reparse !== true;
    },
    async inspectProtectedAcl(target) {
      calls.push(["inspectProtectedAcl", target]);
      if (options.rootAcl && target === options.evidenceRoot) return options.rootAcl;
      if (options.fileAcl && target !== options.evidenceRoot) return options.fileAcl;
      return securityProof();
    },
    async exists(target) {
      return files.has(target);
    },
    async readFile(target) {
      if (!files.has(target)) throw Object.assign(new Error("synthetic missing"), { code: "ENOENT" });
      return Buffer.from(files.get(target));
    },
    async writeFileCreateNew(target, bytes) {
      calls.push(["writeFileCreateNew", target]);
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
      if (options.applyAclResult === false) return false;
      secured.add(target);
      return true;
    },
    async replaceFileAtomic({ temporaryPath, targetPath, expectedPreviousSha256 }) {
      replaceCount += 1;
      calls.push(["replaceFileAtomic", temporaryPath, targetPath, expectedPreviousSha256]);
      if (options.failReplaceAt === replaceCount) {
        return { committed: false, previousMatched: false };
      }
      const exists = files.has(targetPath);
      const previousMatched = expectedPreviousSha256 === null
        ? !exists
        : exists && sha256(files.get(targetPath)) === expectedPreviousSha256;
      if (!previousMatched || !files.has(temporaryPath)) {
        return { committed: false, previousMatched };
      }
      files.set(targetPath, files.get(temporaryPath));
      files.delete(temporaryPath);
      secured.delete(temporaryPath);
      secured.add(targetPath);
      return { committed: true, previousMatched: true };
    },
    async removeOwnedTemporaryFile({ temporaryPath }) {
      calls.push(["removeOwnedTemporaryFile", temporaryPath]);
      if (options.failTemporaryRemoval === true) {
        throw new Error("synthetic temporary removal failure");
      }
      files.delete(temporaryPath);
      secured.delete(temporaryPath);
      return true;
    }
  };
  return { adapter, calls, files, secured };
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
  await assert.rejects(
    ledger.finishPhase("preflight", {
      status: "failed",
      code: "preflight_synthetic_failure"
    }),
    expectCode("evidence_ledger_atomic_replace_failed")
  );
  assert.deepEqual(filesystem.files.get(ledger.paths.evidencePath), before);
  assert.equal(ledger.getPersistenceFailureCode(), "evidence_ledger_atomic_replace_failed");
  assert.equal(
    [...filesystem.files.keys()].some((candidate) => candidate.endsWith(".tmp")),
    false
  );
  assert.ok(
    filesystem.calls.some(([name]) => name === "removeOwnedTemporaryFile")
  );
});

test("file fsync failure is fail-closed, preserves prior evidence and removes the temp file", async () => {
  const { ledger, filesystem } = fixture({ failFlushAt: 2 });
  await ledger.initialize();
  const before = Buffer.from(filesystem.files.get(ledger.paths.evidencePath));
  await assert.rejects(
    ledger.beginPhase("preflight"),
    expectCode("evidence_ledger_persistence_failed")
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
    expectCode("evidence_ledger_temporary_cleanup_failed")
  );
  assert.deepEqual(filesystem.files.get(ledger.paths.evidencePath), before);
  assert.equal(
    ledger.getPersistenceFailureCode(),
    "evidence_ledger_persistence_failed"
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
    expectCode("evidence_ledger_atomic_replace_failed")
  );
  await ledger.beginCleanup();
  await ledger.finishCleanup({ status: "passed", code: "cleanup_passed" });
  const persisted = documentAt(ledger, filesystem);
  assert.equal(persisted.persistenceFailureCode, "evidence_ledger_atomic_replace_failed");
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
  await assert.rejects(ledger.initialize(), expectCode("evidence_ledger_acl_refused"));
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
        expectCode("evidence_ledger_acl_refused")
      );
      assert.equal(filesystem.files.size, 0);
    });
  }
});

test("file ACL failure removes the owned temp and never promotes it", async () => {
  const { ledger, filesystem } = fixture({
    fileAcl: securityProof({ inheritanceProtected: false })
  });
  await assert.rejects(ledger.initialize(), expectCode("evidence_ledger_acl_refused"));
  assert.equal(filesystem.files.size, 0);
  assert.ok(
    filesystem.calls.some(([name]) => name === "removeOwnedTemporaryFile")
  );
});

test("a reparse component is refused before a write", async () => {
  const { ledger, filesystem } = fixture({ reparse: true });
  await assert.rejects(
    ledger.initialize(),
    expectCode("evidence_ledger_reparse_refused")
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
    expectCode("evidence_ledger_existing_target_refused")
  );
  assert.equal(filesystem.files.get(ledger.paths.evidencePath).toString(), "unowned");
});

test("tampering with the prior revision blocks the next update before replacement", async () => {
  const { ledger, filesystem } = fixture();
  await ledger.initialize();
  filesystem.files.set(ledger.paths.evidencePath, Buffer.from("tampered"));
  await assert.rejects(
    ledger.beginPhase("preflight"),
    expectCode("evidence_ledger_previous_revision_changed")
  );
  assert.equal(filesystem.files.get(ledger.paths.evidencePath).toString(), "tampered");
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
