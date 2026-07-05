const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const billingService = require("../billing/billing.service");
const orderStorage = require("../orders/order.storage");

const VALID_STATUSES = new Set(["em_analise", "processando", "pronto", "erro", "cancelado"]);
const NOTIFICATION_STATUSES = new Set(["pendente", "enviada", "erro", "cancelada"]);
const PLANNING_ART_STATUSES = new Set(["novo", "ajuste_pendente", "processando", "pronto", "erro"]);
const SAO_PAULO_UTC_OFFSET = "-03:00";
const MAX_MONTHLY_PLANNING_ARTS = 36;
const BOT_PENDING_HARD_LIMIT = 20;
const BOT_CLAIM_TTL_MS = 10 * 60 * 1000;
const PROCESSING_STALE_MS = 45 * 60 * 1000;

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

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8") || "{}");
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(3).toString("hex")}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmpPath, filePath);
}

function writeStatus(dirPath, status) {
  fs.writeFileSync(path.join(dirPath, "status.txt"), `${status}\n`, "utf8");
}

function readStatus(dirPath, fallback = "em_analise") {
  try {
    const statusPath = path.join(dirPath, "status.txt");
    if (!fs.existsSync(statusPath)) return fallback;
    return String(fs.readFileSync(statusPath, "utf8") || fallback).trim() || fallback;
  } catch {
    return fallback;
  }
}

function appendLog(dirPath, message) {
  const now = new Date().toISOString();
  fs.appendFileSync(path.join(dirPath, "runner_log.txt"), `[${now}] ${message}\n`, "utf8");
}

function safeCopyFile(sourcePath, destPath) {
  try {
    if (!sourcePath || !fs.existsSync(sourcePath)) return false;
    ensureDir(path.dirname(destPath));
    fs.copyFileSync(sourcePath, destPath);
    return true;
  } catch {
    return false;
  }
}

function newPlanningId() {
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `pm_${stamp}_${crypto.randomBytes(4).toString("hex")}`;
}

function normalizeDateText(dateText = "", ciclo = "") {
  const raw = String(dateText || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

  const brMatch = raw.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (brMatch) {
    const day = brMatch[1].padStart(2, "0");
    const month = brMatch[2].padStart(2, "0");
    const cycleYear = String(ciclo || currentMonthCycle()).split("-")[0] || String(new Date().getFullYear());
    const rawYear = brMatch[3] || cycleYear;
    const year = rawYear.length === 2 ? `20${rawYear}` : rawYear;
    return `${year}-${month}-${day}`;
  }

  return "";
}

function normalizeTimeText(timeText = "") {
  const raw = String(timeText || "").trim();
  const match = raw.match(/^(\d{1,2})(?::(\d{1,2}))?$/);
  if (!match) return "";

  const hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return "";

  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function buildNotificationAt(post = {}, planning = {}) {
  const dateText = normalizeDateText(post.data_sugerida || post.data || "", planning.ciclo);
  const timeText = normalizeTimeText(post.horario_sugerido || post.hora || "");
  if (!dateText || !timeText) return "";

  const date = new Date(`${dateText}T${timeText}:00${SAO_PAULO_UTC_OFFSET}`);
  if (Number.isNaN(date.getTime())) return "";

  return date.toISOString();
}

function normalizeNotificationStatus(status = "", fallback = "pendente") {
  const value = String(status || "").trim().toLowerCase();
  return NOTIFICATION_STATUSES.has(value) ? value : fallback;
}

function notificationFieldsForPost(post = {}, planning = {}) {
  const notificarEm = String(post.notificar_em || buildNotificationAt(post, planning) || "").trim();
  const status = normalizeNotificationStatus(
    post.notificacao_status,
    notificarEm ? "pendente" : "erro"
  );

  return {
    notificar_em: notificarEm,
    notificacao_status: status,
    notificacao_enviada_em: post.notificacao_enviada_em || "",
    notificacao_erro: post.notificacao_erro || (notificarEm ? "" : "data_ou_horario_invalido"),
    notificacao_tentativas: Number(post.notificacao_tentativas || 0)
  };
}

function newChildPedidoId(planningId, index, pedidosDir) {
  const now = new Date();
  const y = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, "0");
  const da = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  const base = `${y}${mo}${da}_${hh}${mm}${ss}_pm${String(index).padStart(3, "0")}`;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const random = crypto.randomBytes(3).toString("hex");
    const id = `${base}_${random}`;
    if (!orderStorage.getPedidoBaseGlobal(pedidosDir, id)) {
      return id;
    }
  }

  return `${base}_${crypto.randomBytes(8).toString("hex")}`;
}

function requestDir(baseDir, whatsapp, ciclo, planningId) {
  return path.join(
    baseDir,
    safeSegment(whatsapp, "sem_whatsapp"),
    safeSegment(ciclo, "ciclo"),
    safeSegment(planningId, "planejamento")
  );
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
    path: path.relative(path.dirname(dirPath), destPath).replace(/\\/g, "/")
  };
}

function saveUploadedPhotos(files = {}, dirPath) {
  const fotosDir = path.join(dirPath, "fotos");
  ensureDir(fotosDir);

  return (files.fotos || [])
    .map((file, index) => moveUploadedFile(file, fotosDir, `foto_${String(index + 1).padStart(2, "0")}`))
    .filter(Boolean);
}

function saveUploadedLogo(files = {}, dirPath) {
  const logoFile = (files.logo || [])[0];
  if (!logoFile) return null;
  const assetsDir = path.join(dirPath, "assets");
  ensureDir(assetsDir);
  return moveUploadedFile(logoFile, assetsDir, "logo");
}

function parsePhotoOrientations(body = {}) {
  const raw = body.orientacoes_fotos
    || body.orientacoesFotos
    || body.photo_orientations
    || body.foto_orientacoes;

  if (!raw) return [];

  if (Array.isArray(raw)) {
    return raw
      .map((item, index) => normalizePhotoOrientation(item, index + 1))
      .filter(Boolean);
  }

  if (typeof raw === "object") {
    return Object.entries(raw)
      .map(([arquivo, orientacao], index) => normalizePhotoOrientation({ arquivo, orientacao }, index + 1))
      .filter(Boolean);
  }

  const text = String(raw || "").trim();
  if (!text) return [];

  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parsed
        .map((item, index) => normalizePhotoOrientation(item, index + 1))
        .filter(Boolean);
    }
    if (parsed && typeof parsed === "object") {
      return Object.entries(parsed)
        .map(([arquivo, orientacao], index) => normalizePhotoOrientation({ arquivo, orientacao }, index + 1))
        .filter(Boolean);
    }
  } catch {
    return [];
  }

  return [];
}

function normalizePhotoOrientation(item, fallbackOrder = 1) {
  if (!item || typeof item !== "object") return null;
  const ordem = Math.max(1, Number(item.ordem || item.order || fallbackOrder) || fallbackOrder);
  const arquivo = String(item.arquivo || item.filename || item.file || item.nome || "").trim();
  const orientacao = String(item.orientacao || item.orientation || item.instrucao || item.texto || "").trim().slice(0, 1000);
  if (!arquivo && !orientacao) return null;
  return {
    ordem,
    arquivo,
    orientacao
  };
}

function applyPhotoOrientations(fotos = [], body = {}) {
  const orientations = parsePhotoOrientations(body);
  if (!orientations.length) return fotos;

  const byFile = new Map();
  const byOrder = new Map();
  orientations.forEach((item) => {
    if (item.arquivo) byFile.set(item.arquivo.toLowerCase(), item);
    byOrder.set(item.ordem, item);
  });

  return fotos.map((foto, index) => {
    const orientation = byOrder.get(index + 1)
      || byFile.get(String(foto.original_name || "").toLowerCase())
      || byFile.get(String(foto.filename || "").toLowerCase())
      || null;
    if (!orientation?.orientacao) return foto;
    return {
      ...foto,
      orientacao_cliente: orientation.orientacao,
      orientacao_origem: "cliente_por_foto"
    };
  });
}

function normalizeQuantity(body = {}) {
  const raw = body.quantidade_reservada
    || body.quantidade_artes
    || body.artes_reservadas
    || body.quantidade
    || body.total_artes
    || body.reservadas;

  const quantity = Number(raw);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    const error = new Error("Informe quantas artes deseja reservar para o Planejamento Mensal.");
    error.statusCode = 400;
    error.code = "monthly_planning_quantity_required";
    throw error;
  }

  const normalized = Math.floor(quantity);
  if (normalized > MAX_MONTHLY_PLANNING_ARTS) {
    const error = new Error(`Planejamento Mensal permite no maximo ${MAX_MONTHLY_PLANNING_ARTS} artes por ciclo.`);
    error.statusCode = 400;
    error.code = "monthly_planning_quantity_too_high";
    error.max = MAX_MONTHLY_PLANNING_ARTS;
    throw error;
  }

  return normalized;
}

function normalizeCompanyCharacteristics(value) {
  if (Array.isArray(value)) {
    return Array.from(new Set(value.map((item) => String(item || "").trim()).filter(Boolean)));
  }

  if (value && typeof value === "object") {
    return Array.from(new Set(Object.values(value).flatMap((item) => normalizeCompanyCharacteristics(item))));
  }

  const raw = String(value || "").trim();
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return normalizeCompanyCharacteristics(parsed);
    }
    if (parsed && typeof parsed === "object") {
      return normalizeCompanyCharacteristics(parsed);
    }
  } catch {
    // Mantem compatibilidade com texto simples separado por linhas/virgulas.
  }

  return Array.from(new Set(raw
    .split(/\r?\n|[,;]/)
    .map((item) => String(item || "").trim())
    .filter(Boolean)));
}

function firstCompanyCharacteristics(...values) {
  for (const value of values) {
    const normalized = normalizeCompanyCharacteristics(value);
    if (normalized.length) return normalized;
  }
  return [];
}

function companyCharacteristicsFromBody(body = {}) {
  return firstCompanyCharacteristics(
    body.caracteristicas_empresa,
    body.caracteristicasEmpresa,
    body.company_characteristics,
    body.companyCharacteristics,
    body.fields?.caracteristicas_empresa,
    body.fields?.caracteristicasEmpresa,
    body.fields?.campos_dinamicos?.caracteristicas_empresa,
    body.campos_dinamicos?.caracteristicas_empresa,
    body.legacy?.caracteristicas_empresa,
    body.planejamento_mensal?.caracteristicas_empresa
  );
}

function companyCharacteristicsFromPlanning(planning = {}, profile = {}) {
  const fields = planning.fields || {};
  const camposDinamicos = fields.campos_dinamicos || planning.campos_dinamicos || {};
  const monthly = planning.planejamento_mensal || {};
  const legacy = planning.legacy || {};

  return firstCompanyCharacteristics(
    profile.caracteristicas_empresa,
    planning.caracteristicas_empresa,
    planning.caracteristicasEmpresa,
    planning.company_characteristics,
    planning.companyCharacteristics,
    fields.caracteristicas_empresa,
    fields.caracteristicasEmpresa,
    camposDinamicos.caracteristicas_empresa,
    monthly.caracteristicas_empresa,
    legacy.caracteristicas_empresa
  );
}

function companyImportantInfoFromBody(body = {}) {
  return cleanText(
    body.informacoes_empresa
      || body.informacoesEmpresa
      || body.informacoes_importantes_empresa
      || body.regras_empresa
      || body.dados_importantes_empresa
      || body.fields?.informacoes_empresa
      || body.fields?.campos_dinamicos?.informacoes_empresa
      || body.campos_dinamicos?.informacoes_empresa
      || body.legacy?.informacoes_empresa
      || body.planejamento_mensal?.informacoes_empresa
  );
}

function companyImportantInfoFromPlanning(planning = {}, profile = {}) {
  const fields = planning.fields || {};
  const camposDinamicos = fields.campos_dinamicos || planning.campos_dinamicos || {};
  const monthly = planning.planejamento_mensal || {};
  const legacy = planning.legacy || {};

  return cleanText(
    profile.informacoes_empresa
      || planning.informacoes_empresa
      || planning.informacoesEmpresa
      || planning.informacoes_importantes_empresa
      || planning.regras_empresa
      || fields.informacoes_empresa
      || fields.informacoesEmpresa
      || camposDinamicos.informacoes_empresa
      || monthly.informacoes_empresa
      || legacy.informacoes_empresa
  );
}

function normalizeProfile(body = {}, cliente = {}) {
  return {
    nome_empresa: String(body.nome_empresa || body.nomeEmpresa || cliente.nome_empresa || cliente.nome_time || "").trim(),
    ramo: String(body.ramo || cliente.ramo || cliente.nicho || "").trim(),
    whatsapp: String(body.whatsapp || cliente.whatsapp || "").trim(),
    instagram: String(body.instagram || cliente.instagram || "").trim(),
    caracteristicas_empresa: companyCharacteristicsFromBody(body),
    informacoes_empresa: companyImportantInfoFromBody(body),
    historia: String(body.historia || body.historia_empresa || cliente.historia || "").trim(),
    endereco: String(body.endereco || cliente.endereco || "").trim(),
    cidade: String(body.cidade || cliente.cidade || "").trim(),
    estado: String(body.estado || cliente.estado || "").trim(),
    cep: String(body.cep || cliente.cep || "").trim(),
    email: String(body.email || cliente.email || "").trim(),
    site: String(body.site || cliente.site || "").trim()
  };
}

function ensurePlanningReservationState(cliente, ciclo = planCycle(cliente)) {
  if (
    cliente.planejamento_mensal_ciclo !== ciclo ||
    !cliente.planejamento_mensal_reservas ||
    typeof cliente.planejamento_mensal_reservas !== "object" ||
    Array.isArray(cliente.planejamento_mensal_reservas)
  ) {
    cliente.planejamento_mensal_ciclo = ciclo;
    cliente.planejamento_mensal_reservas = {};
    cliente.planejamento_mensal_artes_reservadas = 0;
    cliente.planejamento_mensal_ja_produzidas = 0;
  }

  return cliente.planejamento_mensal_reservas;
}

function refreshPlanningReservationCounters(cliente) {
  const reservas = cliente.planejamento_mensal_reservas || {};
  let reservadas = 0;
  let produzidas = 0;

  for (const reserva of Object.values(reservas)) {
    if (!reserva || typeof reserva !== "object") continue;
    produzidas += Number(reserva.artes_produzidas || 0);
    if (String(reserva.status || "") === "ativa") {
      reservadas += Number(reserva.artes_bloqueadas_ativas || 0);
    }
  }

  cliente.planejamento_mensal_artes_reservadas = Math.max(0, reservadas);
  cliente.planejamento_mensal_ja_produzidas = Math.max(0, produzidas);
  cliente.planejamento_mensal_atualizado_em = new Date().toISOString();

  return {
    reservadas_no_planejamento: cliente.planejamento_mensal_artes_reservadas,
    ja_produzidas: cliente.planejamento_mensal_ja_produzidas,
    livres_para_criar_arte: Number(cliente.artes_mensais_restantes || 0)
  };
}

function validatePlanAndFreeArts(cliente, quantity) {
  const billing = billingService.getBillingStatus(cliente);
  ensurePlanningReservationState(cliente, planCycle(cliente));
  refreshPlanningReservationCounters(cliente);

  if (!billingService.isPlanActive(cliente)) {
    const error = new Error("Assine ou ative um plano para criar um Planejamento Mensal.");
    error.statusCode = 403;
    error.code = "monthly_planning_plan_required";
    error.billing = billing;
    throw error;
  }

  const freeArts = Number(billing.artes_mensais_restantes || 0);
  if (quantity > freeArts) {
    const error = new Error("Voce nao tem artes livres suficientes para este Planejamento Mensal.");
    error.statusCode = 400;
    error.code = "monthly_planning_insufficient_arts";
    error.billing = billing;
    error.artes_livres = freeArts;
    throw error;
  }

  return {
    billing,
    artes_livres: freeArts
  };
}

function reservePlanningArts(cliente, planningId, quantity, createdAt, billing) {
  const ciclo = planCycle(cliente);
  const reservas = ensurePlanningReservationState(cliente, ciclo);
  const freeArts = Number(cliente.artes_mensais_restantes || 0);

  if (quantity > freeArts) {
    const error = new Error("Voce nao tem artes livres suficientes para este Planejamento Mensal.");
    error.statusCode = 400;
    error.code = "monthly_planning_insufficient_arts";
    error.billing = billing || billingService.getBillingStatus(cliente);
    error.artes_livres = freeArts;
    throw error;
  }

  cliente.artes_mensais_restantes = Math.max(0, freeArts - quantity);
  reservas[planningId] = {
    ciclo,
    criado_em: createdAt,
    atualizado_em: createdAt,
    status: "ativa",
    quantidade_reservada: quantity,
    artes_bloqueadas_ativas: quantity,
    artes_produzidas: 0,
    artes_devolvidas: 0
  };

  const usage = refreshPlanningReservationCounters(cliente);

  return {
    ciclo,
    definitiva: true,
    quantidade_reservada: quantity,
    artes_deste_ciclo: Number(cliente.artes_mensais_total || billing?.artes_mensais_total || 0),
    reservadas_no_planejamento: quantity,
    livres_para_criar_arte: usage.livres_para_criar_arte,
    ja_produzidas: 0,
    total_reservadas_no_ciclo: usage.reservadas_no_planejamento
  };
}

function releasePlanningReservation(cliente, planning) {
  const planningId = planning.planejamento_id || planning.id;
  const ciclo = planning.ciclo || planCycle(cliente);

  if (cliente.planejamento_mensal_ciclo && cliente.planejamento_mensal_ciclo !== ciclo) {
    return {
      billing_alterado: false,
      artes_devolvidas: 0,
      livres_para_criar_arte: Number(cliente.artes_mensais_restantes || 0)
    };
  }

  const reservas = ensurePlanningReservationState(cliente, ciclo);
  const reserva = reservas[planningId];

  if (!reserva || String(reserva.status || "") !== "ativa") {
    refreshPlanningReservationCounters(cliente);
    return {
      billing_alterado: false,
      artes_devolvidas: 0,
      livres_para_criar_arte: Number(cliente.artes_mensais_restantes || 0)
    };
  }

  const reservadas = Number(reserva.quantidade_reservada || planning.quantidade_reservada || 0);
  const produzidas = Math.max(
    Number(reserva.artes_produzidas || 0),
    Number(planning.ja_produzidas || 0)
  );
  const jaDevolvidas = Number(reserva.artes_devolvidas || 0);
  const bloqueadasAtivas = Number(reserva.artes_bloqueadas_ativas || Math.max(0, reservadas - produzidas - jaDevolvidas));
  const devolvidas = Math.max(0, Math.min(bloqueadasAtivas, reservadas - produzidas - jaDevolvidas));
  const now = new Date().toISOString();

  reserva.status = "cancelada";
  reserva.cancelado_em = now;
  reserva.atualizado_em = now;
  reserva.artes_devolvidas = jaDevolvidas + devolvidas;
  reserva.artes_bloqueadas_ativas = 0;

  const usage = refreshPlanningReservationCounters(cliente);
  const total = Number(cliente.artes_mensais_total || 0);
  const usadas = Number(cliente.artes_mensais_usadas || 0);
  const maxFreeArts = Math.max(0, total - usadas - Number(usage.reservadas_no_planejamento || 0));
  const nextFreeArts = Number(cliente.artes_mensais_restantes || 0) + devolvidas;
  cliente.artes_mensais_restantes = Math.min(maxFreeArts, Math.max(0, nextFreeArts));
  const usageAfter = refreshPlanningReservationCounters(cliente);

  return {
    billing_alterado: devolvidas > 0,
    artes_devolvidas: devolvidas,
    livres_para_criar_arte: usageAfter.livres_para_criar_arte
  };
}

function parsePlanning(dirPath) {
  const solicitacaoPath = path.join(dirPath, "solicitacao.json");
  const solicitacao = readJson(solicitacaoPath);
  if (!solicitacao) return null;

  const status = readStatus(dirPath, solicitacao.status || "em_analise");
  const planoMensal = readJson(path.join(dirPath, "plano_mensal.json"), null);
  const pedidosCriados = readJson(path.join(dirPath, "pedidos_criados.json"), null);

  return {
    ...solicitacao,
    status,
    status_label: statusLabel(status),
    base_path: dirPath,
    solicitacao_path: solicitacaoPath,
    plano_mensal: planoMensal,
    pedidos_criados: pedidosCriados
  };
}

function statusLabel(status) {
  if (status === "em_analise") return "Em analise";
  if (status === "processando") return "Em producao";
  if (status === "pronto") return "Pronto";
  if (status === "erro") return "Erro";
  if (status === "cancelado") return "Cancelado";
  return status || "Em analise";
}

function planningTitle(ciclo) {
  const monthNames = [
    "Janeiro",
    "Fevereiro",
    "Marco",
    "Abril",
    "Maio",
    "Junho",
    "Julho",
    "Agosto",
    "Setembro",
    "Outubro",
    "Novembro",
    "Dezembro"
  ];
  const [yearText, monthText] = String(ciclo || "").split("-");
  const month = Number(monthText);
  if (yearText && month >= 1 && month <= 12) {
    return `Planejamento ${monthNames[month - 1]} ${yearText}`;
  }
  return "Planejamento Mensal";
}

function clientPlanningDir(baseDir, whatsapp) {
  return path.join(baseDir, safeSegment(whatsapp, "sem_whatsapp"));
}

function calendarHiddenPath(baseDir, whatsapp) {
  return path.join(clientPlanningDir(baseDir, whatsapp), "calendario_oculto.json");
}

function readCalendarHiddenItems(baseDir, whatsapp) {
  const data = readJson(calendarHiddenPath(baseDir, whatsapp), null);
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.hidden_items)) return data.hidden_items;
  if (Array.isArray(data?.itens_ocultos)) return data.itens_ocultos;
  if (Array.isArray(data?.hidden_keys)) {
    return data.hidden_keys.map((key) => ({ key }));
  }
  return [];
}

function calendarHiddenKeys(baseDir, whatsapp) {
  const keys = new Set();
  for (const item of readCalendarHiddenItems(baseDir, whatsapp)) {
    if (typeof item === "string") {
      const key = item.trim();
      if (key) keys.add(key);
      continue;
    }

    if (!item || typeof item !== "object") continue;
    [
      item.key,
      item.item_key,
      item.calendar_key,
      item.pedido_id,
      item.planning_id && item.planejamento_item_id ? `${item.planning_id}:${item.planejamento_item_id}` : "",
      item.planejamento_id && item.planejamento_item_id ? `${item.planejamento_id}:${item.planejamento_item_id}` : ""
    ].forEach((value) => {
      const key = String(value || "").trim();
      if (key) keys.add(key);
    });
  }
  return keys;
}

function writeCalendarHiddenItems(baseDir, whatsapp, items) {
  const now = new Date().toISOString();
  writeJson(calendarHiddenPath(baseDir, whatsapp), {
    whatsapp,
    atualizado_em: now,
    hidden_items: items
  });
}

function postCalendarKey(planningId, post) {
  const itemId = String(post.planejamento_item_id || post.id || post.ordem || "").trim();
  return [planningId, itemId].filter(Boolean).join(":") || String(post.pedido_id || "").trim();
}

function calendarItemAliases(item = {}) {
  return [
    item.calendar_key,
    item.item_key,
    item.key,
    item.pedido_id,
    item.planning_id && item.planejamento_item_id ? `${item.planning_id}:${item.planejamento_item_id}` : "",
    item.planejamento_id && item.planejamento_item_id ? `${item.planejamento_id}:${item.planejamento_item_id}` : ""
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
}

function isCalendarItemHidden(hiddenKeys, item) {
  return calendarItemAliases(item).some((key) => hiddenKeys.has(key));
}

function stripImageTextPrefix(value = "") {
  return String(value || "")
    .trim()
    .replace(/^escrita\s+que\s+deve\s+aparecer\s+na\s+imagem\s*:\s*/i, "")
    .trim();
}

function firstWords(value = "", maxWords = 6) {
  return String(value || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, maxWords)
    .join(" ");
}

function calendarPostTitle(post) {
  const source = stripImageTextPrefix(
    post.texto_obrigatorio_imagem
      || post.frase_foto
      || post.tema
      || post.objetivo
      || `Postagem ${post.ordem || ""}`
  );
  return firstWords(source, 6) || `Postagem ${post.ordem || ""}`.trim();
}

function createdOrdersFromPedidoFiles(planning = {}, pedidosDir = "") {
  const planningId = String(planning.planejamento_id || planning.id || "").trim();
  const whatsapp = String(planning.whatsapp || "").trim();
  if (!pedidosDir || !planningId || !whatsapp) return [];

  return orderStorage.listPedidoBasesByWhatsapp(pedidosDir, whatsapp)
    .map((item) => {
      const pedido = item.pedido || orderStorage.readOrder(item.base) || {};
      if (!isPlanningOrder(pedido)) return null;

      const meta = pedido.planejamento_mensal || {};
      const pedidoPlanningId = String(pedido.planejamento_id || meta.planejamento_id || "").trim();
      if (pedidoPlanningId !== planningId) return null;

      const pedidoId = String(pedido.id || item.id || path.basename(item.base || "")).trim();
      const itemId = String(pedido.planejamento_item_id || meta.planejamento_item_id || "").trim();
      if (!pedidoId || !itemId) return null;

      return {
        pedido_id: pedidoId,
        planejamento_item_id: itemId,
        ordem: Number(meta.ordem || pedido.ordem || 0),
        tema: pedido.tema || meta.tema || "",
        objetivo_postagem: pedido.objetivo_postagem || meta.objetivo_postagem || "",
        data_sugerida: pedido.data_sugerida || meta.data_sugerida || "",
        horario_sugerido: pedido.horario_sugerido || meta.horario_sugerido || "",
        status: orderStorage.readStatus(item.base, pedido.status || "novo"),
        criado_em: pedido.criado_em || item.criado_em || "",
        pedido_path: path.relative(pedidosDir, item.base).replace(/\\/g, "/")
      };
    })
    .filter(Boolean);
}

function createdOrderRecords(planning = {}, pedidosDir = "") {
  const pedidosCriados = [
    ...(planning.pedidos_criados?.pedidos || readCreatedOrdersFile(planning).pedidos || [])
  ];
  const seenPedidoIds = new Set(
    pedidosCriados
      .map((pedido) => String(pedido?.pedido_id || "").trim())
      .filter(Boolean)
  );

  for (const pedido of createdOrdersFromPedidoFiles(planning, pedidosDir)) {
    if (seenPedidoIds.has(pedido.pedido_id)) continue;
    pedidosCriados.push(pedido);
    seenPedidoIds.add(pedido.pedido_id);
  }

  return pedidosCriados;
}

function createdOrdersByPlanningItem(planning = {}, pedidosDir = "") {
  const pedidosCriados = createdOrderRecords(planning, pedidosDir);

  const byItemId = new Map();
  const byOrder = new Map();

  for (const record of pedidosCriados) {
    if (!record || typeof record !== "object") continue;
    const pedidoId = String(record.pedido_id || "").trim();
    if (!pedidoId) continue;

    const itemId = String(record.planejamento_item_id || "").trim();
    if (itemId) byItemId.set(itemId, pedidoId);

    const ordem = Number(record.ordem || 0);
    if (ordem > 0) byOrder.set(ordem, pedidoId);
  }

  return { byItemId, byOrder };
}

function resolvePlanningPostPedidoId({ planning, post, index, createdOrders }) {
  const directId = String(post.pedido_id || "").trim();
  if (directId) return directId;

  const itemId = String(
    post.planejamento_item_id
      || post.id
      || `${planning.planejamento_id || planning.id}_item_${String(index + 1).padStart(3, "0")}`
  ).trim();
  const byItemId = createdOrders?.byItemId?.get(itemId);
  if (byItemId) return byItemId;

  const ordem = Number(post.ordem || index + 1);
  const byOrder = createdOrders?.byOrder?.get(ordem);
  return byOrder || "";
}

function childOrderStatus({ pedidosDir, pedidoId }) {
  if (!pedidosDir || !pedidoId) {
    return {
      pedido_id: pedidoId || "",
      status: "planejada",
      status_label: "Planejada",
      imagem_pronta: false,
      descricao_instagram: ""
    };
  }

  const base = orderStorage.getPedidoBaseGlobal(pedidosDir, pedidoId);
  if (!base) {
    return {
      pedido_id: pedidoId,
      status: "planejada",
      status_label: "Planejada",
      imagem_pronta: false,
      descricao_instagram: ""
    };
  }

  const pedido = orderStorage.readOrder(base) || {};
  const rawStatus = orderStorage.readStatus(base, pedido.status || "novo");
  const imagemPronta = fs.existsSync(path.join(base, "resultado_final.png"));
  const descricaoInstagram = String(
    pedido.descricao_instagram || pedido.legacy?.descricao_instagram || ""
  ).trim();

  if (imagemPronta) {
    return {
      pedido_id: pedidoId,
      status: "pronta",
      status_label: "Pronta",
      imagem_pronta: true,
      descricao_instagram: descricaoInstagram
    };
  }

  if (rawStatus === "erro") {
    return {
      pedido_id: pedidoId,
      status: "erro",
      status_label: "Erro",
      imagem_pronta: false,
      descricao_instagram: descricaoInstagram
    };
  }

  if (["processando", "em_producao", "ajuste_pendente"].includes(rawStatus)) {
    return {
      pedido_id: pedidoId,
      status: "em_producao",
      status_label: "Em producao",
      imagem_pronta: false,
      descricao_instagram: descricaoInstagram
    };
  }

  return {
    pedido_id: pedidoId,
    status: "planejada",
    status_label: "Planejada",
    imagem_pronta: false,
    descricao_instagram: descricaoInstagram
  };
}

function planningPosts(planning, pedidosDir = "") {
  const plano = planning.plano_mensal || {};
  const sourcePosts = Array.isArray(plano.postagens)
    ? plano.postagens
    : Array.isArray(plano.itens)
      ? plano.itens
      : [];

  const createdOrders = createdOrdersByPlanningItem(planning, pedidosDir);
  return sourcePosts.map((post, index) => {
    const pedidoId = resolvePlanningPostPedidoId({ planning, post, index, createdOrders });
    const childStatus = childOrderStatus({ pedidosDir, pedidoId });
    const notificationFields = notificationFieldsForPost(post, planning);
    const legenda = String(childStatus.descricao_instagram || "").trim();
    return {
      ordem: Number(post.ordem || index + 1),
      planejamento_item_id: post.planejamento_item_id || post.id || `${planning.planejamento_id || planning.id}_item_${String(index + 1).padStart(3, "0")}`,
      tema: post.tema || "",
      objetivo: post.objetivo || post.objetivo_postagem || "",
      data_sugerida: post.data_sugerida || "",
      horario_sugerido: post.horario_sugerido || "",
      legenda,
      descricao_instagram: legenda,
      texto_obrigatorio_imagem: post.texto_obrigatorio_imagem || post.frase_foto || "",
      frase_foto: post.frase_foto || post.texto_obrigatorio_imagem || "",
      orientacao_cliente: post.orientacao_cliente || post.direcionamento_cliente || "",
      direcionamento_cliente: post.direcionamento_cliente || post.orientacao_cliente || "",
      pedido_id: pedidoId,
      status: childStatus.status,
      status_label: childStatus.status_label,
      imagem_pronta: childStatus.imagem_pronta,
      ...notificationFields
    };
  });
}

function planningPostCounts(posts) {
  const total = posts.length;
  const prontas = posts.filter((post) => post.status === "pronta").length;
  const erros = posts.filter((post) => post.status === "erro").length;
  const emProducao = posts.filter((post) => post.status === "em_producao").length;
  const planejadas = Math.max(0, total - prontas - erros - emProducao);

  return {
    total_postagens: total,
    prontas,
    em_producao: emProducao,
    planejadas,
    erros
  };
}

function summarizePlanning(planning, pedidosDir = "") {
  const posts = planningPosts(planning, pedidosDir);
  const counts = planningPostCounts(posts);

  return {
    id: planning.id,
    planejamento_id: planning.planejamento_id || planning.id,
    item_type: "planejamento_mensal",
    titulo: planningTitle(planning.ciclo),
    tipo: planning.tipo,
    status: planning.status,
    status_label: statusLabel(planning.status),
    ciclo: planning.ciclo,
    criado_em: planning.criado_em,
    atualizado_em: planning.atualizado_em || "",
    quantidade_reservada: Number(planning.quantidade_reservada || 0),
    artes_deste_ciclo: Number(planning.artes_deste_ciclo || 0),
    reservadas_no_planejamento: Number(planning.reservadas_no_planejamento || planning.quantidade_reservada || 0),
    livres_para_criar_arte: Number(planning.livres_para_criar_arte || 0),
    ja_produzidas: Number(planning.ja_produzidas || 0),
    fotos_count: Array.isArray(planning.assets?.fotos) ? planning.assets.fotos.length : 0,
    ...counts
  };
}

function listPlanningDirsForWhatsapp(baseDir, whatsapp) {
  const userDir = path.join(baseDir, safeSegment(whatsapp, "sem_whatsapp"));
  if (!fs.existsSync(userDir)) return [];

  const dirs = [];
  for (const cycleEntry of fs.readdirSync(userDir, { withFileTypes: true })) {
    if (!cycleEntry.isDirectory()) continue;
    const cycleDir = path.join(userDir, cycleEntry.name);
    for (const planningEntry of fs.readdirSync(cycleDir, { withFileTypes: true })) {
      if (!planningEntry.isDirectory()) continue;
      dirs.push(path.join(cycleDir, planningEntry.name));
    }
  }
  return dirs;
}

function listAllPlanningDirs(baseDir) {
  if (!fs.existsSync(baseDir)) return [];

  const dirs = [];
  for (const userEntry of fs.readdirSync(baseDir, { withFileTypes: true })) {
    if (!userEntry.isDirectory()) continue;
    const userDir = path.join(baseDir, userEntry.name);
    for (const cycleEntry of fs.readdirSync(userDir, { withFileTypes: true })) {
      if (!cycleEntry.isDirectory()) continue;
      const cycleDir = path.join(userDir, cycleEntry.name);
      for (const planningEntry of fs.readdirSync(cycleDir, { withFileTypes: true })) {
        if (!planningEntry.isDirectory()) continue;
        dirs.push(path.join(cycleDir, planningEntry.name));
      }
    }
  }

  return dirs;
}

function createRequest({ baseDir, cliente, whatsapp, body = {}, files = {} }) {
  const quantidadeReservada = normalizeQuantity(body);
  const { billing } = validatePlanAndFreeArts(cliente, quantidadeReservada);
  const ciclo = planCycle(cliente);
  const planningId = newPlanningId();
  const dirPath = requestDir(baseDir, whatsapp, ciclo, planningId);
  ensureDir(dirPath);

  const fotos = applyPhotoOrientations(saveUploadedPhotos(files, dirPath), body);
  const logo = saveUploadedLogo(files, dirPath);
  const orientacoesFotos = fotos
    .filter((foto) => String(foto.orientacao_cliente || "").trim())
    .map((foto, index) => ({
      ordem: index + 1,
      arquivo: foto.original_name || foto.filename,
      filename: foto.filename,
      orientacao: foto.orientacao_cliente
    }));
  const now = new Date().toISOString();
  const reservation = reservePlanningArts(cliente, planningId, quantidadeReservada, now, billing);
  const profile = normalizeProfile(body, cliente);
  const solicitacao = {
    id: planningId,
    planejamento_id: planningId,
    tipo: "planejamento_mensal",
    status: "em_analise",
    whatsapp,
    ciclo,
    criado_em: now,
    atualizado_em: now,
    quantidade_reservada: quantidadeReservada,
    artes_deste_ciclo: reservation.artes_deste_ciclo,
    reservadas_no_planejamento: reservation.reservadas_no_planejamento,
    livres_para_criar_arte: reservation.livres_para_criar_arte,
    ja_produzidas: reservation.ja_produzidas,
    reserva: {
      validada: true,
      definitiva: true,
      fase_4_pendente: false,
      quantidade_reservada: quantidadeReservada,
      artes_bloqueadas_ativas: quantidadeReservada,
      artes_produzidas: 0,
      artes_devolvidas: 0,
      total_reservadas_no_ciclo: reservation.total_reservadas_no_ciclo,
      observacao: "Reserva definitiva aplicada em artes_mensais_restantes. Criar Arte usa somente as artes livres restantes."
    },
    profile,
    caracteristicas_empresa: profile.caracteristicas_empresa,
    informacoes_empresa: profile.informacoes_empresa,
    orientacoes_fotos: orientacoesFotos,
    assets: {
      logo,
      fotos
    },
    runner_contract: {
      pronto_para_runner: true,
      fase_runner: "fase_5",
      zip_endpoint: `/bot/empresa/planejamento-mensal/${planningId}/zip`,
      observacao: "Runner local deve criar apenas plano_mensal.json. Nao gerar imagens nem pedidos filhos nesta fase."
    }
  };

  writeJson(path.join(dirPath, "solicitacao.json"), solicitacao);
  writeJson(path.join(dirPath, "plano_mensal.json"), {
    planejamento_id: planningId,
    itens: []
  });
  writeJson(path.join(dirPath, "pedidos_criados.json"), {
    planejamento_id: planningId,
    pedidos: []
  });
  writeStatus(dirPath, "em_analise");
  appendLog(dirPath, "Solicitacao de Planejamento Mensal criada com reserva definitiva de artes.");

  return solicitacao;
}

function listClientPlannings({ baseDir, whatsapp, pedidosDir = "" }) {
  const planejamentos = listPlanningDirsForWhatsapp(baseDir, whatsapp)
    .map(parsePlanning)
    .filter(Boolean)
    .sort((a, b) => String(b.criado_em || "").localeCompare(String(a.criado_em || "")))
    .map((planning) => summarizePlanning(planning, pedidosDir));

  return {
    ok: true,
    planejamentos
  };
}

function calendarPayloadForPost(planning, post) {
  const planningId = String(planning.planejamento_id || planning.id || "").trim();
  const calendarKey = postCalendarKey(planningId, post);
  const pedidoId = String(post.pedido_id || "").trim();
  const imageReady = post.imagem_pronta === true;
  const previewUrl = imageReady && pedidoId
    ? `/pedidos/${encodeURIComponent(pedidoId)}/preview`
    : "";

  return {
    key: calendarKey,
    item_key: calendarKey,
    calendar_key: calendarKey,
    planning_id: planningId,
    planejamento_id: planningId,
    pedido_id: pedidoId,
    ordem: Number(post.ordem || 0),
    planejamento_item_id: post.planejamento_item_id || post.id || "",
    data: post.data_sugerida || "",
    horario: post.horario_sugerido || "",
    data_sugerida: post.data_sugerida || "",
    horario_sugerido: post.horario_sugerido || "",
    status: post.status || "",
    status_label: post.status_label || post.status || "",
    titulo: calendarPostTitle(post),
    legenda: post.legenda || post.descricao_instagram || "",
    descricao_instagram: post.descricao_instagram || post.legenda || "",
    tema: post.tema || "",
    objetivo: post.objetivo || post.objetivo_postagem || "",
    texto_obrigatorio_imagem: post.texto_obrigatorio_imagem || post.frase_foto || "",
    frase_foto: post.frase_foto || post.texto_obrigatorio_imagem || "",
    orientacao_cliente: post.orientacao_cliente || post.direcionamento_cliente || "",
    imagem_pronta: imageReady,
    imagem_url: previewUrl,
    miniatura_url: previewUrl,
    preview_url: previewUrl,
    sort_key: [
      post.data_sugerida || "9999-12-31",
      post.horario_sugerido || "23:59",
      String(post.ordem || 0).padStart(4, "0")
    ].join("|")
  };
}

function listClientPlanningCalendar({ baseDir, whatsapp, pedidosDir = "" }) {
  const hiddenKeys = calendarHiddenKeys(baseDir, whatsapp);
  const postagens = [];

  for (const planning of listPlanningDirsForWhatsapp(baseDir, whatsapp).map(parsePlanning).filter(Boolean)) {
    const posts = planningPosts(planning, pedidosDir);
    for (const post of posts) {
      const item = calendarPayloadForPost(planning, post);
      if (isCalendarItemHidden(hiddenKeys, item)) continue;
      postagens.push(item);
    }
  }

  postagens.sort((a, b) => String(a.sort_key || "").localeCompare(String(b.sort_key || "")));

  return {
    ok: true,
    total: postagens.length,
    postagens,
    itens: postagens
  };
}

function hideClientPlanningCalendarItem({
  baseDir,
  whatsapp,
  itemKey = "",
  pedidoId = "",
  planningId = "",
  planejamentoItemId = ""
}) {
  const key = String(itemKey || pedidoId || "").trim();
  if (!key) {
    const error = new Error("Item do calendario nao informado.");
    error.statusCode = 400;
    error.code = "monthly_planning_calendar_item_required";
    throw error;
  }

  const now = new Date().toISOString();
  const current = readCalendarHiddenItems(baseDir, whatsapp)
    .map((item) => typeof item === "string" ? { key: item, item_key: item } : item)
    .filter((item) => item && typeof item === "object");
  const keys = calendarHiddenKeys(baseDir, whatsapp);

  if (!keys.has(key)) {
    current.push({
      key,
      item_key: key,
      pedido_id: String(pedidoId || "").trim(),
      planning_id: String(planningId || "").trim(),
      planejamento_item_id: String(planejamentoItemId || "").trim(),
      oculto_em: now
    });
  }

  writeCalendarHiddenItems(baseDir, whatsapp, current);

  return {
    ok: true,
    item_key: key,
    oculto_em: now
  };
}

function listClientPlanningGroups({ baseDir, whatsapp, pedidosDir = "", limit = 15 }) {
  const max = Math.max(1, Math.min(Number(limit) || 15, 50));
  const planejamentos = listPlanningDirsForWhatsapp(baseDir, whatsapp)
    .map(parsePlanning)
    .filter(Boolean)
    .sort((a, b) => String(b.criado_em || "").localeCompare(String(a.criado_em || "")))
    .slice(0, max)
    .map((planning) => summarizePlanning(planning, pedidosDir));

  return planejamentos;
}

function findPlanningById({ baseDir, whatsapp, planningId }) {
  const safeId = safeSegment(planningId, "planejamento");
  const dirs = listPlanningDirsForWhatsapp(baseDir, whatsapp);

  for (const dirPath of dirs) {
    if (path.basename(dirPath) !== safeId) continue;
    const planning = parsePlanning(dirPath);
    if (planning && String(planning.planejamento_id || planning.id) === String(planningId)) {
      return planning;
    }
  }

  return null;
}

function findPlanningByIdAny({ baseDir, planningId }) {
  const safeId = safeSegment(planningId, "planejamento");
  const dirs = listAllPlanningDirs(baseDir);

  for (const dirPath of dirs) {
    if (path.basename(dirPath) !== safeId) continue;
    const planning = parsePlanning(dirPath);
    if (planning && String(planning.planejamento_id || planning.id) === String(planningId)) {
      return planning;
    }
  }

  return null;
}

function botPendingPayload(planning) {
  return {
    planejamento_id: planning.planejamento_id || planning.id,
    id: planning.planejamento_id || planning.id,
    whatsapp: planning.whatsapp,
    ciclo: planning.ciclo,
    status: planning.status,
    criado_em: planning.criado_em,
    atualizado_em: planning.atualizado_em || "",
    quantidade_reservada: Number(planning.quantidade_reservada || 0),
    ramo: planning.profile?.ramo || "",
    nome_empresa: planning.profile?.nome_empresa || "",
    fotos_count: Array.isArray(planning.assets?.fotos) ? planning.assets.fotos.length : 0,
    zip_url: `/bot/empresa/planejamento-mensal/${planning.planejamento_id || planning.id}/zip`
  };
}

function dateMs(value) {
  const ms = new Date(value || 0).getTime();
  return Number.isFinite(ms) && !Number.isNaN(ms) ? ms : 0;
}

function hasActiveRunnerClaim(planning, nowMs = Date.now()) {
  const expiresAt = dateMs(planning.runner_claim_expires_em);
  return Boolean(expiresAt && expiresAt > nowMs);
}

function isStaleProcessing(planning, nowMs = Date.now()) {
  if (planning.status !== "processando") return false;
  const processingSince = dateMs(planning.processando_em || planning.atualizado_em || planning.criado_em);
  if (!processingSince) return true;
  return nowMs - processingSince > PROCESSING_STALE_MS;
}

function claimPlanningForRunner(planning, now = new Date()) {
  const nowIso = now.toISOString();
  const solicitacao = readJson(planning.solicitacao_path) || planning;
  solicitacao.runner_claimed_em = nowIso;
  solicitacao.runner_claim_expires_em = new Date(now.getTime() + BOT_CLAIM_TTL_MS).toISOString();
  solicitacao.runner_claim_id = crypto.randomBytes(6).toString("hex");
  solicitacao.atualizado_em = nowIso;
  writeJson(planning.solicitacao_path, solicitacao);
  appendLog(planning.base_path, `Planejamento reservado para runner ate ${solicitacao.runner_claim_expires_em}.`);
  return parsePlanning(planning.base_path);
}

function recoverStaleProcessing(planning, now = new Date()) {
  if (!isStaleProcessing(planning, now.getTime())) return planning;

  const solicitacao = readJson(planning.solicitacao_path) || planning;
  solicitacao.status = "em_analise";
  solicitacao.status_message = "Processamento anterior expirou; Planejamento liberado para reprocessamento seguro.";
  solicitacao.runner_claim_expires_em = "";
  solicitacao.atualizado_em = now.toISOString();
  solicitacao.reprocessamentos = Number(solicitacao.reprocessamentos || 0) + 1;
  writeJson(planning.solicitacao_path, solicitacao);
  writeStatus(planning.base_path, "em_analise");
  appendLog(planning.base_path, "Processamento stale recuperado e liberado para runner.");
  return parsePlanning(planning.base_path);
}

function listBotPending({ baseDir, limit = 5, claim = true }) {
  const max = Math.max(1, Math.min(Number(limit) || 5, BOT_PENDING_HARD_LIMIT));
  const now = new Date();
  const nowMs = now.getTime();
  const candidates = listAllPlanningDirs(baseDir)
    .map(parsePlanning)
    .filter(Boolean)
    .map((planning) => recoverStaleProcessing(planning, now))
    .filter((planning) => planning.status === "em_analise")
    .filter((planning) => planning.runner_contract?.pronto_para_runner !== false)
    .filter((planning) => !hasActiveRunnerClaim(planning, nowMs))
    .sort((a, b) => String(a.criado_em || "").localeCompare(String(b.criado_em || "")))
    .slice(0, max);

  const planejamentos = candidates
    .map((planning) => claim ? claimPlanningForRunner(planning, now) : planning)
    .filter(Boolean)
    .map(botPendingPayload);

  return {
    ok: true,
    planejamentos,
    limit: max,
    claimed: claim === true
  };
}

function updatePlanningStatus({ baseDir, planningId, status, message = "" }) {
  if (!VALID_STATUSES.has(status)) {
    const error = new Error("Status de Planejamento Mensal invalido.");
    error.statusCode = 400;
    error.code = "monthly_planning_invalid_status";
    throw error;
  }

  const planning = findPlanningByIdAny({ baseDir, planningId });
  if (!planning) {
    const error = new Error("Planejamento Mensal nao encontrado.");
    error.statusCode = 404;
    error.code = "monthly_planning_not_found";
    throw error;
  }

  const solicitacao = readJson(planning.solicitacao_path) || planning;
  const now = new Date().toISOString();
  solicitacao.status = status;
  solicitacao.atualizado_em = now;
  if (status === "processando") solicitacao.processando_em = solicitacao.processando_em || now;
  if (status === "erro") solicitacao.erro_em = now;
  if (status !== "em_analise") {
    solicitacao.runner_claim_expires_em = "";
    solicitacao.runner_claim_consumed_em = solicitacao.runner_claim_consumed_em || now;
  }
  if (message) solicitacao.status_message = String(message).slice(0, 2000);

  writeJson(planning.solicitacao_path, solicitacao);
  writeStatus(planning.base_path, status);
  appendLog(planning.base_path, `Status atualizado pelo runner: ${status}${message ? ` - ${message}` : ""}`);

  return parsePlanning(planning.base_path);
}

function normalizePlanResultPayload(payload = {}) {
  const rawPlan = payload.plano_mensal || payload.plano || payload;
  if (typeof rawPlan === "string") {
    try {
      return JSON.parse(rawPlan);
    } catch {
      const error = new Error("plano_mensal precisa ser um JSON valido.");
      error.statusCode = 400;
      error.code = "monthly_planning_invalid_plan_json";
      throw error;
    }
  }

  if (!rawPlan || typeof rawPlan !== "object" || Array.isArray(rawPlan)) {
    const error = new Error("Informe o plano_mensal gerado pelo pipeline.");
    error.statusCode = 400;
    error.code = "monthly_planning_plan_required";
    throw error;
  }

  return rawPlan;
}

function resolvePlanningAssetPath(planning, asset = {}) {
  const filename = String(asset.filename || "").trim();
  const relPath = String(asset.path || "").trim();
  const candidates = [];

  if (relPath) {
    candidates.push(path.join(planning.base_path, relPath));
    candidates.push(path.join(path.dirname(planning.base_path), relPath));
  }

  if (filename) {
    candidates.push(path.join(planning.base_path, "fotos", filename));
  }

  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

function extensionFromAsset(asset = {}, sourcePath = "") {
  const filenameExt = path.extname(asset.filename || asset.original_name || sourcePath || "").toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".webp"].includes(filenameExt)) return filenameExt;

  const mime = String(asset.mime_type || "").toLowerCase();
  if (mime.includes("jpeg") || mime.includes("jpg")) return ".jpg";
  if (mime.includes("webp")) return ".webp";
  return ".png";
}

function photoReferenceOrder(item = {}) {
  const ref = item.foto_referencia || {};
  const ordem = Number(ref.ordem || ref.order || ref.index || 0);
  return Number.isFinite(ordem) && ordem > 0 ? ordem : 0;
}

function photoReferenceName(item = {}) {
  const ref = item.foto_referencia || {};
  return String(ref.filename || ref.original_name || ref.arquivo || ref.file || "").trim().toLowerCase();
}

function selectPlanningPhotoAssets(planning, item = {}) {
  const assets = planning.assets || {};
  const photos = Array.isArray(assets.fotos) ? assets.fotos : [];
  if (!photos.length) return [];

  const postOrder = Number(item.ordem || 0);
  const refOrder = photoReferenceOrder(item);
  const refName = photoReferenceName(item);
  const refLooksSpecific = refOrder > 0 && refOrder === postOrder && postOrder <= photos.length;

  if (refLooksSpecific) {
    const byOrder = photos[refOrder - 1];
    if (byOrder && typeof byOrder === "object") {
      return [{ asset: byOrder, originalIndex: refOrder - 1 }];
    }
  }

  if (refLooksSpecific && refName) {
    const matchedIndex = photos.findIndex((photo) => {
      if (!photo || typeof photo !== "object") return false;
      return [photo.filename, photo.original_name, photo.arquivo, photo.file]
        .map((value) => String(value || "").trim().toLowerCase())
        .includes(refName);
    });
    if (matchedIndex >= 0) {
      return [{ asset: photos[matchedIndex], originalIndex: matchedIndex }];
    }
  }

  return photos.map((asset, originalIndex) => ({ asset, originalIndex }));
}

function copyPlanningAssetsToOrder(planning, orderBase, item = {}) {
  const copiedPhotos = [];
  const selectedPhotos = selectPlanningPhotoAssets(planning, item);
  let copiedLogo = "";

  selectedPhotos.forEach(({ asset, originalIndex }) => {
    if (!asset || typeof asset !== "object") return;
    const sourcePath = resolvePlanningAssetPath(planning, asset);
    const ext = extensionFromAsset(asset, sourcePath);
    const filename = `foto${String(originalIndex + 1).padStart(2, "0")}${ext}`;
    const destPath = path.join(orderBase, filename);
    if (safeCopyFile(sourcePath, destPath)) {
      copiedPhotos.push(filename);
    }
  });

  const logoAsset = planning.assets?.logo;
  if (logoAsset && typeof logoAsset === "object") {
    const sourcePath = resolvePlanningAssetPath(planning, logoAsset);
    const ext = extensionFromAsset(logoAsset, sourcePath);
    const filename = `logo${ext}`;
    const destPath = path.join(orderBase, filename);
    if (safeCopyFile(sourcePath, destPath)) {
      copiedLogo = filename;
    }
  }

  return {
    logo: copiedLogo,
    fotos: copiedPhotos
  };
}

function cleanText(value, fallback = "") {
  const text = String(value || "").trim();
  return text || fallback;
}

function cleanInternalPlanningText(value, fallback = "") {
  const text = cleanText(value, fallback);
  const normalized = normalizeForCheck(text).trim();
  const compact = normalized.replace(/[^a-z0-9]+/g, "");
  if (
    /^reforco\d*$/.test(compact) ||
    /^reforo\d*$/.test(compact) ||
    (compact.startsWith("refor") && compact.length <= 10)
  ) {
    return fallback;
  }
  return text;
}

const PLANNING_FORBIDDEN_VISIBLE_TEXTS = [
  "reforco",
  "reforco 2",
  "reforco 3",
  "reforco 4",
  "reforco 5",
  "tema interno",
  "objetivo interno"
];

const PERSON_PRESERVATION_RULES = [
  "nao alterar rosto",
  "nao trocar rosto",
  "nao alterar corpo",
  "nao emagrecer ou engordar",
  "nao mudar idade aparente",
  "nao mudar cor de pele",
  "nao transformar em outra pessoa",
  "manter a identidade visual da pessoa",
  "usar a foto como referencia principal"
];

const PRICE_FORBIDDEN_TEXTS = [
  "preco",
  "preço",
  "valor",
  "valores",
  "R$",
  "reais",
  "desconto",
  "a partir de",
  "por apenas"
];

function normalizeArray(value) {
  if (Array.isArray(value)) return value.filter((item) => String(item || "").trim());
  if (!value) return [];
  return [value].filter((item) => String(item || "").trim());
}

function normalizeForCheck(value = "") {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function planningStyleForOrder(ordem = 1) {
  const index = Math.max(0, Number(ordem || 1) - 1);
  return index % 2 === 0 ? "normal" : "leve";
}

function planningLevelFromOrientation(orientacaoCliente = "") {
  const text = normalizeForCheck(orientacaoCliente).replace(/[_-]+/g, " ");
  const patterns = [
    /\bnivel\s+de\s+edicao\s*[:=]?\s*([123])\b/,
    /\bnivel\s*edicao\s*[:=]?\s*([123])\b/,
    /\bnivel\s*[:=]?\s*([123])\b/
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return Number(match[1]);
  }

  const compact = text.replace(/[^a-z0-9]+/g, "");
  const compactMatch = compact.match(/(?:niveldeedicao|niveledicao|nivel)([123])/);
  return compactMatch ? Number(compactMatch[1]) : 0;
}

function planningStyleFromOrientation(orientacaoCliente = "", ordem = 1) {
  switch (planningLevelFromOrientation(orientacaoCliente)) {
    case 1:
      return "foto_detalhes";
    case 2:
      return "leve";
    case 3:
      return "normal";
    default:
      return planningStyleForOrder(ordem);
  }
}

function valueAfterOrientationLabel(line = "") {
  const text = String(line || "");
  const separatorIndex = text.search(/[:=]/);
  return separatorIndex >= 0 ? text.slice(separatorIndex + 1).trim() : "";
}

function appendOrientationValue(currentValue = "", addition = "") {
  const value = cleanText(addition);
  if (!value) return currentValue;
  return [currentValue, value].filter(Boolean).join("\n");
}

function parsePhotoOrientationBlocks(orientacaoCliente = "") {
  const result = {
    objetivo: "",
    escrita: "",
    nivel: planningLevelFromOrientation(orientacaoCliente),
    visual: ""
  };
  let currentKey = "";
  const visualLines = [];

  String(orientacaoCliente || "").split(/\r?\n/).forEach((rawLine) => {
    const line = String(rawLine || "").trim();
    if (!line) return;
    const normalized = normalizeForCheck(line).replace(/[_-]+/g, " ");

    if (/^objetivo\s+da\s+foto\b/.test(normalized)) {
      currentKey = "objetivo";
      result.objetivo = appendOrientationValue(result.objetivo, valueAfterOrientationLabel(line));
      return;
    }

    if (/^escrita\s+que\s+deve\s+aparecer\s+na\s+imagem\b/.test(normalized)) {
      currentKey = "escrita";
      result.escrita = appendOrientationValue(result.escrita, valueAfterOrientationLabel(line));
      return;
    }

    if (
      /^nivel\s+de\s+edicao\b/.test(normalized)
      || /^nivel\s*edicao\b/.test(normalized)
      || /^niveledicao\b/.test(normalized)
      || /^nivel\s*[:=]?\s*[123]\b/.test(normalized)
    ) {
      currentKey = "";
      return;
    }

    if (currentKey === "objetivo") {
      result.objetivo = appendOrientationValue(result.objetivo, line);
      return;
    }

    if (currentKey === "escrita") {
      result.escrita = appendOrientationValue(result.escrita, line);
      return;
    }

    visualLines.push(line);
  });

  result.visual = visualLines.join("\n").trim();
  return result;
}

function orientationForItem(item = {}) {
  const photo = item.foto_referencia || {};
  return cleanText(
    item.orientacao_cliente
      || item.direcionamento_cliente
      || photo.orientacao_cliente
      || ""
  );
}

function orientationFlags(value = "") {
  const text = normalizeForCheck(value);
  return {
    promocao: /\b(promocao|promo|oferta|divulgar|venda|vender)\b/.test(text),
    sem_preco: text.includes("nao colocar preco")
      || text.includes("sem preco")
      || text.includes("nao por preco")
      || text.includes("nao mostrar preco")
      || text.includes("sem valor")
      || text.includes("nao colocar valor"),
    fim_de_semana: text.includes("fim de semana")
      || text.includes("final de semana")
      || text.includes("sabado")
      || text.includes("domingo")
      || /\bfds\b/.test(text)
  };
}

function stripImageTextCommand(value = "") {
  const original = cleanText(value);
  return original
    .replace(/^\s*(coloque|colocar|escreva|escrever|inclua|incluir|adicione|adicionar|mencione|mencionar)\s+/i, "")
    .replace(/^\s*(na arte|na imagem|no post|no card)\s*[:,-]?\s*/i, "")
    .trim()
    .replace(/^[.,:;\-\s]+|[.,:;\-\s]+$/g, "") || original;
}

function forbiddenTermsFromOrientation(value = "") {
  const text = normalizeForCheck(value);
  const terms = [];
  if (text.includes("preco") || text.includes("valor") || text.includes("r$") || text.includes("reais")) {
    terms.push(...PRICE_FORBIDDEN_TEXTS);
  }
  if (text.includes("promocao") || text.includes("promo") || text.includes("oferta")) {
    terms.push("promocao", "promoção", "promo", "oferta");
  }
  if (text.includes("desconto") || text.includes("off")) {
    terms.push("desconto", "off", "% off");
  }
  if (text.includes("telefone") || text.includes("whatsapp") || text.includes("celular") || text.includes("contato")) {
    terms.push("telefone", "whatsapp", "celular", "contato");
  }
  return Array.from(new Set(terms));
}

function classifyCustomerOrientation(value = "") {
  const original = cleanText(value);
  const text = normalizeForCheck(original);
  const result = {
    orientacao_visual: "",
    texto_obrigatorio_imagem: "",
    orientacao_legenda: "",
    texto_proibido: []
  };
  if (!original) return result;

  const hasForbiddenIntent = [
    "nao colocar",
    "nao escrever",
    "nao falar",
    "nao mencionar",
    "sem preco",
    "sem valor",
    "sem telefone",
    "sem desconto",
    "nao mostrar",
    "nao por"
  ].some((term) => text.includes(term));

  if (hasForbiddenIntent) {
    result.texto_proibido = forbiddenTermsFromOrientation(original);
    if (!result.texto_proibido.length) result.texto_proibido = [original];
    return result;
  }

  const hasLegendIntent = [
    "na legenda",
    "na descricao",
    "no texto do instagram",
    "no instagram",
    "caption",
    "legenda explicar",
    "descricao explicar"
  ].some((term) => text.includes(term));

  if (hasLegendIntent) {
    result.orientacao_legenda = original;
    return result;
  }

  const startsVisualShow = text.startsWith("mostrar que") || text.startsWith("falar sobre");
  const hasImageTextIntent = [
    "coloque ",
    "colocar ",
    "escreva ",
    "escrever ",
    "inclua ",
    "incluir ",
    "adicione ",
    "adicionar ",
    "mencione ",
    "mencionar ",
    "por na arte",
    "poe na arte"
  ].some((term) => text.includes(term));

  if (hasImageTextIntent && !startsVisualShow) {
    result.texto_obrigatorio_imagem = stripImageTextCommand(original);
    return result;
  }

  result.orientacao_visual = original;
  return result;
}

function mergeOrientationRouting(item = {}) {
  const photo = item.foto_referencia || {};
  const orientation = orientationForItem(item);
  const parsed = parsePhotoOrientationBlocks(orientation);
  const classified = classifyCustomerOrientation(parsed.visual);
  return {
    orientacao_visual: cleanText(item.orientacao_visual || photo.orientacao_visual || parsed.visual || classified.orientacao_visual),
    texto_obrigatorio_imagem: cleanText(item.texto_obrigatorio_imagem || photo.texto_obrigatorio_imagem || parsed.escrita || classified.texto_obrigatorio_imagem),
    orientacao_legenda: cleanText(item.orientacao_legenda || photo.orientacao_legenda || classified.orientacao_legenda),
    objetivo_foto_cliente: parsed.objetivo,
    nivel_edicao_cliente: parsed.nivel || 0,
    texto_proibido: Array.from(new Set([
      ...normalizeArray(item.texto_proibido),
      ...normalizeArray(photo.texto_proibido),
      ...normalizeArray(classified.texto_proibido)
    ]))
  };
}

function hasPersonReference(item = {}) {
  const photo = item.foto_referencia || {};
  if (item.preservar_pessoa === true || photo.tem_pessoa === true) return true;
  const text = normalizeForCheck([
    item.tema,
    item.objetivo,
    item.briefing_arte,
    photo.descricao,
    photo.categoria_visual,
    photo.tipo_conteudo,
    ...(normalizeArray(photo.elementos_principais))
  ].join(" "));
  return /\b(pessoa|pessoas|rosto|face|corpo|atleta|equipe|funcionario|colaborador|profissional|cliente|aluno|professor)\b/.test(text);
}

function forbiddenVisibleTextsForItem(item = {}) {
  const orientation = orientationForItem(item);
  const flags = orientationFlags(orientation);
  const custom = mergeOrientationRouting(item).texto_proibido;
  return Array.from(new Set([
    ...PLANNING_FORBIDDEN_VISIBLE_TEXTS,
    ...custom,
    ...(flags.sem_preco ? PRICE_FORBIDDEN_TEXTS : [])
  ]));
}

function personRulesForItem(item = {}) {
  const photo = item.foto_referencia || {};
  const customRules = normalizeArray(item.regras_preservacao_pessoa || photo.regras_preservacao_pessoa);
  if (!hasPersonReference(item)) return customRules;
  return Array.from(new Set([...PERSON_PRESERVATION_RULES, ...customRules]));
}

function buildChildBriefing({ briefingArte, temaInterno, objetivoInterno, forbiddenTexts, personRules, customerOrientation, routing }) {
  const lines = [
    briefingArte,
    "Tema e objetivo do Planejamento Mensal sao orientacao interna, nao texto obrigatorio da arte.",
    `Tema interno: ${temaInterno}.`,
    `Objetivo interno: ${objetivoInterno}.`,
    "O texto visivel da imagem deve ser criado naturalmente pelo pipeline principal, sem copiar literalmente tema ou objetivo.",
    `Nunca escrever na imagem: ${forbiddenTexts.join(", ")}.`
  ];

  if (personRules.length) {
    lines.push(`Foto com pessoa detectada: ${personRules.join("; ")}.`);
  }

  if (customerOrientation) {
    lines.push([
      "ORIENTACAO DO CLIENTE PARA ESTA FOTO:",
      customerOrientation,
      "OBEDECA ESSA ORIENTACAO. Nao trate como sugestao fraca.",
      "Nao copie literalmente como texto obrigatorio na imagem, a menos que o cliente tenha pedido explicitamente.",
      "Use como direcao da arte e da legenda."
    ].join("\n"));
  }

  if (routing?.orientacao_visual) {
    lines.push([
      "INSTRUCAO VISUAL OBRIGATORIA:",
      routing.orientacao_visual,
      "Use como direcao da composicao e da mensagem visual. Nao copie literalmente se nao houver pedido de texto."
    ].join("\n"));
  }

  if (routing?.texto_obrigatorio_imagem) {
    lines.push([
      "TEXTO QUE DEVE APARECER NA IMAGEM:",
      routing.texto_obrigatorio_imagem
    ].join("\n"));
  }

  if (routing?.orientacao_legenda) {
    lines.push([
      "ORIENTACAO PARA LEGENDA/DESCRICAO:",
      routing.orientacao_legenda,
      "Nao usar como texto obrigatorio da imagem."
    ].join("\n"));
  }

  if (forbiddenTexts.length) {
    lines.push(`TEXTO/ASSUNTO PROIBIDO: ${forbiddenTexts.join(", ")}.`);
  }

  return lines.filter(Boolean).join("\n");
}

function buildChildOrder({ planning, item, itemId, pedidoId, mesAtual, copiedAssets }) {
  const profile = planning.profile || {};
  const tema = cleanInternalPlanningText(
    item.tema_interno || item.tema,
    `Postagem planejada ${item.ordem || ""}`.trim()
  );
  const objetivoPostagem = cleanInternalPlanningText(
    item.objetivo_interno || item.objetivo,
    "Divulgar a empresa com clareza e profissionalismo."
  );
  const publicOffer = cleanText(item.texto_nao_obrigatorio || item.texto_publico_sugerido || "");
  const orientacaoCliente = orientationForItem(item);
  const orientacaoFlags = orientationFlags(orientacaoCliente);
  const orientacaoEstruturada = parsePhotoOrientationBlocks(orientacaoCliente);
  const orientacaoRoteada = mergeOrientationRouting(item);
  const objetivoFotoCliente = cleanText(orientacaoRoteada.objetivo_foto_cliente || orientacaoEstruturada.objetivo);
  const objetivoPedido = cleanText(objetivoFotoCliente, objetivoPostagem);
  const hasStructuredOrientation = Boolean(
    objetivoFotoCliente
      || orientacaoRoteada.texto_obrigatorio_imagem
      || orientacaoRoteada.nivel_edicao_cliente
  );
  const orientacaoClienteBriefing = hasStructuredOrientation
    ? [
      objetivoFotoCliente ? `Objetivo da foto: ${objetivoFotoCliente}` : "",
      orientacaoRoteada.orientacao_visual
    ].filter(Boolean).join("\n")
    : orientacaoCliente;
  const forbiddenTexts = forbiddenVisibleTextsForItem(item);
  const personRules = personRulesForItem(item);
  const estiloVisual = planningStyleFromOrientation(orientacaoCliente, item.ordem || 1);
  const briefingArte = buildChildBriefing({
    briefingArte: cleanText(item.briefing_arte, objetivoPostagem),
    temaInterno: tema,
    objetivoInterno: objetivoPostagem,
    forbiddenTexts,
    personRules,
    customerOrientation: orientacaoClienteBriefing,
    routing: orientacaoRoteada
  });
  const dataSugerida = cleanText(item.data_sugerida);
  const horarioSugerido = cleanText(item.horario_sugerido);
  const nomeEmpresa = cleanText(profile.nome_empresa, "Empresa");
  const ramo = cleanText(profile.ramo, "empresa local");
  const whatsappContato = cleanText(profile.whatsapp, planning.whatsapp || "");
  const instagram = cleanText(profile.instagram);
  const caracteristicasEmpresa = companyCharacteristicsFromPlanning(planning, profile);
  const informacoesEmpresa = companyImportantInfoFromPlanning(planning, profile);

  const fields = {
    ramo,
    nome_empresa: nomeEmpresa,
    objetivo: objetivoPedido,
    oferta: publicOffer,
    cta: whatsappContato ? "Chame no WhatsApp" : "Entre em contato",
    whatsapp: whatsappContato,
    instagram,
    caracteristicas_empresa: caracteristicasEmpresa,
    informacoes_empresa: informacoesEmpresa,
    estilo_visual_cliente: estiloVisual,
    frase_foto: orientacaoRoteada.texto_obrigatorio_imagem,
    observacoes: [
      briefingArte,
      dataSugerida ? `Data sugerida: ${dataSugerida}` : "",
      horarioSugerido ? `Horario sugerido: ${horarioSugerido}` : ""
    ].filter(Boolean).join("\n"),
    historia_empresa: cleanText(profile.historia),
    campos_dinamicos: {
      origem: "planejamento_mensal",
      tema_interno: tema,
      objetivo_interno: objetivoPostagem,
      objetivo_foto_cliente: objetivoFotoCliente,
      objetivo_planejamento_interno: objetivoPostagem,
      data_sugerida: dataSugerida,
      horario_sugerido: horarioSugerido,
      briefing_arte: briefingArte,
      estilo_visual_cliente: estiloVisual,
      nivel_edicao_cliente: orientacaoRoteada.nivel_edicao_cliente || 0,
      frase_na_foto: orientacaoRoteada.texto_obrigatorio_imagem,
      texto_proibido: forbiddenTexts,
      orientacao_cliente: orientacaoCliente,
      direcionamento_cliente: orientacaoCliente,
      orientacao_prioridade: orientacaoCliente ? "alta" : "",
      orientacao_flags: orientacaoFlags,
      orientacao_visual: orientacaoRoteada.orientacao_visual,
      texto_obrigatorio_imagem: orientacaoRoteada.texto_obrigatorio_imagem,
      orientacao_legenda: orientacaoRoteada.orientacao_legenda,
      caracteristicas_empresa: caracteristicasEmpresa,
      informacoes_empresa: informacoesEmpresa,
      preservar_pessoa: personRules.length > 0,
      regras_preservacao_pessoa: personRules
    }
  };

  const now = new Date().toISOString();
  const planningMeta = {
    origem: "planejamento_mensal",
    planejamento_id: planning.planejamento_id || planning.id,
    planejamento_item_id: itemId,
    ordem: Number(item.ordem || 0),
    data_sugerida: dataSugerida,
    horario_sugerido: horarioSugerido,
    objetivo_postagem: objetivoPostagem,
    tema,
    tema_interno: tema,
    objetivo_interno: objetivoPostagem,
    objetivo_foto_cliente: objetivoFotoCliente,
    briefing_arte: briefingArte,
    estilo_visual_cliente: estiloVisual,
    nivel_edicao_cliente: orientacaoRoteada.nivel_edicao_cliente || 0,
    frase_foto: orientacaoRoteada.texto_obrigatorio_imagem,
    texto_proibido: forbiddenTexts,
    orientacao_cliente: orientacaoCliente,
    direcionamento_cliente: orientacaoCliente,
    orientacao_prioridade: orientacaoCliente ? "alta" : "",
    orientacao_flags: orientacaoFlags,
    orientacao_visual: orientacaoRoteada.orientacao_visual,
    texto_obrigatorio_imagem: orientacaoRoteada.texto_obrigatorio_imagem,
    orientacao_legenda: orientacaoRoteada.orientacao_legenda,
    caracteristicas_empresa: caracteristicasEmpresa,
    informacoes_empresa: informacoesEmpresa,
    preservar_pessoa: personRules.length > 0,
    regras_preservacao_pessoa: personRules,
    status: "pedido_criado",
    pedido_id: pedidoId
  };

  return {
    categoria: "arte_empresa",
    product_id: "arte_empresa",
    schema_version: 1,
    id: pedidoId,
    whatsapp: planning.whatsapp,
    mes: mesAtual,
    status: "novo",
    aprovado_cliente: false,
    baixado_cliente: false,
    ajuste_automatico_usado: false,
    motivo_ajuste: "",
    criado_em: now,
    origem: "planejamento_mensal",
    planejamento_mensal: planningMeta,
    planejamento_id: planningMeta.planejamento_id,
    planejamento_item_id: itemId,
    data_sugerida: dataSugerida,
    horario_sugerido: horarioSugerido,
    objetivo_postagem: objetivoPostagem,
    tema,
    tema_interno: tema,
    objetivo_interno: objetivoPostagem,
    briefing_arte: briefingArte,
    estilo_visual_cliente: estiloVisual,
    estilo_planejamento_mensal: estiloVisual,
    texto_proibido: forbiddenTexts,
    orientacao_cliente: orientacaoCliente,
    direcionamento_cliente: orientacaoCliente,
    orientacao_prioridade: orientacaoCliente ? "alta" : "",
    orientacao_flags: orientacaoFlags,
    orientacao_visual: orientacaoRoteada.orientacao_visual,
    texto_obrigatorio_imagem: orientacaoRoteada.texto_obrigatorio_imagem,
    orientacao_legenda: orientacaoRoteada.orientacao_legenda,
    preservar_pessoa: personRules.length > 0,
    regras_preservacao_pessoa: personRules,
    cobranca_origem: "planejamento_mensal_reserva",
    valor_cobrado: 0,
    pagamento_pendente: false,
    valor_pendente: 0,
    motivo_pagamento_pendente: "",
    ramo,
    nome_empresa: nomeEmpresa,
    objetivo: objetivoPedido,
    objetivo_foto_cliente: objetivoFotoCliente,
    oferta: publicOffer,
    cta: fields.cta,
    whatsapp_contato: whatsappContato,
    instagram,
    caracteristicas_empresa: caracteristicasEmpresa,
    informacoes_empresa: informacoesEmpresa,
    estilo_visual_cliente: estiloVisual,
    frase_foto: orientacaoRoteada.texto_obrigatorio_imagem,
    observacoes: fields.observacoes,
    historia_empresa: fields.historia_empresa,
    company_assets: {
      logo: copiedAssets.logo || "",
      fotos: copiedAssets.fotos || [],
      referencias: [],
      modelo_existente: ""
    },
    fields,
    assets: {
      logo: copiedAssets.logo || "",
      fotos: copiedAssets.fotos || [],
      referencias: [],
      modelo_existente: ""
    },
    legacy: {
      categoria: "arte_empresa",
      ramo,
      nome_empresa: nomeEmpresa,
      objetivo: objetivoPedido,
      oferta: publicOffer,
      cta: fields.cta,
      whatsapp_contato: whatsappContato,
      instagram,
      caracteristicas_empresa: caracteristicasEmpresa,
      informacoes_empresa: informacoesEmpresa,
      estilo_visual_cliente: estiloVisual,
      frase_foto: orientacaoRoteada.texto_obrigatorio_imagem,
      observacoes: fields.observacoes,
      historia_empresa: fields.historia_empresa,
      rodada: "",
      data: "",
      hora: "",
      arena: ""
    }
  };
}

function readCreatedOrdersFile(planning) {
  return readJson(path.join(planning.base_path, "pedidos_criados.json"), {
    planejamento_id: planning.planejamento_id || planning.id,
    pedidos: []
  }) || {
    planejamento_id: planning.planejamento_id || planning.id,
    pedidos: []
  };
}

function isPlanningOrder(pedido = {}) {
  if (!pedido || typeof pedido !== "object") return false;

  const origem = String(pedido.origem || "").trim().toLowerCase();
  if (origem === "planejamento_mensal") return true;

  const meta = pedido.planejamento_mensal;
  if (meta && typeof meta === "object") {
    const metaOrigem = String(meta.origem || "").trim().toLowerCase();
    if (metaOrigem === "planejamento_mensal") return true;
  }

  return Boolean(
    String(pedido.planejamento_id || "").trim()
    && String(pedido.planejamento_item_id || "").trim()
  );
}

function planningArtPayload({ base, pedido, pedidoId, whatsapp = "", mes = "", status = "" }) {
  const id = pedidoId || pedido?.id || path.basename(base || "");
  return {
    id,
    pedido_id: id,
    whatsapp: whatsapp || pedido?.whatsapp || "",
    mes: mes || pedido?.mes || "",
    status: status || pedido?.status || orderStorage.readStatus(base, "novo"),
    planejamento_id: pedido?.planejamento_id || pedido?.planejamento_mensal?.planejamento_id || "",
    planejamento_item_id: pedido?.planejamento_item_id || pedido?.planejamento_mensal?.planejamento_item_id || "",
    origem: "planejamento_mensal",
    zip_url: `/bot/empresa/planejamento-mensal/artes/${encodeURIComponent(id)}/zip`
  };
}

function findPlanningArtOrder({ pedidosDir, pedidoId }) {
  if (!pedidosDir || !pedidoId) return null;

  const base = orderStorage.getPedidoBaseGlobal(pedidosDir, pedidoId);
  if (!base) return null;

  const pedido = orderStorage.readOrder(base) || {};
  if (!isPlanningOrder(pedido)) return null;

  const status = orderStorage.readStatus(base, pedido.status || "novo");
  return {
    base,
    pedido,
    pedidoId: pedido.id || pedidoId,
    status,
    payload: planningArtPayload({ base, pedido, pedidoId: pedido.id || pedidoId, status })
  };
}

function listPlanningArtPending({ pedidosDir, limit = BOT_PENDING_HARD_LIMIT }) {
  const max = Math.max(1, Math.min(100, Number(limit || BOT_PENDING_HARD_LIMIT) || BOT_PENDING_HARD_LIMIT));
  const artes = [];

  if (!pedidosDir || !fs.existsSync(pedidosDir)) {
    return { ok: true, artes };
  }

  const whatsapps = fs.readdirSync(pedidosDir);
  for (const whatsapp of whatsapps) {
    if (artes.length >= max) break;
    const pastaWhatsapp = path.join(pedidosDir, whatsapp);
    if (!fs.existsSync(pastaWhatsapp) || !fs.statSync(pastaWhatsapp).isDirectory()) continue;

    const ciclos = fs.readdirSync(pastaWhatsapp);
    for (const mes of ciclos) {
      if (artes.length >= max) break;
      const pastaMes = path.join(pastaWhatsapp, mes);
      if (!fs.existsSync(pastaMes) || !fs.statSync(pastaMes).isDirectory()) continue;

      const ids = fs.readdirSync(pastaMes);
      for (const id of ids) {
        if (artes.length >= max) break;
        const base = path.join(pastaMes, id);
        if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) continue;

        const pedido = orderStorage.readOrder(base) || {};
        if (!isPlanningOrder(pedido)) continue;

        const status = orderStorage.readStatus(base, pedido.status || "");
        if (!["novo", "ajuste_pendente"].includes(status)) continue;
        if (fs.existsSync(path.join(base, "resultado_final.png"))) continue;

        artes.push(planningArtPayload({ base, pedido, pedidoId: id, whatsapp, mes, status }));
      }
    }
  }

  return { ok: true, artes };
}

function updatePlanningArtStatus({ pedidosDir, pedidoId, status, message = "" }) {
  const normalizedStatus = String(status || "").trim().toLowerCase();
  if (!PLANNING_ART_STATUSES.has(normalizedStatus)) {
    const error = new Error("Status invalido para arte do Planejamento Mensal.");
    error.statusCode = 400;
    error.code = "monthly_planning_art_invalid_status";
    throw error;
  }

  const found = findPlanningArtOrder({ pedidosDir, pedidoId });
  if (!found) {
    const error = new Error("Arte do Planejamento Mensal nao encontrada.");
    error.statusCode = 404;
    error.code = "monthly_planning_art_not_found";
    throw error;
  }

  const now = new Date().toISOString();
  const pedido = {
    ...found.pedido,
    status: normalizedStatus,
    atualizado_em: now
  };

  if (normalizedStatus === "erro") {
    pedido.erro = String(message || pedido.erro || "Falha no processamento da arte do Planejamento Mensal.");
    pedido.motivo_erro = pedido.erro;
    fs.writeFileSync(path.join(found.base, "erro.txt"), `${pedido.erro}\n`, "utf8");
  }

  orderStorage.writeOrder(found.base, pedido);
  orderStorage.writeStatus(found.base, normalizedStatus);

  return planningArtPayload({
    base: found.base,
    pedido,
    pedidoId: found.pedidoId,
    status: normalizedStatus
  });
}

function savePlanningArtResult({
  pedidosDir,
  pedidoId,
  resultadoPath,
  previewPath = "",
  descricaoInstagram = "",
  apiInfo = null
}) {
  const found = findPlanningArtOrder({ pedidosDir, pedidoId });
  if (!found) {
    const error = new Error("Arte do Planejamento Mensal nao encontrada.");
    error.statusCode = 404;
    error.code = "monthly_planning_art_not_found";
    throw error;
  }

  if (!resultadoPath || !fs.existsSync(resultadoPath)) {
    const error = new Error("Arquivo resultado_final.png nao recebido.");
    error.statusCode = 400;
    error.code = "monthly_planning_art_missing_result";
    throw error;
  }

  const finalPath = path.join(found.base, "resultado_final.png");
  const previewDest = path.join(found.base, "preview_ia4tube.jpg");
  if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath);
  fs.renameSync(resultadoPath, finalPath);

  if (previewPath && fs.existsSync(previewPath)) {
    if (fs.existsSync(previewDest)) fs.unlinkSync(previewDest);
    fs.renameSync(previewPath, previewDest);
  }

  const now = new Date().toISOString();
  const pedido = {
    ...found.pedido,
    status: "pronto",
    descricao_instagram: String(descricaoInstagram || found.pedido.descricao_instagram || "").trim(),
    resultado_enviado_em: now,
    atualizado_em: now
  };

  if (pedido.legacy && typeof pedido.legacy === "object") {
    pedido.legacy.descricao_instagram = pedido.descricao_instagram;
  }

  if (apiInfo && typeof apiInfo === "object") {
    writeJson(path.join(found.base, "resultado_api_info.json"), apiInfo);
  }

  orderStorage.writeOrder(found.base, pedido);
  orderStorage.writeStatus(found.base, "pronto");
  fs.writeFileSync(path.join(found.base, "processado_handoff.txt"), "OK", "utf8");

  return planningArtPayload({
    base: found.base,
    pedido,
    pedidoId: found.pedidoId,
    status: "pronto"
  });
}

function syncPlanningReservationAfterChildren(cliente, planning, childCount) {
  if (!cliente) return null;

  const planningId = planning.planejamento_id || planning.id;
  const ciclo = planning.ciclo || planCycle(cliente);
  const reservas = ensurePlanningReservationState(cliente, ciclo);
  const reserva = reservas[planningId];
  if (!reserva) return refreshPlanningReservationCounters(cliente);

  const quantidade = Number(reserva.quantidade_reservada || planning.quantidade_reservada || 0);
  const vinculadas = Math.max(Number(reserva.artes_produzidas || 0), Number(childCount || 0));
  reserva.artes_produzidas = Math.min(quantidade, vinculadas);
  reserva.artes_bloqueadas_ativas = Math.max(0, quantidade - reserva.artes_produzidas);
  reserva.atualizado_em = new Date().toISOString();

  return refreshPlanningReservationCounters(cliente);
}

function createChildOrdersFromPlan({ pedidosDir, planning, plan, cliente = null }) {
  if (!pedidosDir) {
    return readCreatedOrdersFile(planning);
  }

  const postagens = Array.isArray(plan.postagens)
    ? plan.postagens
    : Array.isArray(plan.itens)
      ? plan.itens
      : [];

  const pedidosCriados = readCreatedOrdersFile(planning);
  const existingByItem = new Map();
  for (const pedido of pedidosCriados.pedidos || []) {
    if (pedido?.planejamento_item_id && pedido?.pedido_id) {
      existingByItem.set(pedido.planejamento_item_id, pedido);
    }
  }

  const now = new Date().toISOString();
  const mesAtual = planning.ciclo || currentMonthCycle();
  const updatedPostagens = postagens.map((item, index) => {
    const itemId = cleanText(item.planejamento_item_id || item.id, `${planning.planejamento_id || planning.id}_item_${String(index + 1).padStart(3, "0")}`);
    const existing = item.pedido_id
      ? { planejamento_item_id: itemId, pedido_id: item.pedido_id }
      : existingByItem.get(itemId);

    if (existing?.pedido_id) {
      const itemWithOrder = {
        ...item,
        planejamento_item_id: itemId,
        pedido_id: existing.pedido_id
      };
      return {
        ...itemWithOrder,
        ...notificationFieldsForPost(itemWithOrder, planning),
        status: item.status === "pronta" ? item.status : "pedido_criado"
      };
    }

    const pedidoId = newChildPedidoId(planning.planejamento_id || planning.id, index + 1, pedidosDir);
    const orderBase = path.join(pedidosDir, safeSegment(planning.whatsapp, "sem_whatsapp"), safeSegment(mesAtual, "ciclo"), pedidoId);
    ensureDir(orderBase);
    const itemForOrder = { ...item, ordem: item.ordem || index + 1 };
    const copiedAssets = copyPlanningAssetsToOrder(planning, orderBase, itemForOrder);
    const childOrder = buildChildOrder({
      planning,
      item: itemForOrder,
      itemId,
      pedidoId,
      mesAtual,
      copiedAssets
    });

    orderStorage.writeOrder(orderBase, childOrder);
    orderStorage.writeStatus(orderBase, "novo");

    const record = {
      pedido_id: pedidoId,
      planejamento_item_id: itemId,
      ordem: Number(item.ordem || index + 1),
      tema: childOrder.tema,
      objetivo_postagem: childOrder.objetivo_postagem,
      data_sugerida: childOrder.data_sugerida,
      horario_sugerido: childOrder.horario_sugerido,
      status: "novo",
      criado_em: now,
      pedido_path: path.relative(pedidosDir, orderBase).replace(/\\/g, "/")
    };
    pedidosCriados.pedidos = Array.isArray(pedidosCriados.pedidos) ? pedidosCriados.pedidos : [];
    pedidosCriados.pedidos.push(record);

    return {
      ...item,
      planejamento_item_id: itemId,
      pedido_id: pedidoId,
      ...notificationFieldsForPost({ ...item, planejamento_item_id: itemId, pedido_id: pedidoId }, planning),
      status: "pedido_criado"
    };
  });

  const uniquePedidos = [];
  const seenPedidoIds = new Set();
  for (const pedido of pedidosCriados.pedidos || []) {
    if (!pedido?.pedido_id || seenPedidoIds.has(pedido.pedido_id)) continue;
    uniquePedidos.push(pedido);
    seenPedidoIds.add(pedido.pedido_id);
  }

  const childCount = uniquePedidos.length;
  pedidosCriados.planejamento_id = planning.planejamento_id || planning.id;
  pedidosCriados.tipo = "planejamento_mensal_pedidos_filhos";
  pedidosCriados.total = childCount;
  pedidosCriados.atualizado_em = now;
  pedidosCriados.pedidos = uniquePedidos;
  writeJson(path.join(planning.base_path, "pedidos_criados.json"), pedidosCriados);

  plan.postagens = updatedPostagens;
  plan.itens = Array.isArray(plan.itens) ? updatedPostagens : updatedPostagens;
  plan.pedidos_filhos_criados = childCount;
  plan.atualizado_em = now;

  const solicitacao = readJson(planning.solicitacao_path) || planning;
  const quantidade = Number(solicitacao.quantidade_reservada || postagens.length || childCount);
  solicitacao.ja_produzidas = childCount;
  solicitacao.pedidos_filhos_criados = childCount;
  solicitacao.ainda_nao_produzidas = Math.max(0, quantidade - childCount);
  solicitacao.reserva = {
    ...(solicitacao.reserva || {}),
    artes_produzidas: childCount,
    artes_bloqueadas_ativas: Math.max(0, quantidade - childCount),
    criterio_producao_fase_6: "Nesta fase, arte produzida significa pedido filho criado e vinculado ao Planejamento Mensal."
  };
  writeJson(planning.solicitacao_path, solicitacao);

  const usage = syncPlanningReservationAfterChildren(cliente, planning, childCount);
  if (usage) {
    solicitacao.total_reservadas_no_ciclo = usage.reservadas_no_planejamento;
    solicitacao.livres_para_criar_arte = usage.livres_para_criar_arte;
    writeJson(planning.solicitacao_path, solicitacao);
  }

  appendLog(planning.base_path, `Pedidos filhos criados/vinculados: ${childCount}.`);
  return pedidosCriados;
}

function savePlanResult({ baseDir, planningId, payload = {}, pedidosDir = "", cliente = null }) {
  const planning = findPlanningByIdAny({ baseDir, planningId });
  if (!planning) {
    const error = new Error("Planejamento Mensal nao encontrado.");
    error.statusCode = 404;
    error.code = "monthly_planning_not_found";
    throw error;
  }

  if (planning.status === "cancelado") {
    const error = new Error("Planejamento Mensal cancelado nao pode receber plano.");
    error.statusCode = 409;
    error.code = "monthly_planning_cancelled";
    throw error;
  }

  const plan = normalizePlanResultPayload(payload);
  const postagens = Array.isArray(plan.postagens)
    ? plan.postagens
    : Array.isArray(plan.itens)
      ? plan.itens
      : [];

  if (!postagens.length) {
    const error = new Error("plano_mensal precisa conter postagens planejadas.");
    error.statusCode = 400;
    error.code = "monthly_planning_empty_plan";
    throw error;
  }

  const reservedQuantity = Number(planning.quantidade_reservada || planning.reservadas_no_planejamento || postagens.length);
  const maxAllowedPosts = Math.min(
    MAX_MONTHLY_PLANNING_ARTS,
    Math.max(1, Number.isFinite(reservedQuantity) ? reservedQuantity : MAX_MONTHLY_PLANNING_ARTS)
  );

  if (postagens.length > maxAllowedPosts) {
    const error = new Error(`plano_mensal excede o limite reservado de ${maxAllowedPosts} postagem(ns).`);
    error.statusCode = 400;
    error.code = "monthly_planning_plan_too_large";
    error.max_postagens = maxAllowedPosts;
    error.postagens_recebidas = postagens.length;
    throw error;
  }

  const now = new Date().toISOString();
  const finalPlan = {
    ...plan,
    planejamento_id: plan.planejamento_id || planning.planejamento_id || planning.id,
    quantidade: Number(plan.quantidade || postagens.length),
    postagens,
    itens: Array.isArray(plan.itens) ? plan.itens : postagens,
    gerado_em: plan.gerado_em || now
  };

  const pedidosCriados = createChildOrdersFromPlan({
    pedidosDir,
    planning,
    plan: finalPlan,
    cliente
  });

  const solicitacao = readJson(planning.solicitacao_path) || planning;
  solicitacao.status = "pronto";
  solicitacao.atualizado_em = now;
  solicitacao.plano_mensal_pronto_em = now;
  solicitacao.ja_produzidas = Number(pedidosCriados.total || 0);
  solicitacao.pedidos_filhos_criados = Number(pedidosCriados.total || 0);
  solicitacao.ainda_nao_produzidas = Math.max(0, Number(solicitacao.quantidade_reservada || postagens.length) - Number(pedidosCriados.total || 0));
  solicitacao.runner_contract = {
    ...(solicitacao.runner_contract || {}),
    plano_mensal_recebido: true,
    pedidos_filhos_criados: Number(pedidosCriados.total || 0),
    observacao_fase_6: "Plano mensal recebido e itens vinculados a pedidos filhos normais. Backend nao gerou imagens."
  };

  writeJson(path.join(planning.base_path, "plano_mensal.json"), finalPlan);
  writeJson(planning.solicitacao_path, solicitacao);
  writeStatus(planning.base_path, "pronto");
  appendLog(planning.base_path, `Plano Mensal recebido pelo backend com ${postagens.length} postagem(ns).`);

  return parsePlanning(planning.base_path);
}

function publicDetailPayload({ baseDir, whatsapp, planningId, pedidosDir = "" }) {
  const planning = findPlanningById({ baseDir, whatsapp, planningId });
  if (!planning) {
    const error = new Error("Planejamento Mensal nao encontrado.");
    error.statusCode = 404;
    error.code = "monthly_planning_not_found";
    throw error;
  }

  const postagens = planningPosts(planning, pedidosDir);
  const planoMensal = planning.plano_mensal || { planejamento_id: planningId, itens: [] };
  const pedidosCriados = {
    ...(planning.pedidos_criados || { planejamento_id: planningId, pedidos: [] }),
    planejamento_id: planning.planejamento_id || planning.id || planningId,
    tipo: "planejamento_mensal_pedidos_filhos",
    pedidos: createdOrderRecords(planning, pedidosDir)
  };
  pedidosCriados.total = pedidosCriados.pedidos.length;
  const planoMensalComStatus = {
    ...planoMensal,
    postagens,
    itens: postagens
  };

  return {
    ok: true,
    planejamento: {
      ...summarizePlanning(planning, pedidosDir),
      profile: planning.profile || {},
      assets: planning.assets || { fotos: [] },
      reserva: planning.reserva || null,
      cancelamento: planning.cancelamento || null,
      plano_mensal: planoMensalComStatus,
      pedidos_criados: pedidosCriados
    }
  };
}

function cancelPendingNotificationsForPlanning(planning, cancelledAt = new Date().toISOString()) {
  const planoPath = path.join(planning.base_path, "plano_mensal.json");
  const plano = readJson(planoPath, null);
  if (!plano || typeof plano !== "object") return 0;

  const sourcePosts = Array.isArray(plano.postagens)
    ? plano.postagens
    : Array.isArray(plano.itens)
      ? plano.itens
      : [];

  let cancelled = 0;
  const posts = sourcePosts.map((post) => {
    const fields = notificationFieldsForPost(post, planning);
    if (fields.notificacao_status !== "pendente") {
      return {
        ...post,
        ...fields
      };
    }

    cancelled += 1;
    return {
      ...post,
      ...fields,
      notificacao_status: "cancelada",
      notificacao_cancelada_em: cancelledAt
    };
  });

  plano.postagens = posts;
  plano.itens = posts;
  plano.notificacoes_canceladas_em = cancelled > 0 ? cancelledAt : plano.notificacoes_canceladas_em || "";
  writeJson(planoPath, plano);
  return cancelled;
}

function cancelPlanning({ baseDir, whatsapp, planningId, cliente }) {
  const planning = findPlanningById({ baseDir, whatsapp, planningId });
  if (!planning) {
    const error = new Error("Planejamento Mensal nao encontrado.");
    error.statusCode = 404;
    error.code = "monthly_planning_not_found";
    throw error;
  }

  if (planning.status === "cancelado") {
    return {
      ...planning,
      cancelamento: {
        ...(planning.cancelamento || {}),
        ja_estava_cancelado: true,
        billing_alterado: false,
        artes_devolvidas_total: Number(planning.cancelamento?.artes_devolvidas || 0),
        artes_devolvidas: 0,
        livres_para_criar_arte: Number(cliente?.artes_mensais_restantes || planning.livres_para_criar_arte || 0)
      }
    };
  }

  const release = cliente
    ? releasePlanningReservation(cliente, planning)
    : {
        billing_alterado: false,
        artes_devolvidas: 0,
        livres_para_criar_arte: Number(planning.livres_para_criar_arte || 0)
      };

  const solicitacao = readJson(planning.solicitacao_path) || planning;
  const now = new Date().toISOString();
  solicitacao.status = "cancelado";
  solicitacao.atualizado_em = now;
  solicitacao.cancelado_em = now;
  solicitacao.livres_para_criar_arte = release.livres_para_criar_arte;
  solicitacao.reservadas_no_planejamento = 0;
  solicitacao.reserva = {
    ...(solicitacao.reserva || {}),
    validada: true,
    definitiva: true,
    status: "cancelada",
    artes_devolvidas: Number((solicitacao.reserva || {}).artes_devolvidas || 0) + release.artes_devolvidas,
    artes_bloqueadas_ativas: 0,
    cancelada_em: now
  };
  solicitacao.cancelamento = {
    solicitado_pelo_cliente: true,
    billing_alterado: release.billing_alterado,
    artes_devolvidas: release.artes_devolvidas,
    livres_para_criar_arte: release.livres_para_criar_arte,
    observacao: "Artes reservadas e nao produzidas foram devolvidas para Criar Arte."
  };

  writeJson(planning.solicitacao_path, solicitacao);
  const notificationsCancelled = cancelPendingNotificationsForPlanning(planning, now);
  if (notificationsCancelled > 0) {
    appendLog(planning.base_path, `Notificacoes pendentes canceladas: ${notificationsCancelled}.`);
  }
  writeStatus(planning.base_path, "cancelado");
  appendLog(planning.base_path, "Planejamento Mensal cancelado pelo cliente.");

  return parsePlanning(planning.base_path);
}

async function processDueNotifications({
  baseDir,
  pedidosDir,
  clientes = {},
  now = new Date(),
  sendNotification,
  limit = 100
}) {
  const max = Math.max(1, Math.min(Number(limit) || 100, 500));
  const nowTime = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const result = {
    ok: true,
    checked: 0,
    sent: 0,
    errors: 0,
    skipped: 0,
    mock: 0
  };

  if (typeof sendNotification !== "function") {
    return {
      ...result,
      ok: false,
      error: "sendNotification callback obrigatorio"
    };
  }

  for (const dirPath of listAllPlanningDirs(baseDir)) {
    if (result.checked >= max) break;

    const planning = parsePlanning(dirPath);
    if (!planning) continue;

    if (planning.status === "cancelado") {
      const cancelled = cancelPendingNotificationsForPlanning(planning);
      result.skipped += cancelled;
      continue;
    }

    const planoPath = path.join(planning.base_path, "plano_mensal.json");
    const plano = readJson(planoPath, null);
    if (!plano || typeof plano !== "object") continue;

    const sourcePosts = Array.isArray(plano.postagens)
      ? plano.postagens
      : Array.isArray(plano.itens)
        ? plano.itens
        : [];

    if (!sourcePosts.length) continue;

    let changed = false;
    const posts = [];

    for (const post of sourcePosts) {
      const postWithNotification = {
        ...post,
        ...notificationFieldsForPost(post, planning)
      };
      posts.push(postWithNotification);

      const notificationStatus = normalizeNotificationStatus(postWithNotification.notificacao_status);
      if (notificationStatus === "enviada" || notificationStatus === "cancelada" || notificationStatus === "erro") {
        if (JSON.stringify(postWithNotification) !== JSON.stringify(post)) changed = true;
        continue;
      }

      if (!postWithNotification.notificar_em) {
        postWithNotification.notificacao_status = "erro";
        postWithNotification.notificacao_erro = "data_ou_horario_invalido";
        result.errors += 1;
        changed = true;
        continue;
      }

      const notifyAt = new Date(postWithNotification.notificar_em).getTime();
      if (!Number.isFinite(notifyAt) || Number.isNaN(notifyAt)) {
        postWithNotification.notificacao_status = "erro";
        postWithNotification.notificacao_erro = "notificar_em_invalido";
        result.errors += 1;
        changed = true;
        continue;
      }

      if (notifyAt > nowTime) {
        if (JSON.stringify(postWithNotification) !== JSON.stringify(post)) changed = true;
        continue;
      }

      if (!postWithNotification.pedido_id) {
        result.skipped += 1;
        if (JSON.stringify(postWithNotification) !== JSON.stringify(post)) changed = true;
        continue;
      }

      const childStatus = childOrderStatus({
        pedidosDir,
        pedidoId: postWithNotification.pedido_id
      });

      if (!childStatus.imagem_pronta) {
        result.skipped += 1;
        if (JSON.stringify(postWithNotification) !== JSON.stringify(post)) changed = true;
        continue;
      }

      result.checked += 1;
      postWithNotification.notificacao_tentativas = Number(postWithNotification.notificacao_tentativas || 0) + 1;

      try {
        const cliente = clientes[planning.whatsapp] || {};
        const sendResult = await sendNotification({
          cliente,
          planning,
          post: postWithNotification,
          childStatus
        });

        if (!sendResult?.ok) {
          postWithNotification.notificacao_status = "erro";
          postWithNotification.notificacao_erro = sendResult?.error || sendResult?.code || "falha_envio_fcm";
          postWithNotification.notificacao_resultado = sendResult || {};
          result.errors += 1;
        } else {
          postWithNotification.notificacao_status = "enviada";
          postWithNotification.notificacao_enviada_em = new Date(nowTime).toISOString();
          postWithNotification.notificacao_erro = "";
          postWithNotification.notificacao_resultado = sendResult || {};
          result.sent += 1;
          if (sendResult.mock) result.mock += 1;
        }
      } catch (error) {
        postWithNotification.notificacao_status = "erro";
        postWithNotification.notificacao_erro = error?.message || "falha_envio_fcm";
        result.errors += 1;
      }

      changed = true;
    }

    if (changed) {
      plano.postagens = posts;
      plano.itens = posts;
      plano.notificacoes_atualizadas_em = new Date(nowTime).toISOString();
      writeJson(planoPath, plano);
      appendLog(planning.base_path, `Agendador de notificacoes: enviadas=${result.sent}, erros=${result.errors}, ignoradas=${result.skipped}.`);
    }
  }

  return result;
}

module.exports = {
  createRequest,
  listClientPlannings,
  listClientPlanningCalendar,
  hideClientPlanningCalendarItem,
  listClientPlanningGroups,
  publicDetailPayload,
  cancelPlanning,
  findPlanningById,
  listBotPending,
  updatePlanningStatus,
  savePlanResult,
  isPlanningOrder,
  findPlanningArtOrder,
  listPlanningArtPending,
  updatePlanningArtStatus,
  savePlanningArtResult,
  findPlanningByIdAny,
  processDueNotifications
};
