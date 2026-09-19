"use strict";

// Intended for the separate media executor host, not the 512 MB API process.
// Only an actual process worker is accepted. Remote adapters must preserve this
// intent/lookup contract and additionally prove their own provider termination.
const { createPreparationExecutionJournal } = require("./preparation-execution-journal");
const { isPreparedDiskAdmission, preparedTaskReservation } = require("./prepared-disk-admission");
const { isImportAccessPolicy } = require("./access-policy");
const crypto = require("node:crypto");
const instances = new WeakSet();
const context = Object.freeze({ authenticated: true, role: "calendar_media_capacity_coordinator" });
function fail(code = "unavailable") { throw Object.assign(new Error(`operational_preparation_${code}`), { code: `operational_preparation_${code}` }); }
function createOperationalPreparationRunner({ store, owner, capacity, admission, accessPolicy, getWorker,
  enabled = false, syntheticMediaForLocalTests = false, clock = Date.now, canLaunch = () => true } = {}) {
  if (!["win32", "linux"].includes(process.platform)) fail("platform_unvalidated");
  if (enabled !== true || store?.capabilities?.persistence !== "durable" || capacity?.capabilities?.persistence !== "durable" ||
      capacity.capabilities.atomicGlobalReservations !== true || !isPreparedDiskAdmission(admission) ||
      !isImportAccessPolicy(accessPolicy) || !accessPolicy.executionAvailable || typeof getWorker !== "function" ||
      typeof syntheticMediaForLocalTests !== "boolean" || typeof canLaunch !== "function" ||
      !["inspect", "acquireNext", "recordCompletion", "closeNeverLaunched"].every(key => typeof capacity[key] === "function")) fail("configuration_invalid");
  const journal = createPreparationExecutionJournal({ store, owner, clock });
  const binding = journal.capabilities.owner;
  function allowed() { accessPolicy.resolve({ authenticated: true, ...binding }); }
  allowed();
  function worker() {
    const value = getWorker();
    if ((!require("./process-disk-preparation-worker").isProcessDiskPreparationWorker(value) &&
        !require("./workflow-process-worker").isWorkflowProcessWorker(value)) ||
        value.capabilities.hardTermination !== true) fail("worker_invalid");
    return value;
  }
  function publicResponse(record) {
    return { dispatchKey: record.task.dispatchKey, executionDigest: record.task.executionDigest,
      executionId: record.executionId, state: record.phase === "succeeded" && record.capacitySettled ? "succeeded" :
        record.phase === "failed" && record.capacitySettled ? "failed" : "running",
      ...(record.phase === "succeeded" && record.capacitySettled ? { resultRef: record.resultRef } : {}) };
  }
  async function settle(record) {
    if (!record.completion || record.capacitySettled) return record;
    const { task, completion } = record;
    if (completion.neverLaunched === true) {
      await capacity.closeNeverLaunched({ context, journal, ...task });
      return journal.markCapacitySettled({ ...task, executionId: record.executionId, proofId: completion.proofId });
    }
    // Process termination and committed result/failure were persisted first.
    // A lost capacity acknowledgement is retried with its exact same proof.
    await capacity.recordCompletion({ context, jobId: task.jobId, leaseToken: record.capacityLeaseToken,
      outcome: completion.outcome, actualRuntimeMs: completion.actualRuntimeMs, proofId: completion.proofId });
    return journal.markCapacitySettled({ ...task, executionId: record.executionId, proofId: completion.proofId });
  }
  async function observeResult(record, observed) {
    if (!observed || observed.executionId !== record.executionId || !["running", "unknown", "succeeded", "failed"].includes(observed.state)) fail("worker_receipt_invalid");
    const updated = await journal.recordObservation({ ...record.task, executionId: record.executionId,
      state: observed.state, resultRef: observed.resultRef, termination: observed.termination, elapsedMs: observed.elapsedMs });
    return settle(updated);
  }
  async function unknown(record) {
    return journal.recordObservation({ ...record.task, executionId: record.executionId, state: "unknown" });
  }
  async function beforeLaunchFailure(record) {
    const closed = await journal.failBeforeLaunch({ ...record.task, executionId: record.executionId });
    return closed.record.completion ? publicResponse(await settle(closed.record)) : lookup(record.task);
  }
  async function dispatch(task) {
    allowed(); preparedTaskReservation(task);
    const actualWorker = worker(); // Validate before persisting a dispatch intent.
    let { record } = await journal.begin(task);
    if (record.launchClaimed) return lookup({ dispatchKey: task.dispatchKey, executionDigest: task.executionDigest });
    if (canLaunch() !== true) return beforeLaunchFailure(record);
    // Both operations are idempotent. A restart after global acquisition reads
    // the existing lease, while the tenant's atomic claim elects one launcher.
    try {
      await admission.reserve(task); allowed();
      let acquired = await capacity.inspect({ context, jobId: task.jobId });
      if (acquired.state === "queued") acquired = await capacity.acquireNext({ context, expectedJobId: task.jobId });
      if (!acquired) return publicResponse(record);
      if (acquired.state !== "running" || acquired.requestDigest !== task.executionDigest || acquired.companyId !== binding.companyId ||
          acquired.userId !== binding.userId || acquired.deadlineAt <= clock()) fail("capacity_conflict");
      const claim = await journal.claim({ ...task, executionId: record.executionId, capacityLeaseToken: acquired.leaseToken });
      record = claim.record;
      if (!claim.claimed) return publicResponse(await settle(record));
    } catch (_) { return beforeLaunchFailure(record); }
    // This catch is strictly before invoking the worker. The exclusive live
    // claimant can prove its invocation did not happen; other exceptions below
    // cannot use this proof, even if no receipt is visible yet.
    try { allowed(); if (canLaunch() !== true) fail("admission_closed"); } catch (_) {
      return publicResponse(await observeResult(record, { executionId: record.executionId, state: "failed", elapsedMs: 0,
        termination: { proved: true, descendants: 0, proofId: crypto.createHash("sha256").update(`launcher-not-invoked:${record.executionId}:${task.executionDigest}`).digest("hex") } }));
    }
    try {
      const observed = await actualWorker.execute(task, { executionId: record.executionId, resultRef: record.resultRef });
      return publicResponse(await observeResult(record, observed));
    } catch (_) {
      // An exception is not evidence that a child or remote task was stopped.
      // Preserve the slot and original identity; recovery only observes it.
      return publicResponse(await unknown(record));
    }
  }
  async function lookup({ dispatchKey, executionDigest } = {}) {
    let record = await journal.getByKey({ dispatchKey, executionDigest });
    if (!record) return { dispatchKey, executionDigest, state: "not_found", authoritative: true };
    // Cleanup/settlement is still required after an owner is revoked, but this
    // lookup cannot create or re-run processing for that owner.
    if (record.completion) return publicResponse(await settle(record));
    if (!record.launchClaimed) return record.task.deadlineAt <= clock() ? beforeLaunchFailure(record) : publicResponse(record);
    try {
      const observed = await worker().observe(record.task, { executionId: record.executionId, resultRef: record.resultRef });
      record = await observeResult(record, observed);
    } catch (_) { record = await unknown(record); }
    return publicResponse(record);
  }
  const runner = Object.freeze({
    capabilities: Object.freeze({ persistence: "durable", isolatedWorker: true, idempotentDispatch: true,
      authoritativeLookup: true, maxRuntimeMs: 180000, hardTermination: true,
      host: "separate_media_executor", syntheticMediaForLocalTests, remoteWorkflowVerified: false, readyForProduction: false }),
    dispatch, getByKey: lookup,
    async resumePending({ limit = 1 } = {}) {
      const pending = await journal.pending({ limit }), results = [];
      // Finite serial work only. A caller chooses when to run another tick.
      for (const record of pending) results.push(record.task.deadlineAt <= clock() ? await beforeLaunchFailure(record) : await dispatch(record.task));
      return results;
    }
  });
  instances.add(runner); return runner;
}
function isOperationalPreparationRunner(value) { return instances.has(value); }
module.exports = { createOperationalPreparationRunner, isOperationalPreparationRunner };
