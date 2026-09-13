"use strict";
const crypto = require("node:crypto"), { isDeepStrictEqual } = require("node:util");
const { isDiskPreparationWorker } = require("./disk-preparation-worker");
const { isPreparedDiskAdmission, preparedTaskReservation } = require("./prepared-disk-admission");
const instances = new WeakSet();
const context = { authenticated: true, role: "calendar_media_capacity_coordinator" };
function fail() { throw Object.assign(new Error("import_preparation_local_runner_unavailable"), { code: "import_preparation_local_runner_unavailable" }); }
/** Explicit in-memory local integration harness, not a durable Render runner. */
function createLocalPreparationRunnerForTests({ store, capacity, admission, getWorker, enabled = false, afterResultForTests } = {}) {
  if (!enabled || store?.capabilities?.persistence !== "volatile-test" || typeof store.update !== "function" || typeof getWorker !== "function" ||
      capacity?.capabilities?.testOnly !== true || !isPreparedDiskAdmission(admission, { allowVolatileForTests: true }) ||
      afterResultForTests !== undefined && typeof afterResultForTests !== "function") fail();
  const tasks = new Map();
  const runner = Object.freeze({
    capabilities: Object.freeze({ testOnly: true, localOnly: true, isolatedWorker: false, idempotentDispatch: true,
      authoritativeLookup: true, maxRuntimeMs: 180000, deadlineMode: "cooperative", hardTermination: false, readyForProduction: false }),
    async dispatch(task) {
      preparedTaskReservation(task);
      const prior = tasks.get(task.dispatchKey);
      if (prior) { if (!isDeepStrictEqual(prior.task, task)) fail(); return structuredClone(prior.response); }
      if (tasks.size >= 1000) fail();
      const worker = getWorker(); if (!isDiskPreparationWorker(worker)) fail();
      const entry = { task: structuredClone(task), resultRef: crypto.randomUUID(), response: { dispatchKey: task.dispatchKey,
        executionDigest: task.executionDigest, executionId: crypto.randomUUID(), state: "running" } };
      tasks.set(task.dispatchKey, entry);
      let acquired;
      const started = performance.now();
      try {
        await admission.reserve(task);
        acquired = await capacity.acquireNext({ context, expectedJobId: task.jobId });
        if (!acquired) fail(); // No other company is taken/skipped to run this job.
        const actual = await worker.execute(task, { resultRef: entry.resultRef });
        entry.response = { ...entry.response, state: "succeeded", resultRef: actual.resultRef };
      } catch (_) { entry.response = { ...entry.response, state: "failed" }; }
      if (acquired) {
        await capacity.recordCompletion({ context, jobId: task.jobId, leaseToken: acquired.leaseToken,
          outcome: entry.response.state === "succeeded" ? "succeeded" : "failed", actualRuntimeMs: Math.ceil(performance.now() - started),
          proofId: crypto.createHash("sha256").update(JSON.stringify(entry.response)).digest("hex") });
      } else await capacity.cancel({ context, jobId: task.jobId }).catch(() => {});
      if (afterResultForTests) await afterResultForTests();
      return structuredClone(entry.response);
    },
    async getByKey({ dispatchKey, executionDigest } = {}) {
      if (![dispatchKey, executionDigest].every(value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value))) fail();
      const entry = tasks.get(dispatchKey);
      if (entry && entry.task.executionDigest !== executionDigest) fail();
      return entry ? structuredClone(entry.response) : { dispatchKey, executionDigest, state: "not_found", authoritative: true };
    }
  });
  instances.add(runner); return runner;
}
function isLocalPreparationRunner(value) { return Boolean(value && instances.has(value)); }
module.exports = { createLocalPreparationRunnerForTests, isLocalPreparationRunner };
