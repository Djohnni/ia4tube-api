const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const STORAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/;

function requireStorageId(value, label = "id") {
  const id = String(value || "").trim();
  if (!STORAGE_ID_PATTERN.test(id)) {
    const error = new Error(`${label} invalido.`);
    error.statusCode = 400;
    error.code = "invalid_storage_identifier";
    throw error;
  }
  return id;
}

function resolveContained(baseDir, ...segments) {
  const root = path.resolve(baseDir);
  const resolved = path.resolve(root, ...segments);
  const relative = path.relative(root, resolved);
  if (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  ) {
    return resolved;
  }
  const error = new Error("Caminho de armazenamento recusado.");
  error.statusCode = 400;
  error.code = "storage_path_outside_root";
  throw error;
}

function existingFileIsContained(baseDir, filePath) {
  try {
    const root = fs.realpathSync(baseDir);
    const file = fs.realpathSync(filePath);
    const relative = path.relative(root, file);
    return Boolean(
      relative &&
      !relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative) &&
      fs.statSync(file).isFile()
    );
  } catch {
    return false;
  }
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8") || "null");
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tempPath, filePath);
}

function campaignDir(baseDir, campaignId) {
  return resolveContained(baseDir, requireStorageId(campaignId, "campaign_id"));
}

function campaignFile(baseDir, campaignId) {
  return path.join(campaignDir(baseDir, campaignId), "campanha.json");
}

function distributionFile(baseDir, campaignId) {
  return path.join(campaignDir(baseDir, campaignId), "distribuicao.json");
}

function artDir(baseDir, campaignId, artId) {
  return resolveContained(
    campaignDir(baseDir, campaignId),
    "artes",
    requireStorageId(artId, "art_id")
  );
}

function artFile(baseDir, campaignId, artId) {
  return path.join(artDir(baseDir, campaignId, artId), "arte.json");
}

function auditFile(baseDir, campaignId) {
  return path.join(campaignDir(baseDir, campaignId), "auditoria.jsonl");
}

function readCampaign(baseDir, campaignId) {
  return readJson(campaignFile(baseDir, campaignId), null);
}

function writeCampaign(baseDir, campaign) {
  writeJson(campaignFile(baseDir, campaign.id), campaign);
}

function readDistribution(baseDir, campaignId) {
  const data = readJson(distributionFile(baseDir, campaignId), { assignments: [] });
  return data && typeof data === "object" && !Array.isArray(data) ? data : { assignments: [] };
}

function writeDistribution(baseDir, campaignId, distribution) {
  writeJson(distributionFile(baseDir, campaignId), distribution);
}

function readArt(baseDir, campaignId, artId) {
  return readJson(artFile(baseDir, campaignId, artId), null);
}

function writeArt(baseDir, campaignId, art) {
  writeJson(artFile(baseDir, campaignId, art.id), art);
}

function appendAudit(baseDir, campaignId, entry) {
  ensureDir(campaignDir(baseDir, campaignId));
  fs.appendFileSync(
    auditFile(baseDir, campaignId),
    `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
    "utf8"
  );
}

function listCampaignIds(baseDir) {
  if (!fs.existsSync(baseDir)) return [];

  return fs.readdirSync(baseDir)
    .filter((name) => STORAGE_ID_PATTERN.test(name))
    .filter((name) => {
      const dir = path.join(baseDir, name);
      return fs.existsSync(path.join(dir, "campanha.json"));
    })
    .sort()
    .reverse();
}

function listCampaigns(baseDir) {
  return listCampaignIds(baseDir)
    .map((id) => readCampaign(baseDir, id))
    .filter(Boolean);
}

function listArts(baseDir, campaignId) {
  const dir = path.join(campaignDir(baseDir, campaignId), "artes");
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir)
    .filter((artId) => STORAGE_ID_PATTERN.test(artId))
    .map((artId) => readArt(baseDir, campaignId, artId))
    .filter(Boolean)
    .sort((a, b) => Number(a.index || 0) - Number(b.index || 0));
}

module.exports = {
  ensureDir,
  requireStorageId,
  resolveContained,
  existingFileIsContained,
  readJson,
  writeJson,
  campaignDir,
  campaignFile,
  distributionFile,
  artDir,
  artFile,
  readCampaign,
  writeCampaign,
  readDistribution,
  writeDistribution,
  readArt,
  writeArt,
  appendAudit,
  listCampaigns,
  listArts
};
