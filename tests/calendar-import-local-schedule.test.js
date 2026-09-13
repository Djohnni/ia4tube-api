"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto"), fs = require("node:fs/promises"), path = require("node:path");
const { createSchedulePipelineFixture, PREFIX, slot } = require("./helpers/gallery-schedule-pipeline-fixture");
const { dateTime, freshState } = require("../src/social/calendar/model");
const { schedulePreparedImport } = require("../src/social/calendar/imports/calendar-entry");
const { createLocalCalendarImportService } = require("../src/social/calendar/imports/local-calendar-service");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
async function scheduleHttp(f, input) {
  const { assetId, ...body } = input;
  const response = await f.post(`${PREFIX}/assets/${assetId}/schedule`, body), result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result)); assert.equal(result.ok, true); return result.schedule;
}
async function calendarHttp(f) { const response = await f.request("/v1/social/calendar"); assert.equal(response.status, 200); return response.json(); }
async function assertPreviewBytes(f, schedule) {
  for (const value of [...schedule.media.variants, ...(schedule.media.thumbnail ? [schedule.media.thumbnail] : [])]) {
    const response = await f.request(new URL(value.url).pathname); assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer()); assert.equal(hash(bytes), value.sha256); assert.equal(bytes.length, value.sizeBytes);
  }
}

test("cross-language golden HTTP envelopes bind the same synthetic owner, source, revision and schedule", () => {
  const golden = require("./fixtures/gallery-import-http-contract.json"), calendar = require("./fixtures/gallery-import-calendar-contract.json");
  for (const value of Object.values(golden)) assert.equal(value.ok, true);
  const { asset } = golden.asset, { preview } = golden.preview, { availability } = golden.availability, { schedule } = golden.schedule;
  assert.deepEqual(golden.capabilities.identity, golden.source.identity); assert.deepEqual(availability.identity, golden.source.identity);
  assert.equal(asset.assetId, golden.source.upload.assetId); assert.equal(asset.uploadId, golden.source.upload.uploadId);
  for (const value of [preview, availability, schedule]) {
    assert.equal(value.assetId, asset.assetId); assert.equal(value.mediaRevision, asset.mediaRevision); assert.equal(value.previewDigest, asset.previewDigest);
  }
  assert.equal(availability.localSimulation, true); assert.equal(availability.commercialReady, false);
  assert.equal(schedule.media.sourceKind, "generated_art");
  for (const item of calendar.items.filter(item => item.media)) for (const part of [...item.media.variants, ...(item.media.thumbnail ? [item.media.thumbnail] : [])]) {
    assert.equal(new URL(part.url).pathname, `/v1/social/calendar/imports/schedules/${item.id}/preview/${part.target}`);
  }
  assert.doesNotMatch(JSON.stringify([golden, calendar]), /objectKey|resultRef|leaseToken|dispatchKey|Bearer /);
});

test("real photo confirmation, lost acknowledgement and calendar/gallery edits share the original calendar record", async t => {
  const f = await createSchedulePipelineFixture(t), ready = await f.preparePhoto(), input = f.inputFor(ready);
  const availability = (await (await f.request(`${PREFIX}/assets/${ready.assetId}/schedule-availability`)).json()).availability;
  assert.equal(availability.ready, true); assert.equal(availability.authorized, true); assert.equal(availability.localSimulation, true);
  assert.equal(availability.commercialReady, false);
  const first = await scheduleHttp(f, input), counts = { ...f.counters };
  // The first response is deliberately discarded by the client. Recovery is GET,
  // followed by an explicit exact POST retry; neither performs another encode.
  const recovered = await (await f.request(`${PREFIX}/assets/${ready.assetId}/schedules/by-key/${input.idempotencyKey}`)).json();
  assert.equal(recovered.schedule.id, first.id); assert.equal((await scheduleHttp(f, input)).id, first.id);
  assert.deepEqual(f.counters, counts); assert.equal(first.media.testOnly, false); await assertPreviewBytes(f, first);
  let calendar = await calendarHttp(f), item = calendar.items.find(item => item.id === first.id);
  assert.deepEqual(calendar.identity, { companyId: f.context.companyId, userId: f.context.userId });
  assert.equal(calendar.next.id, first.id); assert.equal(item.status, "scheduled"); assert.equal(item.imageUrl, null);
  const gallery = await (await f.request("/synthetic-gallery")).json();
  assert.equal(gallery.postagens.filter(item => item.calendar_schedule_id === first.id).length, 1);
  assert.equal(gallery.postagens.find(item => item.calendar_schedule_id === first.id).calendar_media.previewDigest, first.previewDigest);
  assert.ok(calendar.items.some(item => item.id === f.original.id));
  assert.doesNotMatch(JSON.stringify(item), /objectKey|objectVersion|resultRef|leaseToken|dispatchKey|[A-Z]:\\/);
  const original = f.calendarStore.snapshotForTest(f.context.companyId).jobs[f.original.id];
  for (const action of [{ action: "caption", caption: "Legenda corrigida" }, { action: "schedule", ...slot(f.clock(), 1, 15) },
    { action: "automatic", enabled: false }]) {
    const response = await f.post(`/v1/social/calendar/items/${first.id}`, { ...action, revision: item.revision });
    assert.equal(response.status, 200); calendar = await response.json(); item = calendar.items.find(value => value.id === first.id);
  }
  assert.equal(item.caption, "Legenda corrigida"); assert.equal(item.status, "item_paused");
  const pausedGallery = await (await f.request("/synthetic-gallery")).json();
  assert.equal(pausedGallery.postagens.find(item => item.calendar_schedule_id === first.id).legenda, "Legenda corrigida");
  assert.equal((await scheduleHttp(f, input)).automaticEnabled, false, "a repeated confirmation cannot undo a pause");
  const cancelled = await f.post(`/v1/social/calendar/items/${first.id}`, { action: "cancel", revision: item.revision });
  assert.equal(cancelled.status, 200); assert.ok(!(await cancelled.json()).items.some(item => item.id === first.id));
  assert.equal((await scheduleHttp(f, input)).phase, "cancelled");
  assert.ok(!(await (await f.request("/synthetic-gallery")).json()).postagens.some(item => item.calendar_schedule_id === first.id));
  assert.equal((await f.request(new URL(first.media.variants[0].url).pathname)).status, 404);
  assert.deepEqual(f.calendarStore.snapshotForTest(f.context.companyId).jobs[f.original.id], original);
  assert.equal((await f.upload.status(f.context, { uploadId: ready.uploadId })).state, "uploaded");
  assert.equal(f.simulation.sentForTest().length, 0); assert.equal(Object.keys(f.calendarStore.snapshotForTest(f.context.companyId).jobs).length, 2);
});

test("real synthetic photo music has separate Feed image and Story/Reel video, one equivalent encode and no commercial bypass", async t => {
  const f = await createSchedulePipelineFixture(t, { syntheticMusic: true });
  const selection = { kind: "image", targets: ["feed", "story", "reel"], audioMode: "music", musicTrackId: "synthetic-local-tone", musicalTargets: ["story", "reel"] };
  const ready = await f.preparePhoto({ selection }); assert.equal(ready.status.state, "ready", ready.status.errorCode);
  const input = f.inputFor(ready), snapshot = await f.preparation.snapshot(f.context, { assetId: ready.assetId, mediaRevision: ready.mediaRevision });
  assert.equal(snapshot.result.testOnly, true); assert.equal(snapshot.result.variants.feed.hasAudio, false);
  assert.equal(snapshot.result.variants.story.hasAudio, true); assert.equal(snapshot.result.variants.story.durationSeconds, 15);
  assert.equal(snapshot.result.variants.story.sha256, snapshot.result.variants.reel.sha256);
  assert.equal((await fs.readdir(path.join(f.preparationRoot, f.context.companyId, ready.assetId))).filter(file => file.endsWith(".mp4")).length, 1);
  assert.throws(() => schedulePreparedImport(freshState(), f.context, input, snapshot, { now: f.clock(), accessPolicy: f.accessPolicy, catalog: f.catalog }),
    { code: "calendar_import_prepared_media_unavailable" });
  assert.throws(() => schedulePreparedImport(freshState(), f.context, input, snapshot, { now: f.clock(), accessPolicy: f.accessPolicy, catalog: f.catalog,
    localSimulation: { capabilities: { localOnly: true, testOnly: true } } }), { code: "calendar_import_prepared_media_unavailable" });
  assert.throws(() => createLocalCalendarImportService({ simulation: { ...f.simulation }, enabled: true }), { code: "calendar_import_local_configuration_invalid" });
  const saved = await scheduleHttp(f, input); assert.equal(saved.localSimulation, true); assert.equal(saved.media.testOnly, true);
  await assertPreviewBytes(f, saved);
  const edited = { ...input, idempotencyKey: crypto.randomUUID(), mediaRevision: 99 };
  assert.equal((await f.post(`${PREFIX}/assets/${ready.assetId}/schedule`, Object.fromEntries(Object.entries(edited).filter(([key]) => key !== "assetId")))).status, 404);
});

test("generated art uses the real uploaded/inspected pipeline for synthetic music without changing or billing the original", async t => {
  const f = await createSchedulePipelineFixture(t, { syntheticMusic: true });
  const before = f.calendarStore.snapshotForTest(f.context.companyId).jobs[f.original.id], sourceBytes = await f.calendar.image(f.claims, f.original.id);
  const sourceInput = { revision: f.original.revision, idempotencyKey: crypto.randomUUID() };
  const response = await f.post(`${PREFIX}/sources/generated/${f.original.id}`, sourceInput), imported = await response.json();
  assert.equal(response.status, 200, JSON.stringify(imported)); assert.equal(imported.upload.state, "uploaded");
  assert.equal(imported.source.sha256, hash(sourceBytes)); assert.equal(imported.source.kind, "generated_art");
  const repeated = await (await f.post(`${PREFIX}/sources/generated/${f.original.id}`, sourceInput)).json();
  assert.equal(repeated.upload.uploadId, imported.upload.uploadId); assert.equal(f.counters.inspectionSourceReads, 1);
  const changedSource = await f.post(`${PREFIX}/sources/generated/${f.original.id}`, { ...sourceInput, revision: sourceInput.revision + 1 });
  assert.equal(changedSource.status, 409);
  const injectedPath = await f.post(`${PREFIX}/sources/generated/${f.original.id}`, { ...sourceInput, url: "https://untrusted.invalid/image" });
  assert.equal(injectedPath.status, 400);
  const ready = await f.enqueuePrepared(imported.upload, { kind: "image", targets: ["story"], audioMode: "music",
    musicTrackId: "synthetic-local-tone", musicalTargets: ["story"] });
  assert.equal(ready.status.state, "ready", ready.status.errorCode);
  const saved = await scheduleHttp(f, f.inputFor(ready, { caption: "" })); assert.equal(saved.media.sourceKind, "generated_art");
  assert.equal(saved.media.variants[0].hasAudio, true); await assertPreviewBytes(f, saved);
  assert.deepEqual(f.calendarStore.snapshotForTest(f.context.companyId).jobs[f.original.id], before);
  assert.deepEqual(await f.calendar.image(f.claims, f.original.id), sourceBytes);
  assert.equal((await calendarHttp(f)).items.length, 2); assert.equal(f.simulation.sentForTest().length, 0);
  f.clearGeneratedSources(); const afterSync = await calendarHttp(f);
  assert.ok(afterSync.items.some(item => item.id === saved.id), "import survives generation source synchronization");
});

test("real original and muted video revisions keep the scheduled private preview pinned to its confirmed audio/format", async t => {
  const f = await createSchedulePipelineFixture(t);
  const first = await f.prepareVideo({ selection: { kind: "video", targets: ["story", "reel"], audioMode: "original", shareToFeed: true } });
  assert.equal(first.status.ready, true); assert.equal(first.prepared.variants.story.hasAudio, true);
  assert.equal(first.prepared.variants.story.sha256, first.prepared.variants.reel.sha256);
  const old = await scheduleHttp(f, f.inputFor(first)); assert.equal(old.media.shareToFeed, true); await assertPreviewBytes(f, old);
  const changed = await f.enqueuePrepared(first, { kind: "video", targets: ["story"], audioMode: "muted" }, first.mediaRevision);
  assert.equal(changed.status.ready, true); assert.equal(changed.mediaRevision, first.mediaRevision + 1);
  assert.equal(changed.prepared.variants.story.hasAudio, false); assert.equal(changed.prepared.variants.story.audioMode, "muted");
  assert.notEqual(changed.prepared.variants.story.sha256, first.prepared.variants.story.sha256);
  assert.notEqual(changed.status.previewDigest, old.previewDigest);
  const oldEditor = `${PREFIX}/assets/${first.assetId}/revisions/${first.mediaRevision}/preview/story`;
  assert.equal((await f.request(oldEditor)).status, 409, "editor latest-only policy remains intact");
  await assertPreviewBytes(f, old);
  const oldAgain = await (await f.request(`${PREFIX}/schedules/${old.id}/preview`)).json();
  assert.equal(oldAgain.preview.currentRevision, first.mediaRevision); assert.equal(oldAgain.preview.variants[0].hasAudio, true);
  const stale = f.inputFor(first, { ...slot(f.clock(), 1, 30) });
  await assert.rejects(f.scheduling.schedule(f.context, stale), { code: "calendar_import_preview_changed" });
  const newest = await scheduleHttp(f, f.inputFor(changed, { ...slot(f.clock(), 1, 30), caption: "" }));
  assert.equal(newest.media.variants.length, 1); assert.equal(newest.media.variants[0].hasAudio, false);
  await assertPreviewBytes(f, newest); assert.equal(f.counters.preparationSourceReads, 2);
});

test("independent destinations reconcile an uncertain result without repeating a confirmed simulated send", async t => {
  const f = await createSchedulePipelineFixture(t), ready = await f.preparePhoto(), saved = await scheduleHttp(f, f.inputFor(ready));
  f.advance(dateTime(saved.date, saved.time) - f.clock());
  await Promise.all([f.deliverySimulator.tick(f.context), f.deliverySimulator.tick(f.context)]);
  assert.deepEqual(f.simulation.sentForTest().map(item => item.target), ["feed"]);
  f.simulation.setOutcomeForTest("story", null);
  await f.deliverySimulator.tick(f.context); await f.deliverySimulator.tick(f.context);
  assert.deepEqual(f.simulation.sentForTest().map(item => item.target), ["feed", "story"]);
  let job = f.calendarStore.snapshotForTest(f.context.companyId).jobs[saved.id];
  assert.equal(job.deliveries.feed.phase, "published"); assert.equal(job.deliveries.story.phase, "confirming");
  await assert.rejects(f.scheduling.edit(f.context, saved.id, { action: "cancel", revision: job.revision }), { code: "calendar_dispatch_started" });
  f.simulation.setOutcomeForTest("story", { published: true, mediaId: "local-reconciled-story", simulated: true });
  await f.deliverySimulator.tick(f.context); await f.deliverySimulator.tick(f.context);
  job = f.calendarStore.snapshotForTest(f.context.companyId).jobs[saved.id]; assert.equal(job.phase, "published");
  assert.equal(f.simulation.sentForTest().length, 2); assert.equal(f.counters.preparationSourceReads, 1);
  assert.equal((await calendarHttp(f)).items.find(item => item.id === saved.id).publications.story.result.mediaId, "local-reconciled-story");
});

test("schedule availability, owner/session changes and private media routes cannot lend another company a receipt or preview", async t => {
  const f = await createSchedulePipelineFixture(t), ready = await f.preparePhoto(), saved = await scheduleHttp(f, f.inputFor(ready));
  for (const route of [`${PREFIX}/schedules/${saved.id}`, `${PREFIX}/schedules/${saved.id}/preview`,
    new URL(saved.media.variants[0].url).pathname, `${PREFIX}/assets/${ready.assetId}/schedules/by-key/${saved.idempotencyKey}`]) {
    const response = await f.request(route, { headers: { Authorization: `Bearer ${f.otherToken}` } });
    assert.ok([404, 503].includes(response.status)); assert.doesNotMatch(await response.text(), /objectKey|assetId|companyId|userId|previewDigest/);
  }
  f.disconnect();
  const unavailable = (await (await f.request(`${PREFIX}/assets/${ready.assetId}/schedule-availability`)).json()).availability;
  assert.equal(unavailable.connected, false); assert.equal(unavailable.authorized, false); assert.equal(unavailable.blockedReason, "calendar_connection_required");
  await assert.rejects(f.scheduling.schedule(f.context, f.inputFor(ready, { ...slot(f.clock(), 1, 30) })), { code: "calendar_import_consent_changed" });
  f.revoke(); assert.equal((await f.request(new URL(saved.media.variants[0].url).pathname)).status, 404);
  assert.equal(f.simulation.sentForTest().length, 0);
});

test("a disconnected second destination and a paused or manually saved item cannot acquire simulated delivery authority", async t => {
  const f = await createSchedulePipelineFixture(t), ready = await f.preparePhoto(), saved = await scheduleHttp(f, f.inputFor(ready));
  const manual = await scheduleHttp(f, f.inputFor(ready, { automatic: false, ...slot(f.clock(), 1, 15) }));
  await assert.rejects(f.scheduling.edit(f.context, manual.id, { action: "automatic", enabled: true, confirmed: true, revision: manual.revision }),
    { code: "calendar_import_consent_changed" });
  f.advance(dateTime(saved.date, saved.time) - f.clock()); await f.deliverySimulator.tick(f.context);
  assert.deepEqual(f.simulation.sentForTest().map(item => item.target), ["feed"]);
  f.disconnect(); await f.deliverySimulator.tick(f.context);
  assert.deepEqual(f.simulation.sentForTest().map(item => item.target), ["feed"]);
  const sourceKey = f.calendarStore.snapshotForTest(f.context.companyId).jobs[saved.id].sourceKey;
  await assert.rejects(f.calendar.legacyEdit(f.claims, sourceKey, { action: "cancel", reference: {}, revision: 1 }),
    { code: "calendar_refresh_required" });
});

test("lost generated-source acknowledgement survives a later edit/cancel of the original, without recreating the upload", async t => {
  const f = await createSchedulePipelineFixture(t), input = { revision: f.original.revision, idempotencyKey: crypto.randomUUID() };
  const first = await (await f.post(`${PREFIX}/sources/generated/${f.original.id}`, input)).json();
  assert.equal(first.upload.state, "uploaded");
  const changed = await f.calendar.edit(f.claims, f.original.id, { action: "caption", revision: f.original.revision, caption: "Original editada" });
  await f.calendar.edit(f.claims, f.original.id, { action: "cancel", revision: changed.items.find(item => item.id === f.original.id).revision });
  const recovered = await (await f.post(`${PREFIX}/sources/generated/${f.original.id}`, input)).json();
  assert.deepEqual(recovered, first); assert.equal(f.counters.inspectionSourceReads, 1);
  const conflict = await f.post(`${PREFIX}/sources/generated/${f.original.id}`, { ...input, revision: input.revision + 1 });
  assert.equal(conflict.status, 409);
  assert.equal(f.calendarStore.snapshotForTest(f.context.companyId).jobs[f.original.id].phase, "cancelled");
});

test("capabilities are boot-compatible and availability explains a nonbusiness Story restriction before confirmation", async t => {
  const f = await createSchedulePipelineFixture(t), ready = await f.preparePhoto();
  const caps = await (await f.request(`${PREFIX}/capabilities`)).json();
  assert.equal(caps.localSimulation, true); assert.equal(caps.upload.chunkBytes, 5 * 1024 ** 2);
  assert.equal(caps.upload.maxImageBytes, 32 * 1024 ** 2); assert.equal(caps.upload.maxVideoBytes, 100 * 1024 ** 2);
  assert.equal(caps.preparation.maxVideoSeconds, 60); assert.equal(caps.preparation.photoMusicSeconds, 15);
  f.setAccountType("creator");
  const availability = (await (await f.request(`${PREFIX}/assets/${ready.assetId}/schedule-availability`)).json()).availability;
  assert.equal(availability.connected, true); assert.equal(availability.authorized, false); assert.equal(availability.commercialReady, false);
  assert.equal(availability.blockedReason, "calendar_story_business_required");
});
