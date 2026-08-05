"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  DEFAULT_PHASE_TIMEOUTS,
  HarnessFailure,
  PHASES,
  assertClosedEvidenceReport,
  runPhasedHarness
} = require("../scripts/social-3a0p-local-harness-core");

function actionsPassing() {
  return Object.fromEntries(
    PHASES.map((phase) => [
      phase,
      async () => ({ code: `${phase.replaceAll("-", "_")}_ok` })
    ])
  );
}

test("onPhaseSettled is validated before any action runs", async () => {
  let actionRan = false;
  const actions = actionsPassing();
  actions.preflight = async () => {
    actionRan = true;
    return { code: "preflight_ok" };
  };

  await assert.rejects(
    runPhasedHarness({ actions, onPhaseSettled: {} }),
    { code: "harness_phase_settled_hook_invalid" }
  );
  assert.equal(actionRan, false);
});

test("authoritative pass events are frozen, ordered, and awaited", async () => {
  const actions = actionsPassing();
  const events = [];
  let releasePreflightHook;
  let markPreflightHookEntered;
  const preflightHookEntered = new Promise((resolve) => {
    markPreflightHookEntered = resolve;
  });
  const preflightHookGate = new Promise((resolve) => {
    releasePreflightHook = resolve;
  });
  let validatePackageRan = false;
  actions["validate-package"] = async () => {
    validatePackageRan = true;
    return { code: "validate_package_ok" };
  };

  const pending = runPhasedHarness({
    actions,
    onPhaseSettled: async (event) => {
      events.push(event);
      assert.equal(Object.isFrozen(event), true);
      if (event.phase === "preflight") {
        markPreflightHookEntered();
        await preflightHookGate;
      }
    }
  });

  await preflightHookEntered;
  assert.equal(validatePackageRan, false);
  releasePreflightHook();
  const report = await pending;

  assert.equal(report.ok, true);
  assert.equal(report.persistenceFailureCode, null);
  assert.deepEqual(events.map((event) => event.phase), PHASES);
  assert.equal(events[0].status, "passed");
  assert.equal(events[0].code, "phase_passed");
  assert.deepEqual(events[0].result, { code: "preflight_ok" });
  assert.equal(events.at(-1).code, "cleanup_passed");
  assert.equal(assertClosedEvidenceReport(report), true);
});

test("authoritative failure event preserves a sanitized partial result", async () => {
  const actions = actionsPassing();
  const events = [];
  let nextPhaseRan = false;
  actions.preflight = async () => {
    const error = new HarnessFailure("preflight_expected_failure");
    error.partialResult = {
      code: "preflight_partial",
      checks: { syntheticStatePreserved: true }
    };
    throw error;
  };
  actions["validate-package"] = async () => {
    nextPhaseRan = true;
    return { code: "must_not_run" };
  };

  await assert.rejects(
    runPhasedHarness({
      actions,
      onPhaseSettled: async (event) => events.push(event)
    }),
    (error) => {
      assert.equal(error.code, "preflight_expected_failure");
      assert.equal(assertClosedEvidenceReport(error.report), true);
      return true;
    }
  );

  assert.equal(nextPhaseRan, false);
  assert.deepEqual(events.map(({ phase, status, code }) => ({ phase, status, code })), [
    {
      phase: "preflight",
      status: "failed",
      code: "preflight_expected_failure"
    },
    { phase: "cleanup", status: "passed", code: "cleanup_passed" }
  ]);
  assert.deepEqual(events[0].result, {
    code: "preflight_partial",
    checks: { syntheticStatePreserved: true }
  });
  assert.equal(Object.isFrozen(events[0].result), true);
  assert.equal(Object.isFrozen(events[0].result.checks), true);
});

test("timeout event keeps the timeout authoritative and preserves settled partial evidence", async () => {
  const actions = actionsPassing();
  const events = [];
  actions.preflight = async ({ signal }) =>
    new Promise((resolve) => {
      signal.addEventListener(
        "abort",
        () => resolve({
          code: "preflight_aborted",
          checks: { abortObserved: true }
        }),
        { once: true }
      );
    });

  await assert.rejects(
    runPhasedHarness({
      actions,
      timeouts: { ...DEFAULT_PHASE_TIMEOUTS, preflight: 10 },
      terminationTimeoutMs: 25,
      settlementTimeoutMs: 25,
      terminateTree: async () => true,
      onPhaseSettled: async (event) => events.push(event)
    }),
    { code: "preflight_timeout" }
  );

  assert.equal(events[0].phase, "preflight");
  assert.equal(events[0].status, "failed");
  assert.equal(events[0].code, "preflight_timeout");
  assert.deepEqual(events[0].result, {
    code: "preflight_aborted",
    checks: { abortObserved: true }
  });
  assert.equal(events.at(-1).phase, "cleanup");
});

test("cleanup settlement is reported with its sanitized partial result", async () => {
  const actions = actionsPassing();
  const events = [];
  actions.cleanup = async () => {
    const error = new HarnessFailure("cleanup_expected_failure");
    error.partialResult = {
      code: "cleanup_partial",
      counts: { resourcesAttempted: 2, resourcesRemoved: 1 }
    };
    throw error;
  };

  await assert.rejects(
    runPhasedHarness({
      actions,
      onPhaseSettled: async (event) => events.push(event)
    }),
    { code: "cleanup_expected_failure" }
  );

  const cleanup = events.at(-1);
  assert.equal(cleanup.phase, "cleanup");
  assert.equal(cleanup.status, "failed");
  assert.equal(cleanup.code, "cleanup_expected_failure");
  assert.deepEqual(cleanup.result, {
    code: "cleanup_partial",
    counts: { resourcesAttempted: 2, resourcesRemoved: 1 }
  });
});

test("hook failure is fail-closed, blocks the next phase, and still attempts cleanup", async () => {
  const actions = actionsPassing();
  const hookEvents = [];
  let nextPhaseRan = false;
  let cleanupRan = false;
  actions["validate-package"] = async () => {
    nextPhaseRan = true;
    return { code: "must_not_run" };
  };
  actions.cleanup = async () => {
    cleanupRan = true;
    return { code: "cleanup_ok" };
  };

  await assert.rejects(
    runPhasedHarness({
      actions,
      onPhaseSettled: async (event) => {
        hookEvents.push(event);
        if (event.phase === "preflight") {
          throw new Error("sensitive hook implementation detail");
        }
      }
    }),
    (error) => {
      assert.equal(error.code, "harness_phase_settled_hook_failed");
      assert.equal(error.report.primaryFailureCode, "harness_phase_settled_hook_failed");
      assert.equal(
        error.report.persistenceFailureCode,
        "harness_phase_settled_hook_failed"
      );
      assert.equal(error.report.cleanupFailureCode, null);
      assert.equal(JSON.stringify(error).includes("sensitive hook"), false);
      return true;
    }
  );

  assert.equal(nextPhaseRan, false);
  assert.equal(cleanupRan, true);
  assert.deepEqual(hookEvents.map((event) => event.phase), ["preflight", "cleanup"]);
});

test("a phase failure remains primary while a ledger hook failure is recorded separately", async () => {
  const actions = actionsPassing();
  actions.preflight = async () => {
    throw new HarnessFailure("preflight_expected_failure");
  };

  await assert.rejects(
    runPhasedHarness({
      actions,
      onPhaseSettled: async (event) => {
        if (event.phase === "preflight") throw new Error("ledger unavailable");
      }
    }),
    (error) => {
      assert.equal(error.code, "preflight_expected_failure");
      assert.equal(error.report.primaryFailureCode, "preflight_expected_failure");
      assert.equal(
        error.report.persistenceFailureCode,
        "harness_phase_settled_hook_failed"
      );
      assert.equal(error.report.phases[0].code, "preflight_expected_failure");
      assert.equal(assertClosedEvidenceReport(error.report), true);
      assert.equal(JSON.stringify(error).includes("ledger unavailable"), false);
      return true;
    }
  );
});

test("cleanup hook failure occurs only after physical cleanup was attempted", async () => {
  const actions = actionsPassing();
  let cleanupRan = false;
  actions.cleanup = async () => {
    cleanupRan = true;
    return { code: "cleanup_ok" };
  };

  await assert.rejects(
    runPhasedHarness({
      actions,
      onPhaseSettled: async (event) => {
        if (event.phase === "cleanup") throw new Error("hook failed");
      }
    }),
    (error) => {
      assert.equal(error.code, "harness_phase_settled_hook_failed");
      assert.equal(error.report.primaryFailureCode, null);
      assert.equal(
        error.report.persistenceFailureCode,
        "harness_phase_settled_hook_failed"
      );
      assert.equal(error.report.cleanupFailureCode, "harness_phase_settled_hook_failed");
      return true;
    }
  );
  assert.equal(cleanupRan, true);
});

test("unsettled timeout is reported authoritatively and physical cleanup remains blocked", async () => {
  const actions = actionsPassing();
  const events = [];
  let cleanupRan = false;
  actions.preflight = async () => new Promise(() => {});
  actions.cleanup = async () => {
    cleanupRan = true;
    return { code: "must_not_run" };
  };

  await assert.rejects(
    runPhasedHarness({
      actions,
      timeouts: { ...DEFAULT_PHASE_TIMEOUTS, preflight: 5 },
      terminationTimeoutMs: 10,
      settlementTimeoutMs: 10,
      terminateTree: async () => true,
      onPhaseSettled: async (event) => events.push(event)
    }),
    (error) => {
      assert.equal(error.code, "preflight_timeout_operation_unsettled");
      assert.equal(
        error.report.cleanupFailureCode,
        "harness_cleanup_blocked_unsettled_operation"
      );
      assert.equal(assertClosedEvidenceReport(error.report), true);
      return true;
    }
  );

  assert.equal(cleanupRan, false);
  assert.deepEqual(events.map(({ phase, status, code }) => ({ phase, status, code })), [
    {
      phase: "preflight",
      status: "failed",
      code: "preflight_timeout_operation_unsettled"
    },
    {
      phase: "cleanup",
      status: "failed",
      code: "harness_cleanup_blocked_unsettled_operation"
    }
  ]);
});
