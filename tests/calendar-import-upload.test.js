"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createCalendarImportUploadService, DEFAULT_LIMITS } = require("../src/social/calendar/imports/upload-service");
const { createMemoryImportUploadStore, createMemoryMultipartProvider } = require("../src/social/calendar/imports/memory-adapters");
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const identity = () => ({ authenticated: true, companyId: crypto.randomUUID(), userId: crypto.randomUUID() });
const image = Buffer.from("SYNTHETIC_TEST_ONLY_JPEG_fixture");

// Deliberate provider-contract fixture, NOT proof of a real decoder or production
// storage. Actual digest/size are still computed from remote-adapter bytes.
function syntheticInspection() {
  return { signatureVerified: true, decoded: true, detectedMime: "image/jpeg", width: 1080, height: 1350, frames: 1 };
}
function fixture(options = {}) {
  let time = 1789218000000;
  const clock = () => time;
  const store = options.store || createMemoryImportUploadStore();
  const baseProvider = createMemoryMultipartProvider({ inspectBytes: options.inspectBytes || syntheticInspection, clock });
  const provider = options.wrapProvider ? options.wrapProvider(baseProvider) : baseProvider;
  const service = createCalendarImportUploadService({ store, provider, clock, enabled: true, allowVolatileForTests: true, limits: options.limits });
  const context = identity();
  function request(bytes = image, extra = {}) {
    return { idempotencyKey: crypto.randomUUID(), kind: "image", mimeType: "image/jpeg", sizeBytes: bytes.length, sha256: digest(bytes), ...extra };
  }
  async function transfer(upload, bytes = image, user = context) {
    for (let partNumber = 1; partNumber <= upload.partCount; partNumber++) {
      const grant = await service.authorizePart(user, { uploadId: upload.uploadId, partNumber });
      await baseProvider.receivePartForTest(grant.authorizationId, bytes.subarray((partNumber - 1) * upload.chunkBytes, partNumber * upload.chunkBytes));
    }
  }
  return { service, store, provider, baseProvider, context, request, transfer, advance: ms => { time += ms; } };
}
async function code(promise, expected) {
  await assert.rejects(promise, error => error.code === expected && error.message === expected);
}

test("disabled by default and volatile/provider inspector adapters fail closed", async () => {
  const f = fixture();
  await code(createCalendarImportUploadService().start(f.context, f.request()), "import_upload_unavailable");
  await code(createCalendarImportUploadService({ store: f.store, provider: f.provider, enabled: true }).start(f.context, f.request()), "import_upload_unavailable");
  const noInspector = createMemoryMultipartProvider();
  await code(createCalendarImportUploadService({ store: f.store, provider: noInspector, enabled: true, allowVolatileForTests: true }).start(f.context, f.request()), "import_upload_unavailable");
  assert.throws(() => createCalendarImportUploadService({ limits: { videoBytes: DEFAULT_LIMITS.videoBytes + 1 } }), /import_configuration_invalid/);
});

test("verified owner context required; body cannot select another company, key or URL", async () => {
  const f = fixture();
  await code(f.service.start({ ...f.context, authenticated: false }, f.request()), "import_owner_invalid");
  await code(f.service.start({ ...f.context, userId: [f.context.userId] }, f.request()), "import_owner_invalid");
  for (const field of ["companyId", "userId", "objectKey", "filename", "url", "bytes", "path"]) {
    await code(f.service.start(f.context, f.request(image, { [field]: "not-accepted" })), "import_request_invalid");
  }
  assert.equal(f.provider.statsForTest().begin, 0);
});

test("only the bounded JPEG/PNG/WebP or MP4/MOV contract is accepted", async () => {
  const f = fixture();
  for (const extra of [
    { sizeBytes: 0 }, { sizeBytes: 32 * 1024 * 1024 + 1 }, { sizeBytes: 1.5 },
    { mimeType: "image/gif" }, { mimeType: "image/heic" }, { kind: "constructor" },
    { sha256: "not-a-digest" }, { sha256: [digest(image)] }, { idempotencyKey: "a" },
    { kind: "video", mimeType: "video/mp4", sizeBytes: 100 * 1024 * 1024 + 1 }
  ]) await code(f.service.start(f.context, f.request(image, extra)), "import_request_invalid");
  const png = await f.service.start(f.context, f.request(image, { mimeType: "image/png" }));
  assert.equal(png.state, "uploading");
  assert.equal(png.ready, false);
});

test("parallel duplicate starts reserve once and conflicting content is rejected", async () => {
  const f = fixture(), input = f.request();
  const starts = await Promise.all(Array.from({ length: 20 }, () => f.service.start(f.context, input)));
  assert.equal(new Set(starts.map(row => row.uploadId)).size, 1);
  assert.equal(f.provider.statsForTest().begin, 1);
  const state = f.store.snapshotForTest(f.context.companyId);
  assert.equal(state.reservedBytes, image.length);
  assert.equal(Object.keys(state.uploads).length, 1);
  assert.match(Object.values(state.uploads)[0].objectKey, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(starts).includes("objectKey"), false);
  await code(f.service.start(f.context, { ...input, sha256: "a".repeat(64) }), "import_idempotency_conflict");
});

test("idempotency and reads are separated both by company and by user", async () => {
  const f = fixture(), input = f.request(), otherCompany = identity();
  const otherUser = { ...f.context, userId: crypto.randomUUID() };
  const first = await f.service.start(f.context, input);
  const second = await f.service.start(otherCompany, input);
  const third = await f.service.start(otherUser, input);
  assert.equal(new Set([first.uploadId, second.uploadId, third.uploadId]).size, 3);
  for (const context of [otherCompany, otherUser]) {
    for (const operation of ["status", "resume", "complete", "cancel", "authorizePart"]) {
      await code(f.service[operation](context, { uploadId: first.uploadId, ...(operation === "authorizePart" ? { partNumber: 1 } : {}) }), "import_not_found");
    }
  }
});

test("company byte and active-upload quotas remain atomic under concurrency", async () => {
  const f = fixture({ limits: { companyReservedBytes: image.length, companyActiveUploads: 1 } });
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => f.service.start(f.context, f.request())));
  assert.equal(results.filter(row => row.status === "fulfilled").length, 1);
  assert.ok(results.filter(row => row.status === "rejected").every(row => row.reason.code === "import_quota_exceeded"));
  assert.equal(f.store.snapshotForTest(f.context.companyId).reservedBytes, image.length);
});

test("cancelled idempotency history is bounded and cannot grow without limit", async () => {
  const f = fixture({ limits: { companyUploadRecords: 1 } });
  const input = f.request(), upload = await f.service.start(f.context, input);
  await f.service.cancel(f.context, { uploadId: upload.uploadId });
  await code(f.service.start(f.context, f.request()), "import_quota_exceeded");
  assert.equal((await f.service.start(f.context, input)).uploadId, upload.uploadId);
});

test("resume reports actual remote 1-based parts and only missing bytes need resending", async () => {
  const f = fixture();
  const bytes = Buffer.alloc(DEFAULT_LIMITS.chunkBytes + 128, 7);
  const upload = await f.service.start(f.context, f.request(bytes));
  const firstGrant = await f.service.authorizePart(f.context, { uploadId: upload.uploadId, partNumber: 1 });
  assert.equal(firstGrant.sizeBytes, DEFAULT_LIMITS.chunkBytes);
  await f.provider.receivePartForTest(firstGrant.authorizationId, bytes.subarray(0, DEFAULT_LIMITS.chunkBytes));
  const resumed = await f.service.resume(f.context, { uploadId: upload.uploadId });
  assert.deepEqual(resumed.completedParts, [{ partNumber: 1, sizeBytes: DEFAULT_LIMITS.chunkBytes, sha256: digest(bytes.subarray(0, DEFAULT_LIMITS.chunkBytes)) }]);
  await code(f.service.complete(f.context, { uploadId: upload.uploadId }), "import_upload_incomplete");
  assert.equal((await f.service.status(f.context, { uploadId: upload.uploadId })).state, "uploading");
  const finalGrant = await f.service.authorizePart(f.context, { uploadId: upload.uploadId, partNumber: 2 });
  assert.equal(finalGrant.sizeBytes, 128);
  await f.provider.receivePartForTest(finalGrant.authorizationId, bytes.subarray(DEFAULT_LIMITS.chunkBytes));
  assert.equal((await f.service.complete(f.context, { uploadId: upload.uploadId })).state, "uploaded");
});

test("grants are size-bound, expiring and sealed after completion", async () => {
  const f = fixture(), upload = await f.service.start(f.context, f.request());
  for (const partNumber of [0, 2, 1.5]) await code(f.service.authorizePart(f.context, { uploadId: upload.uploadId, partNumber }), "import_part_invalid");
  const grant = await f.service.authorizePart(f.context, { uploadId: upload.uploadId, partNumber: 1 });
  await assert.rejects(f.provider.receivePartForTest(grant.authorizationId, Buffer.alloc(image.length + 1)));
  f.advance(DEFAULT_LIMITS.authorizationLifetimeMs);
  await assert.rejects(f.provider.receivePartForTest(grant.authorizationId, image));
  const fresh = await f.service.authorizePart(f.context, { uploadId: upload.uploadId, partNumber: 1 });
  await f.provider.receivePartForTest(fresh.authorizationId, image);
  await f.service.complete(f.context, { uploadId: upload.uploadId });
  await assert.rejects(f.provider.receivePartForTest(fresh.authorizationId, image));
  await code(f.service.authorizePart(f.context, { uploadId: upload.uploadId, partNumber: 1 }), "import_upload_not_writable");
});

test("completion is idempotent and creates one prepare outbox entry, no schedule or order", async () => {
  const f = fixture(), upload = await f.service.start(f.context, f.request());
  await f.transfer(upload);
  await Promise.all(Array.from({ length: 20 }, () => f.service.complete(f.context, { uploadId: upload.uploadId })));
  const complete = await f.service.complete(f.context, { uploadId: upload.uploadId });
  assert.equal(complete.state, "uploaded"); assert.equal(complete.ready, false); assert.equal(complete.preparation, "pending");
  const state = f.store.snapshotForTest(f.context.companyId);
  assert.equal(Object.keys(state.prepareOutbox).length, 1);
  assert.equal(f.provider.statsForTest().finalize, 1);
  for (const key of ["jobs", "orders", "credits", "calendarItems"]) assert.equal(state[key], undefined);
  assert.equal(JSON.stringify(complete).includes("providerUploadId"), false);
  assert.deepEqual(complete.verification, { sha256: digest(image), sizeBytes: image.length, mimeType: "image/jpeg" });
});

test("actual checksum rejects client metadata even if all part sizes are correct", async () => {
  const f = fixture(), upload = await f.service.start(f.context, f.request(image, { sha256: "a".repeat(64) }));
  await f.transfer(upload);
  await code(f.service.complete(f.context, { uploadId: upload.uploadId }), "import_media_verification_failed");
  const status = await f.service.status(f.context, { uploadId: upload.uploadId });
  assert.equal(status.state, "rejected"); assert.equal(status.ready, false);
  const state = f.store.snapshotForTest(f.context.companyId);
  assert.equal(Object.keys(state.prepareOutbox).length, 0);
  assert.equal(state.reservedBytes, image.length);
});

test("missing decode/signature, mismatched MIME, animated and oversized images are rejected", async () => {
  for (const extra of [
    { decoded: false }, { signatureVerified: false }, { detectedMime: "image/png" },
    { width: 10000, height: 10000 }, { frames: 2 }, { width: 0 }
  ]) {
    const f = fixture({ inspectBytes: () => ({ ...syntheticInspection(), ...extra }) });
    const upload = await f.service.start(f.context, f.request()); await f.transfer(upload);
    await assert.rejects(f.service.complete(f.context, { uploadId: upload.uploadId }), error => error.statusCode === 422);
    assert.equal(Object.keys(f.store.snapshotForTest(f.context.companyId).prepareOutbox).length, 0);
  }
});

test("inspected video has bounded duration and SDR/audio metadata, but is never ready", async () => {
  for (const extra of [{}, { durationMs: 60001 }, { colorMode: "hdr" }, { hasAudio: undefined }]) {
    const f = fixture({ inspectBytes: () => ({ signatureVerified: true, decoded: true, detectedMime: "video/mp4",
      width: 1080, height: 1920, durationMs: 30000, hasAudio: true, colorMode: "sdr", ...extra }) });
    const upload = await f.service.start(f.context, f.request(image, { kind: "video", mimeType: "video/mp4" })); await f.transfer(upload);
    if (Object.keys(extra).length) await assert.rejects(f.service.complete(f.context, { uploadId: upload.uploadId }), error => error.statusCode === 422);
    else assert.equal((await f.service.complete(f.context, { uploadId: upload.uploadId })).ready, false);
  }
});

test("client cannot provide an inspection, completion manifest or arbitrary URL", async () => {
  const f = fixture(), upload = await f.service.start(f.context, f.request());
  for (const field of ["parts", "sha256", "inspection", "url", "objectKey"]) {
    await code(f.service.complete(f.context, { uploadId: upload.uploadId, [field]: "forged" }), "import_request_invalid");
  }
  assert.equal(f.provider.statsForTest().finalize, 0);
});

test("unknown finalization response retries same object, never finalizes a second copy", async () => {
  let first = true;
  const f = fixture({ wrapProvider: base => ({ ...base, async finalizeMultipart(args) {
    const response = await base.finalizeMultipart(args);
    if (first) { first = false; throw new Error("https://private.invalid/?credential=secret"); }
    return response;
  } }) });
  const upload = await f.service.start(f.context, f.request()); await f.transfer(upload);
  await code(f.service.complete(f.context, { uploadId: upload.uploadId }), "import_verification_pending");
  assert.equal((await f.service.status(f.context, { uploadId: upload.uploadId })).state, "verifying");
  await code(f.service.cancel(f.context, { uploadId: upload.uploadId }), "import_upload_not_cancellable");
  assert.equal((await f.service.complete(f.context, { uploadId: upload.uploadId })).state, "uploaded");
  assert.equal(f.provider.statsForTest().completedObjects, 1);
  assert.equal(f.provider.statsForTest().finalize, 1);
});

test("lost initiation response resumes one provider upload with the same opaque key", async () => {
  let first = true;
  const f = fixture({ wrapProvider: base => ({ ...base, async beginMultipart(args) {
    const response = await base.beginMultipart(args);
    if (first) { first = false; throw new Error("provider_secret"); }
    return response;
  } }) });
  const request = f.request();
  await code(f.service.start(f.context, request), "import_provider_unavailable");
  const resumed = await f.service.start(f.context, request);
  assert.equal(resumed.state, "uploading");
  assert.equal(f.provider.statsForTest().sessions, 1);
  assert.equal(f.store.snapshotForTest(f.context.companyId).reservedBytes, image.length);
});

test("provider errors and malformed responses never escape with secrets", async () => {
  const f = fixture({ wrapProvider: base => ({ ...base, async listParts() { throw new Error("token=private; signed_url=secret"); } }) });
  const upload = await f.service.start(f.context, f.request());
  await assert.rejects(f.service.resume(f.context, { uploadId: upload.uploadId }), error => {
    assert.equal(error.code, "import_operation_unavailable");
    assert.equal(error.cause, undefined); assert.equal(error.message.includes("secret"), false); return true;
  });
});

test("cancel aborts exact temporary object, releases quota once and invalidates grants", async () => {
  const f = fixture(), input = f.request(), upload = await f.service.start(f.context, input);
  const grant = await f.service.authorizePart(f.context, { uploadId: upload.uploadId, partNumber: 1 });
  await f.provider.receivePartForTest(grant.authorizationId, image);
  await Promise.all(Array.from({ length: 10 }, () => f.service.cancel(f.context, { uploadId: upload.uploadId })));
  assert.equal((await f.service.cancel(f.context, { uploadId: upload.uploadId })).state, "cancelled");
  assert.equal(f.store.snapshotForTest(f.context.companyId).reservedBytes, 0);
  await assert.rejects(f.provider.receivePartForTest(grant.authorizationId, image));
  assert.equal((await f.service.start(f.context, input)).state, "cancelled");
  assert.equal(f.provider.statsForTest().abort, 1);
});

test("ambiguous cancellation keeps reservation until provider confirms abort", async () => {
  let first = true;
  const f = fixture({ wrapProvider: base => ({ ...base, async abortMultipart(args) {
    const response = await base.abortMultipart(args);
    if (first) { first = false; throw new Error("network failed"); }
    return response;
  } }) });
  const upload = await f.service.start(f.context, f.request());
  await code(f.service.cancel(f.context, { uploadId: upload.uploadId }), "import_cancellation_pending");
  assert.equal(f.store.snapshotForTest(f.context.companyId).reservedBytes, image.length);
  assert.equal((await f.service.cancel(f.context, { uploadId: upload.uploadId })).state, "cancelled");
  assert.equal(f.store.snapshotForTest(f.context.companyId).reservedBytes, 0);
});

test("expired verification lease can be recovered without trusting previous process", async () => {
  const f = fixture(), upload = await f.service.start(f.context, f.request()); await f.transfer(upload);
  await f.store.update(f.context.companyId, state => {
    state.uploads[upload.uploadId].state = "verifying";
    state.uploads[upload.uploadId].lease = { operation: "verify", token: crypto.randomUUID(), expiresAt: 1 };
  });
  assert.equal((await f.service.complete(f.context, { uploadId: upload.uploadId })).state, "uploaded");
  assert.equal(Object.keys(f.store.snapshotForTest(f.context.companyId).prepareOutbox).length, 1);
});

test("stale verification callback cannot append a second outbox job after lease takeover", async () => {
  let releaseFirst, enteredFirst;
  const firstEntered = new Promise(resolve => { enteredFirst = resolve; });
  const held = new Promise(resolve => { releaseFirst = resolve; });
  let count = 0;
  const f = fixture({ wrapProvider: base => ({ ...base, async inspectObject(args) {
    if (++count === 1) { enteredFirst(); await held; }
    return base.inspectObject(args);
  } }) });
  const upload = await f.service.start(f.context, f.request()); await f.transfer(upload);
  const first = f.service.complete(f.context, { uploadId: upload.uploadId });
  await firstEntered;
  const busy = await f.service.complete(f.context, { uploadId: upload.uploadId });
  assert.equal(busy.state, "verifying"); assert.equal(busy.verification, null);
  f.advance(DEFAULT_LIMITS.operationLeaseMs + 1);
  const recovery = await f.service.complete(f.context, { uploadId: upload.uploadId });
  assert.equal(recovery.state, "uploaded");
  releaseFirst();
  assert.equal((await first).state, "uploaded");
  assert.equal(Object.keys(f.store.snapshotForTest(f.context.companyId).prepareOutbox).length, 1);
  assert.equal(f.provider.statsForTest().finalize, 1);
});

test("atomic store rolls back failing mutations and does not return mutable state", async () => {
  const store = createMemoryImportUploadStore(), user = identity();
  await assert.rejects(store.update(user.companyId, state => { state.reservedBytes = 12; throw new Error("rollback"); }));
  assert.equal(store.snapshotForTest(user.companyId).reservedBytes, 0);
  const escaped = await store.update(user.companyId, state => state);
  escaped.reservedBytes = 999;
  assert.equal(store.snapshotForTest(user.companyId).reservedBytes, 0);
  await assert.rejects(store.update(user.companyId, async () => {}), /memory_store_sync_mutation_required/);
});
