"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto"), fs = require("node:fs/promises"), path = require("node:path");
const { createOperationalCalendarPipelineFixture, PREFIX } = require("./helpers/operational-calendar-pipeline-fixture");
const { configureWorkflowPrivatePipeline } = require("./helpers/workflow-private-pipeline-fixture");
const { dateTime } = require("../src/social/calendar/model");
const options = { configurePrivatePipeline: configureWorkflowPrivatePipeline };
test("private Workflow: real PG and separated disk HTTP transfers → inspected photo → same calendar → controlled provider", async t => {
  const f = await createOperationalCalendarPipelineFixture(t, options), ready = await f.preparePhoto();
  assert.equal(ready.status.ready, true, JSON.stringify(ready.status));
  assert.equal(f.workflow.calls.length, 2, "one source inspection and one preparation");
  const records = await f.workflow.journal.records(); assert.equal(records.length, 2);
  for (const r of records) { assert.equal(r.delivered.state, "succeeded"); assert.equal(r.delivered.termination.proved, true); assert.equal(r.delivered.termination.descendants, 0); }
  const input = f.inputFor(ready), { assetId, ...body } = input;
  const response = await f.post(`${PREFIX}/assets/${assetId}/schedule`, body), value = await response.json();
  assert.equal(response.status, 200, JSON.stringify(value));
  f.advance(Math.max(0, dateTime(value.schedule.date, value.schedule.time) - f.clock()));
  await f.current().calendar.tick(); f.advance(60001); await f.current().calendar.tick();
  const row = await f.current().calendarStore.update(f.context.companyId, state => state.jobs[value.schedule.id]);
  assert.equal(row.phase, "published"); assert.equal(f.providerCalls.filter(c => c.operation === "publish").length, 2);
  for (const c of f.providerCalls.filter(c => c.operation === "create")) assert.equal(c.hash, ready.prepared.variants[c.target].sha256);
  assert.ok(!JSON.stringify([...f.workflow.sdkRuns.values()]).includes(f.context.companyId), "Workflow persisted args/results contain only opaque execution ID and closed status");
  const denied = await fetch(f.workflow.origin + "/internal/calendar-media/workflow/" + records[0].executionId + "/source"); assert.equal(denied.status, 409);
  t.diagnostic("WORKFLOW_API=CONTROLLED_SDK; PRIVATE_BYTES=ACTUAL_LOOPBACK_HTTP; PERSISTENCE=POSTGRESQL; CONVERSION=NATIVE_SEPARATE_PROCESS; INSTAGRAM=CONTROLLED_ONLY");
});
test("private Workflow: lost start response observes same execution; exclusive claimant and persisted derivative survive lookup", async t => {
  const f = await createOperationalCalendarPipelineFixture(t, options); f.workflow.loseNextStart();
  const ready = await f.preparePhoto(); assert.equal(ready.status.ready, true, JSON.stringify(ready.status));
  assert.equal(f.workflow.calls.length, 2);
  const records = await f.workflow.journal.records(); const r = records.find(v => v.kind === "prepare");
  const duplicate = f.workflow.clientFor(r.executionId); await assert.rejects(() => duplicate.claim(), /workflow_private_transfer_failed/);
  const observed = await f.preparationRunner.getByKey(r.task); assert.equal(observed.state, "succeeded"); assert.equal(f.workflow.calls.length, 2);
  const before = await f.preparedStore.inspectCommitted({ ...Object.fromEntries(["companyId", "userId", "assetId", "mediaRevision", "dispatchKey", "executionDigest"].map(k => [k, r.task[k]])), resultRef: r.resultRef });
  assert.equal(before.prepared.sourceSha256, r.task.source.sha256);
  await f.workflow.bridge.recover(r.executionId); assert.equal(f.workflow.calls.length, 2);
  const wrong = crypto.randomUUID(); await assert.rejects(() => f.workflow.journal.deliver(r.executionId, wrong, r.delivered), /claim_conflict/);
});
test("private Workflow: musical photo and original video derivatives returned privately with native decode receipts", async t => {
  const f = await createOperationalCalendarPipelineFixture(t, { ...options, syntheticMusic: true });
  const photo = await f.preparePhoto({ selection: { kind: "image", targets: ["feed", "story"], audioMode: "music", musicTrackId: "synthetic-local-tone", musicalTargets: ["story"] } });
  assert.equal(photo.status.ready, true, JSON.stringify(photo.status));
  const video = await f.prepareVideo({ selection: { kind: "video", targets: ["story", "reel"], audioMode: "original" } });
  assert.equal(video.status.ready, true, JSON.stringify(video.status));
  const records = (await f.workflow.journal.records()).filter(r => r.kind === "prepare");
  assert.equal(records.length, 2);
  for (const r of records) for (const p of Object.values(r.manifest.prepared.variants)) {
    assert.equal(r.manifest.inspections[p.sha256].decoded, true);
    assert.equal(r.manifest.inspections[p.sha256].sha256, p.sha256);
  }
});
