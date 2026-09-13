"use strict";
const crypto = require("node:crypto");
const { UUID, idFor, MAX_ITEMS, dateTime, caption, LATE_MS, sameBinding } = require("../model");
const { previewDigest, licensedTrack } = require("./policy");
const { isVerifiedCalendarGrant } = require("../grants");
const { isImportAccessPolicy } = require("./access-policy");
const { isLocalCalendarState } = require("./local-calendar-simulation");
const { isLocalPublicationState } = require("./publication-test-transport");
const HASH = /^[a-f0-9]{64}$/;
function fail(code, statusCode = 409) { throw Object.assign(new Error("Confira a mídia e a programação."), { code: `calendar_import_${code}`, statusCode }); }
function validatePrepared(context, value, input, localState = null, localSimulation = null, localTransport = null) {
  // value comes only from preparation.snapshot(), never the HTTP request body.
  if (!context || context.authenticated !== true || !UUID.test(context.companyId || "") || !UUID.test(context.userId || "") ||
      !value || value.ready !== true || value.state !== "ready" || value.companyId !== context.companyId || value.userId !== context.userId ||
      value.assetId !== input.assetId || value.mediaRevision !== input.mediaRevision || !value.plan || !value.result ||
      typeof value.result.testOnly !== "boolean" || value.result.testOnly !== value.plan.testOnly ||
      value.result.testOnly && !isLocalCalendarState(localState, localSimulation) &&
        !isLocalPublicationState(localState, localTransport)) fail("prepared_media_unavailable");
  const result = value.result;
  if (!HASH.test(input.previewDigest || "") || input.previewDigest !== result.previewDigest ||
      previewDigest(value.plan, result.variants) !== input.previewDigest) fail("preview_changed");
  const keys = value.plan.deliveries.map(delivery => delivery.target);
  if (!result.objects || Object.keys(result.objects).length !== keys.length) fail("prepared_media_unavailable");
  for (const key of keys) {
    const object = result.objects[key], variant = result.variants[key];
    if (!object || !/^[a-f0-9]{64}$/.test(object.objectKey || "") || !UUID.test(object.objectVersion || "") ||
        object.sha256 !== variant.sha256 || !Number.isSafeInteger(object.sizeBytes) || object.sizeBytes < 1 || object.sizeBytes !== variant.size) fail("prepared_media_unavailable");
  }
  return value;
}

/** Pure owner_state transaction mutation. Same jobs collection as generated art;
 * no synthetic creation order, billing credit, network call or separate publicador.
 * Admission is deliberately separate from worker enablement/Meta authorization.
 */
function schedulePreparedImport(state, context, input, snapshot, { now, authorization = null, envelope = null, connectionBinding = null, catalog = null, accessPolicy = null, localSimulation = null, localTransport = null } = {}) {
  const allowed = ["assetId", "mediaRevision", "previewDigest", "idempotencyKey", "date", "time", "caption", "automatic", "confirmed"];
  if (!input || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key)) ||
      !UUID.test(input.assetId || "") || !Number.isSafeInteger(input.mediaRevision) || input.mediaRevision < 1 ||
      !/^[A-Za-z0-9_-]{8,128}$/.test(input.idempotencyKey || "") || input.confirmed !== true ||
      typeof input.automatic !== "boolean" || !Number.isSafeInteger(now) || now < 0) fail("schedule_invalid", 400);
  if (!state || state.schema !== 1 || !state.jobs || !state.preferences) fail("state_invalid", 503);
  // A previously prepared preview is not a current eligibility grant. Resolve
  // from trusted configuration again, including on idempotent scheduling retries.
  let audience;
  if (!isImportAccessPolicy(accessPolicy)) fail("access_unavailable", 503);
  try { audience = accessPolicy.resolve(context).audience; }
  catch (_) { fail("not_allowed", 403); }
  const local = isLocalCalendarState(state, localSimulation) || isLocalPublicationState(state, localTransport);
  const prepared = validatePrepared(context, snapshot, input, state, localSimulation, localTransport);
  const sourceKey = `upload:${input.assetId}:${crypto.createHash("sha256").update(context.userId + ":" + input.idempotencyKey).digest("hex")}`;
  const id = idFor(context.companyId, sourceKey);
  const text = caption(input.caption ?? "");
  const inputHash = crypto.createHash("sha256").update(JSON.stringify([
    input.assetId, input.mediaRevision, input.previewDigest, input.idempotencyKey,
    input.date, input.time, text, input.automatic, input.confirmed
  ])).digest("hex");
  const existing = state.jobs[id];
  if (existing) {
    if (existing.sourceKind !== "upload" || existing.import?.inputHash !== inputHash || existing.import?.userId !== context.userId) fail("idempotency_conflict");
    // Preserve the latest edit/pause/cancel/confirmed result after an uncertain POST.
    return structuredClone(existing);
  }
  if (Object.keys(state.jobs).length >= MAX_ITEMS) fail("capacity_reached");
  if (prepared.currentRevision !== input.mediaRevision) fail("preview_changed");
  const at = dateTime(input.date, input.time);
  if (at <= now || at > now + 180 * 86400000) fail("time_outside_window", 400);
  if (prepared.selection.audioMode === "music") {
    const track = licensedTrack(catalog, prepared.selection.musicTrackId,
      { companyId: context.companyId, now, publishAt: at, audience, testMode: local });
    if (prepared.plan.deliveries.some(part => part.audioMode === "music" && part.musicSha256 !== track.sha256)) fail("preview_changed");
  }
  if (Object.values(state.jobs).some(job => job.phase !== "cancelled" && job.scheduledAt === at)) fail("time_occupied");
  const selectedTargets = prepared.plan.deliveries.map(item => item.target);
  if (!text && selectedTargets.some(target => target !== "story")) fail("caption_required", 400);
  if (input.automatic) {
    if (!isVerifiedCalendarGrant(authorization) || authorization.sourceKind !== "upload" || authorization.companyId !== context.companyId ||
        authorization.userId !== context.userId || authorization.assetId !== input.assetId || authorization.assetRevision !== input.mediaRevision ||
        authorization.previewDigest !== input.previewDigest || authorization.jobId !== id || authorization.validUntil <= at + LATE_MS ||
        !sameBinding(authorization.binding, connectionBinding) || !state.preferences.enabled ||
        state.preferences.revision !== authorization.preferenceRevision || !sameBinding(state.preferences.binding, connectionBinding) ||
        typeof envelope !== "string") fail("consent_changed");
  }
  const assets = Object.fromEntries(selectedTargets.map(target => [target, {
    ...prepared.result.variants[target], ...prepared.result.objects[target],
    kind: prepared.result.variants[target].mimeType === "video/mp4" ? "video" : "image",
    shareToFeed: prepared.plan.deliveries.find(item => item.target === target).shareToFeed,
    metadataDigest: input.previewDigest
  }]));
  const first = selectedTargets[0];
  const job = {
    id, sourceKey, sourceKind: "upload", planningId: null, orderId: null,
    title: prepared.selection.kind === "video" ? "Vídeo da galeria" : "Foto da galeria",
    date: input.date, time: input.time, scheduledAt: at, caption: text,
    revision: 1, phase: "ready", error: null, asset: assets[first], assets,
    layout: "import_prepared_v1", selectedTargets, destination: selectedTargets.length === 1 ? first : "multiple",
    authorization: input.automatic ? { ...authorization, envelope } : null,
    automaticEnabled: input.automatic, sourceVersion: input.previewDigest,
    import: { assetId: input.assetId, mediaRevision: input.mediaRevision, previewDigest: input.previewDigest,
      userId: context.userId, inputHash, sourceSha256: prepared.plan.sourceSha256, selection: prepared.selection, accessAudience: audience },
    createdAt: now, updatedAt: now
  };
  state.jobs[id] = job;
  return structuredClone(job);
}
module.exports = { schedulePreparedImport, validatePrepared };
