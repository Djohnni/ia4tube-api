"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createOperationalCalendarPipelineFixture, PREFIX } = require("./helpers/operational-calendar-pipeline-fixture");
const { dateTime } = require("../src/social/calendar/model");
const row = (f, id) => f.current().calendarStore.update(f.context.companyId, state => state.jobs[id]);
async function start(f, ready, status) {
  assert.equal(ready.status.ready, true);
  const { assetId, ...body } = f.inputFor(ready);
  const response = await f.post(`${PREFIX}/assets/${assetId}/schedule`, body), receipt = await response.json();
  assert.equal(response.status, 200, JSON.stringify(receipt));
  const saved = receipt.schedule;
  f.setProviderContainerStatus(status); f.advance(Math.max(0, dateTime(saved.date, saved.time) - f.clock()));
  await f.current().calendar.tick();
  assert.equal((await row(f, saved.id)).phase, "confirming");
  return saved;
}
async function observe(f) { f.advance(60001); await Promise.all([f.current().calendar.tick(), f.current().calendar.tick()]); }
const video = f => f.prepareVideo({ selection: { kind: "video", targets: ["reel"], audioMode: "original", shareToFeed: true } });

test("physical imported MP4: ten processing errors, fresh FINISHED check and one publish survive restart", async t => {
  const f = await createOperationalCalendarPipelineFixture(t), saved = await start(f, await video(f), "ERROR");
  const original = await row(f, saved.id), publicationId = original.deliveries.reel.intent.publicationId;
  assert.equal(original.mediaKind, undefined, "The opt-in uses the actual imported asset, not a nonexistent field");
  assert.equal(original.assets.reel.mimeType, "video/mp4");
  const container = f.providerCalls[0].containerId;
  for (let count = 1; count <= 10; count++) {
    await observe(f);
    const current = await row(f, saved.id);
    assert.equal(current.deliveries.reel.providerObservationCount, count);
    assert.equal(current.phase, "confirming"); assert.equal(current.deliveries.reel.intent.publicationId, publicationId);
    const reads = f.containerReads.length; await f.current().calendar.tick();
    assert.equal(f.containerReads.length, reads, "An immediate extra tick cannot bypass the minute interval");
    if (count === 5) await f.reopen({ restartDatabase: true });
  }
  assert.equal(f.providerCalls.length, 1); f.setProviderContainerStatus("FINISHED");
  await observe(f);
  assert.equal((await row(f, saved.id)).deliveries.reel.providerObservationCount, 11);
  assert.equal(f.providerCalls.length, 1, "FINISHED arms the existing container before publishing");
  await observe(f);
  const published = await row(f, saved.id);
  assert.equal(published.phase, "published"); assert.equal(published.deliveries.reel.providerObservationCount, 12);
  assert.equal(published.deliveries.reel.intent.publicationId, publicationId);
  assert.deepEqual(f.providerCalls.map(value => value.operation), ["create", "publish"]);
  assert.ok(f.providerCalls.every(value => value.containerId === container));
  await observe(f); await f.reopen({ restartDatabase: true }); await observe(f);
  assert.equal(f.providerCalls.length, 2, "Later ticks and restart cannot duplicate either mutation");
  t.diagnostic("REAL_PG_AND_CHILD_PROCESS=YES; PROVIDER_TRANSPORT=CONTROLLED_ONLY; REAL_INSTAGRAM=NO");
});

test("physical imported MP4 repeated ERROR/EXPIRED stops at twelve observations while retaining the uncertain container", async t => {
  const f = await createOperationalCalendarPipelineFixture(t), saved = await start(f, await video(f), "EXPIRED");
  const initial = await row(f, saved.id), intent = initial.deliveries.reel.intent, container = f.providerCalls[0].containerId;
  for (let index = 0; index < 14; index++) { f.setProviderContainerStatus(index % 2 ? "ERROR" : "EXPIRED"); await observe(f); }
  const beforeRestart = await row(f, saved.id), reads = f.containerReads.length;
  assert.equal(beforeRestart.deliveries.reel.providerObservationCount, 12); assert.equal(reads, 13);
  assert.equal(beforeRestart.phase, "confirming"); assert.equal(beforeRestart.deliveries.reel.phase, "confirming");
  assert.deepEqual(beforeRestart.deliveries.reel.intent, intent);
  const publication = (await f.pg.adminPool.query("SELECT state, reconciliation_reference FROM ia4tube_social.social_publications WHERE id=$1", [intent.publicationId])).rows[0];
  assert.equal(publication.state, "provider_confirming"); assert.equal(publication.reconciliation_reference, `igc:created:${container}`);
  await f.reopen({ restartDatabase: true }); f.setProviderContainerStatus("FINISHED"); await observe(f);
  assert.equal(f.containerReads.length, reads); assert.equal(f.providerCalls.length, 1);
  assert.equal((await row(f, saved.id)).phase, "confirming", "Exhaustion is uncertainty, not an invented permanent failure");
});

test("physical imported JPEG keeps four follow-up checks and never opts into video processing recovery", async t => {
  const f = await createOperationalCalendarPipelineFixture(t);
  const ready = await f.preparePhoto({ selection: { kind: "image", targets: ["feed"], audioMode: "none" } });
  const saved = await start(f, ready, "IN_PROGRESS");
  for (let index = 0; index < 6; index++) await observe(f);
  assert.equal((await row(f, saved.id)).deliveries.feed.providerObservationCount, 4);
  assert.equal(f.containerReads.length, 5); assert.equal(f.providerCalls.length, 1);
});
