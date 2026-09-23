"use strict";
const { isCalendarStore } = require("../store");
const { isImportUploadPostgresStore } = require("./postgres-store");
const { createImportAccessPolicy } = require("./access-policy");
const { createPreparedDiskResultReader } = require("./prepared-disk-store");
const { parsePreviewRange } = require("./preview-service");
const { previewDigest } = require("./policy");
const readers = new WeakSet();
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const ID = /^[a-f0-9]{40}$/;
const ORIGIN = "https://ia4tube-api.onrender.com/v1/social/calendar/imports";
function fail(code = "unavailable", statusCode = 503) {
  throw Object.assign(new Error(`import_preview_${code}`), { code: `import_preview_${code}`, statusCode });
}
function owner(context) {
  if (context?.authenticated !== true || !UUID.test(context.companyId || "") || !UUID.test(context.userId || "")) fail("not_found", 404);
}
function owned(job, context) {
  owner(context);
  if (!job || !ID.test(job.id || "") || job.sourceKind !== "upload" || job.import?.operational !== true ||
      job.import.userId !== context.userId || job.phase === "cancelled") fail("not_found", 404);
  return job;
}
function describe(job, context) {
  owned(job, context);
  const value = job.import.preview;
  if (!value || value.assetId !== job.import.assetId || value.mediaRevision !== job.import.mediaRevision ||
      value.previewDigest !== job.import.previewDigest || !Array.isArray(value.variants)) fail("changed", 409);
  const url = target => `${ORIGIN}/schedules/${job.id}/preview/${target}`;
  return { ...structuredClone(value), currentRevision: value.mediaRevision, sourceKind: job.import.originKind || "upload",
    shareToFeed: job.import.selection.shareToFeed === true,
    variants: value.variants.map(item => ({ ...item, url: url(item.target) })),
    thumbnail: value.thumbnail ? { ...value.thumbnail, url: url("thumbnail") } : null };
}
/** Permanent owner-authenticated calendar reads, independent of admission,
 * processing windows and pilot secrets. It cannot upload, schedule or publish.
 */
function createStoredCalendarMediaReader({ store, uploadStore, rootDirectory, preparationRoot, clock = Date.now } = {}) {
  if (!isCalendarStore(store) || !isImportUploadPostgresStore(uploadStore) ||
      typeof store.read !== "function" || typeof uploadStore.read !== "function") fail();
  let closed = false;
  async function read(context, id) {
    if (closed) fail(); owner(context);
    if (!ID.test(id || "")) fail("not_found", 404);
    return store.read(context.companyId, state => owned(state.jobs[id], context));
  }
  const service = Object.freeze({
    available: true, store,
    describe(job, context) {
      // Calendar history can contain an older/non-operational import. Preserve
      // its title/date/caption without advertising bytes or breaking the list.
      try { if (closed) return null; return describe(job, context); } catch { return null; }
    },
    async metadata(context, { id }) { return describe(await read(context, id), context); },
    async open(context, { id, target }, { rangeHeader, signal } = {}) {
      const job = await read(context, id), media = describe(job, context);
      const expected = target === "thumbnail" ? media.thumbnail : media.variants.find(item => item.target === target);
      if (!expected) fail("not_found", 404);
      const snapshot = await uploadStore.read(context.companyId, state => {
        const asset = state.preparation?.assets?.[media.assetId];
        const prepared = state.preparation?.jobs?.[asset?.revisions?.[String(media.mediaRevision)]];
        if (!asset || asset.userId !== context.userId || !prepared || prepared.userId !== context.userId ||
            prepared.companyId !== context.companyId || prepared.state !== "ready") fail("not_found", 404);
        return { plan: prepared.plan, result: prepared.result };
      });
      if (snapshot.result?.resultRef !== job.import.resultRef || snapshot.result?.previewDigest !== media.previewDigest ||
          previewDigest(snapshot.plan, snapshot.result.variants) !== media.previewDigest) fail("changed", 409);
      // Eligibility to read this exact stored item follows its existing owner,
      // not the now-retired pilot allowlist. This policy is never used to launch.
      const accessPolicy = createImportAccessPolicy({ allowedOwners: [{ companyId: context.companyId, userId: context.userId }],
        isEligible: () => !closed });
      const bytes = createPreparedDiskResultReader({ rootDirectory, preparationRoot, tenantStore: uploadStore, accessPolicy, enabled: true, clock });
      const binding = { context, assetId: media.assetId, mediaRevision: media.mediaRevision,
        resultRef: job.import.resultRef, target, sha256: expected.sha256 };
      const actual = await bytes.inspectPreview({ ...binding, signal, timeoutMs: 60000 });
      if (actual.sha256 !== expected.sha256 || actual.mimeType !== expected.mimeType || actual.sizeBytes !== expected.sizeBytes) fail("changed", 409);
      const range = parsePreviewRange(rangeHeader, expected.sizeBytes);
      return { descriptor: expected, range, async stream(consume) {
        let count = 0;
        await bytes.streamPreview({ ...binding, range: { start: range.start, end: range.end }, signal,
          consume: async chunk => {
            const current = await read(context, id);
            if (signal?.aborted || current.import.previewDigest !== media.previewDigest ||
                chunk.byteLength > 65536 || count + chunk.byteLength > range.length) fail("changed", 409);
            count += chunk.byteLength; await consume(chunk);
          } });
        if (count !== range.length) fail("changed", 409);
        return { sizeBytes: count };
      } };
    },
    close() { closed = true; }
  });
  readers.add(service); return service;
}
function isStoredCalendarMediaReader(value) { return readers.has(value); }
module.exports = { createStoredCalendarMediaReader, isStoredCalendarMediaReader };
