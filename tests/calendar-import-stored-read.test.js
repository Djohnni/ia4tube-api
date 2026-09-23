"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto"), path = require("node:path"), os = require("node:os");
const { freshState } = require("../src/social/calendar/model");
const { createCalendarStore } = require("../src/social/calendar/store");
const { createImportUploadPostgresStore } = require("../src/social/calendar/imports/postgres-store");
const { createStoredCalendarMediaReader, isStoredCalendarMediaReader } = require("../src/social/calendar/imports/stored-calendar-media");
const { createPreparedDiskResultReader, isPreparedDiskResultStore } = require("../src/social/calendar/imports/prepared-disk-store");
const { createImportAccessPolicy } = require("../src/social/calendar/imports/access-policy");
function fixture() {
  const context = { authenticated: true, companyId: crypto.randomUUID(), userId: crypto.randomUUID() }, statements = [];
  const id = "a".repeat(40), state = freshState(), assetId = crypto.randomUUID();
  state.jobs[id] = { id, phase: "ready", sourceKind: "upload", import: { operational: true, userId: context.userId,
    assetId, mediaRevision: 1, previewDigest: "a".repeat(64), selection: { shareToFeed: true }, preview: {
      assetId, mediaRevision: 1, previewDigest: "a".repeat(64), variants: [{ target: "reel", mimeType: "video/mp4", sha256: "b".repeat(64), sizeBytes: 128 }] } } };
  const pool = { async connect() { return { release() {}, async query(sql, args = []) {
    statements.push(sql);
    if (sql.startsWith("SELECT document")) return { rows: args[0] === context.companyId ? [{ document: structuredClone(state) }] : [] };
    return { rows: [] };
  } }; } };
  const store = createCalendarStore({ pool, role: "ia4tube_social_runtime" }), uploadStore = createImportUploadPostgresStore({ pool });
  const reader = createStoredCalendarMediaReader({ store, uploadStore,
    rootDirectory: path.join(os.tmpdir(), "not-created-stored-media"), preparationRoot: path.join(os.tmpdir(), "not-created-preparation") });
  return { context, id, state, statements, store, uploadStore, reader };
}
test("stored metadata keeps its private owner URL without a pilot, allocation, write or public fallback", async () => {
  const f = fixture(); assert.equal(isStoredCalendarMediaReader(f.reader), true); assert.equal(isStoredCalendarMediaReader({ ...f.reader }), false);
  assert.equal(f.reader.schedule, undefined); assert.equal(f.reader.upload, undefined); assert.equal(f.reader.prepare, undefined);
  const result = await f.reader.metadata(f.context, { id: f.id });
  assert.equal(result.shareToFeed, true); assert.equal(result.variants[0].url,
    `https://ia4tube-api.onrender.com/v1/social/calendar/imports/schedules/${f.id}/preview/reel`);
  result.variants[0].sha256 = "changed";
  assert.equal((await f.reader.metadata(f.context, { id: f.id })).variants[0].sha256, "b".repeat(64));
  assert.ok(f.statements.every(sql => /^(?:BEGIN|COMMIT|ROLLBACK|SET LOCAL ROLE|SELECT )/.test(sql)));
  assert.equal(f.statements.some(sql => /INSERT|UPDATE|DELETE|CREATE|FOR UPDATE/.test(sql)), false);
});
test("stored reader rejects foreign company, same-company foreign user, anonymous, cancellation and closed reader", async () => {
  const f = fixture();
  for (const context of [{ ...f.context, companyId: crypto.randomUUID() }, { ...f.context, userId: crypto.randomUUID() },
    { ...f.context, authenticated: false }]) await assert.rejects(f.reader.metadata(context, { id: f.id }), { statusCode: 404 });
  f.state.jobs[f.id].phase = "cancelled"; await assert.rejects(f.reader.metadata(f.context, { id: f.id }), { statusCode: 404 });
  f.state.jobs[f.id].phase = "ready"; f.reader.close(); await assert.rejects(f.reader.metadata(f.context, { id: f.id }), { statusCode: 503 });
});
test("read-only prepared object cannot be substituted for the operational result store or expose commit", () => {
  const f = fixture(), accessPolicy = createImportAccessPolicy({ allowedOwners: [f.context] });
  const reader = createPreparedDiskResultReader({ tenantStore: f.uploadStore, accessPolicy, enabled: true,
    rootDirectory: path.join(os.tmpdir(), "not-created-stored-media"), preparationRoot: path.join(os.tmpdir(), "not-created-preparation") });
  assert.equal(reader.capabilities.available, true); assert.equal(reader.capabilities.readOnly, true);
  assert.equal(reader.commit, undefined); assert.equal(reader.inspectCommitted, undefined);
  assert.equal(isPreparedDiskResultStore(reader), false); assert.equal(isPreparedDiskResultStore(reader, { allowVolatileForTests: true }), false);
});
test("older or malformed imported metadata has no media descriptor instead of breaking the calendar list", async () => {
  const f = fixture();
  f.state.jobs[f.id].import.operational = false;
  assert.equal(f.reader.describe(f.state.jobs[f.id], f.context), null);
  await assert.rejects(f.reader.metadata(f.context, { id: f.id }), { statusCode: 404 });
  f.state.jobs[f.id].import.operational = true; f.state.jobs[f.id].import.preview = null;
  assert.equal(f.reader.describe(f.state.jobs[f.id], f.context), null);
  await assert.rejects(f.reader.metadata(f.context, { id: f.id }), { statusCode: 409 });
});
