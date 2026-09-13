"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path"), { Readable } = require("node:stream");
const { createDiskSpaceGuard, createDiskSpaceGuardForTests, isDiskSpaceGuard, assertDiskSpaceEvidence,
  DEFAULT_MARGIN_BYTES } = require("../src/social/calendar/imports/disk-space-guard");
const { createGlobalMediaCapacity, freshGlobalCapacityState, validateGlobalCapacityState } = require("../src/social/calendar/imports/global-capacity");
const { createRenderDiskAdmission, METADATA_MARGIN } = require("../src/social/calendar/imports/render-disk-admission");
const { createRenderDiskPrivateUploadProvider } = require("../src/social/calendar/imports/render-disk-provider");
const { createMemoryImportUploadStore } = require("../src/social/calendar/imports/memory-adapters");
const { createCalendarImportUploadService } = require("../src/social/calendar/imports/upload-service");
const context = Object.freeze({ authenticated: true, role: "calendar_media_capacity_coordinator" });
const uuid = () => crypto.randomUUID();
function globalStore() {
  let current = freshGlobalCapacityState(), tail = Promise.resolve();
  return { capabilities: { persistence: "volatile", atomicGlobalUpdates: true, testOnly: true },
    update(operation) { const task = tail.then(() => {
      const next = structuredClone(current), result = operation(next);
      if (result && typeof result.then === "function") throw new Error("async forbidden");
      validateGlobalCapacityState(next); current = next; return structuredClone(result);
    }); tail = task.catch(() => {}); return task; }, snapshot: () => structuredClone(current) };
}
async function directory(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iA4tube-space-guard-")); await fs.chmod(root, 0o700);
  t.after(async () => {
    const target = path.resolve(root); assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith("iA4tube-space-guard-")); assert.equal((await fs.lstat(target)).isSymbolicLink(), false);
    await fs.rm(target, { recursive: true, force: true });
  });
  return root;
}
function request(patch = {}) { return { context, jobId: uuid(), companyId: uuid(), userId: uuid(), requestDigest: "a".repeat(64),
  storageBytes: 100, sourceBytes: 40, ...patch }; }
function capacity(store, guard, options = {}) { return createGlobalMediaCapacity({ store, enabled: true, allowVolatileForTests: true,
  requireDiskSpaceEvidence: true, diskSpaceGuard: guard, ...options }); }
async function fixture(t, { marginBytes = 0, bytes = 250n } = {}) {
  const root = await directory(t); let free = bytes, time = 0n, calls = 0;
  const guard = createDiskSpaceGuardForTests({ rootDirectory: root, enabled: true, marginBytes,
    statfsForTests: async (location, options) => { assert.equal(location, root); assert.deepEqual(options, { bigint: true }); calls++; return { bavail: free, bsize: 1n }; },
    monotonicClockForTests: () => time });
  const store = globalStore(), api = capacity(store, guard);
  return { root, guard, store, api, setFree: value => { free = value; }, advance: ms => { time += BigInt(ms) * 1000000n; },
    statsCalls: () => calls };
}

test("real statfs reads a verified temporary root; default guard is disabled and margin is explicit", async t => {
  const root = await directory(t), guard = createDiskSpaceGuard({ rootDirectory: root, enabled: true });
  assert.equal(guard.capabilities.marginBytes, DEFAULT_MARGIN_BYTES);
  assert.equal(guard.capabilities.operatingSystemQuota, false); assert.equal(guard.capabilities.financialHardCap, false);
  const token = await guard.sample(), maximum = assertDiskSpaceEvidence(token, { guard });
  assert.ok(Number.isSafeInteger(maximum) && maximum >= 0);
  assert.equal(JSON.stringify(token), "{}"); assert.equal(Object.isFrozen(token), true);
  await assert.rejects(createDiskSpaceGuard({ rootDirectory: root }).sample(), { code: "disk_space_guard_disabled" });
  assert.throws(() => createDiskSpaceGuard({ rootDirectory: root, statfs: async () => ({ bavail: 100000n, bsize: 1n }) }), { code: "disk_space_configuration_invalid" });
  assert.throws(() => createDiskSpaceGuard({ rootDirectory: path.parse(root).root }), { code: "disk_space_root_unsafe" });
});
test("BigInt available-to-user blocks minus margin yields a safe nonnegative ceiling; invalid stats fail closed", async t => {
  const f = await fixture(t, { marginBytes: 20, bytes: 250n });
  assert.equal(assertDiskSpaceEvidence(await f.guard.sample(), { guard: f.guard, allowVolatileForTests: true }), 230);
  f.setFree(5n); assert.equal(assertDiskSpaceEvidence(await f.guard.sample(), { guard: f.guard, allowVolatileForTests: true }), 0);
  for (const stats of [{ bavail: -1n, bsize: 1n }, { bavail: 10, bsize: 1n }, { bavail: 10n, bsize: 0n },
    { bavail: BigInt(Number.MAX_SAFE_INTEGER), bsize: 2n }, { bfree: 100000n, bsize: 1n }]) {
    const guard = createDiskSpaceGuardForTests({ rootDirectory: f.root, enabled: true, marginBytes: 0, statfsForTests: async () => stats });
    await assert.rejects(guard.sample(), { code: "disk_space_stats_invalid" });
  }
});
test("opaque evidence rejects forgery, serialization, a different issuer and lack of explicit test opt-in", async t => {
  const f = await fixture(t), token = await f.guard.sample();
  assert.equal(isDiskSpaceGuard({ ...f.guard }, { allowVolatileForTests: true }), false);
  assert.equal(isDiskSpaceGuard(f.guard), false);
  assert.throws(() => assertDiskSpaceEvidence(token, { guard: f.guard }), { code: "disk_space_evidence_invalid" });
  for (const forged of [{ maximumHeldBytes: 999999999 }, {}, structuredClone(token), JSON.parse(JSON.stringify(token))]) {
    assert.throws(() => assertDiskSpaceEvidence(forged, { guard: f.guard, allowVolatileForTests: true }), { code: "disk_space_evidence_invalid" });
    await assert.rejects(f.api.reserveStorage(request({ diskSpaceEvidence: forged })), { code: "media_capacity_disk_space_evidence_invalid" });
  }
  const other = createDiskSpaceGuardForTests({ rootDirectory: f.root, enabled: true, statfsForTests: async () => ({ bavail: 100n, bsize: 1n }) });
  assert.throws(() => assertDiskSpaceEvidence(token, { guard: other, allowVolatileForTests: true }), { code: "disk_space_evidence_invalid" });
  assert.equal(capacity(f.store, { ...f.guard }).capabilities.available, false);
});
test("twenty simultaneous companies share one atomic physical ceiling even with the same free-space snapshot", async t => {
  const f = await fixture(t), second = capacity(f.store, f.guard), diskSpaceEvidence = await f.guard.sample();
  const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => (i % 2 ? f.api : second).reserveStorage(request({ diskSpaceEvidence }))));
  assert.equal(results.filter(row => row.status === "fulfilled").length, 2);
  assert.ok(results.filter(row => row.status === "rejected").every(row => row.reason.code === "media_capacity_disk_space_insufficient"));
  assert.equal((await f.api.summary({ context })).storageBytes, 200); assert.equal(f.statsCalls(), 1);
  assert.equal((await f.api.summary({ context })).monthlyJobs, 0);
});
test("low space rejects both new admission and existing write assertions but permits immutable reads", async t => {
  const f = await fixture(t), row = request({ diskSpaceEvidence: await f.guard.sample() });
  await f.api.reserveStorage(row); await f.api.reserveStorage(row);
  f.setFree(99n); const low = await f.guard.sample();
  await assert.rejects(f.api.assertHeld({ ...row, diskSpaceEvidence: low }), { code: "media_capacity_disk_space_insufficient" });
  await assert.rejects(f.api.reserveStorage({ ...row, diskSpaceEvidence: low }), { code: "media_capacity_disk_space_insufficient" });
  await assert.rejects(f.api.reserveStorage(request({ diskSpaceEvidence: low })), { code: "media_capacity_disk_space_insufficient" });
  assert.equal((await f.api.assertHeld({ ...row, intent: "read", diskSpaceEvidence: undefined })).storageHeld, true);
  assert.equal((await f.api.summary({ context })).storageBytes, 100);
});
test("snapshot freshness is monotonic and checked inside the atomic transaction after queue delay", async t => {
  const f = await fixture(t), token = await f.guard.sample();
  f.advance(1001);
  await assert.rejects(f.api.reserveStorage(request({ diskSpaceEvidence: token })), { code: "media_capacity_disk_space_evidence_invalid" });
  const fresh = await f.guard.sample();
  const delayed = { ...f.store, update(operation) { f.advance(1001); return f.store.update(operation); } };
  await assert.rejects(capacity(delayed, f.guard).reserveStorage(request({ diskSpaceEvidence: fresh })), { code: "media_capacity_disk_space_evidence_invalid" });
  const backward = await f.guard.sample(); f.advance(-1);
  assert.throws(() => assertDiskSpaceEvidence(backward, { guard: f.guard, allowVolatileForTests: true }), { code: "disk_space_evidence_stale" });
  assert.equal(Object.keys(f.store.snapshot().jobs).length, 0);
});
test("root aliases, symlinks and lookup failures cannot supply a capacity observation", async t => {
  const root = await directory(t), real = path.join(root, "private"), link = path.join(root, "alias");
  await fs.mkdir(real, { mode: 0o700 });
  await fs.symlink(real, link, process.platform === "win32" ? "junction" : "dir");
  let calls = 0;
  const guard = createDiskSpaceGuardForTests({ rootDirectory: link, enabled: true, marginBytes: 0,
    statfsForTests: async () => { calls++; return { bavail: 100n, bsize: 1n }; } });
  await assert.rejects(guard.sample(), { code: "disk_space_root_unsafe" }); assert.equal(calls, 0);
  const missing = createDiskSpaceGuard({ rootDirectory: path.join(root, "absent"), enabled: true });
  await assert.rejects(missing.sample(), error => error.code === "disk_space_unavailable" && !error.message.includes(root) && !error.cause);
});

async function uploadFixture(t, { wrapAdmission = value => value } = {}) {
  const bytes = Buffer.from("SYNTHETIC_SPACE_GUARD_BYTES"), sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const peak = bytes.length * 2 + METADATA_MARGIN, f = await fixture(t, { bytes: BigInt(peak * 4) });
  const store = createMemoryImportUploadStore();
  const options = { capacity: f.api, store, rootDirectory: f.root, coordinatorContext: context, enabled: true,
    allowVolatileForTests: true, requireDiskSpaceEvidence: true, diskSpaceGuard: f.guard };
  const admission = createRenderDiskAdmission(options);
  const inspector = { capabilities: { isolated: true, bounded: true, remoteObjectInspection: true },
    startInspection: async request => ({ ticketId: request.ticketId, state: "pending" }),
    getInspection: async request => ({ ticketId: request.ticketId, state: "pending" }) };
  const provider = createRenderDiskPrivateUploadProvider({ rootDirectory: f.root, store, admission: wrapAdmission(admission), inspector,
    transferOrigin: "https://synthetic.invalid", enabled: true, allowVolatileForTests: true });
  const upload = createCalendarImportUploadService({ store, provider, enabled: true, allowVolatileForTests: true });
  const owner = { authenticated: true, companyId: uuid(), userId: uuid() };
  const input = { idempotencyKey: uuid(), kind: "image", mimeType: "image/jpeg", sizeBytes: bytes.length, sha256 };
  return { ...f, options, store, admission, provider, upload, owner, bytes, peak, input };
}
async function writePart(f, item) {
  const grant = await f.upload.authorizePart(f.owner, { uploadId: item.uploadId, partNumber: 1, sha256: f.input.sha256,
    md5Base64: crypto.createHash("md5").update(f.bytes).digest("base64") });
  const row = f.store.snapshotForTest(f.owner.companyId).uploads[item.uploadId];
  await f.provider.acceptPart({ context: f.owner, objectKey: row.objectKey, uploadId: row.disk.uploadId, partNumber: 1,
    authorizationId: grant.authorizationId, contentLength: f.bytes.length, stream: Readable.from([f.bytes]) });
  return row;
}
test("admission requires the actual matching guard and capacity binding; capability flags alone cannot activate it", async t => {
  const f = await uploadFixture(t);
  for (const options of [{ diskSpaceGuard: undefined }, { diskSpaceGuard: { ...f.guard } }, { rootDirectory: path.join(f.root, "other") },
    { capacity: { ...f.api, acceptsDiskSpaceGuard: undefined } }]) {
    const wrapper = createRenderDiskAdmission({ ...f.options, ...options });
    assert.equal(wrapper.capabilities.atomicGlobalReservations, false);
    await assert.rejects(wrapper.reserve({}), { code: "disk_admission_unavailable" });
  }
});
test("actual private provider checks free space again before accepting bytes and retains the charged reservation", async t => {
  const f = await uploadFixture(t), item = await f.upload.start(f.owner, f.input);
  const grant = await f.upload.authorizePart(f.owner, { uploadId: item.uploadId, partNumber: 1, sha256: f.input.sha256,
    md5Base64: crypto.createHash("md5").update(f.bytes).digest("base64") });
  const row = f.store.snapshotForTest(f.owner.companyId).uploads[item.uploadId], before = await fs.readdir(path.join(f.root, row.objectKey));
  let consumed = false;
  const stream = Readable.from((function* () { consumed = true; yield f.bytes; })());
  f.setFree(BigInt(f.peak - 1));
  await assert.rejects(f.provider.acceptPart({ context: f.owner, objectKey: row.objectKey, uploadId: row.disk.uploadId,
    partNumber: 1, authorizationId: grant.authorizationId, contentLength: f.bytes.length, stream }));
  assert.equal(consumed, false); assert.deepEqual(await fs.readdir(path.join(f.root, row.objectKey)), before);
  assert.equal((await f.api.summary({ context })).storageBytes, f.peak);
  assert.ok(f.statsCalls() >= 3);
});

test("low space permits identified cancellation to remove owned parts and retain its charged identity margin", async t => {
  const f = await uploadFixture(t), item = await f.upload.start(f.owner, f.input), row = await writePart(f, item);
  const dirname = path.join(f.root, row.objectKey);
  assert.deepEqual((await fs.readdir(dirname)).sort(), ["identity.json", "part-1.bin", "part-1.json"]);
  f.setFree(BigInt(f.peak - 1)); const samplesBeforeCancel = f.statsCalls();
  const result = await f.upload.cancel(f.owner, { uploadId: item.uploadId });
  assert.equal(result.state, "cancelled"); assert.equal(f.statsCalls(), samplesBeforeCancel);
  assert.deepEqual(await fs.readdir(dirname), ["identity.json"]);
  assert.equal((await f.api.summary({ context })).storageBytes, METADATA_MARGIN);
  assert.equal(f.store.snapshotForTest(f.owner.companyId).reservedBytes, 0);
  await f.upload.cancel(f.owner, { uploadId: item.uploadId });
  assert.equal((await f.api.summary({ context })).storageBytes, METADATA_MARGIN);
});

test("low space still refuses missing-identity recovery before creating metadata", async t => {
  const f = await uploadFixture(t, { wrapAdmission: base => ({ ...base, async reserve(binding) {
    await base.reserve(binding); throw new Error("synthetic-lost-storage-response-before-identity");
  } }) });
  await assert.rejects(f.upload.start(f.owner, f.input), { code: "import_provider_unavailable" });
  const row = Object.values(f.store.snapshotForTest(f.owner.companyId).uploads)[0];
  f.setFree(BigInt(f.peak - 1));
  await assert.rejects(f.upload.cancel(f.owner, { uploadId: row.uploadId }), { code: "import_cancellation_pending" });
  assert.deepEqual(await fs.readdir(f.root), []);
  assert.equal((await f.api.summary({ context })).storageBytes, f.peak);
  assert.equal(f.store.snapshotForTest(f.owner.companyId).uploads[row.uploadId].disk.cleanupVerified, undefined);
});

test("low-space cleanup retains unknown content, source files and another operation's lock", async t => {
  for (const name of ["unknown.txt", "source.bin", "operation.lock"]) await t.test(name, async local => {
    const f = await uploadFixture(local), item = await f.upload.start(f.owner, f.input), row = await writePart(f, item);
    const dirname = path.join(f.root, row.objectKey), marker = path.join(dirname, name);
    await fs.writeFile(marker, "preserve-synthetic-content", { flag: "wx" });
    const before = (await fs.readdir(dirname)).sort(); f.setFree(BigInt(f.peak - 1));
    await assert.rejects(f.upload.cancel(f.owner, { uploadId: item.uploadId }), { code: "import_cancellation_pending" });
    assert.deepEqual((await fs.readdir(dirname)).sort(), before);
    assert.equal(await fs.readFile(marker, "utf8"), "preserve-synthetic-content");
    assert.equal((await f.api.summary({ context })).storageBytes, f.peak);
    assert.equal(f.store.snapshotForTest(f.owner.companyId).uploads[item.uploadId].disk.cleanupVerified, undefined);
  });
});
