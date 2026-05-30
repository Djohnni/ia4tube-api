const fs = require("fs");
const path = require("path");

const PROJECT_ROOT = path.join(__dirname, "..", "..");
const NICHOS_DIR = path.join(PROJECT_ROOT, "nichos");
const ALIASES_FILE = path.join(NICHOS_DIR, "aliases.json");
const MAX_SUMMARY_CHARS = 2400;
const MAX_CONTEXT_CHARS = 1800;

const PILOT_PRODUCT_TO_NICHE = {
  arte_empresa: "marketing_visual_empresas"
};

const NICHE_ALIASES = {
  marketing_visual_para_empresas: "marketing_visual_empresas",
  marketing_visual_empresas: "marketing_visual_empresas"
};

let nicheAliasesCache = null;

function normalizeNichoId(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function resolveNichoId(input, options = {}) {
  if (typeof input === "object" && input !== null) {
    const pilotProductKey = normalizeNichoId(
      input.product_id ||
      input.flyer_tipo ||
      input.categoria
    );

    const experimentalRamoEnabled = options.experimentalRamoEnabled === true;
    if (
      experimentalRamoEnabled &&
      pilotProductKey === "arte_empresa" &&
      input.ramo
    ) {
      const resolvedRamoNichoId = resolveExistingNichoId(input.ramo);
      if (resolvedRamoNichoId) {
        return resolvedRamoNichoId;
      }
    }

    if (PILOT_PRODUCT_TO_NICHE[pilotProductKey]) {
      return PILOT_PRODUCT_TO_NICHE[pilotProductKey];
    }
  }

  const raw = typeof input === "object" && input !== null
    ? input.niche_knowledge_id ||
      input.nicho_id ||
      input.niche_id ||
      input.ramo ||
      input.product_id ||
      input.flyer_tipo ||
      input.categoria
    : input;

  const key = normalizeNichoId(raw);
  if (!key) return "";

  if (PILOT_PRODUCT_TO_NICHE[key]) {
    return PILOT_PRODUCT_TO_NICHE[key];
  }

  return resolveAliasNichoId(key);
}

function isSafeNichoId(nichoId) {
  return /^[a-z0-9_]+$/.test(String(nichoId || ""));
}

function getNichoFolderPath(nichoId) {
  const safeId = normalizeNichoId(nichoId);
  if (!isSafeNichoId(safeId)) return "";

  const folderPath = path.join(NICHOS_DIR, safeId);
  const resolved = path.resolve(folderPath);
  const root = path.resolve(NICHOS_DIR);

  if (!resolved.startsWith(root + path.sep)) return "";
  return resolved;
}

function loadKnowledgeSummary(nichoId) {
  try {
    const folderPath = getNichoFolderPath(nichoId);
    if (!folderPath) {
      return { ok: false, nichoId: "", text: "", reason: "invalid_nicho_id" };
    }

    const summaryPath = path.join(folderPath, "KNOWLEDGE_SUMMARY.md");
    if (!fs.existsSync(summaryPath)) {
      return { ok: false, nichoId: normalizeNichoId(nichoId), text: "", reason: "summary_not_found", path: summaryPath };
    }

    const text = fs.readFileSync(summaryPath, "utf8").trim();
    if (!text) {
      return { ok: false, nichoId: normalizeNichoId(nichoId), text: "", reason: "summary_empty", path: summaryPath };
    }

    return {
      ok: true,
      nichoId: normalizeNichoId(nichoId),
      text: limitText(text, MAX_SUMMARY_CHARS),
      path: summaryPath,
      truncated: text.length > MAX_SUMMARY_CHARS
    };
  } catch (error) {
    return {
      ok: false,
      nichoId: normalizeNichoId(nichoId),
      text: "",
      reason: "summary_read_error",
      error: error?.message || "unknown_error"
    };
  }
}

function buildKnowledgeContext(nichoId, summary) {
  const summaryText = typeof summary === "string" ? summary : summary?.text;
  const safeId = normalizeNichoId(nichoId);
  const compact = compactMarkdown(summaryText || "");

  if (!safeId || !compact) return "";

  return limitText(`CONHECIMENTO DO NICHO (${safeId}):\n${compact}`, MAX_CONTEXT_CHARS);
}

function isNicheEngineEnabled(env = process.env) {
  const value = String(env.ENABLE_NICHO_ENGINE || "").trim().toLowerCase();
  return ["1", "true", "on", "yes", "sim", "ligado"].includes(value);
}

function isExperimentalRamoEnabled(env = process.env) {
  const value = String(env.ENABLE_NICHO_ENGINE_EXPERIMENTAL_RAMO || "").trim().toLowerCase();
  return ["1", "true", "on", "yes", "sim", "ligado"].includes(value);
}

function buildNicheKnowledgeForInput(input, options = {}) {
  const enabled = options.enabled ?? isNicheEngineEnabled(options.env || process.env);
  if (!enabled) {
    return { ok: false, enabled: false, nichoId: "", context: "", reason: "engine_disabled" };
  }

  const env = options.env || process.env;
  const nichoId = resolveNichoId(input, {
    experimentalRamoEnabled: options.experimentalRamoEnabled ?? isExperimentalRamoEnabled(env)
  });
  if (!nichoId) {
    return { ok: false, enabled: true, nichoId: "", context: "", reason: "nicho_not_resolved" };
  }

  const summary = loadKnowledgeSummary(nichoId);
  if (!summary.ok) {
    return { ok: false, enabled: true, nichoId, context: "", reason: summary.reason, summary };
  }

  const context = buildKnowledgeContext(nichoId, summary);
  if (!context) {
    return { ok: false, enabled: true, nichoId, context: "", reason: "context_empty", summary };
  }

  return { ok: true, enabled: true, nichoId, context, summary };
}

function compactMarkdown(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .filter((line) => !line.startsWith("```"))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function limitText(text, maxChars) {
  const value = String(text || "");
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 24)).trim()}\n... [conteudo reduzido]`;
}

function knowledgeSummaryExists(nichoId) {
  const folderPath = getNichoFolderPath(nichoId);
  if (!folderPath) return false;
  const summaryPath = path.join(folderPath, "KNOWLEDGE_SUMMARY.md");
  return fs.existsSync(summaryPath) && fs.statSync(summaryPath).isFile();
}

function resolveExistingNichoId(value) {
  const nichoId = resolveAliasNichoId(value);
  if (!nichoId) return "";
  return knowledgeSummaryExists(nichoId) ? nichoId : "";
}

function resolveAliasNichoId(value) {
  const key = normalizeNichoId(value);
  if (!key) return "";
  const aliases = getNicheAliases();
  return aliases[key] || key;
}

function getNicheAliases() {
  if (nicheAliasesCache) return nicheAliasesCache;

  const aliases = { ...NICHE_ALIASES };

  try {
    if (fs.existsSync(ALIASES_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(ALIASES_FILE, "utf8"));
      const source = parsed && typeof parsed === "object" && parsed.aliases
        ? parsed.aliases
        : parsed;

      if (source && typeof source === "object" && !Array.isArray(source)) {
        for (const [from, to] of Object.entries(source)) {
          const aliasFrom = normalizeNichoId(from);
          const aliasTo = normalizeNichoId(to);
          if (aliasFrom && aliasTo) {
            aliases[aliasFrom] = aliasTo;
          }
        }
      }
    }
  } catch (_) {
    // Aliases are optional. If the file is invalid, keep the built-in aliases.
  }

  nicheAliasesCache = aliases;
  return nicheAliasesCache;
}

module.exports = {
  resolveNichoId,
  loadKnowledgeSummary,
  buildKnowledgeContext,
  isNicheEngineEnabled,
  isExperimentalRamoEnabled,
  buildNicheKnowledgeForInput,
  normalizeNichoId,
  getNichoFolderPath
};
