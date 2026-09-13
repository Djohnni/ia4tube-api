"use strict";

// Internal metadata coordinator only. This module never starts/kills a process,
// deletes files or contacts a provider. Reservations are not a billing hard cap.
const crypto = require("node:crypto");
const { isDiskSpaceGuard, assertDiskSpaceEvidence } = require("./disk-space-guard");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const STATES = new Set(["queued", "running", "cancel_requested", "completed", "cancelled",
  "storage_reserved", "storage_sealed", "storage_cancel_requested", "storage_released"]);
const ACTIVE = new Set(["running", "cancel_requested"]);
const TERMINAL = new Set(["completed", "cancelled"]);
const MAX_RECORDS = 10000;
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
const DEFAULT_LIMITS = Object.freeze({ concurrentJobs: 1, queuedJobs: 64, companyQueuedJobs: 4,
  globalStorageBytes: 3 * 1024 ** 3, companyStorageBytes: 3 * 1024 ** 3,
  monthlyJobs: 120, companyMonthlyJobs: 120, monthlyRuntimeMs: 10800000,
  companyMonthlyRuntimeMs: 10800000, maxRuntimeMs: 180000 });
const integer = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;
const object = value => Boolean(value && typeof value === "object" && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value)));
function fail(code, statusCode = 409) {
  const error = new Error(`media_capacity_${code}`); error.code = error.message; error.statusCode = statusCode; throw error;
}
function freshGlobalCapacityState() { return { schema: 1, paused: false, sequence: 0, dispatchSequence: 0, jobs: {} }; }
function validateGlobalCapacityState(state) {
  if (!object(state) || state.schema !== 1 || typeof state.paused !== "boolean" || !integer(state.sequence) ||
      !integer(state.dispatchSequence) || !object(state.jobs) || Object.keys(state.jobs).length > MAX_RECORDS ||
      Buffer.byteLength(JSON.stringify(state)) > MAX_DOCUMENT_BYTES) fail("state_invalid", 503);
  const sequences = new Set();
  for (const [id, job] of Object.entries(state.jobs)) {
    if (!object(job) || !UUID.test(id) || job.jobId !== id || !UUID.test(job.companyId || "") || !UUID.test(job.userId || "") ||
        !HASH.test(job.requestDigest || "") || !STATES.has(job.state) || !integer(job.storageBytes, 1) ||
        !integer(job.sourceBytes) || job.sourceBytes > job.storageBytes || !integer(job.heldBytes) || job.heldBytes > job.storageBytes ||
        !object(job.storageSettlements) || Object.keys(job.storageSettlements).length > 16 ||
        Object.entries(job.storageSettlements).some(([proofId, bytes]) => !HASH.test(proofId) || !integer(bytes, 1) || bytes > job.storageBytes) ||
        !["task", "storage"].includes(job.purpose) || !integer(job.runtimeBudgetMs, job.purpose === "task" ? 1 : 0) || job.runtimeBudgetMs > 180000 ||
        !integer(job.createdAt) || !integer(job.sequence, 1) || job.sequence > state.sequence || sequences.has(job.sequence) ||
        !/^\d{4}-\d{2}$/.test(job.month || "") || !Array.isArray(job.quotaMonths) || job.quotaMonths.length < 1 ||
        job.quotaMonths.length > 256 || new Set(job.quotaMonths).size !== job.quotaMonths.length ||
        !job.quotaMonths.includes(job.month) || job.quotaMonths.some(month => !/^\d{4}-\d{2}$/.test(month)) ||
        typeof job.storageHeld !== "boolean" ||
        !integer(job.dispatchSequence) || job.dispatchSequence > state.dispatchSequence ||
        (job.leaseToken !== null && !UUID.test(job.leaseToken || "")) ||
        (job.cleanupProof !== null && !HASH.test(job.cleanupProof || ""))) fail("state_invalid", 503);
    sequences.add(job.sequence);
    if (job.purpose === "storage" && (!job.state.startsWith("storage_") || job.runtimeBudgetMs !== 0 ||
        job.leaseToken !== null || job.dispatchSequence !== 0 || job.completion !== undefined)) fail("state_invalid", 503);
    if (job.state === "storage_released" && job.storageHeld) fail("state_invalid", 503);
    if (job.purpose === "task" && job.state.startsWith("storage_")) fail("state_invalid", 503);
    if (job.state === "queued" && (job.leaseToken !== null || job.dispatchSequence !== 0 || job.completion !== undefined ||
        job.startedAt !== undefined || job.deadlineAt !== undefined)) fail("state_invalid", 503);
    if (ACTIVE.has(job.state) && (!job.leaseToken || !integer(job.startedAt) || !integer(job.deadlineAt) ||
        job.deadlineAt !== job.startedAt + job.runtimeBudgetMs || job.dispatchSequence < 1 || job.completion !== undefined)) fail("state_invalid", 503);
    if (TERMINAL.has(job.state) && (!object(job.completion) || !integer(job.completion.actualRuntimeMs) ||
        !["succeeded", "failed", "cancelled", "not_started"].includes(job.completion.outcome) ||
        !HASH.test(job.completion.proofId || ""))) fail("state_invalid", 503);
    if (job.state === "completed" && (!job.leaseToken || job.dispatchSequence < 1)) fail("state_invalid", 503);
    if (job.state === "cancelled" && job.leaseToken === null && (job.dispatchSequence !== 0 ||
        job.completion.outcome !== "not_started" || job.completion.actualRuntimeMs !== 0)) fail("state_invalid", 503);
    if (!job.storageHeld && (!(TERMINAL.has(job.state) || job.state === "storage_released") || !job.cleanupProof || job.heldBytes !== 0)) fail("state_invalid", 503);
    if (job.storageHeld && (job.cleanupProof !== null || job.heldBytes < 1)) fail("state_invalid", 503);
    if (job.storageHeld && job.heldBytes < job.storageBytes && !Object.values(job.storageSettlements).includes(job.heldBytes)) fail("state_invalid", 503);
  }
  return state;
}
function usage(state, month, companyId) {
  const rows = Object.values(state.jobs).filter(job => !companyId || job.companyId === companyId);
  return rows.reduce((out, job) => {
    if (job.storageHeld) out.storageBytes += job.heldBytes;
    if (job.purpose === "storage") { if (!integer(out.storageBytes)) fail("state_invalid", 503); return out; }
    if (job.state === "queued") out.queuedJobs++;
    if (ACTIVE.has(job.state)) out.activeJobs++;
    // Unknown-running work remains a conservative reservation in the current
    // month as well. Queueing in one month cannot buy a free start in the next.
    const crossesMonthWhileActive = ACTIVE.has(job.state) && new Date(job.startedAt).toISOString().slice(0, 7) <= month;
    if (job.quotaMonths.includes(month) || crossesMonthWhileActive) {
      out.monthlyJobs++;
      out.runtimeMs += TERMINAL.has(job.state) ? job.completion.actualRuntimeMs : job.runtimeBudgetMs;
    }
    if (Object.values(out).some(value => !integer(value))) fail("state_invalid", 503);
    return out;
  }, { storageBytes: 0, queuedJobs: 0, activeJobs: 0, monthlyJobs: 0, runtimeMs: 0 });
}
function coordinator(context) {
  if (!context || context.authenticated !== true || context.role !== "calendar_media_capacity_coordinator") fail("coordinator_required", 403);
}
function receipt(job) {
  return structuredClone({ jobId: job.jobId, companyId: job.companyId, userId: job.userId,
    requestDigest: job.requestDigest, purpose: job.purpose, state: job.state, storageBytes: job.storageBytes, heldBytes: job.heldBytes, sourceBytes: job.sourceBytes,
    runtimeBudgetMs: job.runtimeBudgetMs, storageHeld: job.storageHeld, leaseToken: job.leaseToken,
    startedAt: job.startedAt ?? null, deadlineAt: job.deadlineAt ?? null, completion: job.completion ?? null });
}
function createGlobalMediaCapacity({ store, enabled = false, allowVolatileForTests = false, limits = {}, clock = Date.now,
  requireDiskSpaceEvidence = false, diskSpaceGuard } = {}) {
  if (!object(limits) || Object.keys(limits).some(key => !Object.hasOwn(DEFAULT_LIMITS, key))) fail("configuration_invalid", 503);
  const budget = { ...DEFAULT_LIMITS, ...limits };
  if (Object.values(budget).some(value => !integer(value, 1)) || budget.concurrentJobs > 32 ||
      budget.queuedJobs > MAX_RECORDS || budget.maxRuntimeMs > 180000 || typeof clock !== "function" ||
      typeof requireDiskSpaceEvidence !== "boolean") fail("configuration_invalid", 503);
  const durable = store?.capabilities?.persistence === "durable" && store.capabilities.atomicGlobalUpdates === true;
  const testOnly = allowVolatileForTests && store?.capabilities?.testOnly === true && store.capabilities.atomicGlobalUpdates === true;
  const available = enabled === true && typeof store?.update === "function" && (durable || testOnly) &&
    (!requireDiskSpaceEvidence || isDiskSpaceGuard(diskSpaceGuard, { allowVolatileForTests }));
  function check(context) { coordinator(context); if (!available) fail("unavailable", 503); }
  function now() { const value = clock(); if (!integer(value)) fail("clock_invalid", 503); return value; }
  function physicalStorage(state, incomingBytes, evidence) {
    if (!requireDiskSpaceEvidence) return;
    let maximum;
    try { maximum = assertDiskSpaceEvidence(evidence, { guard: diskSpaceGuard, allowVolatileForTests }); }
    catch (_) { fail("disk_space_evidence_invalid", 503); }
    const held = usage(state, new Date(now()).toISOString().slice(0, 7)).storageBytes;
    if (incomingBytes > maximum || held > maximum - incomingBytes) fail("disk_space_insufficient");
  }
  async function update(context, operation) {
    check(context);
    return store.update(state => { validateGlobalCapacityState(state); const result = operation(state); validateGlobalCapacityState(state); return result; });
  }
  function get(state, jobId) { if (!UUID.test(jobId || "") || !Object.hasOwn(state.jobs, jobId)) fail("job_not_found", 404); return state.jobs[jobId]; }
  function exactOwner(job, request) {
    if (job.companyId !== request.companyId || job.userId !== request.userId || job.requestDigest !== request.requestDigest) fail("reservation_conflict");
  }
  function storageSettlement(job, remainingBytes, proofId) {
    if (Object.hasOwn(job.storageSettlements, proofId)) {
      if (job.storageSettlements[proofId] !== remainingBytes) fail("cleanup_conflict");
      return;
    }
    if (!job.storageHeld || remainingBytes > job.heldBytes || Object.keys(job.storageSettlements).length >= 16) fail("cleanup_conflict");
    job.storageSettlements[proofId] = remainingBytes; job.heldBytes = remainingBytes;
  }
  return Object.freeze({
    capabilities: Object.freeze({ available, persistence: durable ? "durable" : "volatile", testOnly: !durable,
      atomicGlobalReservations: available, financialHardCap: false, requiresDiskSpaceEvidence: requireDiskSpaceEvidence }),
    acceptsDiskSpaceGuard(guard) { return Boolean(requireDiskSpaceEvidence && guard === diskSpaceGuard &&
      isDiskSpaceGuard(guard, { allowVolatileForTests })); },
    async reserve({ context, jobId, companyId, userId, requestDigest, storageBytes, sourceBytes = 0, runtimeBudgetMs }) {
      check(context);
      if (![jobId, companyId, userId].every(value => UUID.test(value || "")) || !HASH.test(requestDigest || "") ||
          !integer(storageBytes, 1) || !integer(sourceBytes) || sourceBytes > storageBytes || !integer(runtimeBudgetMs, 1) ||
          runtimeBudgetMs > budget.maxRuntimeMs) fail("request_invalid", 400);
      return update(context, state => {
        const prior = state.jobs[jobId];
        if (prior) {
          exactOwner(prior, { companyId, userId, requestDigest });
          if (prior.purpose !== "task" || prior.storageBytes !== storageBytes || prior.sourceBytes !== sourceBytes || prior.runtimeBudgetMs !== runtimeBudgetMs) fail("reservation_conflict");
          return receipt(prior);
        }
        if (state.paused) fail("paused");
        if (Object.keys(state.jobs).length >= MAX_RECORDS) fail("ledger_full");
        const time = now(), month = new Date(time).toISOString().slice(0, 7);
        const global = usage(state, month), company = usage(state, month, companyId);
        if (global.storageBytes + storageBytes > budget.globalStorageBytes || company.storageBytes + storageBytes > budget.companyStorageBytes) fail("storage_exceeded");
        if (global.queuedJobs >= budget.queuedJobs || company.queuedJobs >= budget.companyQueuedJobs) fail("queue_full");
        if (global.monthlyJobs >= budget.monthlyJobs || company.monthlyJobs >= budget.companyMonthlyJobs ||
            global.runtimeMs + runtimeBudgetMs > budget.monthlyRuntimeMs || company.runtimeMs + runtimeBudgetMs > budget.companyMonthlyRuntimeMs) fail("budget_exceeded");
        const job = { jobId, companyId, userId, requestDigest, storageBytes, sourceBytes, runtimeBudgetMs, purpose: "task",
          state: "queued", storageHeld: true, heldBytes: storageBytes, storageSettlements: {}, month, quotaMonths: [month], createdAt: time, sequence: ++state.sequence,
          dispatchSequence: 0, leaseToken: null, cleanupProof: null };
        state.jobs[jobId] = job; return receipt(job);
      });
    },
    async reserveStorage({ context, jobId, companyId, userId, requestDigest, storageBytes, sourceBytes, diskSpaceEvidence }) {
      check(context);
      if (![jobId, companyId, userId].every(value => UUID.test(value || "")) || !HASH.test(requestDigest || "") ||
          !integer(storageBytes, 1) || !integer(sourceBytes, 1) || sourceBytes > storageBytes) fail("request_invalid", 400);
      return update(context, state => {
        const prior = state.jobs[jobId];
        if (prior) {
          exactOwner(prior, { companyId, userId, requestDigest });
          if (prior.purpose !== "storage" || prior.storageBytes !== storageBytes || prior.sourceBytes !== sourceBytes) fail("reservation_conflict");
          physicalStorage(state, 0, diskSpaceEvidence);
          return receipt(prior);
        }
        if (state.paused) fail("paused");
        if (Object.keys(state.jobs).length >= MAX_RECORDS) fail("ledger_full");
        const time = now(), month = new Date(time).toISOString().slice(0, 7);
        if (usage(state, month).storageBytes + storageBytes > budget.globalStorageBytes ||
            usage(state, month, companyId).storageBytes + storageBytes > budget.companyStorageBytes) fail("storage_exceeded");
        physicalStorage(state, storageBytes, diskSpaceEvidence);
        const job = { jobId, companyId, userId, requestDigest, storageBytes, sourceBytes, runtimeBudgetMs: 0, purpose: "storage",
          state: "storage_reserved", storageHeld: true, heldBytes: storageBytes, storageSettlements: {}, month, quotaMonths: [month],
          createdAt: time, sequence: ++state.sequence, dispatchSequence: 0, leaseToken: null, cleanupProof: null };
        state.jobs[jobId] = job; return receipt(job);
      });
    },
    async assertHeld({ context, jobId, companyId, userId, requestDigest, intent = "write", diskSpaceEvidence }) {
      if (!["write", "read"].includes(intent)) fail("request_invalid", 400);
      return update(context, state => {
        const job = get(state, jobId); exactOwner(job, { companyId, userId, requestDigest });
        if (!job.storageHeld) fail("storage_not_held");
        if (intent === "write" && !["queued", "running", "storage_reserved"].includes(job.state)) fail("writes_not_allowed");
        if (intent === "write") physicalStorage(state, 0, diskSpaceEvidence);
        return receipt(job);
      });
    },
    async acquireNext({ context, expectedJobId } = {}) {
      if (expectedJobId !== undefined && !UUID.test(expectedJobId || "")) fail("request_invalid", 400);
      return update(context, state => {
        if (state.paused || Object.values(state.jobs).filter(job => ACTIVE.has(job.state)).length >= budget.concurrentJobs) return null;
        const lastServed = {}, heads = {};
        for (const job of Object.values(state.jobs)) {
          lastServed[job.companyId] = Math.max(lastServed[job.companyId] || 0, job.dispatchSequence);
          if (job.state === "queued" && (!heads[job.companyId] || heads[job.companyId].sequence > job.sequence)) heads[job.companyId] = job;
        }
        const time = now(), month = new Date(time).toISOString().slice(0, 7);
        const global = usage(state, month);
        const job = Object.values(heads).sort((a, b) => lastServed[a.companyId] - lastServed[b.companyId] || a.sequence - b.sequence).find(candidate => {
          if (candidate.quotaMonths.includes(month)) return true;
          const company = usage(state, month, candidate.companyId);
          return global.monthlyJobs < budget.monthlyJobs && company.monthlyJobs < budget.companyMonthlyJobs &&
            global.runtimeMs + candidate.runtimeBudgetMs <= budget.monthlyRuntimeMs &&
            company.runtimeMs + candidate.runtimeBudgetMs <= budget.companyMonthlyRuntimeMs;
        });
        // A worker that only holds one exact task may refuse the fair head, but
        // may not take or skip another company's task to execute its own.
        if (!job || expectedJobId !== undefined && job.jobId !== expectedJobId) return null;
        if (!job.quotaMonths.includes(month)) job.quotaMonths.push(month);
        job.state = "running"; job.startedAt = time; job.deadlineAt = job.startedAt + job.runtimeBudgetMs;
        job.leaseToken = crypto.randomUUID(); job.dispatchSequence = ++state.dispatchSequence;
        return receipt(job);
      });
    },
    async recordCompletion({ context, jobId, leaseToken, outcome, actualRuntimeMs, proofId }) {
      if (!["succeeded", "failed", "cancelled", "not_started"].includes(outcome) || !integer(actualRuntimeMs) || !HASH.test(proofId || "") ||
          (outcome === "not_started" && actualRuntimeMs !== 0)) fail("completion_invalid", 400);
      return update(context, state => {
        const job = get(state, jobId);
        if (!leaseToken || leaseToken !== job.leaseToken) fail("lease_conflict");
        if (TERMINAL.has(job.state)) {
          if (JSON.stringify(job.completion) !== JSON.stringify({ outcome, actualRuntimeMs, proofId })) fail("completion_conflict");
          return receipt(job);
        }
        if (!ACTIVE.has(job.state)) fail("completion_conflict");
        const completionMonth = new Date(now()).toISOString().slice(0, 7);
        if (!job.quotaMonths.includes(completionMonth)) job.quotaMonths.push(completionMonth);
        job.completion = { outcome, actualRuntimeMs, proofId }; job.state = outcome === "cancelled" || outcome === "not_started" ? "cancelled" : "completed";
        // Overrun is recorded in full and stops admission; never silently cap measured usage.
        if (actualRuntimeMs > job.runtimeBudgetMs) state.paused = true;
        return receipt(job);
      });
    },
    async closeNeverLaunched({ context, journal, dispatchKey, executionDigest }) {
      check(context);
      // A caller-supplied boolean/receipt cannot release execution capacity.
      // Only the genuine forced-RLS journal can prove its irreversible fence.
      if (!durable || !require("./preparation-execution-journal").isPreparationExecutionJournal(journal)) fail("never_launched_unproved");
      const record = await journal.getByKey({ dispatchKey, executionDigest });
      if (record?.phase !== "failed" || record.completion?.neverLaunched !== true || record.capacityLeaseToken !== null) fail("never_launched_unproved");
      const task = record.task, proofId = record.completion.proofId;
      const request = journal.capabilities.kind === "prepare" ? require("./prepared-disk-admission").preparedTaskReservation(task) :
        { jobId: task.ticketId, companyId: task.companyId, userId: task.userId, requestDigest: task.executionDigest,
          storageBytes: task.sizeBytes * 2 + 65536, sourceBytes: task.sizeBytes, runtimeBudgetMs: task.maxRuntimeMs };
      return update(context, state => {
        let job = state.jobs[request.jobId];
        if (!job) {
          // Persist a tombstone even if reserve() has not arrived yet. Delayed
          // reservations see this terminal identity and cannot reopen a queue.
          // No bytes were ever admitted for this absent reservation: this is
          // not evidence that existing source/temporary files were deleted.
          if (Object.keys(state.jobs).length >= MAX_RECORDS) fail("ledger_full");
          const time = now(), month = new Date(time).toISOString().slice(0, 7);
          job = { ...request, purpose: "task", state: "cancelled", storageHeld: false, heldBytes: 0,
            storageSettlements: {}, month, quotaMonths: [month], createdAt: time, sequence: ++state.sequence,
            dispatchSequence: 0, leaseToken: null, cleanupProof: proofId };
          state.jobs[request.jobId] = job;
        } else {
          exactOwner(job, request);
          if (job.purpose !== "task" || job.storageBytes !== request.storageBytes || job.sourceBytes !== request.sourceBytes ||
              job.runtimeBudgetMs !== request.runtimeBudgetMs) fail("reservation_conflict");
          if (TERMINAL.has(job.state) && (job.completion.outcome !== "not_started" || job.completion.actualRuntimeMs !== 0)) fail("completion_conflict");
          // Existing storage remains held, regardless of queued/acquired state.
          job.state = "cancelled";
        }
        job.completion = { outcome: "not_started", actualRuntimeMs: 0, proofId };
        return receipt(job);
      });
    },
    async cancel({ context, jobId }) {
      return update(context, state => {
        const job = get(state, jobId);
        if (job.state === "queued") {
          job.state = "cancelled";
          job.completion = { outcome: "not_started", actualRuntimeMs: 0, proofId: crypto.createHash("sha256").update(`never-acquired:${jobId}:${job.requestDigest}`).digest("hex") };
        } else if (ACTIVE.has(job.state)) job.state = "cancel_requested";
        else if (["storage_reserved", "storage_sealed"].includes(job.state)) job.state = "storage_cancel_requested";
        return receipt(job);
      });
    },
    async settleStorage({ context, jobId, remainingBytes, proofId }) {
      if (!HASH.test(proofId || "") || !integer(remainingBytes, 1)) fail("cleanup_invalid", 400);
      return update(context, state => {
        const job = get(state, jobId);
        storageSettlement(job, remainingBytes, proofId);
        // Trusted filesystem adapter confirms the temporary bytes really disappeared.
        // This never changes the process state, runtime budget or lease ownership.
        return receipt(job);
      });
    },
    async sealStorage({ context, jobId, remainingBytes, proofId }) {
      if (!HASH.test(proofId || "") || !integer(remainingBytes, 1)) fail("cleanup_invalid", 400);
      return update(context, state => {
        const job = get(state, jobId);
        if (job.purpose !== "storage" || !["storage_reserved", "storage_sealed"].includes(job.state)) fail("cleanup_conflict");
        if (remainingBytes < job.sourceBytes) fail("cleanup_conflict");
        if (job.state === "storage_sealed" && (!Object.hasOwn(job.storageSettlements, proofId) || job.storageSettlements[proofId] !== remainingBytes)) fail("cleanup_conflict");
        storageSettlement(job, remainingBytes, proofId); job.state = "storage_sealed"; return receipt(job);
      });
    },
    async recordCleanup({ context, jobId, proofId }) {
      if (!HASH.test(proofId || "")) fail("cleanup_invalid", 400);
      return update(context, state => {
        const job = get(state, jobId);
        if (!(TERMINAL.has(job.state) || ["storage_cancel_requested", "storage_released"].includes(job.state))) fail("termination_unconfirmed");
        if (job.cleanupProof && job.cleanupProof !== proofId) fail("cleanup_conflict");
        job.cleanupProof = proofId; job.storageHeld = false; job.heldBytes = 0;
        if (job.purpose === "storage") job.state = "storage_released";
        return receipt(job);
      });
    },
    async setPaused({ context, paused }) {
      if (typeof paused !== "boolean") fail("request_invalid", 400);
      return update(context, state => { state.paused = paused; return { paused }; });
    },
    async inspect({ context, jobId }) { return update(context, state => receipt(get(state, jobId))); },
    async summary({ context }) {
      return update(context, state => ({ paused: state.paused, ...usage(state, new Date(now()).toISOString().slice(0, 7)) }));
    }
  });
}
module.exports = { createGlobalMediaCapacity, freshGlobalCapacityState, validateGlobalCapacityState, DEFAULT_LIMITS,
  MAX_RECORDS, MAX_DOCUMENT_BYTES };
