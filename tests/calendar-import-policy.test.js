"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { LIMITS, selection, inspectedMedia, licensedTrack, publicationPlan, previewDigest } = require("../src/social/calendar/imports/policy");
const image = { kind: "image", decoded: true, format: "jpeg", sha256: "a".repeat(64), size: 1234, width: 4000, height: 3000, frames: 1 };
const video = { ...image, kind: "video", format: "mp4", width: 1920, height: 1080, durationSeconds: 60, hasAudio: true, colorMode: "sdr" };
const base = { kind: "image", targets: ["feed", "story"], audioMode: "none" };
const now = Date.parse("2026-09-12T12:00:00Z"), owner = "synthetic-owner";
const track = { id: "synthetic-track", sha256: "b".repeat(64), durationSeconds: 30,
  evidenceId: "fixture-only", instagramCommercialUse: true, companyAllowlist: [owner], validFrom: now - 1,
  validUntil: now + 86_400_000, endUserSublicensing: false };
const catalog = new Map([[track.id, track]]);
const music = { kind: "image", targets: ["feed", "story"], audioMode: "music", musicTrackId: track.id, musicalTargets: ["story"] };
test("pilot limits are bounded independently of art generation credits", () => {
  assert.equal(LIMITS.videoBytes, 104857600); assert.equal(LIMITS.photoClipSeconds, 15);
  assert.equal(LIMITS.chunkBytes, 5242880); assert.ok(Object.isFrozen(LIMITS));
});
test("same photo yields one JPEG per requested destination without music or an artificial order", () => {
  const plan = publicationPlan(base, image);
  assert.deepEqual(plan.deliveries.map(p => [p.target, p.mimeType, p.height]), [["feed", "image/jpeg", 1350], ["story", "image/jpeg", 1920]]);
  assert.equal(JSON.stringify(plan).includes("orderId"), false);
  assert.equal(plan.testOnly, false);
});
test("photo Feed and musical Story have distinct exact variants", () => {
  const plan = publicationPlan(music, image, { catalog, companyId: owner, now });
  assert.deepEqual(plan.deliveries.map(p => [p.target, p.mediaType, p.audioMode]), [["feed", "image", "none"], ["story", "video", "music"]]);
  assert.equal(plan.deliveries[1].durationSeconds, 15);
});
test("musical photo Feed is expressly Reel with shareToFeed, never video Feed", () => {
  const spec = { ...music, targets: ["reel"], musicalTargets: ["reel"], shareToFeed: true };
  const plan = publicationPlan(spec, image, { catalog, companyId: owner, now });
  assert.equal(plan.deliveries.length, 1); assert.equal(plan.deliveries[0].shareToFeed, true);
  assert.throws(() => selection({ ...music, musicalTargets: ["feed"] }), { code: "calendar_import_photo_music_invalid" });
});
test("video retains original audio or explicit silence and two outputs are not three", () => {
  for (const audioMode of ["original", "muted"]) {
    const plan = publicationPlan({ kind: "video", targets: ["story", "reel"], audioMode, shareToFeed: true }, video);
    assert.equal(plan.deliveries.length, 2);
    assert.ok(plan.deliveries.every(p => p.audioMode === audioMode && p.mimeType === "video/mp4"));
  }
  assert.throws(() => selection({ kind: "video", targets: ["feed"], audioMode: "original" }), { code: "calendar_import_video_feed_is_reel" });
});
test("selection rejects duplicates, URLs, implicit audio transforms and fake client license", () => {
  const invalid = [{ ...base, targets: [] }, { ...base, targets: ["story", "story"] }, { ...base, targets: ["reel"] },
    { ...base, targets: ["https://example.invalid"] }, { ...base, licensed: true }, { ...base, shareToFeed: true },
    { ...music, targets: ["feed", "reel"], musicalTargets: ["reel"], shareToFeed: true },
    { kind: "video", targets: ["story"], audioMode: "music", musicTrackId: track.id }];
  for (const value of invalid) assert.throws(() => selection(value));
});
test("declared extension/MIME cannot replace trusted decoded inspection", () => {
  for (const patch of [{ decoded: false }, { format: "svg" }, { size: 0 }, { size: LIMITS.imageBytes + 1 },
    { width: 50000 }, { frames: 2 }, { sha256: "invalid" }, { width: 0 }]) {
    assert.throws(() => inspectedMedia({ ...image, ...patch }, "image"));
  }
  assert.throws(() => inspectedMedia(image, "video"));
  for (const patch of [{ durationSeconds: 61 }, { durationSeconds: NaN }, { hasAudio: undefined }, { colorMode: "hdr" },
    { width: 4096, height: 4096 }, { width: 5000, height: 100 }]) {
    assert.throws(() => inspectedMedia({ ...video, ...patch }, "video"));
  }
});
test("music fails closed without real configured rights matching owner and scheduled time", () => {
  const opts = { companyId: owner, now };
  assert.throws(() => licensedTrack(null, track.id, opts));
  assert.throws(() => licensedTrack(catalog, track.id, { ...opts, companyId: "other" }));
  assert.throws(() => licensedTrack(catalog, track.id, { ...opts, publishAt: track.validUntil }));
  assert.throws(() => licensedTrack(catalog, track.id, { ...opts, audience: "customers" }));
  for (const patch of [{ evidenceId: null }, { instagramCommercialUse: false }, { disabled: true }, { syntheticTestOnly: true }]) {
    assert.throws(() => licensedTrack(new Map([[track.id, { ...track, ...patch }]]), track.id, opts));
  }
  assert.equal(licensedTrack(catalog, track.id, opts).testOnly, false);
});
test("synthetic audio can only yield explicitly test-only plans", () => {
  const synthetic = new Map([[track.id, { id: track.id, sha256: track.sha256, durationSeconds: 15, syntheticTestOnly: true }]]);
  assert.throws(() => publicationPlan(music, image, { catalog: synthetic, companyId: owner, now }));
  assert.equal(publicationPlan(music, image, { catalog: synthetic, companyId: owner, now, testMode: true }).testOnly, true);
});
test("preview fingerprint binds the exact encoded media, track and format", () => {
  const plan = publicationPlan(music, image, { catalog, companyId: owner, now });
  const prepared = Object.fromEntries(plan.deliveries.map(part => [part.target, { ...part,
    sourceSha256: image.sha256, sha256: (part.target === "feed" ? "c" : "d").repeat(64) }]));
  const first = previewDigest(plan, prepared);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(previewDigest(plan, structuredClone(prepared)), first);
  assert.notEqual(previewDigest(plan, { ...prepared, story: { ...prepared.story, sha256: "e".repeat(64) } }), first);
  assert.throws(() => previewDigest(plan, { ...prepared, story: { ...prepared.story, audioMode: "none" } }));
  assert.throws(() => previewDigest(plan, { ...prepared, story: { ...prepared.story, musicSha256: "f".repeat(64) } }));
  assert.throws(() => previewDigest(plan, { ...prepared, story: { ...prepared.story, height: 1080 } }));
  assert.throws(() => previewDigest(plan, { feed: prepared.feed }));
});
