"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const model = require("../src/social/calendar/model");
const { createCalendarGrants } = require("../src/social/calendar/grants");
const { createCalendarMedia } = require("../src/social/calendar/media");
const { createCalendarService } = require("../src/social/calendar/service");
const { createSocialAuthAdapter } = require("../src/social/auth-adapter");
const { deriveSocialIdentity } = require("../src/social/identity");
const { SESSION_ISSUER, SESSION_AUDIENCE } = require("../src/social/reauth");
function memoryStore() {
  const rows = new Map(); let tail = Promise.resolve();
  return { rows, async exists(id) { return rows.has(id); }, update(id, action) {
    const pending = tail.then(async () => { const state = structuredClone(rows.get(id) || model.freshState());
      const result = await action(state); rows.set(id, state); return structuredClone(result); });
    tail = pending.catch(() => {}); return pending;
  } };
}
function fixture() {
  let now = model.dateTime("2026-09-10", "12:00"), open = true, clients = { "synthetic-owner": { ativo: true } };
  const identityConfig = { namespaceUuid: crypto.randomUUID(), key: crypto.randomBytes(32), derivationVersion: "identity_v1" };
  const identity = (legacyCompanyId, legacyUserId) => deriveSocialIdentity({ ...identityConfig,
    derivationKey: identityConfig.key, legacyCompanyId, legacyUserId });
  const ids = identity("synthetic-owner", "synthetic-owner"), store = memoryStore(), auth = createSocialAuthAdapter(identityConfig);
  const claims = { sub: "synthetic-owner", whatsapp: "synthetic-owner", company_id: "synthetic-owner", token_version: 2,
    iss: SESSION_ISSUER, aud: SESSION_AUDIENCE, jti: crypto.randomUUID() };
  const binding = { connectionId: crypto.randomUUID(), externalId: "123456789012345", connectionRevision: 2 };
  const grants = createCalendarGrants(crypto.randomBytes(32), () => now);
  const envelope = grants.issue({ ...ids, binding, revision: 2, planningId: "plan-synthetic", quantity: 1 });
  let sources = [{ key: "plan:1", planningId: "plan-synthetic", orderId: "order1", date: "2026-09-10", time: "12:00",
    caption: "Legenda original", imageReady: true, version: "1", authorizationEnvelope: envelope }];
  let currentBinding = binding, sends = 0, response = { published: true, mediaId: "12345", permalink: "https://www.instagram.com/p/Synthetic/" };
  const media = { prepare: async () => ({ sha: "a".repeat(64), sourceHash: "b".repeat(64) }), unchanged: async () => true,
    bytesFor: () => Buffer.from("synthetic"), close() {}, publicBytes() {} };
  const publisher = { allowed: () => open, connection: async () => currentBinding ? { binding: currentBinding, username: "synthetic" } : null,
    intent: (_ctx, _job, requestId) => ({ publicationId: requestId }),
    send: async () => { sends++; return response; }, status: async () => response };
  let sourceReads = 0;
  const service = createCalendarService({ store, source: { list: () => { sourceReads++; return sources; } }, media, grants, auth, identity,
    readClients: () => clients, publisher, clock: () => now });
  return { service, store, ids, claims, binding, grants, envelope, media, publisher,
    sends: () => sends, sourceReads: () => sourceReads, setOpen: value => open = value, setSources: value => sources = value,
    setTime: value => now = value, setBinding: value => currentBinding = value, setResponse: value => response = value,
    disableOwner: () => clients = {},
    async enable() { await service.preferences(claims, { enabled: true, revision: 1, confirmed: true }); },
    async first() { return (await service.list(claims)).items[0]; } };
}
test("São Paulo schedule uses explicit zone and rejects impossible dates", () => {
  assert.equal(new Date(model.dateTime("2026-09-10", "12:00")).toISOString(), "2026-09-10T15:00:00.000Z");
  assert.throws(() => model.dateTime("2026-02-30", "12:00"));
  assert.throws(() => model.dateTime("2026-09-10", "25:00"));
});
test("a signed grant is owner/plan/binding scoped, nonforgeable, and expires", () => {
  const f = fixture(); assert.ok(f.grants.verify(f.envelope, f.ids.companyId, f.ids.userId));
  assert.equal(f.grants.verify(f.envelope, crypto.randomUUID(), f.ids.userId), null);
  assert.equal(f.grants.verify(f.envelope + "00", f.ids.companyId, f.ids.userId), null);
  f.setTime(model.dateTime("2027-09-10", "12:00")); assert.equal(f.grants.verify(f.envelope, f.ids.companyId, f.ids.userId), null);
});
test("closed gates and paused preference never dispatch", async () => {
  const f = fixture(); await f.service.tick(); assert.equal(f.sends(), 0);
  await f.enable(); f.setOpen(false); await f.service.tick();
  assert.equal(f.sends(), 0); assert.equal((await f.first()).status, "operations_closed");
});
test("worker leaves historical accounts without an initialized calendar untouched", async () => {
  const f = fixture();
  await f.service.tick(); await f.service.tick();
  assert.equal(f.sourceReads(), 0); assert.equal(f.store.rows.size, 0); assert.equal(f.sends(), 0);
  // A normal authenticated gallery read initializes the same owner's calendar.
  await f.first(); const before = f.sourceReads(); await f.service.tick();
  assert.ok(f.sourceReads() > before); assert.equal(f.store.rows.size, 1); assert.equal(f.sends(), 0);
});
test("one due job uses existing publisher once, preserves result across repeated ticks", async () => {
  const f = fixture(); await f.enable(); await Promise.all([f.service.tick(), f.service.tick()]); await f.service.tick();
  assert.equal(f.sends(), 1); const job = await f.first(); assert.equal(job.status, "published"); assert.equal(job.editable, false);
  await assert.rejects(f.service.edit(f.claims, job.id, { action: "cancel", revision: job.revision }), { code: "calendar_dispatch_started" });
});
test("caption changes reuse item and calendar overlay, stale writes conflict", async () => {
  const f = fixture(); await f.enable(); const item = await f.first();
  const changed = await f.service.edit(f.claims, item.id, { action: "caption", caption: "Nova legenda", revision: item.revision });
  assert.equal(changed.items[0].id, item.id); assert.equal(changed.items[0].caption, "Nova legenda");
  await assert.rejects(f.service.edit(f.claims, item.id, { action: "caption", caption: "Antiga", revision: item.revision }), { code: "calendar_revision_conflict" });
  const overlay = await f.service.overlay(f.claims, { postagens: [{ calendar_key: item.key }] });
  assert.equal(overlay.postagens[0].legenda, "Nova legenda");
});

test("caption confirmation does not depend on a second connection read after the write", async () => {
  const f = fixture(); f.setOpen(false); const item = await f.first();
  const originalConnection = f.publisher.connection; let reads = 0;
  f.publisher.connection = async context => {
    reads++;
    if (f.store.rows.get(f.ids.companyId).jobs[item.id].caption === "Legenda confirmada") {
      throw Object.assign(new Error("synthetic post-commit read failure"), { code: "25P03" });
    }
    return originalConnection(context);
  };
  const response = await f.service.edit(f.claims, item.id,
    { action: "caption", caption: "Legenda confirmada", revision: item.revision });
  assert.equal(response.items[0].caption, "Legenda confirmada");
  assert.equal(response.items[0].revision, item.revision + 1);
  assert.equal(reads, 1); assert.equal(f.sends(), 0);
});

test("caption response is the committed owner snapshot without post-write resynchronization", async () => {
  const f = fixture(); f.setOpen(false); const item = await f.first();
  const foreignCompany = crypto.randomUUID();
  f.store.rows.set(foreignCompany, { ...model.freshState(), jobs: { foreign: { caption: "Foreign private caption" } } });
  const beforeSourceReads = f.sourceReads();
  const response = await f.service.edit(f.claims, item.id,
    { action: "caption", caption: " Nova legenda única ", revision: item.revision });
  assert.equal(f.sourceReads() - beforeSourceReads, 1);
  assert.equal(response.ok, true); assert.equal(response.enabled, true);
  assert.equal(response.operationsAllowed, false); assert.equal(response.preferences.enabled, false);
  assert.equal(response.timeZone, "America/Sao_Paulo"); assert.equal(Number.isFinite(response.serverTime), true);
  assert.equal(response.connection.username, "synthetic");
  assert.equal(response.items.length, 1); assert.equal(response.items[0].id, item.id);
  assert.equal(response.items[0].caption, "Nova legenda única");
  assert.equal(response.items[0].revision, item.revision + 1);
  assert.equal(response.items[0].imageUrl, item.imageUrl);
  assert.equal(f.store.rows.get(f.ids.companyId).jobs[item.id].caption, response.items[0].caption);
  assert.equal(JSON.stringify(response).includes("Foreign private caption"), false);
  assert.equal(f.sends(), 0);
});

test("failed connection preflight leaves the requested caption unmodified", async () => {
  const f = fixture(); const item = await f.first();
  f.publisher.connection = async () => { throw Object.assign(new Error("synthetic unavailable read"), { code: "25P03" }); };
  await assert.rejects(f.service.edit(f.claims, item.id,
    { action: "caption", caption: "Not saved", revision: item.revision }), { code: "25P03" });
  const stored = f.store.rows.get(f.ids.companyId).jobs[item.id];
  assert.equal(stored.caption, item.caption); assert.equal(stored.revision, item.revision);
  assert.equal(f.sends(), 0);
});

test("calendar HTTP returns the full updated caption snapshot in the single POST", async t => {
  const express = require("express");
  const { createCalendarRouter } = require("../src/social/calendar/router");
  const f = fixture(); f.setOpen(false); const item = await f.first();
  const originalConnection = f.publisher.connection;
  f.publisher.connection = async context => {
    if (f.store.rows.get(f.ids.companyId).jobs[item.id].caption === "Confirmada via HTTP") {
      throw new Error("synthetic post-commit read failure");
    }
    return originalConnection(context);
  };
  const app = express(); app.use(express.json());
  app.use("/v1/social/calendar", createCalendarRouter({ getService: () => f.service,
    authenticate: (req, _res, next) => { req.user = f.claims; next(); } }));
  const server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/social/calendar/items/${item.id}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "caption", caption: "Confirmada via HTTP", revision: item.revision })
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true); assert.equal(body.enabled, true);
  assert.equal(body.preferences.enabled, false); assert.equal(body.operationsAllowed, false);
  assert.equal(body.timeZone, "America/Sao_Paulo"); assert.equal(typeof body.serverTime, "number");
  assert.equal(body.items[0].id, item.id); assert.equal(body.items[0].caption, "Confirmada via HTTP");
  assert.equal(body.items[0].revision, item.revision + 1); assert.equal(body.items[0].imageUrl, item.imageUrl);
  assert.equal(f.store.rows.get(f.ids.companyId).jobs[item.id].revision, item.revision + 1);
  assert.equal(f.sends(), 0);
});

test("uncertain edit commit is surfaced once without replaying the mutation", async () => {
  const f = fixture(); const item = await f.first();
  const update = f.store.update.bind(f.store); let mutations = 0;
  f.store.update = async (companyId, operation) => {
    const before = f.store.rows.get(companyId)?.jobs[item.id]?.revision;
    const result = await update(companyId, operation);
    if (f.store.rows.get(companyId)?.jobs[item.id]?.revision !== before) {
      mutations++;
      throw Object.assign(new Error("synthetic lost commit acknowledgement"), { code: "08006" });
    }
    return result;
  };
  await assert.rejects(f.service.edit(f.claims, item.id,
    { action: "caption", caption: "Possibly saved", revision: item.revision }), { code: "08006" });
  assert.equal(mutations, 1); assert.equal(f.sends(), 0);
  assert.equal(f.store.rows.get(f.ids.companyId).jobs[item.id].revision, item.revision + 1);
});

test("oversized generated caption is attention for that art, not a blocked company or a silently truncated post", async () => {
  const f = fixture(); f.setSources([{ key: "plan:1", planningId: "plan-synthetic", orderId: "order1",
    date: "2026-09-10", time: "12:00", caption: "x".repeat(2201), imageReady: true, version: "1", authorizationEnvelope: f.envelope }]);
  await f.enable(); await f.service.tick(); assert.equal(f.sends(), 0);
  const item = await f.first(); assert.equal(item.status, "attention"); assert.equal(item.caption, "");
  await f.service.edit(f.claims, item.id, { action: "caption", caption: "Legenda revisada", revision: item.revision });
  assert.equal((await f.first()).caption, "Legenda revisada");
  await f.service.tick(); assert.equal(f.sends(), 1);
});
test("move changes same item; cancel removes only active schedule, never source", async () => {
  const f = fixture(); await f.enable(); let item = await f.first();
  await f.service.edit(f.claims, item.id, { action: "schedule", revision: item.revision, date: "2026-09-11", time: "13:30" });
  item = await f.first(); assert.equal(item.date, "2026-09-11"); assert.equal((await f.service.list(f.claims)).items.length, 1);
  await f.service.edit(f.claims, item.id, { action: "cancel", revision: item.revision });
  assert.equal((await f.service.list(f.claims)).items.length, 0); await f.service.tick(); assert.equal(f.sends(), 0);
  const stored = [...f.store.rows.values()][0]; assert.equal(Object.keys(stored.jobs).length, 1);
});
test("unknown outcome never repeats a POST, and edits are locked", async () => {
  const f = fixture(); f.setResponse(null); await f.enable(); await f.service.tick(); await f.service.tick();
  assert.equal(f.sends(), 1); assert.equal((await f.first()).status, "confirming");
  await assert.rejects(f.service.legacyEdit(f.claims, "", { action: "cancel", reference: { pedido_id: "order1" } }),
    { code: "calendar_refresh_required" });
  const item = await f.first();
  await assert.rejects(f.service.legacyEdit(f.claims, "", { action: "cancel", revision: item.revision, reference: { pedido_id: "order1" } }),
    { code: "calendar_dispatch_started" });
});
test("missed schedule does not burst publish after downtime", async () => {
  const f = fixture(); await f.enable(); f.setTime(model.dateTime("2026-09-10", "12:11")); await f.service.tick();
  assert.equal(f.sends(), 0); assert.equal((await f.first()).status, "overdue");
});
test("provider rejection is attention, not a forever publishing spinner; no automatic replacement", async () => {
  const f = fixture(); f.setResponse({ state: "failed_permanent", published: false }); await f.enable();
  await f.service.tick(); await f.service.tick(); assert.equal(f.sends(), 1);
  const item = await f.first(); assert.equal(item.status, "attention"); assert.equal(item.editable, false);
});
test("cancelling an authorized child does not give a replacement child extra authority", async () => {
  const f = fixture(); await f.enable(); const first = await f.first();
  await f.service.edit(f.claims, first.id, { action: "cancel", revision: first.revision });
  f.setSources([{ key: "plan:2", planningId: "plan-synthetic", orderId: "order2", date: "2026-09-10", time: "12:00",
    caption: "Extra", imageReady: true, version: "1", authorizationEnvelope: f.envelope }]);
  await f.service.tick(); assert.equal(f.sends(), 0); assert.equal((await f.first()).status, "manual");
});
test("connection change blocks old authorization; deactivated owner cannot dispatch", async () => {
  const f = fixture(); await f.enable(); f.setBinding({ ...f.binding, connectionRevision: 3 }); await f.service.tick();
  assert.equal(f.sends(), 0); assert.equal((await f.first()).status, "connection_required");
  f.disableOwner(); await f.service.tick(); assert.equal(f.sends(), 0);
});
test("old orders stay manual; image replacement revokes scheduled authority", async () => {
  const f = fixture(); await f.enable();
  f.setSources([{ key: "plan:1", planningId: "plan-synthetic", orderId: "order1", date: "2026-09-10", time: "12:00",
    caption: "Outra", imageReady: true, version: "2", authorizationEnvelope: f.envelope }]);
  await f.service.tick(); assert.equal(f.sends(), 0); assert.equal((await f.first()).status, "attention");
});
test("bounded order grants cannot authorize a different plan", async () => {
  const f = fixture(); f.setSources([{ key: "plan:2", planningId: "different-plan", orderId: "order2", date: "2026-09-10", time: "12:00",
    caption: "Outra", imageReady: true, version: "1", authorizationEnvelope: f.envelope }]);
  await f.enable(); await f.service.tick(); assert.equal(f.sends(), 0); assert.equal((await f.first()).status, "manual");
});
test("JPEG conversion preserves composition, private owner path and signed expiry", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-calendar-synthetic-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sharp = require("sharp"), original = await sharp({ create: { width: 400, height: 800, channels: 3, background: "#cc2244" } }).png().toBuffer();
  let now = model.dateTime("2026-09-10", "12:00"); const company = crypto.randomUUID();
  const media = createCalendarMedia({ dataDir: root, secret: "synthetic-secret-".repeat(4), publicOrigin: "https://synthetic.invalid",
    clock: () => now, loadSource: async () => original }); t.after(() => media.close());
  const asset = await media.prepare("synthetic", company, {}), job = { asset, caption: "Exata" };
  const jpeg = media.bytesFor(company, asset), meta = await sharp(jpeg).metadata();
  assert.equal(meta.format, "jpeg"); assert.equal(meta.width, 1080); assert.equal(meta.height, 1080);
  assert.equal(model.digest(original), asset.sourceHash); assert.throws(() => media.bytesFor(crypto.randomUUID(), asset));
  const url = new URL(media.descriptor(company, job).publicUrl), fields = url.pathname.split("/").slice(-4);
  assert.deepEqual(media.publicBytes(...fields), jpeg); fields[3] = "0".repeat(64); assert.throws(() => media.publicBytes(...fields));
  now += 901000; assert.throws(() => media.publicBytes(...new URL(media.descriptor(company, job).publicUrl).pathname.split("/").slice(-4).map((v,i) => i === 2 ? String(Number(v) - 901) : v)));
});
