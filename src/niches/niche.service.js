const storage = require("./niche.storage");
const schema = require("./niche.schema");
const nicheAi = require("./niche.ai");

// Business rules for IA4Tube Empresas niches. This layer searches, creates,
// updates and counts usage while keeping the JSON storage format consistent.
function normalizeNicheStore(store) {
  const safeStore = {
    version: Number(store?.version || 1),
    niches: {}
  };

  Object.values(store?.niches || {}).forEach((niche) => {
    const normalized = normalizeNicheRecord(niche);
    if (normalized.id) {
      safeStore.niches[normalized.id] = normalized;
    }
  });

  return safeStore;
}

function normalizeNicheRecord(niche = {}) {
  const nome = schema.normalizeText(niche.nome || niche.name || niche.id);
  const id = schema.normalizeSlug(niche.id || nome);
  const now = new Date().toISOString();
  const dna = schema.normalizeDna(niche.dna);
  const dnaPreenchido = schema.hasDnaContent(dna);

  return {
    id,
    nome,
    aliases: schema.normalizeArray(niche.aliases),
    dna,
    dna_origem: schema.normalizeText(niche.dna_origem) || (dnaPreenchido ? "manual" : "fallback"),
    dna_status: schema.normalizeText(niche.dna_status) || (dnaPreenchido ? "gerado" : "pendente"),
    dna_gerado_em: schema.normalizeText(niche.dna_gerado_em),
    dna_erro: schema.normalizeText(niche.dna_erro),
    usos: Number(niche.usos || 0),
    criado_em: niche.criado_em || now,
    atualizado_em: niche.atualizado_em || now
  };
}

function buildDnaMetadata(result = {}) {
  const now = new Date().toISOString();

  return {
    dna: schema.normalizeDna(result.dna),
    dna_origem: result.origem || "fallback",
    dna_status: result.status || "pendente",
    dna_gerado_em: result.ok ? now : "",
    dna_erro: result.ok ? "" : schema.normalizeText(result.erro || "DNA pendente")
  };
}

function load(filePath) {
  return normalizeNicheStore(storage.readStore(filePath));
}

function save(store, filePath) {
  return storage.writeStore(normalizeNicheStore(store), filePath);
}

function procurarNicho(ramo, filePath) {
  const key = schema.normalizeSlug(ramo);
  if (!key) return null;

  const store = load(filePath);

  if (store.niches[key]) {
    return store.niches[key];
  }

  return Object.values(store.niches).find((niche) =>
    (niche.aliases || []).some((alias) => schema.normalizeSlug(alias) === key)
  ) || null;
}

function criarNicho({ nome, aliases = [], dna = {} } = {}, filePath) {
  const record = schema.createNicheRecord({ nome, aliases, dna });
  if (!record.id) return null;

  const store = load(filePath);
  const existing = procurarNicho(record.id, filePath);

  if (existing) {
    return existing;
  }

  store.niches[record.id] = record;
  save(store, filePath);
  return record;
}

function salvarNicho(niche, filePath) {
  const record = normalizeNicheRecord(niche);
  if (!record.id) return null;

  const store = load(filePath);
  store.niches[record.id] = record;
  save(store, filePath);
  return record;
}

function atualizarNicho(idOrRamo, patch = {}, filePath) {
  const existing = procurarNicho(idOrRamo, filePath);
  if (!existing) return null;

  const updated = normalizeNicheRecord({
    ...existing,
    ...patch,
    id: existing.id,
    nome: patch.nome || existing.nome,
    aliases: patch.aliases || existing.aliases,
    dna: patch.dna ? { ...existing.dna, ...patch.dna } : existing.dna,
    atualizado_em: new Date().toISOString()
  });

  return salvarNicho(updated, filePath);
}

function incrementarUsos(idOrRamo, filePath) {
  const existing = procurarNicho(idOrRamo, filePath);
  if (!existing) return null;

  return atualizarNicho(existing.id, {
    usos: Number(existing.usos || 0) + 1
  }, filePath);
}

function obterOuCriarNicho(ramo, filePath) {
  const found = procurarNicho(ramo, filePath);
  if (found) return found;

  return criarNicho({ nome: ramo, dna: schema.createEmptyDna() }, filePath);
}

async function obterOuCriarNichoComDna(ramo, context = {}, filePath) {
  const found = procurarNicho(ramo, filePath);

  if (found && schema.hasDnaContent(found.dna) && found.dna_status === "gerado") {
    return found;
  }

  const aiResult = await nicheAi.gerarDnaNicho({
    ...context,
    ramo
  });
  const metadata = buildDnaMetadata(aiResult);

  if (found) {
    return atualizarNicho(found.id, metadata, filePath) || found;
  }

  const created = criarNicho({
    nome: ramo,
    aliases: context.aliases || [],
    dna: metadata.dna
  }, filePath);

  if (!created) return null;

  return atualizarNicho(created.id, metadata, filePath) || created;
}

module.exports = {
  ...schema,
  load,
  save,
  procurarNicho,
  criarNicho,
  salvarNicho,
  atualizarNicho,
  incrementarUsos,
  obterOuCriarNicho,
  obterOuCriarNichoComDna,
  normalizeNicheRecord,
  normalizeNicheStore
};
