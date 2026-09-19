"use strict";
const assert = require("node:assert/strict"), crypto = require("node:crypto"), jwt = require("jsonwebtoken");
const sharp = require("sharp"), express = require("express");
const { createOperationalMediaPostgresFixture } = require("./operational-media-postgres-fixture");
const { initializeSocialSchema, seedSyntheticSocialAccount, syntheticCredentials } = require("./operational-media-social-fixture");
const { createOperationalPrivatePipelineFixture } = require("./operational-private-pipeline-fixture");
const { createProductionSession } = require("../../src/social/production-session");
const { createSocialAuthAdapter } = require("../../src/social/auth-adapter");
const { createConnectorContext } = require("../../src/social/connectors/contract");
const { createPostgresConnectorStore } = require("../../src/persistence/postgres/social-connector-store");
const { createPostgresConnectorAudit } = require("../../src/persistence/postgres/social-connector-audit");
const { loadInstagramOAuthConfig } = require("../../src/social/oauth/instagram-config");
const { createCalendarStore } = require("../../src/social/calendar/store");
const { createCalendarService } = require("../../src/social/calendar/service");
const { createCalendarMedia } = require("../../src/social/calendar/media");
const { createCalendarGrants } = require("../../src/social/calendar/grants");
const { createCalendarPublisher } = require("../../src/social/calendar/publisher");
const { createCalendarRouter } = require("../../src/social/calendar/router");
const { createOperationalCalendarImportsRuntimeFactory, isOperationalCalendarImportsRuntimeFactory, isOperationalCalendarImportsRuntime } = require("../../src/social/calendar/imports/operational-runtime");
const { createPostgresTransferRegistryStore } = require("../../src/social/calendar/imports/postgres-transfer-registry-store");
const { createTransferAuthorizationRegistry } = require("../../src/social/calendar/imports/transfer-registry");
const { createRenderDiskTransferService } = require("../../src/social/calendar/imports/transfer-service");
const { createCalendarImportByteRouter } = require("../../src/social/calendar/imports/transfer-router");
const { createLocalPublicationTransport } = require("../../src/social/calendar/imports/publication-test-transport");
const { createCalendarImportRouter } = require("../../src/social/calendar/imports/router");
const { createPrivateImportPreviewRouter } = require("../../src/social/calendar/imports/preview-router");
const { slot } = require("./gallery-schedule-pipeline-fixture");
const ORIGIN = "https://ia4tube-api.onrender.com", PREFIX = "/v1/social/calendar/imports";
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
async function createOperationalCalendarPipelineFixture(t, options = {}) {
  const owner = "synthetic-operational-owner", other = "synthetic-operational-other";
  const clients = { [owner]: { ativo: true }, [other]: { ativo: true } };
  const session = createProductionSession({ secret: crypto.randomBytes(48).toString("hex"), readClients: () => clients });
  const auth = createSocialAuthAdapter({ namespaceUuid: crypto.randomUUID(), key: crypto.randomBytes(32), derivationVersion: "synthetic-v1" });
  const token = session.sign(owner), otherToken = session.sign(other), claims = jwt.decode(token), otherClaims = jwt.decode(otherToken);
  const principal = auth.fromVerifiedJwt(claims), otherPrincipal = auth.fromVerifiedJwt(otherClaims);
  let context = { authenticated: true, companyId: principal.companyId, userId: principal.userId };
  const otherContext = { authenticated: true, companyId: otherPrincipal.companyId, userId: otherPrincipal.userId };
  const db = await createOperationalMediaPostgresFixture(t, { initializeSocialSchema });
  const seeded = await seedSyntheticSocialAccount(db, context);
  await seedSyntheticSocialAccount(db, otherContext, { externalId: "987654321012345", username: "synthetic_other_owner" });
  const f = await createOperationalPrivatePipelineFixture(t, { ...options, pgFixture: db, context });
  if (typeof options.configurePrivatePipeline === "function") await options.configurePrivatePipeline(t, f, options);
  const originals = await sharp({ create: { width: 160, height: 200, channels: 3, background: "#532a75" } }).png().toBuffer();
  const originalSource = { key: "synthetic-plan:existing", planningId: "synthetic-existing-plan", orderId: "synthetic-existing-order",
    ...slot(f.clock(), 2), caption: "Arte existente preservada", imageReady: true, version: "1" };
  const key = crypto.randomBytes(48).toString("hex"), containers = new Map(), confirmed = new Map(), providerCalls = [], sourcePaths = [];
  let current, base, nextId = 17900000000000000n, fault = null, externalGate = true, connectionGate = true;
  const connectorContext = (verifiedPrincipal = principal) => createConnectorContext({ principal: verifiedPrincipal, provider: "instagram", environment: "production", correlationId: crypto.randomUUID(), auditEventId: crypto.randomUUID() });
  const reply = value => ({ status: 200, headers: { get: () => "application/json" }, arrayBuffer: async () => Buffer.from(JSON.stringify(value)) });
  const transport = createLocalPublicationTransport(async (url, request) => {
    const parsed = new URL(url), id = parsed.pathname.split("/")[2];
    if (request.method === "POST" && parsed.pathname.endsWith("/media")) {
      const body = new URLSearchParams(request.body), target = body.get("media_type") === "STORIES" ? "story" : body.get("media_type") === "REELS" ? "reel" : "feed";
      const sourceUrl = body.get("video_url") || body.get("image_url");
      assert.equal(new URL(sourceUrl).origin, ORIGIN);
      sourcePaths.push(new URL(sourceUrl).pathname); // Test-only, never logged or reported.
      // Simulated provider consumes the actual published-media route over loopback.
      // Never dispatch the requested production URL on the real network.
      const received = await fetch(base + new URL(sourceUrl).pathname);
      assert.equal(received.status, 200, "Prepared media route must provide the exact confirmed file");
      const bytes = Buffer.from(await received.arrayBuffer());
      const containerId = String(++nextId), record = { target, containerId, caption: body.get("caption"),
        shareToFeed: body.get("share_to_feed"), mimeType: received.headers.get("content-type"), hash: hash(bytes), size: bytes.length };
      containers.set(containerId, record); providerCalls.push({ operation: "create", ...record });
      if (fault === `unknown_create_${target}`) { fault = null; throw new Error("synthetic-response-lost-after-create"); }
      if (fault === `known_create_${target}`) { fault = null; return { ...reply({ error: { code: 100, message: "synthetic rejection" } }), status: 400 }; }
      return reply({ id: containerId });
    }
    if (request.method === "POST" && parsed.pathname.endsWith("/media_publish")) {
      const containerId = new URLSearchParams(request.body).get("creation_id"), container = containers.get(containerId);
      assert.ok(container, "Simulated publication must consume an existing exact container");
      const mediaId = String(++nextId), record = { ...container, mediaId };
      confirmed.set(mediaId, record); container.publishedMediaId = mediaId;
      providerCalls.push({ operation: "publish", target: record.target, containerId, mediaId });
      if (fault === `unknown_publish_${record.target}`) { fault = null; throw new Error("synthetic-response-lost-after-publish"); }
      return reply({ id: mediaId });
    }
    if (containers.has(id)) return reply({ id, status_code: containers.get(id).publishedMediaId ? "PUBLISHED" : "FINISHED" });
    const record = confirmed.get(id); assert.ok(record, "Provider read must name a known simulated media ID");
    return reply({ id, media_type: record.target === "feed" ? "IMAGE" : "VIDEO",
      media_product_type: record.target === "story" ? "STORY" : record.target === "reel" ? "REELS" : "FEED",
      permalink: `https://www.instagram.com/${record.target === "reel" ? "reel" : "p"}/Synthetic${id}/`,
      timestamp: new Date(f.clock()).toISOString() });
  });
  async function mount() {
    const calendarStore = createCalendarStore({ pool: db.tenantPool, role: "ia4tube_social_runtime" }); await calendarStore.verify();
    const connectorStore = createPostgresConnectorStore({ pool: db.tenantPool, role: "ia4tube_social_runtime", publicationBindingRequired: true });
    const grants = createCalendarGrants(key, f.clock);
    const media = createCalendarMedia({ dataDir: f.root, secret: key, publicOrigin: ORIGIN, loadSource: async () => originals, clock: f.clock });
    const config = loadInstagramOAuthConfig({ ENVIRONMENT: "production", PUBLIC_API_BASE_URL: ORIGIN,
      SOCIAL_INSTAGRAM_ENABLED: "true", SOCIAL_EXTERNAL_CONNECTION_ENABLED: connectionGate ? "true" : "false", SOCIAL_EXTERNAL_PUBLICATION_ENABLED: externalGate ? "true" : "false",
      SOCIAL_PRODUCTION_OPERATION_ALLOWLIST_JSON: JSON.stringify([{ companyId: context.companyId, userId: context.userId }]), INSTAGRAM_APP_ID: "12345678901234",
      INSTAGRAM_APP_SECRET: crypto.randomBytes(32).toString("hex"), INSTAGRAM_GRAPH_API_VERSION: "v25.0",
      INSTAGRAM_OAUTH_REDIRECT_URI: `${ORIGIN}/v1/social/oauth/callback` });
    let publisher;
    const registryStore = createPostgresTransferRegistryStore({ pool: db.transferPool });
    const registry = createTransferAuthorizationRegistry({ store: registryStore, enabled: true, clock: f.clock });
    const transfer = createRenderDiskTransferService({ store: f.store, provider: f.provider, registry, accessPolicy: f.accessPolicy, enabled: true, clock: f.clock });
    const runtimeFactory = createOperationalCalendarImportsRuntimeFactory({ enabled: true, preparation: f.preparation, resultStore: f.preparedStore,
      accessPolicy: f.accessPolicy, upload: f.upload, provider: f.provider, uploadStore: f.store, transfer,
      catalog: f.catalog, localTransport: transport, allowLocalTransportForTests: true, clock: f.clock, canAdmit: options.canAdmit,
      async verifyReadiness() {
        assert.equal(await registry.verify(), true); assert.equal(await f.ledger.verify(), true);
        if (options.externalPrivateExecutor === true) {
          assert.equal(typeof f.assertPrivateExecutorReadiness, "function");
          assert.equal(await f.assertPrivateExecutorReadiness(), true);
        } else assert.equal(f.executor.capabilities.hardTermination, true);
        assert.equal(f.preparedStore.capabilities.testOnly, false); return true;
      } });
    assert.equal(isOperationalCalendarImportsRuntimeFactory(runtimeFactory), false, "The production factory rejects a simulated transport");
    assert.equal(isOperationalCalendarImportsRuntimeFactory(runtimeFactory, { allowLocalTransportForTests: true }), true);
    const imports = await runtimeFactory({ store: calendarStore, grants, secret: key, publicOrigin: ORIGIN,
      connectionForPrincipal: value => publisher.connection(connectorContext(value)),
      publicationAllowedForPrincipal: value => publisher.allowed(connectorContext(value)),
      connectionForGrant: grant => publisher.connection(connectorContext(auth.fromVerifiedCalendarGrant(grant))),
      async readGeneratedArt(verifiedPrincipal, request) {
        const job = await calendarStore.update(verifiedPrincipal.companyId, state => state.jobs[request.calendarItemId]);
        if (!job || job.sourceKind === "upload" || job.revision !== request.revision || job.phase === "cancelled" || !job.asset)
          throw Object.assign(new Error("calendar_import_source_changed"), { code: "calendar_import_source_changed", statusCode: 409 });
        return { bytes: media.bytesFor(verifiedPrincipal.companyId, job.asset), mimeType: "image/jpeg" };
      } });
    assert.equal(isOperationalCalendarImportsRuntime(imports), true);
    assert.equal(isOperationalCalendarImportsRuntime({ ...imports }), false);
    context = imports.contextForPrincipal(principal); f.context = context;
    const { scheduling, preparedMedia, preview: privatePreview } = imports;
    publisher = createCalendarPublisher({ config, connectorStore, connectorAudit: createPostgresConnectorAudit({ pool: db.tenantPool, role: "ia4tube_social_runtime" }),
      credentials: syntheticCredentials, transport, media, preparedMedia });
    const calendar = createCalendarService({ store: calendarStore, source: { list: value => value === owner ? [originalSource] : [] }, media, grants, auth,
      identity: value => value === owner ? context : otherContext, readClients: () => clients, publisher, importScheduling: scheduling, clock: f.clock });
    current = { calendarStore, connectorStore, publisher, preparedMedia, scheduling, calendar, privatePreview, imports, transfer, registry };
  }
  await mount();
  const original = (await current.calendar.list(claims)).items[0];
  const app = express(), routerOptions = { authenticate: session.authenticate, resolvePrincipal: value => auth.fromVerifiedJwt(value) };
  app.disable("etag");
  app.use(`${PREFIX}/bytes`, createCalendarImportByteRouter({ getService: () => current.transfer }));
  app.use(express.json({ limit: "16kb", strict: true }));
  app.use(PREFIX, createPrivateImportPreviewRouter({ ...routerOptions, getService: () => current.privatePreview, getScheduledService: () => current.scheduling }));
  app.use(PREFIX, createCalendarImportRouter({ ...routerOptions, getService: () => current.imports }));
  app.use("/v1/social/calendar", createCalendarRouter({ authenticate: session.authenticate, getService: () => current.calendar }));
  const server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  db.registerBeforeCleanup(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); current.imports.close(); await current.calendar.close(); });
  const pipelineReopen = f.reopen;
  f.reopen = async settings => { current.imports.close(); await current.calendar.close(); await pipelineReopen(settings); await mount(); };
  const request = (route, options = {}) => fetch(base + route, { ...options, headers: { Authorization: `Bearer ${token}`, ...options.headers } });
  return Object.assign(f, { claims, otherClaims, context, otherContext, original, originalSource, originals, token, otherToken, auth, session, base, providerCalls, sourcePaths, seeded,
    current: () => current, request, setProviderFault: value => { fault = value; }, setFixtureGate: value => { externalGate = value; },
    setFixtureConnectionGate: value => { connectionGate = value; },
    inputFor: (ready, extra = {}) => ({ assetId: ready.assetId, mediaRevision: ready.mediaRevision, previewDigest: ready.status.previewDigest,
      idempotencyKey: crypto.randomUUID(), ...slot(f.clock()), caption: "Conteúdo sintético local", automatic: true, confirmed: true, ...extra }),
    post: (route, body) => request(route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
}
module.exports = { createOperationalCalendarPipelineFixture, PREFIX, hash, slot };
