"use strict";
// Synthetic local integration fixture: every inspection/preparation decodes real
// bytes and both phases pass through the actual shared capacity state machine.
const assert = require("node:assert/strict"), crypto = require("node:crypto"), fs = require("node:fs/promises");
const path = require("node:path"), os = require("node:os"), sharp = require("sharp"), { Readable } = require("node:stream");
const imports = "../../src/social/calendar/imports/";
const { createMemoryImportUploadStore } = require(imports + "memory-adapters");
const { createCalendarImportUploadService } = require(imports + "upload-service");
const { createRenderDiskPrivateUploadProvider } = require(imports + "render-disk-provider");
const { createRenderDiskAdmission } = require(imports + "render-disk-admission");
const { createImportAccessPolicy } = require(imports + "access-policy");
const { createGlobalMediaCapacity, freshGlobalCapacityState, validateGlobalCapacityState } = require(imports + "global-capacity");
const { createDiskSpaceGuard } = require(imports + "disk-space-guard");
const { createDurableInspectionDispatcher } = require(imports + "inspection-dispatcher");
const { createLocalDiskInspectionRunnerForTests } = require(imports + "local-disk-inspection-runner");
const { createDiskBoundedInspectionWorker } = require(imports + "disk-inspection-worker");
const { createPreparedDiskAdmission } = require(imports + "prepared-disk-admission");
const { createPreparedDiskResultStore } = require(imports + "prepared-disk-store");
const { createPreparedDiskOutputInspector } = require(imports + "prepared-disk-output-inspector");
const { createDiskPreparationWorker } = require(imports + "disk-preparation-worker");
const { createLocalPreparationRunnerForTests } = require(imports + "local-preparation-runner");
const { createPreparationQueue } = require(imports + "preparation-queue");
const { runBoundedProcess } = require(imports + "preparation");
const FFMPEG = process.env.FFMPEG_TEST_BINARY || path.resolve(__dirname, "../../../video_audit/pydeps/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v7.1.exe");
const hash = (value, type = "sha256", encoding = "hex") => crypto.createHash(type).update(value).digest(encoding);
const coordinator = { authenticated: true, role: "calendar_media_capacity_coordinator" };
function globalStore() {
  let current = freshGlobalCapacityState(), tail = Promise.resolve();
  return { capabilities: { persistence: "volatile", testOnly: true, atomicGlobalUpdates: true },
    update(operation) {
      const next = tail.then(() => {
        const state = structuredClone(current), result = operation(state);
        assert.notEqual(typeof result?.then, "function"); validateGlobalCapacityState(state);
        current = state; return structuredClone(result);
      });
      tail = next.catch(() => {}); return next;
    },
    snapshotForTest() { return structuredClone(current); } };
}
async function createPrivatePipelineFixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iA4tube-private-pipeline-")); await fs.chmod(root, 0o700);
  t.after(async () => {
    const target = path.resolve(root);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith("iA4tube-private-pipeline-"));
    assert.equal((await fs.lstat(target)).isSymbolicLink(), false);
    await fs.rm(target, { recursive: true, force: true });
  });
  const privateRoot = path.join(root, "private"), preparationRoot = path.join(root, "prepared");
  const musicRoot = path.join(root, "synthetic-music");
  const catalog = new Map();
  if (options.syntheticMusic === true) {
    await fs.mkdir(musicRoot, { mode: 0o700 });
    const generated = await runBoundedProcess(FFMPEG, ["-hide_banner", "-nostdin", "-v", "error", "-f", "lavfi", "-i",
      "sine=frequency=523.25:sample_rate=48000", "-t", "15", "-threads", "2", "-c:a", "pcm_s16le", "-n", path.join(musicRoot, "local-tone.wav")],
    { cwd: root, timeoutMs: 10000 });
    assert.equal(generated.code, 0);
    catalog.set("synthetic-local-tone", { id: "synthetic-local-tone", sha256: hash(await fs.readFile(path.join(musicRoot, "local-tone.wav"))),
      syntheticTestOnly: true, durationSeconds: 15 });
  }
  const inspectionWorkingRoot = path.join(root, "inspection-work"), preparationWorkingRoot = path.join(root, "preparation-work");
  for (const location of [privateRoot, preparationRoot, inspectionWorkingRoot, preparationWorkingRoot]) await fs.mkdir(location, { mode: 0o700 });
  const context = options.context || { authenticated: true, companyId: crypto.randomUUID(), userId: crypto.randomUUID() };
  let eligible = true, offset = 0;
  const clock = () => Date.now() + offset;
  const accessPolicy = options.accessPolicy || createImportAccessPolicy({ allowedOwners: [context], isEligible: () => eligible });
  const store = createMemoryImportUploadStore(), ledger = globalStore();
  const guard = createDiskSpaceGuard({ rootDirectory: privateRoot, enabled: true, marginBytes: 16 * 1024 * 1024 });
  const capacity = createGlobalMediaCapacity({ store: ledger, enabled: true, allowVolatileForTests: true,
    requireDiskSpaceEvidence: true, diskSpaceGuard: guard, clock });
  const sourceAdmission = createRenderDiskAdmission({ capacity, store, rootDirectory: privateRoot, diskSpaceGuard: guard,
    requireDiskSpaceEvidence: true, coordinatorContext: coordinator, enabled: true, allowVolatileForTests: true });
  const counters = { inspectionSourceReads: 0, preparationSourceReads: 0, inspectionResults: 0, preparationResults: 0 };
  const permits = new Map(); let inspectorWorker, preparationWorker;
  const inspectionRunner = createLocalDiskInspectionRunnerForTests({ store, getWorker: () => inspectorWorker, enabled: true,
    async afterResultForTests() {
      assert.deepEqual(await fs.readdir(inspectionWorkingRoot), []);
      for (const row of Object.values(store.snapshotForTest(context.companyId).uploads)) {
        const response = row.disk?.inspectionTicket?.localExecution?.response;
        const permit = permits.get(row.disk?.objectVersion);
        if (!permit || permit.completed || !["succeeded", "failed"].includes(response?.state)) continue;
        const proofId = hash(JSON.stringify(response));
        await capacity.recordCompletion({ context: coordinator, jobId: permit.jobId, leaseToken: permit.leaseToken,
          outcome: response.state, actualRuntimeMs: response.result?.elapsedMs ?? 180000, proofId });
        await capacity.recordCleanup({ context: coordinator, jobId: permit.jobId, proofId });
        permit.completed = true; counters.inspectionResults++;
      }
    } });
  const inspector = createDurableInspectionDispatcher({ store, runner: inspectionRunner, accessPolicy, enabled: true,
    allowVolatileForTests: true, allowLocalForTests: true, clock });
  const provider = createRenderDiskPrivateUploadProvider({ rootDirectory: privateRoot, store, admission: sourceAdmission, inspector,
    transferOrigin: "https://ia4tube-api.onrender.com", enabled: true, allowVolatileForTests: true, clock });
  inspectorWorker = createDiskBoundedInspectionWorker({ workingDirectory: inspectionWorkingRoot, ffmpegPath: FFMPEG, clock,
    provider: { streamSealedObject(args) { counters.inspectionSourceReads++; return provider.streamSealedObject(args); } },
    async assertExecutionHeld({ task, snapshotBytes, maxRuntimeMs }) {
      accessPolicy.resolve({ authenticated: true, companyId: task.companyId, userId: task.userId });
      const row = store.snapshotForTest(task.companyId).uploads[task.uploadId];
      if (!row || row.userId !== task.userId || row.sha256 !== task.sha256 || row.disk.inspectionTicket.dispatch.fenceToken !== task.fenceToken ||
          snapshotBytes !== task.sizeBytes || maxRuntimeMs !== task.maxRuntimeMs) return false;
      if (!permits.has(task.ticketId)) {
        await capacity.reserve({ context: coordinator, jobId: task.ticketId, companyId: task.companyId, userId: task.userId,
          requestDigest: task.executionDigest, storageBytes: task.sizeBytes + 65536, sourceBytes: task.sizeBytes, runtimeBudgetMs: task.maxRuntimeMs });
        const acquired = await capacity.acquireNext({ context: coordinator, expectedJobId: task.ticketId });
        assert.equal(acquired?.jobId, task.ticketId); permits.set(task.ticketId, acquired);
      }
      const actual = await capacity.assertHeld({ context: coordinator, jobId: task.ticketId, companyId: task.companyId, userId: task.userId,
        requestDigest: task.executionDigest, intent: "write", diskSpaceEvidence: await guard.sample() });
      return actual.state === "running" && actual.leaseToken === permits.get(task.ticketId).leaseToken;
    } });
  const upload = createCalendarImportUploadService({ store, provider, enabled: true, allowVolatileForTests: true, clock });
  const preparedAdmission = createPreparedDiskAdmission({ capacity, tenantStore: store, accessPolicy, rootDirectory: privateRoot,
    diskSpaceGuard: guard, enabled: true, allowVolatileForTests: true, clock });
  const preparedStore = createPreparedDiskResultStore({ rootDirectory: privateRoot, preparationRoot, tenantStore: store,
    admission: preparedAdmission, accessPolicy, outputInspector: createPreparedDiskOutputInspector({ ffmpegPath: FFMPEG }),
    enabled: true, allowVolatileForTests: true, clock });
  let lostPreparationReply = options.lostPreparationReply === true;
  const preparationRunner = createLocalPreparationRunnerForTests({ store, capacity, admission: preparedAdmission,
    getWorker: () => preparationWorker, enabled: true, async afterResultForTests() {
      counters.preparationResults++;
      assert.deepEqual(await fs.readdir(preparationWorkingRoot), []);
      if (lostPreparationReply) { lostPreparationReply = false; throw new Error("synthetic-preparation-acknowledgement-lost"); }
    } });
  preparationWorker = createDiskPreparationWorker({ workingDirectory: preparationWorkingRoot, preparationRoot,
    resultStore: preparedStore, admission: preparedAdmission, ffmpegPath: FFMPEG, allowVolatileForTests: true, clock,
    ...(options.syntheticMusic === true ? { musicRoot, allowSyntheticForTests: true,
      resolveMusicTrack: async id => catalog.has(id) ? { sourceName: "local-tone.wav", sha256: catalog.get(id).sha256, synthetic: true } : null } : {}),
    provider: { async streamSealedObject(args) {
      counters.preparationSourceReads++;
      if (options.beforePreparationSourceRead) await options.beforePreparationSourceRead(args);
      return provider.streamSealedObject(args);
    } } });
  const preparation = createPreparationQueue({ store, dispatcher: preparationRunner, resultStore: preparedStore, accessPolicy,
    enabled: true, allowVolatileForTests: true, allowLocalForTests: true,
    catalog, allowSyntheticForTests: options.syntheticMusic === true, clock });
  async function uploadBytes(bytes, kind, mimeType) {
    const started = await upload.start(context, { idempotencyKey: crypto.randomUUID(), kind, mimeType, sizeBytes: bytes.length, sha256: hash(bytes) });
    for (let offset = 0, number = 1; offset < bytes.length; offset += 5 * 1024 * 1024, number++) {
      const chunk = bytes.subarray(offset, Math.min(offset + 5 * 1024 * 1024, bytes.length));
      const grant = await upload.authorizePart(context, { uploadId: started.uploadId, partNumber: number, sha256: hash(chunk), md5Base64: hash(chunk, "md5", "base64") });
      const row = store.snapshotForTest(context.companyId).uploads[started.uploadId];
      await provider.acceptPart({ context, objectKey: row.objectKey, uploadId: row.disk.uploadId, partNumber: number,
        authorizationId: grant.authorizationId, contentLength: chunk.length, stream: Readable.from([chunk]) });
    }
    const result = await upload.complete(context, { uploadId: started.uploadId });
    assert.equal(result.state, "uploaded"); return result;
  }
  async function enqueuePrepared(uploaded, selection, expectedMediaRevision = 0) {
    const request = await preparation.request(context, { uploadId: uploaded.uploadId, assetId: uploaded.assetId,
      expectedMediaRevision, idempotencyKey: crypto.randomUUID(), selection });
    await preparation.dispatchNext(context);
    const status = await preparation.status(context, { assetId: uploaded.assetId });
    const result = status.ready ? (await preparation.snapshot(context, { assetId: uploaded.assetId, mediaRevision: status.mediaRevision })).result : null;
    return { uploadId: uploaded.uploadId, assetId: uploaded.assetId, mediaRevision: status.mediaRevision, request, status, prepared: result };
  }
  async function preparePhoto(settings = {}) {
    const bytes = settings.bytes || await sharp({ create: { width: 160, height: 100, channels: 3, background: "#2c7191" } }).png().toBuffer();
    const uploaded = await uploadBytes(bytes, "image", "image/png");
    return enqueuePrepared(uploaded, settings.selection || { kind: "image", targets: ["feed", "story"], audioMode: "none" });
  }
  async function prepareVideo(settings = {}) {
    const source = path.join(root, "synthetic-video-" + crypto.randomUUID() + ".mp4");
    const created = await runBoundedProcess(FFMPEG, ["-hide_banner", "-nostdin", "-v", "error", "-f", "lavfi", "-i",
      "testsrc2=size=96x160:rate=10", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "0.5",
      "-threads", "2", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac",
      "-movflags", "+faststart", "-n", source], { cwd: root, timeoutMs: 10000 });
    assert.equal(created.code, 0);
    const uploaded = await uploadBytes(await fs.readFile(source), "video", "video/mp4");
    return enqueuePrepared(uploaded, settings.selection || { kind: "video", targets: ["story", "reel"], audioMode: "muted" });
  }
  function jobFor(assetId, mediaRevision) {
    const state = store.snapshotForTest(context.companyId), asset = state.preparation.assets[assetId];
    return state.preparation.jobs[asset.revisions[String(mediaRevision || asset.currentRevision)]];
  }
  async function actualFor(assetId, mediaRevision) {
    const job = jobFor(assetId, mediaRevision);
    return preparedStore.inspectCommitted({ companyId: context.companyId, userId: context.userId, assetId,
      mediaRevision: job.mediaRevision, dispatchKey: job.dispatchKey, executionDigest: job.executionDigest, resultRef: job.result.resultRef });
  }
  return { root, privateRoot, diskRoot: privateRoot, preparationRoot, inspectionWorkingRoot, preparationWorkingRoot, context, store, ledger, catalog, musicRoot,
    accessPolicy, guard, provider, capacity, upload, inspector, inspectionRunner, inspectorWorker, preparation, preparedStore,
    preparedAdmission, preparationRunner, preparationWorker, counters, preparePhoto, prepareVideo, uploadBytes, enqueuePrepared, jobFor, actualFor,
    revoke() { eligible = false; }, advance(ms) { offset += ms; }, clock };
}
module.exports = { createPrivatePipelineFixture, FFMPEG, hash, coordinator };
