const path = require("path");
const fs = require("fs");
const orderStorage = require("./order.storage");
const orderStatus = require("./order.status");
const nicheService = require("../niches/niche.service");
const nicheKnowledgeEngine = require("../niches/nicheKnowledge.engine");
const modeloService = require("../modelos/modelo.service");

function buildOrderBasePath({ pedidosDir, whatsapp, mesAtual, id }) {
  return path.join(pedidosDir, whatsapp, mesAtual, id);
}

function ensureOrderDirectory(base) {
  orderStorage.ensureDir(base);
}

function safeParseJsonObject(value, fallback = {}) {
  if (!value) return fallback;

  if (typeof value === "object" && !Array.isArray(value)) {
    return value;
  }

  if (typeof value !== "string") return fallback;

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function normalizeNewOrderModel(body = {}) {
  const schemaVersion = Number(body.schema_version || body.schemaVersion || 0);
  const explicitProductId = body.product_id ? String(body.product_id) : "";
  const legacyCompanyProductId = body.flyer_tipo === "arte_empresa" || body.categoria === "arte_empresa"
    ? "arte_empresa"
    : "";

  return {
    schema_version: Number.isFinite(schemaVersion) && schemaVersion > 0 ? schemaVersion : undefined,
    product_id: explicitProductId || legacyCompanyProductId,
    fields: safeParseJsonObject(body.fields_json || body.fields, {}),
    assets: safeParseJsonObject(body.assets_json || body.assets, {})
  };
}

function firstText(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }

  return "";
}

function normalizeOrderBody(body = {}) {
  const newModel = normalizeNewOrderModel(body);
  const companyFields = newModel.fields || {};

  return {
    rodada: body.rodada,
    data: body.data,
    hora: body.hora,
    arena: body.arena,
    mascote_tipo: body.mascote_tipo,
    flyer_tipo: body.flyer_tipo,
    artilheiros: body.artilheiros,
    jogadores_json: body.jogadores_json,
    jogadores_texto: body.jogadores_texto,
    time_principal: body.time_principal,
    gols_time_principal: body.gols_time_principal,
    gols_adversario: body.gols_adversario,
    time_adversario: body.time_adversario,
    ramo: firstText(body.ramo, companyFields.ramo),
    nome_empresa: firstText(body.nome_empresa, companyFields.nome_empresa, companyFields.company_name),
    objetivo: firstText(body.objetivo, companyFields.objetivo, companyFields.objective),
    oferta: firstText(body.oferta, companyFields.oferta, companyFields.offer),
    cta: firstText(body.cta, companyFields.cta),
    whatsapp_contato: firstText(body.whatsapp_contato, body.whatsapp_empresa, body.whatsapp, companyFields.whatsapp),
    instagram: firstText(body.instagram, companyFields.instagram),
    observacoes: firstText(body.observacoes, companyFields.observacoes, companyFields.notes),
    new_model: newModel
  };
}

function hasRequiredOrderFields(fields) {
  const productId = fields?.new_model?.product_id || "";
  if (productId === "arte_empresa" || fields?.categoria === "arte_empresa") {
    return !!(fields.ramo && fields.nome_empresa);
  }

  return !!(fields.rodada && fields.data);
}

function hasCompanyLogoReference(files = {}) {
  return Boolean(files.logo?.length);
}

function getUploadPermissions(categoria) {
  return {
    podeUsarEscudo1: ["resultado", "escalacao", "contratacao", "proximo_jogo", "patrocinador", "escudo3d", "proximo_jogo_jogador", "resultado_jogo_jogador", "jogador_escudo", "mascote_uniforme"].includes(categoria),
    podeUsarEscudo2: ["resultado", "escalacao", "contratacao", "proximo_jogo", "proximo_jogo_jogador", "resultado_jogo_jogador"].includes(categoria),
    escudo2EhFotoJogador: false,
    podeUsarMascote: ["resultado", "escalacao", "proximo_jogo_jogador", "resultado_jogo_jogador", "jogador_escudo", "mascote_uniforme"].includes(categoria),
    podeUsarPatrocinadores: categoria === "patrocinador",
    podeUsarLogo: categoria === "arte_empresa",
    podeUsarFotos: categoria === "arte_empresa",
    podeUsarReferencias: categoria === "arte_empresa"
  };
}

function moveUploadedFile({ files, base, field, destName }) {
  const f = files[field]?.[0];
  if (!f) return null;

  const dest = path.join(base, destName);
  fs.renameSync(f.path, dest);

  return dest;
}

function moveOrderUploads({ categoria, files, base }) {
  const permissions = getUploadPermissions(categoria);

  if (permissions.podeUsarEscudo1) {
    moveUploadedFile({ files, base, field: "escudo1", destName: "escudo1.png" });
  }

  if (permissions.podeUsarEscudo2) {
    moveUploadedFile({ files, base, field: "escudo2", destName: "escudo2.png" });
  }

  if (permissions.escudo2EhFotoJogador) {
    moveUploadedFile({ files, base, field: "escudo2", destName: "mascote.png" });
  }

  if (permissions.podeUsarMascote) {
    moveUploadedFile({ files, base, field: "mascote", destName: "mascote.png" });
  }

  const pats = permissions.podeUsarPatrocinadores ? (files["patrocinadores"] || []) : [];

  pats.forEach((f, i) => {
    const dest = path.join(base, `pat${String(i + 1).padStart(2, "0")}.png`);
    fs.renameSync(f.path, dest);
  });

  const logo = permissions.podeUsarLogo
    ? moveUploadedFile({ files, base, field: "logo", destName: "logo.png" })
    : null;

  const fotos = permissions.podeUsarFotos ? (files["fotos"] || []) : [];
  fotos.forEach((f, i) => {
    const dest = path.join(base, `foto${String(i + 1).padStart(2, "0")}${path.extname(f.originalname || ".png") || ".png"}`);
    fs.renameSync(f.path, dest);
  });

  const referencias = permissions.podeUsarReferencias ? (files["referencias"] || []) : [];
  referencias.forEach((f, i) => {
    const dest = path.join(base, `referencia${String(i + 1).padStart(2, "0")}${path.extname(f.originalname || ".png") || ".png"}`);
    fs.renameSync(f.path, dest);
  });

  return {
    ...permissions,
    pats,
    logo,
    fotos,
    referencias
  };
}

function buildCompanyAssets({ files, uploadResult }) {
  return {
    logo: files["logo"]?.[0] ? "logo.png" : "",
    fotos: (uploadResult.fotos || []).map((f, i) => `foto${String(i + 1).padStart(2, "0")}${path.extname(f.originalname || ".png") || ".png"}`),
    referencias: (uploadResult.referencias || []).map((f, i) => `referencia${String(i + 1).padStart(2, "0")}${path.extname(f.originalname || ".png") || ".png"}`)
  };
}

async function buildCompanyData({ fields, files, uploadResult }) {
  const ramo = fields.ramo || "";
  const niche = ramo ? await nicheService.obterOuCriarNichoComDna(ramo, fields) : null;
  const nicheWithUsage = niche ? nicheService.incrementarUsos(niche.id) || niche : null;
  const modeloResult = procurarModeloEmpresa({
    fields,
    nicheDna: nicheWithUsage?.dna || nicheService.createEmptyDna()
  });

  return {
    ramo,
    nome_empresa: fields.nome_empresa || "",
    objetivo: fields.objetivo || "",
    oferta: fields.oferta || "",
    cta: fields.cta || "",
    whatsapp_contato: fields.whatsapp_contato || "",
    instagram: fields.instagram || "",
    observacoes: fields.observacoes || "",
    niche_id: nicheWithUsage?.id || "",
    niche_dna: nicheWithUsage?.dna || nicheService.createEmptyDna(),
    niche_dna_status: nicheWithUsage?.dna_status || "pendente",
    niche_dna_origem: nicheWithUsage?.dna_origem || "fallback",
    niche_dna_gerado_em: nicheWithUsage?.dna_gerado_em || "",
    niche_dna_erro: nicheWithUsage?.dna_erro || "",
    modelo_referencia: modeloResult.modelo,
    modelo_status: modeloResult.status,
    modelo_erro: modeloResult.erro,
    modelo_usado_em: modeloResult.usado_em,
    modelo_score: modeloResult.score,
    modelo_score_detalhes: modeloResult.detalhes_score,
    company_assets: buildCompanyAssets({ files, uploadResult })
  };
}

function procurarModeloEmpresa({ fields, nicheDna }) {
  try {
    const result = modeloService.procurarModeloParecido({
      ramo: fields.ramo,
      objetivo: fields.objetivo,
      tipo_post: fields.tipo_post || fields.objetivo,
      estilo: fields.estilo,
      niche_dna: nicheDna
    });

    if (!result.encontrado) {
      return {
        modelo: null,
        status: "pendente",
        erro: result.motivo || "Modelo nao encontrado",
        usado_em: "",
        score: result.score || 0,
        detalhes_score: result.detalhes_score || []
      };
    }

    const usos = modeloService.incrementarUsoModelo(result.modelo);
    const { arquivo_json, ...modeloReferencia } = result.modelo;
    return {
      modelo: {
        ...modeloReferencia,
        usos: usos || modeloReferencia.usos
      },
      status: "encontrado",
      erro: "",
      usado_em: new Date().toISOString(),
      score: result.score || 0,
      detalhes_score: result.detalhes_score || []
    };
  } catch (err) {
    return {
      modelo: null,
      status: "erro",
      erro: err.message || "Erro ao procurar modelo",
      usado_em: "",
      score: 0,
      detalhes_score: []
    };
  }
}

async function buildPedidoData({
  categoria,
  id,
  whatsapp,
  mesAtual,
  fields,
  files,
  pats,
  podeUsarEscudo1,
  podeUsarEscudo2,
  escudo2EhFotoJogador,
  podeUsarMascote,
  uploadResult = {}
}) {
  const {
    rodada,
    data,
    hora,
    arena,
    mascote_tipo,
    artilheiros,
    jogadores_json,
    jogadores_texto,
    time_principal,
    gols_time_principal,
    gols_adversario,
    time_adversario,
    ramo,
    nome_empresa,
    objetivo,
    oferta,
    cta,
    whatsapp_contato,
    instagram,
    observacoes,
    new_model
  } = fields;

  const pedido = {
    time_principal: ["resultado", "proximo_jogo", "proximo_jogo_jogador", "resultado_jogo_jogador"].includes(categoria) ? (time_principal || "") : "",
    gols_time_principal: ["resultado", "resultado_jogo_jogador"].includes(categoria) ? (Number(gols_time_principal) || 0) : 0,
    gols_adversario: ["resultado", "resultado_jogo_jogador"].includes(categoria) ? (Number(gols_adversario) || 0) : 0,
    time_adversario: ["resultado", "proximo_jogo", "proximo_jogo_jogador", "resultado_jogo_jogador"].includes(categoria) ? (time_adversario || "") : "",

    artilheiros: categoria === "resultado" && artilheiros ? JSON.parse(artilheiros) : [],
    jogadores: ["escalacao", "jogador_escudo", "mascote_uniforme"].includes(categoria) && jogadores_json ? JSON.parse(jogadores_json) : [],
    jogadores_texto: ["escalacao", "jogador_escudo", "mascote_uniforme"].includes(categoria) ? (jogadores_texto || "") : "",

    escudo_principal: podeUsarEscudo1 && files["escudo1"]?.[0] ? "escudo1.png" : "",
    escudo_adversario: podeUsarEscudo2 && files["escudo2"]?.[0] ? "escudo2.png" : "",
    foto_jogo: ((podeUsarMascote && files["mascote"]?.[0]) || (escudo2EhFotoJogador && files["escudo2"]?.[0])) ? "mascote.png" : "",

    categoria: categoria,
    id,
    whatsapp,
    mes: mesAtual,
    rodada,
    data,
    hora: ["resultado", "resultado_jogo_jogador", "contratacao", "proximo_jogo", "proximo_jogo_jogador", "escalacao"].includes(categoria) ? (hora || "") : "",
    arena: ["proximo_jogo", "proximo_jogo_jogador", "escalacao"].includes(categoria) ? (arena || "") : "",
    mascote_tipo: mascote_tipo || "",
    patrocinadores_qtd: pats.length,
    status: "novo",
    aprovado_cliente: false,
    baixado_cliente: false,
    ajuste_automatico_usado: false,
    motivo_ajuste: "",
    criado_em: new Date().toISOString()
  };

  if (categoria === "arte_empresa") {
    const companyData = await buildCompanyData({
      fields: {
        ramo,
        nome_empresa,
        objetivo,
        oferta,
        cta,
        whatsapp_contato,
        instagram,
        observacoes
      },
      files,
      uploadResult
    });

    Object.assign(pedido, companyData, {
      rodada: objetivo || "Arte para empresa",
      data: oferta || nome_empresa || ramo,
      product_id: "arte_empresa",
      schema_version: new_model?.schema_version || 1
    });
  }

  const cleanModel = new_model || {};

  if (cleanModel.schema_version || cleanModel.product_id || Object.keys(cleanModel.fields || {}).length || Object.keys(cleanModel.assets || {}).length) {
    pedido.schema_version = cleanModel.schema_version || 1;
    pedido.product_id = cleanModel.product_id || categoria;
    pedido.fields = cleanModel.fields || {};
    pedido.assets = cleanModel.assets || {};
    pedido.legacy = {
      time_principal: pedido.time_principal,
      gols_time_principal: pedido.gols_time_principal,
      gols_adversario: pedido.gols_adversario,
      time_adversario: pedido.time_adversario,
      artilheiros: pedido.artilheiros,
      jogadores: pedido.jogadores,
      jogadores_texto: pedido.jogadores_texto,
      escudo_principal: pedido.escudo_principal,
      escudo_adversario: pedido.escudo_adversario,
      foto_jogo: pedido.foto_jogo,
      categoria: pedido.categoria,
      rodada: pedido.rodada,
      data: pedido.data,
      hora: pedido.hora,
      arena: pedido.arena,
      mascote_tipo: pedido.mascote_tipo,
      patrocinadores_qtd: pedido.patrocinadores_qtd
    };

    if (categoria === "arte_empresa") {
      pedido.fields = {
        ...pedido.fields,
        ramo: pedido.ramo,
        nome_empresa: pedido.nome_empresa,
        objetivo: pedido.objetivo,
        oferta: pedido.oferta,
        cta: pedido.cta,
        whatsapp: pedido.whatsapp_contato,
        instagram: pedido.instagram,
        observacoes: pedido.observacoes
      };
      pedido.assets = {
        ...pedido.assets,
        ...pedido.company_assets
      };
      pedido.legacy = {
        ...pedido.legacy,
        ramo: pedido.ramo,
        nome_empresa: pedido.nome_empresa,
        objetivo: pedido.objetivo,
        oferta: pedido.oferta,
        cta: pedido.cta,
        whatsapp_contato: pedido.whatsapp_contato,
        instagram: pedido.instagram,
        observacoes: pedido.observacoes,
        niche_id: pedido.niche_id,
        niche_dna_status: pedido.niche_dna_status,
        niche_dna_origem: pedido.niche_dna_origem,
        modelo_status: pedido.modelo_status,
        modelo_score: pedido.modelo_score
      };
    }
  }

  return pedido;
}

function persistNewOrder({ base, pedido }) {
  orderStorage.writeOrder(base, pedido);
  orderStorage.writeStatus(base, orderStatus.ORDER_STATUS.NOVO);
}

function attachNicheKnowledgeContext(pedido) {
  try {
    const result = nicheKnowledgeEngine.buildNicheKnowledgeForInput({
      product_id: pedido.product_id,
      categoria: pedido.categoria,
      flyer_tipo: pedido.flyer_tipo,
      niche_id: pedido.niche_id,
      nicho_id: pedido.nicho_id,
      ramo: pedido.ramo,
      objetivo: pedido.objetivo
    });

    if (result?.ok && result.context) {
      pedido.niche_knowledge_context = result.context;
    }
  } catch {}
}

async function createOrderDraft({ categoria, pedidosDir, whatsapp, mesAtual, fields, files }) {
  const id = orderStorage.newPedidoId();
  const base = buildOrderBasePath({ pedidosDir, whatsapp, mesAtual, id });

  ensureOrderDirectory(base);

  const uploadResult = moveOrderUploads({ categoria, files, base });

  const pedido = await buildPedidoData({
    categoria,
    id,
    whatsapp,
    mesAtual,
    fields,
    files,
    pats: uploadResult.pats,
    podeUsarEscudo1: uploadResult.podeUsarEscudo1,
    podeUsarEscudo2: uploadResult.podeUsarEscudo2,
    escudo2EhFotoJogador: uploadResult.escudo2EhFotoJogador,
    podeUsarMascote: uploadResult.podeUsarMascote,
    uploadResult
  });

  attachNicheKnowledgeContext(pedido);

  persistNewOrder({ base, pedido });

  return {
    id,
    base,
    fields,
    pedido,
    uploadResult
  };
}

module.exports = {
  orderStorage,
  orderStatus,
  buildOrderBasePath,
  ensureOrderDirectory,
  safeParseJsonObject,
  normalizeNewOrderModel,
  normalizeOrderBody,
  hasRequiredOrderFields,
  hasCompanyLogoReference,
  getUploadPermissions,
  moveUploadedFile,
  moveOrderUploads,
  buildPedidoData,
  persistNewOrder,
  createOrderDraft
};
