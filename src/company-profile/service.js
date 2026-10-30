"use strict";

const crypto = require("node:crypto"), sharp = require("sharp");
const { createCompanyProfileStorage, logoBytes } = require("./storage");
const { MAX_LOGO_BYTES, MAX_LOGO_PIXELS, MAX_LOGO_SIDE, ownerHash, emptyProfile, profilePatch, fail } = require("./model");

async function normalizeLogo(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) fail("company_profile_unsupported_logo");
  if (bytes.length > MAX_LOGO_BYTES) fail("company_profile_too_large", 413);
  const format = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "png"
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? "jpeg"
      : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" ? "webp" : null;
  if (!format) fail("company_profile_unsupported_logo");
  try {
    const decoder = sharp(bytes, { limitInputPixels: MAX_LOGO_PIXELS, failOn: "error" }).timeout({ seconds: 10 });
    const metadata = await decoder.metadata();
    if (metadata.format !== format || (metadata.pages || 1) !== 1 ||
        ![metadata.width, metadata.height].every(value => Number.isSafeInteger(value) && value > 0) ||
        metadata.width * metadata.height > MAX_LOGO_PIXELS) fail("company_profile_unsupported_logo");
    const { data, info } = await decoder.rotate().resize({ width: MAX_LOGO_SIDE, height: MAX_LOGO_SIDE, fit: "inside", withoutEnlargement: true })
      .toColourspace("srgb").png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true });
    if (data.length > MAX_LOGO_BYTES) fail("company_profile_too_large", 413);
    return { mime_type: "image/png", base64: data.toString("base64"), size: data.length, width: info.width, height: info.height,
      sha256: crypto.createHash("sha256").update(data).digest("hex") };
  } catch (error) {
    if (error.code === "company_profile_too_large") throw error;
    fail("company_profile_unsupported_logo");
  }
}

function createCompanyProfileService({ baseDir, clock = Date.now }) {
  const storage = createCompanyProfileStorage({ baseDir });
  const response = record => ({ ok: true, profile: { ...(record?.profile || emptyProfile()), has_logo: Boolean(record?.logo), updated_at: record?.updated_at || null } });
  function get(owner) { ownerHash(owner); return response(storage.read(owner)); }
  function logo(owner) {
    const record = storage.read(owner);
    if (!record?.logo) fail("company_profile_logo_not_found", 404);
    return logoBytes(record.logo);
  }
  async function save(owner, { profile, logo = null, removeLogo = false }) {
    const hash = ownerHash(owner), patch = profilePatch(profile);
    if (typeof removeLogo !== "boolean" || removeLogo && logo !== null) fail();
    if (logo !== null && (!Buffer.isBuffer(logo) || !logo.length)) fail("company_profile_unsupported_logo");
    if (logo && logo.length > MAX_LOGO_BYTES) fail("company_profile_too_large", 413);
    const record = await storage.update(owner, async current => ({ schemaVersion: 1, accountHash: hash,
      profile: { ...(current?.profile || emptyProfile()), ...patch },
      logo: removeLogo ? null : logo !== null ? await normalizeLogo(logo) : current?.logo || null,
      updated_at: new Date(clock()).toISOString() }));
    return response(record);
  }
  return Object.freeze({ get, logo, save });
}

module.exports = { createCompanyProfileService, normalizeLogo };
