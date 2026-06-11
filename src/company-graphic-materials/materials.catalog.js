const { normalizeSlug } = require("../niches/niche.schema");
const registry = require("./materials.registry.json");

const GENERAL_SCOPE = "geral";
const BRANCH_SCOPE = "ramo";
const BLOCKED_RAMO_SLUGS = new Set([
  "funeraria",
  "servicos_funerarios",
  "velorio",
  "cemiterio"
]);

const WEAK_WORDS = new Set([
  "a",
  "as",
  "o",
  "os",
  "de",
  "da",
  "das",
  "do",
  "dos",
  "para",
  "em",
  "com"
]);

const LEGACY_RAMO_ALIASES = [
  { pattern: /vidrac/, folder: "vidracaria" },
  { pattern: /lava|estetica_automotiva|automotivo|veiculo|carro/, folder: "lava_jato" },
  { pattern: /constr|obra|empreiteira/, folder: "construcao" },
  { pattern: /restaurante|lanchonete|pizzaria|hamburgueria|bar/, folder: "restaurante" },
  { pattern: /clinica_odontologica|clinica.*odont|consultorio.*odont/, folder: "clinica_odontologica" },
  { pattern: /clinica_estetica|clinica.*estetic|estetica_facial|estetica_corporal/, folder: "clinica_estetica" },
  { pattern: /clinica_medica|clinica.*medic|consultorio.*medic|saude/, folder: "clinica_medica" },
  { pattern: /clinica_veterinaria|veterin|pet/, folder: "veterinaria" },
  { pattern: /otica|optica|oculos/, folder: "otica" },
  { pattern: /farmacia|drogaria/, folder: "farmacia" },
  { pattern: /dentista|consultorio.*dent/, folder: "dentista" },
  { pattern: /clinica|consultorio/, folder: "clinica" }
];

function normalizePlans(plans) {
  return Array.isArray(plans)
    ? plans.map((plan) => String(plan || "").trim().toLowerCase()).filter(Boolean)
    : [];
}

function normalizeMaterial(item, index) {
  const id = normalizeSlug(item?.id || item?.title);
  const title = String(item?.title || "").trim();
  const type = String(item?.type || "").trim();
  const scope = String(item?.scope || "").trim() === BRANCH_SCOPE ? BRANCH_SCOPE : GENERAL_SCOPE;
  const scopeFolder = scope === GENERAL_SCOPE
    ? "_geral"
    : normalizeSlug(item?.ramo_folder || item?.scopeFolder || "");

  if (!id || !title || type !== "print_image") return null;
  if (scope === BRANCH_SCOPE && !scopeFolder) return null;

  return {
    id,
    title,
    type,
    scope,
    scopeFolder,
    ramo_folder: scopeFolder,
    format: String(item.format || "png").toLowerCase(),
    width: Number(item.width || 1240),
    height: Number(item.height || 1754),
    plans: normalizePlans(item.plans),
    order: Number(item.order || index + 1)
  };
}

const MATERIALS = (Array.isArray(registry) ? registry : registry.materials || [])
  .map(normalizeMaterial)
  .filter(Boolean);

const BRANCH_FOLDERS = new Set(
  MATERIALS
    .filter((material) => material.scope === BRANCH_SCOPE)
    .map((material) => material.scopeFolder)
);

function slugTokens(value) {
  const slug = normalizeSlug(value);
  return slug ? slug.split("_").filter(Boolean) : [];
}

function singularizeToken(token) {
  if (!token || token.length <= 3) return token;
  if (token.endsWith("oes") && token.length > 5) return `${token.slice(0, -3)}ao`;
  if (token.endsWith("ais") && token.length > 5) return `${token.slice(0, -3)}al`;
  if (token.endsWith("eis") && token.length > 5) return `${token.slice(0, -3)}el`;
  if (/[aeo]s$/.test(token)) return token.slice(0, -1);
  return token;
}

function comparableKey(value) {
  return slugTokens(value)
    .filter((token) => !WEAK_WORDS.has(token))
    .map(singularizeToken)
    .join("_");
}

function buildUniqueIndex(values, keyFn) {
  const map = new Map();
  const ambiguous = new Set();

  for (const value of values) {
    const key = keyFn(value);
    if (!key) continue;

    if (map.has(key) && map.get(key) !== value) {
      ambiguous.add(key);
      map.delete(key);
    } else if (!ambiguous.has(key)) {
      map.set(key, value);
    }
  }

  return map;
}

const BRANCH_FOLDER_LIST = Array.from(BRANCH_FOLDERS);
const BRANCH_FOLDER_BY_COMPARABLE_KEY = buildUniqueIndex(BRANCH_FOLDER_LIST, comparableKey);

function tokenSetFromComparableKey(key) {
  return new Set(String(key || "").split("_").filter(Boolean));
}

function isSubset(subset, target) {
  if (!subset.size || !target.size) return false;
  for (const token of subset) {
    if (!target.has(token)) return false;
  }
  return true;
}

function resolveByTokenContainment(key) {
  const inputTokens = tokenSetFromComparableKey(key);
  const matches = [];

  for (const folder of BRANCH_FOLDER_LIST) {
    const folderKey = comparableKey(folder);
    const folderTokens = tokenSetFromComparableKey(folderKey);
    const inputIncludesFolder = isSubset(folderTokens, inputTokens);
    const folderIncludesInput = inputTokens.size >= 2 && isSubset(inputTokens, folderTokens);

    if (!inputIncludesFolder && !folderIncludesInput) continue;

    matches.push({
      folder,
      score: Math.max(folderTokens.size, inputTokens.size),
      folderSize: folderTokens.size
    });
  }

  matches.sort((a, b) => b.score - a.score || b.folderSize - a.folderSize || a.folder.localeCompare(b.folder));
  if (matches.length === 1) return matches[0].folder;
  if (matches.length > 1 && matches[0].score > matches[1].score) return matches[0].folder;
  return "";
}

function isBlockedRamo(ramo) {
  const slug = normalizeSlug(ramo);
  return Boolean(slug && BLOCKED_RAMO_SLUGS.has(slug));
}

function folderForRamo(ramo) {
  const slug = normalizeSlug(ramo);
  if (!slug || isBlockedRamo(slug)) return "";

  if (BRANCH_FOLDERS.has(slug)) return slug;

  const comparable = comparableKey(slug);
  const exactComparable = BRANCH_FOLDER_BY_COMPARABLE_KEY.get(comparable);
  if (exactComparable) return exactComparable;

  const containmentMatch = resolveByTokenContainment(comparable);
  if (containmentMatch) return containmentMatch;

  const alias = LEGACY_RAMO_ALIASES.find((entry) => entry.pattern.test(slug));
  return alias && BRANCH_FOLDERS.has(alias.folder) ? alias.folder : slug;
}

function listMaterialsForRamo(ramo) {
  if (isBlockedRamo(ramo)) return [];

  const branchFolder = folderForRamo(ramo);
  return MATERIALS
    .filter((material) => material.scope === GENERAL_SCOPE || material.scopeFolder === branchFolder)
    .sort((a, b) => {
      if (a.scope !== b.scope) return a.scope === GENERAL_SCOPE ? -1 : 1;
      return a.order - b.order || a.title.localeCompare(b.title);
    });
}

module.exports = {
  GENERAL_SCOPE,
  BRANCH_SCOPE,
  folderForRamo,
  isBlockedRamo,
  listMaterialsForRamo
};
