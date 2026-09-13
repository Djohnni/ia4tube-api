"use strict";
const assert = require("node:assert/strict"), crypto = require("node:crypto"), jwt = require("jsonwebtoken"), sharp = require("sharp"), express = require("express");
const { createPrivatePipelineFixture } = require("./gallery-private-pipeline-fixture");
const { createLocalCalendarDeliverySimulator } = require("./local-calendar-delivery-simulator");
const { createProductionSession } = require("../../src/social/production-session");
const { createSocialAuthAdapter } = require("../../src/social/auth-adapter");
const { createImportAccessPolicy } = require("../../src/social/calendar/imports/access-policy");
const { createLocalCalendarSimulationStore } = require("../../src/social/calendar/imports/local-calendar-simulation");
const { createLocalCalendarImportService } = require("../../src/social/calendar/imports/local-calendar-service");
const { createCalendarService } = require("../../src/social/calendar/service");
const { createCalendarMedia } = require("../../src/social/calendar/media");
const { createCalendarGrants } = require("../../src/social/calendar/grants");
const { createCalendarRouter } = require("../../src/social/calendar/router");
const { createCalendarImportRouter } = require("../../src/social/calendar/imports/router");
const { createPrivateImportPreviewRouter } = require("../../src/social/calendar/imports/preview-router");
const { createPrivateImportPreviewService } = require("../../src/social/calendar/imports/preview-service");
const PREFIX = "/v1/social/calendar/imports";
function slot(now, days = 1, minutes = 0) {
  const fields = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(now + days * 86400000 + minutes * 60000))
    .filter(item => item.type !== "literal").map(item => [item.type, item.value]));
  return { date: `${fields.year}-${fields.month}-${fields.day}`, time: `${fields.hour}:${fields.minute}` };
}
async function createSchedulePipelineFixture(t, options = {}) {
  let eligible = true;
  const owner = "synthetic-calendar-owner", other = "synthetic-calendar-other", clients = { [owner]: { ativo: true }, [other]: { ativo: true } };
  const session = createProductionSession({ secret: crypto.randomBytes(48).toString("hex"), readClients: () => clients });
  const auth = createSocialAuthAdapter({ namespaceUuid: crypto.randomUUID(), key: crypto.randomBytes(32), derivationVersion: "synthetic-schedule-v1" });
  const token = session.sign(owner), otherToken = session.sign(other), claims = jwt.decode(token), principal = auth.fromVerifiedJwt(claims);
  const context = { authenticated: true, companyId: principal.companyId, userId: principal.userId };
  const accessPolicy = createImportAccessPolicy({ allowedOwners: [context], isEligible: () => eligible });
  const f = await createPrivatePipelineFixture(t, { ...options, context, accessPolicy });
  const simulation = createLocalCalendarSimulationStore({ enabled: true }), calendarStore = simulation.store;
  const binding = { connectionId: crypto.randomUUID(), externalId: "123456789012345", connectionRevision: 1 };
  let connection = { binding, username: "synthetic_local_account", accountType: "business" };
  const originalBytes = await sharp({ create: { width: 160, height: 200, channels: 3, background: "#532a75" } }).png().toBuffer();
  const generatedSource = { key: "synthetic-plan:original", planningId: "synthetic-plan", orderId: "synthetic-original-order",
    ...slot(f.clock(), 2), caption: "Arte original preservada", imageReady: true, version: "1" };
  let sources = [generatedSource];
  const media = createCalendarMedia({ dataDir: f.root, secret: crypto.randomBytes(48).toString("hex"),
    publicOrigin: "https://synthetic.invalid", loadSource: async () => originalBytes, clock: f.clock });
  const scheduling = createLocalCalendarImportService({ simulation, preparation: f.preparation, resultStore: f.preparedStore,
    accessPolicy, catalog: f.catalog, resolveConnection: async () => connection, enabled: true, clock: f.clock,
    upload: f.upload, provider: f.provider, uploadStore: f.store,
    async resolveGeneratedArt(context, request) {
      accessPolicy.resolve(context);
      const job = await calendarStore.update(context.companyId, state => state.jobs[request.calendarItemId]);
      if (!job || job.sourceKind === "upload" || job.revision !== request.revision || job.phase === "cancelled" || !job.asset)
        throw Object.assign(new Error("calendar_import_source_changed"), { code: "calendar_import_source_changed", statusCode: 409 });
      return { bytes: media.bytesFor(context.companyId, job.asset), mimeType: "image/jpeg" };
    } });
  const grants = createCalendarGrants(crypto.randomBytes(48), f.clock);
  const deliverySimulator = createLocalCalendarDeliverySimulator({ scheduling, simulation, accessPolicy, resolveConnection: async () => connection, clock: f.clock });
  const calendar = createCalendarService({ store: calendarStore, source: { list: () => sources }, media, grants, auth,
    identity: () => ({ companyId: context.companyId, userId: context.userId }), readClients: () => clients,
    publisher: { connection: async () => connection, allowed: () => false, send() { throw new Error("real-publisher-must-not-be-called"); } },
    importScheduling: scheduling, clock: f.clock });
  t.after(async () => { scheduling.close(); await calendar.close(); });
  const original = (await calendar.list(claims)).items[0];
  assert.equal(original.orderId, generatedSource.orderId);
  const privatePreview = createPrivateImportPreviewService({ preparation: f.preparation, resultStore: f.preparedStore,
    accessPolicy, enabled: true, allowVolatileForTests: true });
  const facade = { ready: true, allowed: ctx => { try { accessPolicy.resolve(ctx); return true; } catch { return false; } },
    upload: f.upload, preparation: f.preparation, scheduling,
    capabilities: () => ({ enabled: true, localSimulation: true, scheduling: { enabled: true, localSimulation: true },
      upload: { origin: "https://ia4tube-api.onrender.com", chunkBytes: 5 * 1024 ** 2, maxImageBytes: 32 * 1024 ** 2, maxVideoBytes: 100 * 1024 ** 2 },
      preparation: { enabled: true, maxVideoSeconds: 60, photoMusicSeconds: 15 },
      musicTracks: [...f.catalog.values()].map(track => ({ id: track.id, commercialRightsConfirmed: false, testOnly: true })) }) };
  const app = express(); app.disable("etag");
  const routerOptions = { authenticate: session.authenticate, resolvePrincipal: value => auth.fromVerifiedJwt(value) };
  app.use(PREFIX, createPrivateImportPreviewRouter({ ...routerOptions, getService: () => privatePreview, getScheduledService: () => scheduling }));
  app.use(PREFIX, createCalendarImportRouter({ ...routerOptions, getService: () => facade }));
  app.use(express.json({ limit: "16kb" }));
  app.use("/v1/social/calendar", createCalendarRouter({ authenticate: session.authenticate, getService: () => calendar }));
  app.get("/synthetic-gallery", session.authenticate, async (req, res) => res.json(await calendar.overlay(req.user,
    { postagens: [{ calendar_key: generatedSource.key, pedido_id: generatedSource.orderId, tema: "Arte original" }] })));
  const server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  function request(route, options = {}) { return fetch(base + route, { ...options, headers: { Authorization: `Bearer ${token}`, ...options.headers } }); }
  const post = (route, body) => request(route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  function inputFor(ready, extra = {}) { return { assetId: ready.assetId, mediaRevision: ready.mediaRevision,
    previewDigest: ready.status.previewDigest, idempotencyKey: crypto.randomUUID(), ...slot(f.clock()),
    caption: "Material sintético local", automatic: true, confirmed: true, ...extra }; }
  return { ...f, scheduling, simulation, deliverySimulator, calendarStore, calendar, media, original, originalBytes, generatedSource, claims, token, otherToken,
    request, post, inputFor, base, PREFIX, facade, session, auth, privatePreview, binding,
    disconnect() { connection = null; }, changeConnection() { connection = { ...connection, binding: { ...binding, connectionRevision: 2 } }; },
    setAccountType(value) { connection = { ...connection, accountType: value }; },
    revoke() { eligible = false; }, clearGeneratedSources() { sources = []; } };
}
module.exports = { createSchedulePipelineFixture, slot, PREFIX };
