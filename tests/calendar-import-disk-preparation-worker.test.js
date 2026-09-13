"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const fs = require("node:fs/promises"), fsSync = require("node:fs"), path = require("node:path"), sharp = require("sharp");
const { createPrivatePipelineFixture, FFMPEG, hash, coordinator } = require("./helpers/gallery-private-pipeline-fixture");
const { validatePreparationState } = require("../src/social/calendar/imports/preparation-queue");

test("real uploaded PNG is inspected, prepared, committed privately and accepted as a ready revision", { timeout: 30000 }, async t => {
  const f = await createPrivatePipelineFixture(t), item = await f.preparePhoto();
  assert.equal(item.status.state, "ready", JSON.stringify(item.status)); assert.equal(item.status.ready, true);
  assert.equal(item.mediaRevision, 1); assert.match(item.prepared.previewDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(f.counters, { inspectionSourceReads: 1, preparationSourceReads: 1, inspectionResults: 1, preparationResults: 1 });
  assert.equal(f.inspectionRunner.capabilities.isolatedWorker, false); assert.equal(f.preparationRunner.capabilities.isolatedWorker, false);
  const actual = await f.actualFor(item.assetId, item.mediaRevision), job = f.jobFor(item.assetId);
  const sourceRow = f.store.snapshotForTest(f.context.companyId).uploads[item.uploadId];
  assert.equal(hash(await fs.readFile(path.join(f.diskRoot, sourceRow.objectKey, "source.bin"))), sourceRow.sha256);
  for (const [target, height] of [["feed", 1350], ["story", 1920]]) {
    const part = actual.prepared.variants[target], filename = path.join(f.privateRoot, f.context.companyId, item.assetId, job.dispatchKey, part.fileName);
    const data = await fs.readFile(filename), geometry = await sharp(data).metadata();
    assert.equal(hash(data), part.sha256); assert.equal(geometry.width, 1080); assert.equal(geometry.height, height);
    const chunks = [];
    await f.preparedStore.streamPreview({ context: f.context, assetId: item.assetId, mediaRevision: 1, resultRef: actual.resultRef,
      target, sha256: part.sha256, consume: chunk => chunks.push(chunk) });
    assert.deepEqual(Buffer.concat(chunks), data);
  }
  assert.deepEqual(await fs.readdir(f.inspectionWorkingRoot), []); assert.deepEqual(await fs.readdir(f.preparationWorkingRoot), []);
  const state = f.store.snapshotForTest(f.context.companyId); validatePreparationState(state.preparation, f.context.companyId, state.uploads);
  const usage = await f.capacity.summary({ context: coordinator });
  assert.equal(usage.monthlyJobs, 2); assert.equal(usage.activeJobs, 0);
  assert.ok(usage.storageBytes > sourceRow.sizeBytes); // Retained originals/outputs remain charged.
  assert.equal(f.preparedStore.capabilities.readyForProduction, false);
});

test("lost preparation acknowledgement reconciles the same committed result without another encode or charge", { timeout: 30000 }, async t => {
  const f = await createPrivatePipelineFixture(t, { lostPreparationReply: true }), item = await f.preparePhoto();
  assert.equal(item.status.state, "reconciliation", JSON.stringify(item.status)); assert.equal(item.status.ready, false);
  const before = await f.capacity.summary({ context: coordinator });
  const ready = await f.preparation.reconcile(f.context, { assetId: item.assetId, mediaRevision: item.mediaRevision });
  assert.equal(ready.ready, true, JSON.stringify(ready));
  const actual = await f.actualFor(item.assetId, item.mediaRevision);
  assert.equal(f.counters.preparationSourceReads, 1); assert.equal(f.counters.preparationResults, 1);
  await f.preparation.reconcile(f.context, { assetId: item.assetId, mediaRevision: item.mediaRevision });
  assert.equal(f.counters.preparationSourceReads, 1);
  const after = await f.capacity.summary({ context: coordinator });
  assert.equal(after.monthlyJobs, before.monthlyJobs); assert.equal(after.storageBytes, before.storageBytes);
  assert.equal((await f.actualFor(item.assetId, item.mediaRevision)).resultRef, actual.resultRef);
});

test("prepared admission refuses another owner, source and completion fence without changing held storage", { timeout: 30000 }, async t => {
  const f = await createPrivatePipelineFixture(t), item = await f.preparePhoto();
  assert.equal(item.status.ready, true);
  const job = f.jobFor(item.assetId), manifest = JSON.parse(await fs.readFile(path.join(f.privateRoot, f.context.companyId,
    item.assetId, job.dispatchKey, "manifest.json"), "utf8"));
  const before = await f.capacity.summary({ context: coordinator });
  for (const patch of [{ userId: crypto.randomUUID() }, { fence: manifest.task.fence + 1 }, { leaseToken: crypto.randomUUID() },
    { source: { ...manifest.task.source, sha256: "b".repeat(64) } }]) {
    await assert.rejects(f.preparedAdmission.assertHeld({ task: { ...manifest.task, ...patch }, resultRef: manifest.actual.resultRef,
      requiredBytes: 1, intent: "read" }));
  }
  assert.equal(await f.preparedAdmission.assertHeld({ task: manifest.task, resultRef: manifest.actual.resultRef,
    requiredBytes: 1, intent: "read" }), true);
  const after = await f.capacity.summary({ context: coordinator });
  assert.equal(after.storageBytes, before.storageBytes); assert.equal(after.monthlyJobs, before.monthlyJobs);
});

test("genuine short MP4 upload passes real inspection, preparation and private derivative/thumbnail decoding", {
  skip: !fsSync.existsSync(FFMPEG), timeout: 60000
}, async t => {
  const f = await createPrivatePipelineFixture(t), item = await f.prepareVideo();
  assert.equal(item.status.ready, true, JSON.stringify(item.status));
  const actual = await f.actualFor(item.assetId, item.mediaRevision);
  assert.equal(actual.objects.story.objectKey, actual.objects.reel.objectKey);
  assert.equal(actual.objects.story.objectVersion, actual.objects.reel.objectVersion);
  const variant = actual.prepared.variants.story;
  assert.equal(variant.width, 1080); assert.equal(variant.height, 1920); assert.equal(variant.videoCodec, "h264");
  assert.equal(variant.hasAudio, false); assert.equal(variant.audioMode, "muted");
  assert.equal(actual.prepared.thumbnail.mimeType, "image/jpeg");
  const chunks = [];
  await f.preparedStore.streamPreview({ context: f.context, assetId: item.assetId, mediaRevision: 1, resultRef: actual.resultRef,
    target: "reel", sha256: variant.sha256, consume: chunk => chunks.push(chunk) });
  assert.equal(hash(Buffer.concat(chunks)), variant.sha256);
  assert.equal((await f.capacity.summary({ context: coordinator })).monthlyJobs, 2);
  assert.deepEqual(f.counters, { inspectionSourceReads: 1, preparationSourceReads: 1, inspectionResults: 1, preparationResults: 1 });
  assert.deepEqual(await fs.readdir(f.preparationWorkingRoot), []);
});

test("elapsed local deadline retains the execution slot until a blocked source operation actually returns", { timeout: 10000 }, async t => {
  let entered, resume, finished = false;
  const blocked = new Promise(resolve => { entered = resolve; });
  const released = new Promise(resolve => { resume = resolve; });
  t.after(() => resume());
  const f = await createPrivatePipelineFixture(t, { async beforePreparationSourceRead() { entered(); await released; } });
  assert.equal(f.inspectorWorker.capabilities.deadlineMode, "cooperative");
  assert.equal(f.inspectorWorker.capabilities.hardTermination, false);
  assert.equal(f.inspectionRunner.capabilities.deadlineMode, "cooperative");
  assert.equal(f.inspectionRunner.capabilities.hardTermination, false);
  const pending = f.preparePhoto().then(value => { finished = true; return value; });
  await blocked;
  const before = await f.capacity.summary({ context: coordinator });
  assert.equal(before.activeJobs, 1); assert.equal(before.monthlyJobs, 2);
  f.advance(180001);
  const overdue = await f.capacity.summary({ context: coordinator });
  assert.equal(overdue.activeJobs, 1); assert.equal(overdue.storageBytes, before.storageBytes);
  assert.equal(finished, false);
  const running = Object.values(f.ledger.snapshotForTest().jobs).filter(job => job.state === "running");
  assert.equal(running.length, 1); assert.ok(running[0].deadlineAt < f.clock());
  resume();
  const outcome = await pending;
  assert.equal(outcome.status.ready, false); assert.equal(outcome.status.state, "attention");
  assert.equal(outcome.status.errorCode, "import_preparation_worker_failed");
  assert.equal((await f.capacity.summary({ context: coordinator })).activeJobs, 0);
  const stopped = f.ledger.snapshotForTest().jobs[running[0].jobId];
  assert.equal(stopped.state, "completed"); assert.equal(stopped.completion.outcome, "failed");
  assert.equal(stopped.storageHeld, true); // No inferred cleanup/release of retained storage.
  assert.deepEqual(await fs.readdir(f.preparationWorkingRoot), []);
  assert.deepEqual(await fs.readdir(f.preparationRoot), []);
});
