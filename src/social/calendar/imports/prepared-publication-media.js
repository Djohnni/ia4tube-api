"use strict";
const crypto = require("node:crypto");
const { UUID, sameBinding } = require("../model");
const { delivery } = require("../destinations");
const { isPreparedDiskResultStore } = require("./prepared-disk-store");
const { isImportAccessPolicy } = require("./access-policy");
const { previewDigest } = require("./policy");
const { parsePreviewRange } = require("./preview-service");
const { preparedPublicationDescriptor } = require("./publication-descriptor");
const { isLocalPublicationTransport } = require("./publication-test-transport");
const { isCalendarStore } = require("../store");
const instances = new WeakSet(), ID = /^[a-f0-9]{40}$/, HASH = /^[a-f0-9]{64}$/;
function fail() { throw Object.assign(new Error("Mídia de publicação indisponível."), { code: "calendar_import_publication_media_unavailable", statusCode: 404 }); }
function createPreparedCalendarMedia({ store, preparation, resultStore, accessPolicy, grants, resolveConnection,
  secret, publicOrigin, enabled = false, localTransport = null, clock = Date.now } = {}) {
  const local = isLocalPublicationTransport(localTransport);
  const available = enabled === true && isCalendarStore(store) && typeof preparation?.snapshot === "function" &&
    isPreparedDiskResultStore(resultStore, { allowVolatileForTests: local }) && isImportAccessPolicy(accessPolicy) &&
    typeof grants?.verify === "function" && typeof resolveConnection === "function" && typeof clock === "function" &&
    (Buffer.isBuffer(secret) ? secret.length >= 32 : typeof secret === "string" && secret.length >= 32) &&
    publicOrigin === "https://ia4tube-api.onrender.com";
  const key = available ? crypto.createHmac("sha256", secret).update("ia4tube-prepared-publication-media-v1").digest() : null;
  let closed = false;
  function ready() { if (!available || closed) fail(); }
  function seconds() { const value = clock(); if (!Number.isSafeInteger(value) || value < 0) fail(); return Math.floor(value / 1000); }
  function authorize(context) { ready(); try { accessPolicy.resolve(context); } catch { fail(); } }
  function sign(parts) { return crypto.createHmac("sha256", key).update(JSON.stringify(parts)).digest("hex"); }
  async function current(context, job, requireIntent = true) {
    authorize(context);
    const saved = await store.update(context.companyId, state => state.jobs[job.id]);
    if (!saved || saved.sourceKind !== "upload" || saved.import?.userId !== context.userId ||
        saved.phase === "cancelled" || !saved.selectedTargets?.includes(job.target)) fail();
    const part = delivery(saved, job.target), value = preparedPublicationDescriptor(context.companyId, part);
    const expected = preparedPublicationDescriptor(context.companyId, job);
    if (value.metadataDigest !== expected.metadataDigest || value.testOnly && !local ||
        requireIntent && (!job.intent || part.intent?.publicationId !== job.intent.publicationId ||
          part.intent?.requestHash !== job.intent.requestHash)) fail();
    const grant = grants.verify(saved.authorization?.envelope, context.companyId, context.userId);
    const connection = await resolveConnection(context, grant);
    if (!grant || grant.sourceKind !== "upload" || grant.jobId !== saved.id || grant.assetId !== value.assetId ||
        grant.assetRevision !== value.mediaRevision || grant.previewDigest !== value.previewDigest ||
        !sameBinding(grant.binding, connection?.binding) || job.target === "story" && connection.accountType !== "business") fail();
    authorize(context); return { job: part, descriptor: value };
  }
  async function inspect(context, job, requireIntent = true, signal) {
    const started = performance.now();
    const remaining = () => { const value = Math.floor(60000 - (performance.now() - started)); if (signal?.aborted || value < 1) fail(); return value; };
    remaining();
    const saved = await current(context, job, requireIntent), value = saved.descriptor;
    const snapshot = await preparation.snapshot(context, { assetId: value.assetId, mediaRevision: value.mediaRevision });
    if (!snapshot?.ready || snapshot.state !== "ready" || snapshot.companyId !== context.companyId || snapshot.userId !== context.userId ||
        snapshot.result?.resultRef !== value.resultRef || snapshot.result?.previewDigest !== value.previewDigest ||
        previewDigest(snapshot.plan, snapshot.result.variants) !== value.previewDigest ||
        snapshot.result.testOnly !== value.testOnly) fail();
    const selected = snapshot.result.variants[value.target], object = snapshot.result.objects?.[value.target];
    const planned = snapshot.plan.deliveries.find(item => item.target === value.target);
    if (!selected || !object || !planned || object.objectKey !== value.objectKey || object.objectVersion !== value.objectVersion ||
        object.sha256 !== value.sha256 || object.sizeBytes !== value.sizeBytes || selected.sha256 !== value.sha256 ||
        selected.size !== value.sizeBytes || selected.mimeType !== value.mimeType || selected.width !== value.width ||
        selected.height !== value.height || selected.hasAudio !== value.hasAudio || selected.audioMode !== value.audioMode ||
        (selected.durationSeconds ?? null) !== value.durationSeconds || planned.shareToFeed !== value.shareToFeed) fail();
    for (const [target, part] of Object.entries(snapshot.result.variants)) {
      const actual = await resultStore.inspectPreview({ context, assetId: value.assetId, mediaRevision: value.mediaRevision,
        resultRef: value.resultRef, target, sha256: part.sha256, timeoutMs: remaining(), ...(signal ? { signal } : {}) });
      if (actual.sha256 !== part.sha256 || actual.mimeType !== part.mimeType || actual.sizeBytes !== part.size ||
          actual.width !== part.width || actual.height !== part.height || actual.hasAudio !== part.hasAudio ||
          actual.audioMode !== part.audioMode || (actual.durationSeconds ?? null) !== (part.durationSeconds ?? null)) fail();
    }
    if (snapshot.result.thumbnail) await resultStore.inspectPreview({ context, assetId: value.assetId,
      mediaRevision: value.mediaRevision, resultRef: value.resultRef, target: "thumbnail", sha256: snapshot.result.thumbnail.sha256,
      timeoutMs: remaining(), ...(signal ? { signal } : {}) });
    remaining(); await current(context, job, requireIntent); remaining(); return saved;
  }
  const api = Object.freeze({ available, localTransport: local ? localTransport : null,
    descriptor(companyId, job) { ready(); return preparedPublicationDescriptor(companyId, job); },
    async verify(context, job) { await inspect(context, job, false); return true; },
    async resolveOwnedPreparedMedia(context, id, job) {
      const { descriptor } = await inspect(context, job);
      if (id !== descriptor.mediaId) fail();
      const expires = seconds() + 900;
      const parts = [context.companyId, job.id, job.target, job.intent.publicationId, expires, descriptor.metadataDigest];
      const signature = sign(parts);
      return { ...descriptor, publicUrl: `${publicOrigin}/v1/social/calendar/media/prepared/${context.companyId}/${job.id}/${job.target}/${job.intent.publicationId}/${descriptor.metadataDigest}/${expires}/${signature}` };
    },
    async publicMedia(params, { rangeHeader, signal } = {}) {
      ready(); const { company, id, target, publicationId, metadataDigest, expires, signature } = params;
      if (!UUID.test(company || "") || !ID.test(id || "") || !["feed", "story", "reel"].includes(target) ||
          !UUID.test(publicationId || "") || !HASH.test(metadataDigest || "") || !/^\d{10}$/.test(expires || "") || !HASH.test(signature || "")) fail();
      const now = seconds();
      if (Number(expires) < now || Number(expires) > now + 900) fail();
      const expected = sign([company, id, target, publicationId, Number(expires), metadataDigest]);
      if (!crypto.timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"))) fail();
      const job = await store.update(company, state => state.jobs[id]);
      if (!job) fail();
      const part = delivery(job, target), context = { authenticated: true, companyId: company, userId: job.import?.userId };
      const value = preparedPublicationDescriptor(company, part);
      if (value.metadataDigest !== metadataDigest || part.intent?.publicationId !== publicationId) fail();
      await inspect(context, part, true, signal);
      const range = parsePreviewRange(rangeHeader, value.sizeBytes);
      return { descriptor: value, range, async stream(consume) {
        return resultStore.streamPreview({ context, assetId: value.assetId, mediaRevision: value.mediaRevision, resultRef: value.resultRef,
          target, sha256: value.sha256, range: { start: range.start, end: range.end }, signal, timeoutMs: 60000,
          consume: async bytes => { if (Number(expires) < seconds()) fail(); await current(context, part); await consume(bytes); } });
      } };
    },
    close() { closed = true; key?.fill(0); }
  });
  if (available) instances.add(api); return api;
}
function isPreparedCalendarMedia(value) { return instances.has(value) && value.available; }
module.exports = { createPreparedCalendarMedia, isPreparedCalendarMedia };
