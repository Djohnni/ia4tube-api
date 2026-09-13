"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto"), sharp = require("sharp");
const fs = require("node:fs/promises"), syncFs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { createPreparedDiskResultStore, isPreparedDiskResultStore } = require("../src/social/calendar/imports/prepared-disk-store");
const { createPreparedDiskOutputInspector, parsePreparedOutputProbe } = require("../src/social/calendar/imports/prepared-disk-output-inspector");
const { createPreparedDiskAdmission } = require("../src/social/calendar/imports/prepared-disk-admission");
const { createImportAccessPolicy } = require("../src/social/calendar/imports/access-policy");
const { createDiskSpaceGuardForTests } = require("../src/social/calendar/imports/disk-space-guard");
const { createGlobalMediaCapacity, freshGlobalCapacityState, validateGlobalCapacityState } = require("../src/social/calendar/imports/global-capacity");
const { createMemoryImportUploadStore, createMemoryMultipartProvider } = require("../src/social/calendar/imports/memory-adapters");
const { createCalendarImportUploadService } = require("../src/social/calendar/imports/upload-service");
const { createPreparationQueue } = require("../src/social/calendar/imports/preparation-queue");
const { createImportMediaPreparer, runBoundedProcess } = require("../src/social/calendar/imports/preparation");
const FFMPEG = path.resolve(__dirname, "../../video_audit/pydeps/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v7.1.exe");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex"), uuid = () => crypto.randomUUID();
const coordinator = { authenticated: true, role: "calendar_media_capacity_coordinator" };
test("prepared output accepts at most 250ms encoder tolerance without changing the source duration parser", () => {
  const { parseProbe } = require("../src/social/calendar/imports/preparation");
  const text = "Duration: 00:01:00.20, start: 0.000000\n Stream #0:0: Video: h264 (High), yuv420p(bt709), 1080x1920, 30 fps\n";
  assert.equal(parsePreparedOutputProbe(text).durationSeconds, 60.2);
  assert.throws(() => parsePreparedOutputProbe(text.replace("00:01:00.20", "00:01:00.251")));
  assert.throws(() => parseProbe(text, "video"));
});
function globalStore() {
  let current = freshGlobalCapacityState(), tail = Promise.resolve();
  return { capabilities: { persistence: "volatile", testOnly: true, atomicGlobalUpdates: true }, update(operation) {
    const result = tail.then(() => { const draft = structuredClone(current), value = operation(draft);
      if (value && typeof value.then === "function") throw new Error("async forbidden");
      validateGlobalCapacityState(draft); current = draft; return structuredClone(value); }); tail = result.catch(() => {}); return result;
  } };
}
async function fixture(t, { video = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iA4tube-prepared-store-")); await fs.chmod(root, 0o700);
  t.after(async () => {
    const target = path.resolve(root); assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith("iA4tube-prepared-store-")); assert.equal((await fs.lstat(target)).isSymbolicLink(), false);
    await fs.rm(target, { recursive: true, force: true });
  });
  const inputRoot = path.join(root, "input"), preparationRoot = path.join(root, "prepared"), rootDirectory = path.join(root, "committed");
  for (const location of [inputRoot, preparationRoot, rootDirectory]) await fs.mkdir(location, { mode: 0o700 });
  const context = { authenticated: true, companyId: uuid(), userId: uuid() }, tenantStore = createMemoryImportUploadStore();
  await fs.mkdir(path.join(inputRoot, context.companyId), { mode: 0o700 });
  const sourceName = video ? "source.mp4" : "source.png", sourcePath = path.join(inputRoot, context.companyId, sourceName);
  if (video) {
    const result = await runBoundedProcess(FFMPEG, ["-hide_banner", "-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=120x160:r=30",
      "-t", "0.5", "-threads", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", "-f", "mp4", "-n", sourcePath], { cwd: root });
    assert.equal(result.code, 0);
  } else await sharp({ create: { width: 240, height: 180, channels: 3, background: "#2277aa" } }).png().toFile(sourcePath);
  const bytes = await fs.readFile(sourcePath);
  const sourceResult = video ? { signatureVerified: true, decoded: true, detectedMime: "video/mp4", width: 120, height: 160,
    durationMs: 500, hasAudio: false, colorMode: "sdr" } : { signatureVerified: true, decoded: true, detectedMime: "image/png", width: 240, height: 180, frames: 1 };
  const provider = createMemoryMultipartProvider({ inspectBytes: async actual => {
    assert.equal(hash(actual), hash(bytes)); if (!video) await sharp(actual).raw().toBuffer(); return sourceResult;
  } });
  const uploadService = createCalendarImportUploadService({ store: tenantStore, provider, enabled: true, allowVolatileForTests: true });
  const uploaded = await uploadService.start(context, { idempotencyKey: uuid(), kind: video ? "video" : "image",
    mimeType: sourceResult.detectedMime, sizeBytes: bytes.length, sha256: hash(bytes) });
  const part = await uploadService.authorizePart(context, { uploadId: uploaded.uploadId, partNumber: 1 });
  await provider.receivePartForTest(part.authorizationId, bytes); await uploadService.complete(context, { uploadId: uploaded.uploadId });
  let eligible = true;
  const accessPolicy = createImportAccessPolicy({ allowedOwners: [context], isEligible: () => eligible });
  const guard = createDiskSpaceGuardForTests({ rootDirectory, enabled: true, marginBytes: 0, statfsForTests: async () => ({ bavail: 10n * 1024n ** 3n, bsize: 1n }) });
  const capacity = createGlobalMediaCapacity({ store: globalStore(), enabled: true, allowVolatileForTests: true,
    diskSpaceGuard: guard, requireDiskSpaceEvidence: true });
  const admission = createPreparedDiskAdmission({ capacity, tenantStore, accessPolicy, rootDirectory, diskSpaceGuard: guard,
    enabled: true, allowVolatileForTests: true });
  const options = { rootDirectory, preparationRoot, tenantStore, admission, accessPolicy,
    outputInspector: createPreparedDiskOutputInspector({ ffmpegPath: FFMPEG }), enabled: true, allowVolatileForTests: true };
  const resultStore = createPreparedDiskResultStore(options), tasks = [];
  const dispatcher = { capabilities: { testOnly: true, idempotentDispatch: true, authoritativeLookup: true, isolatedWorker: true, maxRuntimeMs: 180000 },
    async dispatch(task) { tasks.push(task); return { state: "running", executionId: uuid(), dispatchKey: task.dispatchKey, executionDigest: task.executionDigest }; },
    async getByKey(query) { return { ...query, state: "not_found", authoritative: true }; } };
  const queue = createPreparationQueue({ store: tenantStore, dispatcher, resultStore, accessPolicy, enabled: true, allowVolatileForTests: true });
  const selection = { kind: video ? "video" : "image", targets: video ? ["story", "reel"] : ["feed", "story"], audioMode: video ? "muted" : "none",
    musicalTargets: [], musicTrackId: null, shareToFeed: false };
  await queue.request(context, { uploadId: uploaded.uploadId, assetId: uploaded.assetId, expectedMediaRevision: 0, idempotencyKey: uuid(), selection });
  await queue.dispatchNext(context); const task = tasks[0]; assert.ok(task);
  await admission.reserve(task); const globalLease = await capacity.acquireNext({ context: coordinator }); assert.equal(globalLease.jobId, task.jobId);
  const preparer = createImportMediaPreparer({ inputRoot, outputRoot: preparationRoot, ffmpegPath: FFMPEG });
  const prepared = await preparer.prepare({ companyId: context.companyId, assetId: uploaded.assetId, sourceName, ...selection }, { deadlineAt: task.deadlineAt });
  const resultRef = uuid(), request = { task, prepared, resultRef, finishedAt: Date.now(), elapsedMs: Math.max(1, prepared.elapsedMs) };
  const query = Object.fromEntries(["companyId", "userId", "assetId", "mediaRevision", "dispatchKey", "executionDigest"].map(key => [key, task[key]])); query.resultRef = resultRef;
  async function ready() {
    const actual = await resultStore.commit(request);
    const global = await capacity.inspect({ context: coordinator, jobId: task.jobId });
    if (global.state === "running") await capacity.recordCompletion({ context: coordinator, jobId: task.jobId, leaseToken: globalLease.leaseToken,
      outcome: "succeeded", actualRuntimeMs: actual.elapsedMs, proofId: hash("synthetic prepared execution complete") });
    const status = await queue.completeWorker({ authenticated: true, role: "calendar_media_worker", companyId: context.companyId },
      { jobId: task.jobId, fence: task.fence, leaseToken: task.leaseToken, resultRef });
    assert.equal(status.ready, true); return actual;
  }
  const preview = (target = video ? "story" : "feed") => ({ context, assetId: task.assetId, mediaRevision: 1, resultRef,
    target, sha256: target === "thumbnail" ? prepared.thumbnail.sha256 : prepared.variants[target].sha256 });
  const committed = descriptor => path.join(rootDirectory, context.companyId, task.assetId, task.dispatchKey, descriptor.fileName);
  return { root, inputRoot, rootDirectory, preparationRoot, sourcePath, sourceBytes: bytes, options, resultStore, tenantStore, admission,
    context, task, prepared, resultRef, request, query, ready, preview, committed, revoke: () => { eligible = false; } };
}

test("actual photo derivatives commit once, re-inspect with the existing queue and preview exact immutable hashes/ranges", async t => {
  const f = await fixture(t), actual = await f.resultStore.commit(f.request);
  assert.equal(actual.actualInspection, true); assert.deepEqual(await f.resultStore.commit(f.request), actual);
  assert.deepEqual(await f.resultStore.inspectCommitted(f.query), actual);
  await f.ready();
  const recreated = createPreparedDiskResultStore(f.options), descriptor = await recreated.inspectPreview(f.preview());
  assert.equal(descriptor.width, 1080); assert.equal(descriptor.height, 1350); assert.equal(descriptor.audioMode, "none");
  const chunks = [], result = await recreated.streamPreview({ ...f.preview(), range: { start: 5, end: 104 }, consume: chunk => chunks.push(chunk) });
  assert.equal(result.transferredBytes, 100); assert.equal(Buffer.concat(chunks).length, 100);
  assert.deepEqual(Buffer.concat(chunks), (await fs.readFile(f.committed(f.prepared.variants.feed))).subarray(5, 105));
  assert.deepEqual(await fs.readFile(f.sourcePath), f.sourceBytes);
  assert.equal(isPreparedDiskResultStore(recreated), false); assert.equal(isPreparedDiskResultStore(recreated, { allowVolatileForTests: true }), true);
  assert.equal(isPreparedDiskResultStore({ ...recreated }, { allowVolatileForTests: true }), false);
});
test("commit requires the actual branded admission; disabled/test stores cannot silently become active", async t => {
  const f = await fixture(t);
  for (const override of [{ enabled: false }, { allowVolatileForTests: false }, { admission: { ...f.admission } },
    { outputInspector: { capabilities: { actualInspection: true }, inspectFile: async () => ({ decoded: true }) } }]) {
    const store = createPreparedDiskResultStore({ ...f.options, ...override }); assert.equal(store.capabilities.available, false);
    await assert.rejects(store.commit(f.request), { code: "prepared_disk_unavailable" });
  }
});
test("commit refuses exhausted remaining execution time before copying or decoding an output", async t => {
  const f = await fixture(t);
  await assert.rejects(f.resultStore.commit({ ...f.request, elapsedMs: f.task.maxRuntimeMs }), { code: "prepared_disk_deadline_exceeded" });
  const directory = path.dirname(f.committed(f.prepared.variants.feed)), names = await fs.readdir(directory);
  assert.equal(names.some(name => name.endsWith(".jpg") || name.endsWith(".mp4") || name === "manifest.json"), false);
});
test("a dispatch cannot bind a second resultRef and changed metadata cannot replace its committed result", async t => {
  const f = await fixture(t); const actual = await f.resultStore.commit(f.request);
  await assert.rejects(f.resultStore.commit({ ...f.request, resultRef: uuid() }), { code: "prepared_disk_result_conflict" });
  assert.deepEqual(await f.resultStore.commit({ ...f.request, elapsedMs: f.request.elapsedMs + 1 }), actual);
  assert.ok(actual.elapsedMs > f.request.elapsedMs); assert.ok(actual.finishedAt >= f.request.finishedAt);
  assert.equal((await f.resultStore.inspectCommitted(f.query)).resultRef, f.resultRef);
});
test("foreign owner, result, target, checksum, original bytes and path-like requests expose no preview", async t => {
  const f = await fixture(t); await f.ready();
  for (const patch of [{ context: { ...f.context, userId: uuid() } }, { context: { ...f.context, companyId: uuid() } },
    { resultRef: uuid() }, { target: "original" }, { target: "../../source" }, { sha256: hash(f.sourceBytes) },
    { mediaRevision: 2 }, { filePath: f.sourcePath }, { url: "https://synthetic.invalid" }]) {
    let emitted = 0;
    await assert.rejects(f.resultStore.streamPreview({ ...f.preview(), ...patch, consume: () => { emitted++; } })); assert.equal(emitted, 0);
  }
  await assert.rejects(f.resultStore.inspectCommitted({ ...f.query, userId: uuid() }), { code: "prepared_disk_owner_invalid" });
  await f.tenantStore.update(f.context.companyId, state => { state.preparation.jobs[f.task.jobId].result.objects.feed.objectVersion = uuid(); });
  await assert.rejects(f.resultStore.inspectPreview(f.preview()), { code: "prepared_disk_preview_changed" });
  f.revoke(); await assert.rejects(f.resultStore.inspectPreview(f.preview()), { code: "prepared_disk_not_allowed" });
});
test("same-size tampering after commit is detected before queue inspection or any preview byte", async t => {
  const f = await fixture(t); await f.ready();
  const file = f.committed(f.prepared.variants.feed), bytes = await fs.readFile(file); bytes[Math.floor(bytes.length / 2)] ^= 1;
  await fs.chmod(file, 0o600); await fs.writeFile(file, bytes);
  await assert.rejects(f.resultStore.inspectCommitted(f.query), { code: "prepared_disk_checksum_invalid" });
  let emitted = 0; await assert.rejects(f.resultStore.streamPreview({ ...f.preview(), consume: () => { emitted++; } }), { code: "prepared_disk_checksum_invalid" });
  assert.equal(emitted, 0);
});
test("junction/symlink directories and hardlink prepared inputs cannot enter the immutable committed result", async t => {
  const f = await fixture(t), part = f.prepared.variants.feed, file = path.join(f.preparationRoot, f.context.companyId, f.task.assetId, part.fileName);
  const backup = path.join(f.root, "synthetic-output-backup.jpg"); await fs.rename(file, backup);
  await fs.link(backup, file);
  await assert.rejects(f.resultStore.commit(f.request), { code: "prepared_disk_file_invalid" });
  await fs.unlink(file); await fs.rename(backup, file);
  const inputDir = path.dirname(file), savedDir = path.join(path.dirname(inputDir), "synthetic-saved-output");
  await fs.rename(inputDir, savedDir); await fs.symlink(savedDir, inputDir, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(f.resultStore.commit(f.request), { code: "prepared_disk_root_unsafe" });
  assert.equal(hash(await fs.readFile(path.join(savedDir, part.fileName))), part.sha256);
});
test("forged descriptor geometry and original paths cannot claim preparation", async t => {
  const f = await fixture(t), forged = structuredClone(f.prepared);
  forged.variants.feed.width = 1079;
  await assert.rejects(f.resultStore.commit({ ...f.request, prepared: forged }), { code: "prepared_disk_descriptor_invalid" });
  const original = structuredClone(f.prepared); original.variants.feed.fileName = f.sourcePath;
  await assert.rejects(f.resultStore.commit({ ...f.request, prepared: original }), { code: "prepared_disk_descriptor_invalid" });
});
test("failed partial commit binds its original intent before bytes and refuses another result or unknown pending files", async t => {
  const f = await fixture(t), story = f.prepared.variants.story;
  const source = path.join(f.preparationRoot, f.context.companyId, f.task.assetId, story.fileName), original = await fs.readFile(source);
  const corrupt = Buffer.from(original); corrupt[Math.floor(corrupt.length / 2)] ^= 1; await fs.writeFile(source, corrupt);
  await assert.rejects(f.resultStore.commit(f.request), { code: "prepared_disk_checksum_invalid" });
  const dirname = path.dirname(f.committed(story));
  assert.ok((await fs.readdir(dirname)).includes("intent.json")); assert.equal((await fs.readdir(dirname)).includes("manifest.json"), false);
  assert.equal(hash(await fs.readFile(f.committed(f.prepared.variants.feed))), f.prepared.variants.feed.sha256);
  await assert.rejects(f.resultStore.commit({ ...f.request, resultRef: uuid() }), { code: "prepared_disk_result_conflict" });
  const changed = structuredClone(f.prepared); changed.variants.feed.sha256 = "d".repeat(64); changed.variants.feed.fileName = `${"d".repeat(64)}.jpg`;
  await assert.rejects(f.resultStore.commit({ ...f.request, prepared: changed }), { code: "prepared_disk_result_conflict" });
  await fs.writeFile(source, original);
  const pending = path.join(dirname, ".pending-unknown-synthetic"); await fs.writeFile(pending, "SYNTHETIC OWNED TEST MARKER", { flag: "wx" });
  await assert.rejects(f.resultStore.commit(f.request), { code: "prepared_disk_busy_or_recovery_required" });
  assert.equal(await fs.readFile(pending, "utf8"), "SYNTHETIC OWNED TEST MARKER");
  await fs.unlink(pending); assert.equal((await f.resultStore.commit(f.request)).resultRef, f.resultRef);
});
test("null photo thumbnail is accepted, same-task replay after ready stays read-only, and inspection certificate tampering is refused", async t => {
  const f = await fixture(t); f.request.prepared = { ...f.prepared, thumbnail: null }; await f.ready();
  const actual = await f.resultStore.inspectCommitted(f.query);
  assert.deepEqual(await f.resultStore.commit({ ...f.request, finishedAt: Date.now(), elapsedMs: actual.elapsedMs + 10 }), actual);
  const manifestPath = path.join(path.dirname(f.committed(f.prepared.variants.feed)), "manifest.json"), manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  manifest.inspection.files[f.prepared.variants.feed.fileName].width = 1079;
  await fs.chmod(manifestPath, 0o600); await fs.writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(f.resultStore.inspectCommitted(f.query), { code: "prepared_disk_inspection_invalid" });
});
test("preview single ranges and cancellation are bounded; a stalled consumer times out without further chunks", async t => {
  const f = await fixture(t); await f.ready();
  for (const range of [{ start: -1, end: 10 }, { start: 5, end: 4 }, { start: 0, end: f.prepared.variants.feed.size }, { start: 0, end: 1, extra: true }]) {
    let emitted = 0; await assert.rejects(f.resultStore.streamPreview({ ...f.preview(), range, consume: () => { emitted++; } })); assert.equal(emitted, 0);
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.resultStore.streamPreview({ ...f.preview(), signal: controller.signal, consume: () => {} }), { code: "prepared_disk_stream_aborted" });
  let emitted = 0;
  await assert.rejects(f.resultStore.streamPreview({ ...f.preview(), timeoutMs: 40, consume: () => { emitted++; return new Promise(() => {}); } }), { code: "prepared_disk_stream_timeout" });
  assert.ok(emitted <= 1);
});
test("real MP4 and thumbnail decode at commit, equivalent Story/Reel share one committed object, and queue accepts hash reinspection", {
  skip: !syncFs.existsSync(FFMPEG), timeout: 60000
}, async t => {
  const f = await fixture(t, { video: true }); const actual = await f.ready();
  assert.equal(actual.objects.story.objectKey, actual.objects.reel.objectKey);
  assert.equal(actual.objects.story.objectVersion, actual.objects.reel.objectVersion);
  assert.equal(actual.prepared.variants.story.videoCodec, "h264"); assert.equal(actual.prepared.variants.story.hasAudio, false);
  const descriptor = await f.resultStore.inspectPreview(f.preview("story")); assert.equal(descriptor.mimeType, "video/mp4");
  assert.equal(descriptor.width, 1080); assert.equal(descriptor.height, 1920);
  const thumb = await f.resultStore.inspectPreview(f.preview("thumbnail")); assert.equal(thumb.mimeType, "image/jpeg");
  const chunks = []; await f.resultStore.streamPreview({ ...f.preview("reel"), consume: chunk => chunks.push(chunk) });
  assert.equal(hash(Buffer.concat(chunks)), actual.prepared.variants.reel.sha256);
});
