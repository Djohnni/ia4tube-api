"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  NORMAL_REVISION_DIAGNOSTIC_ONLY,
  NORMAL_REVISION_STAGES,
  NORMAL_REVISION_WRAPPER_METHODS,
  PHYSICAL_LEDGER_APPROVAL,
  REPLACEMENT_AUDIT_KEYS,
  createOneShotPostReplaceReadFailureAdapters,
  createNormalRevision2StageTrackingAdapters,
  createNormalRevisionDiagnostic,
  parseCommandLine,
  serializeNormalRevisionDiagnostic,
  validateNormalRevisionDiagnostic
} = require("../scripts/social-3a0p-local-evidence-ledger-ntfs-proof");
const {
  REQUIRED_ADAPTERS
} = require("../scripts/social-3a0p-local-evidence-ledger");

const TRANSACTION_ID = "a".repeat(32);
const EVIDENCE_PATH = path.join("C:\\", "synthetic", "ledger.json");
const TEMPORARY_PATH = path.join("C:\\", "synthetic", "ledger.tmp");
const VALID_SECURITY_PROOF = Object.freeze({
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
});
const VALID_REPLACEMENT_AUDIT = Object.freeze(Object.fromEntries(
  REPLACEMENT_AUDIT_KEYS.map((key) => [key, 0])
));

function fakeAdapters(overrides = {}) {
  const adapters = Object.fromEntries(
    REQUIRED_ADAPTERS.map((name) => [name, async () => true])
  );
  Object.assign(adapters, {
    prepareFileReplacement: async () => ({
      transactionId: TRANSACTION_ID,
      hadPrevious: true
    }),
    replaceFileAtomic: async () => ({ committed: true, previousMatched: true }),
    exists: async (target) => target === EVIDENCE_PATH,
    inspectProtectedAcl: async () => VALID_SECURITY_PROOF,
    readFile: async () => Buffer.from("synthetic-ledger", "utf8"),
    getReplacementAudit() {
      return VALID_REPLACEMENT_AUDIT;
    }
  }, overrides);
  return adapters;
}

function observedFailure({
  systemErrorClass = "process",
  systemErrorCode = "UNKNOWN"
} = {}) {
  const error = new Error("sensitive-message C:\\Users\\private\\ledger.json");
  error.code = "evidence_second_revision_reopen_failed";
  error.stack = "sensitive-stack S-1-5-21-999";
  error.persistenceDiagnostic = Object.freeze({
    systemErrorClass,
    systemErrorCode
  });
  return error;
}

async function armPostReplace(tracker) {
  await tracker.adapters.prepareFileReplacement({
    temporaryPath: TEMPORARY_PATH,
    targetPath: EVIDENCE_PATH
  });
  await tracker.adapters.replaceFileAtomic({ transactionId: TRANSACTION_ID });
}

async function passThroughTargetPresence(tracker) {
  await tracker.adapters.assertNoReparseComponents({});
  assert.equal(await tracker.adapters.exists(TEMPORARY_PATH), false);
  assert.equal(await tracker.adapters.exists(EVIDENCE_PATH), true);
}

test("NTFS proof has an independent exact approval and no package argument", () => {
  assert.equal(
    parseCommandLine(["--approval", PHYSICAL_LEDGER_APPROVAL]),
    true
  );
  for (const argv of [
    [],
    ["--approval", "wrong"],
    ["--package-path", "synthetic.zip"],
    ["--approval", PHYSICAL_LEDGER_APPROVAL, "--port", "64995"]
  ]) {
    assert.throws(() => parseCommandLine(argv), {
      code: "ledger_ntfs_approval_missing"
    });
  }
});

test("normal instrumentation wrapper exposes exactly the approved methods and a read-only audit snapshot", () => {
  let calls = 0;
  let original;
  original = fakeAdapters({
    getReplacementAudit() {
      calls += 1;
      assert.equal(this, original);
      return VALID_REPLACEMENT_AUDIT;
    }
  });
  assert.equal(typeof original.getReplacementAudit, "function");
  const tracker = createNormalRevision2StageTrackingAdapters(
    original,
    EVIDENCE_PATH
  );
  assert.equal(typeof tracker.adapters.getReplacementAudit, "function");
  assert.deepEqual(
    Object.keys(tracker.adapters).sort(),
    [...NORMAL_REVISION_WRAPPER_METHODS].sort()
  );
  assert.equal(Object.isFrozen(tracker.adapters), true);

  const snapshot = tracker.adapters.getReplacementAudit();
  assert.equal(calls, 1);
  assert.deepEqual(snapshot, VALID_REPLACEMENT_AUDIT);
  assert.notEqual(snapshot, VALID_REPLACEMENT_AUDIT);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.throws(() => {
    snapshot.openTransactionCount = 99;
  }, TypeError);
  assert.equal(VALID_REPLACEMENT_AUDIT.openTransactionCount, 0);
});

test("normal instrumentation wrapper rejects a missing audit method before delegated I/O", () => {
  let delegatedCalls = 0;
  const adapters = fakeAdapters();
  for (const name of REQUIRED_ADAPTERS) {
    adapters[name] = async () => {
      delegatedCalls += 1;
      return true;
    };
  }
  delete adapters.getReplacementAudit;
  assert.throws(
    () => createNormalRevision2StageTrackingAdapters(adapters, EVIDENCE_PATH),
    { code: "ledger_ntfs_replacement_audit_method_missing" }
  );
  assert.equal(delegatedCalls, 0);
});

test("normal instrumentation wrapper rejects undefined and invalid audit contracts", () => {
  const missingKey = Object.freeze(Object.fromEntries(
    REPLACEMENT_AUDIT_KEYS.slice(1).map((key) => [key, 0])
  ));
  const extraKey = Object.freeze({ ...VALID_REPLACEMENT_AUDIT, extra: 0 });
  const invalidValue = Object.freeze({
    ...VALID_REPLACEMENT_AUDIT,
    openTransactionCount: -1
  });
  const notFrozen = { ...VALID_REPLACEMENT_AUDIT };
  const withSymbol = { ...VALID_REPLACEMENT_AUDIT };
  Object.defineProperty(withSymbol, Symbol("hidden"), {
    enumerable: false,
    value: 0
  });
  Object.freeze(withSymbol);

  for (const value of [
    undefined,
    null,
    [],
    missingKey,
    extraKey,
    invalidValue,
    notFrozen,
    withSymbol
  ]) {
    const tracker = createNormalRevision2StageTrackingAdapters(
      fakeAdapters({ getReplacementAudit: () => value }),
      EVIDENCE_PATH
    );
    assert.throws(() => tracker.adapters.getReplacementAudit(), {
      code: "ledger_ntfs_replacement_audit_invalid"
    });
  }
});

test("normal instrumentation wrapper normalizes audit exceptions without raw details", () => {
  const tracker = createNormalRevision2StageTrackingAdapters(
    fakeAdapters({
      getReplacementAudit() {
        const error = new Error(
          "private ledger C:\\Users\\private\\ledger.json S-1-5-21-999"
        );
        error.stack = "private-stack";
        throw error;
      }
    }),
    EVIDENCE_PATH
  );
  let observed;
  try {
    tracker.adapters.getReplacementAudit();
  } catch (error) {
    observed = error;
  }
  assert.equal(observed?.code, "ledger_ntfs_replacement_audit_read_failed");
  const publicFailure = JSON.stringify({
    code: observed.code,
    message: observed.message
  });
  assert.doesNotMatch(
    publicFailure,
    /private|Users|ledger\.json|S-1-5|stack|password|token/i
  );
});

test("NTFS proof imports only harness evidence components and no product or network module", () => {
  const source = fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "scripts",
      "social-3a0p-local-evidence-ledger-ntfs-proof.js"
    ),
    "utf8"
  );
  assert.doesNotMatch(source, /windows-entry|windows-adapters|\.\.\/src|package-path/i);
  assert.doesNotMatch(source, /node:(?:net|http|https|dns)|fetch\s*\(/i);
  assert.doesNotMatch(source, /postgresql-18\.4|sanitized-failure-summary/i);
  assert.match(source, /createSanitizedEvidenceLedger/);
  assert.match(source, /createWindowsEvidenceLedgerAdapters/);
  assert.match(source, /nonElevated/);
  assert.match(source, /postgresProcessesBefore/);
  assert.match(source, /cleanupCompleted/);
  assert.match(source, /serializeTempValidationDiagnostic/);
  assert.ok(
    source.indexOf("serializeTempValidationDiagnostic(error.tempValidationDiagnostic)") <
      source.indexOf("serializePersistenceDiagnostic(error.persistenceDiagnostic)")
  );
  assert.equal(NORMAL_REVISION_DIAGNOSTIC_ONLY, false);
  assert.match(source, /syntheticScenarioExecuted:\s*false/);
  assert.match(
    source,
    /cleanupRoot:\s*rollbackCleanupRoot,[\s\S]*environment:\s*rollbackEnvironment/
  );
  assert.match(source, /rollbackPhysicalApproved:\s*true/);
});

test("instrumentation delegates every untouched method with the original receiver", async () => {
  let original;
  const observed = [];
  original = fakeAdapters({
    async flushFile(value) {
      observed.push([this, value]);
      return true;
    }
  });
  const tracker = createNormalRevision2StageTrackingAdapters(
    original,
    EVIDENCE_PATH
  );

  assert.equal(await tracker.adapters.flushFile(TEMPORARY_PATH), true);
  assert.deepEqual(observed, [[original, TEMPORARY_PATH]]);
});

test("rollback fault injection is one-shot and accepted only with its exact test identity", async () => {
  const identity = Object.freeze({
    nonce: "d".repeat(32),
    stage: "post_replace_read",
    code: "EBUSY"
  });
  const original = fakeAdapters();
  const injected = createOneShotPostReplaceReadFailureAdapters(
    original,
    EVIDENCE_PATH,
    identity
  );
  const prepared = await injected.adapters.prepareFileReplacement({
    temporaryPath: TEMPORARY_PATH,
    targetPath: EVIDENCE_PATH
  });
  await injected.adapters.replaceFileAtomic({
    transactionId: prepared.transactionId
  });
  await assert.rejects(injected.adapters.readFile(EVIDENCE_PATH), {
    code: "EBUSY"
  });
  assert.equal(injected.wasInjected(), true);
  assert.equal(injected.matchesInjectionIdentity(identity), true);
  assert.equal(
    injected.matchesInjectionIdentity({
      ...identity,
      nonce: "e".repeat(32)
    }),
    false
  );
  assert.equal(
    await injected.adapters.readFile(EVIDENCE_PATH).then(Buffer.isBuffer),
    true
  );

  const natural = createOneShotPostReplaceReadFailureAdapters(
    fakeAdapters({
      readFile: async () => {
        const error = new Error("synthetic-natural-error");
        error.code = "EBUSY";
        throw error;
      }
    }),
    EVIDENCE_PATH,
    identity
  );
  await assert.rejects(natural.adapters.readFile(EVIDENCE_PATH), {
    code: "EBUSY"
  });
  assert.equal(natural.wasInjected(), false);
  assert.equal(natural.matchesInjectionIdentity(identity), false);
});

test("normal revision diagnostic has an exact sanitized schema", () => {
  const diagnostic = createNormalRevisionDiagnostic({
    stage: "normal_revision2_post_replace_target_reopen",
    adapterFailure: { code: "EBUSY" },
    observedFailure: observedFailure({
      systemErrorClass: "filesystem",
      systemErrorCode: "EBUSY"
    })
  });
  assert.equal(validateNormalRevisionDiagnostic(diagnostic), true);
  assert.deepEqual(diagnostic, {
    event: "evidence_ledger_normal_revision_failure",
    scenario: "normal_persistence",
    revisionNumber: 2,
    normalPersistenceStage: "normal_revision2_post_replace_target_reopen",
    sanitizedFailureClass: "filesystem",
    sanitizedFailureCode: "EBUSY"
  });
  const serialized = serializeNormalRevisionDiagnostic(diagnostic);
  assert.doesNotMatch(
    serialized,
    /sensitive|Users|ledger\.json|S-1-5|stack|message|path|nonce|synthetic/i
  );
});

test("normal revision stages distinguish pre-replace, unconfirmed replace and post-replace without a misleading fallback", async () => {
  assert.deepEqual(NORMAL_REVISION_STAGES, [
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

  const prepareFailure = Object.assign(
    new Error("private pre-replace path C:\\Users\\private\\ledger.json"),
    { code: "EPERM" }
  );
  const tracker = createNormalRevision2StageTrackingAdapters(
    fakeAdapters({
      prepareFileReplacement: async () => {
        throw prepareFailure;
      }
    }),
    EVIDENCE_PATH
  );
  await assert.rejects(
    tracker.adapters.prepareFileReplacement({
      temporaryPath: TEMPORARY_PATH,
      targetPath: EVIDENCE_PATH
    }),
    prepareFailure
  );
  const preReplace = tracker.createFailureDiagnostic(observedFailure({
    systemErrorClass: "permission",
    systemErrorCode: "EPERM"
  }));
  assert.equal(
    preReplace.normalPersistenceStage,
    "normal_revision2_pre_replace"
  );
  assert.doesNotMatch(preReplace.normalPersistenceStage, /post_replace/);

  const unattributed = createNormalRevisionDiagnostic({
    stage: "not_an_allowlisted_internal_stage",
    observedFailure: observedFailure()
  });
  assert.equal(
    unattributed.normalPersistenceStage,
    "normal_revision2_unattributed"
  );
  assert.doesNotMatch(unattributed.normalPersistenceStage, /post_replace/);
});

test("tracked replace remains unconfirmed on exception or any non-exact result", async () => {
  const replaceFailure = Object.assign(
    new Error("private mutation outcome C:\\Users\\private\\ledger.json"),
    { code: "EBUSY", stack: "private-stack S-1-5-21-999" }
  );
  const throwing = createNormalRevision2StageTrackingAdapters(
    fakeAdapters({
      replaceFileAtomic: async () => {
        throw replaceFailure;
      }
    }),
    EVIDENCE_PATH
  );
  await throwing.adapters.prepareFileReplacement({
    temporaryPath: TEMPORARY_PATH,
    targetPath: EVIDENCE_PATH
  });
  await assert.rejects(
    throwing.adapters.replaceFileAtomic({ transactionId: TRANSACTION_ID }),
    replaceFailure
  );
  assert.deepEqual(throwing.snapshot(), {
    trackingState: "failed",
    normalPersistenceStage:
      "normal_revision2_replace_outcome_unconfirmed",
    adapterFailureCaptured: true
  });
  const throwingDiagnostic = throwing.createFailureDiagnostic(observedFailure({
    systemErrorClass: "filesystem",
    systemErrorCode: "EBUSY"
  }));
  assert.equal(
    throwingDiagnostic.normalPersistenceStage,
    "normal_revision2_replace_outcome_unconfirmed"
  );
  assert.equal(throwingDiagnostic.sanitizedFailureCode, "EBUSY");
  assert.doesNotMatch(
    serializeNormalRevisionDiagnostic(throwingDiagnostic),
    /private|Users|ledger\.json|S-1-5|stack|message|path/i
  );

  const nonExactResults = [
    undefined,
    null,
    { committed: false, previousMatched: true },
    { committed: true, previousMatched: false },
    { committed: true },
    { committed: true, previousMatched: true, extra: true }
  ];
  for (const result of nonExactResults) {
    const tracker = createNormalRevision2StageTrackingAdapters(
      fakeAdapters({ replaceFileAtomic: async () => result }),
      EVIDENCE_PATH
    );
    await tracker.adapters.prepareFileReplacement({
      temporaryPath: TEMPORARY_PATH,
      targetPath: EVIDENCE_PATH
    });
    assert.equal(
      await tracker.adapters.replaceFileAtomic({
        transactionId: TRANSACTION_ID
      }),
      result
    );
    assert.equal(tracker.snapshot().trackingState, "failed");
    assert.equal(
      tracker.snapshot().normalPersistenceStage,
      "normal_revision2_replace_outcome_unconfirmed"
    );
  }
});

test("only an exact confirmed tracked replace advances to post-replace", async () => {
  const tracker = createNormalRevision2StageTrackingAdapters(
    fakeAdapters(),
    EVIDENCE_PATH
  );
  await tracker.adapters.prepareFileReplacement({
    temporaryPath: TEMPORARY_PATH,
    targetPath: EVIDENCE_PATH
  });
  await tracker.adapters.replaceFileAtomic({ transactionId: "b".repeat(32) });
  assert.deepEqual(tracker.snapshot(), {
    trackingState: "prepared",
    normalPersistenceStage: "normal_revision2_pre_replace",
    adapterFailureCaptured: false
  });

  await tracker.adapters.replaceFileAtomic({ transactionId: TRANSACTION_ID });
  assert.deepEqual(tracker.snapshot(), {
    trackingState: "post_replace",
    normalPersistenceStage: "normal_revision2_post_replace_temp_absence_check",
    adapterFailureCaptured: false
  });
});

test("reparse audit failure remains attributed to reparse", async () => {
  const failure = Object.assign(new Error("hidden"), {
    code: "windows_evidence_reparse_refused"
  });
  const tracker = createNormalRevision2StageTrackingAdapters(
    fakeAdapters({ assertNoReparseComponents: async () => { throw failure; } }),
    EVIDENCE_PATH
  );
  await armPostReplace(tracker);
  await assert.rejects(tracker.adapters.assertNoReparseComponents({}), failure);
  const diagnostic = tracker.createFailureDiagnostic(observedFailure());
  assert.equal(
    diagnostic.normalPersistenceStage,
    "normal_revision2_post_replace_reparse_audit"
  );
  assert.equal(diagnostic.sanitizedFailureClass, "process");
  assert.equal(diagnostic.sanitizedFailureCode, "UNKNOWN");
});

test("PowerShell process failure is sanitized without raw details", async () => {
  const failure = Object.assign(new Error("private PowerShell output"), {
    code: "harness_process_output_invalid"
  });
  const tracker = createNormalRevision2StageTrackingAdapters(
    fakeAdapters({ assertNoReparseComponents: async () => { throw failure; } }),
    EVIDENCE_PATH
  );
  await armPostReplace(tracker);
  await assert.rejects(tracker.adapters.assertNoReparseComponents({}), failure);
  const diagnostic = tracker.createFailureDiagnostic(observedFailure());
  assert.equal(diagnostic.sanitizedFailureClass, "powershell");
  assert.equal(diagnostic.sanitizedFailureCode, "UNKNOWN");
  assert.doesNotMatch(serializeNormalRevisionDiagnostic(diagnostic), /private|output/i);
});

test("temporary absence query failure and existing temporary keep their stage", async () => {
  const queryFailure = Object.assign(new Error("hidden"), { code: "EBUSY" });
  const throwing = createNormalRevision2StageTrackingAdapters(
    fakeAdapters({
      exists: async (target) => {
        if (target === TEMPORARY_PATH) throw queryFailure;
        return target === EVIDENCE_PATH;
      }
    }),
    EVIDENCE_PATH
  );
  await armPostReplace(throwing);
  await throwing.adapters.assertNoReparseComponents({});
  await assert.rejects(throwing.adapters.exists(TEMPORARY_PATH), queryFailure);
  assert.equal(
    throwing.createFailureDiagnostic(observedFailure()).normalPersistenceStage,
    "normal_revision2_post_replace_temp_absence_check"
  );

  const present = createNormalRevision2StageTrackingAdapters(
    fakeAdapters({ exists: async () => true }),
    EVIDENCE_PATH
  );
  await armPostReplace(present);
  await present.adapters.assertNoReparseComponents({});
  assert.equal(await present.adapters.exists(TEMPORARY_PATH), true);
  assert.equal(
    present.createFailureDiagnostic(observedFailure()).normalPersistenceStage,
    "normal_revision2_post_replace_temp_absence_check"
  );
});

test("target presence query failure and absent target keep their stage", async () => {
  const queryFailure = Object.assign(new Error("hidden"), { code: "ENOENT" });
  const throwing = createNormalRevision2StageTrackingAdapters(
    fakeAdapters({
      exists: async (target) => {
        if (target === TEMPORARY_PATH) return false;
        throw queryFailure;
      }
    }),
    EVIDENCE_PATH
  );
  await armPostReplace(throwing);
  await throwing.adapters.assertNoReparseComponents({});
  await throwing.adapters.exists(TEMPORARY_PATH);
  await assert.rejects(throwing.adapters.exists(EVIDENCE_PATH), queryFailure);
  const throwingDiagnostic = throwing.createFailureDiagnostic(observedFailure({
    systemErrorClass: "filesystem",
    systemErrorCode: "ENOENT"
  }));
  assert.equal(
    throwingDiagnostic.normalPersistenceStage,
    "normal_revision2_post_replace_target_presence_check"
  );
  assert.equal(throwingDiagnostic.sanitizedFailureCode, "ENOENT");

  const absent = createNormalRevision2StageTrackingAdapters(
    fakeAdapters({ exists: async () => false }),
    EVIDENCE_PATH
  );
  await armPostReplace(absent);
  await absent.adapters.assertNoReparseComponents({});
  await absent.adapters.exists(TEMPORARY_PATH);
  assert.equal(await absent.adapters.exists(EVIDENCE_PATH), false);
  assert.equal(
    absent.createFailureDiagnostic(observedFailure()).normalPersistenceStage,
    "normal_revision2_post_replace_target_presence_check"
  );
});

test("ACL exception and divergent ACL remain fail-closed at ACL stage", async () => {
  const aclFailure = Object.assign(new Error("hidden ACL"), { code: "EPERM" });
  const throwing = createNormalRevision2StageTrackingAdapters(
    fakeAdapters({ inspectProtectedAcl: async () => { throw aclFailure; } }),
    EVIDENCE_PATH
  );
  await armPostReplace(throwing);
  await passThroughTargetPresence(throwing);
  await assert.rejects(throwing.adapters.inspectProtectedAcl(EVIDENCE_PATH), aclFailure);
  const throwingDiagnostic = throwing.createFailureDiagnostic(observedFailure({
    systemErrorClass: "permission",
    systemErrorCode: "EPERM"
  }));
  assert.equal(
    throwingDiagnostic.normalPersistenceStage,
    "normal_revision2_post_replace_acl_validation"
  );
  assert.equal(throwingDiagnostic.sanitizedFailureClass, "acl");
  assert.equal(throwingDiagnostic.sanitizedFailureCode, "EPERM");

  const divergent = createNormalRevision2StageTrackingAdapters(
    fakeAdapters({
      inspectProtectedAcl: async () => ({
        ...VALID_SECURITY_PROOF,
        ownerCurrentUser: false
      })
    }),
    EVIDENCE_PATH
  );
  await armPostReplace(divergent);
  await passThroughTargetPresence(divergent);
  await divergent.adapters.inspectProtectedAcl(EVIDENCE_PATH);
  assert.equal(divergent.snapshot().trackingState, "failed");
  assert.equal(
    divergent.createFailureDiagnostic(observedFailure()).normalPersistenceStage,
    "normal_revision2_post_replace_acl_validation"
  );
});

test("target reopen failure is distinct from a later verification failure", async () => {
  const reopenFailure = Object.assign(new Error("hidden path"), { code: "EBUSY" });
  const failing = createNormalRevision2StageTrackingAdapters(
    fakeAdapters({ readFile: async () => { throw reopenFailure; } }),
    EVIDENCE_PATH
  );
  await armPostReplace(failing);
  await passThroughTargetPresence(failing);
  await failing.adapters.inspectProtectedAcl(EVIDENCE_PATH);
  await assert.rejects(failing.adapters.readFile(EVIDENCE_PATH), reopenFailure);
  const reopenDiagnostic = failing.createFailureDiagnostic(observedFailure({
    systemErrorClass: "filesystem",
    systemErrorCode: "EBUSY"
  }));
  assert.equal(
    reopenDiagnostic.normalPersistenceStage,
    "normal_revision2_post_replace_target_reopen"
  );
  assert.equal(reopenDiagnostic.sanitizedFailureClass, "filesystem");
  assert.equal(reopenDiagnostic.sanitizedFailureCode, "EBUSY");

  const later = createNormalRevision2StageTrackingAdapters(
    fakeAdapters(),
    EVIDENCE_PATH
  );
  await armPostReplace(later);
  await passThroughTargetPresence(later);
  await later.adapters.inspectProtectedAcl(EVIDENCE_PATH);
  await later.adapters.readFile(EVIDENCE_PATH);
  assert.equal(later.snapshot().trackingState, "completed");
  assert.equal(
    later.createFailureDiagnostic(observedFailure()).normalPersistenceStage,
    "normal_revision2_post_replace_verification_or_finalize"
  );
});

test("process UNKNOWN preserves stage and EBUSY alone never marks a fault synthetic", () => {
  const processDiagnostic = createNormalRevisionDiagnostic({
    stage: "normal_revision2_post_replace_reparse_audit",
    observedFailure: observedFailure()
  });
  assert.equal(processDiagnostic.sanitizedFailureClass, "process");
  assert.equal(processDiagnostic.sanitizedFailureCode, "UNKNOWN");

  const ebusyDiagnostic = createNormalRevisionDiagnostic({
    stage: "normal_revision2_post_replace_target_reopen",
    adapterFailure: { code: "EBUSY" },
    observedFailure: observedFailure({
      systemErrorClass: "filesystem",
      systemErrorCode: "EBUSY"
    })
  });
  assert.equal(ebusyDiagnostic.scenario, "normal_persistence");
  assert.equal(Object.hasOwn(ebusyDiagnostic, "synthetic"), false);
  assert.equal(Object.hasOwn(ebusyDiagnostic, "nonce"), false);
});

test("normal diagnostic rejects extra fields and non-allowlisted values", () => {
  const valid = createNormalRevisionDiagnostic({
    stage: "normal_revision2_post_replace_target_reopen",
    observedFailure: observedFailure()
  });
  for (const invalid of [
    { ...valid, message: "raw" },
    { ...valid, normalPersistenceStage: "other" },
    { ...valid, sanitizedFailureClass: "permission" },
    { ...valid, sanitizedFailureCode: "EIO" }
  ]) {
    assert.throws(() => validateNormalRevisionDiagnostic(invalid), {
      message: "ledger_ntfs_normal_diagnostic_invalid"
    });
  }
});
