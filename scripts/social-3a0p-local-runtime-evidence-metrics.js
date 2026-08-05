"use strict";

const {
  HarnessFailure
} = require("./social-3a0p-local-harness-core");

const ROLE_CATEGORIES = Object.freeze([
  "runtime",
  "migration",
  "provisioning"
]);
const ROLE_LOGIN = /^[a-z][a-z0-9_]{2,62}$/;
const POOL_CATEGORIES = Object.freeze([
  "runtime",
  "migration",
  "provisioning",
  "administration"
]);

function fail(code) {
  throw new HarnessFailure(code);
}

function isPlainObject(value) {
  return Boolean(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function requireNonNegativeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
}

function requirePositiveInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 1) fail(code);
  return value;
}

function poolSample(value, configuredMax) {
  if (!value || typeof value !== "object") {
    fail("harness_pool_metrics_sample_invalid");
  }
  const total = requireNonNegativeInteger(
    value.totalCount,
    "harness_pool_metrics_total_invalid"
  );
  const idle = requireNonNegativeInteger(
    value.idleCount,
    "harness_pool_metrics_idle_invalid"
  );
  const waiting = requireNonNegativeInteger(
    value.waitingCount,
    "harness_pool_metrics_waiting_invalid"
  );
  if (total > configuredMax) fail("harness_pool_metrics_max_exceeded");
  if (idle > total) fail("harness_pool_metrics_idle_exceeds_total");
  return Object.freeze({ total, idle, active: total - idle, waiting });
}

function createPoolMetricsRecorder({ configuredMax } = {}) {
  const maximum = requirePositiveInteger(
    configuredMax,
    "harness_pool_metrics_configured_max_invalid"
  );
  let samples = 0;
  let acquisitions = 0;
  let peakTotal = 0;
  let peakActive = 0;
  let peakIdle = 0;
  let peakWaiting = 0;

  function recordSample(sample) {
    samples += 1;
    peakTotal = Math.max(peakTotal, sample.total);
    peakActive = Math.max(peakActive, sample.active);
    peakIdle = Math.max(peakIdle, sample.idle);
    peakWaiting = Math.max(peakWaiting, sample.waiting);
    return sample;
  }

  return Object.freeze({
    observe(pool) {
      return recordSample(poolSample(pool, maximum));
    },
    recordAcquisition(pool) {
      const sample = poolSample(pool, maximum);
      acquisitions += 1;
      return recordSample(sample);
    },
    snapshot() {
      if (samples < 1) fail("harness_pool_metrics_sample_missing");
      return Object.freeze({
        code: "pool_metrics_collected",
        counts: Object.freeze({
          poolConfiguredMax: maximum,
          poolSamples: samples,
          poolAcquisitions: acquisitions
        }),
        metrics: Object.freeze({
          poolPeakTotal: peakTotal,
          poolPeakActive: peakActive,
          poolPeakIdle: peakIdle,
          poolPeakWaiting: peakWaiting
        }),
        checks: Object.freeze({
          poolConfiguredMaxRespected: peakTotal <= maximum
        })
      });
    }
  });
}

function poolCategorySuffix(category) {
  return `${category[0].toUpperCase()}${category.slice(1)}`;
}

function createPoolMetricsRegistry() {
  const pools = new Map();
  const categoryStats = Object.fromEntries(
    POOL_CATEGORIES.map((category) => [category, {
      acquisitions: 0,
      configuredMaxPeak: 0,
      peakTotal: 0,
      peakActive: 0,
      peakIdle: 0,
      peakWaiting: 0
    }])
  );
  const globalStats = {
    acquisitions: 0,
    configuredMaxPeak: 0,
    peakTotal: 0,
    peakActive: 0,
    peakIdle: 0,
    peakWaiting: 0,
    samples: 0,
    instances: 0
  };

  function requireRegistered(pool) {
    const entry = pools.get(pool);
    if (!entry) fail("harness_pool_metrics_pool_unregistered");
    return entry;
  }

  function aggregate(category = null) {
    const selected = [...pools.values()].filter(
      (entry) => category === null || entry.category === category
    );
    return selected.reduce((result, entry) => ({
      configuredMax: result.configuredMax + entry.configuredMax,
      total: result.total + entry.sample.total,
      active: result.active + entry.sample.active,
      idle: result.idle + entry.sample.idle,
      waiting: result.waiting + entry.sample.waiting
    }), { configuredMax: 0, total: 0, active: 0, idle: 0, waiting: 0 });
  }

  function updatePeaks() {
    const global = aggregate();
    globalStats.samples += 1;
    globalStats.configuredMaxPeak = Math.max(
      globalStats.configuredMaxPeak,
      global.configuredMax
    );
    globalStats.peakTotal = Math.max(globalStats.peakTotal, global.total);
    globalStats.peakActive = Math.max(globalStats.peakActive, global.active);
    globalStats.peakIdle = Math.max(globalStats.peakIdle, global.idle);
    globalStats.peakWaiting = Math.max(globalStats.peakWaiting, global.waiting);
    for (const category of POOL_CATEGORIES) {
      const current = aggregate(category);
      const stats = categoryStats[category];
      stats.configuredMaxPeak = Math.max(
        stats.configuredMaxPeak,
        current.configuredMax
      );
      stats.peakTotal = Math.max(stats.peakTotal, current.total);
      stats.peakActive = Math.max(stats.peakActive, current.active);
      stats.peakIdle = Math.max(stats.peakIdle, current.idle);
      stats.peakWaiting = Math.max(stats.peakWaiting, current.waiting);
    }
  }

  function observe(pool, value) {
    const entry = requireRegistered(pool);
    entry.sample = poolSample(value, entry.configuredMax);
    updatePeaks();
    return entry.sample;
  }

  return Object.freeze({
    register(pool, { category, configuredMax } = {}) {
      if (
        (!pool || (typeof pool !== "object" && typeof pool !== "function")) ||
        pools.has(pool) ||
        !POOL_CATEGORIES.includes(category)
      ) {
        fail("harness_pool_metrics_registration_invalid");
      }
      const maximum = requirePositiveInteger(
        configuredMax,
        "harness_pool_metrics_configured_max_invalid"
      );
      pools.set(pool, {
        category,
        configuredMax: maximum,
        sample: Object.freeze({ total: 0, active: 0, idle: 0, waiting: 0 })
      });
      globalStats.instances += 1;
      updatePeaks();
      return true;
    },
    observe,
    recordAcquisition(pool, value) {
      const entry = requireRegistered(pool);
      const sample = poolSample(value, entry.configuredMax);
      entry.sample = sample;
      categoryStats[entry.category].acquisitions += 1;
      globalStats.acquisitions += 1;
      updatePeaks();
      return sample;
    },
    unregister(pool) {
      requireRegistered(pool);
      pools.delete(pool);
      updatePeaks();
      return true;
    },
    snapshot() {
      if (globalStats.samples < 1) fail("harness_pool_metrics_sample_missing");
      const counts = {
        poolInstancesObserved: globalStats.instances,
        poolSamplesGlobal: globalStats.samples,
        poolConfiguredMaxGlobal: globalStats.configuredMaxPeak,
        poolAcquisitionsGlobal: globalStats.acquisitions
      };
      const metrics = {
        poolPeakTotalGlobal: globalStats.peakTotal,
        poolPeakActiveGlobal: globalStats.peakActive,
        poolPeakIdleGlobal: globalStats.peakIdle,
        poolPeakWaitingGlobal: globalStats.peakWaiting
      };
      for (const category of POOL_CATEGORIES) {
        const suffix = poolCategorySuffix(category);
        const stats = categoryStats[category];
        counts[`poolConfiguredMax${suffix}`] = stats.configuredMaxPeak;
        counts[`poolAcquisitions${suffix}`] = stats.acquisitions;
        metrics[`poolPeakTotal${suffix}`] = stats.peakTotal;
        metrics[`poolPeakActive${suffix}`] = stats.peakActive;
        metrics[`poolPeakIdle${suffix}`] = stats.peakIdle;
        metrics[`poolPeakWaiting${suffix}`] = stats.peakWaiting;
      }
      return Object.freeze({
        code: "pool_metrics_collected",
        counts: Object.freeze(counts),
        metrics: Object.freeze(metrics),
        checks: Object.freeze({
          poolConfiguredMaxRespected:
            globalStats.peakTotal <= globalStats.configuredMaxPeak
        })
      });
    }
  });
}

function normalizeRoleCategories(roleCategories) {
  if (!isPlainObject(roleCategories)) {
    fail("harness_session_role_categories_invalid");
  }
  const keys = Object.keys(roleCategories);
  if (
    keys.length !== ROLE_CATEGORIES.length ||
    keys.some((key) => !ROLE_CATEGORIES.includes(key))
  ) {
    fail("harness_session_role_categories_invalid");
  }
  const roleToCategory = new Map();
  for (const category of ROLE_CATEGORIES) {
    const roles = roleCategories[category];
    if (!Array.isArray(roles) || roles.length < 1) {
      fail("harness_session_role_categories_invalid");
    }
    for (const role of roles) {
      if (typeof role !== "string" || !ROLE_LOGIN.test(role)) {
        fail("harness_session_role_invalid");
      }
      if (roleToCategory.has(role)) fail("harness_session_role_ambiguous");
      roleToCategory.set(role, category);
    }
  }
  return roleToCategory;
}

function requireApplicationName(value) {
  if (
    typeof value !== "string" ||
    value.length < 3 ||
    value.length > 63 ||
    !/^ia4tube-social-(?:local|3a0p)-[a-z0-9_-]+$/.test(value)
  ) {
    fail("harness_session_application_name_invalid");
  }
  return value;
}

function requireObservedText(value, code) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 63 ||
    /[\0\r\n\u0001-\u001f\u007f]/.test(value)
  ) {
    fail(code);
  }
  return value;
}

function requireObservedApplicationName(value) {
  if (
    typeof value !== "string" ||
    value.length > 63 ||
    /[\0\r\n\u0001-\u001f\u007f]/.test(value)
  ) {
    fail("harness_session_application_name_invalid");
  }
  return value;
}

function normalizeOwnedSessions(ownedSessions) {
  if (!Array.isArray(ownedSessions)) {
    fail("harness_session_ownership_invalid");
  }
  const ownedByPid = new Map();
  for (const owned of ownedSessions) {
    if (!isPlainObject(owned)) fail("harness_session_ownership_invalid");
    const pid = requirePositiveInteger(
      owned.pid,
      "harness_session_backend_pid_invalid"
    );
    if (!ROLE_CATEGORIES.includes(owned.category)) {
      fail("harness_session_ownership_category_invalid");
    }
    const applicationName = requireApplicationName(owned.applicationName);
    if (ownedByPid.has(pid)) fail("harness_session_ownership_duplicate");
    ownedByPid.set(pid, Object.freeze({
      category: owned.category,
      applicationName
    }));
  }
  return ownedByPid;
}

function collectSessionMetrics({
  sessions,
  roleCategories,
  ownedSessions = []
} = {}) {
  if (!Array.isArray(sessions)) fail("harness_sessions_invalid");
  const roleToCategory = normalizeRoleCategories(roleCategories);
  const ownedByPid = normalizeOwnedSessions(ownedSessions);
  const seenPids = new Set();
  const counts = {
    sessionsTotal: 0,
    sessionsRuntime: 0,
    sessionsMigration: 0,
    sessionsProvisioning: 0,
    sessionsUnexpected: 0,
    sessionsIdleInTransaction: 0,
    sessionsOrphan: 0
  };

  for (const session of sessions) {
    if (!isPlainObject(session)) fail("harness_session_invalid");
    const pid = requirePositiveInteger(
      session.pid,
      "harness_session_backend_pid_invalid"
    );
    if (seenPids.has(pid)) fail("harness_session_backend_pid_duplicate");
    seenPids.add(pid);
    const role = requireObservedText(session.role, "harness_session_role_invalid");
    const state = requireObservedText(session.state, "harness_session_state_invalid");
    const applicationName = requireObservedApplicationName(session.applicationName);
    const category = roleToCategory.get(role) || "unexpected";
    const owner = ownedByPid.get(pid);
    counts.sessionsTotal += 1;
    if (category === "runtime") counts.sessionsRuntime += 1;
    else if (category === "migration") counts.sessionsMigration += 1;
    else if (category === "provisioning") counts.sessionsProvisioning += 1;
    else counts.sessionsUnexpected += 1;
    if (
      state === "idle in transaction" ||
      state === "idle in transaction (aborted)"
    ) {
      counts.sessionsIdleInTransaction += 1;
    }
    if (
      !owner ||
      owner.category !== category ||
      owner.applicationName !== applicationName
    ) {
      counts.sessionsOrphan += 1;
    }
  }

  for (const pid of ownedByPid.keys()) {
    if (!seenPids.has(pid)) counts.sessionsOrphan += 1;
  }

  return Object.freeze({
    code: "session_metrics_collected",
    counts: Object.freeze(counts),
    checks: Object.freeze({
      noUnexpectedRoles: counts.sessionsUnexpected === 0,
      noIdleInTransaction: counts.sessionsIdleInTransaction === 0,
      noOrphanConnections: counts.sessionsOrphan === 0
    })
  });
}

function assertSessionMetricsSafe(result) {
  if (
    !isPlainObject(result) ||
    !isPlainObject(result.checks) ||
    result.checks.noUnexpectedRoles !== true
  ) {
    fail("harness_session_unexpected_role_detected");
  }
  if (result.checks.noIdleInTransaction !== true) {
    fail("harness_session_idle_in_transaction_detected");
  }
  if (result.checks.noOrphanConnections !== true) {
    fail("harness_session_orphan_connection_detected");
  }
  return true;
}

function collectResidualProcessMetrics({ processes } = {}) {
  if (!Array.isArray(processes)) fail("harness_residual_processes_invalid");
  const pids = new Set();
  for (const process of processes) {
    if (!isPlainObject(process)) fail("harness_residual_process_invalid");
    const pid = requirePositiveInteger(
      process.pid,
      "harness_residual_process_pid_invalid"
    );
    if (pids.has(pid)) fail("harness_residual_process_pid_duplicate");
    pids.add(pid);
  }
  return Object.freeze({
    code: "residual_process_metrics_collected",
    counts: Object.freeze({ residualProcesses: pids.size }),
    checks: Object.freeze({ noResidualProcesses: pids.size === 0 })
  });
}

function assertNoResidualProcesses(result) {
  if (
    !isPlainObject(result) ||
    !isPlainObject(result.checks) ||
    result.checks.noResidualProcesses !== true
  ) {
    fail("harness_residual_process_detected");
  }
  return true;
}

module.exports = {
  POOL_CATEGORIES,
  ROLE_CATEGORIES,
  assertNoResidualProcesses,
  assertSessionMetricsSafe,
  collectResidualProcessMetrics,
  collectSessionMetrics,
  createPoolMetricsRecorder,
  createPoolMetricsRegistry
};
