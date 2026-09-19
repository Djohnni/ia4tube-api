"use strict";
const fs = require("node:fs/promises"), path = require("node:path"), crypto = require("node:crypto");
const HASH = /^[a-f0-9]{64}$/, ID = /^track_[a-f0-9]{24}$/;
function fail() { throw Object.assign(new Error("Catálogo de músicas indisponível."), { code: "calendar_music_catalog_invalid" }); }
function displayName(value, fallback) {
  return typeof value === "string" && value === value.trim() && value.length >= 1 && value.length <= 80 &&
    !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value) ? value : fallback;
}
function validateCanonicalWav(bytes) {
  if (bytes.length < 44 || bytes.toString("ascii",0,4) !== "RIFF" || bytes.toString("ascii",8,12) !== "WAVE" || bytes.readUInt32LE(4) !== bytes.length-8) fail();
  let offset=12, fmt=false, data=false;
  while (offset < bytes.length) {
    if (offset+8 > bytes.length) fail();
    const kind=bytes.toString("ascii",offset,offset+4), size=bytes.readUInt32LE(offset+4), begin=offset+8;
    if (begin+size > bytes.length) fail();
    if (kind === "fmt ") {
      if (fmt || size !== 16 || bytes.readUInt16LE(begin) !== 1 || bytes.readUInt16LE(begin+2) !== 2 ||
          bytes.readUInt32LE(begin+4) !== 48000 || bytes.readUInt32LE(begin+8) !== 192000 ||
          bytes.readUInt16LE(begin+12) !== 4 || bytes.readUInt16LE(begin+14) !== 16) fail();
      fmt=true;
    }
    if (kind === "data") { if (data || size !== 2_880_000) fail(); data=true; }
    offset=begin+size+(size%2);
  }
  if (!fmt || !data || offset !== bytes.length) fail();
  return true;
}
async function protectedBytes(file, maximum) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 1 || stat.size > maximum ||
      path.resolve(await fs.realpath(file)) !== path.resolve(file) || process.platform !== "win32" && (stat.mode & 0o022)) fail();
  const handle = await fs.open(file, require("node:fs").constants.O_RDONLY | (require("node:fs").constants.O_NOFOLLOW || 0));
  try {
    const before = await handle.stat();
    if (before.ino !== stat.ino || before.dev !== stat.dev || before.size !== stat.size) fail();
    const bytes = await handle.readFile(); const after = await handle.stat();
    if (after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || bytes.length !== stat.size) fail();
    return bytes;
  } finally { await handle.close(); }
}
// The manifest and rights receipt are operator-owned, never client request JSON.
// Audio bytes stay outside Git and outside every public/static directory.
async function loadPrivateMusicCatalog({ rootDirectory, manifest, rights, ownerCompanyId, clock = Date.now, now = clock(), allowExpiredForReadOnly = false }) {
  if (!path.isAbsolute(rootDirectory || "") || !manifest || manifest.schema !== 1 || !Array.isArray(manifest.tracks) ||
      manifest.tracks.length > 100 || !/^[a-f0-9-]{36}$/.test(ownerCompanyId || "") || !Number.isSafeInteger(now) ||
      typeof clock !== 'function' || typeof allowExpiredForReadOnly !== 'boolean') fail();
  const root = path.resolve(rootDirectory), stat = await fs.lstat(root);
  if (root === path.parse(root).root || !stat.isDirectory() || stat.isSymbolicLink() || path.resolve(await fs.realpath(root)) !== root ||
      process.platform !== "win32" && (stat.mode & 0o077)) fail();
  if (!rights || rights.companyId !== ownerCompanyId || rights.instagramCommercialUse !== true || rights.endUserSublicensing !== false ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(rights.evidenceId || "") || !Number.isSafeInteger(rights.validFrom) ||
      !Number.isSafeInteger(rights.validUntil) || rights.validFrom < 0 || rights.validFrom > now || rights.validUntil <= rights.validFrom ||
      rights.validUntil <= now && !allowExpiredForReadOnly) fail();
  // Snapshot operator evidence before any asynchronous file reads. Historical
  // metadata can survive the pilot window; it never renews authorization.
  const receipt=Object.freeze({...rights}), expiredAtLoad=receipt.validUntil<=now;
  const records = new Map(), seenHashes = new Set();
  for (const row of manifest.tracks) {
    if (!row || !ID.test(row.id || "") || records.has(row.id) || !HASH.test(row.sha256 || "") || seenHashes.has(row.sha256) ||
        row.fileName !== row.id + ".wav" || row.durationSeconds !== 15 || row.sampleRate !== 48000 || row.channels !== 2 || row.codec !== "pcm_s16le" ||
        !Number.isSafeInteger(row.sizeBytes) || row.sizeBytes < 2_880_000 || row.sizeBytes > 2_900_000 || displayName(row.displayName, null) === null) fail();
    const filePath = path.join(root, row.fileName), bytes = await protectedBytes(filePath, 2_900_000);
    if (bytes.length !== row.sizeBytes || crypto.createHash("sha256").update(bytes).digest("hex") !== row.sha256) fail();
    validateCanonicalWav(bytes);
    records.set(row.id, Object.freeze({ id:row.id, displayName:row.displayName, sha256:row.sha256, durationSeconds:15,
      evidenceId:receipt.evidenceId, validFrom:receipt.validFrom, validUntil:receipt.validUntil, instagramCommercialUse:true,
      companyAllowlist:Object.freeze([ownerCompanyId]), endUserSublicensing:false }));
    seenHashes.add(row.sha256);
  }
  const catalog = Object.freeze({ get:id=>records.get(id), has:id=>records.has(id), values:()=>records.values(), size:records.size });
  return Object.freeze({ catalog, async resolveMusicTrack(id, companyId) {
    // Keep the native executor's minimal rights proof attached to the bytes.
    // This is only the already-validated owner's commercial permission, not a
    // grant to another company or to the full customer catalog.
    const track = catalog.get(id); if (!track || companyId !== ownerCompanyId || expiredAtLoad) return null;
    let at;try{at=clock();}catch{return null;}
    if(!Number.isSafeInteger(at)||at<track.validFrom||at>=track.validUntil)return null;
    // The transfer layer hashes the actual bytes again before offering them.
    return Object.freeze({ filePath:path.join(root,id+".wav"), sha256:track.sha256, synthetic:false,
      rights:Object.freeze({commercialPublishing:true,evidenceId:track.evidenceId}) });
  } });
}
module.exports = { loadPrivateMusicCatalog, displayName, protectedBytes, validateCanonicalWav };
