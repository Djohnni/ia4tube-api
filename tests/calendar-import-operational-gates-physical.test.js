"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createOperationalCalendarPipelineFixture, PREFIX, slot } = require("./helpers/operational-calendar-pipeline-fixture");

test("real publisher gates block imported automatic creation and reactivation but preserve manual scheduling and existing records", async t => {
  const f = await createOperationalCalendarPipelineFixture(t);
  const ready = await f.preparePhoto({ selection: { kind: "image", targets: ["feed"], audioMode: "none" } });
  assert.equal(ready.status.ready, true);
  const input = f.inputFor(ready);
  const active = await f.current().scheduling.schedule(f.context, input);
  const paused = await f.current().scheduling.edit(f.context, active.id, { action: "automatic", enabled: false, revision: active.revision });
  const witness = await f.current().scheduling.schedule(f.context, f.inputFor(ready, slot(f.clock(), 1, 5)));
  const existingOriginal = await f.current().calendarStore.update(f.context.companyId, state => state.jobs[f.original.id]);
  for (const closed of ["publication", "both"]) {
    // The real config rejects publication=true with connection=false. Do not weaken that invariant for a fixture.
    f.setFixtureGate(false); f.setFixtureConnectionGate(closed !== "both");
    await f.reopen();
    const response = await f.request(`${PREFIX}/assets/${ready.assetId}/schedule-availability`);
    assert.equal(response.status, 200);
    const availability = (await response.json()).availability;
    assert.equal(availability.connected, true, "Closing a gate does not disconnect Instagram");
    assert.equal(availability.authorized, true, "Saved preference/binding alone are not a live gate");
    assert.equal(availability.calendarSaveAllowed, true);
    assert.equal(availability.automaticAllowed, false);
    assert.equal(availability.blockedReason, "calendar_import_operations_closed");
    const automatic = f.inputFor(ready, { ...slot(f.clock(), 1, 15) });
    const { assetId, ...body } = automatic;
    const denied = await f.post(`${PREFIX}/assets/${assetId}/schedule`, body);
    assert.equal(denied.status, 409); assert.equal((await denied.json()).code, "calendar_import_operations_closed");
    // Exact replay is observation of the same paused record, never new consent.
    assert.equal((await f.current().scheduling.schedule(f.context, input)).automaticEnabled, false);
    await assert.rejects(f.current().scheduling.edit(f.context, paused.id,
      { action: "automatic", enabled: true, confirmed: true, revision: paused.revision }), { code: "calendar_import_operations_closed" });
    const deniedEdit = await f.post(`/v1/social/calendar/items/${paused.id}`,
      { action: "automatic", enabled: true, confirmed: true, revision: paused.revision });
    assert.equal(deniedEdit.status, 409); assert.equal((await deniedEdit.json()).code, "calendar_import_operations_closed");
    const saved = await f.current().scheduling.schedule(f.context, f.inputFor(ready,
      { automatic: false, ...slot(f.clock(), 1, closed === "publication" ? 30 : 60) }));
    assert.equal(saved.automaticEnabled, false);
    const changed = await f.post(`/v1/social/calendar/items/${saved.id}`,
      { action: "caption", caption: "Legenda manual preservada", revision: saved.revision });
    assert.equal(changed.status, 200);
    assert.equal((await changed.json()).items.find(item => item.id === saved.id).caption, "Legenda manual preservada");
    assert.equal((await f.current().calendar.list(f.claims)).items.find(item => item.id === witness.id).status, "operations_closed");
    await f.current().calendar.tick(); assert.equal(f.providerCalls.length, 0);
    assert.deepEqual(await f.current().calendarStore.update(f.context.companyId, state => state.jobs[f.original.id]), existingOriginal);
  }
  f.advance(86400000 + 10 * 60000); await f.current().calendar.tick();
  assert.equal(f.providerCalls.length, 0, "Due imported jobs still cannot bypass either worker gate");
  assert.equal(f.counters.inspectionSourceReads, 1); assert.equal(f.counters.preparationSourceReads, 1);
  t.diagnostic("PG=REAL_LOOPBACK; PREPARED_PHOTO=REAL_LOCAL; CONNECTION_RETAINED=YES; EXTERNAL_PROVIDER_CALLS=0; PUBLICATION_CLOSED_AND_BOTH_CLOSED=YES");
});
