"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
const { createMemoryImportUploadStore } = require("../src/social/calendar/imports/memory-adapters");
const { createImportAccessPolicy } = require("../src/social/calendar/imports/access-policy");
const { createGlobalMediaCapacity, freshGlobalCapacityState, validateGlobalCapacityState } = require("../src/social/calendar/imports/global-capacity");
const { createDiskSpaceGuardForTests } = require("../src/social/calendar/imports/disk-space-guard");
const { createPreparedDiskAdmission, preparedTaskReservation, isPreparedDiskAdmission } = require("../src/social/calendar/imports/prepared-disk-admission");
const ctx = { authenticated: true, role: "calendar_media_capacity_coordinator" };
function globalStore() {
  let state = freshGlobalCapacityState(), tail = Promise.resolve();
  return { capabilities: { persistence: "volatile", atomicGlobalUpdates: true, testOnly: true },
    update(fn) { const pending = tail.then(() => { const next = structuredClone(state), result = fn(next); validateGlobalCapacityState(next); state = next; return structuredClone(result); });
      tail = pending.catch(() => {}); return pending; } };
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iA4tube-prepared-admission-")); await fs.chmod(root, 0o700);
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("iA4tube-prepared-admission-"));
    assert.equal((await fs.lstat(root)).isSymbolicLink(), false); await fs.rm(root, { recursive: true, force: true }); });
  let time = Date.now(), eligible = true, free = 1024n ** 3n;
  const task = { schema: 1, jobId: crypto.randomUUID(), companyId: crypto.randomUUID(), userId: crypto.randomUUID(), assetId: crypto.randomUUID(),
    uploadId: crypto.randomUUID(), mediaRevision: 1, dispatchKey: "d".repeat(64), executionDigest: "e".repeat(64), fence: 1, leaseToken: crypto.randomUUID(),
    deadlineAt: time + 180000, maxRuntimeMs: 180000, source: { objectKey: "a".repeat(64), objectVersion: crypto.randomUUID(), sha256: "b".repeat(64), sizeBytes: 100 },
    selection: { kind: "image", targets: ["feed"], audioMode: "none" }, plan: { schema: 1 }, reservedOutputBytes: 1000 };
  const tenantStore = createMemoryImportUploadStore(), store = globalStore();
  await tenantStore.update(task.companyId, state => {
    state.uploads[task.uploadId] = { uploadId: task.uploadId, companyId: task.companyId, userId: task.userId, assetId: task.assetId, state: "uploaded" };
    state.preparation = { jobs: { [task.jobId]: { ...task, state: "dispatching", runtimeBudgetMs: task.maxRuntimeMs, reservedBytes: task.reservedOutputBytes,
      lease: { token: task.leaseToken, deadlineAt: task.deadlineAt } } } };
  });
  const diskSpaceGuard = createDiskSpaceGuardForTests({ rootDirectory: root, enabled: true, marginBytes: 0, statfsForTests: async () => ({ bavail: free, bsize: 1n }) });
  const capacity = createGlobalMediaCapacity({ store, enabled: true, allowVolatileForTests: true, requireDiskSpaceEvidence: true, diskSpaceGuard, clock: () => time });
  const accessPolicy = createImportAccessPolicy({ allowedOwners: [task], isEligible: () => eligible });
  const options = { capacity, tenantStore, accessPolicy, rootDirectory: root, diskSpaceGuard, enabled: true, allowVolatileForTests: true, clock: () => time };
  const admission = createPreparedDiskAdmission(options), resultRef = crypto.randomUUID();
  return { root, task, resultRef, tenantStore, capacity, options, admission,
    setFree(value) { free = value; }, revoke() { eligible = false; }, advance(ms) { time += ms; },
    async run() { await admission.reserve(task); return capacity.acquireNext({ context: ctx }); },
    args(patch = {}) { return { task, resultRef, requiredBytes: 1000, intent: "write", ...patch }; } };
}
test("prepared admission requires a real matching guard, shared capacity and explicit volatile opt-in", async t => {
  const f = await fixture(t);
  assert.equal(isPreparedDiskAdmission(f.admission, { rootDirectory: f.root, allowVolatileForTests: true }), true);
  assert.equal(isPreparedDiskAdmission({ ...f.admission }, { allowVolatileForTests: true }), false);
  assert.equal(isPreparedDiskAdmission(f.admission), false);
  for (const patch of [{ enabled: false }, { diskSpaceGuard: { ...f.options.diskSpaceGuard } }, { allowVolatileForTests: false }, { rootDirectory: path.dirname(f.root) }]) {
    await assert.rejects(createPreparedDiskAdmission({ ...f.options, ...patch }).reserve(f.task));
  }
  assert.equal((await f.capacity.summary({ context: ctx })).monthlyJobs, 0);
});
test("reservation is idempotent and does not acquire execution; actual running receipt is mandatory for writes", async t => {
  const f = await fixture(t);
  const receipts = await Promise.all(Array.from({ length: 10 }, () => f.admission.reserve(f.task)));
  assert.ok(receipts.every(value => value.storageBytes === 67736));
  assert.equal((await f.capacity.summary({ context: ctx })).monthlyJobs, 1);
  await assert.rejects(f.admission.assertHeld(f.args()), { code: "prepared_admission_reservation_invalid" });
  await f.capacity.acquireNext({ context: ctx });
  assert.equal(await f.admission.assertHeld(f.args()), true);
  await assert.rejects(f.admission.assertHeld(f.args({ requiredBytes: 67737 })), { code: "prepared_admission_reservation_invalid" });
  assert.equal((await fs.readdir(f.root)).length, 0);
});
test("wrong owner, source, fence, lease and plan cannot borrow a held preparation reservation", async t => {
  const f = await fixture(t); await f.run();
  for (const patch of [{ companyId: crypto.randomUUID() }, { userId: crypto.randomUUID() }, { fence: 2 }, { leaseToken: crypto.randomUUID() },
    { executionDigest: "f".repeat(64) }, { plan: { schema: 2 } }, { source: { ...f.task.source, sha256: "c".repeat(64) } }]) {
    await assert.rejects(f.admission.assertHeld(f.args({ task: { ...f.task, ...patch } })));
  }
  f.revoke(); await assert.rejects(f.admission.assertHeld(f.args()), { code: "prepared_admission_owner_invalid" });
});
test("equivalent JSONB object key ordering preserves the exact admitted task", async t => {
  const f = await fixture(t); await f.run();
  const reverse = object => Object.fromEntries(Object.entries(object).reverse());
  assert.equal(await f.admission.assertHeld(f.args({ task: { ...f.task, source: reverse(f.task.source), selection: reverse(f.task.selection), plan: reverse(f.task.plan) } })), true);
});
test("free space and both deadlines are rechecked while held read does not require new headroom", async t => {
  const f = await fixture(t); await f.run();
  f.setFree(1n); await assert.rejects(f.admission.assertHeld(f.args()));
  assert.equal(await f.admission.assertHeld(f.args({ intent: "read" })), true);
  f.setFree(1024n ** 3n); f.advance(180001);
  await assert.rejects(f.admission.assertHeld(f.args()), { code: "prepared_admission_deadline_exceeded" });
  assert.equal((await f.capacity.inspect({ context: ctx, jobId: f.task.jobId })).state, "running");
});
test("committed results stay readable through the exact completed fence while new writes and cancelled jobs fail", async t => {
  const f = await fixture(t), run = await f.run();
  await f.tenantStore.update(f.task.companyId, state => {
    const job = state.preparation.jobs[f.task.jobId]; job.state = "ready"; job.completedFence = job.fence; job.completedToken = job.lease.token;
    job.lease = null; job.result = { resultRef: f.resultRef };
  });
  await f.capacity.recordCompletion({ context: ctx, jobId: f.task.jobId, leaseToken: run.leaseToken, outcome: "succeeded", actualRuntimeMs: 100, proofId: "f".repeat(64) });
  assert.equal(await f.admission.assertHeld(f.args({ intent: "read" })), true);
  await assert.rejects(f.admission.assertHeld(f.args()));
  await assert.rejects(f.admission.assertHeld(f.args({ intent: "read", resultRef: crypto.randomUUID() })));
  const second = await fixture(t); await second.run(); await second.capacity.cancel({ context: ctx, jobId: second.task.jobId });
  await assert.rejects(second.admission.assertHeld(second.args()));
});
test("malformed tasks and raw provider failures never expose caller supplied error content", async t => {
  const f = await fixture(t);
  assert.throws(() => preparedTaskReservation({ ...f.task, source: { ...f.task.source, sizeBytes: Infinity } }));
  const bad = createPreparedDiskAdmission({ ...f.options, capacity: { ...f.capacity, reserve: async () => { throw new Error("secret-filesystem-token"); } } });
  await assert.rejects(bad.reserve(f.task), error => error.code === "prepared_admission_unavailable" && !/secret|token/.test(error.message));
});
