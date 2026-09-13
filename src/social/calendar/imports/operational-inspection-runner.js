"use strict";

const { isDeepStrictEqual } = require("node:util");
const { createInspectionExecutionJournal } = require("./preparation-execution-journal");
const { validateDiskInspectionTask } = require("./disk-inspection-worker");
const { isImportAccessPolicy } = require("./access-policy");
const { isDiskSpaceGuard } = require("./disk-space-guard");
const crypto = require("node:crypto");
const instances = new WeakSet();
const context = Object.freeze({ authenticated: true, role: "calendar_media_capacity_coordinator" });
function fail(code = "unavailable") { throw Object.assign(new Error(`operational_inspection_${code}`), { code: `operational_inspection_${code}` }); }
function createOperationalInspectionRunner({ store, owner, capacity, accessPolicy, diskSpaceGuard, getWorker,
  enabled = false, clock = Date.now } = {}) {
  if (!["win32", "linux"].includes(process.platform)) fail("platform_unvalidated");
  if (enabled !== true || capacity?.capabilities?.persistence !== "durable" || capacity.capabilities.atomicGlobalReservations !== true ||
      !isImportAccessPolicy(accessPolicy) || !accessPolicy.executionAvailable || typeof getWorker !== "function" ||
      !isDiskSpaceGuard(diskSpaceGuard) || capacity.acceptsDiskSpaceGuard?.(diskSpaceGuard) !== true ||
      !["reserve", "assertHeld", "inspect", "acquireNext", "recordCompletion", "closeNeverLaunched"].every(key => typeof capacity[key] === "function")) fail("configuration_invalid");
  const journal = createInspectionExecutionJournal({ store, owner, clock }), binding = journal.capabilities.owner;
  function allowed() { accessPolicy.resolve({ authenticated: true, ...binding }); }
  allowed();
  function worker() {
    const value = getWorker();
    if ((!require("./process-disk-inspection-worker").isProcessDiskInspectionWorker(value) &&
        !require("./workflow-process-worker").isWorkflowProcessWorker(value)) || value.capabilities.hardTermination !== true) fail("worker_invalid");
    return value;
  }
  function reservation(task) {
    validateDiskInspectionTask(task);
    if (task.companyId !== binding.companyId || task.userId !== binding.userId) fail("owner_invalid");
    return { context, jobId: task.ticketId, companyId: task.companyId, userId: task.userId,
      requestDigest: task.executionDigest, storageBytes: task.sizeBytes * 2 + 65536,
      sourceBytes: task.sizeBytes, runtimeBudgetMs: task.maxRuntimeMs };
  }
  function response(record) {
    const terminal = record.completion && record.capacitySettled;
    return { dispatchKey: record.task.dispatchKey, executionDigest: record.task.executionDigest, executionId: record.executionId,
      state: terminal ? record.phase : "running", ...(terminal && record.phase === "succeeded" ? { result: structuredClone(record.result) } : {}) };
  }
  async function settle(record) {
    if (!record.completion || record.capacitySettled) return record;
    if (record.completion.neverLaunched === true) {
      await capacity.closeNeverLaunched({ context, journal, ...record.task });
      return journal.markCapacitySettled({ ...record.task, executionId: record.executionId, proofId: record.completion.proofId });
    }
    await capacity.recordCompletion({ context, jobId: record.task.ticketId, leaseToken: record.capacityLeaseToken,
      outcome: record.completion.outcome, actualRuntimeMs: record.completion.actualRuntimeMs, proofId: record.completion.proofId });
    // No storage release is inferred from process termination. Cleanup needs
    // its own exact file/reference evidence, just as prepared derivatives do.
    return journal.markCapacitySettled({ ...record.task, executionId: record.executionId, proofId: record.completion.proofId });
  }
  async function observed(record, value) {
    if (!value || value.executionId !== record.executionId || !["running", "unknown", "succeeded", "failed"].includes(value.state)) fail("receipt_invalid");
    return settle(await journal.recordObservation({ ...record.task, executionId: record.executionId, state: value.state,
      result: value.result, termination: value.termination, elapsedMs: value.elapsedMs }));
  }
  async function unknown(record) { return journal.recordObservation({ ...record.task, executionId: record.executionId, state: "unknown" }); }
  async function beforeLaunchFailure(record) {
    const closed = await journal.failBeforeLaunch({ ...record.task, executionId: record.executionId });
    return closed.record.completion ? response(await settle(closed.record)) : lookup(record.task);
  }
  async function dispatch(task) {
    allowed(); const request = reservation(task), executor = worker();
    let { record } = await journal.begin(task);
    if (record.launchClaimed) return lookup(task);
    try {
      await capacity.reserve(request);
      let slot = await capacity.assertHeld({ ...request, intent: "write", diskSpaceEvidence: await diskSpaceGuard.sample() }); allowed();
      if (slot.state === "queued") slot = await capacity.acquireNext({ context, expectedJobId: task.ticketId });
      if (!slot) return response(record);
      if (slot.state !== "running" || slot.companyId !== binding.companyId || slot.userId !== binding.userId ||
          slot.requestDigest !== task.executionDigest || slot.deadlineAt <= clock()) fail("capacity_conflict");
      const claim = await journal.claim({ ...task, executionId: record.executionId, capacityLeaseToken: slot.leaseToken }); record = claim.record;
      if (!claim.claimed) return response(await settle(record));
    } catch (_) { return beforeLaunchFailure(record); }
    try { allowed(); } catch (_) {
      return response(await observed(record, { executionId: record.executionId, state: "failed", elapsedMs: 0,
        termination: { proved: true, descendants: 0, proofId: crypto.createHash("sha256").update(`launcher-not-invoked:${record.executionId}:${task.executionDigest}`).digest("hex") } }));
    }
    try { return response(await observed(record, await executor.inspect(task, { executionId: record.executionId }))); }
    catch (_) { return response(await unknown(record)); }
  }
  async function lookup({ companyId, userId, dispatchKey, executionDigest } = {}) {
    if (companyId !== undefined && companyId !== binding.companyId || userId !== undefined && userId !== binding.userId) fail("owner_invalid");
    let record = await journal.getByKey({ dispatchKey, executionDigest });
    if (!record) return { dispatchKey, executionDigest, state: "not_found", authoritative: true };
    if (record.completion) return response(await settle(record));
    if (!record.launchClaimed) return record.task.deadlineAt <= clock() ? beforeLaunchFailure(record) : response(record);
    try { record = await observed(record, await worker().observe(record.task, { executionId: record.executionId })); }
    catch (_) { record = await unknown(record); }
    return response(record);
  }
  const runner = Object.freeze({
    capabilities: Object.freeze({ persistence: "durable", isolatedWorker: true, idempotentDispatch: true,
      authoritativeLookup: true, maxRuntimeMs: 180000, hardTermination: true,
      host: "separate_media_executor", remoteWorkflowVerified: false, readyForProduction: false }),
    dispatch, getByKey: lookup,
    async assertExecutionHeld({ task, snapshotBytes, maxRuntimeMs }) {
      allowed(); const request = reservation(task);
      if (snapshotBytes !== task.sizeBytes || maxRuntimeMs !== task.maxRuntimeMs || task.deadlineAt <= clock()) fail("task_invalid");
      const record = await journal.getByKey(task);
      if (!record || !record.launchClaimed || record.completion || !isDeepStrictEqual(record.task, task)) fail("execution_unclaimed");
      const slot = await capacity.assertHeld({ ...request, intent: "write", diskSpaceEvidence: await diskSpaceGuard.sample() });
      allowed();
      return slot.state === "running" && slot.leaseToken === record.capacityLeaseToken && slot.deadlineAt > clock();
    },
    async resumePending({ limit = 1 } = {}) {
      const results = [];
      for (const record of await journal.pending({ limit })) results.push(record.task.deadlineAt <= clock() ? await beforeLaunchFailure(record) : await dispatch(record.task));
      return results;
    }
  });
  instances.add(runner); return runner;
}
function isOperationalInspectionRunner(value) { return instances.has(value); }
module.exports = { createOperationalInspectionRunner, isOperationalInspectionRunner };
