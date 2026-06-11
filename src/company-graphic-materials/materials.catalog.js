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

const RAMO_ALIASES = [
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

function isBlockedRamo(ramo) {
  const slug = normalizeSlug(ramo);
  return Boolean(slug && BLOCKED_RAMO_SLUGS.has(slug));
}

function folderForRamo(ramo) {
  const slug = normalizeSlug(ramo);
  if (!slug || isBlockedRamo(slug)) return "";

  if (BRANCH_FOLDERS.has(slug)) return slug;

  const alias = RAMO_ALIASES.find((entry) => entry.pattern.test(slug));
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
