"use strict";
// Production composition for already-finished MP4s. It uses the existing RLS,
// immutable storage, signed transfer and calendar publication contracts.
const fs = require("node:fs/promises"), path = require("node:path");
const { loadReadyVideoConfig, resolveReadyVideoOwners } = require("./ready-video-config");
const { createImportUploadPostgresStore } = require("./postgres-store");
const { createPostgresGlobalCapacityStore } = require("./postgres-global-capacity-store");
const { createPostgresTransferRegistryStore } = require("./postgres-transfer-registry-store");
const { createGlobalMediaCapacity } = require("./global-capacity");
const { createDiskSpaceGuard } = require("./disk-space-guard");
const { createRenderDiskAdmission } = require("./render-disk-admission");
const { createPreparedDiskAdmission } = require("./prepared-disk-admission");
const { createImportAccessPolicy } = require("./access-policy");
const { createReadyVideoProcessExecutor } = require("./ready-video-process-executor");
const { createOperationalInspectionRunner, isOperationalInspectionRunner } = require("./operational-inspection-runner");
const { createOperationalPreparationRunner, isOperationalPreparationRunner } = require("./operational-preparation-runner");
const { createProcessDiskInspectionWorker } = require("./process-disk-inspection-worker");
const { createProcessDiskPreparationWorker } = require("./process-disk-preparation-worker");
const { createDurableInspectionDispatcher } = require("./inspection-dispatcher");
const { createRenderDiskPrivateUploadProvider } = require("./render-disk-provider");
const { createCalendarImportUploadService } = require("./upload-service");
const { createPreparedDiskResultStore } = require("./prepared-disk-store");
const { createPreparedDiskOutputInspector } = require("./prepared-disk-output-inspector");
const { createPreparationQueue } = require("./preparation-queue");
const { createTransferAuthorizationRegistry } = require("./transfer-registry");
const { createRenderDiskTransferService, createSingleProcessTransferLimiter } = require("./transfer-service");
const { createOperationalCalendarImportsRuntimeFactory } = require("./operational-runtime");
const { safePath } = require("./media-process-executor");
const { NATIVE_READY_VIDEO_PROFILE } = require("./native-ready-video");
const { createReadyVideoDiagnostics } = require("./ready-video-diagnostics");
const ROOT = "/var/data/private/calendar-media";
function fail(code, statusCode = 503) { throw Object.assign(new Error(code === "original_mp4_required"
  ? "Selecione um vídeo MP4 pronto e mantenha o áudio original." : "Importação de vídeos indisponível."),
{ code: code === "original_mp4_required" ? "calendar_import_ready_video_original_required" : `ready_video_${code}`, statusCode }); }
function createReadyVideoUploadCompletion({ upload, accessPolicy, waitMs = 12000, pollMs = 250 }) {
  if (!Number.isSafeInteger(waitMs) || waitMs < 1 || waitMs > 12000 || !Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > waitMs) fail("configuration_invalid");
  return async function complete(context, input) {
    let expired = false, timer;
    const pending = () => Object.assign(new Error("O vídeo ainda está sendo verificado."), { code: "import_verification_pending", statusCode: 503 });
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => { expired = true; reject(pending()); }, waitMs); });
    const observe = async () => {
      while (!expired) {
        accessPolicy.resolve(context);
        try {
          // The existing complete path reuses the immutable upload/ticket and
          // performs authoritative lookup; it never invents another job key.
          const record = await upload.complete(context, input);
          if (record?.state !== "verifying") return record;
        } catch (error) { if (error?.code !== "import_verification_pending") throw error; }
        if (!expired) await new Promise(resolve => setTimeout(resolve, pollMs));
      }
      throw pending();
    };
    try { return await Promise.race([observe(), deadline]); }
    finally { expired = true; clearTimeout(timer); }
  };
}
// Called only for an owner-bound durable calendar intention. A successful PUT
// followed by a closed phone still reaches the existing authoritative inspector.
function createReadyVideoUploadReconciliation({ upload, accessPolicy }) {
  return async (context, input) => {
    accessPolicy.resolve(context);
    const record = await upload.resume(context, input);
    if (record.kind !== "video" || record.mimeType !== "video/mp4" || record.uploadMode !== "single" || record.partCount !== 1)
      fail("original_mp4_required", 400);
    if (record.state === "uploaded" || ["cancelled", "cancel_pending", "rejected"].includes(record.state)) return record;
    if (record.state === "uploading" && (record.completedParts?.length !== 1 || record.completedParts[0].partNumber !== 1 ||
        record.completedParts[0].sizeBytes !== record.sizeBytes)) return record;
    if (!["uploading", "verifying"].includes(record.state)) return record;
    try { return await upload.complete(context, input); }
    catch (error) {
      if (["import_upload_incomplete", "import_verification_pending"].includes(error.code)) return null;
      throw error;
    }
  };
}
function routeRunners(entries, kind) {
  const check = kind === "inspect" ? isOperationalInspectionRunner : isOperationalPreparationRunner;
  if (!entries.length || entries.some(entry => !check(entry.runner))) fail("runner_invalid");
  function selected(value) {
    const entry = entries.find(item => item.owner.companyId === value?.companyId && item.owner.userId === value?.userId);
    if (!entry) fail("owner_not_allowed", 403);
    return entry.runner;
  }
  return Object.freeze({ capabilities: entries[0].runner.capabilities,
    dispatch: task => selected(task).dispatch(task), getByKey: query => selected(query).getByKey(query),
    assertExecutionHeld: query => selected(query?.task).assertExecutionHeld(query) });
}
function restrictReadyVideoServices(upload, preparation, accessPolicy) {
  const checkedUpload = Object.freeze({ ...upload,
    complete: createReadyVideoUploadCompletion({ upload, accessPolicy }),
    start(context, input) {
      accessPolicy.resolve(context);
      if (input?.kind !== "video" || input.mimeType !== "video/mp4") fail("original_mp4_required", 400);
      return upload.start(context, input);
    } });
  const checkedPreparation = Object.freeze({ ...preparation,
    validateSelection(context, selection) {
      accessPolicy.resolve(context);
      if (selection?.kind !== "video" || selection.audioMode !== "original" || selection.musicTrackId != null ||
          (selection.musicalTargets || []).length) fail("original_mp4_required", 400);
      return true;
    },
    request(context, input) {
      checkedPreparation.validateSelection(context, input?.selection);
      return preparation.request(context, input);
    } });
  return { upload: checkedUpload, preparation: checkedPreparation };
}
async function createReadyVideoRuntime({ env = process.env, tenantPool, capacityPool, transferPool,
  resolveOwnerForSubject, codecExecutor, rootDirectory = ROOT, ffmpegPath = "/usr/bin/ffmpeg", ffprobePath = "/usr/bin/ffprobe",
  isEligibleOwner = () => true, clock = Date.now, logger } = {}) {
  const config = loadReadyVideoConfig(env);
  if (!config.enabled) return null;
  let gcsConfig={enabled:false},gcsTransport=null;
  try {
    gcsConfig=require("./gcs-config").loadGcsConfig(env);
    gcsTransport=require("./gcs-config").createConfiguredGcsTransport(env);
  } catch {
    // Google configuration/availability never closes existing disk media.
    gcsConfig={enabled:env.SOCIAL_READY_VIDEO_GCS_ENABLED==="true"};gcsTransport=null;
  }
  const owners = await resolveReadyVideoOwners(config, resolveOwnerForSubject);
  if (!tenantPool || !capacityPool || !transferPool || tenantPool === capacityPool || tenantPool === transferPool || capacityPool === transferPool ||
      !path.isAbsolute(rootDirectory) || typeof clock !== "function" || typeof isEligibleOwner !== "function") fail("configuration_invalid");
  const root = path.resolve(rootDirectory), privateRoot = path.join(root, "uploads"), preparationRoot = path.join(root, "prepared");
  const workRoot = path.join(root, "ready-video"), executionRoot = path.join(workRoot, "executions"),
    inspectionRoot = path.join(workRoot, "inspection"), snapshotRoot = path.join(workRoot, "preparation");
  // Never create/migrate database schema here. These independently restricted
  // principals must pass their existing role, RLS and cross-role checks first.
  const store = createImportUploadPostgresStore({ pool: tenantPool }), ledger = createPostgresGlobalCapacityStore({ pool: capacityPool }),
    registryStore = createPostgresTransferRegistryStore({ pool: transferPool });
  await store.verify(); await ledger.verify(); await registryStore.verify();
  async function privateDirectory(directory) {
    await safePath(directory); const stat = await fs.stat(directory);
    if (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid())) fail("storage_permissions_invalid");
  }
  await privateDirectory(root);
  for (const directory of [privateRoot, preparationRoot, workRoot, executionRoot, inspectionRoot, snapshotRoot]) {
    try { await fs.mkdir(directory, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
    await privateDirectory(directory);
  }
  const disk = (await fs.stat(privateRoot)).dev;
  if ((await fs.stat(preparationRoot)).dev !== disk || (await fs.stat(workRoot)).dev !== disk) fail("storage_device_invalid");
  const executor = createReadyVideoProcessExecutor({ workingRoot: executionRoot,
    allowedRoots: [privateRoot, preparationRoot, inspectionRoot, snapshotRoot], codecExecutor, ffmpegPath, ffprobePath, clock });
  await executor.prepareRuntime();
  let closed = false, closing = false, submissions = null, timer = null, currentTick = null, started = false;
  const canAdmit = () => !closed && !closing;
  const accessPolicy = createImportAccessPolicy({ mode: "ready_video", allowedOwners: owners, isEligible: owner => !closed && isEligibleOwner(owner) === true });
  // Temporary investigation scope is one configured server-derived owner. No
  // phone/body IDs, account data or grant are passed to the diagnostic sink.
  const diagnosticOwner = owners[config.subjects.indexOf("159911205989")];
  const diagnostics = diagnosticOwner ? createReadyVideoDiagnostics({ logger, owner: diagnosticOwner,
    isEligibleOwner: owner => !closed && isEligibleOwner(owner) === true }) : null;
  const guard = createDiskSpaceGuard({ rootDirectory: privateRoot, enabled: true, marginBytes: 256 * 1024 ** 2 });
  await guard.sample();
  const capacity = createGlobalMediaCapacity({ store: ledger, enabled: true, requireDiskSpaceEvidence: true, diskSpaceGuard: guard, clock });
  if ((await capacity.summary({ context: { authenticated: true, role: "calendar_media_capacity_coordinator" } })).paused) fail("capacity_paused");
  const admission = createRenderDiskAdmission({ capacity, store, rootDirectory: privateRoot, diskSpaceGuard: guard, requireDiskSpaceEvidence: true,
    coordinatorContext: { authenticated: true, role: "calendar_media_capacity_coordinator" }, enabled: true, diagnostics });
  const preparedAdmission = createPreparedDiskAdmission({ capacity, tenantStore: store, accessPolicy,
    rootDirectory: privateRoot, diskSpaceGuard: guard, enabled: true, clock });
  const diskResultStore = createPreparedDiskResultStore({ rootDirectory: privateRoot, preparationRoot, tenantStore: store, admission: preparedAdmission,
    accessPolicy, outputInspector: createPreparedDiskOutputInspector({ ffmpegPath, processExecutor: executor,
      nativeProfile: NATIVE_READY_VIDEO_PROFILE }), nativeProfile: NATIVE_READY_VIDEO_PROFILE, enabled: true, clock });
  const resultStore=require("./prepared-disk-store").createRoutedPreparedResultStore({diskStore:diskResultStore,tenantStore:store,
    gcsStore:gcsTransport?require("./gcs-prepared-store").createGcsPreparedResultStore({tenantStore:store,diskStore:diskResultStore,transport:gcsTransport,accessPolicy,clock}):null});
  let inspectionWorker, preparationWorker;
  const entries = owners.map(owner => ({ owner,
    inspection: createOperationalInspectionRunner({ store, owner, capacity, accessPolicy, diskSpaceGuard: guard,
      getWorker: () => inspectionWorker, enabled: true, clock, canLaunch: canAdmit, executionMode: "background" }),
    preparation: createOperationalPreparationRunner({ store, owner, capacity, admission: preparedAdmission, accessPolicy,
      getWorker: () => preparationWorker, enabled: true, clock, canLaunch: canAdmit, executionMode: "background" }) }));
  const inspectionRunner = routeRunners(entries.map(entry => ({ owner: entry.owner, runner: entry.inspection })), "inspect");
  const preparationRunner = routeRunners(entries.map(entry => ({ owner: entry.owner, runner: entry.preparation })), "prepare");
  const inspector = createDurableInspectionDispatcher({ store, runner: inspectionRunner, accessPolicy, enabled: true, clock });
  const diskProvider = createRenderDiskPrivateUploadProvider({ rootDirectory: privateRoot, store, admission, inspector,
    transferOrigin: config.publicOrigin, enabled: true, clock, diagnostics });
  const gcsProvider=gcsTransport?require("./gcs-provider").createGcsPrivateUploadProvider({store,transport:gcsTransport,inspector,accessPolicy,enabled:true,clock}):null;
  const provider=require("./storage-provider-router").createUploadStorageRouter({store,disk:diskProvider,gcs:gcsProvider,accessPolicy,newGcsEnabled:gcsConfig.enabled});
  inspectionWorker = createProcessDiskInspectionWorker({ provider, workingDirectory: inspectionRoot, executor, clock,
    assertExecutionHeld: query => inspectionRunner.assertExecutionHeld(query) });
  preparationWorker = createProcessDiskPreparationWorker({ provider, workingDirectory: snapshotRoot, preparationRoot,
    resultStore, admission: preparedAdmission, executor, clock });
  const baseUpload = createCalendarImportUploadService({ store, provider, enabled: true, clock });
  const basePreparation = createPreparationQueue({ store, dispatcher: preparationRunner, resultStore, accessPolicy, enabled: true, clock });
  const { upload, preparation } = restrictReadyVideoServices(baseUpload, basePreparation, accessPolicy);
  const registry = createTransferAuthorizationRegistry({ store: registryStore, enabled: true, clock });
  const transfer = createRenderDiskTransferService({ store, provider:diskProvider, gcsProvider, registry, accessPolicy, enabled: true, clock, diagnostics,
    limiter: createSingleProcessTransferLimiter({ maxConcurrent: 1, maxPerCompany: 1 }) });
  const factory = createOperationalCalendarImportsRuntimeFactory({ enabled: true, preparation, resultStore, accessPolicy,
    upload, provider, uploadStore: store, transfer, clock, canAdmit, onSubmissionsReady: value => { submissions = value; },
    reconcilePendingUpload: gcsTransport ? createReadyVideoUploadReconciliation({ upload: baseUpload, accessPolicy }) : null,
    cancelPendingUpload: gcsTransport ? (context, input) => { accessPolicy.resolve(context); return baseUpload.cancel(context, input); } : null,
    gcsProfile:gcsTransport?{transport:"gcs-parts-v1",bucket:gcsTransport.bucketName,objectPrefix:gcsTransport.prefix}:null,
    async verifyReadiness() {
      await registry.verify(); await ledger.verify(); await guard.sample();
      if (executor.capabilities.hardTermination !== true) fail("runtime_unproved");
      return true;
    } });
  async function runTick() {
    for (const entry of entries) {
      if (closed || closing) return;
      const context = { authenticated: true, companyId: entry.owner.companyId, userId: entry.owner.userId };
      try {
      if (submissions) await submissions.progress(context.companyId);
      const pending = await store.update(context.companyId, state => ({
        uploadId: Object.values(state.uploads).find(row => row.userId === context.userId && row.state === "verifying")?.uploadId,
        cancelId: Object.values(state.uploads).find(row => row.userId===context.userId && row.storageProvider==="gcs" && row.state==="cancel_pending")?.uploadId,
        job: Object.values(state.preparation?.jobs || {}).find(row => row.userId === context.userId &&
          ["dispatching", "processing", "reconciliation"].includes(row.state))
      }));
      if(pending.cancelId){try{await baseUpload.cancel(context,{uploadId:pending.cancelId});}catch(error){report(error);}}
      if (pending.uploadId) {
        try { await baseUpload.complete(context, { uploadId: pending.uploadId }); }
        catch (error) { if (error.code !== "import_verification_pending") throw error; }
      }
      if (pending.job) await preparation.reconcile(context, { assetId: pending.job.assetId, mediaRevision: pending.job.mediaRevision });
      const unresolved = await store.update(context.companyId, state => ["inspectionExecutions", "preparationExecutions"].some(key =>
        Object.values(state[key]?.records || {}).some(record => record.task.userId === context.userId && record.launchClaimed && !record.capacitySettled)));
      if (!unresolved && canAdmit()) {
        await entry.inspection.resumePending({ limit: 1 });
        await entry.preparation.resumePending({ limit: 1 });
        await preparation.dispatchNext(context);
      }
      if (submissions) await submissions.progress(context.companyId);
      } catch (error) { report(error); }
    }
  }
  function tick() {
    if (!currentTick) currentTick = runTick().finally(() => { currentTick = null; });
    return currentTick;
  }
  function report() {
    try {
      const pending = logger?.error?.({ component: "calendar_ready_video", code: "calendar_ready_video_progress_attention" });
      if (pending && typeof pending.then === "function") pending.catch(() => {});
    } catch { /* Diagnostics never affect the execution fence. */ }
  }
  function schedule() {
    if (!canAdmit()) return;
    timer = setTimeout(() => { timer = null; tick().catch(report).finally(schedule); }, 1000); timer.unref?.();
  }
  return Object.freeze({ factory, tick, profile: NATIVE_READY_VIDEO_PROFILE,
    start() { if (!started && canAdmit()) { started = true; schedule(); } },
    async close() {
      if (closed) return; closing = true; if (timer) clearTimeout(timer);
      if (currentTick) await currentTick.catch(report);
      await Promise.allSettled(entries.flatMap(entry => [entry.inspection.drain(), entry.preparation.drain()]));
      closed = true;
      gcsTransport?.close();
      // Pools are caller-owned; never close the shared social pool here.
    } });
}
module.exports = { createReadyVideoRuntime, restrictReadyVideoServices, createReadyVideoUploadCompletion, createReadyVideoUploadReconciliation, routeRunners, ROOT };
