"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { digest, fail, UUID } = require("./model");
const { MAX_VIDEO_BYTES } = require("../../company-monthly-planning/ready-video");
const MAX_BYTES = 8 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
function createCalendarMedia({ dataDir, secret, publicOrigin, loadSource, describeSource, clock = Date.now }) {
  if (typeof secret !== "string" || secret.length < 32) fail("calendar_key_unavailable", 503);
  const key = crypto.createHmac("sha256", secret).update("ia4tube-calendar-media-v1").digest();
  const root = path.resolve(dataDir, "calendar-publication-media");
  const sign = value => crypto.createHmac("sha256", key).update(value).digest("hex");
  function filename(companyId, hash) {
    if (!UUID.test(companyId) || !HASH.test(hash)) fail("calendar_media_invalid", 404);
    return path.join(root, companyId, `${hash}.jpg`);
  }
  function videoFilename(companyId, hash) {
    if (!UUID.test(companyId) || !HASH.test(hash)) fail("calendar_media_invalid", 404);
    return path.join(root, companyId, `${hash}.mp4`);
  }
  function fileDigest(file, maxBytes) {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const before = fs.fstatSync(fd);
      if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > maxBytes) fail("calendar_media_unavailable", 404);
      const hash = crypto.createHash("sha256"), bytes = Buffer.alloc(65536);
      let offset = 0;
      while (offset < before.size) {
        const count = fs.readSync(fd, bytes, 0, Math.min(bytes.length, before.size - offset), offset);
        if (!count) fail("calendar_media_changed", 409);
        hash.update(bytes.subarray(0, count)); offset += count;
      }
      const after = fs.fstatSync(fd);
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
          after.ino !== before.ino || after.dev !== before.dev) fail("calendar_media_changed", 409);
      return { sha: hash.digest("hex"), size: offset };
    } finally { fs.closeSync(fd); }
  }
  function videoFile(companyId, asset) {
    if (!asset || asset.mimeType !== "video/mp4" || !HASH.test(asset.sha || "") ||
        !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > MAX_VIDEO_BYTES) fail("calendar_media_invalid", 404);
    const file = videoFilename(companyId, asset.sha), companyRoot = path.dirname(file);
    if (fs.lstatSync(root).isSymbolicLink() || fs.lstatSync(companyRoot).isSymbolicLink()) fail("calendar_media_invalid", 404);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== asset.size) fail("calendar_media_changed", 409);
    const actual = fileDigest(file, MAX_VIDEO_BYTES);
    if (actual.sha !== asset.sha || actual.size !== asset.size) fail("calendar_media_changed", 409);
    return { file, size: asset.size, sha: asset.sha };
  }
  function prepareVideo(owner, companyId, job) {
    if (typeof describeSource !== "function") fail("calendar_media_unavailable", 503);
    const source = describeSource(owner, job);
    if (source.mediaKind !== "video" || source.version !== job.sourceVersion ||
        !source.metadata || source.size > MAX_VIDEO_BYTES) fail("calendar_media_unavailable", 409);
    const companyRoot = path.join(root, companyId);
    fs.mkdirSync(companyRoot, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(root).isSymbolicLink() || fs.lstatSync(companyRoot).isSymbolicLink()) fail("calendar_media_invalid", 404);
    const temp = path.join(companyRoot, `${crypto.randomUUID()}.mp4.tmp`);
    let input = null, output = null, sha, size = 0;
    try {
      input = fs.openSync(source.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      output = fs.openSync(temp, "wx", 0o600);
      const before = fs.fstatSync(input), hash = crypto.createHash("sha256"), bytes = Buffer.alloc(65536);
      if (!before.isFile() || before.nlink !== 1 || before.size !== source.size) fail("calendar_media_changed", 409);
      while (size < before.size) {
        const count = fs.readSync(input, bytes, 0, Math.min(bytes.length, before.size - size), size);
        if (!count) fail("calendar_media_changed", 409);
        for (let written = 0; written < count;) {
          const amount = fs.writeSync(output, bytes, written, count - written);
          if (amount < 1) fail("calendar_media_unavailable", 503);
          written += amount;
        }
        hash.update(bytes.subarray(0, count)); size += count;
      }
      const after = fs.fstatSync(input);
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
          after.ino !== before.ino || after.dev !== before.dev) fail("calendar_media_changed", 409);
      fs.fsyncSync(output); sha = hash.digest("hex");
      fs.closeSync(output); output = null;
      const final = videoFilename(companyId, sha);
      if (!fs.existsSync(final)) fs.renameSync(temp, final);
      else fs.unlinkSync(temp);
      const metadata = source.metadata;
      const asset = { sha, sourceHash: sha, size, mimeType: "video/mp4", width: metadata.width,
        height: metadata.height, durationSeconds: metadata.durationSeconds,
        hasAudio: metadata.hasAudio, audioMode: metadata.audioMode };
      videoFile(companyId, asset);
      return { ...asset, variants: { reel: asset, story: asset } };
    } finally {
      if (output !== null) fs.closeSync(output);
      if (input !== null) fs.closeSync(input);
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
  }
  async function prepare(owner, companyId, job) {
    if (job.mediaKind === "video") return prepareVideo(owner, companyId, job);
    const bytes = await loadSource(owner, job);
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 32 * 1024 * 1024) fail("calendar_media_unavailable");
    const sourceHash = digest(bytes);
    const sharp = require("sharp");
    const input = sharp(bytes, { limitInputPixels: 25 * 1000 * 1000, failOn: "error" });
    const meta = await input.metadata();
    if (!["png", "jpeg", "webp"].includes(meta.format) || (meta.pages || 1) !== 1) fail("calendar_media_invalid");
    if (job.layout === "safe_master_v1") {
      // Preserve the entire Feed artwork in both placements; a prompt is not a crop-safety proof.
      const rotated = await input.rotate().flatten({ background: "#ffffff" }).png().toBuffer();
      const geometry = await sharp(rotated).metadata();
      if (geometry.width !== 1152 || geometry.height !== 1440) fail("calendar_format_source_invalid");
      const feed = await sharp(rotated).resize(1080, 1350).png().toBuffer();
      const variants = {};
      for (const target of ["feed", "story"]) {
        // Only the decorative background is cropped/blurred. The foreground is never cropped.
        const frame = target === "feed" ? sharp(feed) : sharp(rotated)
          .resize(1080, 1920, { fit: "cover" }).blur(50).composite([{ input: feed, left: 0, top: 285 }]);
        const height = target === "feed" ? 1350 : 1920;
        const jpeg = await frame.toColourspace("srgb")
          .jpeg({ quality: 92, chromaSubsampling: "4:4:4" }).toBuffer();
        variants[target] = persist(companyId, jpeg, sourceHash, 1080, height);
      }
      return { ...variants[job.destination === "story" ? "story" : "feed"], variants };
    }
    const jpeg = await input.rotate().flatten({ background: "#ffffff" })
      .resize(1080, 1080, { fit: "contain", background: "#ffffff" })
      .toColourspace("srgb").jpeg({ quality: 92, chromaSubsampling: "4:4:4" }).toBuffer();
    return persist(companyId, jpeg, sourceHash, 1080, 1080);
  }
  function persist(companyId, jpeg, sourceHash, width, height) {
    if (jpeg.length > MAX_BYTES) fail("calendar_media_too_large");
    const sha = digest(jpeg); const file = filename(companyId, sha);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    if (fs.lstatSync(root).isSymbolicLink() || fs.lstatSync(path.dirname(file)).isSymbolicLink()) fail("calendar_media_invalid");
    if (!fs.existsSync(file)) {
      const temp = `${file}.${crypto.randomUUID()}.tmp`;
      const fd = fs.openSync(temp, "wx", 0o600);
      try { fs.writeFileSync(fd, jpeg); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temp, file);
    }
    return { sha, sourceHash, width, height, size: jpeg.length };
  }
  function bytesFor(companyId, asset) {
    const file = filename(companyId, asset.sha);
    if (fs.lstatSync(root).isSymbolicLink() || fs.lstatSync(path.dirname(file)).isSymbolicLink()) fail("calendar_media_invalid");
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) fail("calendar_media_unavailable");
    const bytes = fs.readFileSync(file);
    if (digest(bytes) !== asset.sha) fail("calendar_media_changed");
    return bytes;
  }
  function descriptor(companyId, job) {
    bytesFor(companyId, job.asset);
    const expires = Math.floor(clock() / 1000) + 900;
    const signature = sign(`${companyId}:${job.asset.sha}:${expires}`);
    const publicUrl = `${publicOrigin}/v1/social/calendar/media/${companyId}/${job.asset.sha}/${expires}/${signature}`;
    const metadata = [companyId, job.asset.sha, job.caption];
    // Pending legacy Feed intents retain the digest they were created with.
    if (job.layout === "safe_master_v1" || job.target) metadata.push(job.target || "feed");
    return Object.freeze({ companyId, mediaId: `${job.target === "story" ? "calendar-story-jpeg" : "calendar-jpeg"}:${job.asset.sha}`, mimeType: "image/jpeg",
      width: job.asset.width, height: job.asset.height, caption: job.caption, publicUrl, thumbnailUrl: publicUrl,
      destination: job.target || "feed",
      metadataDigest: digest(JSON.stringify(metadata)) });
  }
  function videoDescriptor(companyId, userId, job) {
    if (!UUID.test(userId || "") || job.mediaKind !== "video" || !["reel", "story"].includes(job.target)) fail("calendar_media_invalid", 404);
    const asset = videoFile(companyId, job.asset), expires = Math.floor(clock() / 1000) + 3600;
    const signature = sign(`video:${companyId}:${asset.sha}:${expires}`);
    const publicUrl = `${publicOrigin}/v1/social/calendar/media/video/${companyId}/${asset.sha}/${expires}/${signature}`;
    const shareToFeed = job.target === "reel";
    const metadataDigest = digest(JSON.stringify(["generated-video-v1", companyId, userId, job.id,
      asset.sha, job.target, job.caption, shareToFeed, job.asset.durationSeconds]));
    return Object.freeze({ companyId, userId, mediaId: `calendar-prepared-v1:${metadataDigest}`,
      mimeType: "video/mp4", sha256: asset.sha, sizeBytes: asset.size, width: job.asset.width,
      height: job.asset.height, durationSeconds: job.asset.durationSeconds, hasAudio: job.asset.hasAudio,
      audioMode: job.asset.audioMode, shareToFeed, target: job.target, destination: job.target,
      publicUrl, thumbnailUrl: publicUrl, caption: job.caption, metadataDigest });
  }
  function publicVideo(companyId, sha, expires, signature) {
    if (!HASH.test(signature || "") || !/^\d{10}$/.test(expires || "")) fail("calendar_media_invalid", 404);
    const now = Math.floor(clock() / 1000);
    if (Number(expires) < now || Number(expires) > now + 3600) fail("calendar_media_expired", 404);
    const expected = sign(`video:${companyId}:${sha}:${expires}`);
    if (!crypto.timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"))) fail("calendar_media_invalid", 404);
    const file = videoFilename(companyId, sha);
    const stat = fs.lstatSync(file);
    return videoFile(companyId, { sha, mimeType: "video/mp4", size: stat.size });
  }
  async function unchanged(owner, job) {
    if (job.mediaKind === "video") {
      const source = describeSource(owner, job);
      return source.version === job.sourceVersion && source.mediaKind === "video" &&
        fileDigest(source.file, MAX_VIDEO_BYTES).sha === job.asset.sourceHash;
    }
    return digest(await loadSource(owner, job)) === job.asset.sourceHash;
  }
  function publicBytes(companyId, sha, expires, signature) {
    if (!HASH.test(signature || "") || !/^\d{10}$/.test(expires || "")) fail("calendar_media_invalid", 404);
    const now = Math.floor(clock() / 1000);
    if (Number(expires) < now || Number(expires) > now + 900) fail("calendar_media_expired", 404);
    const expected = sign(`${companyId}:${sha}:${expires}`);
    if (!crypto.timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"))) fail("calendar_media_invalid", 404);
    return bytesFor(companyId, { sha });
  }
  return Object.freeze({ prepare, bytesFor, descriptor, videoDescriptor, videoFile, publicVideo,
    unchanged, publicBytes, close() { key.fill(0); } });
}
module.exports = { createCalendarMedia };
