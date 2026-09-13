"use strict";
// Workflow coordinator owns only a fixed private API client and native runtime.
// The converter child receives neither this client nor the bridge credential.
const fs = require("node:fs/promises"), path = require("node:path"), crypto = require("node:crypto");
const { isMediaProcessExecutor, safePath, digest, immutableJson, readJson } = require("./media-process-executor");
const { isWorkflowPrivateClient, fileHash, allParts } = require("./workflow-private-transfer");
const { UUID, fail } = require("./workflow-private-journal");
const { closedSpawnErrorCode } = require("./media-process-diagnostics");
function createWorkflowTaskAgent({ workingRoot, executor, allowSyntheticForTests = false, clock = Date.now, diagnostic = () => {} } = {}) {
  if (!path.isAbsolute(workingRoot || "") || !isMediaProcessExecutor(executor) ||
      !(executor.capabilities.supported || executor.capabilities.validationOnly && executor.capabilities.linuxCapabilitiesProved) || !executor.capabilities.hardTermination) fail("runtime_unvalidated");
  const root = path.resolve(workingRoot);
  return Object.freeze({
    async run(client, { recoveryOnly = false } = {}) {
      if (!isWorkflowPrivateClient(client)) fail("client_invalid");
      const executionId = client.executionId; let task, attempt, manifest, existingIntent = false;
      try {
        // A new Render task has not claimed its agent yet, so its initial
        // status may be denied. A VM replay already has the durable claimant.
        const delivery = await client.status().catch(() => null);
        if (delivery?.delivered === true) return { executionId, state: "delivered" };
        await safePath(root); attempt = path.join(root, executionId);
        await fs.mkdir(attempt, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; }); await safePath(attempt);
        const input = await client.claim(); task = input.task;
        if (!task || !UUID.test(task.companyId || "") || !UUID.test(task.assetId || "") || task.deadlineAt <= clock()) fail("task_invalid");
        const intent = { kind: input.kind, task, resultRef: input.resultRef, executionId };
        try { await immutableJson(path.join(attempt, "intent.json"), intent); }
        catch (error) { if (error.code !== "EEXIST" || digest(await readJson(path.join(attempt, "intent.json"))) !== digest(intent)) throw error; existingIntent = true; }
        try { manifest = await readJson(path.join(attempt, "return.json")); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        if (!manifest) {
          if (recoveryOnly || existingIntent) {
            // A durable intention without a returned receipt is ambiguous. A
            // process restart must observe the native identity, never re-enter
            // run() with a freshly reconstructed logical time or source.
            const observed = await executor.observe(executionId);
            diagnostic(observed.termination?.proved ? "workflow_recovery_native_terminated_result_missing" : "workflow_recovery_native_unknown");
            fail("recovery_requires_receipt");
          }
          const started = performance.now(), remaining = () => { const left = Math.floor(Math.min(task.deadlineAt - clock(), task.maxRuntimeMs - performance.now() + started)); if (left < 1) fail("deadline_exceeded"); return left; };
          const source = input.kind === "inspect" ? task : task.source;
          const inputRoot = path.join(attempt, "input"), outputRoot = path.join(attempt, "output"), musicRoot = path.join(attempt, "music");
          for (const dir of [inputRoot, outputRoot, musicRoot]) await fs.mkdir(dir, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
          const company = path.join(inputRoot, task.companyId); await fs.mkdir(company, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
          const sourceName = input.kind === "inspect" ? "source.bin" : task.uploadId + "." + (task.selection.kind === "video" ? "mp4" : "png"), sourcePath = path.join(company, sourceName);
          remaining(); await client.source(sourcePath, source); remaining();
          let music;
          if (input.music) { if (input.music.synthetic && !allowSyntheticForTests || !/^track\.(wav|mp3)$/.test(input.music.sourceName)) fail("music_unavailable");
            const m = await client.music(path.join(musicRoot, input.music.sourceName)); if (m.sha256 !== input.music.sha256) fail("music_changed");
            music = { root: musicRoot, name: input.music.sourceName, sha256: m.sha256, synthetic: input.music.synthetic, ...(input.music.rights ? { rights: input.music.rights } : {}) }; }
          const nativeInput = input.kind === "inspect" ? { task, sourcePath, logicalNow: clock() } : {
            companyId: task.companyId, assetId: task.assetId, sourceName, selection: task.selection, inputRoot, outputRoot,
            ...(music ? { music } : {}), logicalNow: clock(), deadlineAt: task.deadlineAt };
          const converted = await executor.run({ executionId, operation: input.kind, timeoutMs: remaining(), input: nativeInput });
          if (converted.state !== "succeeded") diagnostic(/^[a-z_]{1,100}$/.test(converted.failureCode || converted.reason || "") ? converted.failureCode || converted.reason : "workflow_conversion_incomplete");
          if (converted.reason === "not_started_spawn") diagnostic("workflow_spawn_" + closedSpawnErrorCode({ code: converted.spawnErrorCode }).toLowerCase());
          if (!converted.termination?.proved) fail("termination_unproved");
          const inspections = {};
          if (input.kind === "prepare" && converted.state === "succeeded") {
            await executor.withExecutionScope(executionId, async () => {
              for (const part of allParts(converted.result).values()) {
                const filePath = path.join(outputRoot, task.companyId, task.assetId, part.fileName), before = await fileHash(filePath);
                if (before.sha256 !== part.sha256 || before.size !== part.size) fail("result_changed");
                const proof = await executor.inspectPreparedFile({ filePath, descriptor: part, timeoutMs: Math.min(30000, remaining()) });
                const after = await fileHash(filePath); if (digest(before) !== digest(after)) fail("result_changed");
                inspections[part.sha256] = { ...proof, sha256: part.sha256, sizeBytes: part.size };
              }
            });
          }
          const termination = await executor.terminationProof(executionId); if (!termination?.proved || termination.descendants !== 0) fail("termination_unproved");
          manifest = { executionId, state: converted.state, termination, elapsedMs: Math.ceil(performance.now() - started), finishedAt: clock(),
            ...(converted.state === "succeeded" ? input.kind === "inspect" ? { result: converted.result } : { prepared: converted.result, inspections } : {}) };
          await immutableJson(path.join(attempt, "return.json"), manifest);
        }
        await client.manifest(manifest);
        if (manifest.state === "succeeded" && manifest.prepared) for (const p of allParts(manifest.prepared).values()) {
          await client.part(p.sha256, path.join(attempt, "output", task.companyId, task.assetId, p.fileName));
        }
        await client.complete();
        // Render retains only this closed public-free envelope, not metadata.
        return { executionId, state: "delivered" };
      } catch (error) {
        diagnostic(/^[a-z_]{1,100}$/.test(error?.code || "") ? error.code : "workflow_task_incomplete");
        // No automatic new conversion. Native/job proof stays in the private
        // journal or task disk; absent return evidence leaves API capacity held.
        return { executionId, state: "reconciliation_required" };
      }
    }
  });
}
function registerWorkflowTask({ task, agent, clientForExecution }) {
  if (typeof task !== "function" || typeof agent?.run !== "function" || typeof clientForExecution !== "function") fail("configuration_invalid");
  return task({ name: "prepareCalendarMedia", retry: { maxRetries: 0 }, timeoutSeconds: 180, plan: "flex" }, async (_context, input) => {
    if (!input || Object.keys(input).length !== 1 || !UUID.test(input.executionId || "")) return { state: "invalid_request" };
    return agent.run(clientForExecution(input.executionId));
  });
}
module.exports = { createWorkflowTaskAgent, registerWorkflowTask };
