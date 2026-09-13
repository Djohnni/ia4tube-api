"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { Readable } = require("node:stream");
const { createCalendarImportUploadService } = require("../src/social/calendar/imports/upload-service");
const { createMemoryImportUploadStore } = require("../src/social/calendar/imports/memory-adapters");
const { createRenderDiskPrivateUploadProvider, validateDiskUploadRecord } = require("../src/social/calendar/imports/render-disk-provider");
const { validateImportUploadState } = require("../src/social/calendar/imports/postgres-store");
const digest = (value, type = "sha256", encoding = "hex") => crypto.createHash(type).update(value).digest(encoding);
const fake = Buffer.from("SYNTHETIC_LOCAL_STORAGE_PROTOCOL_NOT_REAL_IMAGE");
const CHUNK = 5 * 1024 * 1024;

async function fixture(t, { bytes = fake, wrapAdmission, wrapInspector } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iA4tube-disk-provider-"));
  await fs.chmod(root, 0o700);
  t.after(async () => {
    const parent = path.resolve(os.tmpdir()), target = path.resolve(root);
    assert.equal(path.dirname(target), parent);
    assert.ok(path.basename(target).startsWith("iA4tube-disk-provider-"));
    await fs.rm(target, { recursive: true, force: true });
  });
  const store = createMemoryImportUploadStore(), reservations = new Map(), tickets = new Map();
  const ctx = { authenticated: true, companyId: crypto.randomUUID(), userId: crypto.randomUUID() };
  let time = 1789260000000;
  const stats = { reserve: 0, release: 0, inspect: 0 };
  const admissionBase = {
    capabilities: { persistence: "volatile-test", atomicGlobalReservations: true },
    async reserve(binding) {
      stats.reserve++;
      const prior = reservations.get(binding.reservationKey);
      if (prior) assert.deepEqual(prior, binding);
      else reservations.set(binding.reservationKey, structuredClone(binding));
    },
    async assertHeld(binding) {
      const actual = reservations.get(binding.reservationKey);
      return actual ? { held: true, binding: structuredClone(actual) } : { held: false };
    },
    async sealStorage() { /* synthetic provider-contract substitute only */ },
    async releaseAfterAbort(binding) { stats.release++; reservations.delete(binding.reservationKey); }
  };
  const inspectorBase = {
    capabilities: { isolated: true, bounded: true, remoteObjectInspection: true },
    async startInspection(request) {
      stats.inspect++;
      assert.equal(request.sha256, digest(bytes));
      const result = { ticketId: request.ticketId, state: "ready", result: {
        complete: true, decoded: true, signatureVerified: true, detectedMime: "image/jpeg", width: 10, height: 10, frames: 1,
        sizeBytes: bytes.length, sha256: digest(bytes) } };
      tickets.set(request.ticketId, result); return result;
    },
    async getInspection(request) { return tickets.get(request.ticketId) || { ticketId: request.ticketId, state: "pending" }; }
  };
  const admission = wrapAdmission ? wrapAdmission(admissionBase) : admissionBase;
  const inspector = wrapInspector ? wrapInspector(inspectorBase) : inspectorBase;
  const options = { rootDirectory: root, store, admission, inspector, transferOrigin: "https://ia4tube-api.onrender.com",
    clock: () => time, enabled: true, allowVolatileForTests: true };
  let provider = createRenderDiskPrivateUploadProvider(options);
  let service = createCalendarImportUploadService({ store, provider, enabled: true, allowVolatileForTests: true, clock: () => time });
  const input = { idempotencyKey: crypto.randomUUID(), kind: "image", mimeType: "image/jpeg", sizeBytes: bytes.length, sha256: digest(bytes) };
  function row(upload) { return store.snapshotForTest(ctx.companyId).uploads[upload.uploadId]; }
  function args(upload, extra = {}) { const current = row(upload); return { context: ctx, objectKey: current.objectKey, uploadId: current.disk.uploadId, ...extra }; }
  async function part(upload, number = 1, chunk = bytes.subarray((number - 1) * CHUNK, number * CHUNK)) {
    const grant = await service.authorizePart(ctx, { uploadId: upload.uploadId, partNumber: number,
      sha256: digest(chunk), md5Base64: digest(chunk, "md5", "base64") });
    return { ...args(upload), partNumber: number, authorizationId: grant.authorizationId, contentLength: chunk.length,
      stream: Readable.from([chunk]) };
  }
  return { root, store, ctx, options, stats, bytes, reservations, input, row, args, part,
    get provider() { return provider; }, get service() { return service; }, advance(ms) { time += ms; },
    restart() { provider = createRenderDiskPrivateUploadProvider(options); service = createCalendarImportUploadService({ store, provider,
      enabled: true, allowVolatileForTests: true, clock: () => time }); } };
}

test("disk foundation fails closed absent durable global admission, inspector, origin or production permission", async t => {
  const f = await fixture(t);
  for (const changed of [{ admission: undefined }, { inspector: undefined }, { transferOrigin: "http://insecure.invalid" },
    { allowVolatileForTests: false }, { rootDirectory: "." }, { admission: { ...f.options.admission, capabilities: { persistence: "durable" } } }]) {
    const candidate = createRenderDiskPrivateUploadProvider({ ...f.options, ...changed });
    assert.equal(candidate.capabilities.privateObjects, false);
    await assert.rejects(candidate.beginMultipart({}), { code: "disk_provider_disabled" });
  }
  assert.equal(f.provider.getCapabilities().readyForProduction, false);
  assert.deepEqual(await fs.readdir(f.root), []);
});

test("private part roundtrip resumes after adapter restart, returns exact scoped URL and seals one object/outbox", async t => {
  const f = await fixture(t), upload = await f.service.start(f.ctx, f.input);
  const grantArgs = await f.part(upload);
  const grant = await f.service.resolvePart(f.ctx, { uploadId: upload.uploadId, partNumber: 1, authorizationId: grantArgs.authorizationId });
  assert.equal(grant.url, `https://ia4tube-api.onrender.com/v1/social/calendar/imports/bytes/${grantArgs.authorizationId}`);
  assert.deepEqual(Object.keys(grant.headers).sort(), ["content-length", "content-md5", "x-amz-checksum-sha256"]);
  assert.equal(grant.url.includes(f.row(upload).objectKey), false);
  await f.provider.acceptPart(grantArgs);
  f.restart();
  const resumed = await f.service.resume(f.ctx, { uploadId: upload.uploadId });
  assert.deepEqual(resumed.completedParts, [{ partNumber: 1, sizeBytes: fake.length, sha256: digest(fake) }]);
  const result = await f.service.complete(f.ctx, { uploadId: upload.uploadId });
  assert.equal(result.state, "uploaded"); assert.equal(result.ready, false); assert.equal(f.stats.inspect, 1);
  const state = f.store.snapshotForTest(f.ctx.companyId);
  validateImportUploadState(state, f.ctx.companyId);
  assert.equal(Object.keys(state.prepareOutbox).length, 1);
  const chunks = [];
  const read = await f.provider.streamSealedObject({ ...f.args(upload), objectVersion: f.row(upload).disk.objectVersion,
    consume: chunk => { chunks.push(Buffer.from(chunk)); } });
  assert.deepEqual(Buffer.concat(chunks), fake); assert.equal(read.sha256, digest(fake));
  assert.equal(f.reservations.size, 1); // Sealed content retains peak reservation.
  await f.service.complete(f.ctx, { uploadId: upload.uploadId }); assert.equal(f.stats.inspect, 1);
});

test("multipart byte order and whole-object digest match across bounded chunks", async t => {
  const bytes = Buffer.concat([Buffer.alloc(CHUNK, 7), Buffer.alloc(19, 9)]), f = await fixture(t, { bytes });
  const upload = await f.service.start(f.ctx, f.input);
  await f.provider.acceptPart(await f.part(upload, 2));
  await f.provider.acceptPart(await f.part(upload, 1));
  const complete = await f.service.complete(f.ctx, { uploadId: upload.uploadId });
  assert.equal(complete.verification.sha256, digest(bytes));
  const info = await fs.stat(path.join(f.root, f.row(upload).objectKey, "source.bin"));
  assert.equal(info.size, bytes.length); assert.equal(info.nlink, 1);
});

test("tenant and user substitutions cannot resolve, write, list, inspect or read another owner's bytes", async t => {
  const f = await fixture(t), upload = await f.service.start(f.ctx, f.input), grant = await f.part(upload);
  for (const changed of [{ companyId: crypto.randomUUID() }, { userId: crypto.randomUUID() }, { authenticated: false }]) {
    const wrong = { ...grant, context: { ...f.ctx, ...changed } };
    for (const method of ["resolveAuthorization", "acceptPart", "listParts", "inspectObject", "streamSealedObject"]) {
      await assert.rejects(f.provider[method](wrong), { code: "disk_owner_invalid" });
    }
  }
  assert.equal((await f.service.resume(f.ctx, { uploadId: upload.uploadId })).completedParts.length, 0);
});

test("wrong, truncated, oversized, expired or replaced part grants never commit bytes", async t => {
  const f = await fixture(t), upload = await f.service.start(f.ctx, f.input), grant = await f.part(upload);
  for (const body of [Buffer.alloc(fake.length, 2), fake.subarray(0, -1), Buffer.concat([fake, Buffer.from("x")])]) {
    await assert.rejects(f.provider.acceptPart({ ...grant, stream: Readable.from([body]) }), /disk_body_/);
  }
  const updated = await f.part(upload);
  await assert.rejects(f.provider.acceptPart({ ...grant, stream: Readable.from([fake]) }), { code: "disk_authorization_invalid" });
  f.advance(600001);
  await assert.rejects(f.provider.acceptPart(updated), { code: "disk_authorization_invalid" });
  assert.deepEqual(await fs.readdir(path.join(f.root, f.row(upload).objectKey)), ["identity.json"]);
});

test("interrupted and stalled streams release only their own partial file and allow retry", async t => {
  const f = await fixture(t), upload = await f.service.start(f.ctx, f.input), grant = await f.part(upload);
  const interrupted = Readable.from((async function* () { yield fake.subarray(0, 3); throw new Error("synthetic-failure-not-an-error-leak"); })());
  await assert.rejects(f.provider.acceptPart({ ...grant, stream: interrupted }), { code: "disk_operation_unavailable" });
  const stalled = new Readable({ read() {} });
  await assert.rejects(f.provider.acceptPart({ ...grant, stream: stalled, timeoutMs: 10 }), { code: "disk_transfer_timeout" });
  assert.equal(stalled.destroyed, true);
  await f.provider.acceptPart({ ...grant, stream: Readable.from([fake]) });
  assert.equal((await f.service.resume(f.ctx, { uploadId: upload.uploadId })).completedParts.length, 1);
});

test("renewed same-byte replay is accepted but different digest and post-seal writes are refused", async t => {
  const f = await fixture(t), upload = await f.service.start(f.ctx, f.input);
  await f.provider.acceptPart(await f.part(upload));
  await f.provider.acceptPart(await f.part(upload));
  await assert.rejects(f.service.authorizePart(f.ctx, { uploadId: upload.uploadId, partNumber: 1,
    sha256: "a".repeat(64), md5Base64: digest(fake, "md5", "base64") }), { code: "import_operation_unavailable" });
  const grant = await f.part(upload);
  await f.service.complete(f.ctx, { uploadId: upload.uploadId });
  await assert.rejects(f.provider.acceptPart(grant), { code: "disk_authorization_invalid" });
  await assert.rejects(f.service.cancel(f.ctx, { uploadId: upload.uploadId }), { code: "import_upload_not_cancellable" });
});

test("reservation is exact owner/hash-bound and must remain held for every transfer", async t => {
  const f = await fixture(t), upload = await f.service.start(f.ctx, f.input), grant = await f.part(upload);
  const binding = [...f.reservations.values()][0];
  assert.equal(binding.sourceSha256, digest(fake)); assert.equal(binding.peakBytes, fake.length * 2 + 65536);
  f.reservations.set(binding.reservationKey, { ...binding, companyId: crypto.randomUUID() });
  await assert.rejects(f.provider.acceptPart(grant), { code: "disk_reservation_missing" });
  f.reservations.delete(binding.reservationKey);
  await assert.rejects(f.provider.resolveAuthorization(grant), { code: "disk_reservation_missing" });
});

test("reservation failure leaves no byte-storage directory", async t => {
  const f = await fixture(t, { wrapAdmission: base => ({ ...base, async reserve() { throw new Error("quota-exhausted"); } }) });
  await assert.rejects(f.service.start(f.ctx, f.input), { code: "import_provider_unavailable" });
  assert.deepEqual(await fs.readdir(f.root), []);
});

test("whole file hash mismatch is rejected, no source seal and reservation is retained", async t => {
  const f = await fixture(t), upload = await f.service.start(f.ctx, { ...f.input, sha256: "a".repeat(64) });
  await f.provider.acceptPart(await f.part(upload));
  await assert.rejects(f.service.complete(f.ctx, { uploadId: upload.uploadId }), { code: "import_media_verification_failed" });
  assert.equal(f.row(upload).state, "rejected"); assert.equal(f.reservations.size, 1);
  const files = await fs.readdir(path.join(f.root, f.row(upload).objectKey));
  assert.equal(files.includes("source.bin"), false); assert.equal(files.includes("seal.json"), false);
});

test("file corruption or hard link replacement is detected before inspection or outgoing transfer", async t => {
  const f = await fixture(t), upload = await f.service.start(f.ctx, f.input);
  await f.provider.acceptPart(await f.part(upload));
  const file = path.join(f.root, f.row(upload).objectKey, "part-1.bin");
  await fs.link(file, path.join(f.root, "synthetic-hardlink"));
  await assert.rejects(f.provider.listParts(f.args(upload)), { code: "disk_file_unsafe" });
  await fs.unlink(path.join(f.root, "synthetic-hardlink"));
  await fs.writeFile(file, Buffer.alloc(fake.length, 1));
  await assert.rejects(f.provider.listParts(f.args(upload)), { code: "disk_part_conflict" });
});

test("root junction/symlink and traversal key are denied without accessing target", async t => {
  const f = await fixture(t), external = path.join(f.root, "private-target"), alias = path.join(f.root, "alias");
  await fs.mkdir(external, { mode: 0o700 });
  await fs.symlink(external, alias, process.platform === "win32" ? "junction" : "dir");
  const candidate = createRenderDiskPrivateUploadProvider({ ...f.options, rootDirectory: alias });
  const service = createCalendarImportUploadService({ store: f.store, provider: candidate, enabled: true, allowVolatileForTests: true });
  await assert.rejects(service.start(f.ctx, f.input), { code: "import_provider_unavailable" });
  assert.deepEqual(await fs.readdir(external), []);
  await assert.rejects(f.provider.beginMultipart({ context: f.ctx, objectKey: "../outside" }), { code: "disk_owner_invalid" });
});

test("stale exclusive lock fails closed after restart and is not auto-removed", async t => {
  const f = await fixture(t), upload = await f.service.start(f.ctx, f.input), grant = await f.part(upload);
  const filename = path.join(f.root, f.row(upload).objectKey, "operation.lock");
  await fs.writeFile(filename, "synthetic-crash-marker", { flag: "wx" }); f.restart();
  await assert.rejects(f.provider.acceptPart(grant), { code: "disk_operation_busy_or_recovery_required" });
  assert.equal(await fs.readFile(filename, "utf8"), "synthetic-crash-marker");
});

test("cancellation removes only owned known partial bytes before idempotent reservation release", async t => {
  const f = await fixture(t), upload = await f.service.start(f.ctx, f.input);
  await f.provider.acceptPart(await f.part(upload));
  const cancelled = await f.service.cancel(f.ctx, { uploadId: upload.uploadId });
  assert.equal(cancelled.state, "cancelled"); assert.equal(f.reservations.size, 0); assert.equal(f.stats.release, 1);
  assert.deepEqual(await fs.readdir(path.join(f.root, f.row(upload).objectKey)), ["identity.json"]);
  await f.service.cancel(f.ctx, { uploadId: upload.uploadId }); assert.equal(f.stats.release, 1);
});

test("unknown file blocks cleanup and retains reservation rather than deleting unrelated content", async t => {
  const f = await fixture(t), upload = await f.service.start(f.ctx, f.input);
  await f.provider.acceptPart(await f.part(upload));
  const marker = path.join(f.root, f.row(upload).objectKey, "unrecognized.txt");
  await fs.writeFile(marker, "preserve-synthetic");
  await assert.rejects(f.service.cancel(f.ctx, { uploadId: upload.uploadId }), { code: "import_cancellation_pending" });
  assert.equal(await fs.readFile(marker, "utf8"), "preserve-synthetic"); assert.equal(f.reservations.size, 1); assert.equal(f.stats.release, 0);
});

test("inspection is an isolated ticket contract, loses no quota or seal when response is pending", async t => {
  const f = await fixture(t, { wrapInspector: base => ({ ...base,
    async startInspection(request) { return { ticketId: request.ticketId, state: "pending" }; },
    async getInspection(request) { return { ticketId: request.ticketId, state: "pending" }; } }) });
  const upload = await f.service.start(f.ctx, f.input); await f.provider.acceptPart(await f.part(upload));
  await assert.rejects(f.service.complete(f.ctx, { uploadId: upload.uploadId }), { code: "import_verification_pending" });
  assert.equal(f.row(upload).disk.phase, "sealed"); assert.equal(f.row(upload).state, "verifying");
  assert.equal(f.reservations.size, 1); assert.equal(Object.keys(f.store.snapshotForTest(f.ctx.companyId).prepareOutbox).length, 0);
});

test("additive disk state validator rejects invalid identities and mutated grants", async t => {
  const f = await fixture(t), upload = await f.service.start(f.ctx, f.input); await f.part(upload);
  const row = f.row(upload); assert.equal(validateDiskUploadRecord(row), row);
  assert.throws(() => validateDiskUploadRecord({ ...row, objectKey: "../escape" }), { code: "disk_record_invalid" });
  const changed = structuredClone(row); changed.disk.parts[1].sizeBytes++;
  assert.throws(() => validateDiskUploadRecord(changed), { code: "disk_record_invalid" });
});

test("known injected error codes preserve no secret message, path or cause", async t => {
  const f = await fixture(t, { wrapAdmission: base => ({ ...base, async reserve() {
    throw Object.assign(new Error("SYNTHETIC_SECRET_MUST_NOT_ESCAPE /private/path"), { code: "disk_reservation_missing", cause: new Error("SYNTHETIC_CAUSE") });
  } }) });
  await assert.rejects(f.service.start(f.ctx, f.input), { code: "import_provider_unavailable" });
  const row = Object.values(f.store.snapshotForTest(f.ctx.companyId).uploads)[0];
  await assert.rejects(f.provider.beginMultipart({ context: f.ctx, objectKey: row.objectKey, assetId: row.assetId,
    sizeBytes: row.sizeBytes, chunkBytes: row.chunkBytes, checksumAlgorithm: "SHA256" }), error => {
    assert.equal(error.code, "disk_reservation_missing"); assert.equal(error.message, "disk_reservation_missing");
    assert.equal(error.cause, undefined); assert.equal(JSON.stringify(error).includes("SYNTHETIC"), false); return true;
  });
});

test("seal receipt corruption is refused before returning inspection or streaming source", async t => {
  const f = await fixture(t), upload = await f.service.start(f.ctx, f.input); await f.provider.acceptPart(await f.part(upload));
  await f.service.complete(f.ctx, { uploadId: upload.uploadId });
  const row = f.row(upload), filename = path.join(f.root, row.objectKey, "seal.json");
  await fs.writeFile(filename, JSON.stringify({ objectVersion: row.disk.objectVersion, sha256: "b".repeat(64) }));
  let consumed = false;
  for (const method of ["inspectObject", "streamSealedObject"]) await assert.rejects(f.provider[method]({ ...f.args(upload),
    objectVersion: row.disk.objectVersion, consume: () => { consumed = true; } }), { code: "disk_seal_conflict" });
  assert.equal(consumed, false);
});

test("trusted asynchronous binding checks refuse before allocation and immediately before committing bytes", async t => {
  const f = await fixture(t), upload = await f.service.start(f.ctx, f.input);
  const grant = await f.part(upload), dir = path.join(f.root, f.row(upload).objectKey);
  for (const verifyWriteBinding of [true, async () => false, async () => ({ approved: true })]) {
    await assert.rejects(f.provider.acceptPart({ ...grant, stream: Readable.from([fake]), verifyWriteBinding }),
      { code: "disk_write_binding_invalid" });
    assert.deepEqual(await fs.readdir(dir), ["identity.json"]);
  }
  let checks = 0;
  await assert.rejects(f.provider.acceptPart({ ...grant, stream: Readable.from([fake]), async verifyWriteBinding() {
    checks++; await new Promise(resolve => setImmediate(resolve));
    // The body is already fully validated and its private pending file flushed.
    // A durable revocation discovered by the final binding read blocks install.
    if (checks === 3) { assert.deepEqual((await fs.readdir(dir)).sort(), ["identity.json", "operation.lock", "part-1.pending"]); return false; }
    return true;
  } }), { code: "disk_write_binding_invalid" });
  assert.equal(checks, 3); assert.deepEqual(await fs.readdir(dir), ["identity.json"]);
  assert.equal(f.reservations.size, 1);
  await f.provider.acceptPart({ ...grant, stream: Readable.from([fake]), verifyWriteBinding: async () => true });
  assert.equal((await f.service.resume(f.ctx, { uploadId: upload.uploadId })).completedParts.length, 1);
});

test("a binding refusal at receipt install retains an already committed part and supports an exact retry", async t => {
  const f = await fixture(t), upload = await f.service.start(f.ctx, f.input), grant = await f.part(upload);
  const dir = path.join(f.root, f.row(upload).objectKey);
  await assert.rejects(f.provider.acceptPart({ ...grant, async verifyWriteBinding() {
    return !(await fs.readdir(dir)).some(name => /^part-1\.json\..+\.pending$/.test(name));
  } }), { code: "disk_write_binding_invalid" });
  assert.deepEqual((await fs.readdir(dir)).sort(), ["identity.json", "part-1.bin"]);
  assert.deepEqual(await fs.readFile(path.join(dir, "part-1.bin")), fake); assert.equal(f.reservations.size, 1);
  await f.provider.acceptPart({ ...grant, stream: Readable.from([fake]), verifyWriteBinding: async () => true });
  assert.deepEqual((await fs.readdir(dir)).sort(), ["identity.json", "part-1.bin", "part-1.json"]);
});
