"use strict";
const path = require("node:path");
const { isDeepStrictEqual } = require("node:util");
const { isImportAccessPolicy } = require("./access-policy");
const { isDiskSpaceGuard } = require("./disk-space-guard");
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const instances = new WeakMap();
const ACTIVE = new Set(["dispatching", "processing", "reconciliation"]);
const MARGIN = 65536;
function fail(code = "unavailable") { throw Object.assign(new Error(`prepared_admission_${code}`), { code: `prepared_admission_${code}` }); }
function integer(value, minimum = 1) { return Number.isSafeInteger(value) && value >= minimum; }
function validateTask(task) {
  if (!task || task.schema !== 1 || ![task.jobId, task.companyId, task.userId, task.assetId, task.uploadId, task.leaseToken].every(x => UUID.test(x || "")) ||
      ![task.dispatchKey, task.executionDigest, task.source?.sha256, task.source?.objectKey].every(x => HASH.test(x || "")) ||
      !UUID.test(task.source?.objectVersion || "") || !integer(task.mediaRevision) || !integer(task.fence) || !integer(task.deadlineAt) ||
      !integer(task.maxRuntimeMs) || task.maxRuntimeMs > 180000 || !integer(task.source?.sizeBytes) || task.source.sizeBytes > 100 * 1024 ** 2 ||
      !integer(task.reservedOutputBytes) || task.reservedOutputBytes > 308 * 1024 ** 2 || !task.selection || !task.plan) fail("task_invalid");
  return task;
}
// Covers input staging + preparer's snapshot, retained prepared files + private
// result copies, and metadata. This is held bytes, not a bill or quota release.
function preparedTaskReservation(task) {
  validateTask(task);
  return { jobId: task.jobId, companyId: task.companyId, userId: task.userId, requestDigest: task.executionDigest,
    storageBytes: task.source.sizeBytes * 2 + task.reservedOutputBytes * 2 + MARGIN,
    sourceBytes: task.source.sizeBytes, runtimeBudgetMs: task.maxRuntimeMs };
}
function createPreparedDiskAdmission({ capacity, tenantStore, accessPolicy, rootDirectory, diskSpaceGuard,
  enabled = false, allowVolatileForTests = false, clock = Date.now } = {}) {
  const durable = capacity?.capabilities?.persistence === "durable" && tenantStore?.capabilities?.persistence === "durable";
  const testOnly = !durable;
  const root = path.resolve(rootDirectory || ".");
  const available = Boolean(enabled === true && path.isAbsolute(rootDirectory || "") && typeof clock === "function" &&
    capacity?.capabilities?.available === true && capacity.capabilities.atomicGlobalReservations === true &&
    tenantStore?.capabilities?.atomicCompanyUpdates === true && typeof tenantStore.update === "function" &&
    ["reserve", "assertHeld", "inspect"].every(key => typeof capacity[key] === "function") &&
    isImportAccessPolicy(accessPolicy) && accessPolicy.executionAvailable &&
    isDiskSpaceGuard(diskSpaceGuard, { rootDirectory, allowVolatileForTests }) &&
    capacity.capabilities.requiresDiskSpaceEvidence === true && capacity.acceptsDiskSpaceGuard?.(diskSpaceGuard) === true &&
    (durable || allowVolatileForTests && capacity.capabilities.testOnly === true && tenantStore.capabilities.persistence === "volatile-test"));
  const context = Object.freeze({ authenticated: true, role: "calendar_media_capacity_coordinator" });
  function now() { const value = clock(); if (!integer(value, 0)) fail("clock_invalid"); return value; }
  function allowed(task) {
    try { accessPolicy.resolve({ authenticated: true, companyId: task.companyId, userId: task.userId }); }
    catch (_) { fail("owner_invalid"); }
  }
  async function owned(task, intent, resultRef) {
    validateTask(task); allowed(task);
    await tenantStore.update(task.companyId, state => {
      const job = state.preparation?.jobs?.[task.jobId], upload = state.uploads?.[task.uploadId];
      if (!job || !upload || job.companyId !== task.companyId || job.userId !== task.userId || job.assetId !== task.assetId ||
          job.uploadId !== task.uploadId || job.mediaRevision !== task.mediaRevision || job.executionDigest !== task.executionDigest ||
          job.dispatchKey !== task.dispatchKey || job.runtimeBudgetMs !== task.maxRuntimeMs || job.reservedBytes !== task.reservedOutputBytes ||
          upload.companyId !== task.companyId || upload.userId !== task.userId || upload.assetId !== task.assetId || upload.state !== "uploaded" ||
          !isDeepStrictEqual(job.source, task.source) || !isDeepStrictEqual(job.plan, task.plan) ||
          !isDeepStrictEqual(job.selection, task.selection)) fail("owner_invalid");
      if (ACTIVE.has(job.state)) {
        if (job.fence !== task.fence || job.lease?.token !== task.leaseToken || job.lease.deadlineAt !== task.deadlineAt) fail("lease_invalid");
        if (intent === "write" && task.deadlineAt <= now()) fail("deadline_exceeded");
      } else if (intent !== "read" || job.state !== "ready" || job.completedFence !== task.fence || job.completedToken !== task.leaseToken ||
          job.result?.resultRef !== resultRef) fail("state_invalid");
    });
    allowed(task);
  }
  function receipt(value, task, requiredBytes, writing = false) {
    const expected = preparedTaskReservation(task);
    if (!value || value.purpose !== "task" || Object.keys(expected).some(key => value[key] !== expected[key]) ||
        value.storageHeld !== true || !integer(value.heldBytes) || value.heldBytes < requiredBytes ||
        writing && (value.state !== "running" || !UUID.test(value.leaseToken || "") || value.deadlineAt <= now())) fail("reservation_invalid");
  }
  async function safe(operation) {
    if (!available) fail();
    try { return await operation(); }
    catch (error) { fail(/^prepared_admission_[a-z_]{1,60}$/.test(error?.code || "") ? error.code.slice(19) : "unavailable"); }
  }
  const admission = Object.freeze({
    capabilities: Object.freeze({ available, persistence: durable ? "durable" : "volatile-test", testOnly,
      requiresDiskSpaceEvidence: true, financialHardCap: false, readyForProduction: false }),
    async reserve(task) { return safe(async () => {
      await owned(task, "write");
      const binding = preparedTaskReservation(task);
      const value = await capacity.reserve({ context, ...binding });
      receipt(value, task, binding.storageBytes);
      const diskSpaceEvidence = await diskSpaceGuard.sample();
      await capacity.assertHeld({ context, ...binding, intent: "write", diskSpaceEvidence });
      await owned(task, "write");
      // Does not acquire a process, create a directory or start any job.
      return binding;
    }); },
    async assertHeld({ task, resultRef, requiredBytes, intent = "write" } = {}) { return safe(async () => {
      if (!["read", "write"].includes(intent) || !UUID.test(resultRef || "") || !integer(requiredBytes)) fail("request_invalid");
      await owned(task, intent, resultRef);
      const binding = preparedTaskReservation(task);
      if (requiredBytes > binding.storageBytes) fail("reservation_invalid");
      const diskSpaceEvidence = intent === "write" ? await diskSpaceGuard.sample() : undefined;
      const value = await capacity.assertHeld({ context, ...binding, intent, diskSpaceEvidence });
      receipt(value, task, requiredBytes, intent === "write");
      await owned(task, intent, resultRef);
      return true;
    }); }
  });
  instances.set(admission, { root, available, testOnly }); return admission;
}
function isPreparedDiskAdmission(value, { rootDirectory, allowVolatileForTests = false } = {}) {
  const record = instances.get(value);
  return Boolean(record?.available && (!record.testOnly || allowVolatileForTests) &&
    (rootDirectory === undefined || path.isAbsolute(rootDirectory || "") && path.resolve(rootDirectory) === record.root));
}
module.exports = { createPreparedDiskAdmission, isPreparedDiskAdmission, preparedTaskReservation };
