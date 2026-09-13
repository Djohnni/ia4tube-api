"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const fs = require("node:fs/promises"), fsSync = require("node:fs"), os = require("node:os"), path = require("node:path");
const { Readable } = require("node:stream"), sharp = require("sharp");
const { createMemoryImportUploadStore } = require("../src/social/calendar/imports/memory-adapters");
const { createCalendarImportUploadService } = require("../src/social/calendar/imports/upload-service");
const { createRenderDiskPrivateUploadProvider } = require("../src/social/calendar/imports/render-disk-provider");
const { createRenderDiskAdmission } = require("../src/social/calendar/imports/render-disk-admission");
const { createGlobalMediaCapacity, freshGlobalCapacityState, validateGlobalCapacityState } = require("../src/social/calendar/imports/global-capacity");
const { createDurableInspectionDispatcher, validateInspectionDispatchState, isLocalDiskInspectionDispatcher } = require("../src/social/calendar/imports/inspection-dispatcher");
const { createLocalDiskInspectionRunnerForTests } = require("../src/social/calendar/imports/local-disk-inspection-runner");
const { createDiskBoundedInspectionWorker } = require("../src/social/calendar/imports/disk-inspection-worker");
const { runBoundedProcess } = require("../src/social/calendar/imports/preparation");
const FFMPEG = process.env.FFMPEG_TEST_BINARY || path.resolve(__dirname, "../../video_audit/pydeps/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v7.1.exe");
const hash = (value, type = "sha256", encoding = "hex") => crypto.createHash(type).update(value).digest(encoding);
const coordinator = { authenticated: true, role: "calendar_media_capacity_coordinator" };
function ledger() {
  let current = freshGlobalCapacityState(), tail = Promise.resolve();
  return { capabilities: { persistence: "volatile", testOnly: true, atomicGlobalUpdates: true },
    update(operation) {
      const pending = tail.then(() => {
        const state = structuredClone(current), value = operation(state);
        assert.notEqual(typeof value?.then, "function"); validateGlobalCapacityState(state);
        current = state; return structuredClone(value);
      });
      tail = pending.catch(() => {}); return pending;
    } };
}
async function fixture(t, { lostReply = false, sourceFault = false, denyExecution = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iA4tube-disk-inspection-"));
  await fs.chmod(root, 0o700);
  const diskRoot = path.join(root, "sealed"), workingDirectory = path.join(root, "worker");
  await fs.mkdir(diskRoot, { mode: 0o700 }); await fs.mkdir(workingDirectory, { mode: 0o700 });
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("iA4tube-disk-inspection-"));
    assert.equal((await fs.lstat(root)).isSymbolicLink(), false);
    await fs.rm(root, { recursive: true, force: true });
  });
  const context = { authenticated: true, companyId: crypto.randomUUID(), userId: crypto.randomUUID() };
  const store = createMemoryImportUploadStore(), capacity = createGlobalMediaCapacity({ store: ledger(), enabled: true, allowVolatileForTests: true });
  const admission = createRenderDiskAdmission({ capacity, store, rootDirectory: diskRoot, coordinatorContext: coordinator, enabled: true, allowVolatileForTests: true });
  const permits = new Map(); let firstReply = true, worker, sourceReads = 0;
  const runner = createLocalDiskInspectionRunnerForTests({ store, getWorker: () => worker, enabled: true,
    async afterResultForTests() {
      const row = Object.values(store.snapshotForTest(context.companyId).uploads)[0], execution = row.disk.inspectionTicket.localExecution.response;
      assert.deepEqual(await fs.readdir(workingDirectory), []);
      const permit = permits.get(row.disk.objectVersion);
      if (permit) {
        const proofId = hash(JSON.stringify(execution));
        await capacity.recordCompletion({ context: coordinator, jobId: permit.jobId, leaseToken: permit.leaseToken,
          outcome: execution.state === "succeeded" ? "succeeded" : "failed",
          actualRuntimeMs: execution.result?.elapsedMs ?? 180000, proofId });
        await capacity.recordCleanup({ context: coordinator, jobId: permit.jobId, proofId });
      }
      if (lostReply && firstReply) { firstReply = false; throw new Error("synthetic-result-acknowledgement-lost"); }
    } });
  const inspector = createDurableInspectionDispatcher({ store, runner, allowedOwners: [context], enabled: true,
    allowVolatileForTests: true, allowLocalForTests: true });
  const provider = createRenderDiskPrivateUploadProvider({ rootDirectory: diskRoot, store, admission, inspector,
    transferOrigin: "https://ia4tube-api.onrender.com", enabled: true, allowVolatileForTests: true });
  worker = createDiskBoundedInspectionWorker({ provider: { async streamSealedObject(args) {
    sourceReads++;
    return provider.streamSealedObject({ ...args, consume: chunk => {
      if (!sourceFault) return args.consume(chunk);
      const changed = Buffer.from(chunk); changed[0] ^= 1; return args.consume(changed);
    } });
  } }, workingDirectory, ffmpegPath: FFMPEG, async assertExecutionHeld({ task, snapshotBytes, maxRuntimeMs }) {
    if (denyExecution) return false;
    assert.equal(snapshotBytes, task.sizeBytes); assert.equal(maxRuntimeMs, 180000);
    const row = store.snapshotForTest(task.companyId).uploads[task.uploadId];
    if (!row || row.userId !== task.userId || row.sha256 !== task.sha256 || row.objectKey !== task.objectKey ||
        row.disk.inspectionTicket.dispatch.fenceToken !== task.fenceToken) return false;
    if (!permits.has(task.ticketId)) {
      await capacity.reserve({ context: coordinator, jobId: task.ticketId, companyId: task.companyId, userId: task.userId,
        requestDigest: task.executionDigest, storageBytes: task.sizeBytes + 65536, sourceBytes: task.sizeBytes, runtimeBudgetMs: maxRuntimeMs });
      const lease = await capacity.acquireNext({ context: coordinator });
      assert.equal(lease.jobId, task.ticketId); permits.set(task.ticketId, lease);
    }
    const observed = await capacity.assertHeld({ context: coordinator, jobId: task.ticketId, companyId: task.companyId,
      userId: task.userId, requestDigest: task.executionDigest });
    return observed.state === "running" && observed.leaseToken === permits.get(task.ticketId).leaseToken;
  } });
  const upload = createCalendarImportUploadService({ store, provider, enabled: true, allowVolatileForTests: true });
  async function start(bytes, kind = "image", mimeType = "image/png") {
    const item = await upload.start(context, { idempotencyKey: crypto.randomUUID(), kind, mimeType, sizeBytes: bytes.length, sha256: hash(bytes) });
    for (let offset = 0, number = 1; offset < bytes.length; offset += 5 * 1024 * 1024, number++) {
      const chunk = bytes.subarray(offset, Math.min(offset + 5 * 1024 * 1024, bytes.length));
      const grant = await upload.authorizePart(context, { uploadId: item.uploadId, partNumber: number, sha256: hash(chunk), md5Base64: hash(chunk, "md5", "base64") });
      const row = store.snapshotForTest(context.companyId).uploads[item.uploadId];
      await provider.acceptPart({ context, objectKey: row.objectKey, uploadId: row.disk.uploadId, partNumber: number,
        authorizationId: grant.authorizationId, contentLength: chunk.length, stream: Readable.from([chunk]) });
    }
    return item;
  }
  return { root, diskRoot, workingDirectory, context, store, provider, inspector, runner, worker, upload, capacity, start,
    reads: () => sourceReads, row: () => Object.values(store.snapshotForTest(context.companyId).uploads)[0] };
}
const photo = () => sharp({ create: { width: 96, height: 64, channels: 3, background: "#376b91" } }).png().toBuffer();

test("actual sealed disk image decodes through the branded local dispatcher, leaving one inspection and one outbox", async t => {
  const f = await fixture(t), bytes = await photo(), item = await f.start(bytes);
  assert.equal(f.inspector.capabilities.isolated, false); assert.equal(isLocalDiskInspectionDispatcher(f.inspector), true);
  assert.equal(f.worker.capabilities.osSandbox, false); assert.equal(f.provider.capabilities.privateObjects, true);
  const complete = await f.upload.complete(f.context, { uploadId: item.uploadId });
  assert.equal(complete.state, "uploaded"); assert.equal(complete.ready, false);
  assert.equal(complete.verification.sha256, hash(bytes)); assert.equal(f.row().disk.inspectionResult.width, 96);
  assert.equal(f.row().disk.inspectionResult.height, 64); assert.equal(f.reads(), 1);
  const state = f.store.snapshotForTest(f.context.companyId); validateInspectionDispatchState(state, f.context.companyId);
  assert.equal(Object.keys(state.prepareOutbox).length, 1);
  assert.equal(Object.values(state.inspectionQuota.months)[0].starts, 1);
  assert.equal((await f.capacity.summary({ context: coordinator })).monthlyJobs, 1);
  assert.equal((await f.capacity.summary({ context: coordinator })).activeJobs, 0);
  assert.equal((await f.capacity.summary({ context: coordinator })).storageBytes, bytes.length * 2 + 65536);
  assert.deepEqual(await fs.readdir(f.workingDirectory), []);
  await f.upload.complete(f.context, { uploadId: item.uploadId }); assert.equal(f.reads(), 1);
});

test("lost actual decode response reconciles persisted worker result without decoding or charging twice", async t => {
  const f = await fixture(t, { lostReply: true }), item = await f.start(await photo());
  await assert.rejects(f.upload.complete(f.context, { uploadId: item.uploadId }), { code: "import_verification_pending" });
  assert.equal(f.row().disk.inspectionTicket.dispatch.state, "reconciliation"); assert.equal(f.reads(), 1);
  const result = await f.upload.complete(f.context, { uploadId: item.uploadId });
  assert.equal(result.state, "uploaded"); assert.equal(f.reads(), 1);
  assert.equal(Object.values(f.store.snapshotForTest(f.context.companyId).inspectionQuota.months)[0].starts, 1);
  assert.equal((await f.capacity.summary({ context: coordinator })).monthlyJobs, 1);
});

test("real decoding rejects a truncated image and never produces an uploaded source or preparation outbox", async t => {
  const f = await fixture(t), bytes = await photo(), item = await f.start(bytes.subarray(0, 48));
  await assert.rejects(f.upload.complete(f.context, { uploadId: item.uploadId }), { code: "import_media_verification_failed" });
  assert.equal(f.row().state, "rejected");
  assert.equal(Object.keys(f.store.snapshotForTest(f.context.companyId).prepareOutbox).length, 0);
  assert.deepEqual(await fs.readdir(f.workingDirectory), []);
});

test("worker recomputes source SHA-256 and refuses corrupted snapshot bytes", async t => {
  const f = await fixture(t, { sourceFault: true }), item = await f.start(await photo());
  await assert.rejects(f.upload.complete(f.context, { uploadId: item.uploadId }), { code: "import_media_verification_failed" });
  assert.equal(f.row().state, "rejected"); assert.deepEqual(await fs.readdir(f.workingDirectory), []);
});

test("missing compute/snapshot admission prevents source streaming or snapshot allocation", async t => {
  const f = await fixture(t, { denyExecution: true }), item = await f.start(await photo());
  await assert.rejects(f.upload.complete(f.context, { uploadId: item.uploadId }), { code: "import_media_verification_failed" });
  assert.equal(f.reads(), 0); assert.deepEqual(await fs.readdir(f.workingDirectory), []);
  assert.equal((await f.capacity.summary({ context: coordinator })).monthlyJobs, 0);
});

test("another owner and a copied local capability object cannot inspect the sealed source", async t => {
  const f = await fixture(t), item = await f.start(await photo()); await f.upload.complete(f.context, { uploadId: item.uploadId });
  const row = f.row(), request = { context: { ...f.context, userId: crypto.randomUUID() }, ticketId: row.disk.objectVersion };
  await assert.rejects(f.inspector.getInspection(request), { code: "import_inspection_owner_not_allowed" });
  const copy = createDurableInspectionDispatcher({ store: f.store, runner: { ...f.runner }, allowedOwners: [f.context],
    enabled: true, allowVolatileForTests: true, allowLocalForTests: true });
  assert.equal(copy.capabilities.remoteObjectInspection, false);
  const bad = createRenderDiskPrivateUploadProvider({ rootDirectory: f.diskRoot, store: f.store,
    admission: {}, inspector: { ...f.inspector }, transferOrigin: "https://ia4tube-api.onrender.com", enabled: true, allowVolatileForTests: true });
  assert.equal(bad.capabilities.privateObjects, false);
  const state = f.store.snapshotForTest(f.context.companyId); delete state.inspectionQuota;
  assert.throws(() => validateInspectionDispatchState(state, f.context.companyId), { code: "import_inspection_state_invalid" });
});

test("actual synthetic H.264 SDR video is fully decoded locally with its audio/duration verified", { skip: !fsSync.existsSync(FFMPEG), timeout: 30000 }, async t => {
  const f = await fixture(t), source = path.join(f.root, "synthetic-input.mp4");
  const generated = await runBoundedProcess(FFMPEG, ["-hide_banner", "-nostdin", "-v", "error",
    "-f", "lavfi", "-i", "testsrc2=size=96x160:rate=10", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-t", "1", "-threads", "2", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-movflags", "+faststart", "-n", source], { cwd: f.root, timeoutMs: 10000 });
  assert.equal(generated.code, 0);
  const bytes = await fs.readFile(source), item = await f.start(bytes, "video", "video/mp4");
  const complete = await f.upload.complete(f.context, { uploadId: item.uploadId });
  const inspected = f.row().disk.inspectionResult;
  assert.equal(complete.state, "uploaded"); assert.equal(inspected.width, 96);
  assert.equal(inspected.height, 160); assert.equal(inspected.hasAudio, true);
  assert.equal(inspected.durationMs, 1000); assert.equal(inspected.colorMode, "sdr");
  assert.deepEqual(await fs.readdir(f.workingDirectory), []);
});
