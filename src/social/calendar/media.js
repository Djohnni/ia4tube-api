"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { digest, fail, UUID } = require("./model");
const MAX_BYTES = 8 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
function createCalendarMedia({ dataDir, secret, publicOrigin, loadSource, clock = Date.now }) {
  if (typeof secret !== "string" || secret.length < 32) fail("calendar_key_unavailable", 503);
  const key = crypto.createHmac("sha256", secret).update("ia4tube-calendar-media-v1").digest();
  const root = path.resolve(dataDir, "calendar-publication-media");
  const sign = value => crypto.createHmac("sha256", key).update(value).digest("hex");
  function filename(companyId, hash) {
    if (!UUID.test(companyId) || !HASH.test(hash)) fail("calendar_media_invalid", 404);
    return path.join(root, companyId, `${hash}.jpg`);
  }
  async function prepare(owner, companyId, job) {
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
  async function unchanged(owner, job) { return digest(await loadSource(owner, job)) === job.asset.sourceHash; }
  function publicBytes(companyId, sha, expires, signature) {
    if (!HASH.test(signature || "") || !/^\d{10}$/.test(expires || "")) fail("calendar_media_invalid", 404);
    const now = Math.floor(clock() / 1000);
    if (Number(expires) < now || Number(expires) > now + 900) fail("calendar_media_expired", 404);
    const expected = sign(`${companyId}:${sha}:${expires}`);
    if (!crypto.timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"))) fail("calendar_media_invalid", 404);
    return bytesFor(companyId, { sha });
  }
  return Object.freeze({ prepare, bytesFor, descriptor, unchanged, publicBytes, close() { key.fill(0); } });
}
module.exports = { createCalendarMedia };
