"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const fs = require("node:fs/promises"), path = require("node:path");
const { createOperationalCalendarPipelineFixture, PREFIX, hash, slot } = require("./helpers/operational-calendar-pipeline-fixture");
const { dateTime } = require("../src/social/calendar/model");
async function schedule(f, ready, extra = {}) {
  assert.equal(ready.status.ready, true, `Preparation state: ${ready.status.state}; ${ready.status.errorCode}`);
  const input = f.inputFor(ready, extra), { assetId, ...body } = input;
  const response = await f.post(`${PREFIX}/assets/${assetId}/schedule`, body), receipt = await response.json();
  assert.equal(response.status, 200, JSON.stringify(receipt)); assert.equal(receipt.ok, true);
  return { input, saved: receipt.schedule };
}
async function preview(f, saved) {
  for (const variant of [...saved.media.variants, ...(saved.media.thumbnail ? [saved.media.thumbnail] : [])]) {
    const result = await f.request(new URL(variant.url).pathname); assert.equal(result.status, 200);
    const bytes = Buffer.from(await result.arrayBuffer()); assert.equal(hash(bytes), variant.sha256); assert.equal(bytes.length, variant.sizeBytes);
    const denied = await f.request(new URL(variant.url).pathname, { headers: { Authorization: `Bearer ${f.otherToken}` } });
    assert.equal(denied.status, 404);
  }
}
const row = (f, id) => f.current().calendarStore.update(f.context.companyId, state => state.jobs[id]);
async function dispatchAt(f, saved, { rounds = saved.selectedTargets.length } = {}) {
  f.advance(Math.max(0, dateTime(saved.date, saved.time) - f.clock()));
  for (let index = 0; index < rounds; index++) { await f.current().calendar.tick(); f.advance(60001); }
  return row(f, saved.id);
}
function assertPublished(job, targets) {
  assert.equal(job.phase, "published", `Persisted phase=${job.phase}; error=${job.error}`);
  for (const target of targets) {
    assert.equal(job.deliveries[target].phase, "published");
    assert.equal(job.deliveries[target].publication.published, true);
    assert.match(job.deliveries[target].publication.mediaId, /^\d+$/);
  }
}

test("principal physical path: uploaded photo → process → private preview → same calendar → actual publisher with controlled HTTP → PostgreSQL restart", async t => {
  const f = await createOperationalCalendarPipelineFixture(t);
  const ready = await f.preparePhoto(), { input, saved } = await schedule(f, ready);
  const originalBefore = await row(f, f.original.id), counters = { ...f.counters };
  await preview(f, saved);
  const list = await f.current().calendar.list(f.claims);
  assert.equal(list.next.id, saved.id); assert.equal(list.items.filter(item => item.id === saved.id).length, 1);
  const gallery = await f.current().calendar.overlay(f.claims, { postagens: [] });
  assert.equal(gallery.postagens.filter(item => item.calendar_schedule_id === saved.id).length, 1);
  assert.equal((await row(f, saved.id)).orderId, null, "An import does not invent an art-generation order");
  await f.reopen({ restartDatabase: true });
  const recovered = await f.current().scheduling.byKey(f.context, input.assetId, input.idempotencyKey);
  assert.equal(recovered.id, saved.id);
  assert.equal((await f.current().scheduling.schedule(f.context, input)).id, saved.id);
  assert.deepEqual(f.counters, counters, "Restart and private reads must not encode again");
  const result = await dispatchAt(f, saved); assertPublished(result, ["feed", "story"]);
  assert.equal(f.providerCalls.filter(call => call.operation === "create").length, 2);
  for (const created of f.providerCalls.filter(call => call.operation === "create")) {
    assert.equal(created.hash, ready.prepared.variants[created.target].sha256);
    assert.equal(created.caption, created.target === "story" ? null : input.caption);
  }
  const mediaPath = f.sourcePaths[0], initialCount = (await f.pg.adminPool.query("SELECT count(*) FROM ia4tube_calendar.owner_state")).rows[0].count;
  const head = await fetch(f.base + mediaPath, { method: "HEAD" }); assert.equal(head.status, 200);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  const range = await fetch(f.base + mediaPath, { headers: { Range: "bytes=0-31" } });
  assert.equal(range.status, 206); assert.equal((await range.arrayBuffer()).byteLength, 32);
  for (const bad of [mediaPath.replace(f.context.companyId, crypto.randomUUID()), mediaPath.replace("/feed/", "/reel/"),
    mediaPath.slice(0, -1) + (mediaPath.endsWith("0") ? "1" : "0"), mediaPath + "?extra=1"]) {
    assert.equal((await fetch(f.base + bad)).status, 404);
  }
  assert.equal((await f.pg.adminPool.query("SELECT count(*) FROM ia4tube_calendar.owner_state")).rows[0].count, initialCount,
    "Tampered anonymous links must not initialize a tenant record");
  await f.reopen({ restartDatabase: true });
  await Promise.all([f.current().calendar.tick(), f.current().calendar.tick()]);
  assertPublished(await row(f, saved.id), ["feed", "story"]); assert.equal(f.providerCalls.length, 4);
  assert.deepEqual(await row(f, f.original.id), originalBefore);
  f.advance(901000); assert.equal((await fetch(f.base + mediaPath)).status, 404);
  const persisted = await f.pg.adminPool.query("SELECT state,count(*) FROM ia4tube_social.social_publications GROUP BY state");
  assert.equal(persisted.rows.find(value => value.state === "published").count, "2");
  const own = await f.current().calendar.list(f.otherClaims); assert.ok(!own.items.some(item => item.id === saved.id));
  t.diagnostic("REAL_PG_AND_CHILD_PROCESS=YES; PROVIDER_TRANSPORT=CONTROLLED_ONLY; REAL_INSTAGRAM=NO; PRINCIPAL_MEMORY_STORE=NO");
});

test("photo Feed + musical Story and existing art with music retain source, bytes and independent typed delivery", async t => {
  const f = await createOperationalCalendarPipelineFixture(t, { syntheticMusic: true });
  const first = await f.preparePhoto({ selection: { kind: "image", targets: ["feed", "story"], audioMode: "music",
    musicTrackId: "synthetic-local-tone", musicalTargets: ["story"] } });
  const { saved } = await schedule(f, first); await preview(f, saved);
  assert.equal(saved.media.testOnly, true); assertPublished(await dispatchAt(f, saved), ["feed", "story"]);
  assert.equal(f.providerCalls.find(call => call.operation === "create" && call.target === "feed").mimeType, "image/jpeg");
  assert.equal(f.providerCalls.find(call => call.operation === "create" && call.target === "story").mimeType, "video/mp4");
  const before = await row(f, f.original.id), originalBytes = await f.current().calendar.image(f.claims, f.original.id);
  const sourceInput = { revision: f.original.revision, idempotencyKey: crypto.randomUUID() };
  const response = await f.post(`${PREFIX}/sources/generated/${f.original.id}`, sourceInput), source = await response.json();
  assert.equal(response.status, 200, JSON.stringify(source)); assert.equal(source.source.kind, "generated_art");
  await f.reopen({ restartDatabase: true });
  const retry = await f.post(`${PREFIX}/sources/generated/${f.original.id}`, sourceInput);
  assert.equal((await retry.json()).upload.uploadId, source.upload.uploadId);
  const second = await f.enqueuePrepared(source.upload, { kind: "image", targets: ["story", "reel"], audioMode: "music",
    musicTrackId: "synthetic-local-tone", musicalTargets: ["story", "reel"], shareToFeed: true });
  const secondSchedule = await schedule(f, second); await preview(f, secondSchedule.saved);
  assert.equal(secondSchedule.saved.media.sourceKind, "generated_art");
  assert.equal(second.prepared.variants.story.sha256, second.prepared.variants.reel.sha256);
  assert.equal((await fs.readdir(path.join(f.preparationRoot, f.context.companyId, second.assetId))).filter(name => name.endsWith(".mp4")).length, 1);
  assertPublished(await dispatchAt(f, secondSchedule.saved), ["story", "reel"]);
  const reels = f.providerCalls.filter(call => call.operation === "create" && call.target === "reel");
  assert.equal(reels.length, 1); assert.equal(reels[0].shareToFeed, "true");
  assert.equal(f.providerCalls.filter(call => call.operation === "create").length, 4, "Reel Feed visibility is not a third post");
  assert.deepEqual(await row(f, f.original.id), before);
  assert.deepEqual(await f.current().calendar.image(f.claims, f.original.id), originalBytes);
});

test("original and muted video revisions stay pinned to each schedule and use one equivalent Reel/Story preparation", async t => {
  const f = await createOperationalCalendarPipelineFixture(t);
  const original = await f.prepareVideo({ selection: { kind: "video", targets: ["story", "reel"], audioMode: "original", shareToFeed: true } });
  const first = await schedule(f, original);
  const muted = await f.enqueuePrepared(original, { kind: "video", targets: ["story", "reel"], audioMode: "muted", shareToFeed: true }, original.mediaRevision);
  const second = await schedule(f, muted, slot(f.clock(), 1, 30));
  assert.equal(original.prepared.variants.story.hasAudio, true); assert.equal(muted.prepared.variants.story.hasAudio, false);
  assert.notEqual(muted.prepared.variants.story.sha256, original.prepared.variants.story.sha256);
  assert.equal(muted.prepared.variants.story.sha256, muted.prepared.variants.reel.sha256);
  await preview(f, first.saved); await preview(f, second.saved);
  const preparedReads = f.counters.preparationSourceReads;
  assertPublished(await dispatchAt(f, first.saved), ["story", "reel"]);
  assertPublished(await dispatchAt(f, second.saved), ["story", "reel"]);
  assert.equal(f.counters.preparationSourceReads, preparedReads, "Publication never performs encoding");
  assert.equal(f.providerCalls.filter(call => call.operation === "publish").length, 4);
});

test("lost create response remains uncertain; restart never repeats a confirmed destination or uncertain POST", async t => {
  const f = await createOperationalCalendarPipelineFixture(t), ready = await f.preparePhoto();
  const first = await schedule(f, ready); f.setProviderFault("unknown_create_story");
  const unknown = await dispatchAt(f, first.saved);
  assert.equal(unknown.deliveries.feed.phase, "published"); assert.equal(unknown.deliveries.story.phase, "confirming");
  const count = f.providerCalls.length;
  await f.reopen({ restartDatabase: true });
  f.advance(60001); await Promise.all([f.current().calendar.tick(), f.current().calendar.tick()]);
  assert.equal(f.providerCalls.length, count); assert.equal((await row(f, first.saved.id)).deliveries.story.phase, "confirming");
  const persisted = await f.pg.adminPool.query("SELECT state,count(*) FROM ia4tube_social.social_publications GROUP BY state");
  assert.equal(persisted.rows.find(value => value.state === "provider_confirming").count, "1");
});

test("known provider rejection is persisted as failure, not uncertain or published", async t => {
  const f = await createOperationalCalendarPipelineFixture(t), ready = await f.preparePhoto({ selection: { kind: "image", targets: ["feed"], audioMode: "none" } });
  const { saved } = await schedule(f, ready); f.setProviderFault("known_create_feed");
  const failed = await dispatchAt(f, saved);
  assert.equal(failed.deliveries.feed.phase, "failed");
  assert.equal(f.providerCalls.filter(call => call.operation === "publish").length, 0);
  const records = await f.pg.adminPool.query("SELECT state FROM ia4tube_social.social_publications");
  assert.match(records.rows[0].state, /^failed_/);
  await f.reopen({ restartDatabase: true }); await f.current().calendar.tick(); assert.equal(f.providerCalls.length, 1);
});

test("lost publish acknowledgement keeps the same durable intent after database restart without another POST", async t => {
  const f = await createOperationalCalendarPipelineFixture(t);
  const ready = await f.preparePhoto({ selection: { kind: "image", targets: ["story"], audioMode: "none" } });
  const { saved } = await schedule(f, ready); f.setProviderFault("unknown_publish_story");
  const unknown = await dispatchAt(f, saved);
  assert.equal(unknown.deliveries.story.phase, "confirming");
  assert.equal(f.providerCalls.filter(call => call.operation === "create").length, 1);
  assert.equal(f.providerCalls.filter(call => call.operation === "publish").length, 1);
  await f.reopen({ restartDatabase: true });
  for (let index = 0; index < 5; index++) { f.advance(60001); await f.current().calendar.tick(); }
  assert.equal(f.providerCalls.length, 2, "A lost acknowledgement does not permit a replacement publication");
  const persisted = await row(f, saved.id);
  assert.equal(persisted.deliveries.story.phase, "confirming", "Container PUBLISHED without the exact media ID is not a fabricated confirmation");
  const publications = await f.pg.adminPool.query("SELECT state FROM ia4tube_social.social_publications");
  assert.deepEqual(publications.rows.map(value => value.state), ["provider_confirming"]);
});

test("changed committed bytes prevent provider POST and preserve the original generated image", async t => {
  const f = await createOperationalCalendarPipelineFixture(t), ready = await f.preparePhoto();
  const { saved } = await schedule(f, ready), job = await f.jobFor(ready.assetId);
  const original = await f.current().calendar.image(f.claims, f.original.id);
  const actual = await f.actualFor(ready.assetId);
  const filename = path.join(f.privateRoot, f.context.companyId, ready.assetId, job.dispatchKey, actual.prepared.variants.feed.fileName);
  const bytes = await fs.readFile(filename); assert.equal(hash(bytes), ready.prepared.variants.feed.sha256);
  // The genuine commit makes files read-only. This controlled corruption case
  // models operator-level damage ONLY inside the newly created synthetic tree;
  // do not weaken the product's immutable-file permission to make the test work.
  assert.ok(path.resolve(filename).startsWith(path.resolve(f.privateRoot) + path.sep));
  await fs.chmod(filename, 0o600);
  bytes[0] ^= 1; await fs.writeFile(filename, bytes);
  const stopped = await dispatchAt(f, saved);
  assert.equal(stopped.error, "calendar_art_changed"); assert.equal(f.providerCalls.length, 0);
  assert.deepEqual(await f.current().calendar.image(f.claims, f.original.id), original);
});

test("edit, pause, cancel, concurrent scheduling and closed fixture gate do not publish or alter original art", async t => {
  const f = await createOperationalCalendarPipelineFixture(t), ready = await f.preparePhoto();
  const input = f.inputFor(ready), receipts = await Promise.all(Array.from({ length: 8 }, () => f.current().scheduling.schedule(f.context, input)));
  assert.equal(new Set(receipts.map(value => value.id)).size, 1);
  let saved = receipts[0];
  saved = await f.current().scheduling.edit(f.context, saved.id, { action: "caption", revision: saved.revision, caption: "Legenda final editada" });
  saved = await f.current().scheduling.edit(f.context, saved.id, { action: "schedule", revision: saved.revision, ...slot(f.clock(), 1, 10) });
  saved = await f.current().scheduling.edit(f.context, saved.id, { action: "automatic", revision: saved.revision, enabled: false });
  await dispatchAt(f, saved); assert.equal(f.providerCalls.length, 0);
  assert.equal((await f.current().scheduling.schedule(f.context, input)).automaticEnabled, false, "An old confirmation cannot undo an explicit pause");
  saved = await f.current().scheduling.edit(f.context, saved.id, { action: "cancel", revision: saved.revision });
  assert.equal(saved.phase, "cancelled");
  assert.equal((await f.upload.status(f.context, { uploadId: ready.uploadId })).state, "uploaded");
  const active = await schedule(f, ready);
  f.setFixtureGate(false); await f.reopen({ restartDatabase: true });
  await dispatchAt(f, active.saved); assert.equal(f.providerCalls.length, 0);
  assert.equal((await f.current().calendar.list(f.claims)).items.filter(item => item.sourceKind === "upload").length, 1);
});
