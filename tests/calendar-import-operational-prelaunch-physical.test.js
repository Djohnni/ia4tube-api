"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const { createOperationalPrivatePipelineFixture, coordinator } = require("./helpers/operational-private-pipeline-fixture");
const { createPreparationExecutionJournal } = require("../src/social/calendar/imports/preparation-execution-journal");
const { createOperationalPreparationRunner } = require("../src/social/calendar/imports/operational-preparation-runner");
const { createPreparedDiskAdmission, preparedTaskReservation } = require("../src/social/calendar/imports/prepared-disk-admission");
const { createDiskSpaceGuard } = require("../src/social/calendar/imports/disk-space-guard");
const { createGlobalMediaCapacity } = require("../src/social/calendar/imports/global-capacity");
const { freshPreparationState } = require("../src/social/calendar/imports/preparation-queue");
const hash = () => crypto.randomBytes(32).toString("hex");

// The facts asserted here all PRECEDE any media process. Real PostgreSQL/RLS,
// row locks and physical statfs are used; synthetic metadata is explicitly not
// evidence of successful decoding, which the separate pipeline suite proves.
test("physical prelaunch journal fence closes known failures without trusting process timeouts", {
  skip: !process.env.CALENDAR_OPERATIONAL_MEDIA_TEST_PG_BIN || !(process.platform === "win32" || process.platform === "linux" && process.env.CALENDAR_MEDIA_LINUX_CGROUP_ROOT), timeout: 90000
}, async t => {
  const f = await createOperationalPrivatePipelineFixture(t);
  const journal = () => createPreparationExecutionJournal({ store: f.store, owner: f.context, clock: f.clock });
  async function seedTask() {
    const { companyId, userId } = f.context, time = f.clock();
    const task = { schema: 1, jobId: crypto.randomUUID(), companyId, userId, assetId: crypto.randomUUID(), uploadId: crypto.randomUUID(),
      mediaRevision: 1, dispatchKey: hash(), executionDigest: hash(), fence: 1, leaseToken: crypto.randomUUID(),
      deadlineAt: time + 180000, maxRuntimeMs: 180000, reservedOutputBytes: 1024,
      source: { sha256: hash(), objectKey: hash(), objectVersion: crypto.randomUUID(), sizeBytes: 128, inspection: {} },
      selection: { kind: "image", targets: ["feed"], audioMode: "none" }, plan: { targets: ["feed"], testOnly: false } };
    await f.store.update(companyId, state => {
      state.uploads[task.uploadId] = { uploadId: task.uploadId, companyId, userId, assetId: task.assetId, state: "uploaded" };
      const prep = state.preparation || freshPreparationState(), quotaMonth = new Date(time).toISOString().slice(0, 7);
      prep.months[quotaMonth] ||= { preparations: 0, reservedComputeMs: 0, usedComputeMs: 0 };
      prep.months[quotaMonth].preparations++; prep.months[quotaMonth].reservedComputeMs += 180000;
      prep.jobs[task.jobId] = { jobId: task.jobId, companyId, userId, assetId: task.assetId, uploadId: task.uploadId, mediaRevision: 1,
        state: "dispatching", requestDigest: hash(), dispatchKey: task.dispatchKey, executionDigest: task.executionDigest, fence: 1,
        runtimeBudgetMs: 180000, reservedBytes: 1024, quotaMonth, source: task.source, selection: task.selection, plan: task.plan,
        lease: { token: task.leaseToken, fence: 1, startedAt: time, deadlineAt: task.deadlineAt } };
      prep.assets[task.assetId] = { assetId: task.assetId, companyId, userId, uploadId: task.uploadId, currentRevision: 1, revisions: { 1: task.jobId } };
      state.preparation = prep;
    });
    return task;
  }
  await t.test("physical free-space refusal after reservation settles execution, never reserved bytes", async () => {
    const task = await seedTask();
    // Actual filesystem observation with an intentionally impossible safety
    // margin. This does not fill the disk or replace statfs with fake values.
    const guard = createDiskSpaceGuard({ rootDirectory: f.privateRoot, enabled: true, marginBytes: Number.MAX_SAFE_INTEGER });
    const capacity = createGlobalMediaCapacity({ store: f.ledger, enabled: true, requireDiskSpaceEvidence: true, diskSpaceGuard: guard, clock: f.clock });
    const admission = createPreparedDiskAdmission({ capacity, tenantStore: f.store, accessPolicy: f.accessPolicy,
      rootDirectory: f.privateRoot, diskSpaceGuard: guard, enabled: true, clock: f.clock });
    const runner = createOperationalPreparationRunner({ store: f.store, owner: f.context, capacity, admission,
      accessPolicy: f.accessPolicy, getWorker: () => f.preparationWorker, enabled: true, clock: f.clock });
    const response = await runner.dispatch(task); assert.equal(response.state, "failed");
    const record = await journal().getByKey(task); assert.equal(record.completion.neverLaunched, true);
    assert.equal(record.capacitySettled, true); assert.equal(record.capacityLeaseToken, null);
    const slot = await capacity.inspect({ context: coordinator, jobId: task.jobId });
    assert.equal(slot.state, "cancelled"); assert.equal(slot.completion.actualRuntimeMs, 0);
    assert.equal(slot.storageHeld, true); assert.equal(slot.heldBytes, preparedTaskReservation(task).storageBytes);
    assert.equal(f.counters.preparationSourceReads, 0);
    await f.reopen({ restartDatabase: true });
    assert.equal((await f.preparationRunner.getByKey(task)).state, "failed");
    const summary = await f.capacity.summary({ context: coordinator }); assert.equal(summary.activeJobs, 0); assert.equal(summary.queuedJobs, 0);
  });
  await t.test("absent reservation receives permanent tombstone before a delayed reserve can arrive", async () => {
    const task = await seedTask(), j = journal(), initial = await j.begin(task);
    const closed = await j.failBeforeLaunch({ ...task, executionId: initial.record.executionId }); assert.equal(closed.failed, true);
    await f.capacity.closeNeverLaunched({ context: coordinator, journal: j, ...task });
    const late = await Promise.all(Array.from({ length: 12 }, () => f.capacity.reserve({ context: coordinator, ...preparedTaskReservation(task) })));
    assert.ok(late.every(value => value.state === "cancelled" && value.heldBytes === 0));
    assert.equal((await j.claim({ ...task, executionId: initial.record.executionId, capacityLeaseToken: crypto.randomUUID() })).claimed, false);
    await assert.rejects(f.capacity.closeNeverLaunched({ context: coordinator, journal: { ...j }, ...task }), { code: "media_capacity_never_launched_unproved" });
    assert.equal((await f.capacity.summary({ context: coordinator })).activeJobs, 0);
  });
  await t.test("restart after acquire but before journal claim closes only an unclaimed expired intent", async () => {
    const task = await seedTask(); await journal().begin(task);
    await f.capacity.reserve({ context: coordinator, ...preparedTaskReservation(task) });
    assert.equal((await f.capacity.acquireNext({ context: coordinator, expectedJobId: task.jobId })).state, "running");
    f.advance(180001); await f.reopen({ restartDatabase: true });
    const results = await f.preparationRunner.resumePending({ limit: 4 }); assert.equal(results.length, 1); assert.equal(results[0].state, "failed");
    const record = await journal().getByKey(task); assert.equal(record.completion.neverLaunched, true); assert.equal(record.capacitySettled, true);
    assert.equal((await f.capacity.summary({ context: coordinator })).activeJobs, 0);
    assert.equal((await f.capacity.inspect({ context: coordinator, jobId: task.jobId })).storageHeld, true);
  });
  await t.test("a competing genuine launch claim defeats closure even after its deadline", async () => {
    const task = await seedTask(), j = journal(), initial = await j.begin(task);
    await f.capacity.reserve({ context: coordinator, ...preparedTaskReservation(task) });
    const slot = await f.capacity.acquireNext({ context: coordinator, expectedJobId: task.jobId });
    assert.equal((await j.claim({ ...task, executionId: initial.record.executionId, capacityLeaseToken: slot.leaseToken })).claimed, true);
    f.advance(180001);
    const attempts = await Promise.all(Array.from({ length: 12 }, () => j.failBeforeLaunch({ ...task, executionId: initial.record.executionId })));
    assert.ok(attempts.every(value => value.failed === false && value.record.phase === "claimed"));
    await assert.rejects(f.capacity.closeNeverLaunched({ context: coordinator, journal: j, ...task }), { code: "media_capacity_never_launched_unproved" });
    assert.equal((await f.capacity.summary({ context: coordinator })).activeJobs, 1);
    assert.deepEqual(await j.pending(), []); assert.equal(f.counters.preparationSourceReads, 0);
  });
  t.diagnostic("PRELAUNCH_MEDIA_PROCESS_CALLS=0; PHYSICAL_POSTGRES_AND_STATFS=YES; CLAIMED_UNKNOWN_RELEASED=NO");
});
