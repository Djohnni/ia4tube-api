const fs = require("fs");
const path = require("path");

// File-backed storage for IA4Tube Empresas niches. It is intentionally small
// and JSON-based so the new architecture can be introduced without a database.
const DEFAULT_NICHES_FILE = process.env.IA4_NICHES_FILE ||
  (process.env.DATA_DIR
    ? path.join(process.env.DATA_DIR, "nichos.json")
    : path.join(__dirname, "..", "..", "data", "nichos.json"));

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function emptyStore() {
  return {
    version: 1,
    niches: {}
  };
}

function ensureStore(filePath = DEFAULT_NICHES_FILE) {
  ensureDir(path.dirname(filePath));

  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(emptyStore(), null, 2), "utf8");
  }

  return filePath;
}

function readStore(filePath = DEFAULT_NICHES_FILE) {
  ensureStore(filePath);

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8") || "{}");
    return {
      version: Number(parsed.version || 1),
      niches: parsed.niches && typeof parsed.niches === "object" ? parsed.niches : {}
    };
  } catch {
    return emptyStore();
  }
}

function writeStore(store, filePath = DEFAULT_NICHES_FILE) {
  ensureStore(filePath);

  const safeStore = {
    version: Number(store?.version || 1),
    niches: store?.niches && typeof store.niches === "object" ? store.niches : {}
  };

  fs.writeFileSync(filePath, JSON.stringify(safeStore, null, 2), "utf8");
  return safeStore;
}

module.exports = {
  DEFAULT_NICHES_FILE,
  emptyStore,
  ensureStore,
  readStore,
  writeStore
};
