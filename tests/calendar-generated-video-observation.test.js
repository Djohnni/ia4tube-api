"use strict";

const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const { fixtureContext, createMemoryPool } = require("./helpers/publication-atomic-memory-pool");
const { createPostgresConnectorStore } = require("../src/persistence/postgres/social-connector-store");
const { createCalendarPublisher } = require("../src/social/calendar/publisher");
const { createCalendarService } = require("../src/social/calendar/service");
const { createCalendarGrants } = require("../src/social/calendar/grants");
const { loadInstagramOAuthConfig } = require("../src/social/oauth/instagram-config");
const model = require("../src/social/calendar/model");

// Real calendar/publisher/connector protocols, with serialized in-memory stores
// and a controlled provider transport. No HTTP, Google, or Meta call is made.
async function fixture({ timeoutCreate = false, timeoutPublish = false, unavailableConfirmation = false } = {}) {
  const owner = "synthetic-generated-video-owner";
  const { adapter, claims, context } = fixtureContext(owner), pool = createMemoryPool(context);
  const connectorStore = createPostgresConnectorStore({ pool, publicationBindingRequired: true });
  let now = model.dateTime("2026-10-28", "12:00"), statusCode = "IN_PROGRESS", tail = Promise.resolve();
  const rows = new Map(), posts = [], reads = [];
  const store = { async exists(id) { return rows.has(id); }, update(id, action) {
    const pending = tail.then(async () => {
      const value = structuredClone(rows.get(id) || model.freshState()), result = await action(value);
      rows.set(id, value); return structuredClone(result);
    }); tail = pending.catch(() => {}); return pending;
  } };
  const binding = { connectionId: pool.state.connection.id, externalId: pool.state.connection.external_id, connectionRevision: 7 };
  const grants = createCalendarGrants(crypto.randomBytes(32), () => now);
  const envelope = grants.issue({ companyId: context.companyId, userId: context.userId, binding,
    revision: 1, planningId: "generated-video-plan", quantity: 1 });
  const source = { list: () => [{ key: "generated-video-plan:1", planningId: "generated-video-plan", orderId: "video-order",
    date: "2026-10-28", time: "12:00", caption: "Legenda exata", imageReady: true, mediaKind: "video",
    version: "video-v1", authorizationEnvelope: envelope, destination: "feed" }] };
  const asset = { mimeType: "video/mp4", sha: "b".repeat(64), sourceHash: "b".repeat(64), size: 1234,
    width: 720, height: 1280, durationSeconds: 10, hasAudio: true, audioMode: "original" };
  const origin = "https://ia4tube-api.onrender.com";
  const media = { prepare: async () => ({ ...asset, variants: { reel: asset, story: asset } }),
    unchanged: async () => true, videoFile: () => ({ size: asset.size, sha: asset.sha }), close() {},
    videoDescriptor(companyId, userId, job) {
      return { companyId, userId, mediaId: `calendar-prepared-v1:${"c".repeat(64)}`, metadataDigest: "c".repeat(64),
        mimeType: "video/mp4", sha256: asset.sha, sizeBytes: asset.size, width: 720, height: 1280,
        durationSeconds: 10, hasAudio: true, audioMode: "original", target: job.target, destination: job.target,
        shareToFeed: job.target === "reel", caption: job.caption, publicUrl: `${origin}/v1/social/calendar/media/video/synthetic` };
    } };
  const config = loadInstagramOAuthConfig({ ENVIRONMENT: "production", PUBLIC_API_BASE_URL: origin,
    SOCIAL_INSTAGRAM_ENABLED: "true", SOCIAL_EXTERNAL_CONNECTION_ENABLED: "true", SOCIAL_EXTERNAL_PUBLICATION_ENABLED: "true",
    SOCIAL_PRODUCTION_OPERATION_ALLOWLIST_JSON: JSON.stringify([{ companyId: context.companyId, userId: context.userId }]),
    INSTAGRAM_APP_ID: "12345678901234", INSTAGRAM_APP_SECRET: crypto.randomBytes(32).toString("hex"),
    INSTAGRAM_GRAPH_API_VERSION: "v25.0", INSTAGRAM_OAUTH_REDIRECT_URI: `${origin}/v1/social/oauth/callback` });
  const reply = body => ({ status: 200, headers: { get: () => "application/json" },
    arrayBuffer: async () => Buffer.from(JSON.stringify(body)) });
  const container = "17900000000000001", published = "18000000000000001";
  const transport = async (url, request) => {
    assert.equal(pool.transactions, 0, "Provider requests must remain outside database transactions");
    if (request.method === "POST") {
      const body = Object.fromEntries(new URLSearchParams(request.body)), operation = url.endsWith("/media_publish") ? "publish" : "create";
      posts.push({ operation, body });
      if (operation === "create" && timeoutCreate || operation === "publish" && timeoutPublish) throw new Error("Synthetic uncertain response");
      return reply({ id: operation === "create" ? container : published });
    }
    reads.push(url);
    if (url.includes(container)) return reply({ status_code: statusCode });
    if (unavailableConfirmation) throw new Error("Synthetic unavailable confirmation");
    return reply({ id: published, media_product_type: "REELS", permalink: "https://www.instagram.com/reel/Synthetic123/",
      timestamp: "2026-10-28T15:00:00Z" });
  };
  const credentials = { async withDecryptedCredential(_input, action) {
    const token = Buffer.from("synthetic-token"); try { return await action(token); } finally { token.fill(0); }
  } };
  function open() {
    const publisher = createCalendarPublisher({ config, connectorStore, connectorAudit: { async append() {} }, credentials, transport, media });
    const service = createCalendarService({ store, source, media, grants, auth: adapter,
      identity: () => ({ companyId: context.companyId, userId: context.userId }),
      readClients: () => ({ [owner]: { ativo: true } }), publisher, clock: () => now });
    return { service, publisher };
  }
  let current = open(); await current.service.list(claims);
  const id = model.idFor(context.companyId, "generated-video-plan:1");
  const row = () => store.update(context.companyId, state => state.jobs[id]);
  return { pool, store, context, claims, posts, reads, container, row, open,
    current: () => current, restart: () => { current = open(); }, setStatus: value => { statusCode = value; },
    setConfirmationAvailable: () => { unavailableConfirmation = false; },
    advance: (ms = 60001) => { now += ms; },
    async tick() { await current.service.tick(); },
    async start() { await current.service.tick(); assert.equal((await row()).phase, "confirming"); },
    async observe() { now += 60001; await current.service.tick(); } };
}

test("generated 720p MP4 publishes the same container when FINISHED arrives on the fifth processing check", async () => {
  const f = await fixture(); await f.start();
  assert.equal(f.reads.length, 1); assert.equal(f.posts.length, 1);
  for (let count = 1; count <= 4; count++) {
    await f.observe(); assert.equal((await f.row()).deliveries.reel.providerObservationCount, count);
    assert.equal(f.reads.length, count + 1, "IN_PROGRESS must issue one GET per minute, never a second immediate GET");
    const before = f.reads.length; await f.tick(); assert.equal(f.reads.length, before);
  }
  f.setStatus("FINISHED"); await f.observe();
  const job = await f.row();
  assert.equal(job.phase, "published"); assert.equal(job.deliveries.reel.providerObservationCount, 5);
  assert.deepEqual(f.posts.map(value => value.operation), ["create", "publish"]);
  assert.equal(f.posts[1].body.creation_id, f.container);
  f.restart(); await f.observe(); assert.equal(f.posts.length, 2);
});

test("restart after the last durable FINISHED stage can complete without another processing-budget slot", async () => {
  const f = await fixture(); await f.start();
  const initial = await f.row(), intent = initial.deliveries.reel.intent;
  // Restore a valid persisted checkpoint: the last GET committed FINISHED/armed
  // before the process stopped. The same connector stage claim owns publication.
  await f.store.update(f.context.companyId, state => {
    const part = state.jobs[initial.id].deliveries.reel;
    part.providerObservationCount = 5; part.providerObservedAt = part.dispatchAt;
  });
  const publication = f.pool.state.publications.get(intent.publicationId);
  publication.reconciliation_reference = `igc:armed:${f.container}`;
  f.restart(); await f.observe();
  const job = await f.row();
  assert.equal(job.phase, "published"); assert.equal(job.deliveries.reel.providerObservationCount, 5);
  assert.equal(job.deliveries.reel.providerCompletionObservationCount, 1);
  assert.deepEqual(f.posts.map(value => value.operation), ["create", "publish"]);
});

test("two calendar instances share the observation claim and cannot duplicate a ready container publication", async () => {
  const f = await fixture(); await f.start(); f.setStatus("FINISHED"); f.advance();
  const other = f.open();
  await Promise.all([f.current().service.tick(), other.service.tick()]);
  assert.equal((await f.row()).phase, "published");
  assert.deepEqual(f.posts.map(value => value.operation), ["create", "publish"]);
  assert.equal((await f.row()).deliveries.reel.providerObservationCount, 1);
});

test("an uncertain publish on the final processing check is observed without repeating either POST", async () => {
  const f = await fixture({ timeoutPublish: true }); await f.start();
  for (let index = 0; index < 4; index++) await f.observe();
  f.setStatus("FINISHED"); await f.observe();
  assert.equal((await f.row()).phase, "confirming"); f.restart();
  for (let index = 0; index < 6; index++) await f.observe();
  const part = (await f.row()).deliveries.reel;
  assert.equal(part.providerObservationCount, 5); assert.equal(part.providerCompletionObservationCount, 4);
  assert.deepEqual(f.posts.map(value => value.operation), ["create", "publish"]);
  const item = (await f.current().service.list(f.claims)).items[0];
  assert.equal(item.status, "attention"); assert.match(item.statusLabel, /Confirmação pendente/);
  assert.equal(item.editable, false); assert.equal((await f.row()).phase, "confirming");
});

test("exhausted generated-video processing is visible attention while retaining the locked original intent", async () => {
  const f = await fixture(); await f.start();
  const intent = (await f.row()).deliveries.reel.intent;
  for (let index = 0; index < 8; index++) await f.observe();
  f.restart(); await f.observe();
  const stored = await f.row(), item = (await f.current().service.list(f.claims)).items[0];
  assert.equal(stored.phase, "confirming"); assert.equal(stored.deliveries.reel.providerObservationCount, 5);
  assert.deepEqual(stored.deliveries.reel.intent, intent);
  assert.equal(item.status, "attention"); assert.equal(item.error, "calendar_video_confirmation_pending");
  assert.match(item.statusLabel, /confira a publicação/); assert.equal(item.editable, false);
  assert.equal(f.posts.length, 1); assert.equal(f.reads.length, 6);
});

test("a known published media ID can be confirmed after the fifth processing check and restart", async () => {
  const f = await fixture({ unavailableConfirmation: true }); await f.start();
  for (let index = 0; index < 4; index++) await f.observe();
  f.setStatus("FINISHED"); await f.observe(); assert.equal((await f.row()).phase, "confirming");
  f.setConfirmationAvailable(); f.restart(); await f.observe();
  const job = await f.row(); assert.equal(job.phase, "published");
  assert.equal(job.deliveries.reel.providerObservationCount, 5);
  assert.equal(job.deliveries.reel.providerCompletionObservationCount, 1);
  assert.deepEqual(f.posts.map(value => value.operation), ["create", "publish"]);
});

for (const status of ["ERROR", "EXPIRED"]) test(`generated MP4 ${status} is terminal and never produces another container`, async () => {
  const f = await fixture(); await f.start(); f.setStatus(status); await f.observe(); f.restart(); await f.observe();
  assert.equal((await f.row()).phase, "failed"); assert.equal(f.posts.length, 1);
});

test("an uncertain create remains the same intent without a replacement POST", async () => {
  const f = await fixture({ timeoutCreate: true }); await f.start(); f.restart();
  for (let index = 0; index < 8; index++) await f.observe();
  assert.equal(f.posts.length, 1); assert.notEqual((await f.row()).phase, "published");
});
