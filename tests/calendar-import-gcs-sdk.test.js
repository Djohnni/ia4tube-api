"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const { Readable, Writable, PassThrough } = require("node:stream");
const { createGcsSdkTransport, isGcsSdkTransport } = require("../src/social/calendar/imports/gcs-sdk-transport");
const bytes = Buffer.from("SYNTHETIC_GCS_TRANSPORT_TEST_ONLY");
const objectKey = "a".repeat(64) + "/parts/01", sourceKey = "a".repeat(64) + "/source";
const bucketName = "ia4tube-synthetic-private", objectGeneration = "17931400000000003";
const hash = (value, algorithm = "sha256", encoding = "hex") => crypto.createHash(algorithm).update(value).digest(encoding);
function metadata(key = objectKey, overrides = {}) {
  return { bucket: bucketName, name: "ready-video/" + key, size: String(bytes.length), generation: objectGeneration,
    md5Hash: hash(bytes, "md5", "base64"), crc32c: "AAAAAA==", contentType: "application/octet-stream", metadata: { sha256: hash(bytes) }, ...overrides };
}
function fixture({ request, readStream, writeStream, bucketMetadata, timeout = 1000 } = {}) {
  const calls = [], storageOptions = [];
  class FakeStorage {
    constructor(options) { storageOptions.push(options); }
    bucket(name) {
      assert.equal(name, bucketName);
      return {
        async request(options) { calls.push({ type: "bucket", options }); if (bucketMetadata) return [bucketMetadata]; return [{ name: bucketName,
          iamConfiguration: { uniformBucketLevelAccess: { enabled: true }, publicAccessPrevention: "enforced" }, storageClass: "STANDARD", location: "SOUTHAMERICA-EAST1" }]; },
        file(name, fileOptions) {
          return {
            async request(options) {
              calls.push({ type: "file", name, fileOptions, generation: this.generation, options });
              if (request) return request({ name, fileOptions, options, calls });
              return [metadata(name.replace(/^ready-video\//, ""))];
            },
            createReadStream(options) { calls.push({ type: "read", name, fileOptions, generation: this.generation, options }); return readStream ? readStream(options) : Readable.from([bytes]); },
            createWriteStream(options) { calls.push({ type: "write", name, fileOptions, options }); return writeStream ? writeStream(options) : new Writable({ write(chunk, encoding, callback) { callback(); } }); }
          };
        }
      };
    }
  }
  const transport = createGcsSdkTransport({ bucketName, sdkForTests: { Storage: FakeStorage }, allowTestSdk: true,
    allowApplicationDefaultCredentials: true, metadataTimeoutMs: timeout, transferTimeoutMs: 5000 });
  return { transport, calls, storageOptions };
}

test("official SDK signs exact bucket, object, MD5, length, type and generation-zero without network", async () => {
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const now = Date.now();
  const transport = createGcsSdkTransport({ bucketName, projectId: "ia4tube-synthetic", clock: () => now,
    credentials: { type: "service_account", client_email: "synthetic@ia4tube-synthetic.iam.gserviceaccount.com", private_key: privateKey } });
  try {
    assert.equal(isGcsSdkTransport(transport), true);
    assert.equal(isGcsSdkTransport({ ...transport }), false);
    const grant = await transport.signPartWrite({ objectKey, sizeBytes: bytes.length, md5Base64: hash(bytes, "md5", "base64"), expiresAt: now + 60000 });
    const url = new URL(grant.url);
    assert.equal(url.origin, "https://storage.googleapis.com");
    assert.equal(url.pathname, `/${bucketName}/ready-video/${objectKey}`);
    assert.equal(url.searchParams.get("X-Goog-Expires"), "60");
    assert.equal(grant.method, "PUT");
    assert.deepEqual(grant.headers, { "content-length": String(bytes.length), "content-md5": hash(bytes, "md5", "base64"), "content-type": "application/octet-stream", "x-goog-if-generation-match": "0" });
    assert.equal(url.searchParams.get("X-Goog-SignedHeaders"), "content-length;content-md5;content-type;host;x-goog-if-generation-match");
    const get = await transport.signObjectRead({ objectKey: sourceKey, generation: objectGeneration, sizeBytes: bytes.length,
      contentType: "video/mp4", expiresAt: now + 60000 });
    const readUrl = new URL(get.url);
    assert.equal(readUrl.searchParams.get("generation"), objectGeneration);
    assert.equal(readUrl.searchParams.get("X-Goog-SignedHeaders"), "host");
    assert.deepEqual(get.headers, {});
    assert.equal(get.method, "GET");
    for (const badKey of ["../secret", objectKey + "/../secret", "a".repeat(64) + "/%2e%2e/secret", "ready-video/" + objectKey, "https://attacker.invalid/x", "a".repeat(64) + "//parts/1"]) {
      await assert.rejects(transport.signPartWrite({ objectKey: badKey, sizeBytes: bytes.length, md5Base64: hash(bytes, "md5", "base64"), expiresAt: now + 60000 }), /object_key_invalid/);
    }
    await assert.rejects(transport.signPartWrite({ objectKey, sizeBytes: bytes.length, md5Base64: "not-md5", expiresAt: now + 60000 }), /checksum_invalid/);
    await assert.rejects(transport.signPartWrite({ objectKey, sizeBytes: 5 * 1024 * 1024 + 1, md5Base64: hash(bytes, "md5", "base64"), expiresAt: now + 60000 }), /part_size_invalid/);
    await assert.rejects(transport.signObjectRead({ objectKey, generation: objectGeneration, sizeBytes: bytes.length, contentType: "video/mp4", expiresAt: now + 900001 }), /expiry_invalid/);
  } finally { transport.close(); }
});

test("explicit credentials, fixed prefix and canonical endpoint are required", () => {
  assert.throws(() => createGcsSdkTransport({ bucketName }), /credentials_required/);
  assert.throws(() => createGcsSdkTransport({ bucketName, prefix: "../", allowApplicationDefaultCredentials: true }), /gcs_transport_invalid/);
  assert.throws(() => createGcsSdkTransport({ bucketName: "bucket.example.com", allowApplicationDefaultCredentials: true }), /gcs_transport_invalid/);
  assert.throws(() => createGcsSdkTransport({ bucketName, keyFilename: "relative-secret.json" }), /credentials_invalid/);
  const f = fixture();
  assert.equal(isGcsSdkTransport(f.transport), false);
  assert.equal(isGcsSdkTransport(f.transport, { allowTestSdk: true }), true);
  assert.equal(f.storageOptions[0].apiEndpoint, "https://storage.googleapis.com");
  assert.equal(f.storageOptions[0].retryOptions.autoRetry, false);
  assert.equal(f.storageOptions[0].retryOptions.maxRetries, 0);
  f.transport.close();
});

test("real SDK request decoration accepts metadata and preserves generations and compose payload offline", async () => {
  const { Storage } = require("@google-cloud/storage"), requests = [];
  const path = require("node:path");
  const { util: sdkUtil } = require(path.join(path.dirname(require.resolve("@google-cloud/storage")), "nodejs-common", "util.js"));
  let composed = false;
  class OfflineStorage extends Storage {
    request(options, callback) {
      try { sdkUtil.decorateRequest(options, "ia4tube-synthetic"); }
      catch (error) { return callback(error); }
      requests.push(options);
      if (options.method === "DELETE") return callback(null, {});
      if (!options.uri.includes("/o/")) return callback(null, { name: bucketName,
        iamConfiguration: { uniformBucketLevelAccess: { enabled: true }, publicAccessPrevention: "enforced" } });
      const name = decodeURIComponent(options.uri.split("/o/")[1].replace(/\/compose$/, ""));
      if (options.method === "POST") composed = true;
      if (name.endsWith("/source") && !composed) return callback(Object.assign(new Error("missing"), { code: 404 }));
      callback(null, metadata(name.replace(/^ready-video\//, ""), { contentType: "video/mp4" }));
    }
  }
  const transport = createGcsSdkTransport({ bucketName, allowApplicationDefaultCredentials: true,
    sdkForTests: { Storage: OfflineStorage }, allowTestSdk: true });
  assert.equal((await transport.headObject({ objectKey, generation: objectGeneration })).generation, objectGeneration);
  assert.equal(requests.at(-1).qs.generation, objectGeneration);
  assert.ok(requests.at(-1).uri.endsWith("/o/" + encodeURIComponent("ready-video/" + objectKey)));
  assert.equal((await transport.verifyBucket()).private, true);
  assert.equal((await transport.composeObject({ objectKey: sourceKey, sources: [{ objectKey, generation: objectGeneration }], metadata: { sha256: hash(bytes) } })).exists, true);
  const compose = requests.find(request => request.method === "POST");
  assert.ok(compose.uri.endsWith("/o/" + encodeURIComponent("ready-video/" + sourceKey) + "/compose"));
  assert.equal(compose.qs.ifGenerationMatch, 0);
  assert.equal(compose.json.sourceObjects[0].generation, objectGeneration);
  await transport.deleteObject({ objectKey, generation: objectGeneration });
  assert.deepEqual(requests.at(-1).qs, { generation: objectGeneration, ifGenerationMatch: objectGeneration });
  transport.close();
});

test("metadata retains exact large generation and verifies bucket/name/size/checksums", async () => {
  const f = fixture();
  const result = await f.transport.headObject({ objectKey, generation: objectGeneration });
  assert.equal(result.generation, objectGeneration);
  assert.equal(result.sizeBytes, bytes.length);
  assert.equal(result.md5Base64, hash(bytes, "md5", "base64"));
  assert.equal(Object.isFrozen(result.metadata), true);
  assert.equal(f.calls[0].generation, objectGeneration);
  assert.equal(f.calls[0].options.qs.generation, objectGeneration);
  f.transport.close();
  const wrong = fixture({ request: async () => [metadata(objectKey, { bucket: "someone-else" })] });
  await assert.rejects(wrong.transport.headObject({ objectKey }), /metadata_invalid/);
  wrong.transport.close();
});

test("real SDK createReadStream emits exact uint64 generation for whole and range requests", async () => {
  const { File, CRC32C } = require("@google-cloud/storage"), requests = [];
  const originalRequestStream = File.prototype.requestStream;
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const transport = createGcsSdkTransport({ bucketName, projectId: "ia4tube-synthetic",
    credentials: { type: "service_account", client_email: "synthetic@ia4tube-synthetic.iam.gserviceaccount.com", private_key: privateKey } });
  File.prototype.requestStream = function(options) {
    assert.equal(options.qs.generation, objectGeneration);
    assert.equal(typeof options.qs.generation, "string");
    assert.equal(this.generation, objectGeneration);
    requests.push(options);
    const range = options.headers.Range?.match(/^bytes=(\d+)-(\d+)$/);
    const body = range ? bytes.subarray(Number(range[1]), Number(range[2]) + 1) : bytes;
    const checksum = new CRC32C(); checksum.update(body);
    const response = Readable.from([body]);
    response.statusCode = range ? 206 : 200;
    response.request = {};
    response.toJSON = () => ({ headers: { "x-goog-hash": "crc32c=" + checksum.toString(), "x-goog-stored-content-encoding": "identity" } });
    const request = new PassThrough();
    queueMicrotask(() => { request.emit("response", response); request.end(); });
    return request;
  };
  try {
    const whole = [];
    await transport.streamObject({ objectKey, generation: objectGeneration, sizeBytes: bytes.length, consume(chunk) { whole.push(chunk); } });
    assert.deepEqual(Buffer.concat(whole), bytes);
    const partial = [];
    await transport.streamObject({ objectKey, generation: objectGeneration, sizeBytes: bytes.length, range: { start: 1, end: 4 }, consume(chunk) { partial.push(chunk); } });
    assert.deepEqual(Buffer.concat(partial), bytes.subarray(1, 5));
    assert.equal(requests.length, 2); assert.equal(requests[1].headers.Range, "bytes=1-4");
  } finally { File.prototype.requestStream = originalRequestStream; transport.close(); }
});

test("404 is missing, errors expose no provider response, and timeouts are bounded", async () => {
  const missing = fixture({ request: async () => { throw Object.assign(new Error("private URL secret"), { code: 404 }); } });
  assert.deepEqual(await missing.transport.headObject({ objectKey }), { exists: false });
  missing.transport.close();
  const denied = fixture({ request: async () => { throw Object.assign(new Error("Bearer private URL secret"), { code: 403 }); } });
  await assert.rejects(denied.transport.headObject({ objectKey }), e => e.message === "gcs_transport_unavailable" && e.httpStatus === 403 && !JSON.stringify(e).includes("secret"));
  denied.transport.close();
  const timeout = fixture({ request: async () => new Promise(() => {}), timeout: 100 });
  const keepAlive = setTimeout(() => {}, 300);
  await assert.rejects(timeout.transport.headObject({ objectKey }), /gcs_transport_timeout/);
  clearTimeout(keepAlive); timeout.transport.close();
});

test("compose uses immutable destination and exact source generations, never deletes sources", async () => {
  let composed = false;
  const f = fixture({ request: async ({ name, options }) => {
    if (options.method === "GET" && !composed) throw Object.assign(new Error("missing"), { code: 404 });
    composed = true; return [metadata(name.replace(/^ready-video\//, ""), { contentType: "video/mp4", md5Hash: undefined })];
  } });
  const result = await f.transport.composeObject({ objectKey: sourceKey, sources: [{ objectKey, generation: objectGeneration }], metadata: { sha256: hash(bytes) } });
  assert.equal(result.md5Base64, null);
  const request = f.calls.find(call => call.options.method === "POST").options;
  assert.equal(request.method, "POST"); assert.equal(request.uri, "/compose");
  assert.deepEqual(request.qs, { ifGenerationMatch: 0 });
  assert.deepEqual(request.json.sourceObjects, [{ name: "ready-video/" + objectKey, generation: objectGeneration }]);
  assert.equal(request.json.destination.metadata.sha256, hash(bytes));
  assert.equal("deleteSourceObjects" in request.qs, false);
  assert.equal((await f.transport.composeObject({ objectKey: sourceKey, sources: [{ objectKey, generation: objectGeneration }], metadata: { sha256: hash(bytes) } })).exists, true);
  assert.equal(f.calls.filter(call => call.options.method === "POST").length, 1);
  await assert.rejects(f.transport.composeObject({ objectKey: sourceKey, sources: [{ objectKey, generation: objectGeneration }], metadata: { sha256: "b".repeat(64) } }), /precondition_failed/);
  await assert.rejects(f.transport.composeObject({ objectKey: sourceKey, sources: [{ objectKey: sourceKey, generation: objectGeneration }] }), /gcs_transport_invalid/);
  f.transport.close();
});

test("deletion is bound to exact generation and absence is idempotent", async () => {
  const f = fixture({ request: async ({ options }) => {
    if (options.method === "DELETE") throw Object.assign(new Error("missing"), { code: 404 });
    return [metadata()];
  } });
  assert.equal(await f.transport.deleteObject({ objectKey, generation: objectGeneration }), true);
  assert.equal(f.calls[0].generation, objectGeneration);
  assert.deepEqual(f.calls.find(call => call.options.method === "DELETE").options.qs, { generation: objectGeneration, ifGenerationMatch: objectGeneration });
  await assert.rejects(f.transport.deleteObject({ objectKey }), /gcs_transport_invalid/);
  f.transport.close();
});

test("streaming preserves backpressure, exact bytes, generation and 64KiB maximum chunks", async () => {
  const large = Buffer.alloc(180000, 7), f = fixture({ readStream: () => Readable.from([large]) });
  const received = []; let consuming = false;
  const result = await f.transport.streamObject({ objectKey: sourceKey, generation: objectGeneration, sizeBytes: large.length,
    async consume(chunk) { assert.equal(consuming, false); consuming = true; assert.ok(chunk.length <= 65536); await new Promise(resolve => setImmediate(resolve)); received.push(chunk); consuming = false; } });
  assert.deepEqual(Buffer.concat(received), large); assert.equal(result.sizeBytes, large.length);
  assert.equal(f.calls[0].generation, objectGeneration); assert.equal(f.calls[0].options.validation, "crc32c");
  f.transport.close();
  const short = fixture({ readStream: () => Readable.from([bytes.subarray(1)]) });
  await assert.rejects(short.transport.streamObject({ objectKey, generation: objectGeneration, sizeBytes: bytes.length, consume() {} }), /size_mismatch/);
  short.transport.close();
});

test("range is bounded and validates delivered length; cancellation stops a live stream", async () => {
  const range = fixture({ readStream: options => Readable.from([bytes.subarray(options.start, options.end + 1)]) });
  const result = await range.transport.streamObject({ objectKey, generation: objectGeneration, sizeBytes: bytes.length, range: { start: 1, end: 4 }, consume() {} });
  assert.equal(result.sizeBytes, 4); assert.equal(range.calls[0].options.validation, false);
  await assert.rejects(range.transport.streamObject({ objectKey, generation: objectGeneration, sizeBytes: bytes.length, range: { start: 0, end: bytes.length }, consume() {} }), /gcs_transport_invalid/);
  range.transport.close();
  const controller = new AbortController(), pending = fixture({ readStream: () => new Readable({ read() {} }) });
  const read = pending.transport.streamObject({ objectKey, generation: objectGeneration, sizeBytes: bytes.length, signal: controller.signal, consume() {} });
  controller.abort(); await assert.rejects(read, /aborted/); pending.transport.close();
});

test("result upload checks exact source bytes and creation precondition; retries reconcile metadata", async () => {
  let uploaded = false; const received = [];
  const f = fixture({ request: async ({ name }) => { if (!uploaded) throw Object.assign(new Error("missing"), { code: 404 }); return [metadata(name.replace(/^ready-video\//, ""), { contentType: "video/mp4" })]; },
    writeStream: () => new Writable({ write(chunk, encoding, callback) { received.push(Buffer.from(chunk)); callback(); }, final(callback) { uploaded = true; callback(); } }) });
  const args = { objectKey: sourceKey, bodyStream: Readable.from([bytes]), sizeBytes: bytes.length, contentType: "video/mp4", metadata: { sha256: hash(bytes) } };
  assert.equal((await f.transport.uploadObject(args)).exists, true);
  assert.deepEqual(Buffer.concat(received), bytes);
  assert.deepEqual(f.calls.find(call => call.type === "write").options.preconditionOpts, { ifGenerationMatch: 0 });
  assert.equal(f.calls.find(call => call.type === "write").options.validation, false);
  assert.equal((await f.transport.uploadObject({ ...args, bodyStream: Readable.from([bytes]) })).exists, true);
  assert.equal(f.calls.filter(call => call.type === "write").length, 1);
  f.transport.close();
  const bad = fixture({ request: async () => { throw Object.assign(new Error("missing"), { code: 404 }); } });
  await assert.rejects(bad.transport.uploadObject({ ...args, bodyStream: Readable.from([bytes.subarray(1)]) }), /size_mismatch/);
  bad.transport.close();
});

test("bucket readiness requires uniform private access and no requester-pays surprises", async () => {
  const f = fixture();
  assert.deepEqual(await f.transport.verifyBucket(), { private: true, bucketName, location: "SOUTHAMERICA-EAST1", storageClass: "STANDARD" });
  f.transport.close();
  await assert.rejects(f.transport.headObject({ objectKey }), /closed/);
  for (const bucketMetadata of [
    { name: bucketName, iamConfiguration: { uniformBucketLevelAccess: { enabled: false }, publicAccessPrevention: "enforced" } },
    { name: bucketName, iamConfiguration: { uniformBucketLevelAccess: { enabled: true }, publicAccessPrevention: "inherited" } },
    { name: bucketName, iamConfiguration: { uniformBucketLevelAccess: { enabled: true }, publicAccessPrevention: "enforced" }, billing: { requesterPays: true } }
  ]) {
    const invalid = fixture({ bucketMetadata });
    await assert.rejects(invalid.transport.verifyBucket(), /bucket_not_private/); invalid.transport.close();
  }
});

test("a stalled consumer cannot hold the transfer past its deadline", async () => {
  const f = fixture(), keepAlive = setTimeout(() => {}, 300);
  await assert.rejects(f.transport.streamObject({ objectKey, generation: objectGeneration, sizeBytes: bytes.length,
    timeoutMs: 100, consume: async () => new Promise(() => {}) }), /timeout/);
  clearTimeout(keepAlive); f.transport.close();
});

test("a result checksum mismatch leaves exact-generation cleanup to the owner", async () => {
  let uploaded = false;
  const f = fixture({
    request: async ({ name }) => {
      if (!uploaded) throw Object.assign(new Error("missing"), { code: 404 });
      return [metadata(name.replace(/^ready-video\//, ""), { contentType: "video/mp4", md5Hash: hash(Buffer.from("other bytes"), "md5", "base64") })];
    },
    writeStream: () => new Writable({ write(chunk, encoding, callback) { callback(); }, final(callback) { uploaded = true; callback(); } })
  });
  await assert.rejects(f.transport.uploadObject({ objectKey: sourceKey, bodyStream: Readable.from([bytes]), sizeBytes: bytes.length,
    contentType: "video/mp4", metadata: { sha256: hash(bytes) } }), /checksum_mismatch/);
  assert.equal(f.calls.find(call => call.type === "write").options.validation, false);
  assert.equal(f.calls.some(call => call.options.method === "DELETE"), false);
  f.transport.close();
});

function cancellationFixture({ present = false, loseAcknowledgment = false, failWrite = false } = {}) {
  let current = present ? metadata() : null;
  const f = fixture({ request: async () => {
    if (!current) throw Object.assign(new Error("missing"), { code: 404 });
    return [current];
  }, writeStream: options => new Writable({
    write(chunk, encoding, callback) { assert.deepEqual(chunk, Buffer.from([0])); callback(); },
    final(callback) {
      if (failWrite) return callback(new Error("network secret"));
      const expected = options.preconditionOpts.ifGenerationMatch;
      if (expected === 0 ? current !== null : current?.generation !== expected) return callback(Object.assign(new Error("condition"), { code: 412 }));
      current = metadata(objectKey, { size: "1", generation: String(BigInt(objectGeneration) + 1n), md5Hash: hash(Buffer.from([0]), "md5", "base64"), metadata: options.metadata.metadata });
      callback(loseAcknowledgment ? new Error("network secret") : undefined);
    }
  }) });
  return { ...f, completeDelayedPut() {
    // The storage service evaluates generation-zero at commit, so a PUT that
    // started before expiration cannot overwrite the occupied cancellation key.
    if (current) throw Object.assign(new Error("precondition_failed"), { code: 412 });
    current = metadata();
  } };
}

test("cancel tombstones fence a delayed PUT, deduplicate and require the original upload owner", async () => {
  const f = cancellationFixture(), uploadId = crypto.randomUUID();
  const result = await f.transport.cancelPart({ objectKey, uploadId });
  assert.equal(result.sizeBytes, 1); assert.equal(result.metadata.cancelledUpload, uploadId);
  assert.equal(f.calls.find(call => call.type === "write").options.preconditionOpts.ifGenerationMatch, 0);
  assert.throws(() => f.completeDelayedPut(), error => error.code === 412);
  assert.equal((await f.transport.cancelPart({ objectKey, uploadId })).generation, result.generation);
  assert.equal(f.calls.filter(call => call.type === "write").length, 1);
  await assert.rejects(f.transport.deleteObject({ objectKey, generation: result.generation }), /tombstone_protected/);
  await assert.rejects(f.transport.cancelPart({ objectKey, uploadId: crypto.randomUUID() }), /ownership_conflict/);
  for (const invalid of [sourceKey, "a".repeat(64) + "/result.mp4", "a".repeat(64) + "/parts/21"])
    await assert.rejects(f.transport.cancelPart({ objectKey: invalid, uploadId }), /object_key_invalid/);
  assert.equal(f.calls.some(call => call.options.method === "DELETE"), false); f.transport.close();
});

test("cancel replaces only an exact prior generation and reconciles a lost acknowledgment without another write", async () => {
  const f = cancellationFixture({ present: true, loseAcknowledgment: true }), uploadId = crypto.randomUUID();
  await assert.rejects(f.transport.cancelPart({ objectKey, uploadId }), /precondition_failed/);
  await assert.rejects(f.transport.cancelPart({ objectKey, uploadId, expectedGeneration: "1" }), /precondition_failed/);
  const result = await f.transport.cancelPart({ objectKey, uploadId, expectedGeneration: objectGeneration });
  assert.equal(result.metadata.cancelledUpload, uploadId);
  assert.equal(f.calls.find(call => call.type === "write").options.preconditionOpts.ifGenerationMatch, objectGeneration);
  assert.equal(f.calls.filter(call => call.type === "write").length, 1); f.transport.close();
  const failed = cancellationFixture({ failWrite: true });
  await assert.rejects(failed.transport.cancelPart({ objectKey, uploadId }), error => error.message === "gcs_transport_unavailable");
  assert.equal(failed.calls.filter(call => call.type === "write").length, 1);
  assert.deepEqual(await failed.transport.headObject({ objectKey }), { exists: false }); failed.transport.close();
});
