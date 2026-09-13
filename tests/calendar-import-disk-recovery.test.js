"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
const { createGlobalMediaCapacity, freshGlobalCapacityState, validateGlobalCapacityState } = require("../src/social/calendar/imports/global-capacity");
const { createRenderDiskAdmission, renderDiskCapacityIdentity, METADATA_MARGIN } = require("../src/social/calendar/imports/render-disk-admission");
const { createRenderDiskPrivateUploadProvider } = require("../src/social/calendar/imports/render-disk-provider");
const { createMemoryImportUploadStore } = require("../src/social/calendar/imports/memory-adapters");
const { createCalendarImportUploadService } = require("../src/social/calendar/imports/upload-service");
const bytes = Buffer.from("SYNTHETIC_INITIALIZATION_RECOVERY_ONLY"), sourceSha256 = crypto.createHash("sha256").update(bytes).digest("hex");
const coordinator = Object.freeze({ authenticated: true, role: "calendar_media_capacity_coordinator" });
function gate() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function globalStore() {
  let state = freshGlobalCapacityState(), tail = Promise.resolve();
  return { capabilities: { persistence: "volatile", atomicGlobalUpdates: true, testOnly: true },
    update(mutation) {
      const result = tail.then(() => {
        const next = structuredClone(state), value = mutation(next);
        assert.notEqual(typeof value?.then, "function"); validateGlobalCapacityState(next);
        state = next; return structuredClone(value);
      });
      tail = result.catch(() => {}); return result;
    }, snapshot() { return structuredClone(state); } };
}
async function fixture(t, { wrapAdmission = value => value, wrapProvider = value => value } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iA4tube-disk-recovery-")); await fs.chmod(root, 0o700);
  t.after(async () => {
    const target = path.resolve(root);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith("iA4tube-disk-recovery-"));
    await fs.rm(target, { recursive: true, force: true });
  });
  const store = createMemoryImportUploadStore(), ledger = globalStore(); let time = 1789260000000;
  const context = { authenticated: true, companyId: crypto.randomUUID(), userId: crypto.randomUUID() };
  const clock = () => time;
  const capacity = createGlobalMediaCapacity({ store: ledger, enabled: true, allowVolatileForTests: true, clock });
  const admission = createRenderDiskAdmission({ rootDirectory: root, store, capacity, coordinatorContext: coordinator,
    enabled: true, allowVolatileForTests: true });
  const inspector = { capabilities: { isolated: true, bounded: true, remoteObjectInspection: true },
    async startInspection() { assert.fail("recovery must not dispatch inspection"); },
    async getInspection() { assert.fail("recovery must not poll inspection"); } };
  const f = { root, store, ledger, capacity, context,
    input: { idempotencyKey: crypto.randomUUID(), kind: "image", mimeType: "image/jpeg", sizeBytes: bytes.length, sha256: sourceSha256 },
    row() { return Object.values(store.snapshotForTest(context.companyId).uploads)[0]; },
    directory() { return path.join(root, f.row().objectKey); },
    advance(ms) { time += ms; },
    binding() { const row = f.row(); return { reservationKey: `disk:${row.assetId}`, companyId: row.companyId,
      userId: row.userId, assetId: row.assetId, sourceSha256: row.sha256, sourceBytes: row.sizeBytes,
      peakBytes: row.sizeBytes * 2 + METADATA_MARGIN }; },
    beginArgs() { const row = f.row(); return { context, objectKey: row.objectKey, assetId: row.assetId,
      sizeBytes: row.sizeBytes, chunkBytes: row.chunkBytes, checksumAlgorithm: "SHA256" }; },
    async usage() { return capacity.summary({ context: coordinator }); },
    async job() { return capacity.inspect({ context: coordinator, jobId: renderDiskCapacityIdentity(f.binding()).jobId }); },
    restart() {
      f.provider = createRenderDiskPrivateUploadProvider({ rootDirectory: root, store, admission: wrapAdmission(admission, f),
        inspector, transferOrigin: "https://ia4tube-api.onrender.com", enabled: true, allowVolatileForTests: true, clock });
      f.service = createCalendarImportUploadService({ store, provider: wrapProvider(f.provider, f), enabled: true,
        allowVolatileForTests: true, clock });
    } };
  f.restart(); return f;
}
async function lostReservationFixture(t, { emptyDirectory = false } = {}) {
  let first = true;
  const f = await fixture(t, { wrapAdmission: (base, local) => ({ ...base, async reserve(binding) {
    const result = await base.reserve(binding);
    if (first) {
      first = false;
      if (emptyDirectory) await fs.mkdir(local.directory(), { mode: 0o700 });
      throw new Error("synthetic-lost-global-reservation-response");
    }
    return result;
  } }) });
  await assert.rejects(f.service.start(f.context, f.input), { code: "import_provider_unavailable" });
  assert.equal(f.row().disk.phase, "created");
  assert.equal((await f.usage()).storageBytes, f.binding().peakBytes);
  assert.equal(Object.keys(f.ledger.snapshot().jobs).length, 1);
  assert.deepEqual(await fs.readdir(f.root), emptyDirectory ? [f.row().objectKey] : []);
  if (emptyDirectory) assert.deepEqual(await fs.readdir(f.directory()), []);
  return f;
}
async function assertCancelledTombstone(f) {
  assert.equal(f.row().state, "cancelled"); assert.equal(f.row().disk.phase, "aborted");
  assert.deepEqual(await fs.readdir(f.directory()), ["identity.json"]);
  const identity = JSON.parse(await fs.readFile(path.join(f.directory(), "identity.json"), "utf8"));
  assert.deepEqual(identity, { ...f.binding(), uploadId: f.row().disk.uploadId, objectVersion: f.row().disk.objectVersion });
  const job = await f.job(); assert.equal(job.heldBytes, METADATA_MARGIN); assert.equal(job.storageHeld, true);
  assert.equal(job.state, "storage_cancel_requested");
  const usage = await f.usage(); assert.equal(usage.storageBytes, METADATA_MARGIN);
  assert.equal(usage.monthlyJobs, 0); assert.equal(usage.runtimeMs, 0); assert.equal(usage.activeJobs, 0);
  assert.equal(usage.queuedJobs, 0); assert.equal(Object.keys(f.ledger.snapshot().jobs).length, 1);
  assert.equal(f.store.snapshotForTest(f.context.companyId).reservedBytes, 0);
  assert.equal(f.provider.getCapabilities().readyForProduction, false);
}

test("lost reservation response recovers the same initialization or cancels under a new exclusive object lock", async t => {
  for (const emptyDirectory of [false, true]) for (const action of ["retry", "cancel"]) {
    await t.test(`${emptyDirectory ? "empty" : "absent"} directory: ${action}`, async local => {
      const f = await lostReservationFixture(local, { emptyDirectory }), before = f.row(); f.restart();
      if (action === "retry") {
        const retried = await f.service.start(f.context, f.input);
        assert.equal(retried.uploadId, before.uploadId); assert.equal(retried.state, "uploading");
        assert.equal(f.row().disk.uploadId, before.disk.uploadId); assert.equal(f.row().disk.objectVersion, before.disk.objectVersion);
        assert.equal((await f.usage()).storageBytes, f.binding().peakBytes);
        assert.deepEqual(await fs.readdir(f.directory()), ["identity.json"]);
      }
      await f.service.cancel(f.context, { uploadId: before.uploadId }); await assertCancelledTombstone(f);
      await f.service.cancel(f.context, { uploadId: before.uploadId }); await assertCancelledTombstone(f);
      await assert.rejects(f.provider.beginMultipart(f.beginArgs()), { code: "disk_state_conflict" });
    });
  }
});

test("lost provider initialization response reuses the already installed receipt and provider identity", async t => {
  let first = true;
  const f = await fixture(t, { wrapProvider: base => ({ ...base, async beginMultipart(args) {
    const result = await base.beginMultipart(args);
    if (first) { first = false; throw new Error("synthetic-lost-initialization-response"); }
    return result;
  } }) });
  await assert.rejects(f.service.start(f.context, f.input), { code: "import_provider_unavailable" });
  const initial = f.row(), receipt = await fs.readFile(path.join(f.directory(), "identity.json"), "utf8");
  assert.equal(initial.state, "created"); assert.equal(initial.disk.phase, "open"); f.restart();
  const retried = await f.service.start(f.context, f.input);
  assert.equal(retried.uploadId, initial.uploadId); assert.equal(f.row().disk.uploadId, initial.disk.uploadId);
  assert.equal(f.row().disk.objectVersion, initial.disk.objectVersion);
  assert.equal(await fs.readFile(path.join(f.directory(), "identity.json"), "utf8"), receipt);
  assert.equal(Object.keys(f.ledger.snapshot().jobs).length, 1);
});

test("a missing reservation cannot create recovery files or claim quota release", async t => {
  const f = await fixture(t, { wrapAdmission: base => ({ ...base, async reserve() { throw new Error("synthetic-no-global-commit"); } }) });
  await assert.rejects(f.service.start(f.context, f.input), { code: "import_provider_unavailable" });
  await assert.rejects(f.service.cancel(f.context, { uploadId: f.row().uploadId }), { code: "import_cancellation_pending" });
  assert.deepEqual(await fs.readdir(f.root), []); assert.equal(Object.keys(f.ledger.snapshot().jobs).length, 0);
  assert.equal((await f.usage()).storageBytes, 0);
  assert.equal(f.store.snapshotForTest(f.context.companyId).reservedBytes, bytes.length);
  assert.equal(f.row().disk.cleanupVerified, undefined); assert.equal(f.row().disk.phase, "created");
});

test("unknown, pending, source and existing-lock files block identity adoption and keep every reservation", async t => {
  for (const name of ["unrecognized.txt", "part-1.bin", "source.bin", "identity.json.synthetic.pending", "operation.lock"]) {
    await t.test(name, async local => {
      const f = await lostReservationFixture(local, { emptyDirectory: true });
      const marker = path.join(f.directory(), name), value = `synthetic-preserve-${name}`;
      await fs.writeFile(marker, value, { flag: "wx" });
      // Even an old lock is retained. Elapsed wall time is never ownership proof.
      if (name === "operation.lock") await fs.utimes(marker, new Date(0), new Date(0));
      f.restart();
      await assert.rejects(f.provider.beginMultipart(f.beginArgs()),
        { code: name === "operation.lock" ? "disk_operation_busy_or_recovery_required" : "disk_initialization_recovery_required" });
      await assert.rejects(f.service.cancel(f.context, { uploadId: f.row().uploadId }), { code: "import_cancellation_pending" });
      assert.deepEqual(await fs.readdir(f.directory()), [name]); assert.equal(await fs.readFile(marker, "utf8"), value);
      assert.equal((await f.usage()).storageBytes, f.binding().peakBytes);
      assert.equal((await f.job()).state, "storage_reserved"); assert.equal(f.row().disk.cleanupVerified, undefined);
    });
  }
});

test("an open session with a subsequently missing identity is refused even when its directory is empty", async t => {
  const f = await fixture(t); await f.service.start(f.context, f.input);
  // Remove exactly this fixture's generated receipt to model external loss.
  await fs.unlink(path.join(f.directory(), "identity.json"));
  await assert.rejects(f.provider.beginMultipart(f.beginArgs()), { code: "disk_initialization_recovery_required" });
  await assert.rejects(f.service.cancel(f.context, { uploadId: f.row().uploadId }), { code: "import_cancellation_pending" });
  assert.deepEqual(await fs.readdir(f.directory()), []);
  assert.equal((await f.usage()).storageBytes, f.binding().peakBytes);
});

test("another owner cannot initialize or cancel a recovery candidate", async t => {
  const f = await lostReservationFixture(t, { emptyDirectory: true });
  for (const context of [{ ...f.context, userId: crypto.randomUUID() }, { ...f.context, companyId: crypto.randomUUID() }]) {
    await assert.rejects(f.provider.beginMultipart({ ...f.beginArgs(), context }), { code: "disk_owner_invalid" });
    await assert.rejects(f.provider.abortMultipart({ context, objectKey: f.row().objectKey }), { code: "disk_owner_invalid" });
  }
  assert.deepEqual(await fs.readdir(f.directory()), []); assert.equal((await f.usage()).storageBytes, f.binding().peakBytes);
});

test("cancellation wins while initialization waits for a reserved-storage response", async t => {
  const reserved = gate(), resume = gate();
  const f = await fixture(t, { wrapAdmission: base => ({ ...base, async reserve(binding) {
    const result = await base.reserve(binding); reserved.resolve(); await resume.promise; return result;
  } }) });
  t.after(() => resume.resolve());
  const initialized = f.service.start(f.context, f.input).then(value => ({ value }), error => ({ error }));
  await reserved.promise; f.advance(300001);
  await f.service.cancel(f.context, { uploadId: f.row().uploadId }); await assertCancelledTombstone(f);
  const receipt = await fs.readFile(path.join(f.directory(), "identity.json"), "utf8");
  resume.resolve(); assert.equal((await initialized).error?.code, "import_provider_unavailable");
  await assertCancelledTombstone(f);
  assert.equal(await fs.readFile(path.join(f.directory(), "identity.json"), "utf8"), receipt);
});

test("an initializing writer keeps its real lock when a cancellation lease supersedes it", async t => {
  const locked = gate(), resume = gate(); let checks = 0;
  const f = await fixture(t, { wrapAdmission: base => ({ ...base, async assertHeld(binding, options) {
    const result = await base.assertHeld(binding, options);
    if (++checks === 2) { locked.resolve(); await resume.promise; }
    return result;
  } }) });
  t.after(() => resume.resolve());
  const initialized = f.service.start(f.context, f.input).then(value => ({ value }), error => ({ error }));
  await locked.promise;
  assert.deepEqual(await fs.readdir(f.directory()), ["operation.lock"]);
  const lockBefore = await fs.stat(path.join(f.directory(), "operation.lock"));
  f.advance(300001);
  await assert.rejects(f.service.cancel(f.context, { uploadId: f.row().uploadId }), { code: "import_cancellation_pending" });
  const lockAfter = await fs.stat(path.join(f.directory(), "operation.lock"));
  assert.equal(lockAfter.ino, lockBefore.ino); assert.equal(lockAfter.dev, lockBefore.dev);
  assert.equal((await f.usage()).storageBytes, f.binding().peakBytes); assert.equal(f.row().disk.cleanupVerified, undefined);
  resume.resolve(); assert.equal((await initialized).error?.code, "import_provider_unavailable");
  assert.equal(f.row().state, "cancel_pending"); assert.equal(f.row().disk.phase, "created");
  await f.service.cancel(f.context, { uploadId: f.row().uploadId }); await assertCancelledTombstone(f);
});
