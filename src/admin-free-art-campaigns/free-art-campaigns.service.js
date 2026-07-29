const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const storage = require("./free-art-campaigns.storage");
const orderStorage = require("../orders/order.storage");

const ORIGIN = "arte_gratis_semanal";
const SAO_PAULO_TZ = "America/Sao_Paulo";
const DEFAULT_TIME = "18:00";
const VALID_ART_STATUSES = new Set(["pendente", "gerando", "pronta", "aprovada", "excluida", "erro"]);

function nowIso() {
  return new Date().toISOString();
}

function stableHash(value, length = 16) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, length);
}

function normalizeText(value = "") {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function normalizeRamo(value = "") {
  return normalizeText(value);
}

function sanitizeIdPart(value = "") {
  return normalizeText(value)
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40) || "campanha";
}

function isFreeArtOrder(pedido = {}) {
  const origem = String(pedido?.origem || "").trim();
  const campaignId = String(pedido?.campaign_id || pedido?.campaignId || "").trim();
  return origem === ORIGIN || campaignId.startsWith("free_");
}

function campaignNotFoundError() {
  const error = new Error("Campanha nao encontrada.");
  error.statusCode = 404;
  error.code = "campaign_not_found";
  return error;
}

function campaignLockedError() {
  const error = new Error("Campanha ja distribuida nao pode ser editada.");
  error.statusCode = 400;
  error.code = "campaign_already_distributed";
  return error;
}

function readCampaignOrThrow(baseDir, campaignId) {
  const campaign = storage.readCampaign(baseDir, campaignId);
  if (!campaign) throw campaignNotFoundError();
  return campaign;
}

function ensureCampaignEditable(campaign) {
  if (campaign?.status === "distribuida") throw campaignLockedError();
}

function parseDateFromOrderId(orderId = "") {
  const match = String(orderId || "").match(/^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/);
  if (!match) return "";
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}-03:00`;
}

function readOrderJson(filePath) {
  return storage.readJson(filePath, null);
}

function isValidOrderForRamo(pedido = {}) {
  if (!pedido || typeof pedido !== "object") return false;
  if (isFreeArtOrder(pedido)) return false;
  if (pedido.pagamento_pendente === true) return false;
  if (pedido.status === "erro") return false;
  return true;
}

function orderCreatedAt(orderPath, pedido = {}, orderId = "") {
  const candidates = [
    pedido.resultado_enviado_em,
    pedido.criado_em,
    pedido.created_at,
    pedido.data,
    parseDateFromOrderId(orderId)
  ].filter(Boolean);

  for (const candidate of candidates) {
    const time = new Date(candidate).getTime();
    if (Number.isFinite(time)) return time;
  }

  try {
    return fs.statSync(orderPath).mtimeMs;
  } catch {
    return 0;
  }
}

function orderRamoCandidate(orderPath, orderId, pedido = {}) {
  const ramo = String(pedido.ramo || pedido.niche_name || pedido.nicho || "").trim();
  if (!ramo || !isValidOrderForRamo(pedido)) return null;

  const origem = String(pedido.origem || "").trim();
  const isPlanning = origem === "planejamento_mensal" ||
    Boolean(pedido.planejamento_id || pedido.planejamento_mensal?.planejamento_id);
  const isCompany = pedido.categoria === "arte_empresa" || pedido.product_id === "arte_empresa";
  if (!isPlanning && !isCompany) return null;

  return {
    ramo,
    ramo_normalizado: normalizeRamo(ramo),
    source: isPlanning ? "planejamento_mensal" : "arte_empresa",
    priority: isPlanning ? 2 : 1,
    created_at_ms: orderCreatedAt(orderPath, pedido, orderId),
    pedido_id: orderId
  };
}

function listOrderCandidatesForClient(pedidosDir, whatsapp) {
  return orderStorage.listPedidoBasesByWhatsapp(pedidosDir, whatsapp)
    .map(({ base, id, pedido }) => orderRamoCandidate(base, id, pedido || {}))
    .filter(Boolean);
}

function selectLatestRamoCandidate(candidates = []) {
  const sorted = [...candidates].sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return b.created_at_ms - a.created_at_ms;
  });
  return sorted[0] || null;
}

function scanClientBranches({ pedidosDir, clientes = {} }) {
  const branchMap = new Map();
  const clients = [];
  let withoutBranch = 0;

  for (const whatsapp of Object.keys(clientes || {}).sort()) {
    const cliente = clientes[whatsapp] || {};
    if (cliente.ativo === false) continue;

    const candidate = selectLatestRamoCandidate(listOrderCandidatesForClient(pedidosDir, whatsapp));
    if (!candidate) {
      withoutBranch += 1;
      continue;
    }

    const current = branchMap.get(candidate.ramo_normalizado) || {
      ramo: candidate.ramo,
      ramo_normalizado: candidate.ramo_normalizado,
      clientes: 0
    };
    current.clientes += 1;
    branchMap.set(candidate.ramo_normalizado, current);
    clients.push({
      whatsapp,
      nome_time: cliente.nome_time || "",
      ramo: candidate.ramo,
      ramo_normalizado: candidate.ramo_normalizado,
      ramo_source: candidate.source,
      ramo_pedido_id: candidate.pedido_id
    });
  }

  const ramos = [...branchMap.values()].sort((a, b) => {
    if (b.clientes !== a.clientes) return b.clientes - a.clientes;
    return a.ramo.localeCompare(b.ramo);
  });

  return {
    ok: true,
    total_clientes_com_ramo: clients.length,
    clientes_sem_ramo_identificado: withoutBranch,
    ramos,
    clients
  };
}

function validateQuantity(quantity, maxArts) {
  const parsed = Number(quantity);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maxArts) {
    const error = new Error(`Quantidade deve ser entre 1 e ${maxArts}.`);
    error.statusCode = 400;
    error.code = "invalid_quantity";
    throw error;
  }
  return parsed;
}

function normalizeDateText(value = "") {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return "";
  const date = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return "";
  return text;
}

function normalizeTimeText(value = "") {
  const text = String(value || DEFAULT_TIME).trim();
  const match = text.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  return match ? `${match[1]}:${match[2]}` : DEFAULT_TIME;
}

function notificationIso(dateText, timeText) {
  const date = normalizeDateText(dateText);
  const time = normalizeTimeText(timeText);
  if (!date) return "";
  return `${date}T${time}:00-03:00`;
}

function createCampaign({ baseDir, pedidosDir, clientes, body = {}, adminId = "", maxArts = 20 }) {
  const scan = scanClientBranches({ pedidosDir, clientes });
  const ramoNormalizado = normalizeRamo(body.ramo_normalizado || body.ramo || "");
  const ramoInfo = scan.ramos.find((item) => item.ramo_normalizado === ramoNormalizado);

  if (!ramoInfo) {
    const error = new Error("Ramo sem clientes elegiveis.");
    error.statusCode = 400;
    error.code = "branch_without_clients";
    throw error;
  }

  const quantidade = validateQuantity(body.quantidade || body.quantidade_artes || body.arts || 1, maxArts);
  const dataPostagem = normalizeDateText(body.data_postagem || body.data || body.date || "");
  const horario = normalizeTimeText(body.horario || body.time || DEFAULT_TIME);
  if (!dataPostagem) {
    const error = new Error("Data da postagem obrigatoria.");
    error.statusCode = 400;
    error.code = "invalid_campaign_date";
    throw error;
  }
  const promptLivre = String(body.prompt || body.prompt_livre || "").trim();
  const opcaoRapida = String(body.opcao_rapida || body.quick_option || "").trim();
  const now = nowIso();
  const campaignId = [
    "free",
    new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14),
    sanitizeIdPart(ramoInfo.ramo),
    stableHash(`${ramoInfo.ramo_normalizado}:${now}`, 6)
  ].join("_");

  const eligibleClients = scan.clients
    .filter((client) => client.ramo_normalizado === ramoInfo.ramo_normalizado)
    .sort((a, b) => a.whatsapp.localeCompare(b.whatsapp));

  const campaign = {
    id: campaignId,
    tipo: ORIGIN,
    origem: ORIGIN,
    status: "gerando",
    ramo: ramoInfo.ramo,
    ramo_normalizado: ramoInfo.ramo_normalizado,
    quantidade_artes: quantidade,
    prompt_livre: promptLivre,
    opcao_rapida: opcaoRapida || "faca_o_que_quiser",
    data_postagem: dataPostagem,
    horario,
    timezone: SAO_PAULO_TZ,
    notificacao_titulo: String(body.notificacao_titulo || body.notification_title || "Arte Gratis da Semana").trim(),
    notificacao_mensagem: String(body.notificacao_mensagem || body.notification_body || "Sua arte gratis da semana esta pronta. Toque para ver.").trim(),
    clientes_elegiveis_total: eligibleClients.length,
    clientes_sem_ramo_identificado: scan.clientes_sem_ramo_identificado,
    eligible_clients_snapshot: eligibleClients,
    created_by: adminId,
    created_at: now,
    updated_at: now,
    approved_count: 0,
    distributed_count: 0,
    distributed_at: "",
    distributed_by: ""
  };

  storage.ensureDir(baseDir);
  storage.writeCampaign(baseDir, campaign);
  storage.writeDistribution(baseDir, campaignId, { assignments: [] });

  for (let index = 1; index <= quantidade; index += 1) {
    const artId = `art_${String(index).padStart(2, "0")}`;
    storage.writeArt(baseDir, campaignId, {
      id: artId,
      campaign_id: campaignId,
      index,
      status: "pendente",
      ramo: ramoInfo.ramo,
      ramo_normalizado: ramoInfo.ramo_normalizado,
      prompt_livre: promptLivre,
      opcao_rapida: campaign.opcao_rapida,
      arquivo_original: "",
      arquivo_preview: "",
      descricao_instagram: "",
      created_at: now,
      updated_at: now,
      approved_at: "",
      approved_by: "",
      erro: ""
    });
  }

  storage.appendAudit(baseDir, campaignId, {
    action: "created",
    by: adminId,
    quantidade_artes: quantidade,
    clientes_elegiveis_total: eligibleClients.length
  });

  return detailCampaign({ baseDir, campaignId });
}

function updateCampaignSettings({ baseDir, campaignId, body = {}, adminId = "" }) {
  const campaign = readCampaignOrThrow(baseDir, campaignId);
  ensureCampaignEditable(campaign);

  const dataPostagem = normalizeDateText(body.data_postagem || body.data || body.date || campaign.data_postagem || "");
  if (!dataPostagem) {
    const error = new Error("Data da postagem obrigatoria.");
    error.statusCode = 400;
    error.code = "invalid_campaign_date";
    throw error;
  }

  campaign.data_postagem = dataPostagem;
  campaign.horario = normalizeTimeText(body.horario || body.time || campaign.horario || DEFAULT_TIME);
  campaign.notificacao_titulo = String(body.notificacao_titulo || body.notification_title || campaign.notificacao_titulo || "Arte Gratis da Semana").trim();
  campaign.notificacao_mensagem = String(body.notificacao_mensagem || body.notification_body || campaign.notificacao_mensagem || "Sua arte gratis da semana esta pronta. Toque para ver.").trim();
  campaign.updated_at = nowIso();
  campaign.updated_by = adminId;

  storage.writeCampaign(baseDir, campaign);
  storage.appendAudit(baseDir, campaignId, {
    action: "settings_updated",
    by: adminId,
    data_postagem: campaign.data_postagem,
    horario: campaign.horario
  });

  return detailCampaign({ baseDir, campaignId });
}

function duplicateCampaign({ baseDir, pedidosDir, clientes, campaignId, adminId = "", maxArts = 20 }) {
  const campaign = readCampaignOrThrow(baseDir, campaignId);
  const created = createCampaign({
    baseDir,
    pedidosDir,
    clientes,
    body: {
      ramo_normalizado: campaign.ramo_normalizado,
      ramo: campaign.ramo,
      quantidade: campaign.quantidade_artes,
      prompt_livre: campaign.prompt_livre,
      opcao_rapida: campaign.opcao_rapida,
      data_postagem: campaign.data_postagem,
      horario: campaign.horario,
      notificacao_titulo: campaign.notificacao_titulo,
      notificacao_mensagem: campaign.notificacao_mensagem
    },
    adminId,
    maxArts
  });

  storage.appendAudit(baseDir, created.campaign.id, {
    action: "duplicated_from",
    source_campaign_id: campaignId,
    by: adminId
  });

  return {
    ...created,
    duplicated_from: campaignId
  };
}

function summarizeCampaign(campaign, arts = []) {
  return {
    ...campaign,
    artes: undefined,
    artes_total: arts.length,
    artes_pendentes: arts.filter((art) => art.status === "pendente").length,
    artes_gerando: arts.filter((art) => art.status === "gerando").length,
    artes_prontas: arts.filter((art) => art.status === "pronta" || art.status === "aprovada").length,
    artes_aprovadas: arts.filter((art) => art.status === "aprovada").length,
    artes_excluidas: arts.filter((art) => art.status === "excluida").length,
    artes_com_erro: arts.filter((art) => art.status === "erro").length
  };
}

function listCampaigns({ baseDir }) {
  return {
    ok: true,
    campaigns: storage.listCampaigns(baseDir).map((campaign) => {
      const arts = storage.listArts(baseDir, campaign.id);
      return summarizeCampaign(campaign, arts);
    })
  };
}

function detailCampaign({ baseDir, campaignId }) {
  const campaign = storage.readCampaign(baseDir, campaignId);
  if (!campaign) {
    const error = new Error("Campanha nao encontrada.");
    error.statusCode = 404;
    error.code = "campaign_not_found";
    throw error;
  }

  const arts = storage.listArts(baseDir, campaignId);
  const distribution = storage.readDistribution(baseDir, campaignId);
  return {
    ok: true,
    campaign: summarizeCampaign(campaign, arts),
    artes: arts,
    distribuicao: distribution.assignments || []
  };
}

function updateCampaignStatusFromArts(baseDir, campaignId) {
  const campaign = storage.readCampaign(baseDir, campaignId);
  if (!campaign) return null;
  const arts = storage.listArts(baseDir, campaignId);
  const active = arts.filter((art) => art.status !== "excluida");
  const done = active.length > 0 && active.every((art) => ["pronta", "aprovada", "erro"].includes(art.status));
  campaign.approved_count = arts.filter((art) => art.status === "aprovada").length;
  if (campaign.status === "gerando" && done) campaign.status = "revisao";
  campaign.updated_at = nowIso();
  storage.writeCampaign(baseDir, campaign);
  return campaign;
}

function listPendingArts({ baseDir, limit = 10 }) {
  const pending = [];
  for (const campaign of storage.listCampaigns(baseDir)) {
    if (!["gerando", "revisao"].includes(campaign.status)) continue;
    for (const art of storage.listArts(baseDir, campaign.id)) {
      if (art.status !== "pendente") continue;
      pending.push({
        campaign_id: campaign.id,
        art_id: art.id,
        ramo: campaign.ramo,
        ramo_normalizado: campaign.ramo_normalizado,
        prompt_livre: campaign.prompt_livre,
        opcao_rapida: campaign.opcao_rapida,
        index: art.index
      });
      if (pending.length >= limit) break;
    }
    if (pending.length >= limit) break;
  }
  return { ok: true, artes: pending };
}

function parseTimeMs(value) {
  const time = new Date(value || "").getTime();
  return Number.isFinite(time) ? time : 0;
}

function normalizeStuckAction(action = "") {
  return String(action || "").trim().toLowerCase() === "erro" ? "erro" : "pendente";
}

function recoverStuckGeneration({
  baseDir,
  timeoutMs = 30 * 60 * 1000,
  action = "pendente",
  now = new Date()
}) {
  const maxAgeMs = Math.max(60 * 1000, Number(timeoutMs) || 30 * 60 * 1000);
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const currentMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const currentIso = new Date(currentMs).toISOString();
  const recoveredStatus = normalizeStuckAction(action);
  const recovered = [];

  for (const campaign of storage.listCampaigns(baseDir)) {
    if (!["gerando", "revisao"].includes(campaign.status)) continue;

    let changed = false;
    for (const art of storage.listArts(baseDir, campaign.id)) {
      if (art.status !== "gerando") continue;
      const lastProgressMs = parseTimeMs(art.updated_at || art.resultado_enviado_em || art.created_at);
      if (lastProgressMs && currentMs - lastProgressMs <= maxAgeMs) continue;

      const previousStatus = art.status;
      art.status = recoveredStatus;
      art.updated_at = currentIso;
      art.recovered_at = currentIso;
      art.recovery_reason = `generation_timeout_${maxAgeMs}ms`;
      art.erro = recoveredStatus === "erro" ? "generation_timeout" : "";
      storage.writeArt(baseDir, campaign.id, art);
      storage.appendAudit(baseDir, campaign.id, {
        action: "art_generation_recovered",
        art_id: art.id,
        previous_status: previousStatus,
        recovered_status: recoveredStatus,
        timeout_ms: maxAgeMs
      });
      recovered.push({
        campaign_id: campaign.id,
        art_id: art.id,
        previous_status: previousStatus,
        status: recoveredStatus
      });
      changed = true;
    }

    if (changed) updateCampaignStatusFromArts(baseDir, campaign.id);
  }

  return {
    ok: true,
    recovered_count: recovered.length,
    recovered
  };
}

function updateArtStatus({ baseDir, campaignId, artId, status, message = "" }) {
  if (!VALID_ART_STATUSES.has(status)) {
    const error = new Error("Status invalido.");
    error.statusCode = 400;
    error.code = "invalid_art_status";
    throw error;
  }
  const campaign = readCampaignOrThrow(baseDir, campaignId);
  ensureCampaignEditable(campaign);
  const art = storage.readArt(baseDir, campaignId, artId);
  if (!art) {
    const error = new Error("Arte nao encontrada.");
    error.statusCode = 404;
    error.code = "art_not_found";
    throw error;
  }
  art.status = status;
  art.erro = status === "erro" ? String(message || art.erro || "erro_pipeline") : "";
  art.updated_at = nowIso();
  storage.writeArt(baseDir, campaignId, art);
  updateCampaignStatusFromArts(baseDir, campaignId);
  return { ok: true, arte: art };
}

function saveArtResult({ baseDir, campaignId, artId, resultFile, previewFile, descricaoInstagram = "" }) {
  const campaign = readCampaignOrThrow(baseDir, campaignId);
  ensureCampaignEditable(campaign);
  const art = storage.readArt(baseDir, campaignId, artId);
  if (!art) {
    const error = new Error("Arte nao encontrada.");
    error.statusCode = 404;
    error.code = "art_not_found";
    throw error;
  }

  const dir = storage.artDir(baseDir, campaignId, artId);
  storage.ensureDir(dir);
  const originalPath = path.join(dir, "original.png");
  const previewPath = path.join(dir, "preview.jpg");

  if (!resultFile) {
    const error = new Error("Arquivo resultado obrigatorio.");
    error.statusCode = 400;
    error.code = "missing_result_file";
    throw error;
  }

  if (fs.existsSync(originalPath)) fs.unlinkSync(originalPath);
  fs.renameSync(resultFile.path, originalPath);

  if (previewFile) {
    if (fs.existsSync(previewPath)) fs.unlinkSync(previewPath);
    fs.renameSync(previewFile.path, previewPath);
  }

  art.status = "pronta";
  art.arquivo_original = originalPath;
  art.arquivo_preview = previewFile ? previewPath : originalPath;
  art.descricao_instagram = String(descricaoInstagram || "").trim();
  art.resultado_enviado_em = nowIso();
  art.updated_at = nowIso();
  art.erro = "";
  storage.writeArt(baseDir, campaignId, art);
  storage.appendAudit(baseDir, campaignId, { action: "art_ready", art_id: artId });
  updateCampaignStatusFromArts(baseDir, campaignId);
  return { ok: true, arte: art };
}

function approveArt({ baseDir, campaignId, artId, adminId = "" }) {
  const campaign = readCampaignOrThrow(baseDir, campaignId);
  ensureCampaignEditable(campaign);
  const art = storage.readArt(baseDir, campaignId, artId);
  if (!art || !fs.existsSync(art.arquivo_original || "")) {
    const error = new Error("Arte precisa estar pronta antes de aprovar.");
    error.statusCode = 400;
    error.code = "art_not_ready";
    throw error;
  }
  art.status = "aprovada";
  art.approved_at = nowIso();
  art.approved_by = adminId;
  art.updated_at = art.approved_at;
  storage.writeArt(baseDir, campaignId, art);
  storage.appendAudit(baseDir, campaignId, { action: "art_approved", art_id: artId, by: adminId });
  updateCampaignStatusFromArts(baseDir, campaignId);
  return { ok: true, arte: art };
}

function excludeArt({ baseDir, campaignId, artId, adminId = "" }) {
  const campaign = readCampaignOrThrow(baseDir, campaignId);
  ensureCampaignEditable(campaign);
  const art = storage.readArt(baseDir, campaignId, artId);
  if (!art) {
    const error = new Error("Arte nao encontrada.");
    error.statusCode = 404;
    error.code = "art_not_found";
    throw error;
  }
  art.status = "excluida";
  art.excluded_at = nowIso();
  art.excluded_by = adminId;
  art.updated_at = art.excluded_at;
  storage.writeArt(baseDir, campaignId, art);
  storage.appendAudit(baseDir, campaignId, { action: "art_excluded", art_id: artId, by: adminId });
  updateCampaignStatusFromArts(baseDir, campaignId);
  return { ok: true, arte: art };
}

function regenerateArt({ baseDir, campaignId, artId, adminId = "" }) {
  const campaign = readCampaignOrThrow(baseDir, campaignId);
  ensureCampaignEditable(campaign);
  const art = storage.readArt(baseDir, campaignId, artId);
  if (!art) {
    const error = new Error("Arte nao encontrada.");
    error.statusCode = 404;
    error.code = "art_not_found";
    throw error;
  }
  art.status = "pendente";
  art.regenerated_at = nowIso();
  art.regenerated_by = adminId;
  art.updated_at = art.regenerated_at;
  art.erro = "";
  storage.writeArt(baseDir, campaignId, art);
  storage.appendAudit(baseDir, campaignId, { action: "art_regenerate", art_id: artId, by: adminId });
  return { ok: true, arte: art };
}

function findLatestLogoForClient(pedidosDir, whatsapp) {
  const matches = [];
  for (const { base } of orderStorage.listPedidoBasesByWhatsapp(pedidosDir, whatsapp)) {
    for (const filePath of walkFiles(base)) {
      const name = path.basename(filePath).toLowerCase();
      if (!/^logo\.(png|jpg|jpeg|webp)$/.test(name)) continue;
      try {
        matches.push({ filePath, mtimeMs: fs.statSync(filePath).mtimeMs });
      } catch {}
    }
  }
  matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return matches[0]?.filePath || "";
}

function* walkFiles(dirPath) {
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const current = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(current);
    } else if (entry.isFile()) {
      yield current;
    }
  }
}

function selectArtForClient(approvedArts, client, index) {
  if (!approvedArts.length) return null;
  const offset = parseInt(stableHash(client.whatsapp, 8), 16) % approvedArts.length;
  return approvedArts[(index + offset) % approvedArts.length];
}

function buildAssignmentId(campaignId, whatsapp) {
  return `free_${stableHash(`${campaignId}:${whatsapp}`, 18)}`;
}

function orderMonthFromDate(dateText = "") {
  const date = normalizeDateText(dateText);
  return date ? date.slice(0, 7) : new Date().toISOString().slice(0, 7);
}

function copyFileIfExists(src, dest) {
  if (!src || !fs.existsSync(src)) return false;
  storage.ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
  return true;
}

function createOrderLikeDelivery({
  pedidosDir,
  campaign,
  art,
  client,
  assignmentId,
  finalImagePath,
  logoSource = "",
  logoStatus = "nao_aplicada"
}) {
  const month = orderMonthFromDate(campaign.data_postagem);
  const base = path.join(pedidosDir, client.whatsapp, month, assignmentId);
  storage.ensureDir(base);

  const now = nowIso();
  const pedido = {
    id: assignmentId,
    pedido_id: assignmentId,
    whatsapp: client.whatsapp,
    categoria: "arte_empresa",
    product_id: "arte_empresa",
    tipo_arte: "arte_gratis_semanal",
    origem: ORIGIN,
    gratuita_administrativa: true,
    bloquear_cobranca: true,
    bloquear_edicao: true,
    campaign_id: campaign.id,
    assignment_id: assignmentId,
    ramo: campaign.ramo,
    ramo_normalizado: campaign.ramo_normalizado,
    nome_empresa: "",
    objetivo: "Arte Gratis da Semana",
    frase_foto: "Arte Gratis da Semana",
    cta: "",
    descricao_instagram: art.descricao_instagram || "",
    status: "pronto",
    pagamento_pendente: false,
    valor_pendente: 0,
    valor_cobrado: 0,
    cobranca_origem: "campanha_gratuita",
    tipo_compra: "campanha_gratuita",
    aprovado_cliente: false,
    ajuste_automatico_usado: true,
    pode_pedir_ajuste: false,
    data_postagem: campaign.data_postagem,
    horario_postagem: campaign.horario,
    notificar_em: notificationIso(campaign.data_postagem, campaign.horario),
    logo_source: logoSource,
    logo_status: logoStatus,
    arte_origem_id: art.id,
    criado_em: now,
    resultado_enviado_em: now
  };

  storage.writeJson(path.join(base, "pedido.json"), pedido);
  fs.writeFileSync(path.join(base, "status.txt"), "pronto", "utf8");
  copyFileIfExists(finalImagePath || art.arquivo_original, path.join(base, "resultado_final.png"));

  return { base, pedido, month };
}

function buildDistributionPreview({ baseDir, campaignId }) {
  const campaign = readCampaignOrThrow(baseDir, campaignId);
  ensureCampaignEditable(campaign);
  const approvedArts = storage.listArts(baseDir, campaignId).filter((art) => art.status === "aprovada");
  if (!approvedArts.length) {
    const error = new Error("Aprove pelo menos uma arte antes de distribuir.");
    error.statusCode = 400;
    error.code = "no_approved_arts";
    throw error;
  }
  const clients = Array.isArray(campaign.eligible_clients_snapshot) ? campaign.eligible_clients_snapshot : [];
  const perArt = Object.fromEntries(approvedArts.map((art) => [art.id, 0]));
  clients.forEach((client, index) => {
    const art = selectArtForClient(approvedArts, client, index);
    if (art) perArt[art.id] += 1;
  });

  return {
    ok: true,
    campaign_id: campaignId,
    ramo: campaign.ramo,
    clientes: clients.length,
    artes_aprovadas: approvedArts.length,
    data_postagem: campaign.data_postagem,
    horario: campaign.horario,
    notificacao_titulo: campaign.notificacao_titulo,
    notificacao_mensagem: campaign.notificacao_mensagem,
    distribuicao_por_arte: perArt
  };
}

function distributeCampaign({
  baseDir,
  pedidosDir,
  campaignId,
  adminId = "",
  composeLogo = null
}) {
  const campaign = readCampaignOrThrow(baseDir, campaignId);
  ensureCampaignEditable(campaign);

  const preview = buildDistributionPreview({ baseDir, campaignId });
  const approvedArts = storage.listArts(baseDir, campaignId).filter((art) => art.status === "aprovada");
  const clients = Array.isArray(campaign.eligible_clients_snapshot) ? campaign.eligible_clients_snapshot : [];
  const distribution = storage.readDistribution(baseDir, campaignId);
  const existing = new Map((distribution.assignments || []).map((item) => [item.assignment_id, item]));
  const assignments = [];

  clients.forEach((client, index) => {
    const art = selectArtForClient(approvedArts, client, index);
    if (!art) return;

    const assignmentId = buildAssignmentId(campaign.id, client.whatsapp);
    const current = existing.get(assignmentId);
    if (current?.pedido_id) {
      assignments.push(current);
      return;
    }

    const logoSource = findLatestLogoForClient(pedidosDir, client.whatsapp);
    let finalImagePath = art.arquivo_original;
    let logoStatus = logoSource ? "falha_fallback_generica" : "sem_logo";

    if (logoSource && typeof composeLogo === "function") {
      try {
        const personalizedPath = path.join(storage.campaignDir(baseDir, campaign.id), "clientes", client.whatsapp, `${assignmentId}.png`);
        const result = composeLogo({
          baseImagePath: art.arquivo_original,
          logoPath: logoSource,
          outputPath: personalizedPath
        });
        if (result?.ok && fs.existsSync(personalizedPath)) {
          finalImagePath = personalizedPath;
          logoStatus = "aplicada";
        }
      } catch {
        finalImagePath = art.arquivo_original;
        logoStatus = "falha_fallback_generica";
      }
    }

    const delivery = createOrderLikeDelivery({
      pedidosDir,
      campaign,
      art,
      client,
      assignmentId,
      finalImagePath,
      logoSource,
      logoStatus
    });

    assignments.push({
      assignment_id: assignmentId,
      campaign_id: campaign.id,
      whatsapp: client.whatsapp,
      art_id: art.id,
      pedido_id: assignmentId,
      mes: delivery.month,
      status: "distribuida",
      calendario_status: "ativo",
      notificacao_status: campaign.data_postagem ? "pendente" : "sem_data",
      notificacao_tentativas: 0,
      notificar_em: notificationIso(campaign.data_postagem, campaign.horario),
      data_postagem: campaign.data_postagem,
      horario: campaign.horario,
      logo_source: logoSource,
      logo_status: logoStatus,
      created_at: nowIso()
    });
  });

  campaign.status = "distribuida";
  campaign.distributed_count = assignments.length;
  campaign.distributed_at = nowIso();
  campaign.distributed_by = adminId;
  campaign.updated_at = campaign.distributed_at;
  storage.writeCampaign(baseDir, campaign);
  storage.writeDistribution(baseDir, campaignId, {
    ...distribution,
    assignments,
    updated_at: nowIso()
  });
  storage.appendAudit(baseDir, campaignId, {
    action: "distributed",
    by: adminId,
    assignments: assignments.length,
    preview
  });

  return detailCampaign({ baseDir, campaignId });
}

function listClientCalendar({ baseDir, whatsapp, pedidosDir = "" }) {
  const postagens = [];
  for (const campaign of storage.listCampaigns(baseDir)) {
    if (campaign.status !== "distribuida") continue;
    const distribution = storage.readDistribution(baseDir, campaign.id);
    for (const assignment of distribution.assignments || []) {
      if (assignment.whatsapp !== whatsapp || assignment.calendario_status === "oculto") continue;
      const pedidoId = assignment.pedido_id || assignment.assignment_id;
      const imageReady = Boolean(pedidoId) && fs.existsSync(path.join(pedidosDir, whatsapp, assignment.mes || orderMonthFromDate(campaign.data_postagem), pedidoId, "resultado_final.png"));
      const key = `free-art:${campaign.id}:${assignment.assignment_id}`;
      postagens.push({
        key,
        item_key: key,
        calendar_key: key,
        tipo: ORIGIN,
        origem: ORIGIN,
        free_art_weekly: true,
        planning_id: `free-art:${campaign.id}`,
        planejamento_id: `free-art:${campaign.id}`,
        pedido_id: pedidoId,
        assignment_id: assignment.assignment_id,
        campaign_id: campaign.id,
        ordem: 0,
        planejamento_item_id: assignment.assignment_id,
        data: assignment.data_postagem || campaign.data_postagem || "",
        horario: assignment.horario || campaign.horario || DEFAULT_TIME,
        data_sugerida: assignment.data_postagem || campaign.data_postagem || "",
        horario_sugerido: assignment.horario || campaign.horario || DEFAULT_TIME,
        status: imageReady ? "pronto" : "planejada",
        status_label: imageReady ? "Pronta" : "Planejada",
        titulo: "Arte Gratis da Semana",
        legenda: "",
        descricao_instagram: "",
        tema: "Arte Gratis da Semana",
        objetivo: campaign.ramo || "",
        texto_obrigatorio_imagem: "Arte Gratis da Semana",
        frase_foto: "Arte Gratis da Semana",
        imagem_pronta: imageReady,
        image_url: imageReady ? `/pedidos/${encodeURIComponent(pedidoId)}/preview` : "",
        imagem_url: imageReady ? `/pedidos/${encodeURIComponent(pedidoId)}/preview` : "",
        thumbnail_url: imageReady ? `/pedidos/${encodeURIComponent(pedidoId)}/thumbnail` : "",
        miniatura_url: imageReady ? `/pedidos/${encodeURIComponent(pedidoId)}/thumbnail` : "",
        preview_url: imageReady ? `/pedidos/${encodeURIComponent(pedidoId)}/preview` : "",
        sort_key: [
          assignment.data_postagem || campaign.data_postagem || "9999-12-31",
          assignment.horario || campaign.horario || "23:59",
          "free-art",
          campaign.id
        ].join("|")
      });
    }
  }
  postagens.sort((a, b) => String(a.sort_key || "").localeCompare(String(b.sort_key || "")));
  return postagens;
}

function hideCalendarItem({ baseDir, whatsapp, itemKey }) {
  const key = String(itemKey || "");
  if (!key.startsWith("free-art:")) return null;

  for (const campaign of storage.listCampaigns(baseDir)) {
    const distribution = storage.readDistribution(baseDir, campaign.id);
    let changed = false;
    for (const assignment of distribution.assignments || []) {
      const expected = `free-art:${campaign.id}:${assignment.assignment_id}`;
      if (expected === key && assignment.whatsapp === whatsapp) {
        assignment.calendario_status = "oculto";
        assignment.calendario_oculto_em = nowIso();
        changed = true;
      }
    }
    if (changed) {
      storage.writeDistribution(baseDir, campaign.id, distribution);
      return { ok: true };
    }
  }
  return null;
}

module.exports = {
  ORIGIN,
  DEFAULT_TIME,
  normalizeRamo,
  isFreeArtOrder,
  scanClientBranches,
  createCampaign,
  updateCampaignSettings,
  duplicateCampaign,
  listCampaigns,
  detailCampaign,
  listPendingArts,
  recoverStuckGeneration,
  updateArtStatus,
  saveArtResult,
  approveArt,
  excludeArt,
  regenerateArt,
  buildDistributionPreview,
  distributeCampaign,
  listClientCalendar,
  hideCalendarItem,
  notificationIso,
  _private: {
    selectLatestRamoCandidate,
    selectArtForClient,
    buildAssignmentId,
    stableHash,
    normalizeDateText,
    normalizeTimeText
  }
};
