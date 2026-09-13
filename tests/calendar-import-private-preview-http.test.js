"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const fs = require("node:fs/promises"), path = require("node:path"), http = require("node:http");
const express = require("express"), jwt = require("jsonwebtoken");
const { createProductionSession } = require("../src/social/production-session");
const { createSocialAuthAdapter } = require("../src/social/auth-adapter");
const { createImportAccessPolicy } = require("../src/social/calendar/imports/access-policy");
const { createPrivateImportPreviewService, parsePreviewRange } = require("../src/social/calendar/imports/preview-service");
const { createPrivateImportPreviewRouter } = require("../src/social/calendar/imports/preview-router");
const { createPrivatePipelineFixture } = require("./helpers/gallery-private-pipeline-fixture");
const PREFIX = "/v1/social/calendar/imports";
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
async function fixture(t) {
  let eligible = true;
  const clients = { "synthetic-preview-owner": { ativo: true }, "synthetic-preview-other": { ativo: true } };
  const session = createProductionSession({ secret: crypto.randomBytes(48).toString("hex"), readClients: () => clients });
  const auth = createSocialAuthAdapter({ namespaceUuid: crypto.randomUUID(), key: crypto.randomBytes(32), derivationVersion: "synthetic-preview-v1" });
  const token = session.sign("synthetic-preview-owner"), otherToken = session.sign("synthetic-preview-other");
  const principal = auth.fromVerifiedJwt(jwt.decode(token));
  const context = { authenticated: true, companyId: principal.companyId, userId: principal.userId };
  const accessPolicy = createImportAccessPolicy({ allowedOwners: [context], isEligible: () => eligible });
  const pipeline = await createPrivatePipelineFixture(t, { context, accessPolicy });
  let service = createPrivateImportPreviewService({ preparation: pipeline.preparation, resultStore: pipeline.preparedStore,
    accessPolicy, enabled: true, allowVolatileForTests: true });
  assert.equal(service.available, true);
  const app = express(); app.disable("etag");
  app.use(PREFIX, createPrivateImportPreviewRouter({ authenticate: session.authenticate, resolvePrincipal: claims => auth.fromVerifiedJwt(claims), getService: () => service }));
  app.use((_req, res) => res.status(404).json({ ok: false }));
  const server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const request = (route, options = {}) => fetch(base + route, { ...options, headers: { Authorization: `Bearer ${token}`, ...options.headers } });
  const routeFor = ready => `${PREFIX}/assets/${ready.assetId}/revisions/${ready.mediaRevision}/preview`;
  return { ...pipeline, service, base, token, otherToken, request, routeFor, server,
    revoke() { eligible = false; }, invalidateSession() { clients["synthetic-preview-owner"].ativo = false; },
    setService(value) { service = value; } };
}
test("preview range parser bounds full, open and suffix reads and rejects malformed/multiple ranges", () => {
  assert.deepEqual(parsePreviewRange(undefined, 10), { start: 0, end: 9, length: 10, partial: false });
  assert.deepEqual(parsePreviewRange("bytes=2-", 10), { start: 2, end: 9, length: 8, partial: true });
  assert.deepEqual(parsePreviewRange("bytes=-3", 10), { start: 7, end: 9, length: 3, partial: true });
  assert.equal(parsePreviewRange("bytes=0-999", 10).end, 9);
  for (const bad of ["bytes=", "bytes=-", "bytes=-0", "bytes=10-", "bytes=2-1", "bytes=0-1,4-5", "Bytes=0-1", "bytes=+0-1", "bytes=9007199254740992-"])
    assert.throws(() => parsePreviewRange(bad, 10), { code: "import_preview_range_invalid" });
});
test("actual received photo becomes a private prepared preview over authenticated HTTP, never its source", async t => {
  const f = await fixture(t), ready = await f.preparePhoto(), route = f.routeFor(ready);
  const before = f.store.snapshotForTest(f.context.companyId);
  const response = await f.request(route); assert.equal(response.status, 200);
  const payload = await response.json(), p = payload.preview;
  assert.equal(payload.ok, true); assert.equal(p.assetId, ready.assetId); assert.equal(p.mediaRevision, ready.mediaRevision);
  assert.match(p.previewDigest, /^[a-f0-9]{64}$/); assert.equal(p.testOnly, false);
  assert.equal(p.thumbnail, null); assert.ok(p.variants.length > 0);
  const exposed = JSON.stringify(payload);
  assert.doesNotMatch(exposed, /objectKey|resultRef|leaseToken|dispatchKey|[A-Z]:\\|Bearer /);
  for (const v of p.variants) {
    const parsed = new URL(v.url); assert.equal(parsed.origin, "https://ia4tube-api.onrender.com");
    assert.equal(parsed.search, ""); assert.equal(parsed.hash, ""); assert.equal(v.kind, "image");
    const image = await f.request(parsed.pathname), bytes = Buffer.from(await image.arrayBuffer());
    assert.equal(image.status, 200); assert.equal(image.headers.get("content-type"), "image/jpeg");
    assert.equal(image.headers.get("cache-control"), "private, no-store"); assert.equal(image.headers.get("etag"), null);
    assert.equal(bytes.length, v.sizeBytes); assert.equal(hash(bytes), v.sha256);
    assert.notEqual(v.sha256, v.sourceSha256);
    const head = await f.request(parsed.pathname, { method: "HEAD" }); assert.equal(head.status, 200);
    assert.equal(Number(head.headers.get("content-length")), bytes.length); assert.equal((await head.arrayBuffer()).byteLength, 0);
  }
  assert.deepEqual(f.store.snapshotForTest(f.context.companyId), before, "reads never request preparation, scheduling or publication");
});
test("HTTP preview supports private single ranges without allowing a cache/authentication bypass", async t => {
  const f = await fixture(t), ready = await f.preparePhoto(), route = f.routeFor(ready);
  const meta = (await (await f.request(route)).json()).preview.variants[0];
  const source = new URL(meta.url).pathname, whole = Buffer.from(await (await f.request(source)).arrayBuffer());
  for (const [range, start, end] of [["bytes=0-15", 0, 15], ["bytes=-17", whole.length - 17, whole.length - 1], [`bytes=${whole.length - 8}-`, whole.length - 8, whole.length - 1]]) {
    const part = await f.request(source, { headers: { Range: range, "If-None-Match": '"invented-cache"' } });
    assert.equal(part.status, 206); assert.equal(part.headers.get("content-range"), `bytes ${start}-${end}/${whole.length}`);
    assert.deepEqual(Buffer.from(await part.arrayBuffer()), whole.subarray(start, end + 1));
  }
  for (const range of ["bytes=0-1,4-5", "bytes=-0", `bytes=${whole.length}-`])
    assert.equal((await f.request(source, { headers: { Range: range } })).status, 416);
  assert.equal((await f.request(route, { headers: { Range: "bytes=0-1" } })).status, 416);
  assert.equal((await fetch(f.base + source, { headers: { "If-None-Match": '"invented-cache"' } })).status, 401);
});
test("foreign session, current eligibility revocation and inactive login cannot read prepared media", async t => {
  const f = await fixture(t), ready = await f.preparePhoto(), route = f.routeFor(ready);
  const p = (await (await f.request(route)).json()).preview;
  for (const url of [route, new URL(p.variants[0].url).pathname]) {
    const foreign = await f.request(url, { headers: { Authorization: `Bearer ${f.otherToken}` } });
    assert.equal(foreign.status, 404); assert.doesNotMatch(await foreign.text(), /objectKey|companyId|userId/);
  }
  f.revoke(); assert.equal((await f.request(route)).status, 404);
  f.invalidateSession(); assert.equal((await f.request(route)).status, 401);
});
test("preview paths, origins, methods and copied capability objects fail closed", async t => {
  const f = await fixture(t), ready = await f.preparePhoto(), route = f.routeFor(ready);
  assert.equal((await f.request(route + "?token=do-not-expose")).status, 404);
  assert.equal((await f.request(route + "/feed/")).status, 404);
  assert.equal((await f.request(route + "/source")).status, 404);
  assert.equal((await f.request(route, { method: "POST" })).status, 405);
  assert.equal((await f.request(route, { headers: { Origin: "https://attacker.invalid" } })).status, 403);
  assert.equal((await f.request(route, { headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
  assert.equal((await f.request(route, { headers: { "Content-Encoding": "gzip" } })).status, 400);
  f.setService({ ...f.service }); assert.equal((await f.request(route)).status, 503);
});
test("duplicate Range headers are refused before media streaming", async t => {
  const f = await fixture(t), ready = await f.preparePhoto();
  const result = await new Promise((resolve, reject) => {
    const req = http.request(f.base + f.routeFor(ready) + "/feed", { headers: ["Authorization", `Bearer ${f.token}`, "Range", "bytes=0-1", "Range", "bytes=2-3"] }, res => {
      const chunks = []; res.on("data", chunk => chunks.push(chunk)); res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    }); req.on("error", reject); req.end();
  });
  assert.equal(result.status, 400); assert.doesNotMatch(result.body, /Bearer|bytes=|objectKey/);
});
test("modified committed bytes are rejected and never replaced with the original upload", async t => {
  const f = await fixture(t), ready = await f.preparePhoto(), route = f.routeFor(ready);
  const v = (await (await f.request(route)).json()).preview.variants[0];
  const matches = [];
  async function findDerived(folder) {
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      const item = path.join(folder, entry.name);
      if (entry.isDirectory()) await findDerived(item);
      else if (entry.name === `${v.sha256}.jpg`) matches.push(item);
    }
  }
  await findDerived(f.privateRoot); assert.equal(matches.length, 1);
  // Deliberate corruption of this new synthetic fixture only; real results are
  // immutable/read-only and their protection is never changed by the service.
  await fs.chmod(matches[0], 0o600);
  const handle = await fs.open(matches[0], "r+");
  try { await handle.write(Buffer.from([0]), 0, 1, 0); await handle.sync(); } finally { await handle.close(); }
  const response = await f.request(new URL(v.url).pathname); assert.equal(response.status, 503);
  assert.match(response.headers.get("content-type"), /application\/json/);
  assert.doesNotMatch(await response.text(), /objectKey|[A-Z]:\\|sourceName|leaseToken/);
});

test("a newer revision invalidates the editor preview URL without overwriting the old prepared result", async t => {
  const f = await fixture(t), ready = await f.preparePhoto(), route = f.routeFor(ready);
  const old = await f.preparation.snapshot(f.context, { assetId: ready.assetId, mediaRevision: ready.mediaRevision });
  await f.preparation.request(f.context, { assetId: ready.assetId, uploadId: ready.uploadId, expectedMediaRevision: ready.mediaRevision,
    idempotencyKey: crypto.randomUUID(), selection: { kind: "image", targets: ["story"], audioMode: "none" } });
  assert.equal((await f.request(route)).status, 409);
  assert.equal((await f.request(route + "/feed")).status, 409);
  const preserved = await f.preparation.snapshot(f.context, { assetId: ready.assetId, mediaRevision: ready.mediaRevision });
  assert.deepEqual(preserved.result, old.result);
});

test("an aborted preview and eligibility loss after preflight never start byte delivery", async t => {
  const f = await fixture(t), ready = await f.preparePhoto();
  const request = { assetId: ready.assetId, mediaRevision: ready.mediaRevision, target: "feed" };
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(f.service.open(f.context, request, { signal: aborted.signal }), /import_preview_/);
  const open = await f.service.open(f.context, request);
  let chunks = 0;
  await open.stream(async () => { chunks++; }); assert.ok(chunks >= 1);
  const again = await f.service.open(f.context, request); f.revoke();
  await assert.rejects(again.stream(async () => assert.fail("revoked session must not see bytes")), /import_preview_/);
});

test("midstream eligibility revocation stops a multichunk image before further delivery", async t => {
  const sharp = require("sharp"), f = await fixture(t);
  const bytes = await sharp(crypto.randomBytes(1080 * 1350 * 3), { raw: { width: 1080, height: 1350, channels: 3 } }).png().toBuffer();
  const ready = await f.preparePhoto({ bytes, selection: { kind: "image", targets: ["feed"], audioMode: "none" } });
  const open = await f.service.open(f.context, { assetId: ready.assetId, mediaRevision: ready.mediaRevision, target: "feed" });
  assert.ok(open.descriptor.sizeBytes > 65536);
  let transferred = 0;
  await assert.rejects(open.stream(async chunk => { transferred += chunk.length; f.revoke(); }), /import_preview_/);
  assert.equal(transferred, 65536);
});

test("actual prepared MP4 and thumbnail have typed private HTTP previews and authenticated seeking", async t => {
  const f = await fixture(t), ready = await f.prepareVideo(), route = f.routeFor(ready);
  assert.equal(ready.status.ready, true);
  const meta = (await (await f.request(route)).json()).preview;
  assert.equal(meta.thumbnail.kind, "image"); assert.equal(meta.thumbnail.target, "thumbnail");
  assert.equal(meta.variants.length, 2);
  for (const v of meta.variants) {
    assert.equal(v.kind, "video"); assert.equal(v.audioMode, "muted"); assert.equal(v.hasAudio, false);
    const response = await f.request(new URL(v.url).pathname, { headers: { Range: "bytes=0-31" } });
    assert.equal(response.status, 206); assert.equal(response.headers.get("content-type"), "video/mp4");
    const bytes = Buffer.from(await response.arrayBuffer()); assert.equal(bytes.length, 32);
    assert.equal(bytes.subarray(4, 8).toString(), "ftyp");
  }
  const thumbnail = await f.request(new URL(meta.thumbnail.url).pathname);
  assert.equal(thumbnail.status, 200); assert.equal(hash(Buffer.from(await thumbnail.arrayBuffer())), meta.thumbnail.sha256);
});
