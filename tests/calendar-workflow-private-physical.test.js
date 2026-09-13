"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto"), fs = require("node:fs/promises"), path = require("node:path");
const { createOperationalCalendarPipelineFixture, PREFIX } = require("./helpers/operational-calendar-pipeline-fixture");
const { configureWorkflowPrivatePipeline } = require("./helpers/workflow-private-pipeline-fixture");
const { dateTime } = require("../src/social/calendar/model");
const http = require("node:http");
const options = { configurePrivatePipeline: configureWorkflowPrivatePipeline };
test("private Workflow: real PG and separated disk HTTP transfers → inspected photo → same calendar → controlled provider", async t => {
  const f = await createOperationalCalendarPipelineFixture(t, options), ready = await f.workflow.finishPrepared(await f.preparePhoto());
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
  const ready = await f.preparePhoto(); assert.equal(ready.status.ready, false, "A lost start acknowledgement is not fabricated as immediate success");
  const reconciled = (await f.workflow.finishPrepared(ready)).status;
  assert.equal(reconciled.ready, true, JSON.stringify(reconciled));
  assert.equal(f.workflow.calls.length, 2);
  const records = await f.workflow.journal.records(); const r = records.find(v => v.kind === "prepare");
  const duplicate = f.workflow.clientFor(r.executionId); await assert.rejects(() => duplicate.claim(), /workflow_private_transfer_failed/);
  const observed = await f.preparationRunner.getByKey(r.task); assert.equal(observed.state, "succeeded"); assert.equal(f.workflow.calls.length, 2);
  const before = await f.preparedStore.inspectCommitted({ ...Object.fromEntries(["companyId", "userId", "assetId", "mediaRevision", "dispatchKey", "executionDigest"].map(k => [k, r.task[k]])), resultRef: r.resultRef });
  assert.equal(before.prepared.sourceSha256, r.task.source.sha256);
  await f.workflow.bridge.recover(r.executionId); assert.equal(f.workflow.calls.length, 2);
  const wrong = crypto.randomUUID(); await assert.rejects(() => f.workflow.journal.deliver(r.executionId, wrong, r.delivered), /claim_conflict/);
});
test("private Workflow: authenticated slow body has total deadline and disconnected requests release transfer slots", async t => {
  const f = await createOperationalCalendarPipelineFixture(t, { ...options, bridgeTimeoutMs: 2000 });
  const ready = await f.workflow.finishPrepared(await f.preparePhoto()); assert.equal(ready.status.ready, true);
  const r = (await f.workflow.journal.records())[0], started = performance.now();
  async function partial(disconnect) {
    return new Promise(resolve => {
      const agentId = crypto.randomUUID(), length = 4096, sha256 = crypto.createHash("sha256").update(Buffer.alloc(length, 32)).digest("hex");
      const headers = f.workflow.headersForSyntheticTest({ executionId: r.executionId, agentId, method: "POST", resource: "claim", length, sha256 });
      const req = http.request(f.workflow.origin + "/internal/calendar-media/workflow/" + r.executionId + "/claim", { method: "POST", headers });
      let timer; const done = () => { clearInterval(timer); resolve(); };
      req.on("error", done); req.on("close", done); req.on("response", res => { res.resume(); res.on("end", done); });
      req.write(" "); timer = setInterval(() => req.write(" "), 25);
      if (disconnect) setTimeout(() => req.destroy(), 100);
    });
  }
  await partial(false); const elapsed = performance.now() - started;
  assert.ok(elapsed >= 1500 && elapsed < 5000, `Bounded continuous sender stopped at ${Math.round(elapsed)}ms`);
  await Promise.all([partial(true), partial(true)]);
  assert.deepEqual(await f.workflow.clientFor(r.executionId, r.agentId).status(), { delivered: true });
  const unchanged = await f.workflow.journal.get(r.executionId); assert.deepEqual(unchanged.delivered, r.delivered);
  await assert.rejects(() => f.workflow.clientFor(r.executionId, r.agentId).manifest({ ...r.manifest, executionId: crypto.randomUUID() }), /transfer_failed/);
  assert.deepEqual((await f.workflow.journal.get(r.executionId)).manifest, r.manifest);
  t.diagnostic("PRIVATE_TRANSFER_TOTAL_DEADLINE=PROVED; CONTINUOUS_IDLE_RESET=INEFFECTIVE; CLOSED_CLIENT_SLOTS=REUSABLE; ORIGINAL_RECEIPT=UNCHANGED");
});
test("private Workflow: musical photo and original video derivatives returned privately with native decode receipts", async t => {
  const f = await createOperationalCalendarPipelineFixture(t, { ...options, syntheticMusic: true });
  const photo = await f.workflow.finishPrepared(await f.preparePhoto({ selection: { kind: "image", targets: ["feed", "story"], audioMode: "music", musicTrackId: "synthetic-local-tone", musicalTargets: ["story"] } }));
  assert.equal(photo.status.ready, true, JSON.stringify(photo.status));
  const video = await f.workflow.finishPrepared(await f.prepareVideo({ selection: { kind: "video", targets: ["story", "reel"], audioMode: "original" } }));
  assert.equal(video.status.ready, true, JSON.stringify(video.status));
  const records = (await f.workflow.journal.records()).filter(r => r.kind === "prepare");
  assert.equal(records.length, 2);
  for (const r of records) for (const p of Object.values(r.manifest.prepared.variants)) {
    assert.equal(r.manifest.inspections[p.sha256].decoded, true);
    assert.equal(r.manifest.inspections[p.sha256].sha256, p.sha256);
  }
});

test("private Workflow: asynchronous start progresses only through finite owner tick; overlap and unconfirmed run never duplicate or free capacity", async t => {
  const f = await createOperationalCalendarPipelineFixture(t, { ...options, asynchronousSdk: true });
  const bytes = await require("sharp")({ create: { width: 96, height: 160, channels: 3, background: "#24678a" } }).png().toBuffer();
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const started = await f.upload.start(f.context, { idempotencyKey: crypto.randomUUID(), kind: "image", mimeType: "image/png", sizeBytes: bytes.length, sha256 });
  const grant = await f.upload.authorizePart(f.context, { uploadId: started.uploadId, partNumber: 1, sha256, md5Base64: crypto.createHash("md5").update(bytes).digest("base64") });
  const uploadRecord = (await f.snapshot()).uploads[started.uploadId];
  await f.provider.acceptPart({ context: f.context, objectKey: uploadRecord.objectKey, uploadId: uploadRecord.disk.uploadId, partNumber: 1,
    authorizationId: grant.authorizationId, contentLength: bytes.length, stream: require("node:stream").Readable.from([bytes]) });
  await assert.rejects(() => f.upload.complete(f.context, { uploadId: started.uploadId }), error => error.code === "import_verification_pending");
  assert.equal(f.workflow.calls.length, 1); assert.equal([...f.workflow.sdkRuns.values()][0].status, "running");
  await f.workflow.awaitTasks(); await f.workflow.tick();
  assert.equal((await f.upload.status(f.context, { uploadId: started.uploadId })).state, "uploaded");
  const requested = await f.preparation.request(f.context, { uploadId: started.uploadId, assetId: started.assetId, expectedMediaRevision: 0,
    idempotencyKey: crypto.randomUUID(), selection: { kind: "image", targets: ["feed"], audioMode: "none" } });
  const first = f.workflow.tick(), overlapping = f.workflow.tick(); assert.equal(first, overlapping, "Concurrent calls join one finite tick");
  await first; assert.equal(f.workflow.calls.length, 2); assert.equal((await f.preparation.status(f.context, { assetId: started.assetId })).ready, false);
  await f.workflow.awaitTasks();
  // Controlled crash-gap state: a claimed predecessor must itself block new
  // dispatch even if its Workflow registration is not visible. Restore only
  // this exact synthetic row; this is not an actual API restart proof.
  const registration = (await f.workflow.journal.records()).find(r => r.kind === "prepare");
  const storedRegistration = await f.store.update(f.context.companyId, state => {
    const row = state.workflowExecutions.records[registration.executionId]; delete state.workflowExecutions.records[registration.executionId]; return row;
  });
  try { assert.equal((await f.workflow.tick()).unresolved, true); assert.equal(f.workflow.calls.length, 2); }
  finally { await f.store.update(f.context.companyId, state => { state.workflowExecutions.records[registration.executionId] = storedRegistration; }); }
  const remotePrepare = [...f.workflow.sdkRuns.values()][1]; remotePrepare.status = "running";
  const observed = await f.workflow.tick(); assert.equal(observed.unresolved, true, "Bytes are durably returned; provider status remains independently pending");
  assert.equal((await f.preparation.status(f.context, { assetId: started.assetId })).ready, false);
  const record = (await f.workflow.journal.records()).find(r => r.kind === "prepare");
  const capacity = await f.capacity.inspect({ context: { authenticated: true, role: "calendar_media_capacity_coordinator" }, jobId: record.task.jobId });
  assert.equal(capacity.state, "running", "A durable result alone must not release capacity before confirmed run termination");
  assert.equal(f.workflow.calls.length, 2);
  remotePrepare.status = "completed"; await f.workflow.tick();
  const ready = await f.preparation.status(f.context, { assetId: started.assetId }); assert.equal(ready.ready, true); assert.equal(ready.mediaRevision, requested.mediaRevision);
  await Promise.all([f.workflow.tick(), f.workflow.tick()]); assert.equal(f.workflow.calls.length, 2);
  f.revoke(); await assert.rejects(() => f.workflow.tick(), /not_allowed/); assert.equal(f.workflow.calls.length, 2);
  t.diagnostic("ASYNC_START=PROVED; STATUS_READONLY=YES; TICK_OVERLAP_JOINED=YES; UNKNOWN_RESERVATION_HELD=YES; DUPLICATE_STARTS=ZERO");
});

test("private Workflow: assertion-error cleanup drains active host and proves native termination before PostgreSQL or media removal", async t => {
  const f = await createOperationalCalendarPipelineFixture(t, options);
  const value = await f.preparePhoto({ selection: { kind: "image", targets: ["feed"], audioMode: "none" } });
  assert.equal(value.status.ready, false); assert.equal([...f.workflow.sdkRuns.values()].at(-1).status, "running");
  let caught;
  try { throw Error("synthetic_assertion_failure_after_start"); }
  catch (error) { caught = error.message; }
  finally { await f.workflow.close(); }
  assert.equal(caught, "synthetic_assertion_failure_after_start");
  assert.equal((await fs.stat(f.pg.root)).isDirectory(), true);
  assert.equal((await f.pg.tenantPool.query("SELECT 1 AS intact")).rows[0].intact, 1);
  const r = (await f.workflow.journal.records()).find(r => r.kind === "prepare");
  assert.equal(r.delivered.termination.proved, true); assert.equal(r.delivered.termination.descendants, 0);
  assert.equal(f.workflow.calls.length, 2);
  t.diagnostic("ASSERTION_ERROR_PATH=CONTROLLED; ACTIVE_HOST_DRAINED=YES; NATIVE_TERMINATION_PROVED=YES; DATABASE_AND_FILES_PRESENT_UNTIL_STOP=YES");
});
