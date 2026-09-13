"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs").promises;
const os = require("node:os");
const path = require("node:path");
const sharp = require("sharp");
const { createCalendarImportUploadService } = require("../src/social/calendar/imports/upload-service");
const { createMemoryImportUploadStore, createMemoryMultipartProvider } = require("../src/social/calendar/imports/memory-adapters");
const { createPreparationQueue, DEFAULT_LIMITS, validatePreparationState } = require("../src/social/calendar/imports/preparation-queue");
const { createImportMediaPreparer } = require("../src/social/calendar/imports/preparation");
const { createImportAccessPolicy } = require("../src/social/calendar/imports/access-policy");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const clone = value => structuredClone(value);
const selection = { kind: "image", targets: ["feed", "story"], audioMode: "none",
  musicTrackId: null, musicalTargets: [], shareToFeed: false };
const bytes = Buffer.from("SYNTHETIC_CONTROL_BOUNDARY_ONLY_NOT_ACTUAL_JPEG");

function fixture(options = {}) {
  let now = Date.UTC(2026, 8, 12, 12);
  const clock = () => now;
  const context = { authenticated: true, companyId: crypto.randomUUID(), userId: crypto.randomUUID() };
  const worker = { authenticated: true, role: "calendar_media_worker", companyId: context.companyId };
  const store = options.store || createMemoryImportUploadStore();
  const multipart = createMemoryMultipartProvider({ clock, inspectBytes: options.inspectBytes || (() => ({
    signatureVerified: true, decoded: true, detectedMime: "image/jpeg", width: 1080, height: 1350, frames: 1
  })) });
  const uploads = createCalendarImportUploadService({ store, provider: multipart, clock, enabled: true, allowVolatileForTests: true });
  const tasks = [], remote = new Map(), results = new Map();
  const controls = { throwBefore: false, throwAfter: false, lookupFailure: false, lookupAuthoritative: true, inspectHook: null };
  const calls = { dispatch: 0, lookup: 0, inspect: 0, executions: 0 };
  const dispatcher = {
    capabilities: { testOnly: true, idempotentDispatch: true, authoritativeLookup: true, isolatedWorker: true,
      maxRuntimeMs: options.limits?.maxJobRuntimeMs || DEFAULT_LIMITS.maxJobRuntimeMs },
    async dispatch(task) {
      calls.dispatch++; tasks.push(clone(task));
      if (controls.throwBefore) throw new Error("synthetic_network_before_acceptance");
      let execution = remote.get(task.dispatchKey);
      if (!execution) {
        calls.executions++;
        execution = { state: "running", dispatchKey: task.dispatchKey, executionDigest: task.executionDigest, executionId: crypto.randomUUID() };
        remote.set(task.dispatchKey, execution);
      }
      if (controls.throwAfter) throw new Error("synthetic_response_lost_after_acceptance");
      return clone(execution);
    },
    async getByKey(query) {
      calls.lookup++;
      if (controls.lookupFailure) throw new Error("synthetic_lookup_unavailable");
      return clone(remote.get(query.dispatchKey) || { ...query, state: "not_found", authoritative: controls.lookupAuthoritative });
    }
  };
  const resultStore = {
    capabilities: { testOnly: true, actualInspection: true, immutableObjects: true },
    async inspectCommitted(query) {
      calls.inspect++;
      const result = clone(results.get(query.resultRef));
      if (!result) throw new Error("synthetic_output_unavailable");
      return controls.inspectHook ? controls.inspectHook(result, query) : result;
    }
  };
  const queueOptions = { store, dispatcher, resultStore, clock, enabled: true, allowVolatileForTests: true,
    allowedOwners: [context], limits: options.limits, catalog: options.catalog,
    allowSyntheticForTests: options.allowSyntheticForTests === true };
  const queue = createPreparationQueue(queueOptions);
  async function upload(content = bytes, mimeType = "image/jpeg") {
    const start = await uploads.start(context, { idempotencyKey: crypto.randomUUID(), kind: "image", mimeType,
      sizeBytes: content.length, sha256: hash(content) });
    const grant = await uploads.authorizePart(context, { uploadId: start.uploadId, partNumber: 1 });
    await multipart.receivePartForTest(grant.authorizationId, content);
    return uploads.complete(context, { uploadId: start.uploadId });
  }
  function request(uploaded, extra = {}) {
    return { assetId: uploaded.assetId, uploadId: uploaded.uploadId, idempotencyKey: crypto.randomUUID(),
      expectedMediaRevision: 0, selection: clone(selection), ...extra };
  }
  function actualResult(task, prepared) {
    const source = task.source.inspection;
    prepared ||= { sourceInspection: { ...source, decoded: true, frames: 1, colorMode: "sdr" }, commercialReady: true,
      variants: Object.fromEntries(task.plan.deliveries.map(part => [part.target, {
        sha256: hash(task.dispatchKey + ":" + part.target), sourceSha256: task.source.sha256,
        mimeType: part.mimeType, width: part.width, height: part.height, size: 4096,
        durationSeconds: part.durationSeconds, audioMode: part.audioMode,
        ...(part.musicSha256 ? { musicSha256: part.musicSha256 } : {}), hasAudio: part.audioMode === "music"
      }])) };
    const refFor = (variant, salt) => ({ objectKey: hash(task.dispatchKey + ":object:" + salt), objectVersion: crypto.randomUUID(),
      sha256: variant.sha256, sizeBytes: variant.size, companyId: task.companyId, assetId: task.assetId, mediaRevision: task.mediaRevision });
    const result = { complete: true, immutable: true, actualInspection: true, companyId: task.companyId, userId: task.userId,
      assetId: task.assetId, mediaRevision: task.mediaRevision, dispatchKey: task.dispatchKey, executionDigest: task.executionDigest,
      resultRef: crypto.randomUUID(), finishedAt: now, elapsedMs: Math.max(0, now - (task.deadlineAt - task.maxRuntimeMs)),
      prepared, objects: Object.fromEntries(Object.entries(prepared.variants).map(([target, variant]) => [target, refFor(variant, target)])),
      ...(prepared.thumbnail ? { thumbnailObject: refFor(prepared.thumbnail, "thumbnail") } : {}) };
    results.set(result.resultRef, clone(result));
    return result;
  }
  function callback(task, result) { return { jobId: task.jobId, fence: task.fence, leaseToken: task.leaseToken, resultRef: result.resultRef }; }
  return { queue, queueOptions, context, worker, store, uploads, multipart, upload, request, actualResult, callback,
    tasks, remote, results, controls, calls, now: clock, advance: ms => { now += ms; } };
}
async function code(promise, expected) { await assert.rejects(promise, error => error.code === expected); }

test("trusted eligibility revocation blocks a queued dispatch and cannot be forged by context", async () => {
  const f = fixture(), uploaded = await f.upload(); let eligible = true;
  const accessPolicy = createImportAccessPolicy({ allowedOwners: [f.context], isEligible: () => eligible });
  const queue = createPreparationQueue({ ...f.queueOptions, allowedOwners: [], accessPolicy });
  await queue.request(f.context, f.request(uploaded));
  eligible = false;
  await code(queue.dispatchNext({ ...f.context, audience: "owner_pilot", eligible: true }), "import_preparation_not_allowed");
  await code(queue.snapshot(f.context, { assetId: uploaded.assetId, mediaRevision: 1 }), "import_preparation_not_allowed");
  assert.equal(f.calls.dispatch, 0);
  assert.equal(Object.values(f.store.snapshotForTest(f.context.companyId).preparation.jobs)[0].state, "queued");
});

test("revocation during lease persistence is rechecked immediately before remote dispatch", async () => {
  const f = fixture(), uploaded = await f.upload(); let eligible = true, revokeAfterWrite = false;
  const accessPolicy = createImportAccessPolicy({ allowedOwners: [f.context], isEligible: () => eligible });
  const store = { ...f.store, async update(...args) {
    const value = await f.store.update(...args);
    if (revokeAfterWrite) eligible = false;
    return value;
  } };
  const queue = createPreparationQueue({ ...f.queueOptions, store, allowedOwners: [], accessPolicy });
  await queue.request(f.context, f.request(uploaded)); revokeAfterWrite = true;
  const result = await queue.dispatchNext(f.context);
  assert.equal(result.state, "attention"); assert.equal(result.errorCode, "import_preparation_dispatch_not_allowed");
  assert.equal(f.calls.dispatch, 0);
  assert.equal(f.store.snapshotForTest(f.context.companyId).preparation.months["2026-09"].usedComputeMs, 0);
});

test("multi-company and even one customer stay disabled until shared admission is truly wired", async () => {
  const f = fixture(), uploaded = await f.upload();
  for (const audience of ["owner_pilot", "customers"]) {
    const accessPolicy = createImportAccessPolicy({ mode: "multi_company", allowedOwners: [{ ...f.context, audience }] });
    const queue = createPreparationQueue({ ...f.queueOptions, allowedOwners: [], accessPolicy,
      globalAdmission: { capabilities: { atomicGlobalAdmission: true } } });
    await code(queue.request(f.context, f.request(uploaded)), "import_preparation_unavailable");
  }
  assert.throws(() => createPreparationQueue({ ...f.queueOptions, allowedOwners: [], accessPolicy: { executionAvailable: true, resolve: () => f.context } }),
    { code: "import_preparation_configuration_invalid" });
  assert.equal(f.calls.dispatch, 0);
});

test("music disabled after preview request is not dispatched with stale rights", async () => {
  const catalog = new Map(), f = fixture({ catalog }), uploaded = await f.upload();
  const track = { id: "license-control-fixture", sha256: hash("track"), durationSeconds: 20, evidenceId: "license-evidence",
    instagramCommercialUse: true, companyAllowlist: [f.context.companyId], validFrom: f.now() - 1, validUntil: f.now() + 86400000 };
  catalog.set(track.id, track);
  const input = f.request(uploaded, { selection: { kind: "image", targets: ["story"], audioMode: "music", musicTrackId: track.id, musicalTargets: ["story"] } });
  await f.queue.request(f.context, input); track.disabled = true;
  const result = await f.queue.dispatchNext(f.context);
  assert.equal(result.errorCode, "import_preparation_dispatch_not_allowed"); assert.equal(f.calls.dispatch, 0);
});

test("disabled, volatile or unbounded worker integrations fail closed", async () => {
  const f = fixture(), uploaded = await f.upload(), input = f.request(uploaded);
  await code(createPreparationQueue().request(f.context, input), "import_preparation_unavailable");
  await code(createPreparationQueue({ ...f.queueOptions, allowVolatileForTests: false }).request(f.context, input), "import_preparation_unavailable");
  const unsafe = { ...f.queueOptions.dispatcher, capabilities: { ...f.queueOptions.dispatcher.capabilities, isolatedWorker: false } };
  await code(createPreparationQueue({ ...f.queueOptions, dispatcher: unsafe }).request(f.context, input), "import_preparation_unavailable");
  assert.throws(() => createPreparationQueue({ limits: { monthlyPreparations: 61 } }), { code: "import_preparation_configuration_invalid" });
  assert.throws(() => createPreparationQueue({ ...f.queueOptions, allowedOwners: [f.context, f.context] }), { code: "import_preparation_configuration_invalid" });
});

test("completed upload alone stays awaiting selection and never dispatches an invented format", async () => {
  const f = fixture(), uploaded = await f.upload();
  const before = await f.queue.status(f.context, { assetId: uploaded.assetId });
  assert.equal(before.state, "awaiting_selection"); assert.equal(before.ready, false);
  assert.equal((await f.queue.dispatchNext(f.context)).dispatched, false);
  assert.equal(f.calls.dispatch, 0);
  const state = f.store.snapshotForTest(f.context.companyId);
  assert.equal(state.prepareOutbox[`${uploaded.assetId}:1`].state, "pending");
  assert.equal(Object.keys(state.preparation.jobs).length, 0);
});

test("parallel idempotent requests reserve quota once and callbacks do not create schedules", async () => {
  const f = fixture(), uploaded = await f.upload(), input = f.request(uploaded);
  const created = await Promise.all(Array.from({ length: 12 }, () => f.queue.request(f.context, input)));
  assert.equal(new Set(created.map(record => record.jobId)).size, 1);
  assert.equal(f.calls.dispatch, 0);
  const prep = f.store.snapshotForTest(f.context.companyId).preparation;
  assert.equal(prep.months["2026-09"].preparations, 1);
  assert.equal(prep.reservedOutputBytes, 16 * 1024 * 1024);
  assert.equal(prep.months["2026-09"].reservedComputeMs, 180000);
  await code(f.queue.request(f.context, { ...input, selection: { ...selection, targets: ["story"] } }), "import_preparation_idempotency_conflict");
  await code(f.queue.request(f.context, f.request(uploaded)), "import_preparation_revision_conflict");
  const recorded = await f.queue.status(f.context, { assetId: uploaded.assetId });
  assert.equal(recorded.state, "queued"); assert.equal(recorded.ready, false);
  assert.equal(f.store.snapshotForTest(f.context.companyId).uploads[uploaded.uploadId].state, "uploaded");
  assert.equal(JSON.stringify(recorded).includes("objectKey"), false);
  assert.equal(JSON.stringify(recorded).includes("leaseToken"), false);
});

test("owner/user boundaries and body-carried inspector fields are not accepted", async () => {
  const f = fixture(), uploaded = await f.upload(), input = f.request(uploaded);
  await code(f.queue.request({ ...f.context, authenticated: false }, input), "import_preparation_owner_invalid");
  await code(f.queue.request({ ...f.context, userId: crypto.randomUUID() }, input), "import_preparation_not_allowed");
  await code(f.queue.request({ ...f.context, companyId: crypto.randomUUID() }, input), "import_preparation_not_allowed");
  await code(f.queue.request(f.context, { ...input, sourceInspection: { decoded: true } }), "import_preparation_request_invalid");
  await code(f.queue.request(f.context, { ...input, assetId: crypto.randomUUID() }), "import_preparation_not_found");
  await f.queue.request(f.context, input); await f.queue.dispatchNext(f.context);
  const task = f.tasks[0], actual = f.actualResult(task);
  await code(f.queue.completeWorker(f.context, f.callback(task, actual)), "import_preparation_owner_invalid");
  await code(f.queue.completeWorker(f.worker, { ...f.callback(task, actual), prepared: actual.prepared }), "import_preparation_request_invalid");
  assert.equal(f.calls.inspect, 0);
  assert.equal((await f.queue.status(f.context, { assetId: uploaded.assetId })).state, "processing");
});

test("two consumers sharing a durable-contract store dispatch one workflow and cap concurrent jobs", async () => {
  const f = fixture(), uploaded = await f.upload();
  await f.queue.request(f.context, f.request(uploaded));
  const another = createPreparationQueue(f.queueOptions);
  await Promise.all([f.queue.dispatchNext(f.context), another.dispatchNext(f.context)]);
  assert.equal(f.calls.dispatch, 1); assert.equal(f.calls.executions, 1);
  await f.queue.request(f.context, f.request(uploaded, { expectedMediaRevision: 1 }));
  assert.equal((await another.dispatchNext(f.context)).dispatched, false);
  assert.equal(f.calls.executions, 1);
  assert.equal(f.tasks[0].maxRuntimeMs, 180000);
  assert.equal(JSON.stringify(f.tasks[0]).includes("DATABASE_URL"), false);
});

test("lost dispatch response is reconciled by the same key without redispatch or a second quota charge", async () => {
  const f = fixture(), uploaded = await f.upload(), input = f.request(uploaded);
  await f.queue.request(f.context, input);
  f.controls.throwAfter = true;
  const uncertain = await f.queue.dispatchNext(f.context);
  assert.equal(uncertain.state, "reconciliation");
  f.controls.throwAfter = false;
  const reconciled = await f.queue.reconcile(f.context, { assetId: uploaded.assetId, mediaRevision: 1 });
  assert.equal(reconciled.state, "processing");
  assert.equal(f.calls.dispatch, 1); assert.equal(f.calls.executions, 1); assert.equal(f.calls.lookup, 1);
  const retry = await f.queue.request(f.context, input);
  assert.equal(retry.jobId, uncertain.jobId);
  assert.equal(f.store.snapshotForTest(f.context.companyId).preparation.months["2026-09"].preparations, 1);
});

test("authoritative missing execution may retry the same key; prior lease is fenced out", async () => {
  const f = fixture(), uploaded = await f.upload();
  await f.queue.request(f.context, f.request(uploaded));
  f.controls.throwBefore = true;
  await f.queue.dispatchNext(f.context);
  const stale = f.tasks[0];
  await f.queue.reconcile(f.context, { assetId: uploaded.assetId, mediaRevision: 1 });
  f.controls.throwBefore = false;
  await f.queue.dispatchNext(f.context);
  const active = f.tasks[1];
  assert.equal(stale.dispatchKey, active.dispatchKey);
  assert.ok(active.fence > stale.fence);
  await code(f.queue.completeWorker(f.worker, f.callback(stale, f.actualResult(stale))), "import_preparation_stale_worker");
  assert.equal(f.calls.inspect, 0);
  const completed = await f.queue.completeWorker(f.worker, f.callback(active, f.actualResult(active)));
  assert.equal(completed.ready, true); assert.equal(f.calls.executions, 1);
  assert.equal(f.store.snapshotForTest(f.context.companyId).preparation.months["2026-09"].preparations, 1);
});

test("unconfirmed lookup and elapsed worker do not authorize reruns or late writes", async () => {
  const f = fixture(), uploaded = await f.upload();
  await f.queue.request(f.context, f.request(uploaded));
  f.controls.throwBefore = true;
  await f.queue.dispatchNext(f.context);
  f.controls.lookupAuthoritative = false;
  assert.equal((await f.queue.reconcile(f.context, { assetId: uploaded.assetId, mediaRevision: 1 })).state, "reconciliation");
  assert.equal((await f.queue.dispatchNext(f.context)).dispatched, false);
  f.controls.lookupAuthoritative = true;
  await f.queue.reconcile(f.context, { assetId: uploaded.assetId, mediaRevision: 1 });
  f.controls.throwBefore = false;
  await f.queue.dispatchNext(f.context);
  const task = f.tasks[1];
  f.advance(180001);
  const stopped = await f.queue.reconcile(f.context, { assetId: uploaded.assetId, mediaRevision: 1 });
  assert.equal(stopped.state, "attention"); assert.equal(stopped.errorCode, "import_preparation_worker_deadline_exceeded");
  await code(f.queue.completeWorker(f.worker, f.callback(task, f.actualResult(task))), "import_preparation_stale_worker");
  assert.equal((await f.queue.dispatchNext(f.context)).dispatched, false);
  const prep = f.store.snapshotForTest(f.context.companyId).preparation;
  assert.equal(prep.months["2026-09"].reservedComputeMs, 0);
  assert.equal(prep.months["2026-09"].usedComputeMs, 180000);
  assert.equal(prep.reservedOutputBytes, 16 * 1024 * 1024);
});

test("actual immutable result is required; mismatch cannot be made ready by callback fields", async () => {
  const mutations = [
    result => { result.actualInspection = false; },
    result => { result.immutable = false; },
    result => { result.companyId = crypto.randomUUID(); },
    result => { result.mediaRevision++; },
    result => { result.prepared.sourceInspection.sha256 = "0".repeat(64); },
    result => { result.prepared.variants.feed.width = 1; },
    result => { result.objects.feed.objectVersion = "https://not-a-version"; },
    result => { result.prepared.variants.feed.hasAudio = true; }
  ];
  for (const mutate of mutations) {
    const f = fixture(), uploaded = await f.upload();
    await f.queue.request(f.context, f.request(uploaded)); await f.queue.dispatchNext(f.context);
    const task = f.tasks[0], actual = f.actualResult(task); mutate(actual); f.results.set(actual.resultRef, actual);
    await assert.rejects(f.queue.completeWorker(f.worker, f.callback(task, actual)));
    const status = await f.queue.status(f.context, { assetId: uploaded.assetId });
    assert.equal(status.ready, false); assert.equal(status.state, "attention");
    await code(f.queue.snapshot(f.context, { assetId: uploaded.assetId, mediaRevision: 1 }), "import_preparation_not_ready");
  }
});

test("ready outputs, digest and quota survive consumer restart and repeated completion", async () => {
  const f = fixture(), uploaded = await f.upload(), input = f.request(uploaded);
  await f.queue.request(f.context, input); await f.queue.dispatchNext(f.context); f.advance(125);
  const task = f.tasks[0], actual = f.actualResult(task), callback = f.callback(task, actual);
  const ready = await f.queue.completeWorker(f.worker, callback);
  assert.equal(ready.ready, true); assert.match(ready.previewDigest, /^[a-f0-9]{64}$/);
  const restart = createPreparationQueue(f.queueOptions);
  const repeated = await restart.completeWorker(f.worker, callback);
  assert.equal(repeated.previewDigest, ready.previewDigest); assert.equal(f.calls.inspect, 1);
  const snapshot = await restart.snapshot(f.context, { assetId: uploaded.assetId, mediaRevision: 1 });
  assert.equal(snapshot.state, "ready"); assert.equal(snapshot.result.objects.feed.objectVersion, actual.objects.feed.objectVersion);
  assert.equal(JSON.stringify(ready).includes("objectVersion"), false);
  const prep = f.store.snapshotForTest(f.context.companyId).preparation;
  assert.equal(prep.reservedOutputBytes, 0); assert.equal(prep.committedOutputBytes, 8192);
  assert.equal(prep.months["2026-09"].usedComputeMs, 125); assert.equal(prep.months["2026-09"].reservedComputeMs, 0);
  assert.equal((await restart.request(f.context, input)).previewDigest, ready.previewDigest);
});

test("new media revision does not overwrite an older immutable result or mark latest revision ready early", async () => {
  const f = fixture(), uploaded = await f.upload();
  await f.queue.request(f.context, f.request(uploaded)); await f.queue.dispatchNext(f.context);
  const firstTask = f.tasks[0];
  await f.queue.request(f.context, f.request(uploaded, { expectedMediaRevision: 1,
    selection: { ...selection, targets: ["story"] } }));
  await f.queue.completeWorker(f.worker, f.callback(firstTask, f.actualResult(firstTask)));
  const latest = await f.queue.status(f.context, { assetId: uploaded.assetId });
  assert.equal(latest.mediaRevision, 2); assert.equal(latest.state, "queued"); assert.equal(latest.ready, false);
  const first = await f.queue.snapshot(f.context, { assetId: uploaded.assetId, mediaRevision: 1 });
  await f.queue.dispatchNext(f.context);
  const secondTask = f.tasks[1];
  await f.queue.completeWorker(f.worker, f.callback(secondTask, f.actualResult(secondTask)));
  assert.deepEqual((await f.queue.snapshot(f.context, { assetId: uploaded.assetId, mediaRevision: 1 })).result, first.result);
  assert.notEqual((await f.queue.status(f.context, { assetId: uploaded.assetId })).previewDigest, first.result.previewDigest);
});

test("monthly count, pending-job and output reservations prevent unbounded processing cost", async () => {
  const f = fixture({ limits: { monthlyPreparations: 1 } }), uploaded = await f.upload();
  await f.queue.request(f.context, f.request(uploaded));
  await code(f.queue.request(f.context, f.request(uploaded, { expectedMediaRevision: 1 })), "import_preparation_quota_exceeded");
  const storage = fixture({ limits: { companyOutputBytes: 15 * 1024 * 1024 } }), otherUpload = await storage.upload();
  await code(storage.queue.request(storage.context, storage.request(otherUpload)), "import_preparation_quota_exceeded");
  const pending = fixture({ limits: { maxPendingJobs: 1 } }), pendingUpload = await pending.upload();
  await pending.queue.request(pending.context, pending.request(pendingUpload));
  await code(pending.queue.request(pending.context, pending.request(pendingUpload, { expectedMediaRevision: 1 })), "import_preparation_quota_exceeded");
});

test("state validation refuses references belonging to another upload owner", async () => {
  const f = fixture(), uploaded = await f.upload();
  await f.queue.request(f.context, f.request(uploaded));
  const state = f.store.snapshotForTest(f.context.companyId);
  const job = Object.values(state.preparation.jobs)[0];
  job.userId = crypto.randomUUID();
  assert.throws(() => validatePreparationState(state.preparation, f.context.companyId, state.uploads), { code: "import_preparation_state_invalid" });
});

test("provider messages cannot leak through familiar codes and a lowered runtime budget persists across restart", async () => {
  const f = fixture({ limits: { maxJobRuntimeMs: 120000 } }), uploaded = await f.upload();
  await f.queue.request(f.context, f.request(uploaded));
  const restart = createPreparationQueue({ ...f.queueOptions, limits: undefined });
  await restart.dispatchNext(f.context);
  const task = f.tasks[0]; assert.equal(task.maxRuntimeMs, 120000);
  const actual = f.actualResult(task);
  f.controls.inspectHook = () => { const error = new Error("SYNTHETIC_PRIVATE_SIGNED_URL_NEVER_RETURN");
    error.code = "import_preparation_provider_unavailable"; throw error; };
  await assert.rejects(restart.completeWorker(f.worker, f.callback(task, actual)), error =>
    error.message === "import_preparation_provider_unavailable" && !error.stack.includes("SYNTHETIC_PRIVATE"));
  f.controls.inspectHook = null;
  await restart.completeWorker(f.worker, f.callback(task, actual));
  assert.equal(f.store.snapshotForTest(f.context.companyId).preparation.months["2026-09"].reservedComputeMs, 0);
});

test("actual local photo preparation feeds the durable result and preview contract without fabricated variant metadata", async t => {
  const source = await sharp({ create: { width: 240, height: 120, channels: 3, background: "#306ea0" } }).png().toBuffer();
  const f = fixture({ inspectBytes: async data => { const meta = await sharp(data).metadata();
    return { signatureVerified: true, decoded: true, detectedMime: "image/png", width: meta.width, height: meta.height, frames: 1 }; } });
  const uploaded = await f.upload(source, "image/png");
  await f.queue.request(f.context, f.request(uploaded)); await f.queue.dispatchNext(f.context);
  const task = f.tasks[0];
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ia4tube-preparation-queue-"));
  t.after(async () => { const absolute = await fs.realpath(root); assert.equal(absolute, path.resolve(root));
    assert.ok(path.basename(absolute).startsWith("ia4tube-preparation-queue-")); await fs.rm(absolute, { recursive: true, force: true }); });
  const inputRoot = path.join(root, "input"), outputRoot = path.join(root, "output");
  await fs.mkdir(path.join(inputRoot, f.context.companyId), { recursive: true }); await fs.mkdir(outputRoot);
  await fs.writeFile(path.join(inputRoot, f.context.companyId, "photo.png"), source);
  const preparer = createImportMediaPreparer({ inputRoot, outputRoot });
  const prepared = await preparer.prepare({ ...task.selection, companyId: task.companyId, assetId: task.assetId, sourceName: "photo.png" });
  const actual = f.actualResult(task, prepared);
  // Result inspector stand-in re-reads actual derivative bytes, not a client MIME.
  f.controls.inspectHook = async result => {
    for (const [target, variant] of Object.entries(result.prepared.variants)) {
      const data = await fs.readFile(path.join(outputRoot, task.companyId, task.assetId, variant.fileName));
      const meta = await sharp(data).metadata();
      assert.equal(hash(data), variant.sha256); assert.equal(data.length, variant.size);
      assert.equal(meta.width, variant.width); assert.equal(meta.height, variant.height);
      assert.equal(meta.format, "jpeg"); assert.equal(result.objects[target].sha256, hash(data));
    }
    return result;
  };
  const result = await f.queue.completeWorker(f.worker, f.callback(task, actual));
  assert.equal(result.ready, true); assert.match(result.previewDigest, /^[a-f0-9]{64}$/);
  assert.equal(result.variants.feed.sourceSha256, hash(source));
  assert.equal((await f.queue.snapshot(f.context, { assetId: uploaded.assetId, mediaRevision: 1 })).result.sourceInspection.decoded, true);
});
