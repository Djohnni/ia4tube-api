"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path"), { Readable } = require("node:stream");
const { createGlobalMediaCapacity, freshGlobalCapacityState, validateGlobalCapacityState } = require("../src/social/calendar/imports/global-capacity");
const { createRenderDiskAdmission, renderDiskCapacityIdentity, METADATA_MARGIN } = require("../src/social/calendar/imports/render-disk-admission");
const { createRenderDiskPrivateUploadProvider } = require("../src/social/calendar/imports/render-disk-provider");
const { createMemoryImportUploadStore } = require("../src/social/calendar/imports/memory-adapters");
const { createCalendarImportUploadService } = require("../src/social/calendar/imports/upload-service");
const bytes = Buffer.from("SYNTHETIC_DISK_GLOBAL_INTEGRATION_BYTES"), sourceBytes = bytes.length;
const hash = (value, type = "sha256", encoding = "hex") => crypto.createHash(type).update(value).digest(encoding);
const coord = Object.freeze({ authenticated: true, role: "calendar_media_capacity_coordinator" });
const owner = () => ({ authenticated: true, companyId: crypto.randomUUID(), userId: crypto.randomUUID() });
function globalStore() {
  let state = freshGlobalCapacityState(), tail = Promise.resolve();
  return { capabilities: { persistence: "volatile", atomicGlobalUpdates: true, testOnly: true },
    update(operation) { const result = tail.then(() => {
      const next = structuredClone(state), value = operation(next);
      if (value && typeof value.then === "function") throw new Error("async-mutation-refused");
      validateGlobalCapacityState(next); state = next; return structuredClone(value);
    }); tail = result.catch(() => {}); return result; }, snapshot() { return structuredClone(state); } };
}
async function fixture(t, { limits = {}, wrapAdmission, inspect = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iA4tube-disk-global-")); await fs.chmod(root, 0o700);
  t.after(async () => {
    const target = path.resolve(root); assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith("iA4tube-disk-global-")); await fs.rm(target, { recursive: true, force: true });
  });
  const store = createMemoryImportUploadStore(), ledger = globalStore();
  const capacity = createGlobalMediaCapacity({ store: ledger, enabled: true, allowVolatileForTests: true, limits });
  const options = { capacity, store, rootDirectory: root, coordinatorContext: coord, enabled: true, allowVolatileForTests: true };
  const realAdmission = createRenderDiskAdmission(options), admission = wrapAdmission ? wrapAdmission(realAdmission) : realAdmission;
  const tickets = new Map();
  const inspector = { capabilities: { isolated: true, bounded: true, remoteObjectInspection: true },
    async startInspection(request) {
      const response = { ticketId: request.ticketId, state: inspect ? "ready" : "pending", result: {
        complete: true, decoded: true, signatureVerified: true, detectedMime: "image/jpeg", width: 10, height: 10,
        frames: 1, sizeBytes: sourceBytes, sha256: hash(bytes) } };
      tickets.set(request.ticketId, response); return response;
    }, async getInspection({ ticketId }) { return tickets.get(ticketId) || { ticketId, state: "pending" }; } };
  const provider = createRenderDiskPrivateUploadProvider({ rootDirectory: root, store, admission, inspector,
    transferOrigin: "https://ia4tube-api.onrender.com", enabled: true, allowVolatileForTests: true });
  const upload = createCalendarImportUploadService({ store, provider, enabled: true, allowVolatileForTests: true });
  const input = () => ({ idempotencyKey: crypto.randomUUID(), kind: "image", mimeType: "image/jpeg", sizeBytes: sourceBytes, sha256: hash(bytes) });
  function row(context, item) { return store.snapshotForTest(context.companyId).uploads[item.uploadId]; }
  function binding(context, item) { const r = row(context, item); return { reservationKey: `disk:${r.assetId}`,
    companyId: r.companyId, userId: r.userId, assetId: r.assetId, sourceSha256: r.sha256, sourceBytes: r.sizeBytes,
    peakBytes: r.sizeBytes * 2 + METADATA_MARGIN }; }
  async function transfer(context, item) {
    const grant = await upload.authorizePart(context, { uploadId: item.uploadId, partNumber: 1,
      sha256: hash(bytes), md5Base64: hash(bytes, "md5", "base64") }); const r = row(context, item);
    await provider.acceptPart({ context, objectKey: r.objectKey, uploadId: r.disk.uploadId, partNumber: 1,
      authorizationId: grant.authorizationId, contentLength: sourceBytes, stream: Readable.from([bytes]) });
  }
  return { root, store, ledger, capacity, options, admission: realAdmission, provider, upload, input, row, binding, transfer };
}

test("real storage admission is disabled absent durable setup or dedicated coordinator", async t => {
  const f = await fixture(t), ctx = owner(), item = await f.upload.start(ctx, f.input()), binding = f.binding(ctx, item);
  for (const override of [{ enabled: false }, { allowVolatileForTests: false }, { coordinatorContext: ctx }, { capacity: {} }]) {
    const wrapper = createRenderDiskAdmission({ ...f.options, ...override });
    assert.equal(wrapper.capabilities.atomicGlobalReservations, false);
    await assert.rejects(wrapper.reserve(binding), { code: "disk_admission_unavailable" });
  }
});

test("twenty concurrent companies cannot overreserve disk, and denied owners create no file directories", async t => {
  const peak = sourceBytes * 2 + METADATA_MARGIN;
  const f = await fixture(t, { limits: { globalStorageBytes: peak * 2, companyStorageBytes: peak } });
  const owners = Array.from({ length: 20 }, owner);
  const results = await Promise.allSettled(owners.map(ctx => f.upload.start(ctx, f.input())));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 2);
  assert.equal((await fs.readdir(f.root)).length, 2);
  assert.equal(Object.keys(f.ledger.snapshot().jobs).length, 2);
  const summary = await f.capacity.summary({ context: coord });
  assert.equal(summary.storageBytes, peak * 2); assert.equal(summary.monthlyJobs, 0);
  assert.equal(summary.queuedJobs, 0); assert.equal(summary.runtimeMs, 0);
  assert.equal(await f.capacity.acquireNext({ context: coord }), null);
});

test("repeated exact storage reserve is idempotent and binds tenant, user, source hash and namespace", async t => {
  const f = await fixture(t), ctx = owner(), item = await f.upload.start(ctx, f.input()), binding = f.binding(ctx, item);
  await Promise.all(Array.from({ length: 20 }, () => f.admission.reserve(binding)));
  const identity = renderDiskCapacityIdentity(binding);
  assert.notEqual(identity.jobId, binding.assetId); assert.match(identity.jobId, /^[a-f0-9-]{36}$/);
  assert.equal(Object.keys(f.ledger.snapshot().jobs).length, 1);
  for (const modified of [{ companyId: crypto.randomUUID() }, { userId: crypto.randomUUID() }, { sourceSha256: "f".repeat(64) },
    { peakBytes: binding.peakBytes + 1 }, { context: coord }]) {
    await assert.rejects(f.admission.reserve({ ...binding, ...modified }), /disk_reservation_/);
  }
  assert.equal((await f.capacity.summary({ context: coord })).storageBytes, binding.peakBytes);
});

test("successful byte upload seals storage read-only and never consumes a task or a runtime slot", async t => {
  const f = await fixture(t), ctx = owner(), item = await f.upload.start(ctx, f.input()); await f.transfer(ctx, item);
  const result = await f.upload.complete(ctx, { uploadId: item.uploadId }); assert.equal(result.state, "uploaded");
  const binding = f.binding(ctx, item), job = await f.capacity.inspect({ context: coord, jobId: renderDiskCapacityIdentity(binding).jobId });
  assert.equal(job.purpose, "storage"); assert.equal(job.state, "storage_sealed"); assert.equal(job.runtimeBudgetMs, 0);
  await assert.rejects(f.admission.assertHeld(binding), { code: "disk_global_capacity_refused" });
  assert.equal((await f.admission.assertHeld(binding, { intent: "read" })).held, true);
  const r = f.row(ctx, item), collected = [];
  await f.provider.streamSealedObject({ context: ctx, objectKey: r.objectKey, objectVersion: r.disk.objectVersion,
    consume: chunk => { collected.push(Buffer.from(chunk)); } });
  assert.deepEqual(Buffer.concat(collected), bytes);
  const summary = await f.capacity.summary({ context: coord });
  assert.equal(summary.queuedJobs, 0); assert.equal(summary.activeJobs, 0); assert.equal(summary.monthlyJobs, 0); assert.equal(summary.runtimeMs, 0);
  assert.equal(summary.storageBytes, binding.peakBytes); assert.equal(await f.capacity.acquireNext({ context: coord }), null);
});

test("actual cancellation retains charged 64KiB identity margin and frees only confirmed source bytes", async t => {
  const f = await fixture(t), ctx = owner(), item = await f.upload.start(ctx, f.input()); await f.transfer(ctx, item);
  const binding = f.binding(ctx, item), cancelled = await f.upload.cancel(ctx, { uploadId: item.uploadId });
  assert.equal(cancelled.state, "cancelled");
  assert.deepEqual(await fs.readdir(path.join(f.root, f.row(ctx, item).objectKey)), ["identity.json"]);
  const job = await f.capacity.inspect({ context: coord, jobId: renderDiskCapacityIdentity(binding).jobId });
  assert.equal(job.heldBytes, METADATA_MARGIN); assert.equal(job.storageHeld, true); assert.equal(job.state, "storage_cancel_requested");
  assert.equal((await f.capacity.summary({ context: coord })).storageBytes, METADATA_MARGIN);
});

test("cleanup cannot be fabricated by calling wrapper before actual byte removal", async t => {
  const f = await fixture(t), ctx = owner(), item = await f.upload.start(ctx, f.input()); await f.transfer(ctx, item);
  const binding = f.binding(ctx, item);
  await assert.rejects(f.admission.releaseAfterAbort(binding), { code: "disk_cleanup_evidence_invalid" });
  const job = await f.capacity.inspect({ context: coord, jobId: renderDiskCapacityIdentity(binding).jobId });
  assert.equal(job.state, "storage_reserved"); assert.equal(job.heldBytes, binding.peakBytes);
});

test("forged cleanup state plus operation marker still fails when a source part remains", async t => {
  const f = await fixture(t), ctx = owner(), item = await f.upload.start(ctx, f.input()); await f.transfer(ctx, item);
  const binding = f.binding(ctx, item), r = f.row(ctx, item);
  await f.store.update(ctx.companyId, state => { const row = state.uploads[item.uploadId]; row.state = "cancel_pending";
    row.disk.phase = "aborting"; row.disk.cleanupVerified = true; });
  await fs.writeFile(path.join(f.root, r.objectKey, "operation.lock"), "", { flag: "wx" });
  await assert.rejects(f.admission.releaseAfterAbort(binding), { code: "disk_cleanup_evidence_invalid" });
  assert.equal((await f.capacity.summary({ context: coord })).storageBytes, binding.peakBytes);
});

test("lost storage seal response is retried against existing read-only source without enqueuing a job", async t => {
  let first = true;
  const f = await fixture(t, { wrapAdmission: base => ({ ...base, async sealStorage(binding) {
    const result = await base.sealStorage(binding);
    if (first) { first = false; throw new Error("synthetic-lost-seal-response"); } return result;
  } }) });
  const ctx = owner(), item = await f.upload.start(ctx, f.input()); await f.transfer(ctx, item);
  await assert.rejects(f.upload.complete(ctx, { uploadId: item.uploadId }), { code: "import_verification_pending" });
  assert.equal(f.row(ctx, item).disk.phase, "sealed");
  const result = await f.upload.complete(ctx, { uploadId: item.uploadId }); assert.equal(result.state, "uploaded");
  assert.equal(Object.keys(f.ledger.snapshot().jobs).length, 1);
  assert.equal((await f.capacity.summary({ context: coord })).monthlyJobs, 0);
});

test("lost abort settlement response resumes cleanup without double reduction or unsafe write reopening", async t => {
  let first = true;
  const f = await fixture(t, { wrapAdmission: base => ({ ...base, async releaseAfterAbort(binding) {
    const result = await base.releaseAfterAbort(binding);
    if (first) { first = false; throw new Error("synthetic-lost-cleanup-response"); } return result;
  } }) });
  const ctx = owner(), item = await f.upload.start(ctx, f.input()); await f.transfer(ctx, item);
  await assert.rejects(f.upload.cancel(ctx, { uploadId: item.uploadId }), { code: "import_cancellation_pending" });
  assert.equal((await f.capacity.summary({ context: coord })).storageBytes, METADATA_MARGIN);
  const result = await f.upload.cancel(ctx, { uploadId: item.uploadId }); assert.equal(result.state, "cancelled");
  assert.equal((await f.capacity.summary({ context: coord })).storageBytes, METADATA_MARGIN);
  await assert.rejects(f.admission.assertHeld(f.binding(ctx, item)), { code: "disk_global_capacity_refused" });
});

test("storage operation cannot silently fall back to the compute reservation API", async t => {
  const f = await fixture(t), capacity = { ...f.capacity, reserveStorage: undefined };
  const wrapper = createRenderDiskAdmission({ ...f.options, capacity });
  assert.equal(wrapper.capabilities.atomicGlobalReservations, false);
  const ctx = owner(), item = await f.upload.start(ctx, f.input());
  await assert.rejects(wrapper.reserve(f.binding(ctx, item)), { code: "disk_admission_unavailable" });
  assert.equal((await f.capacity.summary({ context: coord })).monthlyJobs, 0);
});
