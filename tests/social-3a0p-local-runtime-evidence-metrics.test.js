"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  HarnessFailure,
  validatePhaseResult
} = require("../scripts/social-3a0p-local-harness-core");
const {
  assertNoResidualProcesses,
  assertSessionMetricsSafe,
  collectResidualProcessMetrics,
  collectSessionMetrics,
  createPoolMetricsRecorder,
  createPoolMetricsRegistry
} = require("../scripts/social-3a0p-local-runtime-evidence-metrics");

const ROLE_CATEGORIES = Object.freeze({
  runtime: Object.freeze(["ia4tube_social_local_runtime"]),
  migration: Object.freeze(["ia4tube_social_local_migration"]),
  provisioning: Object.freeze([
    "ia4tube_social_local_provisioner",
    "ia4tube_social_local_admin"
  ])
});

function expectCode(code) {
  return (error) => error instanceof HarnessFailure && error.code === code;
}

test("pool records configured maximum, real peaks, acquisitions and waiting", () => {
  const recorder = createPoolMetricsRecorder({ configuredMax: 3 });
  recorder.observe({ totalCount: 0, idleCount: 0, waitingCount: 0 });
  recorder.recordAcquisition({ totalCount: 1, idleCount: 0, waitingCount: 0 });
  recorder.recordAcquisition({ totalCount: 2, idleCount: 1, waitingCount: 2 });
  recorder.recordAcquisition({ totalCount: 3, idleCount: 0, waitingCount: 1 });
  recorder.observe({ totalCount: 3, idleCount: 2, waitingCount: 1 });
  const result = recorder.snapshot();

  assert.deepEqual(result.counts, {
    poolConfiguredMax: 3,
    poolSamples: 5,
    poolAcquisitions: 3
  });
  assert.deepEqual(result.metrics, {
    poolPeakTotal: 3,
    poolPeakActive: 3,
    poolPeakIdle: 2,
    poolPeakWaiting: 2
  });
  assert.equal(result.checks.poolConfiguredMaxRespected, true);
  assert.equal(validatePhaseResult(result).code, "pool_metrics_collected");
});

test("pool refuses impossible or missing samples", () => {
  const missing = createPoolMetricsRecorder({ configuredMax: 3 });
  assert.throws(
    () => missing.snapshot(),
    expectCode("harness_pool_metrics_sample_missing")
  );
  const exceeded = createPoolMetricsRecorder({ configuredMax: 3 });
  assert.throws(
    () => exceeded.observe({ totalCount: 4, idleCount: 0, waitingCount: 0 }),
    expectCode("harness_pool_metrics_max_exceeded")
  );
  const impossible = createPoolMetricsRecorder({ configuredMax: 3 });
  assert.throws(
    () => impossible.observe({ totalCount: 1, idleCount: 2, waitingCount: 0 }),
    expectCode("harness_pool_metrics_idle_exceeds_total")
  );
});

test("pool registry separates categories and sums simultaneous pools", () => {
  const registry = createPoolMetricsRegistry();
  const runtime = {};
  const migration = {};
  const provisioning = {};
  const administration = {};
  registry.register(runtime, { category: "runtime", configuredMax: 3 });
  registry.register(migration, { category: "migration", configuredMax: 2 });
  registry.register(provisioning, { category: "provisioning", configuredMax: 1 });
  registry.register(administration, { category: "administration", configuredMax: 1 });
  registry.recordAcquisition(runtime, {
    totalCount: 3,
    idleCount: 1,
    waitingCount: 2
  });
  registry.recordAcquisition(migration, {
    totalCount: 2,
    idleCount: 0,
    waitingCount: 1
  });
  registry.observe(provisioning, {
    totalCount: 1,
    idleCount: 1,
    waitingCount: 0
  });
  registry.observe(administration, {
    totalCount: 1,
    idleCount: 0,
    waitingCount: 0
  });
  const result = registry.snapshot();

  assert.equal(result.counts.poolConfiguredMaxGlobal, 7);
  assert.equal(result.metrics.poolPeakTotalGlobal, 7);
  assert.equal(result.metrics.poolPeakActiveGlobal, 5);
  assert.equal(result.metrics.poolPeakTotalRuntime, 3);
  assert.equal(result.metrics.poolPeakTotalMigration, 2);
  assert.equal(result.metrics.poolPeakTotalProvisioning, 1);
  assert.equal(result.metrics.poolPeakTotalAdministration, 1);
  assert.equal(result.counts.poolAcquisitionsRuntime, 1);
  assert.equal(result.counts.poolAcquisitionsMigration, 1);
  assert.equal(result.checks.poolConfiguredMaxRespected, true);
});

test("pool registry validates configuration.max and refuses unknown pools", () => {
  const registry = createPoolMetricsRegistry();
  assert.throws(
    () => registry.register({}, { category: "runtime", configuredMax: 0 }),
    expectCode("harness_pool_metrics_configured_max_invalid")
  );
  assert.throws(
    () => registry.register({}, { category: "other", configuredMax: 1 }),
    expectCode("harness_pool_metrics_registration_invalid")
  );
  assert.throws(
    () => registry.observe({}, { totalCount: 0, idleCount: 0, waitingCount: 0 }),
    expectCode("harness_pool_metrics_pool_unregistered")
  );
});

test("sessions are counted by synthetic role category without exposing logins", () => {
  const sessions = [
    {
      pid: 4101,
      role: "ia4tube_social_local_runtime",
      state: "active",
      applicationName: "ia4tube-social-local-runtime"
    },
    {
      pid: 4102,
      role: "ia4tube_social_local_migration",
      state: "idle",
      applicationName: "ia4tube-social-local-migration"
    },
    {
      pid: 4103,
      role: "ia4tube_social_local_provisioner",
      state: "idle",
      applicationName: "ia4tube-social-local-provisioner"
    }
  ];
  const ownedSessions = [
    { pid: 4101, category: "runtime", applicationName: "ia4tube-social-local-runtime" },
    { pid: 4102, category: "migration", applicationName: "ia4tube-social-local-migration" },
    { pid: 4103, category: "provisioning", applicationName: "ia4tube-social-local-provisioner" }
  ];
  const result = collectSessionMetrics({
    sessions,
    roleCategories: ROLE_CATEGORIES,
    ownedSessions
  });

  assert.deepEqual(result.counts, {
    sessionsTotal: 3,
    sessionsRuntime: 1,
    sessionsMigration: 1,
    sessionsProvisioning: 1,
    sessionsUnexpected: 0,
    sessionsIdleInTransaction: 0,
    sessionsOrphan: 0
  });
  assert.equal(assertSessionMetricsSafe(result), true);
  assert.doesNotMatch(JSON.stringify(result), /ia4tube_social_local_/);
  assert.equal(validatePhaseResult(result).code, "session_metrics_collected");
});

test("unexpected role is recorded and refused by the gate", () => {
  const result = collectSessionMetrics({
    sessions: [{
      pid: 4201,
      role: "foreign-role",
      state: "active",
      applicationName: "psql"
    }],
    roleCategories: ROLE_CATEGORIES,
    ownedSessions: []
  });
  assert.equal(result.counts.sessionsUnexpected, 1);
  assert.equal(result.checks.noUnexpectedRoles, false);
  assert.throws(
    () => assertSessionMetricsSafe(result),
    expectCode("harness_session_unexpected_role_detected")
  );
});

test("idle in transaction is recorded and refused", () => {
  const result = collectSessionMetrics({
    sessions: [{
      pid: 4301,
      role: "ia4tube_social_local_runtime",
      state: "idle in transaction",
      applicationName: "ia4tube-social-local-runtime"
    }],
    roleCategories: ROLE_CATEGORIES,
    ownedSessions: [{
      pid: 4301,
      category: "runtime",
      applicationName: "ia4tube-social-local-runtime"
    }]
  });
  assert.equal(result.counts.sessionsIdleInTransaction, 1);
  assert.throws(
    () => assertSessionMetricsSafe(result),
    expectCode("harness_session_idle_in_transaction_detected")
  );
});

test("missing or mismatched ownership records an orphan connection", () => {
  const result = collectSessionMetrics({
    sessions: [{
      pid: 4401,
      role: "ia4tube_social_local_runtime",
      state: "idle",
      applicationName: "ia4tube-social-local-runtime"
    }],
    roleCategories: ROLE_CATEGORIES,
    ownedSessions: [{
      pid: 4401,
      category: "runtime",
      applicationName: "ia4tube-social-local-migration"
    }]
  });
  assert.equal(result.counts.sessionsOrphan, 1);
  assert.throws(
    () => assertSessionMetricsSafe(result),
    expectCode("harness_session_orphan_connection_detected")
  );
});

test("empty application name and an owned PID absent from the cluster fail closed", () => {
  const result = collectSessionMetrics({
    sessions: [{
      pid: 5001,
      role: "ia4tube_social_local_runtime",
      state: "idle",
      applicationName: ""
    }],
    ownedSessions: [{
      pid: 5002,
      category: "runtime",
      applicationName: "ia4tube-social-local-runtime"
    }],
    roleCategories: ROLE_CATEGORIES
  });
  assert.equal(result.counts.sessionsOrphan, 2);
  assert.throws(
    () => assertSessionMetricsSafe(result),
    expectCode("harness_session_orphan_connection_detected")
  );
});

test("residual process is recorded without executable or command details", () => {
  const clean = collectResidualProcessMetrics({ processes: [] });
  assert.equal(clean.counts.residualProcesses, 0);
  assert.equal(assertNoResidualProcesses(clean), true);

  const residual = collectResidualProcessMetrics({ processes: [{ pid: 4501 }] });
  assert.equal(residual.counts.residualProcesses, 1);
  assert.throws(
    () => assertNoResidualProcesses(residual),
    expectCode("harness_residual_process_detected")
  );
  assert.equal(validatePhaseResult(residual).code, "residual_process_metrics_collected");
});

test("duplicate backend and process PIDs are refused deterministically", () => {
  assert.throws(
    () => collectSessionMetrics({
      sessions: [
        { pid: 4601, role: "ia4tube_social_local_runtime", state: "idle", applicationName: "ia4tube-social-local-runtime" },
        { pid: 4601, role: "ia4tube_social_local_runtime", state: "idle", applicationName: "ia4tube-social-local-runtime" }
      ],
      roleCategories: ROLE_CATEGORIES
    }),
    expectCode("harness_session_backend_pid_duplicate")
  );
  assert.throws(
    () => collectResidualProcessMetrics({ processes: [{ pid: 4602 }, { pid: 4602 }] }),
    expectCode("harness_residual_process_pid_duplicate")
  );
});
