Warning: truncated output (original token count: 59242)
Total output lines: 7420

const {
  createProductionSocialIntegration
} = require("./src/social/production-integration");
const productionSocialIntegration = createProductionSocialIntegration({
  env: process.env
});

const {
  repairAppReviewCompanyLabel
} = require("./src/social/app-review-policy");

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const productsRegistry = require("./src/products");
const orderStorage = require("./src/orders/order.storage");
const orderStatus = require("./src/orders/order.status");
const orderService = require("./src/orders/order.service");
const billingService = require("./src/billing/billing.service");
const billingPlans = require("./src/billing/plans");
const graphicMaterialsService = require("./src/company-graphic-materials/materials.service");
const graphicMaterialsCatalog = require("./src/company-graphic-materials/materials.catalog");
const carouselService = require("./src/company-carousels/carousels.service");
const monthlyPlanningService = require("./src/company-monthly-planning/planning.service");
const productDiscoveryService = require("./src/company-monthly-planning/product-discovery.service");
const fcmService = require("./src/notifications/fcm.service");
const {
  activeEncryptedFcmTokenRecords,
  atomicWriteJson,
  deactivateFcmTokens
} = require("./src/notifications/fcm-token-store");
const {
  createArtReadyNotificationService
} = require("./src/notifications/art-ready-notification.service");
const {
  successfulCompletionTransition
} = require("./src/notifications/art-ready-generation");
const {
  FcmTokenApiContractError,
  parseDeactivateFcmTokenBody,
  parseRegisterFcmTokenBody
} = require("./src/notifications/fcm-token-api-contract");
const {
  FcmFinalTestError,
  assertFinalTestAllowedOwner,
  deactivateFinalTestDevice,
  registerFinalTestDevice
} = require("./src/notifications/fcm-final-test");
const { streamDirectoryZip } = require("./src/zip/zip-stream");
const freeArtCampaignsService = require("./src/admin-free-art-campaigns/free-art-campaigns.service");
const freeArtCampaignsStorage = require("./src/admin-free-art-campaigns/free-art-campaigns.storage");
const freeArtCampaignsScheduler = require("./src/admin-free-art-campaigns/free-art-campaigns.scheduler");
const { createFreeArtCampaignRoutes } = require("./src/admin-free-art-campaigns/free-art-campaigns.routes");
const seoNichePages = require("./src/seo/niche-page-renderer");
const { createLegalPagesRouter } = require("./src/legal/legal-pages.routes");

const app = express();
app.set("trust proxy", true);

// ===== CONFIG BÁSICA =====
const PORT = process.env.PORT || 3000;
function requireJwtSecret(env = process.env) {
  const value = String(env.JWT_SECRET || "").trim();
  if (
    value.length < 32 ||
    value === "TROQUE_ISSO_AGORA"
  ) {
    throw new Error(
      "Configuracao obrigatoria invalida: JWT_SECRET"
    );
  }
  return value;
}
const JWT_SECRET = requireJwtSecret();
const { createProductionSession } = require("./src/social/production-session");
const productionSession = createProductionSession({ secret: JWT_SECRET, readClients: readClientes });

// ===== DATA STORAGE (RENDER DISK) =====
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "dados");

const PEDIDOS_DIR = path.join(DATA_DIR, "pedidos");
const TMP_UPLOADS_DIR = path.join(DATA_DIR, "tmp_uploads");
const GRAPHIC_MATERIALS_DIR = path.join(DATA_DIR, "materiais_graficos");
const CAROUSELS_DIR = path.join(DATA_DIR, "carrosseis");
const MONTHLY_PLANNINGS_DIR = path.join(DATA_DIR, "planejamentos_mensais");
const FREE_ART_CAMPAIGNS_DIR = path.join(DATA_DIR, "campanhas_artes_gratis");
const CLIENTES_FILE = path.join(DATA_DIR, "clientes.json");
const ART_READY_OUTBOX_FILE = path.join(
  DATA_DIR,
  "notifications",
  "art-ready-outbox.json"
);
const BOT_ADMIN_WHATSAPP = process.env.BOT_ADMIN_WHATSAPP || "15991120599";
const BOT_RUNNER_TOKEN = process.env.BOT_RUNNER_TOKEN || "";
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || "";
const MP_NOTIFICATION_URL = process.env.MP_NOTIFICATION_URL || "https://ia4tube-api.onrender.com/webhook/mercadopago";
const PUBLIC_API_BASE_URL = (process.env.PUBLIC_API_BASE_URL || "https://ia4tube-api.onrender.com").replace(/\/+$/, "");
const ARTE_AVULSA_COMPRA = billingPlans.getSingleArtPurchase();
const EMPRESA_ARTE_AVULSA_VALOR = Number(ARTE_AVULSA_COMPRA.amount || productsRegistry.getProductPrice("arte_empresa") || 5.99);
const MP_PROCESSANDO_RETRY_MS = 10 * 60 * 1000;
const MONTHLY_PLANNING_NOTIFICATIONS_INTERVAL_MS = Math.max(
  30 * 1000,
  Number(process.env.MONTHLY_PLANNING_NOTIFICATIONS_INTERVAL_MS || 60 * 1000)
);
const MP_PROCESSADOS_FILE = path.join(DATA_DIR, "mp_processados.json");
const TEMPO_ESTIMADO_FILE = path.join(DATA_DIR, "tempo_estimado.json");
const ONLINE_FILE = path.join(DATA_DIR, "usuarios_online.json");
const SUPORTE_ABERTAS_FILE = path.join(DATA_DIR, "suporte_conversas_abertas.json");
const SUPORTE_FINALIZADAS_FILE = path.join(DATA_DIR, "suporte_conversas_finalizadas.json");
const ANALYTICS_DIR = path.join(DATA_DIR, "analytics");
const EVENTOS_CLIENTES_FILE = path.join(DATA_DIR, "eventos_clientes.json");
const MARKETING_VIDEOS_DIR = path.join(DATA_DIR, "marketing_videos");
const MARKETING_VIDEO_VIEWS_FILE = path.join(MARKETING_VIDEOS_DIR, "views.json");
const FREE_ART_IP_LOCKS_FILE = path.join(DATA_DIR, "free_art_ip_locks.json");
const FREE_ART_IP_LOCK_DAYS = Math.max(1, Number(process.env.IA4TUBE_FREE_ART_IP_LOCK_DAYS || 7));
const FREE_ART_IP_LOCK_MS = FREE_ART_IP_LOCK_DAYS * 24 * 60 * 60 * 1000;
const PUBLIC_DIR = path.join(__dirname, "public");
const PUBLIC_VIDEOS_DIR = path.join(PUBLIC_DIR, "videos");
const SEO_NICHES_DIR = path.join(PUBLIC_DIR, "nichos");
const ADMIN_MOBILE_ANALYTICS_FILE = path.join(__dirname, "admin", "mobile_analytics.html");
const ADMIN_FREE_ART_CAMPAIGNS_FILE = path.join(__dirname, "admin", "free_art_campaigns.html");
const ADMIN_ANALYTICS_COOKIE = "ia4tube_admin_token";

const CLIENTES_TESTE = [
  "Los Hermanos",
  "TESTE",
  "admin"
];

const MONTHLY_PLANNING_RESERVED_ROUTE_SEGMENTS = new Set([
  "calendario"
]);

// CORS: permite seu site chamar a API
app.use(cors({
  origin: ["https://ia4tube.com", "https://www.ia4tube.com", "http://127.0.0.1:8080", "http://localhost:8080"],
  credentials: false
}));

app.use(productionSocialIntegration.privateMediaMiddleware);
app.use("/v1/social", productionSocialIntegration.middleware);
productionSocialIntegration.mountWeb(app);

const globalJsonParser = express.json({ limit: "50mb" });
const globalUrlencodedParser = express.urlencoded({ extended: false, limit: "1mb" });
const finalTestFcmJsonParser = express.json({ limit: "16kb" });

function isFcmTokenRouteRequest(req) {
  const normalizedPath = String(req.path || "")
    .toLowerCase()
    .replace(/\/+$/, "");
  return (
    normalizedPath === "/me/fcm-token" &&
    ["POST", "DELETE"].includes(req.method)
  );
}

app.use((req, res, next) => {
  if (!isFcmTokenRouteRequest(req)) return next();
  if (!fcmService.tokenRegistrationEnabled()) {
    return res.status(503).json({
      ok: false,
      code: "fcm_token_registration_disabled",
      error: "Registro de notificacoes desativado."
    });
  }
  return auth(req, res, () => {
    if (!requireFinalTestAllowedOwner(req, res)) return;
    if (!req.is("application/json")) {
      return res.status(415).json({
        ok: false,
        code: "fcm_token_content_type_invalid",
        error: "Requisicao de notificacoes invalida."
      });
    }
    req.fcmFinalTestPreauthorized = true;
    return next();
  });
});

app.use((req, res, next) => {
  if (req.fcmFinalTestPreauthorized === true) {
    return finalTestFcmJsonParser(req, res, next);
  }
  return globalJsonParser(req, res, next);
});
app.use((req, res, next) => {
  if (req.fcmFinalTestPreauthorized === true) return next();
  return globalUrlencodedParser(req, res, next);
});
app.use((err, req, res, next) => {
  if (
    req.fcmFinalTestPreauthorized === true &&
    ["entity.parse.failed", "entity.too.large"].includes(err?.type)
  ) {
    return res.status(err.type === "entity.too.large" ? 413 : 400).json({
      ok: false,
      code: err.type === "entity.too.large"
        ? "fcm_token_payload_too_large"
        : "fcm_token_request_invalid",
      error: "Requisicao de notificacoes invalida."
    });
  }
  return next(err);
});

app.get(["/mobile_analytics.html", "/public/mobile_analytics.html"], (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  return res.status(404).send("Not found");
});

app.use("/videos", express.static(PUBLIC_VIDEOS_DIR, {
  acceptRanges: true,
  setHeaders: (res, filePath) => {
    const normalizedPath = String(filePath || "").toLowerCase();
    if (normalizedPath.endsWith(".mp4")) {
      res.type("video/mp4");
    }
    if (normalizedPath.endsWith(".jpg") || normalizedPath.endsWith(".jpeg")) {
      res.type("image/jpeg");
    }
    res.setHeader("Cache-Control", "public, max-age=300");
  }
}));

app.use(createLegalPagesRouter());
app.use(express.static(PUBLIC_DIR));

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";

// ===== GARANTE PASTAS =====
function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

ensureDir(DATA_DIR);
ensureDir(PEDIDOS_DIR);
ensureDir(TMP_UPLOADS_DIR);
ensureDir(GRAPHIC_MATERIALS_DIR);
ensureDir(CAROUSELS_DIR);
ensureDir(MONTHLY_PLANNINGS_DIR);
ensureDir(ANALYTICS_DIR);
ensureDir(MARKETING_VIDEOS_DIR);

if (!fs.existsSync(CLIENTES_FILE)) {
  fs.writeFileSync(CLIENTES_FILE, JSON.stringify({}, null, 2), "utf8");
}

if (!fs.existsSync(MP_PROCESSADOS_FILE)) {
  fs.writeFileSync(MP_PROCESSADOS_FILE, JSON.stringify({}, null, 2), "utf8");
}

if (!fs.existsSync(TEMPO_ESTIMADO_FILE)) {
  fs.writeFileSync(TEMPO_ESTIMADO_FILE, JSON.stringify({
    tempo_medio_segundos: 135,
    tempo_estimado_segundos: 135,
    pedidos_na_fila: 0,
    lotes: 1,
    max_processos: 5,
    atualizado_em: new Date().toISOString()
  }, null, 2), "utf8");
}

if (!fs.existsSync(ONLINE_FILE)) {
  fs.writeFileSync(ONLINE_FILE, JSON.stringify({}, null, 2), "utf8");
}

if (!fs.existsSync(SUPORTE_ABERTAS_FILE)) {
  fs.writeFileSync(SUPORTE_ABERTAS_FILE, JSON.stringify([], null, 2), "utf8");
}

if (!fs.existsSync(SUPORTE_FINALIZADAS_FILE)) {
  fs.writeFileSync(SUPORTE_FINALIZADAS_FILE, JSON.stringify([], null, 2), "utf8");
}

if (!fs.existsSync(EVENTOS_CLIENTES_FILE)) {
  fs.writeFileSync(EVENTOS_CLIENTES_FILE, JSON.stringify([], null, 2), "utf8");
}

if (!fs.existsSync(MARKETING_VIDEO_VIEWS_FILE)) {
  fs.writeFileSync(MARKETING_VIDEO_VIEWS_FILE, JSON.stringify({}, null, 2), "utf8");
}

if (!fs.existsSync(FREE_ART_IP_LOCKS_FILE)) {
  fs.writeFileSync(FREE_ART_IP_LOCKS_FILE, JSON.stringify({}, null, 2), "utf8");
}

// ===== HELPERS =====
function readClientes() {
  return JSON.parse((fs.readFileSync(CLIENTES_FILE, "utf8") || "{}").replace(/^\uFEFF/, ""));
}

function writeClientes(obj) {
  fs.writeFileSync(CLIENTES_FILE, JSON.stringify(obj, null, 2), "utf8");
}

const artReadyNotificationService = createArtReadyNotificationService({
  outboxPath: ART_READY_OUTBOX_FILE,
  eventEnabled: fcmService.artReadyEventEnabled,
  deliveryEnabled: fcmService.fcmDeliveryEnabled,
  automaticNotificationsEnabled: fcmService.automaticNotificationsEnabled,
  getClienteByOwner: (ownerId) => readClientes()[ownerId] || null,
  listActiveTokenRecords: (cliente) =>
    activeEncryptedFcmTokenRecords({ cliente }),
  sendToClient: fcmService.sendArtReadyToClient,
  deactivateInvalidTokens: (ownerId, tokens) =>
    deactivateInvalidFcmTokens(ownerId, tokens)
});

function isMonthlyPlanningReservedRouteSegment(value) {
  return MONTHLY_PLANNING_RESERVED_ROUTE_SEGMENTS.has(
    String(value || "").trim().toLowerCase()
  );
}

function readMpProcessados() {
  return JSON.parse(fs.readFileSync(MP_PROCESSADOS_FILE, "utf8") || "{}");
}

function writeMpProcessados(obj) {
  fs.writeFileSync(MP_PROCESSADOS_FILE, JSON.stringify(obj, null, 2), "utf8");
}

function isMpProcessandoStale(registro) {
  if (!registro || registro.status !== "processando") return false;

  const tentativaEm = new Date(registro.ultima_tentativa_em || registro.criado_em || 0).getTime();
  if (!tentativaEm || Number.isNaN(tentativaEm)) return true;

  return Date.now() - tentativaEm > MP_PROCESSANDO_RETRY_MS;
}

function readTempoEstimado() {
  try {
    return JSON.parse(fs.readFileSync(TEMPO_ESTIMADO_FILE, "utf8") || "{}");
  } catch {
    return {
      tempo_medio_segundos: 135,
      tempo_estimado_segundos: 135,
      pedidos_na_fila: 0,
      lotes: 1,
      max_processos: 5,
      atualizado_em: new Date().toISOString()
    };
  }
}

function writeTempoEstimado(obj) {
  fs.writeFileSync(TEMPO_ESTIMADO_FILE, JSON.stringify(obj, null, 2), "utf8");
}

function getCustoPedido(categoria, cliente) {
  const registryPrice = productsRegistry.getProductPrice(categoria, cliente);
  if (registryPrice !== null) return registryPrice;

  if (categoria === "resultado") return 8.00;
  if (categoria === "escalacao") return 8.00;
  if (categoria === "contratacao") return 7.00;
  if (categoria === "proximo_jogo") return 7.00;
  if (categoria === "treino") return 7.00;
  if (categoria === "patrocinador") return 8.00;
  if (categoria === "escudo3d") return 4.00;

  if (categoria === "proximo_jogo_jogador") return 7.00;
  if (categoria === "resultado_jogo_jogador") return 8.00;
  if (categoria === "jogador_escudo") return 6.00;
  if (categoria === "mascote_uniforme") {
    if (cliente && cliente.brinde_mascote_disponivel === true) return 0;
    return 18.00;
  }

  return 0;
}

function nomeCategoriaPedido(categoria) {
  const registryName = productsRegistry.getProductName(categoria);
  if (registryName) return registryName;

  const nomes = {
    resultado: "Resultado do jogo",
    escalacao: "Escalação",
    contratacao: "Contratação",
    proximo_jogo: "Próximo jogo",
    treino: "Dia de Treino",
    patrocinador: "Patrocinador / Apoio",
    escudo3d: "Escudo 3D",
    proximo_jogo_jogador: "Próximo jogo jogador",
    resultado_jogo_jogador: "Resultado jogador",
    jogador_escudo: "Jogador + escudo",
    mascote_uniforme: "Mascote + uniforme"
  };

  return nomes[categoria] || categoria || "";
}

function normalizarLoginId(valor) {
  return String(valor || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9._-]+/g, "");
}

function gerarSenhaAutomatica() {
  return "ia4" + Math.random().toString(36).slice(2, 8);
}

function criarLoginAutomaticoUnico(base, clientes) {
  let loginBase = normalizarLoginId(base);

  if (!loginBase || loginBase.length < 3) {
    loginBase = "jogador";
  }

  let login = "auto_" + loginBase + "_" + Date.now();

  while (clientes[login]) {
    login = "auto_" + loginBase + "_" + Date.now() + "_" + Math.floor(Math.random() * 999);
  }

  return login;
}

function nowYYYYMM() {
  return orderStorage.nowYYYYMM();
}

function newPedidoId() {
  return orderStorage.newPedidoId();
}

function getPedidoBase(whatsapp, pedidoId) {
  return orderStorage.getPedidoBase(PEDIDOS_DIR, whatsapp, pedidoId);
}

function safeReadJson(filePath) {
  return orderStorage.safeReadJson(filePath);
}

function isBotAdmin(req) {
  return req.user && req.user.whatsapp === BOT_ADMIN_WHATSAPP;
}

function parseCookies(req) {
  return String(req.headers.cookie || "")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .reduce((cookies, item) => {
      const idx = item.indexOf("=");
      if (idx === -1) return cookies;
      const key = decodeURIComponent(item.slice(0, idx).trim());
      const value = decodeURIComponent(item.slice(idx + 1).trim());
      cookies[key] = value;
      return cookies;
    }, {});
}

function bearerTokenFromRequest(req) {
  const h = req.headers.authorization || "";
  if (h.startsWith("Bearer ")) return h.slice(7).trim();
  const cookies = parseCookies(req);
  return String(cookies[ADMIN_ANALYTICS_COOKIE] || "").trim();
}

function verifyBotAdminToken(token) {
  if (!token) return null;
  try {
    const user = jwt.verify(token, JWT_SECRET, {
      algorithms: ["HS256"]
    });
    if (user?.whatsapp !== BOT_ADMIN_WHATSAPP) return null;
    return user;
  } catch {
    return null;
  }
}

function setAdminAnalyticsCookie(res, token) {
  res.cookie(ADMIN_ANALYTICS_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    maxAge: 12 * 60 * 60 * 1000,
    path: "/bot"
  });
}

function botAdminAuth(req, res, next) {
  const token = bearerTokenFromRequest(req);
  const user = verifyBotAdminToken(token);

  if (!user) {
    return res.status(401).json({ ok: false, error: "Acesso restrito ao admin" });
  }

  req.user = user;
  return next();
}

function adminAnalyticsLoginPage() {
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Analytics Mobile IA4Tube - Acesso restrito</title>
  <style>
    body{margin:0;min-height:100vh;display:grid;place-items:center;background:#090d14;color:#eef4ff;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    main{width:min(420px,calc(100% - 32px));background:#111827;border:1px solid rgba(255,255,255,.1);border-radius:18px;padding:24px;box-shadow:0 18px 50px rgba(0,0,0,.35)}
    h1{margin:0 0 8px;font-size:24px}p{color:#93a4bd}label{display:block;margin-top:18px;color:#cbd5e1}input{width:100%;margin-top:8px;border:1px solid rgba(255,255,255,.14);border-radius:12px;background:#0b1220;color:#fff;padding:12px}button{width:100%;margin-top:16px;border:0;border-radius:12px;background:#35d07f;color:#06110b;font-weight:800;padding:12px;cursor:pointer}.msg{min-height:22px;color:#ff6b7a}
  </style>
</head>
<body>
  <main>
    <h1>Analytics Mobile</h1>
    <p>Acesso restrito ao admin iA4Tube.</p>
    <label>Token admin
      <input id="token" type="password" autocomplete="off" autofocus>
    </label>
    <button id="enter" type="button">Entrar</button>
    <p id="msg" class="msg"></p>
  </main>
  <script>
    async function login(){
      const token = document.getElementById("token").value.trim();
      const msg = document.getElementById("msg");
      msg.textContent = "";
      if(!token){ msg.textContent = "Informe o token admin."; return; }
      const response = await fetch("/bot/mobile-analytics/login", {
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body:JSON.stringify({ token })
      });
      if(response.ok){ location.href = "/bot/mobile-analytics"; return; }
      msg.textContent = "Acesso negado. Confira o token admin.";
    }
    document.getElementById("enter").addEventListener("click", login);
    document.getElementById("token").addEventListener("keydown", (event) => {
      if(event.key === "Enter") login();
    });
  </script>
</body>
</html>`;
}

function mobileAnalyticsPanelAuth(req, res, next) {
  const user = verifyBotAdminToken(bearerTokenFromRequest(req));
  if (!user) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(401).send(adminAnalyticsLoginPage());
  }
  req.user = user;
  return next();
}

app.post("/bot/mobile-analytics/login", (req, res) => {
  const token = String(req.body?.token || "").trim();
  const user = verifyBotAdminToken(token);

  if (!user) {
    return res.status(401).json({ ok: false, error: "Acesso restrito ao admin" });
  }

  setAdminAnalyticsCookie(res, token);
  return res.json({ ok: true });
});

app.post("/bot/mobile-analytics/logout", (_req, res) => {
  res.clearCookie(ADMIN_ANALYTICS_COOKIE, {
    secure: true,
    sameSite: "strict",
    path: "/bot"
  });
  return res.json({ ok: true });
});

app.get("/bot/mobile-analytics", mobileAnalyticsPanelAuth, (_req, res) => {
  if (!fs.existsSync(ADMIN_MOBILE_ANALYTICS_FILE)) {
    return res.status(404).send("Painel mobile analytics nao encontrado");
  }

  res.setHeader("Cache-Control", "no-store");
  return res.sendFile(ADMIN_MOBILE_ANALYTICS_FILE);
});

function maskSensitiveIdentifier(value = "") {
  const raw = String(value || "").replace(/\D+/g, "");
  if (!raw) return "";
  if (raw.length <= 4) return "****";
  return `${raw.slice(0, 2)}****${raw.slice(-3)}`;
}

function sanitizeAnalyticsPayloadForResponse(value, depth = 0) {
  const sensitiveParts = [
    "telefone",
    "phone",
    "whatsapp",
    "cliente_id",
    "cliente",
    "nome",
    "empresa",
    "email",
    "senha",
    "password",
    "documento",
    "cpf",
    "cnpj",
    "endereco",
    "address",
    "token",
    "authorization",
    "auth",
    "pix",
    "copia_cola",
    "copiaecola",
    "prompt",
    "image",
    "imagem",
    "foto",
    "url",
    "uri",
    "base64"
  ];

  if (depth > 4 || value === null || value === undefined) return value;

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeAnalyticsPayloadForResponse(item, depth + 1));
  }

  if (typeof value === "object") {
    return Object.entries(value).reduce((safe, [key, item]) => {
      const normalizedKey = String(key || "").toLowerCase();
      if (!normalizedKey || sensitiveParts.some((part) => normalizedKey.includes(part))) {
        return safe;
      }
      safe[key] = sanitizeAnalyticsPayloadForResponse(item, depth + 1);
      return safe;
    }, {});
  }

  if (typeof value === "string") {
    if (value.length > 180) return `${value.slice(0, 177)}...`;
    return value;
  }

  if (["number", "boolean"].includes(typeof value)) return value;
  return "";
}

function sanitizeAnalyticsEventForResponse(event = {}) {
  const maskedClient = maskSensitiveIdentifier(event.whatsapp || event.cliente_id);
  const safe = sanitizeAnalyticsPayloadForResponse(event) || {};

  safe.cliente_mascarado = maskedClient;
  safe.payload = sanitizeAnalyticsPayloadForResponse(event.payload || {});

  delete safe.whatsapp;
  delete safe.cliente_id;
  delete safe.cliente;
  delete safe.email;
  delete safe.token;

  return safe;
}

function sanitizeOnlineUserForResponse(user = {}) {
  const safe = sanitizeAnalyticsPayloadForResponse(user) || {};
  const maskedClient = maskSensitiveIdentifier(user.whatsapp || user.cliente_id);

  safe.cliente_mascarado = maskedClient;
  safe.online = Boolean(user.online);
  safe.ultima_atividade = user.ultima_atividade || "";
  safe.pagina_atual = user.pagina_atual || "";
  safe.produto_atual = user.produto_atual || "";
  safe.chat_aberto = Boolean(user.chat_aberto);
  safe.ultima_acao = user.ultima_acao || "";
  safe.campo_atual = user.campo_atual || "";
  safe.ultima_acao_evento = user.ultima_acao_evento || "";
  safe.tempo_inativo_ms = Number(user.tempo_inativo_ms || 0);
  safe.ultimo_evento = user.ultimo_evento || "";

  delete safe.whatsapp;
  delete safe.cliente_id;
  delete safe.email;
  delete safe.token;
  delete safe.foto_google;

  return safe;
}

function getPedidoBaseGlobal(pedidoId) {
  return orderStorage.getPedidoBaseGlobal(PEDIDOS_DIR, pedidoId);
}

function getPedidoOwnerFromBase(base) {
  const relative = path.relative(path.resolve(PEDIDOS_DIR), path.resolve(base || ""));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return "";
  }
  const parts = relative.split(path.sep).filter(Boolean);
  return parts.length === 3 ? String(parts[0] || "").trim() : "";
}

function listPedidoBasesByWhatsapp(whatsapp) {
  return orderStorage.listPedidoBasesByWhatsapp(PEDIDOS_DIR, whatsapp);
}

function removeOldPedidos(whatsapp, maxKeep = 15) {
  return orderStorage.removeOldPedidos(PEDIDOS_DIR, whatsapp, maxKeep);
}

function readPedido(base) {
  return orderStorage.readOrder(base);
}

function writePedido(base, pedido) {
  return orderStorage.writeOrder(base, pedido);
}

function readOrderStatus(base, fallback = "") {
  return orderStorage.readStatus(base, fallback);
}

function writeOrderStatus(base, status) {
  return orderStorage.writeStatus(base, status);
}

function readJsonArraySafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const data = JSON.parse(fs.readFileSync(filePath, "utf8") || "[]");
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writeJsonSafe(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function readJsonObjectSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return {};
    const data = JSON.parse(fs.readFileSync(filePath, "utf8") || "{}");
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

const activeFreeArtClaimLocks = new Set();

function firstHeaderValue(value) {
  if (Array.isArray(value)) return firstHeaderValue(value[0]);
  return String(value || "").split(",")[0].trim();
}

function normalizeClientIp(value) {
  let ip = String(value || "").trim();
  if (!ip) return "";

  if (ip.startsWith("::ffff:")) ip = ip.slice("::ffff:".length);
  if (ip.startsWith("[") && ip.includes("]")) ip = ip.slice(1, ip.indexOf("]"));
  if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(ip)) ip = ip.slice(0, ip.lastIndexOf(":"));

  return ip;
}

function getClientIp(req) {
  const candidates = [
    firstHeaderValue(req.headers["cf-connecting-ip"]),
    firstHeaderValue(req.headers["true-client-ip"]),
    firstHeaderValue(req.headers["x-real-ip"]),
    firstHeaderValue(req.headers["x-forwarded-for"]),
    req.ip,
    req.socket?.remoteAddress
  ];

  for (const candidate of candidates) {
    const ip = normalizeClientIp(candidate);
    if (ip) return ip;
  }

  return "";
}

function hashFreeArtIp(ip) {
  const normalizedIp = normalizeClientIp(ip);
  if (!normalizedIp) return "";
  return crypto
    .createHash("sha256")
    .update(`ia4tube-free-art-ip:${JWT_SECRET}:${normalizedIp}`)
    .digest("hex");
}

function maskClientIp(ip) {
  const normalizedIp = normalizeClientIp(ip);
  if (!normalizedIp) return "";

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(normalizedIp)) {
    const parts = normalizedIp.split(".");
    return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
  }

  const segments = normalizedIp.split(":").filter(Boolean);
  return segments.length ? `${segments.slice(0, 3).join(":")}::` : "";
}

function readFreeArtIpLocks() {
  return readJsonObjectSafe(FREE_ART_IP_LOCKS_FILE);
}

function writeFreeArtIpLocks(locks) {
  writeJsonSafe(FREE_ART_IP_LOCKS_FILE, locks && typeof locks === "object" ? locks : {});
}

function cleanupExpiredFreeArtIpLocks(locks, now = new Date()) {
  let changed = false;
  const current = now instanceof Date ? now : new Date(now);

  for (const [key, lock] of Object.entries(locks || {})) {
    const blockedUntil = new Date(lock?.bloqueado_ate || 0);
    if (!lock || Number.isNaN(blockedUntil.getTime()) || blockedUntil <= current) {
      delete locks[key];
      changed = true;
    }
  }

  return changed;
}

function getFreeArtIpLockStatus(req, now = new Date()) {
  const ip = getClientIp(req);
  const ipHash = hashFreeArtIp(ip);
  const ipMasked = maskClientIp(ip);

  if (!ipHash) {
    return { blocked: false, ipHash: "", ipMasked: "", lock: null };
  }

  const locks = readFreeArtIpLocks();
  const cleaned = cleanupExpiredFreeArtIpLocks(locks, now);
  const lock = locks[ipHash] || null;
  const blockedUntil = new Date(lock?.bloqueado_ate || 0);
  const blocked = lock && !Number.isNaN(blockedUntil.getTime()) && blockedUntil > now;

  if (cleaned) writeFreeArtIpLocks(locks);

  return {
    blocked: Boolean(blocked),
    ipHash,
    ipMasked,
    lock: blocked ? lock : null
  };
}

function acquireFreeArtClaimLocks(whatsapp, ipHash) {
  const keys = [
    `user:${String(whatsapp || "").trim()}`,
    ipHash ? `ip:${ipHash}` : ""
  ].filter(Boolean);

  if (!keys.length || keys.some((key) => activeFreeArtClaimLocks.has(key))) return [];
  keys.forEach((key) => activeFreeArtClaimLocks.add(key));
  return keys;
}

function releaseFreeArtClaimLocks(keys = []) {
  for (const key of keys) {
    activeFreeArtClaimLocks.delete(key);
  }
}

function recordFreeArtIpLock(req, { whatsapp, pedidoId, context = "arte_empresa" } = {}) {
  try {
    const ip = getClientIp(req);
    const ipHash = hashFreeArtIp(ip);
    if (!ipHash) return null;

    const now = new Date();
    const blockedUntil = new Date(now.getTime() + FREE_ART_IP_LOCK_MS);
    const locks = readFreeArtIpLocks();
    cleanupExpiredFreeArtIpLocks(locks, now);

    const lock = {
      ip_hash: ipHash,
      ip_mascarado: maskClientIp(ip),
      cliente: String(whatsapp || "").trim(),
      pedido_id: String(pedidoId || "").trim(),
      contexto: String(context || "").trim() || "arte_empresa",
      usado_em: now.toISOString(),
      bloqueado_ate: blockedUntil.toISOString(),
      dias_bloqueio: FREE_ART_IP_LOCK_DAYS
    };

    locks[ipHash] = lock;
    writeFreeArtIpLocks(locks);

    return lock;
  } catch (error) {
    console.warn("[free-art-ip] erro ao registrar bloqueio", { message: error?.message });
    return null;
  }
}

function marketingVideoViewKey(videoId, version, context) {
  return [context, videoId, version]
    .map((value) => String(value || "").trim().replace(/\s+/g, "_"))
    .join("|");
}

function readMarketingVideoViews() {
  return readJsonObjectSafe(MARKETING_VIDEO_VIEWS_FILE);
}

function writeMarketingVideoViews(views) {
  writeJsonSafe(MARKETING_VIDEO_VIEWS_FILE, views && typeof views === "object" ? views : {});
}

function getMarketingVideoViewStatus(whatsapp, videoId, version, context) {
  const userId = String(whatsapp || "").trim();
  if (!userId || !videoId) {
    return { ja_visto: false };
  }

  const views = readMarketingVideoViews();
  const key = marketingVideoViewKey(videoId, version, context);
  const record = views[userId]?.[key] || null;
  return {
    ja_visto: Boolean(record?.started_at || record?.viewed_at || record?.completed_at)
  };
}

function marketingVideoEventDetails(event) {
  const payload = event?.p && typeof event.p === "object" ? event.p : {};
  const nested = payload.payload && typeof payload.payload === "object" ? payload.payload : {};
  return { ...payload, ...nested };
}

function updateMarketingVideoViewsFromEvents(whatsapp, eventos = [], atIso = new Date().toISOString()) {
  const userId = String(whatsapp || "").trim();
  if (!userId || !Array.isArray(eventos) || eventos.length === 0) return;

  let views = null;
  let changed = false;

  eventos.forEach((event) => {
    const eventName = String(event?.e || "").trim();
    if (!eventName.startsWith("mobile_video_marketing_")) return;
    if (eventName === "mobile_video_marketing_erro") return;

    const details = marketingVideoEventDetails(event);
    const videoId = String(details.video_id || details.videoId || "").trim();
    if (!videoId) return;

    const version = String(details.versao || details.version || "").trim();
    const context = String(details.contexto || details.context || FIRST_FREE_ART_VIDEO_CONTEXT).trim() || FIRST_FREE_ART_VIDEO_CONTEXT;
    const watchedSeconds = Number(details.tempo_assistido_segundos || details.segundos || 0);
    const percentFromName = Number((eventName.match(/_(25|50|75|100)$/) || [])[1] || 0);
    const percent = Math.max(percentFromName, Number(details.percentual || 0) || 0);
    const shouldMarkStarted =
      eventName === "mobile_video_marketing_iniciado" ||
      percent > 0 ||
      (eventName === "mobile_video_marketing_abandonou" && watchedSeconds > 0);

    if (!shouldMarkStarted) return;

    if (!views) views = readMarketingVideoViews();
    const key = marketingVideoViewKey(videoId, version, context);
    const userViews = views[userId] && typeof views[userId] === "object" ? views[userId] : {};
    const record = userViews[key] && typeof userViews[key] === "object" ? userViews[key] : {};

    record.video_id = videoId;
    record.versao = version;
    record.contexto = context;
    record.last_seen_at = atIso;
    record.last_event = eventName;
    record.max_percent = Math.max(Number(record.max_percent || 0), percent);
    record.last_watched_seconds = Math.max(Number(record.last_watched_seconds || 0), watchedSeconds);

    if (!record.started_at) record.started_at = atIso;
    if (eventName === "mobile_video_marketing_iniciado") {
      record.started_count = Number(record.started_count || 0) + 1;
    }
    if (percent >= 75 && !record.viewed_at) record.viewed_at = atIso;
    if (percent >= 100 && !record.completed_at) record.completed_at = atIso;

    const pedidoId = String(details.pedido_id || details.pedidoId || event?.pedido_id || "").trim();
    if (pedidoId) record.last_pedido_id = pedidoId;

    userViews[key] = record;
    views[userId] = userViews;
    changed = true;
  });

  if (changed) {
    writeMarketingVideoViews(views);
  }
}

function salvarEventosCliente(req, eventos = []) {
  try {
    if (!Array.isArray(eventos) || eventos.length === 0) return;

    const agora = new Date();
    const agoraIso = agora.toISOString();

    const yyyy = agora.getFullYear();
    const mm = String(agora.getMonth() + 1).padStart(2, "0");
    const dd = String(agora.getDate()).padStart(2, "0");

    const analyticsDiaFile = path.join(
      ANALYTICS_DIR,
      `${yyyy}-${mm}-${dd}.json`
    );

    const atuais = readJsonArraySafe(analyticsDiaFile);

    const cliente = req.user ? getClienteResumo(req.user.whatsapp) : null;
    updateMarketingVideoViewsFromEvents(req.user?.whatsapp, eventos, agoraIso);

    if (
      cliente?.nome_time &&
      CLIENTES_TESTE.includes(cliente.nome_time)
    ) {
      return;
    }

    const ultimoEventoPorSessao = {};

    atuais.slice(-300).forEach(ev => {
      if (!ev?.sessao) return;
      ultimoEventoPorSessao[ev.sessao] = ev;
    });

    eventos.forEach(ev => {
      const payload = ev.p || {};
      const pedidoId = String(payload.pedido_id || ev.pedido_id || "").trim();

      const item = {
        data: agoraIso,
        cliente_id: cliente?.cliente_id || "",
        nome_time: cliente?.nome_time || "",
        whatsapp: cliente?.whatsapp || "",
        sessao: ev.sessao || "",
        evento: ev.e || "",
        produto: ev.produto || "",
        categoria: ev.categoria || "",
        pedido_id: pedidoId,
        pagina: ev.url || "",
        logado: !!ev.logado,

        campo_atual: payload.campo_atual || "",
        ultima_acao: payload.ultima_acao || "",
        tempo_inativo_ms: Number(payload.tempo_inativo_ms || 0),

        payload
      };

      const ultimo = ultimoEventoPorSessao[item.sessao];

      if (
        item.evento === "campo_foco" &&
        ultimo &&
        ultimo.evento === "campo_foco" &&
        ultimo.campo_atual === item.campo_atual
      ) {
        return;
      }

      if (
        item.evento === "click_interface" &&
        ultimo &&
        ultimo.evento === "click_interface" &&
        ultimo.campo_atual === item.campo_atual &&
        (new Date(item.data).getTime() - new Date(ultimo.data).getTime()) < 2000
      ) {
        return;
      }

      if (
        item.evento === "usuario_inativo"
      ) {
        const tempo = Number(item.tempo_inativo_ms || 0);

        const faixa =
          tempo >= 900000 ? "15m" :
          tempo >= 300000 ? "5m" :
          tempo >= 60000 ? "1m" :
          "0";

        item.faixa_inatividade = faixa;

        if (
          ultimo &&
          ultimo.evento === "usuario_inativo" &&
          ultimo.faixa_inatividade === faixa
        ) {
          return;
        }
      }

      atuais.push(item);
      ultimoEventoPorSessao[item.sessao] = item;

      if (pedidoId) {
        try {
          const basePedido = getPedidoBaseGlobal(pedidoId);

          if (basePedido) {
            const eventosPedidoFile = path.join(basePedido, "eventos_cliente.json");
            const eventosPedido = readJsonArraySafe(eventosPedidoFile);

            eventosPedido.push(item);

            const limitePedido = 500;

            if (eventosPedido.length > limitePedido) {
              eventosPedido.splice(0, eventosPedido.length - limitePedido);
            }

            writeJsonSafe(eventosPedidoFile, eventosPedido);
          }
        } catch {}
      }
    });

    const limite = 50000;

    if (atuais.length > limite) {
      atuais.splice(0, atuais.length - limite);
    }

    writeJsonSafe(analyticsDiaFile, atuais);

    const resumo = {
      atualizado_em: agoraIso,
      total_eventos: atuais.length,
      visitas: atuais.filter(e => e.evento === "pagina_aberta").length,
      pedidos_concluidos: atuais.filter(e => e.evento === "pedido_concluido").length,
      downloads: atuais.filter(e => e.evento === "baixou_imagem").length,
      suporte: atuais.filter(e => e.evento === "abriu_suporte").length,
      erros: atuais.filter(e => String(e.evento || "").includes("erro")).length
    };

    writeJsonSafe(
      path.join(ANALYTICS_DIR, "analytics_resumo.json"),
      resumo
    );

  } catch {}
}

function sanitizeServerAnalyticsPayload(payload = {}) {
  const sensitiveParts = [
    "telefone",
    "phone",
    "whatsapp",
    "email",
    "senha",
    "password",
    "token",
    "authorization",
    "auth",
    "pix",
    "copia_cola",
    "copiaecola",
    "prompt",
    "image",
    "imagem",
    "foto",
    "url",
    "uri",
    "base64"
  ];

  return Object.entries(payload || {}).reduce((safe, [key, value]) => {
    const normalizedKey = String(key || "").toLowerCase();
    if (!normalizedKey || sensitiveParts.some((part) => normalizedKey.includes(part))) {
      return safe;
    }

    if (value === null || value === undefined) {
      return safe;
    }

    if (["string", "number", "boolean"].includes(typeof value)) {
      safe[key] = typeof value === "string" ? value.slice(0, 160) : value;
    }

    return safe;
  }, {});
}

function registrarEventoServidor(evento, options = {}) {
  try {
    const eventName = String(evento || "").trim();
    if (!eventName) return;

    const whatsapp = String(options.whatsapp || "").trim();
    const pedidoId = String(options.pedidoId || options.pedido_id || "").trim();
    const payload = sanitizeServerAnalyticsPayload({
      origem: "backend",
      ...options.payload,
      pedido_id: pedidoId
    });

    salvarEventosCliente(
      { user: whatsapp ? { whatsapp } : null },
      [{
        e: eventName,
        sessao: `server_${Date.now()}_${Math.random().toString(16).slice(2)}`,
        t: Date.now(),
        produto: String(options.produto || "").trim(),
        categoria: String(options.categoria || "").trim(),
        logado: Boolean(whatsapp),
        p: payload
      }]
    );
  } catch {}
}

function getClienteResumo(whatsapp) {
  const clientes = readClientes();
  const c = clientes[whatsapp] || {};

  return {
    whatsapp,
    cliente_id: whatsapp,
    nome_time: c.nome_time || "",
    login_tipo: c.login_tipo || "whatsapp",
    email: c.email || "",
    foto_google: c.foto_google || "",
    saldo: Number(c.saldo_mensal || 0) + Number(c.saldo_extra || 0),
    usados_no_ciclo: Number(c.usados_no_ciclo || 0)
  };
}

function registrarOnline(req, extra = {}) {
  try {
    if (!req.user || !req.user.whatsapp) return;

    const online = safeReadJson(ONLINE_FILE) || {};
    const whatsapp = req.user.whatsapp;
    const cliente = getClienteResumo(whatsapp);

    online[whatsapp] = {
      ...cliente,
      online: true,
      ultima_atividade: new Date().toISOString(),
      pagina_atual: extra.pagina_atual || req.headers["x-ia4-page"] || "",
      produto_atual: extra.produto_atual || req.headers["x-ia4-product"] || "",
      chat_aberto: String(extra.chat_aberto ?? req.headers["x-ia4-chat"] ?? "") === "true",
      ultima_acao: extra.ultima_acao || req.headers["x-ia4-action"] || ""
    };

    fs.writeFileSync(ONLINE_FILE, JSON.stringify(online, null, 2), "utf8");
  } catch {}
}

function listarOnlineRecentes() {
  const online = safeReadJson(ONLINE_FILE) || {};
  const eventos = readJsonArraySafe(EVENTOS_CLIENTES_FILE);

  const agora = Date.now();
  const limiteMs = 2 * 60 * 1000;

  const usuarios = Object.values(online)
    .filter(u => {
      const t = new Date(u.ultima_atividade || 0).getTime();
      return t && agora - t <= limiteMs;
    })
    .sort((a, b) => new Date(b.ultima_atividade) - new Date(a.ultima_atividade));

  return usuarios.map(u => {
    const ultimos = eventos
      .filter(ev => ev.whatsapp === u.whatsapp)
      .slice(-30);

    const ultimo = ultimos[ultimos.length - 1] || {};

    return {
      ...u,
      campo_atual: ultimo.campo_atual || "",
      ultima_acao_evento: ultimo.ultima_acao || "",
      tempo_inativo_ms: Number(ultimo.tempo_inativo_ms || 0),
      ultimo_evento: ultimo.evento || ""
    };
  });
}

function salvarMensagemSuporteAberta(whatsapp, mensagemCliente, respostaIA, origem = "ia") {
  finalizarConversasSuporteInativas();

  const abertas = readJsonArraySafe(SUPORTE_ABERTAS_FILE);
  const cliente = getClienteResumo(whatsapp);

  let conversa = abertas.find(c => c.whatsapp === whatsapp && !c.finalizada);

  if (!conversa) {
    conversa = {
      id: `${whatsapp}_${Date.now()}`,
      whatsapp,
      cliente,
      inicio: new Date().toISOString(),
      finalizada: false,
      status: "aberta",
      precisa_humano: false,
      cliente_leu: false,
      mensagens: []
    };
    abertas.push(conversa);
  }

  conversa.cliente = cliente;
  conversa.ultima_atualizacao = new Date().toISOString();

  if (mensagemCliente && String(mensagemCliente).trim()) {
    conversa.mensagens.push({
      id: `${Date.now()}_cliente`,
      data: new Date().toISOString(),
      autor: "cliente",
      texto: String(mensagemCliente || "").trim()
    });

    conversa.cliente_leu = true;
  }

  if (respostaIA && String(respostaIA).trim()) {
    conversa.mensagens.push({
      id: `${Date.now()}_${origem}`,
      data: new Date().toISOString(),
      autor: origem,
      texto: String(respostaIA || "").trim()
    });

    conversa.cliente_leu = false;
  }

  writeJsonSafe(SUPORTE_ABERTAS_FILE, abertas);
  return conversa;
}

function finalizarConversaSuporte(whatsapp, motivo) {
  const abertasPath = SUPORTE_ABERTAS_FILE;
  const finalizadasPath = SUPORTE_FINALIZADAS_FILE;

  const abertas = readJsonArraySafe(abertasPath);
  const finalizadas = readJsonArraySafe(finalizadasPath);

  const idx = abertas.findIndex(c => c.whatsapp === whatsapp && !c.finalizada);

  if (idx === -1) return false;

  const conversa = abertas[idx];
  conversa.finalizada = true;
  conversa.fim = new Date().toISOString();
  conversa.motivo_finalizacao = motivo || "finalizacao_automatica";

  finalizadas.push(conversa);
  abertas.splice(idx, 1);

  writeJsonSafe(abertasPath, abertas);
  writeJsonSafe(finalizadasPath, finalizadas);

  return true;
}

function finalizarConversasSuporteInativas() {
  const abertasPath = SUPORTE_ABERTAS_FILE;
  const finalizadasPath = SUPORTE_FINALIZADAS_FILE;

  const abertas = readJsonArraySafe(abertasPath);
  if (abertas.length === 0) return;

  const finalizadas = readJsonArraySafe(finalizadasPath);
  const agora = Date.now();
  const limiteMs = 10 * 60 * 1000;

  const aindaAbertas = [];

  for (const conversa of abertas) {
    const ultima = new Date(conversa.ultima_atualizacao || conversa.inicio || 0).getTime();

    if (ultima && agora - ultima >= limiteMs) {
      conversa.finalizada = true;
      conversa.fim = new Date().toISOString();
      conversa.motivo_finalizacao = "inatividade_10_minutos";
      finalizadas.push(conversa);
    } else {
      aindaAbertas.push(conversa);
    }
  }

  writeJsonSafe(abertasPath, aindaAbertas);
  writeJsonSafe(finalizadasPath, finalizadas);
}

function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";

  if (!token) {
    return res.status(401).json({ ok: false, error: "Sem token" });
  }

  try {
    req.user = jwt.verify(token, JWT_SECRET, {
      algorithms: ["HS256"]
    });
    return next();
  } catch {
    return res.status(401).json({ ok: false, error: "Token inválido" });
  }
}

function botRunnerAuth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";

  if (!token) {
    return res.status(401).json({ ok: false, error: "Sem token" });
  }

  if (BOT_RUNNER_TOKEN && token === BOT_RUNNER_TOKEN) {
    req.user = {
      whatsapp: BOT_ADMIN_WHATSAPP,
      bot_runner: true
    };
    return next();
  }

  try {
    req.user = jwt.verify(token, JWT_SECRET, {
      algorithms: ["HS256"]
    });

    if (!isBotAdmin(req)) {
      return res.status(403).json({ ok: false, error: "Acesso negado" });
    }

    return next();
  } catch {
    return res.status(401).json({ ok: false, error: "Token inválido" });
  }
}

// ===== UPLOAD (multer) =====
const TMP_UPLOAD_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const TMP_UPLOAD_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

function flattenUploadedFiles(files = {}) {
  return Object.values(files).flat().filter(Boolean);
}

function cleanupUploadedFiles(files = {}) {
  for (const file of flattenUploadedFiles(files)) {
    try {
      if (file?.path && file.path.startsWith(TMP_UPLOADS_DIR) && fs.existsSync(file.path)) {
        fs.unlinkSync(file.path);
      }
    } catch (error) {
      console.warn("[uploads] falha ao remover temporario da requisicao", {
        path: file?.path,
        message: error?.message
      });
    }
  }
}

function cleanupOldTmpUploads() {
  try {
    ensureDir(TMP_UPLOADS_DIR);
    const now = Date.now();
    let removed = 0;
    let freedBytes = 0;

    for (const entry of fs.readdirSync(TMP_UPLOADS_DIR, { withFileTypes: true })) {
      if (!entry.isFile()) continue;

      const filePath = path.join(TMP_UPLOADS_DIR, entry.name);
      const stat = fs.statSync(filePath);

      if (now - stat.mtimeMs < TMP_UPLOAD_MAX_AGE_MS) continue;

      fs.unlinkSync(filePath);
      removed += 1;
      freedBytes += stat.size;
    }

    if (removed > 0) {
      console.log("[uploads] limpeza tmp_uploads", {
        removed,
        freed_mb: Number((freedBytes / 1024 / 1024).toFixed(2))
      });
    }
  } catch (error) {
    console.warn("[uploads] falha na limpeza tmp_uploads", {
      message: error?.message
    });
  }
}

const storage = multer.diskStorage({
  destination: (req, file, cb) =>
    cb(null, TMP_UPLOADS_DIR),

  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^\w.\-]+/g, "_");
    cb(null, `${Date.now()}_${safe}`);
  }
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const permitidos = [
      "image/png",
      "image/jpeg",
      "image/jpg",
      "image/webp"
    ];

    if (!permitidos.includes(String(file.mimetype || "").toLowerCase())) {
      return cb(new Error("Apenas imagens PNG, JPG e WEBP são permitidas."));
    }

    cb(null, true);
  }
});

const productDiscoveryUpload = multer({
  storage,
  limits: {
    files: 1,
    fields: 1,
    // Busboy emits LIMIT_PART_COUNT when the configured count is reached.
    // Keep files/fields strict while allowing one image plus ramo_contexto.
    parts: 3,
    fieldSize: 512,
    fileSize: 3 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    const permitidos = ["image/png", "image/jpeg", "image/jpg", "image/webp"];
    if (!permitidos.includes(String(file.mimetype || "").toLowerCase())) {
      return cb(new Error("Apenas imagens PNG, JPG e WEBP são permitidas."));
    }
    return cb(null, true);
  }
});

const uploadResultado = multer({ storage });
const uploadMonthlyPlanningResult = multer({ storage, limits: { files: 2, fields: 2, parts: 5,
  fieldSize: 1024 * 1024, fileSize: 100000000 } });

const PEDIDO_UPLOAD_FIELDS = [
  { name: "escudo1", maxCount: 1 },
  { name: "escudo2", maxCount: 1 },
  { name: "mascote", maxCount: 1 },
  { name: "patrocinadores", maxCount: 20 },
  { name: "logo", maxCount: 1 },
  { name: "fotos", maxCount: 20 },
  { name: "referencias", maxCount: 20 },
  { name: "modelo_existente", maxCount: 1 }
];

const MONTHLY_PLANNING_REQUEST_MAX_ITEMS = Math.max(
  1,
  Number(monthlyPlanningService._private?.MAX_MONTHLY_PLANNING_REQUEST_ITEMS || 20) || 20
);
const MONTHLY_PLANNING_UPLOAD_FIELDS = PEDIDO_UPLOAD_FIELDS.map((field) => (
  field.name === "fotos"
    ? { ...field, maxCount: Math.max(field.maxCount, MONTHLY_PLANNING_REQUEST_MAX_ITEMS) }
    : field
));
const productDiscoveryInFlight = new Set();

app.use("/bot/free-art-campaigns", createFreeArtCampaignRoutes({
  service: freeArtCampaignsService,
  storage: freeArtCampaignsStorage,
  uploadResultado,
  config: {
    enabled: adminFreeArtsEnabled,
    maxArts: adminFreeArtsMaxArts,
    stuckTimeoutMs: adminFreeArtsGeneratingTimeoutMs,
    stuckAction: adminFreeArtsStuckAction
  },
  paths: {
    baseDir: FREE_ART_CAMPAIGNS_DIR,
    pedidosDir: PEDIDOS_DIR,
    panelFile: ADMIN_FREE_ART_CAMPAIGNS_FILE
  },
  auth: botAdminAuth,
  botRunnerAuth,
  isBotAdmin,
  readClientes,
  cleanupUploadedFiles,
  composeLogo: composeFreeArtLogo
}));

// ===== ROTAS =====

// Health check
app.get("/", (req, res) => {
  res.json({ ok: true, msg: "omascote-api online" });
});

function envInt(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function envBool(name, fallback = false) {
  const value = String(process.env[name] || "").trim().toLowerCase();
  if (["1", "true", "yes", "sim", "on"].includes(value)) return true;
  if (["0", "false", "no", "nao", "n\u00e3o", "off"].includes(value)) return false;
  return fallback;
}

function adminFreeArtsEnabled() {
  return envBool("IA4TUBE_ADMIN_FREE_ARTS_ENABLED", false);
}

function adminFreeArtsNotificationsEnabled() {
  return adminFreeArtsEnabled() && envBool("IA4TUBE_ADMIN_FREE_ARTS_NOTIFICATIONS_ENABLED", false);
}

function adminFreeArtsMaxArts() {
  return Math.max(1, Math.min(envInt("IA4TUBE_ADMIN_FREE_ARTS_MAX_ARTS", 20), 20));
}

function adminFreeArtsGeneratingTimeoutMs() {
  return Math.max(
    60 * 1000,
    envInt("IA4TUBE_ADMIN_FREE_ARTS_GENERATING_TIMEOUT_MS", 30 * 60 * 1000)
  );
}

function adminFreeArtsStuckAction() {
  const action = String(process.env.IA4TUBE_ADMIN_FREE_ARTS_STUCK_ACTION || "pendente").trim().toLowerCase();
  return action === "erro" ? "erro" : "pendente";
}

function adminFreeArtsRecoveryIntervalMs() {
  return Math.max(
    60 * 1000,
    envInt("IA4TUBE_ADMIN_FREE_ARTS_RECOVERY_INTERVAL_MS", 5 * 60 * 1000)
  );
}

function adminFreeArtsNotificationsIntervalMs() {
  return Math.max(
    30 * 1000,
    envInt("IA4TUBE_ADMIN_FREE_ARTS_NOTIFICATIONS_INTERVAL_MS", 60 * 1000)
  );
}

function isAdminFreeArtOrderHidden(pedido = {}) {
  return freeArtCampaignsService.isFreeArtOrder(pedido) && !adminFreeArtsEnabled();
}

function sendHiddenAdminFreeArtOrder(res) {
  return res.status(404).json({
    ok: false,
    code: "admin_free_arts_disabled",
    error: "Pedido nao encontrado"
  });
}

function composeFreeArtLogo({ baseImagePath, logoPath, outputPath }) {
  const scriptPath = path.join(__dirname, "scripts", "compose_free_art_logo.py");
  if (!fs.existsSync(scriptPath)) {
    return { ok: false, error: "compose_script_not_found" };
  }

  const result = spawnSync("python", [
    scriptPath,
    "--base", baseImagePath,
    "--logo", logoPath,
    "--out", outputPath
  ], {
    cwd: __dirname,
    encoding: "utf8",
    timeout: 30 * 1000
  });

  if (result.status !== 0) {
    return {
      ok: false,
      error: result.stderr || result.stdout || "compose_failed"
    };
  }

  return { ok: true, output_path: outputPath };
}

function envMarketingVideo(name, context = "primeira_arte_gratis") {
  const suffix = String(context || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const scopedName = suffix ? `IA4TUBE_MARKETING_VIDEO_${suffix}_${name}` : "";
  return String((scopedName && process.env[scopedName]) || process.env[`IA4TUBE_MARKETING_VIDEO_${name}`] || "").trim();
}

function isHttpMediaUrl(value = "") {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

const FIRST_FREE_ART_VIDEO_CONTEXT = "primeira_arte_gratis";
const DEFAULT_FIRST_FREE_ART_VIDEO_URL = "https://ia4tube.com/videos/primeira-arte-gratis.mp4";
const DEFAULT_FIRST_FREE_ART_THUMBNAIL_URL = "https://ia4tube.com/videos/thumb-primeira-arte-gratis.jpg";

function marketingVideoUrl(context) {
  const configuredVideoUrl = String(process.env.IA4TUBE_MARKETING_VIDEO_URL || "").trim();
  if (configuredVideoUrl) return configuredVideoUrl;
  return context === FIRST_FREE_ART_VIDEO_CONTEXT ? DEFAULT_FIRST_FREE_ART_VIDEO_URL : "";
}

function marketingVideoThumbnailUrl(context) {
  const configuredThumbnailUrl = envMarketingVideo("THUMBNAIL", context);
  if (configuredThumbnailUrl) return configuredThumbnailUrl;
  return context === FIRST_FREE_ART_VIDEO_CONTEXT ? DEFAULT_FIRST_FREE_ART_THUMBNAIL_URL : "";
}

app.get("/app/version", (req, res) => {
  const latestVersionCode = envInt("IA4TUBE_ANDROID_LATEST_VERSION_CODE", 5);
  const minimumVersionCode = envInt("IA4TUBE_ANDROID_MINIMUM_VERSION_CODE", 1);
  const latestVersionName = process.env.IA4TUBE_ANDROID_LATEST_VERSION_NAME || "0.1.0";

  return res.json({
    ok: true,
    latest_version_code: latestVersionCode,
    minimum_version_code: minimumVersionCode,
    latest_version_name: latestVersionName,
    update_required: envBool("IA4TUBE_ANDROID_UPDATE_REQUIRED", false),
    title: process.env.IA4TUBE_ANDROID_UPDATE_TITLE || "Nova vers\u00e3o dispon\u00edvel",
    message: process.env.IA4TUBE_ANDROID_UPDATE_MESSAGE ||
      "Atualize o app para receber melhorias, corre\u00e7\u00f5es e uma experi\u00eancia mais est\u00e1vel.",
    play_store_url: process.env.IA4TUBE_ANDROID_PLAY_STORE_URL ||
      "https://play.google.com/store/apps/details?id=com.ia4tube.app"
  });
});

app.get("/marketing/video", auth, (req, res) => {
  const context = String(req.query?.context || FIRST_FREE_ART_VIDEO_CONTEXT).trim() || FIRST_FREE_ART_VIDEO_CONTEXT;
  const enabledByFlag = envBool("IA4TUBE_MARKETING_VIDEO_ENABLED", context === FIRST_FREE_ART_VIDEO_CONTEXT);
  const videoUrl = marketingVideoUrl(context);
  const enabled = enabledByFlag && isHttpMediaUrl(videoUrl);
  const thumbnail = marketingVideoThumbnailUrl(context);
  const version = envMarketingVideo("VERSION", context) || new Date().toISOString().slice(0, 10);
  const id = envMarketingVideo("ID", context) || `${context}_${version}`.replace(/[^a-zA-Z0-9_-]+/g, "_");
  const viewStatus = getMarketingVideoViewStatus(req.user?.whatsapp, id, version, context);
  const autoplay = enabled && !viewStatus.ja_visto;

  res.setHeader("Cache-Control", "no-store");

  return res.json({
    ok: true,
    ativo: enabled,
    id,
    context,
    contexto: context,
    titulo: envMarketingVideo("TITLE", context) || "Enquanto sua primeira arte fica pronta...",
    descricao: envMarketingVideo("DESCRIPTION", context) || "Veja como a iA4Tube pode ajudar seu negócio.",
    url_video: enabled ? videoUrl : "",
    thumbnail: isHttpMediaUrl(thumbnail) ? thumbnail : "",
    autoplay,
    ja_visto: viewStatus.ja_visto,
    duracao: envInt("IA4TUBE_MARKETING_VIDEO_DURATION", 0),
    versao: version,
    fallback: "progress_card"
  });
});

app.get("/tempo-estimado", (req, res) => {
  return res.json({
    ok: true,
    ...readTempoEstimado()
  });
});

app.post("/evento", (req, res) => {
  try {
    const eventos = Array.isArray(req.body?.eventos)
      ? req.body.eventos
      : [];

    let clienteFake = null;

    try {
      const h = req.headers.authorization || "";
      const token = h.startsWith("Bearer ") ? h.slice(7) : "";

      if (token) {
        clienteFake = jwt.verify(token, JWT_SECRET, {
          algorithms: ["HS256"]
        });
      }
    } catch {}

    salvarEventosCliente(
      { user: clienteFake },
      eventos
    );

    return res.json({ ok:true });
  } catch {
    return res.status(500).json({
      ok:false,
      error:"erro_eventos"
    });
  }
});

app.post("/bot/tempo-estimado", botRunnerAuth, (req, res) => {
  if (!isBotAdmin(req)) {
    return res.status(403).json({ ok: false, error: "Acesso negado" });
  }

  const payload = req.body || {};

  const tempo = {
    tempo_medio_segundos: Number(payload.tempo_medio_segundos ?? 0),
    tempo_estimado_segundos: Number(payload.tempo_estimado_segundos ?? 0),
    pedidos_na_fila: Number(payload.pedidos_na_fila || 0),
    lotes: Number(payload.lotes || 1),
    max_processos: Number(payload.max_processos || 5),
    atualizado_em: payload.atualizado_em || new Date().toISOString()
  };

  writeTempoEstimado(tempo);

  return res.json({ ok: true });
});

async function verificarGoogleIdToken(id_token) {
  if (!GOOGLE_CLIENT_ID) {
    throw new Error("GOOGLE_CLIENT_ID não configurado");
  }

  const r = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(id_token));
  const data = await r.json();

  if (!r.ok || data.aud !== GOOGLE_CLIENT_ID || !data.sub) {
    throw new Error("Token Google inválido");
  }

  return data;
}

app.get("/auth/google-config", (req, res) => {
  return res.json({
    ok: true,
    client_id: GOOGLE_CLIENT_ID
  });
});

app.post("/auth/google", async (req, res) => {
  try {
    const { id_token } = req.body || {};

    if (!id_token) {
      return res.status(400).json({ ok: false, error: "id_token obrigatório" });
    }

    const google = await verificarGoogleIdToken(id_token);
    const clientes = readClientes();

    const chaveCliente = "google_" + String(google.sub).replace(/[^\w\-]+/g, "");
    const nomeGoogle = google.name || google.given_name || "Meu time";
    const emailGoogle = google.email || "";

    let c = clientes[chaveCliente];

    if (!c) {
      c = {
        nome_time: nomeGoogle,
        senha_hash: "",
        login_tipo: "google",
        google_id: google.sub,
        email: emailGoogle,
        foto_google: google.picture || "",
        plano: 0,
        saldo_mensal: 0,
        saldo_extra: 0,
        artes_avulsas_restantes: 0,
        artes_avulsas_usadas: 0,
        artes_avulsas_total_compradas: 0,
        artes_avulsas_compras: [],
        artes_avulsas_consumos: [],
        usados_no_ciclo: 0,
        ciclo_mes: nowYYYYMM(),
        ativo: true
      };
      billingService.markFreeArtEligible(c);

      clientes[chaveCliente] = c;
      writeClientes(clientes);
    }

    const mesAtual = nowYYYYMM();
    if (c.ciclo_mes !== mesAtual) {
      c.ciclo_mes = mesAtual;
      c.usados_no_ciclo = 0;
      clientes[chaveCliente] = c;
      writeClientes(clientes);
    }

    await productionSocialIntegration.afterAuthentication(chaveCliente);
    const token = productionSession.sign(chaveCliente);

    return res.json({
      ok: true,
      token,
      nome_time: c.nome_time,
      plano: c.plano,
      saldo_mensal: Number(c.saldo_mensal || 0),
      saldo_extra: Number(c.saldo_extra || 0),
      ...billingService.getStandaloneArtStatus(c),
      saldo: Number(c.saldo_mensal || 0) + Number(c.saldo_extra || 0),
      usados_no_ciclo: c.usados_no_ciclo
    });

  } catch (e) {
    return res.status(401).json({
      ok: false,
      error: e.message || "Erro ao entrar com Google"
    });
  }
});

// Login automático invisível
app.post("/auth/auto-register", async (req, res) => {
  try {
    const body = req.body || {};
    const clientes = readClientes();

    const nome_time = String(
      body.nome_time ||
      body.nome_jogador ||
      body.login ||
      "Jogador"
    ).trim();

    const produtoOrigem = String(body.produto || "");
    const creditoPreviewInterno = ge…29242 tokens truncated…payerEmail
      },
      external_reference: `pedido_pix|${whatsapp}|${id}|${Date.now()}`,
      metadata: {
        tipo: "pedido_pix",
        whatsapp,
        pedido_id: id,
        valor_pendente: Number(valorPendente.toFixed(2))
      },
      notification_url: "https://ia4tube-api.onrender.com/webhook/mercadopago"
    };

    const r = await fetch("https://api.mercadopago.com/v1/payments", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${MP_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
        "X-Idempotency-Key": `pedido_pix_${id}_${Date.now()}`
      },
      body: JSON.stringify(paymentPayload)
    });

    const data = await r.json();

    if (!r.ok) {
      return res.status(500).json({ ok: false, error: "Erro ao gerar Pix", detalhe: data });
    }

    const transactionData = data.point_of_interaction?.transaction_data || {};
    const pixCopiaCola = transactionData.qr_code || "";
    const qrCodeBase64 = transactionData.qr_code_base64 || "";
    const ticketUrl = transactionData.ticket_url || "";

    if (!pixCopiaCola) {
      return res.status(500).json({ ok: false, error: "Mercado Pago nao retornou codigo Pix", detalhe: data });
    }

    pedido.pagamento_metodo_pendente = "pix";
    pedido.mp_payment_id = String(data.id || "");
    pedido.mp_payment_status = data.status || "pending";
    pedido.pix_copia_cola = pixCopiaCola;
    pedido.pix_qr_code_base64 = qrCodeBase64;
    pedido.pix_ticket_url = ticketUrl;
    pedido.pix_gerado_em = new Date().toISOString();

    fs.writeFileSync(pedidoPath, JSON.stringify(pedido, null, 2), "utf8");

    return res.json({
      ok: true,
      pix_copia_cola: pixCopiaCola,
      qr_code_base64: qrCodeBase64,
      ticket_url: ticketUrl,
      payment_id: pedido.mp_payment_id
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Erro interno ao gerar Pix" });
  }
});

app.get("/pedidos/:id/pagamento-info", auth, (req, res) => {
  const whatsapp = req.user.whatsapp;
  const base = getPedidoBase(whatsapp, req.params.id);

  if (!base) {
    return res.status(404).json({ ok: false, error: "Pedido nao encontrado" });
  }

  const pedidoPath = path.join(base, "pedido.json");
  const pedido = safeReadJson(pedidoPath) || {};

  if (isAdminFreeArtOrderHidden(pedido)) {
    return sendHiddenAdminFreeArtOrder(res);
  }

  return res.json({
    ok: true,
    pagamento_pendente: pedido.pagamento_pendente === true,
    valor_pendente: Number(pedido.valor_pendente || 0),
    mp_payment_status: pedido.mp_payment_status || "",
    pix_copia_cola: pedido.pix_copia_cola || "",
    qr_code_base64: pedido.pix_qr_code_base64 || "",
    ticket_url: pedido.pix_ticket_url || "",
    payment_id: pedido.mp_payment_id || ""
  });
});

app.post("/pedidos/:id/aprovar", auth, (req, res) => {
  const whatsapp = req.user.whatsapp;
  const base = getPedidoBase(whatsapp, req.params.id);

  if (!base) {
    return res.status(404).json({ ok: false, error: "Pedido não encontrado" });
  }

  const pedidoPath = path.join(base, "pedido.json");
  const pedido = safeReadJson(pedidoPath) || {};

  if (isAdminFreeArtOrderHidden(pedido)) {
    return sendHiddenAdminFreeArtOrder(res);
  }

  if (freeArtCampaignsService.isFreeArtOrder(pedido)) {
    return res.status(403).json({
      ok: false,
      code: "free_art_weekly_edit_blocked",
      error: "A Arte Gratis da Semana nao entra no fluxo normal de aprovacao."
    });
  }

  pedido.aprovado_cliente = true;
  pedido.baixado_cliente = false;
  pedido.aprovado_em = new Date().toISOString();

  fs.writeFileSync(pedidoPath, JSON.stringify(pedido, null, 2), "utf8");

  const clientes = readClientes();
  const cliente = clientes[whatsapp];
  const imagemPronta = fs.existsSync(path.join(base, "resultado_final.png")) ||
    (pedido.resultado_mime === "video/mp4" && fs.existsSync(path.join(base, "resultado_final.mp4")));
  const pagamentoPendente = pedido.pagamento_pendente === true;
  const downloadBloqueado = imagemPronta && !pagamentoPendente && downloadBloqueadoPorCadastro(cliente);

  return res.json({
    ok: true,
    aprovado_cliente: true,
    pode_baixar: imagemPronta && !pagamentoPendente && !downloadBloqueado,
    download_bloqueado: downloadBloqueado,
    mensagem_download_bloqueado: downloadBloqueado ? mensagemDownloadBloqueado(cliente) : ""
  });
});

app.post("/pedidos/:id/solicitar-ajuste", auth, (req, res) => {
  const whatsapp = req.user.whatsapp;
  const base = getPedidoBase(whatsapp, req.params.id);

  if (!base) {
    return res.status(404).json({ ok: false, error: "Pedido não encontrado" });
  }

  const motivo = String(req.body?.motivo_ajuste || req.body?.motivo || "").trim();

  if (!motivo || motivo.length < 5) {
    return res.status(400).json({ ok: false, error: "Descreva melhor o ajuste." });
  }

  const pedidoPath = path.join(base, "pedido.json");
  const pedido = safeReadJson(pedidoPath) || {};

  if (isAdminFreeArtOrderHidden(pedido)) {
    return sendHiddenAdminFreeArtOrder(res);
  }

  if (freeArtCampaignsService.isFreeArtOrder(pedido)) {
    return res.status(403).json({
      ok: false,
      code: "free_art_weekly_edit_blocked",
      error: "A Arte Gratis da Semana nao entra no fluxo de ajustes nesta versao."
    });
  }

  if (pedido.ajuste_automatico_usado === true) {
    const conversa = salvarMensagemSuporteAberta(
      whatsapp,
      `Pedido ${req.params.id}: ${motivo}`,
      "Esse pedido já usou o ajuste automático. Vou encaminhar para o suporte.",
      "sistema"
    );

    conversa.precisa_humano = true;
    conversa.status = "aguardando_suporte";
    conversa.ultima_atualizacao = new Date().toISOString();

    const abertas = readJsonArraySafe(SUPORTE_ABERTAS_FILE);
    const idx = abertas.findIndex(c => c.id === conversa.id);
    if (idx >= 0) {
      abertas[idx] = conversa;
      writeJsonSafe(SUPORTE_ABERTAS_FILE, abertas);
    }

    return res.json({
      ok: true,
      modo_humano: true,
      conversa_id: conversa.id
    });
  }

  const resultadoAtual = path.join(base, "resultado_final.png");
  const resultadoBackup = path.join(base, "resultado_final_anterior.png");

  try {
    if (fs.existsSync(resultadoAtual)) {
      fs.copyFileSync(resultadoAtual, resultadoBackup);
    }
  } catch {}

  pedido.ajuste_automatico_usado = true;
  pedido.motivo_ajuste = motivo;
  pedido.aprovado_cliente = false;
  pedido.status = "ajuste_pendente";
  pedido.ajuste_solicitado_em = new Date().toISOString();

  fs.writeFileSync(pedidoPath, JSON.stringify(pedido, null, 2), "utf8");
  writeOrderStatus(base, orderStatus.ORDER_STATUS.AJUSTE_PENDENTE);
  fs.writeFileSync(path.join(base, "ajuste_pendente.txt"), motivo, "utf8");

  return res.json({
    ok: true,
    modo_humano: false,
    status: "ajuste_pendente"
  });
});

app.get("/pedidos/:id/download-resultado", auth, (req, res) => {
  const whatsapp = req.user.whatsapp;
  const base = getPedidoBase(whatsapp, req.params.id);

  if (!base) {
    return res.status(404).json({ ok: false, error: "Pedido não encontrado" });
  }

  const pedidoPath = path.join(base, "pedido.json");
  const pedido = safeReadJson(pedidoPath) || {};

  if (isAdminFreeArtOrderHidden(pedido)) {
    return sendHiddenAdminFreeArtOrder(res);
  }

  if (pedido.pagamento_pendente === true) {
    return res.status(403).json({
      ok: false,
      error: "Pagamento pendente. Desbloqueie esta imagem para baixar em alta qualidade."
    });
  }

  const clientes = readClientes();
  const cliente = clientes[whatsapp];

  if (cliente?.cadastro_automatico === true && cliente?.conta_finalizada !== true) {
    return res.status(403).json({
      ok: false,
      error: "Crie seu login e senha para liberar o download."
    });
  }

  const video = pedido.resultado_mime === "video/mp4";
  const arquivo = path.join(base, video ? "resultado_final.mp4" : "resultado_final.png");

  if (!fs.existsSync(arquivo)) {
    return res.status(404).json({ ok: false, error: "Resultado final não encontrado" });
  }

  pedido.baixado_cliente = true;
  pedido.baixado_em = new Date().toISOString();

  try {
    fs.writeFileSync(pedidoPath, JSON.stringify(pedido, null, 2), "utf8");
  } catch {}

  res.setHeader("Content-Type", video ? "video/mp4" : "image/png");
  res.setHeader("Content-Disposition", `attachment; filename="${req.params.id}_resultado.${video ? "mp4" : "png"}"`);

  return res.sendFile(arquivo);
});

function normalizarLinhaDescricaoInstagram(texto = "") {
  return String(texto || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[,:.;!?\-\u2013\u2014]+$/g, "")
    .trim();
}

function pedidoEhPatrocinador(pedido = {}) {
  const contexto = [
    pedido.product_id,
    pedido.categoria,
    pedido.objetivo,
    pedido.rodada,
    pedido.tipo_arte
  ].map((valor) => String(valor || "").toLowerCase()).join(" ");

  return contexto.includes("patrocin");
}

function removerHashtagsPatrocinador(linha = "") {
  return String(linha || "")
    .split(/\s+/)
    .filter((parte) => {
      const normalizada = normalizarLinhaDescricaoInstagram(parte);
      return normalizada !== "#patrocinador" && normalizada !== "#patrocinadores";
    })
    .join(" ")
    .trim();
}

function sanitizarDescricaoInstagram(texto = "", pedido = {}) {
  const linhas = String(texto || "")
    .split(/\r?\n/)
    .map((linha) => linha.trim())
    .filter(Boolean);

  if (!linhas.length) return "";

  const rotulos = new Set([
    "descricao para instagram",
    "descricao para postagem",
    "legenda para instagram",
    "sugestao de descricao",
    "sugestao de legenda",
    "caption",
    "instagram caption",
    "resultado",
    "proximo jogo",
    "escalacao",
    "contratacao",
    "dia de treino"
  ]);
  const podeUsarPatrocinador = pedidoEhPatrocinador(pedido);
  return linhas.filter((linha) => {
    const normalizada = normalizarLinhaDescricaoInstagram(linha);
    if (rotulos.has(normalizada)) return false;
    if (normalizada === "patrocinador" || normalizada === "patrocinadores") return false;
    return true;
  }).map((linha) => {
    if (podeUsarPatrocinador) return linha;
    return removerHashtagsPatrocinador(linha);
  }).filter(Boolean).join("\n").trim();
}

function descricaoPostagemPedido(pedido = {}) {
  const pronta = sanitizarDescricaoInstagram(pedido.descricao_instagram || "", pedido);
  if (pronta && !descricaoPostagemGenerica(pronta)) return pronta;

  const nome = String(pedido.nome_empresa || pedido.data || "").trim();
  const ramo = String(pedido.ramo || "").trim();
  const tipo = String(pedido.product_id || pedido.categoria || "arte").replace(/_/g, " ").trim();
  const objetivo = String(pedido.objetivo || pedido.rodada || "").trim();
  const frase = String(pedido.frase_foto || pedido.oferta || objetivo || "").trim();
  const cta = String(pedido.cta || "").trim();
  const historia = String(pedido.historia_empresa || "").trim();
  const insta = String(pedido.instagram || "").trim();
  const whatsapp = String(pedido.whatsapp_contato || "").trim();
  const contexto = [ramo, tipo, objetivo, frase].join(" ").toLowerCase();
  const marca = nome || ramo || "sua marca";
  const linhas = [];

  if (contexto.includes("marketing") || contexto.includes("redes") || contexto.includes("divulg")) {
    linhas.push(`${marca}: sua empresa precisa aparecer melhor para vender mais e ser lembrada pelo cliente certo.`);
    linhas.push(frase || "Criamos artes profissionais para divulgar produtos, servicos e promocoes com mais impacto.");
  } else if (contexto.includes("lava") || contexto.includes("automot") || contexto.includes("carro")) {
    linhas.push(`${marca}: carro limpo, cuidado no detalhe e atendimento caprichado para deixar seu veiculo com cara de novo.`);
  } else if (
    contexto.includes("futebol") ||
    contexto.includes("jogo") ||
    contexto.includes("time") ||
    contexto.includes("torcida") ||
    contexto.includes("escala")
  ) {
    linhas.push(`${marca} em campo com energia total. E dia de apoiar, vibrar e mostrar a forca da torcida.`);
  } else if (frase) {
    linhas.push(`${marca} apresenta: ${frase}`);
  } else if (ramo) {
    linhas.push(`${marca} traz uma novidade especial para quem procura ${ramo.toLowerCase()} com qualidade e atendimento de verdade.`);
  } else {
    linhas.push(`${marca} preparou uma novidade especial para voce conhecer hoje.`);
  }

  if (historia) linhas.push(historia.length > 180 ? `${historia.slice(0, 177)}...` : historia);
  linhas.push(cta || "Chame agora e veja como podemos te atender.");
  if (whatsapp) linhas.push(`WhatsApp: ${whatsapp}`);
  if (insta) linhas.push(insta.startsWith("@") ? insta : `@${insta}`);
  linhas.push("#IA4Tube #ArteComIA");

  return sanitizarDescricaoInstagram(linhas.join("\n"), pedido);
}

function descricaoPostagemGenerica(texto = "") {
  const normalizada = normalizarLinhaDescricaoInstagram(String(texto).trim())
    .replace(/\s+/g, " ");
  return !normalizada ||
    normalizada.includes("pedido ia4tube") ||
    normalizada.includes("arte pronta") ||
    normalizada.includes("arte profissional para sua marca") ||
    normalizada.includes("apresentamos novidades") ||
    normalizada.includes("fique de olho nas proximas") ||
    normalizada.includes("acompanhe para saber mais") ||
    normalizada === "#ia4tube #artecomia";
}

// ===== INFO DO PEDIDO =====
app.get("/pedidos/:id/info", auth, (req, res) => {
  const whatsapp = req.user.whatsapp;
  const base = getPedidoBase(whatsapp, req.params.id);

  if (!base) {
    return res.status(404).json({ ok: false, error: "Pedido não encontrado" });
  }

  const pedidoJsonPath = path.join(base, "pedido.json");

  let pedido = {};
  if (fs.existsSync(pedidoJsonPath)) {
    try {
      pedido = JSON.parse(fs.readFileSync(pedidoJsonPath, "utf8"));
    } catch {}
  }

  if (isAdminFreeArtOrderHidden(pedido)) {
    return sendHiddenAdminFreeArtOrder(res);
  }

  const status = readOrderStatus(base, "novo");
  const video = pedido.resultado_mime === "video/mp4";
  const resultadoFinalPath = path.join(base, video ? "resultado_final.mp4" : "resultado_final.png");

  const imagem_pronta = fs.existsSync(resultadoFinalPath);
  const clientes = readClientes();
  const cliente = clientes[whatsapp];
  const pagamentoPendente = pedido.pagamento_pendente === true;
  const isFreeArtWeekly = freeArtCampaignsService.isFreeArtOrder(pedido);
  const downloadBloqueado = imagem_pronta && !pagamentoPendente && downloadBloqueadoPorCadastro(cliente);

  return res.json({
    ok: true,
    id: req.params.id,
    status,
    categoria: pedido.categoria || "",
    tipo_arte: pedido.product_id || pedido.categoria || "",
    nome_empresa: pedido.nome_empresa || "",
    ramo: pedido.ramo || "",
    objetivo: pedido.objetivo || pedido.rodada || "",
    frase_foto: pedido.frase_foto || "",
    cta: pedido.cta || "",
    whatsapp_contato: pedido.whatsapp_contato || "",
    instagram: pedido.instagram || "",
    historia_empresa: pedido.historia_empresa || "",
    imagem_pronta,
    resultado_mime: video && imagem_pronta ? "video/mp4" : imagem_pronta ? "image/png" : null,
    video_url: video && imagem_pronta ? `/pedidos/${encodeURIComponent(req.params.id)}/download-resultado` : null,
    preview_url: imagem_pronta && !video
      ? `${req.protocol}://${req.get("host")}/pedidos/${req.params.id}/preview`
      : null,
    aprovado_cliente: pedido.aprovado_cliente === true,
    pagamento_pendente: pagamentoPendente,
    valor_pendente: Number(pedido.valor_pendente || 0),
    motivo_pagamento_pendente: pedido.motivo_pagamento_pendente || "",
    cobranca_origem: pedido.cobranca_origem || "",
    tipo_compra: pedido.tipo_compra || "",
    valor_cobrado: Number(pedido.valor_cobrado || 0),
    origem_promocional: pedido.origem_promocional || "",
    origem: pedido.origem || "",
    gratuita_administrativa: pedido.gratuita_administrativa === true,
    bloquear_cobranca: pedido.bloquear_cobranca === true,
    bloquear_edicao: pedido.bloquear_edicao === true,
    campaign_id: pedido.campaign_id || "",
    assignment_id: pedido.assignment_id || "",
    marketing_context: pedido.marketing_context || "",
    arte_gratis: pedido.cobranca_origem === "arte_gratis",
    arte_gratis_semanal: isFreeArtWeekly,
    descricao_instagram: descricaoPostagemPedido(pedido),
    ajuste_automatico_usado: pedido.ajuste_automatico_usado === true,
    motivo_ajuste: pedido.motivo_ajuste || "",
    pode_baixar: imagem_pronta && !pagamentoPendente && !downloadBloqueado,
    download_bloqueado: downloadBloqueado,
    mensagem_download_bloqueado: downloadBloqueado ? mensagemDownloadBloqueado(cliente) : "",
    pode_pedir_ajuste: !isFreeArtWeekly && !video && imagem_pronta && pedido.ajuste_automatico_usado !== true && status === "pronto"
  });
});

// ===== PREVIEW DA IMAGEM FINAL =====
app.get("/pedidos/:id/preview", (req, res) => {
  const pedidoId = req.params.id;

  function procurarPedidoPorId() {
    if (!fs.existsSync(PEDIDOS_DIR)) return null;

    const whatsapps = fs.readdirSync(PEDIDOS_DIR);

    for (const whatsapp of whatsapps) {
      const pastaWhatsapp = path.join(PEDIDOS_DIR, whatsapp);
      if (!fs.statSync(pastaWhatsapp).isDirectory()) continue;

      const meses = fs.readdirSync(pastaWhatsapp);

      for (const mes of meses) {
        const base = path.join(pastaWhatsapp, mes, pedidoId);
        if (fs.existsSync(base)) return base;
      }
    }

    return null;
  }

  const base = procurarPedidoPorId();

  if (!base) {
    return res.status(404).json({ ok: false, error: "Pedido não encontrado" });
  }

  const previewProtegidaPath = path.join(base, "preview_ia4tube.jpg");
  const pedidoPath = path.join(base, "pedido.json");
  const pedido = safeReadJson(pedidoPath) || {};
  if (pedido.resultado_mime === "video/mp4") return res.status(404).json({ ok: false, error: "Prévia indisponível" });
  const resultadoFinalPath = path.join(base, "resultado_final.png");
  const pagamentoPendente = pedido.pagamento_pendente === true;

  if (isAdminFreeArtOrderHidden(pedido)) {
    return sendHiddenAdminFreeArtOrder(res);
  }

  const previewPath = pagamentoPendente && fs.existsSync(previewProtegidaPath)
    ? previewProtegidaPath
    : resultadoFinalPath;

  if (!fs.existsSync(previewPath)) {
    return res.status(404).json({ ok: false, error: "Imagem ainda não ficou pronta" });
  }

  if (previewPath.endsWith(".jpg") || previewPath.endsWith(".jpeg")) {
    res.setHeader("Content-Type", "image/jpeg");
  } else {
    res.setHeader("Content-Type", "image/png");
  }

  return res.sendFile(previewPath);
});

// ===== MINIATURA DA IMAGEM FINAL =====
app.get("/pedidos/:id/thumbnail", (req, res) => {
  const base = getPedidoBaseGlobal(req.params.id);

  if (!base) {
    return res.status(404).json({ ok: false, error: "Pedido nÃ£o encontrado" });
  }

  const previewProtegidaPath = path.join(base, "preview_ia4tube.jpg");
  const pedido = safeReadJson(path.join(base, "pedido.json")) || {};
  if (pedido.resultado_mime === "video/mp4") return res.status(404).json({ ok: false, error: "Miniatura indisponível" });
  const resultadoFinalPath = path.join(base, "resultado_final.png");

  if (isAdminFreeArtOrderHidden(pedido)) {
    return sendHiddenAdminFreeArtOrder(res);
  }

  const thumbnailPath = fs.existsSync(resultadoFinalPath)
    ? resultadoFinalPath
    : previewProtegidaPath;

  if (!fs.existsSync(thumbnailPath)) {
    return res.status(404).json({ ok: false, error: "Imagem ainda nÃ£o ficou pronta" });
  }

  if (thumbnailPath.endsWith(".jpg") || thumbnailPath.endsWith(".jpeg")) {
    res.setHeader("Content-Type", "image/jpeg");
  } else {
    res.setHeader("Content-Type", "image/png");
  }
  res.setHeader("Cache-Control", "public, max-age=300");

  return res.sendFile(thumbnailPath);
});

// ===== BAIXAR ZIP =====
app.get("/pedidos/:id/zip", auth, async (req, res) => {
  const whatsapp = req.user.whatsapp;
  const base = getPedidoBase(whatsapp, req.params.id);

  if (!base) {
    return res.status(404).json({ ok: false, error: "Pedido não encontrado" });
  }

  const pedido = safeReadJson(path.join(base, "pedido.json")) || {};
  if (isAdminFreeArtOrderHidden(pedido)) {
    return sendHiddenAdminFreeArtOrder(res);
  }
  if (freeArtCampaignsService.isFreeArtOrder(pedido)) {
    return res.status(403).json({
      ok: false,
      code: "free_art_weekly_zip_blocked",
      error: "A Arte Gratis da Semana nao entra no fluxo normal de ZIP."
    });
  }

  return streamDirectoryZip({
    res,
    directory: base,
    filename: `${req.params.id}.zip`
  });
});

// ===== ATUALIZAR STATUS =====
app.post("/pedidos/:id/status", auth, (req, res) => {
  const whatsapp = req.user.whatsapp;
  const base = getPedidoBase(whatsapp, req.params.id);

  if (!base) {
    return res.status(404).json({ ok: false, error: "Pedido não encontrado" });
  }

  const pedido = safeReadJson(path.join(base, "pedido.json")) || {};
  if (isAdminFreeArtOrderHidden(pedido)) {
    return sendHiddenAdminFreeArtOrder(res);
  }
  if (freeArtCampaignsService.isFreeArtOrder(pedido)) {
    return res.status(403).json({
      ok: false,
      code: "free_art_weekly_status_blocked",
      error: "A Arte Gratis da Semana nao entra no fluxo normal de status."
    });
  }

  const { status } = req.body || {};

  if (!orderStatus.isValidPublicStatus(status)) {
    return res.status(400).json({ ok: false, error: "status inválido" });
  }

  writeOrderStatus(base, status);

  return res.json({ ok: true });
});

// ===== UPLOAD DO RESULTADO FINAL =====
app.post(
  "/bot/pedidos/:id/upload-resultado",
  botRunnerAuth,
  uploadResultado.fields([
    { name: "resultado", maxCount: 1 },
    { name: "preview", maxCount: 1 }
  ]),
  (req, res) => {

    const descricao_instagram = req.body?.descricao_instagram || "";
    if (!isBotAdmin(req)) {
      return res.status(403).json({ ok: false, error: "Acesso negado" });
    }

    const base = getPedidoBaseGlobal(req.params.id);

    if (!base) {
      cleanupUploadedFiles(req.files);
      return res.status(404).json({ ok: false, error: "Pedido não encontrado" });
    }

    const existingPedido = safeReadJson(path.join(base, "pedido.json")) || {};
    if (isAdminFreeArtOrderHidden(existingPedido)) {
      cleanupUploadedFiles(req.files);
      return sendHiddenAdminFreeArtOrder(res);
    }
    if (freeArtCampaignsService.isFreeArtOrder(existingPedido)) {
      cleanupUploadedFiles(req.files);
      return res.status(403).json({
        ok: false,
        code: "free_art_weekly_upload_blocked",
        error: "A Arte Gratis da Semana nao entra no fluxo normal de upload."
      });
    }

    const resultadoFile = req.files?.resultado?.[0] || null;
    const previewFile = req.files?.preview?.[0] || null;
    const artReadyEventEnabled = fcmService.artReadyEventEnabled();
    const previousOrderStatus = artReadyEventEnabled
      ? readOrderStatus(base, "")
      : "";

    if (!resultadoFile) {
      cleanupUploadedFiles(req.files);
      return res.status(400).json({ ok: false, error: "Arquivo resultado não enviado" });
    }

    const dest = path.join(base, "resultado_final.png");
    const previewDest = path.join(base, "preview_ia4tube.jpg");

    try {
      if (fs.existsSync(dest)) fs.unlinkSync(dest);
      fs.renameSync(resultadoFile.path, dest);

      if (previewFile) {
        if (fs.existsSync(previewDest)) fs.unlinkSync(previewDest);
        fs.renameSync(previewFile.path, previewDest);
      }

      writeOrderStatus(base, orderStatus.ORDER_STATUS.PRONTO);

      try {
        const ajustePendentePath = path.join(base, "ajuste_pendente.txt");
        if (fs.existsSync(ajustePendentePath)) fs.unlinkSync(ajustePendentePath);
      } catch {}

      try {
        const pedidoPath = path.join(base, "pedido.json");
        if (fs.existsSync(pedidoPath)) {
          const pedidoData = JSON.parse(fs.readFileSync(pedidoPath, "utf8"));
          let artReadyCompletion = null;

          if (
            artReadyEventEnabled &&
            pedidoData.whatsapp &&
            !monthlyPlanningService.isPlanningOrder(pedidoData) &&
            !freeArtCampaignsService.isFreeArtOrder(pedidoData)
          ) {
            try {
              const ownerId = getPedidoOwnerFromBase(base);
              if (ownerId !== String(pedidoData.whatsapp || "").trim()) {
                throw Object.assign(new Error("Proprietario divergente."), {
                  code: "art_ready_owner_mismatch"
                });
              }
              const transition = successfulCompletionTransition({
                previousStatus: existingPedido.status,
                previousOrderStatus,
                existingGenerationId: pedidoData.art_ready_generation_id,
                createGenerationId: artReadyNotificationService.createGenerationId
              });
              if (transition.transitioned) {
                pedidoData.art_ready_generation_id = transition.generationId;
                artReadyCompletion = {
                  generationId: transition.generationId,
                  ownerId,
                  pedidoId: req.params.id
                };
              }
            } catch (error) {
              console.warn("[fcm][art-ready] evento nao preparado", {
                code: error?.code || "art_ready_prepare_failed"
              });
            }
          }

          pedidoData.descricao_instagram = descricao_instagram || "";
          pedidoData.status = "pronto";
          pedidoData.aprovado_cliente = false;
          pedidoData.baixado_cliente = false;
          pedidoData.resultado_enviado_em = new Date().toISOString();
          fs.writeFileSync(pedidoPath, JSON.stringify(pedidoData, null, 2), "utf8");
          registrarEventoServidor("pedido_pronto", {
            whatsapp: pedidoData.whatsapp,
            pedidoId: req.params.id,
            produto: pedidoData.product_id || pedidoData.categoria || "pedido",
            payload: {
              tipo: "pedido",
              categoria: pedidoData.categoria || "",
              pagamento_pendente: pedidoData.pagamento_pendente === true
            }
          });
          if (artReadyCompletion) {
            setImmediate(() => {
              artReadyNotificationService
                .handleCompletion(artReadyCompletion)
                .then((result) => {
                  console.log("[fcm][art-ready] processamento concluido", {
                    code: result?.code || "art_ready_result_unknown",
                    sent: Number(result?.sent || 0),
                    blocked: Number(result?.blocked || 0)
                  });
                })
                .catch((error) => {
                  console.warn("[fcm][art-ready] processamento falhou", {
                    code: error?.code || "art_ready_processing_failed"
                  });
                });
            });
          }
        }
      } catch (e) {}

      return res.json({
        ok: true,
        arquivo: "resultado_final.png",
        preview: previewFile ? "preview_ia4tube.jpg" : ""
      });
    } catch (e) {
      cleanupUploadedFiles(req.files);
      console.error("[uploads] falha ao salvar resultado", {
        pedido_id: req.params.id,
        message: e?.message,
        stack: e?.stack
      });
      return res.status(500).json({
        ok: false,
        error: "Falha ao salvar resultado"
      });
    }
  }
);

// ===== SUPORTE CHAT =====
app.post("/suporte/chat", auth, async (req, res) => {
  try {
    const { mensagem } = req.body || {};
    const whatsapp = req.user.whatsapp;

    const abertasHumanas = readJsonArraySafe(SUPORTE_ABERTAS_FILE);
    const conversaHumana = abertasHumanas.find(c =>
      c.whatsapp === whatsapp &&
      !c.finalizada &&
      (
        c.status === "humano_assumiu" ||
        c.precisa_humano === true
      )
    );

    if (conversaHumana) {
      conversaHumana.mensagens = conversaHumana.mensagens || [];

      conversaHumana.mensagens.push({
        id: `${Date.now()}_cliente`,
        data: new Date().toISOString(),
        autor: "cliente",
        texto: String(mensagem || "").trim()
      });

      conversaHumana.ultima_atualizacao = new Date().toISOString();

      writeJsonSafe(SUPORTE_ABERTAS_FILE, abertasHumanas);

      return res.json({
        ok:true,
        modo_humano:true,
        conversa_id: conversaHumana.id,
        resposta:null
      });
    }

    if (!mensagem || !String(mensagem).trim()) {
      return res.status(400).json({ ok: false, error: "Mensagem vazia" });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ ok: false, error: "OPENAI_API_KEY não configurada" });
    }

    const msg = String(mensagem || "").toLowerCase();

// ===== RESPOSTAS GRÁTIS (SEM IA) =====
if(msg.includes("resultado do jogo") && msg.includes("entender")){
  return res.json({
    ok:true,
    resposta:`Resultado do jogo mostra placar e escudos.\n\nObrigatório:\n- Times\n- Placar\n- Escudos\n\nOpcional:\n- Frase\n- Artilheiros\n- Foto`
  });
}

if(msg.includes("próximo jogo jogador") || msg.includes("proximo jogo jogador")){
  return res.json({
    ok:true,
    resposta:`Próximo jogo jogador cria uma arte focada em um jogador para divulgar a próxima partida.\n\nObrigatório:\n- Time A e Time B\n- Escudo do time\n- Foto do jogador\n- Data e horário\n- Campeonato/competição\n\nOpcional:\n- Local`
  });
}

if(msg.includes("resultado jogador")){
  return res.json({
    ok:true,
    resposta:`Resultado jogador cria uma arte de resultado com foco no jogador.\n\nObrigatório:\n- Times\n- Placar\n- Escudos\n- Foto do jogador\n\nOpcional:\n- Frase\n- Campeonato/competição`
  });
}

if(msg.includes("jogador + escudo") || msg.includes("jogador e escudo")){
  return res.json({
    ok:true,
    resposta:`Jogador + escudo cria uma arte simples e forte com o jogador e o escudo do time.\n\nObrigatório:\n- Nome do jogador\n- Escudo do time\n- Foto do jogador\n\nOpcional:\n- Nenhum`
  });
}

if(msg.includes("como baixar") || msg.includes("baixar novamente")){
  return res.json({
    ok:true,
    resposta:"Vá em Meus pedidos e clique em Baixar novamente."
  });
}

if(
  msg.includes("combo") ||
  msg.includes("combos") ||
  msg.includes("plano") ||
  msg.includes("planos") ||
  msg.includes("assinatura") ||
  msg.includes("mensalidade") ||
  msg.includes("essencial") ||
  msg.includes("profissional") ||
  msg.includes("empresarial")
){
  return res.json({
    ok:true,
    resposta:"Combos IA4Tube:\n\n- i4 Essencial: R$ 39,90/mês, 8 artes por mês, 3 Materiais Gráficos da Empresa por mês, 1 Carrossel por mês e suporte via WhatsApp.\n\n- i4 Profissional: R$ 79,90/mês, 20 artes por mês, 5 Materiais Gráficos da Empresa por mês, 1 Material Gráfico de Nicho por mês, 2 Carrosséis por mês e suporte via WhatsApp.\n\n- i4 Empresarial: R$ 149,90/mês, 40 artes por mês, todos os Materiais Gráficos Gerais liberados, 3 Materiais Gráficos de Nicho por mês, 4 Carrosséis por mês e suporte via WhatsApp."
  });
}

if(msg.includes("saldo") && msg.includes("como")){
  return res.json({
    ok:true,
    resposta:"Clique em Adicionar saldo no topo da tela."
  });
}

// ===== SUPORTE DIRETO (SEM IA) =====
if(
  msg.includes("erro") ||
  msg.includes("não chegou") ||
  msg.includes("nao chegou") ||
  msg.includes("errado") ||
  msg.includes("alteração") ||
  msg.includes("suporte")
){
  const conversa = salvarMensagemSuporteAberta(whatsapp, mensagem, "Vou encaminhar sua solicitação para o suporte.", "sistema");
  conversa.precisa_humano = true;
  conversa.status = "aguardando_suporte";
  conversa.ultima_atualizacao = new Date().toISOString();

  const abertas = readJsonArraySafe(SUPORTE_ABERTAS_FILE);
  const idx = abertas.findIndex(c => c.id === conversa.id);
  if(idx >= 0){
    abertas[idx] = conversa;
    writeJsonSafe(SUPORTE_ABERTAS_FILE, abertas);
  }

  return res.json({
    ok:true,
    modo_humano:true,
    conversa_id: conversa.id,
    resposta:"Vou encaminhar sua solicitação para o suporte."
  });
}

// ===== SE NÃO CAIU EM NADA → USA IA =====
const pedidos = listPedidoBasesByWhatsapp(whatsapp).slice(0, 5);

    const resumoPedidos = pedidos.map((p) => {
      const resultadoFinalPath = path.join(p.base, "resultado_final.png");

      const status = readOrderStatus(p.base, p.pedido.status || "novo");

      return {
        id: p.id,
        status,
        categoria: p.pedido.categoria || "",
        rodada: p.pedido.rodada || "",
        data: p.pedido.data || "",
        criado_em: p.criado_em,
        imagem_pronta: fs.existsSync(resultadoFinalPath)
      };
    });

    const prompt = `
Você é o suporte automático da IA4Tube.

REGRAS:
- Responda sempre em português do Brasil.
- Responda curto, simples e direto.
- Não invente status, prazo ou informação.
- Use os pedidos reais abaixo somente quando o cliente perguntar sobre pedido.

MENU DO SUPORTE:
1. Dúvida sobre produto
2. Não consigo enviar pedido
3. Meu pedido deu erro / alteração
4. Pedido pronto / download
5. Pagamento / saldo
6. Quero falar com suporte

COMPORTAMENTO:
- Se for cumprimento, responda: "Oi! Escolha uma opção no menu do suporte."
- Se o cliente pedir opções, disser "quais opções", "me dê as opções" ou algo parecido, responda curto: "Use os botões do menu do suporte."
- Se o cliente falar "dúvida sobre produto" ou perguntar "como funciona", responda: "Escolha o produto no menu abaixo."
- Se o cliente perguntar sobre combos, planos, assinatura, mensalidade, Essencial, Profissional ou Empresarial, responda somente: "Combos IA4Tube: i4 Essencial R$ 39,90/mês com 8 artes, 3 Materiais Gráficos da Empresa, 1 Carrossel e suporte via WhatsApp. i4 Profissional R$ 79,90/mês com 20 artes, 5 Materiais Gráficos da Empresa, 1 Material Gráfico de Nicho, 2 Carrosséis e suporte via WhatsApp. i4 Empresarial R$ 149,90/mês com 40 artes, todos os Materiais Gráficos Gerais, 3 Materiais Gráficos de Nicho, 4 Carrosséis e suporte via WhatsApp."

- Se o cliente disser "Quero entender Resultado do jogo", explique somente Resultado do jogo.
- Se o cliente disser "Quero entender Escalação", explique somente Escalação.
- Se o cliente disser "Quero entender Contratação", explique somente Contratação.
- Se o cliente disser "Quero entender Próximo jogo", explique somente Próximo jogo.
- Se o cliente disser "Quero entender Patrocinador", explique somente Patrocinador.
- Se o cliente disser "Quero entender Escudo 3D", responda: "Escudo 3D transforma o escudo do time em uma arte 3D moderna. Obrigatório: enviar o escudo do time. Opcional: nenhuma informação extra."
- Se o cliente disser "Quero entender Próximo jogo jogador", explique somente Próximo jogo jogador.
- Se o cliente disser "Quero entender Resultado jogador", explique somente Resultado jogador.
- Se o cliente disser "Quero entender Jogador + escudo", explique somente Jogador + escudo.

- Ao explicar produto, sempre separe "Obrigatório" e "Opcional".
- Se o cliente disser "Não sei o que preencher", pergunte: "Qual produto você está tentando enviar?"
- Se o cliente disser "Não consigo enviar imagem", responda: "Tente enviar uma imagem em PNG ou JPG. Se continuar dando erro, vou encaminhar para o suporte."
- Se o cliente disser "Botão criar minha arte não funciona", responda exatamente: "Vou encaminhar sua solicitação para o suporte."
- Se o cliente disser "Apareceu erro ao enviar pedido", responda exatamente: "Vou encaminhar sua solicitação para o suporte."
- Se o cliente disser "Não consigo enviar pedido", pergunte: "Qual produto você está tentando enviar?"

- Se o cliente disser imagem com nome errado, texto errado, escudo errado, imagem estranha, pedir alteração, pedido não chegou, problema técnico ou reclamação, responda exatamente: "Vou encaminhar sua solicitação para o suporte."

- Se o cliente perguntar como baixar, responda: "Vá em Meus pedidos e clique em Baixar novamente."
- Se o cliente disser "Não apareceu meu pedido pronto", responda: "Confira em Meus pedidos. Se ainda não apareceu, aguarde alguns minutos. Se continuar, vou encaminhar para o suporte."
- Se o cliente disser "Quero baixar novamente", responda: "Vá em Meus pedidos e clique em Baixar novamente."
- Se o cliente disser "Meu pedido está demorando", responda: "Aguarde alguns minutos e confira em Meus pedidos. Se continuar demorando, vou encaminhar para o suporte."

- Se o cliente perguntar como adicionar saldo, responda: "Clique em Adicionar saldo no topo da tela e escolha um valor."
- Se o cliente disser "Paguei e meu saldo não apareceu", responda exatamente: "Vou encaminhar sua solicitação para o suporte."
- Se o cliente disser "Saldo insuficiente", responda: "Clique em Adicionar saldo no topo da tela e escolha um valor."
- Se o cliente perguntar valores de saldo, responda: "Você pode adicionar R$8, R$18, R$28 ou R$48."

- Se o cliente pedir suporte humano ou disser "Quero falar com suporte", responda exatamente: "Vou encaminhar sua solicitação para o suporte."

PRODUTOS:

Resultado do jogo:
- Mostra o placar da partida, os escudos dos times e uma frase relacionada ao jogo.
- Obrigatório:
  1. Definir quais times estão jogando.
  2. Definir o placar.
  3. Selecionar os escudos.
- Opcional:
  4. Criar uma frase.
  5. Informar campeonato/competição.
  6. Informar artilheiros.
  7. Enviar foto do jogo ou do time.

Escalação:
- Mostra a lista de jogadores do time.
- Obrigatório:
  1. Título da arte.
  2. Escudo do time.
  3. Nome dos jogadores.
- Opcional:
  4. Posição dos jogadores.
  5. Escudo adversário.
  6. Foto do jogador ou do time.

Contratação:
- Anúncio de jogador contratado, renovado ou apresentado.
- Obrigatório:
  1. Título da arte.
  2. Nome do jogador.
  3. Escudo do time.
  4. Foto do jogador.
- Opcional:
  5. Posição ou idade.

Próximo jogo:
- Mostra confronto entre dois times com data e horário.
- Obrigatório:
  1. Definir os dois times.
  2. Selecionar os escudos.
  3. Informar data e horário.
  4. Informar campeonato/competição.
- Opcional:
  5. Informar local.

Patrocinador:
- Mostra o escudo do time junto com logos de patrocinadores/apoiadores.
- Obrigatório:
  1. Título da arte.
  2. Escudo do time.
  3. Enviar logos dos patrocinadores.
- Opcional:
  4. Texto principal.

Próximo jogo jogador:
- Arte de próximo jogo com foco em um jogador.
- Obrigatório:
  1. Definir os dois times.
  2. Escudo do time.
  3. Foto do jogador.
  4. Data e horário.
  5. Campeonato/competição.
- Opcional:
  6. Local.

Resultado jogador:
- Arte de resultado com foco no jogador.
- Obrigatório:
  1. Definir os times.
  2. Definir o placar.
  3. Selecionar os escudos.
  4. Enviar foto do jogador.
- Opcional:
  5. Frase.
  6. Campeonato/competição.

Jogador + escudo:
- Arte simples com jogador e escudo do time.
- Obrigatório:
  1. Nome do jogador.
  2. Escudo do time.
  3. Foto do jogador.
- Opcional:
  Nenhum.

PEDIDOS DO CLIENTE:
${JSON.stringify(resumoPedidos, null, 2)}

MENSAGEM DO CLIENTE:
${String(mensagem).trim()}
`;

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + process.env.OPENAI_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "Você é o suporte automático da IA4Tube. Responda curto, claro e em português do Brasil." },
          { role: "user", content: prompt }
        ],
        max_tokens: 220,
        temperature: 0.3
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(500).json({
        ok: false,
        error: "Erro ao chamar IA",
        detalhe: data?.error?.message || ""
      });
    }

    const resposta = data.choices?.[0]?.message?.content?.trim();
    const respostaFinal = (resposta || "Não consegui responder agora.").trim()
      + "\n\nQuer continuar conversando com o robô ou prefere falar com humano?";

    const conversa = salvarMensagemSuporteAberta(whatsapp, mensagem, respostaFinal, "ia");

    const respostaLower = respostaFinal.toLowerCase();

    if (
      (respostaLower.includes("encaminhar") && respostaLower.includes("suporte")) ||
      respostaLower.includes("suporte humano") ||
      respostaLower.includes("falar com suporte") ||
      respostaLower.includes("entrar em contato com o suporte") ||
      respostaLower.includes("recomendo que você entre em contato")
    ) {
      conversa.precisa_humano = true;
      conversa.status = "aguardando_suporte";

      const abertas = readJsonArraySafe(SUPORTE_ABERTAS_FILE);
      const idx = abertas.findIndex(c => c.id === conversa.id);
      if(idx >= 0){
        abertas[idx] = conversa;
        writeJsonSafe(SUPORTE_ABERTAS_FILE, abertas);
      }
    }

    return res.json({
      ok: true,
      conversa_id: conversa.id,
      modo_humano: !!conversa.precisa_humano,
      resposta: respostaFinal,
      mostrar_opcoes_pos_ia: true,
      opcoes_pos_ia: [
        { texto: "Continuar com robô", valor: "continuar_robo" },
        { texto: "Falar com humano", valor: "falar_humano" }
      ]
    });

  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: "Erro no suporte"
    });
  }
});

app.get("/suporte/minhas-mensagens", auth, (req, res) => {
  try {
    const chatAberto = String(req.headers["x-ia4-chat"] || "") === "true";

    registrarOnline(req, { chat_aberto: chatAberto, ultima_acao: "suporte_poll" });

    const whatsapp = req.user.whatsapp;
    const abertas = readJsonArraySafe(SUPORTE_ABERTAS_FILE);
    const conversa = abertas.find(c => c.whatsapp === whatsapp && !c.finalizada);

    if (!conversa) {
      return res.json({
        ok: true,
        conversa: null,
        mensagens: [],
        tem_mensagem_nova: false
      });
    }

    const temMensagemNova = conversa.cliente_leu === false;

    if (chatAberto) {
      conversa.cliente_leu = true;
      writeJsonSafe(SUPORTE_ABERTAS_FILE, abertas);
    }

    return res.json({
      ok: true,
      conversa_id: conversa.id,
      conversa,
      mensagens: conversa.mensagens || [],
      tem_mensagem_nova: temMensagemNova
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Erro ao buscar mensagens" });
  }
});

app.get("/bot/eventos-clientes", botAdminAuth, (req, res) => {
  try {
    if (!isBotAdmin(req)) {
      return res.status(403).json({ ok: false, error: "Acesso negado" });
    }

    const limite = Math.min(Number(req.query.limite || 1000), 5000);

    const agora = new Date();
    const yyyy = agora.getFullYear();
    const mm = String(agora.getMonth() + 1).padStart(2, "0");
    const dd = String(agora.getDate()).padStart(2, "0");

    const analyticsDiaFile = path.join(
      ANALYTICS_DIR,
      `${yyyy}-${mm}-${dd}.json`
    );

    const eventos = readJsonArraySafe(analyticsDiaFile)
      .slice(-limite)
      .map(sanitizeAnalyticsEventForResponse);

    return res.json({
      ok: true,
      total: eventos.length,
      eventos
    });
  } catch {
    return res.status(500).json({ ok:false, error:"erro_eventos_clientes" });
  }
});

app.get("/bot/analytics-dia/:data", botAdminAuth, (req, res) => {
  try {
    if (!isBotAdmin(req)) {
      return res.status(403).json({ ok: false, error: "Acesso negado" });
    }

    const data = String(req.params.data || "").trim();

    if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) {
      return res.status(400).json({
        ok: false,
        error: "Data inválida. Use YYYY-MM-DD."
      });
    }

    const analyticsDiaFile = path.join(ANALYTICS_DIR, `${data}.json`);

    if (!fs.existsSync(analyticsDiaFile)) {
      return res.status(404).json({
        ok: false,
        error: "Arquivo de analytics não encontrado para esta data.",
        data
      });
    }

    const eventos = readJsonArraySafe(analyticsDiaFile)
      .map(sanitizeAnalyticsEventForResponse);

    return res.json({
      ok: true,
      data,
      total: eventos.length,
      eventos
    });
  } catch {
    return res.status(500).json({
      ok: false,
      error: "erro_analytics_dia"
    });
  }
});

app.get("/bot/eventos-pedido/:id", botAdminAuth, (req, res) => {
  try {
    if (!isBotAdmin(req)) {
      return res.status(403).json({ ok: false, error: "Acesso negado" });
    }

    const basePedido = getPedidoBaseGlobal(req.params.id);

    if (!basePedido) {
      return res.status(404).json({ ok:false, error:"Pedido não encontrado" });
    }

    const eventosPedidoFile = path.join(basePedido, "eventos_cliente.json");
    const eventos = readJsonArraySafe(eventosPedidoFile)
      .map(sanitizeAnalyticsEventForResponse);

    return res.json({
      ok:true,
      pedido_id:req.params.id,
      total:eventos.length,
      eventos
    });
  } catch {
    return res.status(500).json({ ok:false, error:"erro_eventos_pedido" });
  }
});

app.get("/bot/online", botAdminAuth, (req, res) => {
  try {
    if (!isBotAdmin(req)) {
      return res.status(403).json({ ok: false, error: "Acesso negado" });
    }

    return res.json({
      ok: true,
      usuarios: listarOnlineRecentes().map(sanitizeOnlineUserForResponse)
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Erro ao listar online" });
  }
});

app.post("/bot/suporte/erro-pedido", botRunnerAuth, (req, res) => {
  try {
    if (!isBotAdmin(req)) {
      return res.status(403).json({ ok:false, error:"Acesso negado" });
    }

    const { pedido_id, whatsapp, motivo } = req.body || {};

    if (!pedido_id || !whatsapp) {
      return res.status(400).json({ ok:false, error:"pedido_id e whatsapp obrigatórios" });
    }

    const basePedido = getPedidoBaseGlobal(pedido_id);

    if (basePedido) {
      try {
        writeOrderStatus(basePedido, orderStatus.ORDER_STATUS.ERRO);

        const pedidoPath = path.join(basePedido, "pedido.json");
        const pedidoData = safeReadJson(pedidoPath) || {};

        pedidoData.status = "erro";
        pedidoData.erro_cliente = true;
        pedidoData.motivo_erro = motivo || "erro_pipeline";
        pedidoData.erro_em = new Date().toISOString();

        fs.writeFileSync(
          pedidoPath,
          JSON.stringify(pedidoData, null, 2),
          "utf8"
        );
        registrarEventoServidor("runner_erro", {
          whatsapp,
          pedidoId: pedido_id,
          produto: pedidoData.product_id || pedidoData.categoria || "pedido",
          payload: {
            tipo: "suporte_pipeline",
            motivo: motivo || "erro_pipeline"
          }
        });
      } catch {}
    }

    const conversa = salvarMensagemSuporteAberta(
      whatsapp,
      "",
      `⚠️ Seu pedido ${pedido_id} entrou em análise.\n\nSua imagem não passou na nossa política de privacidade ou ocorreu algum erro no processamento automático.\n\nVeja o SUPORTE abaixo para acompanhar o atendimento.\n\nNossa equipe vai verificar o caso. Se necessário, o valor será devolvido em saldo na sua conta.`,
      "sistema"
    );

    conversa.precisa_humano = true;
    conversa.status = "aguardando_suporte";
    conversa.motivo = motivo || "erro_pipeline";
    conversa.ultima_atualizacao = new Date().toISOString();
    conversa.cliente_leu = false;

    const abertas = readJsonArraySafe(SUPORTE_ABERTAS_FILE);
    const idx = abertas.findIndex(c => c.id === conversa.id);

    if (idx >= 0) {
      abertas[idx] = conversa;
      writeJsonSafe(SUPORTE_ABERTAS_FILE, abertas);
    }

    return res.json({
      ok:true,
      conversa_id: conversa.id
    });
  } catch (e) {
    return res.status(500).json({ ok:false, error:"erro_avisar_suporte" });
  }
});

function resolverWhatsappDestinoSuporte(destino) {
  destino = String(destino || "").trim();

  if (!destino) return "";

  const abertas = readJsonArraySafe(SUPORTE_ABERTAS_FILE);
  const conversa = abertas.find(c => c.id === destino && !c.finalizada);

  if (conversa?.whatsapp) {
    return conversa.whatsapp;
  }

  const clientes = readClientes();

  if (clientes[destino]) {
    return destino;
  }

  const basePedido = getPedidoBaseGlobal(destino);

  if (basePedido) {
    const pedidoPath = path.join(basePedido, "pedido.json");
    const pedido = safeReadJson(pedidoPath) || {};

    if (pedido.whatsapp) {
      return pedido.whatsapp;
    }
  }

  return "";
}

app.post("/bot/suporte/enviar-cliente", auth, (req, res) => {
  try {
    if (!isBotAdmin(req)) {
      return res.status(403).json({ ok:false, error:"Acesso negado" });
    }

    const { destino, mensagem } = req.body || {};
    const texto = String(mensagem || "").trim();

    if (!destino || !texto) {
      return res.status(400).json({
        ok:false,
        error:"destino e mensagem obrigatórios"
      });
    }

    const whatsapp = resolverWhatsappDestinoSuporte(destino);

    if (!whatsapp) {
      return res.status(404).json({
        ok:false,
        error:"Cliente não encontrado por esse ID, WhatsApp ou pedido."
      });
    }

    const conversa = salvarMensagemSuporteAberta(
      whatsapp,
      "",
      texto,
      "humano"
    );

    conversa.precisa_humano = true;
    conversa.status = "humano_assumiu";
    conversa.ultima_atualizacao = new Date().toISOString();
    conversa.cliente_leu = false;

    const abertas = readJsonArraySafe(SUPORTE_ABERTAS_FILE);
    const idx = abertas.findIndex(c => c.id === conversa.id);

    if (idx >= 0) {
      abertas[idx] = conversa;
      writeJsonSafe(SUPORTE_ABERTAS_FILE, abertas);
    }

    return res.json({
      ok:true,
      conversa_id: conversa.id,
      whatsapp
    });
  } catch {
    return res.status(500).json({
      ok:false,
      error:"erro_enviar_mensagem_cliente"
    });
  }
});

app.get("/bot/suporte/abertas", auth, (req, res) => {
  try {
    if (!isBotAdmin(req)) {
      return res.status(403).json({ ok: false, error: "Acesso negado" });
    }

    const conversas = readJsonArraySafe(SUPORTE_ABERTAS_FILE)
      .filter(c => !c.finalizada)
      .sort((a, b) => new Date(b.ultima_atualizacao || b.inicio) - new Date(a.ultima_atualizacao || a.inicio));

    return res.json({
      ok: true,
      conversas
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Erro ao listar suporte aberto" });
  }
});

app.post("/bot/suporte/:id/assumir", auth, (req, res) => {
  try {
    if (!isBotAdmin(req)) {
      return res.status(403).json({ ok:false, error:"Acesso negado" });
    }

    const abertas = readJsonArraySafe(SUPORTE_ABERTAS_FILE);
    const idx = abertas.findIndex(c => c.id === req.params.id && !c.finalizada);

    if (idx === -1) {
      return res.status(404).json({ ok:false, error:"Conversa não encontrada" });
    }

    abertas[idx].status = "humano_assumiu";
    abertas[idx].precisa_humano = true;
    abertas[idx].cliente_leu = false;
    abertas[idx].ultima_atualizacao = new Date().toISOString();

    writeJsonSafe(SUPORTE_ABERTAS_FILE, abertas);

    return res.json({ ok:true });
  } catch {
    return res.status(500).json({ ok:false, error:"erro_assumir" });
  }
});

app.post("/bot/suporte/:id/responder", auth, (req, res) => {
  try {
    if (!isBotAdmin(req)) {
      return res.status(403).json({ ok: false, error: "Acesso negado" });
    }

    const { mensagem } = req.body || {};
    const texto = String(mensagem || "").trim();

    if (!texto) {
      return res.status(400).json({ ok: false, error: "Mensagem vazia" });
    }

    const abertas = readJsonArraySafe(SUPORTE_ABERTAS_FILE);
    const idx = abertas.findIndex(c => c.id === req.params.id && !c.finalizada);

    if (idx === -1) {
      return res.status(404).json({ ok: false, error: "Conversa não encontrada" });
    }

    abertas[idx].mensagens = abertas[idx].mensagens || [];
    abertas[idx].mensagens.push({
      id: `${Date.now()}_humano`,
      data: new Date().toISOString(),
      autor: "humano",
      texto
    });

    abertas[idx].status = "humano_assumiu";
    abertas[idx].precisa_humano = true;
    abertas[idx].ultima_atualizacao = new Date().toISOString();

    writeJsonSafe(SUPORTE_ABERTAS_FILE, abertas);

    return res.json({ ok: true, conversa: abertas[idx] });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Erro ao responder suporte" });
  }
});

app.post("/suporte/finalizar", auth, (req, res) => {
  try {
    const whatsapp = req.user.whatsapp;
    const { motivo } = req.body || {};

    const finalizou = finalizarConversaSuporte(whatsapp, motivo || "cliente_fechou_chat");

    if (!finalizou) {
      return res.json({ ok: true, sem_conversa_aberta: true });
    }

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Erro ao finalizar suporte" });
  }
});

app.get("/bot/suporte/finalizadas", auth, (req, res) => {
  try {
    if (!isBotAdmin(req)) {
      return res.status(403).json({ ok: false, error: "Acesso negado" });
    }

    const finalizadasPath = path.join(DATA_DIR, "suporte_conversas_finalizadas.json");
    const conversas = readJsonArraySafe(finalizadasPath);

    return res.json({
      ok: true,
      conversas
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Erro ao listar suporte finalizado" });
  }
});

app.post("/bot/suporte/limpar-finalizadas", auth, (req, res) => {
  try {
    if (!isBotAdmin(req)) {
      return res.status(403).json({ ok: false, error: "Acesso negado" });
    }

    const finalizadasPath = path.join(DATA_DIR, "suporte_conversas_finalizadas.json");
    writeJsonSafe(finalizadasPath, []);

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Erro ao limpar suporte finalizado" });
  }
});

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function listSeoNicheSlugs() {
  if (!fs.existsSync(SEO_NICHES_DIR)) {
    return [];
  }

  return fs.readdirSync(SEO_NICHES_DIR)
    .filter((fileName) => fileName.endsWith(".json") && !fileName.startsWith("_"))
    .map((fileName) => {
      const expectedSlug = path.basename(fileName, ".json");
      const filePath = path.join(SEO_NICHES_DIR, fileName);

      try {
        const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
        const slug = String(data.slug || "").trim().toLowerCase();

        if (slug !== expectedSlug) {
          console.warn("[seo] sitemap ignorou nicho com slug divergente", {
            fileName,
            expectedSlug,
            slug
          });
          return null;
        }

        if (!/^[a-z0-9-]{2,80}$/.test(slug)) {
          console.warn("[seo] sitemap ignorou nicho com slug invalido", {
            fileName,
            slug
          });
          return null;
        }

        return slug;
      } catch (e) {
        console.warn("[seo] sitemap ignorou JSON invalido", {
          fileName,
          message: e?.message
        });
        return null;
      }
    })
    .filter(Boolean)
    .sort();
}

app.get("/sitemap.xml", (req, res) => {
  const baseUrl = "https://ia4tube.com";
  const urls = [
    { loc: `${baseUrl}/`, changefreq: "daily", priority: "1.0" },
    ...listSeoNicheSlugs().map((slug) => ({
      loc: `${baseUrl}/${slug}`,
      changefreq: "weekly",
      priority: "0.8"
    }))
  ];

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((item) => `  <url>
    <loc>${escapeXml(item.loc)}</loc>
    <changefreq>${escapeXml(item.changefreq)}</changefreq>
    <priority>${escapeXml(item.priority)}</priority>
  </url>`).join("\n")}
</urlset>`;

  return res.type("application/xml").send(body);
});

app.get("/robots.txt", (req, res) => {
  return res.type("text/plain").send(`User-agent: *
Allow: /

Disallow: /login
Disallow: /painel
Disallow: /admin
Disallow: /api

Sitemap: https://ia4tube.com/sitemap.xml
`);
});

app.get("/:nichoSlug", (req, res, next) => {
  const slug = String(req.params.nichoSlug || "").trim().toLowerCase();

  if (!/^[a-z0-9-]{2,80}$/.test(slug)) {
    return next();
  }

  try {
    const nicheData = seoNichePages.readNichePageData(SEO_NICHES_DIR, slug);

    if (nicheData) {
      return res.type("html").send(seoNichePages.renderNichePage(nicheData));
    }
  } catch (e) {
    console.error("[seo] erro ao renderizar pagina de nicho", {
      slug,
      message: e?.message
    });
    return res.status(500).send("Erro ao carregar pagina de nicho");
  }

  const legacyPagePath = path.join(SEO_NICHES_DIR, `${slug}.html`);

  if (fs.existsSync(legacyPagePath)) {
    return res.sendFile(legacyPagePath);
  }

  return next();
});

app.use((err, req, res, next) => {
  cleanupUploadedFiles(req.files);
  console.error("[api] erro nao tratado", {
    path: req.path,
    method: req.method,
    code: err?.code,
    field: err?.field,
    message: err?.message,
    stack: err?.stack
  });

  if (res.headersSent) {
    return next(err);
  }

  if (err instanceof multer.MulterError) {
    const isProductDiscovery = req.path === "/empresa/planejamento-mensal/descobrir-produtos";
    const imageTooLarge = err.code === "LIMIT_FILE_SIZE";
    return res.status(isProductDiscovery && imageTooLarge ? 413 : 400).json({
      ok: false,
      ...(isProductDiscovery ? {
        code: imageTooLarge
          ? "product_discovery_image_too_large"
          : "product_discovery_invalid_image"
      } : {}),
      error: "Não foi possível enviar a imagem. Verifique o arquivo e tente novamente."
    });
  }

  if (String(err?.message || "").includes("Apenas imagens")) {
    return res.status(400).json({
      ok: false,
      ...(req.path === "/empresa/planejamento-mensal/descobrir-produtos"
        ? { code: "product_discovery_invalid_image" }
        : {}),
      error: err.message
    });
  }

  return res.status(err?.statusCode || 500).json({
    ok: false,
    error: "Não foi possível criar o pedido agora. Tente novamente em alguns instantes."
  });
});

cleanupOldTmpUploads();
function startLegacyBackgroundTasks() {
setInterval(cleanupOldTmpUploads, TMP_UPLOAD_CLEANUP_INTERVAL_MS);
setInterval(finalizarConversasSuporteInativas, 60 * 1000);
if (fcmService.scheduledNotificationsEnabled()) {
  setTimeout(runMonthlyPlanningNotifications, 15 * 1000);
  setInterval(runMonthlyPlanningNotifications, MONTHLY_PLANNING_NOTIFICATIONS_INTERVAL_MS);
}
if (adminFreeArtsEnabled()) {
  setTimeout(runFreeArtCampaignRecovery, 60 * 1000);
  setInterval(runFreeArtCampaignRecovery, adminFreeArtsRecoveryIntervalMs());
}
if (
  adminFreeArtsNotificationsEnabled() &&
  fcmService.scheduledNotificationsEnabled()
) {
  setTimeout(runFreeArtCampaignNotifications, 20 * 1000);
  setInterval(runFreeArtCampaignNotifications, adminFreeArtsNotificationsIntervalMs());
}

}

productionSocialIntegration.initialize({
  secret: JWT_SECRET,
  readClients: readClientes,
  dataDir: DATA_DIR,
  planningDir: MONTHLY_PLANNINGS_DIR,
  ordersDir: PEDIDOS_DIR,
  logger: require("./src/social/server-runtime").createSocialDiagnosticLogger(console)
}).then(() => {
  startLegacyBackgroundTasks();
  const httpServer = app.listen(PORT, () => {
    console.log("API rodando na porta", PORT);
  });
  if (productionSocialIntegration.enabled) {
    const { installSocialRuntimeShutdown } = require("./src/social/server-runtime");
    installSocialRuntimeShutdown({
      runtimeState: productionSocialIntegration,
      server: httpServer
    });
  }
}).catch((error) => {
  const { safeErrorCode } = require("./src/social/server-runtime");
  console.error(
    "[social] Inicializacao recusada; nenhum servidor HTTP iniciado. Codigo:",
    safeErrorCode(error)
  );
  process.exitCode = 1;
});
