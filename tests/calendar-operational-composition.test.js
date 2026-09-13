"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createOperationalCalendarImportsRuntimeFactory, isOperationalCalendarImportsRuntimeFactory,
  isOperationalCalendarImportsRuntime } = require("../src/social/calendar/imports/operational-runtime");
const { createLocalPublicationTransport } = require("../src/social/calendar/imports/publication-test-transport");
const { createPreparedCalendarMedia, isPreparedCalendarMedia } = require("../src/social/calendar/imports/prepared-publication-media");
const { validatePreparedPublicationPart } = require("../src/social/calendar/imports/publication-descriptor");
test("operational imports composition defaults disabled and never probes or starts a worker", async () => {
  let calls = 0;
  const factory = createOperationalCalendarImportsRuntimeFactory({ verifyReadiness() { calls++; throw new Error("must not run"); } });
  assert.equal(isOperationalCalendarImportsRuntimeFactory(factory), true);
  assert.equal(await factory(), null); assert.equal(calls, 0);
  assert.equal(isOperationalCalendarImportsRuntimeFactory({ ...factory }), false);
  assert.equal(isOperationalCalendarImportsRuntime({ ready: true }), false);
});
test("an enabled factory refuses capability lookalikes before generic readiness can authorize anything", async () => {
  let probes = 0;
  const factory = createOperationalCalendarImportsRuntimeFactory({ enabled: true,
    uploadStore: { capabilities: { persistence: "durable" }, verify: async () => true },
    resultStore: { capabilities: { available: true, actualInspection: true } },
    transfer: { available: true, wrapUpload: value => value }, verifyReadiness: async () => { probes++; return true; } });
  await assert.rejects(factory({ store: { capabilities: { durable: true }, verify: async () => true } }),
    { code: "calendar_import_runtime_invalid" });
  assert.equal(probes, 0);
});
test("controlled transport requires a separate explicit opt-in and never qualifies as production factory", async () => {
  const transport = createLocalPublicationTransport(async () => assert.fail("No network in composition"));
  assert.throws(() => createOperationalCalendarImportsRuntimeFactory({ localTransport: transport }), { code: "calendar_import_runtime_invalid" });
  const factory = createOperationalCalendarImportsRuntimeFactory({ localTransport: transport, allowLocalTransportForTests: true });
  assert.equal(isOperationalCalendarImportsRuntimeFactory(factory), false);
  assert.equal(isOperationalCalendarImportsRuntimeFactory(factory, { allowLocalTransportForTests: true }), true);
  assert.equal(await factory(), null);
  assert.throws(() => createOperationalCalendarImportsRuntimeFactory({ localTransport: async () => {}, allowLocalTransportForTests: true }),
    { code: "calendar_import_runtime_invalid" });
});
test("prepared provider media stays unavailable without genuine stores even with enabled booleans", async () => {
  const value = createPreparedCalendarMedia({ enabled: true, store: { update() {} }, resultStore: { capabilities: { available: true } } });
  assert.equal(value.available, false); assert.equal(isPreparedCalendarMedia(value), false);
  await assert.rejects(value.publicMedia({}), { code: "calendar_import_publication_media_unavailable" });
});
const video = { mimeType: "video/mp4", size: 100000000, sizeBytes: 100000000, width: 1080, height: 1920,
  durationSeconds: 3, hasAudio: false, audioMode: "muted", shareToFeed: false };
test("same operational availability and descriptor guard accepts exact conservative provider boundaries", () => {
  assert.equal(validatePreparedPublicationPart("story", video, ["story"]), true);
  assert.equal(validatePreparedPublicationPart("reel", { ...video, durationSeconds: 60, shareToFeed: true }, ["story", "reel"]), true);
});
for (const change of [{ durationSeconds: 2.999 }, { durationSeconds: 60.001 }, { size: 100000001, sizeBytes: 100000001 },
  { sizeBytes: 1 }, { audioMode: "muted", hasAudio: true }, { audioMode: "music", hasAudio: false }, { shareToFeed: true }, { width: 1079 }])
  test(`operational publication guard refuses ${JSON.stringify(change)}`, () => {
    assert.throws(() => validatePreparedPublicationPart("story", { ...video, ...change }, ["story"]),
      { code: "calendar_import_prepared_media_unavailable" });
  });
