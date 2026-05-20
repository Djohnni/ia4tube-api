// Defines the internal niche record and the reusable visual/commercial DNA shape.
const DNA_KEYS = [
  "estilo_visual",
  "publico_alvo",
  "cores_sugeridas",
  "tipo_layout",
  "ofertas_comuns",
  "chamadas",
  "ctas",
  "elementos_visuais",
  "tipos_de_post"
];

const DEFAULT_DNA = Object.freeze({
  estilo_visual: "",
  publico_alvo: [],
  cores_sugeridas: [],
  tipo_layout: [],
  ofertas_comuns: [],
  chamadas: [],
  ctas: [],
  elementos_visuais: [],
  tipos_de_post: []
});

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeSlug(value) {
  return normalizeText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeArray(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeText).filter(Boolean);
  }

  const text = normalizeText(value);
  return text ? [text] : [];
}

function normalizeDna(dna = {}) {
  return DNA_KEYS.reduce((acc, key) => {
    const defaultValue = DEFAULT_DNA[key];
    acc[key] = Array.isArray(defaultValue)
      ? normalizeArray(dna[key])
      : normalizeText(dna[key]);
    return acc;
  }, {});
}

function createEmptyDna() {
  return normalizeDna(DEFAULT_DNA);
}

function hasDnaContent(dna = {}) {
  const normalized = normalizeDna(dna);

  return DNA_KEYS.some((key) => {
    const value = normalized[key];
    return Array.isArray(value) ? value.length > 0 : !!value;
  });
}

function createNicheRecord({ nome, aliases = [], dna = {}, usos = 0 } = {}) {
  const nomeNormalizado = normalizeText(nome);
  const id = normalizeSlug(nomeNormalizado);
  const now = new Date().toISOString();
  const normalizedDna = normalizeDna(dna);
  const dnaPreenchido = hasDnaContent(normalizedDna);

  return {
    id,
    nome: nomeNormalizado,
    aliases: normalizeArray(aliases),
    dna: normalizedDna,
    dna_origem: dnaPreenchido ? "manual" : "fallback",
    dna_status: dnaPreenchido ? "gerado" : "pendente",
    dna_gerado_em: dnaPreenchido ? now : "",
    dna_erro: dnaPreenchido ? "" : "DNA ainda nao gerado",
    usos: Number(usos || 0),
    criado_em: now,
    atualizado_em: now
  };
}

module.exports = {
  DNA_KEYS,
  DEFAULT_DNA,
  createEmptyDna,
  createNicheRecord,
  hasDnaContent,
  normalizeArray,
  normalizeDna,
  normalizeSlug,
  normalizeText
};
