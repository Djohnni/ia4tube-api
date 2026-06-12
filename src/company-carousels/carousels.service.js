const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const billingService = require("../billing/billing.service");

const VALID_STATUSES = new Set(["pendente", "baixado", "processando", "pronto", "erro"]);
const READY_STATUSES = new Set(["pronto"]);
const CAROUSEL_PLAN_LIMITS = {
  essencial: 1,
  profissional: 2,
  empresarial: 4
};
const CAROUSEL_LIMIT_REACHED_MESSAGE = "Voc\u00ea atingiu o limite de carross\u00e9is do seu plano neste ciclo.";

function safeSegment(value, fallback = "item") {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_.@+-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 100) || fallback;
}

function currentMonthCycle(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function planCycle(cliente) {
  return String(cliente?.plano_ciclo || cliente?.ciclo_mes || currentMonthCycle()).trim();
}

function planKey(cliente) {
  if (!billingService.isPlanActive(cliente)) return "";
  const id = String(cliente.plano_atual || cliente.plano || "").toLowerCase();
  if (id.includes("essencial")) return "essencial";
  if (id.includes("profissional")) return "profissional";
  if (id.includes("empresarial")) return "empresarial";
  return "";
}

function ensureCarouselCycleState(cliente) {
  billingService.refreshManualPlanCycle(cliente);
  const ciclo = planCycle(cliente);
  if (cliente.carrosseis_ciclo !== ciclo || typeof cliente.carrosseis_criados !== "object" || Array.isArray(cliente.carrosseis_criados)) {
    cliente.carrosseis_ciclo = ciclo;
    cliente.carrosseis_criados = {};
  }
  return ciclo;
}

function carouselUsagePayload(cliente) {
  const ciclo = ensureCarouselCycleState(cliente);
  const key = planKey(cliente);
  const limit = CAROUSEL_PLAN_LIMITS[key] || 0;
  const used = Object.keys(cliente.carrosseis_criados || {}).length;
  return {
    ciclo,
    plano: key,
    limite_plano: limit,
    usado_no_ciclo: used,
    restante_no_ciclo: Math.max(0, limit - used)
  };
}

function assertCarouselQuotaAvailable(cliente) {
  const usage = carouselUsagePayload(cliente);
  if (usage.restante_no_ciclo > 0) return usage;

  const error = new Error(CAROUSEL_LIMIT_REACHED_MESSAGE);
  error.statusCode = 403;
  error.code = "carousel_limit_reached";
  error.quota = usage;
  throw error;
}

function consumeCarouselQuota(cliente, carrosselId, createdAt) {
  ensureCarouselCycleState(cliente);
  cliente.carrosseis_criados[carrosselId] = {
    criado_em: createdAt,
    status: "solicitado"
  };
  return carouselUsagePayload(cliente);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8") || "{}");
  } catch {
    return null;
  }
}

function readDirEntries(dirPath) {
  try {
    if (!fs.existsSync(dirPath)) return [];
    return fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function readStatus(dirPath, fallback = "pendente") {
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

function appendLog(dirPath, message) {
  const now = new Date().toISOString();
  fs.appendFileSync(path.join(dirPath, "runner_log.txt"), `[${now}] ${message}\n`, "utf8");
}

function requestDir(baseDir, whatsapp, ciclo, carrosselId) {
  return path.join(
    baseDir,
    safeSegment(whatsapp, "sem_whatsapp"),
    safeSegment(ciclo, "ciclo"),
    safeSegment(carrosselId, "carrossel")
  );
}

function parseRequest(dirPath) {
  const solicitacaoPath = path.join(dirPath, "solicitacao.json");
  const solicitacao = readJson(solicitacaoPath);
  if (!solicitacao) return null;

  const status = readStatus(dirPath, solicitacao.status || "pendente");
  return {
    ...solicitacao,
    status,
    base_path: dirPath,
    solicitacao_path: solicitacaoPath,
    resultado_path: path.join(dirPath, "resultado.zip"),
    descricao_path: path.join(dirPath, "descricao_instagram.txt"),
    info_path: path.join(dirPath, "resultado_api_info.json")
  };
}

function clampScreenCount(value) {
  const count = Number(value || 0);
  if (!Number.isFinite(count) || count <= 0) return 5;
  return Math.max(2, Math.min(10, Math.round(count)));
}

function normalizeBriefing(body = {}) {
  const quantidade = clampScreenCount(body.quantidade_telas || body.quantidade || body.telas);
  return {
    briefing: String(body.briefing || body.texto || "").trim(),
    tema: String(body.tema || "").trim(),
    formato: String(body.formato || "carrossel").trim(),
    quantidade,
    quantidade_telas: quantidade,
    publico: String(body.publico || body.publico_alvo || "").trim(),
    objetivo: String(body.objetivo || "").trim(),
    estilo_visual: String(body.estilo_visual || body.estiloVisual || "").trim(),
    cores: String(body.cores || "").trim(),
    observacoes: String(body.observacoes || "").trim(),
    modo_briefing: String(body.modo_briefing || body.modoBriefing || "").trim(),
    texto_fonte: String(body.texto_fonte || body.textoFonte || "").trim()
  };
}

function normalizeProfile(body = {}) {
  return {
    nome_empresa: String(body.nome_empresa || "").trim(),
    ramo: String(body.ramo || "").trim(),
    whatsapp: String(body.whatsapp || "").trim(),
    instagram: String(body.instagram || "").trim(),
    historia: String(body.historia || "").trim(),
    endereco: String(body.endereco || "").trim(),
    cidade: String(body.cidade || "").trim(),
    estado: String(body.estado || "").trim(),
    cep: String(body.cep || "").trim(),
    email: String(body.email || "").trim(),
    site: String(body.site || "").trim()
  };
}

function validateBriefing(briefing) {
  if (briefing.texto_fonte || briefing.briefing || briefing.tema) return;

  const error = new Error("Informe um briefing ou tema para criar o carrossel.");
  error.statusCode = 400;
  error.code = "missing_carousel_briefing";
  throw error;
}

function newCarouselId() {
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `car_${stamp}_${crypto.randomBytes(4).toString("hex")}`;
}

function fileExtension(file) {
  const original = String(file?.originalname || "");
  const ext = path.extname(original).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".webp"].includes(ext)) return ext;

  const mime = String(file?.mimetype || "").toLowerCase();
  if (mime.includes("jpeg") || mime.includes("jpg")) return ".jpg";
  if (mime.includes("webp")) return ".webp";
  return ".png";
}

function moveUploadedFile(file, dirPath, baseName) {
  if (!file?.path || !fs.existsSync(file.path)) return null;

  const filename = `${safeSegment(baseName)}${fileExtension(file)}`;
  const destPath = path.join(dirPath, filename);
  if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
  fs.renameSync(file.path, destPath);

  return {
    filename,
    original_name: file.originalname || filename,
    mime_type: file.mimetype || "",
    size: file.size || 0,
    path: filename
  };
}

function saveUploadedAssets(files = {}, dirPath) {
  const logo = moveUploadedFile(files.logo?.[0], dirPath, "logo");
  const fotos = (files.fotos || [])
    .map((file, index) => moveUploadedFile(file, dirPath, `foto_empresa_${String(index + 1).padStart(2, "0")}`))
    .filter(Boolean);

  return {
    logo,
    fotos
  };
}

function createRequest({ baseDir, cliente, whatsapp, body, files = {} }) {
  const briefing = normalizeBriefing(body);
  const profile = normalizeProfile(body);
  validateBriefing(briefing);
  const quotaBefore = assertCarouselQuotaAvailable(cliente);
  const ciclo = quotaBefore.ciclo;

  const carrosselId = newCarouselId();
  const dirPath = requestDir(baseDir, whatsapp, ciclo, carrosselId);
  ensureDir(dirPath);
  const assets = saveUploadedAssets(files, dirPath);

  const now = new Date().toISOString();
  const quota = consumeCarouselQuota(cliente, carrosselId, now);
  const solicitacao = {
    id: carrosselId,
    carrossel_id: carrosselId,
    tipo: "carrossel_ia4tube",
    status: "pendente",
    whatsapp,
    ciclo,
    criado_em: now,
    briefing,
    profile,
    assets,
    quota: {
      consumed: true,
      ciclo: quota.ciclo,
      plano: quota.plano,
      limite_plano: quota.limite_plano,
      usado_no_ciclo: quota.usado_no_ciclo,
      restante_no_ciclo: quota.restante_no_ciclo
    }
  };

  writeJson(path.join(dirPath, "solicitacao.json"), solicitacao);
  writeStatus(dirPath, "pendente");
  appendLog(dirPath, "Solicitacao de carrossel criada.");
  return solicitacao;
}

function findRequestById({ baseDir, carrosselId }) {
  const safeId = safeSegment(carrosselId, "carrossel");

  for (const userEntry of readDirEntries(baseDir)) {
    if (!userEntry.isDirectory()) continue;
    const userDir = path.join(baseDir, userEntry.name);
    for (const cycleEntry of readDirEntries(userDir)) {
      if (!cycleEntry.isDirectory()) continue;
      const dirPath = path.join(userDir, cycleEntry.name, safeId);
      if (!fs.existsSync(dirPath)) continue;
      const request = parseRequest(dirPath);
      if (!request) return null;
      if (String(request.carrossel_id || request.id) !== String(carrosselId)) return null;
      return request;
    }
  }

  return null;
}

function assertClientRequest(request, whatsapp) {
  if (!request || String(request.whatsapp || "") !== String(whatsapp || "")) {
    const error = new Error("Carrossel nao encontrado.");
    error.statusCode = 404;
    throw error;
  }
}

function statusLabel(status) {
  if (status === "pendente") return "Pendente";
  if (status === "baixado") return "Baixado";
  if (status === "processando") return "Em producao";
  if (status === "pronto") return "Pronto";
  if (status === "erro") return "Erro";
  return status || "Pendente";
}

function publicStatusPayload({ baseDir, whatsapp, carrosselId }) {
  const request = findRequestById({ baseDir, carrosselId });
  assertClientRequest(request, whatsapp);
  const ready = READY_STATUSES.has(request.status) && fs.existsSync(request.resultado_path);
  const descricao = ready && fs.existsSync(request.descricao_path)
    ? fs.readFileSync(request.descricao_path, "utf8")
    : "";

  return {
    ok: true,
    carrossel: {
      id: request.carrossel_id || request.id,
      carrossel_id: request.carrossel_id || request.id,
      status: request.status,
      status_label: statusLabel(request.status),
      ready,
      ciclo: request.ciclo,
      criado_em: request.criado_em || "",
      atualizado_em: request.atualizado_em || "",
      descricao_instagram: descricao,
      download_url: ready ? `/empresa/carrosseis/${request.carrossel_id || request.id}/download` : "",
      quota: request.quota || null
    }
  };
}

function downloadForCarousel({ baseDir, whatsapp, carrosselId }) {
  const request = findRequestById({ baseDir, carrosselId });
  assertClientRequest(request, whatsapp);

  if (!READY_STATUSES.has(request.status) || !fs.existsSync(request.resultado_path)) {
    const error = new Error("Carrossel ainda nao esta pronto para download.");
    error.statusCode = 404;
    throw error;
  }

  return {
    filePath: request.resultado_path,
    filename: `${safeSegment(request.carrossel_id || request.id, "carrossel")}.zip`,
    metadata: request
  };
}

function updateRequestStatus(request, status, message = "") {
  const nextStatus = VALID_STATUSES.has(status) ? status : "processando";
  const solicitacao = readJson(request.solicitacao_path) || request;
  const now = new Date().toISOString();
  solicitacao.status = nextStatus;
  solicitacao.atualizado_em = now;
  if (message) solicitacao.status_message = String(message).slice(0, 500);
  writeJson(request.solicitacao_path, solicitacao);
  writeStatus(request.base_path, nextStatus);
  appendLog(request.base_path, `Status: ${nextStatus}${message ? ` - ${message}` : ""}`);
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

function saveUploadedResult({ baseDir, carrosselId, resultPath, descricaoInstagram = "", apiInfo = {} }) {
  const request = findRequestById({ baseDir, carrosselId });
  if (!request) {
    const error = new Error("Solicitacao de carrossel nao encontrada.");
    error.statusCode = 404;
    throw error;
  }
  if (!resultPath || !fs.existsSync(resultPath)) {
    const error = new Error("Resultado do carrossel nao enviado.");
    error.statusCode = 400;
    throw error;
  }

  moveFile(resultPath, request.resultado_path);

  if (descricaoInstagram) {
    fs.writeFileSync(request.descricao_path, String(descricaoInstagram), "utf8");
  }

  const now = new Date().toISOString();
  writeJson(request.info_path, {
    ok: true,
    carrossel_id: request.carrossel_id || request.id,
    uploaded_at: now,
    ...apiInfo
  });
  fs.writeFileSync(path.join(request.base_path, "processado_handoff.txt"), `${now}\n`, "utf8");

  return updateRequestStatus(request, "pronto", "Resultado final recebido pelo backend.");
}

function listBotPending({ baseDir, limit = 5 }) {
  const items = [];

  for (const userEntry of readDirEntries(baseDir)) {
    if (!userEntry.isDirectory()) continue;
    const userDir = path.join(baseDir, userEntry.name);
    for (const cycleEntry of readDirEntries(userDir)) {
      if (!cycleEntry.isDirectory()) continue;
      const cycleDir = path.join(userDir, cycleEntry.name);
      for (const carouselEntry of readDirEntries(cycleDir)) {
        if (!carouselEntry.isDirectory()) continue;
        const request = parseRequest(path.join(cycleDir, carouselEntry.name));
        if (!request || request.status !== "pendente") continue;
        items.push({
          carrossel_id: request.carrossel_id || request.id,
          whatsapp: request.whatsapp,
          ciclo: request.ciclo,
          status: request.status,
          criado_em: request.criado_em,
          quantidade_telas: request.briefing?.quantidade_telas || request.briefing?.quantidade || "",
          tema: request.briefing?.tema || request.briefing?.briefing || "",
          zip_url: `/bot/empresa/carrosseis/${request.carrossel_id || request.id}/zip`
        });
      }
    }
  }

  return items
    .sort((a, b) => String(a.criado_em || "").localeCompare(String(b.criado_em || "")))
    .slice(0, limit);
}

module.exports = {
  createRequest,
  findRequestById,
  publicStatusPayload,
  downloadForCarousel,
  updateRequestStatus,
  saveUploadedResult,
  listBotPending,
  carouselUsagePayload
};
