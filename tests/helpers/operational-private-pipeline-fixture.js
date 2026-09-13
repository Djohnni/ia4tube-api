"use strict";

// Principal local integration fixture: real loopback PostgreSQL, real sealed
// files and separate native-process workers. No volatile-store acceptance flag.
const assert = require("node:assert/strict"), crypto = require("node:crypto"), fs = require("node:fs/promises");
const path = require("node:path"), sharp = require("sharp"), { Readable } = require("node:stream");
const { createOperationalMediaPostgresFixture } = require("./operational-media-postgres-fixture");
const imports = "../../src/social/calendar/imports/";
const { createImportUploadPostgresStore } = require(imports + "postgres-store");
const { createPostgresGlobalCapacityStore } = require(imports + "postgres-global-capacity-store");
const { createCalendarImportUploadService } = require(imports + "upload-service");
const { createRenderDiskPrivateUploadProvider } = require(imports + "render-disk-provider");
const { createRenderDiskAdmission } = require(imports + "render-disk-admission");
const { createImportAccessPolicy } = require(imports + "access-policy");
const { createGlobalMediaCapacity } = require(imports + "global-capacity");
const { createDiskSpaceGuard } = require(imports + "disk-space-guard");
const { createDurableInspectionDispatcher } = require(imports + "inspection-dispatcher");
const { createOperationalInspectionRunner } = require(imports + "operational-inspection-runner");
const { createProcessDiskInspectionWorker } = require(imports + "process-disk-inspection-worker");
const { createPreparedDiskAdmission } = require(imports + "prepared-disk-admission");
const { createPreparedDiskResultStore } = require(imports + "prepared-disk-store");
const { createPreparedDiskOutputInspector } = require(imports + "prepared-disk-output-inspector");
const { createMediaProcessExecutor } = require(imports + "media-process-executor");
const { createProcessDiskPreparationWorker } = require(imports + "process-disk-preparation-worker");
const { createOperationalPreparationRunner } = require(imports + "operational-preparation-runner");
const { createPreparationQueue } = require(imports + "preparation-queue");
const { runBoundedProcess } = require(imports + "preparation");
const FFMPEG = process.env.FFMPEG_TEST_BINARY || path.resolve(__dirname, "../../../video_audit/pydeps/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v7.1.exe");
const hash = (value, type = "sha256", encoding = "hex") => crypto.createHash(type).update(value).digest(encoding);
const coordinator = Object.freeze({ authenticated: true, role: "calendar_media_capacity_coordinator" });

async function createOperationalPrivatePipelineFixture(t, options = {}) {
  const pg = options.pgFixture || await createOperationalMediaPostgresFixture(t, options);
  const root = path.join(pg.root, "media-" + crypto.randomUUID()); await fs.mkdir(root, { mode: 0o700 });
  const privateRoot = path.join(root, "private"), preparationRoot = path.join(root, "prepared"), musicRoot = path.join(root, "music");
  const inspectionWorkingRoot = path.join(root, "inspection"), preparationWorkingRoot = path.join(root, "preparation"), executorRoot = path.join(root, "executor");
  for (const location of [privateRoot, preparationRoot, musicRoot, inspectionWorkingRoot, preparationWorkingRoot, executorRoot]) await fs.mkdir(location, { mode: 0o700 });
  const context = options.context || { authenticated: true, companyId: await pg.addCompany(), userId: crypto.randomUUID() };
  const catalog = new Map();
  if (options.syntheticMusic === true) {
    const filename = path.join(musicRoot, "local-tone.wav");
    const generated = await runBoundedProcess(FFMPEG, ["-hide_banner", "-nostdin", "-v", "error", "-f", "lavfi", "-i",
      "sine=frequency=523.25:sample_rate=48000", "-t", "15", "-threads", "2", "-c:a", "pcm_s16le", "-n", filename], { cwd: root, timeoutMs: 10000 });
    assert.equal(generated.code, 0);
    catalog.set("synthetic-local-tone", { id: "synthetic-local-tone", sha256: hash(await fs.readFile(filename)), syntheticTestOnly: true, durationSeconds: 15 });
  }
  let eligible = true, offset = 0, failPreparedObservation = false, observationFailures = 0;
  const clock = () => Date.now() + offset;
  const accessPolicy = options.accessPolicy || createImportAccessPolicy({ allowedOwners: [context], isEligible: () => eligible });
  const counters = { inspectionSourceReads: 0, preparationSourceReads: 0 };
  const f = { pg, root, privateRoot, diskRoot: privateRoot, preparationRoot, musicRoot, inspectionWorkingRoot, preparationWorkingRoot,
    executorRoot, context, catalog, accessPolicy, counters, clock, revoke() { eligible = false; }, advance(ms) { offset += ms; },
    failNextPreparedObservationForTest() { failPreparedObservation = true; }, observationFailures: () => observationFailures };
  async function mount() {
    // Actual PostgreSQL is always used. This optional test fault drops exactly
    // one pending terminal-state write BEFORE sending it, then real ROLLBACK
    // runs. It simulates a coordinator failure after immutable media commit.
    const actualPool = pg.tenantPool;
    const faultablePool = { query: (...args) => actualPool.query(...args), async connect() {
      const client = await actualPool.connect();
      return { release: () => client.release(), async query(sql, args) {
        if (failPreparedObservation && typeof sql === "string" && sql.startsWith("INSERT INTO ia4tube_calendar.import_upload_state") &&
            typeof args?.[1] === "string") {
          const document = JSON.parse(args[1]);
          if (Object.values(document.preparationExecutions?.records || {}).some(record => record.phase === "succeeded" && !record.capacitySettled)) {
            failPreparedObservation = false; observationFailures++;
            throw Object.assign(new Error("synthetic_terminal_write_lost_before_query"), { code: "08006" });
          }
        }
        return client.query(sql, args);
      } };
    } };
    const store = createImportUploadPostgresStore({ pool: faultablePool }), ledger = createPostgresGlobalCapacityStore({ pool: pg.capacityPool });
    assert.equal(await store.verify(), true); assert.equal(await ledger.verify(), true);
    const guard = createDiskSpaceGuard({ rootDirectory: privateRoot, enabled: true, marginBytes: 16 * 1024 * 1024 });
    const capacity = createGlobalMediaCapacity({ store: ledger, enabled: true, requireDiskSpaceEvidence: true, diskSpaceGuard: guard, clock });
    const sourceAdmission = createRenderDiskAdmission({ capacity, store, rootDirectory: privateRoot, diskSpaceGuard: guard,
      requireDiskSpaceEvidence: true, coordinatorContext: coordinator, enabled: true });
    const executor = createMediaProcessExecutor({ workingRoot: executorRoot, ffmpegPath: FFMPEG,
      allowedRoots: [privateRoot, preparationRoot, musicRoot, inspectionWorkingRoot, preparationWorkingRoot], memoryBytes: 512 * 1024 ** 2,
      ...(process.platform === "linux" ? { linuxRuntime: { cgroupRoot: process.env.CALENDAR_MEDIA_LINUX_CGROUP_ROOT,
        launchMode: process.env.CALENDAR_MEDIA_LINUX_LAUNCH_MODE || "direct", validationOnly: true } } : {}) });
    if (process.platform === "linux") await executor.prepareRuntime();
    assert.equal(executor.capabilities.hardTermination, true, "Principal fixture requires actual native process-tree termination");
    let inspectorWorker, preparationWorker;
    const inspectionRunner = createOperationalInspectionRunner({ store, owner: context, capacity, accessPolicy, diskSpaceGuard: guard,
      getWorker: () => inspectorWorker, enabled: true, clock });
    const inspectionTransport = Object.freeze({ ...inspectionRunner, async dispatch(task) {
      try { return await inspectionRunner.dispatch(task); }
      catch (error) { t.diagnostic(`PHYSICAL_INSPECTION_DISPATCH_ERROR=${error.code || error.name}`); throw error; }
    } });
    const inspector = createDurableInspectionDispatcher({ store, runner: inspectionTransport, accessPolicy, enabled: true, clock });
    const provider = createRenderDiskPrivateUploadProvider({ rootDirectory: privateRoot, store, admission: sourceAdmission, inspector,
      transferOrigin: "https://ia4tube-api.onrender.com", enabled: true, clock });
    inspectorWorker = createProcessDiskInspectionWorker({ workingDirectory: inspectionWorkingRoot, executor, clock,
      assertExecutionHeld: value => inspectionRunner.assertExecutionHeld(value),
      provider: { streamSealedObject(args) { counters.inspectionSourceReads++; return provider.streamSealedObject(args); } } });
    const uploadProvider = Object.freeze({ ...provider,
      async finalizeMultipart(args) { try { return await provider.finalizeMultipart(args); }
        catch (error) { t.diagnostic(`PHYSICAL_FINALIZE_ERROR=${error.code || error.name}`); throw error; } },
      async inspectObject(args) { try { return await provider.inspectObject(args); }
        catch (error) { t.diagnostic(`PHYSICAL_INSPECTION_ERROR=${error.code || error.name}`); throw error; } }
    });
    const upload = createCalendarImportUploadService({ store, provider: uploadProvider, enabled: true, clock });
    const preparedAdmission = createPreparedDiskAdmission({ capacity, tenantStore: store, accessPolicy, rootDirectory: privateRoot,
      diskSpaceGuard: guard, enabled: true, clock });
    const preparedStore = createPreparedDiskResultStore({ rootDirectory: privateRoot, preparationRoot, tenantStore: store, admission: preparedAdmission,
      accessPolicy, outputInspector: createPreparedDiskOutputInspector({ ffmpegPath: FFMPEG, processExecutor: executor }), enabled: true, clock });
    const preparationRunner = createOperationalPreparationRunner({ store, owner: context, capacity, admission: preparedAdmission, accessPolicy,
      getWorker: () => preparationWorker, enabled: true, syntheticMediaForLocalTests: options.syntheticMusic === true, clock });
    preparationWorker = createProcessDiskPreparationWorker({ workingDirectory: preparationWorkingRoot, preparationRoot, resultStore: preparedStore,
      admission: preparedAdmission, executor, clock,
      ...(options.syntheticMusic === true ? { musicRoot, allowSyntheticForTests: true,
        resolveMusicTrack: async id => catalog.has(id) ? { sourceName: "local-tone.wav", sha256: catalog.get(id).sha256, synthetic: true } : null } : {}),
      provider: { async streamSealedObject(args) {
        counters.preparationSourceReads++;
        if (options.beforePreparationSourceRead) await options.beforePreparationSourceRead(args);
        return provider.streamSealedObject(args);
      } } });
    const preparation = createPreparationQueue({ store, dispatcher: preparationRunner, resultStore: preparedStore, accessPolicy,
      enabled: true, catalog, allowSyntheticForTests: options.syntheticMusic === true, clock });
    Object.assign(f, { store, ledger, guard, capacity, sourceAdmission, executor, inspectionRunner, inspector, inspectorWorker, provider,
      upload, preparedAdmission, preparedStore, preparationRunner, preparationWorker, preparation });
  }
  await mount();
  f.snapshot = () => f.store.update(context.companyId, state => structuredClone(state));
  f.reopen = async ({ restartDatabase = false } = {}) => { if (restartDatabase) await pg.restart(); else await pg.reopenPools(); await mount(); };
  f.jobFor = async (assetId, mediaRevision) => {
    const state = await f.snapshot(), asset = state.preparation.assets[assetId];
    return state.preparation.jobs[asset.revisions[String(mediaRevision || asset.currentRevision)]];
  };
  f.actualFor = async (assetId, mediaRevision) => {
    const job = await f.jobFor(assetId, mediaRevision);
    return f.preparedStore.inspectCommitted({ companyId: context.companyId, userId: context.userId, assetId,
      mediaRevision: job.mediaRevision, dispatchKey: job.dispatchKey, executionDigest: job.executionDigest, resultRef: job.result.resultRef });
  };
  f.uploadBytes = async (bytes, kind, mimeType, { idempotencyKey = crypto.randomUUID(), afterPart } = {}) => {
    const started = await f.upload.start(context, { idempotencyKey, kind, mimeType, sizeBytes: bytes.length, sha256: hash(bytes) });
    for (let offset = 0, number = 1; offset < bytes.length; offset += 5 * 1024 * 1024, number++) {
      const chunk = bytes.subarray(offset, Math.min(offset + 5 * 1024 * 1024, bytes.length));
      const grant = await f.upload.authorizePart(context, { uploadId: started.uploadId, partNumber: number, sha256: hash(chunk), md5Base64: hash(chunk, "md5", "base64") });
      const row = (await f.snapshot()).uploads[started.uploadId];
      await f.provider.acceptPart({ context, objectKey: row.objectKey, uploadId: row.disk.uploadId, partNumber: number,
        authorizationId: grant.authorizationId, contentLength: chunk.length, stream: Readable.from([chunk]) });
      if (afterPart) await afterPart({ started, partNumber: number });
    }
    let result;
    try { result = await f.upload.complete(context, { uploadId: started.uploadId }); }
    catch (error) {
      const state = await f.snapshot();
      const execution = Object.values(state.inspectionExecutions?.records || {}).find(record => record.task.uploadId === started.uploadId);
      if (execution) {
        const observed = await f.executor.observe(execution.executionId);
        let terminal; try { terminal = JSON.parse(await fs.readFile(path.join(inspectionWorkingRoot, execution.executionId, "worker-terminal.json"), "utf8")); } catch (_) {}
        t.diagnostic(`PHYSICAL_SOURCE_INSPECTION=${JSON.stringify({ journal: execution.phase, state: observed.state,
          reason: observed.reason, failureCode: observed.failureCode, workerReason: terminal?.reason })}`);
      }
      throw error;
    }
    assert.equal(result.state, "uploaded", `Physical inspection did not finish: ${result.state}`); return result;
  };
  f.enqueuePrepared = async (uploaded, selection, expectedMediaRevision = 0, { lostAcknowledgement = false } = {}) => {
    const request = await f.preparation.request(context, { uploadId: uploaded.uploadId, assetId: uploaded.assetId,
      expectedMediaRevision, idempotencyKey: crypto.randomUUID(), selection });
    if (lostAcknowledgement) {
      // Complete the actual dispatch but deliberately discard its queue reply;
      // the durable execution/result records are still the principal evidence.
      const delegate = f.preparationRunner;
      const dropped = Object.freeze({ ...delegate, dispatch: async task => { await delegate.dispatch(task); throw new Error("synthetic-ack-lost"); } });
      const queue = createPreparationQueue({ store: f.store, dispatcher: dropped, resultStore: f.preparedStore, accessPolicy,
        enabled: true, catalog, clock });
      await queue.dispatchNext(context);
    } else await f.preparation.dispatchNext(context);
    const status = await f.preparation.status(context, { assetId: uploaded.assetId });
    if (status.state === "attention") {
      const job = await f.jobFor(uploaded.assetId), execution = (await f.snapshot()).preparationExecutions?.records?.[job.dispatchKey];
      if (execution) {
        const actual = await f.executor.observe(execution.executionId);
        let terminal; try { terminal = JSON.parse(await fs.readFile(path.join(preparationWorkingRoot, execution.executionId, "worker-terminal.json"), "utf8")); } catch (_) {}
        t.diagnostic(`PHYSICAL_PREPARATION=${JSON.stringify({ state: actual.state, reason: actual.reason, metrics: actual.metrics,
          workerReason: terminal?.reason, journal: execution.phase })}`);
        for (const name of await fs.readdir(executorRoot)) {
          if (!/^[a-f0-9-]{36}$/.test(name)) continue;
          let child; try { child = JSON.parse(await fs.readFile(path.join(executorRoot, name, "request.json"), "utf8")); } catch (_) { continue; }
          if (child.parentExecutionId !== execution.executionId || child.operation !== "inspect_output") continue;
          const observed = await f.executor.observe(name);
          t.diagnostic(`PHYSICAL_DERIVATIVE_INSPECTION=${JSON.stringify({ mimeType: child.input.descriptor.mimeType,
            filePathCharacters: child.input.filePath.length, state: observed.state, reason: observed.reason,
            failureCode: observed.failureCode, metrics: observed.metrics })}`);
        }
      }
    }
    const prepared = status.ready ? (await f.preparation.snapshot(context, { assetId: uploaded.assetId, mediaRevision: status.mediaRevision })).result : null;
    return { uploadId: uploaded.uploadId, assetId: uploaded.assetId, mediaRevision: status.mediaRevision, request, status, prepared };
  };
  f.preparePhoto = async (settings = {}) => {
    const bytes = settings.bytes || await sharp({ create: { width: 160, height: 100, channels: 3, background: "#2c7191" } }).png().toBuffer();
    return f.enqueuePrepared(await f.uploadBytes(bytes, "image", "image/png", settings.upload), settings.selection ||
      { kind: "image", targets: ["feed", "story"], audioMode: "none" }, 0, settings);
  };
  f.prepareVideo = async (settings = {}) => {
    if (settings.bytes) return f.enqueuePrepared(await f.uploadBytes(settings.bytes, "video", "video/mp4", settings.upload), settings.selection ||
      { kind: "video", targets: ["story", "reel"], audioMode: "muted" }, 0, settings);
    const source = path.join(root, "synthetic-video-" + crypto.randomUUID() + ".mp4");
    const created = await runBoundedProcess(FFMPEG, ["-hide_banner", "-nostdin", "-v", "error", "-f", "lavfi", "-i",
      "testsrc2=size=96x160:rate=10", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "3",
      "-threads", "2", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac",
      "-movflags", "+faststart", "-n", source], { cwd: root, timeoutMs: 10000 });
    assert.equal(created.code, 0);
    return f.enqueuePrepared(await f.uploadBytes(await fs.readFile(source), "video", "video/mp4", settings.upload), settings.selection ||
      { kind: "video", targets: ["story", "reel"], audioMode: "muted" }, 0, settings);
  };
  return f;
}
module.exports = { createOperationalPrivatePipelineFixture, FFMPEG, hash, coordinator };
