"use strict";

// Test-process-only interception beneath the official File/Bucket API. The
// transport remains a genuine production-branded instance; no production
// factory or WeakSet is weakened to admit a fake. Unknown buckets fail closed.
const crypto = require("node:crypto");
const path = require("node:path");
const { Readable, Writable } = require("node:stream");
const { Storage, File, CRC32C } = require("@google-cloud/storage");
const { util: sdkUtil } = require(path.join(path.dirname(require.resolve("@google-cloud/storage")), "nodejs-common", "util.js"));
const { createGcsSdkTransport } = require("../../src/social/calendar/imports/gcs-sdk-transport");
const fixtures = new Map(), prefix = "ready-video/";
const original = { request: Storage.prototype.request, read: File.prototype.createReadStream, write: File.prototype.createWriteStream };
const privateKey = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
const md5 = bytes => crypto.createHash("md5").update(bytes).digest("base64");
function fail(code = 503) { throw Object.assign(new Error("offline_gcs_failure"), { code }); }
function relative(name) { if (!name.startsWith(prefix)) fail(); return name.slice(prefix.length); }
function fixtureFor(bucket) { const fixture = fixtures.get(bucket); if (!fixture) fail(); return fixture; }
function metadata(fixture, objectKey, object) {
  const crc = new CRC32C(); crc.update(object.bytes);
  return { bucket: fixture.bucketName, name: prefix + objectKey, size: String(object.bytes.length), generation: object.generation,
    contentType: object.contentType, metadata: structuredClone(object.metadata), crc32c: crc.toString(),
    ...(object.composite ? {} : { md5Hash: md5(object.bytes) }) };
}
function present(fixture, objectKey, generation) {
  const value = fixture.objects.get(objectKey);
  if (!value || generation !== undefined && String(generation) !== value.generation) fail(404);
  return value;
}
function condition(fixture, objectKey, expected) {
  const current = fixture.objects.get(objectKey);
  if (expected === undefined || expected === null) fail();
  if (String(expected) === "0" ? Boolean(current) : current?.generation !== String(expected)) fail(412);
}
function insert(fixture, objectKey, bytes, options = {}) {
  const value = { bytes: Buffer.from(bytes), generation: options.generation || String(++fixture.nextGeneration),
    contentType: options.contentType || "application/octet-stream", metadata: structuredClone(options.metadata || {}), composite: options.composite === true };
  fixture.objects.set(objectKey, value); return metadata(fixture, objectKey, value);
}
async function notify(fixture, phase, event) {
  if (phase === "before") fixture.calls.push(structuredClone(event));
  const faultIndex = fixture.faults.findIndex(fault => fault.operation === event.operation && fault.phase === phase);
  if (faultIndex !== -1) { const [fault] = fixture.faults.splice(faultIndex, 1); fail(fault.code); }
  if (typeof fixture.hooks[phase] === "function") await fixture.hooks[phase](event, fixture);
}
function interceptedRequest(options, callback) {
  // All SDK metadata calls terminate here, before authentication or network IO.
  Promise.resolve().then(async () => {
    // Exercise the same SDK serializer that runs before authenticated HTTP.
    // Intercepting before this step would hide mutation/serialization failures.
    sdkUtil.decorateRequest(options, "ia4tube-synthetic");
    const uri = String(options.uri).replace(/^https:\/\/storage\.googleapis\.com\/storage\/v1\//, "").replace(/^\//, "");
    const matched = /^b\/([a-z0-9-]+)(?:\/o\/(.+))?$/.exec(uri);
    if (!matched) fail();
    const fixture = fixtureFor(matched[1]);
    if (!matched[2]) {
      const event = { operation: "bucket", method: options.method }; await notify(fixture, "before", event);
      const value = { name: fixture.bucketName, location: "SOUTHAMERICA-EAST1", storageClass: "STANDARD",
        iamConfiguration: { uniformBucketLevelAccess: { enabled: true }, publicAccessPrevention: "enforced" }, billing: { requesterPays: false } };
      await notify(fixture, "after", event); return value;
    }
    const compose = options.method === "POST" && matched[2].endsWith("/compose");
    const objectKey = relative(decodeURIComponent(compose ? matched[2].slice(0, -8) : matched[2]));
    const event = { operation: compose ? "compose" : options.method === "DELETE" ? "delete" : "head", objectKey,
      ...(options.qs?.generation !== undefined ? { generation: String(options.qs.generation) } : {}),
      ...(options.qs?.ifGenerationMatch !== undefined ? { ifGenerationMatch: options.qs.ifGenerationMatch } : {}) };
    await notify(fixture, "before", event); let result;
    if (compose) {
      condition(fixture, objectKey, options.qs?.ifGenerationMatch);
      const sources = options.json.sourceObjects.map(source => present(fixture, relative(source.name), source.generation));
      result = insert(fixture, objectKey, Buffer.concat(sources.map(source => source.bytes)), {
        contentType: options.json.destination.contentType, metadata: options.json.destination.metadata, composite: true });
    } else if (options.method === "GET") result = metadata(fixture, objectKey, present(fixture, objectKey, options.qs?.generation));
    else if (options.method === "DELETE") {
      present(fixture, objectKey, options.qs?.generation); condition(fixture, objectKey, options.qs?.ifGenerationMatch);
      fixture.objects.delete(objectKey); result = {};
    } else fail();
    await notify(fixture, "after", event); return result;
  }).then(result => callback(null, result, {}), error => callback(error));
}
function interceptedRead(options = {}) {
  const fixture = fixtureFor(this.bucket.name), objectKey = relative(this.name), generation = this.generation;
  return Readable.from((async function* () {
    const event = { operation: "stream", objectKey, generation: String(generation),
      ...(options.start !== undefined ? { start: options.start, end: options.end } : {}) };
    await notify(fixture, "before", event);
    const object = present(fixture, objectKey, generation), bytes = Buffer.from(object.bytes);
    const start = options.start ?? 0, end = options.end ?? bytes.length - 1;
    for (let offset = start; offset <= end; offset += 65536) yield bytes.subarray(offset, Math.min(offset + 65536, end + 1));
    await notify(fixture, "after", event);
  })());
}
function interceptedWrite(options = {}) {
  const fixture = fixtureFor(this.bucket.name), objectKey = relative(this.name), chunks = [];
  sdkUtil.decorateRequest({ uri: "synthetic-upload", json: options.metadata }, "ia4tube-synthetic");
  return new Writable({
    write(chunk, encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); },
    final(callback) {
      Promise.resolve().then(async () => {
        const event = { operation: "write", objectKey, ifGenerationMatch: options.preconditionOpts?.ifGenerationMatch };
        await notify(fixture, "before", event); condition(fixture, objectKey, options.preconditionOpts?.ifGenerationMatch);
        insert(fixture, objectKey, Buffer.concat(chunks), { contentType: options.metadata?.contentType, metadata: options.metadata?.metadata });
        await notify(fixture, "after", event);
      }).then(() => callback(), error => callback(error));
    }
  });
}
function createOfflineGcsFixture({ bucketName = "ia4tube-offline-" + crypto.randomBytes(6).toString("hex"), clock = Date.now } = {}) {
  if (fixtures.has(bucketName)) throw new Error("offline_gcs_bucket_already_used");
  const fixture = { bucketName, objects: new Map(), calls: [], hooks: {}, faults: [], nextGeneration: 17931400000000000n };
  const transports = new Set(); let closed = false;
  if (!fixtures.size) {
    Storage.prototype.request = interceptedRequest;
    File.prototype.createReadStream = interceptedRead;
    File.prototype.createWriteStream = interceptedWrite;
  }
  fixtures.set(bucketName, fixture);
  function createTransport() {
    if (closed) throw new Error("offline_gcs_fixture_closed");
    const transport = createGcsSdkTransport({ bucketName, clock, projectId: "ia4tube-synthetic",
      credentials: { type: "service_account", client_email: "synthetic@ia4tube-synthetic.iam.gserviceaccount.com", private_key: privateKey } });
    transports.add(transport); return transport;
  }
  function close() {
    if (closed) return; closed = true;
    for (const transport of transports) transport.close();
    fixtures.delete(bucketName);
    if (!fixtures.size) {
      Storage.prototype.request = original.request;
      File.prototype.createReadStream = original.read;
      File.prototype.createWriteStream = original.write;
    }
  }
  try {
    fixture.transport = createTransport();
  } catch (error) { close(); throw error; }
  return Object.assign(fixture, {
    close, createTransport,
    failNext(operation, { afterCommit = false, code = 503 } = {}) {
      fixture.faults.push({ operation, phase: afterCommit ? "after" : "before", code });
    },
    seed({ objectKey, bytes, contentType, metadata: custom, generation } = {}) {
      return insert(fixture, objectKey, bytes, { contentType, metadata: custom, generation });
    },
    head(objectKey) { const object = fixture.objects.get(objectKey); return object ? metadata(fixture, objectKey, object) : null; },
    async putSigned(grant, bytes) {
      const url = new URL(grant.url), objectKey = relative(decodeURIComponent(url.pathname.slice(("/" + bucketName + "/").length)));
      if (grant.method !== "PUT" || url.origin !== "https://storage.googleapis.com" || !url.pathname.startsWith("/" + bucketName + "/") ||
          url.searchParams.get("X-Goog-Algorithm") !== "GOOG4-RSA-SHA256" || Number(grant.headers["content-length"]) !== bytes.length ||
          grant.headers["content-md5"] !== md5(bytes) || grant.headers["content-type"] !== "application/octet-stream" ||
          grant.headers["x-goog-if-generation-match"] !== "0" || grant.expiresAt <= clock()) fail(403);
      const event = { operation: "signed_put", objectKey, ifGenerationMatch: 0 };
      await notify(fixture, "before", event); condition(fixture, objectKey, 0);
      const result = insert(fixture, objectKey, bytes); await notify(fixture, "after", event);
      return { status: 200, generation: result.generation };
    }
  });
}
module.exports = { createOfflineGcsFixture };
