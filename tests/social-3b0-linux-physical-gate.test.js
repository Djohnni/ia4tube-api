"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const express = require("express");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const test = require("node:test");

const gate = require("../scripts/social-3b0-linux-physical-gate");
const historicGate = require("../scripts/social-3a0p-linux-gate");
const realPostgresRunner = require("../scripts/run-real-postgres-tests");
const {
  PROCESS_LIFECYCLE_TEST_FILES,
  partitionAutomatedTests
} = require("../scripts/run-node-tests");
const {
  INSTAGRAM_OAUTH_REDIRECT_URI,
  loadInstagramOAuthConfig
} = require("../src/social/oauth/instagram-config");
const {
  contextFromRow,
  envelopeFromRow
} = require("../src/social/credential-service");
const { createSocialVault } = require("../src/social/vault");
const {
  deriveVaultKeyVersion,
  vaultKeyringFingerprint
} = require("../src/social/vault-key-version");

const SHA = "a".repeat(40);
const EXACT_0004_PHYSICAL_PROFILE_BEFORE = "social-schema-0003";
const O12_COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const O12_CREDENTIAL_ID = "22222222-2222-4222-8222-222222222222";
const O12_CONNECTION_ID = "33333333-3333-4333-8333-333333333333";
const O12_CREDENTIAL_TYPE = "instagram_user_access_token";

function collectSafeRunnerLines(lines, channel = "stdout") {
  const collector = realPostgresRunner.createSafeEventCollector();
  for (const line of lines) {
    const split = Math.max(1, Math.floor(Buffer.byteLength(line, "utf8") / 2));
    const body = Buffer.from(line, "utf8");
    collector.push(channel, body.subarray(0, split));
    collector.push(channel, body.subarray(split));
  }
  return collector.finish();
}

function untrustedSafeEvent(value) {
  return realPostgresRunner.SAFE_EVENT_PREFIX +
    realPostgresRunner.canonicalJson(value) + "\n";
}

function exactTapRunnerArguments() {
  return [
    "--test-reporter=tap",
    "--test-reporter-destination=stdout",
    "--test",
    path.resolve(__dirname, "social-postgres-real.test.js")
  ];
}

function assertExactTapRunnerArguments(args) {
  assert.deepEqual(args, exactTapRunnerArguments());
}

function safeEventNames(lines) {
  return lines.map((line) => JSON.parse(
    line.slice(realPostgresRunner.SAFE_EVENT_PREFIX.length)
  ).event);
}

function safeEventObject(event, sequence, fields = {}) {
  return {
    event,
    evidenceSchemaVersion: realPostgresRunner.EVIDENCE_SCHEMA_VERSION,
    sequence,
    ...fields
  };
}

function realTestFileLoadedLine(fingerprint, sequence = 1) {
  return realPostgresRunner.safeEventLine(safeEventObject(
    realPostgresRunner.REAL_TEST_FILE_LOAD_EVENT,
    sequence,
    { marker: realPostgresRunner.realTestFileLoadMarker(fingerprint) }
  ));
}

function shiftSafeEventSequences(lines, offset) {
  return lines.map((line) => {
    const event = JSON.parse(
      line.slice(realPostgresRunner.SAFE_EVENT_PREFIX.length)
    );
    return realPostgresRunner.safeEventLine({
      ...event,
      sequence: event.sequence + offset
    });
  });
}

function authenticatedPhysicalLines(fingerprint, phaseLines = []) {
  return [
    realTestFileLoadedLine(fingerprint),
    ...shiftSafeEventSequences(phaseLines, 1)
  ];
}

function emitExitAndClose(child, code, signal) {
  child.emit("exit", code, signal);
  child.emit("close", code, signal);
}

function exact0004Evidence(
  overrides = {},
  { failureObserved = false } = {}
) {
  return {
    ...realPostgresRunner.emptyExact0004Evidence({ failureObserved }),
    ...overrides
  };
}

function exact0004CompletionFields(subphase) {
  return subphase === "plan_exact"
    ? { physicalProfileBefore: EXACT_0004_PHYSICAL_PROFILE_BEFORE }
    : {};
}

async function completeConflictingNegative(phases) {
  phases.markExact0004ConflictingNegativeAttempted();
  const error = Object.assign(new Error("synthetic conflict"), {
    code: "23514"
  });
  await assert.rejects(
    phases.observeExact0004ConflictingNegative(Promise.reject(error)),
    (observed) => {
      const matched = observed?.code === "23514";
      phases.markExact0004ConflictingNegativeAssertionMatched(matched);
      return matched && observed === error;
    }
  );
}

async function completeExact0004Subphases(phases) {
  for (const subphase of
    realPostgresRunner.EXACT_0004_EXECUTION_SUBPHASES) {
    phases.startExact0004Subphase(subphase);
    if (subphase === "conflicting_0004_negative") {
      phases.markExact0004DatabaseMutationAttempted();
      await completeConflictingNegative(phases);
    }
    phases.completeExact0004Subphase(
      subphase,
      exact0004CompletionFields(subphase)
    );
  }
}

async function physicalPhaseLines({ complete = true } = {}) {
  const lines = [];
  const phases = realPostgresRunner.createPhysicalPhaseEmitter(
    (line) => lines.push(line)
  );
  for (const phase of realPostgresRunner.PHYSICAL_MAIN_PHASES) {
    phases.startMain(phase);
    if (!complete) break;
    if (phase === "exact_0004_plan_apply") {
      await completeExact0004Subphases(phases);
    }
    phases.completeMain(phase);
  }
  if (complete) {
    phases.startCleanup();
    phases.completeCleanup();
  }
  return lines;
}

async function exact0004FailurePhaseLines(
  subphase,
  { mutationAttempted = false } = {}
) {
  const targetIndex =
    realPostgresRunner.EXACT_0004_EXECUTION_SUBPHASES.indexOf(subphase);
  const mutationIndex =
    realPostgresRunner.EXACT_0004_EXECUTION_SUBPHASES.indexOf(
      "conflicting_0004_negative"
    );
  if (
    targetIndex < 0 ||
    (mutationAttempted && targetIndex < mutationIndex) ||
    (!mutationAttempted && targetIndex > mutationIndex)
  ) throw new Error("synthetic_exact_0004_boundary_invalid");
  const lines = [];
  const phases = realPostgresRunner.createPhysicalPhaseEmitter(
    (line) => lines.push(line)
  );
  for (const phase of realPostgresRunner.PHYSICAL_MAIN_PHASES) {
    phases.startMain(phase);
    if (phase !== "exact_0004_plan_apply") {
      phases.completeMain(phase);
      continue;
    }
    for (const candidate of
      realPostgresRunner.EXACT_0004_EXECUTION_SUBPHASES) {
      phases.startExact0004Subphase(candidate);
      if (candidate === "conflicting_0004_negative" && mutationAttempted) {
        phases.markExact0004DatabaseMutationAttempted();
      }
      if (candidate === subphase) break;
      if (candidate === "conflicting_0004_negative") {
        await completeConflictingNegative(phases);
      }
      phases.completeExact0004Subphase(
        candidate,
        exact0004CompletionFields(candidate)
      );
    }
    break;
  }
  phases.startCleanup();
  phases.completeCleanup();
  return lines;
}

function activeConflictingNegativeEmitter() {
  const lines = [];
  const phases = realPostgresRunner.createPhysicalPhaseEmitter(
    (line) => lines.push(line)
  );
  for (const phase of realPostgresRunner.PHYSICAL_MAIN_PHASES) {
    phases.startMain(phase);
    if (phase !== "exact_0004_plan_apply") {
      phases.completeMain(phase);
      continue;
    }
    for (const subphase of
      realPostgresRunner.EXACT_0004_EXECUTION_SUBPHASES) {
      phases.startExact0004Subphase(subphase);
      if (subphase === "conflicting_0004_negative") {
        phases.markExact0004DatabaseMutationAttempted();
        return { lines, phases };
      }
      phases.completeExact0004Subphase(
        subphase,
        exact0004CompletionFields(subphase)
      );
    }
  }
  throw new Error("synthetic_conflicting_negative_subphase_missing");
}

function observeNodeLines(entries) {
  const observer = realPostgresRunner.createNodeTestObserver();
  for (const { channel, line } of entries) {
    const body = Buffer.from(line, "utf8");
    const split = Math.max(1, Math.floor(body.length / 2));
    observer.push(channel, body.subarray(0, split));
    observer.push(channel, body.subarray(split));
  }
  return observer.finish();
}

async function runSyntheticReporterFailure({
  stdoutLines,
  stderrLines,
  phaseLines = []
}) {
  const fingerprint = "f".repeat(64);
  const emitted = [];
  let spawnArguments;
  const spawnImpl = (_executable, args) => {
    spawnArguments = args;
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    queueMicrotask(() => {
      child.emit("spawn");
      child.stderr.write(authenticatedPhysicalLines(
        fingerprint,
        phaseLines
      ).join(""));
      child.stdout.end([...stdoutLines, ""].join("\n"));
      child.stderr.end([...stderrLines, ""].join("\n"));
      setImmediate(() => emitExitAndClose(child, 1, null));
    });
    return child;
  };
  const exitCode = await realPostgresRunner.main({}, {
    spawnImpl,
    validateGateEnvironmentImpl: () => ({ fingerprint }),
    writeLine: (line) => emitted.push(line)
  });
  assertExactTapRunnerArguments(spawnArguments);
  return Object.freeze({
    emitted: Object.freeze(emitted),
    exitCode,
    facts: collectSafeRunnerLines(emitted)
  });
}

test("real PostgreSQL runner emits one canonical safe lifecycle without raw TAP", async () => {
  const fingerprint = "a".repeat(64);
  const emitted = [];
  const phaseLines = await physicalPhaseLines();
  let spawnArguments;
  let spawnOptions;
  const spawnImpl = (_executable, args, options) => {
    spawnArguments = args;
    spawnOptions = options;
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    queueMicrotask(() => {
      child.emit("spawn");
      child.stderr.end(authenticatedPhysicalLines(
        fingerprint,
        phaseLines
      ).join(""));
      child.stdout.end([
        "TAP version 13",
        `# Subtest: ${realPostgresRunner.TAP_TITLE}`,
        `ok 1 - ${realPostgresRunner.TAP_TITLE}`,
        "1..1",
        "# tests 1",
        "# pass 1",
        "# fail 0",
        "# skipped 0",
        "# cancelled 0",
        ""
      ].join("\n"));
      setImmediate(() => emitExitAndClose(child, 0, null));
    });
    return child;
  };
  const exitCode = await realPostgresRunner.main({}, {
    spawnImpl,
    validateGateEnvironmentImpl: () => ({ fingerprint }),
    writeLine: (line) => emitted.push(line)
  });
  assert.equal(exitCode, 0);
  assertExactTapRunnerArguments(spawnArguments);
  assert.equal(spawnOptions.shell, false);
  assert.deepEqual(spawnOptions.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(emitted.length, 12);
  assert.deepEqual(safeEventNames(emitted), [
    "runnerReached",
    "gateValidated",
    "nodeTestSpawnAttempted",
    "nodeTestProcessCreated",
    "testFileLoaded",
    "tapStarted",
    "tapTitleObserved",
    "firstTestDiscovered",
    "nodeTestTapSummary",
    "nodeTestExit",
    "nodeTestClose",
    "physicalPhaseSnapshot"
  ]);
  assert.equal(emitted.every((line) =>
    line.startsWith(realPostgresRunner.SAFE_EVENT_PREFIX)), true);
  assert.equal(emitted.some((line) => line.includes("TAP version 13")), false);
  assert.equal(emitted.some((line) =>
    line.includes(realPostgresRunner.TAP_TITLE)), false);
  const facts = collectSafeRunnerLines(emitted);
  assert.equal(facts.protocolValid, true);
  assert.equal(facts.eventCount, 12);
  for (const name of [
    "runnerReached",
    "gateValidated",
    "nodeTestSpawnAttempted",
    "nodeTestProcessCreated",
    "testFileLoaded",
    "tapStarted",
    "tapTitleObserved",
    "firstTestDiscovered"
  ]) assert.equal(facts[name], true, name);
  assert.equal(facts.nodeTestExitObserved, true);
  assert.equal(facts.nodeTestExitCode, 0);
  assert.equal(facts.nodeTestSignal, null);
  assert.equal(facts.nodeTestTimedOut, false);
  assert.equal(facts.nodeTestCloseObserved, true);
  assert.equal(facts.nodeTestCloseCode, 0);
  assert.equal(facts.nodeTestCloseSignal, null);
  assert.deepEqual([
    facts.testsDiscovered,
    facts.testsPassed,
    facts.testsFailed
  ], [1, 1, 0]);
  assert.equal(facts.lastMainPhaseStarted, "reauthentication");
  assert.equal(facts.lastMainPhaseCompleted, "reauthentication");
  assert.equal(facts.lastExact0004SubphaseStarted, "final_snapshot");
  assert.equal(facts.lastExact0004SubphaseCompleted, "final_snapshot");
  assert.equal(facts.exact0004FailureSubphase, "not_reached");
  assert.equal(facts.safeSqlState, "not_observed");
  assert.equal(facts.safeErrorClass, "unknown");
  assert.equal(facts.safeOperationClass, "unknown");
  assert.equal(facts.planExactInvoked, true);
  assert.equal(facts.planExactCompleted, true);
  assert.equal(
    facts.physicalProfileBefore,
    EXACT_0004_PHYSICAL_PROFILE_BEFORE
  );
  assert.equal(facts.profileBefore, "0003");
  assert.equal(facts.applyExactInvoked, true);
  assert.equal(facts.applyExactCompleted, true);
  assert.equal(facts.databaseMutationAttempted, true);
  assert.equal(facts.failureBeforeFirstMutation, false);
  assert.equal(facts.conflictingNegativeAttempted, true);
  assert.equal(facts.conflictingNegativePromiseOutcome, "rejected");
  assert.equal(facts.conflictingNegativeObservedSqlState, "23514");
  assert.equal(
    facts.conflictingNegativeFulfilledResultClass,
    "not_observed"
  );
  assert.equal(facts.conflictingNegativeAssertionMatched, true);
  assert.equal(facts.conflictingNegativeRejectedBeforeAssertion, true);
  assert.equal(facts.cleanupStarted, true);
  assert.equal(facts.cleanupCompleted, true);
  assert.equal(facts.failureDuringCleanup, false);
  assert.equal(facts.failurePhase, null);
  assert.equal(facts.safePermissionOrigin, null);
  assert.equal(facts.safeSourceBasename, null);
  assert.equal(facts.safeLineBucket, null);
  assert.equal(facts.firstFailureStage, null);
  assert.equal(facts.stderrCategory, null);
});

test("real PostgreSQL runner refuses implicit and alternate reporter contracts", () => {
  const expected = exactTapRunnerArguments();
  assertExactTapRunnerArguments(expected);
  const mutations = [
    ["--test", expected[3]],
    ["--test-reporter=spec", ...expected.slice(1)],
    ["--test-reporter=dot", ...expected.slice(1)],
    ["--test-reporter=junit", ...expected.slice(1)],
    [expected[0], "--test-reporter-destination=stderr", ...expected.slice(2)],
    [expected[1], expected[0], ...expected.slice(2)],
    [...expected.slice(0, 3), path.resolve(__dirname, "different.test.js")]
  ];
  for (const mutation of mutations) {
    assert.throws(() => assertExactTapRunnerArguments(mutation));
  }
});

test("real PostgreSQL runner classifies ReferenceError before TAP as bootstrap", async () => {
  const rawSentinel = "ReferenceError: raw_bootstrap_sentinel";
  const result = await runSyntheticReporterFailure({
    stdoutLines: [],
    stderrLines: [rawSentinel]
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.facts.protocolValid, true);
  assert.equal(result.facts.nodeTestProcessCreated, true);
  assert.equal(result.facts.tapStarted, null);
  assert.equal(result.facts.firstTestDiscovered, null);
  assert.equal(result.facts.firstFailureStage, "node_test_bootstrap");
  assert.equal(result.facts.stderrCategory, "reference_error");
  assert.equal(result.emitted.some((line) => line.includes(rawSentinel)), false);
});

test("real PostgreSQL runner classifies ReferenceError after discovery as test execution", async () => {
  const rawSentinel = "ReferenceError: raw_execution_sentinel";
  const result = await runSyntheticReporterFailure({
    stdoutLines: [
      "TAP version 13",
      `# Subtest: ${realPostgresRunner.TAP_TITLE}`
    ],
    phaseLines: await physicalPhaseLines({ complete: false }),
    stderrLines: [rawSentinel]
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.facts.protocolValid, true);
  assert.equal(result.facts.tapStarted, true);
  assert.equal(result.facts.tapTitleObserved, true);
  assert.equal(result.facts.firstTestDiscovered, true);
  assert.equal(result.facts.firstFailureStage, "test_execution");
  assert.equal(result.facts.stderrCategory, "reference_error");
  assert.deepEqual(
    Object.fromEntries(realPostgresRunner.EXACT_0004_EVIDENCE_FIELDS.map(
      (field) => [field, result.facts[field]]
    )),
    realPostgresRunner.emptyExact0004Evidence()
  );
  assert.equal(result.emitted.some((line) => line.includes(rawSentinel)), false);
});

test("real PostgreSQL runner preserves a sanitized gate refusal before spawn", async () => {
  const emitted = [];
  const exitCode = await realPostgresRunner.main({}, {
    validateGateEnvironmentImpl: () => {
      throw new realPostgresRunner.PostgresGateRefusal(
        "explicit_approval_missing"
      );
    },
    writeLine: (line) => emitted.push(line)
  });
  assert.equal(exitCode, 2);
  assert.equal(emitted.length, 2);
  const facts = collectSafeRunnerLines(emitted);
  assert.equal(facts.protocolValid, true);
  assert.equal(facts.runnerReached, true);
  assert.equal(facts.gateValidated, null);
  assert.equal(facts.nodeTestSpawnAttempted, null);
  assert.equal(facts.firstFailureStage, "environment_gate");
  assert.equal(facts.stderrCategory, "environment_contract");
  assert.equal(facts.safeErrorCode, "guard_failed");
  assert.equal(facts.safeModuleName, null);
});

test("real PostgreSQL runner classifies module failure without preserving its line", async () => {
  const fingerprint = "b".repeat(64);
  const emitted = [];
  const phaseLines = await physicalPhaseLines({ complete: false });
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    queueMicrotask(() => {
      child.emit("spawn");
      child.stderr.end(authenticatedPhysicalLines(
        fingerprint,
        phaseLines
      ).join(""));
      child.stdout.end([
        "TAP version 13",
        "Error: Cannot find module 'pg' MODULE_NOT_FOUND",
        ""
      ].join("\n"));
      setImmediate(() => emitExitAndClose(child, 1, null));
    });
    return child;
  };
  const exitCode = await realPostgresRunner.main({}, {
    spawnImpl,
    validateGateEnvironmentImpl: () => ({ fingerprint }),
    writeLine: (line) => emitted.push(line)
  });
  assert.equal(exitCode, 1);
  assert.equal(emitted.some((line) => line.includes("Cannot find")), false);
  const facts = collectSafeRunnerLines(emitted);
  assert.equal(facts.protocolValid, true);
  assert.equal(facts.nodeTestProcessCreated, true);
  assert.equal(facts.nodeTestExitCode, 1);
  assert.equal(facts.firstFailureStage, "test_discovery");
  assert.equal(facts.stderrCategory, "module_not_found");
  assert.equal(facts.safeErrorCode, "MODULE_NOT_FOUND");
  assert.equal(facts.safeModuleName, "pg");
});

test("real PostgreSQL runner distinguishes discovery from the expected TAP title", () => {
  const observed = [];
  const observer = realPostgresRunner.createNodeTestObserver(
    (name) => observed.push(name)
  );
  observer.push("stdout", Buffer.from([
    "TAP version 13",
    "# Subtest: synthetic unexpected title",
    ""
  ].join("\n"), "utf8"));
  const facts = observer.finish();
  assert.equal(facts.tapStarted, true);
  assert.equal(facts.tapTitleObserved, false);
  assert.equal(facts.firstTestDiscovered, true);
  assert.deepEqual(observed, ["tapStarted", "firstTestDiscovered"]);
});

test("real PostgreSQL runner preserves an observable spawn refusal", async () => {
  const emitted = [];
  const exitCode = await realPostgresRunner.main({}, {
    spawnImpl: () => {
      throw Object.assign(new Error("synthetic refusal"), { code: "EACCES" });
    },
    validateGateEnvironmentImpl: () => ({ fingerprint: "c".repeat(64) }),
    writeLine: (line) => emitted.push(line)
  });
  assert.equal(exitCode, 2);
  const facts = collectSafeRunnerLines(emitted);
  assert.equal(facts.protocolValid, true);
  assert.equal(facts.nodeTestSpawnAttempted, true);
  assert.equal(facts.nodeTestProcessCreated, null);
  assert.equal(facts.nodeTestExitCode, null);
  assert.equal(facts.firstFailureStage, "node_test_spawn");
  assert.equal(facts.stderrCategory, "permission_denied");
  assert.equal(facts.safeErrorCode, "EACCES");
});

test("real PostgreSQL runner preserves a signal close without inventing timeout", async () => {
  const fingerprint = "d".repeat(64);
  const emitted = [];
  const phaseLines = await physicalPhaseLines({ complete: false });
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    queueMicrotask(() => {
      child.emit("spawn");
      child.stderr.end(authenticatedPhysicalLines(
        fingerprint,
        phaseLines
      ).join(""));
      child.stdout.end([
        "TAP version 13",
        `# Subtest: ${realPostgresRunner.TAP_TITLE}`,
        "# tests 1",
        "# pass 1",
        "# fail 0",
        "# skipped 0",
        "# cancelled 0",
        ""
      ].join("\n"));
      setImmediate(() => emitExitAndClose(child, null, "SIGTERM"));
    });
    return child;
  };
  const exitCode = await realPostgresRunner.main({}, {
    spawnImpl,
    validateGateEnvironmentImpl: () => ({ fingerprint }),
    writeLine: (line) => emitted.push(line)
  });
  assert.equal(exitCode, 1);
  const facts = collectSafeRunnerLines(emitted);
  assert.equal(facts.protocolValid, true);
  assert.equal(facts.nodeTestProcessCreated, true);
  assert.equal(facts.nodeTestExitCode, null);
  assert.equal(facts.nodeTestSignal, "SIGTERM");
  assert.equal(facts.nodeTestTimedOut, false);
  assert.equal(facts.nodeTestCloseObserved, true);
  assert.equal(facts.nodeTestCloseSignal, "SIGTERM");
  assert.equal(facts.firstFailureStage, "test_execution");
});

test("protocol group 1: physical phases accept only the complete ordered main and cleanup lifecycle", async () => {
  assert.equal(realPostgresRunner.EVIDENCE_SCHEMA_VERSION, 7);
  assert.deepEqual(realPostgresRunner.PHYSICAL_PHASES, [
    "physical_target_preflight",
    "role_provisioning",
    "direct_connect_boundary",
    "startup_unmigrated",
    "migration_0001_0002",
    "pre_registry_seed",
    "migration_0003_rollback",
    "migration_0003_apply",
    "exact_0004_plan_apply",
    "post_migration_validation",
    "migration_cli",
    "runtime_role_schema",
    "runtime_permission_negatives",
    "tenant_rls",
    "vault_persistence",
    "reauthentication",
    "final_cleanup"
  ]);
  const completePhaseLines = await physicalPhaseLines();
  const facts = observeNodeLines(completePhaseLines.map((line) => ({
    channel: "stderr",
    line
  })));
  assert.equal(facts.phaseProtocolValid, true);
  assert.equal(facts.phaseEventCount, 70);
  const exactBoundaryEvents = completePhaseLines.map((line) => JSON.parse(
    line.slice(realPostgresRunner.SAFE_EVENT_PREFIX.length)
  )).filter((event) => [
    "exact0004SubphaseStarted",
    "exact0004SubphaseCompleted"
  ].includes(event.event));
  assert.deepEqual(
    exactBoundaryEvents.map((event) => [event.event, event.subphase]),
    realPostgresRunner.EXACT_0004_EXECUTION_SUBPHASES.flatMap(
      (subphase) => [
        ["exact0004SubphaseStarted", subphase],
        ["exact0004SubphaseCompleted", subphase]
      ]
    )
  );
  assert.equal(facts.lastMainPhaseStarted, "reauthentication");
  assert.equal(facts.lastMainPhaseCompleted, "reauthentication");
  assert.equal(facts.lastExact0004SubphaseStarted, "final_snapshot");
  assert.equal(facts.lastExact0004SubphaseCompleted, "final_snapshot");
  assert.equal(facts.exact0004FailureSubphase, "not_reached");
  assert.equal(facts.safeSqlState, "not_observed");
  assert.equal(facts.safeErrorClass, "unknown");
  assert.equal(facts.safeOperationClass, "unknown");
  assert.equal(facts.planExactInvoked, true);
  assert.equal(facts.planExactCompleted, true);
  assert.equal(
    facts.physicalProfileBefore,
    EXACT_0004_PHYSICAL_PROFILE_BEFORE
  );
  assert.equal(facts.applyExactInvoked, true);
  assert.equal(facts.applyExactCompleted, true);
  assert.equal(facts.databaseMutationAttempted, true);
  assert.equal(facts.failureBeforeFirstMutation, false);
  assert.equal(facts.conflictingNegativeAttempted, true);
  assert.equal(facts.conflictingNegativePromiseOutcome, "rejected");
  assert.equal(facts.conflictingNegativeObservedSqlState, "23514");
  assert.equal(facts.conflictingNegativeFulfilledResultClass, "not_observed");
  assert.equal(facts.conflictingNegativeAssertionMatched, true);
  assert.equal(facts.conflictingNegativeRejectedBeforeAssertion, true);
  assert.equal(facts.cleanupStarted, true);
  assert.equal(facts.cleanupCompleted, true);
  const planCompletion = exactBoundaryEvents.find((event) =>
    event.event === "exact0004SubphaseCompleted" &&
      event.subphase === "plan_exact"
  );
  assert.ok(planCompletion);
  assert.deepEqual(
    Object.keys(planCompletion).sort(),
    [
      "event",
      "evidenceSchemaVersion",
      "operationClass",
      "physicalProfileBefore",
      "sequence",
      "subphase"
    ]
  );
  assert.equal(
    planCompletion.physicalProfileBefore,
    EXACT_0004_PHYSICAL_PROFILE_BEFORE
  );
  const missingExact0004Subphases =
    realPostgresRunner.createPhysicalPhaseEmitter(() => {});
  for (const phase of realPostgresRunner.PHYSICAL_MAIN_PHASES) {
    missingExact0004Subphases.startMain(phase);
    if (phase === "exact_0004_plan_apply") {
      assert.throws(
        () => missingExact0004Subphases.completeMain(phase),
        /physical_phase_protocol_invalid/
      );
      break;
    }
    missingExact0004Subphases.completeMain(phase);
  }
});

test("protocol group 1: authenticated profile before is canonical, allowlisted and bound only to plan completion", () => {
  function emitterAtPlanCompletion(writeLine = () => {}) {
    const emitter = realPostgresRunner.createPhysicalPhaseEmitter(writeLine);
    for (const phase of realPostgresRunner.PHYSICAL_MAIN_PHASES) {
      emitter.startMain(phase);
      if (phase !== "exact_0004_plan_apply") {
        emitter.completeMain(phase);
        continue;
      }
      for (const subphase of
        realPostgresRunner.EXACT_0004_EXECUTION_SUBPHASES) {
        emitter.startExact0004Subphase(subphase);
        if (subphase === "plan_exact") return emitter;
        emitter.completeExact0004Subphase(
          subphase,
          exact0004CompletionFields(subphase)
        );
      }
    }
    throw new Error("synthetic_plan_exact_subphase_missing");
  }

  const acceptedLines = [];
  const accepted = emitterAtPlanCompletion((line) => acceptedLines.push(line));
  accepted.completeExact0004Subphase("plan_exact", {
    physicalProfileBefore: EXACT_0004_PHYSICAL_PROFILE_BEFORE
  });
  const acceptedEvent = JSON.parse(acceptedLines.at(-1).slice(
    realPostgresRunner.SAFE_EVENT_PREFIX.length
  ));
  assert.equal(acceptedEvent.event, "exact0004SubphaseCompleted");
  assert.equal(acceptedEvent.subphase, "plan_exact");
  assert.equal(
    acceptedEvent.physicalProfileBefore,
    EXACT_0004_PHYSICAL_PROFILE_BEFORE
  );
  assert.equal(Object.hasOwn(acceptedEvent, "profileBefore"), false);

  assert.throws(
    () => emitterAtPlanCompletion().completeExact0004Subphase("plan_exact"),
    /physical_phase_completion_fields_invalid/
  );
  assert.throws(
    () => emitterAtPlanCompletion().completeExact0004Subphase("plan_exact", {
      physicalProfileBefore: EXACT_0004_PHYSICAL_PROFILE_BEFORE,
      profileBefore: "0003"
    }),
    /physical_phase_completion_fields_invalid/
  );
  for (const physicalProfileBefore of [
    "social-schema-0004",
    "0003",
    "arbitrary-profile",
    null
  ]) {
    assert.throws(
      () => emitterAtPlanCompletion().completeExact0004Subphase(
        "plan_exact",
        { physicalProfileBefore }
      ),
      /physical_phase_protocol_invalid/
    );
  }

  const outsidePlan = realPostgresRunner.createPhysicalPhaseEmitter(() => {});
  for (const phase of realPostgresRunner.PHYSICAL_MAIN_PHASES) {
    outsidePlan.startMain(phase);
    if (phase === "exact_0004_plan_apply") break;
    outsidePlan.completeMain(phase);
  }
  outsidePlan.startExact0004Subphase("oid_catalog_lookup");
  assert.throws(
    () => outsidePlan.completeExact0004Subphase("oid_catalog_lookup", {
      physicalProfileBefore: EXACT_0004_PHYSICAL_PROFILE_BEFORE
    }),
    /physical_phase_completion_fields_invalid/
  );
});

test("protocol group 1: physical phases refuse jumps, repeats, unknowns, extras and post-cleanup markers", async () => {
  const version = realPostgresRunner.EVIDENCE_SCHEMA_VERSION;
  const event = (name, phase, sequence, extra = {}) => untrustedSafeEvent({
    event: name,
    evidenceSchemaVersion: version,
    phase,
    sequence,
    ...extra
  });
  const first = event(
    "mainPhaseStarted",
    "physical_target_preflight",
    1
  );
  const firstDone = event(
    "mainPhaseCompleted",
    "physical_target_preflight",
    2
  );
  const complete = await physicalPhaseLines();
  const skippedExternalAccountGate = complete.map((line) => {
    const candidate = JSON.parse(
      line.slice(realPostgresRunner.SAFE_EVENT_PREFIX.length)
    );
    if (
      candidate.event === "exact0004SubphaseStarted" &&
      candidate.subphase === "conflicting_external_account_0004_negative"
    ) {
      return untrustedSafeEvent({
        ...candidate,
        operationClass: "apply",
        subphase: "apply_exact"
      });
    }
    return line;
  });
  const invalidCases = [
    [event("mainPhaseStarted", "role_provisioning", 1)],
    [first, event("mainPhaseStarted", "physical_target_preflight", 2)],
    [event("mainPhaseStarted", "unknown_phase", 1)],
    [event("mainPhaseStarted", "physical_target_preflight", 1, {
      extra: true
    })],
    [realPostgresRunner.SAFE_EVENT_PREFIX + "{invalid}\n"],
    [
      first,
      firstDone,
      event("mainPhaseStarted", "direct_connect_boundary", 3)
    ],
    [
      ...complete,
      event("mainPhaseStarted", "physical_target_preflight", 71)
    ],
    skippedExternalAccountGate
  ];
  for (const lines of invalidCases) {
    const facts = observeNodeLines(lines.map((line) => ({
      channel: "stderr",
      line
    })));
    assert.equal(facts.phaseProtocolValid, false);
  }
});

test("protocol group 1: physical snapshot keeps main and cleanup boundaries separate", async () => {
  const functionalLines = [];
  const functional = realPostgresRunner.createPhysicalPhaseEmitter(
    (line) => functionalLines.push(line)
  );
  functional.startMain("physical_target_preflight");
  functional.startCleanup();
  functional.completeCleanup();
  const functionalFacts = observeNodeLines(functionalLines.map((line) => ({
    channel: "stderr",
    line
  })));
  assert.equal(functionalFacts.phaseProtocolValid, true);
  assert.equal(
    functionalFacts.lastMainPhaseStarted,
    "physical_target_preflight"
  );
  assert.equal(functionalFacts.lastMainPhaseCompleted, null);
  assert.equal(functionalFacts.cleanupStarted, true);
  assert.equal(functionalFacts.cleanupCompleted, true);

  const cleanupLines = [];
  const cleanup = realPostgresRunner.createPhysicalPhaseEmitter(
    (line) => cleanupLines.push(line)
  );
  for (const phase of realPostgresRunner.PHYSICAL_MAIN_PHASES) {
    cleanup.startMain(phase);
    if (phase === "exact_0004_plan_apply") {
      await completeExact0004Subphases(cleanup);
    }
    cleanup.completeMain(phase);
  }
  cleanup.startCleanup();
  const cleanupFacts = observeNodeLines(cleanupLines.map((line) => ({
    channel: "stderr",
    line
  })));
  assert.equal(cleanupFacts.phaseProtocolValid, true);
  assert.equal(cleanupFacts.lastMainPhaseCompleted, "reauthentication");
  assert.equal(cleanupFacts.cleanupStarted, true);
  assert.equal(cleanupFacts.cleanupCompleted, false);
});

test("protocol group 1: exact 0004 evidence is closed, ordered, immutable and sanitized", async () => {
  assert.deepEqual(realPostgresRunner.EXACT_0004_SUBPHASES, [
    "oid_catalog_lookup",
    "direct_privilege_boolean_check",
    "direct_ledger_read_negative",
    "set_local_migrator_role",
    "role_ledger_read_positive",
    "snapshot_before_plan",
    "plan_exact",
    "plan_snapshot_compare",
    "synthetic_0005_negative",
    "conflicting_0004_negative",
    "rollback_verification",
    "conflicting_external_account_0004_negative",
    "external_account_rollback_verification",
    "apply_exact",
    "concurrency",
    "final_snapshot",
    "unknown",
    "not_reached"
  ]);
  assert.equal(realPostgresRunner.EXACT_0004_SUBPHASES.length, 18);
  assert.equal(
    realPostgresRunner.EXACT_0004_EXECUTION_SUBPHASES.length,
    16
  );
  assert.equal(realPostgresRunner.EXACT_0004_EVIDENCE_FIELDS.length, 18);
  assert.deepEqual(realPostgresRunner.EXACT_0004_OPERATION_CLASSES, [
    "catalog_read",
    "privilege_check",
    "direct_negative_read",
    "role_switch",
    "role_positive_read",
    "schema_snapshot",
    "plan",
    "negative_gate",
    "rollback_check",
    "apply",
    "concurrency",
    "final_validation",
    "unknown"
  ]);
  assert.deepEqual(realPostgresRunner.EXACT_0004_ERROR_CLASSES, [
    "postgres_sqlstate",
    "assertion_failure",
    "environment_contract",
    "process_failure",
    "timeout",
    "unexpected_result",
    "unknown"
  ]);
  assert.deepEqual(realPostgresRunner.SAFE_SQL_STATES, [
    "42501",
    "23514",
    "P0001"
  ]);
  assert.deepEqual(realPostgresRunner.CONFLICTING_NEGATIVE_PROMISE_OUTCOMES, [
    "not_started",
    "fulfilled",
    "rejected",
    "unknown"
  ]);
  assert.deepEqual(
    realPostgresRunner.CONFLICTING_NEGATIVE_FULFILLED_RESULT_CLASSES,
    ["not_observed", "empty", "applied_0004", "other", "unknown"]
  );
  const operationBySubphase = {
    oid_catalog_lookup: "catalog_read",
    direct_privilege_boolean_check: "privilege_check",
    direct_ledger_read_negative: "direct_negative_read",
    set_local_migrator_role: "role_switch",
    role_ledger_read_positive: "role_positive_read",
    snapshot_before_plan: "schema_snapshot",
    plan_exact: "plan",
    plan_snapshot_compare: "schema_snapshot",
    synthetic_0005_negative: "negative_gate",
    conflicting_0004_negative: "negative_gate",
    rollback_verification: "rollback_check",
    conflicting_external_account_0004_negative: "negative_gate",
    external_account_rollback_verification: "rollback_check",
    apply_exact: "apply",
    concurrency: "concurrency",
    final_snapshot: "final_validation"
  };
  for (const [subphase, operationClass] of
    Object.entries(operationBySubphase)) {
    assert.equal(
      realPostgresRunner.exact0004OperationClass(subphase),
      operationClass
    );
  }
  assert.equal(realPostgresRunner.exact0004OperationClass("unknown"), "unknown");
  assert.equal(
    realPostgresRunner.exact0004OperationClass("not_reached"),
    "unknown"
  );

  const allowedFailure = exact0004Evidence({
    lastExact0004SubphaseStarted: "oid_catalog_lookup",
    lastExact0004SubphaseCompleted: "not_reached",
    exact0004FailureSubphase: "oid_catalog_lookup",
    safeSqlState: "42501",
    safeErrorClass: "postgres_sqlstate",
    safeOperationClass: "catalog_read",
    failureBeforeFirstMutation: true
  }, { failureObserved: true });
  assert.equal(realPostgresRunner.exact0004EvidenceValid(
    allowedFailure,
    { failureEvent: true }
  ), true);
  for (const invalid of [
    { ...allowedFailure, lastExact0004SubphaseStarted: "outside_enum" },
    { ...allowedFailure, exact0004FailureSubphase: "outside_enum" },
    { ...allowedFailure, safeSqlState: "57014" },
    { ...allowedFailure, safeErrorClass: "outside_enum" },
    { ...allowedFailure, safeOperationClass: "outside_enum" },
    {
      ...realPostgresRunner.emptyExact0004Evidence(),
      lastExact0004SubphaseCompleted: "oid_catalog_lookup"
    }
  ]) {
    assert.equal(realPostgresRunner.exact0004EvidenceValid(
      invalid,
      { failureEvent: true }
    ), false);
  }

  function emitterAtExact0004() {
    const emitter = realPostgresRunner.createPhysicalPhaseEmitter(() => {});
    for (const phase of realPostgresRunner.PHYSICAL_MAIN_PHASES) {
      emitter.startMain(phase);
      if (phase === "exact_0004_plan_apply") return emitter;
      emitter.completeMain(phase);
    }
    throw new Error("synthetic_exact_0004_phase_missing");
  }
  assert.throws(
    () => emitterAtExact0004().startExact0004Subphase("outside_enum"),
    /physical_phase_protocol_invalid/
  );
  assert.throws(
    () => emitterAtExact0004().completeExact0004Subphase(
      "oid_catalog_lookup"
    ),
    /physical_phase_protocol_invalid/
  );
  const duplicate = emitterAtExact0004();
  duplicate.startExact0004Subphase("oid_catalog_lookup");
  assert.throws(
    () => duplicate.startExact0004Subphase("oid_catalog_lookup"),
    /physical_phase_protocol_invalid/
  );

  const tapPrefix = [
    "TAP version 13",
    `# Subtest: ${realPostgresRunner.TAP_TITLE}`
  ];
  const beforeMutation = await runSyntheticReporterFailure({
    stdoutLines: tapPrefix,
    phaseLines: await exact0004FailurePhaseLines("oid_catalog_lookup"),
    stderrLines: ["permission denied", "code: '42501'"]
  });
  assert.equal(beforeMutation.facts.exact0004FailureSubphase,
    "oid_catalog_lookup");
  assert.equal(beforeMutation.facts.safeOperationClass, "catalog_read");
  assert.equal(beforeMutation.facts.safeSqlState, "42501");
  assert.equal(beforeMutation.facts.safeErrorClass, "postgres_sqlstate");
  assert.equal(beforeMutation.facts.databaseMutationAttempted, false);
  assert.equal(beforeMutation.facts.failureBeforeFirstMutation, true);

  const rawSql = "SELECT raw_sql_sentinel FROM private_table";
  const rawMessage = "raw_message_sentinel";
  const rawStack =
    "    at probe (C:\\private\\raw_stack_sentinel.js:997:3)";
  const rawSecret = [
    "postgres",
    "://",
    ["raw_user", "raw_password"].join(":"),
    "@",
    ["fixture.example.invalid", "raw"].join("/"),
    "?",
    ["token", "raw_token"].join("=")
  ].join("");
  const assertionFailure = await runSyntheticReporterFailure({
    stdoutLines: tapPrefix,
    phaseLines: await exact0004FailurePhaseLines(
      "direct_privilege_boolean_check"
    ),
    stderrLines: [
      "AssertionError ERR_ASSERTION",
      "code: '23514'",
      rawSql,
      rawMessage,
      rawStack,
      rawSecret
    ]
  });
  assert.equal(assertionFailure.facts.safeSqlState, "23514");
  assert.equal(assertionFailure.facts.safeErrorClass, "assertion_failure");
  const sanitized = JSON.stringify({
    emitted: assertionFailure.emitted,
    facts: assertionFailure.facts
  });
  for (const forbidden of [
    rawSql,
    rawMessage,
    rawStack,
    "C:\\private",
    "raw_password",
    "raw_token"
  ]) assert.equal(sanitized.includes(forbidden), false, forbidden);
  for (const forbiddenKey of [
    "query",
    "params",
    "message",
    "detail",
    "hint",
    "where",
    "stack",
    "stdout",
    "stderr",
    "env",
    "url",
    "login",
    "password",
    "token",
    "key",
    "fixture"
  ]) assert.equal(Object.hasOwn(assertionFailure.facts, forbiddenKey), false);

  const nestedDiagnostic =
    realPostgresRunner.createSafeDiagnosticAggregator();
  const wrappedAssertion = new Error("root_message_must_not_escape");
  wrappedAssertion.name = "AssertionError";
  wrappedAssertion.code = "ERR_ASSERTION";
  wrappedAssertion.actual = {
    name: "DatabaseError",
    code: "23514",
    message: "P0001 nested_actual_message_must_not_be_observed",
    stack: "42501 nested_actual_stack_must_not_be_observed"
  };
  wrappedAssertion.cause = {
    name: "Error",
    message: "environment_contract nested_cause_must_not_be_observed",
    stack: "C:\\private\\nested_cause_stack.js:9:1"
  };
  nestedDiagnostic.observeError(wrappedAssertion);
  const nestedFacts = nestedDiagnostic.finish();
  assert.equal(nestedFacts.safeDiagnosticValid, true);
  assert.equal(nestedFacts.safeSqlState, "23514");
  assert.equal(nestedFacts.safeErrorClass, "assertion_failure");
  const nestedSerialized = JSON.stringify(nestedFacts);
  for (const forbidden of [
    "root_message_must_not_escape",
    "nested_actual_message_must_not_be_observed",
    "nested_actual_stack_must_not_be_observed",
    "nested_cause_must_not_be_observed",
    "nested_cause_stack"
  ]) assert.equal(nestedSerialized.includes(forbidden), false, forbidden);

  const afterMutation = await runSyntheticReporterFailure({
    stdoutLines: tapPrefix,
    phaseLines: await exact0004FailurePhaseLines(
      "rollback_verification",
      { mutationAttempted: true }
    ),
    stderrLines: ["code: 'P0001'"]
  });
  assert.equal(afterMutation.facts.exact0004FailureSubphase,
    "rollback_verification");
  assert.equal(afterMutation.facts.safeOperationClass, "rollback_check");
  assert.equal(afterMutation.facts.safeSqlState, "P0001");
  assert.equal(afterMutation.facts.safeErrorClass, "postgres_sqlstate");
  assert.equal(afterMutation.facts.databaseMutationAttempted, true);
  assert.equal(afterMutation.facts.failureBeforeFirstMutation, false);

  const externalAccountGateFailure = await runSyntheticReporterFailure({
    stdoutLines: tapPrefix,
    phaseLines: await exact0004FailurePhaseLines(
      "conflicting_external_account_0004_negative",
      { mutationAttempted: true }
    ),
    stderrLines: ["AssertionError ERR_ASSERTION", "code: '23514'"]
  });
  assert.equal(
    externalAccountGateFailure.facts.lastExact0004SubphaseStarted,
    "conflicting_external_account_0004_negative"
  );
  assert.equal(
    externalAccountGateFailure.facts.lastExact0004SubphaseCompleted,
    "rollback_verification"
  );
  assert.equal(
    externalAccountGateFailure.facts.exact0004FailureSubphase,
    "conflicting_external_account_0004_negative"
  );
  assert.equal(
    externalAccountGateFailure.facts.safeOperationClass,
    "negative_gate"
  );
  assert.equal(externalAccountGateFailure.facts.safeSqlState, "23514");
  assert.equal(
    externalAccountGateFailure.facts.safeErrorClass,
    "assertion_failure"
  );
  assert.equal(
    externalAccountGateFailure.facts.conflictingNegativeAssertionMatched,
    true
  );

  const externalAccountRollbackFailure = await runSyntheticReporterFailure({
    stdoutLines: tapPrefix,
    phaseLines: await exact0004FailurePhaseLines(
      "external_account_rollback_verification",
      { mutationAttempted: true }
    ),
    stderrLines: ["code: 'P0001'"]
  });
  assert.equal(
    externalAccountRollbackFailure.facts.lastExact0004SubphaseStarted,
    "external_account_rollback_verification"
  );
  assert.equal(
    externalAccountRollbackFailure.facts.lastExact0004SubphaseCompleted,
    "conflicting_external_account_0004_negative"
  );
  assert.equal(
    externalAccountRollbackFailure.facts.exact0004FailureSubphase,
    "external_account_rollback_verification"
  );
  assert.equal(
    externalAccountRollbackFailure.facts.safeOperationClass,
    "rollback_check"
  );
  assert.equal(externalAccountRollbackFailure.facts.safeSqlState, "P0001");
  assert.equal(
    externalAccountRollbackFailure.facts.safeErrorClass,
    "postgres_sqlstate"
  );

  const externalAccountGateEvidence = Object.fromEntries(
    realPostgresRunner.EXACT_0004_EVIDENCE_FIELDS.map((field) => [
      field,
      externalAccountGateFailure.facts[field]
    ])
  );
  assert.equal(realPostgresRunner.exact0004EvidenceValid(
    externalAccountGateEvidence,
    { failureEvent: true }
  ), true);
  assert.equal(realPostgresRunner.exact0004EvidenceValid({
    ...externalAccountGateEvidence,
    safeOperationClass: "rollback_check"
  }, { failureEvent: true }), false);
  assert.equal(realPostgresRunner.exact0004EvidenceValid({
    ...externalAccountGateEvidence,
    lastExact0004SubphaseCompleted: "conflicting_0004_negative"
  }, { failureEvent: true }), false);

  const invalidSqlState = await runSyntheticReporterFailure({
    stdoutLines: tapPrefix,
    phaseLines: await exact0004FailurePhaseLines("oid_catalog_lookup"),
    stderrLines: ["code: '57014'"]
  });
  assert.equal(invalidSqlState.facts.safeSqlState, "unknown");
  const missingSqlState = await runSyntheticReporterFailure({
    stdoutLines: tapPrefix,
    phaseLines: await exact0004FailurePhaseLines("oid_catalog_lookup"),
    stderrLines: ["AssertionError ERR_ASSERTION"]
  });
  assert.equal(missingSqlState.facts.safeSqlState, "unknown");
  assert.equal(missingSqlState.facts.safeErrorClass, "assertion_failure");

  const appendedAfterFailure = beforeMutation.emitted[0]
    .replace(
      '"sequence":1',
      `"sequence":${beforeMutation.emitted.length + 1}`
    );
  const preserved = collectSafeRunnerLines([
    ...beforeMutation.emitted,
    appendedAfterFailure
  ]);
  assert.equal(preserved.protocolValid, false);
  assert.equal(preserved.firstFailureStage, "test_execution");
  assert.equal(preserved.exact0004FailureSubphase, "oid_catalog_lookup");
  assert.equal(preserved.safeSqlState, "42501");
  assert.equal(preserved.safeErrorClass, "postgres_sqlstate");

  const failureEvent = JSON.parse(beforeMutation.emitted.at(-1)
    .slice(realPostgresRunner.SAFE_EVENT_PREFIX.length));
  assert.deepEqual(Object.keys(failureEvent).sort(), [
    "applyExactCompleted",
    "applyExactInvoked",
    "conflictingNegativeAssertionMatched",
    "conflictingNegativeAttempted",
    "conflictingNegativeFulfilledResultClass",
    "conflictingNegativeObservedSqlState",
    "conflictingNegativePromiseOutcome",
    "conflictingNegativeRejectedBeforeAssertion",
    "databaseMutationAttempted",
    "event",
    "evidenceSchemaVersion",
    "exact0004FailureSubphase",
    "failureBeforeFirstMutation",
    "failureDuringCleanup",
    "failurePhase",
    "firstFailureStage",
    "lastExact0004SubphaseCompleted",
    "lastExact0004SubphaseStarted",
    "planExactCompleted",
    "planExactInvoked",
    "safeErrorClass",
    "safeErrorCode",
    "safeLineBucket",
    "safeModuleName",
    "safeOperationClass",
    "safePermissionOrigin",
    "safeSourceBasename",
    "safeSqlState",
    "sequence",
    "stderrCategory"
  ].sort());
});

test("protocol group 1: conflicting 0004 Promise outcome evidence is closed and observational", async () => {
  const empty = realPostgresRunner.emptyConflictingNegativeEvidence();
  assert.deepEqual(empty, {
    conflictingNegativeAttempted: false,
    conflictingNegativePromiseOutcome: "not_started",
    conflictingNegativeObservedSqlState: "not_observed",
    conflictingNegativeFulfilledResultClass: "not_observed",
    conflictingNegativeAssertionMatched: null,
    conflictingNegativeRejectedBeforeAssertion: null
  });
  assert.equal(Object.isFrozen(empty), true);
  assert.equal(realPostgresRunner.conflictingNegativeEvidenceValid(empty), true);
  for (const invalid of [
    { ...empty, conflictingNegativeAttempted: true },
    { ...empty, conflictingNegativePromiseOutcome: "outside_enum" },
    { ...empty, conflictingNegativeObservedSqlState: "12-xy" },
    {
      ...empty,
      conflictingNegativeAttempted: true,
      conflictingNegativePromiseOutcome: "rejected",
      conflictingNegativeObservedSqlState: "23514",
      conflictingNegativeAssertionMatched: false,
      conflictingNegativeRejectedBeforeAssertion: true
    },
    {
      ...empty,
      conflictingNegativeAttempted: true,
      conflictingNegativePromiseOutcome: "fulfilled",
      conflictingNegativeFulfilledResultClass: "empty",
      conflictingNegativeRejectedBeforeAssertion: true
    }
  ]) {
    assert.equal(
      realPostgresRunner.conflictingNegativeEvidenceValid(invalid),
      false
    );
  }
  const attemptedWithoutMutation = exact0004Evidence({
    lastExact0004SubphaseStarted: "conflicting_0004_negative",
    lastExact0004SubphaseCompleted: "synthetic_0005_negative",
    exact0004FailureSubphase: "conflicting_0004_negative",
    safeSqlState: "unknown",
    safeErrorClass: "assertion_failure",
    safeOperationClass: "negative_gate",
    planExactInvoked: true,
    planExactCompleted: true,
    databaseMutationAttempted: false,
    failureBeforeFirstMutation: true,
    conflictingNegativeAttempted: true,
    conflictingNegativePromiseOutcome: "unknown",
    conflictingNegativeObservedSqlState: "unknown",
    conflictingNegativeFulfilledResultClass: "unknown"
  }, { failureObserved: true });
  assert.equal(
    realPostgresRunner.conflictingNegativeEvidenceValid(
      attemptedWithoutMutation
    ),
    true
  );
  assert.equal(
    realPostgresRunner.exact0004EvidenceValid(attemptedWithoutMutation, {
      failureEvent: true
    }),
    false
  );

  const physicalFacts = (lines) => observeNodeLines(lines.map((line) => ({
    channel: "stderr",
    line
  })));
  async function rejectedScenario(error) {
    const route = activeConflictingNegativeEmitter();
    route.phases.markExact0004ConflictingNegativeAttempted();
    let predicateError = null;
    const assertion = assert.rejects(
      route.phases.observeExact0004ConflictingNegative(
        Promise.reject(error)
      ),
      (observed) => {
        predicateError = observed;
        const matched = observed?.code === "23514";
        route.phases.markExact0004ConflictingNegativeAssertionMatched(
          matched
        );
        return matched;
      }
    );
    let assertionError = null;
    try {
      await assertion;
    } catch (errorFromAssertion) {
      assertionError = errorFromAssertion;
    }
    assert.equal(predicateError, error);
    return {
      assertionError,
      facts: physicalFacts(route.lines),
      ...route
    };
  }
  async function fulfilledScenario(value) {
    const route = activeConflictingNegativeEmitter();
    route.phases.markExact0004ConflictingNegativeAttempted();
    const observed = route.phases.observeExact0004ConflictingNegative(
      Promise.resolve(value)
    );
    let predicateCalled = false;
    await assert.rejects(
      assert.rejects(observed, () => {
        predicateCalled = true;
        return true;
      }),
      (error) => error?.code === "ERR_ASSERTION"
    );
    assert.equal(predicateCalled, false);
    assert.equal(await observed, value);
    return { facts: physicalFacts(route.lines), ...route };
  }

  const correctError = Object.assign(new Error("correct raw message"), {
    code: "23514"
  });
  const correct = await rejectedScenario(correctError);
  assert.equal(correct.assertionError, null);
  assert.equal(correct.facts.conflictingNegativeAttempted, true);
  assert.equal(correct.facts.conflictingNegativePromiseOutcome, "rejected");
  assert.equal(correct.facts.conflictingNegativeObservedSqlState, "23514");
  assert.equal(
    correct.facts.conflictingNegativeFulfilledResultClass,
    "not_observed"
  );
  assert.equal(correct.facts.conflictingNegativeAssertionMatched, true);
  assert.equal(
    correct.facts.conflictingNegativeRejectedBeforeAssertion,
    true
  );
  correct.phases.completeExact0004Subphase("conflicting_0004_negative");

  const differentError = Object.assign(new Error("different raw message"), {
    code: "42P01"
  });
  const different = await rejectedScenario(differentError);
  assert.equal(different.assertionError?.code, "ERR_ASSERTION");
  assert.equal(different.facts.conflictingNegativePromiseOutcome, "rejected");
  assert.equal(different.facts.conflictingNegativeObservedSqlState, "42P01");
  assert.equal(different.facts.conflictingNegativeAssertionMatched, false);
  assert.throws(
    () => different.phases.completeExact0004Subphase(
      "conflicting_0004_negative"
    ),
    /physical_phase_protocol_invalid/
  );

  const emptyFulfillment = await fulfilledScenario(undefined);
  assert.equal(
    emptyFulfillment.facts.conflictingNegativePromiseOutcome,
    "fulfilled"
  );
  assert.equal(
    emptyFulfillment.facts.conflictingNegativeFulfilledResultClass,
    "empty"
  );
  assert.equal(
    emptyFulfillment.facts.conflictingNegativeObservedSqlState,
    "not_observed"
  );
  assert.equal(
    emptyFulfillment.facts.conflictingNegativeAssertionMatched,
    null
  );
  assert.equal(
    emptyFulfillment.facts.conflictingNegativeRejectedBeforeAssertion,
    false
  );

  const rawSecretKey = ["se", "cret"].join("");
  const rawSecretValue = ["raw", "secret", "sentinel"].join("_");
  const rawAppliedResult = {
    appliedMigration: "0004_social_connector_persistence",
    query: "SELECT raw_sql_sentinel FROM private_table",
    parameters: ["raw_parameter_sentinel"],
    [rawSecretKey]: rawSecretValue,
    path: "C:\\private\\raw_result_sentinel.json"
  };
  const appliedFulfillment = await fulfilledScenario(rawAppliedResult);
  assert.equal(
    appliedFulfillment.facts.conflictingNegativeFulfilledResultClass,
    "applied_0004"
  );
  const arrayFulfillment = await fulfilledScenario([]);
  assert.equal(
    arrayFulfillment.facts.conflictingNegativeFulfilledResultClass,
    "other"
  );
  const getterResult = {};
  Object.defineProperty(getterResult, "appliedMigration", {
    enumerable: true,
    get() {
      throw new Error("raw_getter_message_sentinel");
    }
  });
  const unknownFulfillment = await fulfilledScenario(getterResult);
  assert.equal(
    unknownFulfillment.facts.conflictingNegativeFulfilledResultClass,
    "unknown"
  );

  const interrupted = activeConflictingNegativeEmitter();
  interrupted.phases.markExact0004ConflictingNegativeAttempted();
  const interruptedFacts = physicalFacts(interrupted.lines);
  assert.equal(
    interruptedFacts.conflictingNegativePromiseOutcome,
    "unknown"
  );
  assert.equal(
    interruptedFacts.conflictingNegativeObservedSqlState,
    "unknown"
  );
  assert.equal(
    interruptedFacts.conflictingNegativeFulfilledResultClass,
    "unknown"
  );
  assert.equal(interruptedFacts.conflictingNegativeAssertionMatched, null);
  assert.equal(
    interruptedFacts.conflictingNegativeRejectedBeforeAssertion,
    null
  );

  const noCodeError = new Error("raw_no_code_message_sentinel");
  noCodeError.stack =
    "Error: raw_no_code_message_sentinel\n" +
    "    at probe (C:\\private\\raw_stack_sentinel.js:991:7)";
  const noCode = await rejectedScenario(noCodeError);
  assert.equal(noCode.assertionError?.code, "ERR_ASSERTION");
  assert.equal(noCode.facts.conflictingNegativePromiseOutcome, "rejected");
  assert.equal(noCode.facts.conflictingNegativeObservedSqlState, "unknown");
  assert.equal(noCode.facts.conflictingNegativeAssertionMatched, false);

  const invalidCode = "12-xy";
  const invalidSqlState = await rejectedScenario(Object.assign(
    new Error("raw_invalid_sqlstate_message_sentinel"),
    { code: invalidCode }
  ));
  assert.equal(invalidSqlState.assertionError?.code, "ERR_ASSERTION");
  assert.equal(
    invalidSqlState.facts.conflictingNegativeObservedSqlState,
    "unknown"
  );
  assert.equal(
    JSON.stringify(invalidSqlState.lines).includes(invalidCode),
    false
  );

  const firstFailure = await runSyntheticReporterFailure({
    stdoutLines: [
      "TAP version 13",
      `# Subtest: ${realPostgresRunner.TAP_TITLE}`
    ],
    phaseLines: different.lines,
    stderrLines: ["AssertionError ERR_ASSERTION"]
  });
  assert.equal(firstFailure.facts.protocolValid, true);
  assert.equal(firstFailure.facts.failure, true);
  assert.equal(
    firstFailure.facts.conflictingNegativeObservedSqlState,
    "42P01"
  );
  assert.equal(
    firstFailure.facts.conflictingNegativeAssertionMatched,
    false
  );
  const laterFailure = JSON.parse(firstFailure.emitted.at(-1).slice(
    realPostgresRunner.SAFE_EVENT_PREFIX.length
  ));
  laterFailure.sequence += 1;
  laterFailure.conflictingNegativeObservedSqlState = "23514";
  laterFailure.conflictingNegativeAssertionMatched = true;
  const preservedFirstFailure = collectSafeRunnerLines([
    ...firstFailure.emitted,
    realPostgresRunner.safeEventLine(laterFailure)
  ]);
  assert.equal(preservedFirstFailure.protocolValid, false);
  assert.equal(
    preservedFirstFailure.conflictingNegativeObservedSqlState,
    "42P01"
  );
  assert.equal(
    preservedFirstFailure.conflictingNegativeAssertionMatched,
    false
  );

  const duplicateAttempt = activeConflictingNegativeEmitter();
  duplicateAttempt.phases.markExact0004ConflictingNegativeAttempted();
  assert.throws(
    () => duplicateAttempt.phases
      .markExact0004ConflictingNegativeAttempted(),
    /physical_phase_protocol_invalid/
  );
  const outOfOrderSettlement = activeConflictingNegativeEmitter();
  await assert.rejects(
    outOfOrderSettlement.phases.observeExact0004ConflictingNegative(
      Promise.resolve(null)
    ),
    /physical_phase_protocol_invalid/
  );
  const outOfOrderAssertion = activeConflictingNegativeEmitter();
  assert.throws(
    () => outOfOrderAssertion.phases
      .markExact0004ConflictingNegativeAssertionMatched(false),
    /physical_phase_protocol_invalid/
  );
  const duplicateSettlement = activeConflictingNegativeEmitter();
  duplicateSettlement.phases.markExact0004ConflictingNegativeAttempted();
  assert.equal(
    await duplicateSettlement.phases.observeExact0004ConflictingNegative(
      Promise.resolve(null)
    ),
    null
  );
  await assert.rejects(
    duplicateSettlement.phases.observeExact0004ConflictingNegative(
      Promise.resolve(null)
    ),
    /physical_phase_protocol_invalid/
  );

  const serialized = JSON.stringify({
    applied: appliedFulfillment.facts,
    appliedLines: appliedFulfillment.lines,
    invalid: invalidSqlState.facts,
    invalidLines: invalidSqlState.lines,
    noCode: noCode.facts,
    noCodeLines: noCode.lines,
    unknownFulfillment: unknownFulfillment.facts,
    unknownFulfillmentLines: unknownFulfillment.lines
  });
  for (const forbidden of [
    rawAppliedResult.query,
    rawAppliedResult.parameters[0],
    rawAppliedResult[rawSecretKey],
    rawAppliedResult.path,
    noCodeError.message,
    noCodeError.stack,
    "raw_getter_message_sentinel",
    "C:\\private",
    invalidCode
  ]) assert.equal(serialized.includes(forbidden), false, forbidden);
  for (const forbiddenKey of [
    "sql",
    "query",
    "parameters",
    "message",
    "detail",
    "hint",
    "where",
    "stack",
    "path",
    "url",
    "secret"
  ]) {
    assert.equal(
      Object.hasOwn(appliedFulfillment.facts, forbiddenKey),
      false,
      forbiddenKey
    );
  }
});

test("protocol group 1: impossible snapshots and incoherent failure boundaries fail closed", () => {
  const version = realPostgresRunner.EVIDENCE_SCHEMA_VERSION;
  const snapshot = (overrides = {}) => ({
    event: "physicalPhaseSnapshot",
    evidenceSchemaVersion: version,
    lastMainPhaseStarted: null,
    lastMainPhaseCompleted: null,
    physicalProfileBefore: "not_observed",
    cleanupStarted: false,
    cleanupCompleted: false,
    ...exact0004Evidence(),
    sequence: 1,
    ...overrides
  });
  const invalidSnapshots = [
    snapshot({
      lastMainPhaseStarted: "direct_connect_boundary",
      lastMainPhaseCompleted: "physical_target_preflight"
    }),
    snapshot({
      lastMainPhaseStarted: "role_provisioning",
      lastMainPhaseCompleted: "role_provisioning",
      cleanupStarted: true
    }),
    snapshot({
      lastMainPhaseStarted: "reauthentication",
      lastMainPhaseCompleted: "reauthentication",
      cleanupCompleted: true
    }),
    snapshot({
      lastMainPhaseStarted: "migration_0003_apply",
      lastMainPhaseCompleted: "migration_0003_apply",
      lastExact0004SubphaseStarted: "final_snapshot",
      lastExact0004SubphaseCompleted: "final_snapshot",
      planExactInvoked: true,
      planExactCompleted: true,
      applyExactInvoked: true,
      applyExactCompleted: true,
      databaseMutationAttempted: true
    }),
    snapshot({
      lastMainPhaseStarted: "post_migration_validation",
      lastMainPhaseCompleted: "post_migration_validation"
    }),
    snapshot({
      lastMainPhaseStarted: "post_migration_validation",
      lastMainPhaseCompleted: "exact_0004_plan_apply",
      lastExact0004SubphaseStarted: "plan_exact",
      lastExact0004SubphaseCompleted: "snapshot_before_plan",
      planExactInvoked: true
    })
  ];
  for (const event of invalidSnapshots) {
    assert.throws(
      () => realPostgresRunner.safeEventLine(event),
      /safe_event_invalid/
    );
  }

  const failure = (overrides = {}) => ({
    event: "failure",
    evidenceSchemaVersion: version,
    failureDuringCleanup: false,
    failurePhase: null,
    firstFailureStage: "runner_load",
    safeErrorCode: null,
    safeLineBucket: "unknown",
    safeModuleName: null,
    safePermissionOrigin: "unknown",
    safeSourceBasename: null,
    ...exact0004Evidence(),
    sequence: 1,
    stderrCategory: "unknown",
    ...overrides
  });
  assert.throws(() => realPostgresRunner.safeEventLine(failure({
    failurePhase: "physical_target_preflight"
  })), /safe_event_invalid/);
  assert.throws(() => realPostgresRunner.safeEventLine(failure({
    firstFailureStage: "test_execution",
    safeErrorCode: "42501",
    safePermissionOrigin: "postgres_sqlstate",
    stderrCategory: "permission_denied"
  })), /safe_event_invalid/);
  const contaminatedPrestart = collectSafeRunnerLines([
    realPostgresRunner.safeEventLine({
      event: "runnerReached",
      evidenceSchemaVersion: version,
      runnerReached: true,
      sequence: 1
    }),
    untrustedSafeEvent(failure({
      safeSqlState: "42501",
      safeErrorClass: "postgres_sqlstate",
      sequence: 2
    }))
  ]);
  assert.equal(contaminatedPrestart.protocolValid, false);
  assert.equal(contaminatedPrestart.failure, false);
  assert.equal(contaminatedPrestart.firstFailureStage, "safe_event_protocol");
  assert.equal(contaminatedPrestart.safeSqlState, "not_observed");
  assert.equal(contaminatedPrestart.safeErrorClass, "unknown");

  const lifecycle = [
    realPostgresRunner.safeEventLine({
      event: "runnerReached",
      evidenceSchemaVersion: version,
      runnerReached: true,
      sequence: 1
    }),
    realPostgresRunner.safeEventLine({
      event: "gateValidated",
      evidenceSchemaVersion: version,
      gateValidated: true,
      sequence: 2
    }),
    realPostgresRunner.safeEventLine({
      event: "nodeTestSpawnAttempted",
      evidenceSchemaVersion: version,
      nodeTestSpawnAttempted: true,
      sequence: 3
    }),
    realPostgresRunner.safeEventLine({
      event: "nodeTestProcessCreated",
      evidenceSchemaVersion: version,
      nodeTestProcessCreated: true,
      sequence: 4
    }),
    realPostgresRunner.safeEventLine({
      event: "testFileLoaded",
      evidenceSchemaVersion: version,
      testFileLoaded: true,
      sequence: 5
    }),
    realPostgresRunner.safeEventLine({
      event: "tapStarted",
      evidenceSchemaVersion: version,
      tapStarted: true,
      sequence: 6
    }),
    realPostgresRunner.safeEventLine({
      event: "firstTestDiscovered",
      evidenceSchemaVersion: version,
      firstTestDiscovered: true,
      sequence: 7
    }),
    realPostgresRunner.safeEventLine({
      event: "nodeTestExit",
      evidenceSchemaVersion: version,
      nodeTestExitCode: 1,
      nodeTestSignal: null,
      nodeTestTimedOut: false,
      sequence: 8
    }),
    realPostgresRunner.safeEventLine({
      event: "nodeTestClose",
      evidenceSchemaVersion: version,
      nodeTestCloseCode: 1,
      nodeTestCloseSignal: null,
      sequence: 9
    }),
    realPostgresRunner.safeEventLine(snapshot({
      lastMainPhaseStarted: "physical_target_preflight",
      sequence: 10
    }))
  ];
  for (const firstFailureStage of [
    "safe_event_protocol",
    "test_execution"
  ]) {
    const facts = collectSafeRunnerLines([
      ...lifecycle,
      realPostgresRunner.safeEventLine(failure({
        failurePhase: "role_provisioning",
        firstFailureStage,
        safeErrorCode: firstFailureStage === "safe_event_protocol"
          ? "safe_event_protocol_invalid"
          : "ERR_TEST_FAILURE",
        sequence: 11,
        stderrCategory: firstFailureStage === "safe_event_protocol"
          ? "unknown"
          : "tap_failure"
      }))
    ]);
    assert.equal(facts.protocolValid, false);
    assert.equal(facts.failure, false);
    assert.equal(facts.firstFailureStage, "safe_event_protocol");
    assert.equal(facts.failureDuringCleanup, false);
    assert.equal(facts.failurePhase, "physical_target_preflight");
  }
});

test("protocol group 1: outer failure preserves the first functional boundary and distinguishes cleanup", async () => {
  const functionalLines = [];
  const functionalPhases = realPostgresRunner.createPhysicalPhaseEmitter(
    (line) => functionalLines.push(line)
  );
  functionalPhases.startMain("physical_target_preflight");
  functionalPhases.startCleanup();
  functionalPhases.completeCleanup();
  const functional = await runSyntheticReporterFailure({
    stdoutLines: [
      "TAP version 13",
      `# Subtest: ${realPostgresRunner.TAP_TITLE}`
    ],
    phaseLines: functionalLines,
    stderrLines: ["permission denied", "code: '42501'"]
  });
  assert.equal(functional.facts.protocolValid, true);
  assert.equal(functional.facts.eventCount, 12);
  assert.equal(functional.facts.failureDuringCleanup, false);
  assert.equal(functional.facts.failurePhase, "physical_target_preflight");
  assert.equal(functional.facts.lastMainPhaseCompleted, null);
  assert.equal(functional.facts.cleanupStarted, true);
  assert.equal(functional.facts.cleanupCompleted, true);
  assert.equal(functional.facts.safeErrorCode, "42501");
  assert.equal(
    functional.facts.safePermissionOrigin,
    "postgres_sqlstate"
  );

  const cleanupLines = [];
  const cleanupPhases = realPostgresRunner.createPhysicalPhaseEmitter(
    (line) => cleanupLines.push(line)
  );
  for (const phase of realPostgresRunner.PHYSICAL_MAIN_PHASES) {
    cleanupPhases.startMain(phase);
    if (phase === "exact_0004_plan_apply") {
      await completeExact0004Subphases(cleanupPhases);
    }
    cleanupPhases.completeMain(phase);
  }
  cleanupPhases.startCleanup();
  const cleanup = await runSyntheticReporterFailure({
    stdoutLines: [
      "TAP version 13",
      `# Subtest: ${realPostgresRunner.TAP_TITLE}`
    ],
    phaseLines: cleanupLines,
    stderrLines: ["EPERM permission denied", "syscall: 'spawn'"]
  });
  assert.equal(cleanup.facts.protocolValid, true);
  assert.equal(cleanup.facts.failureDuringCleanup, true);
  assert.equal(cleanup.facts.failurePhase, "final_cleanup");
  assert.equal(cleanup.facts.safeErrorCode, "EPERM");
  assert.equal(cleanup.facts.safePermissionOrigin, "os_process");
  assert.deepEqual(
    Object.fromEntries(realPostgresRunner.EXACT_0004_EVIDENCE_FIELDS.map(
      (field) => [field, cleanup.facts[field]]
    )),
    exact0004Evidence({
      lastExact0004SubphaseStarted: "final_snapshot",
      lastExact0004SubphaseCompleted: "final_snapshot",
      planExactInvoked: true,
      planExactCompleted: true,
      applyExactInvoked: true,
      applyExactCompleted: true,
      databaseMutationAttempted: true,
      conflictingNegativeAttempted: true,
      conflictingNegativePromiseOutcome: "rejected",
      conflictingNegativeObservedSqlState: "23514",
      conflictingNegativeFulfilledResultClass: "not_observed",
      conflictingNegativeAssertionMatched: true,
      conflictingNegativeRejectedBeforeAssertion: true
    })
  );
});

test("classifier group 2: permission diagnostics aggregate a later SQLSTATE across channels without raw output", () => {
  const raw = "permission denied raw-sensitive-sentinel";
  const facts = observeNodeLines([
    { channel: "stdout", line: raw + "\n" },
    { channel: "stderr", line: "code: 'ERR_TEST_FAILURE'\n" },
    { channel: "stderr", line: "code: '42501'\n" },
    {
      channel: "stderr",
      line: "    at probe (/home/runner/private/tests/" +
        "social-postgres-real.test.js:3827:19)\n"
    }
  ]);
  assert.equal(facts.stderrCategory, "permission_denied");
  assert.equal(facts.safeErrorCode, "42501");
  assert.equal(facts.safePermissionOrigin, "postgres_sqlstate");
  assert.equal(facts.safeSourceBasename, "social-postgres-real.test.js");
  assert.equal(facts.safeLineBucket, "3500-3999");
  const serialized = JSON.stringify(facts);
  assert.equal(serialized.includes(raw), false);
  assert.equal(serialized.includes("/home/runner/private"), false);
  assert.equal(serialized.includes("3827"), false);
  const sqlstateFirst = observeNodeLines([
    { channel: "stderr", line: "42501\n" },
    { channel: "stdout", line: "permission denied\n" }
  ]);
  assert.equal(sqlstateFirst.stderrCategory, "permission_denied");
  assert.equal(sqlstateFirst.safeErrorCode, "42501");
  assert.equal(sqlstateFirst.safePermissionOrigin, "postgres_sqlstate");
});

test("classifier group 2: permission diagnostics authenticate OS origins and fail closed on conflicting codes", () => {
  const filesystem = observeNodeLines([
    { channel: "stderr", line: "EACCES permission denied\n" },
    { channel: "stdout", line: "syscall: 'open'\n" }
  ]);
  assert.equal(filesystem.safeErrorCode, "EACCES");
  assert.equal(filesystem.safePermissionOrigin, "os_filesystem");
  const processFacts = observeNodeLines([
    { channel: "stdout", line: "EPERM permission denied\n" },
    { channel: "stderr", line: "syscall: 'spawn'\n" }
  ]);
  assert.equal(processFacts.safeErrorCode, "EPERM");
  assert.equal(processFacts.safePermissionOrigin, "os_process");
  const unknown = observeNodeLines([
    { channel: "stderr", line: "EACCES permission denied\n" }
  ]);
  assert.equal(unknown.safePermissionOrigin, "unknown");
  const conflict = observeNodeLines([
    { channel: "stdout", line: "permission denied\n" },
    { channel: "stderr", line: "code: '42501'\n" },
    { channel: "stdout", line: "EACCES permission denied\n" }
  ]);
  assert.equal(conflict.stderrCategory, "permission_denied");
  assert.equal(conflict.safeDiagnosticValid, false);
  assert.equal(conflict.safeErrorCode, null);
  assert.equal(conflict.safePermissionOrigin, "unknown");
});

test("classifier group 2: same-line permission conflicts propagate through collectors and errors", async () => {
  const sameLine = "permission denied 42501 EACCES\n";
  const diagnostic = observeNodeLines([
    { channel: "stderr", line: sameLine }
  ]);
  assert.equal(diagnostic.stderrCategory, "permission_denied");
  assert.equal(diagnostic.safeDiagnosticValid, false);
  assert.equal(diagnostic.safeErrorCode, null);
  assert.equal(diagnostic.safePermissionOrigin, "unknown");

  const version = realPostgresRunner.EVIDENCE_SCHEMA_VERSION;
  const runner = realPostgresRunner.safeEventLine({
    event: "runnerReached",
    evidenceSchemaVersion: version,
    runnerReached: true,
    sequence: 1
  });
  const rawCollector = realPostgresRunner.createSafeEventCollector();
  rawCollector.push("stdout", Buffer.from(runner));
  rawCollector.push("stderr", Buffer.from(sameLine));
  const rawFacts = rawCollector.finish();
  assert.equal(rawFacts.protocolValid, false);
  assert.equal(rawFacts.firstFailureStage, "safe_event_protocol");
  assert.equal(rawFacts.safeErrorCode, "safe_event_protocol_invalid");

  const firstFailure = realPostgresRunner.safeEventLine({
    event: "failure",
    evidenceSchemaVersion: version,
    failureDuringCleanup: false,
    failurePhase: null,
    firstFailureStage: "environment_gate",
    safeErrorCode: "guard_failed",
    safeLineBucket: "unknown",
    safeModuleName: null,
    safePermissionOrigin: "unknown",
    safeSourceBasename: null,
    ...exact0004Evidence(),
    sequence: 2,
    stderrCategory: "environment_contract"
  });
  const preservedCollector = realPostgresRunner.createSafeEventCollector();
  preservedCollector.push("stdout", Buffer.from(runner + firstFailure));
  preservedCollector.push("stderr", Buffer.from(sameLine));
  const preserved = preservedCollector.finish();
  assert.equal(preserved.protocolValid, false);
  assert.equal(preserved.firstFailureStage, "environment_gate");
  assert.equal(preserved.stderrCategory, "environment_contract");
  assert.equal(preserved.safeErrorCode, "guard_failed");

  const emitted = [];
  const conflictingError = Object.assign(
    new Error("permission denied 42501"),
    { code: "EACCES", syscall: "open" }
  );
  const exitCode = await realPostgresRunner.main({}, {
    runNodeTestImpl: async ({ onCreated, onExit, onClose }) => {
      onCreated();
      onExit(1, null, false);
      onClose(1, null);
      return {
        created: true,
        error: conflictingError,
        exitObserved: true,
        closeObserved: true,
        closeStatus: 1,
        closeSignal: null,
        facts: {
          lastMainPhaseStarted: "role_provisioning",
          lastMainPhaseCompleted: "physical_target_preflight",
          cleanupStarted: true,
          cleanupCompleted: true,
          physicalProfileBefore: "not_observed"
        },
        signal: null,
        status: 1
      };
    },
    validateGateEnvironmentImpl: () => ({ fingerprint: "e".repeat(64) }),
    writeLine: (line) => emitted.push(line)
  });
  const errorFacts = collectSafeRunnerLines(emitted);
  assert.equal(exitCode, 1);
  assert.equal(errorFacts.protocolValid, true);
  assert.equal(errorFacts.failure, true);
  assert.equal(errorFacts.eventCount, 8);
  assert.equal(errorFacts.firstFailureStage, "safe_event_protocol");
  assert.equal(errorFacts.failureDuringCleanup, false);
  assert.equal(errorFacts.failurePhase, "role_provisioning");
  assert.equal(errorFacts.stderrCategory, "unknown");
  assert.equal(errorFacts.safeErrorCode, "safe_event_protocol_invalid");
});

test("classifier group 2: first diagnostic category is immutable", () => {
  const immutable = observeNodeLines([
    { channel: "stderr", line: "ReferenceError: first-category\n" },
    { channel: "stdout", line: "42501\n" },
    { channel: "stderr", line: "permission denied\n" }
  ]);
  assert.equal(immutable.stderrCategory, "reference_error");
  assert.equal(immutable.safeErrorCode, null);
  assert.equal(immutable.safePermissionOrigin, "unknown");
});

test("safe source group 3: sources stay allowlisted and bucketed", () => {
  const rawPath = "/home/runner/private/tests/social-postgres-real.test.js";
  const acceptedSource = observeNodeLines([
    { channel: "stderr", line: "permission denied\n" },
    { channel: "stderr", line: "code: '42501'\n" },
    {
      channel: "stderr",
      line: `    at probe (${rawPath}:3827:19)\n`
    }
  ]);
  assert.equal(acceptedSource.safeSourceBasename, "social-postgres-real.test.js");
  assert.equal(acceptedSource.safeLineBucket, "3500-3999");
  const serializedAccepted = JSON.stringify(acceptedSource);
  assert.equal(serializedAccepted.includes(rawPath), false);
  assert.equal(serializedAccepted.includes("3827"), false);
  assert.equal(serializedAccepted.includes("at probe"), false);

  const refusedSource = observeNodeLines([
    { channel: "stderr", line: "permission denied\n" },
    { channel: "stderr", line: "code: '42501'\n" },
    {
      channel: "stderr",
      line: "    at probe (/private/outside-secret.js:731:2)\n"
    }
  ]);
  assert.equal(refusedSource.safeSourceBasename, null);
  assert.equal(refusedSource.safeLineBucket, "unknown");
  assert.deepEqual([
    realPostgresRunner.safeLineBucket(1),
    realPostgresRunner.safeLineBucket(499),
    realPostgresRunner.safeLineBucket(500),
    realPostgresRunner.safeLineBucket(4499),
    realPostgresRunner.safeLineBucket(4500)
  ], ["1-499", "1-499", "500-999", "4000-4499", "unknown"]);
});

test("protocol group 1: safe event collector refuses duplicates, JSON, fields, enums, modules and order", () => {
  const version = realPostgresRunner.EVIDENCE_SCHEMA_VERSION;
  const runner = realPostgresRunner.safeEventLine({
    event: "runnerReached",
    evidenceSchemaVersion: version,
    runnerReached: true,
    sequence: 1
  });
  const invalidCases = [
    [runner, runner.replace('"sequence":1', '"sequence":2')],
    [realPostgresRunner.SAFE_EVENT_PREFIX + "{invalid}\n"],
    [untrustedSafeEvent({
      event: "runnerReached",
      evidenceSchemaVersion: version,
      extra: true,
      runnerReached: true,
      sequence: 1
    })],
    [runner, untrustedSafeEvent({
      event: "failure",
      evidenceSchemaVersion: version,
      firstFailureStage: "environment_gate",
      safeErrorCode: "guard_failed",
      safeModuleName: null,
      sequence: 2,
      stderrCategory: "outside_enum"
    })],
    [runner, untrustedSafeEvent({
      event: "failure",
      evidenceSchemaVersion: version,
      firstFailureStage: "environment_gate",
      safeErrorCode: "guard_failed",
      safeModuleName: "outside.js",
      sequence: 2,
      stderrCategory: "module_not_found"
    })],
    [runner, realPostgresRunner.safeEventLine({
      event: "nodeTestSpawnAttempted",
      evidenceSchemaVersion: version,
      nodeTestSpawnAttempted: true,
      sequence: 2
    })],
    [
      runner,
      realPostgresRunner.safeEventLine({
        event: "gateValidated",
        evidenceSchemaVersion: version,
        gateValidated: true,
        sequence: 2
      }),
      realPostgresRunner.safeEventLine({
        event: "nodeTestSpawnAttempted",
        evidenceSchemaVersion: version,
        nodeTestSpawnAttempted: true,
        sequence: 3
      }),
      realPostgresRunner.safeEventLine({
        event: "nodeTestProcessCreated",
        evidenceSchemaVersion: version,
        nodeTestProcessCreated: true,
        sequence: 4
      }),
      realPostgresRunner.safeEventLine({
        event: "firstTestDiscovered",
        evidenceSchemaVersion: version,
        firstTestDiscovered: true,
        sequence: 5
      })
    ],
    [
      runner,
      untrustedSafeEvent({
        event: "failure",
        evidenceSchemaVersion: version,
        firstFailureStage: "postgres_start",
        safeErrorCode: null,
        safeModuleName: null,
        sequence: 2,
        stderrCategory: "unknown"
      })
    ],
    [
      runner,
      realPostgresRunner.safeEventLine({
        event: "gateValidated",
        evidenceSchemaVersion: version,
        gateValidated: true,
        sequence: 2
      }),
      realPostgresRunner.safeEventLine({
        event: "nodeTestSpawnAttempted",
        evidenceSchemaVersion: version,
        nodeTestSpawnAttempted: true,
        sequence: 3
      }),
      realPostgresRunner.safeEventLine({
        event: "nodeTestProcessCreated",
        evidenceSchemaVersion: version,
        nodeTestProcessCreated: true,
        sequence: 4
      }),
      untrustedSafeEvent({
        event: "nodeTestExit",
        evidenceSchemaVersion: version,
        nodeTestExitCode: -1,
        nodeTestSignal: "SIGTERM",
        nodeTestTimedOut: false,
        sequence: 5
      })
    ]
  ];
  for (const lines of invalidCases) {
    const facts = collectSafeRunnerLines(lines);
    assert.equal(facts.protocolValid, false);
    assert.equal(facts.firstFailureStage, "safe_event_protocol");
    assert.equal(facts.safeModuleName, null);
  }
  const stderrFacts = collectSafeRunnerLines([runner], "stderr");
  assert.equal(stderrFacts.protocolValid, false);
  assert.equal(stderrFacts.firstFailureStage, "safe_event_protocol");
  const firstFailure = realPostgresRunner.safeEventLine({
    event: "failure",
    evidenceSchemaVersion: version,
    failureDuringCleanup: false,
    failurePhase: null,
    firstFailureStage: "environment_gate",
    safeErrorCode: "guard_failed",
    safeLineBucket: "unknown",
    safeModuleName: null,
    safePermissionOrigin: "unknown",
    safeSourceBasename: null,
    ...exact0004Evidence(),
    sequence: 2,
    stderrCategory: "environment_contract"
  });
  const preserved = collectSafeRunnerLines([
    runner,
    firstFailure,
    runner.replace('"sequence":1', '"sequence":3')
  ]);
  assert.equal(preserved.protocolValid, false);
  assert.equal(preserved.firstFailureStage, "environment_gate");
  assert.equal(preserved.stderrCategory, "environment_contract");
  assert.equal(preserved.safeErrorCode, "guard_failed");
});

test("classifier group 2: safe stderr classifier uses only closed categories, codes and module basenames", () => {
  const cases = [
    ["npm ERR! Missing script: \"test:postgres-real\"", "npm_script_missing"],
    ["SyntaxError: synthetic", "syntax_error"],
    ["ReferenceError: synthetic", "reference_error"],
    ["TypeError: synthetic", "type_error"],
    ["EACCES permission denied", "permission_denied"],
    ["ECONNREFUSED connection refused", "connection_refused"],
    ["ERR_TLS_CERT_ALTNAME_INVALID", "tls_hostname"],
    ["28P01 password authentication failed", "postgres_authentication"],
    ["42P01 relation does not exist", "postgres_schema"],
    ["unrecognized diagnostic", "unknown"]
  ];
  for (const [line, category] of cases) {
    assert.equal(
      realPostgresRunner.classifySafeLine(line).stderrCategory,
      category,
      line
    );
  }
  const allowed = realPostgresRunner.classifySafeLine(
    "Error: Cannot find module 'pg' MODULE_NOT_FOUND"
  );
  assert.equal(allowed.safeModuleName, "pg");
  const refused = realPostgresRunner.classifySafeLine(
    "Error: Cannot find module '../../outside.js' MODULE_NOT_FOUND"
  );
  assert.equal(refused.safeModuleName, null);
});

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function clonePendingCredentialRow(row, overrides = {}) {
  return {
    ...row,
    ciphertext: Buffer.from(row.ciphertext),
    nonce: Buffer.from(row.nonce),
    auth_tag: Buffer.from(row.auth_tag),
    ...overrides
  };
}

function assertPendingCredentialBuffersCleared(rows) {
  for (const row of rows || []) {
    for (const field of ["ciphertext", "nonce", "auth_tag"]) {
      if (!Buffer.isBuffer(row?.[field])) continue;
      assert.equal(row[field].every((byte) => byte === 0), true, field);
    }
  }
}

function createPendingCredentialFixture({ encryptionContext = {} } = {}) {
  const keyMaterial = crypto.randomBytes(32);
  const keyVersion = deriveVaultKeyVersion(1, keyMaterial);
  const keyringMaterial = Buffer.from(keyMaterial);
  const keyring = {
    activeVersion: keyVersion,
    keys: new Map([[keyVersion, keyringMaterial]])
  };
  const rawVault = createSocialVault({
    keyring,
    expectedKeyringFingerprint: vaultKeyringFingerprint(keyVersion, [keyVersion])
  });
  keyringMaterial.fill(0);
  keyring.keys.clear();
  keyMaterial.fill(0);

  const syntheticMaterial = crypto.randomBytes(32);
  const marker = Buffer.from(syntheticMaterial.toString("base64url"), "utf8");
  const expected = {
    companyId: O12_COMPANY_ID,
    credentialId: O12_CREDENTIAL_ID,
    connectionId: O12_CONNECTION_ID,
    provider: "instagram",
    credentialType: O12_CREDENTIAL_TYPE
  };
  const context = {
    companyId: expected.companyId,
    provider: expected.provider,
    credentialId: expected.credentialId,
    credentialType: expected.credentialType,
    subjectType: "connection",
    subjectId: expected.connectionId,
    ...encryptionContext
  };
  const envelope = rawVault.encrypt(marker, context);
  const expectedDigest = sha256(marker);
  marker.fill(0);
  const row = {
    company_id: expected.companyId,
    id: expected.credentialId,
    provider: expected.provider,
    connection_id: expected.connectionId,
    oauth_transaction_id: null,
    credential_type: expected.credentialType,
    ciphertext: envelope.ciphertext,
    nonce: envelope.nonce,
    auth_tag: envelope.authTag,
    key_version: envelope.keyVersion,
    aad_version: envelope.aadVersion,
    expires_at: null,
    revoked_at: null
  };
  const decryptedPlaintexts = [];
  let vaultDecryptCalls = 0;
  const vault = Object.freeze({
    ...rawVault,
    decrypt(...args) {
      vaultDecryptCalls += 1;
      const plaintext = rawVault.decrypt(...args);
      decryptedPlaintexts.push(plaintext);
      return plaintext;
    }
  });
  let operationalReads = 0;
  let operationalCallbackCalls = 0;
  const credentials = Object.freeze({
    async withDecryptedCredential(_identity, _operation) {
      operationalReads += 1;
      const error = new Error("pending credential unavailable");
      error.code = "credential_not_found";
      throw error;
    }
  });
  const evidenceCounts = { ...gate.zeroCounts() };
  const options = (overrides = {}) => ({
    result: { rows: [row] },
    expected,
    syntheticMaterial,
    expectedDigest,
    credentials,
    vault,
    contextFromRow,
    envelopeFromRow,
    operationCounts: () => ({
      vaultEncryptCalls: 1,
      vaultDecryptCalls,
      credentialStoreCalls: 1
    }),
    evidenceCounts,
    readBoundary: async () => {
      assert.equal(decryptedPlaintexts.length, 1);
      assert.equal(decryptedPlaintexts[0].every((byte) => byte === 0), true);
      return {
        status: "authorization_pending",
        externalAccounts: 0
      };
    },
    ...overrides
  });
  return {
    credentials,
    decryptedPlaintexts,
    evidenceCounts,
    expected,
    expectedDigest,
    options,
    rawVault,
    row,
    syntheticMaterial,
    get operationalCallbackCalls() { return operationalCallbackCalls; },
    get operationalReads() { return operationalReads; },
    get vaultDecryptCalls() { return vaultDecryptCalls; },
    recordOperationalCallback() { operationalCallbackCalls += 1; },
    destroy() {
      rawVault.destroy();
      syntheticMaterial.fill(0);
      for (const plaintext of decryptedPlaintexts) plaintext.fill(0);
      for (const field of ["ciphertext", "nonce", "auth_tag"]) {
        if (Buffer.isBuffer(row[field])) row[field].fill(0);
      }
    }
  };
}

function environment(overrides = {}) {
  return Object.freeze({
    RUNNER_TEMP: overrides.RUNNER_TEMP,
    GITHUB_RUN_ID: overrides.GITHUB_RUN_ID || "73190",
    SOCIAL_3B0_BRANCH: gate.BRANCH,
    SOCIAL_3B0_SHA: SHA,
    SOCIAL_3B0_RUN_ATTEMPT: "1",
    SOCIAL_3B0_WINDOWS_STATUS: "passed",
    SOCIAL_3B0_PRE_GATE_STATUS: "passed",
    SOCIAL_3B0_POSTGRES_IMAGE: gate.IMAGE,
    POSTGRES_CONNECTIVITY_MODE: "internal_bridge_direct_v1",
    POSTGRES_BACKUP_CONNECTIVITY_MODE:
      "logical_dns_to_internal_container_v1",
    SOCIAL_3A0P_POSTGRES_IMAGE: gate.IMAGE,
    SOCIAL_INSTAGRAM_ENABLED: "false",
    SOCIAL_EXTERNAL_CONNECTION_ENABLED: "false",
    SOCIAL_EXTERNAL_PUBLICATION_ENABLED: "false"
  });
}

function passedEvidence() {
  const evidence = gate.baseEvidence({
    branch: gate.BRANCH,
    sha: SHA,
    runAttempt: 1
  });
  evidence.gates1To5 = Object.freeze(gate.GATE_DEFINITIONS.map((entry) =>
    Object.freeze({ ...entry, status: "passed" })
  ));
  evidence.substeps = Object.freeze(gate.SUBSTEP_IDS.map((id) =>
    Object.freeze({ id, status: "passed" })
  ));
  evidence.counts = gate.EXPECTED_COUNTS;
  evidence.secretScan = Object.freeze({
    status: "passed",
    historicPhysicalPassed: true,
    oauthEvidencePassed: true
  });
  evidence.cleanup = Object.freeze({
    cleanupCompleted: true,
    intermediateEvidenceRemoved: true,
    syntheticMaterialsCleared: true
  });
  evidence.residuals = gate.zeroResiduals();
  evidence.status = "passed";
  return evidence;
}

function cleanupSnapshot(tracker, overrides = {}) {
  return tracker.snapshot({
    postgresCleanupCompleted: true,
    firstAttemptSyntheticMaterialsCleared: true,
    firstAttemptResiduals: gate.zeroResiduals(),
    ...overrides
  });
}

function cleanupProvenance(overrides = {}) {
  return Object.freeze({
    operation: "http_server_close",
    causalCode: "social_3b0_cleanup_operation_failed",
    cleanupErrorCount: 1,
    postgresCleanupCompleted: true,
    firstAttemptSyntheticMaterialsCleared: true,
    firstAttemptResiduals: gate.zeroResiduals(),
    ...overrides
  });
}

function failedO22Evidence(overrides = {}) {
  const evidence = passedEvidence();
  const provenance = overrides.cleanupFailureProvenance || cleanupProvenance();
  evidence.status = "failed";
  evidence.firstFailure = gate.closedFirstFailure({
    phase: gate.PHASE,
    substep: "O22",
    lastCompletedSubstep: "O21",
    causalCode: provenance.causalCode
  });
  evidence.cleanupFailureProvenance = provenance;
  evidence.substeps = Object.freeze(evidence.substeps.map((entry) =>
    Object.freeze(entry.id === "O22" ? { ...entry, status: "failed" } : entry)
  ));
  if (overrides.cleanup) evidence.cleanup = Object.freeze(overrides.cleanup);
  if (overrides.residuals) evidence.residuals = Object.freeze(overrides.residuals);
  return evidence;
}

async function supervisedEvidenceFixture({
  workerEvidence,
  exitCode = 1,
  cleanupResult = zeroCleanup(),
  runId = "73200"
}) {
  const runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), "social-3b0-provenance-"));
  const directory = path.join(runnerTemp, gate.ARTIFACT_DIRECTORY);
  const outputPath = path.join(directory, gate.EVIDENCE_FILE);
  const processStatusPath = path.join(directory, gate.PROCESS_STATUS_FILE);
  const spawnImpl = (_executable, _args, options) => {
    const child = new EventEmitter();
    child.kill = () => true;
    queueMicrotask(() => {
      try {
        if (workerEvidence !== undefined) {
          gate.writePayload(
            path.join(options.env.RUNNER_TEMP, gate.ARTIFACT_DIRECTORY,
              gate.EVIDENCE_FILE),
            path.join(options.env.RUNNER_TEMP, gate.ARTIFACT_DIRECTORY,
              gate.EVIDENCE_HASH_FILE),
            workerEvidence
          );
        }
        child.emit("spawn");
        child.emit("close", exitCode, null);
      } catch (error) {
        child.emit("error", error);
      }
    });
    return child;
  };
  try {
    const result = await gate.superviseInstagramOAuthPhysicalGate({
      runnerTemp,
      outputPath,
      processStatusPath,
      repositoryRoot: path.join(__dirname, ".."),
      environment: environment({ RUNNER_TEMP: runnerTemp, GITHUB_RUN_ID: runId }),
      spawnImpl,
      cleanupImpl: async () => cleanupResult,
      timeoutMs: 1000
    });
    const serialized = fs.readFileSync(outputPath, "utf8");
    return Object.freeze({ result, evidence: JSON.parse(serialized), serialized });
  } finally {
    fs.rmSync(runnerTemp, { recursive: true, force: true });
  }
}

function zeroCleanup() {
  return Object.freeze({
    cleanupCompleted: true,
    artifactDirectoryRemoved: true,
    intermediateEvidenceRemoved: true,
    residuals: gate.zeroResiduals()
  });
}

function fakeChild({ exitCode = 1, emitSpawn = true } = {}) {
  return function spawnImpl() {
    const child = new EventEmitter();
    child.kill = () => true;
    queueMicrotask(() => {
      if (emitSpawn) child.emit("spawn");
      child.emit(emitSpawn ? "close" : "error", emitSpawn ? exitCode : null, null);
    });
    return child;
  };
}

function controlledHttpTransport({ destroyEmitsClose = true } = {}) {
  const request = new EventEmitter();
  let responseCallback;
  let endCallback;
  let payload = null;
  let endCalls = 0;
  const requestImpl = (options, onResponse) => {
    responseCallback = onResponse;
    request.options = options;
    request.end = (candidate, encoding, callback) => {
      endCalls += 1;
      if (Buffer.isBuffer(candidate)) payload = candidate;
      endCallback = typeof callback === "function"
        ? callback
        : typeof encoding === "function"
          ? encoding
          : typeof candidate === "function"
            ? candidate
            : null;
      return request;
    };
    return request;
  };
  const startResponse = (statusCode = 200) => {
    const response = new EventEmitter();
    response.statusCode = statusCode;
    response.destroyCalls = 0;
    response.resumeCalls = 0;
    response.resume = () => {
      response.resumeCalls += 1;
      return response;
    };
    response.destroy = () => {
      response.destroyCalls += 1;
      if (destroyEmitsClose) response.emit("close");
    };
    responseCallback(response);
    return response;
  };
  const respond = (serialized, statusCode = 200) => {
    const response = startResponse(statusCode);
    if (serialized !== null) response.emit("data", Buffer.from(serialized));
    response.emit("end");
    response.emit("close");
    return response;
  };
  return {
    request,
    requestImpl,
    respond,
    startResponse,
    get endCallback() { return endCallback; },
    get endCalls() { return endCalls; },
    get payload() { return payload; }
  };
}

async function closeLoopbackServer(server, sockets) {
  const socketClosures = [...sockets].map((socket) => new Promise((resolve) => {
    socket.once("close", resolve);
  }));
  for (const socket of sockets) socket.destroy();
  if (typeof server.closeAllConnections === "function") {
    server.closeAllConnections();
  }
  const serverClosure = new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  await Promise.all([serverClosure, ...socketClosures]);
}

function controlledSocketBarrier({
  includeIdle = true,
  includeAll = true,
  serverError = null,
  serverCallbackSynchronous = false,
  idleError = null,
  allError = null
} = {}) {
  const server = new EventEmitter();
  const sockets = [new EventEmitter(), new EventEmitter()];
  const calls = [];
  let serverCallback = null;
  gate.trackServerSockets(server);
  for (const socket of sockets) server.emit("connection", socket);
  server.close = (callback) => {
    calls.push("server.close");
    serverCallback = callback;
    if (serverCallbackSynchronous) callback(serverError);
  };
  if (includeIdle) {
    server.closeIdleConnections = () => {
      calls.push("server.closeIdleConnections");
      if (idleError) throw idleError;
    };
  }
  if (includeAll) {
    server.closeAllConnections = () => {
      calls.push("server.closeAllConnections");
      if (allError) throw allError;
    };
  }
  return {
    calls,
    server,
    sockets,
    emitServerClose(error = serverError) {
      assert.equal(typeof serverCallback, "function");
      serverCallback(error);
    },
    emitSocketClose(index) {
      sockets[index].emit("close");
    }
  };
}

function observePromise(promise) {
  const observation = { status: "pending", reason: null };
  promise.then(
    () => { observation.status = "fulfilled"; },
    (error) => {
      observation.status = "rejected";
      observation.reason = error;
    }
  );
  return observation;
}

async function flushBarrierMicrotasks() {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

test("Social 3B physical gate freezes the Exact7 loopback socket close route", () => {
  assert.equal(
    gate.BRANCH,
    "social/checkpoint-3b0-o22-loopback-socket-close-barrier-20260813"
  );
  assert.equal(
    gate.COMMIT_MESSAGE,
    "[run-social-3b0] await loopback socket close barrier"
  );
  assert.equal(
    gate.PARENT_COMMIT,
    "84061704e214ec5f293fa5f2c9443d9832d42e1e"
  );
  assert.deepEqual(gate.HISTORIC_COMMIT_CHAIN, [
    {
      level: "functional_parent",
      sha: "3dc3d8be62438216509f061f6c1a26ee39c9b5dc"
    },
    {
      level: "functional",
      sha: "33e3ea7abcea7f5dc51780c3a1efd4743352fe40"
    },
    {
      level: "prior_infrastructure",
      sha: "7bff67ac0c1acdd37473889a3f8b5c2017b30c9c"
    },
    {
      level: "previous_correction",
      sha: "27cd350a253ab3ff07a915570eb41f291bbd1b42"
    },
    {
      level: "o05",
      sha: "ad3c162aaee04bb66d79ea3c35c3d75297e8d0ab"
    },
    {
      level: "o12",
      sha: "1febe1211b0021d8c35cdfb840f581fd76ce39e7"
    },
    {
      level: "o22",
      sha: "1eae6c50003c523ad80a473a5554eb9f84770389"
    },
    {
      level: "windows_native_process_serialization",
      sha: gate.PARENT_COMMIT
    }
  ]);
  assert.equal(
    gate.HISTORIC_COMMIT_CHAIN.at(-1).sha,
    gate.PARENT_COMMIT
  );
  assert.deepEqual(gate.CORRECTION_FILES, [
    ".github/workflows/social-3b0-instagram-oauth-local-contract.yml",
    "scripts/social-3a0p-local-scope.js",
    "scripts/social-3b0-linux-physical-gate.js",
    "tests/social-3a0p-current-diff-scope.test.js",
    "tests/social-3a0p-local-scope.test.js",
    "tests/social-3b0-linux-physical-gate.test.js",
    "tests/social-3b0-linux-workflow.test.js"
  ]);
  assert.equal(gate.CORRECTION_FILES.length, 7);
  assert.equal(new Set(gate.CORRECTION_FILES).size, 7);
  assert.deepEqual(gate.WINDOWS_NATIVE_SERIAL_TEST_FILES, [
    "social-3a0p-local-safe-zip-extract.test.js",
    "social-postgres-tls.test.js"
  ]);
  const expectedProcessLifecycleTestFiles = [
    "body-parser-security.test.js",
    "checkpoint-a-security.test.js",
    "fcm-token-encryption.test.js",
    "social-2b0-config-security.test.js",
    "social-foundation-integration.test.js",
    "zip-downloads.test.js",
    "social-3a0p-local-file-replace-argument-powershell.test.js",
    "social-3a0p-local-file-replace-powershell-diagnostic.test.js",
    "social-3a0p-local-firewall-nonmutation.test.js",
    "social-3a0p-local-safe-zip-extract.test.js",
    "social-postgres-tls.test.js",
    "social-3a0p-current-diff-scope.test.js"
  ];
  assert.deepEqual(PROCESS_LIFECYCLE_TEST_FILES, expectedProcessLifecycleTestFiles);
  assert.equal(PROCESS_LIFECYCLE_TEST_FILES.length, 12);
  assert.equal(new Set(PROCESS_LIFECYCLE_TEST_FILES).size, 12);
  assert.equal(
    PROCESS_LIFECYCLE_TEST_FILES.filter(
      (name) => name === "social-3a0p-current-diff-scope.test.js"
    ).length,
    1
  );
  assert.equal(
    PROCESS_LIFECYCLE_TEST_FILES.includes("social-3a0p-local-scope.test.js"),
    false
  );
  const partition = partitionAutomatedTests(
    [...expectedProcessLifecycleTestFiles, "social-3a0p-local-scope.test.js"]
      .map((name) => path.join(__dirname, name))
      .sort()
  );
  const serialNames = partition.serial.map((file) => path.basename(file));
  const concurrentNames = partition.concurrent.map((file) => path.basename(file));
  assert.deepEqual(serialNames, expectedProcessLifecycleTestFiles);
  assert.equal(
    serialNames.filter((name) => name === "social-3a0p-current-diff-scope.test.js").length,
    1
  );
  assert.equal(
    concurrentNames.includes("social-3a0p-current-diff-scope.test.js"),
    false
  );
  assert.deepEqual(concurrentNames, ["social-3a0p-local-scope.test.js"]);
  for (const name of gate.WINDOWS_NATIVE_SERIAL_TEST_FILES) {
    assert.equal(
      PROCESS_LIFECYCLE_TEST_FILES.filter((candidate) => candidate === name).length,
      1,
      name
    );
    assert.equal(gate.CORRECTION_FILES.includes(`tests/${name}`), false, name);
  }
  for (const protectedPath of [
    "scripts/social-3a0p-local-safe-zip-extract.ps1",
    "tests/helpers/local-tls-handshake.js"
  ]) assert.equal(gate.CORRECTION_FILES.includes(protectedPath), false);
  assert.equal(Object.isFrozen(gate.HISTORIC_COMMIT_CHAIN), true);
  assert.equal(
    gate.HISTORIC_COMMIT_CHAIN.every((entry) => Object.isFrozen(entry)),
    true
  );
  assert.equal(Object.isFrozen(gate.CORRECTION_FILES), true);
  assert.equal(Object.isFrozen(gate.WINDOWS_NATIVE_SERIAL_TEST_FILES), true);
  assert.equal(gate.PHASE, "instagram_oauth_local_contract");
  assert.equal(
    gate.IMAGE,
    "docker.io/library/postgres:18.4-bookworm@" +
      "sha256:7e6103cf85f88f7a0eddb3ec0b1ba8940eba098ed118ade25a729ca9daee5568"
  );
  assert.equal(gate.WORKER_TIMEOUT_MS, 44 * 60_000);
  assert.equal(gate.HISTORIC_TIMEOUT_MS, 36 * 60_000);
  assert.ok(gate.HISTORIC_TIMEOUT_MS < gate.WORKER_TIMEOUT_MS);
  assert.ok(gate.WORKER_TIMEOUT_MS < 60 * 60_000);
  assert.deepEqual(gate.SUBSTEP_IDS, Array.from(
    { length: 22 },
    (_unused, index) => `O${String(index + 1).padStart(2, "0")}`
  ));
  const o22Evidence = passedEvidence();
  assert.equal(o22Evidence.substeps.at(-1).id, "O22");
  assert.equal(o22Evidence.substeps.at(-1).status, "passed");
  assert.equal(o22Evidence.cleanupFailureProvenance, null);
  assert.equal(gate.evidenceSafe(o22Evidence), true);
});

test("socket close barrier 1: captures exactly two owned sockets before shutdown", async () => {
  const control = controlledSocketBarrier();
  assert.equal(gate.trackedServerSocketCount(control.server), 2);
  const barrier = gate.closeServer(control.server);
  await flushBarrierMicrotasks();
  assert.deepEqual(control.calls, [
    "server.close",
    "server.closeIdleConnections",
    "server.closeAllConnections"
  ]);
  control.emitServerClose();
  control.emitSocketClose(0);
  control.emitSocketClose(1);
  await barrier;
  assert.equal(gate.trackedServerSocketCount(control.server), 0);
});

test("socket close barrier 2: server callback can precede both socket close events", async () => {
  const control = controlledSocketBarrier();
  const barrier = gate.closeServer(control.server);
  const observed = observePromise(barrier);
  await flushBarrierMicrotasks();
  control.emitServerClose();
  await flushBarrierMicrotasks();
  assert.equal(observed.status, "pending");
  assert.equal(gate.trackedServerSocketCount(control.server), 2);
  control.emitSocketClose(0);
  control.emitSocketClose(1);
  await barrier;
});

test("socket close barrier 3: callback-only completion stays pending and repeated close is idempotent", async () => {
  const control = controlledSocketBarrier();
  const first = gate.closeServer(control.server);
  const second = gate.closeServer(control.server);
  const observed = observePromise(first);
  assert.equal(second, first);
  await flushBarrierMicrotasks();
  control.emitServerClose();
  await flushBarrierMicrotasks();
  assert.equal(observed.status, "pending");
  assert.deepEqual(control.calls, [
    "server.close",
    "server.closeIdleConnections",
    "server.closeAllConnections"
  ]);
  control.emitSocketClose(0);
  control.emitSocketClose(1);
  await first;
});

test("socket close barrier 4: one closed socket leaves the barrier pending and tracker at one", async () => {
  const control = controlledSocketBarrier();
  const barrier = gate.closeServer(control.server);
  const observed = observePromise(barrier);
  await flushBarrierMicrotasks();
  control.emitServerClose();
  control.emitSocketClose(0);
  await flushBarrierMicrotasks();
  assert.equal(observed.status, "pending");
  assert.equal(gate.trackedServerSocketCount(control.server), 1);
  control.emitSocketClose(1);
  await barrier;
});

test("socket close barrier 5: both close events resolve only after the tracker reaches zero", async () => {
  const control = controlledSocketBarrier();
  const barrier = gate.closeServer(control.server);
  const observed = observePromise(barrier);
  await flushBarrierMicrotasks();
  control.emitSocketClose(0);
  control.emitSocketClose(1);
  await flushBarrierMicrotasks();
  assert.equal(gate.trackedServerSocketCount(control.server), 0);
  assert.equal(observed.status, "pending");
  control.emitServerClose();
  await barrier;
  assert.equal(observed.status, "fulfilled");
});

test("socket close barrier 6: server close error is propagated only after both sockets drain", async () => {
  const serverError = Object.assign(new Error("fixture server close"), {
    code: "social_3b0_fixture_server_close_failed"
  });
  const laterError = Object.assign(new Error("fixture later close"), {
    code: "social_3b0_fixture_later_close_failed"
  });
  const control = controlledSocketBarrier({
    serverError,
    serverCallbackSynchronous: true,
    idleError: laterError
  });
  const barrier = gate.closeServer(control.server);
  const observed = observePromise(barrier);
  await flushBarrierMicrotasks();
  control.emitSocketClose(0);
  await flushBarrierMicrotasks();
  assert.equal(observed.status, "pending");
  assert.equal(gate.trackedServerSocketCount(control.server), 1);
  control.emitSocketClose(1);
  await assert.rejects(barrier, (error) => error === serverError);
  assert.equal(gate.trackedServerSocketCount(control.server), 0);
  assert.equal(observed.reason, serverError);
});

test("socket close barrier 7: closeIdleConnections remains part of the drain", async () => {
  const control = controlledSocketBarrier({ includeAll: false });
  const barrier = gate.closeServer(control.server);
  await flushBarrierMicrotasks();
  assert.deepEqual(control.calls, [
    "server.close",
    "server.closeIdleConnections"
  ]);
  control.emitServerClose();
  control.emitSocketClose(0);
  control.emitSocketClose(1);
  await barrier;
});

test("socket close barrier 8: closeAllConnections remains part of the drain", async () => {
  const control = controlledSocketBarrier({ includeIdle: false });
  const barrier = gate.closeServer(control.server);
  await flushBarrierMicrotasks();
  assert.deepEqual(control.calls, [
    "server.close",
    "server.closeAllConnections"
  ]);
  control.emitServerClose();
  control.emitSocketClose(0);
  control.emitSocketClose(1);
  await barrier;
});

test("socket close barrier 9: compatible servers without idle or all helpers remain safe", async () => {
  const control = controlledSocketBarrier({
    includeIdle: false,
    includeAll: false
  });
  const barrier = gate.closeServer(control.server);
  await flushBarrierMicrotasks();
  assert.deepEqual(control.calls, ["server.close"]);
  control.emitServerClose();
  control.emitSocketClose(0);
  control.emitSocketClose(1);
  await barrier;
  assert.equal(gate.trackedServerSocketCount(control.server), 0);
  await gate.closeServer(null);
});

test("socket close barrier 10: two sockets may close in reverse order", async () => {
  const control = controlledSocketBarrier();
  const barrier = gate.closeServer(control.server);
  await flushBarrierMicrotasks();
  control.emitServerClose();
  control.emitSocketClose(1);
  assert.equal(gate.trackedServerSocketCount(control.server), 1);
  control.emitSocketClose(0);
  await barrier;
  assert.equal(gate.trackedServerSocketCount(control.server), 0);
});

test("socket close barrier 11: nearly simultaneous socket events complete one barrier", async () => {
  const control = controlledSocketBarrier();
  control.server.close = (callback) => {
    control.calls.push("server.close");
    control.emitSocketClose(0);
    control.emitSocketClose(1);
    callback();
  };
  const barrier = gate.closeServer(control.server);
  await barrier;
  assert.equal(gate.trackedServerSocketCount(control.server), 0);
  assert.equal(control.calls.filter((entry) => entry === "server.close").length, 1);
});

test("socket close barrier 12: real loopback drains two concurrent HTTP connections", async () => {
  const responses = [];
  let requestCount = 0;
  const listener = await gate.listenLoopback((_request, response) => {
    requestCount += 1;
    responses.push(response);
    if (requestCount === 2) {
      for (const pending of responses) pending.end("ok");
    }
  });
  const agent = new http.Agent({ keepAlive: true, maxSockets: 2 });
  const request = () => new Promise((resolve, reject) => {
    const outgoing = http.get({
      agent,
      host: "127.0.0.1",
      port: listener.port,
      path: "/socket-close-barrier"
    }, (response) => {
      response.resume();
      response.once("end", resolve);
    });
    outgoing.once("error", reject);
  });
  let capturedSockets = -1;
  try {
    await Promise.all([request(), request()]);
    capturedSockets = gate.trackedServerSocketCount(listener.server);
    await gate.closeServer(listener.server);
  } finally {
    agent.destroy();
    if (listener.server.listening) {
      listener.server.closeAllConnections?.();
      await new Promise((resolve) => listener.server.close(resolve));
    }
  }
  assert.equal(requestCount, 2);
  assert.equal(capturedSockets, 2);
  assert.equal(listener.server.listening, false);
  assert.equal(gate.trackedServerSocketCount(listener.server), 0);
});

test("socket close barrier 13: O22 fails when one genuinely open socket remains", async () => {
  const control = controlledSocketBarrier();
  const barrier = gate.closeServer(control.server);
  await flushBarrierMicrotasks();
  control.emitServerClose();
  control.emitSocketClose(0);
  const firstAttemptResiduals = {
    ...gate.zeroResiduals(),
    listeners: gate.trackedServerSocketCount(control.server)
  };
  const provenance = cleanupSnapshot(gate.createCleanupAttemptTracker(), {
    firstAttemptResiduals
  });
  const evidence = failedO22Evidence({
    cleanupFailureProvenance: provenance,
    cleanup: {
      cleanupCompleted: false,
      intermediateEvidenceRemoved: true,
      syntheticMaterialsCleared: true
    },
    residuals: firstAttemptResiduals
  });
  assert.equal(firstAttemptResiduals.listeners, 1);
  assert.equal(provenance.operation, "residual_validation");
  assert.equal(evidence.substeps[21].status, "failed");
  assert.equal(evidence.firstFailure.substep, "O22");
  assert.equal(gate.evidenceSafe(evidence), true);
  control.emitSocketClose(1);
  await barrier;
});

test("socket close barrier 14: O22 passes only with its first snapshot entirely zero", async () => {
  const control = controlledSocketBarrier();
  const barrier = gate.closeServer(control.server);
  await flushBarrierMicrotasks();
  control.emitServerClose();
  control.emitSocketClose(0);
  control.emitSocketClose(1);
  await barrier;
  const firstAttemptResiduals = {
    ...gate.zeroResiduals(),
    listeners: gate.trackedServerSocketCount(control.server)
  };
  assert.deepEqual(firstAttemptResiduals, gate.zeroResiduals());
  assert.equal(cleanupSnapshot(gate.createCleanupAttemptTracker(), {
    firstAttemptResiduals
  }), null);
  const evidence = passedEvidence();
  assert.equal(evidence.substeps[21].status, "passed");
  assert.equal(evidence.firstFailure, null);
  assert.equal(evidence.cleanupFailureProvenance, null);
  assert.deepEqual(evidence.residuals, gate.zeroResiduals());
  assert.equal(gate.evidenceSafe(evidence), true);
  for (const key of Object.keys(gate.zeroResiduals())) {
    assert.equal(gate.evidenceSafe({
      ...evidence,
      residuals: { ...gate.zeroResiduals(), [key]: 1 }
    }), false, key);
  }
});

test("socket close barrier 15: functional, first O22 and compensating cleanup evidence stay separate", async () => {
  const functional = passedEvidence();
  functional.status = "failed";
  functional.firstFailure = gate.closedFirstFailure({
    phase: gate.PHASE,
    substep: "O13",
    lastCompletedSubstep: "O12",
    causalCode: "social_3b0_fixture_functional_failure"
  });
  functional.substeps = Object.freeze(functional.substeps.map((entry, index) =>
    Object.freeze(index === 12
      ? { ...entry, status: "failed" }
      : index > 12 && index < 21
        ? { ...entry, status: "skipped" }
        : entry)
  ));
  assert.equal(functional.substeps[21].status, "passed");
  assert.equal(functional.cleanupFailureProvenance, null);
  assert.equal(gate.evidenceSafe(functional), true);

  const firstAttemptResiduals = { ...gate.zeroResiduals(), listeners: 1 };
  const provenance = cleanupProvenance({
    operation: "residual_validation",
    causalCode: "social_3b0_cleanup_residuals_nonzero",
    cleanupErrorCount: 0,
    firstAttemptResiduals
  });
  const supervised = await supervisedEvidenceFixture({
    workerEvidence: failedO22Evidence({
      cleanupFailureProvenance: provenance,
      cleanup: {
        cleanupCompleted: false,
        intermediateEvidenceRemoved: true,
        syntheticMaterialsCleared: true
      },
      residuals: firstAttemptResiduals
    }),
    cleanupResult: zeroCleanup(),
    runId: "73222"
  });
  assert.equal(supervised.evidence.firstFailure.substep, "O22");
  assert.equal(supervised.evidence.substeps[21].status, "failed");
  assert.equal(
    supervised.evidence.cleanupFailureProvenance.firstAttemptResiduals.listeners,
    1
  );
  assert.equal(supervised.evidence.cleanup.cleanupCompleted, true);
  assert.deepEqual(supervised.evidence.residuals, gate.zeroResiduals());
});

test("Linux physical gate does not prewarm or alter the ZIP/TLS native environment", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "scripts", "social-3b0-linux-physical-gate.js"),
    "utf8"
  );
  assert.doesNotMatch(source, /\b(?:prewarm|openssl(?:\.exe)?|powershell(?:\.exe)?)\b/i);
  assert.doesNotMatch(
    source,
    /(?:process\.env|environment|env)\.PATH\s*=/
  );
  const valid = environment({
    RUNNER_TEMP: path.join(os.tmpdir(), "social-3b0-environment-contract")
  });
  assert.equal(
    Object.keys(valid).some((name) =>
      /^(?:PATH|OPENSSL|POWERSHELL|PREWARM)(?:_|$)/i.test(name)
    ),
    false
  );
  assert.deepEqual(gate.validateEnvironment(valid), {
    branch: gate.BRANCH,
    sha: SHA,
    runAttempt: 1
  });
});

test("remote environment requires every external runtime gate to remain exactly false", () => {
  const runnerTemp = path.join(os.tmpdir(), "social-3b0-environment-contract");
  const valid = environment({ RUNNER_TEMP: runnerTemp });
  assert.deepEqual(gate.validateEnvironment(valid), {
    branch: gate.BRANCH,
    sha: SHA,
    runAttempt: 1
  });
  for (const name of [
    "SOCIAL_INSTAGRAM_ENABLED",
    "SOCIAL_EXTERNAL_CONNECTION_ENABLED",
    "SOCIAL_EXTERNAL_PUBLICATION_ENABLED"
  ]) {
    assert.throws(
      () => gate.validateEnvironment({ ...valid, [name]: "true" }),
      (error) => error?.code === "social_3b0_environment_invalid"
    );
    const missing = { ...valid };
    delete missing[name];
    assert.throws(
      () => gate.validateEnvironment(missing),
      (error) => error?.code === "social_3b0_environment_invalid"
    );
  }
});

test("httpJsonRequest preserves the JSON payload through real loopback parser and Bearer boundaries", async () => {
  const originalRequest = http.request;
  const expectedBody = Object.freeze({ purpose: "connect" });
  const expectedSerialized = JSON.stringify(expectedBody);
  const validAuthorization = ["Bearer", "fixture-valid"].join(" ");
  const invalidAuthorization = ["Bearer", "fixture-invalid"].join(" ");
  const rawBodies = [];
  const parsedBodies = [];
  const sockets = new Set();
  let authenticationCalls = 0;
  let handlerCalls = 0;
  let parserFailures = 0;
  let delayedRequests = 0;
  const app = express();
  app.use(express.json({
    verify(_request, _response, buffer) {
      rawBodies.push(Buffer.from(buffer));
    }
  }));
  app.post(
    "/v1/social/connections/instagram/authorization",
    (request, response, next) => {
      authenticationCalls += 1;
      parsedBodies.push(request.body);
      if (request.headers.authorization !== validAuthorization) {
        response.status(401).json({ code: "synthetic_unauthorized" });
        return;
      }
      next();
    },
    (request, response) => {
      handlerCalls += 1;
      response.status(201).json({
        status: "authorization_pending",
        purpose: request.body.purpose
      });
    }
  );
  app.use((_error, _request, response, _next) => {
    parserFailures += 1;
    response.status(400).json({ code: "synthetic_parser_refusal" });
  });
  const server = http.createServer(app);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.equal(address.address, "127.0.0.1");

  http.request = (options, onResponse) => {
    const actual = originalRequest(options, onResponse);
    const originalWrite = actual.write.bind(actual);
    const originalEnd = actual.end.bind(actual);
    let retainedPayload = null;
    delayedRequests += 1;
    actual.write = (candidate) => {
      retainedPayload = candidate;
      return true;
    };
    actual.end = (candidate, encoding, callback) => {
      if (Buffer.isBuffer(candidate)) retainedPayload = candidate;
      const completion = typeof callback === "function"
        ? callback
        : typeof encoding === "function"
          ? encoding
          : typeof candidate === "function"
            ? candidate
            : undefined;
      setImmediate(() => {
        actual.write = originalWrite;
        actual.end = originalEnd;
        if (retainedPayload) originalEnd(retainedPayload, completion);
        else originalEnd(completion);
      });
      return actual;
    };
    return actual;
  };

  try {
    const missing = await gate.httpJsonRequest({
      port: address.port,
      method: "POST",
      route: "/v1/social/connections/instagram/authorization",
      body: expectedBody
    });
    const invalid = await gate.httpJsonRequest({
      port: address.port,
      method: "POST",
      route: "/v1/social/connections/instagram/authorization",
      headers: { authorization: invalidAuthorization },
      body: expectedBody
    });
    const valid = await gate.httpJsonRequest({
      port: address.port,
      method: "POST",
      route: "/v1/social/connections/instagram/authorization",
      headers: { authorization: validAuthorization },
      body: expectedBody
    });

    assert.equal(missing.status, 401);
    assert.equal(invalid.status, 401);
    assert.deepEqual(valid, {
      status: 201,
      value: { status: "authorization_pending", purpose: "connect" }
    });
    assert.equal(delayedRequests, 3);
    assert.equal(authenticationCalls, 3);
    assert.equal(handlerCalls, 1);
    assert.equal(parserFailures, 0);
    assert.equal(rawBodies.length, 3);
    assert.equal(rawBodies.every((buffer) => buffer.toString("utf8") === expectedSerialized), true);
    assert.equal(rawBodies.every((buffer) => !buffer.includes(0)), true);
    assert.deepEqual(parsedBodies, [expectedBody, expectedBody, expectedBody]);
  } finally {
    http.request = originalRequest;
    for (const buffer of rawBodies) buffer.fill(0);
    await closeLoopbackServer(server, sockets);
  }
  assert.equal(server.listening, false);
  assert.equal(sockets.size, 0);
  assert.equal(http.request, originalRequest);
});

test("httpJsonRequest retains one payload until finish and accepts a response started after finish", async () => {
  const control = controlledHttpTransport();
  const resultPromise = gate.httpJsonRequest({
    port: 7443,
    method: "POST",
    route: "/v1/social/test",
    body: { purpose: "connect" },
    requestImpl: control.requestImpl
  });
  const retained = control.payload;
  assert.ok(Buffer.isBuffer(retained));
  assert.equal(retained.toString("utf8"), JSON.stringify({ purpose: "connect" }));
  assert.equal(control.endCalls, 1);
  let wipeCalls = 0;
  const originalFill = retained.fill.bind(retained);
  retained.fill = (...args) => {
    wipeCalls += 1;
    return originalFill(...args);
  };

  control.request.emit("finish");
  assert.equal(retained.every((byte) => byte === 0), true);
  assert.equal(wipeCalls, 1);
  control.endCallback?.();
  const response = control.startResponse(200);
  control.request.emit("close");
  assert.equal(wipeCalls, 1);
  response.emit("data", Buffer.from('{"ok":true}'));
  response.emit("end");
  response.emit("close");
  assert.deepEqual(await resultPromise, { status: 200, value: { ok: true } });
  assert.equal(wipeCalls, 1);
  assert.deepEqual(control.request.eventNames(), []);
  assert.deepEqual(response.eventNames(), []);
});

test("httpJsonRequest rejects finish-close-before-response once and destroys a late response", async () => {
  const control = controlledHttpTransport();
  let responseChunkFactoryCalls = 0;
  const resultPromise = gate.httpJsonRequest({
    port: 7443,
    method: "POST",
    route: "/v1/social/test",
    body: { purpose: "connect" },
    requestImpl: control.requestImpl,
    responseChunkFactory(chunk) {
      responseChunkFactoryCalls += 1;
      return Buffer.from(chunk);
    }
  });
  const retained = control.payload;
  let wipeCalls = 0;
  let resolveCalls = 0;
  let rejectCalls = 0;
  const originalFill = retained.fill.bind(retained);
  retained.fill = (...args) => {
    wipeCalls += 1;
    return originalFill(...args);
  };
  const observed = resultPromise.then(
    (value) => {
      resolveCalls += 1;
      return value;
    },
    (error) => {
      rejectCalls += 1;
      throw error;
    }
  );

  control.request.emit("finish");
  control.endCallback?.();
  control.request.emit("close");
  await assert.rejects(
    observed,
    (error) => error?.code === "social_3b0_loopback_request_closed"
  );
  assert.equal(retained.every((byte) => byte === 0), true);
  assert.equal(wipeCalls, 1);
  assert.equal(resolveCalls, 0);
  assert.equal(rejectCalls, 1);
  assert.deepEqual(control.request.eventNames(), []);

  const lateResponse = control.startResponse(200);
  lateResponse.emit("data", Buffer.from('{"late":true}'));
  lateResponse.emit("end");
  assert.equal(lateResponse.resumeCalls, 1);
  assert.equal(lateResponse.destroyCalls, 1);
  assert.equal(responseChunkFactoryCalls, 0);
  assert.equal(resolveCalls, 0);
  assert.equal(rejectCalls, 1);
  assert.equal(wipeCalls, 1);
  assert.deepEqual(lateResponse.eventNames(), []);
});

test("httpJsonRequest rejects a real loopback peer close before response without residual resources", async () => {
  const sockets = new Set();
  let responseCallbacks = 0;
  let dnsCalls = 0;
  let bodyExact = false;
  let bodyContainsNull = true;
  const server = http.createServer((request) => {
    const chunks = [];
    let total = 0;
    request.on("data", (chunk) => {
      const copy = Buffer.from(chunk);
      chunks.push(copy);
      total += copy.length;
    });
    request.once("end", () => {
      const serialized = Buffer.concat(chunks, total);
      for (const chunk of chunks) chunk.fill(0);
      chunks.length = 0;
      bodyExact = serialized.toString("utf8") === JSON.stringify({ purpose: "connect" });
      bodyContainsNull = serialized.includes(0);
      serialized.fill(0);
      request.socket.destroy();
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.equal(address.address, "127.0.0.1");

  try {
    const requestImpl = (options, onResponse) => {
      assert.equal(options.host, "127.0.0.1");
      return http.request({
        ...options,
        agent: false,
        lookup(hostname, _options, callback) {
          dnsCalls += 1;
          callback(new Error(`unexpected lookup for ${hostname}`));
        }
      }, (response) => {
        responseCallbacks += 1;
        onResponse(response);
      });
    };
    await assert.rejects(
      gate.httpJsonRequest({
        port: address.port,
        method: "POST",
        route: "/v1/social/test",
        body: { purpose: "connect" },
        requestImpl
      }),
      (error) => error?.code === "social_3b0_loopback_request_closed"
    );
    assert.equal(bodyExact, true);
    assert.equal(bodyContainsNull, false);
    assert.equal(responseCallbacks, 0);
    assert.equal(dnsCalls, 0);
  } finally {
    await closeLoopbackServer(server, sockets);
  }
  assert.equal(server.listening, false);
  assert.equal(sockets.size, 0);
});

test("httpJsonRequest wipes on error or premature close and settles each failure once", async (context) => {
  for (const scenario of ["error", "close"]) {
    await context.test(scenario, async () => {
      const control = controlledHttpTransport();
      const resultPromise = gate.httpJsonRequest({
        port: 7443,
        method: "POST",
        route: "/v1/social/test",
        body: { purpose: "connect" },
        requestImpl: control.requestImpl
      });
      const retained = control.payload;
      let wipeCalls = 0;
      let rejectionCalls = 0;
      const originalFill = retained.fill.bind(retained);
      retained.fill = (...args) => {
        wipeCalls += 1;
        return originalFill(...args);
      };
      const observed = resultPromise.catch((error) => {
        rejectionCalls += 1;
        throw error;
      });
      if (scenario === "error") {
        control.request.emit("error", new Error("synthetic transport refusal"));
        control.request.emit("close");
      } else {
        control.request.emit("close");
      }
      await assert.rejects(
        observed,
        (error) => error?.code === (scenario === "error"
          ? "social_3b0_loopback_request_failed"
          : "social_3b0_loopback_request_closed") &&
          !String(error?.message).includes("synthetic transport refusal")
      );
      assert.equal(retained.every((byte) => byte === 0), true);
      assert.equal(wipeCalls, 1);
      assert.equal(rejectionCalls, 1);
    });
  }
});

test("httpJsonRequest absorbs aborted-error-close and drains a response after request failure", async (context) => {
  await context.test("aborted then error then close", async () => {
    const control = controlledHttpTransport({ destroyEmitsClose: false });
    const resultPromise = gate.httpJsonRequest({
      port: 7443,
      method: "GET",
      route: "/v1/social/test",
      requestImpl: control.requestImpl
    });
    control.request.emit("finish");
    control.endCallback?.();
    const response = control.startResponse(200);
    response.emit("data", Buffer.from('{"partial":'));
    response.emit("aborted");
    response.emit("error", new Error("synthetic post-abort detail"));
    response.emit("close");
    await assert.rejects(
      resultPromise,
      (error) => error?.code === "social_3b0_loopback_response_failed" &&
        !String(error?.message).includes("synthetic post-abort detail")
    );
    assert.equal(response.resumeCalls, 1);
    assert.equal(response.destroyCalls, 1);
    assert.deepEqual(response.eventNames(), []);
    assert.deepEqual(control.request.eventNames(), []);
  });

  await context.test("request error after response start", async () => {
    const control = controlledHttpTransport({ destroyEmitsClose: false });
    const resultPromise = gate.httpJsonRequest({
      port: 7443,
      method: "GET",
      route: "/v1/social/test",
      requestImpl: control.requestImpl
    });
    control.request.emit("finish");
    control.endCallback?.();
    const response = control.startResponse(200);
    response.emit("data", Buffer.from('{"partial":'));
    control.request.emit("error", new Error("synthetic request detail"));
    response.emit("error", new Error("synthetic drained detail"));
    response.emit("close");
    await assert.rejects(
      resultPromise,
      (error) => error?.code === "social_3b0_loopback_request_failed" &&
        !String(error?.message).includes("synthetic request detail")
    );
    assert.equal(response.resumeCalls, 1);
    assert.equal(response.destroyCalls, 1);
    assert.deepEqual(response.eventNames(), []);
    assert.deepEqual(control.request.eventNames(), []);
  });
});

test("httpJsonRequest preserves null bodies, JSON parsing, response limits and loopback pinning", async (context) => {
  await context.test("null and invalid JSON responses", async () => {
    const control = controlledHttpTransport();
    const resultPromise = gate.httpJsonRequest({
      port: 7443,
      method: "GET",
      route: "/v1/social/test",
      requestImpl: control.requestImpl
    });
    assert.equal(control.payload, null);
    assert.equal(control.request.options.host, "127.0.0.1");
    control.request.emit("finish");
    control.endCallback?.();
    control.respond("not-json", 202);
    assert.deepEqual(await resultPromise, { status: 202, value: null });
  });

  await context.test("oversized response", async () => {
    const control = controlledHttpTransport();
    const resultPromise = gate.httpJsonRequest({
      port: 7443,
      method: "GET",
      route: "/v1/social/test",
      requestImpl: control.requestImpl
    });
    control.request.emit("finish");
    control.endCallback?.();
    const response = control.respond("x".repeat(64 * 1024 + 1), 200);
    await assert.rejects(
      resultPromise,
      (error) => error?.code === "social_3b0_loopback_response_too_large"
    );
    assert.equal(response.destroyCalls, 1);
  });

  await context.test("response chunks and response errors", async () => {
    const control = controlledHttpTransport();
    let observedCopy;
    const resultPromise = gate.httpJsonRequest({
      port: 7443,
      method: "GET",
      route: "/v1/social/test",
      requestImpl: control.requestImpl,
      responseChunkFactory(chunk) {
        observedCopy = Buffer.from(chunk);
        return observedCopy;
      }
    });
    control.request.emit("finish");
    control.endCallback?.();
    control.respond('{"ok":true}', 200);
    assert.deepEqual(await resultPromise, { status: 200, value: { ok: true } });
    assert.ok(Buffer.isBuffer(observedCopy));
    assert.equal(observedCopy.every((byte) => byte === 0), true);

    const failed = controlledHttpTransport();
    const failedPromise = gate.httpJsonRequest({
      port: 7443,
      method: "GET",
      route: "/v1/social/test",
      requestImpl: failed.requestImpl
    });
    failed.request.emit("finish");
    failed.endCallback?.();
    const failedResponse = failed.startResponse(200);
    failedResponse.emit("data", Buffer.from('{"partial":'));
    failedResponse.emit("error", new Error("synthetic response detail"));
    failedResponse.emit("close");
    await assert.rejects(
      failedPromise,
      (error) => error?.code === "social_3b0_loopback_response_failed" &&
        !String(error?.message).includes("synthetic response detail")
    );
  });

  let requestCalls = 0;
  assert.throws(
    () => gate.httpJsonRequest({
      port: 7443,
      method: "GET",
      route: "https://example.invalid/v1/social/test",
      requestImpl() { requestCalls += 1; }
    }),
    (error) => error?.code === "social_3b0_loopback_request_invalid"
  );
  assert.equal(requestCalls, 0);
});

test("O05 refusal predicates preserve four exact and non-overlapping causal codes", () => {
  const valid = Object.freeze({
    missingStatus: 401,
    invalidStatus: 401,
    beforeCount: 0,
    afterCount: 0,
    bearerAccepts: 0
  });
  assert.equal(gate.assertAuthorizeRefusalContract(valid), true);
  const scenarios = [
    ["missingStatus", 400, "social_3b0_authorize_missing_bearer_status_invalid"],
    ["invalidStatus", 400, "social_3b0_authorize_invalid_bearer_status_invalid"],
    ["afterCount", 1, "social_3b0_authorize_refusal_persistence_invalid"],
    ["bearerAccepts", 1, "social_3b0_authorize_refusal_acceptance_invalid"]
  ];
  for (const [field, value, code] of scenarios) {
    assert.throws(
      () => gate.assertAuthorizeRefusalContract({ ...valid, [field]: value }),
      (error) => error?.code === code && error?.message === code
    );
    assert.throws(
      () => gate.assertAuthorizeRefusalContract({ ...valid, [field]: value }),
      (error) => !String(error?.code).startsWith(`${code}_`)
    );
  }
});

test("O05 source preserves refusal ordering, request counts and the valid authorize contract", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "scripts", "social-3b0-linux-physical-gate.js"),
    "utf8"
  );
  const start = source.indexOf('await ledger.run("O05"');
  const end = source.indexOf('await ledger.run("O06"', start);
  const o05 = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.equal((o05.match(/counts\.authorizeRequests \+= 1/g) || []).length, 3);
  assert.match(o05, /assertAuthorizeRefusalContract\(\{/);
  assert.match(o05, /missingStatus: missing\.status/);
  assert.match(o05, /invalidStatus: invalid\.status/);
  assert.match(o05, /beforeCount: Number\(before\.rows/);
  assert.match(o05, /afterCount: Number\(afterRefusal\.rows/);
  assert.match(o05, /bearerAccepts\s*\n\s*\}\);/);
  assert.doesNotMatch(o05, /social_3b0_authorize_bearer_refusal_invalid/);
  assert.match(o05, /response\.status !== 201/);
  assert.match(o05, /response\.value\?\.status !== "authorization_pending"/);
  assert.match(o05, /bearerAccepts !== 1/);
  assert.match(o05, /fail\("social_3b0_authorize_http_invalid"\)/);
  const refusalCheck = o05.indexOf("assertAuthorizeRefusalContract({");
  const validRequest = o05.indexOf("const response = await httpJsonRequest({");
  const requestCounts = [...o05.matchAll(/counts\.authorizeRequests \+= 1/g)]
    .map((match) => match.index);
  assert.equal(requestCounts.filter((index) => index < refusalCheck).length, 2);
  assert.equal(requestCounts.filter((index) => index > validRequest).length, 1);
  assert.ok(refusalCheck < validRequest);
  assert.ok(o05.indexOf("response.status !== 201") < o05.indexOf("primaryState = new URL"));
  assert.doesNotMatch(o05, /startsWith|endsWith|\.includes\(|\bRegExp\b|\|\|\s*\[|catch\s*\(/);
});

test("O12 accepts one encrypted pending credential and proves it with the real vault", async () => {
  const fixture = createPendingCredentialFixture();
  const syntheticToken = fixture.syntheticMaterial.toString("base64url");
  try {
    const result = await gate.verifyPendingCredentialPhysicalProof(
      fixture.options()
    );
    assert.equal(result, true);
    assert.equal(fixture.operationalReads, 1);
    assert.equal(fixture.operationalCallbackCalls, 0);
    assert.equal(fixture.vaultDecryptCalls, 1);
    assert.equal(fixture.evidenceCounts.credentialWrites, 1);
    assert.equal(fixture.evidenceCounts.accountDiscoveryCalls, 0);
    assert.equal(fixture.evidenceCounts.publicationCalls, 0);
    assert.equal(fixture.decryptedPlaintexts.length, 1);
    assert.equal(
      fixture.decryptedPlaintexts[0].every((byte) => byte === 0),
      true
    );
    assertPendingCredentialBuffersCleared([fixture.row]);
    assert.equal(JSON.stringify(result).includes(syntheticToken), false);
  } finally {
    fixture.destroy();
  }
});

test("O12 rejects every malformed physical pending credential row and clears its buffers", async (context) => {
  const alternateCompany = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const alternateCredential = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const alternateConnection = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const alternateTransaction = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const cases = [
    {
      name: "missing row",
      code: "social_3b0_pending_credential_row_invalid",
      rows: () => []
    },
    {
      name: "more than one row",
      code: "social_3b0_pending_credential_row_invalid",
      rows: (fixture) => [
        fixture.row,
        clonePendingCredentialRow(fixture.row)
      ]
    },
    {
      name: "company mismatch",
      code: "social_3b0_pending_credential_row_invalid",
      rows: (fixture) => [{ ...fixture.row, company_id: alternateCompany }]
    },
    {
      name: "credential id mismatch",
      code: "social_3b0_pending_credential_row_invalid",
      rows: (fixture) => [{ ...fixture.row, id: alternateCredential }]
    },
    {
      name: "connection id mismatch",
      code: "social_3b0_pending_credential_row_invalid",
      rows: (fixture) => [{ ...fixture.row, connection_id: alternateConnection }]
    },
    {
      name: "provider mismatch",
      code: "social_3b0_pending_credential_row_invalid",
      rows: (fixture) => [{ ...fixture.row, provider: "facebook" }]
    },
    {
      name: "credential type mismatch",
      code: "social_3b0_pending_credential_row_invalid",
      rows: (fixture) => [{ ...fixture.row, credential_type: "other_token" }]
    },
    {
      name: "oauth transaction is not null",
      code: "social_3b0_pending_credential_row_invalid",
      rows: (fixture) => [{
        ...fixture.row,
        oauth_transaction_id: alternateTransaction
      }]
    },
    {
      name: "revoked timestamp is not null",
      code: "social_3b0_pending_credential_row_invalid",
      rows: (fixture) => [{ ...fixture.row, revoked_at: new Date(0) }]
    },
    {
      name: "empty ciphertext",
      code: "social_3b0_credential_ciphertext_invalid",
      rows: (fixture) => [{ ...fixture.row, ciphertext: Buffer.alloc(0) }]
    },
    {
      name: "nonce is not twelve bytes",
      code: "social_3b0_credential_ciphertext_invalid",
      rows: (fixture) => [{ ...fixture.row, nonce: Buffer.alloc(11, 1) }]
    },
    {
      name: "authentication tag is not sixteen bytes",
      code: "social_3b0_credential_ciphertext_invalid",
      rows: (fixture) => [{ ...fixture.row, auth_tag: Buffer.alloc(15, 1) }]
    },
    {
      name: "AAD version is not one",
      code: "social_3b0_credential_ciphertext_invalid",
      rows: (fixture) => [{ ...fixture.row, aad_version: 2 }]
    },
    {
      name: "ciphertext contains the synthetic plaintext",
      code: "social_3b0_credential_ciphertext_invalid",
      rows: (fixture) => [{
        ...fixture.row,
        ciphertext: Buffer.from(
          fixture.syntheticMaterial.toString("base64url"),
          "utf8"
        )
      }]
    }
  ];
  for (const entry of cases) {
    await context.test(entry.name, async () => {
      const fixture = createPendingCredentialFixture();
      const rows = entry.rows(fixture);
      try {
        await assert.rejects(
          gate.verifyPendingCredentialPhysicalProof(
            fixture.options({ result: { rows } })
          ),
          (error) => error?.code === entry.code
        );
        assert.equal(fixture.operationalReads, 0);
        assert.equal(fixture.vaultDecryptCalls, 0);
        assert.equal(fixture.evidenceCounts.credentialWrites, 0);
        assertPendingCredentialBuffersCleared(rows);
      } finally {
        fixture.destroy();
        for (const row of rows) {
          for (const field of ["ciphertext", "nonce", "auth_tag"]) {
            if (Buffer.isBuffer(row?.[field])) row[field].fill(0);
          }
        }
      }
    });
  }
});

test("O12 requires exact credential_not_found and never accepts an operational plaintext", async (context) => {
  await context.test("exact pending refusal is accepted without invoking the callback", async () => {
    const fixture = createPendingCredentialFixture();
    try {
      assert.equal(
        await gate.verifyPendingCredentialPhysicalProof(fixture.options()),
        true
      );
      assert.equal(fixture.operationalReads, 1);
      assert.equal(fixture.operationalCallbackCalls, 0);
    } finally {
      fixture.destroy();
    }
  });

  await context.test("resolved plaintext is rejected and zeroed", async () => {
    const fixture = createPendingCredentialFixture();
    const resolved = Buffer.from(
      fixture.syntheticMaterial.toString("base64url"),
      "utf8"
    );
    try {
      await assert.rejects(
        gate.verifyPendingCredentialPhysicalProof(fixture.options({
          credentials: {
            async withDecryptedCredential() { return resolved; }
          }
        })),
        (error) =>
          error?.code === "social_3b0_pending_credential_unexpectedly_operational"
      );
      assert.equal(resolved.every((byte) => byte === 0), true);
      assert.equal(fixture.vaultDecryptCalls, 0);
    } finally {
      resolved.fill(0);
      fixture.destroy();
    }
  });

  await context.test("an invoked operational callback is rejected even if credential_not_found follows", async () => {
    const fixture = createPendingCredentialFixture();
    const delivered = Buffer.from(
      fixture.syntheticMaterial.toString("base64url"),
      "utf8"
    );
    try {
      await assert.rejects(
        gate.verifyPendingCredentialPhysicalProof(fixture.options({
          credentials: {
            async withDecryptedCredential(_identity, operation) {
              fixture.recordOperationalCallback();
              await operation(delivered);
              const error = new Error("pending credential unavailable");
              error.code = "credential_not_found";
              throw error;
            }
          }
        })),
        (error) =>
          error?.code === "social_3b0_pending_credential_unexpectedly_operational"
      );
      assert.equal(fixture.operationalCallbackCalls, 1);
      assert.equal(delivered.every((byte) => byte === 0), true);
      assert.equal(fixture.vaultDecryptCalls, 0);
    } finally {
      delivered.fill(0);
      fixture.destroy();
    }
  });

  for (const refusal of [
    { name: "different code", value: "credential_expired" },
    { name: "prefixed code", value: "credential_not_found_pending" },
    { name: "missing code", value: undefined },
    { name: "undefined rejection", value: undefined, bare: true },
    { name: "null rejection", value: null, bare: true }
  ]) {
    await context.test(`${refusal.name} is rejected`, async () => {
      const fixture = createPendingCredentialFixture();
      try {
        await assert.rejects(
          gate.verifyPendingCredentialPhysicalProof(fixture.options({
            credentials: {
              async withDecryptedCredential() {
                if (refusal.bare) throw refusal.value;
                const error = new Error("wrong refusal");
                error.code = refusal.value;
                throw error;
              }
            }
          })),
          (error) =>
            error?.code === "social_3b0_pending_credential_visibility_guard_invalid"
        );
        assert.equal(fixture.vaultDecryptCalls, 0);
      } finally {
        fixture.destroy();
      }
    });
  }
});

test("O12 physical proof binds row context, real vault AAD, digest and zeroization", async (context) => {
  await context.test("context and envelope are derived from the selected row", async () => {
    const fixture = createPendingCredentialFixture();
    let contextRow;
    let envelopeRow;
    let contextExpected;
    try {
      await gate.verifyPendingCredentialPhysicalProof(fixture.options({
        contextFromRow(row, expected) {
          contextRow = row;
          contextExpected = expected;
          return contextFromRow(row, expected);
        },
        envelopeFromRow(row) {
          envelopeRow = row;
          return envelopeFromRow(row);
        }
      }));
      assert.equal(contextRow, fixture.row);
      assert.equal(envelopeRow, fixture.row);
      assert.deepEqual(contextExpected, {
        companyId: fixture.expected.companyId,
        credentialId: fixture.expected.credentialId
      });
      assert.equal(fixture.decryptedPlaintexts[0].every((byte) => byte === 0), true);
      assertPendingCredentialBuffersCleared([fixture.row]);
    } finally {
      fixture.destroy();
    }
  });

  await context.test("AAD mismatch is rejected by the real vault", async () => {
    const fixture = createPendingCredentialFixture({
      encryptionContext: {
        subjectId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
      }
    });
    try {
      await assert.rejects(
        gate.verifyPendingCredentialPhysicalProof(fixture.options()),
        (error) =>
          error?.code === "social_3b0_pending_credential_vault_proof_invalid"
      );
      assert.equal(fixture.vaultDecryptCalls, 1);
      assertPendingCredentialBuffersCleared([fixture.row]);
    } finally {
      fixture.destroy();
    }
  });

  await context.test("a different vault cannot authenticate the envelope", async () => {
    const fixture = createPendingCredentialFixture();
    const other = createPendingCredentialFixture();
    try {
      await assert.rejects(
        gate.verifyPendingCredentialPhysicalProof(fixture.options({
          vault: other.options().vault,
          operationCounts: () => ({
            vaultEncryptCalls: 1,
            vaultDecryptCalls: other.vaultDecryptCalls,
            credentialStoreCalls: 1
          })
        })),
        (error) =>
          error?.code === "social_3b0_pending_credential_vault_proof_invalid"
      );
      assert.equal(other.vaultDecryptCalls, 1);
      assertPendingCredentialBuffersCleared([fixture.row]);
    } finally {
      fixture.destroy();
      other.destroy();
    }
  });

  await context.test("digest mismatch zeroes plaintext and physical buffers", async () => {
    const fixture = createPendingCredentialFixture();
    try {
      await assert.rejects(
        gate.verifyPendingCredentialPhysicalProof(fixture.options({
          expectedDigest: "0".repeat(64)
        })),
        (error) =>
          error?.code === "social_3b0_pending_credential_vault_proof_invalid"
      );
      assert.equal(fixture.decryptedPlaintexts.length, 1);
      assert.equal(fixture.decryptedPlaintexts[0].every((byte) => byte === 0), true);
      assertPendingCredentialBuffersCleared([fixture.row]);
    } finally {
      fixture.destroy();
    }
  });
});

test("O12 enforces one encrypt, decrypt, store and credentialWrites increment", async (context) => {
  for (const entry of [
    ["vault encrypt", { vaultEncryptCalls: 0, vaultDecryptCalls: 1, credentialStoreCalls: 1 }],
    ["vault decrypt", { vaultEncryptCalls: 1, vaultDecryptCalls: 0, credentialStoreCalls: 1 }],
    ["credential store", { vaultEncryptCalls: 1, vaultDecryptCalls: 1, credentialStoreCalls: 0 }]
  ]) {
    await context.test(`${entry[0]} count mismatch`, async () => {
      const fixture = createPendingCredentialFixture();
      try {
        await assert.rejects(
          gate.verifyPendingCredentialPhysicalProof(fixture.options({
            operationCounts: () => ({ ...entry[1] })
          })),
          (error) => error?.code === "social_3b0_credential_single_write_invalid"
        );
        assert.equal(fixture.evidenceCounts.credentialWrites, 0);
      } finally {
        fixture.destroy();
      }
    });
  }

  await context.test("a pre-existing credential write is rejected", async () => {
    const fixture = createPendingCredentialFixture();
    fixture.evidenceCounts.credentialWrites = 1;
    try {
      await assert.rejects(
        gate.verifyPendingCredentialPhysicalProof(fixture.options()),
        (error) => error?.code === "social_3b0_credential_single_write_invalid"
      );
      assert.equal(fixture.evidenceCounts.credentialWrites, 1);
    } finally {
      fixture.destroy();
    }
  });
});

test("O12 keeps authorization pending with zero accounts, discovery and publication", async (context) => {
  const cases = [
    {
      name: "connection activated before O13",
      override: () => ({
        readBoundary: async () => ({ status: "active", externalAccounts: 0 })
      })
    },
    {
      name: "external account created before O13",
      override: () => ({
        readBoundary: async () => ({
          status: "authorization_pending",
          externalAccounts: 1
        })
      })
    },
    {
      name: "account discovery called",
      override: (fixture) => ({
        evidenceCounts: {
          ...fixture.evidenceCounts,
          accountDiscoveryCalls: 1
        }
      })
    },
    {
      name: "publication called",
      override: (fixture) => ({
        evidenceCounts: {
          ...fixture.evidenceCounts,
          publicationCalls: 1
        }
      })
    }
  ];
  for (const entry of cases) {
    await context.test(entry.name, async () => {
      const fixture = createPendingCredentialFixture();
      const overrides = entry.override(fixture);
      try {
        await assert.rejects(
          gate.verifyPendingCredentialPhysicalProof(
            fixture.options(overrides)
          ),
          (error) => error?.code === "social_3b0_account_discovery_boundary_invalid"
        );
        assert.equal((overrides.evidenceCounts || fixture.evidenceCounts).credentialWrites, 0);
      } finally {
        fixture.destroy();
      }
    });
  }
});

test("O12 never returns or propagates synthetic credential material", async () => {
  const fixture = createPendingCredentialFixture();
  const syntheticToken = fixture.syntheticMaterial.toString("base64url");
  const unsafe = new Error(syntheticToken);
  unsafe.code = "credential_expired";
  try {
    let observed;
    try {
      await gate.verifyPendingCredentialPhysicalProof(fixture.options({
        credentials: {
          async withDecryptedCredential() { throw unsafe; }
        }
      }));
    } catch (error) {
      observed = error;
    }
    assert.equal(
      observed?.code,
      "social_3b0_pending_credential_visibility_guard_invalid"
    );
    assert.equal(String(observed?.message || "").includes(syntheticToken), false);
    assert.equal(JSON.stringify(observed || {}).includes(syntheticToken), false);
    assert.equal(JSON.stringify(fixture.evidenceCounts).includes(syntheticToken), false);
    assertPendingCredentialBuffersCleared([fixture.row]);
  } finally {
    fixture.destroy();
  }
});

test("O12 source keeps physical proof separate from the fail-closed operational repository", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "scripts", "social-3b0-linux-physical-gate.js"),
    "utf8"
  );
  const start = source.indexOf('await ledger.run("O12"');
  const end = source.indexOf('await ledger.run("O13"', start);
  const o12 = source.slice(start, end);
  const helperStart = source.indexOf("async function verifyPendingCredentialPhysicalProof");
  const helperEnd = source.indexOf("function zeroResiduals", helperStart);
  const helper = source.slice(helperStart, helperEnd);
  assert.ok(start >= 0 && end > start && helperStart >= 0 && helperEnd > helperStart);
  for (const field of [
    "company_id", "id", "provider", "connection_id", "oauth_transaction_id",
    "credential_type", "ciphertext", "nonce", "auth_tag", "key_version",
    "aad_version", "expires_at", "revoked_at"
  ]) assert.match(o12, new RegExp(`\\b${field}\\b`));
  assert.match(o12, /verifyPendingCredentialPhysicalProof\(\{/);
  assert.match(o12, /credentials,/);
  assert.match(o12, /vault,/);
  assert.match(o12, /contextFromRow,/);
  assert.match(o12, /envelopeFromRow,/);
  assert.match(helper, /withDecryptedCredential\(\{/);
  assert.match(helper, /operationalRejected = true/);
  assert.match(helper, /operationalError\?\.code !== "credential_not_found"/);
  assert.match(helper, /options\.vault\.decrypt\(/);
  assert.match(helper, /options\.envelopeFromRow\(row\)/);
  assert.match(helper, /options\.contextFromRow\(row,/);
  assert.match(helper, /physicalPlaintext\.fill\(0\)/);
  assert.match(helper, /clearPendingCredentialRows\(rows\)/);
  assert.doesNotMatch(o12 + helper, /findEncryptedCredentialForKeyRotation/);
  assert.doesNotMatch(o12 + helper, /createDecipheriv|createDecipher|setAAD|setAuthTag/);
  assert.doesNotMatch(o12 + helper, /console\.|stdout|stderr/);
  assert.doesNotMatch(o12, /\bUPDATE\b|\bINSERT\b|\bDELETE\b/);
  assert.doesNotMatch(o12, /status\s*=\s*["']active["']/);
});

test("O13 remains a second independent pending, account, discovery and publication boundary", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "scripts", "social-3b0-linux-physical-gate.js"),
    "utf8"
  );
  const start = source.indexOf('await ledger.run("O13"');
  const end = source.indexOf('await ledger.run("O14"', start);
  const o13 = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(o13, /status !== "authorization_pending"/);
  assert.match(o13, /Number\(result\.rows\[0\]\.accounts\) !== 0/);
  assert.match(o13, /counts\.accountDiscoveryCalls !== 0/);
  assert.match(o13, /counts\.publicationCalls !== 0/);
  assert.doesNotMatch(o13, /\bUPDATE\b|\bINSERT\b|\bDELETE\b|status\s*=\s*["']active["']/);
});

test("evidence contract requires exact Gates, O01-O22, counts, scans and zero residuals", () => {
  const base = gate.baseEvidence({
    branch: gate.BRANCH,
    sha: SHA,
    runAttempt: 1
  });
  assert.equal(base.externalRenderCalls, 0);
  const evidence = passedEvidence();
  assert.equal(gate.evidenceSafe(evidence), true);
  assert.equal(evidence.externalRenderCalls, 0);

  for (const secretScan of [
    { status: "passed", historicPhysicalPassed: false, oauthEvidencePassed: true },
    { status: "passed", historicPhysicalPassed: true, oauthEvidencePassed: false },
    { status: "not_run", historicPhysicalPassed: true, oauthEvidencePassed: true },
    { status: "failed", historicPhysicalPassed: true, oauthEvidencePassed: true }
  ]) {
    assert.equal(gate.evidenceSafe({ ...evidence, secretScan }), false);
  }
  assert.equal(gate.evidenceSafe({
    ...evidence,
    counts: { ...gate.EXPECTED_COUNTS, credentialWrites: 1 }
  }), false);
  assert.equal(gate.evidenceSafe({
    ...evidence,
    residuals: { ...gate.zeroResiduals(), timers: 1 }
  }), false);
  assert.equal(gate.evidenceSafe({
    ...evidence,
    cleanup: { ...evidence.cleanup, cleanupCompleted: false }
  }), false);
  assert.equal(gate.evidenceSafe({
    ...evidence,
    substeps: evidence.substeps.map((entry) => entry.id === "O22"
      ? { ...entry, status: "failed" }
      : entry)
  }), false);
  assert.equal(gate.evidenceSafe({
    ...evidence,
    state: crypto.randomBytes(24).toString("base64url")
  }), false);
});

test("cleanupFailureProvenance 1: an integral first cleanup attempt produces null", async () => {
  const tracker = gate.createCleanupAttemptTracker();
  for (const operation of [
    "network_guard_restore",
    "http_server_close",
    "state_envelope_destroy",
    "vault_destroy",
    "postgres_cleanup_call"
  ]) {
    await tracker.capture(operation, async () => true);
  }
  assert.equal(cleanupSnapshot(tracker), null);
  assert.equal(gate.validCleanupFailureProvenance(null), true);
  assert.equal(gate.baseEvidence({
    branch: gate.BRANCH,
    sha: SHA,
    runAttempt: 1
  }).cleanupFailureProvenance, null);
});

for (const [number, operation] of [
  [2, "network_guard_restore"],
  [3, "http_server_close"],
  [4, "state_envelope_destroy"],
  [5, "vault_destroy"],
  [6, "postgres_cleanup_call"]
]) {
  test(`cleanupFailureProvenance ${number}: a thrown cleanup error records ${operation}`, async () => {
    const tracker = gate.createCleanupAttemptTracker();
    const error = new Error("fixture cleanup failure");
    error.code = `social_3b0_fixture_${operation}_failed`;
    await tracker.capture(operation, async () => { throw error; });
    const provenance = cleanupSnapshot(tracker, {
      postgresCleanupCompleted: operation === "postgres_cleanup_call" ? null : true
    });
    assert.equal(provenance.operation, operation);
    assert.equal(provenance.causalCode, error.code);
    assert.equal(provenance.cleanupErrorCount, 1);
    assert.deepEqual(
      Object.keys(provenance).sort(),
      gate.CLEANUP_FAILURE_PROVENANCE_KEYS
    );
    assert.equal(gate.validCleanupFailureProvenance(provenance), true);
  });
}

test("cleanupFailureProvenance 7: an incomplete PostgreSQL result has its closed cause", () => {
  const provenance = cleanupSnapshot(gate.createCleanupAttemptTracker(), {
    postgresCleanupCompleted: false
  });
  assert.equal(provenance.operation, "postgres_cleanup_result");
  assert.equal(
    provenance.causalCode,
    "social_3b0_postgres_cleanup_incomplete"
  );
  assert.equal(provenance.cleanupErrorCount, 0);
  assert.equal(gate.validCleanupFailureProvenance(provenance), true);
});

test("cleanupFailureProvenance 8: a nonzero residual has its closed validation cause", () => {
  const firstAttemptResiduals = { ...gate.zeroResiduals(), timers: 1 };
  const provenance = cleanupSnapshot(gate.createCleanupAttemptTracker(), {
    firstAttemptResiduals,
    firstAttemptSyntheticMaterialsCleared: false
  });
  assert.equal(provenance.operation, "residual_validation");
  assert.equal(
    provenance.causalCode,
    "social_3b0_cleanup_residuals_nonzero"
  );
  assert.equal(provenance.cleanupErrorCount, 0);
  assert.equal(provenance.firstAttemptSyntheticMaterialsCleared, false);
  assert.deepEqual(provenance.firstAttemptResiduals, firstAttemptResiduals);
});

test("cleanupFailureProvenance 9: every residual is observed in isolation", () => {
  const residualKeys = Object.keys(gate.zeroResiduals());
  assert.equal(residualKeys.length, 10);
  for (const key of residualKeys) {
    const firstAttemptResiduals = { ...gate.zeroResiduals(), [key]: 1 };
    const provenance = cleanupSnapshot(gate.createCleanupAttemptTracker(), {
      firstAttemptResiduals
    });
    assert.equal(provenance.operation, "residual_validation", key);
    assert.equal(provenance.firstAttemptResiduals[key], 1, key);
    assert.deepEqual(
      Object.entries(provenance.firstAttemptResiduals)
        .filter(([, value]) => value !== 0),
      [[key, 1]],
      key
    );
  }
});

test("cleanupFailureProvenance 10: the first thrown operation wins", async () => {
  const tracker = gate.createCleanupAttemptTracker();
  const first = Object.assign(new Error("first"), {
    code: "social_3b0_first_cleanup_failed"
  });
  const later = Object.assign(new Error("later"), {
    code: "social_3b0_later_cleanup_failed"
  });
  await tracker.capture("network_guard_restore", async () => { throw first; });
  await tracker.capture("http_server_close", async () => { throw later; });
  const provenance = cleanupSnapshot(tracker);
  assert.equal(provenance.operation, "network_guard_restore");
  assert.equal(provenance.causalCode, first.code);
});

test("cleanupFailureProvenance 11: all thrown cleanup operations are counted", async () => {
  const tracker = gate.createCleanupAttemptTracker();
  const thrownOperations = [
    "network_guard_restore",
    "http_server_close",
    "state_envelope_destroy",
    "vault_destroy",
    "postgres_cleanup_call"
  ];
  for (const operation of thrownOperations) {
    await tracker.capture(operation, async () => {
      throw new Error("count-only fixture");
    });
  }
  assert.equal(cleanupSnapshot(tracker, {
    postgresCleanupCompleted: null
  }).cleanupErrorCount, thrownOperations.length);
});

test("cleanupFailureProvenance 12: messages and stacks never enter evidence", async () => {
  const marker = "sensitive-cleanup-message-and-stack";
  const tracker = gate.createCleanupAttemptTracker();
  const error = new Error(marker);
  error.code = "not a closed code";
  error.stack = `${marker}\nprivate stack material`;
  await tracker.capture("vault_destroy", async () => { throw error; });
  const provenance = cleanupSnapshot(tracker);
  const serialized = JSON.stringify(provenance);
  assert.equal(provenance.causalCode, "social_3b0_cleanup_operation_failed");
  assert.equal(serialized.includes(marker), false);
  assert.equal(serialized.includes("private stack material"), false);
  assert.deepEqual(
    Object.keys(provenance).sort(),
    gate.CLEANUP_FAILURE_PROVENANCE_KEYS
  );
});

test("cleanupFailureProvenance rejects open schemas and unsafe scalar or residual values", () => {
  const valid = cleanupProvenance();
  assert.equal(gate.validCleanupFailureProvenance(valid), true);
  const missing = { ...valid };
  delete missing.operation;
  const missingResidual = { ...valid.firstAttemptResiduals };
  delete missingResidual.timers;
  const invalid = [
    missing,
    { ...valid, unexpected: 0 },
    { ...valid, operation: "unknown_cleanup" },
    { ...valid, causalCode: "not a closed code" },
    { ...valid, cleanupErrorCount: -1 },
    { ...valid, cleanupErrorCount: 1.5 },
    { ...valid, cleanupErrorCount: "1" },
    { ...valid, cleanupErrorCount: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid, postgresCleanupCompleted: "true" },
    { ...valid, firstAttemptSyntheticMaterialsCleared: 1 },
    { ...valid, firstAttemptResiduals: missingResidual },
    { ...valid, firstAttemptResiduals: { ...valid.firstAttemptResiduals, extra: 0 } },
    { ...valid, firstAttemptResiduals: { ...valid.firstAttemptResiduals, timers: -1 } },
    { ...valid, firstAttemptResiduals: { ...valid.firstAttemptResiduals, timers: 0.5 } },
    { ...valid, firstAttemptResiduals: { ...valid.firstAttemptResiduals, timers: "0" } },
    {
      ...valid,
      firstAttemptResiduals: {
        ...valid.firstAttemptResiduals,
        timers: Number.MAX_SAFE_INTEGER + 1
      }
    }
  ];
  for (const candidate of invalid) {
    assert.equal(gate.validCleanupFailureProvenance(candidate), false);
  }
  const passed = passedEvidence();
  const missingEvidenceField = { ...passed };
  delete missingEvidenceField.cleanupFailureProvenance;
  assert.equal(gate.evidenceSafe(missingEvidenceField), false);
  assert.equal(gate.evidenceSafe({ ...passed, cleanupFailureDetail: null }), false);
});

test("cleanupFailureProvenance 13: compensating cleanup preserves first provenance", async () => {
  const firstAttemptResiduals = { ...gate.zeroResiduals(), timers: 2 };
  const provenance = cleanupProvenance({
    operation: "state_envelope_destroy",
    causalCode: "social_3b0_state_cleanup_failed",
    cleanupErrorCount: 2,
    postgresCleanupCompleted: true,
    firstAttemptResiduals
  });
  const workerEvidence = failedO22Evidence({
    cleanupFailureProvenance: provenance,
    cleanup: {
      cleanupCompleted: false,
      intermediateEvidenceRemoved: true,
      syntheticMaterialsCleared: true
    },
    residuals: firstAttemptResiduals
  });
  assert.equal(gate.evidenceSafe(workerEvidence), true);
  const supervised = await supervisedEvidenceFixture({
    workerEvidence,
    cleanupResult: zeroCleanup(),
    runId: "73213"
  });
  assert.equal(supervised.result.ok, false);
  assert.deepEqual(supervised.evidence.cleanupFailureProvenance, provenance);
  assert.equal(supervised.evidence.substeps[21].status, "failed");
  assert.equal(supervised.evidence.firstFailure.substep, "O22");
  assert.equal(supervised.evidence.cleanup.cleanupCompleted, true);
});

test("cleanupFailureProvenance 14: final zero residuals do not erase first residuals", async () => {
  const firstAttemptResiduals = { ...gate.zeroResiduals(), containers: 1 };
  const provenance = cleanupProvenance({
    operation: "residual_validation",
    causalCode: "social_3b0_cleanup_residuals_nonzero",
    cleanupErrorCount: 0,
    firstAttemptResiduals
  });
  const supervised = await supervisedEvidenceFixture({
    workerEvidence: failedO22Evidence({
      cleanupFailureProvenance: provenance,
      cleanup: {
        cleanupCompleted: false,
        intermediateEvidenceRemoved: true,
        syntheticMaterialsCleared: true
      },
      residuals: firstAttemptResiduals
    }),
    cleanupResult: zeroCleanup(),
    runId: "73214"
  });
  assert.deepEqual(supervised.evidence.residuals, gate.zeroResiduals());
  assert.deepEqual(
    supervised.evidence.cleanupFailureProvenance.firstAttemptResiduals,
    firstAttemptResiduals
  );
});

test("cleanupFailureProvenance 15: O22 remains failed after its first attempt fails", () => {
  const failed = failedO22Evidence();
  const passedO22 = failed.substeps.map((entry) => entry.id === "O22"
    ? { ...entry, status: "passed" }
    : entry);
  assert.equal(gate.evidenceSafe(failed), true);
  assert.equal(failed.substeps[21].status, "failed");
  assert.equal(failed.firstFailure.substep, "O22");
  assert.notEqual(failed.cleanupFailureProvenance, null);
  assert.equal(gate.evidenceSafe({
    ...failed,
    cleanupFailureProvenance: null
  }), false);
  assert.equal(gate.evidenceSafe({
    ...failed,
    substeps: passedO22
  }), false);
  assert.equal(gate.evidenceSafe({
    ...failed,
    firstFailure: gate.closedFirstFailure({
      phase: gate.PHASE,
      substep: "O22",
      lastCompletedSubstep: "O21",
      causalCode: "social_3b0_cleanup_operation_failed"
    }),
    substeps: passedO22,
    cleanupFailureProvenance: null
  }), false);
});

test("cleanupFailureProvenance 16: an earlier functional failure keeps passed O22", () => {
  const evidence = passedEvidence();
  evidence.status = "failed";
  evidence.firstFailure = gate.closedFirstFailure({
    phase: gate.PHASE,
    substep: "O13",
    lastCompletedSubstep: "O12",
    causalCode: "social_3b0_fixture_functional_failure"
  });
  evidence.substeps = Object.freeze(evidence.substeps.map((entry, index) =>
    Object.freeze(index === 12
      ? { ...entry, status: "failed" }
      : index > 12 && index < 21
        ? { ...entry, status: "skipped" }
        : entry)
  ));
  assert.equal(evidence.substeps[21].status, "passed");
  assert.equal(evidence.cleanupFailureProvenance, null);
  assert.equal(gate.evidenceSafe(evidence), true);
});

test("cleanupFailureProvenance 17: an integral passed run requires null provenance", () => {
  const evidence = passedEvidence();
  assert.equal(evidence.status, "passed");
  assert.equal(evidence.firstFailure, null);
  assert.equal(evidence.substeps[21].status, "passed");
  assert.equal(evidence.cleanupFailureProvenance, null);
  assert.equal(gate.evidenceSafe(evidence), true);
  assert.equal(gate.evidenceSafe({
    ...evidence,
    cleanupFailureProvenance: cleanupProvenance()
  }), false);
});

test("cleanupFailureProvenance 18: sanitized fallback retains only the closed schema", async () => {
  const marker = "sensitive cleanup exception detail";
  const invalidWorkerEvidence = failedO22Evidence();
  invalidWorkerEvidence.cleanupFailureProvenance = {
    ...invalidWorkerEvidence.cleanupFailureProvenance,
    message: marker,
    stack: marker
  };
  assert.equal(gate.evidenceSafe(invalidWorkerEvidence), false);
  const supervised = await supervisedEvidenceFixture({
    workerEvidence: invalidWorkerEvidence,
    cleanupResult: zeroCleanup(),
    runId: "73218"
  });
  const base = gate.baseEvidence({
    branch: gate.BRANCH,
    sha: SHA,
    runAttempt: 1
  });
  assert.equal(gate.evidenceSafe(supervised.evidence), true);
  assert.deepEqual(Object.keys(supervised.evidence).sort(), Object.keys(base).sort());
  assert.equal(supervised.evidence.cleanupFailureProvenance, null);
  assert.equal(supervised.evidence.substeps[21].status, "skipped");
  assert.equal(supervised.serialized.includes(marker), false);
  assert.equal("message" in supervised.evidence, false);
  assert.equal("stack" in supervised.evidence, false);
});

test("external render evidence rejects missing, malformed, nonzero and aliased counters", () => {
  const evidence = passedEvidence();
  const missing = { ...evidence };
  delete missing.externalRenderCalls;
  assert.equal(gate.evidenceSafe(missing), false);

  for (const externalRenderCalls of [
    null,
    "0",
    -1,
    1,
    Number.MAX_SAFE_INTEGER + 1
  ]) {
    assert.equal(gate.evidenceSafe({
      ...evidence,
      externalRenderCalls
    }), false);
  }

  assert.equal(gate.evidenceSafe({
    ...missing,
    externalRendererCalls: 0
  }), false);
  assert.equal(gate.evidenceSafe({
    ...evidence,
    renderCalls: 0
  }), false);
});

test("closed first failure preserves observed process facts without sensitive fields", () => {
  const failure = gate.closedFirstFailure({
    job: "linux_physical_gates",
    phase: "backup_restore",
    lastCompletedSubstep: "vault",
    causalCode: "backup_external_tool_failed",
    externalProcessStarted: true,
    exitCode: 7,
    signal: null,
    timedOut: false
  });
  assert.deepEqual(Object.keys(failure).sort(), [
    "causalCode",
    "exitCode",
    "externalProcessStarted",
    "job",
    "lastCompletedSubstep",
    "phase",
    "signal",
    "substep",
    "timedOut"
  ].sort());
  assert.equal(failure.externalProcessStarted, true);
  assert.equal(failure.exitCode, 7);
  assert.equal(JSON.stringify(failure).includes("stdout"), false);
  assert.equal(JSON.stringify(failure).includes("stderr"), false);
});

test("historic Gates 2-4 preserve their sanitized failing and last completed substeps", () => {
  const cases = [
    {
      firstPhase: "rls_roles",
      lastCompletedPhase: "rls_runtime_attributes_text_resolution_reproduction",
      firstCode: "postgres_insufficient_privilege",
      evidenceKey: "rlsFailureProvenance",
      provenance: {
        substep: "rls_cross_tenant_write",
        causalCode: "postgres_insufficient_privilege"
      },
      expectedSubstep: "rls_cross_tenant_write",
      expectedLast: "rls_runtime_attributes_text_resolution_reproduction"
    },
    {
      firstPhase: "concurrency_oauth_idempotency",
      lastCompletedPhase: "rls_roles",
      firstCode: "gate3_type_error",
      evidenceKey: "gate3FailureProvenance",
      provenance: {
        operation: "base",
        substep: "B2",
        operationClass: "postgres_transaction",
        causalCode: "gate3_type_error",
        lastCompletedSubstep: "B1",
        externalProcessStarted: false,
        exitCode: null,
        signal: null
      },
      expectedSubstep: "B2",
      expectedLast: "B1"
    },
    {
      firstPhase: "vault",
      lastCompletedPhase: "concurrency_oauth_idempotency",
      firstCode: "gate4_type_error",
      evidenceKey: "gate4FailureProvenance",
      provenance: {
        operation: "base",
        substep: "V02",
        operationClass: "memory_crypto",
        causalCode: "gate4_type_error",
        lastCompletedSubstep: "V01",
        externalProcessStarted: false,
        exitCode: null,
        signal: null
      },
      expectedSubstep: "V02",
      expectedLast: "V01"
    }
  ];
  for (const item of cases) {
    const details = gate.historicFailureDetails({
      historic: historicGate,
      evidence: {
        firstFailure: { phase: item.firstPhase, code: item.firstCode },
        [item.evidenceKey]: item.provenance
      },
      firstPhase: item.firstPhase,
      lastCompletedPhase: item.lastCompletedPhase,
      backupRestoreFailureProvenance: null
    });
    assert.equal(details.substep, item.expectedSubstep);
    assert.equal(details.lastCompletedSubstep, item.expectedLast);
    const closed = gate.closedFirstFailure({
      job: "linux_physical_gates",
      phase: item.firstPhase,
      substep: details.substep,
      lastCompletedSubstep: details.lastCompletedSubstep,
      causalCode: details.causalCode,
      externalProcessStarted: details.externalProcessStarted,
      exitCode: details.exitCode,
      signal: details.signal,
      timedOut: false
    });
    assert.equal(closed.substep, item.expectedSubstep);
    assert.equal(closed.lastCompletedSubstep, item.expectedLast);
  }
});

test("blocked response body uses one timer, aborts, cancels and releases without a residual", async () => {
  const appMaterial = crypto.randomBytes(32);
  const config = loadInstagramOAuthConfig(Object.freeze({
    SOCIAL_INSTAGRAM_ENABLED: "true",
    SOCIAL_EXTERNAL_CONNECTION_ENABLED: "true",
    SOCIAL_EXTERNAL_PUBLICATION_ENABLED: "false",
    INSTAGRAM_APP_ID: "73190",
    INSTAGRAM_APP_SECRET: appMaterial.toString("base64url"),
    INSTAGRAM_OAUTH_REDIRECT_URI,
    INSTAGRAM_GRAPH_API_VERSION: "v24.0"
  }));
  try {
    const proof = await gate.runBlockedBodyProof(config);
    assert.deepEqual(proof, { active: 0, clearCalls: 1, setCalls: 1 });
  } finally {
    appMaterial.fill(0);
  }
});

test("timeout owns and terminates the complete Linux process group without a residual", async () => {
  const signals = [];
  let groupAlive = true;
  let spawnOptions;
  let child;
  const spawnImpl = (_executable, _args, options) => {
    spawnOptions = options;
    child = new EventEmitter();
    child.pid = 4242;
    child.kill = () => assert.fail("direct child kill bypassed the process group");
    queueMicrotask(() => child.emit("spawn"));
    return child;
  };
  const processKill = (target, signal) => {
    assert.equal(target, -4242);
    if (signal === 0) {
      if (groupAlive) return true;
      const error = new Error("missing process group");
      error.code = "ESRCH";
      throw error;
    }
    signals.push(signal);
    if (signal === "SIGKILL") {
      groupAlive = false;
      queueMicrotask(() => child.emit("close", null, "SIGKILL"));
    }
    return true;
  };
  const result = await gate.childOnce(process.execPath, ["synthetic-worker"], {
    spawnImpl,
    timeoutMs: 1,
    killGraceMs: 1,
    ownsProcessGroup: true,
    platform: "linux",
    processKill
  });
  assert.equal(spawnOptions.detached, true);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(result.started, true);
  assert.equal(result.timedOut, true);
  assert.equal(result.signal, "SIGKILL");
  assert.equal(result.processResiduals, 0);
});

test("application firewall refuses http, Socket and fetch non-loopback before I/O and restores globals", async () => {
  const originalRequest = http.request;
  const originalConnect = net.Socket.prototype.connect;
  const originalFetch = globalThis.fetch;
  const loopbackServer = net.createServer((socket) => socket.end());
  await new Promise((resolve, reject) => {
    loopbackServer.once("error", reject);
    loopbackServer.listen(0, "127.0.0.1", resolve);
  });
  const guard = gate.installApplicationNetworkGuard(new Set([
    "127.0.0.1",
    "172.18.0.2"
  ]));
  try {
    const address = loopbackServer.address();
    await new Promise((resolve, reject) => {
      const socket = net.createConnection({
        host: "127.0.0.1",
        port: address.port
      });
      socket.once("connect", () => {
        socket.end();
        resolve();
      });
      socket.once("error", reject);
    });
    assert.throws(
      () => http.request({ host: "198.51.100.1", port: 80, path: "/" }),
      (error) => error?.code === "social_3b0_non_loopback_network_refused"
    );
    const socket = new net.Socket();
    assert.throws(
      () => socket.connect(80, "203.0.113.1"),
      (error) => error?.code === "social_3b0_non_loopback_network_refused"
    );
    if (typeof originalFetch === "function") {
      await assert.rejects(
        globalThis.fetch("https://example.invalid/"),
        (error) => error?.code === "social_3b0_non_loopback_network_refused"
      );
    }
    const observed = guard.snapshot();
    assert.equal(observed.externalConnections, 0);
    assert.equal(observed.deniedAttempts, typeof originalFetch === "function" ? 3 : 2);
  } finally {
    guard.restore();
    await new Promise((resolve) => loopbackServer.close(resolve));
  }
  assert.equal(http.request, originalRequest);
  assert.equal(net.Socket.prototype.connect, originalConnect);
  assert.equal(globalThis.fetch, originalFetch);
});

test("worker crash still publishes exactly four sanitized files after measured cleanup", async () => {
  const runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), "social-3b0-crash-"));
  const directory = path.join(runnerTemp, gate.ARTIFACT_DIRECTORY);
  const outputPath = path.join(directory, gate.EVIDENCE_FILE);
  const processStatusPath = path.join(directory, gate.PROCESS_STATUS_FILE);
  try {
    const result = await gate.superviseInstagramOAuthPhysicalGate({
      runnerTemp,
      outputPath,
      processStatusPath,
      repositoryRoot: path.join(__dirname, ".."),
      environment: environment({ RUNNER_TEMP: runnerTemp }),
      spawnImpl: fakeChild({ exitCode: 19 }),
      cleanupImpl: async () => zeroCleanup(),
      timeoutMs: 1000
    });
    assert.equal(result.ok, false);
    assert.deepEqual(fs.readdirSync(directory).sort(), [
      gate.EVIDENCE_FILE,
      gate.EVIDENCE_HASH_FILE,
      gate.PROCESS_STATUS_FILE,
      gate.PROCESS_STATUS_HASH_FILE
    ].sort());
    const evidence = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    assert.equal(gate.evidenceSafe(evidence), true);
    assert.equal(evidence.status, "failed");
    assert.equal(evidence.firstFailure.externalProcessStarted, true);
    assert.equal(evidence.firstFailure.exitCode, 19);
    assert.equal(evidence.cleanup.cleanupCompleted, true);
    assert.deepEqual(evidence.residuals, gate.zeroResiduals());
    assert.equal(evidence.substeps[21].status, "skipped");
    assert.equal(evidence.cleanupFailureProvenance, null);
    assert.equal(evidence.externalRenderCalls, 0);
    gate.verifySidecar(outputPath, path.join(directory, gate.EVIDENCE_HASH_FILE));
    gate.verifySidecar(
      processStatusPath,
      path.join(directory, gate.PROCESS_STATUS_HASH_FILE)
    );
  } finally {
    fs.rmSync(runnerTemp, { recursive: true, force: true });
  }
});

test("compensating cleanup failure downgrades the run without rewriting worker O22", async () => {
  const runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), "social-3b0-cleanup-"));
  const directory = path.join(runnerTemp, gate.ARTIFACT_DIRECTORY);
  const outputPath = path.join(directory, gate.EVIDENCE_FILE);
  const processStatusPath = path.join(directory, gate.PROCESS_STATUS_FILE);
  let wroteWorkerEvidence = false;
  let workerWriteError = null;
  const spawnImpl = (_executable, _args, options) => {
    const child = new EventEmitter();
    child.kill = (signal) => {
      queueMicrotask(() => child.emit("close", null, signal));
      return true;
    };
    queueMicrotask(() => {
      try {
        const evidence = passedEvidence();
        gate.writePayload(
          path.join(options.env.RUNNER_TEMP, gate.ARTIFACT_DIRECTORY,
            gate.EVIDENCE_FILE),
          path.join(options.env.RUNNER_TEMP, gate.ARTIFACT_DIRECTORY,
            gate.EVIDENCE_HASH_FILE),
          evidence
        );
        wroteWorkerEvidence = true;
        child.emit("spawn");
        child.emit("close", 0, null);
      } catch (error) {
        workerWriteError = error;
        child.emit("error", error);
      }
    });
    return child;
  };
  try {
    const result = await gate.superviseInstagramOAuthPhysicalGate({
      runnerTemp,
      outputPath,
      processStatusPath,
      repositoryRoot: path.join(__dirname, ".."),
      environment: environment({ RUNNER_TEMP: runnerTemp, GITHUB_RUN_ID: "73193" }),
      spawnImpl,
      cleanupImpl: async () => Object.freeze({
        cleanupCompleted: false,
        artifactDirectoryRemoved: false,
        intermediateEvidenceRemoved: true,
        residuals: Object.freeze({ ...gate.zeroResiduals(), timers: 1 })
      }),
      timeoutMs: 1000
    });
    if (workerWriteError) throw workerWriteError;
    assert.equal(wroteWorkerEvidence, true);
    assert.equal(result.ok, false);
    const evidence = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    assert.equal(gate.evidenceSafe(evidence), true);
    assert.equal(evidence.status, "failed");
    assert.equal(evidence.firstFailure.causalCode, "social_3b0_cleanup_incomplete");
    assert.equal(evidence.cleanup.cleanupCompleted, false);
    assert.equal(evidence.residuals.timers, 1);
    assert.equal(evidence.substeps[21].status, "passed");
    assert.equal(evidence.cleanupFailureProvenance, null);
    assert.equal(evidence.externalRenderCalls, 0);
  } finally {
    fs.rmSync(runnerTemp, { recursive: true, force: true });
  }
});

test("spawn refusal records that no worker process started and still closes the artifact", async () => {
  const runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), "social-3b0-spawn-"));
  const directory = path.join(runnerTemp, gate.ARTIFACT_DIRECTORY);
  const outputPath = path.join(directory, gate.EVIDENCE_FILE);
  try {
    await gate.superviseInstagramOAuthPhysicalGate({
      runnerTemp,
      outputPath,
      processStatusPath: path.join(directory, gate.PROCESS_STATUS_FILE),
      repositoryRoot: path.join(__dirname, ".."),
      environment: environment({ RUNNER_TEMP: runnerTemp, GITHUB_RUN_ID: "73191" }),
      spawnImpl: fakeChild({ emitSpawn: false }),
      cleanupImpl: async () => zeroCleanup(),
      timeoutMs: 1000
    });
    const evidence = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    assert.equal(evidence.firstFailure.externalProcessStarted, false);
    assert.equal(evidence.firstFailure.exitCode, null);
    assert.equal(evidence.firstFailure.timedOut, false);
  } finally {
    fs.rmSync(runnerTemp, { recursive: true, force: true });
  }
});

test("historic Gate failure preserves its first cause and never starts the OAuth contract", async () => {
  const runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), "social-3b0-historic-"));
  const directory = path.join(runnerTemp, gate.ARTIFACT_DIRECTORY);
  fs.mkdirSync(directory, { mode: 0o700 });
  const outputPath = path.join(directory, gate.EVIDENCE_FILE);
  const provenance = Object.freeze({
    operation: "restore",
    substep: "bundle_authentication",
    boundary: "before_transport",
    causalCode: "backup_bundle_authentication_failed",
    externalTransportProcessStarted: false,
    substepExact: true
  });
  let oauthCalled = false;
  try {
    const result = await gate.runInstagramOAuthPhysicalGate({
      runnerTemp,
      outputPath,
      repositoryRoot: path.join(__dirname, ".."),
      environment: environment({ RUNNER_TEMP: runnerTemp, GITHUB_RUN_ID: "73192" }),
      runHistoricPhysicalGates: async () => Object.freeze({
        ok: false,
        gates1To5: Object.freeze(gate.GATE_DEFINITIONS.map((entry, index) =>
          Object.freeze({ ...entry, status: index < 4 ? "passed" : "failed" })
        )),
        backupRestoreFailureProvenance: provenance,
        historicSecretScanPassed: true,
        processResiduals: 0,
        firstFailure: gate.closedFirstFailure({
          job: "linux_physical_gates",
          phase: "backup_restore",
          lastCompletedSubstep: "vault",
          causalCode: "backup_bundle_authentication_failed",
          externalProcessStarted: false,
          exitCode: 1,
          timedOut: false
        }),
        intermediateEvidenceRemoved: true
      }),
      runPhysicalOAuthContract: async () => {
        oauthCalled = true;
        assert.fail("OAuth contract ran after a historic Gate failure");
      }
    });
    assert.equal(result.ok, false);
    assert.equal(oauthCalled, false);
    const evidence = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    assert.equal(evidence.firstFailure.phase, "backup_restore");
    assert.equal(
      evidence.firstFailure.causalCode,
      "backup_bundle_authentication_failed"
    );
    assert.equal(evidence.firstFailure.lastCompletedSubstep, "vault");
    assert.deepEqual(evidence.backupRestoreFailureProvenance, provenance);
    assert.equal(evidence.substeps.every((entry) => entry.status === "skipped"), true);
    assert.equal(evidence.externalRenderCalls, 0);
  } finally {
    fs.rmSync(runnerTemp, { recursive: true, force: true });
  }
});

test("source keeps the physical O01-O22 proofs and closed cleanup interfaces", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "scripts", "social-3b0-linux-physical-gate.js"),
    "utf8"
  );
  for (const id of gate.SUBSTEP_IDS.slice(0, 21)) {
    assert.match(source, new RegExp(`ledger\\.run\\(\"${id}\"`));
  }
  assert.ok(source.includes("ledger.passCleanup()"));
  assert.ok(source.includes("ledger.failCleanup(cleanupFailure)"));
  for (const marker of [
    "createLinuxPostgres",
    "createInstagramOAuthRouter",
    "openForCallback",
    "relrowsecurity AND relforcerowsecurity",
    "withDecryptedCredential",
    "cancelled_at",
    "containsSyntheticMarkerInTree",
    "scanDataDirectoryMarkers",
    "installApplicationNetworkGuard",
    "social_3b0_non_loopback_network_refused",
    "external.render = network.externalConnections",
    "secret_scan",
    "cleanupInstagramOAuthPhysicalGate",
    "artifactDirectoryRemoved"
  ]) assert.match(source, new RegExp(marker));
  for (const marker of [
    "detached: ownsProcessGroup",
    "ownsProcessGroup: false",
    "processKill(-child.pid, signal)",
    "child.processResiduals",
    "postgres.materials",
    "rememberSensitive"
  ]) assert.ok(source.includes(marker), marker);
});

const EXACT_0004_ARTIFACT_FILES = Object.freeze([
  "evidence.json",
  "evidence.json.sha256",
  "process-status.json",
  "process-status.json.sha256"
]);

const EXACT_0004_DIRTY_WORKTREE_PATH =
  "tests/social-3b0-linux-physical-gate.test.js";
const EXACT_0004_DIRTY_WORKTREE_STATUS =
  ` M ${EXACT_0004_DIRTY_WORKTREE_PATH}\n`;

function exact0004FixtureWorktreeEnvironment(context, worktreeStatus) {
  assert.ok([
    "",
    EXACT_0004_DIRTY_WORKTREE_STATUS
  ].includes(worktreeStatus));
  const repositoryRoot = path.resolve(__dirname, "..");
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "social-3b0-exact-0004-worktree-")
  );
  context.after(() => {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  });
  const runGit = (arguments_, environment = process.env) => execFileSync(
    "git",
    arguments_,
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: environment
    }
  );
  const gitDirectory = runGit([
    "rev-parse",
    "--absolute-git-dir"
  ]).trim();
  const sourceIndex = path.resolve(repositoryRoot, runGit([
    "rev-parse",
    "--git-path",
    "index"
  ]).trim());
  const indexFile = path.join(fixtureRoot, "index");
  const worktree = path.join(fixtureRoot, "checkout");
  fs.mkdirSync(worktree, { mode: 0o700 });
  fs.copyFileSync(sourceIndex, indexFile);
  const fixtureEnvironment = Object.freeze({
    GIT_DIR: gitDirectory,
    GIT_INDEX_FILE: indexFile,
    GIT_WORK_TREE: worktree
  });
  const gitEnvironment = {
    ...process.env,
    ...fixtureEnvironment,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0"
  };
  runGit([
    "checkout-index",
    "--all",
    "--force",
    "--index"
  ], gitEnvironment);
  if (worktreeStatus !== "") {
    fs.appendFileSync(
      path.join(worktree, ...EXACT_0004_DIRTY_WORKTREE_PATH.split("/")),
      "\nexact0004 dirty worktree fixture\n"
    );
  }
  const observedStatus = runGit([
    "status",
    "--porcelain=v1",
    "--untracked-files=all"
  ], gitEnvironment).replace(/\r\n/g, "\n");
  assert.equal(observedStatus, worktreeStatus);
  return fixtureEnvironment;
}

function exact0004ProtocolFixture(context, environmentOverrides = {}) {
  const runnerTemp = fs.mkdtempSync(
    path.join(os.tmpdir(), "social-3b0-exact-0004-entry-")
  );
  context.after(() => {
    fs.rmSync(runnerTemp, { recursive: true, force: true });
  });
  const environment = {
    RUNNER_TEMP: runnerTemp,
    ENTRY_OUTCOME: "success",
    PHYSICAL_OUTCOME: "failure",
    CLEANUP_OUTCOME: "success",
    TRANSPORT_OUTCOME: "success",
    LEGACY_FINALIZE_OUTCOME: "success",
    FINALIZE_OUTCOME: "success",
    UPLOAD_OUTCOME: "success",
    SOCIAL_EXACT_POSTGRES_IMAGE: gate.IMAGE,
    SOCIAL_EXACT_BRANCH:
      "social/checkpoint-3b0-exact-0004-runner-linux-lifecycle-clean-worktree-fixture-20260821",
    GITHUB_SHA: "b".repeat(40),
    SOCIAL_EXACT_PARENT: "a".repeat(40),
    ...environmentOverrides
  };
  const files = realPostgresRunner.exact0004CheckpointPaths(environment);
  fs.mkdirSync(files.artifactDirectory, { recursive: true, mode: 0o700 });
  return Object.freeze({ environment, files });
}

function exact0004ReadCheckpoint(fixture) {
  return JSON.parse(fs.readFileSync(fixture.files.checkpoint, "utf8"));
}

function exact0004WriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(value) + "\n", { mode: 0o600 });
}

function exact0004LegacyArtifact(fixture, overrides = {}) {
  const addedKeys = new Set(
    realPostgresRunner.EXACT_0004_ARTIFACT_ADDED_KEYS
  );
  const legacyKeys = realPostgresRunner.EXACT_0004_ARTIFACT_KEYS.filter(
    (key) => !addedKeys.has(key) && key !== "lifecycleEvidence"
  );
  const artifact = Object.fromEntries(legacyKeys.map((key) => [key, null]));
  return Object.assign(artifact, {
    schemaVersion: 1,
    evidenceSchemaVersion: realPostgresRunner.EVIDENCE_SCHEMA_VERSION,
    branch: fixture.environment.SOCIAL_EXACT_BRANCH,
    commit: fixture.environment.GITHUB_SHA,
    parent: fixture.environment.SOCIAL_EXACT_PARENT,
    inventory: [...realPostgresRunner.EXACT_0004_INVENTORY],
    runner: "ubuntu-24.04",
    nodeVersion: process.version,
    postgresImageDigest: gate.IMAGE.slice(gate.IMAGE.lastIndexOf("@") + 1),
    postgresStarted: false,
    testProcessStarted: false,
    testFileLoaded: null,
    testsDiscovered: 0,
    testsPassed: 0,
    testsFailed: 0,
    planExactPassed: false,
    applyExactPassed: false,
    concurrencyPassed: false,
    rollbackPassed: false,
    profileBefore: "not_observed",
    profileAfter: "not_observed",
    firstFailure: null,
    runnerReached: null,
    gateValidated: null,
    nodeTestSpawnAttempted: null,
    nodeTestProcessCreated: null,
    cleanupStarted: false,
    failureDuringCleanup: false,
    failurePhase: null,
    safePermissionOrigin: null,
    safeLineBucket: null,
    cleanupCompleted: false,
    residuals: {
      containers: 0,
      volumes: 0,
      networks: 0,
      postgresProcesses: 0,
      auxiliaryProcesses: 0,
      listeners: 0,
      temp: 0,
      intermediateFiles: 0
    },
    ...realPostgresRunner.emptyExact0004Evidence(),
    ...overrides
  });
}

function exact0004GreenLegacyOverrides() {
  return {
    postgresStarted: true,
    testProcessStarted: true,
    testFileLoaded: true,
    testsDiscovered: 1,
    testsPassed: 1,
    testsFailed: 0,
    planExactPassed: true,
    applyExactPassed: true,
    concurrencyPassed: true,
    rollbackPassed: true,
    profileBefore: "0003",
    profileAfter: "0004",
    runnerReached: true,
    gateValidated: true,
    nodeTestSpawnAttempted: true,
    nodeTestProcessCreated: true,
    nodeTestExitCode: 0,
    nodeTestSignal: null,
    nodeTestTimedOut: false,
    tapStarted: true,
    tapTitleObserved: true,
    firstTestDiscovered: true,
    lastMainPhaseStarted: "reauthentication",
    lastMainPhaseCompleted: "reauthentication",
    lastExact0004SubphaseStarted: "final_snapshot",
    lastExact0004SubphaseCompleted: "final_snapshot",
    exact0004FailureSubphase: "not_reached",
    safeSqlState: "not_observed",
    safeErrorClass: "unknown",
    safeOperationClass: "unknown",
    planExactInvoked: true,
    planExactCompleted: true,
    applyExactInvoked: true,
    applyExactCompleted: true,
    databaseMutationAttempted: true,
    failureBeforeFirstMutation: false,
    conflictingNegativeAttempted: true,
    conflictingNegativePromiseOutcome: "rejected",
    conflictingNegativeObservedSqlState: "23514",
    conflictingNegativeFulfilledResultClass: "not_observed",
    conflictingNegativeAssertionMatched: true,
    conflictingNegativeRejectedBeforeAssertion: true
  };
}

function exact0004FunctionalFailureLegacyOverrides() {
  return {
    ...exact0004GreenLegacyOverrides(),
    testsPassed: 0,
    testsFailed: 1,
    nodeTestExitCode: 1,
    firstFailure: "functional_test_failure",
    firstFailureStage: "test_execution",
    lastMainPhaseStarted: "tenant_rls",
    lastMainPhaseCompleted: "runtime_permission_negatives",
    failureDuringCleanup: false,
    failurePhase: "tenant_rls",
    stderrCategory: "unknown",
    safeErrorCode: null,
    safeModuleName: null,
    safePermissionOrigin: "unknown",
    safeSourceBasename: null,
    safeLineBucket: "unknown"
  };
}

function exact0004ZeroCleanup(overrides = {}) {
  return {
    cleanupCompleted: true,
    containerResiduals: 0,
    volumeResiduals: 0,
    networkResiduals: 0,
    listenerResiduals: 0,
    temporaryRootResiduals: 0,
    ...overrides
  };
}

function exact0004WriteProcessStatus(fixture, overrides = {}) {
  const status = {
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdoutStored: false,
    stderrStored: false,
    ...overrides
  };
  exact0004WriteJson(fixture.files.processState, status);
  const statusFile = path.join(
    fixture.files.artifactDirectory,
    "process-status.json"
  );
  exact0004WriteJson(statusFile, status);
  const body = fs.readFileSync(statusFile);
  const digest = crypto.createHash("sha256").update(body).digest("hex");
  fs.writeFileSync(
    statusFile + ".sha256",
    digest + "  process-status.json\n",
    { mode: 0o600 }
  );
  return status;
}

function exact0004FinalizeFixture(fixture, {
  evidenceState = "valid",
  cleanupState = exact0004ZeroCleanup(),
  legacyOverrides = {},
  mutateLegacy = (value) => value,
  processStatus = {}
} = {}) {
  const legacy = mutateLegacy(exact0004LegacyArtifact(
    fixture,
    legacyOverrides
  ));
  exact0004WriteJson(
    path.join(fixture.files.artifactDirectory, "evidence.json"),
    legacy
  );
  if (evidenceState === "valid") {
    exact0004WriteJson(fixture.files.evidenceState, {
      evidenceSchemaVersion: realPostgresRunner.EVIDENCE_SCHEMA_VERSION
    });
  } else if (evidenceState === "partial") {
    exact0004WriteJson(fixture.files.evidenceState + ".tmp-fixture", {
      evidenceSchemaVersion: realPostgresRunner.EVIDENCE_SCHEMA_VERSION
    });
  } else {
    assert.equal(evidenceState, "missing");
  }
  exact0004WriteProcessStatus(fixture, processStatus);
  if (cleanupState !== null) {
    realPostgresRunner.writeExact0004CleanupState(
      cleanupState,
      fixture.environment
    );
  }
  realPostgresRunner.snapshotExact0004PhysicalTransport(
    fixture.environment
  );
  realPostgresRunner.finalizeExact0004Artifact(fixture.environment);
  return JSON.parse(fs.readFileSync(
    path.join(fixture.files.artifactDirectory, "evidence.json"),
    "utf8"
  ));
}

function exact0004LoadPhysicalScript(fixture) {
  realPostgresRunner.initializeExact0004PhysicalCheckpoint(
    fixture.environment
  );
  realPostgresRunner.enterExact0004PhysicalStep(fixture.environment);
  realPostgresRunner.attemptExact0004PhysicalScriptLoad(
    fixture.environment
  );
  return realPostgresRunner.startExact0004PhysicalObservation(
    fixture.environment
  );
}

function exact0004RunnerEvent(name, sequence, fields = {}) {
  return safeEventObject(name, sequence, fields);
}

function exact0004AppendRunnerEvents(observation, events) {
  for (const event of events) {
    assert.equal(
      observation.safeEvent(event.event, null, event),
      true,
      event.event
    );
  }
}

function exact0004CreatedRunnerEvents() {
  return [
    exact0004RunnerEvent("runnerReached", 1, { runnerReached: true }),
    exact0004RunnerEvent("gateValidated", 2, { gateValidated: true }),
    exact0004RunnerEvent("nodeTestSpawnAttempted", 3, {
      nodeTestSpawnAttempted: true
    }),
    exact0004RunnerEvent("nodeTestProcessCreated", 4, {
      nodeTestProcessCreated: true
    })
  ];
}

function exact0004GreenRunnerEvents() {
  const green = exact0004GreenLegacyOverrides();
  const snapshotFields = Object.fromEntries([
    "lastMainPhaseStarted",
    "lastMainPhaseCompleted",
    ...realPostgresRunner.EXACT_0004_EVIDENCE_FIELDS
  ].map((key) => [key, green[key]]));
  return [
    ...exact0004CreatedRunnerEvents(),
    exact0004RunnerEvent("testFileLoaded", 5, { testFileLoaded: true }),
    exact0004RunnerEvent("tapStarted", 6, { tapStarted: true }),
    exact0004RunnerEvent("tapTitleObserved", 7, {
      tapTitleObserved: true
    }),
    exact0004RunnerEvent("firstTestDiscovered", 8, {
      firstTestDiscovered: true
    }),
    exact0004RunnerEvent("nodeTestTapSummary", 9, {
      cancelled: 0,
      fail: 0,
      pass: 1,
      skipped: 0,
      tests: 1
    }),
    exact0004RunnerEvent("nodeTestExit", 10, {
      nodeTestExitCode: 0,
      nodeTestSignal: null,
      nodeTestTimedOut: false
    }),
    exact0004RunnerEvent("nodeTestClose", 11, {
      nodeTestCloseCode: 0,
      nodeTestCloseSignal: null
    }),
    exact0004RunnerEvent("physicalPhaseSnapshot", 12, {
      cleanupCompleted: true,
      cleanupStarted: true,
      physicalProfileBefore: EXACT_0004_PHYSICAL_PROFILE_BEFORE,
      ...snapshotFields
    })
  ];
}

function exact0004CompleteGreenPhysicalRoute(fixture) {
  const observation = exact0004LoadPhysicalScript(fixture);
  observation.postgresStartAttempted();
  observation.postgresStarted();
  observation.launcherSpawnAttempted();
  observation.launcherProcessCreated();
  exact0004AppendRunnerEvents(observation, exact0004GreenRunnerEvents());
  observation.launcherClosed(0, null, false);
  observation.auxiliaryResidualBeforeKill(0);
  observation.auxiliaryResidualFinal(0);
  observation.cleanupStarted();
  observation.cleanupCompleted(true, 0);
  return observation;
}

function exact0004VerifySidecar(directory, name) {
  const file = path.join(directory, name);
  const body = fs.readFileSync(file);
  const digest = crypto.createHash("sha256").update(body).digest("hex");
  assert.equal(
    fs.readFileSync(file + ".sha256", "utf8"),
    digest + "  " + name + "\n"
  );
}

function exact0004HasRawOutputKey(value) {
  if (value === null || typeof value !== "object") return false;
  const forbidden = new Set([
    "command",
    "environment",
    "path",
    "stack",
    "stdout",
    "stderr",
    "rawStdout",
    "rawStderr",
    "stdoutLines",
    "stderrLines"
  ]);
  return Object.entries(value).some(([key, entry]) =>
    forbidden.has(key) || exact0004HasRawOutputKey(entry)
  );
}

test("Exact-0004 entry evidence 01 classifies a skipped step as A not admitted", (context) => {
  const fixture = exact0004ProtocolFixture(context, {
    ENTRY_OUTCOME: "skipped",
    PHYSICAL_OUTCOME: "skipped"
  });
  realPostgresRunner.initializeExact0004PhysicalCheckpoint(
    fixture.environment
  );
  const artifact = exact0004FinalizeFixture(fixture, {
    evidenceState: "missing"
  });
  assert.equal(artifact.physicalStepAdmitted, false);
  assert.equal(artifact.physicalStepEntered, false);
  assert.equal(artifact.physicalScriptLoadAttempted, false);
  assert.equal(artifact.firstFailure, "physical_step_not_admitted");
  assert.equal(artifact.firstFailureStage, "physical_admission");

  const skippedWithMarkers = exact0004ProtocolFixture(context, {
    ENTRY_OUTCOME: "failure",
    PHYSICAL_OUTCOME: "skipped"
  });
  exact0004LoadPhysicalScript(skippedWithMarkers);
  const skippedWithMarkersArtifact = exact0004FinalizeFixture(
    skippedWithMarkers,
    { evidenceState: "missing" }
  );
  assert.equal(
    skippedWithMarkersArtifact.firstFailure,
    "physical_step_failure_evidence_insufficient"
  );

  const physicalRanAfterInitFailure = exact0004ProtocolFixture(context, {
    ENTRY_OUTCOME: "failure",
    PHYSICAL_OUTCOME: "failure"
  });
  exact0004LoadPhysicalScript(physicalRanAfterInitFailure);
  const physicalRanArtifact = exact0004FinalizeFixture(
    physicalRanAfterInitFailure,
    { evidenceState: "missing" }
  );
  assert.equal(physicalRanArtifact.physicalStepAdmitted, true);
  assert.equal(physicalRanArtifact.physicalStepEntered, true);
  assert.equal(
    physicalRanArtifact.firstFailure,
    "physical_step_failure_evidence_insufficient"
  );

  const admittedWithoutEntry = exact0004ProtocolFixture(context, {
    ENTRY_OUTCOME: "failure",
    PHYSICAL_OUTCOME: "failure"
  });
  realPostgresRunner.initializeExact0004PhysicalCheckpoint(
    admittedWithoutEntry.environment
  );
  const admittedWithoutEntryArtifact = exact0004FinalizeFixture(
    admittedWithoutEntry,
    { evidenceState: "missing" }
  );
  assert.equal(admittedWithoutEntryArtifact.physicalStepAdmitted, true);
  assert.equal(admittedWithoutEntryArtifact.physicalStepEntered, false);
  assert.equal(
    admittedWithoutEntryArtifact.firstFailure,
    "physical_step_failure_evidence_insufficient"
  );
});

test("Exact-0004 entry evidence 02 distinguishes B command resolution from C script load", (context) => {
  const commandFixture = exact0004ProtocolFixture(context);
  realPostgresRunner.initializeExact0004PhysicalCheckpoint(
    commandFixture.environment
  );
  realPostgresRunner.enterExact0004PhysicalStep(commandFixture.environment);
  const commandArtifact = exact0004FinalizeFixture(commandFixture, {
    evidenceState: "missing"
  });
  assert.equal(commandArtifact.physicalStepAdmitted, true);
  assert.equal(commandArtifact.physicalStepEntered, true);
  assert.equal(commandArtifact.physicalScriptLoadAttempted, false);
  assert.equal(
    commandArtifact.firstFailure,
    "physical_step_command_resolution_failed_prestart"
  );

  const loadFixture = exact0004ProtocolFixture(context);
  realPostgresRunner.initializeExact0004PhysicalCheckpoint(
    loadFixture.environment
  );
  realPostgresRunner.enterExact0004PhysicalStep(loadFixture.environment);
  realPostgresRunner.attemptExact0004PhysicalScriptLoad(
    loadFixture.environment
  );
  const loadArtifact = exact0004FinalizeFixture(loadFixture, {
    evidenceState: "missing"
  });
  assert.equal(loadArtifact.physicalScriptLoadAttempted, true);
  assert.equal(loadArtifact.physicalScriptLoaded, false);
  assert.equal(
    loadArtifact.firstFailure,
    "physical_step_script_load_failed_prestart"
  );
});

test("Exact-0004 entry evidence 03 classifies D when sudo spawn is attempted and refused", (context) => {
  const fixture = exact0004ProtocolFixture(context);
  const observation = exact0004LoadPhysicalScript(fixture);
  observation.launcherSpawnAttempted();
  observation.failure("physical_launcher_spawn");
  const artifact = exact0004FinalizeFixture(fixture, {
    evidenceState: "missing",
    legacyOverrides: {
      firstFailure: "exact0004_orchestration_failed",
      firstFailureStage: "composed_process"
    }
  });
  assert.equal(artifact.physicalLauncherSpawnAttempted, true);
  assert.equal(artifact.physicalLauncherProcessCreated, false);
  assert.equal(artifact.safeAuxiliaryProcessClass, "sudo");
  assert.equal(artifact.firstFailure, "physical_step_launcher_spawn_failed");
  assert.equal(artifact.firstFailureStage, "physical_launcher_spawn");
  assert.deepEqual(
    [artifact.testsDiscovered, artifact.testsPassed, artifact.testsFailed],
    [0, 0, 0]
  );
});

test("Exact-0004 entry evidence 04 classifies E with the created launcher result intact", (context) => {
  const fixture = exact0004ProtocolFixture(context);
  const observation = exact0004LoadPhysicalScript(fixture);
  observation.launcherSpawnAttempted();
  observation.launcherProcessCreated();
  observation.launcherClosed(0, null, false);
  const artifact = exact0004FinalizeFixture(fixture, {
    evidenceState: "missing",
    legacyOverrides: {
      firstFailure: "physical_step_no_evidence",
      firstFailureStage: "artifact"
    }
  });
  assert.equal(artifact.physicalLauncherProcessCreated, true);
  assert.equal(artifact.physicalLauncherExitCode, 0);
  assert.equal(artifact.physicalLauncherSignal, null);
  assert.equal(artifact.physicalLauncherTimedOut, false);
  assert.equal(
    artifact.firstFailure,
    "physical_step_process_created_before_evidence_failure"
  );
});

test("Exact-0004 entry evidence 05 persists pre-PostgreSQL evidence and classifies F partial transport", (context) => {
  const fixture = exact0004ProtocolFixture(context);
  exact0004LoadPhysicalScript(fixture);
  const beforePostgres = exact0004ReadCheckpoint(fixture);
  assert.equal(fs.statSync(fixture.files.checkpoint).isFile(), true);
  assert.equal(beforePostgres.physicalScriptLoaded, true);
  assert.equal(beforePostgres.postgresStartAttempted, false);
  assert.equal(beforePostgres.postgresStarted, false);
  const artifact = exact0004FinalizeFixture(fixture, {
    evidenceState: "partial"
  });
  assert.equal(artifact.physicalEvidenceState, "partial");
  assert.equal(artifact.firstFailure, "physical_step_evidence_writer_failed");
  assert.equal(artifact.firstFailureStage, "physical_evidence");
});

test("Exact-0004 entry evidence 06 finalizer maps absent physical evidence only to J", (context) => {
  const fixture = exact0004ProtocolFixture(context);
  exact0004LoadPhysicalScript(fixture);
  const artifact = exact0004FinalizeFixture(fixture, {
    evidenceState: "missing",
    legacyOverrides: {
      firstFailure: "physical_step_no_evidence",
      firstFailureStage: "artifact"
    }
  });
  assert.equal(artifact.physicalEvidenceState, "missing");
  assert.equal(
    artifact.firstFailure,
    "physical_step_failure_evidence_insufficient"
  );
  assert.equal(artifact.firstFailureStage, "physical_evidence");
  assert.deepEqual(
    [artifact.testsDiscovered, artifact.testsPassed, artifact.testsFailed],
    [0, 0, 0]
  );
});

test("Exact-0004 entry evidence 07 classifies G when an owned resource has no cleanup start", (context) => {
  const fixture = exact0004ProtocolFixture(context);
  const observation = exact0004LoadPhysicalScript(fixture);
  observation.launcherSpawnAttempted();
  observation.launcherProcessCreated();
  observation.launcherClosed(1, null, false);
  const artifact = exact0004FinalizeFixture(fixture, {
    cleanupState: null
  });
  assert.equal(artifact.cleanupStarted, false);
  assert.equal(artifact.cleanupCompleted, false);
  assert.equal(artifact.firstFailure, "physical_step_cleanup_not_started");
  assert.equal(artifact.firstFailureStage, "cleanup");
});

test("Exact-0004 entry evidence 08 records completed cleanup with every route residual zero", (context) => {
  const fixture = exact0004ProtocolFixture(context, {
    PHYSICAL_OUTCOME: "success"
  });
  const intermediate = collectSafeRunnerLines(
    exact0004GreenRunnerEvents().map((event) =>
      realPostgresRunner.safeEventLine(event)
    )
  );
  exact0004CompleteGreenPhysicalRoute(fixture);
  const artifact = exact0004FinalizeFixture(fixture, {
    legacyOverrides: exact0004GreenLegacyOverrides()
  });
  assert.equal(intermediate.protocolValid, true);
  assert.equal(intermediate.physicalProfileBefore,
    EXACT_0004_PHYSICAL_PROFILE_BEFORE);
  assert.equal(intermediate.profileBefore, "0003");
  assert.equal(intermediate.failureDuringCleanup, false);
  assert.equal(artifact.cleanupStarted, true);
  assert.equal(artifact.cleanupCompleted, true);
  assert.equal(artifact.cleanupFailure, null);
  assert.equal(artifact.profileBefore, intermediate.profileBefore);
  assert.equal(
    artifact.failureDuringCleanup,
    intermediate.failureDuringCleanup
  );
  assert.deepEqual(Object.values(artifact.residuals), Array(8).fill(0));
  assert.equal(artifact.firstFailure, null);
  assert.equal(realPostgresRunner.validExact0004Artifact(artifact), true);
});

test("Exact-0004 entry evidence 08b rejects a workflow-only profile before literal", (context) => {
  const fixture = exact0004ProtocolFixture(context, {
    PHYSICAL_OUTCOME: "success"
  });
  exact0004CompleteGreenPhysicalRoute(fixture);
  const artifact = exact0004FinalizeFixture(fixture, {
    legacyOverrides: exact0004GreenLegacyOverrides()
  });
  const physicalSnapshot = artifact.lifecycleEvidence.find(
    ({ event }) => event === "physicalPhaseSnapshot"
  );
  assert.ok(physicalSnapshot);
  assert.equal(
    physicalSnapshot.facts.physicalProfileBefore,
    EXACT_0004_PHYSICAL_PROFILE_BEFORE
  );
  assert.equal(artifact.profileBefore, "0003");
  assert.equal(realPostgresRunner.validExact0004Artifact({
    ...artifact,
    lifecycleEvidence: artifact.lifecycleEvidence.filter(
      ({ event }) => event !== "physicalPhaseSnapshot"
    ),
    profileBefore: "0003"
  }), false);
  assert.equal(realPostgresRunner.validExact0004Artifact({
    ...artifact,
    profileBefore: "not_observed"
  }), false);
});

test("Exact-0004 entry evidence 09 classifies H only for an owned launcher residual", (context) => {
  const fixture = exact0004ProtocolFixture(context);
  const observation = exact0004LoadPhysicalScript(fixture);
  observation.launcherSpawnAttempted();
  observation.launcherProcessCreated();
  observation.failure("cleanup");
  observation.cleanupStarted();
  const artifact = exact0004FinalizeFixture(fixture, {
    cleanupState: exact0004ZeroCleanup({ cleanupCompleted: false })
  });
  assert.equal(artifact.auxiliaryProcessCount, 1);
  assert.equal(artifact.auxiliaryProcessOwnedByRoute, true);
  assert.equal(artifact.residuals.auxiliaryProcesses, 1);
  assert.equal(
    artifact.firstFailure,
    "physical_step_cleanup_incomplete_with_owned_auxiliary_process"
  );
});

test("Exact-0004 entry evidence 10 keeps I external allowlisted identity outside route residuals", (context) => {
  const fixture = exact0004ProtocolFixture(context);
  const observation = exact0004LoadPhysicalScript(fixture);
  realPostgresRunner.updateExact0004Checkpoint({
    auxiliaryProcessCount: 1,
    safeAuxiliaryProcessClass: "github_runner_tool",
    auxiliaryProcessOwnedByRoute: false
  }, fixture.environment);
  observation.cleanupStarted();
  observation.cleanupCompleted(true, 0);
  const artifact = exact0004FinalizeFixture(fixture);
  assert.equal(artifact.physicalLauncherSpawnAttempted, false);
  assert.equal(artifact.physicalLauncherProcessCreated, false);
  assert.equal(artifact.auxiliaryProcessCount, 1);
  assert.equal(artifact.safeAuxiliaryProcessClass, "github_runner_tool");
  assert.equal(artifact.auxiliaryProcessOwnedByRoute, false);
  assert.equal(artifact.residuals.auxiliaryProcesses, 0);
  assert.equal(artifact.cleanupStarted, true);
  assert.equal(artifact.cleanupCompleted, true);
  assert.equal(
    artifact.firstFailure,
    "physical_step_auxiliary_process_not_owned_by_route"
  );
  assert.equal(artifact.firstFailureStage, "artifact");
  assert.ok(realPostgresRunner.EXACT_0004_PHYSICAL_FAILURE_CODES.includes(
    "physical_step_auxiliary_process_not_owned_by_route"
  ));
});

test("Exact-0004 entry evidence 11 preserves the first failure and separates later cleanup failure", (context) => {
  const fixture = exact0004ProtocolFixture(context);
  const observation = exact0004LoadPhysicalScript(fixture);
  observation.postgresStartAttempted();
  observation.postgresStarted();
  observation.launcherSpawnAttempted();
  observation.launcherProcessCreated();
  exact0004AppendRunnerEvents(observation, exact0004CreatedRunnerEvents());
  observation.launcherClosed(1, null, false);
  observation.auxiliaryResidualBeforeKill(0);
  observation.auxiliaryResidualFinal(0);
  observation.failure("test_execution");
  observation.cleanupStarted();
  observation.cleanupCompleted(false, 0);
  assert.equal(
    exact0004ReadCheckpoint(fixture).firstFailureStage,
    "test_execution"
  );
  const artifact = exact0004FinalizeFixture(fixture, {
    cleanupState: exact0004ZeroCleanup(),
    legacyOverrides: {
      ...exact0004FunctionalFailureLegacyOverrides(),
      profileBefore: "not_observed",
      profileAfter: "not_observed"
    }
  });
  assert.equal(artifact.firstFailure, "functional_test_failure");
  assert.equal(artifact.firstFailureStage, "test_execution");
  assert.equal(artifact.cleanupCompleted, true);
  assert.equal(artifact.cleanupFailure, "physical_cleanup_incomplete");
  assert.equal(artifact.failureDuringCleanup, true);
  assert.deepEqual(Object.values(artifact.residuals), Array(8).fill(0));
  assert.ok(realPostgresRunner.EXACT_0004_CLEANUP_FAILURE_CODES.includes(
    artifact.cleanupFailure
  ));
});

test("Exact-0004 entry evidence 12 accepted observer callbacks contain no raw stdout or stderr", () => {
  const accepted = [];
  const collector = realPostgresRunner.createSafeEventCollector({
    onAcceptedEvent: (name, snapshot) => accepted.push({ name, snapshot })
  });
  collector.push("stdout", Buffer.from(realPostgresRunner.safeEventLine({
    event: "runnerReached",
    evidenceSchemaVersion: realPostgresRunner.EVIDENCE_SCHEMA_VERSION,
    runnerReached: true,
    sequence: 1
  })));
  collector.push("stdout", Buffer.from("private stdout payload\n"));
  collector.push("stderr", Buffer.from("private stderr payload\n"));
  const facts = collector.finish();
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].name, "runnerReached");
  assert.equal(facts.physicalProfileBefore, "not_observed");
  assert.equal(facts.profileBefore, "not_observed");
  assert.equal(facts.failureDuringCleanup, null);
  assert.equal(exact0004HasRawOutputKey(accepted[0].snapshot), false);
  assert.equal(exact0004HasRawOutputKey(facts), false);
  assert.doesNotMatch(JSON.stringify(accepted), /private (stdout|stderr) payload/);
  assert.doesNotMatch(JSON.stringify(facts), /private (stdout|stderr) payload/);
});

test("Exact-0004 entry evidence 13 never transports a secret-like raw canary", () => {
  const secretCanary = "secret-canary-" + "7".repeat(48);
  const accepted = [];
  const collector = realPostgresRunner.createSafeEventCollector({
    onAcceptedEvent: (name, snapshot) => accepted.push({ name, snapshot })
  });
  collector.push("stdout", Buffer.from(realPostgresRunner.safeEventLine({
    event: "runnerReached",
    evidenceSchemaVersion: realPostgresRunner.EVIDENCE_SCHEMA_VERSION,
    runnerReached: true,
    sequence: 1
  })));
  collector.push("stdout", Buffer.from(secretCanary + "\n"));
  const facts = collector.finish();
  assert.equal(JSON.stringify(accepted).includes(secretCanary), false);
  assert.equal(JSON.stringify(facts).includes(secretCanary), false);
  assert.equal(
    Object.prototype.hasOwnProperty.call(facts, "environment"),
    false
  );
  assert.equal(Object.prototype.hasOwnProperty.call(facts, "token"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(facts, "password"), false);
});

test("Exact-0004 entry evidence 14 final artifact has schema 2 and exactly four authenticated files", (context) => {
  const fixture = exact0004ProtocolFixture(context, {
    PHYSICAL_OUTCOME: "success"
  });
  exact0004CompleteGreenPhysicalRoute(fixture);
  const artifact = exact0004FinalizeFixture(fixture, {
    legacyOverrides: exact0004GreenLegacyOverrides()
  });
  assert.equal(
    artifact.schemaVersion,
    realPostgresRunner.EXACT_0004_ARTIFACT_SCHEMA_VERSION
  );
  assert.equal(
    artifact.evidenceSchemaVersion,
    realPostgresRunner.EVIDENCE_SCHEMA_VERSION
  );
  assert.equal(realPostgresRunner.EXACT_0004_ARTIFACT_KEYS.length, 80);
  assert.equal(Object.keys(artifact).length, 80);
  assert.equal(exact0004HasRawOutputKey(artifact), false);
  assert.ok(realPostgresRunner.EXACT_0004_AUXILIARY_PROCESS_CLASSES.includes(
    artifact.safeAuxiliaryProcessClass
  ));
  assert.equal(
    artifact.cleanupFailure === null ||
      realPostgresRunner.EXACT_0004_CLEANUP_FAILURE_CODES.includes(
        artifact.cleanupFailure
      ),
    true
  );
  assert.equal(realPostgresRunner.EXACT_0004_CLEANUP_FAILURE_CODES.length, 6);
  assert.deepEqual(
    fs.readdirSync(fixture.files.artifactDirectory).sort(),
    [...EXACT_0004_ARTIFACT_FILES].sort()
  );
  exact0004VerifySidecar(fixture.files.artifactDirectory, "evidence.json");
  exact0004VerifySidecar(
    fixture.files.artifactDirectory,
    "process-status.json"
  );
  for (const stateFile of [
    fixture.files.checkpoint,
    fixture.files.evidenceState,
    fixture.files.processState,
    fixture.files.cleanupState,
    fixture.files.assessment
  ]) {
    assert.equal(fs.existsSync(stateFile), false, stateFile);
    const temporaryPrefix = path.basename(stateFile) + ".tmp-";
    assert.deepEqual(
      fs.readdirSync(path.dirname(stateFile)).filter(
        (name) => name.startsWith(temporaryPrefix)
      ),
      []
    );
  }
});

function exact0004NodeLifecycleHarness({
  fingerprint = "9".repeat(64)
} = {}) {
  const callbacks = [];
  let child;
  let spawnExecutable;
  let spawnArguments;
  let spawnOptions;
  const result = realPostgresRunner.runNodeTest({
    configuration: { fingerprint },
    env: {},
    onCreated: () => callbacks.push({ event: "spawn" }),
    onError: (afterSpawn, error) => callbacks.push({
      afterSpawn,
      event: "error",
      safeCode: error?.code ?? null
    }),
    onExit: (code, signal, timedOut) => callbacks.push({
      code,
      event: "exit",
      signal,
      timedOut
    }),
    onClose: (code, signal) => callbacks.push({
      code,
      event: "close",
      signal
    }),
    onMarker: (name, fields = {}) => callbacks.push({
      event: name,
      ...fields
    }),
    spawnImpl: (executable, args, options) => {
      spawnExecutable = executable;
      spawnArguments = args;
      spawnOptions = options;
      child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      return child;
    }
  });
  return Object.freeze({
    callbacks,
    child,
    fingerprint,
    result,
    spawnExecutable,
    spawnArguments,
    spawnOptions
  });
}

function exact0004EmitAuthenticatedFileLoad(harness) {
  harness.child.stderr.write(realTestFileLoadedLine(harness.fingerprint));
}

function exact0004EmitTap(harness, {
  title = realPostgresRunner.TAP_TITLE,
  tests = 1,
  pass = 1,
  fail = 0
} = {}) {
  harness.child.stdout.write([
    "TAP version 13",
    `# Subtest: ${title}`,
    `ok 1 - ${title}`,
    `1..${tests}`,
    `# tests ${tests}`,
    `# pass ${pass}`,
    `# fail ${fail}`,
    "# skipped 0",
    "# cancelled 0",
    ""
  ].join("\n"));
}

function exact0004EndSyntheticPipes(harness) {
  harness.child.stdout.end();
  harness.child.stderr.end();
}

function exact0004RewriteEvidenceWithSidecar(fixture, value) {
  const file = path.join(fixture.files.artifactDirectory, "evidence.json");
  exact0004WriteJson(file, value);
  const digest = crypto.createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("hex");
  fs.writeFileSync(
    file + ".sha256",
    digest + "  evidence.json\n",
    { mode: 0o600 }
  );
}

function exact0004GreenLifecycleArtifact(context, options = {}) {
  const fixture = exact0004ProtocolFixture(context, {
    PHYSICAL_OUTCOME: "success",
    ...options.environmentOverrides
  });
  const observation = exact0004CompleteGreenPhysicalRoute(fixture);
  const artifact = exact0004FinalizeFixture(fixture, {
    legacyOverrides: exact0004GreenLegacyOverrides(),
    ...options.finalizeOverrides
  });
  return Object.freeze({ artifact, fixture, observation });
}

test("Exact-0004 lifecycle evidence 01 preserves spawn to file load to TAP to exit to close", async () => {
  const harness = exact0004NodeLifecycleHarness();
  assert.deepEqual(harness.child.eventNames(), [
    "spawn",
    "error",
    "exit",
    "close"
  ]);
  assertExactTapRunnerArguments(harness.spawnArguments);
  assert.equal(harness.spawnExecutable, process.execPath);
  assert.equal(harness.spawnOptions.cwd, path.resolve(__dirname, ".."));
  assert.equal(harness.spawnOptions.shell, false);
  assert.equal(harness.spawnOptions.windowsHide, true);
  assert.deepEqual(harness.spawnOptions.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(
    harness.spawnOptions.env.SOCIAL_REAL_POSTGRES_REQUIRED,
    "true"
  );
  assert.equal(
    harness.spawnOptions.env.SOCIAL_TEST_GATE_VALIDATED_FINGERPRINT,
    harness.fingerprint
  );
  assert.equal(
    harness.spawnOptions.env[realPostgresRunner.REAL_TEST_FILE_LOAD_MARKER_ENV],
    realPostgresRunner.realTestFileLoadMarker(harness.fingerprint)
  );
  harness.child.emit("spawn");
  exact0004EmitAuthenticatedFileLoad(harness);
  exact0004EmitTap(harness);
  harness.child.emit("exit", 0, null);
  exact0004EndSyntheticPipes(harness);
  harness.child.emit("close", 0, null);
  const result = await harness.result;
  const observed = harness.callbacks.map(({ event }) => event);
  assert.deepEqual(observed, [
    "spawn",
    "testFileLoaded",
    "tapStarted",
    "tapTitleObserved",
    "firstTestDiscovered",
    "nodeTestTapSummary",
    "exit",
    "close"
  ]);
  assert.deepEqual({
    absent: [],
    certified: [
      result.facts.testFileLoaded,
      result.facts.tapStarted,
      result.exitObserved,
      result.closeObserved
    ],
    inference: [],
    observed
  }, {
    absent: [],
    certified: [true, true, true, true],
    inference: [],
    observed
  });
  assert.deepEqual([
    result.status,
    result.signal,
    result.closeStatus,
    result.closeSignal
  ], [0, null, 0, null]);
});

test("Exact-0004 lifecycle evidence 02 keeps testFileLoaded independent from the TAP title", async () => {
  const harness = exact0004NodeLifecycleHarness();
  harness.child.emit("spawn");
  exact0004EmitAuthenticatedFileLoad(harness);
  exact0004EmitTap(harness, { title: "synthetic different TAP title" });
  harness.child.emit("exit", 1, null);
  exact0004EndSyntheticPipes(harness);
  harness.child.emit("close", 1, null);
  const result = await harness.result;
  assert.equal(result.facts.testFileLoaded, true, "certified file entry");
  assert.equal(result.facts.tapStarted, true, "observed TAP byte");
  assert.equal(result.facts.tapTitleObserved, false, "expected title absent");
  assert.equal(result.facts.firstTestDiscovered, true, "test observed");
});

test("Exact-0004 lifecycle evidence 03 preserves spawn then exit then close without inventing bootstrap facts", async () => {
  const harness = exact0004NodeLifecycleHarness();
  harness.child.emit("spawn");
  harness.child.emit("exit", 0, null);
  exact0004EndSyntheticPipes(harness);
  harness.child.emit("close", 0, null);
  const result = await harness.result;
  assert.deepEqual(
    harness.callbacks.map(({ event }) => event),
    ["spawn", "exit", "close"]
  );
  assert.equal(result.facts.testFileLoaded, false, "authenticated fact absent");
  assert.equal(result.facts.tapStarted, false, "TAP absent");
  assert.equal(result.exitObserved, true);
  assert.equal(result.closeObserved, true);
});

test("Exact-0004 lifecycle evidence 04 preserves exit while close is still pending", async () => {
  const harness = exact0004NodeLifecycleHarness();
  let settled = false;
  harness.result.then(() => { settled = true; });
  harness.child.emit("spawn");
  harness.child.emit("exit", 0, null);
  await Promise.resolve();
  assert.equal(settled, false, "close remains absent, not inferred");
  assert.deepEqual(
    harness.callbacks.map(({ event }) => event),
    ["spawn", "exit"]
  );
  exact0004EndSyntheticPipes(harness);
  harness.child.emit("close", 0, null);
  const result = await harness.result;
  assert.equal(result.exitObserved, true);
  assert.equal(result.closeObserved, true);
});

test("Exact-0004 lifecycle evidence 05 keeps an open pipe pending after exit", async () => {
  const harness = exact0004NodeLifecycleHarness();
  let settled = false;
  harness.result.then(() => { settled = true; });
  harness.child.emit("spawn");
  exact0004EmitAuthenticatedFileLoad(harness);
  harness.child.stderr.write("non-sensitive diagnostic still draining\n");
  harness.child.emit("exit", 0, null);
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(harness.child.stderr.writableEnded, false);
  exact0004EndSyntheticPipes(harness);
  harness.child.emit("close", 0, null);
  const result = await harness.result;
  assert.equal(result.exitObserved, true);
  assert.equal(result.closeObserved, true);
  assert.equal(result.facts.testFileLoaded, true);
});

test("Exact-0004 lifecycle evidence 06 preserves error before spawn as an observed refusal", async () => {
  const harness = exact0004NodeLifecycleHarness();
  harness.child.emit(
    "error",
    Object.assign(new Error("synthetic refusal"), { code: "EACCES" })
  );
  exact0004EndSyntheticPipes(harness);
  harness.child.emit("close", null, null);
  const result = await harness.result;
  assert.deepEqual(harness.callbacks, [{
    afterSpawn: false,
    event: "error",
    safeCode: "EACCES"
  }]);
  assert.equal(result.created, false);
  assert.equal(result.exitObserved, false);
  assert.equal(result.closeObserved, true);
});

test("Exact-0004 lifecycle evidence 07 preserves error after spawn independently from exit and close", async () => {
  const harness = exact0004NodeLifecycleHarness();
  harness.child.emit("spawn");
  harness.child.emit(
    "error",
    Object.assign(new Error("synthetic child error"), { code: "EPIPE" })
  );
  harness.child.emit("exit", 1, null);
  exact0004EndSyntheticPipes(harness);
  harness.child.emit("close", 1, null);
  const result = await harness.result;
  assert.deepEqual(
    harness.callbacks.map(({ event }) => event),
    ["spawn", "error", "exit", "close"]
  );
  assert.equal(harness.callbacks[1].afterSpawn, true);
  assert.equal(result.error.code, "EPIPE");
  assert.equal(result.exitObserved, true);
  assert.equal(result.closeObserved, true);
});

test("Exact-0004 lifecycle evidence 08 preserves a nonzero exit code through close", async () => {
  const harness = exact0004NodeLifecycleHarness();
  harness.child.emit("spawn");
  harness.child.emit("exit", 7, null);
  exact0004EndSyntheticPipes(harness);
  harness.child.emit("close", 7, null);
  const result = await harness.result;
  assert.deepEqual([
    result.status,
    result.signal,
    result.closeStatus,
    result.closeSignal
  ], [7, null, 7, null]);
});

test("Exact-0004 lifecycle evidence 09 preserves a signal without inventing an exit code", async () => {
  const harness = exact0004NodeLifecycleHarness();
  harness.child.emit("spawn");
  harness.child.emit("exit", null, "SIGTERM");
  exact0004EndSyntheticPipes(harness);
  harness.child.emit("close", null, "SIGTERM");
  const result = await harness.result;
  assert.deepEqual([
    result.status,
    result.signal,
    result.closeStatus,
    result.closeSignal
  ], [null, "SIGTERM", null, "SIGTERM"]);
  assert.equal(result.exitObserved, true);
  assert.equal(result.closeObserved, true);
});

test("Exact-0004 lifecycle evidence 10 preserves timeout and the existing TERM KILL path", (context) => {
  const workflowSource = fs.readFileSync(path.join(
    __dirname,
    "..",
    ".github",
    "workflows",
    "social-3b0-exact-0004-runner-linux.yml"
  ), "utf8");
  assert.ok(workflowSource.includes("--signal=TERM"));
  assert.ok(workflowSource.includes("--kill-after=5s"));
  assert.ok(workflowSource.includes("'1200s'"));
  const fixture = exact0004ProtocolFixture(context);
  const observation = exact0004LoadPhysicalScript(fixture);
  observation.launcherSpawnAttempted();
  observation.launcherProcessCreated();
  observation.launcherClosed(124, null, true);
  observation.auxiliaryResidualBeforeKill(1);
  observation.auxiliaryKillAttempted();
  observation.auxiliaryKillResult(null, "SIGKILL", false);
  observation.auxiliaryResidualFinal(0);
  observation.cleanupStarted();
  observation.cleanupCompleted(true, 0);
  const checkpoint = exact0004ReadCheckpoint(fixture);
  assert.equal(
    checkpoint.checkpointSchemaVersion,
    realPostgresRunner.EXACT_0004_CHECKPOINT_SCHEMA_VERSION
  );
  assert.equal(checkpoint.checkpointSchemaVersion, 2);
  const byName = new Map(
    checkpoint.lifecycleEvidence.map((entry) => [entry.event, entry])
  );
  assert.deepEqual(byName.get("physicalLauncherClosed").facts, {
    exitCode: 124,
    signal: null,
    timedOut: true
  });
  assert.deepEqual(byName.get("auxiliaryKillAttempted").facts, {
    signal: "SIGKILL"
  });
  assert.deepEqual(byName.get("auxiliaryKillResult").facts, {
    exitCode: null,
    signal: "SIGKILL",
    timedOut: false
  });
});

test("Exact-0004 lifecycle evidence 11 preserves residual before kill and residual final append only", (context) => {
  const fixture = exact0004ProtocolFixture(context);
  const observation = exact0004LoadPhysicalScript(fixture);
  observation.launcherSpawnAttempted();
  observation.launcherProcessCreated();
  observation.launcherClosed(1, null, false);
  observation.auxiliaryResidualBeforeKill(1);
  const beforeKill = exact0004ReadCheckpoint(fixture).lifecycleEvidence;
  observation.auxiliaryKillAttempted();
  observation.auxiliaryKillResult(0, null, false);
  observation.auxiliaryResidualFinal(0);
  const afterKill = exact0004ReadCheckpoint(fixture).lifecycleEvidence;
  assert.deepEqual(afterKill.slice(0, beforeKill.length), beforeKill);
  assert.deepEqual(
    afterKill.map(({ sequence }) => sequence),
    Array.from({ length: afterKill.length }, (_, index) => index + 1)
  );
  assert.equal(
    afterKill.find(({ event }) =>
      event === "auxiliaryResidualBeforeKill").facts.count,
    1
  );
  assert.equal(
    afterKill.find(({ event }) =>
      event === "auxiliaryResidualFinal").facts.count,
    0
  );
});

test("Exact-0004 lifecycle evidence 12 keeps authenticated facts when aggregate evidence is invalid", (context) => {
  const fixture = exact0004ProtocolFixture(context);
  exact0004CompleteGreenPhysicalRoute(fixture);
  const artifact = exact0004FinalizeFixture(fixture, {
    legacyOverrides: {
      ...exact0004GreenLegacyOverrides(),
      failureDuringCleanup: false,
      failurePhase: null,
      firstFailure: "physical_step_no_evidence",
      firstFailureStage: "artifact",
      safeErrorCode: null,
      safeLineBucket: "unknown",
      safeModuleName: null,
      safePermissionOrigin: "unknown",
      safeSourceBasename: null,
      stderrCategory: "unknown"
    }
  });
  assert.equal(artifact.physicalEvidenceState, "invalid");
  assert.equal(artifact.testFileLoaded, true);
  assert.equal(artifact.tapStarted, true);
  assert.deepEqual([
    artifact.testsDiscovered,
    artifact.testsPassed,
    artifact.testsFailed
  ], [1, 1, 0]);
  assert.deepEqual([
    artifact.nodeTestExitCode,
    artifact.nodeTestSignal,
    artifact.nodeTestTimedOut
  ], [0, null, false]);
  assert.notEqual(artifact.firstFailure, null);

  const invalidCheckpointFixture = exact0004ProtocolFixture(context);
  exact0004CompleteGreenPhysicalRoute(invalidCheckpointFixture);
  exact0004WriteJson(invalidCheckpointFixture.files.checkpoint, {
    ...exact0004ReadCheckpoint(invalidCheckpointFixture),
    unexpectedAggregateKey: true
  });
  const salvaged = exact0004FinalizeFixture(invalidCheckpointFixture, {
    legacyOverrides: {
      ...exact0004GreenLegacyOverrides(),
      firstFailure: "physical_step_no_evidence",
      firstFailureStage: "artifact",
      stderrCategory: "unknown",
      safePermissionOrigin: "unknown",
      safeLineBucket: "unknown"
    }
  });
  assert.equal(salvaged.physicalEntryCheckpointState, "invalid");
  assert.equal(salvaged.testFileLoaded, true);
  assert.equal(salvaged.nodeTestExitCode, 0);
  assert.equal(salvaged.safeAuxiliaryProcessClass, "sudo");
  assert.equal(salvaged.lifecycleEvidence.length > 0, true);

  const countContradictionFixture = exact0004ProtocolFixture(context);
  exact0004CompleteGreenPhysicalRoute(countContradictionFixture);
  exact0004WriteJson(countContradictionFixture.files.checkpoint, {
    ...exact0004ReadCheckpoint(countContradictionFixture),
    auxiliaryProcessCount: 1
  });
  const countContradiction = exact0004FinalizeFixture(
    countContradictionFixture,
    {
      legacyOverrides: {
        ...exact0004GreenLegacyOverrides(),
        firstFailure: "physical_step_no_evidence",
        firstFailureStage: "artifact",
        stderrCategory: "unknown",
        safePermissionOrigin: "unknown",
        safeLineBucket: "unknown"
      }
    }
  );
  assert.equal(countContradiction.physicalEntryCheckpointState, "invalid");
  assert.equal(countContradiction.physicalEvidenceState, "invalid");
  assert.equal(countContradiction.testFileLoaded, true);
  assert.equal(countContradiction.nodeTestExitCode, 0);
  assert.throws(
    () => realPostgresRunner.enforceExact0004Artifact(
      countContradictionFixture.environment
    ),
    /exact0004_(?:artifact|lifecycle)_/
  );

  const unmeasuredZeroFixture = exact0004ProtocolFixture(context);
  const unmeasuredZeroObservation = exact0004LoadPhysicalScript(
    unmeasuredZeroFixture
  );
  unmeasuredZeroObservation.launcherSpawnAttempted();
  unmeasuredZeroObservation.launcherProcessCreated();
  unmeasuredZeroObservation.cleanupStarted();
  unmeasuredZeroObservation.cleanupCompleted(true, 0);
  const unmeasuredZeroCheckpoint = exact0004ReadCheckpoint(
    unmeasuredZeroFixture
  );
  assert.equal(unmeasuredZeroCheckpoint.auxiliaryProcessCount, 1);
  assert.equal(unmeasuredZeroCheckpoint.cleanupStarted, true);
  assert.equal(unmeasuredZeroCheckpoint.cleanupCompleted, false);
  assert.equal(
    unmeasuredZeroCheckpoint.lifecycleEvidence.some(({ event }) =>
      event === "routeCleanupCompleted"),
    false
  );

  const residualMismatchFixture = exact0004ProtocolFixture(context);
  exact0004CompleteGreenPhysicalRoute(residualMismatchFixture);
  const residualMismatchCheckpoint = exact0004ReadCheckpoint(
    residualMismatchFixture
  );
  exact0004WriteJson(residualMismatchFixture.files.checkpoint, {
    ...residualMismatchCheckpoint,
    auxiliaryProcessCount: 1,
    cleanupCompleted: false,
    firstFailureStage: "cleanup",
    lifecycleEvidence: residualMismatchCheckpoint.lifecycleEvidence.map(
      (entry) => entry.event === "routeCleanupCompleted"
        ? { ...entry, facts: { completed: true, count: 1 } }
        : entry
    )
  });
  const residualMismatch = exact0004FinalizeFixture(
    residualMismatchFixture,
    {
      legacyOverrides: {
        ...exact0004GreenLegacyOverrides(),
        firstFailure: "physical_step_no_evidence",
        firstFailureStage: "artifact",
        stderrCategory: "unknown",
        safePermissionOrigin: "unknown",
        safeLineBucket: "unknown"
      }
    }
  );
  const residualMismatchByName = new Map(
    residualMismatch.lifecycleEvidence.map((entry) => [entry.event, entry])
  );
  assert.equal(residualMismatch.physicalEntryCheckpointState, "invalid");
  assert.equal(residualMismatch.physicalEvidenceState, "invalid");
  assert.equal(residualMismatch.auxiliaryProcessCount, 1);
  assert.equal(
    residualMismatchByName.get("auxiliaryResidualFinal").facts.count,
    0
  );
  assert.equal(
    residualMismatchByName.get("routeCleanupCompleted").facts.count,
    1
  );
  assert.equal(residualMismatch.testFileLoaded, true);
  assert.equal(residualMismatch.nodeTestExitCode, 0);
  assert.throws(
    () => realPostgresRunner.enforceExact0004Artifact(
      residualMismatchFixture.environment
    ),
    /exact0004_(?:artifact|lifecycle)_/
  );

  const classContradictionFixture = exact0004ProtocolFixture(context);
  const classObservation = exact0004LoadPhysicalScript(
    classContradictionFixture
  );
  classObservation.launcherSpawnAttempted();
  exact0004WriteJson(classContradictionFixture.files.checkpoint, {
    ...exact0004ReadCheckpoint(classContradictionFixture),
    safeAuxiliaryProcessClass: "unknown"
  });
  const classContradiction = exact0004FinalizeFixture(
    classContradictionFixture,
    {
      evidenceState: "missing",
      legacyOverrides: {
        firstFailure: "exact0004_orchestration_failed",
        firstFailureStage: "composed_process"
      }
    }
  );
  assert.equal(classContradiction.physicalEntryCheckpointState, "invalid");
  assert.equal(classContradiction.physicalEvidenceState, "invalid");
  assert.equal(classContradiction.physicalLauncherSpawnAttempted, true);
  assert.equal(classContradiction.physicalLauncherProcessCreated, false);
  assert.equal(classContradiction.nodeTestExitCode, null);
  assert.throws(
    () => realPostgresRunner.enforceExact0004Artifact(
      classContradictionFixture.environment
    ),
    /exact0004_(?:artifact|lifecycle)_/
  );

  const protocolFixture = exact0004ProtocolFixture(context);
  exact0004CompleteGreenPhysicalRoute(protocolFixture);
  const protocolInvalid = exact0004FinalizeFixture(protocolFixture, {
    legacyOverrides: {
      ...exact0004GreenLegacyOverrides(),
      firstFailure: "safe_event_protocol_invalid",
      firstFailureStage: "safe_event_protocol",
      failureDuringCleanup: false,
      failurePhase: null,
      safeErrorCode: "safe_event_protocol_invalid",
      safeLineBucket: "unknown",
      safeModuleName: null,
      safePermissionOrigin: "unknown",
      safeSourceBasename: null,
      stderrCategory: "unknown"
    }
  });
  assert.equal(protocolInvalid.physicalEvidenceState, "invalid");
  assert.equal(protocolInvalid.testFileLoaded, true);
  assert.equal(protocolInvalid.tapStarted, true);
  assert.deepEqual([
    protocolInvalid.testsDiscovered,
    protocolInvalid.testsPassed,
    protocolInvalid.testsFailed,
    protocolInvalid.nodeTestExitCode,
    protocolInvalid.nodeTestSignal,
    protocolInvalid.nodeTestTimedOut
  ], [1, 1, 0, 0, null, false]);
  assert.equal(
    protocolInvalid.lifecycleEvidence.some(({ event }) =>
      event === "nodeTestClose"),
    true
  );

  const cleanupContradictions = [
    {
      cleanupStarted: false,
      cleanupCompleted: true
    },
    {
      cleanupStarted: false,
      cleanupCompleted: false,
      failureDuringCleanup: true,
      failurePhase: "final_cleanup",
      firstFailure: "final_cleanup_incomplete",
      firstFailureStage: "cleanup",
      stderrCategory: "unknown",
      safePermissionOrigin: "unknown",
      safeLineBucket: "unknown"
    },
    {
      cleanupStarted: true,
      cleanupCompleted: false,
      failureDuringCleanup: false,
      failurePhase: "final_cleanup",
      firstFailure: "final_cleanup_incomplete",
      firstFailureStage: "cleanup",
      stderrCategory: "unknown",
      safePermissionOrigin: "unknown",
      safeLineBucket: "unknown"
    },
    {
      gateValidated: null,
      nodeTestSpawnAttempted: true
    },
    {
      ...realPostgresRunner.emptyExact0004Evidence(),
      cleanupStarted: true,
      cleanupCompleted: false,
      lastMainPhaseStarted: "physical_target_preflight",
      lastMainPhaseCompleted: "physical_target_preflight"
    }
  ];
  for (const contradiction of cleanupContradictions) {
    const cleanupFixture = exact0004ProtocolFixture(context);
    exact0004CompleteGreenPhysicalRoute(cleanupFixture);
    const cleanupInvalid = exact0004FinalizeFixture(cleanupFixture, {
      legacyOverrides: {
        ...exact0004GreenLegacyOverrides(),
        ...contradiction
      }
    });
    assert.equal(cleanupInvalid.physicalEvidenceState, "invalid");
    assert.equal(cleanupInvalid.testFileLoaded, true);
    assert.deepEqual([
      cleanupInvalid.testsDiscovered,
      cleanupInvalid.testsPassed,
      cleanupInvalid.testsFailed,
      cleanupInvalid.nodeTestExitCode
    ], [1, 1, 0, 0]);
  }
});

test("Exact-0004 lifecycle evidence 13 preserves lifecycle across a post run test_execution failure", (context) => {
  const fixture = exact0004ProtocolFixture(context);
  const observation = exact0004CompleteGreenPhysicalRoute(fixture);
  observation.failure("test_execution");
  const artifact = exact0004FinalizeFixture(fixture, {
    legacyOverrides: {
      ...exact0004GreenLegacyOverrides(),
      firstFailure: "post_run_contract_failed",
      firstFailureStage: "test_execution",
      failureDuringCleanup: false,
      failurePhase: null,
      safeErrorCode: "ERR_TEST_FAILURE",
      safeLineBucket: "unknown",
      safeModuleName: null,
      safePermissionOrigin: "unknown",
      safeSourceBasename: null,
      stderrCategory: "tap_failure"
    }
  });
  assert.equal(artifact.firstFailureStage, "test_execution");
  assert.equal(artifact.firstFailure, "post_run_contract_failed");
  assert.equal(
    artifact.lifecycleEvidence.some(({ event }) => event === "nodeTestExit"),
    true
  );
  assert.equal(
    artifact.lifecycleEvidence.some(({ event }) => event === "nodeTestClose"),
    true
  );
  assert.equal(artifact.nodeTestExitCode, 0);
});

test("Exact-0004 lifecycle evidence 14 finalizer preserves TAP counts exit and close", (context) => {
  const fixture = exact0004ProtocolFixture(context);
  exact0004CompleteGreenPhysicalRoute(fixture);
  const artifact = exact0004FinalizeFixture(fixture, {
    legacyOverrides: {
      ...exact0004GreenLegacyOverrides(),
      nodeTestExitCode: null,
      nodeTestSignal: null,
      nodeTestTimedOut: null,
      testsDiscovered: 0,
      testsPassed: 0,
      testsFailed: 0
    }
  });
  const byName = new Map(
    artifact.lifecycleEvidence.map((entry) => [entry.event, entry])
  );
  assert.deepEqual([
    artifact.testsDiscovered,
    artifact.testsPassed,
    artifact.testsFailed
  ], [1, 1, 0]);
  assert.deepEqual([
    artifact.nodeTestExitCode,
    artifact.nodeTestSignal,
    artifact.nodeTestTimedOut
  ], [0, null, false]);
  assert.deepEqual(byName.get("nodeTestClose").facts, {
    nodeTestCloseCode: 0,
    nodeTestCloseSignal: null
  });
});

test("Exact-0004 lifecycle evidence 15 enforcer rejects every lifecycle contradiction", (context) => {
  const cleanWorktreeEnvironment = exact0004FixtureWorktreeEnvironment(
    context,
    ""
  );
  const { fixture } = exact0004GreenLifecycleArtifact(context, {
    environmentOverrides: cleanWorktreeEnvironment
  });
  assert.doesNotThrow(() =>
    realPostgresRunner.enforceExact0004Artifact(fixture.environment));
  const contradictions = [
    (artifact) => ({ ...artifact, nodeTestExitCode: 1 }),
    (artifact) => ({ ...artifact, testFileLoaded: null }),
    (artifact) => ({
      ...artifact,
      postgresImageDigest: "sha256:" + "d".repeat(64)
    }),
    (artifact) => ({ ...artifact, postgresImageDigest: null }),
    (artifact) => ({
      ...artifact,
      auxiliaryProcessCount: 1,
      residuals: { ...artifact.residuals, auxiliaryProcesses: 1 }
    }),
    (artifact) => ({
      ...artifact,
      lifecycleEvidence: artifact.lifecycleEvidence.map((entry) =>
        entry.event === "nodeTestClose"
          ? {
              ...entry,
              facts: { ...entry.facts, nodeTestCloseCode: 1 }
            }
          : entry)
    }),
    (artifact) => ({
      ...artifact,
      lifecycleEvidence: artifact.lifecycleEvidence.map((entry) =>
        entry.event === "routeCleanupCompleted"
          ? { ...entry, facts: { completed: false, count: 1 } }
          : entry)
    }),
    (artifact) => ({
      ...artifact,
      lifecycleEvidence: artifact.lifecycleEvidence.map((entry) =>
        entry.event === "physicalPhaseSnapshot"
          ? {
              ...entry,
              facts: {
                ...entry.facts,
                cleanupStarted: false,
                cleanupCompleted: false
              }
            }
          : entry)
    }),
    (artifact) => ({
      ...artifact,
      lifecycleEvidence: artifact.lifecycleEvidence.map((entry) =>
        entry.event === "physicalPhaseSnapshot"
          ? {
              ...entry,
              facts: {
                ...entry.facts,
                ...realPostgresRunner.emptyExact0004Evidence(),
                cleanupStarted: true,
                cleanupCompleted: true,
                lastMainPhaseStarted: "role_provisioning",
                lastMainPhaseCompleted: "physical_target_preflight"
              }
            }
          : entry)
    }),
    ...["skipped", "cancelled"].map((field) => (artifact) => ({
      ...artifact,
      lifecycleEvidence: artifact.lifecycleEvidence.map((entry) =>
        entry.event === "nodeTestTapSummary"
          ? { ...entry, facts: { ...entry.facts, [field]: 1 } }
          : entry)
    })),
    (artifact) => ({
      ...artifact,
      lifecycleEvidence: artifact.lifecycleEvidence.map((entry) => {
        if (entry.event === "tapTitleObserved") return {
          ...entry,
          event: "firstTestDiscovered",
          facts: { firstTestDiscovered: true }
        };
        if (entry.event === "firstTestDiscovered") return {
          ...entry,
          event: "tapTitleObserved",
          facts: { tapTitleObserved: true }
        };
        return entry;
      })
    }),
    (artifact) => {
      const launcher = artifact.lifecycleEvidence.filter((entry) => [
        "physicalLauncherSpawnAttempted",
        "physicalLauncherProcessCreated"
      ].includes(entry.event));
      const remainder = artifact.lifecycleEvidence.filter((entry) => ![
        "physicalLauncherSpawnAttempted",
        "physicalLauncherProcessCreated"
      ].includes(entry.event));
      return {
        ...artifact,
        lifecycleEvidence: [...launcher, ...remainder].map((entry, index) => ({
          ...entry,
          sequence: index + 1
        }))
      };
    },
    (artifact) => {
      const snapshot = artifact.lifecycleEvidence.find((entry) =>
        entry.event === "physicalPhaseSnapshot");
      const remainder = artifact.lifecycleEvidence.filter((entry) =>
        entry.event !== "physicalPhaseSnapshot");
      return {
        ...artifact,
        lifecycleEvidence: [...remainder, snapshot].map((entry, index) => ({
          ...entry,
          sequence: index + 1
        }))
      };
    }
  ];
  for (const mutate of contradictions) {
    const current = exact0004GreenLifecycleArtifact(context, {
      environmentOverrides: cleanWorktreeEnvironment
    });
    exact0004RewriteEvidenceWithSidecar(
      current.fixture,
      mutate(current.artifact)
    );
    assert.throws(
      () => realPostgresRunner.enforceExact0004Artifact(
        current.fixture.environment
      ),
      /exact0004_(?:artifact|lifecycle)_/
    );
  }
  const dirtyWorktreeEnvironment = exact0004FixtureWorktreeEnvironment(
    context,
    EXACT_0004_DIRTY_WORKTREE_STATUS
  );
  const dirty = exact0004GreenLifecycleArtifact(context, {
    environmentOverrides: dirtyWorktreeEnvironment
  });
  assert.equal(
    dirty.artifact.postgresImageDigest,
    gate.IMAGE.slice(gate.IMAGE.lastIndexOf("@") + 1)
  );
  assert.throws(
    () => realPostgresRunner.enforceExact0004Artifact(
      dirty.fixture.environment
    ),
    { message: "exact0004_worktree_not_clean" }
  );
});

test("Exact-0004 lifecycle evidence 16 artifact contains no raw output or secret", (context) => {
  const secretCanary = "lifecycle-secret-" + "8".repeat(48);
  const fixture = exact0004ProtocolFixture(context);
  exact0004CompleteGreenPhysicalRoute(fixture);
  const artifact = exact0004FinalizeFixture(fixture, {
    legacyOverrides: exact0004GreenLegacyOverrides(),
    mutateLegacy: (legacy) => ({
      ...legacy,
      testProcessStarted: "raw stdout and stderr " + secretCanary
    })
  });
  assert.equal(exact0004HasRawOutputKey(artifact), false);
  assert.equal(JSON.stringify(artifact).includes(secretCanary), false);
  assert.equal(JSON.stringify(artifact).includes("raw stdout"), false);
  assert.equal(JSON.stringify(artifact).includes("raw stderr"), false);
});

test("Exact-0004 lifecycle evidence 17 artifact remains exactly four files with correct sidecars", (context) => {
  const { fixture } = exact0004GreenLifecycleArtifact(context);
  assert.deepEqual(
    fs.readdirSync(fixture.files.artifactDirectory).sort(),
    [...EXACT_0004_ARTIFACT_FILES].sort()
  );
  exact0004VerifySidecar(fixture.files.artifactDirectory, "evidence.json");
  exact0004VerifySidecar(
    fixture.files.artifactDirectory,
    "process-status.json"
  );
});

test("Exact-0004 lifecycle evidence 18 cleanup is true true with every final residual zero", (context) => {
  const { artifact } = exact0004GreenLifecycleArtifact(context);
  assert.equal(artifact.cleanupStarted, true);
  assert.equal(artifact.cleanupCompleted, true);
  assert.equal(artifact.cleanupFailure, null);
  assert.deepEqual(Object.values(artifact.residuals), Array(8).fill(0));
  const cleanupEvents = artifact.lifecycleEvidence.filter(({ event }) =>
    event === "routeCleanupStarted" || event === "routeCleanupCompleted"
  );
  assert.deepEqual(cleanupEvents.map(({ event }) => event), [
    "routeCleanupStarted",
    "routeCleanupCompleted"
  ]);
  assert.deepEqual(cleanupEvents[1].facts, { completed: true, count: 0 });
});
