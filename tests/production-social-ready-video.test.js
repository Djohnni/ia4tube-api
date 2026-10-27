"use strict";
// Host lifecycle/assembly contracts. Codec and SQL ports are synthetic here;
// physical Linux and PostgreSQL evidence belongs to their separate suites.
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
const { initializeProductionReadyVideo, assertProductionPreparationBoundary } = require("../src/social/production-integration");
const owner = { companyId: "11111111-1111-4111-8111-111111111111", userId: "22222222-2222-4222-8222-222222222222" };
function env() { return { ENVIRONMENT: "production", PUBLIC_API_BASE_URL: "https://ia4tube-api.onrender.com", SOCIAL_PERSISTENCE_ENABLED: "true",
  SOCIAL_INSTAGRAM_ENABLED: "true", SOCIAL_CALENDAR_ENABLED: "true", SOCIAL_READY_VIDEO_IMPORTS_ENABLED: "true",
  SOCIAL_READY_VIDEO_ALLOWED_SUBJECTS_JSON: '["159911205989"]', META_APP_REVIEW_WINDOW_ENABLED: "false",
  SOCIAL_EXTERNAL_CONNECTION_ENABLED: "true", SOCIAL_EXTERNAL_PUBLICATION_ENABLED: "true" }; }
function patch(t, modulePath, replacement) {
  const id = require.resolve(modulePath); require(id); const original = require.cache[id].exports;
  require.cache[id].exports = { ...original, ...replacement }; t.after(() => { require.cache[id].exports = original; });
}
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ready-video-integration-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const events = [], logs = [], identities = [], clients = { "159911205989": { ativo: true } }, pools = [];
  let captured, codecOptions;
  patch(t, "../src/social/calendar/imports/ready-video-config", { async loadReadyVideoPoolConfigs() {
    events.push("configs"); if (options.configFailure) throw Error("synthetic-private-url");
    return { capacity: { kind: "capacity" }, transfer: { kind: "transfer" } };
  } });
  patch(t, "../src/persistence/postgres/pool", { createPostgresPool(config) {
    events.push(config.kind + "-create"); if (options.secondPoolFailure && config.kind === "transfer") throw Error("synthetic-private-password");
    const pool = { kind: config.kind, async end() { events.push(config.kind + "-close"); } }; pools.push(pool); return pool;
  } });
  patch(t, "../src/social/calendar/imports/ready-video-codec-executor", { createReadyVideoCodecExecutor(value) {
    codecOptions = value; events.push("codec"); return { synthetic: true };
  } });
  const factory = async () => ({});
  patch(t, "../src/social/calendar/imports/ready-video-runtime", { async createReadyVideoRuntime(value) {
    captured = value; events.push("runtime");
    assert.equal((await fs.stat(codecOptions.workingRoot)).isDirectory(), true);
    for (const directory of codecOptions.allowedRoots) assert.equal((await fs.stat(directory)).isDirectory(), true);
    if (options.runtimeFailure) throw Error("synthetic-private-runtime");
    return { factory, start() { events.push("start"); }, async close() { events.push("video-close"); if (options.closeFailure) throw Error("private-close"); } };
  } });
  const ports = { pool: { kind: "social" }, identity(company, user) { identities.push([company, user]); return owner; } };
  const dependencies = { readClients: () => clients, logger: { warn: value => logs.push(value) } };
  return { root, events, logs, identities, clients, pools, ports, dependencies, factory,
    get captured() { return captured; }, get codecOptions() { return codecOptions; } };
}
test("default-off does not read client/configuration records or initialize video resources", async t => {
  const f = await fixture(t); f.dependencies.readClients = () => assert.fail("clients read while disabled");
  const result = await initializeProductionReadyVideo({ env: {}, ports: f.ports, dependencies: f.dependencies, rootDirectory: f.root });
  assert.equal(result, null); assert.deepEqual(f.events, []); assert.deepEqual(f.identities, []);
});
test("malformed, pilot-conflicting and custom-factory video configuration closes only video", async t => {
  const f = await fixture(t);
  for (const patch of [{ SOCIAL_READY_VIDEO_IMPORTS_ENABLED: "TRUE" }, { SOCIAL_MEDIA_IMPORTS_ENABLED: "true" }]) {
    assert.equal(await initializeProductionReadyVideo({ env: { ...env(), ...patch }, ports: f.ports, dependencies: f.dependencies, rootDirectory: f.root }), null);
  }
  assert.doesNotThrow(() => assertProductionPreparationBoundary({ SOCIAL_READY_VIDEO_IMPORTS_ENABLED: "TRUE" }));
  assert.equal(await initializeProductionReadyVideo({ env: env(), ports: f.ports,
    dependencies: { ...f.dependencies, importsRuntimeFactory() {} }, rootDirectory: f.root }), null);
  assert.deepEqual(f.events, []);
  assert.ok(f.logs.every(value => value.component === "calendar_ready_video" && value.code === "calendar_ready_video_unavailable"));
});
test("active clients resolve through the existing subject identity and eligibility is rechecked", async t => {
  const f = await fixture(t), state = await initializeProductionReadyVideo({ env: env(), ports: f.ports, dependencies: f.dependencies, rootDirectory: f.root });
  assert.equal(state.factory, f.factory); assert.deepEqual(f.identities, [["159911205989", "159911205989"]]);
  assert.equal(f.captured.tenantPool, f.ports.pool); assert.notEqual(f.captured.capacityPool, f.captured.transferPool);
  assert.deepEqual(f.codecOptions.allowedRoots, ["uploads", "prepared", "ready-video/inspection", "ready-video/preparation"].map(value => path.join(f.root, value)));
  assert.equal(f.codecOptions.workingRoot, path.join(f.root, "ready-video", "codec"));
  assert.equal(f.captured.isEligibleOwner(owner), true);
  assert.equal(f.captured.isEligibleOwner({ ...owner, userId: "33333333-3333-4333-8333-333333333333" }), false);
  f.clients["159911205989"].ativo = false;
  assert.equal(f.captured.isEligibleOwner(owner), false);
  assert.throws(() => f.captured.resolveOwnerForSubject("159911205989"), { code: "ready_video_owner_unavailable" });
  assert.throws(() => f.captured.resolveOwnerForSubject("phone-company-id"), { code: "ready_video_owner_unavailable" });
  state.start(); await state.close(); await state.close(); state.start();
  assert.deepEqual(f.events.slice(-4), ["start", "video-close", "capacity-close", "transfer-close"]);
});
test("inactive and unfinished automatic clients never create pools", async t => {
  const f = await fixture(t);
  for (const client of [{ ativo: false }, { ativo: true, cadastro_automatico: true, conta_finalizada: false }]) {
    f.clients["159911205989"] = client;
    assert.equal(await initializeProductionReadyVideo({ env: env(), ports: f.ports, dependencies: f.dependencies, rootDirectory: f.root }), null);
  }
  assert.deepEqual(f.events, []); assert.deepEqual(f.identities, []);
});
test("partial pool creation is cleaned without exposing provider messages", async t => {
  const f = await fixture(t, { secondPoolFailure: true });
  assert.equal(await initializeProductionReadyVideo({ env: env(), ports: f.ports, dependencies: f.dependencies, rootDirectory: f.root }), null);
  assert.deepEqual(f.events, ["configs", "capacity-create", "transfer-create", "capacity-close"]);
  assert.equal(JSON.stringify(f.logs).includes("private"), false);
});
test("runtime failure closes both restricted pools and preserves the shared tenant pool", async t => {
  const f = await fixture(t, { runtimeFailure: true });
  assert.equal(await initializeProductionReadyVideo({ env: env(), ports: f.ports, dependencies: f.dependencies, rootDirectory: f.root }), null);
  assert.deepEqual(f.events.slice(-2), ["capacity-close", "transfer-close"]); assert.equal(f.pools.length, 2);
  assert.equal(JSON.stringify(f.logs).includes("private"), false);
});
test("factory failure drains video and both pools even when video cleanup fails", async t => {
  const f = await fixture(t, { closeFailure: true });
  const state = await initializeProductionReadyVideo({ env: env(), ports: f.ports, dependencies: f.dependencies, rootDirectory: f.root });
  await assert.doesNotReject(state.onImportsUnavailable(Error("private-factory-failure"))); state.start();
  assert.deepEqual(f.events.slice(-3), ["video-close", "capacity-close", "transfer-close"]);
  assert.deepEqual(f.logs.map(row => row.code), ["calendar_ready_video_unavailable", "calendar_ready_video_cleanup_failed"]);
});
test("optional import factory failure preserves core calendar assembly and native history reads", async t => {
  const rootModule = require.resolve("../src/social/calendar"); require(rootModule); const priorRoot = require.cache[rootModule];
  const events = [], store = { async verify() { events.push("verify"); } }, importsFactory = async () => { throw Error("private-factory"); };
  patch(t, "../src/social/calendar/store", { createCalendarStore: () => store });
  patch(t, "../src/social/calendar/source", { createCalendarSource: () => ({ load() {}, describe() {} }) });
  patch(t, "../src/social/calendar/media", { createCalendarMedia: () => ({ close() { events.push("media-close"); } }) });
  patch(t, "../src/social/calendar/grants", { createCalendarGrants: () => ({ close() { events.push("grants-close"); } }) });
  patch(t, "../src/social/calendar/publisher", { createCalendarPublisher: () => { events.push("publisher"); return {}; } });
  patch(t, "../src/social/calendar/service", { createCalendarService: () => ({ async close() { events.push("calendar-close"); } }) });
  patch(t, "../src/social/calendar/imports/operational-runtime", { isOperationalCalendarImportsRuntimeFactory: value => value === importsFactory });
  patch(t, "../src/social/calendar/imports/postgres-store", { createImportUploadPostgresStore: () => ({}) });
  patch(t, "../src/social/calendar/imports/stored-calendar-media", { createStoredCalendarMediaReader(value) {
    assert.equal(value.nativeProfile, "native_mp4_v1"); events.push("history"); return { close() { events.push("history-close"); } };
  } });
  delete require.cache[rootModule]; t.after(() => { require.cache[rootModule] = priorRoot; });
  const { createProductionCalendar } = require(rootModule);
  const dependencies = { secret: "synthetic", readClients: () => ({}), importsRuntimeFactory: importsFactory,
    async onImportsUnavailable() { events.push("feature-closed"); } };
  const ports = { pool: {}, role: "ia4tube_social_runtime", config: { publicOrigin: "https://ia4tube-api.onrender.com" } };
  const calendar = await createProductionCalendar(dependencies, ports);
  assert.equal(calendar.imports, null); assert.ok(calendar.storedImportMedia);
  assert.deepEqual(events, ["verify", "feature-closed", "publisher", "history"]);
  await calendar.close(); assert.deepEqual(events.slice(-2), ["calendar-close", "history-close"]);
  // Default legacy behavior still rejects a failing injected factory.
  await assert.rejects(createProductionCalendar({ ...dependencies, onImportsUnavailable: undefined }, ports), /private-factory/);
});
