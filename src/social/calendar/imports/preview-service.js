"use strict";
const { isImportAccessPolicy } = require("./access-policy");
const { previewDigest } = require("./policy");
const { isPreparedDiskResultStore } = require("./prepared-disk-store");
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const TARGETS = new Set(["feed", "story", "reel", "thumbnail"]);
const instances = new WeakSet();
const ORIGIN = "https://ia4tube-api.onrender.com";
function fail(code = "unavailable", statusCode = 503) { throw Object.assign(new Error(`import_preview_${code}`), { code: `import_preview_${code}`, statusCode }); }
function input(value, withTarget = false) {
  if (!value || Object.keys(value).some(key => !["assetId", "mediaRevision", ...(withTarget ? ["target"] : [])].includes(key)) ||
      !UUID.test(value.assetId || "") || !Number.isSafeInteger(value.mediaRevision) || value.mediaRevision < 1 || value.mediaRevision > 999999 ||
      withTarget && !TARGETS.has(value.target)) fail("not_found", 404);
}
function descriptor(target, variant) {
  if (!TARGETS.has(target) || !variant || !HASH.test(variant.sha256 || "") || !HASH.test(variant.sourceSha256 || "") ||
      !["image/jpeg", "video/mp4"].includes(variant.mimeType) || !Number.isSafeInteger(variant.size) || variant.size < 1 ||
      variant.size > (variant.mimeType === "image/jpeg" ? 8 : 100) * 1024 ** 2 ||
      !Number.isSafeInteger(variant.width) || !Number.isSafeInteger(variant.height) || variant.width < 1 || variant.height < 1 ||
      typeof variant.hasAudio !== "boolean" || !["none", "original", "muted", "music"].includes(variant.audioMode) ||
      variant.mimeType === "video/mp4" && (!Number.isFinite(variant.durationSeconds) || variant.durationSeconds <= 0 || variant.durationSeconds > 60.25) ||
      target === "thumbnail" && (variant.mimeType !== "image/jpeg" || variant.hasAudio || variant.audioMode !== "none")) fail("result_invalid");
  return { target, kind: variant.mimeType === "video/mp4" ? "video" : "image", mimeType: variant.mimeType,
    sha256: variant.sha256, sourceSha256: variant.sourceSha256, width: variant.width, height: variant.height,
    sizeBytes: variant.size, durationMs: variant.durationSeconds == null ? null : Math.round(variant.durationSeconds * 1000),
    audioMode: variant.audioMode, hasAudio: variant.hasAudio };
}
function parsePreviewRange(header, size) {
  if (!Number.isSafeInteger(size) || size < 1 || size > 100 * 1024 ** 2) fail("result_invalid");
  if (header === undefined) return { start: 0, end: size - 1, length: size, partial: false };
  if (typeof header !== "string" || header.length > 50) fail("range_invalid", 416);
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) fail("range_invalid", 416);
  let start, end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix < 1) fail("range_invalid", 416);
    start = Math.max(0, size - suffix); end = size - 1;
  } else {
    start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) fail("range_invalid", 416);
    end = Math.min(end, size - 1);
  }
  return { start, end, length: end - start + 1, partial: true };
}
function createPrivateImportPreviewService({ preparation, resultStore, accessPolicy, enabled = false, allowVolatileForTests = false } = {}) {
  const available = enabled === true && typeof preparation?.snapshot === "function" && isImportAccessPolicy(accessPolicy) &&
    accessPolicy.executionAvailable && isPreparedDiskResultStore(resultStore, { allowVolatileForTests }) &&
    ["inspectPreview", "streamPreview"].every(key => typeof resultStore[key] === "function");
  function authorize(context) { try { accessPolicy.resolve(context); } catch (_) { fail("not_found", 404); } }
  async function safe(operation) {
    if (!available) fail();
    try { return await operation(); }
    catch (error) {
      if (/^import_preview_[a-z_]{1,70}$/.test(error?.code || "")) fail(error.code.slice(15), [400, 403, 404, 409, 416, 503].includes(error.statusCode) ? error.statusCode : 503);
      fail();
    }
  }
  async function snapshot(context, request) {
    authorize(context);
    const value = await preparation.snapshot(context, { assetId: request.assetId, mediaRevision: request.mediaRevision });
    authorize(context);
    if (!value || value.companyId !== context.companyId || value.userId !== context.userId || value.assetId !== request.assetId ||
        value.mediaRevision !== request.mediaRevision || value.ready !== true || value.state !== "ready" || !UUID.test(value.result?.resultRef || "")) fail("not_found", 404);
    if (value.currentRevision !== request.mediaRevision) fail("changed", 409);
    if (typeof value.result.testOnly !== "boolean" || value.result.testOnly !== value.plan?.testOnly ||
        value.result.testOnly && !allowVolatileForTests || previewDigest(value.plan, value.result.variants) !== value.result.previewDigest) fail("result_invalid");
    return value;
  }
  function url(request, target) { return `${ORIGIN}/v1/social/calendar/imports/assets/${request.assetId}/revisions/${request.mediaRevision}/preview/${target}`; }
  const service = Object.freeze({
    available,
    async metadata(context, request) { return safe(async () => {
      input(request); const value = await snapshot(context, request);
      const variants = value.plan.deliveries.map(part => ({ ...descriptor(part.target, value.result.variants[part.target]), url: url(request, part.target) }));
      const thumbnail = value.result.thumbnail ? { ...descriptor("thumbnail", value.result.thumbnail), url: url(request, "thumbnail") } : null;
      // URLs contain no bearer token, private object key, local path or signature.
      // Their bytes still require the current authenticated owner on every GET.
      return { assetId: value.assetId, mediaRevision: value.mediaRevision, currentRevision: value.currentRevision,
        previewDigest: value.result.previewDigest, testOnly: value.result.testOnly, variants, thumbnail };
    }); },
    async open(context, request, { rangeHeader, signal } = {}) { return safe(async () => {
      input(request, true); const value = await snapshot(context, request);
      const raw = request.target === "thumbnail" ? value.result.thumbnail : value.result.variants[request.target];
      const expected = descriptor(request.target, raw);
      const binding = { context, assetId: request.assetId, mediaRevision: request.mediaRevision,
        resultRef: value.result.resultRef, target: request.target, sha256: expected.sha256 };
      const actual = await resultStore.inspectPreview({ ...binding, signal, timeoutMs: 60000 });
      authorize(context);
      if (!actual || actual.mimeType !== expected.mimeType || actual.sha256 !== expected.sha256 || actual.sizeBytes !== expected.sizeBytes) fail("result_invalid");
      const range = parsePreviewRange(rangeHeader, expected.sizeBytes);
      return Object.freeze({ descriptor: expected, range,
        async stream(consume) { return safe(async () => {
          if (typeof consume !== "function" || signal?.aborted) fail("interrupted");
          const current = await snapshot(context, request);
          if (current.result.resultRef !== value.result.resultRef || current.result.previewDigest !== value.result.previewDigest) fail("changed", 409);
          let count = 0;
          await resultStore.streamPreview({ ...binding, range: { start: range.start, end: range.end }, signal,
            consume: async chunk => {
              authorize(context);
              if (signal?.aborted || !(Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) || chunk.byteLength > 65536 || count + chunk.byteLength > range.length) fail("interrupted");
              count += chunk.byteLength; await consume(chunk);
            } });
          if (count !== range.length) fail("interrupted");
          return { sizeBytes: count };
        }); }
      });
    }); }
  });
  instances.add(service); return service;
}
function isPrivateImportPreviewService(value) { return Boolean(value && instances.has(value)); }
module.exports = { createPrivateImportPreviewService, isPrivateImportPreviewService, parsePreviewRange, descriptor };
