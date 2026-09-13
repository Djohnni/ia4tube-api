"use strict";
const crypto = require("node:crypto");
const { UUID } = require("../model");
const HASH = /^[a-f0-9]{64}$/, ID = /^[a-f0-9]{40}$/;
function fail() { throw Object.assign(new Error("Mídia preparada indisponível."), { code: "calendar_import_prepared_media_unavailable", statusCode: 409 }); }
function validatePreparedPublicationPart(target, part, selectedTargets) {
  if (!part || !["feed", "story", "reel"].includes(target) || !Array.isArray(selectedTargets) || !selectedTargets.includes(target) ||
      !["image/jpeg", "video/mp4"].includes(part.mimeType) || !Number.isSafeInteger(part.sizeBytes) ||
      part.sizeBytes < 1 || part.size !== part.sizeBytes || typeof part.shareToFeed !== "boolean" ||
      typeof part.hasAudio !== "boolean" || !["none", "original", "muted", "music"].includes(part.audioMode)) fail();
  const video = part.mimeType === "video/mp4";
  if (part.sizeBytes > (video ? 100000000 : 8000000) || part.width !== 1080 || part.height !== (target === "feed" ? 1350 : 1920) ||
      video && (target === "feed" || !Number.isFinite(part.durationSeconds) || part.durationSeconds < 3 || part.durationSeconds > 60 || part.audioMode === "none") ||
      !video && (target === "reel" || part.hasAudio || part.audioMode !== "none") ||
      part.audioMode === "muted" && part.hasAudio || part.audioMode === "music" && !part.hasAudio ||
      part.shareToFeed && (target !== "reel" || selectedTargets.includes("feed"))) fail();
  return true;
}

// Pure construction from a trusted calendar snapshot, suitable inside its CAS
// transaction. File/ownership reinspection occurs separately before any POST.
function preparedPublicationDescriptor(companyId, job) {
  const imported = job?.import, part = job?.assets?.[job.target];
  if (!UUID.test(companyId || "") || job?.sourceKind !== "upload" || job.layout !== "import_prepared_v1" ||
      !ID.test(job.id || "") || !imported || !UUID.test(imported.userId || "") ||
      !UUID.test(imported.assetId || "") || !Number.isSafeInteger(imported.mediaRevision) || imported.mediaRevision < 1 ||
      !UUID.test(imported.resultRef || "") || !HASH.test(imported.previewDigest || "") ||
      !Array.isArray(job.selectedTargets) || !job.selectedTargets.includes(job.target) ||
      !["feed", "story", "reel"].includes(job.target) || !part || !HASH.test(part.sha256 || "") ||
      !HASH.test(part.objectKey || "") || !UUID.test(part.objectVersion || "") ||
      !["image/jpeg", "video/mp4"].includes(part.mimeType) || !Number.isSafeInteger(part.sizeBytes) ||
      part.sizeBytes < 1 || part.size !== part.sizeBytes || typeof part.shareToFeed !== "boolean" ||
      typeof part.hasAudio !== "boolean" || !["none", "original", "muted", "music"].includes(part.audioMode) ||
      typeof job.caption !== "string" || job.caption.length > 2200 ||
      typeof imported.preview?.testOnly !== "boolean") fail();
  const video = part.mimeType === "video/mp4";
  validatePreparedPublicationPart(job.target, part, job.selectedTargets);
  const value = { companyId, userId: imported.userId, calendarItemId: job.id,
    assetId: imported.assetId, mediaRevision: imported.mediaRevision, resultRef: imported.resultRef,
    previewDigest: imported.previewDigest, target: job.target, destination: job.target,
    objectKey: part.objectKey, objectVersion: part.objectVersion,
    sha256: part.sha256, mimeType: part.mimeType, sizeBytes: part.sizeBytes, width: part.width, height: part.height,
    durationSeconds: video ? part.durationSeconds : null, hasAudio: part.hasAudio, audioMode: part.audioMode,
    shareToFeed: part.shareToFeed, testOnly: imported.preview.testOnly, caption: job.caption };
  const metadataDigest = crypto.createHash("sha256").update(JSON.stringify(["ia4tube:prepared-publication:v1", value])).digest("hex");
  return Object.freeze({ ...value, metadataDigest, mediaId: `calendar-prepared-v1:${metadataDigest}` });
}
module.exports = { preparedPublicationDescriptor, validatePreparedPublicationPart };
