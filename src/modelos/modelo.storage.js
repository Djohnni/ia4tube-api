// Storage helpers for the local internal flyer/model bank.
const fs = require("fs");
const path = require("path");
const schema = require("./modelo.schema");

const DEFAULT_MODELOS_DIR = path.resolve(__dirname, "..", "..", "banco_modelos");
const INDEX_FILE = path.join(DEFAULT_MODELOS_DIR, "index.json");

function ensureDir(dirPath = DEFAULT_MODELOS_DIR) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function listJsonFiles(dirPath = DEFAULT_MODELOS_DIR) {
  if (!fs.existsSync(dirPath)) return [];

  const files = [];
  const walk = (currentDir) => {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) {
        files.push(fullPath);
      }
    }
  };

  walk(dirPath);
  return files.sort();
}

function listModelJsonFiles(dirPath = DEFAULT_MODELOS_DIR) {
  return listJsonFiles(dirPath).filter((filePath) => {
    const name = path.basename(filePath).toLowerCase();
    const normalized = filePath.replace(/\\/g, "/").toLowerCase();
    return (name === "metadata.json" && normalized.includes("/ativos/")) || /^modelo_.+\.json$/i.test(name);
  });
}

function normalizeFileModel(filePath) {
  const raw = readJson(filePath);
  const modelDir = path.dirname(filePath);
  const imagemExemplo = schema.normalizeText(raw.imagem_exemplo || raw.preview || "preview.jpg");
  return schema.normalizeModelo(raw, {
    id: path.basename(filePath, ".json"),
    ramo_slug: path.basename(modelDir),
    arquivo_json: filePath,
    imagem_exemplo_path: schema.resolveImagePath({ modelDir, imagemExemplo })
  });
}

function loadModelosFromFiles(dirPath = DEFAULT_MODELOS_DIR) {
  const modelos = [];
  const ids = new Set();
  const metadataFiles = listModelJsonFiles(dirPath).filter((filePath) => {
    return path.basename(filePath).toLowerCase() === "metadata.json";
  });
  const legacyFiles = listModelJsonFiles(dirPath).filter((filePath) => {
    return path.basename(filePath).toLowerCase() !== "metadata.json";
  });

  for (const filePath of [...metadataFiles, ...legacyFiles]) {
    try {
      const modelo = normalizeFileModel(filePath);
      if (!modelo.ativo || ids.has(modelo.id)) continue;
      ids.add(modelo.id);
      modelos.push(modelo);
    } catch {
      // Modelo invalido nao entra no indice nem na busca.
    }
  }

  return modelos;
}

function readIndex(indexPath = INDEX_FILE) {
  if (!fs.existsSync(indexPath)) return null;
  const parsed = readJson(indexPath);
  if (!parsed || !Array.isArray(parsed.modelos)) return null;
  return parsed;
}

function buildIndex(dirPath = DEFAULT_MODELOS_DIR) {
  ensureDir(dirPath);
  const modelos = loadModelosFromFiles(dirPath).map(schema.getModeloPublicData);
  const index = {
    versao: "1.0.0",
    gerado_em: new Date().toISOString(),
    total_modelos_ativos: modelos.length,
    modelos
  };
  writeJson(path.join(dirPath, "index.json"), index);
  return index;
}

function loadModelos(dirPath = DEFAULT_MODELOS_DIR) {
  const index = readIndex(path.join(dirPath, "index.json"));
  if (index) {
    return index.modelos.map((raw) => schema.normalizeModelo(raw, {
      arquivo_json: raw.arquivo_json,
      imagem_exemplo_path: raw.imagem_exemplo_path
    })).filter((modelo) => modelo.ativo);
  }

  return loadModelosFromFiles(dirPath);
}

function updateModelo(filePath, patch = {}) {
  const current = readJson(filePath);
  const next = {
    ...current,
    ...patch,
    atualizado_em: new Date().toISOString()
  };
  writeJson(filePath, next);
  return next;
}

module.exports = {
  DEFAULT_MODELOS_DIR,
  INDEX_FILE,
  buildIndex,
  ensureDir,
  listModelJsonFiles,
  loadModelosFromFiles,
  loadModelos,
  readIndex,
  readJson,
  updateModelo,
  writeJson
};
