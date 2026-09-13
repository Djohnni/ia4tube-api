"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto"), { Readable } = require("node:stream");
const { createCalendarImportUploadService } = require("../src/social/calendar/imports/upload-service");
const { createMemoryImportUploadStore } = require("../src/social/calendar/imports/memory-adapters");
const { createR2PrivateUploadProvider } = require("../src/social/calendar/imports/r2-provider");
const { createR2SdkTransport } = require("../src/social/calendar/imports/r2-sdk-transport");
const { createR2BoundedInspectionWorker } = require("../src/social/calendar/imports/r2-inspection-worker");
const hash = (bytes, algorithm = "sha256", encoding = "hex") => crypto.createHash(algorithm).update(bytes).digest(encoding);
const bytes = Buffer.from("SYNTHETIC_R2_PROTOCOL_TEST_NOT_REAL_IMAGE");
const context = () => ({ authenticated: true, companyId: crypto.randomUUID(), userId: crypto.randomUUID() });
function fixture({ wrapTransport, inspect, wrapInspector } = {}) {
  const store = createMemoryImportUploadStore(), ctx = context();
  let now = 1789218000000;
  const remote = new Map(), counts = { create: 0, complete: 0, sign: 0, get: 0, inspectionStart: 0, inspectionGet: 0 };
  const base = {
    origin: "https://00000000000000000000000000000000.r2.cloudflarestorage.com",
    capabilities: { sdk: "aws-sdk-v3", oneAttempt: true, privateEndpoint: true },
    async head(key) {
      const entry = remote.get(key);
      return entry?.sealed ? { ContentLength: bytes.length, ETag: entry.etag, Metadata: { "import-asset-id": entry.assetId } } : null;
    },
    async create(key, assetId) { counts.create++; const UploadId = crypto.randomUUID(); remote.set(key, { UploadId, assetId, parts: [], sealed: false }); return { UploadId }; },
    async findUploads(key) { const entry = remote.get(key); return entry && !entry.sealed ? [{ UploadId: entry.UploadId, Key: key }] : []; },
    async listParts(key, id) { const entry = remote.get(key); if (!entry || entry.UploadId !== id || entry.sealed) throw new Error("NoSuchUpload"); return entry.parts; },
    async complete(key, id, parts) {
      const entry = remote.get(key); if (!entry || entry.UploadId !== id || entry.sealed) throw new Error("NoSuchUpload");
      assert.equal(parts[0].ChecksumSHA256, hash(bytes, "sha256", "base64"));
      counts.complete++; entry.sealed = true; entry.etag = '"opaque-multipart-etag-1"';
    },
    async get(key, etag) { counts.get++; const entry = remote.get(key); if (!entry?.sealed || entry.etag !== etag) throw new Error("precondition"); return { Body: Readable.from([bytes]), ETag: etag, ContentLength: bytes.length }; },
    async abort(key, id) { const entry = remote.get(key); if (entry?.sealed) throw new Error("sealed"); if (entry?.UploadId === id) remote.delete(key); },
    async signPart(args) {
      counts.sign++; assert.equal(args.sha256, hash(bytes)); assert.equal(args.md5Base64, hash(bytes, "md5", "base64"));
      return { url: `${base.origin}/private/${args.key}?synthetic=not-a-real-grant`, method: "PUT", sizeBytes: args.sizeBytes,
        headers: { "content-length": String(args.sizeBytes), "content-md5": args.md5Base64, "x-amz-checksum-sha256": hash(bytes, "sha256", "base64") }, expiresAt: args.expiresAt };
    }
  };
  const decoder = { async inspect(args) {
    if (inspect) return inspect(args);
    for await (const _ of args.stream) { /* synthetic decoder contract only */ }
    return { decoded: true, signatureVerified: true, detectedMime: "image/jpeg", width: 1080, height: 1350, frames: 1 };
  } };
  const transport = wrapTransport ? wrapTransport(base) : base;
  const worker = createR2BoundedInspectionWorker({ transport, decoder }), tickets = new Map();
  // Simulated metadata RPC for contract tests, not proof of actual isolation.
  const simulatedInspector = {
    capabilities: { isolated: true, bounded: true, remoteObjectInspection: true },
    async startInspection(request) {
      counts.inspectionStart++;
      if (!tickets.has(request.ticketId)) {
        try { tickets.set(request.ticketId, { ticketId: request.ticketId, state: "ready", result: await worker.execute(request) }); }
        catch (_) { tickets.set(request.ticketId, { ticketId: request.ticketId, state: "failed" }); }
      }
      return tickets.get(request.ticketId);
    },
    async getInspection({ ticketId }) { counts.inspectionGet++; return tickets.get(ticketId) || { ticketId, state: "pending" }; }
  };
  const inspector = wrapInspector ? wrapInspector(simulatedInspector) : simulatedInspector;
  const provider = createR2PrivateUploadProvider({ store, transport, inspector, clock: () => now, enabled: true, allowVolatileForTests: true });
  const service = createCalendarImportUploadService({ store, provider, clock: () => now, enabled: true, allowVolatileForTests: true });
  function input() { return { idempotencyKey: crypto.randomUUID(), kind: "image", mimeType: "image/jpeg", sizeBytes: bytes.length, sha256: hash(bytes) }; }
  async function uploadParts(upload) {
    const grant = await service.authorizePart(ctx, { uploadId: upload.uploadId, partNumber: 1, sha256: hash(bytes), md5Base64: hash(bytes, "md5", "base64") });
    const row = store.snapshotForTest(ctx.companyId).uploads[upload.uploadId];
    const entry = remote.get(row.objectKey);
    entry.parts = [{ PartNumber: 1, Size: bytes.length, ChecksumSHA256: hash(bytes, "sha256", "base64"), ETag: '"part-etag"' }];
    return grant;
  }
  return { store, ctx, service, provider, remote, counts, base, inspector, input, uploadParts, advance(ms) { now += ms; } };
}

test("real official SDK presigner binds exact endpoint, part, length, MD5 and SHA256 without network", async () => {
  const transport = createR2SdkTransport({ sdk: require("@aws-sdk/client-s3"), getSignedUrl: require("@aws-sdk/s3-request-presigner").getSignedUrl,
    credentials: { accessKeyId: "SYNTHETIC_TEST_ONLY", secretAccessKey: "SYNTHETIC_TEST_ONLY_NOT_A_CREDENTIAL" },
    accountId: "00000000000000000000000000000000", bucket: "local-test-private", clock: () => 1789218000000 });
  try {
    const result = await transport.signPart({ key: "a".repeat(64), uploadId: "synthetic-upload-id", partNumber: 2, sizeBytes: bytes.length,
      sha256: hash(bytes), md5Base64: hash(bytes, "md5", "base64"), expiresAt: 1789218060000 });
    const parsed = new URL(result.url);
    assert.equal(parsed.searchParams.get("partNumber"), "2");
    assert.equal(parsed.searchParams.get("X-Amz-Expires"), "60");
    assert.equal(result.headers["content-length"], String(bytes.length));
    assert.equal(result.headers["x-amz-checksum-sha256"], hash(bytes, "sha256", "base64"));
    for (const field of ["content-length", "content-md5", "x-amz-checksum-sha256"]) assert.ok(parsed.searchParams.get("X-Amz-SignedHeaders").split(";").includes(field));
  } finally { transport.close(); }
});

test("provider is disabled without durable store/config/isolated inspector", async () => {
  const f = fixture();
  const disabled = createR2PrivateUploadProvider({ store: f.store, transport: f.base, inspector: f.inspector, enabled: true });
  assert.equal(disabled.capabilities.privateObjects, false);
  assert.equal(disabled.getCapabilities().available, false);
});

test("successful provider protocol persists one object and one outbox, digest not ETag", async () => {
  const f = fixture(), start = await f.service.start(f.ctx, f.input());
  const grant = await f.uploadParts(start);
  const resolved = await f.service.resolvePart(f.ctx, { uploadId: start.uploadId, partNumber: 1, authorizationId: grant.authorizationId });
  assert.equal(resolved.method, "PUT");
  const completed = await f.service.complete(f.ctx, { uploadId: start.uploadId });
  assert.equal(completed.state, "uploaded"); assert.equal(completed.verification.sha256, hash(bytes));
  await f.service.complete(f.ctx, { uploadId: start.uploadId });
  assert.equal(f.counts.complete, 1); assert.equal(f.counts.create, 1);
  const state = f.store.snapshotForTest(f.ctx.companyId);
  assert.equal(Object.keys(state.prepareOutbox).length, 1);
  assert.equal(JSON.stringify(state).includes("synthetic=not-a-real-grant"), false);
});

test("lost Create response reconciles exact key and never issues a second Create", async () => {
  let first = true;
  const f = fixture({ wrapTransport: base => ({ ...base, async create(key, id) {
    const reply = await base.create(key, id); if (first) { first = false; throw new Error("secret access key should never escape"); } return reply;
  } }) });
  const input = f.input(); await assert.rejects(f.service.start(f.ctx, input), /import_provider_unavailable/);
  const recovered = await f.service.start(f.ctx, input);
  assert.equal(recovered.state, "uploading"); assert.equal(f.counts.create, 1);
});

test("uncertain Create with no remote match remains pending, never invents success or retries Create", async () => {
  let attempts = 0;
  const f = fixture({ wrapTransport: base => ({ ...base, async create() { attempts++; throw new Error("uncertain transport"); } }) });
  const input = f.input();
  for (let n = 0; n < 3; n++) await assert.rejects(f.service.start(f.ctx, input), /import_provider_unavailable/);
  assert.equal(attempts, 1);
  const id = Object.keys(f.store.snapshotForTest(f.ctx.companyId).uploads)[0];
  await assert.rejects(f.service.cancel(f.ctx, { uploadId: id }), /import_cancellation_pending/);
  assert.equal(f.store.snapshotForTest(f.ctx.companyId).reservedBytes, bytes.length);
});

test("ambiguous completion reconciles HEAD, and post-completion list uses persisted manifest", async () => {
  let first = true;
  const f = fixture({ wrapTransport: base => ({ ...base, async complete(...args) {
    await base.complete(...args); if (first) { first = false; throw new Error("lost success"); }
  } }) });
  const start = await f.service.start(f.ctx, f.input()); await f.uploadParts(start);
  assert.equal((await f.service.complete(f.ctx, { uploadId: start.uploadId })).state, "uploaded");
  assert.equal(f.counts.complete, 1);
  const row = f.store.snapshotForTest(f.ctx.companyId).uploads[start.uploadId];
  assert.equal((await f.provider.listParts({ context: f.ctx, objectKey: row.objectKey, uploadId: row.providerUploadId }))[0].sha256, hash(bytes));
});

test("remote ListParts must expose real SHA256; ETag or client digest cannot substitute", async () => {
  for (const replacement of [undefined, hash(Buffer.from("wrong"), "sha256", "base64")]) {
    const f = fixture(), start = await f.service.start(f.ctx, f.input()); await f.uploadParts(start);
    const row = f.store.snapshotForTest(f.ctx.companyId).uploads[start.uploadId];
    f.remote.get(row.objectKey).parts[0].ChecksumSHA256 = replacement;
    await assert.rejects(f.service.complete(f.ctx, { uploadId: start.uploadId }), /import_verification_pending/);
    assert.equal(f.counts.complete, 0);
  }
});

test("another company/user cannot resolve a grant, and changed part hash conflicts", async () => {
  const f = fixture(), start = await f.service.start(f.ctx, f.input()); const grant = await f.uploadParts(start);
  for (const ctx of [context(), { ...f.ctx, userId: crypto.randomUUID() }]) {
    await assert.rejects(f.service.resolvePart(ctx, { uploadId: start.uploadId, partNumber: 1, authorizationId: grant.authorizationId }), /import_not_found/);
  }
  await assert.rejects(f.service.authorizePart(f.ctx, { uploadId: start.uploadId, partNumber: 1, sha256: "b".repeat(64), md5Base64: hash(bytes, "md5", "base64") }));
  assert.equal(f.counts.sign, 0);
});

test("expired or already completed grants cannot be resolved", async () => {
  const f = fixture(), start = await f.service.start(f.ctx, f.input()); const grant = await f.uploadParts(start);
  f.advance(600001);
  await assert.rejects(f.service.resolvePart(f.ctx, { uploadId: start.uploadId, partNumber: 1, authorizationId: grant.authorizationId }));
  await f.service.complete(f.ctx, { uploadId: start.uploadId });
  await assert.rejects(f.service.resolvePart(f.ctx, { uploadId: start.uploadId, partNumber: 1, authorizationId: grant.authorizationId }), /import_upload_not_writable/);
});

test("inspector must consume entire bounded byte stream; claims cannot fabricate digest", async () => {
  const f = fixture({ inspect: async () => ({ decoded: true, signatureVerified: true, detectedMime: "image/jpeg", width: 1, height: 1, frames: 1, sha256: hash(bytes) }) });
  const start = await f.service.start(f.ctx, f.input()); await f.uploadParts(start);
  await assert.rejects(f.service.complete(f.ctx, { uploadId: start.uploadId }), /import_media_verification_failed/);
  assert.equal(Object.keys(f.store.snapshotForTest(f.ctx.companyId).prepareOutbox).length, 0);
});

test("object overwrite before complete is rejected without writing over it", async () => {
  const f = fixture(), start = await f.service.start(f.ctx, f.input()); await f.uploadParts(start);
  const row = f.store.snapshotForTest(f.ctx.companyId).uploads[start.uploadId];
  f.remote.get(row.objectKey).sealed = true; f.remote.get(row.objectKey).etag = '"other-object"';
  await assert.rejects(f.service.complete(f.ctx, { uploadId: start.uploadId }));
  assert.equal(f.counts.complete, 0);
});

test("abort confirms absence before releasing reserved quota", async () => {
  const f = fixture(), start = await f.service.start(f.ctx, f.input()); await f.uploadParts(start);
  assert.equal((await f.service.cancel(f.ctx, { uploadId: start.uploadId })).state, "cancelled");
  assert.equal(f.store.snapshotForTest(f.ctx.companyId).reservedBytes, 0);
  assert.equal(f.remote.size, 0);
});

test("lost inspection dispatch response polls the persisted ticket, no repeated paid job", async () => {
  let first = true;
  const f = fixture({ wrapInspector: base => ({ ...base, async startInspection(request) {
    const result = await base.startInspection(request);
    if (first) { first = false; throw new Error("lost dispatcher response"); } return result;
  } }) });
  const start = await f.service.start(f.ctx, f.input()); await f.uploadParts(start);
  await assert.rejects(f.service.complete(f.ctx, { uploadId: start.uploadId }), /import_verification_pending/);
  assert.equal((await f.service.complete(f.ctx, { uploadId: start.uploadId })).state, "uploaded");
  assert.equal(f.counts.inspectionStart, 1); assert.equal(f.counts.inspectionGet, 1); assert.equal(f.counts.get, 1);
});

test("unknown inspection ticket stays verifying across retries without re-dispatch", async () => {
  let calls = 0;
  const f = fixture({ wrapInspector: base => ({ ...base, async startInspection() { calls++; throw new Error("unknown submission"); } }) });
  const start = await f.service.start(f.ctx, f.input()); await f.uploadParts(start);
  for (let index = 0; index < 3; index++) await assert.rejects(f.service.complete(f.ctx, { uploadId: start.uploadId }), /import_verification_pending/);
  assert.equal(calls, 1); assert.equal(f.counts.get, 0);
  assert.equal((await f.service.status(f.ctx, { uploadId: start.uploadId })).state, "verifying");
});
