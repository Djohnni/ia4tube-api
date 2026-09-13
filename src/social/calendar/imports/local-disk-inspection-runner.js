"use strict";
// Explicit local integration harness. This is not an isolated or paid runner.
const crypto = require("node:crypto");
const instances = new WeakSet();
function fail() { throw Object.assign(new Error("import_inspection_local_runner_unavailable"), { code: "import_inspection_local_runner_unavailable" }); }
function createLocalDiskInspectionRunnerForTests({ store, worker, getWorker, enabled = false, afterResultForTests } = {}) {
  const { isDiskBoundedInspectionWorker, validateDiskInspectionTask } = require("./disk-inspection-worker");
  if (!enabled || store?.capabilities?.persistence !== "volatile-test" || store.capabilities.atomicCompanyUpdates !== true ||
      typeof store.update !== "function" || (getWorker !== undefined ? typeof getWorker !== "function" || worker !== undefined : !isDiskBoundedInspectionWorker(worker)) ||
      afterResultForTests !== undefined && typeof afterResultForTests !== "function") fail();
  function owned(state, task) {
    const row = state.uploads?.[task.uploadId], ticket = row?.disk?.inspectionTicket, dispatch = ticket?.dispatch;
    if (!row || row.companyId !== task.companyId || row.userId !== task.userId || row.assetId !== task.assetId ||
        row.objectKey !== task.objectKey || row.sha256 !== task.sha256 || row.sizeBytes !== task.sizeBytes || row.kind !== task.mediaKind ||
        row.disk.phase !== "sealed" || row.disk.objectVersion !== task.objectVersion || ticket.ticketId !== task.ticketId ||
        dispatch?.dispatchKey !== task.dispatchKey || dispatch.requestDigest !== task.executionDigest || dispatch.fenceToken !== task.fenceToken ||
        dispatch.startedAt !== task.startedAt || dispatch.deadlineAt !== task.deadlineAt) fail();
    return ticket;
  }
  const runner = Object.freeze({
    capabilities: Object.freeze({ testOnly: true, localOnly: true, isolatedWorker: false, idempotentDispatch: true,
      authoritativeLookup: true, maxRuntimeMs: 180000, deadlineMode: "cooperative", hardTermination: false, readyForProduction: false }),
    async dispatch(task) {
      validateDiskInspectionTask(task);
      const executor = getWorker ? getWorker() : worker;
      if (!isDiskBoundedInspectionWorker(executor)) fail();
      const taskDigest = crypto.createHash("sha256").update(JSON.stringify(task)).digest("hex");
      const claim = await store.update(task.companyId, state => {
        const ticket = owned(state, task);
        if (ticket.localExecution) {
          if (ticket.localExecution.taskDigest !== taskDigest) fail();
          return { first: false, response: structuredClone(ticket.localExecution.response) };
        }
        const response = { dispatchKey: task.dispatchKey, executionDigest: task.executionDigest,
          executionId: crypto.randomUUID(), state: "running" };
        ticket.localExecution = { taskDigest, response };
        return { first: true, response: structuredClone(response) };
      });
      if (!claim.first) return claim.response;
      let response;
      try { response = { ...claim.response, state: "succeeded", result: await executor.inspect(task) }; }
      catch (_) { response = { ...claim.response, state: "failed" }; }
      await store.update(task.companyId, state => {
        const ticket = owned(state, task);
        if (ticket.localExecution?.taskDigest !== taskDigest || ticket.localExecution.response.executionId !== response.executionId) fail();
        ticket.localExecution.response = response;
      });
      if (afterResultForTests) await afterResultForTests();
      return structuredClone(response);
    },
    async getByKey(request) {
      if (!request || Object.keys(request).some(key => !["companyId", "userId", "dispatchKey", "executionDigest"].includes(key))) fail();
      return store.update(request.companyId, state => {
        const rows = Object.values(state.uploads || {}).filter(row => row.disk?.inspectionTicket?.dispatch?.dispatchKey === request.dispatchKey);
        if (rows.length !== 1 || rows[0].companyId !== request.companyId || rows[0].userId !== request.userId ||
            rows[0].disk.inspectionTicket.dispatch.requestDigest !== request.executionDigest) fail();
        const execution = rows[0].disk.inspectionTicket.localExecution;
        return execution ? structuredClone(execution.response) : { dispatchKey: request.dispatchKey,
          executionDigest: request.executionDigest, state: "not_found", authoritative: true };
      });
    }
  });
  instances.add(runner); return runner;
}
function isLocalDiskInspectionRunner(value) { return Boolean(value && instances.has(value)); }
module.exports = { createLocalDiskInspectionRunnerForTests, isLocalDiskInspectionRunner };
