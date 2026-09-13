"use strict";
const path = require("node:path"), { isMediaProcessExecutor } = require("./media-process-executor");
const { validateDiskInspectionTask } = require("./disk-inspection-worker");
const s = require("./process-disk-worker-support"), instances = new WeakSet();
function createProcessDiskInspectionWorker({ provider, workingDirectory, executor, assertExecutionHeld, clock = Date.now } = {}) {
  if (typeof provider?.streamSealedObject !== "function" || !path.isAbsolute(workingDirectory || "") || !isMediaProcessExecutor(executor) ||
      !(executor.capabilities.supported || executor.capabilities.platform === "linux" && executor.capabilities.validationOnly && executor.capabilities.hardTermination) ||
      typeof assertExecutionHeld !== "function") s.fail("configuration_invalid");
  const root = path.resolve(workingDirectory), active = new Set(), filename = "snapshot.bin";
  async function finish(task, executionId, decoded, elapsed) {
    const termination = await executor.terminationProof(executionId);
    if (!termination) return { state: "unknown", executionId, reason: "termination_unproven" };
    await s.cleanupSnapshot(root, executionId, task.companyId, filename);
    return s.saveTerminal(path.join(root, executionId), { state: decoded.state, executionId, ...(decoded.state === "succeeded" ? { result: decoded.result } : { reason: decoded.failureCode || decoded.reason }),
      termination, elapsedMs: elapsed ?? decoded.elapsedMs, metrics: decoded.metrics });
  }
  async function observe(task, { executionId } = {}) {
    validateDiskInspectionTask(task); s.validateId(executionId); if (active.has(executionId)) return { state: "running", executionId };
    try {
      await s.intent(root, executionId, task);
      try { return await s.readJson(path.join(root, executionId, "worker-terminal.json")); } catch (error) { if (error.code !== "ENOENT") throw error; }
      const decoded = await executor.observe(executionId); if (!decoded.termination?.proved) return { state: "unknown", executionId, reason: decoded.reason };
      return await finish(task, executionId, decoded);
    } catch { return { state: "unknown", executionId, reason: "reconciliation_incomplete" }; }
  }
  const worker = Object.freeze({ capabilities: Object.freeze({ actualByteDecoding: true, separateProcess: true, isolatedWorker: true, localOnly: true,
    deadlineMode: "native-process-tree", hardTermination: executor.capabilities.hardTermination, coordinationDeadlineMode: "cooperative", osSandbox: false, readyForProduction: false }), observe,
    async inspect(task, { executionId } = {}) {
      validateDiskInspectionTask(task); s.validateId(executionId); const started = s.budget(task, clock), initialized = await s.initialize(root, executionId, task);
      if (!initialized.fresh) return observe(task, { executionId });
      active.add(executionId); let launchAttempted = false;
      const held = async () => { started.remaining(); if (await assertExecutionHeld({ task: structuredClone(task), snapshotBytes: task.sizeBytes, maxRuntimeMs: task.maxRuntimeMs }) !== true) s.fail("admission_missing"); started.remaining(); };
      try {
        const sourcePath = await s.snapshot({ provider, task, source: task, attempt: initialized.attempt, filename, held, remaining: started.remaining });
        launchAttempted = true;
        const decoded = await executor.run({ executionId, operation: "inspect", input: { task, sourcePath, logicalNow: clock() }, timeoutMs: started.remaining() });
        if (!decoded.termination?.proved) return { state: "unknown", executionId, reason: decoded.reason };
        if (decoded.state === "succeeded") await held(); return await finish(task, executionId, decoded, started.elapsed());
      } catch (error) {
        const termination = launchAttempted ? await executor.terminationProof(executionId) : { proved: true, descendants: 0, proofId: s.digest({ executionId, stage: "not_launched", task }) };
        if (!termination) return { state: "unknown", executionId, reason: "termination_unproven" };
        try { await s.cleanupSnapshot(root, executionId, task.companyId, filename); } catch { return { state: "unknown", executionId, reason: "cleanup_unproven" }; }
        return s.saveTerminal(initialized.attempt, { state: "failed", executionId, termination, elapsedMs: started.elapsed(), reason: /^process_disk_[a-z_]+$/.test(error.code || "") ? error.code : "inspection_failed" });
      } finally { active.delete(executionId); }
    }
  }); instances.add(worker); return worker;
}
function isProcessDiskInspectionWorker(value) { return Boolean(value && instances.has(value)); }
module.exports = { createProcessDiskInspectionWorker, isProcessDiskInspectionWorker };
