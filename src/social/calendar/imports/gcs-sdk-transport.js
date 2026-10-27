"use strict";

// Private Google Cloud Storage transport. The caller owns tenant authorization,
// durable operation intent and reconciliation. Signed URLs never enter logs.
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { createHash } = require("node:crypto");
const path = require("node:path");
const { Storage, IdempotencyStrategy } = require("@google-cloud/storage");
const instances = new WeakSet();
const ORIGIN = "https://storage.googleapis.com", PREFIX = "ready-video/";
const MAX_BYTES = 100 * 1024 * 1024, PART_BYTES = 5 * 1024 * 1024, CHUNK_BYTES = 65536;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const TOMBSTONE = Buffer.from([0]), TOMBSTONE_MD5 = createHash("md5").update(TOMBSTONE).digest("base64");
function error(code, httpStatus) {
  const value = new Error(`gcs_transport_${code}`);
  value.code = `gcs_transport_${code}`;
  if (Number.isSafeInteger(httpStatus)) value.httpStatus = httpStatus;
  return value;
}
function fail(code = "invalid") { throw error(code); }
function plain(value) { return value && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
function generation(value) {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,19}$/.test(value) || BigInt(value) > 18446744073709551615n) fail();
  return value;
}
function size(value) { if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_BYTES) fail(); return value; }
function md5(value) { return typeof value === "string" && /^[A-Za-z0-9+/]{22}==$/.test(value) && Buffer.from(value, "base64").toString("base64") === value; }
function fields(value) {
  if (value == null) return {};
  if (!plain(value) || Object.keys(value).length > 16) fail();
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key) || typeof item !== "string" || item.length > 256 || /[\u0000-\u001f\u007f]|:\/\//.test(item)) fail();
    // SDK request decoration rewrites values in place, even when unchanged.
    // Keep this private copy mutable; normalized public metadata is frozen below.
    Object.defineProperty(result, key, { value: item, enumerable: true, writable: true, configurable: true });
  }
  return result;
}
function codeOf(value) {
  const candidate = Number(value?.code ?? value?.response?.statusCode ?? value?.response?.status);
  return Number.isSafeInteger(candidate) && candidate >= 400 && candidate <= 599 ? candidate : undefined;
}
function sanitized(value) {
  if (value?.code && /^gcs_transport_[a-z_]+$/.test(value.code)) return value;
  const status = codeOf(value);
  return error(status === 412 ? "precondition_failed" : "unavailable", status);
}

function createGcsSdkTransport({ bucketName, prefix = PREFIX, projectId, credentials, keyFilename,
  allowApplicationDefaultCredentials = false, clock = Date.now, metadataTimeoutMs = 60000,
  transferTimeoutMs = 300000, sdkForTests, allowTestSdk = false } = {}) {
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucketName || "") || prefix !== PREFIX ||
      typeof clock !== "function" || !Number.isSafeInteger(metadataTimeoutMs) || metadataTimeoutMs < 100 || metadataTimeoutMs > 60000 ||
      !Number.isSafeInteger(transferTimeoutMs) || transferTimeoutMs < metadataTimeoutMs || transferTimeoutMs > 600000 ||
      projectId !== undefined && !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(projectId) ||
      typeof allowApplicationDefaultCredentials !== "boolean" || typeof allowTestSdk !== "boolean") fail();
  if (process.env.STORAGE_EMULATOR_HOST || sdkForTests && (!allowTestSdk || typeof sdkForTests.Storage !== "function")) fail();
  const authModes = Number(credentials !== undefined) + Number(keyFilename !== undefined) + Number(allowApplicationDefaultCredentials);
  if (authModes !== 1) fail("credentials_required");
  if (credentials !== undefined && (!plain(credentials) || credentials.type !== "service_account" ||
      !/^[a-zA-Z0-9._-]+@[a-zA-Z0-9-]+\.iam\.gserviceaccount\.com$/.test(credentials.client_email || "") ||
      typeof credentials.private_key !== "string" || !credentials.private_key.includes("-----BEGIN PRIVATE KEY-----"))) fail("credentials_invalid");
  if (keyFilename !== undefined && (typeof keyFilename !== "string" || !path.isAbsolute(keyFilename) || /[\0\r\n]/.test(keyFilename))) fail("credentials_invalid");
  const Client = sdkForTests?.Storage || Storage;
  const client = new Client({ ...(projectId ? { projectId } : {}),
    ...(credentials ? { credentials: { client_email: credentials.client_email, private_key: credentials.private_key } } : {}),
    ...(keyFilename ? { keyFilename } : {}), apiEndpoint: ORIGIN,
    retryOptions: { autoRetry: false, maxRetries: 0, idempotencyStrategy: IdempotencyStrategy.RetryNever },
    timeout: transferTimeoutMs });
  if (!sdkForTests && (client.apiEndpoint !== ORIGIN || client.baseUrl !== `${ORIGIN}/storage/v1`)) fail("endpoint_invalid");
  const bucket = client.bucket(bucketName), active = new Set();
  let closed = false;
  function available() { if (closed) fail("closed"); }
  function key(value) {
    available();
    if (typeof value !== "string" || value.length > 256 || !/^[a-f0-9]{64}\/[A-Za-z0-9][A-Za-z0-9_.\/-]*$/.test(value) ||
        value.split("/").some(part => !part || part === "." || part === "..")) fail("object_key_invalid");
    return prefix + value;
  }
  function file(objectKey, objectGeneration) {
    const name = key(objectKey), exactGeneration = objectGeneration === undefined ? undefined : generation(objectGeneration);
    try {
      // SDK8.4 FileOptions.generation coerces decimal strings through Number.
      // Create without that option, then bind the public generation property as
      // an exact string. createReadStream forwards it unchanged into qs; HEAD
      // and DELETE also carry their explicit exact-generation query below.
      const target = bucket.file(name);
      if (exactGeneration !== undefined) {
        Object.defineProperty(target, "generation", { value: exactGeneration, enumerable: true, writable: false, configurable: false });
      }
      return target;
    } catch (cause) { throw sanitized(cause); }
  }
  function partKey(objectKey) {
    key(objectKey);
    if (!/^[a-f0-9]{64}\/parts\/(0[1-9]|1[0-9]|20)$/.test(objectKey)) fail("object_key_invalid");
    return objectKey;
  }
  function isTombstone(remote, uploadId) {
    if (!remote.exists || remote.metadata.cancelledUpload === undefined) return false;
    if (remote.metadata.cancelledUpload !== uploadId) fail("ownership_conflict");
    if (remote.sizeBytes !== 1 || remote.contentType !== "application/octet-stream" || remote.md5Base64 !== TOMBSTONE_MD5) fail("metadata_invalid");
    return true;
  }
  function expiry(expiresAt) {
    const now = clock();
    if (!Number.isSafeInteger(now) || !Number.isSafeInteger(expiresAt) || expiresAt - now < 1000 || expiresAt - now > 900000) fail("expiry_invalid");
    return now;
  }
  async function bounded(operation, timeoutMs = metadataTimeoutMs) {
    available(); let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(error("timeout")), timeoutMs); timer.unref?.(); });
    try { return await Promise.race([operation(), timeout]); }
    catch (cause) { throw sanitized(cause); }
    finally { clearTimeout(timer); }
  }
  function normalized(value, objectKey, requiredGeneration) {
    if (!plain(value) || value.bucket !== bucketName || value.name !== key(objectKey) ||
        !/^[0-9]+$/.test(String(value.size))) fail("metadata_invalid");
    const objectGeneration = generation(String(value.generation));
    if (requiredGeneration !== undefined && objectGeneration !== generation(requiredGeneration)) fail("generation_mismatch");
    const sizeBytes = size(Number(value.size));
    if (value.md5Hash !== undefined && !md5(value.md5Hash) || typeof value.crc32c !== "string" ||
        !/^[A-Za-z0-9+/]{6}==$/.test(value.crc32c) || typeof value.contentType !== "string" ||
        value.contentType.length > 100 || /[\r\n\0]/.test(value.contentType)) fail("metadata_invalid");
    return Object.freeze({ exists: true, objectKey, sizeBytes, generation: objectGeneration,
      md5Base64: value.md5Hash || null, crc32c: value.crc32c, contentType: value.contentType,
      metadata: Object.freeze(fields(value.metadata)) });
  }
  function signed(url, objectKey, requiredHeaders, expectedGeneration, now, expiresAt) {
    let parsed; try { parsed = new URL(url); } catch { fail("signature_invalid"); }
    const names = ["X-Goog-Algorithm", "X-Goog-Credential", "X-Goog-Date", "X-Goog-Expires", "X-Goog-SignedHeaders", "X-Goog-Signature",
      ...(expectedGeneration === undefined ? [] : ["generation"])];
    const headers = new Set((parsed.searchParams.get("X-Goog-SignedHeaders") || "").split(";"));
    const date = new Date(now).toISOString().replace(/[-:]|\.\d{3}/g, "");
    const seconds = Number(parsed.searchParams.get("X-Goog-Expires"));
    if (parsed.origin !== ORIGIN || parsed.username || parsed.password || parsed.hash || parsed.pathname !== `/${bucketName}/${key(objectKey)}` ||
        [...parsed.searchParams.keys()].some(name => !names.includes(name) || parsed.searchParams.getAll(name).length !== 1) ||
        names.some(name => !parsed.searchParams.has(name)) || parsed.searchParams.get("X-Goog-Algorithm") !== "GOOG4-RSA-SHA256" ||
        !/^[a-f0-9]+$/.test(parsed.searchParams.get("X-Goog-Signature") || "") || parsed.searchParams.get("X-Goog-Date") !== date ||
        !Number.isInteger(seconds) || seconds < 1 || seconds > 900 || seconds > Math.ceil((expiresAt - now) / 1000) ||
        !requiredHeaders.every(name => headers.has(name)) || [...headers].some(name => !requiredHeaders.includes(name)) ||
        expectedGeneration !== undefined && parsed.searchParams.get("generation") !== expectedGeneration) fail("signature_invalid");
    return url;
  }
  async function headObject({ objectKey, generation: objectGeneration } = {}) {
    const target = file(objectKey, objectGeneration);
    try {
      const [result] = await bounded(() => target.request({ method: "GET", uri: "", timeout: metadataTimeoutMs, maxRetries: 0,
        qs: { fields: "bucket,name,size,generation,md5Hash,crc32c,contentType,metadata",
          ...(objectGeneration === undefined ? {} : { generation: objectGeneration }) } }));
      return normalized(result, objectKey, objectGeneration);
    } catch (cause) { if (cause.httpStatus === 404) return Object.freeze({ exists: false }); throw cause; }
  }
  const transport = {
    origin: ORIGIN, bucketName, prefix,
    capabilities: Object.freeze({ sdk: "google-cloud-storage", privateEndpoint: true, privateObjects: true, oneAttempt: true,
      immutableCreates: true, immutableGeneration: true, testOnly: Boolean(sdkForTests) }),
    headObject,
    async verifyBucket() {
      const [result] = await bounded(() => bucket.request({ method: "GET", uri: "", timeout: metadataTimeoutMs, maxRetries: 0,
        qs: { fields: "name,location,storageClass,iamConfiguration,billing" } }));
      if (result?.name !== bucketName || result.iamConfiguration?.uniformBucketLevelAccess?.enabled !== true ||
          result.iamConfiguration?.publicAccessPrevention !== "enforced" || result.billing?.requesterPays === true) fail("bucket_not_private");
      return Object.freeze({ private: true, bucketName, location: result.location, storageClass: result.storageClass });
    },
    async signPartWrite({ objectKey, sizeBytes, md5Base64, expiresAt } = {}) {
      partKey(objectKey);
      size(sizeBytes); if (sizeBytes > PART_BYTES) fail("part_size_invalid"); if (!md5(md5Base64)) fail("checksum_invalid");
      const now = expiry(expiresAt), target = file(objectKey);
      const headers = { "content-length": String(sizeBytes), "content-md5": md5Base64,
        "content-type": "application/octet-stream", "x-goog-if-generation-match": "0" };
      const [url] = await bounded(() => target.getSignedUrl({ action: "write", version: "v4", virtualHostedStyle: false,
        accessibleAt: new Date(now), expires: new Date(expiresAt), contentMd5: md5Base64, contentType: headers["content-type"],
        extensionHeaders: { "content-length": headers["content-length"], "x-goog-if-generation-match": "0" } }));
      return Object.freeze({ url: signed(url, objectKey, ["host", ...Object.keys(headers)], undefined, now, expiresAt),
        method: "PUT", headers: Object.freeze(headers), expiresAt, sizeBytes });
    },
    async composeObject({ objectKey, sources, contentType = "video/mp4", metadata = {} } = {}) {
      const target = file(objectKey);
      if (!Array.isArray(sources) || sources.length < 1 || sources.length > 20 ||
          !["video/mp4", "video/quicktime", "image/jpeg", "image/png", "image/webp", "application/octet-stream"].includes(contentType)) fail();
      const sourceObjects = sources.map(source => ({ name: key(source?.objectKey), generation: generation(source?.generation) }));
      if (sourceObjects.some(source => source.name === key(objectKey)) || new Set(sourceObjects.map(source => source.name)).size !== sources.length) fail();
      const storedMetadata = fields(metadata), existing = await headObject({ objectKey });
      if (existing.exists) {
        if (existing.contentType !== contentType || !Object.keys(storedMetadata).length ||
            Object.entries(storedMetadata).some(([name, value]) => existing.metadata[name] !== value)) fail("precondition_failed");
        return existing;
      }
      const [result] = await bounded(() => target.request({ method: "POST", uri: "/compose", timeout: metadataTimeoutMs, maxRetries: 0,
        qs: { ifGenerationMatch: 0 }, json: { sourceObjects,
          destination: { contentType, cacheControl: "private, no-store", metadata: storedMetadata } } }));
      return normalized(result, objectKey);
    },
    async signObjectRead({ objectKey, generation: objectGeneration, sizeBytes, contentType, expiresAt } = {}) {
      generation(objectGeneration); size(sizeBytes);
      if (!["video/mp4", "image/jpeg", "image/png", "application/octet-stream"].includes(contentType)) fail();
      const now = expiry(expiresAt), target = file(objectKey);
      const [url] = await bounded(() => target.getSignedUrl({ action: "read", version: "v4", virtualHostedStyle: false,
        accessibleAt: new Date(now), expires: new Date(expiresAt), queryParams: { generation: objectGeneration } }));
      return Object.freeze({ url: signed(url, objectKey, ["host"], objectGeneration, now, expiresAt), method: "GET",
        headers: Object.freeze({}), expiresAt, sizeBytes, generation: objectGeneration, contentType });
    },
    async deleteObject({ objectKey, generation: objectGeneration } = {}) {
      const target = file(objectKey, generation(objectGeneration));
      const existing = await headObject({ objectKey, generation: objectGeneration });
      if (!existing.exists) return true;
      if (existing.metadata.cancelledUpload !== undefined) fail("tombstone_protected");
      try { await bounded(() => target.request({ method: "DELETE", uri: "", timeout: metadataTimeoutMs, maxRetries: 0,
        qs: { generation: objectGeneration, ifGenerationMatch: objectGeneration } })); }
      catch (cause) { if (cause.httpStatus !== 404) throw cause; }
      return true;
    },
    async cancelPart({ objectKey, expectedGeneration, uploadId } = {}) {
      partKey(objectKey);
      if (!UUID.test(uploadId || "")) fail("ownership_conflict");
      if (expectedGeneration !== undefined) generation(expectedGeneration);
      const existing = await headObject({ objectKey });
      if (isTombstone(existing, uploadId)) return existing;
      if (existing.exists ? existing.generation !== expectedGeneration : expectedGeneration !== undefined) fail("precondition_failed");
      // This narrowly scoped exception replaces only an authorized part's exact
      // generation. Keeping its name occupied fences late generation-zero PUTs.
      // Do not delete tombstones, including after a signed URL has expired.
      const target = file(objectKey);
      let writable;
      try { writable = target.createWriteStream({ resumable: false, validation: false, timeout: metadataTimeoutMs,
        preconditionOpts: { ifGenerationMatch: expectedGeneration ?? 0 },
        metadata: { contentType: "application/octet-stream", cacheControl: "private, no-store", metadata: { cancelledUpload: uploadId } } }); }
      catch (cause) { throw sanitized(cause); }
      const source = Readable.from([TOMBSTONE]); active.add(writable); active.add(source);
      const timer = setTimeout(() => { writable.destroy(error("timeout")); source.destroy(error("timeout")); }, metadataTimeoutMs); timer.unref?.();
      try {
        try { await bounded(() => pipeline(source, writable)); }
        catch (cause) {
          // A lost acknowledgment is reconciled by metadata, never a second PUT.
          try { const observed = await headObject({ objectKey }); if (isTombstone(observed, uploadId)) return observed; }
          catch (_) { /* Preserve the sanitized original uncertain-write error. */ }
          throw cause;
        }
        const observed = await headObject({ objectKey });
        if (!isTombstone(observed, uploadId)) fail("cancellation_unconfirmed");
        return observed;
      } catch (cause) { throw sanitized(cause); }
      finally { clearTimeout(timer); active.delete(source); active.delete(writable); source.destroy(); writable.destroy(); }
    },
    async streamObject({ objectKey, generation: objectGeneration, sizeBytes, range, signal, consume, timeoutMs = transferTimeoutMs } = {}) {
      const target = file(objectKey, generation(objectGeneration)); size(sizeBytes);
      if (typeof consume !== "function" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > transferTimeoutMs ||
          range !== undefined && (!plain(range) || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) ||
            range.start < 0 || range.end < range.start || range.end >= sizeBytes)) fail();
      if (signal?.aborted) fail("aborted");
      const expected = range ? range.end - range.start + 1 : sizeBytes;
      let stream;
      try { stream = target.createReadStream({ decompress: false, validation: range ? false : "crc32c",
        ...(range ? { start: range.start, end: range.end } : {}) }); }
      catch (cause) { throw sanitized(cause); }
      const deadline = Date.now() + timeoutMs;
      active.add(stream); let count = 0;
      const abort = () => stream.destroy(error("aborted"));
      signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => stream.destroy(error("timeout")), timeoutMs); timer.unref?.();
      try {
        for await (const value of stream) {
          available(); if (signal?.aborted) fail("aborted");
          const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
          count += chunk.length; if (count > expected) fail("size_mismatch");
          for (let offset = 0; offset < chunk.length; offset += CHUNK_BYTES) {
            const remaining = deadline - Date.now(); if (remaining <= 0) fail("timeout");
            await bounded(() => consume(chunk.subarray(offset, Math.min(offset + CHUNK_BYTES, chunk.length))), remaining);
          }
        }
        if (count !== expected) fail("size_mismatch");
        return Object.freeze({ sizeBytes: count, generation: objectGeneration });
      } catch (cause) { throw sanitized(cause); }
      finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); active.delete(stream); stream.destroy(); }
    },
    async uploadObject({ objectKey, bodyStream, sizeBytes, contentType, metadata = {}, timeoutMs = transferTimeoutMs } = {}) {
      const target = file(objectKey); size(sizeBytes);
      if (!bodyStream || typeof bodyStream[Symbol.asyncIterator] !== "function" ||
          !["video/mp4", "image/jpeg", "image/png", "application/octet-stream"].includes(contentType) ||
          !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > transferTimeoutMs) fail();
      const storedMetadata = fields(metadata);
      const existing = await headObject({ objectKey });
      if (existing.exists) {
        if (existing.sizeBytes !== sizeBytes || existing.contentType !== contentType ||
            Object.entries(storedMetadata).some(([name, value]) => existing.metadata[name] !== value)) fail("precondition_failed");
        return existing;
      }
      let writable;
      // SDK checksum validation may delete the current object automatically on
      // mismatch. Verify our own digests after upload so only explicit, exact-
      // generation cleanup can remove an object, even after an uncertain write.
      try { writable = target.createWriteStream({ resumable: false, validation: false, timeout: timeoutMs,
        preconditionOpts: { ifGenerationMatch: 0 }, metadata: { contentType, cacheControl: "private, no-store", metadata: storedMetadata } }); }
      catch (cause) { throw sanitized(cause); }
      const md5Digest = createHash("md5"), sha256Digest = createHash("sha256");
      const source = Readable.from((async function* () {
        let count = 0;
        for await (const value of bodyStream) {
          available(); const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
          count += chunk.length; if (count > sizeBytes) fail("size_mismatch"); md5Digest.update(chunk); sha256Digest.update(chunk); yield chunk;
        }
        if (count !== sizeBytes) fail("size_mismatch");
      })());
      active.add(writable); active.add(source);
      const timer = setTimeout(() => { writable.destroy(error("timeout")); source.destroy(error("timeout")); }, timeoutMs); timer.unref?.();
      try {
        await bounded(() => pipeline(source, writable), timeoutMs);
        const received = await headObject({ objectKey });
        if (!received.exists || received.sizeBytes !== sizeBytes || received.md5Base64 !== md5Digest.digest("base64") ||
            storedMetadata.sha256 && storedMetadata.sha256 !== sha256Digest.digest("hex") || received.contentType !== contentType ||
            Object.entries(storedMetadata).some(([name, value]) => received.metadata[name] !== value)) fail("checksum_mismatch");
        return received;
      }
      catch (cause) { throw sanitized(cause); }
      finally { clearTimeout(timer); active.delete(source); active.delete(writable); source.destroy(); writable.destroy(); }
    },
    close() { if (!closed) { closed = true; for (const stream of active) stream.destroy(error("closed")); active.clear(); } }
  };
  Object.freeze(transport); instances.add(transport); return transport;
}
function isGcsSdkTransport(value, { allowTestSdk = false } = {}) {
  return Boolean(value && instances.has(value) && (allowTestSdk || !value.capabilities.testOnly));
}
module.exports = { createGcsSdkTransport, isGcsSdkTransport };
