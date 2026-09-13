"use strict";

// Local pilot contract. These bounds are product decisions, not universal Meta limits.
// This module neither authorizes provider operations nor provisions storage.
const crypto = require("node:crypto");
const LIMITS = Object.freeze({ imageBytes: 32 * 1024 * 1024, imagePixels: 25_000_000,
  videoBytes: 100 * 1024 * 1024, videoPixels: 8_294_400, videoDimension: 4096,
  videoSeconds: 60, photoClipSeconds: 15,
  chunkBytes: 5 * 1024 * 1024, captionCharacters: 2200 });
const FORMATS = Object.freeze({ image: Object.freeze(["jpeg", "png", "webp"]),
  video: Object.freeze(["mp4", "mov"]) });
const TARGET_ORDER = Object.freeze(["feed", "story", "reel"]);
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-zA-Z0-9_-]{1,100}$/;
function fail(code) {
  const error = new Error("Confira o arquivo, o formato e o áudio antes de programar.");
  error.code = `calendar_import_${code}`; error.statusCode = 400; throw error;
}
function record(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(code);
  return value;
}
function exactKeys(value, keys) {
  if (Object.keys(value).some(key => !keys.includes(key))) fail("unexpected_field");
}
function targets(value, allowEmpty = false) {
  if (!Array.isArray(value) || (!allowEmpty && !value.length) || value.length > 3 ||
      value.some(target => !TARGET_ORDER.includes(target)) || new Set(value).size !== value.length) fail("destinations_invalid");
  return Object.freeze(TARGET_ORDER.filter(target => value.includes(target)));
}
function selection(input) {
  record(input, "selection_invalid");
  exactKeys(input, ["kind", "targets", "audioMode", "musicTrackId", "musicalTargets", "shareToFeed"]);
  if (!Object.hasOwn(FORMATS, input.kind)) fail("kind_invalid");
  const chosen = targets(input.targets);
  const musical = targets(input.musicalTargets ?? [], true);
  if (input.shareToFeed !== undefined && typeof input.shareToFeed !== "boolean") fail("share_to_feed_invalid");
  const shareToFeed = input.shareToFeed === true;
  if (shareToFeed && !chosen.includes("reel")) fail("share_to_feed_requires_reel");
  if (input.kind === "video") {
    if (chosen.includes("feed")) fail("video_feed_is_reel");
    if (!["original", "muted"].includes(input.audioMode) || musical.length || input.musicTrackId != null) fail("video_audio_invalid");
  } else if (input.audioMode === "none") {
    if (chosen.includes("reel") || musical.length || input.musicTrackId != null) fail("photo_audio_invalid");
  } else if (input.audioMode === "music") {
    if (!ID.test(input.musicTrackId || "") || !musical.length || musical.includes("feed") ||
        musical.some(target => !chosen.includes(target)) || (chosen.includes("reel") && !musical.includes("reel"))) fail("photo_music_invalid");
  } else fail("photo_audio_invalid");
  // A Reel can appear in Feed itself. A separate Feed photo alongside it must be explicit,
  // but do not offer duplicate Feed delivery under the same initial selection.
  if (chosen.includes("feed") && shareToFeed) fail("duplicate_feed_delivery");
  return Object.freeze({ kind: input.kind, targets: chosen, audioMode: input.audioMode,
    musicTrackId: input.musicTrackId ?? null, musicalTargets: musical, shareToFeed });
}

// Must be called with a trusted inspector's output, never directly on request JSON.
// MIME/extension from the phone are not evidence. The inspector must decode and hash bytes.
function inspectedMedia(input, expectedKind) {
  record(input, "inspection_invalid");
  if (!Object.hasOwn(FORMATS, expectedKind) || input.kind !== expectedKind ||
      input.decoded !== true || !HASH.test(input.sha256 || "") ||
      !FORMATS[expectedKind].includes(input.format)) fail("inspection_invalid");
  const cap = expectedKind === "image" ? LIMITS.imageBytes : LIMITS.videoBytes;
  if (!Number.isSafeInteger(input.size) || input.size <= 0 || input.size > cap) fail("size_invalid");
  if (!Number.isSafeInteger(input.width) || !Number.isSafeInteger(input.height) ||
      input.width <= 0 || input.height <= 0 || input.width * input.height > LIMITS.imagePixels) fail("geometry_invalid");
  if (expectedKind === "image") {
    if (input.frames !== 1) fail("animated_image_unsupported");
  } else {
    if (input.width > LIMITS.videoDimension || input.height > LIMITS.videoDimension ||
        input.width * input.height > LIMITS.videoPixels) fail("geometry_invalid");
    if (!Number.isFinite(input.durationSeconds) || input.durationSeconds <= 0 ||
        input.durationSeconds > LIMITS.videoSeconds || typeof input.hasAudio !== "boolean") fail("duration_invalid");
    // First pilot accepts decoded SDR only; HEVC/HDR is not silently labelled compatible.
    if (input.colorMode !== "sdr") fail("video_color_unsupported");
  }
  return Object.freeze({ kind: input.kind, format: input.format, sha256: input.sha256,
    size: input.size, width: input.width, height: input.height,
    durationSeconds: expectedKind === "video" ? input.durationSeconds : null,
    hasAudio: expectedKind === "video" ? input.hasAudio : false });
}

// Catalog is injected by trusted server configuration, not editable license claims from a client.
function licensedTrack(catalog, trackId, { companyId, now, publishAt = now, audience = "owner_pilot", testMode = false }) {
  if (!catalog || typeof catalog.get !== "function" || !Number.isSafeInteger(now) ||
      !Number.isSafeInteger(publishAt) || publishAt < now || !["owner_pilot", "customers"].includes(audience)) fail("music_license_unavailable");
  const track = catalog.get(trackId);
  if (!track || track.id !== trackId || !HASH.test(track.sha256 || "") || track.disabled === true ||
      !Number.isFinite(track.durationSeconds) || track.durationSeconds < LIMITS.photoClipSeconds) fail("music_license_unavailable");
  if (testMode && track.syntheticTestOnly === true) return Object.freeze({ id: track.id, sha256: track.sha256, testOnly: true });
  if (track.syntheticTestOnly === true || !ID.test(track.evidenceId || "") ||
      track.instagramCommercialUse !== true || !Array.isArray(track.companyAllowlist) ||
      !track.companyAllowlist.includes(companyId) || !Number.isSafeInteger(track.validFrom) ||
      !Number.isSafeInteger(track.validUntil) || track.validFrom > now || track.validUntil <= publishAt ||
      (audience === "customers" && track.endUserSublicensing !== true)) fail("music_license_unavailable");
  return Object.freeze({ id: track.id, sha256: track.sha256, evidenceId: track.evidenceId,
    validUntil: track.validUntil, testOnly: false });
}
function publicationPlan(spec, inspected, { catalog, companyId, now, publishAt, audience, testMode } = {}) {
  const chosen = selection(spec);
  const media = inspectedMedia(inspected, chosen.kind);
  const track = chosen.audioMode === "music" ? licensedTrack(catalog, chosen.musicTrackId,
    { companyId, now, publishAt, audience, testMode }) : null;
  const deliveries = chosen.targets.map(target => {
    const musical = chosen.musicalTargets.includes(target);
    const video = chosen.kind === "video" || musical;
    return Object.freeze({ target, mediaType: video ? "video" : "image",
      mimeType: video ? "video/mp4" : "image/jpeg", width: 1080, height: target === "feed" ? 1350 : 1920,
      durationSeconds: musical ? LIMITS.photoClipSeconds : chosen.kind === "video" ? media.durationSeconds : null,
      audioMode: musical ? "music" : chosen.kind === "video" ? chosen.audioMode : "none",
      musicTrackId: musical ? track.id : null, musicSha256: musical ? track.sha256 : null,
      shareToFeed: target === "reel" && chosen.shareToFeed });
  });
  return Object.freeze({ schema: 1, sourceSha256: media.sha256, selection: chosen,
    testOnly: track?.testOnly === true, deliveries: Object.freeze(deliveries) });
}

// Bind approval to actual prepared variants; changing audio/format/source invalidates it.
// Schedule/owner checks belong to authenticated transactional scheduling, not this fingerprint.
function previewDigest(plan, preparedVariants) {
  record(plan, "plan_invalid"); record(preparedVariants, "preview_invalid");
  if (plan.schema !== 1 || !HASH.test(plan.sourceSha256 || "") || !Array.isArray(plan.deliveries) ||
      !plan.deliveries.length || plan.deliveries.length > 3) fail("plan_invalid");
  const expected = new Set(plan.deliveries.map(part => part.target));
  if (expected.size !== plan.deliveries.length || Object.keys(preparedVariants).length !== expected.size) fail("preview_invalid");
  const references = plan.deliveries.map(part => {
    const prepared = preparedVariants[part.target];
    if (!prepared || !HASH.test(prepared.sha256 || "") || prepared.mimeType !== part.mimeType ||
        prepared.width !== part.width || prepared.height !== part.height ||
        prepared.audioMode !== part.audioMode || prepared.sourceSha256 !== plan.sourceSha256 ||
        (part.musicSha256 != null && prepared.musicSha256 !== part.musicSha256) ||
        (part.mediaType === "video" && (!Number.isFinite(prepared.durationSeconds) ||
          Math.abs(prepared.durationSeconds - part.durationSeconds) > 0.25))) fail("preview_invalid");
    return { target: part.target, sha256: prepared.sha256, mimeType: prepared.mimeType,
      audioMode: prepared.audioMode, shareToFeed: part.shareToFeed };
  });
  return crypto.createHash("sha256").update(JSON.stringify({ schema: 1, sourceSha256: plan.sourceSha256,
    selection: plan.selection, testOnly: plan.testOnly, variants: references })).digest("hex");
}
module.exports = { LIMITS, selection, inspectedMedia, licensedTrack, publicationPlan, previewDigest };
