"use strict";

const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { FIELDS, MAX_LOGO_BYTES, MAX_LOGO_SIDE, MAX_RECORD_BYTES, ownerHash, profilePatch, fail } = require("./model");
const queues = new Map();
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function logoBytes(logo) {
  if (!logo || logo.mime_type !== "image/png" || !Number.isSafeInteger(logo.size) || logo.size < 1 || logo.size > MAX_LOGO_BYTES ||
      ![logo.width, logo.height].every(value => Number.isSafeInteger(value) && value > 0 && value <= MAX_LOGO_SIDE) ||
      typeof logo.base64 !== "string" || logo.base64.length > Math.ceil(MAX_LOGO_BYTES / 3) * 4 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(logo.base64) || !/^[a-f0-9]{64}$/.test(logo.sha256 || "")) fail("company_profile_unavailable", 503);
  const bytes = Buffer.from(logo.base64, "base64");
  if (bytes.length !== logo.size || bytes.toString("base64") !== logo.base64 || bytes.length < 33 ||
      !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.toString("ascii", 12, 16) !== "IHDR" ||
      bytes.readUInt32BE(16) !== logo.width || bytes.readUInt32BE(20) !== logo.height ||
      crypto.createHash("sha256").update(bytes).digest("hex") !== logo.sha256) fail("company_profile_unavailable", 503);
  return bytes;
}

function validRecord(record, hash) {
  try {
    if (!record || record.schemaVersion !== 1 || record.accountHash !== hash ||
        !record.profile || Object.keys(record.profile).length !== FIELDS.length ||
        typeof record.updated_at !== "string" || !Number.isFinite(Date.parse(record.updated_at))) throw new Error();
    profilePatch(record.profile);
    if (record.logo !== null) logoBytes(record.logo);
    return record;
  } catch { fail("company_profile_unavailable", 503); }
}

function createCompanyProfileStorage({ baseDir }) {
  if (typeof baseDir !== "string" || !baseDir) fail("company_profile_unavailable", 503);
  const root = path.resolve(baseDir);
  function baseExists() {
    try { const stat = fs.lstatSync(root); if (!stat.isDirectory() || stat.isSymbolicLink()) fail("company_profile_unavailable", 503); return true; }
    catch (error) { if (error.code === "ENOENT") return false; fail("company_profile_unavailable", 503); }
  }
  function read(owner) {
    const hash = ownerHash(owner), file = path.join(root, hash + ".json");
    if (!baseExists()) return null;
    let fd;
    try {
      const before = fs.lstatSync(file);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 1 || before.size > MAX_RECORD_BYTES)
        fail("company_profile_unavailable", 503);
      fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const opened = fs.fstatSync(fd);
      if (opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size) fail("company_profile_unavailable", 503);
      const record = JSON.parse(fs.readFileSync(fd, "utf8")), after = fs.fstatSync(fd);
      if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) fail("company_profile_unavailable", 503);
      return validRecord(record, hash);
    } catch (error) { if (error.code === "ENOENT") return null; fail("company_profile_unavailable", 503); }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  function write(hash, record) {
    validRecord(record, hash);
    const text = JSON.stringify(record);
    if (Buffer.byteLength(text) > MAX_RECORD_BYTES) fail("company_profile_too_large", 413);
    let temporary, fd;
    try {
      if (!baseExists()) fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      if (!baseExists()) fail("company_profile_unavailable", 503);
      temporary = path.join(root, "." + hash + "." + crypto.randomUUID() + ".tmp");
      fd = fs.openSync(temporary, "wx", 0o600);
      fs.writeFileSync(fd, text, "utf8"); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(temporary, path.join(root, hash + ".json")); temporary = undefined;
    } catch { fail("company_profile_unavailable", 503); }
    finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (temporary) { try { fs.unlinkSync(temporary); } catch {} }
    }
  }
  function update(owner, transform) {
    const hash = ownerHash(owner), key = path.join(root, hash + ".json"), previous = queues.get(key) || Promise.resolve();
    const running = previous.then(async () => {
      const next = await transform(read(owner)); write(hash, next); return next;
    });
    const settled = running.then(() => {}, () => {});
    queues.set(key, settled);
    settled.then(() => { if (queues.get(key) === settled) queues.delete(key); });
    return running;
  }
  return Object.freeze({ read, update });
}

module.exports = { createCompanyProfileStorage, logoBytes };
