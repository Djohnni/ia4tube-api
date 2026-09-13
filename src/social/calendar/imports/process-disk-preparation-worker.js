"use strict";
const path = require("node:path"), { isMediaProcessExecutor } = require("./media-process-executor");
const { isPreparedDiskAdmission, preparedTaskReservation } = require("./prepared-disk-admission");
const { isPreparedDiskResultStore } = require("./prepared-disk-store");
const s = require("./process-disk-worker-support"), workers = new WeakSet();
function createProcessDiskPreparationWorker({ provider, workingDirectory, preparationRoot, resultStore, admission, executor,
  musicRoot, resolveMusicTrack, allowSyntheticForTests = false, allowVolatileForTests = false, clock = Date.now } = {}) {
  if (typeof provider?.streamSealedObject !== "function" || !path.isAbsolute(workingDirectory || "") || !path.isAbsolute(preparationRoot || "") ||
      !isMediaProcessExecutor(executor) || !(executor.capabilities.supported || executor.capabilities.platform === "linux" && executor.capabilities.validationOnly && executor.capabilities.hardTermination) ||
      !isPreparedDiskAdmission(admission, { allowVolatileForTests }) || !isPreparedDiskResultStore(resultStore, { allowVolatileForTests })) s.fail("configuration_invalid");
  const root = path.resolve(workingDirectory), outputRoot = path.resolve(preparationRoot), active = new Set();
  const filename = task => `${task.uploadId}.${task.selection.kind === "video" ? "mp4" : "png"}`;
  function binding(task, resultRef) { preparedTaskReservation(task); s.validateId(resultRef); }
  async function finish(task, { executionId, resultRef }, converted, started) {
    const attempt = path.join(root, executionId), query = Object.fromEntries(["companyId", "userId", "assetId", "mediaRevision", "dispatchKey", "executionDigest"].map(key => [key, task[key]]));
    query.resultRef = resultRef;
    let result, reason = converted.failureCode || converted.reason;
    if (converted.state === "succeeded") {
      try {
        // A lost acknowledgement is reconciled from the immutable result first.
        result = await resultStore.inspectCommitted(query);
      } catch {
        let commit;
        try { commit = await s.readJson(path.join(attempt, "commit.json")); }
        catch (error) { if (error.code !== "ENOENT") throw error;
          commit = { task, prepared: converted.result, resultRef, finishedAt: clock(), elapsedMs: started?.elapsed() ?? converted.elapsedMs };
          await s.immutableJson(path.join(attempt, "commit.json"), commit);
        }
        if (s.digest(commit.task) !== s.digest(task) || commit.resultRef !== resultRef || s.digest(commit.prepared) !== s.digest(converted.result)) s.fail("binding_invalid");
        result = await executor.withExecutionScope(executionId, () => resultStore.commit(commit));
      }
    }
    const termination = await executor.terminationProof(executionId);
    if (!termination) return { state: "unknown", executionId, reason: "termination_unproven" };
    await s.cleanupSnapshot(root, executionId, task.companyId, filename(task));
    return s.saveTerminal(attempt, { state: result ? "succeeded" : "failed", executionId, ...(result ? { resultRef } : { reason }),
      elapsedMs: started?.elapsed() ?? converted.elapsedMs, termination, metrics: converted.metrics });
  }
  async function observe(task, { executionId, resultRef } = {}) {
    binding(task, resultRef); s.validateId(executionId);
    if (active.has(executionId)) return { state: "running", executionId };
    try {
      await s.intent(root, executionId, task, resultRef);
      try { return await s.readJson(path.join(root, executionId, "worker-terminal.json")); } catch (error) { if (error.code !== "ENOENT") throw error; }
      const converted = await executor.observe(executionId);
      if (!converted.termination?.proved) return { state: "unknown", executionId, reason: converted.reason };
      return await finish(task, { executionId, resultRef }, converted);
    } catch { return { state: "unknown", executionId, reason: "reconciliation_incomplete" }; }
  }
  const worker = Object.freeze({ capabilities: Object.freeze({ actualPreparation: true, separateProcess: true, isolatedWorker: true, localOnly: true,
    deadlineMode: "native-process-tree", hardTermination: executor.capabilities.hardTermination, coordinationDeadlineMode: "cooperative", osSandbox: false, readyForProduction: false }), observe,
    async execute(task, { executionId, resultRef } = {}) {
      binding(task, resultRef); s.validateId(executionId); const reservation = preparedTaskReservation(task), started = s.budget(task, clock);
      const initialized = await s.initialize(root, executionId, task, resultRef);
      if (!initialized.fresh) return observe(task, { executionId, resultRef });
      active.add(executionId); let launchAttempted = false;
      const held = async () => { started.remaining(); if (await admission.assertHeld({ task, resultRef, requiredBytes: reservation.storageBytes, intent: "write" }) !== true) s.fail("admission_missing"); started.remaining(); };
      try {
        await s.safePath(outputRoot);
        await s.snapshot({ provider, task, source: task.source, attempt: initialized.attempt, filename: filename(task), held, remaining: started.remaining });
        let music;
        if (task.selection.musicTrackId) {
          if (typeof resolveMusicTrack !== "function" || !path.isAbsolute(musicRoot || "")) s.fail("music_unavailable");
          const track = await resolveMusicTrack(task.selection.musicTrackId, task.companyId);
          music = { root: path.resolve(musicRoot), name: track?.sourceName, sha256: track?.sha256, synthetic: track?.synthetic === true, ...(track?.rights ? { rights: track.rights } : {}) };
          if (music.synthetic && !allowSyntheticForTests) s.fail("music_unavailable");
        }
        await held(); launchAttempted = true;
        const converted = await executor.run({ executionId, operation: "prepare", timeoutMs: started.remaining(), input: {
          companyId: task.companyId, assetId: task.assetId, sourceName: filename(task), selection: task.selection,
          inputRoot: initialized.attempt, outputRoot, ...(music ? { music } : {}), logicalNow: clock(), deadlineAt: task.deadlineAt } });
        if (!converted.termination?.proved) return { state: "unknown", executionId, reason: converted.reason };
        if (converted.state === "succeeded") await held(); return await finish(task, { executionId, resultRef }, converted, started);
      } catch (error) {
        const termination = launchAttempted ? await executor.terminationProof(executionId) : { proved: true, descendants: 0, proofId: s.digest({ executionId, stage: "not_launched", task }) };
        if (!termination) return { state: "unknown", executionId, reason: "termination_unproven" };
        try { await s.cleanupSnapshot(root, executionId, task.companyId, filename(task)); } catch { return { state: "unknown", executionId, reason: "cleanup_unproven" }; }
        return s.saveTerminal(initialized.attempt, { state: "failed", executionId, reason: /^(process_disk_|media_process_|prepared_disk_)[a-z_]{1,80}$/.test(error.code || "") ? error.code : "preparation_failed", termination, elapsedMs: started.elapsed() });
      } finally { active.delete(executionId); }
    }
  }); workers.add(worker); return worker;
}
function isProcessDiskPreparationWorker(value) { return Boolean(value && workers.has(value)); }
module.exports = { createProcessDiskPreparationWorker, isProcessDiskPreparationWorker };
