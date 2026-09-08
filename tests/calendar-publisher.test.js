"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const { fixtureContext, createMemoryPool } = require("./helpers/publication-atomic-memory-pool");
const { createPostgresConnectorStore } = require("../src/persistence/postgres/social-connector-store");
const { createCalendarPublisher } = require("../src/social/calendar/publisher");
const { loadInstagramOAuthConfig } = require("../src/social/oauth/instagram-config");
function fixture(uncertain = false) {
  const { context } = fixtureContext(), pool = createMemoryPool(context), posts = [];
  const store = createPostgresConnectorStore({ pool, publicationBindingRequired: true });
  const origin = "https://ia4tube-api.onrender.com";
  const config = loadInstagramOAuthConfig({ ENVIRONMENT: "production", PUBLIC_API_BASE_URL: origin,
    SOCIAL_INSTAGRAM_ENABLED: "true", SOCIAL_EXTERNAL_CONNECTION_ENABLED: "true", SOCIAL_EXTERNAL_PUBLICATION_ENABLED: "true",
    SOCIAL_PRODUCTION_OPERATION_ALLOWLIST_JSON: JSON.stringify([{ companyId: context.companyId, userId: context.userId }]),
    INSTAGRAM_APP_ID: "12345678901234", INSTAGRAM_APP_SECRET: crypto.randomBytes(32).toString("hex"),
    INSTAGRAM_GRAPH_API_VERSION: "v25.0", INSTAGRAM_OAUTH_REDIRECT_URI: `${origin}/v1/social/oauth/callback` });
  const caption = "Exatamente esta legenda, sem sufixo.", mediaId = `calendar-jpeg:${"b".repeat(64)}`;
  const binding = { connectionId: pool.state.connection.id, externalId: pool.state.connection.external_id, connectionRevision: 7 };
  const descriptor = { companyId: context.companyId, mediaId, caption, mimeType: "image/jpeg", width: 1080, height: 1080,
    metadataDigest: "c".repeat(64), publicUrl: `${origin}/v1/social/calendar/media/synthetic` };
  const reply = value => ({ status: 200, headers: { get: () => "application/json" }, arrayBuffer: async () => Buffer.from(JSON.stringify(value)) });
  const transport = async (url, request) => {
    assert.equal(pool.transactions, 0, "HTTP cannot hold the calendar/connector transaction");
    if (request.method === "POST") {
      posts.push(url);
      assert.equal(new URLSearchParams(request.body).get("caption") || caption, caption);
      if (uncertain) throw new Error("synthetic uncertain provider");
      return reply({ id: url.endsWith("/media_publish") ? "18000000000000001" : "17900000000000001" });
    }
    if (url.includes("17900000000000001")) return reply({ status_code: "FINISHED" });
    return reply({ id: "18000000000000001", permalink: "https://www.instagram.com/p/Synthetic123/", timestamp: "2026-09-05T00:00:00Z" });
  };
  const publisher = createCalendarPublisher({ config, connectorStore: store, connectorAudit: { async append() {} },
    credentials: { async withDecryptedCredential(_input, action) { const token = Buffer.from("synthetic-not-a-secret");
      try { return await action(token); } finally { token.fill(0); } } }, transport,
    media: { descriptor: () => descriptor } });
  const job = { caption, authorization: { binding } }; job.intent = publisher.intent(context, job, crypto.randomUUID());
  return { publisher, context, job, posts, pool };
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
