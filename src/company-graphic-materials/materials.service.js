const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const billingService = require("../billing/billing.service");
const catalog = require("./materials.catalog");

const PLAN_LIMITS = {
  essencial: { geral: 4, ramo: 1 },
  profissional: { geral: 8, ramo: 3 },
  empresarial: { geral: Infinity, ramo: Infinity }
};

const ACTIVE_STATUSES = new Set(["novo", "em_producao", "processando"]);
const READY_STATUSES = new Set(["pronto", "created"]);
const VALID_STATUSES = new Set(["novo", "em_producao", "processando", "pronto", "erro", "created"]);

function safeSegment(value, fallback = "usuario") {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 100) || fallback;
}

function currentMonthCycle(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function planKey(cliente) {
  if (!billingService.isPlanActive(cliente)) return "";
  const id = String(cliente.plano_atual || cliente.plano || "").toLowerCase();
  if (id.includes("essencial")) return "essencial";
  if (id.includes("profissional")) return "profissional";
  if (id.includes("empresarial")) return "empresarial";
  return "";
}

function planCycle(cliente) {
  return String(cliente.plano_ciclo || cliente.ciclo_mes || currentMonthCycle()).trim();
}

function ensureCycleState(cliente) {
  const ciclo = planCycle(cliente);
  if (cliente.materiais_graficos_ciclo !== ciclo || typeof cliente.materiais_graficos_criados !== "object") {
    cliente.materiais_graficos_ciclo = ciclo;
    cliente.materiais_graficos_criados = {};
  }
  return ciclo;
}

function ensureSpecificCycleState(cliente, ciclo) {
  if (cliente.materiais_graficos_ciclo !== ciclo || typeof cliente.materiais_graficos_criados !== "object") {
    cliente.materiais_graficos_ciclo = ciclo;
    cliente.materiais_graficos_criados = {};
  }
}

function isMaterialAllowedForPlan(material, key) {
  return Boolean(key) && (!material.plans.length || material.plans.includes(key));
}

function scopeKeyForMaterial(material) {
  return material.scope === catalog.BRANCH_SCOPE ? "ramo" : "geral";
}

function normalizeProfile(body = {}) {
  return {
    nome_empresa: String(body.nome_empresa || "").trim(),
    ramo: String(body.ramo || "").trim(),
    whatsapp: String(body.whatsapp || "").trim(),
    instagram: String(body.instagram || "").trim(),
    historia: String(body.historia || "").trim()
  };
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function requestDir(baseDir, whatsapp, ciclo, documentId) {
  return path.join(baseDir, safeSegment(whatsapp), safeSegment(ciclo, "ciclo"), safeSegment(documentId, "documento"));
}

function readJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8") || "{}");
  } catch {
    return null;
  }
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function readStatus(dirPath, fallback = "novo") {
  try {
    const statusPath = path.join(dirPath, "status.txt");
    if (!fs.existsSync(statusPath)) return fallback;
    return String(fs.readFileSync(statusPath, "utf8") || fallback).trim() || fallback;
  } catch {
    return fallback;
  }
}

function writeStatus(dirPath, status) {
  fs.writeFileSync(path.join(dirPath, "status.txt"), `${status}\n`, "utf8");
}

function parseRequest(dirPath) {
  const solicitationPath = path.join(dirPath, "solicitacao.json");
  const solicitation = readJson(solicitationPath);
  if (!solicitation) return null;

  const status = readStatus(dirPath, solicitation.status || "novo");
  return {
    ...solicitation,
    status,
    base_path: dirPath,
    solicitacao_path: solicitationPath,
    resultado_path: path.join(dirPath, "resultado_final.png"),
    preview_path: path.join(dirPath, "preview_ia4tube.jpg"),
    info_path: path.join(dirPath, "resultado_api_info.json")
  };
}

function listRequestsForCycle({ baseDir, whatsapp, ciclo }) {
  const cycleDir = path.join(baseDir, safeSegment(whatsapp), safeSegment(ciclo, "ciclo"));
  if (!fs.existsSync(cycleDir)) return [];

  return fs.readdirSync(cycleDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => parseRequest(path.join(cycleDir, entry.name)))
    .filter(Boolean)
    .filter((request) => String(request.whatsapp || "") === String(whatsapp || ""))
    .sort((a, b) => String(b.criado_em || "").localeCompare(String(a.criado_em || "")));
}

function activeRequestMap({ baseDir, whatsapp, ciclo }) {
  const map = new Map();
  for (const request of listRequestsForCycle({ baseDir, whatsapp, ciclo })) {
    if (!request.material_id || map.has(request.material_id)) continue;
    if (ACTIVE_STATUSES.has(request.status) || (READY_STATUSES.has(request.status) && fs.existsSync(request.resultado_path))) {
      map.set(request.material_id, request);
    }
  }
  return map;
}

function annotateMaterials({ cliente, ramo, baseDir, whatsapp }) {
  billingService.refreshManualPlanCycle(cliente);
  const key = planKey(cliente);
  const ciclo = ensureCycleState(cliente);
  const limits = PLAN_LIMITS[key] || { geral: 0, ramo: 0 };
  const used = cliente.materiais_graficos_criados || {};
  const requests = activeRequestMap({ baseDir, whatsapp, ciclo });
  const counters = { geral: 0, ramo: 0 };

  const materials = catalog.listMaterialsForRamo(ramo).map((material) => {
    const scopeKey = scopeKeyForMaterial(material);
    const created = used[material.id] || null;
    const request = requests.get(material.id) || null;
    counters[scopeKey] += 1;

    const eligibleByPlan = isMaterialAllowedForPlan(material, key);
    const withinLimit = counters[scopeKey] <= (limits[scopeKey] || 0);
    const documentId = created?.document_id || request?.document_id || request?.id || "";
    let status = "locked";
    let statusLabel = "Bloqueado pelo plano";

    if (created || (request && READY_STATUSES.has(request.status) && fs.existsSync(request.resultado_path))) {
      status = "created";
      statusLabel = "Criado";
    } else if (request && ACTIVE_STATUSES.has(request.status)) {
      status = "processing";
      statusLabel = "Em produção";
    } else if (eligibleByPlan && withinLimit) {
      status = "available";
      statusLabel = "Criar";
    }

    return {
      id: material.id,
      title: material.title,
      type: material.type,
      scope: scopeKey,
      format: material.format,
      width: material.width,
      height: material.height,
      status,
      status_label: statusLabel,
      created_in_cycle: status === "created",
      created_at: created?.criado_em || request?.finalizado_em || "",
      document_id: documentId,
      ready: status === "created" && Boolean(documentId),
      download_url: status === "created" && documentId ? `/empresa/materiais-graficos/${material.id}/download` : "",
      locked: status === "locked",
      plan_required: status === "locked" ? "Plano superior" : "",
      _material: material
    };
  });

  return {
    ciclo,
    plan_key: key,
    plan_name: cliente.plano_nome || "",
    plan_status: cliente.plano_status || "none",
    limits: {
      geral: Number.isFinite(limits.geral) ? limits.geral : -1,
      ramo: Number.isFinite(limits.ramo) ? limits.ramo : -1
    },
    materials
  };
}

function publicListPayload({ cliente, ramo, baseDir, whatsapp }) {
  const result = annotateMaterials({ cliente, ramo, baseDir, whatsapp });
  return {
    ok: true,
    title: "Materiais Gráficos da Empresa",
    ciclo: result.ciclo,
    plano: {
      key: result.plan_key,
      nome: result.plan_name,
      status: result.plan_status
    },
    limites: result.limits,
    materiais: result.materials.map(({ _material, ...item }) => item)
  };
}

function materialStatusPayload({ cliente, ramo, baseDir, whatsapp, materialId }) {
  const result = annotateMaterials({ cliente, ramo, baseDir, whatsapp });
  const item = result.materials.find((material) => material.id === materialId);
  if (!item) {
    const error = new Error("Material grafico nao encontrado.");
    error.statusCode = 404;
    throw error;
  }
  const { _material, ...payload } = item;
  return { ok: true, ciclo: result.ciclo, material: payload };
}

function findMaterialForRequest({ cliente, ramo, baseDir, whatsapp, materialId }) {
  const result = annotateMaterials({ cliente, ramo, baseDir, whatsapp });
  const item = result.materials.find((material) => material.id === materialId);
  if (!item) {
    const error = new Error("Material grafico nao encontrado.");
    error.statusCode = 404;
    throw error;
  }
  if (item.status === "created") {
    const error = new Error("Este material grafico ja foi criado no ciclo atual.");
    error.statusCode = 409;
    error.code = "already_created";
    throw error;
  }
  if (item.status === "processing") {
    const error = new Error("Este material grafico ja esta em producao.");
    error.statusCode = 409;
    error.code = "already_processing";
    throw error;
  }
  if (item.status === "locked") {
    const error = new Error("Material grafico bloqueado pelo plano.");
    error.statusCode = 403;
    error.code = "plan_locked";
    throw error;
  }
  return { annotated: item, material: item._material, ciclo: result.ciclo };
}

function newDocumentId() {
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `mg_${stamp}_${crypto.randomBytes(4).toString("hex")}`;
}

function copyLogo(logoPath, destinationDir) {
  if (!logoPath || !fs.existsSync(logoPath)) return "";
  const destination = path.join(destinationDir, "logo.png");
  fs.copyFileSync(logoPath, destination);
  return "logo.png";
}

function createRequest({ baseDir, cliente, whatsapp, materialId, body, logoPath }) {
  const profile = normalizeProfile(body);
  const { material, ciclo } = findMaterialForRequest({
    cliente,
    ramo: profile.ramo,
    baseDir,
    whatsapp,
    materialId
  });

  const documentId = newDocumentId();
  const dirPath = requestDir(baseDir, whatsapp, ciclo, documentId);
  ensureDir(dirPath);

  const logoFile = copyLogo(logoPath, dirPath);
  const now = new Date().toISOString();
  const scope = scopeKeyForMaterial(material);
  const solicitation = {
    id: documentId,
    document_id: documentId,
    tipo: "material_grafico_empresa",
    material_id: material.id,
    title: material.title,
    type: "print_image",
    scope,
    format: "png",
    width: 1240,
    height: 1754,
    status: "novo",
    whatsapp,
    ciclo,
    criado_em: now,
    ramo_folder: material.scopeFolder,
    prompt: material.prompt,
    profile,
    assets: {
      logo: logoFile
    }
  };

  writeJson(path.join(dirPath, "solicitacao.json"), solicitation);
  writeStatus(dirPath, "novo");
  fs.writeFileSync(path.join(dirPath, "runner_log.txt"), `[${now}] Solicitacao criada.\n`, "utf8");

  return solicitation;
}

function findRequestByDocument({ baseDir, documentId }) {
  const safeDocumentId = safeSegment(documentId, "documento");
  if (!fs.existsSync(baseDir)) return null;

  for (const userEntry of fs.readdirSync(baseDir, { withFileTypes: true })) {
    if (!userEntry.isDirectory()) continue;
    const userDir = path.join(baseDir, userEntry.name);
    for (const cycleEntry of fs.readdirSync(userDir, { withFileTypes: true })) {
      if (!cycleEntry.isDirectory()) continue;
      const requestDirPath = path.join(userDir, cycleEntry.name, safeDocumentId);
      if (!fs.existsSync(requestDirPath)) continue;
      const request = parseRequest(requestDirPath);
      if (!request) return null;
      if (String(request.document_id || request.id) !== String(documentId)) return null;
      return request;
    }
  }

  return null;
}

function findClientRequestByMaterial({ baseDir, whatsapp, ciclo, materialId, documentId = "" }) {
  const requests = listRequestsForCycle({ baseDir, whatsapp, ciclo });
  return requests.find((request) => {
    const sameMaterial = request.material_id === materialId;
    const sameDocument = !documentId || request.document_id === documentId || request.id === documentId;
    return sameMaterial && sameDocument && fs.existsSync(request.resultado_path);
  }) || null;
}

function downloadForMaterial({ baseDir, cliente, whatsapp, materialId }) {
  const ciclo = ensureCycleState(cliente);
  const created = cliente.materiais_graficos_criados?.[materialId] || null;
  const request = findClientRequestByMaterial({
    baseDir,
    whatsapp,
    ciclo,
    materialId,
    documentId: created?.document_id || ""
  });

  if (!created || !request || !READY_STATUSES.has(request.status)) {
    const error = new Error("Material grafico ainda nao esta pronto para download.");
    error.statusCode = 404;
    throw error;
  }

  return {
    filePath: request.resultado_path,
    filename: `${safeSegment(request.title || materialId, "material_grafico")}.png`,
    metadata: request
  };
}

function updateRequestStatus(request, status, message = "") {
  const nextStatus = VALID_STATUSES.has(status) ? status : "processando";
  const solicitation = readJson(request.solicitacao_path) || request;
  const now = new Date().toISOString();
  solicitation.status = nextStatus;
  solicitation.atualizado_em = now;
  if (message) solicitation.status_message = String(message).slice(0, 500);
  writeJson(request.solicitacao_path, solicitation);
  writeStatus(request.base_path, nextStatus);
  fs.appendFileSync(path.join(request.base_path, "runner_log.txt"), `[${now}] Status: ${nextStatus}${message ? ` - ${message}` : ""}\n`, "utf8");
  return parseRequest(request.base_path);
}

function moveFile(origin, destination) {
  try {
    fs.renameSync(origin, destination);
  } catch {
    fs.copyFileSync(origin, destination);
    fs.unlinkSync(origin);
  }
}

function saveUploadedResult({ baseDir, documentId, resultPath, previewPath, apiInfo = {} }) {
  const request = findRequestByDocument({ baseDir, documentId });
  if (!request) {
    const error = new Error("Solicitacao de material grafico nao encontrada.");
    error.statusCode = 404;
    throw error;
  }
  if (!resultPath || !fs.existsSync(resultPath)) {
    const error = new Error("Resultado final nao enviado.");
    error.statusCode = 400;
    throw error;
  }

  moveFile(resultPath, request.resultado_path);
  if (previewPath && fs.existsSync(previewPath)) {
    moveFile(previewPath, request.preview_path);
  }

  const now = new Date().toISOString();
  const info = {
    ok: true,
    document_id: request.document_id,
    material_id: request.material_id,
    uploaded_at: now,
    ...apiInfo
  };
  writeJson(request.info_path, info);
  fs.writeFileSync(path.join(request.base_path, "processado_handoff.txt"), `${now}\n`, "utf8");

  const updated = updateRequestStatus(request, "pronto", "Resultado final recebido pelo backend.");
  return updated;
}

function markClientCreated(cliente, request) {
  ensureSpecificCycleState(cliente, request.ciclo);
  cliente.materiais_graficos_criados[request.material_id] = {
    criado_em: request.finalizado_em || request.atualizado_em || new Date().toISOString(),
    scope: request.scope,
    document_id: request.document_id || request.id
  };
}

function listBotPending({ baseDir, limit = 5 }) {
  if (!fs.existsSync(baseDir)) return [];
  const items = [];

  for (const userEntry of fs.readdirSync(baseDir, { withFileTypes: true })) {
    if (!userEntry.isDirectory()) continue;
    const userDir = path.join(baseDir, userEntry.name);
    for (const cycleEntry of fs.readdirSync(userDir, { withFileTypes: true })) {
      if (!cycleEntry.isDirectory()) continue;
      const cycleDir = path.join(userDir, cycleEntry.name);
      for (const docEntry of fs.readdirSync(cycleDir, { withFileTypes: true })) {
        if (!docEntry.isDirectory()) continue;
        const request = parseRequest(path.join(cycleDir, docEntry.name));
        if (!request || request.status !== "novo") continue;
        items.push({
          document_id: request.document_id || request.id,
          material_id: request.material_id,
          title: request.title,
          whatsapp: request.whatsapp,
          ciclo: request.ciclo,
          status: request.status,
          criado_em: request.criado_em,
          zip_url: `/bot/empresa/materiais-graficos/${request.document_id || request.id}/zip`
        });
      }
    }
  }

  return items
    .sort((a, b) => String(a.criado_em || "").localeCompare(String(b.criado_em || "")))
    .slice(0, limit);
}

module.exports = {
  publicListPayload,
  materialStatusPayload,
  createRequest,
  findRequestByDocument,
  downloadForMaterial,
  updateRequestStatus,
  saveUploadedResult,
  markClientCreated,
  listBotPending
};
