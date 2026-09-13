"use strict";

// The tenant's existing forced-RLS document is the source of truth. This is not
// a process registry or a Map: an execution intent commits before any dispatch.
const crypto = require("node:crypto"), { isDeepStrictEqual } = require("node:util");
const { preparedTaskReservation } = require("./prepared-disk-admission");
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const instances = new WeakSet(), MAX_RECORDS = 1000;
const ACTIVE = new Set(["dispatching", "processing", "reconciliation"]);
const PHASES = new Set(["intent", "claimed", "running", "unknown", "succeeded", "failed"]);
const TERMINAL = new Set(["succeeded", "failed"]);
const integer = value => Number.isSafeInteger(value) && value >= 0;
function fail(code = "unavailable") { throw Object.assign(new Error(`preparation_execution_${code}`), { code: `preparation_execution_${code}` }); }
function object(value) { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function taskIdentity(task, companyId, userId, kind = "prepare") {
  if (kind === "inspect") require("./disk-inspection-worker").validateDiskInspectionTask(task);
  else preparedTaskReservation(task);
  if (task.companyId !== companyId || task.userId !== userId || Buffer.byteLength(JSON.stringify(task)) > 32768) fail("owner_invalid");
}
function fresh() { return { schema: 1, records: {} }; }
function validateExecutionState(value, companyId, uploads, preparation, kind) {
  if (!object(value) || value.schema !== 1 || !object(value.records) || Object.keys(value.records).length > MAX_RECORDS) fail("state_invalid");
  for (const [key, record] of Object.entries(value.records)) {
    if (!HASH.test(key) || !object(record) || !UUID.test(record.executionId || "") || !UUID.test(record.resultRef || "") ||
        !PHASES.has(record.phase) || !integer(record.createdAt) || !integer(record.updatedAt) || record.updatedAt < record.createdAt ||
        typeof record.capacitySettled !== "boolean" || typeof record.launchClaimed !== "boolean" ||
        record.capacityLeaseToken !== null && !UUID.test(record.capacityLeaseToken || "")) fail("state_invalid");
    const task = record.task, job = preparation?.jobs?.[task?.jobId], upload = uploads?.[task?.uploadId];
    taskIdentity(task, companyId, task?.userId, kind);
    if (kind === "inspect") {
      const ticket = upload?.disk?.inspectionTicket, dispatch = ticket?.dispatch;
      if (task.dispatchKey !== key || !upload || upload.companyId !== companyId || upload.userId !== task.userId ||
          upload.assetId !== task.assetId || upload.objectKey !== task.objectKey || upload.sha256 !== task.sha256 ||
          upload.sizeBytes !== task.sizeBytes || upload.kind !== task.mediaKind || upload.disk.objectVersion !== task.objectVersion ||
          ticket?.ticketId !== task.ticketId || dispatch?.dispatchKey !== key || dispatch.requestDigest !== task.executionDigest ||
          dispatch.fenceToken !== task.fenceToken || dispatch.startedAt !== task.startedAt || dispatch.deadlineAt !== task.deadlineAt) fail("state_invalid");
      if (record.phase === "succeeded" && (!object(record.result) || record.result.companyId !== companyId ||
          record.result.userId !== task.userId || record.result.ticketId !== task.ticketId || record.result.executionDigest !== task.executionDigest ||
          Buffer.byteLength(JSON.stringify(record.result)) > 8192)) fail("state_invalid");
    } else if (task.dispatchKey !== key || !job || !upload || job.userId !== task.userId || upload.userId !== task.userId ||
        job.assetId !== task.assetId || upload.assetId !== task.assetId || job.uploadId !== task.uploadId ||
        job.dispatchKey !== key || job.executionDigest !== task.executionDigest || job.mediaRevision !== task.mediaRevision ||
        !isDeepStrictEqual(job.source, task.source) || !isDeepStrictEqual(job.selection, task.selection) || !isDeepStrictEqual(job.plan, task.plan)) fail("state_invalid");
    const neverLaunched = record.completion?.neverLaunched === true;
    if (record.launchClaimed !== (record.phase !== "intent") || record.launchClaimed && !record.capacityLeaseToken && !neverLaunched ||
        !TERMINAL.has(record.phase) && (record.completion !== null || record.capacitySettled)) fail("state_invalid");
    if (TERMINAL.has(record.phase)) {
      const completion = record.completion;
      if (!object(completion) || completion.outcome !== record.phase || !integer(completion.actualRuntimeMs) ||
          !HASH.test(completion.proofId || "") || completion.terminationProved !== true || completion.descendants !== 0) fail("state_invalid");
      if (completion.neverLaunched !== undefined && (completion.neverLaunched !== true || record.phase !== "failed" ||
          completion.actualRuntimeMs !== 0 || record.capacityLeaseToken !== null)) fail("state_invalid");
    }
  }
  return value;
}
function validatePreparationExecutionState(value, companyId, uploads, preparation) {
  return validateExecutionState(value, companyId, uploads, preparation, "prepare");
}
function validateInspectionExecutionState(value, companyId, uploads) { return validateExecutionState(value, companyId, uploads, null, "inspect"); }
function createExecutionJournal({ store, owner, clock = Date.now, kind } = {}) {
  if (store?.capabilities?.persistence !== "durable" || store.capabilities.atomicCompanyUpdates !== true ||
      !require("./postgres-store").isImportUploadPostgresStore(store) || typeof store.update !== "function" ||
      !UUID.test(owner?.companyId || "") || !UUID.test(owner?.userId || "") || typeof clock !== "function") fail("configuration_invalid");
  const binding = Object.freeze({ companyId: owner.companyId, userId: owner.userId });
  const namespace = kind === "inspect" ? "inspectionExecutions" : "preparationExecutions";
  function now() { const value = clock(); if (!integer(value)) fail("clock_invalid"); return value; }
  async function update(operation) {
    return store.update(binding.companyId, state => {
      const value = state[namespace] || fresh();
      validateExecutionState(value, binding.companyId, state.uploads, state.preparation, kind);
      const result = operation(value, state);
      validateExecutionState(value, binding.companyId, state.uploads, state.preparation, kind);
      if (Object.keys(value.records).length) state[namespace] = value;
      return result;
    });
  }
  function get(value, dispatchKey, executionDigest) {
    if (!HASH.test(dispatchKey || "") || !HASH.test(executionDigest || "")) fail("request_invalid");
    const record = value.records[dispatchKey];
    if (record && (record.task.userId !== binding.userId || record.task.executionDigest !== executionDigest)) fail("binding_conflict");
    return record;
  }
  function exact(record, executionId) { if (!record || record.executionId !== executionId) fail("execution_conflict"); }
  const journal = Object.freeze({
    capabilities: Object.freeze({ persistence: "durable", atomicClaim: true, owner: binding, kind }),
    async begin(task) {
      taskIdentity(task, binding.companyId, binding.userId, kind);
      return update((value, state) => {
        const prior = get(value, task.dispatchKey, task.executionDigest);
        if (prior) { if (!isDeepStrictEqual(prior.task, task)) fail("binding_conflict"); return { created: false, record: prior }; }
        const job = state.preparation?.jobs?.[task.jobId], upload = state.uploads?.[task.uploadId];
        if (Object.keys(value.records).length >= MAX_RECORDS) fail("journal_full");
        if (kind === "inspect") {
          const dispatch = upload?.disk?.inspectionTicket?.dispatch;
          if (!upload || upload.disk.phase !== "sealed" || !ACTIVE.has(dispatch?.state) || task.deadlineAt <= now()) fail("task_stale");
        } else if (!job || !upload || !ACTIVE.has(job.state) || job.fence !== task.fence || job.lease?.token !== task.leaseToken ||
            job.lease.deadlineAt !== task.deadlineAt || job.runtimeBudgetMs !== task.maxRuntimeMs || job.reservedBytes !== task.reservedOutputBytes ||
            task.deadlineAt <= now() || upload.state !== "uploaded") fail("task_stale");
        const time = now(), record = { task: structuredClone(task), executionId: crypto.randomUUID(), resultRef: crypto.randomUUID(),
          phase: "intent", launchClaimed: false, capacityLeaseToken: null, completion: null, capacitySettled: false,
          createdAt: time, updatedAt: time };
        value.records[task.dispatchKey] = record;
        return { created: true, record };
      });
    },
    async getByKey({ dispatchKey, executionDigest } = {}) {
      return update(value => get(value, dispatchKey, executionDigest) || null);
    },
    async pending({ limit = 1 } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 4) fail("request_invalid");
      return update(value => Object.values(value.records).filter(record => record.task.userId === binding.userId &&
        record.phase === "intent").sort((a, b) => a.createdAt - b.createdAt).slice(0, limit));
    },
    async failBeforeLaunch({ dispatchKey, executionDigest, executionId } = {}) {
      return update(value => {
        const record = get(value, dispatchKey, executionDigest); exact(record, executionId);
        // This terminal transition competes in the SAME row lock as claim().
        // An existing claimant is never declared stopped by a timeout or error.
        if (record.launchClaimed) return { failed: false, record };
        const proofId = crypto.createHash("sha256").update(`journal-never-launched:${kind}:${binding.companyId}:${binding.userId}:${dispatchKey}:${executionDigest}:${executionId}`).digest("hex");
        record.launchClaimed = true; record.phase = "failed"; record.updatedAt = now();
        record.completion = { outcome: "failed", actualRuntimeMs: 0, proofId, terminationProved: true, descendants: 0, neverLaunched: true };
        return { failed: true, record };
      });
    },
    async claim({ dispatchKey, executionDigest, executionId, capacityLeaseToken } = {}) {
      if (!UUID.test(capacityLeaseToken || "")) fail("lease_invalid");
      return update(value => {
        const record = get(value, dispatchKey, executionDigest); exact(record, executionId);
        if (record.launchClaimed) {
          if (record.completion?.neverLaunched === true) return { claimed: false, record };
          if (record.capacityLeaseToken !== capacityLeaseToken) fail("lease_conflict");
          return { claimed: false, record };
        }
        // No lease expiry may steal this claim. An uncertain remote create must
        // be reconciled by its durable executionId, never attempted a second time.
        if (record.task.deadlineAt <= now()) fail("task_stale");
        record.capacityLeaseToken = capacityLeaseToken; record.launchClaimed = true; record.phase = "claimed"; record.updatedAt = now();
        return { claimed: true, record };
      });
    },
    async recordObservation({ dispatchKey, executionDigest, executionId, state, resultRef, result, termination, elapsedMs } = {}) {
      if (!["running", "unknown", "succeeded", "failed"].includes(state)) fail("observation_invalid");
      if (TERMINAL.has(state) && (termination?.proved !== true || termination.descendants !== 0 ||
          !HASH.test(termination.proofId || "") || !integer(elapsedMs))) fail("termination_unproved");
      return update(value => {
        const record = get(value, dispatchKey, executionDigest); exact(record, executionId);
        if (!record.launchClaimed || kind === "prepare" && state === "succeeded" && record.resultRef !== resultRef) fail("observation_conflict");
        if (TERMINAL.has(record.phase)) {
          if (TERMINAL.has(state) && (record.phase !== state || record.completion.proofId !== termination.proofId ||
              record.completion.actualRuntimeMs !== elapsedMs)) fail("observation_conflict");
          return record; // A delayed running response cannot undo a terminal fact.
        }
        record.phase = state; record.updatedAt = now();
        if (kind === "inspect" && state === "succeeded") record.result = structuredClone(result);
        if (TERMINAL.has(state)) record.completion = { outcome: state, actualRuntimeMs: elapsedMs,
          proofId: termination.proofId, terminationProved: true, descendants: 0 };
        return record;
      });
    },
    async markCapacitySettled({ dispatchKey, executionDigest, executionId, proofId } = {}) {
      return update(value => {
        const record = get(value, dispatchKey, executionDigest); exact(record, executionId);
        if (!TERMINAL.has(record.phase) || record.completion.proofId !== proofId) fail("settlement_conflict");
        if (!record.capacitySettled) { record.capacitySettled = true; record.updatedAt = now(); }
        return record;
      });
    }
  });
  instances.add(journal); return journal;
}
function createPreparationExecutionJournal(options) { return createExecutionJournal({ ...options, kind: "prepare" }); }
function createInspectionExecutionJournal(options) { return createExecutionJournal({ ...options, kind: "inspect" }); }
function isPreparationExecutionJournal(value) { return instances.has(value); }
module.exports = { createPreparationExecutionJournal, createInspectionExecutionJournal, isPreparationExecutionJournal,
  validatePreparationExecutionState, validateInspectionExecutionState };
