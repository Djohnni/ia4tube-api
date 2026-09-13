"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises");
const { createOperationalPrivatePipelineFixture, coordinator } = require("./helpers/operational-private-pipeline-fixture");

test("physical durable upload/process/immutable-result pipeline recovers without repeating work", {
  skip: !process.env.CALENDAR_OPERATIONAL_MEDIA_TEST_PG_BIN || !(process.platform === "win32" || process.platform === "linux" && process.env.CALENDAR_MEDIA_LINUX_CGROUP_ROOT), timeout: 240000
}, async t => {
  const f = await createOperationalPrivatePipelineFixture(t, { syntheticMusic: true });
  await t.test("sealed upload survives pool restart and real image processing survives lost ACK/server restart", async () => {
    const photo = await f.preparePhoto({ lostAcknowledgement: true, upload: { afterPart: () => f.reopen() } });
    assert.equal(photo.status.state, "reconciliation", JSON.stringify(photo.status)); assert.equal(photo.status.ready, false);
    const before = await f.snapshot(), job = await f.jobFor(photo.assetId);
    const execution = before.preparationExecutions.records[job.dispatchKey];
    assert.equal(execution.phase, "succeeded", JSON.stringify(execution)); assert.equal(execution.capacitySettled, true);
    assert.equal(Object.values(before.inspectionExecutions.records)[0].phase, "succeeded");
    const counters = structuredClone(f.counters), quota = await f.capacity.summary({ context: coordinator });
    await f.reopen({ restartDatabase: true });
    const status = await f.preparation.reconcile(f.context, { assetId: photo.assetId, mediaRevision: photo.mediaRevision });
    assert.equal(status.ready, true, JSON.stringify(status));
    assert.equal((await f.actualFor(photo.assetId, photo.mediaRevision)).resultRef, execution.resultRef);
    assert.deepEqual(f.counters, counters); assert.equal(f.counters.inspectionSourceReads, 1); assert.equal(f.counters.preparationSourceReads, 1);
    assert.deepEqual(await f.capacity.summary({ context: coordinator }), quota);
    assert.equal(quota.activeJobs, 0); assert.ok(quota.storageBytes > 0);
    assert.equal(f.store.capabilities.persistence, "durable"); assert.equal(f.executor.capabilities.hardTermination, true);
  });
  await t.test("real three-second uploaded video preserves or mutes audio through immutable process outputs", async () => {
    const video = await f.prepareVideo({ selection: { kind: "video", targets: ["story", "reel"], audioMode: "original", shareToFeed: true } });
    assert.equal(video.status.ready, true, JSON.stringify(video.status));
    const actual = await f.actualFor(video.assetId, 1);
    assert.equal(actual.prepared.variants.story.mimeType, "video/mp4"); assert.equal(actual.prepared.variants.story.hasAudio, true);
    assert.equal(actual.objects.story.objectKey, actual.objects.reel.objectKey);
    assert.equal((await f.jobFor(video.assetId, 1)).selection.shareToFeed, true);
    const uploaded = { uploadId: video.uploadId, assetId: video.assetId };
    const muted = await f.enqueuePrepared(uploaded, { kind: "video", targets: ["story", "reel"], audioMode: "muted" }, 1);
    assert.equal(muted.status.ready, true, JSON.stringify(muted.status));
    assert.equal((await f.actualFor(video.assetId, 2)).prepared.variants.story.hasAudio, false);
    assert.equal((await f.capacity.summary({ context: coordinator })).activeJobs, 0);
  });
  await t.test("synthetic photo music is genuinely rendered by the process and remains noncommercial", async () => {
    const item = await f.preparePhoto({ selection: { kind: "image", targets: ["feed", "story"], audioMode: "music",
      musicalTargets: ["story"], musicTrackId: "synthetic-local-tone" } });
    assert.equal(item.status.ready, true, JSON.stringify(item.status)); assert.equal(item.status.testOnly, true);
    const actual = await f.actualFor(item.assetId, 1);
    assert.equal(actual.prepared.variants.feed.mimeType, "image/jpeg");
    assert.equal(actual.prepared.variants.story.mimeType, "video/mp4"); assert.equal(actual.prepared.variants.story.hasAudio, true);
    assert.equal(actual.prepared.commercialReady, false);
    assert.equal((await f.capacity.summary({ context: coordinator })).activeJobs, 0);
    assert.ok((await fs.readdir(f.executorRoot)).length > 0); // Actual durable supervisor receipts, not a memory-only runner.
  });
});
