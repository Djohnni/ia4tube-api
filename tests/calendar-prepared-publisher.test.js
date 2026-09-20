"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const { fixtureContext, createMemoryPool } = require("./helpers/publication-atomic-memory-pool");
const { createPostgresConnectorStore } = require("../src/persistence/postgres/social-connector-store");
const { createConnectorRegistry } = require("../src/social/connectors/registry");
const { createSocialConnectorService } = require("../src/social/connectors/service");
const { createInstagramPublicationConnector, parseConfirmedReference } = require("../src/social/publication/instagram-publication-connector");
const { createPublicationIntent } = require("../src/social/publication/connection-binding");
const { loadInstagramOAuthConfig } = require("../src/social/oauth/instagram-config");
const { preparedPublicationDescriptor } = require("../src/social/calendar/imports/publication-descriptor");
const { createLocalPublicationTransport } = require("../src/social/calendar/imports/publication-test-transport");
function fixture({ target = "reel", mimeType = "video/mp4", caption = "Legenda exata iA4tube", mode = "ok", change = {}, shareToFeed = target === "reel" } = {}) {
  const { context } = fixtureContext(), pool = createMemoryPool(context);
  const store = createPostgresConnectorStore({ pool, publicationBindingRequired: true });
  const origin = "https://ia4tube-api.onrender.com", posts = [], reads = [];
  const config = loadInstagramOAuthConfig({ ENVIRONMENT: "production", PUBLIC_API_BASE_URL: origin,
    SOCIAL_INSTAGRAM_ENABLED: "true", SOCIAL_EXTERNAL_CONNECTION_ENABLED: "true", SOCIAL_EXTERNAL_PUBLICATION_ENABLED: "true",
    SOCIAL_PRODUCTION_OPERATION_ALLOWLIST_JSON: JSON.stringify([{ companyId: context.companyId, userId: context.userId }]),
    INSTAGRAM_APP_ID: "12345678901234", INSTAGRAM_APP_SECRET: crypto.randomBytes(32).toString("hex"),
    INSTAGRAM_GRAPH_API_VERSION: "v25.0", INSTAGRAM_OAUTH_REDIRECT_URI: `${origin}/v1/social/oauth/callback` });
  const binding = { connectionId: pool.state.connection.id, externalId: pool.state.connection.external_id, connectionRevision: 7 };
  const part = { sha256: "b".repeat(64), sourceSha256: "a".repeat(64), objectKey: "c".repeat(64), objectVersion: crypto.randomUUID(),
    mimeType, size: 4096, sizeBytes: 4096, width: 1080, height: target === "feed" ? 1350 : 1920,
    durationSeconds: mimeType === "video/mp4" ? 15 : undefined, hasAudio: mimeType === "video/mp4",
    audioMode: mimeType === "video/mp4" ? "original" : "none", shareToFeed: target === "reel" && shareToFeed };
  const job = { id: "d".repeat(40), sourceKind: "upload", layout: "import_prepared_v1", target, caption,
    selectedTargets: [target], assets: { [target]: part }, import: { userId: context.userId, assetId: crypto.randomUUID(), mediaRevision: 1,
      resultRef: crypto.randomUUID(), previewDigest: "e".repeat(64), preview: { testOnly: false } } };
  const descriptor = { ...preparedPublicationDescriptor(context.companyId, job), publicUrl: `${origin}/v1/social/calendar/media/prepared/synthetic`, ...change };
  const media = { async resolveOwnedJpeg() { throw new Error("A prepared object is not a legacy JPEG"); }, async resolveOwnedPreparedMedia() { return descriptor; } };
  const reply = value => ({ status: 200, headers: { get: () => "application/json" }, arrayBuffer: async () => Buffer.from(JSON.stringify(value)) });
  let currentMode = mode;
  const transport = createLocalPublicationTransport(async (url, request) => {
    assert.equal(pool.transactions, 0, "No HTTP inside a database transaction");
    assert.equal(new URL(url).origin, "https://graph.instagram.com");
    assert.equal(request.headers.authorization, "Bearer synthetic-local-token");
    assert.equal(new URL(url).searchParams.has("access_token"), false);
    if (request.method === "POST") {
      const body = new URLSearchParams(request.body); posts.push({ pathname: new URL(url).pathname, body: Object.fromEntries(body) });
      const publishing = url.endsWith("/media_publish");
      if (currentMode === "create-rejected" && !publishing || currentMode === "publish-rejected" && publishing)
        return { ...reply({ error: { code: 100, message: "synthetic rejection" } }), status: 400 };
      if (currentMode === "create-unknown" && !publishing || currentMode === "publish-unknown" && publishing) throw new Error("Synthetic interrupted response");
      if (currentMode === "body-timeout" && !publishing) return { status: 200, headers: { get: () => "application/json" }, arrayBuffer: () => new Promise(() => {}) };
      return reply({ id: publishing ? "18000000000000001" : "17900000000000001" });
    }
    reads.push(url);
    if (url.includes("17900000000000001")) return reply({ status_code: currentMode === "publish-unknown" && posts.some(value => value.pathname.endsWith("/media_publish")) ? "PUBLISHED" : "FINISHED" });
    if (currentMode === "confirm-unknown") throw new Error("Synthetic unavailable confirmation");
    return reply({ id: "18000000000000001", timestamp: "2026-09-13T00:00:00Z",
      media_product_type: currentMode === "wrong-product" ? "FEED" : target === "story" ? "STORY" : target === "reel" ? "REELS" : "FEED",
      permalink: target === "story" ? undefined : `https://www.instagram.com/${target === "reel" ? "reel" : "p"}/Synthetic123/` });
  });
  const connector = createInstagramPublicationConnector({ config, store, media, transport, destination: target, timeoutMs: 20,
    pollAttempts: 1, pollIntervalMs: 0, authorizeContext: value => value === context,
    authorizeConnection: () => true, authorizePublicationRequest: () => true, authorizePublication: () => true,
    allowOperationReferenceReconciliation: false, authorizePublishedCandidate: () => false,
    credentials: { async withDecryptedCredential(_input, action) { const token = Buffer.from("synthetic-local-token");
      try { return await action(token); } finally { token.fill(0); } } } });
  const registry = createConnectorRegistry({ environment: "production", gates: { externalConnectionEnabled: true,
    externalPublicationEnabled: true, enabledProviders: ["instagram"], companyAllowlist: [context.companyId] } });
  registry.register(connector); registry.seal();
  const service = createSocialConnectorService({ registry, store, media, audit: { async append() {} }, publicationBindingRequired: true });
  const intent = createPublicationIntent({ companyId: context.companyId, clientRequestId: crypto.randomUUID(), binding,
    mediaId: descriptor.mediaId, mediaMetadataDigest: descriptor.metadataDigest, caption });
  const input = { ...Object.fromEntries(["operationId", "publicationId", "clientRequestId"].map(key => [key, intent[key]])),
    connectionId: binding.connectionId, binding, caption, image: { mediaId: descriptor.mediaId, mimeType, metadataDigest: descriptor.metadataDigest } };
  return { context, service, store, input, intent, posts, reads, descriptor, job, setMode(value) { currentMode = value; },
    publish: () => service.publishPreparedMedia(context, input),
    async observe() { const row = await store.scope(context).getPublicationDetails(intent.publicationId);
      return service.getPublicationStatus(context, { publicationId: intent.publicationId, operationId: crypto.randomUUID(), binding,
        providerReference: row.reconciliationReference }); } };
}
test("Reel without Feed keeps explicit false through descriptor and provider without another publication", async () => {
  const f = fixture({ target: "reel", mimeType: "video/mp4", shareToFeed: false });
  assert.equal(f.job.assets.reel.shareToFeed, false); assert.equal(f.descriptor.shareToFeed, false);
  const result = await f.publish(); assert.equal(result.state, "published");
  assert.equal(f.posts.length, 2, "One create plus one publish is still one Reel publication");
  assert.equal(f.posts[0].body.media_type, "REELS"); assert.equal(f.posts[0].body.share_to_feed, "false");
  assert.deepEqual(f.job.selectedTargets, ["reel"]); assert.equal(Object.keys(f.job.assets).length, 1);
});
for (const [target, mimeType] of [["feed", "image/jpeg"], ["story", "image/jpeg"], ["story", "video/mp4"], ["reel", "video/mp4"]]) {
  test(`prepared ${target}/${mimeType} uses real provider adapter, typed URL and persisted confirmation`, async () => {
    const f = fixture({ target, mimeType }); const result = await f.publish();
    assert.equal(result.state, "published"); assert.equal(f.posts.length, 2);
    const body = f.posts[0].body;
    assert.equal(body[mimeType === "video/mp4" ? "video_url" : "image_url"], f.descriptor.publicUrl);
    assert.equal(body[mimeType === "video/mp4" ? "image_url" : "video_url"], undefined);
    assert.equal(body.media_type, target === "story" ? "STORIES" : target === "reel" ? "REELS" : undefined);
    assert.equal(body.share_to_feed, target === "reel" ? "true" : undefined);
    assert.equal(body.caption, target === "story" ? undefined : f.input.caption);
    const saved = await f.store.scope(f.context).getPublicationDetails(f.intent.publicationId);
    assert.equal(saved.mediaMetadataDigest, f.descriptor.metadataDigest);
    assert.equal(saved.requestHash, f.intent.requestHash);
    assert.equal(parseConfirmedReference(saved.confirmedProviderReference).mediaId, "18000000000000001");
    assert.equal((await f.publish()).state, "published"); assert.equal(f.posts.length, 2);
  });
}
test("Story-only empty caption is an exact durable intent and is not sent as text", async () => {
  const f = fixture({ target: "story", caption: "" }); assert.equal((await f.publish()).state, "published");
  assert.equal((await f.store.scope(f.context).getPublicationDetails(f.intent.publicationId)).caption, "");
  assert.equal(f.posts[0].body.caption, undefined);
});
for (const mode of ["create-unknown", "body-timeout", "publish-unknown"]) test(`prepared ${mode} never repeats the uncertain mutation`, async () => {
  const f = fixture({ mode }); await f.publish().catch(() => {});
  const count = f.posts.length; await f.observe().catch(() => {}); await f.publish().catch(() => {});
  assert.equal(f.posts.length, count); assert.equal(count, mode === "publish-unknown" ? 2 : 1);
  assert.notEqual((await f.store.scope(f.context).getPublicationDetails(f.intent.publicationId)).state, "published");
});
test("known provider ID reconciles after restart-equivalent read without creating another container", async () => {
  const f = fixture({ mode: "confirm-unknown" }); assert.equal((await f.publish()).state, "provider_confirming");
  f.setMode("ok"); assert.equal((await f.observe()).state, "published"); assert.equal(f.posts.length, 2);
});
for (const mode of ["create-rejected", "publish-rejected"]) test(`prepared ${mode} is a known durable failure, not uncertain or retried`, async () => {
  const f = fixture({ mode }); assert.equal((await f.publish()).state, "failed_permanent");
  const count = f.posts.length;
  await f.publish().catch(() => {}); await f.observe().catch(() => {});
  assert.equal(f.posts.length, count); assert.equal(count, mode === "create-rejected" ? 1 : 2);
  assert.equal((await f.store.scope(f.context).getPublicationDetails(f.intent.publicationId)).state, "failed_permanent");
});
test("a returned Feed cannot confirm a Reel and cannot cause another upload", async () => {
  const f = fixture({ mode: "wrong-product" }); assert.equal((await f.publish()).state, "provider_confirming");
  await f.observe(); assert.equal(f.posts.length, 2);
});
for (const change of [{ sizeBytes: 100000001 }, { durationSeconds: 60.01 }, { durationSeconds: 2.99 },
  { audioMode: "muted", hasAudio: true }, { userId: crypto.randomUUID() }]) test(`prepared provider boundary rejects ${Object.keys(change).join("/")} before POST`, async () => {
  const f = fixture({ target: "story", change }); await assert.rejects(f.publish()); assert.equal(f.posts.length, 0);
});
test("descriptor binds target, owner, media revision and Reel feed sharing independently of mutable calendar revision", () => {
  const f = fixture(); const original = preparedPublicationDescriptor(f.context.companyId, f.job);
  assert.equal(preparedPublicationDescriptor(f.context.companyId, { ...f.job, revision: 9 }).metadataDigest, original.metadataDigest);
  for (const job of [{ ...f.job, import: { ...f.job.import, mediaRevision: 2 } },
    { ...f.job, assets: { reel: { ...f.job.assets.reel, shareToFeed: false } } }, { ...f.job, caption: "Outra legenda" }]) {
    assert.notEqual(preparedPublicationDescriptor(f.context.companyId, job).metadataDigest, original.metadataDigest);
  }
});
