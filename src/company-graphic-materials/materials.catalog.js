const fs = require("fs");
const path = require("path");
const { normalizeSlug } = require("../niches/niche.schema");

const NICHOS_DIR = path.join(__dirname, "..", "..", "nichos");
const MATERIALS_DIR = "materiais_graficos";
const GENERAL_SCOPE = "geral";
const BRANCH_SCOPE = "ramo";

const RAMO_ALIASES = [
  { pattern: /vidrac/, folder: "vidracaria" },
  { pattern: /lava|estetica_automotiva|automotivo|veiculo|carro/, folder: "lava_jato" },
  { pattern: /constr|obra|empreiteira/, folder: "construcao" },
  { pattern: /restaurante|lanchonete|pizzaria|hamburgueria|bar/, folder: "restaurante" },
  { pattern: /clinica|consultorio|medic|saude/, folder: "clinica" }
];

function materialFolder(scopeFolder) {
  return path.join(NICHOS_DIR, scopeFolder, MATERIALS_DIR);
}

function readCatalog(scopeFolder, scope) {
  const catalogPath = path.join(materialFolder(scopeFolder), "catalogo.json");
  if (!fs.existsSync(catalogPath)) return [];

  const raw = JSON.parse(fs.readFileSync(catalogPath, "utf8") || "{}");
  const items = Array.isArray(raw) ? raw : Array.isArray(raw.materials) ? raw.materials : [];

  return items
    .map((item, index) => normalizeCatalogItem(item, { scopeFolder, scope, index }))
    .filter(Boolean);
}

function normalizeCatalogItem(item, { scopeFolder, scope, index }) {
  const id = normalizeSlug(item?.id || item?.title);
  const title = String(item?.title || "").trim();
  const type = String(item?.type || "").trim();

  if (!id || !title || type !== "print_image") return null;

  return {
    id,
    title,
    type,
    scope,
    scopeFolder,
    format: String(item.format || "png").toLowerCase(),
    width: Number(item.width || 1240),
    height: Number(item.height || 1754),
    prompt: String(item.prompt || "").trim(),
    plans: Array.isArray(item.plans) ? item.plans.map((plan) => String(plan).trim().toLowerCase()).filter(Boolean) : [],
    order: Number(item.order || index + 1)
  };
}

function folderForRamo(ramo) {
  const slug = normalizeSlug(ramo);
  if (!slug) return "";

  const alias = RAMO_ALIASES.find((entry) => entry.pattern.test(slug));
  return alias ? alias.folder : slug;
}

function listMaterialsForRamo(ramo) {
  const general = readCatalog("_geral", GENERAL_SCOPE);
  const branchFolder = folderForRamo(ramo);
  const branch = branchFolder ? readCatalog(branchFolder, BRANCH_SCOPE) : [];

  return [...general, ...branch].sort((a, b) => {
    if (a.scope !== b.scope) return a.scope === GENERAL_SCOPE ? -1 : 1;
    return a.order - b.order || a.title.localeCompare(b.title);
  });
}

function resolvePromptPath(material) {
  if (!material?.prompt) return "";

  const baseDir = materialFolder(material.scopeFolder);
  const promptPath = path.resolve(baseDir, material.prompt);

  if (!promptPath.startsWith(path.resolve(baseDir))) return "";
  return promptPath;
}

module.exports = {
  GENERAL_SCOPE,
  BRANCH_SCOPE,
  folderForRamo,
  listMaterialsForRamo,
  resolvePromptPath
};
