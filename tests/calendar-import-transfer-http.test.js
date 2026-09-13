"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path"), http = require("node:http");
const express = require("express"), jwt = require("jsonwebtoken");
const { Readable } = require("node:stream");
const { createProductionSession } = require("../src/social/production-session");
const { createSocialAuthAdapter } = require("../src/social/auth-adapter");
const { createImportAccessPolicy } = require("../src/social/calendar/imports/access-policy");
const { createMemoryImportUploadStore } = require("../src/social/calendar/imports/memory-adapters");
const { createCalendarImportUploadService } = require("../src/social/calendar/imports/upload-service");
const { createRenderDiskPrivateUploadProvider } = require("../src/social/calendar/imports/render-disk-provider");
const { createRenderDiskAdmission } = require("../src/social/calendar/imports/render-disk-admission");
const { createGlobalMediaCapacity, freshGlobalCapacityState, validateGlobalCapacityState } = require("../src/social/calendar/imports/global-capacity");
const { createTransferAuthorizationRegistry, createMemoryTransferRegistryStore } = require("../src/social/calendar/imports/transfer-registry");
const { createCalendarImportRouter } = require("../src/social/calendar/imports/router");
const { createRenderDiskTransferService, createSingleProcessTransferLimiter } = require("../src/social/calendar/imports/transfer-service");
const { createCalendarImportByteRouter, redactImportTransferUrl } = require("../src/social/calendar/imports/transfer-router");
const { validateImportUploadState } = require("../src/social/calendar/imports/postgres-store");
const checksum = (bytes, type = "sha256", encoding = "hex") => crypto.createHash(type).update(bytes).digest(encoding);
const PREFIX = "/v1/social/calendar/imports";
function ledger() {
  let state = freshGlobalCapacityState(), tail = Promise.resolve();
  return { capabilities: { persistence: "volatile", atomicGlobalUpdates: true, testOnly: true },
    update(operation) { const result = tail.then(() => { const next = structuredClone(state), out = operation(next);
      assert.equal(Boolean(out?.then), false); validateGlobalCapacityState(next); state = next; return structuredClone(out); });
      tail = result.catch(() => {}); return result; } };
}
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iA4tube-transfer-http-")); await fs.chmod(root, 0o700);
  let time = Date.now(), eligible = true;
  const clock = () => time, clients = { "synthetic-owner": { ativo: true }, "synthetic-other": { ativo: true } };
  const session = createProductionSession({ secret: crypto.randomBytes(48).toString("hex"), readClients: () => clients });
  const auth = createSocialAuthAdapter({ namespaceUuid: crypto.randomUUID(), key: crypto.randomBytes(32), derivationVersion: "synthetic-transfer-v1" });
  const token = session.sign("synthetic-owner"), principal = auth.fromVerifiedJwt(jwt.decode(token));
  const context = { authenticated: true, companyId: principal.companyId, userId: principal.userId };
  const other = auth.fromVerifiedJwt(jwt.decode(session.sign("synthetic-other")));
  const accessPolicy = createImportAccessPolicy({ allowedOwners: [context], isEligible: () => eligible && clients["synthetic-owner"].ativo });
  const store = createMemoryImportUploadStore(), globalStore = ledger();
  const capacity = createGlobalMediaCapacity({ store: globalStore, enabled: true, allowVolatileForTests: true });
  const admission = createRenderDiskAdmission({ capacity, store, rootDirectory: root,
    coordinatorContext: { authenticated: true, role: "calendar_media_capacity_coordinator" }, enabled: true, allowVolatileForTests: true });
  const inspector = { capabilities: { isolated: true, bounded: true, remoteObjectInspection: true },
    async startInspection() { throw new Error("real-decoder-not-mounted"); }, async getInspection() { throw new Error("real-decoder-not-mounted"); } };
  const provider = createRenderDiskPrivateUploadProvider({ rootDirectory: root, store, admission, inspector,
    transferOrigin: "https://ia4tube-api.onrender.com", enabled: true, allowVolatileForTests: true, clock });
  const upload = createCalendarImportUploadService({ store, provider, enabled: true, allowVolatileForTests: true, clock });
  const registryStore = createMemoryTransferRegistryStore();
  const registry = createTransferAuthorizationRegistry({ store: registryStore, enabled: true, allowVolatileForTests: true, clock });
  const makeService = overrides => createRenderDiskTransferService({ store, provider, registry, accessPolicy,
    enabled: true, allowVolatileForTests: true, clock, ...overrides });
  let transfer = makeService(options.service);
  const facade = { ready: true, allowed: ctx => { try { accessPolicy.resolve(ctx); return true; } catch (_) { return false; } },
    capabilities: () => ({ enabled: true }), upload: transfer.wrapUpload(upload) };
  const app = express();
  if (options.parserBefore) app.use(express.raw({ type: "application/octet-stream", limit: "6mb" }));
  app.use(`${PREFIX}/bytes`, createCalendarImportByteRouter({ getService: () => transfer, timeoutMs: options.timeoutMs || 30000 }));
  app.use(PREFIX, createCalendarImportRouter({ authenticate: session.authenticate, resolvePrincipal: claims => auth.fromVerifiedJwt(claims), getService: () => facade }));
  const server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("iA4tube-transfer-http-"));
    await fs.rm(root, { recursive: true, force: true }); assert.equal(await fs.stat(root).then(() => true, () => false), false);
  });
  const meta = async (suffix, data, bearer = token) => fetch(base + PREFIX + suffix,
    { method: data === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  async function issue(bytes = Buffer.from("SYNTHETIC_TRANSFER_BYTES")) {
    const start = await meta("/uploads", { idempotencyKey: crypto.randomUUID(), kind: "image", mimeType: "image/jpeg", sizeBytes: bytes.length, sha256: checksum(bytes) });
    assert.equal(start.status, 200); const { upload: item } = await start.json();
    const input = { sha256: checksum(bytes), md5Base64: checksum(bytes, "md5", "base64") };
    const authorized = await meta(`/uploads/${item.uploadId}/parts/1/authorize`, input); assert.equal(authorized.status, 200);
    const { part } = await authorized.json();
    const resolved = await meta(`/uploads/${item.uploadId}/parts/1/resolve`, { authorizationId: part.authorizationId });
    assert.equal(resolved.status, 200); const { grant } = await resolved.json();
    return { item, part, grant, bytes, url: base + new URL(grant.url).pathname,
      headers: { "Content-Type": "application/octet-stream", ...grant.headers } };
  }
  async function put(issued, changes = {}) { return fetch(issued.url, { method: "PUT", headers: issued.headers, body: issued.bytes, ...changes }); }
  return { root, base, context, other, provider, upload, store, registry, registryStore, capacity, makeService, meta, issue, put,
    setService(value) { transfer = value; }, now: () => time, advance(ms) { time += ms; }, revokeOwner() { eligible = false; } };
}

test("authenticated metadata issues a private grant; real HTTP bytes resume after service reconstruction without creating a task", async t => {
  const f = await fixture(t), issued = await f.issue();
  const hidden = await f.registryStore.update(state => JSON.stringify(state)); assert.ok(!hidden.includes(issued.part.authorizationId));
  const result = await f.put(issued); assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { ok: true, part: { partNumber: 1, sizeBytes: issued.bytes.length, sha256: checksum(issued.bytes) } });
  assert.equal(result.headers.get("cache-control"), "private, no-store");
  f.setService(f.makeService());
  const replay = await f.put(issued); assert.equal(replay.status, 200);
  const resume = await f.meta(`/uploads/${issued.item.uploadId}/resume`, {}); assert.equal(resume.status, 200);
  const state = (await resume.json()).upload;
  assert.equal(state.state, "uploading"); assert.equal(state.completedParts.length, 1); assert.equal(state.ready, false);
  const summary = await f.capacity.summary({ context: { authenticated: true, role: "calendar_media_capacity_coordinator" } });
  assert.equal(summary.monthlyJobs, 0); assert.equal(summary.activeJobs, 0);
  const row = f.store.snapshotForTest(f.context.companyId).uploads[issued.item.uploadId];
  assert.deepEqual(await fs.readFile(path.join(f.root, row.objectKey, "part-1.bin")), issued.bytes);
  assert.equal(validateImportUploadState(f.store.snapshotForTest(f.context.companyId), f.context.companyId).schema, 1);
});

test("raw route refuses credentials, foreign origins, query/path injection, encodings and changed checksum headers", async t => {
  const f = await fixture(t), issued = await f.issue();
  for (const [header, value, status] of [["Authorization", "Bearer synthetic-secret", 403], ["Cookie", "session=synthetic-secret", 403],
    ["Origin", "https://attacker.invalid", 403], ["Sec-Fetch-Site", "cross-site", 403], ["Content-Encoding", "gzip", 400],
    ["Content-Range", "bytes 0-1/2", 400], ["Content-Type", "image/jpeg", 415],
    ["content-md5", Buffer.alloc(16, 5).toString("base64"), 400], ["x-amz-checksum-sha256", Buffer.alloc(32, 5).toString("base64"), 400]]) {
    const response = await f.put(issued, { headers: { ...issued.headers, [header]: value } }); assert.equal(response.status, status, header);
    const body = await response.text(); assert.doesNotMatch(body, /synthetic-secret|attacker/);
  }
  for (const suffix of ["?companyId=" + f.other.companyId, "/", "%2f", "/another"]) {
    const response = await fetch(issued.url + suffix, { method: "PUT", headers: issued.headers, body: issued.bytes }); assert.equal(response.status, 404);
  }
  assert.equal((await fetch(issued.url)).status, 405);
  const row = f.store.snapshotForTest(f.context.companyId).uploads[issued.item.uploadId];
  assert.deepEqual((await fs.readdir(path.join(f.root, row.objectKey))).sort(), ["identity.json"]);
});

test("body parser before raw mount fails closed instead of accepting reconstructed bytes", async t => {
  const f = await fixture(t, { parserBefore: true }), issued = await f.issue();
  assert.equal((await f.put(issued)).status, 400);
});

test("expired, revoked and replaced authorizations cannot write; unknown grant does not scan tenant state", async t => {
  const f = await fixture(t), expired = await f.issue(); f.advance(600001);
  assert.equal((await f.put(expired)).status, 404);
  const revoked = await f.issue(); await f.registry.revoke(revoked.part.authorizationId); assert.equal((await f.put(revoked)).status, 404);
  const replaced = await f.issue();
  const second = await f.meta(`/uploads/${replaced.item.uploadId}/parts/1/authorize`, { sha256: checksum(replaced.bytes), md5Base64: checksum(replaced.bytes, "md5", "base64") });
  assert.equal(second.status, 200); assert.equal((await f.put(replaced)).status, 404);
  const response = await fetch(f.base + PREFIX + "/bytes/" + crypto.randomUUID(), { method: "PUT", headers: replaced.headers, body: replaced.bytes });
  assert.equal(response.status, 404);
});

test("owner access is rechecked after a grant exists and before source data is written", async t => {
  const f = await fixture(t), issued = await f.issue(); f.revokeOwner();
  assert.equal((await f.put(issued)).status, 404);
  assert.equal((await f.meta(`/uploads/${issued.item.uploadId}/resume`, {})).status, 503);
});

test("same-size wrong bytes cannot commit a part or expose filesystem/provider errors", async t => {
  const f = await fixture(t), issued = await f.issue();
  const response = await f.put(issued, { body: Buffer.alloc(issued.bytes.length, 9) });
  assert.equal(response.status, 422); const body = await response.text();
  assert.ok(!body.includes(f.root)); assert.ok(!body.includes(issued.part.authorizationId));
  const row = f.store.snapshotForTest(f.context.companyId).uploads[issued.item.uploadId];
  assert.deepEqual((await fs.readdir(path.join(f.root, row.objectKey))).sort(), ["identity.json"]);
  assert.equal((await f.put(issued)).status, 200);
});

test("single-process concurrency denies excess lookups and same-company transfers without a queued retry", async () => {
  const limiter = createSingleProcessTransferLimiter({ maxConcurrent: 2, maxPerCompany: 1 });
  const companyId = crypto.randomUUID(); let release;
  const first = limiter.run(async () => ({ companyId }), () => new Promise(resolve => { release = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(limiter.run(async () => ({ companyId }), () => { throw new Error("must-not-run"); }), { code: "import_transfer_busy" });
  let finishLookup;
  const second = limiter.run(() => new Promise(resolve => { finishLookup = resolve; }), () => true);
  await assert.rejects(limiter.run(() => { throw new Error("lookup-must-not-run"); }, () => true), { code: "import_transfer_busy" });
  release(true); finishLookup({ companyId: crypto.randomUUID() }); await Promise.all([first, second]);
  assert.equal(await limiter.run(async () => ({ companyId }), () => true), true);
});

test("unavailable or unbranded services cannot expose the raw path", async t => {
  const f = await fixture(t), issued = await f.issue();
  for (const service of [null, { available: true, async acceptPart() { throw new Error("must-not-run"); } }, f.makeService({ enabled: false }), f.makeService({ allowVolatileForTests: false })]) {
    f.setService(service); assert.equal((await f.put(issued)).status, 503);
  }
});

test("lost registry acknowledgement never exposes an unregistered grant and retry uses same upload", async t => {
  const f = await fixture(t), issued = await f.issue(); let calls = 0;
  const registry = { ...f.registry, async register(binding) { calls++; await f.registry.register(binding); if (calls === 1) throw new Error("synthetic-store-secret"); return binding; } };
  const transfer = f.makeService({ registry });
  const input = { uploadId: issued.item.uploadId, partNumber: 1, authorizationId: issued.part.authorizationId };
  await assert.rejects(transfer.resolvePart(f.upload, f.context, input), error => error.code === "import_transfer_unavailable" && !error.message.includes("secret"));
  assert.equal((await transfer.resolvePart(f.upload, f.context, input)).url, issued.grant.url);
  assert.equal(Object.keys(f.store.snapshotForTest(f.context.companyId).uploads).length, 1);
});

test("interrupted HTTP upload releases its own partial bytes; resume grants only the same uncommitted part", async t => {
  const f = await fixture(t), issued = await f.issue(Buffer.alloc(128 * 1024, 7));
  await new Promise(resolve => {
    const request = http.request(issued.url, { method: "PUT", headers: issued.headers }); request.on("error", () => resolve());
    request.write(issued.bytes.subarray(0, 4000)); setTimeout(() => request.destroy(), 30);
  });
  const row = f.store.snapshotForTest(f.context.companyId).uploads[issued.item.uploadId];
  // Bounded wait for the aborted socket's already-started filesystem cleanup.
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await fs.readdir(path.join(f.root, row.objectKey))).length === 1) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.deepEqual((await fs.readdir(path.join(f.root, row.objectKey))).sort(), ["identity.json"]);
  assert.equal((await f.put(issued)).status, 200);
});

test("revocation between chunks prevents the part from being committed", async t => {
  const f = await fixture(t), issued = await f.issue(Buffer.alloc(128 * 1024, 6));
  let release, started;
  const start = new Promise(resolve => { started = resolve; }), gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const stream = Readable.from((async function* () {
    yield issued.bytes.subarray(0, 4096); started(); await gate; yield issued.bytes.subarray(4096);
  })());
  const transfer = f.makeService();
  const pending = transfer.acceptPart({ authorizationId: issued.part.authorizationId, contentLength: issued.bytes.length,
    md5Base64: issued.headers["content-md5"], sha256Base64: issued.headers["x-amz-checksum-sha256"], stream }).then(value => ({ value }), error => ({ error }));
  await start; await f.registry.revoke(issued.part.authorizationId); release();
  const result = await pending; assert.ok(result.error); assert.equal(result.value, undefined);
  const row = f.store.snapshotForTest(f.context.companyId).uploads[issued.item.uploadId];
  assert.deepEqual((await fs.readdir(path.join(f.root, row.objectKey))).sort(), ["identity.json"]);
});

test("wall deadline closes stalled registry lookup and late resolution cannot begin a writer", async t => {
  const f = await fixture(t, { timeoutMs: 100 }), issued = await f.issue();
  let release, started;
  const start = new Promise(resolve => { started = resolve; }), gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const registry = { ...f.registry, async resolve(id) { started(); await gate; return f.registry.resolve(id); } };
  f.setService(f.makeService({ registry }));
  const request = f.put(issued).then(response => ({ status: response.status }), () => ({ socketClosed: true }));
  await start;
  const result = await request;
  assert.ok(result.socketClosed || result.status === 408);
  release(); await new Promise(resolve => setTimeout(resolve, 30));
  const row = f.store.snapshotForTest(f.context.companyId).uploads[issued.item.uploadId];
  assert.deepEqual((await fs.readdir(path.join(f.root, row.objectKey))).sort(), ["identity.json"]);
  f.setService(f.makeService()); assert.equal((await f.put(issued)).status, 200);
});

test("multipart HTTP uses separate exact grants and resume lists actual persisted chunks", async t => {
  const f = await fixture(t), bytes = Buffer.alloc(5 * 1024 * 1024 + 9000, 3);
  const start = await f.meta("/uploads", { idempotencyKey: crypto.randomUUID(), kind: "image", mimeType: "image/jpeg",
    sizeBytes: bytes.length, sha256: checksum(bytes) }); assert.equal(start.status, 200);
  const item = (await start.json()).upload;
  for (let partNumber = 1; partNumber <= 2; partNumber++) {
    const chunk = bytes.subarray((partNumber - 1) * 5 * 1024 * 1024, Math.min(partNumber * 5 * 1024 * 1024, bytes.length));
    const authorized = await f.meta(`/uploads/${item.uploadId}/parts/${partNumber}/authorize`, {
      sha256: checksum(chunk), md5Base64: checksum(chunk, "md5", "base64") }); assert.equal(authorized.status, 200);
    const part = (await authorized.json()).part;
    const resolved = await f.meta(`/uploads/${item.uploadId}/parts/${partNumber}/resolve`, { authorizationId: part.authorizationId });
    assert.equal(resolved.status, 200); const grant = (await resolved.json()).grant;
    const response = await fetch(f.base + new URL(grant.url).pathname, { method: "PUT", headers: {
      "Content-Type": "application/octet-stream", ...grant.headers }, body: chunk });
    assert.equal(response.status, 200); assert.equal((await response.json()).part.partNumber, partNumber);
  }
  const resume = await f.meta(`/uploads/${item.uploadId}/resume`, {}), observation = (await resume.json()).upload;
  assert.equal(observation.completedParts.length, 2);
  assert.equal(observation.completedParts.reduce((sum, part) => sum + part.sizeBytes, 0), bytes.length);
  assert.equal(observation.state, "uploading"); assert.equal(observation.ready, false);
});

test("store boundary rejects malformed additive disk data without changing legacy upload records", () => {
  const companyId = crypto.randomUUID(), userId = crypto.randomUUID(), uploadId = crypto.randomUUID(), assetId = crypto.randomUUID();
  const state = { schema: 1, reservedBytes: 0, uploads: { [uploadId]: { uploadId, companyId, userId, assetId } }, idempotency: {}, prepareOutbox: {} };
  assert.equal(validateImportUploadState(state, companyId), state);
  for (const disk of [null, {}, { schema: 1, phase: "created", parts: {} }, "synthetic-invalid"]) {
    const modified = structuredClone(state); modified.uploads[uploadId].disk = disk;
    assert.throws(() => validateImportUploadState(modified, companyId), { code: "calendar_import_state_invalid" });
  }
});

test("grant URLs are redacted for host logging and never included in error responses", () => {
  const id = crypto.randomUUID(); const input = `https://ia4tube-api.onrender.com${PREFIX}/bytes/${id}?secret=x`;
  assert.equal(redactImportTransferUrl(input), `https://ia4tube-api.onrender.com${PREFIX}/bytes/[redacted]`);
  assert.equal(redactImportTransferUrl("/ordinary/path"), "/ordinary/path");
});
