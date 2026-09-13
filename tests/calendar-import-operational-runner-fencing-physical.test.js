"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createOperationalPrivatePipelineFixture, coordinator } = require("./helpers/operational-private-pipeline-fixture");
const { createOperationalPreparationRunner } = require("../src/social/calendar/imports/operational-preparation-runner");
const { createImportUploadPostgresStore } = require("../src/social/calendar/imports/postgres-store");

test("physical preparation runner duplicates and revocation cannot launch another process or prematurely free its slot", {
  skip: !process.env.CALENDAR_OPERATIONAL_MEDIA_TEST_PG_BIN || !(process.platform === "win32" || process.platform === "linux" && process.env.CALENDAR_MEDIA_LINUX_CGROUP_ROOT), timeout: 90000
}, async t => {
  let entered, release;
  const blocked = new Promise(resolve => { entered = resolve; }), resumed = new Promise(resolve => { release = resolve; });
  const f = await createOperationalPrivatePipelineFixture(t, { async beforePreparationSourceRead() { entered(); await resumed; } });
  const pending = f.preparePhoto();
  try {
    await blocked;
    const state = await f.snapshot(), record = Object.values(state.preparationExecutions.records)[0];
    assert.equal(record.launchClaimed, true); assert.equal(record.phase, "claimed");
    const reopened = createOperationalPreparationRunner({ store: createImportUploadPostgresStore({ pool: f.pg.tenantPool }), owner: f.context,
      capacity: f.capacity, admission: f.preparedAdmission, accessPolicy: f.accessPolicy, getWorker: () => f.preparationWorker, enabled: true });
    const results = await Promise.all(Array.from({ length: 12 }, () => reopened.dispatch(record.task)));
    assert.ok(results.every(value => value.state === "running" && value.executionId === record.executionId));
    assert.equal(f.counters.preparationSourceReads, 1);
    const held = await f.capacity.summary({ context: coordinator }); assert.equal(held.activeJobs, 1);
    f.revoke();
    await assert.rejects(reopened.dispatch(record.task));
    assert.equal((await reopened.getByKey(record.task)).state, "running");
    assert.equal((await f.capacity.summary({ context: coordinator })).activeJobs, 1);
    release();
    // The revoked user cannot read the completed queue response, but its real
    // worker must still terminate and its already-issued slot must be settled.
    await pending.catch(() => {});
    assert.equal((await reopened.getByKey(record.task)).state, "failed");
    const ended = await f.capacity.summary({ context: coordinator });
    assert.equal(ended.activeJobs, 0); assert.equal(ended.storageBytes, held.storageBytes);
    assert.equal(ended.monthlyJobs, held.monthlyJobs); assert.equal(f.counters.preparationSourceReads, 1);
    const durable = (await f.snapshot()).preparationExecutions.records[record.task.dispatchKey];
    assert.equal(durable.phase, "failed"); assert.equal(durable.completion.terminationProved, true); assert.equal(durable.capacitySettled, true);
  } finally { release(); await pending.catch(() => {}); }
});
