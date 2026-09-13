"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises");
const { createOperationalPrivatePipelineFixture, coordinator } = require("./helpers/operational-private-pipeline-fixture");

test("physical result committed before failed PostgreSQL acknowledgement is recovered, not encoded again", {
  skip: !process.env.CALENDAR_OPERATIONAL_MEDIA_TEST_PG_BIN || !(process.platform === "win32" || process.platform === "linux" && process.env.CALENDAR_MEDIA_LINUX_CGROUP_ROOT), timeout: 90000
}, async t => {
  const f = await createOperationalPrivatePipelineFixture(t);
  f.failNextPreparedObservationForTest();
  const photo = await f.preparePhoto();
  assert.equal(f.observationFailures(), 1);
  assert.equal(photo.status.ready, false); assert.equal(photo.status.state, "processing");
  const job = await f.jobFor(photo.assetId), record = (await f.snapshot()).preparationExecutions.records[job.dispatchKey];
  assert.equal(record.phase, "unknown"); assert.equal(record.capacitySettled, false); assert.equal(record.completion, null);
  const before = await f.capacity.summary({ context: coordinator }); assert.equal(before.activeJobs, 1);
  const processes = (await fs.readdir(f.executorRoot)).filter(name => /^[a-f0-9-]{36}$/.test(name)).sort();
  const sourceReads = structuredClone(f.counters);
  await f.reopen({ restartDatabase: true });
  const recovered = await f.preparation.reconcile(f.context, { assetId: photo.assetId, mediaRevision: 1 });
  assert.equal(recovered.ready, true, JSON.stringify(recovered));
  assert.equal((await f.actualFor(photo.assetId, 1)).resultRef, record.resultRef);
  assert.deepEqual((await fs.readdir(f.executorRoot)).filter(name => /^[a-f0-9-]{36}$/.test(name)).sort(), processes);
  assert.deepEqual(f.counters, sourceReads);
  const after = await f.capacity.summary({ context: coordinator }); assert.equal(after.activeJobs, 0);
  assert.equal(after.storageBytes, before.storageBytes); assert.equal(after.monthlyJobs, before.monthlyJobs);
  const terminal = (await f.snapshot()).preparationExecutions.records[job.dispatchKey];
  assert.equal(terminal.phase, "succeeded"); assert.equal(terminal.capacitySettled, true);
  assert.equal(terminal.executionId, record.executionId); assert.equal(terminal.completion.terminationProved, true);
});
