// Defines the internal flyer/model metadata used as visual references for IA4Tube Empresas.
const path = require("path");

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeArray(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeText).filter(Boolean);
  }

  const text = normalizeText(value);
  return text ? [text] : [];
}

function normalizeBoolean(value, fallback = true) {
  if (typeof value === "boolean") return value;
  if (value === "false" || value === "0") return false;
  if (value === "true" || value === "1") return true;
  return fallback;
}

function normalizeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function slugify(value) {
  return normalizeText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function tokenize(value) {
  return slugify(value)
    .split("_")
    .map((item) => item.trim())
    .filter((item) => item.length >= 3);
}

function normalizeModelo(raw = {}, fallback = {}) {
  const ramo = normalizeText(raw.ramo || raw.nicho || fallback.ramo);
  const ramoSlug = slugify(raw.ramo_slug || raw.nicho_slug || ramo || fallback.ramo_slug);
  const id = normalizeText(raw.id || fallback.id || `${ramoSlug}_modelo`);
  const imagemExemplo = normalizeText(raw.imagem_exemplo || raw.preview || fallback.imagem_exemplo);
  const estilo = normalizeArray(raw.estilo);
  const paleta = normalizeArray(raw.paleta || raw.cores);
  const composicao = normalizeText(raw.composicao || raw.layout);
  const cta = normalizeText(raw.cta || raw.CTA);
  const elementos = normalizeArray(raw.elementos || raw.tags);

  return {
    id,
    versao: normalizeText(raw.versao || "1.0.0"),
    ativo: normalizeBoolean(raw.ativo, true),
    nicho: ramo,
    nicho_slug: ramoSlug,
    ramo,
    ramo_slug: ramoSlug,
    subtipo: normalizeText(raw.subtipo),
    objetivo: normalizeText(raw.objetivo),
    tipo_post: normalizeText(raw.tipo_post),
    formato: normalizeText(raw.formato || "feed"),
    estilo,
    paleta,
    composicao,
    densidade_texto: normalizeText(raw.densidade_texto),
    tipo_fundo: normalizeText(raw.tipo_fundo),
    iluminacao: normalizeText(raw.iluminacao),
    emocao_visual: normalizeText(raw.emocao_visual),
    foco_comercial: normalizeText(raw.foco_comercial || raw.objetivo),
    qualidade_visual: normalizeText(raw.qualidade_visual || "curado"),
    score: normalizeNumber(raw.score, 0),
    aprovacoes: normalizeNumber(raw.aprovacoes, 0),
    rejeicoes: normalizeNumber(raw.rejeicoes, 0),
    origem: normalizeText(raw.origem || "curadoria_manual"),
    criado_por: normalizeText(raw.criado_por || "IA4Tube"),
    tags: normalizeArray(raw.tags),
    // Campos legados mantidos para o pipeline atual e pedidos ja existentes.
    cores: paleta,
    layout: composicao,
    texto_principal: normalizeText(raw.texto_principal),
    cta,
    elementos,
    imagem_exemplo: imagemExemplo,
    criado_em: normalizeText(raw.criado_em),
    atualizado_em: normalizeText(raw.atualizado_em),
    usos: normalizeNumber(raw.usos, 0),
    arquivo_json: normalizeText(fallback.arquivo_json),
    imagem_exemplo_path: normalizeText(fallback.imagem_exemplo_path)
  };
}

function getModeloPublicData(modelo = {}) {
  return {
    id: modelo.id,
    versao: modelo.versao,
    ativo: modelo.ativo,
    nicho: modelo.nicho,
    nicho_slug: modelo.nicho_slug,
    ramo: modelo.ramo,
    ramo_slug: modelo.ramo_slug,
    subtipo: modelo.subtipo,
    objetivo: modelo.objetivo,
    tipo_post: modelo.tipo_post,
    formato: modelo.formato,
    estilo: modelo.estilo,
    paleta: modelo.paleta || [],
    composicao: modelo.composicao,
    densidade_texto: modelo.densidade_texto,
    tipo_fundo: modelo.tipo_fundo,
    iluminacao: modelo.iluminacao,
    emocao_visual: modelo.emocao_visual,
    foco_comercial: modelo.foco_comercial,
    qualidade_visual: modelo.qualidade_visual,
    score: modelo.score || 0,
    aprovacoes: modelo.aprovacoes || 0,
    rejeicoes: modelo.rejeicoes || 0,
    origem: modelo.origem,
    criado_por: modelo.criado_por,
    tags: modelo.tags || [],
    cores: modelo.cores || [],
    layout: modelo.layout,
    texto_principal: modelo.texto_principal,
    cta: modelo.cta,
    elementos: modelo.elementos || [],
    imagem_exemplo: modelo.imagem_exemplo,
    imagem_exemplo_path: modelo.imagem_exemplo_path,
    criado_em: modelo.criado_em,
    atualizado_em: modelo.atualizado_em,
    usos: modelo.usos || 0,
    arquivo_json: modelo.arquivo_json
  };
}

function resolveImagePath({ modelDir, imagemExemplo }) {
  const imageName = normalizeText(imagemExemplo);
  if (!imageName) return "";
  return path.join(modelDir, imageName);
}

module.exports = {
  getModeloPublicData,
  normalizeArray,
  normalizeBoolean,
  normalizeModelo,
  normalizeNumber,
  normalizeText,
  resolveImagePath,
  slugify,
  tokenize
};
