"use strict";
const fs = require("node:fs/promises"), path = require("node:path"), crypto = require("node:crypto"), { spawn } = require("node:child_process");
const instances = new WeakSet(), UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const { AsyncLocalStorage } = require("node:async_hooks");
const MAX_JSON = 262144, HARD_MS = 180000;
function fail(code) { throw Object.assign(new Error("media_process_" + code), { code: "media_process_" + code }); }
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, stable(value[key])]));
  return value;
}
function digest(value) { return crypto.createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(stable(value))).digest("hex"); }
async function safePath(value, { file = false, beneath } = {}) {
  if (typeof value !== "string" || !path.isAbsolute(value) || /[\0\r\n"]/.test(value) || /^[/\\]{2}/.test(value) || value.replace(/^[a-z]:/i, "").includes(":")) fail("path_invalid");
  const exact = path.resolve(value);
  if (exact === path.parse(exact).root || beneath && (exact === beneath || !exact.startsWith(beneath + path.sep))) fail("path_invalid");
  const stat = await fs.lstat(exact);
  if (stat.isSymbolicLink() || path.resolve(await fs.realpath(exact)) !== exact || (file ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory())) fail("path_invalid");
  return exact;
}
async function readJson(file) { await safePath(file, { file: true }); const stat = await fs.stat(file); if (stat.size < 2 || stat.size > MAX_JSON) fail("receipt_invalid"); return JSON.parse(await fs.readFile(file, "utf8")); }
async function immutableJson(file, value) { const text = JSON.stringify(value); if (Buffer.byteLength(text) > MAX_JSON) fail("request_invalid"); const handle = await fs.open(file, "wx", 0o600); try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); } }
function cleanEnvironment(root) { return process.platform === "win32" ? { SystemRoot: process.env.SystemRoot, TEMP: root, TMP: root, UV_THREADPOOL_SIZE: "2" } : { LANG: "C", LC_ALL: "C", TMPDIR: root, UV_THREADPOOL_SIZE: "2" }; }
async function compileSupervisor(root) {
  if (process.platform === "linux") return require("./linux-media-runtime").compileLinuxSupervisor(root, { safePath, cleanEnvironment });
  const source = path.join(__dirname, "media-process-supervisor.cs"), bytes = await fs.readFile(source), key = digest(bytes);
  const destination = path.join(root, `supervisor-${key}.exe`);
  try { await safePath(destination, { file: true }); return destination; } catch (error) { if (error.code !== "ENOENT") throw error; }
  const compiler = path.join(process.env.SystemRoot || "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
  // Windows components may have servicing hardlinks. This fixed OS compiler is
  // not task media; resolve its canonical path without accepting a caller path.
  const compilerStat = await fs.lstat(compiler), compilerReal = await fs.realpath(compiler);
  if (!compilerStat.isFile() || compilerStat.isSymbolicLink() || compilerReal.toLowerCase() !== compiler.toLowerCase()) fail("compiler_invalid");
  const temporary = path.join(root, `compile-${crypto.randomUUID()}.exe`);
  await new Promise((resolve, reject) => {
    let child;
    try { child = spawn(compiler, ["/nologo", "/optimize+", "/target:exe", "/platform:x64", `/out:${temporary}`, source], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: cleanEnvironment(root) }); }
    catch { reject(Object.assign(new Error("media_process_compiler_failed"), { code: "media_process_compiler_failed" })); return; }
    let bytes = 0, failed = false; const timer = setTimeout(() => { failed = true; child.kill(); }, 30000);
    child.once("error", () => { failed = true; });
    child.once("close", code => { clearTimeout(timer); !failed && code === 0 && bytes <= MAX_JSON ? resolve() : reject(Object.assign(new Error("media_process_compiler_failed"), { code: "media_process_compiler_failed" })); });
    for (const stream of [child.stdout, child.stderr]) if (stream) stream.on("data", chunk => { bytes += chunk.length; if (bytes > MAX_JSON) { failed = true; child.kill(); } });
  });
  await safePath(temporary, { file: true });
  // Link+unlink can leave a Windows executable inode delete-pending while a
  // handle closes. Publish the completed executable by same-volume rename.
  try { await fs.rename(temporary, destination); } catch (error) {
    if (!["EEXIST", "EPERM"].includes(error.code)) throw error;
    await safePath(destination, { file: true }); await fs.unlink(temporary);
  }
  await safePath(destination, { file: true }); return destination;
}
/** Fixed local worker entrypoint, never a caller-selected executable/command.
 * Windows tree termination is physical. Unsupported platforms fail closed;
 * Linux process groups alone are deliberately not presented as equivalent.
 */
function createMediaProcessExecutor({ workingRoot, ffmpegPath, allowedRoots = [], memoryBytes = 512 * 1024 ** 2, syntheticTests = false, linuxRuntime } = {}) {
  if (!path.isAbsolute(workingRoot || "") || !path.isAbsolute(ffmpegPath || "") || !Array.isArray(allowedRoots) || allowedRoots.some(root => !path.isAbsolute(root || "")) ||
      !Number.isSafeInteger(memoryBytes) || memoryBytes < 64 * 1024 ** 2 || memoryBytes > 512 * 1024 ** 2) fail("configuration_invalid");
  const root = path.resolve(workingRoot), roots = [root, ...allowedRoots.map(value => path.resolve(value))];
  const linux = linuxRuntime === undefined ? undefined : require("./linux-media-runtime").normalizeLinuxRuntime(linuxRuntime);
  let active = 0, supervisorPromise, linuxProof; const scope = new AsyncLocalStorage();
  async function readyRuntime() {
    if (process.platform !== "win32" && !(process.platform === "linux" && linux)) fail("platform_unvalidated");
    supervisorPromise ||= compileSupervisor(root); const native = await supervisorPromise;
    if (process.platform === "linux" && !linuxProof) linuxProof = await require("./linux-media-runtime").probeLinuxRuntime(native, linux, cleanEnvironment, root);
    return native;
  }
  async function permitted(value, file = false) { const exact = await safePath(value, { file }); if (!roots.some(parent => exact === parent || exact.startsWith(parent + path.sep))) fail("path_forbidden"); return exact; }
  async function project(operation, input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) fail("request_invalid");
    if (operation === "prepare") {
      const { companyId, assetId, sourceName, selection, inputRoot, outputRoot, music, logicalNow, deadlineAt } = input;
      if (!UUID.test(companyId || "") || !UUID.test(assetId || "") || !/^[a-f0-9-]{36}\.(png|mp4)$/.test(sourceName || "") || !Number.isSafeInteger(logicalNow) || !Number.isSafeInteger(deadlineAt)) fail("request_invalid");
      require("./preparation").validateSpec({ companyId, assetId, sourceName, ...selection });
      const selectionKeys = ["kind", "targets", "audioMode", "musicalTargets", "musicTrackId", "shareToFeed"];
      if (!selection || Object.keys(selection).some(key => !selectionKeys.includes(key))) fail("request_invalid");
      const projected = { companyId, assetId, sourceName, selection, inputRoot: await permitted(inputRoot), outputRoot: await permitted(outputRoot), logicalNow, deadlineAt };
      await permitted(path.join(projected.inputRoot, companyId, sourceName), true);
      if (process.platform === "linux") {
        // Privileged launcher never receives the shared preparation root as a
        // writable mount. Trusted coordinator creates only this task's path.
        let exact = projected.outputRoot;
        for (const name of [companyId, assetId]) {
          exact = path.join(exact, name);
          try { await fs.mkdir(exact, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
          await permitted(exact);
        }
      }
      if (music) {
        if (!/^[a-zA-Z0-9_-]{1,100}\.(wav|mp3)$/.test(music.name || "") || !/^[a-f0-9]{64}$/.test(music.sha256 || "") || typeof music.synthetic !== "boolean") fail("request_invalid");
        projected.music = { root: await permitted(music.root), name: music.name, sha256: music.sha256, synthetic: music.synthetic };
        if (!music.synthetic) {
          if (music.rights?.commercialPublishing !== true || !/^[a-zA-Z0-9_-]{1,100}$/.test(music.rights.evidenceId || "")) fail("music_rights_invalid");
          projected.music.rights = { commercialPublishing: true, evidenceId: music.rights.evidenceId };
        }
        await permitted(path.join(projected.music.root, music.name), true);
      }
      return projected;
    }
    if (operation === "inspect") {
      require("./disk-inspection-worker").validateDiskInspectionTask(input.task);
      if (!Number.isSafeInteger(input.logicalNow)) fail("request_invalid");
      return { task: input.task, sourcePath: await permitted(input.sourcePath, true), logicalNow: input.logicalNow };
    }
    if (operation === "inspect_output") {
      const descriptor = input.descriptor;
      if (!descriptor || !["image/jpeg", "video/mp4"].includes(descriptor.mimeType) || !Number.isSafeInteger(descriptor.size) || descriptor.size < 1 || descriptor.size > (descriptor.mimeType === "image/jpeg" ? 8 : 100) * 1024 ** 2 || !/^[a-f0-9]{64}$/.test(descriptor.sha256 || "")) fail("request_invalid");
      return { filePath: await permitted(input.filePath, true), descriptor: { mimeType: descriptor.mimeType, size: descriptor.size, sha256: descriptor.sha256 } };
    }
    if (operation === "test_tree" && syntheticTests === true && ["stall", "child_exit", "output", "finite_output", "environment", "linux_containment", "linux_task_pressure", "linux_memory_pressure"].includes(input.mode) && Object.keys(input).length === 1) return { mode: input.mode };
    fail("operation_forbidden");
  }
  async function observe(executionId) {
    if (!UUID.test(executionId || "")) fail("execution_invalid");
    const attempt = path.join(root, executionId);
    const nativeReceipts = process.platform === "linux" ? attempt + ".supervision" : attempt;
    try {
      const request = await readJson(path.join(attempt, "request.json"));
      if (request.executionId !== executionId || request.schema !== 1) fail("receipt_invalid");
      let launcher;
      try { launcher = await readJson(path.join(attempt, "launcher-terminal.json")); } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (launcher) {
        for (const name of ["terminal.json", "started.json"]) {
          try { await fs.lstat(path.join(nativeReceipts, name)); return { state: "unknown", executionId, reason: "launch_receipt_conflict" }; }
          catch (error) { if (error.code !== "ENOENT") throw error; }
        }
        if (launcher.schema !== 1 || launcher.executionId !== executionId || launcher.requestDigest !== digest(request) ||
            launcher.state !== "not_started_proved" || !["compile", "spawn", "busy", "deadline"].includes(launcher.stage) || launcher.workerStarted !== false ||
            !Number.isSafeInteger(launcher.elapsedMs) || launcher.elapsedMs < 0) return { state: "unknown", executionId, reason: "launch_receipt_invalid" };
        return { state: "failed", executionId, reason: `not_started_${launcher.stage}`, elapsedMs: launcher.elapsedMs,
          termination: { proved: true, descendants: 0, proofId: digest({ request, launcher }) } };
      }
      const terminal = await readJson(path.join(nativeReceipts, "terminal.json"));
      if (terminal.schema !== 1 || !["succeeded", "failed", "timed_out", "parent_lost", "output_limit"].includes(terminal.state) || terminal.termination?.proved !== true || terminal.termination.descendants !== 0 || !Number.isSafeInteger(terminal.elapsedMs) || terminal.elapsedMs < 0) return { state: "unknown", executionId };
      if (!Number.isSafeInteger(terminal.supervisor?.pid) || terminal.supervisor.pid < 1 || !/^[0-9]{1,20}$/.test(terminal.supervisor.creationTicks || "")) return { state: "unknown", executionId };
      supervisorPromise ||= compileSupervisor(root);
      const native = await supervisorPromise;
      if (process.platform === "linux" && (terminal.platform !== "linux" || !/^[a-f0-9-]{36}$/.test(terminal.supervisor.bootId || ""))) return { state: "unknown", executionId, reason: "supervisor_identity_invalid" };
      const supervisorExit = await new Promise(resolve => { const probe = spawn(native, ["--observe", String(terminal.supervisor.pid), terminal.supervisor.creationTicks,
        ...(process.platform === "linux" ? [terminal.supervisor.bootId] : [])],
        { shell: false, windowsHide: true, stdio: "ignore", env: cleanEnvironment(root) }); probe.once("error", () => resolve(70)); probe.once("close", resolve); });
      if (supervisorExit !== 0) return { state: supervisorExit === 75 ? "running" : "unknown", executionId, reason: "supervisor_not_terminated" };
      const termination = { proved: true, descendants: 0, proofId: digest({ requestDigest: digest(request), terminal }) };
      const common = { executionId, termination, elapsedMs: terminal.elapsedMs, metrics: terminal.metrics, ...(terminal.limits ? { limits: terminal.limits } : {}), reason: terminal.state };
      if (terminal.state !== "succeeded" || terminal.exitCode !== 0) {
        let failureCode;
        try { const failure = await readJson(path.join(attempt, "failure.json")); if (failure.schema === 1 && /^(media_|disk_|prepared_disk_|process_disk_)[a-z_]{1,80}$/.test(failure.code || "")) failureCode = failure.code; } catch {}
        return { ...common, state: "failed", ...(failureCode ? { failureCode } : {}) };
      }
      let result; try { result = await readJson(path.join(attempt, "result.json")); } catch { return { ...common, state: "failed", reason: "result_invalid" }; }
      if (result.schema !== 1 || result.executionId !== executionId || result.requestDigest !== digest(request) || result.complete !== true) return { ...common, state: "failed", reason: "result_invalid" };
      return { ...common, state: "succeeded", result: result.value };
    } catch (error) {
      // Absent/partial receipt is not proof of not-started. A launcher may still
      // be between its durable intent and native spawn; never retry implicitly.
      return { state: "unknown", executionId, reason: error.code === "ENOENT" ? "receipt_missing" : "receipt_invalid" };
    }
  }
  const executor = Object.freeze({
    capabilities: Object.freeze({ separateProcess: true, isolatedWorker: true, osSandbox: false, localOnly: true, readyForProduction: false,
      platform: process.platform, supported: process.platform === "win32", validationOnly: process.platform === "linux", deadlineMode: "native-process-tree",
      get hardTermination() { return process.platform === "win32" || Boolean(linuxProof); },
      get linuxCapabilitiesProved() { return linuxProof; }, maxRuntimeMs: HARD_MS, maxConcurrent: 1, memoryBytes,
      maxProcesses: process.platform === "linux" ? undefined : 4, maxTasks: process.platform === "linux" ? 64 : undefined,
      maxOutputBytes: MAX_JSON, testOnly: syntheticTests === true }),
    workingRoot: root,
    observe,
    async prepareRuntime() {
      await safePath(root); await safePath(ffmpegPath, { file: true });
      await readyRuntime();
      return { prepared: true, platform: process.platform, ...(linuxProof ? { capabilities: linuxProof } : {}) };
    },
    async withExecutionScope(executionId, action) {
      if (!UUID.test(executionId || "") || typeof action !== "function") fail("execution_invalid");
      return scope.run(executionId, action);
    },
    async terminationProof(executionId) {
      if (!UUID.test(executionId || "")) fail("execution_invalid");
      const names = await fs.readdir(root), proofs = []; if (names.length > 10000) return undefined;
      for (const name of names.filter(name => UUID.test(name))) {
        let request; try { request = await readJson(path.join(root, name, "request.json")); } catch { if (name === executionId) return undefined; continue; }
        if (name !== executionId && request.parentExecutionId !== executionId) continue;
        const result = await observe(name); if (!result.termination?.proved) return undefined; proofs.push(result.termination.proofId);
      }
      return proofs.length ? { proved: true, descendants: 0, proofId: digest(proofs.sort()) } : undefined;
    },
    async run({ executionId, operation, input, timeoutMs = HARD_MS } = {}) {
      const launchStarted = performance.now();
      if (process.platform !== "win32" && !(process.platform === "linux" && linux)) fail("platform_unvalidated");
      if (!UUID.test(executionId || "") || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > HARD_MS) fail("request_invalid");
      await safePath(root); await safePath(ffmpegPath, { file: true });
      const projected = await project(operation, input), attempt = path.join(root, executionId);
      const request = { schema: 1, executionId, parentExecutionId: scope.getStore() || executionId, operation, input: projected, ffmpegPath: path.resolve(ffmpegPath), timeoutMs, memoryBytes };
      try { await fs.mkdir(attempt, { mode: 0o700 }); } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const previous = await readJson(path.join(attempt, "request.json"));
        if (digest(previous) !== digest(request)) fail("binding_conflict");
        return observe(executionId);
      }
      await immutableJson(path.join(attempt, "request.json"), request);
      async function notStarted(stage) {
        await immutableJson(path.join(attempt, "launcher-terminal.json"), { schema: 1, executionId, requestDigest: digest(request), state: "not_started_proved",
          stage, workerStarted: false, elapsedMs: Math.ceil(performance.now() - launchStarted) });
        return observe(executionId);
      }
      if (active) return notStarted("busy");
      active++;
      try {
        let supervisor; try { supervisor = await readyRuntime(); } catch { supervisorPromise = undefined; return notStarted("compile"); }
        // Keep the persisted request unchanged for idempotent reopen, but give
        // the native tree only the budget remaining after validation/compile.
        const spawnTimeout = Math.floor(timeoutMs - (performance.now() - launchStarted));
        if (spawnTimeout < 1) return notStarted("deadline");
        const outcome = await new Promise(resolve => {
          let child, spawned = false, spawnFailed = false;
          const nativeArgs = [attempt, process.execPath, path.join(__dirname, "media-process-child.js"), String(spawnTimeout), String(process.pid), String(memoryBytes),
            ...(process.platform === "linux" ? [linux.cgroupRoot, operation === "prepare" ? path.join(projected.outputRoot, projected.companyId, projected.assetId) : attempt] : [])];
          const launch = process.platform === "linux" ? require("./linux-media-runtime").launch(supervisor, nativeArgs, linux) : { command: supervisor, args: nativeArgs };
          try { child = spawn(launch.command, launch.args,
            { cwd: attempt, shell: false, windowsHide: true, detached: true, stdio: "ignore", env: cleanEnvironment(attempt) }); }
          catch { resolve("not_started"); return; }
          child.once("spawn", () => { spawned = true; });
          child.once("error", () => { spawnFailed = true; });
          child.once("close", () => resolve(spawnFailed && !spawned && !child.pid ? "not_started" : "launched"));
        });
        if (outcome === "not_started") return notStarted("spawn");
        return observe(executionId);
      } finally { active--; }
    },
    async inspectPreparedFile({ filePath, descriptor, timeoutMs = 30000 }) {
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) fail("request_invalid");
      const parent = scope.getStore(); let executionId = crypto.randomUUID();
      if (parent) { const hash = digest({ parent, filePath, descriptor }); executionId = `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`; }
      let result;
      try {
        const existing = await readJson(path.join(root, executionId, "request.json"));
        const projected = await project("inspect_output", { filePath, descriptor });
        if (existing.operation !== "inspect_output" || digest(existing.input) !== digest(projected) || existing.parentExecutionId !== parent) fail("binding_conflict");
        result = await observe(executionId);
      } catch (error) { if (error.code !== "ENOENT") throw error; result = await executor.run({ executionId, operation: "inspect_output", input: { filePath, descriptor }, timeoutMs }); }
      if (result.state !== "succeeded" || result.termination?.proved !== true) fail(result.state === "unknown" ? "termination_unknown" : "output_invalid");
      return result.result;
    }
  });
  instances.add(executor); return executor;
}
function isMediaProcessExecutor(value) { return Boolean(value && instances.has(value)); }
module.exports = { createMediaProcessExecutor, isMediaProcessExecutor, safePath, digest, readJson, immutableJson };
