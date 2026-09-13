"use strict";

const crypto = require("node:crypto");
const { CalendarImportUploadError } = require("./upload-service");
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const b64 = value => Buffer.from(value, "hex").toString("base64");
function fail(code = "r2_provider_unavailable") { const error = new Error(code); error.code = code; throw error; }
function base64Hash(value, bytes) {
  return typeof value === "string" && Buffer.from(value, "base64").length === bytes && Buffer.from(value, "base64").toString("base64") === value;
}
function createR2PrivateUploadProvider({ store, transport, inspector, clock = Date.now, enabled = false, allowVolatileForTests = false }) {
  const durable = store?.capabilities?.persistence === "durable";
  const available = enabled && store?.capabilities?.atomicCompanyUpdates === true &&
    (durable || allowVolatileForTests && store?.capabilities?.persistence === "volatile-test") &&
    transport?.capabilities?.sdk === "aws-sdk-v3" && transport?.capabilities?.oneAttempt === true &&
    transport?.capabilities?.privateEndpoint === true && inspector?.capabilities?.isolated === true &&
    inspector?.capabilities?.bounded === true && inspector?.capabilities?.remoteObjectInspection === true &&
    typeof inspector.startInspection === "function" && typeof inspector.getInspection === "function";
  async function safe(operation) {
    if (!available) fail("r2_provider_disabled");
    try { return await operation(); }
    catch (error) { if (error instanceof CalendarImportUploadError || typeof error?.code === "string" && /^r2_[a-z_]{1,80}$/.test(error.code)) throw error; fail(); }
  }
  function identity(args) {
    const ctx = args?.context;
    if (ctx?.authenticated !== true || !UUID.test(ctx.companyId || "") || !UUID.test(ctx.userId || "") || !HASH.test(args.objectKey || "")) fail("r2_owner_invalid");
    return ctx;
  }
  async function mutate(args, operation) {
    const ctx = identity(args);
    return store.update(ctx.companyId, state => {
      const row = Object.values(state.uploads).find(value => value.objectKey === args.objectKey);
      if (!row || row.companyId !== ctx.companyId || row.userId !== ctx.userId ||
          args.uploadId && row.r2?.uploadId !== args.uploadId) fail("r2_upload_not_found");
      return operation(row);
    });
  }
  async function read(args) { return mutate(args, row => structuredClone(row)); }
  function remoteId(value) { if (typeof value !== "string" || !value.length || value.length > 2048 || /[\x00-\x1f]/.test(value)) fail("r2_remote_response_invalid"); return value; }
  function etag(value) { if (typeof value !== "string" || value.length < 1 || value.length > 200 || /[\x00-\x1f]/.test(value)) fail("r2_remote_response_invalid"); return value; }
  async function head(args, record, expectedEtag) {
    const found = await transport.head(args.objectKey);
    if (!found) return null;
    if (found.ContentLength !== record.sizeBytes || found.Metadata?.["import-asset-id"] !== record.assetId ||
        expectedEtag && found.ETag !== expectedEtag) fail("r2_object_conflict");
    etag(found.ETag);
    return found;
  }
  async function currentParts(args, row) {
    if (["sealing", "sealed"].includes(row.r2.phase)) return row.r2.manifest;
    const remote = await transport.listParts(args.objectKey, row.r2.remoteUploadId);
    const seen = new Set();
    if (!Array.isArray(remote) || remote.length > Math.ceil(row.sizeBytes / row.chunkBytes)) fail("r2_parts_invalid");
    return remote.map(part => {
      const expected = row.r2.parts[String(part.PartNumber)];
      if (!expected || seen.has(part.PartNumber) || part.Size !== expected.sizeBytes ||
          !base64Hash(part.ChecksumSHA256, 32) || part.ChecksumSHA256 !== b64(expected.sha256)) fail("r2_parts_invalid");
      seen.add(part.PartNumber);
      return { partNumber: part.PartNumber, sizeBytes: part.Size, sha256: Buffer.from(part.ChecksumSHA256, "base64").toString("hex"),
        etag: etag(part.ETag), checksum: part.ChecksumSHA256 };
    }).sort((a, b) => a.partNumber - b.partNumber);
  }
  async function confirmSealed(args, row) {
    const found = await head(args, row, row.r2.etag);
    if (!found) return null;
    return mutate(args, current => {
      if (!["sealing", "sealed"].includes(current.r2.phase)) fail("r2_state_conflict");
      current.r2.phase = "sealed";
      current.r2.etag = found.ETag;
      return { objectVersion: current.r2.objectVersion };
    });
  }
  return Object.freeze({
    capabilities: Object.freeze({ testOnly: !durable, privateObjects: Boolean(available), metadataOnly: true,
      actualInspection: Boolean(available), idempotentMultipart: Boolean(available), immutableFinalObjects: Boolean(available) }),
    getCapabilities() { return { provider: "cloudflare-r2", origin: transport?.origin || null, available: Boolean(available), multipartPartNumbers: "one-based" }; },
    async beginMultipart(args) { return safe(async () => {
      const claim = await mutate(args, row => {
        if (row.assetId !== args.assetId || row.sizeBytes !== args.sizeBytes || row.chunkBytes !== args.chunkBytes) fail("r2_request_conflict");
        if (row.r2) return { first: false, row: structuredClone(row) };
        if (row.state !== "created") fail("r2_state_conflict");
        // Persist before the only CreateMultipartUpload attempt. A crash before
        // the call can require manual reconciliation; never silently recreate.
        row.r2 = { schema: 1, uploadId: crypto.randomUUID(), objectVersion: crypto.randomUUID(),
          phase: "begin_unknown", parts: {}, beginAt: clock() };
        return { first: true, row: structuredClone(row) };
      });
      const row = claim.row;
      if (["open", "sealing", "sealed"].includes(row.r2.phase)) return { uploadId: row.r2.uploadId };
      if (row.r2.phase !== "begin_unknown") fail("r2_state_conflict");
      if (await transport.head(args.objectKey)) fail("r2_object_conflict");
      let id;
      if (claim.first) id = remoteId((await transport.create(args.objectKey, row.assetId)).UploadId);
      else {
        const uploads = await transport.findUploads(args.objectKey);
        if (uploads.length !== 1) fail("r2_begin_reconciliation_required");
        id = remoteId(uploads[0].UploadId);
      }
      return mutate(args, current => {
        if (current.r2.phase !== "begin_unknown" && !(current.r2.phase === "open" && current.r2.remoteUploadId === id)) fail("r2_state_conflict");
        current.r2.remoteUploadId = id; current.r2.phase = "open";
        return { uploadId: current.r2.uploadId };
      });
    }); },
    async authorizePart(args) { return safe(async () => {
      if (!HASH.test(args.sha256 || "") || !base64Hash(args.md5Base64, 16) ||
          !Number.isSafeInteger(args.expiresAt) || args.expiresAt <= clock() || args.expiresAt - clock() > 600000) fail("r2_part_invalid");
      return mutate(args, row => {
        if (row.state !== "uploading" || row.r2?.phase !== "open") fail("r2_state_conflict");
        const expected = Math.min(row.chunkBytes, row.sizeBytes - (args.partNumber - 1) * row.chunkBytes);
        if (!Number.isSafeInteger(args.partNumber) || args.partNumber < 1 || args.sizeBytes !== expected || expected < 1) fail("r2_part_invalid");
        const previous = row.r2.parts[String(args.partNumber)];
        if (previous && (previous.sha256 !== args.sha256 || previous.md5Base64 !== args.md5Base64 || previous.sizeBytes !== expected)) fail("r2_part_conflict");
        // Renewing the same digest invalidates the old opaque resolution handle;
        // any issued presign can only retransmit the same size/checksummed bytes.
        const grant = { sha256: args.sha256, md5Base64: args.md5Base64, sizeBytes: expected,
          authorizationId: crypto.randomUUID(), expiresAt: args.expiresAt };
        row.r2.parts[String(args.partNumber)] = grant;
        return { authorizationId: grant.authorizationId, expiresAt: grant.expiresAt };
      });
    }); },
    async resolveAuthorization(args) { return safe(async () => {
      const row = await read(args), grant = row.r2?.parts[String(args.partNumber)];
      if (row.state !== "uploading" || row.r2.phase !== "open" || !grant || grant.authorizationId !== args.authorizationId || grant.expiresAt <= clock()) fail("r2_authorization_invalid");
      const signed = await transport.signPart({ key: args.objectKey, uploadId: row.r2.remoteUploadId, partNumber: args.partNumber, ...grant });
      // Resolve against current durable state again after signing, before exposing.
      await mutate(args, current => {
        if (current.state !== "uploading" || current.r2.phase !== "open" || current.r2.parts[String(args.partNumber)]?.authorizationId !== args.authorizationId) fail("r2_authorization_invalid");
      });
      return signed;
    }); },
    async listParts(args) { return safe(async () => {
      const row = await read(args);
      if (!row.r2 || !["open", "sealing", "sealed"].includes(row.r2.phase)) fail("r2_state_conflict");
      return (await currentParts(args, row)).map(({ partNumber, sizeBytes, sha256 }) => ({ partNumber, sizeBytes, sha256 }));
    }); },
    async finalizeMultipart(args) { return safe(async () => {
      let row = await read(args);
      if (row.state !== "verifying" || !["open", "sealing", "sealed"].includes(row.r2?.phase)) fail("r2_state_conflict");
      if (row.r2.phase === "sealed") {
        const result = await confirmSealed(args, row); if (!result) fail("r2_object_missing"); return result;
      }
      if (row.r2.phase === "sealing") {
        const result = await confirmSealed(args, row); if (result) return result;
      }
      if (row.r2.phase === "open" && await transport.head(args.objectKey)) fail("r2_object_conflict");
      const manifest = row.r2.phase === "sealing" ? row.r2.manifest : await currentParts(args, row);
      const normalized = manifest.map(({ partNumber, sizeBytes, sha256 }) => ({ partNumber, sizeBytes, sha256 }));
      if (manifest.length !== Math.ceil(row.sizeBytes / row.chunkBytes) || JSON.stringify(normalized) !== JSON.stringify(args.parts)) fail("r2_manifest_conflict");
      await mutate(args, current => {
        if (!["open", "sealing"].includes(current.r2.phase)) fail("r2_state_conflict");
        if (current.r2.manifest && JSON.stringify(current.r2.manifest) !== JSON.stringify(manifest)) fail("r2_manifest_conflict");
        current.r2.phase = "sealing"; current.r2.manifest = manifest;
      });
      // Retrying this exact UploadId cannot create another object/upload. An
      // uncertain success is reconciled with HEAD, not a new multipart session.
      try { await transport.complete(args.objectKey, row.r2.remoteUploadId, manifest.map(part => ({ PartNumber: part.partNumber, ETag: part.etag, ChecksumSHA256: part.checksum }))); }
      catch (_) { /* Reconcile below; if absent preserve sealing and fail closed. */ }
      row = await read(args);
      const confirmed = await confirmSealed(args, row);
      if (!confirmed) fail("r2_completion_pending");
      return confirmed;
    }); },
    async inspectObject(args) { return safe(async () => {
      const row = await read(args);
      if (row.r2?.phase !== "sealed" || row.r2.objectVersion !== args.objectVersion) fail("r2_state_conflict");
      if (!(await head(args, row, row.r2.etag))) fail("r2_object_missing");
      if (row.r2.inspectionResult) return structuredClone(row.r2.inspectionResult);
      const claim = await mutate(args, current => {
        if (current.r2.inspectionTicket) return { first: false, ticket: structuredClone(current.r2.inspectionTicket) };
        const ticket = { ticketId: current.r2.objectVersion, state: "requested", requestedAt: clock(), deadlineMs: 180000 };
        current.r2.inspectionTicket = ticket;
        return { first: true, ticket };
      });
      const request = { context: args.context, ticketId: claim.ticket.ticketId, objectKey: args.objectKey,
        objectVersion: row.r2.objectVersion, etag: row.r2.etag, sizeBytes: row.sizeBytes,
        sha256: row.sha256, kind: row.kind, deadlineMs: 180000 };
      // This is a short metadata RPC. The dispatcher reserves compute quota and
      // persists a unique ticket before running an isolated worker. Never stream
      // media through this API process or repeat a paid job after a lost reply.
      let response;
      if (claim.first) response = await inspector.startInspection(request);
      else response = await inspector.getInspection({ context: args.context, ticketId: claim.ticket.ticketId });
      if (response?.ticketId !== claim.ticket.ticketId) fail("r2_inspection_response_invalid");
      if (response.state === "failed") throw new CalendarImportUploadError("import_media_verification_failed", 422);
      if (response.state !== "ready") fail("r2_inspection_pending");
      const result = response.result;
      if (!result || result.complete !== true || !HASH.test(result.sha256 || "") || !Number.isSafeInteger(result.sizeBytes)) fail("r2_inspection_response_invalid");
      const actual = { complete: true, sizeBytes: result.sizeBytes, sha256: result.sha256,
        decoded: result.decoded === true, signatureVerified: result.signatureVerified === true,
        detectedMime: result.detectedMime, width: result.width, height: result.height,
        ...(row.kind === "image" ? { frames: result.frames } : { durationMs: result.durationMs, hasAudio: result.hasAudio, colorMode: result.colorMode }) };
      if (!(await head(args, row, row.r2.etag))) fail("r2_object_missing");
      await mutate(args, current => {
        if (current.r2.etag !== row.r2.etag || current.r2.phase !== "sealed") fail("r2_object_conflict");
        current.r2.inspectionResult = actual; current.r2.inspectionTicket.state = "ready";
      });
      return actual;
    }); },
    async abortMultipart(args) { return safe(async () => {
      const row = await read(args);
      if (row.state !== "cancel_pending") fail("r2_state_conflict");
      if (!row.r2) { await mutate(args, current => { current.r2 = { schema: 1, phase: "aborted", parts: {} }; }); return { aborted: true, objectExists: false }; }
      if (row.r2.phase === "aborted") return { aborted: true, objectExists: false };
      if (["sealing", "sealed"].includes(row.r2.phase) || await transport.head(args.objectKey)) fail("r2_abort_conflict");
      // Do not report abort while an unresolved Create may still arrive later.
      if (!row.r2.remoteUploadId) fail("r2_begin_reconciliation_required");
      await mutate(args, current => { current.r2.phase = "abort_unknown"; });
      await transport.abort(args.objectKey, row.r2.remoteUploadId);
      if (await transport.head(args.objectKey) || (await transport.findUploads(args.objectKey)).length) fail("r2_abort_pending");
      await mutate(args, current => { current.r2.phase = "aborted"; current.r2.parts = {}; });
      return { aborted: true, objectExists: false };
    }); }
  });
}

module.exports = { createR2PrivateUploadProvider };
