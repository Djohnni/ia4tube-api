"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const model = require("../src/social/calendar/model");
const destinations = require("../src/social/calendar/destinations");
const { createCalendarGrants } = require("../src/social/calendar/grants");
const { publicationPlan, previewDigest } = require("../src/social/calendar/imports/policy");
const { schedulePreparedImport } = require("../src/social/calendar/imports/calendar-entry");
const { createImportAccessPolicy } = require("../src/social/calendar/imports/access-policy");
const hash = text => crypto.createHash("sha256").update(text).digest("hex");

// Contract-only synthetic records. Actual decode tests live in preparation.test.
function fixture(kind = "video") {
  const context = { authenticated: true, companyId: crypto.randomUUID(), userId: crypto.randomUUID() };
  const accessPolicy = createImportAccessPolicy({ allowedOwners: [context] });
  const now = model.dateTime("2026-09-12", "12:00"), state = model.freshState();
  const selection = kind === "video" ? { kind, targets: ["story", "reel"], audioMode: "original", shareToFeed: true }
    : { kind, targets: ["feed", "story"], audioMode: "none" };
  const source = { kind, format: kind === "video" ? "mp4" : "jpeg", decoded: true, frames: 1,
    sha256: hash("synthetic-source"), width: 1080, height: 1920, size: 1024,
    hasAudio: true, durationSeconds: 30, colorMode: "sdr" };
  const plan = publicationPlan(selection, source);
  const variants = Object.fromEntries(plan.deliveries.map(part => [part.target, {
    sha256: hash("synthetic-" + part.target), sourceSha256: source.sha256, mimeType: part.mimeType,
    width: part.width, height: part.height, size: 4096, durationSeconds: part.durationSeconds,
    audioMode: part.audioMode, hasAudio: part.audioMode === "original"
  }]));
  const objects = Object.fromEntries(Object.entries(variants).map(([key, variant]) => [key, {
    objectKey: hash("synthetic-object-" + key), objectVersion: crypto.randomUUID(), sha256: variant.sha256, sizeBytes: variant.size
  }]));
  const prepared = { ...context, assetId: crypto.randomUUID(), mediaRevision: 1, ready: true, state: "ready",
    currentRevision: 1, selection: plan.selection, plan,
    result: { variants, objects, testOnly: false, previewDigest: previewDigest(plan, variants) } };
  const input = { assetId: prepared.assetId, mediaRevision: 1, previewDigest: prepared.result.previewDigest,
    idempotencyKey: crypto.randomUUID(), date: "2026-09-13", time: "09:00", caption: "Conteúdo sintético controlado",
    automatic: false, confirmed: true };
  const binding = { connectionId: crypto.randomUUID(), externalId: "1234567890123", connectionRevision: 1 };
  const grants = createCalendarGrants(crypto.randomBytes(32), () => now);
  function grant(request = input, extra = {}) {
    const sourceKey = `upload:${request.assetId}:${hash(context.userId + ":" + request.idempotencyKey)}`;
    return grants.issueImport({ ...context, binding, revision: state.preferences.revision, assetId: request.assetId,
      assetRevision: request.mediaRevision, previewDigest: request.previewDigest, jobId: model.idFor(context.companyId, sourceKey), ...extra });
  }
  const schedule = (request = input, snapshot = prepared, options = {}) => schedulePreparedImport(state, context, request, snapshot, { now, accessPolicy, ...options });
  return { context, state, now, prepared, input, binding, grants, grant, schedule, accessPolicy };
}

test("photo and video enter the existing jobs without generation orders or credits", () => {
  for (const kind of ["image", "video"]) {
    const f = fixture(kind), job = f.schedule();
    assert.equal(job.sourceKind, "upload"); assert.equal(job.orderId, null); assert.equal(job.planningId, null);
    assert.equal(job.automaticEnabled, false); assert.equal(job.authorization, null);
    assert.deepEqual(Object.keys(f.state).sort(), ["jobs", "preferences", "schema"]);
    assert.deepEqual(destinations.targets(job), f.prepared.plan.deliveries.map(part => part.target));
    assert.equal(job.assets.story.mimeType, kind === "image" ? "image/jpeg" : "video/mp4");
  }
});
test("schedule retry is canonical across JSON key order and preserves edits and cancellation", () => {
  const f = fixture(), first = f.schedule();
  const reordered = Object.fromEntries(Object.entries(f.input).reverse());
  assert.equal(f.schedule(reordered).id, first.id);
  model.changeJob(f.state, first.id, { action: "caption", caption: "Legenda corrigida", revision: 1 }, f.now);
  assert.equal(f.schedule().caption, "Legenda corrigida");
  model.changeJob(f.state, first.id, { action: "cancel", revision: 2 }, f.now);
  assert.equal(f.schedule().phase, "cancelled"); assert.equal(Object.keys(f.state.jobs).length, 1);
  assert.throws(() => f.schedule({ ...f.input, time: "10:00" }), { code: "calendar_import_idempotency_conflict" });
});
test("imports survive ordinary source synchronization and cannot overwrite other owners", () => {
  const f = fixture(), job = f.schedule();
  model.syncSources(f.state, [], f.context.companyId, f.now);
  assert.equal(f.state.jobs[job.id].phase, "ready");
  for (const field of ["companyId", "userId", "assetId"]) {
    assert.throws(() => f.schedule(f.input, { ...f.prepared, [field]: crypto.randomUUID() }), { code: "calendar_import_prepared_media_unavailable" });
  }
});
test("uninspected, altered, synthetic-only or mismatched immutable media cannot be scheduled", () => {
  const f = fixture();
  for (const mutate of [p => p.ready = false, p => p.result.testOnly = true, p => p.plan.testOnly = true,
    p => p.mediaRevision++, p => p.result.objects.story.sha256 = "f".repeat(64),
    p => p.result.objects.story.objectKey = "https://untrusted.invalid/file",
    p => p.result.objects.story.sizeBytes++, p => delete p.result.objects.reel]) {
    const copy = structuredClone(f.prepared); mutate(copy);
    assert.throws(() => f.schedule(f.input, copy), { code: "calendar_import_prepared_media_unavailable" });
  }
  assert.throws(() => f.schedule({ ...f.input, previewDigest: "a".repeat(64) }), { code: "calendar_import_preview_changed" });
  assert.equal(Object.keys(f.state.jobs).length, 0);
});
test("schedule validates explicit preview confirmation, captions, future slot and reserved metadata", () => {
  const f = fixture();
  for (const extra of [{ confirmed: false }, { automatic: "true" }, { objectKey: "x" }, { mediaRevision: 0 }]) {
    assert.throws(() => f.schedule({ ...f.input, ...extra }), { code: "calendar_import_schedule_invalid" });
  }
  assert.throws(() => f.schedule({ ...f.input, date: "2026-09-11" }), { code: "calendar_import_time_outside_window" });
  assert.throws(() => f.schedule({ ...f.input, caption: "" }), { code: "calendar_import_caption_required" });
  f.schedule();
  assert.throws(() => f.schedule({ ...f.input, idempotencyKey: crypto.randomUUID() }), { code: "calendar_import_time_occupied" });
});
test("automatic entry requires branded owner/media/job/binding/preference consent", () => {
  const f = fixture(), input = { ...f.input, automatic: true };
  f.state.preferences.binding = f.binding;
  const envelope = f.grant(input), authorization = f.grants.verify(envelope, f.context.companyId, f.context.userId);
  const options = { envelope, authorization, connectionBinding: f.binding };
  assert.throws(() => f.schedule(input), { code: "calendar_import_consent_changed" });
  assert.throws(() => f.schedule(input, f.prepared, { ...options, authorization: { ...authorization } }), { code: "calendar_import_consent_changed" });
  assert.throws(() => f.schedule(input, f.prepared, { ...options, connectionBinding: { ...f.binding, connectionRevision: 2 } }), { code: "calendar_import_consent_changed" });
  const wrongEnvelope = f.grant(input, { assetRevision: 2 });
  assert.throws(() => f.schedule(input, f.prepared, { ...options, authorization: f.grants.verify(wrongEnvelope, f.context.companyId, f.context.userId) }), { code: "calendar_import_consent_changed" });
  f.state.preferences.enabled = false;
  assert.throws(() => f.schedule(input, f.prepared, options), { code: "calendar_import_consent_changed" });
  f.state.preferences.enabled = true;
  const job = f.schedule(input, f.prepared, options);
  assert.equal(job.automaticEnabled, true); assert.equal(job.authorization.assetId, input.assetId);
  assert.equal(model.availability(job, f.state.preferences, f.binding, true, f.now), "import_not_operational");
});
test("import grants are distinct from existing order grants and are nontransferable", () => {
  const f = fixture(), envelope = f.grant();
  assert.equal(f.grants.verify(envelope, crypto.randomUUID(), f.context.userId), null);
  assert.equal(f.grants.verify(envelope + "0", f.context.companyId, f.context.userId), null);
  assert.throws(() => f.grant(f.input, { jobId: null }), { code: "calendar_consent_invalid" });
  const legacy = f.grants.issue({ ...f.context, binding: f.binding, revision: 1, planningId: "synthetic-plan", quantity: 3 });
  assert.equal(f.grants.verify(legacy, f.context.companyId, f.context.userId).quantity, 3);
  assert.equal(f.grants.verify(envelope, f.context.companyId, f.context.userId).planningId, null);
});
test("caption, time, pause and delete reuse one imported job; changing format requires new preview", () => {
  const f = fixture(), job = f.schedule();
  model.changeJob(f.state, job.id, { action: "schedule", revision: 1, date: "2026-09-14", time: "16:30" }, f.now);
  model.changeJob(f.state, job.id, { action: "automatic", revision: 2, enabled: false }, f.now);
  assert.throws(() => model.changeJob(f.state, job.id, { action: "destination", revision: 3, destination: "feed", confirmed: true }, f.now), { code: "calendar_formats_not_ready" });
  model.changeJob(f.state, job.id, { action: "cancel", revision: 3 }, f.now);
  assert.equal(Object.keys(f.state.jobs).length, 1);
  assert.equal(f.state.jobs[job.id].time, "16:30"); assert.equal(f.state.jobs[job.id].phase, "cancelled");
});

test("music rights are checked again for the scheduled date instead of trusting an old preview", () => {
  const f = fixture("image"), track = { id: "synthetic-license-fixture", sha256: hash("synthetic-track"), durationSeconds: 20,
    evidenceId: "synthetic-evidence", instagramCommercialUse: true, companyAllowlist: [f.context.companyId],
    validFrom: f.now - 1000, validUntil: f.now + 10 * 86400000 };
  const catalog = new Map([[track.id, track]]);
  const plan = publicationPlan({ kind: "image", targets: ["story"], audioMode: "music", musicTrackId: track.id, musicalTargets: ["story"] },
    { kind: "image", format: "jpeg", frames: 1, decoded: true, width: 1080, height: 1920, size: 1024, sha256: hash("synthetic-source") },
    { catalog, companyId: f.context.companyId, now: f.now });
  const variants = { story: { ...f.prepared.result.variants.story, mimeType: "video/mp4", audioMode: "music",
    durationSeconds: 15, musicSha256: track.sha256, hasAudio: true } };
  f.prepared.selection = plan.selection; f.prepared.plan = plan;
  f.prepared.result.variants = variants; delete f.prepared.result.objects.feed;
  f.input.previewDigest = f.prepared.result.previewDigest = previewDigest(plan, variants);
  assert.throws(() => f.schedule(), { code: "calendar_import_music_license_unavailable" });
  track.validUntil = f.now + 3600000;
  assert.throws(() => f.schedule(f.input, f.prepared, { catalog }), { code: "calendar_import_music_license_unavailable" });
  track.validUntil = f.now + 10 * 86400000;
  track.sha256 = hash("replacement-track");
  assert.throws(() => f.schedule(f.input, f.prepared, { catalog }), { code: "calendar_import_preview_changed" });
  track.sha256 = variants.story.musicSha256;
  const customerPolicy = createImportAccessPolicy({ mode: "multi_company", allowedOwners: [{ ...f.context, audience: "customers" }] });
  assert.throws(() => f.schedule(f.input, f.prepared, { catalog, accessPolicy: customerPolicy }), { code: "calendar_import_music_license_unavailable" });
  track.endUserSublicensing = true;
  const customerJob = f.schedule(f.input, f.prepared, { catalog, accessPolicy: customerPolicy });
  assert.equal(customerJob.import.accessAudience, "customers");
  assert.equal(f.schedule(f.input, f.prepared, { catalog }).sourceKind, "upload");
});

test("scheduling needs server-trusted current eligibility, including retries; client audience cannot override it", () => {
  const f = fixture(); let eligible = true;
  const accessPolicy = createImportAccessPolicy({ allowedOwners: [f.context], isEligible: () => eligible });
  assert.throws(() => f.schedule(f.input, f.prepared, { accessPolicy: null }), { code: "calendar_import_access_unavailable" });
  assert.throws(() => f.schedule(f.input, f.prepared, { accessPolicy: { resolve: () => ({ audience: "owner_pilot" }) } }), { code: "calendar_import_access_unavailable" });
  assert.throws(() => f.schedule({ ...f.input, audience: "owner_pilot" }, f.prepared, { accessPolicy }), { code: "calendar_import_schedule_invalid" });
  const first = f.schedule(f.input, f.prepared, { accessPolicy });
  eligible = false;
  assert.throws(() => f.schedule(f.input, f.prepared, { accessPolicy }), { code: "calendar_import_not_allowed" });
  assert.equal(Object.keys(f.state.jobs).length, 1); assert.equal(f.state.jobs[first.id].phase, "ready");
});
