"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), crypto = require("node:crypto"), http = require("node:http");
const imports = "../../src/social/calendar/imports/";
const { createWorkflowPrivateJournal } = require(imports + "workflow-private-journal");
const { createWorkflowPrivateBridge, createWorkflowPrivateClient } = require(imports + "workflow-private-transfer");
const { createControlledRenderWorkflowAdapter } = require(imports + "render-workflow-adapter");
const { createWorkflowProcessWorker } = require(imports + "workflow-process-worker");
const { createWorkflowTaskAgent } = require(imports + "workflow-task-agent");
const { createMediaProcessExecutor } = require(imports + "media-process-executor");
const { createPreparedDiskResultStore } = require(imports + "prepared-disk-store");
const { createPreparedDiskOutputInspector } = require(imports + "prepared-disk-output-inspector");
const { createOperationalPreparationRunner } = require(imports + "operational-preparation-runner");
const { createPreparationQueue } = require(imports + "preparation-queue");
const { createOperationalInspectionRunner } = require(imports + "operational-inspection-runner");
const { createDurableInspectionDispatcher } = require(imports + "inspection-dispatcher");
const { createRenderDiskPrivateUploadProvider } = require(imports + "render-disk-provider");
const { createCalendarImportUploadService } = require(imports + "upload-service");
const { FFMPEG } = require("./operational-private-pipeline-fixture");
async function configureWorkflowPrivatePipeline(t, f, options = {}) {
  const remoteRoot = path.join(f.pg.root, "workflow-" + crypto.randomBytes(4).toString("hex")), work = path.join(remoteRoot, "w"), exec = path.join(remoteRoot, "e");
  for (const p of [remoteRoot, work, exec]) await fs.mkdir(p, { mode: 0o700 });
  const native = createMediaProcessExecutor({ workingRoot: exec, ffmpegPath: FFMPEG, allowedRoots: [work], memoryBytes: 512 * 1024 ** 2,
    ...(process.platform === "linux" ? { linuxRuntime: { cgroupRoot: process.env.CALENDAR_MEDIA_LINUX_CGROUP_ROOT,
      launchMode: process.env.CALENDAR_MEDIA_LINUX_LAUNCH_MODE || "sudo", validationOnly: true } } : {}) });
  await native.prepareRuntime();
  const journal = createWorkflowPrivateJournal({ store: f.store, owner: f.context, clock: f.clock });
  const key = crypto.randomBytes(32), originalProvider = f.provider; let preparedStore, preparationRunner, inspectionRunner;
  const bridge = createWorkflowPrivateBridge({ journal, key, provider: originalProvider, privateRoot: f.privateRoot, preparationRoot: f.preparationRoot, getResultStore: () => preparedStore,
    clock: f.clock, musicRoot: f.musicRoot, transferTimeoutMs: options.bridgeTimeoutMs || 60000,
    allowSyntheticForTests: options.syntheticMusic === true, diagnostic: code => t.diagnostic("WORKFLOW_TRANSFER_CODE=" + code),
    resolveMusicTrack: async id => f.catalog.has(id) ? { filePath: path.join(f.musicRoot, "local-tone.wav"), sha256: f.catalog.get(id).sha256, synthetic: true } : null,
    assertHeld: async (task, kind, resultRef) => kind === "inspect" ? inspectionRunner.assertExecutionHeld({ task, snapshotBytes: task.sizeBytes, maxRuntimeMs: task.maxRuntimeMs }) :
      f.preparedAdmission.assertHeld({ task, resultRef, requiredBytes: 65536, intent: "write" }) });
  const server = http.createServer(async (req, res) => { if (!(await bridge.handle(req, res))) { res.writeHead(404); res.end(); } });
  server.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, agent = createWorkflowTaskAgent({ workingRoot: work, executor: native, allowSyntheticForTests: options.syntheticMusic === true, clock: f.clock,
    diagnostic: code => t.diagnostic("WORKFLOW_AGENT_CODE=" + code) });
  const sdkRuns = new Map(), calls = [], metrics = []; let lostStart = false;
  const clientFor = (executionId, agentId) => createWorkflowPrivateClient({ origin, key, executionId, ...(agentId ? { agentId } : {}), allowLoopbackForTests: true });
  const sdkClient = { workflows: {
    async startTask(slug, args) { assert.deepEqual(Object.keys(args[0]), ["executionId"]); assert.equal(args.length, 1);
      const id = "trn-" + crypto.randomBytes(10).toString("hex"); calls.push({ operation: "start", id, args: structuredClone(args) });
      const r = { id, input: args, status: "running", retries: 0, results: [] }; sdkRuns.set(id, r);
      r.results = [await agent.run(clientFor(args[0].executionId))]; r.status = "completed";
      if (lostStart && (await journal.get(args[0].executionId)).kind === "prepare") { lostStart = false; throw Error("synthetic_start_response_lost"); } return { taskRunId: id };
    },
    async getTaskRun(id) { return structuredClone(sdkRuns.get(id)); },
    async listTaskRuns() { return [...sdkRuns.values()].map(r => ({ taskRun: { id: r.id }, cursor: r.id })); },
    async cancelTaskRun(id) { sdkRuns.get(id).status = "canceled"; }
  } };
  const adapter = createControlledRenderWorkflowAdapter({ sdkClient }), worker = createWorkflowProcessWorker({ bridge, adapter, allowControlledForTests: true });
  preparedStore = createPreparedDiskResultStore({ rootDirectory: f.privateRoot, preparationRoot: f.preparationRoot, tenantStore: f.store,
    admission: f.preparedAdmission, accessPolicy: f.accessPolicy, outputInspector: createPreparedDiskOutputInspector({ workflowBridge: bridge }), enabled: true, clock: f.clock });
  preparationRunner = createOperationalPreparationRunner({ store: f.store, owner: f.context, capacity: f.capacity, admission: f.preparedAdmission,
    accessPolicy: f.accessPolicy, getWorker: () => worker, enabled: true, syntheticMediaForLocalTests: options.syntheticMusic === true, clock: f.clock });
  inspectionRunner = createOperationalInspectionRunner({ store: f.store, owner: f.context, capacity: f.capacity, accessPolicy: f.accessPolicy,
    diskSpaceGuard: f.guard, getWorker: () => worker, enabled: true, clock: f.clock });
  const inspector = createDurableInspectionDispatcher({ store: f.store, runner: inspectionRunner, accessPolicy: f.accessPolicy, enabled: true, clock: f.clock });
  const provider = createRenderDiskPrivateUploadProvider({ rootDirectory: f.privateRoot, store: f.store, admission: f.sourceAdmission, inspector,
    transferOrigin: "https://ia4tube-api.onrender.com", enabled: true, clock: f.clock });
  const upload = createCalendarImportUploadService({ store: f.store, provider, enabled: true, clock: f.clock });
  const preparation = createPreparationQueue({ store: f.store, dispatcher: preparationRunner, resultStore: preparedStore, accessPolicy: f.accessPolicy,
    enabled: true, catalog: f.catalog, allowSyntheticForTests: options.syntheticMusic === true, clock: f.clock });
  Object.assign(f, { preparedStore, preparationRunner, inspectionRunner, inspector, provider, upload, preparation,
    workflow: { bridge, journal, native, agent, origin, calls, sdkRuns, clientFor, remoteRoot, metrics, loseNextStart() { lostStart = true; },
      headersForSyntheticTest({ executionId, agentId, method, resource, length = 0, sha256 = crypto.createHash("sha256").update("").digest("hex") }) {
        const stamp = String(f.clock()), scoped = crypto.createHmac("sha256", key).update("calendar-workflow-v1:" + executionId).digest();
        const signature = crypto.createHmac("sha256", scoped).update([method, resource, agentId, stamp, length, sha256].join("\n")).digest("hex"); scoped.fill(0);
        return { "content-length": length, "x-media-agent": agentId, "x-media-time": stamp, "x-media-sha256": sha256, "x-media-auth": signature };
      }
    } });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); key.fill(0); });
}
module.exports = { configureWorkflowPrivatePipeline };
