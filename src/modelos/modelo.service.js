// Finds the closest internal flyer/model reference for IA4Tube Empresas orders.
const schema = require("./modelo.schema");
const storage = require("./modelo.storage");

function intersectCount(a = [], b = []) {
  const setB = new Set(b);
  return a.filter((item) => setB.has(item)).length;
}

function getStyleText(modelo = {}) {
  return [
    ...(Array.isArray(modelo.estilo) ? modelo.estilo : [modelo.estilo]),
    modelo.layout,
    modelo.composicao,
    modelo.tipo_fundo,
    modelo.iluminacao,
    modelo.emocao_visual,
    modelo.foco_comercial,
    ...(modelo.paleta || []),
    ...(modelo.cores || []),
    ...(modelo.elementos || []),
    ...(modelo.tags || [])
  ].filter(Boolean).join(" ");
}

function scoreModelo(modelo, query = {}) {
  const ramoSlug = schema.slugify(query.ramo);
  const objetivoTokens = schema.tokenize(query.objetivo);
  const tipoPostTokens = schema.tokenize(query.tipo_post);
  const estiloTokens = schema.tokenize(query.estilo);

  let score = 0;
  const detalhes = [];

  if (ramoSlug && modelo.ramo_slug === ramoSlug) {
    score += 50;
    detalhes.push("ramo:+50");
  }

  const modeloObjetivoTokens = schema.tokenize(modelo.objetivo);
  const objetivoMatches = intersectCount(objetivoTokens, modeloObjetivoTokens);
  if (objetivoMatches) {
    const points = Math.min(20, objetivoMatches * 10);
    score += points;
    detalhes.push(`objetivo:+${points}`);
  }

  const modeloTipoTokens = schema.tokenize(modelo.tipo_post);
  const tipoMatches = intersectCount(tipoPostTokens, modeloTipoTokens);
  if (tipoMatches) {
    const points = Math.min(15, tipoMatches * 15);
    score += points;
    detalhes.push(`tipo_post:+${points}`);
  }

  const modeloEstiloTokens = schema.tokenize(getStyleText(modelo));
  const estiloMatches = intersectCount(estiloTokens, modeloEstiloTokens);
  if (estiloMatches) {
    const points = Math.min(15, estiloMatches * 5);
    score += points;
    detalhes.push(`estilo:+${points}`);
  }

  const usoBonus = Math.min(5, Number(modelo.usos || 0));
  if (usoBonus) {
    score += usoBonus;
    detalhes.push(`usos:+${usoBonus}`);
  }

  const qualidadeBonus = Math.min(5, Math.max(0, Number(modelo.score || 0) / 20));
  if (qualidadeBonus) {
    score += qualidadeBonus;
    detalhes.push(`qualidade:+${qualidadeBonus}`);
  }

  return {
    score,
    detalhes
  };
}

function buildQuery({ ramo = "", objetivo = "", tipo_post = "", estilo = "", niche_dna = {} } = {}) {
  const dnaTipoPost = Array.isArray(niche_dna.tipos_de_post) ? niche_dna.tipos_de_post.join(" ") : "";
  const dnaEstilo = [
    niche_dna.estilo_visual,
    niche_dna.tipo_layout,
    Array.isArray(niche_dna.cores_sugeridas) ? niche_dna.cores_sugeridas.join(" ") : ""
  ].filter(Boolean).join(" ");

  return {
    ramo: schema.normalizeText(ramo),
    objetivo: schema.normalizeText(objetivo),
    tipo_post: schema.normalizeText(tipo_post || dnaTipoPost),
    estilo: schema.normalizeText(estilo || dnaEstilo)
  };
}

function procurarModeloParecido(input = {}, dirPath) {
  const query = buildQuery(input);
  const modelos = storage.loadModelos(dirPath);

  const scored = modelos.map((modelo) => {
    const score = scoreModelo(modelo, query);
    return {
      modelo,
      score: score.score,
      detalhes_score: score.detalhes
    };
  }).sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return Number(b.modelo.usos || 0) - Number(a.modelo.usos || 0);
  });

  const best = scored[0];
  if (!best || best.score < 50) {
    return {
      encontrado: false,
      modelo: null,
      score: best?.score || 0,
      detalhes_score: best?.detalhes_score || [],
      candidatos: scored.length,
      motivo: "Nenhum modelo parecido encontrado"
    };
  }

  return {
    encontrado: true,
    modelo: schema.getModeloPublicData(best.modelo),
    score: best.score,
    detalhes_score: best.detalhes_score,
    candidatos: scored.length,
    motivo: "Modelo encontrado"
  };
}

function incrementarUsoModelo(modeloReferencia = {}) {
  if (!modeloReferencia.arquivo_json) return null;

  try {
    const usos = Number(modeloReferencia.usos || 0) + 1;
    storage.updateModelo(modeloReferencia.arquivo_json, { usos });
    storage.buildIndex();
    return usos;
  } catch {
    return null;
  }
}

module.exports = {
  buildQuery,
  incrementarUsoModelo,
  procurarModeloParecido,
  scoreModelo
};
