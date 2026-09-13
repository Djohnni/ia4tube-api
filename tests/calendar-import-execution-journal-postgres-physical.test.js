"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const { createOperationalMediaPostgresFixture } = require("./helpers/operational-media-postgres-fixture");
const { createImportUploadPostgresStore } = require("../src/social/calendar/imports/postgres-store");
const { createPreparationExecutionJournal } = require("../src/social/calendar/imports/preparation-execution-journal");
const { freshPreparationState } = require("../src/social/calendar/imports/preparation-queue");
const hash = () => crypto.randomBytes(32).toString("hex");

// This suite proves journal durability/claims, not media decoding. The integrated
// physical pipeline separately uses real process workers and actual byte results.
test("physical execution journal persists before dispatch, fences duplicates and survives a server restart", {
  skip: !process.env.CALENDAR_OPERATIONAL_MEDIA_TEST_PG_BIN, timeout: 90000
}, async t => {
  const f = await createOperationalMediaPostgresFixture(t);
  const companyId = await f.addCompany(), otherCompany = await f.addCompany(), userId = crypto.randomUUID();
  const owner = { companyId, userId }, time = Date.now(), clock = () => time;
  let store = createImportUploadPostgresStore({ pool: f.tenantPool }); assert.equal(await store.verify(), true);
  const task = { schema: 1, jobId: crypto.randomUUID(), companyId, userId, assetId: crypto.randomUUID(), uploadId: crypto.randomUUID(),
    mediaRevision: 1, dispatchKey: hash(), executionDigest: hash(), fence: 1, leaseToken: crypto.randomUUID(),
    deadlineAt: time + 180000, maxRuntimeMs: 180000, reservedOutputBytes: 1024,
    source: { sha256: hash(), objectKey: hash(), objectVersion: crypto.randomUUID(), sizeBytes: 128, inspection: {} },
    selection: { kind: "image", targets: ["feed"], audioMode: "none" }, plan: { targets: ["feed"], testOnly: false } };
  await store.update(companyId, state => {
    state.uploads[task.uploadId] = { uploadId: task.uploadId, companyId, userId, assetId: task.assetId, state: "uploaded" };
    const prep = freshPreparationState(), quotaMonth = new Date(time).toISOString().slice(0, 7);
    prep.months[quotaMonth] = { preparations: 1, reservedComputeMs: 180000, usedComputeMs: 0 };
    prep.jobs[task.jobId] = { jobId: task.jobId, companyId, userId, assetId: task.assetId, uploadId: task.uploadId, mediaRevision: 1,
      state: "dispatching", requestDigest: hash(), dispatchKey: task.dispatchKey, executionDigest: task.executionDigest, fence: 1,
      runtimeBudgetMs: 180000, reservedBytes: 1024, quotaMonth, source: task.source, selection: task.selection, plan: task.plan,
      lease: { token: task.leaseToken, fence: 1, startedAt: time, deadlineAt: task.deadlineAt } };
    prep.assets[task.assetId] = { assetId: task.assetId, companyId, userId, uploadId: task.uploadId, currentRevision: 1, revisions: { 1: task.jobId } };
    state.preparation = prep;
  });
  let journal = createPreparationExecutionJournal({ store, owner, clock }), record;
  await t.test("simultaneous independent journals commit one intent and one launch claim", async () => {
    const second = createPreparationExecutionJournal({ store: createImportUploadPostgresStore({ pool: f.tenantPool }), owner, clock });
    const starts = await Promise.all(Array.from({ length: 16 }, (_, index) => (index % 2 ? second : journal).begin(task)));
    assert.equal(starts.filter(value => value.created).length, 1); record = starts[0].record;
    assert.equal(new Set(starts.map(value => value.record.executionId)).size, 1);
    assert.equal(new Set(starts.map(value => value.record.resultRef)).size, 1);
    const capacityLeaseToken = crypto.randomUUID();
    const claims = await Promise.all(Array.from({ length: 16 }, (_, index) => (index % 2 ? second : journal)
      .claim({ ...task, executionId: record.executionId, capacityLeaseToken })));
    assert.equal(claims.filter(value => value.claimed).length, 1); record = claims[0].record;
    assert.equal(record.phase, "claimed");
  });
  await t.test("physical server stop/start preserves execution ID, result reference and non-stealable claim", async () => {
    await f.restart(); store = createImportUploadPostgresStore({ pool: f.tenantPool }); assert.equal(await store.verify(), true);
    journal = createPreparationExecutionJournal({ store, owner, clock });
    assert.deepEqual(await journal.getByKey(task), record);
    assert.equal((await journal.begin(task)).created, false);
    assert.equal((await journal.claim({ ...task, executionId: record.executionId, capacityLeaseToken: record.capacityLeaseToken })).claimed, false);
    assert.deepEqual(await journal.pending(), []);
  });
  await t.test("tenant RLS and exact user/key/task binding prevent cross-owner execution lookup or mutation", async () => {
    const other = createPreparationExecutionJournal({ store, owner: { companyId: otherCompany, userId }, clock });
    assert.equal(await other.getByKey(task), null);
    await assert.rejects(other.begin(task), { code: "preparation_execution_owner_invalid" });
    const otherUser = createPreparationExecutionJournal({ store, owner: { companyId, userId: crypto.randomUUID() }, clock });
    await assert.rejects(otherUser.getByKey(task), { code: "preparation_execution_binding_conflict" });
    await assert.rejects(journal.begin({ ...task, fence: 2 }), { code: "preparation_execution_binding_conflict" });
    assert.equal((await f.tenantPool.query("SELECT company_id FROM ia4tube_calendar.import_upload_state")).rowCount, 0);
    await assert.rejects(f.capacityPool.query("SELECT document FROM ia4tube_calendar.import_upload_state"), { code: "42501" });
    await assert.rejects(f.tenantPool.query("SET ROLE ia4tube_media_capacity_runtime"), { code: "42501" });
  });
  await t.test("unknown timeout is retained; unproved completion and wrong result cannot make a ready receipt", async () => {
    record = await journal.recordObservation({ ...task, executionId: record.executionId, state: "unknown" });
    assert.equal(record.completion, null); assert.equal(record.capacitySettled, false);
    await assert.rejects(journal.recordObservation({ ...task, executionId: record.executionId, state: "succeeded", resultRef: record.resultRef,
      termination: { proved: false, descendants: 0, proofId: hash() }, elapsedMs: 50 }), { code: "preparation_execution_termination_unproved" });
    await assert.rejects(journal.recordObservation({ ...task, executionId: record.executionId, state: "succeeded", resultRef: crypto.randomUUID(),
      termination: { proved: true, descendants: 0, proofId: hash() }, elapsedMs: 50 }), { code: "preparation_execution_observation_conflict" });
    assert.equal((await journal.getByKey(task)).phase, "unknown");
  });
  await t.test("terminal fact and settlement proof persist; late callbacks cannot regress or change a result", async () => {
    const termination = { proved: true, descendants: 0, proofId: hash() };
    record = await journal.recordObservation({ ...task, executionId: record.executionId, state: "succeeded", resultRef: record.resultRef, termination, elapsedMs: 50 });
    assert.equal(record.capacitySettled, false);
    await journal.markCapacitySettled({ ...task, executionId: record.executionId, proofId: termination.proofId });
    record = await journal.getByKey(task);
    assert.deepEqual(await journal.recordObservation({ ...task, executionId: record.executionId, state: "running" }), record);
    await assert.rejects(journal.recordObservation({ ...task, executionId: record.executionId, state: "failed", termination, elapsedMs: 50 }),
      { code: "preparation_execution_observation_conflict" });
    await f.reopenPools(); store = createImportUploadPostgresStore({ pool: f.tenantPool }); journal = createPreparationExecutionJournal({ store, owner, clock });
    assert.deepEqual(await journal.getByKey(task), record);
  });
  await t.test("invalid mutation is rolled back and no memory capability impersonates a durable store", async () => {
    await assert.rejects(store.update(companyId, state => { state.preparationExecutions.records[task.dispatchKey].task.userId = crypto.randomUUID(); }));
    assert.deepEqual(await journal.getByKey(task), record);
    assert.throws(() => createPreparationExecutionJournal({ store: { capabilities: { persistence: "durable", atomicCompanyUpdates: true }, update() {} }, owner }),
      { code: "preparation_execution_configuration_invalid" });
  });
  t.diagnostic(`PHYSICAL_PLATFORM=${f.platform}; POSTGRES_VERSION=${f.databaseVersion}; PROCESS_DECODING=NOT_ASSERTED_BY_JOURNAL_SUITE`);
});
