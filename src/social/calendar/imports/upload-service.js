"use strict";

const crypto = require("node:crypto");
const { LIMITS, inspectedMedia } = require("./policy");

const MiB = 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const MIME_TYPES = Object.freeze({
  image: Object.freeze(["image/jpeg", "image/png", "image/webp"]),
  video: Object.freeze(["video/mp4", "video/quicktime"])
});
const DEFAULT_LIMITS = Object.freeze({
  imageBytes: LIMITS.imageBytes, videoBytes: LIMITS.videoBytes, chunkBytes: LIMITS.chunkBytes,
  imagePixels: LIMITS.imagePixels, videoDurationMs: LIMITS.videoSeconds * 1000,
  // Local pilot defaults, not a provisioned or approved commercial allowance.
  companyReservedBytes: 1024 * MiB, companyActiveUploads: 10,
  companyUploadRecords: 1000,
  operationLeaseMs: 5 * 60 * 1000, authorizationLifetimeMs: 10 * 60 * 1000
});

class CalendarImportUploadError extends Error {
  constructor(code, statusCode = 400) {
    super(code);
    this.name = "CalendarImportUploadError";
    this.code = code;
    this.statusCode = statusCode;
  }
}
function fail(code, statusCode) { throw new CalendarImportUploadError(code, statusCode); }
function sha(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function fields(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Object.keys(value).some(key => !allowed.includes(key))) fail("import_request_invalid");
}
function owner(context) {
  // The route must derive this context from the verified session, never the body.
  if (!context || context.authenticated !== true || typeof context.companyId !== "string" || typeof context.userId !== "string" ||
      !UUID.test(context.companyId) || !UUID.test(context.userId)) fail("import_owner_invalid", 403);
  return { companyId: context.companyId.toLowerCase(), userId: context.userId.toLowerCase() };
}
function recordFor(state, identity, uploadId) {
  if (typeof uploadId !== "string" || !UUID.test(uploadId)) fail("import_not_found", 404);
  const record = state.uploads[uploadId];
  if (!record || record.companyId !== identity.companyId || record.userId !== identity.userId) fail("import_not_found", 404);
  return record;
}
function freshImportUploadState() {
  return { schema: 1, reservedBytes: 0, uploads: {}, idempotency: {}, prepareOutbox: {} };
}
function publicRecord(record) {
  return {
    uploadId: record.uploadId, assetId: record.assetId, kind: record.kind,
    mimeType: record.mimeType, sizeBytes: record.sizeBytes, chunkBytes: record.chunkBytes,
    partCount: Math.ceil(record.sizeBytes / record.chunkBytes), state: record.state,
    createdAt: record.createdAt, updatedAt: record.updatedAt,
    errorCode: record.errorCode || null,
    preparation: record.state === "uploaded" ? "pending" : "not_queued",
    verification: record.state === "uploaded" ? {
      sha256: record.verified.sha256, sizeBytes: record.verified.sizeBytes,
      mimeType: record.verified.mimeType
    } : null,
    ready: false
  };
}
function observedParts(parts, record, requireComplete) {
  if (!Array.isArray(parts) || parts.length > Math.ceil(record.sizeBytes / record.chunkBytes)) fail("import_remote_parts_invalid", 502);
  const found = new Set();
  const normalized = parts.map(part => {
    const number = part?.partNumber;
    if (!Number.isSafeInteger(number) || number < 1 || number > Math.ceil(record.sizeBytes / record.chunkBytes) || found.has(number)) fail("import_remote_parts_invalid", 502);
    found.add(number);
    const expected = Math.min(record.chunkBytes, record.sizeBytes - (number - 1) * record.chunkBytes);
    if (part.sizeBytes !== expected || !HASH.test(part.sha256 || "")) fail("import_remote_parts_invalid", 502);
    return { partNumber: number, sizeBytes: part.sizeBytes, sha256: part.sha256 };
  }).sort((a, b) => a.partNumber - b.partNumber);
  if (requireComplete && normalized.length !== Math.ceil(record.sizeBytes / record.chunkBytes)) fail("import_upload_incomplete", 409);
  return normalized;
}
function inspectedMetadata(actual, record, limits) {
  if (!actual || actual.complete !== true || actual.signatureVerified !== true || actual.decoded !== true ||
      actual.sizeBytes !== record.sizeBytes || actual.sha256 !== record.sha256 ||
      actual.detectedMime !== record.mimeType || !Number.isSafeInteger(actual.width) || actual.width <= 0 ||
      !Number.isSafeInteger(actual.height) || actual.height <= 0) fail("import_media_verification_failed", 422);
  if (record.kind === "image" && actual.width * actual.height > limits.imagePixels) fail("import_media_limits_exceeded", 422);
  if (record.kind === "video" && (!Number.isSafeInteger(actual.durationMs) || actual.durationMs < 1 ||
      actual.durationMs > limits.videoDurationMs || actual.width > 4096 || actual.height > 4096)) fail("import_media_limits_exceeded", 422);
  const format = { "image/jpeg": "jpeg", "image/png": "png", "image/webp": "webp", "video/mp4": "mp4", "video/quicktime": "mov" }[actual.detectedMime];
  try {
    inspectedMedia({ kind: record.kind, format, size: actual.sizeBytes, sha256: actual.sha256,
      decoded: actual.decoded, width: actual.width, height: actual.height, frames: actual.frames,
      durationSeconds: actual.durationMs / 1000, hasAudio: actual.hasAudio, colorMode: actual.colorMode }, record.kind);
  } catch (_) { fail("import_media_verification_failed", 422); }
  return {
    sizeBytes: actual.sizeBytes, sha256: actual.sha256, mimeType: actual.detectedMime,
    width: actual.width, height: actual.height,
    ...(record.kind === "video" ? { durationMs: actual.durationMs, hasAudio: actual.hasAudio, colorMode: actual.colorMode } : { frames: actual.frames })
  };
}

/**
 * Metadata-only upload control; it neither receives media nor creates calendars.
 *
 * store.update(companyId, synchronousMutation) MUST commit serializably across
 * every API process, including absent rows, quota, idempotency and prepareOutbox.
 * A process-local mutex is insufficient in production. No provider/network call
 * is made inside update. Production needs authenticated owner/RLS, an atomic
 * durable outbox consumer and recovery of expired operation leases.
 *
 * provider MUST create an idempotent private multipart upload keyed by objectKey,
 * grant only the exact part/size, atomically seal the verified manifest, preserve
 * immutable object versions and inspect actual bytes out of process. Inspection
 * cannot merely echo client metadata or a multipart ETag as the object SHA-256.
 * Transient finalize ambiguity is retried only against that same immutable key.
 * listParts must remain idempotently available after completion, backed by the
 * persisted sealed manifest (not a raw S3 list-parts call after upload removal).
 * No signed URLs, object keys, provider upload IDs or grants are persisted in logs
 * or exposed in the public status. Transport of the opaque authorizationId is a
 * separate, authenticated provider integration, not implemented here.
 */
function createCalendarImportUploadService(options = {}) {
  const { store, provider, clock = Date.now, enabled = false, allowVolatileForTests = false } = options;
  const limits = Object.freeze({ ...DEFAULT_LIMITS, ...(options.limits || {}) });
  for (const [key, value] of Object.entries(limits)) {
    if (!(key in DEFAULT_LIMITS) || !Number.isSafeInteger(value) || value < 1 || value > DEFAULT_LIMITS[key]) fail("import_configuration_invalid", 503);
  }
  if (limits.chunkBytes !== DEFAULT_LIMITS.chunkBytes) fail("import_configuration_invalid", 503);
  const volatile = store?.capabilities?.persistence === "volatile-test" || provider?.capabilities?.testOnly === true;
  const available = enabled && store?.capabilities?.atomicCompanyUpdates === true &&
    (store?.capabilities?.persistence === "durable" || (volatile && allowVolatileForTests)) &&
    provider?.capabilities?.privateObjects === true && provider?.capabilities?.metadataOnly === true &&
    provider?.capabilities?.actualInspection === true && provider?.capabilities?.idempotentMultipart === true &&
    provider?.capabilities?.immutableFinalObjects === true && (!volatile || allowVolatileForTests) &&
    typeof store.update === "function" && ["beginMultipart", "authorizePart", "listParts", "finalizeMultipart", "inspectObject", "abortMultipart"].every(name => typeof provider[name] === "function");
  function assertAvailable() { if (!available) fail("import_upload_unavailable", 503); }
  function now() {
    const value = clock();
    if (!Number.isSafeInteger(value) || value < 0) fail("import_clock_invalid", 503);
    return value;
  }
  async function update(identity, operation) {
    return store.update(identity.companyId, state => {
      if (state?.schema !== 1 || !Number.isSafeInteger(state.reservedBytes) || state.reservedBytes < 0 ||
          !state.uploads || !state.idempotency || !state.prepareOutbox) fail("import_store_invalid", 503);
      return operation(state);
    });
  }
  async function get(identity, uploadId) {
    return update(identity, state => structuredClone(recordFor(state, identity, uploadId)));
  }
  async function safe(operation) {
    assertAvailable();
    try { return await operation(); }
    catch (error) {
      if (error instanceof CalendarImportUploadError) throw error;
      // Do not propagate provider URLs, secrets, stack/cause or database errors.
      fail("import_operation_unavailable", 503);
    }
  }
  async function claim(identity, uploadId, operation, accepted, nextState) {
    return update(identity, state => {
      const record = recordFor(state, identity, uploadId), time = now();
      if (!accepted.includes(record.state)) return { claimed: false, record: structuredClone(record) };
      if (record.lease && record.lease.expiresAt > time) return { claimed: false, record: structuredClone(record) };
      record.state = nextState;
      record.lease = { operation, token: crypto.randomUUID(), expiresAt: time + limits.operationLeaseMs };
      record.updatedAt = time;
      return { claimed: true, token: record.lease.token, record: structuredClone(record) };
    });
  }
  async function finish(identity, uploadId, token, operation) {
    return update(identity, state => {
      const record = recordFor(state, identity, uploadId);
      if (record.lease?.token !== token) return structuredClone(record);
      operation(record, state);
      record.lease = null;
      record.updatedAt = now();
      return structuredClone(record);
    });
  }
  async function initialize(identity, uploadId) {
    const attempt = await claim(identity, uploadId, "initialize", ["created"], "created");
    if (!attempt.claimed) return attempt.record;
    const { record, token } = attempt;
    try {
      const result = await provider.beginMultipart({ context: { ...identity, authenticated: true }, objectKey: record.objectKey, assetId: record.assetId,
        sizeBytes: record.sizeBytes, chunkBytes: record.chunkBytes, checksumAlgorithm: "SHA256" });
      if (!UUID.test(result?.uploadId || "")) fail("import_provider_response_invalid", 502);
      return await finish(identity, uploadId, token, current => {
        current.providerUploadId = result.uploadId;
        current.state = "uploading"; current.errorCode = null;
      });
    } catch (_) {
      await finish(identity, uploadId, token, current => { current.errorCode = "import_provider_unavailable"; });
      fail("import_provider_unavailable", 503);
    }
  }

  const service = {
    async start(context, input) { return safe(async () => {
      const identity = owner(context);
      fields(input, ["idempotencyKey", "kind", "mimeType", "sizeBytes", "sha256"]);
      if (typeof input.idempotencyKey !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(input.idempotencyKey) ||
          !Object.hasOwn(MIME_TYPES, input.kind) || !MIME_TYPES[input.kind].includes(input.mimeType) || !Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1 ||
          input.sizeBytes > limits[input.kind + "Bytes"] || typeof input.sha256 !== "string" || !HASH.test(input.sha256)) fail("import_request_invalid");
      const requestHash = sha(JSON.stringify([input.kind, input.mimeType, input.sizeBytes, input.sha256]));
      const idempotencyHash = sha(identity.userId + ":" + input.idempotencyKey);
      const record = await update(identity, state => {
        const existingId = state.idempotency[idempotencyHash];
        if (existingId) {
          const existing = recordFor(state, identity, existingId);
          if (existing.requestHash !== requestHash) fail("import_idempotency_conflict", 409);
          return structuredClone(existing);
        }
        const active = Object.values(state.uploads).filter(row => ["created", "uploading", "verifying", "cancel_pending"].includes(row.state)).length;
        if (active >= limits.companyActiveUploads || Object.keys(state.uploads).length >= limits.companyUploadRecords ||
            state.reservedBytes + input.sizeBytes > limits.companyReservedBytes) fail("import_quota_exceeded", 409);
        const time = now();
        const created = {
          ...identity, uploadId: crypto.randomUUID(), assetId: crypto.randomUUID(), objectKey: crypto.randomBytes(32).toString("hex"),
          kind: input.kind, mimeType: input.mimeType, sizeBytes: input.sizeBytes, sha256: input.sha256,
          chunkBytes: limits.chunkBytes, requestHash, state: "created", lease: null,
          createdAt: time, updatedAt: time, errorCode: null
        };
        state.uploads[created.uploadId] = created;
        state.idempotency[idempotencyHash] = created.uploadId;
        state.reservedBytes += created.sizeBytes;
        return structuredClone(created);
      });
      return publicRecord(record.state === "created" ? await initialize(identity, record.uploadId) : record);
    }); },
    async status(context, input) { return safe(async () => {
      const identity = owner(context); fields(input, ["uploadId"]);
      return publicRecord(await get(identity, input.uploadId));
    }); },
    async resume(context, input) { return safe(async () => {
      const identity = owner(context); fields(input, ["uploadId"]);
      let record = await get(identity, input.uploadId);
      if (record.state === "created") record = await initialize(identity, record.uploadId);
      let parts = [];
      if (record.state === "uploading") parts = observedParts(await provider.listParts({ context: { ...identity, authenticated: true }, objectKey: record.objectKey, uploadId: record.providerUploadId }), record, false);
      // Completed-part hashes may be compared locally against the selected file.
      return { ...publicRecord(record), completedParts: parts };
    }); },
    async authorizePart(context, input) { return safe(async () => {
      const identity = owner(context); fields(input, ["uploadId", "partNumber", "sha256", "md5Base64"]);
      if (input.sha256 !== undefined && (typeof input.sha256 !== "string" || !HASH.test(input.sha256))) fail("import_part_invalid");
      if (input.md5Base64 !== undefined && (typeof input.md5Base64 !== "string" || !/^[A-Za-z0-9+/]{22}==$/.test(input.md5Base64) || Buffer.from(input.md5Base64, "base64").toString("base64") !== input.md5Base64)) fail("import_part_invalid");
      const record = await get(identity, input.uploadId);
      if (record.state !== "uploading") fail("import_upload_not_writable", 409);
      if (!Number.isSafeInteger(input.partNumber) || input.partNumber < 1 || input.partNumber > Math.ceil(record.sizeBytes / record.chunkBytes)) fail("import_part_invalid");
      const sizeBytes = Math.min(record.chunkBytes, record.sizeBytes - (input.partNumber - 1) * record.chunkBytes);
      const expiresAt = now() + limits.authorizationLifetimeMs;
      const authorization = await provider.authorizePart({ context: { ...identity, authenticated: true }, objectKey: record.objectKey, uploadId: record.providerUploadId,
        partNumber: input.partNumber, sizeBytes, expiresAt, sha256: input.sha256, md5Base64: input.md5Base64 });
      if (!UUID.test(authorization?.authorizationId || "") || authorization.expiresAt !== expiresAt) fail("import_provider_response_invalid", 502);
      return { uploadId: record.uploadId, partNumber: input.partNumber, sizeBytes,
        authorizationId: authorization.authorizationId, expiresAt };
    }); },
    async resolvePart(context, input) { return safe(async () => {
      const identity = owner(context); fields(input, ["uploadId", "partNumber", "authorizationId"]);
      if (typeof provider.resolveAuthorization !== "function") fail("import_transfer_unavailable", 503);
      const record = await get(identity, input.uploadId);
      if (record.state !== "uploading") fail("import_upload_not_writable", 409);
      if (!Number.isSafeInteger(input.partNumber) || input.partNumber < 1 || input.partNumber > Math.ceil(record.sizeBytes / record.chunkBytes) ||
          typeof input.authorizationId !== "string" || !UUID.test(input.authorizationId)) fail("import_part_invalid");
      const grant = await provider.resolveAuthorization({ context: { ...identity, authenticated: true }, objectKey: record.objectKey,
        uploadId: record.providerUploadId, partNumber: input.partNumber, authorizationId: input.authorizationId });
      const expected = Math.min(record.chunkBytes, record.sizeBytes - (input.partNumber - 1) * record.chunkBytes);
      if (!grant || grant.method !== "PUT" || grant.sizeBytes !== expected || !Number.isSafeInteger(grant.expiresAt) ||
          grant.expiresAt <= now() || typeof grant.url !== "string" || !grant.url.startsWith("https://") ||
          !grant.headers || Object.keys(grant.headers).some(key => !["content-length", "content-md5", "x-amz-checksum-sha256"].includes(key))) fail("import_provider_response_invalid", 502);
      return { url: grant.url, method: "PUT", headers: grant.headers, expiresAt: grant.expiresAt, sizeBytes: grant.sizeBytes };
    }); },
    async complete(context, input) { return safe(async () => {
      const identity = owner(context); fields(input, ["uploadId"]);
      const attempt = await claim(identity, input.uploadId, "verify", ["uploading", "verifying"], "verifying");
      if (!attempt.claimed) {
        if (["uploaded", "verifying", "rejected"].includes(attempt.record.state)) return publicRecord(attempt.record);
        fail("import_upload_not_completable", 409);
      }
      const { record, token } = attempt;
      try {
        const parts = observedParts(await provider.listParts({ context: { ...identity, authenticated: true }, objectKey: record.objectKey, uploadId: record.providerUploadId }), record, true);
        const manifestHash = sha(JSON.stringify(parts));
        await update(identity, state => {
          const current = recordFor(state, identity, record.uploadId);
          if (current.lease?.token !== token) fail("import_operation_superseded", 409);
          if (current.manifestHash && current.manifestHash !== manifestHash) fail("import_remote_manifest_changed", 422);
          current.manifestHash = manifestHash;
        });
        const completed = await provider.finalizeMultipart({ context: { ...identity, authenticated: true }, objectKey: record.objectKey, uploadId: record.providerUploadId, parts });
        if (!UUID.test(completed?.objectVersion || "")) fail("import_provider_response_invalid", 502);
        const actual = await provider.inspectObject({ context: { ...identity, authenticated: true }, objectKey: record.objectKey, objectVersion: completed.objectVersion });
        const verified = inspectedMetadata(actual, record, limits);
        const result = await finish(identity, record.uploadId, token, (current, state) => {
          current.state = "uploaded"; current.errorCode = null;
          current.verified = verified; current.objectVersion = completed.objectVersion;
          // Atomic outbox, not an in-memory callback that could enqueue twice.
          const jobId = current.assetId + ":1";
          if (!state.prepareOutbox[jobId]) state.prepareOutbox[jobId] = {
            jobId, companyId: current.companyId, userId: current.userId, assetId: current.assetId,
            uploadId: current.uploadId, assetRevision: 1, state: "pending", createdAt: now()
          };
        });
        return publicRecord(result);
      } catch (error) {
        const incomplete = error instanceof CalendarImportUploadError && error.code === "import_upload_incomplete";
        const invalid = error instanceof CalendarImportUploadError && error.statusCode === 422;
        await finish(identity, record.uploadId, token, current => {
          current.state = incomplete ? "uploading" : invalid ? "rejected" : "verifying";
          current.errorCode = incomplete || invalid ? error.code : "import_verification_pending";
          // A rejected or uncertain object still consumes its reservation. Cleanup
          // needs a separate reference-aware policy; never silently release it.
        });
        if (incomplete || invalid) throw error;
        fail("import_verification_pending", 503);
      }
    }); },
    async cancel(context, input) { return safe(async () => {
      const identity = owner(context); fields(input, ["uploadId"]);
      const attempt = await claim(identity, input.uploadId, "cancel", ["created", "uploading", "cancel_pending"], "cancel_pending");
      if (!attempt.claimed) {
        if (["cancelled", "cancel_pending"].includes(attempt.record.state)) return publicRecord(attempt.record);
        fail("import_upload_not_cancellable", 409);
      }
      const { record, token } = attempt;
      try {
        // Key-based abort also cancels an initiation whose response was lost.
        const result = await provider.abortMultipart({ context: { ...identity, authenticated: true }, objectKey: record.objectKey });
        if (result?.aborted !== true || result?.objectExists !== false) fail("import_provider_response_invalid", 502);
        return publicRecord(await finish(identity, record.uploadId, token, (current, state) => {
          current.state = "cancelled"; current.errorCode = null;
          state.reservedBytes -= current.sizeBytes;
        }));
      } catch (_) {
        await finish(identity, record.uploadId, token, current => { current.errorCode = "import_cancellation_pending"; });
        fail("import_cancellation_pending", 503);
      }
    }); }
  };
  return Object.freeze(service);
}

module.exports = {
  createCalendarImportUploadService, CalendarImportUploadError,
  freshImportUploadState, DEFAULT_LIMITS, MIME_TYPES
};
