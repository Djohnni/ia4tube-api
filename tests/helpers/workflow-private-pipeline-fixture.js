"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), crypto = require("node:crypto"), http = require("node:http");
const { fork } = require("node:child_process");
const imports = "../../src/social/calendar/imports/";
const { createWorkflowPrivateClient } = require(imports + "workflow-private-transfer");
const { createControlledRenderWorkflowAdapter } = require(imports + "render-workflow-adapter");
const { createWorkflowOperationalComponents } = require(imports + "workflow-operational-components");
const { FFMPEG } = require("./operational-private-pipeline-fixture");
async function configureWorkflowPrivatePipeline(t, f, options = {}) {
  const remoteRoot = path.join(f.pg.root, "workflow-" + crypto.randomBytes(4).toString("hex")), work = path.join(remoteRoot, "w"), exec = path.join(remoteRoot, "e");
  for (const p of [remoteRoot, work, exec]) await fs.mkdir(p, { mode: 0o700 });
  const key = crypto.randomBytes(32); let journal, bridge;
  const server = http.createServer(async (req, res) => { if (!bridge || !(await bridge.handle(req, res))) { res.writeHead(404); res.end(); } });
  server.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const host = fork(path.join(__dirname, "workflow-private-task-host.js"), [], { execArgv: [], windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: process.platform === "win32" ? { SystemRoot: process.env.SystemRoot, TEMP: remoteRoot, TMP: remoteRoot } : { LANG: "C", LC_ALL: "C", TMPDIR: remoteRoot } });
  // Register before initialization: an early capability/config failure must also
  // close the new host and HTTP listener. Never call cleanup on another fixture.
  const hostExited = new Promise(resolve => host.once("exit", resolve));
  t.after(async () => {
    if (host.connected) host.send({ type: "shutdown" });
    let timer;
    try { await Promise.race([hostExited, new Promise((_, reject) => { timer = setTimeout(() => reject(Error("synthetic_workflow_host_shutdown_unproved")), 190000); })]); }
    finally { clearTimeout(timer); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); key.fill(0); }
    t.diagnostic("WORKFLOW_COORDINATOR_SEPARATE_OS_PROCESS=YES; NO_DATABASE_OR_INSTAGRAM_ENVIRONMENT=YES; COORDINATOR_EXITED=YES");
  });
  const pending = new Map(); let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  host.on("message", message => {
    if (message.type === "ready") readyResolve(message);
    else if (message.type === "initialization_failed") readyReject(Error("synthetic_workflow_host_initialization_failed"));
    else if (message.type === "diagnostic") t.diagnostic("WORKFLOW_AGENT_CODE=" + message.code);
    else if (message.type === "result") { pending.get(message.executionId)?.resolve(message.result); pending.delete(message.executionId); }
  });
  host.on("error", () => readyReject(Error("synthetic_workflow_host_start_failed")));
  host.on("exit", () => { for (const p of pending.values()) p.reject(Error("synthetic_workflow_host_lost")); pending.clear(); });
  host.send({ type: "initialize", options: { workingRoot: work, executorRoot: exec, ffmpegPath: FFMPEG, origin, keyBase64: key.toString("base64"), synthetic: options.syntheticMusic === true,
    ...(process.platform === "linux" ? { linuxRuntime: { cgroupRoot: process.env.CALENDAR_MEDIA_LINUX_CGROUP_ROOT,
      launchMode: process.env.CALENDAR_MEDIA_LINUX_LAUNCH_MODE || "sudo", validationOnly: true } } : {}) } });
  const hostProof = await ready; assert.notEqual(hostProof.pid, process.pid); assert.equal(hostProof.isolatedEnvironment, true); assert.equal(hostProof.hardTermination, true);
  const runOnHost = executionId => new Promise((resolve, reject) => { pending.set(executionId, { resolve, reject }); host.send({ type: "run", executionId }); });
  const sdkRuns = new Map(), calls = [], metrics = [], taskPromises = []; let lostStart = false;
  const clientFor = (executionId, agentId) => createWorkflowPrivateClient({ origin, key, executionId, ...(agentId ? { agentId } : {}), allowLoopbackForTests: true });
  const sdkClient = { workflows: {
    async startTask(slug, args) { assert.deepEqual(Object.keys(args[0]), ["executionId"]); assert.equal(args.length, 1);
      const id = "trn-" + crypto.randomBytes(10).toString("hex"); calls.push({ operation: "start", id, args: structuredClone(args) });
      const r = { id, input: args, status: "running", retries: 0, results: [] }; sdkRuns.set(id, r);
      const taskPromise = runOnHost(args[0].executionId).then(value => { r.results = [value]; r.status = "completed"; }, () => { r.status = "failed"; });
      taskPromises.push(taskPromise);
      if (options.asynchronousSdk !== true) await taskPromise;
      if (lostStart && (await journal.get(args[0].executionId)).kind === "prepare") { lostStart = false; throw Error("synthetic_start_response_lost"); } return { taskRunId: id };
    },
    async getTaskRun(id) { return structuredClone(sdkRuns.get(id)); },
    async listTaskRuns() { return [...sdkRuns.values()].map(r => ({ taskRun: { id: r.id }, cursor: r.id })); },
    async cancelTaskRun(id) { sdkRuns.get(id).status = "canceled"; }
  } };
  const adapter = createControlledRenderWorkflowAdapter({ sdkClient });
  const components = await createWorkflowOperationalComponents({ enabled: true, store: f.store,
    owner: { companyId: f.context.companyId, userId: f.context.userId }, capacity: f.capacity,
    sourceAdmission: f.sourceAdmission, preparedAdmission: f.preparedAdmission, accessPolicy: f.accessPolicy, diskSpaceGuard: f.guard,
    privateRoot: f.privateRoot, preparationRoot: f.preparationRoot, publicApiOrigin: "https://ia4tube-api.onrender.com", musicRoot: f.musicRoot,
    resolveMusicTrack: async id => f.catalog.has(id) ? { filePath: path.join(f.musicRoot, "local-tone.wav"), sha256: f.catalog.get(id).sha256, synthetic: true } : null,
    catalog: f.catalog, bridgeKey: key, adapter, allowControlledForTests: true, clock: f.clock,
    diagnostic: code => t.diagnostic("WORKFLOW_TRANSFER_CODE=" + code), transferTimeoutMs: options.bridgeTimeoutMs || 60000 });
  ({ journal, bridge } = components);
  const { resultStore: preparedStore, preparationRunner, inspectionRunner, inspector, provider, upload, preparation, tick } = components;
  Object.assign(f, { preparedStore, preparationRunner, inspectionRunner, inspector, provider, upload, preparation,
    workflow: { bridge, journal, origin, calls, sdkRuns, clientFor, remoteRoot, metrics, hostProof, tick,
      awaitTasks: () => Promise.all(taskPromises), loseNextStart() { lostStart = true; },
      headersForSyntheticTest({ executionId, agentId, method, resource, length = 0, sha256 = crypto.createHash("sha256").update("").digest("hex") }) {
        const stamp = String(f.clock()), scoped = crypto.createHmac("sha256", key).update("calendar-workflow-v1:" + executionId).digest();
        const signature = crypto.createHmac("sha256", scoped).update([method, resource, agentId, stamp, length, sha256].join("\n")).digest("hex"); scoped.fill(0);
        return { "content-length": length, "x-media-agent": agentId, "x-media-time": stamp, "x-media-sha256": sha256, "x-media-auth": signature };
      }
    } });
}
module.exports = { configureWorkflowPrivatePipeline };
