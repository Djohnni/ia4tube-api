"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const { createOperationalCalendarPipelineFixture, PREFIX, hash } = require("./helpers/operational-calendar-pipeline-fixture");
const { createPreparedDiskResultReader, isPreparedDiskResultStore } = require("../src/social/calendar/imports/prepared-disk-store");
test("closed imports retain exact scheduled photo/video reads after restart without preparation, admission, publication or database writes", async t => {
  const f = await createOperationalCalendarPipelineFixture(t);
  await f.executor.prepareRuntime();
  const prepared = [await f.preparePhoto({ selection: { kind: "image", targets: ["feed"], audioMode: "none" } }),
    await f.prepareVideo({ selection: { kind: "video", targets: ["reel"], audioMode: "original", shareToFeed: true } })];
  const expected = [];
  for (const ready of prepared) {
    const request = { uploadId: ready.uploadId, idempotencyKey: crypto.randomUUID(), expectedMediaRevision: ready.mediaRevision,
      selection: ready.request.selection, caption: "Calendário preservado após fechar o piloto" };
    const response = await f.post(`${PREFIX}/assets/${ready.assetId}/calendar-submissions`, request);
    assert.equal(response.status, 200); const receipt = (await response.json()).submission;
    await f.current().imports.submissions.progress(f.context.companyId);
    const item = (await f.current().calendar.list(f.claims)).items.find(item => item.id === receipt.id);
    assert.ok(item.media); const part = item.media.variants[0];
    const bytes = Buffer.from(await (await f.request(new URL(part.url).pathname)).arrayBuffer());
    assert.equal(hash(bytes), part.sha256);
    expected.push({ item, part, bytes });
  }
  f.setFixtureGate(false); await f.reopen({ restartDatabase: true, importsDisabled: true });
  assert.equal(f.current().imports, null); assert.equal(f.current().publisher.preparedAvailable, false);
  const counters = structuredClone(f.counters);
  const before = await f.pg.adminPool.query("SELECT company_id,revision,document FROM ia4tube_calendar.import_upload_state ORDER BY company_id");
  const beforeCalendar = await f.pg.adminPool.query("SELECT company_id,revision,document FROM ia4tube_calendar.owner_state ORDER BY company_id");
  const items = (await f.current().calendar.list(f.claims)).items;
  for (const { item, part, bytes } of expected) {
    const kept = items.find(value => value.id === item.id);
    assert.equal(kept.date, item.date); assert.equal(kept.time, item.time); assert.equal(kept.caption, item.caption);
    assert.equal(kept.mediaReadAvailable, true); assert.equal(kept.shareToFeed, item.shareToFeed);
    const path = new URL(kept.media.variants[0].url).pathname;
    const response = await f.request(path); assert.equal(response.status, 200);
    assert.equal(hash(Buffer.from(await response.arrayBuffer())), part.sha256);
    const range = await f.request(path, { headers: { Range: "bytes=0-31" } });
    assert.equal(range.status, 206); assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(0, 32));
    assert.equal((await f.request(path, { method: "HEAD" })).status, 200);
    assert.equal((await f.request(path, { method: "POST" })).status, 405);
    assert.equal((await f.request(path, { headers: { Authorization: `Bearer ${f.otherToken}` } })).status, 404);
    assert.equal((await f.request(path, { headers: { Range: "bytes=999999999-" } })).status, 416);
  }
  assert.deepEqual((await f.pg.adminPool.query("SELECT company_id,revision,document FROM ia4tube_calendar.import_upload_state ORDER BY company_id")).rows, before.rows);
  assert.deepEqual((await f.pg.adminPool.query("SELECT company_id,revision,document FROM ia4tube_calendar.owner_state ORDER BY company_id")).rows, beforeCalendar.rows);
  const capability = await (await f.request(`${PREFIX}/capabilities`)).json(); assert.equal(capability.enabled, false);
  assert.equal((await f.post(`${PREFIX}/uploads`, {})).status, 503);
  assert.equal((await f.post(`${PREFIX}/assets/${prepared[0].assetId}/calendar-submissions`, {})).status, 503);
  await f.current().calendar.tick(); assert.equal(f.providerCalls.length, 0); assert.deepEqual(f.counters, counters);
  const reader = createPreparedDiskResultReader({ rootDirectory: f.privateRoot, preparationRoot: f.preparationRoot,
    tenantStore: f.store, accessPolicy: f.accessPolicy, enabled: true, clock: f.clock });
  assert.equal(reader.commit, undefined); assert.equal(reader.inspectCommitted, undefined); assert.equal(isPreparedDiskResultStore(reader), false);
  const target = items.find(item => item.id === expected[0].item.id);
  await f.current().calendar.edit(f.claims, target.id, { action: "cancel", revision: target.revision });
  assert.equal((await f.request(new URL(expected[0].part.url).pathname)).status, 404);
  await assert.rejects(f.current().scheduling.metadata({ ...f.context, userId: crypto.randomUUID() }, { id: expected[1].item.id }), { statusCode: 404 });
});
