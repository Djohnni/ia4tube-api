"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const { fixtureContext, createMemoryPool } = require("./helpers/publication-atomic-memory-pool");
const { createPostgresConnectorStore } = require("../src/persistence/postgres/social-connector-store");
const { createCalendarPublisher } = require("../src/social/calendar/publisher");
const { loadInstagramOAuthConfig } = require("../src/social/oauth/instagram-config");
function fixture(uncertain = false, destination = "feed", withPermalink = true, productType = "STORY", accountType = "business", mediaKind = "image", rejectCreate = false) {
  const { context } = fixtureContext(), pool = createMemoryPool(context), posts = [];
  pool.state.connection.account_type = accountType;
  const store = createPostgresConnectorStore({ pool, publicationBindingRequired: true });
  const origin = "https://ia4tube-api.onrender.com";
  const config = loadInstagramOAuthConfig({ ENVIRONMENT: "production", PUBLIC_API_BASE_URL: origin,
    SOCIAL_INSTAGRAM_ENABLED: "true", SOCIAL_EXTERNAL_CONNECTION_ENABLED: "true", SOCIAL_EXTERNAL_PUBLICATION_ENABLED: "true",
    SOCIAL_PRODUCTION_OPERATION_ALLOWLIST_JSON: JSON.stringify([{ companyId: context.companyId, userId: context.userId }]),
    INSTAGRAM_APP_ID: "12345678901234", INSTAGRAM_APP_SECRET: crypto.randomBytes(32).toString("hex"),
    INSTAGRAM_GRAPH_API_VERSION: "v25.0", INSTAGRAM_OAUTH_REDIRECT_URI: `${origin}/v1/social/oauth/callback` });
  const caption = "Exatamente esta legenda, sem sufixo.", mediaId = mediaKind === "video" ? `calendar-prepared-v1:${"c".repeat(64)}` : `calendar-jpeg:${"b".repeat(64)}`;
  const binding = { connectionId: pool.state.connection.id, externalId: pool.state.connection.external_id, connectionRevision: 7 };
  const descriptor = { companyId: context.companyId, mediaId, caption, destination, mimeType: "image/jpeg", width: 1080, height: destination === "story" ? 1920 : 1350,
    metadataDigest: "c".repeat(64), publicUrl: `${origin}/v1/social/calendar/media/synthetic` };
  if (mediaKind === "video") Object.assign(descriptor, { userId: context.userId, mimeType: "video/mp4", target: destination,
    sha256: "b".repeat(64), sizeBytes: 1234, width: 720, height: 1280, durationSeconds: 10,
    hasAudio: true, audioMode: "original", shareToFeed: destination === "reel" });
  const reply = (value, status = 200) => ({ status, headers: { get: () => "application/json" }, arrayBuffer: async () => Buffer.from(JSON.stringify(value)) });
  const transport = async (url, request) => {
    assert.equal(pool.transactions, 0, "HTTP cannot hold the calendar/connector transaction");
    if (request.method === "POST") {
      posts.push(url);
      if (!url.endsWith("/media_publish")) {
        const body = new URLSearchParams(request.body);
        assert.equal(body.get("media_type"), destination === "story" ? "STORIES" : destination === "reel" ? "REELS" : null);
        assert.equal(body.get("caption"), destination === "story" ? null : caption);
        assert.ok(body.get(mediaKind === "video" ? "video_url" : "image_url"));
        if (rejectCreate) return reply({ error: { message: "Synthetic unsupported placement", code: 10, is_transient: false } }, 400);
      }
      assert.equal(new URLSearchParams(request.body).get("caption") || caption, caption);
      if (uncertain) throw new Error("synthetic uncertain provider");
      return reply({ id: url.endsWith("/media_publish") ? "18000000000000001" : "17900000000000001" });
    }
    if (url.includes("17900000000000001")) return reply({ status_code: "FINISHED" });
    return reply({ id: "18000000000000001", media_product_type: destination === "story" ? productType : destination === "reel" ? "REELS" : "FEED",
      permalink: !withPermalink ? undefined : destination === "story" ? "https://www.instagram.com/stories/synthetic/18000000000000001/" : "https://www.instagram.com/p/Synthetic123/", timestamp: "2026-09-05T00:00:00Z" });
  };
  const publisher = createCalendarPublisher({ config, connectorStore: store, connectorAudit: { async append() {} },
    credentials: { async withDecryptedCredential(_input, action) { const token = Buffer.from("synthetic-not-a-secret");
      try { return await action(token); } finally { token.fill(0); } } }, transport,
    media: { descriptor: () => descriptor, videoDescriptor: () => descriptor } });
  const job = { caption, target: destination, ...(mediaKind === "video" ? { mediaKind } : {}), authorization: { binding } }; job.intent = publisher.intent(context, job, crypto.randomUUID());
  return { publisher, context, job, posts, pool, store };
}
test("calendar adapter really invokes existing bound publisher, exact caption and durable confirmed history", async () => {
  const f = fixture(); const binding = await f.publisher.connection(f.context); assert.ok(binding);
  const first = await f.publisher.send(f.context, f.job);
  assert.equal(first.published, true); assert.equal(first.mediaId, "18000000000000001"); assert.equal(f.posts.length, 2);
  assert.deepEqual(await f.publisher.observe(f.context, f.job), first);
  await f.publisher.send(f.context, f.job); assert.equal(f.posts.length, 2);
});
test("unknown create outcome observes same intent without issuing another POST", async () => {
  const f = fixture(true);
  try { await f.publisher.send(f.context, f.job); } catch { /* same witness inspected below */ }
  await f.publisher.observe(f.context, f.job); await f.publisher.send(f.context, f.job);
  assert.equal(f.posts.length, 1);
  assert.notEqual((await f.publisher.status(f.context, f.job.intent.publicationId))?.published, true);
});

test("Story uses STORIES image container without Feed caption and confirms exact returned Story identity", async () => {
  const f = fixture(false, "story"); const result = await f.publisher.send(f.context, f.job);
  assert.equal(result.published, true); assert.equal(result.mediaId, "18000000000000001");
  assert.equal(result.permalink, "https://www.instagram.com/stories/synthetic/18000000000000001/");
  await f.publisher.send(f.context, f.job); assert.equal(f.posts.length, 2);
});

test("Story confirmation without a provider permalink preserves ID and time, never invents a link", async () => {
  const f = fixture(false, "story", false); const result = await f.publisher.send(f.context, f.job);
  assert.equal(result.published, true); assert.equal(result.mediaId, "18000000000000001"); assert.equal(result.permalink, null);
  assert.equal(result.publishedAt, Date.parse("2026-09-05T00:00:00Z"));
  await f.publisher.observe(f.context, f.job); assert.equal(f.posts.length, 2);
  const history = require("../src/social/reviewer-real/reviewer-real").publicPublication(await f.store.scope(f.context).getPublicationDetails(f.job.intent.publicationId));
  assert.equal(history.state, "published"); assert.equal(history.destination, "story"); assert.equal(history.permalink, null);
  assert.equal(history.providerMediaId, result.mediaId);
});
test("a media record of the wrong placement cannot confirm a Story or trigger another publish", async () => {
  const f = fixture(false, "story", true, "FEED"); const result = await f.publisher.send(f.context, f.job);
  assert.equal(result.published, false); await f.publisher.observe(f.context, f.job); assert.equal(f.posts.length, 2);
});

for (const mediaKind of ["image", "video"]) test(`creator ${mediaKind} Story uses the original connection and is never posted twice`, async () => {
  const f = fixture(false, "story", false, "STORY", "creator", mediaKind);
  assert.equal((await f.publisher.connection(f.context)).accountType, "creator");
  let result = await f.publisher.send(f.context, f.job);
  if (!result.published) result = await f.publisher.observe(f.context, f.job);
  assert.equal(result.published, true); assert.equal(f.posts.length, 2);
  await f.publisher.send(f.context, f.job); await f.publisher.observe(f.context, f.job);
  assert.equal(f.posts.length, 2); assert.equal(f.pool.state.connection.account_type, "creator");
});

test("a provider rejection for creator Story remains recorded without another create or publish", async () => {
  const f = fixture(false, "story", false, "STORY", "creator", "image", true);
  try { await f.publisher.send(f.context, f.job); } catch { /* Durable failure read below. */ }
  const original = await f.publisher.status(f.context, f.job.intent.publicationId);
  assert.equal(original.state, "failed_permanent"); assert.equal(original.published, false);
  await f.publisher.observe(f.context, f.job); await f.publisher.send(f.context, f.job);
  assert.equal(f.posts.length, 1);
});

for (const [destination, mediaKind] of [["feed", "image"], ["reel", "video"]])
  test(`creator ${destination} retains its existing publication path`, async () => {
    const f = fixture(false, destination, true, "STORY", "creator", mediaKind);
    let result = await f.publisher.send(f.context, f.job);
    if (!result.published) result = await f.publisher.observe(f.context, f.job);
    assert.equal(result.published, true); assert.equal(f.posts.length, 2);
  });
