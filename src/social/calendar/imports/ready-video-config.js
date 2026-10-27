"use strict";
const ENABLED = "SOCIAL_READY_VIDEO_IMPORTS_ENABLED";
const SUBJECTS = "SOCIAL_READY_VIDEO_ALLOWED_SUBJECTS_JSON";
const ORIGIN = "https://ia4tube-api.onrender.com";
const POOL_CONFIG = "/var/data/private/calendar-media/control/ready-video.json";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function fail() { throw Object.assign(new Error("Importação de vídeos indisponível."), { code: "ready_video_configuration_invalid", statusCode: 503 }); }
function loadReadyVideoConfig(env = process.env) {
  if (env[ENABLED] !== undefined && !["false", "true"].includes(env[ENABLED])) fail();
  if (env[ENABLED] !== "true") return Object.freeze({ enabled: false, subjects: Object.freeze([]) });
  if (env.ENVIRONMENT !== "production" || env.PUBLIC_API_BASE_URL !== ORIGIN ||
      env.SOCIAL_PERSISTENCE_ENABLED !== "true" || env.SOCIAL_CALENDAR_ENABLED !== "true" ||
      env.SOCIAL_INSTAGRAM_ENABLED !== "true" || env.META_APP_REVIEW_WINDOW_ENABLED === "true" ||
      env.SOCIAL_MEDIA_IMPORTS_ENABLED === "true") fail();
  let subjects;
  try { subjects = JSON.parse(env[SUBJECTS]); } catch { fail(); }
  if (!Array.isArray(subjects) || subjects.length < 1 || subjects.length > 10 ||
      subjects.some(value => typeof value !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) ||
      new Set(subjects).size !== subjects.length) fail();
  return Object.freeze({ enabled: true, subjects: Object.freeze(subjects.slice()), publicOrigin: ORIGIN });
}
async function resolveReadyVideoOwners(config, resolveOwnerForSubject) {
  if (config?.enabled !== true || typeof resolveOwnerForSubject !== "function") fail();
  const owners = [], seen = new Set();
  for (const subject of config.subjects) {
    // This callback belongs to the authenticated identity/provisioning adapter.
    // A phone-supplied companyId/userId is never an identity source.
    const value = await resolveOwnerForSubject(subject);
    if (!value || !UUID.test(value.companyId || "") || !UUID.test(value.userId || "")) fail();
    const owner = Object.freeze({ companyId: value.companyId.toLowerCase(), userId: value.userId.toLowerCase(), audience: "customers" });
    const key = `${owner.companyId}:${owner.userId}`;
    if (seen.has(key)) fail();
    seen.add(key); owners.push(owner);
  }
  return Object.freeze(owners);
}
function validateReadyVideoPoolConfigs(value, env) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schema !== 1 ||
      Object.keys(value).sort().join() !== ["schema", "capacityDatabaseUrl", "transferDatabaseUrl"].sort().join()) fail();
  try {
    // Reuse the existing restricted-host/role/TLS validation, never pilot state.
    const { restrictedPoolConfig } = require("./production-pilot-config");
    return Object.freeze({ capacity: restrictedPoolConfig(value.capacityDatabaseUrl, "ia4tube_media_capacity_runtime", env),
      transfer: restrictedPoolConfig(value.transferDatabaseUrl, "ia4tube_media_transfer_runtime", env) });
  } catch { fail(); }
}
async function loadReadyVideoPoolConfigs({ filePath = POOL_CONFIG, env = process.env } = {}) {
  const fs = require("node:fs/promises"), path = require("node:path"), { constants } = require("node:fs");
  let bytes, handle;
  try {
    if (!path.isAbsolute(filePath) || /[\0\r\n]/.test(filePath)) fail();
    await require("./media-process-executor").safePath(path.dirname(filePath));
    const directory = await fs.stat(path.dirname(filePath));
    if (process.platform !== "win32" && ((directory.mode & 0o077) !== 0 || directory.uid !== process.getuid())) fail();
    const before = await fs.lstat(filePath);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 2 || before.size > 16384 ||
        process.platform !== "win32" && ((before.mode & 0o077) !== 0 || before.uid !== process.getuid())) fail();
    handle = await fs.open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.nlink !== 1) fail();
    bytes = await handle.readFile();
    const after = await handle.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || after.nlink !== 1) fail();
    return validateReadyVideoPoolConfigs(JSON.parse(bytes.toString("utf8")), env);
  } catch { fail(); }
  finally { bytes?.fill(0); await handle?.close(); }
}
module.exports = { ENABLED, SUBJECTS, ORIGIN, POOL_CONFIG, loadReadyVideoConfig, resolveReadyVideoOwners,
  validateReadyVideoPoolConfigs, loadReadyVideoPoolConfigs };
