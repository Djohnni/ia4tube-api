"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const model = require("../src/social/calendar/model");
const { createCalendarGrants } = require("../src/social/calendar/grants");
const { createCalendarMedia } = require("../src/social/calendar/media");
const { createCalendarService } = require("../src/social/calendar/service");
const { createCalendarPublisher } = require("../src/social/calendar/publisher");
const { createSocialAuthAdapter } = require("../src/social/auth-adapter");
const { deriveSocialIdentity } = require("../src/social/identity");
const { loadInstagramOAuthConfig } = require("../src/social/oauth/instagram-config");
const { createPostgresConnectorStore } = require("../src/persistence/postgres/social-connector-store");
const { fixtureContext, createMemoryPool } = require("./helpers/publication-atomic-memory-pool");
const { createPublicationIntent } = require("../src/social/publication/connection-binding");
const { createInstagramRealReviewerService } = require("../src/social/reviewer-real/reviewer-real");
const { SESSION_ISSUER, SESSION_AUDIENCE } = require("../src/social/reauth");

function memoryStore() {
  const rows = new Map();
  let tail = Promise.resolve();
  return { rows, async exists(id) { return rows.has(id); },
    async read(id, action) { return structuredClone(await action(structuredClone(rows.get(id)))); },
    update(id, action) {
      const work = tail.then(async () => {
        const state = structuredClone(rows.get(id) || model.freshState());
        const result = await action(state);
        rows.set(id, state);
        return structuredClone(result);
      });
      tail = work.catch(() => {});
      return work;
    } };
}

function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-calendar-bridge-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const owner = "synthetic-reviewer-owner";
  const identityConfig = { namespaceUuid: crypto.randomUUID(), key: crypto.randomBytes(32), derivationVersion: "v1" };
  const identity = (company, user) => deriveSocialIdentity({ namespaceUuid: identityConfig.namespaceUuid,
    derivationKey: identityConfig.key, derivationVersion: "v1", legacyCompanyId: company, legacyUserId: user });
  const ids = identity(owner, owner);
  const auth = createSocialAuthAdapter(identityConfig);
  const claims = { sub: owner, whatsapp: owner, company_id: owner, token_version: 2,
    iss: SESSION_ISSUER, aud: SESSION_AUDIENCE, jti: crypto.randomUUID() };
  const binding = { connectionId: crypto.randomUUID(), externalId: "17840000000000001", connectionRevision: 7 };
  const account = { externalId: binding.externalId, accountType: "business", username: "synthetic_reviewer" };
  const connection = { id: binding.connectionId, companyId: ids.companyId, provider: "instagram", state: "connected",
    health: "healthy", activeCredentialId: crypto.randomUUID(), account,
    grantedScopes: ["instagram_business_basic", "instagram_business_content_publish"], revision: binding.connectionRevision };
  const config = { provider: "instagram", environment: "production", publicOrigin: "https://ia4tube-api.onrender.com",
    enabled: true, instagramEnabled: true, externalConnectionEnabled: true, externalPublicationEnabled: true,
    publicationBindingRequired: true, appReview: { enabled: false, companyId: null },
    productionOperations: { subjects: [{ companyId: ids.companyId, userId: ids.userId }] } };
  const bytes = Buffer.from("synthetic verified JPEG bytes for calendar copy");
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const mediaId = `reviewer-jpeg:${"a".repeat(64)}`;
  const metadataDigest = "b".repeat(64);
  let sourceCaption = "Legenda aprovada", now = Date.now(), allowed = true, currentBinding = binding;
  let sourceReady = true, sends = 0, holdDispatchConnection = false, connectionReads = 0;
  let connectorPending = [];
  const store = memoryStore();
  const media = createCalendarMedia({ dataDir: temp, secret: "synthetic-calendar-secret-32-bytes-minimum",
    publicOrigin: config.publicOrigin, loadSource: async () => { throw new Error("generated source reached"); },
    clock: () => now });
  const reviewerMedia = { async listOwnedJpegs() { return []; },
    async resolveOwnedJpeg({ context, owner: requestedOwner, mediaId: requestedId }) {
      return context.companyId === ids.companyId && requestedOwner === owner && requestedId === mediaId
        ? { companyId: ids.companyId, mediaId, mimeType: "image/jpeg", metadataDigest, caption: sourceCaption } : null;
    },
    async readOwnedJpeg({ context, owner: requestedOwner, mediaId: requestedId }) {
      return context.companyId === ids.companyId && requestedOwner === owner && requestedId === mediaId
        ? { companyId: ids.companyId, mediaId, metadataDigest, sha256, width: 1080, height: 1080,
          bytes: Buffer.from(bytes) } : null;
    } };
  const publisher = { allowed: () => allowed,
    connection: async () => {
      connectionReads++;
      if (holdDispatchConnection && connectionReads > 1) throw new Error("synthetic worker connection read unavailable");
      return currentBinding ? { binding: currentBinding, username: account.username, accountType: "business" } : null;
    },
    intent(context, job, requestId) {
      const descriptor = media.descriptor(context.companyId, job);
      return createPublicationIntent({ companyId: context.companyId, clientRequestId: requestId,
        binding: job.authorization.binding, mediaId: descriptor.mediaId,
        mediaMetadataDigest: descriptor.metadataDigest, caption: job.caption });
    },
    async send() { sends++; return { state: "provider_confirming", published: false }; },
    async observe() { return { state: "provider_confirming", published: false }; } };
  const calendar = createCalendarService({ store, source: { list() {
    if (!sourceReady) throw new Error("paused synthetic source read");
    return [];
  } }, media, reviewerMedia, grants: createCalendarGrants(crypto.randomBytes(32), () => now),
  auth, identity, readClients: () => ({ [owner]: { ativo: true }, foreign: { ativo: true } }), publisher, clock: () => now });
  const connectorStore = { scope(context) { return {
    async getCurrentConnectionDetails() { return context.companyId === ids.companyId ? connection : null; },
    async getConnectionDetails(id) { return context.companyId === ids.companyId && id === connection.id ? connection : null; },
    async getPublicationDetails() { return null; },
    async listPublicationDetails() { return connectorPending; }
  }; } };
  const reviewer = createInstagramRealReviewerService({ config, authAdapter: auth, connectorStore,
    connectorAudit: { async append() {} }, media: reviewerMedia, getCalendar: () => calendar,
    createPublicationConnector() { throw new Error("direct connector path used"); },
    createConnectorService() { throw new Error("direct connector path used"); } });
  const request = (clientRequestId = crypto.randomUUID()) => ({ verifiedClaims: claims,
    mediaId, clientRequestId, expectedConnectionId: binding.connectionId,
    expectedExternalId: binding.externalId, expectedConnectionRevision: binding.connectionRevision });
  return { owner, ids, claims, binding, mediaId, bytes, store, media, calendar, reviewer, request,
    sends: () => sends, connectionReads: () => connectionReads, setCaption: value => sourceCaption = value,
    setAllowed: value => allowed = value, setBinding: value => currentBinding = value,
    setConnectorPending: value => connectorPending = value,
    setSourceReady: value => sourceReady = value, setHoldDispatchConnection: value => holdDispatchConnection = value,
    advance: ms => now += ms };
}

async function eventually(predicate) {
  for (let i = 0; i < 100; i++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail("worker did not reach expected state");
}

test("reviewer click queues original bound intent and worker sends once despite paused calendar preference", async t => {
  const f = fixture(t);
  await f.store.update(f.ids.companyId, state => { state.preferences.enabled = false; });
  f.setSourceReady(false); // Generated monthly source failure must not block this reviewer JPEG.
  const input = f.request();
  const first = await f.reviewer.publish(input);
  assert.equal(first.publication.state, "sending");
  assert.equal(first.publication.media.id, f.mediaId);
  assert.deepEqual(first.publication.binding, f.binding);
  assert.equal(first.publication.destination, "feed");
  assert.equal(first.publication.providerMediaId, null);
  assert.match(first.publication.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  const byKey = await f.reviewer.getPublicationIntent({ verifiedClaims: f.claims, clientRequestId: input.clientRequestId });
  assert.equal(byKey.publication.publicationId, first.publication.publicationId);
  const duplicate = await f.reviewer.publish(input);
  assert.equal(duplicate.duplicateSubmissionPrevented, true);
  await eventually(() => f.sends() === 1);
  await f.calendar.tick();
  assert.equal(f.sends(), 1);
  f.setSourceReady(true);
  assert.deepEqual((await f.calendar.list(f.claims)).items, []);
  assert.deepEqual((await f.calendar.overlay(f.claims, { postagens: [] })).postagens, []);
  const job = Object.values(f.store.rows.get(f.ids.companyId).jobs)[0];
  assert.equal(job.sourceKind, "reviewer");
  assert.equal(job.authorization.purpose, "calendar_reviewer_publish");
  assert.equal(job.authorization.planningId, null);
  assert.equal(job.phase !== "cancelled", true);
  assert.equal(job.intent.publicationId, first.publication.publicationId);
  assert.equal(job.intent.clientRequestId, input.clientRequestId);
  assert.equal(f.media.descriptor(f.ids.companyId, job).mediaId, f.mediaId);
  assert.deepEqual(f.media.bytesFor(f.ids.companyId, job.asset), f.bytes);
  await assert.rejects(f.calendar.image(f.claims, job.id), { code: "calendar_not_found" });
  await assert.rejects(f.calendar.edit(f.claims, job.id, { action: "cancel", revision: job.revision }), { code: "calendar_not_found" });
});

test("same key with changed caption conflicts and a second pending key cannot dispatch", async t => {
  const f = fixture(t);
  const input = f.request();
  const concurrent = await Promise.all([f.reviewer.publish(input), f.reviewer.publish(input)]);
  assert.deepEqual(concurrent.map(value => value.duplicateSubmissionPrevented).sort(), [false, true]);
  f.setCaption("Outra legenda");
  await assert.rejects(f.reviewer.publish(input), { code: "calendar_revision_conflict" });
  f.setCaption("Legenda aprovada");
  await assert.rejects(f.reviewer.publish(f.request()), { code: "calendar_reviewer_pending" });
  await eventually(() => f.sends() === 1);
  assert.equal(f.sends(), 1);
});

test("closed gate, changed connection and expired click never start a provider send", async t => {
  const closed = fixture(t);
  closed.setAllowed(false);
  await assert.rejects(closed.reviewer.publish(closed.request()), { code: "calendar_operations_closed" });
  assert.equal(closed.sends(), 0);

  const changed = fixture(t);
  changed.setHoldDispatchConnection(true);
  const queued = await changed.reviewer.publish(changed.request());
  await eventually(() => changed.connectionReads() > 1);
  changed.setBinding({ ...changed.binding, connectionRevision: 8 });
  changed.setHoldDispatchConnection(false);
  await changed.calendar.tick();
  assert.equal(changed.sends(), 0);
  assert.equal((await changed.reviewer.getPublication({ verifiedClaims: changed.claims,
    publicationId: queued.publication.publicationId })).publication.state, "failed_temporary");

  const expired = fixture(t);
  expired.setHoldDispatchConnection(true);
  await expired.reviewer.publish(expired.request());
  await eventually(() => expired.connectionReads() > 1);
  expired.advance(16 * 60000);
  expired.setHoldDispatchConnection(false);
  await expired.calendar.tick();
  assert.equal(expired.sends(), 0);
});

test("owner isolation and calendar capacity fail closed", async t => {
  const f = fixture(t);
  const input = f.request();
  await f.reviewer.publish(input);
  const foreign = { ...input.verifiedClaims, sub: "foreign", whatsapp: "foreign", company_id: "foreign" };
  await assert.rejects(f.reviewer.publish({ ...input, verifiedClaims: foreign }),
    { code: "external_capability_disabled" });
  assert.equal((await f.reviewer.getPublicationIntent({ verifiedClaims: foreign,
    clientRequestId: input.clientRequestId })).publication, null);

  const full = fixture(t);
  await full.store.update(full.ids.companyId, state => {
    for (let i = 0; i < model.MAX_ITEMS; i++) state.jobs[String(i)] = { sourceKind: "upload", phase: "cancelled" };
  });
  await assert.rejects(full.reviewer.publish(full.request()), { code: "calendar_capacity_reached" });
  assert.equal(full.sends(), 0);
});

test("stored reviewer caption cannot change the signed request hash before dispatch", async t => {
  const f = fixture(t);
  f.setHoldDispatchConnection(true);
  await f.reviewer.publish(f.request());
  await eventually(() => f.connectionReads() > 1);
  await f.store.update(f.ids.companyId, state => {
    const job = Object.values(state.jobs)[0];
    job.caption = "changed after approval";
  });
  f.setHoldDispatchConnection(false);
  await f.calendar.tick();
  assert.equal(f.sends(), 0);
  assert.equal(Object.values(f.store.rows.get(f.ids.companyId).jobs)[0].error, "reviewer_intent_changed");
});

test("an older provider-confirming publication blocks a fresh reviewer intent", async t => {
  const f = fixture(t);
  f.setConnectorPending([{ id: crypto.randomUUID(), state: "provider_confirming" }]);
  await assert.rejects(f.reviewer.publish(f.request()), { code: "state_transition_invalid" });
  assert.equal(Object.keys(f.store.rows.get(f.ids.companyId)?.jobs || {}).length, 0);
  assert.equal(f.sends(), 0);
});

test("real calendar publisher sends reviewer identity through signed JPEG URL and confirms Meta result", async t => {
  const { context } = fixtureContext();
  const pool = createMemoryPool(context);
  const connectorStore = createPostgresConnectorStore({ pool, publicationBindingRequired: true });
  const origin = "https://ia4tube-api.onrender.com";
  const config = loadInstagramOAuthConfig({ ENVIRONMENT: "production", PUBLIC_API_BASE_URL: origin,
    SOCIAL_INSTAGRAM_ENABLED: "true", SOCIAL_EXTERNAL_CONNECTION_ENABLED: "true",
    SOCIAL_EXTERNAL_PUBLICATION_ENABLED: "true",
    SOCIAL_PRODUCTION_OPERATION_ALLOWLIST_JSON: JSON.stringify([{ companyId: context.companyId, userId: context.userId }]),
    INSTAGRAM_APP_ID: "12345678901234", INSTAGRAM_APP_SECRET: crypto.randomBytes(32).toString("hex"),
    INSTAGRAM_GRAPH_API_VERSION: "v25.0", INSTAGRAM_OAUTH_REDIRECT_URI: `${origin}/v1/social/oauth/callback` });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-publisher-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const media = createCalendarMedia({ dataDir: temp, secret: "synthetic-calendar-secret-32-bytes-minimum",
    publicOrigin: origin, loadSource: async () => { throw new Error("generated source reached"); } });
  t.after(() => media.close());
  const bytes = Buffer.from("synthetic verified reviewer JPEG for provider test");
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const asset = media.ingestReviewer(context.companyId, { bytes, sha256, width: 1080, height: 1080 });
  const mediaId = `reviewer-jpeg:${"a".repeat(64)}`;
  const metadataDigest = "b".repeat(64);
  const caption = "Legenda aprovada\n\n#reviewer-intent";
  const binding = { connectionId: pool.state.connection.id,
    externalId: pool.state.connection.external_id, connectionRevision: 7 };
  const reply = value => ({ status: 200, headers: { get: () => "application/json" },
    arrayBuffer: async () => Buffer.from(JSON.stringify(value)) });
  const posts = [];
  const transport = async (url, request) => {
    assert.equal(pool.transactions, 0);
    if (request.method === "POST") {
      posts.push(url);
      const body = new URLSearchParams(request.body);
      if (!url.endsWith("/media_publish")) {
        assert.equal(body.get("caption"), caption);
        assert.match(body.get("image_url"), /^https:\/\/ia4tube-api\.onrender\.com\/v1\/social\/calendar\/media\//);
      }
      return reply({ id: url.endsWith("/media_publish") ? "18000000000000001" : "17900000000000001" });
    }
    if (url.includes("17900000000000001")) return reply({ status_code: "FINISHED" });
    return reply({ id: "18000000000000001", media_product_type: "FEED",
      permalink: "https://www.instagram.com/p/Synthetic123/", timestamp: "2026-09-05T00:00:00Z" });
  };
  const publisher = createCalendarPublisher({ config, connectorStore, connectorAudit: { async append() {} },
    credentials: { async withDecryptedCredential(_input, action) {
      const token = Buffer.from("synthetic-token");
      try { return await action(token); } finally { token.fill(0); }
    } }, transport, media });
  const job = { sourceKind: "reviewer", mediaKind: "image", asset, caption, destination: "feed",
    authorization: { binding }, reviewer: { mediaId, metadataDigest } };
  const requestId = crypto.randomUUID();
  job.intent = publisher.intent(context, job, requestId);
  assert.equal(job.intent.mediaId, mediaId);
  assert.equal(job.intent.mediaMetadataDigest, metadataDigest);
  assert.equal(job.intent.clientRequestId, requestId);
  const result = await publisher.send(context, job);
  assert.equal(result.published, true);
  assert.equal(result.mediaId, "18000000000000001");
  assert.equal(posts.length, 2);
  const record = await connectorStore.scope(context).getPublicationDetails(job.intent.publicationId);
  assert.equal(record.mediaReference, mediaId);
  assert.equal(record.mediaMetadataDigest, metadataDigest);
  assert.equal(record.caption, caption);
  await publisher.send(context, job);
  assert.equal(posts.length, 2);
});
