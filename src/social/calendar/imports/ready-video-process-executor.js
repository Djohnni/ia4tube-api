"use strict";
// Durable coordination for the ready-video codec launcher. It deliberately has
// no VM, namespace or cgroup claims. An interrupted intent is never relaunched.
const fs = require("node:fs/promises"), path = require("node:path"), crypto = require("node:crypto");
const { AsyncLocalStorage } = require("node:async_hooks");
const { safePath, readJson, immutableJson, digest } = require("./media-process-executor");
const { validateDiskInspectionTask } = require("./disk-inspection-worker");
const native = require("./native-ready-video");
const instances = new WeakSet(), UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
function fail(code) { throw Object.assign(new Error(`ready_video_process_${code}`), { code: `ready_video_process_${code}` }); }
function createReadyVideoProcessExecutor({ workingRoot, allowedRoots = [], codecExecutor, ffmpegPath, ffprobePath, clock = Date.now } = {}) {
  if (!path.isAbsolute(workingRoot || "") || !allowedRoots.length || allowedRoots.some(root => !path.isAbsolute(root || "")) ||
      !require("./ready-video-codec-executor").isReadyVideoCodecExecutor(codecExecutor) || typeof clock !== "function") fail("configuration_invalid");
  const root = path.resolve(workingRoot), roots = allowedRoots.map(value => path.resolve(value)), scope = new AsyncLocalStorage();
  let active = false;
  async function permitted(value, file = false) {
    const exact = await safePath(value, { file });
    if (!roots.some(parent => exact === parent || exact.startsWith(parent + path.sep))) fail("path_forbidden");
    return exact;
  }
  function id(value) { if (!UUID.test(value || "")) fail("execution_invalid"); }
  async function observe(executionId) {
    id(executionId);
    try {
      const request = await readJson(path.join(root, executionId, "request.json"));
      const terminal = await readJson(path.join(root, executionId, "terminal.json"));
      if (request.executionId !== executionId || terminal.executionId !== executionId || terminal.requestDigest !== digest(request) ||
          !["succeeded", "failed"].includes(terminal.state) || terminal.termination?.proved !== true ||
          terminal.termination.descendants !== 0 || !HASH.test(terminal.termination.proofId || "")) fail("receipt_invalid");
      return terminal;
    } catch { return { state: "unknown", executionId, reason: "receipt_unavailable" }; }
  }
  async function projected(operation, input) {
    if (operation === "inspect") {
      validateDiskInspectionTask(input.task);
      if (input.task.mediaKind !== "video") fail("video_required");
      return { task: input.task, sourcePath: await permitted(input.sourcePath, true) };
    }
    if (operation === "prepare") {
      require("./preparation").validateSpec({ companyId: input.companyId, assetId: input.assetId, sourceName: input.sourceName, ...input.selection });
      if (input.selection.kind !== "video" || input.selection.audioMode !== "original" || input.music) fail("original_video_required");
      return { companyId: input.companyId, assetId: input.assetId, sourceName: input.sourceName, selection: input.selection,
        inputRoot: await permitted(input.inputRoot), outputRoot: await permitted(input.outputRoot), deadlineAt: input.deadlineAt };
    }
    if (operation === "inspect_output") {
      if (!["image/jpeg", "video/mp4"].includes(input.descriptor?.mimeType) || !HASH.test(input.descriptor?.sha256 || "")) fail("descriptor_invalid");
      return { filePath: await permitted(input.filePath, true), descriptor: input.descriptor };
    }
    fail("operation_forbidden");
  }
  const executor = Object.freeze({
    capabilities: Object.freeze({ separateProcess: true, isolatedWorker: true, osSandbox: false, platform: process.platform,
      supported: true, nativeReadyVideo: true, testOnly: false, maxRuntimeMs: 180000, maxConcurrent: 1,
      get hardTermination() { return codecExecutor.capabilities?.hardTermination === true; } }),
    async prepareRuntime() {
      await safePath(root);
      if (typeof codecExecutor.prepareRuntime === "function") await codecExecutor.prepareRuntime();
      if (codecExecutor.capabilities?.hardTermination !== true) fail("runtime_unproved");
      return true;
    },
    observe,
    async withExecutionScope(executionId, action) { id(executionId); return scope.run(executionId, action); },
    async terminationProof(executionId) {
      id(executionId);
      try {
        const original = await observe(executionId), proofs = [];
        if (original.termination?.proved !== true) return undefined;
        proofs.push(original.termination.proofId);
        const children = path.join(root, executionId, "children"); let names;
        try { await safePath(children); names = await fs.readdir(children); } catch (error) { if (error.code !== "ENOENT") throw error; names = []; }
        if (names.length > 32) return undefined;
        for (const name of names) {
          if (!name.endsWith(".json") || !UUID.test(name.slice(0, -5))) return undefined;
          const childId = name.slice(0, -5), link = await readJson(path.join(children, name));
          const request = await readJson(path.join(root, childId, "request.json")), terminal = await observe(childId);
          if (link.executionId !== childId || link.requestDigest !== digest(request) || request.parentExecutionId !== executionId ||
              terminal.termination?.proved !== true) return undefined;
          proofs.push(terminal.termination.proofId);
        }
        return { proved: true, descendants: 0, proofId: digest(proofs.sort()) };
      } catch { return undefined; }
    },
    async inspectPreparedFile(input) {
      const executionId = crypto.randomUUID(), result = await executor.run({ executionId, operation: "inspect_output", input,
        timeoutMs: Math.min(input.timeoutMs || 30000, 30000) });
      if (result.state !== "succeeded") fail("output_inspection_failed");
      return result.result;
    },
    async run({ executionId, operation, input, timeoutMs = 180000 } = {}) {
      id(executionId);
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 180000 || codecExecutor.capabilities?.hardTermination !== true) fail("runtime_unproved");
      const value = await projected(operation, input), attempt = path.join(root, executionId);
      const request = { schema: 1, executionId, operation, input: value, timeoutMs,
        ...(scope.getStore() ? { parentExecutionId: scope.getStore() } : {}) };
      try { await fs.mkdir(attempt, { mode: 0o700 }); } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const prior = await readJson(path.join(attempt, "request.json"));
        if (digest(prior) !== digest(request)) fail("intent_conflict");
        return observe(executionId);
      }
      await immutableJson(path.join(attempt, "request.json"), request);
      if (request.parentExecutionId) {
        id(request.parentExecutionId);
        const parent = path.join(root, request.parentExecutionId);
        const parentRequest = await readJson(path.join(parent, "request.json"));
        if (parentRequest.executionId !== request.parentExecutionId || parentRequest.parentExecutionId) fail("scope_invalid");
        const children = path.join(parent, "children");
        try { await fs.mkdir(children, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
        await safePath(children);
        if ((await fs.readdir(children)).length >= 32) fail("scope_full");
        // Persist the relationship before any codec can start. A crash or an
        // unknown child receipt then prevents a false whole-execution proof.
        await immutableJson(path.join(children, executionId + ".json"), { executionId, requestDigest: digest(request) });
      }
      const started = performance.now(), proofs = []; let pending = 0, unproved = false;
      const hooks = {
        onCodecStart() { pending++; },
        onCodecResult(result) {
          const proof = result?.termination;
          if (pending < 1 || proof?.proved !== true || proof.descendants !== 0 || !HASH.test(proof.proofId || "")) unproved = true;
          else proofs.push(proof.proofId);
          pending--;
        }
      };
      let result, reason;
      if (active) reason = "busy";
      else {
        active = true;
        try {
          const options = { codecExecutor, ffmpegPath, ffprobePath, ...hooks };
          if (operation === "inspect") {
            const inspected = await native.inspectNativeReadyVideo({ ...options, filePath: value.sourcePath, timeoutMs });
            const task = value.task;
            if (inspected.sha256 !== task.sha256 || inspected.size !== task.sizeBytes) fail("source_changed");
            result = { providerType: task.providerType, companyId: task.companyId, userId: task.userId, ticketId: task.ticketId,
              objectKey: task.objectKey, objectVersion: task.objectVersion, executionDigest: task.executionDigest,
              finishedAt: clock(), elapsedMs: Math.ceil(performance.now() - started),
              inspection: { complete: true, decoded: true, signatureVerified: true, sizeBytes: inspected.size,
                sha256: inspected.sha256, detectedMime: "video/mp4", width: inspected.width, height: inspected.height,
                durationMs: Math.round(inspected.durationSeconds * 1000), hasAudio: inspected.hasAudio, colorMode: "sdr" } };
          } else if (operation === "prepare") {
            result = await native.createNativeReadyVideoPreparer({ ...options, inputRoot: value.inputRoot, outputRoot: value.outputRoot,
              maxPreparationMs: timeoutMs, clock }).prepare({ companyId: value.companyId, assetId: value.assetId, sourceName: value.sourceName,
                ...value.selection }, { deadlineAt: value.deadlineAt });
          } else if (value.descriptor.mimeType === "video/mp4") {
            result = await native.inspectNativeReadyVideo({ ...options, filePath: value.filePath, timeoutMs });
            if (result.sha256 !== value.descriptor.sha256 || result.size !== value.descriptor.size) fail("source_changed");
          } else {
            // Only the bounded generated JPEG thumbnail takes this existing path.
            // Source photos and image-to-video conversions are not admitted here.
            result = await require("./prepared-disk-output-inspector").createPreparedDiskOutputInspector()
              .inspectFile({ ...value, timeoutMs });
          }
        } catch (error) { reason = /^[a-z][a-z0-9_]{1,100}$/.test(error?.code || "") ? error.code : "operation_failed"; }
        finally { active = false; }
      }
      if (unproved || pending !== 0) return { state: "unknown", executionId, reason: "termination_unproved" };
      const terminal = { state: result ? "succeeded" : "failed", executionId, requestDigest: digest(request),
        ...(result ? { result } : { reason }), elapsedMs: Math.ceil(performance.now() - started),
        termination: { proved: true, descendants: 0, proofId: digest({ request: digest(request), proofs, launched: proofs.length > 0 }) } };
      await immutableJson(path.join(attempt, "terminal.json"), terminal);
      return terminal;
    }
  });
  instances.add(executor); return executor;
}
function isReadyVideoProcessExecutor(value) { return Boolean(value && instances.has(value)); }
module.exports = { createReadyVideoProcessExecutor, isReadyVideoProcessExecutor };
