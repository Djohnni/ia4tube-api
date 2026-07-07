const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const archiver = require("archiver");
const crypto = require("crypto");
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
const fcmService = require("./src/notifications/fcm.service");
const seoNichePages = require("./src/seo/niche-page-renderer");

const app = express();

// ===== CONFIG BÁSICA =====
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "TROQUE_ISSO_AGORA";

// ===== DATA STORAGE (RENDER DISK) =====
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "dados");

const PEDIDOS_DIR = path.join(DATA_DIR, "pedidos");
const TMP_UPLOADS_DIR = path.join(DATA_DIR, "tmp_uploads");
const GRAPHIC_MATERIALS_DIR = path.join(DATA_DIR, "materiais_graficos");
const CAROUSELS_DIR = path.join(DATA_DIR, "carrosseis");
const MONTHLY_PLANNINGS_DIR = path.join(DATA_DIR, "planejamentos_mensais");
const CLIENTES_FILE = path.join(DATA_DIR, "clientes.json");
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
const SEO_NICHES_DIR = path.join(__dirname, "public", "nichos");
const ADMIN_MOBILE_ANALYTICS_FILE = path.join(__dirname, "admin", "mobile_analytics.html");
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

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: false, limit: "1mb" }));

app.get(["/mobile_analytics.html", "/public/mobile_analytics.html"], (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  return res.status(404).send("Not found");
});

app.use(express.static("public"));

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

// ===== HELPERS =====
function readClientes() {
  return JSON.parse((fs.readFileSync(CLIENTES_FILE, "utf8") || "{}").replace(/^\uFEFF/, ""));
}

function writeClientes(obj) {
  fs.writeFileSync(CLIENTES_FILE, JSON.stringify(obj, null, 2), "utf8");
}

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
    const user = jwt.verify(token, JWT_SECRET);
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
    req.user = jwt.verify(token, JWT_SECRET);
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
    req.user = jwt.verify(token, JWT_SECRET);

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

const uploadResultado = multer({ storage });

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
        clienteFake = jwt.verify(token, JWT_SECRET);
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

    const token = jwt.sign({ whatsapp: chaveCliente }, JWT_SECRET, { expiresIn: "7d" });

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
app.post("/auth/auto-register", (req, res) => {
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
    const creditoPreviewInterno = getCustoPedido(produtoOrigem, null);
    const login = criarLoginAutomaticoUnico(body.login || nome_time, clientes);
    const senhaCliente = gerarSenhaAutomatica();
    const senha_hash = bcrypt.hashSync(senhaCliente, 8);

    const novo = {
      nome_time: nome_time || "Jogador",
      senha_hash,
      login_tipo: "automatico",
      cadastro_automatico: true,
      conta_finalizada: false,
      produto_origem: produtoOrigem,
      credito_preview_interno: Number(creditoPreviewInterno || 0),
      device_id: String(body.device_id || ""),
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
      ativo: true,
      criado_em: new Date().toISOString()
    };
    billingService.markFreeArtEligible(novo);

    clientes[login] = novo;
    writeClientes(clientes);

    const token = jwt.sign({ whatsapp: login }, JWT_SECRET, { expiresIn: "7d" });

    return res.json({
      ok: true,
      token,
      login,
      whatsapp: login,
      nome_time: novo.nome_time,
      plano: novo.plano,
      saldo_mensal: Number(novo.saldo_mensal || 0),
      saldo_extra: Number(novo.saldo_extra || 0),
      ...billingService.getStandaloneArtStatus(novo),
      saldo: Number(novo.saldo_mensal || 0) + Number(novo.saldo_extra || 0),
      usados_no_ciclo: novo.usados_no_ciclo
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: "Erro ao criar acesso automático."
    });
  }
});

// Login
app.post("/auth/register", (req, res) => {
  const body = req.body || {};
  const whatsapp = normalizarLoginId(body.whatsapp);
  const senha = body.senha || "";
  const nome_time = String(body.nome_time || whatsapp || "").trim();

  if (!whatsapp || !senha) {
    return res.status(400).json({ ok: false, error: "login e senha obrigatórios" });
  }

  if (whatsapp.length < 3) {
    return res.status(400).json({ ok: false, error: "Login muito curto" });
  }

  const clientes = readClientes();

  if (clientes[whatsapp]) {
    return res.status(400).json({
      ok: false,
      error: `Esse login já existe. Tente algo como: ${whatsapp}${Math.floor(Math.random()*99)}`
    });
  }

  const senha_hash = bcrypt.hashSync(senha, 8);

  const novo = {
    nome_time,
    senha_hash,
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
  billingService.markFreeArtEligible(novo);

  const clientesAtualizados = readClientes();

  if (clientesAtualizados[whatsapp]) {
    return res.status(400).json({
      ok: false,
      error: `Esse login já existe. Tente outro nome.`
    });
  }

  clientesAtualizados[whatsapp] = novo;
  writeClientes(clientesAtualizados);

  const token = jwt.sign({ whatsapp }, JWT_SECRET, { expiresIn: "7d" });

  return res.json({
    ok: true,
    token,
    nome_time: novo.nome_time,
    plano: novo.plano,
    ...billingService.getStandaloneArtStatus(novo),
    usados_no_ciclo: novo.usados_no_ciclo
  });
});

app.post("/auth/finalizar-conta-auto", auth, (req, res) => {
  try {
    const loginAtual = req.user.whatsapp;
    const novoLogin = normalizarLoginId(req.body?.login);
    const senha = String(req.body?.senha || "");

    if (!novoLogin || novoLogin.length < 3) {
      return res.status(400).json({ ok:false, error:"Login muito curto" });
    }

    if (!senha || senha.length < 3) {
      return res.status(400).json({ ok:false, error:"Senha muito curta" });
    }

    const clientes = readClientes();
    const clienteAtual = clientes[loginAtual];

    if (!clienteAtual) {
      return res.status(404).json({ ok:false, error:"Conta automática não encontrada" });
    }

    if (clienteAtual.cadastro_automatico !== true || clienteAtual.conta_finalizada === true) {
      return res.status(400).json({ ok:false, error:"Essa conta já foi finalizada" });
    }

    if (clientes[novoLogin] && novoLogin !== loginAtual) {
      return res.status(400).json({
        ok:false,
        error:`Esse login já existe. Tente algo como: ${novoLogin}${Math.floor(Math.random()*99)}`
      });
    }

    clienteAtual.nome_time = novoLogin;
    clienteAtual.senha_hash = bcrypt.hashSync(senha, 8);
    clienteAtual.conta_finalizada = true;
    clienteAtual.finalizado_em = new Date().toISOString();

    if (novoLogin !== loginAtual) {
      clientes[novoLogin] = clienteAtual;
      delete clientes[loginAtual];

      try {
        const pastaAntiga = path.join(PEDIDOS_DIR, loginAtual);
        const pastaNova = path.join(PEDIDOS_DIR, novoLogin);

        if (fs.existsSync(pastaAntiga) && !fs.existsSync(pastaNova)) {
          fs.renameSync(pastaAntiga, pastaNova);
        }
      } catch {}
    } else {
      clientes[loginAtual] = clienteAtual;
    }

    writeClientes(clientes);

    const token = jwt.sign({ whatsapp: novoLogin }, JWT_SECRET, { expiresIn: "7d" });

    return res.json({
      ok:true,
      token,
      whatsapp: novoLogin,
      nome_time: clienteAtual.nome_time,
      plano: clienteAtual.plano,
      saldo_mensal: Number(clienteAtual.saldo_mensal || 0),
      saldo_extra: Number(clienteAtual.saldo_extra || 0),
      ...billingService.getStandaloneArtStatus(clienteAtual),
      saldo: Number(clienteAtual.saldo_mensal || 0) + Number(clienteAtual.saldo_extra || 0),
      usados_no_ciclo: clienteAtual.usados_no_ciclo
    });

  } catch (e) {
    return res.status(500).json({
      ok:false,
      error:"Erro ao finalizar conta automática"
    });
  }
});

app.post("/auth/login", (req, res) => {
  const body = req.body || {};
  const whatsapp = normalizarLoginId(body.whatsapp);
  const senha = body.senha || "";

  if (!whatsapp || !senha) {
    return res.status(400).json({ ok: false, error: "login e senha obrigatórios" });
  }

  const clientes = readClientes();
  const c = clientes[whatsapp];

  if (!c) {
    return res.status(401).json({ ok: false, error: "Login não encontrado" });
  }

  if (!c.ativo) {
    return res.status(403).json({ ok: false, error: "Mensalidade inativa" });
  }

  const ok = bcrypt.compareSync(senha, c.senha_hash);
  if (!ok) {
    return res.status(401).json({ ok: false, error: "Senha incorreta" });
  }

  const mesAtual = nowYYYYMM();
  if (c.ciclo_mes !== mesAtual) {
    c.ciclo_mes = mesAtual;
    c.usados_no_ciclo = 0;
    clientes[whatsapp] = c;
    writeClientes(clientes);
  }

  const token = jwt.sign({ whatsapp }, JWT_SECRET, { expiresIn: "7d" });

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
});

// Perfil
app.get("/me", auth, (req, res) => {
  registrarOnline(req, { ultima_acao: "perfil" });

  const clientes = readClientes();
  const c = clientes[req.user.whatsapp];

  if (!c) {
    return res.status(404).json({ ok: false, error: "Cliente não encontrado" });
  }

  const cicloAtualizado = billingService.refreshManualPlanCycle(c);
  const carrosselCycleBefore = JSON.stringify({
    carrosseis_ciclo: c.carrosseis_ciclo || "",
    carrosseis_criados: c.carrosseis_criados || null
  });
  const billing = billingService.getBillingStatus(c);
  const carrosselUsage = carouselService.carouselUsagePayload(c);
  const carrosselCycleAfter = JSON.stringify({
    carrosseis_ciclo: c.carrosseis_ciclo || "",
    carrosseis_criados: c.carrosseis_criados || null
  });

  if (cicloAtualizado.changed || carrosselCycleBefore !== carrosselCycleAfter) {
    clientes[req.user.whatsapp] = c;
    writeClientes(clientes);
  }

  const bonusTesteVisual = req.user.whatsapp === "15991120599" ? 999 : 0;
  const saldoVisivel = Number(c.saldo_mensal || 0) + Number(c.saldo_extra || 0) + bonusTesteVisual;

  return res.json({
    ok: true,
    nome_time: c.nome_time,
    plano: c.plano,
    plano_atual: billing.plano_atual,
    plano_status: billing.plano_status,
    plano_nome: billing.plano_nome,
    plano_renova_em: billing.plano_renova_em,
    artes_mensais_total: billing.artes_mensais_total,
    artes_mensais_usadas: billing.artes_mensais_usadas,
    artes_mensais_restantes: billing.artes_mensais_restantes,
    artes_avulsas_restantes: billing.artes_avulsas_restantes,
    artes_avulsas_usadas: billing.artes_avulsas_usadas,
    artes_avulsas_total_compradas: billing.artes_avulsas_total_compradas,
    arte_avulsa_valor: billing.arte_avulsa_valor,
    arte_avulsa_produto_id: billing.arte_avulsa_produto_id,
    arte_avulsa_titulo: billing.arte_avulsa_titulo,
    saldo_mensal: Number(c.saldo_mensal || 0),
    saldo_extra: Number(c.saldo_extra || 0),
    saldo: saldoVisivel,
    usados_no_ciclo: c.usados_no_ciclo,
    carrosseis_limite: carrosselUsage.limite_plano,
    carrosseis_usados: carrosselUsage.usado_no_ciclo,
    carrosseis_restantes: carrosselUsage.restante_no_ciclo,
    carrosseis_ciclo: carrosselUsage.ciclo,
    brinde_mascote_disponivel: c.brinde_mascote_disponivel === true,
    ativo: c.ativo,
    billing
  });
});

app.get("/billing/free-art/status", auth, (req, res) => {
  const clientes = readClientes();
  const c = clientes[req.user.whatsapp];

  if (!c) {
    return res.status(404).json({ ok: false, error: "Cliente nao encontrado" });
  }

  return res.json({
    ok: true,
    ...billingService.getFreeArtStatus(c)
  });
});

app.post("/me/fcm-token", auth, (req, res) => {
  const fcmToken = String(req.body?.token || "").trim();
  const platform = String(req.body?.platform || "android").trim().toLowerCase() || "android";

  if (!fcmToken) {
    return res.status(400).json({ ok: false, error: "Token FCM obrigatorio" });
  }

  const clientes = readClientes();
  const c = clientes[req.user.whatsapp];

  if (!c) {
    return res.status(404).json({ ok: false, error: "Cliente nao encontrado" });
  }

  const now = new Date().toISOString();
  c.notificacoes = c.notificacoes && typeof c.notificacoes === "object" && !Array.isArray(c.notificacoes)
    ? c.notificacoes
    : {};

  const existingTokens = Array.isArray(c.notificacoes.fcm_tokens)
    ? c.notificacoes.fcm_tokens.filter(item => item && typeof item === "object" && item.token)
    : [];
  const current = existingTokens.find(item => item.token === fcmToken);

  if (current) {
    current.platform = platform;
    current.ativo = true;
    current.atualizado_em = now;
  } else {
    existingTokens.push({
      token: fcmToken,
      platform,
      ativo: true,
      atualizado_em: now
    });
  }

  c.notificacoes.fcm_tokens = existingTokens;
  clientes[req.user.whatsapp] = c;
  writeClientes(clientes);

  return res.json({
    ok: true,
    salvo: true,
    tokens_ativos: existingTokens.filter(item => item.ativo !== false).length
  });
});

function fcmSenderForType(tipo = "") {
  switch (String(tipo || "").trim().toLowerCase()) {
    case "arte_pronta":
      return fcmService.sendArtePronta;
    case "pedido_atualizado":
      return fcmService.sendPedidoAtualizado;
    case "planejamento_mensal":
      return fcmService.sendPlanejamentoMensal;
    case "nova_versao":
      return fcmService.sendNovaVersao;
    case "aviso_geral":
    default:
      return fcmService.sendAvisoGeral;
  }
}

function deactivateInvalidFcmTokens(whatsapp, invalidTokens = [], reason = "firebase_invalid_token") {
  const tokenSet = new Set(
    (Array.isArray(invalidTokens) ? invalidTokens : [])
      .map((token) => String(token || "").trim())
      .filter(Boolean)
  );

  if (!tokenSet.size) {
    return { deactivated: 0 };
  }

  const clientes = readClientes();
  const cliente = clientes[whatsapp];
  if (!cliente) {
    return { deactivated: 0 };
  }

  cliente.notificacoes = cliente.notificacoes && typeof cliente.notificacoes === "object" && !Array.isArray(cliente.notificacoes)
    ? cliente.notificacoes
    : {};

  const tokens = Array.isArray(cliente.notificacoes.fcm_tokens)
    ? cliente.notificacoes.fcm_tokens
    : [];

  const now = new Date().toISOString();
  let deactivated = 0;

  for (const item of tokens) {
    const token = String(item?.token || "").trim();
    if (!token || !tokenSet.has(token) || item.ativo === false) continue;

    item.ativo = false;
    item.invalidado_em = now;
    item.invalidado_motivo = reason;
    item.atualizado_em = now;
    deactivated += 1;
  }

  if (deactivated > 0) {
    cliente.notificacoes.fcm_tokens = tokens;
    clientes[whatsapp] = cliente;
    writeClientes(clientes);
  }

  return { deactivated };
}

function publicApiUrl(pathname = "") {
  const cleanPath = String(pathname || "").startsWith("/")
    ? String(pathname || "")
    : `/${pathname || ""}`;
  return `${PUBLIC_API_BASE_URL}${cleanPath}`;
}

function sendClientPushAsync(whatsapp, tipo, payload = {}) {
  try {
    const clientes = readClientes();
    const cliente = clientes[whatsapp];

    if (!cliente) {
      console.warn("[fcm] cliente nao encontrado", { whatsapp, tipo });
      return;
    }

    const sender = fcmSenderForType(tipo);
    const invalidTokens = [];
    sender(cliente, payload, {
      onInvalidToken: (token) => invalidTokens.push(token)
    })
      .then((result) => {
        const cleanup = deactivateInvalidFcmTokens(whatsapp, invalidTokens);
        if (cleanup.deactivated > 0) {
          result.tokens_invalidos_desativados = cleanup.deactivated;
          console.warn("[fcm] tokens invalidos desativados", {
            whatsapp,
            tipo,
            deactivated: cleanup.deactivated
          });
        }

        if (!result?.ok) {
          console.warn("[fcm] push nao enviado", { whatsapp, tipo, result });
          return;
        }
        console.log("[fcm] push enviado", {
          whatsapp,
          tipo,
          sent: result.sent || 0,
          mock: result.mock === true
        });
      })
      .catch((error) => {
        console.warn("[fcm] falha ao enviar push", {
          whatsapp,
          tipo,
          message: error?.message
        });
      });
  } catch (error) {
    console.warn("[fcm] falha ao preparar push", {
      whatsapp,
      tipo,
      message: error?.message
    });
  }
}

app.post("/bot/notificacoes/teste", botRunnerAuth, async (req, res) => {
  if (!isBotAdmin(req)) {
    return res.status(403).json({ ok: false, error: "Acesso negado" });
  }

  const whatsapp = String(req.body?.whatsapp || "").trim();
  const tipo = String(req.body?.tipo || "aviso_geral").trim() || "aviso_geral";

  if (!whatsapp) {
    return res.status(400).json({ ok: false, error: "WhatsApp obrigatorio" });
  }

  const clientes = readClientes();
  const cliente = clientes[whatsapp];

  if (!cliente) {
    return res.status(404).json({ ok: false, error: "Cliente nao encontrado" });
  }

  try {
    const sender = fcmSenderForType(tipo);
    const invalidTokens = [];
    const result = await sender(cliente, {
      title: req.body?.title,
      body: req.body?.body || req.body?.message,
      pedido_id: req.body?.pedido_id,
      planejamento_id: req.body?.planejamento_id,
      planejamento_item_id: req.body?.planejamento_item_id,
      latest_version_code: req.body?.latest_version_code,
      latest_version_name: req.body?.latest_version_name,
      image_url: req.body?.image_url || req.body?.imageUrl || req.body?.image || req.body?.picture,
      data: req.body?.data && typeof req.body.data === "object" ? req.body.data : {}
    }, {
      onInvalidToken: (token) => invalidTokens.push(token)
    });

    const cleanup = deactivateInvalidFcmTokens(whatsapp, invalidTokens);
    if (cleanup.deactivated > 0) {
      result.tokens_invalidos_desativados = cleanup.deactivated;
    }

    return res.json({ ok: result?.ok === true, result });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || "Falha ao enviar notificacao de teste"
    });
  }
});

// ===== MERCADO PAGO =====
async function createMercadoPagoPixPayment({ amount, description, payerKey, externalReference, metadata, idempotencyKey }) {
  if (!MP_ACCESS_TOKEN) {
    const error = new Error("MP_ACCESS_TOKEN nao configurado");
    error.statusCode = 500;
    throw error;
  }

  const payerEmail = `${String(payerKey).replace(/\D/g, "") || "cliente"}@ia4tube.com.br`;
  const paymentPayload = {
    transaction_amount: Number(Number(amount).toFixed(2)),
    description,
    payment_method_id: "pix",
    payer: {
      email: payerEmail
    },
    external_reference: externalReference,
    metadata,
    notification_url: MP_NOTIFICATION_URL
  };

  const r = await fetch("https://api.mercadopago.com/v1/payments", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${MP_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
      "X-Idempotency-Key": idempotencyKey
    },
    body: JSON.stringify(paymentPayload)
  });

  const data = await r.json();

  if (!r.ok) {
    const error = new Error("Erro ao gerar Pix");
    error.statusCode = 500;
    error.detail = data;
    throw error;
  }

  const transactionData = data.point_of_interaction?.transaction_data || {};
  return {
    data,
    pixCopiaCola: transactionData.qr_code || "",
    qrCodeBase64: transactionData.qr_code_base64 || "",
    ticketUrl: transactionData.ticket_url || ""
  };
}

app.get("/billing/status", auth, (req, res) => {
  const clientes = readClientes();
  const c = clientes[req.user.whatsapp];

  if (!c) {
    return res.status(404).json({ ok: false, error: "Cliente nao encontrado" });
  }

  const cicloAtualizado = billingService.refreshManualPlanCycle(c);
  if (cicloAtualizado.changed) {
    clientes[req.user.whatsapp] = c;
    writeClientes(clientes);
  }

  return res.json({
    ok: true,
    ...billingService.getBillingStatus(c)
  });
});

function createArteAvulsaPurchaseId(whatsapp) {
  const cleanWhatsapp = String(whatsapp || "").replace(/\W+/g, "").slice(0, 32) || "cliente";
  return `arte_avulsa_${cleanWhatsapp}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

async function criarArteAvulsaPixHandler(req, res) {
  try {
    const whatsapp = req.user.whatsapp;
    const clientes = readClientes();
    const c = clientes[whatsapp];

    if (!c) {
      return res.status(404).json({ ok: false, error: "Cliente nao encontrado" });
    }

    const produto = billingPlans.getSingleArtPurchase();
    const quantidade = Math.max(
      1,
      Math.min(20, Math.round(Number(req.body?.quantidade || produto.quantity || 1)))
    );
    const valorTotal = billingService.roundMoney(Number(produto.amount) * quantidade);
    const purchaseId = createArteAvulsaPurchaseId(whatsapp);

    const result = await createMercadoPagoPixPayment({
      amount: valorTotal,
      description: quantidade > 1 ? `${produto.title} (${quantidade} artes)` : produto.title,
      payerKey: whatsapp,
      externalReference: `arte_avulsa_pix|${whatsapp}|${purchaseId}`,
      metadata: {
        tipo: "arte_avulsa_pix",
        whatsapp,
        purchase_id: purchaseId,
        produto_id: produto.id,
        quantidade,
        valor_unitario: Number(produto.amount),
        valor_pago: valorTotal
      },
      idempotencyKey: `arte_avulsa_pix_${purchaseId}`
    });

    billingService.recordStandaloneArtPurchasePending(c, {
      purchaseId,
      paymentId: String(result.data.id || ""),
      amount: valorTotal,
      quantity: quantidade,
      createdAt: new Date().toISOString()
    });
    clientes[whatsapp] = c;
    writeClientes(clientes);

    return res.json({
      ok: true,
      pix_copia_cola: result.pixCopiaCola,
      qr_code_base64: result.qrCodeBase64,
      ticket_url: result.ticketUrl,
      payment_id: result.data.id,
      purchase_id: purchaseId,
      tipo: "arte_avulsa_pix",
      produto_id: produto.id,
      valor_pago: valorTotal,
      valor_unitario: Number(produto.amount),
      quantidade,
      cta_label: quantidade > 1
        ? `Comprar ${quantidade} artes por R$ ${valorTotal.toFixed(2).replace(".", ",")}`
        : "Comprar 1 arte por R$ 5,99",
      artes_avulsas_restantes: Number(c.artes_avulsas_restantes || 0)
    });
  } catch (e) {
    return res.status(e.statusCode || 500).json({
      ok: false,
      error: e.message || "Erro interno ao gerar Pix da arte avulsa",
      detalhe: e.detail
    });
  }
}

app.post("/billing/arte-avulsa/pix", auth, criarArteAvulsaPixHandler);
app.post("/billing/artes-avulsas/pix", auth, criarArteAvulsaPixHandler);

app.post("/billing/saldo/pix", auth, async (req, res) => {
  try {
    const { pacote = "saldo_990" } = req.body || {};
    const whatsapp = req.user.whatsapp;
    const p = billingPlans.getBalancePackage(pacote);

    if (!p) {
      return res.status(400).json({ ok: false, error: "Pacote invalido" });
    }

    const result = await createMercadoPagoPixPayment({
      amount: p.amount,
      description: p.title,
      payerKey: whatsapp,
      externalReference: `saldo_extra|${whatsapp}|${p.id}|${Date.now()}`,
      metadata: {
        tipo: "saldo_extra",
        whatsapp,
        pacote: p.id,
        credito: Number(p.credit)
      },
      idempotencyKey: `saldo_extra_${whatsapp}_${p.id}_${Date.now()}`
    });

    return res.json({
      ok: true,
      pix_copia_cola: result.pixCopiaCola,
      qr_code_base64: result.qrCodeBase64,
      ticket_url: result.ticketUrl,
      payment_id: result.data.id,
      pacote: p.id,
      valor_pago: Number(p.amount),
      credito: Number(p.credit)
    });
  } catch (e) {
    return res.status(e.statusCode || 500).json({
      ok: false,
      error: e.message || "Erro interno ao gerar Pix",
      detalhe: e.detail
    });
  }
});

app.post("/billing/planos/:planId/pix", auth, async (req, res) => {
  try {
    const whatsapp = req.user.whatsapp;
    const plan = billingPlans.getPlan(req.params.planId);

    if (!plan) {
      return res.status(400).json({ ok: false, error: "Combo invalido" });
    }

    const result = await createMercadoPagoPixPayment({
      amount: plan.price,
      description: `IA4Tube - ${plan.name}`,
      payerKey: whatsapp,
      externalReference: `plano_pix|${whatsapp}|${plan.id}|${Date.now()}`,
      metadata: {
        tipo: "plano_pix",
        whatsapp,
        plan_id: plan.id,
        plan_name: plan.name,
        artes_mes: Number(plan.artsPerMonth)
      },
      idempotencyKey: `plano_pix_${whatsapp}_${plan.id}_${Date.now()}`
    });

    return res.json({
      ok: true,
      pix_copia_cola: result.pixCopiaCola,
      qr_code_base64: result.qrCodeBase64,
      ticket_url: result.ticketUrl,
      payment_id: result.data.id,
      plan_id: plan.id,
      plan_name: plan.name,
      valor_pago: Number(plan.price),
      artes_mes: Number(plan.artsPerMonth)
    });
  } catch (e) {
    return res.status(e.statusCode || 500).json({
      ok: false,
      error: e.message || "Erro interno ao gerar Pix",
      detalhe: e.detail
    });
  }
});

app.post("/comprar-creditos", auth, async (req, res) => {
  try {
    if (!MP_ACCESS_TOKEN) {
      return res.status(500).json({ ok: false, error: "MP_ACCESS_TOKEN não configurado" });
    }

    const { pacote } = req.body || {};
    const whatsapp = req.user.whatsapp;

    const pacotes = {
      saldo_800: { titulo: "Saldo IA4Tube - R$8", valor_pago: 8.00, credito: 8.00 },
      saldo_1800: { titulo: "Saldo IA4Tube - R$18", valor_pago: 18.00, credito: 18.00 },
      saldo_2800: { titulo: "Saldo IA4Tube - R$28", valor_pago: 28.00, credito: 28.00 },
      saldo_4800: { titulo: "Saldo IA4Tube - R$48", valor_pago: 48.00, credito: 48.00 }
    };

    const p = pacotes[pacote];

    if (!p) {
      return res.status(400).json({ ok: false, error: "Pacote inválido" });
    }

    const preference = {
      items: [{
        title: p.titulo,
        quantity: 1,
        currency_id: "BRL",
        unit_price: Number(p.valor_pago)
      }],
      external_reference: `${whatsapp}|${pacote}|${Date.now()}`,
      metadata: {
        tipo: "saldo",
        whatsapp,
        pacote,
        credito: Number(p.credito)
      },
      back_urls: {
        success: "https://ia4tube.com/app.html",
        failure: "https://ia4tube.com/app.html",
        pending: "https://ia4tube.com/app.html"
      },
      notification_url: "https://ia4tube-api.onrender.com/webhook/mercadopago",
      auto_return: "approved"
    };

    const r = await fetch("https://api.mercadopago.com/checkout/preferences", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${MP_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(preference)
    });

    const data = await r.json();

    if (!r.ok) {
      return res.status(500).json({ ok: false, error: "Erro ao criar checkout", detalhe: data });
    }

    return res.json({
      ok: true,
      init_point: data.init_point,
      sandbox_init_point: data.sandbox_init_point
    });

  } catch (e) {
    return res.status(500).json({ ok: false, error: "Erro interno ao criar compra" });
  }
});

app.post("/comprar-creditos-pix", auth, async (req, res) => {
  try {
    if (!MP_ACCESS_TOKEN) {
      return res.status(500).json({ ok: false, error: "MP_ACCESS_TOKEN não configurado" });
    }

    const { pacote } = req.body || {};
    const whatsapp = req.user.whatsapp;

    const pacotes = {
      saldo_800: { titulo: "Saldo IA4Tube - R$8", valor_pago: 8.00, credito: 8.00 },
      saldo_1800: { titulo: "Saldo IA4Tube - R$18", valor_pago: 18.00, credito: 18.00 },
      saldo_2800: { titulo: "Saldo IA4Tube - R$28", valor_pago: 28.00, credito: 28.00 },
      saldo_4800: { titulo: "Saldo IA4Tube - R$48", valor_pago: 48.00, credito: 48.00 }
    };

    const p = pacotes[pacote];

    if (!p) {
      return res.status(400).json({ ok: false, error: "Pacote inválido" });
    }

    const payerEmail = `${String(whatsapp).replace(/\D/g, "") || "cliente"}@ia4tube.com.br`;
    const paymentPayload = {
      transaction_amount: Number(Number(p.valor_pago).toFixed(2)),
      description: p.titulo,
      payment_method_id: "pix",
      payer: {
        email: payerEmail
      },
      external_reference: `saldo_pix|${whatsapp}|${pacote}|${Date.now()}`,
      metadata: {
        tipo: "saldo",
        whatsapp,
        pacote,
        credito: Number(p.credito)
      },
      notification_url: "https://ia4tube-api.onrender.com/webhook/mercadopago"
    };

    const r = await fetch("https://api.mercadopago.com/v1/payments", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${MP_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
        "X-Idempotency-Key": `saldo_pix_${whatsapp}_${pacote}_${Date.now()}`
      },
      body: JSON.stringify(paymentPayload)
    });

    const data = await r.json();

    if (!r.ok) {
      return res.status(500).json({ ok: false, error: "Erro ao gerar Pix", detalhe: data });
    }

    const transactionData = data.point_of_interaction?.transaction_data || {};

    return res.json({
      ok: true,
      pix_copia_cola: transactionData.qr_code || "",
      qr_code_base64: transactionData.qr_code_base64 || "",
      ticket_url: transactionData.ticket_url || "",
      payment_id: data.id,
      valor_pago: Number(p.valor_pago),
      credito: Number(p.credito)
    });

  } catch (e) {
    return res.status(500).json({ ok: false, error: "Erro interno ao gerar Pix" });
  }
});

app.post("/webhook/mercadopago", async (req, res) => {
  try {
    const body = req.body || {};
    const paymentId = body?.data?.id || body?.id || req.query?.id;

    if (!paymentId) {
      return res.json({ ok: true });
    }

    let processados = readMpProcessados();
    const registroAtual = processados[paymentId];

    if (registroAtual && registroAtual.status !== "processando") {
      return res.json({ ok: true, duplicado: true });
    }

    if (registroAtual && !isMpProcessandoStale(registroAtual)) {
      return res.json({ ok: true, processando: true });
    }

    processados[paymentId] = {
      status: "processando",
      criado_em: registroAtual?.criado_em || new Date().toISOString(),
      ultima_tentativa_em: new Date().toISOString(),
      tentativas: Number(registroAtual?.tentativas || 0) + 1
    };

    writeMpProcessados(processados);

    const r = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: {
        "Authorization": `Bearer ${MP_ACCESS_TOKEN}`
      }
    });

    const pagamento = await r.json();

    if (!r.ok || pagamento.status !== "approved") {
      processados = readMpProcessados();
      delete processados[paymentId];
      writeMpProcessados(processados);

      return res.json({ ok: true, status: pagamento.status || "ignorado" });
    }

    const external = String(pagamento.external_reference || "");
    const tipo = pagamento.metadata?.tipo || "";

    if (tipo === "pedido_pix") {
      const whatsapp = pagamento.metadata?.whatsapp || external.split("|")[1];
      const pedidoId = pagamento.metadata?.pedido_id || external.split("|")[2];

      if (!whatsapp || !pedidoId) {
        processados = readMpProcessados();
        processados[paymentId] = {
          tipo: "pedido_pix",
          status: "erro_sem_pedido",
          criado_em: new Date().toISOString()
        };
        writeMpProcessados(processados);
        return res.json({ ok: true });
      }

      const base = getPedidoBase(whatsapp, pedidoId);

      if (!base) {
        processados = readMpProcessados();
        processados[paymentId] = {
          tipo: "pedido_pix",
          whatsapp,
          pedido_id: pedidoId,
          status: "pedido_nao_encontrado",
          criado_em: new Date().toISOString()
        };
        writeMpProcessados(processados);
        return res.json({ ok: true });
      }

      const pedidoPath = path.join(base, "pedido.json");
      const pedido = safeReadJson(pedidoPath) || {};

      if (pedido.pagamento_pendente !== true) {
        processados = readMpProcessados();
        processados[paymentId] = {
          tipo: "pedido_pix",
          whatsapp,
          pedido_id: pedidoId,
          status: "ja_liberado",
          criado_em: new Date().toISOString()
        };
        writeMpProcessados(processados);
        return res.json({ ok: true });
      }

      if (String(pedido.mp_payment_id || "") !== String(paymentId)) {
        processados = readMpProcessados();
        processados[paymentId] = {
          tipo: "pedido_pix",
          whatsapp,
          pedido_id: pedidoId,
          status: "payment_id_divergente",
          criado_em: new Date().toISOString()
        };
        writeMpProcessados(processados);
        return res.json({ ok: true });
      }

      pedido.pagamento_pendente = false;
      pedido.pagamento_metodo = "pix";
      pedido.pagamento_confirmado_em = new Date().toISOString();
      pedido.mp_payment_status = "approved";

      const deveCreditarBonusPedido = pedido.creditar_saldo_ao_pagar_pix === true;
      const valorBonusPedido = deveCreditarBonusPedido ? Number(
        pedido.valor_pendente ||
        pagamento.metadata?.valor_pendente ||
        pagamento.transaction_amount ||
        0
      ) : 0;

      if (valorBonusPedido > 0) {
        const clientes = readClientes();
        const c = clientes[whatsapp];

        if (c) {
          c.saldo_extra = Number(c.saldo_extra || 0) + valorBonusPedido;
          clientes[whatsapp] = c;
          writeClientes(clientes);
          pedido.bonus_saldo_extra = valorBonusPedido;
          pedido.bonus_saldo_extra_em = new Date().toISOString();
        }
      }

      fs.writeFileSync(pedidoPath, JSON.stringify(pedido, null, 2), "utf8");

      processados = readMpProcessados();
      processados[paymentId] = {
        tipo: "pedido_pix",
        whatsapp,
        pedido_id: pedidoId,
        status: pagamento.status,
        criado_em: new Date().toISOString()
      };
      writeMpProcessados(processados);

      registrarEventoServidor("pix_pago", {
        whatsapp,
        pedidoId,
        produto: pedido.product_id || pedido.categoria || "pedido",
        payload: {
          tipo: "pedido_pix",
          valor_pago: Number(pagamento.transaction_amount || pedido.valor_pendente || 0),
          status: pagamento.status
        }
      });
      registrarEventoServidor("compra_aprovada", {
        whatsapp,
        pedidoId,
        produto: pedido.product_id || pedido.categoria || "pedido",
        payload: {
          tipo: "pedido_pix",
          valor_pago: Number(pagamento.transaction_amount || pedido.valor_pendente || 0)
        }
      });
      if (valorBonusPedido > 0) {
        registrarEventoServidor("saldo_creditado", {
          whatsapp,
          pedidoId,
          produto: "saldo_extra",
          payload: {
            tipo: "bonus_pedido_pix",
            credito: valorBonusPedido
          }
        });
      }

      return res.json({ ok: true });
    }

    if (tipo === "plano_pix") {
      const whatsapp = pagamento.metadata?.whatsapp || external.split("|")[1];
      const planId = pagamento.metadata?.plan_id || external.split("|")[2];
      const plan = billingPlans.getPlan(planId);

      if (!whatsapp || !plan) {
        processados = readMpProcessados();
        processados[paymentId] = {
          tipo: "plano_pix",
          whatsapp,
          plan_id: planId,
          status: "erro_plano_invalido",
          criado_em: new Date().toISOString()
        };
        writeMpProcessados(processados);
        return res.json({ ok: true });
      }

      const clientes = readClientes();
      const c = clientes[whatsapp];

      if (!c) {
        processados = readMpProcessados();
        processados[paymentId] = {
          tipo: "plano_pix",
          whatsapp,
          plan_id: plan.id,
          status: "cliente_nao_encontrado",
          criado_em: new Date().toISOString()
        };
        writeMpProcessados(processados);
        return res.json({ ok: true });
      }

      const resultadoPlano = billingService.applyManualPlanPayment(c, plan, {
        paymentId: String(paymentId),
        paidAt: pagamento.date_approved || pagamento.date_last_updated || new Date().toISOString()
      });

      c.ultimo_pix_plano_valor = Number(pagamento.transaction_amount || plan.price);
      c.ultimo_pix_plano_status = resultadoPlano.status;
      clientes[whatsapp] = c;
      writeClientes(clientes);

      processados = readMpProcessados();
      processados[paymentId] = {
        tipo: "plano_pix",
        whatsapp,
        plan_id: plan.id,
        plano_status: resultadoPlano.status,
        status: pagamento.status,
        criado_em: new Date().toISOString()
      };
      writeMpProcessados(processados);

      registrarEventoServidor("pix_pago", {
        whatsapp,
        produto: "combo",
        payload: {
          tipo: "plano_pix",
          plano_id: plan.id,
          valor_pago: Number(pagamento.transaction_amount || plan.price),
          status: pagamento.status
        }
      });
      registrarEventoServidor("compra_aprovada", {
        whatsapp,
        produto: "combo",
        payload: {
          tipo: "plano_pix",
          plano_id: plan.id,
          plano_status: resultadoPlano.status,
          artes_mes: Number(plan.artsPerMonth || 0)
        }
      });
      registrarEventoServidor("saldo_creditado", {
        whatsapp,
        produto: "combo",
        payload: {
          tipo: "combo_artes_mensais",
          plano_id: plan.id,
          artes_mes: Number(plan.artsPerMonth || 0),
          plano_status: resultadoPlano.status
        }
      });

      return res.json({ ok: true });
    }

    if (tipo === "arte_avulsa_pix") {
      const externalParts = external.split("|");
      const whatsapp = String(pagamento.metadata?.whatsapp || externalParts[1] || "").trim();
      const purchaseId = String(pagamento.metadata?.purchase_id || externalParts[2] || "").trim();
      const produto = billingPlans.getSingleArtPurchase();
      const quantidade = Math.max(1, Math.round(Number(pagamento.metadata?.quantidade || produto.quantity || 1)));
      const valorPago = billingService.roundMoney(pagamento.transaction_amount || pagamento.metadata?.valor_pago || 0);
      const valorEsperado = billingService.roundMoney(Number(produto.amount) * quantidade);

      if (!whatsapp || !purchaseId || valorPago !== valorEsperado) {
        processados = readMpProcessados();
        processados[paymentId] = {
          tipo: "arte_avulsa_pix",
          whatsapp,
          purchase_id: purchaseId,
          valor_pago: valorPago,
          valor_esperado: valorEsperado,
          status: "erro_dados_ou_valor_invalido",
          criado_em: new Date().toISOString()
        };
        writeMpProcessados(processados);
        return res.json({ ok: true });
      }

      const clientes = readClientes();
      const c = clientes[whatsapp];

      if (!c) {
        processados = readMpProcessados();
        processados[paymentId] = {
          tipo: "arte_avulsa_pix",
          whatsapp,
          purchase_id: purchaseId,
          status: "cliente_nao_encontrado",
          criado_em: new Date().toISOString()
        };
        writeMpProcessados(processados);
        return res.json({ ok: true });
      }

      const credito = billingService.creditStandaloneArtPurchase(c, {
        purchaseId,
        paymentId: String(paymentId),
        amount: valorPago,
        quantity: quantidade,
        paidAt: pagamento.date_approved || pagamento.date_last_updated || new Date().toISOString()
      });

      clientes[whatsapp] = c;
      writeClientes(clientes);

      processados = readMpProcessados();
      processados[paymentId] = {
        tipo: "arte_avulsa_pix",
        whatsapp,
        purchase_id: purchaseId,
        produto_id: produto.id,
        quantidade,
        valor_pago: valorPago,
        creditado: credito.credited === true,
        duplicado: credito.duplicate === true,
        artes_avulsas_restantes: Number(c.artes_avulsas_restantes || 0),
        status: pagamento.status,
        criado_em: new Date().toISOString()
      };
      writeMpProcessados(processados);

      registrarEventoServidor("pix_pago", {
        whatsapp,
        produto: "arte_avulsa",
        payload: {
          tipo: "arte_avulsa_pix",
          produto_id: produto.id,
          quantidade,
          valor_pago: valorPago,
          status: pagamento.status
        }
      });
      registrarEventoServidor("compra_aprovada", {
        whatsapp,
        produto: "arte_avulsa",
        payload: {
          tipo: "arte_avulsa_pix",
          produto_id: produto.id,
          quantidade,
          valor_pago: valorPago
        }
      });
      if (credito.credited === true) {
        registrarEventoServidor("saldo_creditado", {
          whatsapp,
          produto: "arte_avulsa",
          payload: {
            tipo: "arte_avulsa",
            quantidade,
            artes_avulsas_restantes: Number(c.artes_avulsas_restantes || 0)
          }
        });
      }

      return res.json({ ok: true });
    }

    if (tipo !== "saldo" && tipo !== "saldo_extra") {
      processados = readMpProcessados();
      processados[paymentId] = {
        tipo: tipo || "desconhecido",
        status: "ignorado",
        criado_em: new Date().toISOString()
      };
      writeMpProcessados(processados);
      return res.json({ ok: true, status: "tipo_ignorado" });
    }

    const externalParts = external.split("|");
    let whatsapp = String(pagamento.metadata?.whatsapp || "").trim();

    if (!whatsapp) {
      if (tipo === "saldo_extra" && externalParts[0] === "saldo_extra") {
        whatsapp = String(externalParts[1] || "").trim();
      } else {
        whatsapp = String(externalParts[0] || "").trim();
      }
    }

    const credito = Number(pagamento.metadata?.credito || 0);
    const clienteReferenciaValida = whatsapp &&
      whatsapp !== "saldo" &&
      whatsapp !== "saldo_extra" &&
      !whatsapp.includes("|");

    if (!clienteReferenciaValida || !credito) {
      processados = readMpProcessados();
      processados[paymentId] = {
        tipo,
        whatsapp,
        credito,
        payment_id: String(paymentId),
        external_reference: external,
        status: "erro_sem_whatsapp_ou_credito",
        criado_em: new Date().toISOString()
      };
      writeMpProcessados(processados);
      return res.json({ ok: true, error: "sem whatsapp ou credito" });
    }

    const clientes = readClientes();
    const c = clientes[whatsapp];

    if (!c) {
      console.warn("[mercadopago webhook] cliente_nao_encontrado", {
        paymentId: String(paymentId),
        tipo,
        whatsapp,
        external_reference: external
      });
      processados = readMpProcessados();
      processados[paymentId] = {
        tipo,
        whatsapp,
        credito,
        payment_id: String(paymentId),
        external_reference: external,
        status: "cliente_nao_encontrado",
        criado_em: new Date().toISOString()
      };
      writeMpProcessados(processados);
      return res.json({ ok: true, error: "cliente não encontrado" });
    }

    c.saldo_extra = Number(c.saldo_extra || 0) + credito;
    c.ativo = true;

    if (c.brinde_mascote_ja_liberado !== true) {
      c.brinde_mascote_disponivel = true;
      c.brinde_mascote_ja_liberado = true;
      c.brinde_mascote_liberado_em = new Date().toISOString();
    }

    clientes[whatsapp] = c;
    writeClientes(clientes);

    processados = readMpProcessados();
    processados[paymentId] = {
      tipo,
      whatsapp,
      credito,
      status: pagamento.status,
      criado_em: new Date().toISOString()
    };

    writeMpProcessados(processados);

    registrarEventoServidor("pix_pago", {
      whatsapp,
      produto: "saldo_extra",
      payload: {
        tipo,
        credito,
        status: pagamento.status
      }
    });
    registrarEventoServidor("compra_aprovada", {
      whatsapp,
      produto: "saldo_extra",
      payload: {
        tipo,
        credito
      }
    });
    registrarEventoServidor("saldo_creditado", {
      whatsapp,
      produto: "saldo_extra",
      payload: {
        tipo,
        credito,
        saldo_extra: Number(c.saldo_extra || 0)
      }
    });

    return res.json({ ok: true });

  } catch (e) {
    return res.json({ ok: true });
  }
});

// ===== MATERIAIS GRAFICOS DA EMPRESA =====
app.get("/empresa/materiais-graficos", auth, (req, res) => {
  const whatsapp = req.user.whatsapp;
  const clientes = readClientes();
  const cliente = clientes[whatsapp];

  if (!cliente) {
    return res.status(404).json({ ok: false, error: "Cliente nao encontrado" });
  }

  try {
    const requestedRamo = String(req.query?.ramo || cliente.ramo || cliente.nicho || "").trim();
    const payload = graphicMaterialsService.publicListPayload({
      cliente,
      ramo: requestedRamo,
      baseDir: GRAPHIC_MATERIALS_DIR,
      whatsapp
    });
    const generalCount = payload.materiais.filter((material) => material.scope !== "ramo").length;
    const branchCount = payload.materiais.filter((material) => material.scope === "ramo").length;
    console.log("[materiais-graficos] listagem", {
      whatsapp,
      ramo_recebido: req.query?.ramo || "",
      ramo_usado: requestedRamo,
      ramo_resolvido: graphicMaterialsCatalog.folderForRamo(requestedRamo),
      materiais_gerais: generalCount,
      materiais_ramo: branchCount,
      plano_atual: cliente.plano_atual || cliente.plano || "",
      plano_status: cliente.plano_status || "",
      plano_ativo: billingService.isPlanActive(cliente)
    });
    clientes[whatsapp] = cliente;
    writeClientes(clientes);
    return res.json(payload);
  } catch (error) {
    console.error("[materiais-graficos] erro ao listar", {
      whatsapp,
      message: error?.message,
      stack: error?.stack
    });
    return res.status(500).json({
      ok: false,
      error: "Nao foi possivel listar os materiais graficos agora."
    });
  }
});

app.post(
  "/empresa/materiais-graficos/:materialId/solicitar",
  auth,
  upload.single("logo"),
  (req, res) => {
    const whatsapp = req.user.whatsapp;
    const clientes = readClientes();
    const cliente = clientes[whatsapp];

    if (!cliente) {
      if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return res.status(404).json({ ok: false, error: "Cliente nao encontrado" });
    }

    try {
      const document = graphicMaterialsService.createRequest({
        baseDir: GRAPHIC_MATERIALS_DIR,
        cliente,
        whatsapp,
        materialId: req.params.materialId,
        body: req.body || {},
        logoPath: req.file?.path || ""
      });

      clientes[whatsapp] = cliente;
      writeClientes(clientes);

      return res.json({
        ok: true,
        document_id: document.document_id,
        material_id: document.material_id,
        title: document.title,
        scope: document.scope,
        ciclo: document.ciclo,
        status: "processing",
        status_label: "Em produção"
      });
    } catch (error) {
      console.error("[materiais-graficos] erro ao solicitar", {
        whatsapp,
        materialId: req.params.materialId,
        message: error?.message,
        stack: error?.stack
      });
      return res.status(error?.statusCode || 500).json({
        ok: false,
        code: error?.code || "graphic_material_request_error",
        error: error?.message || "Nao foi possivel solicitar o material grafico agora."
      });
    } finally {
      if (req.file?.path && fs.existsSync(req.file.path)) {
        try {
          fs.unlinkSync(req.file.path);
        } catch {}
      }
    }
  }
);

app.get("/empresa/materiais-graficos/:materialId/status", auth, (req, res) => {
  const whatsapp = req.user.whatsapp;
  const clientes = readClientes();
  const cliente = clientes[whatsapp];

  if (!cliente) {
    return res.status(404).json({ ok: false, error: "Cliente nao encontrado" });
  }

  try {
    const payload = graphicMaterialsService.materialStatusPayload({
      cliente,
      ramo: req.query?.ramo || "",
      baseDir: GRAPHIC_MATERIALS_DIR,
      whatsapp,
      materialId: req.params.materialId
    });
    clientes[whatsapp] = cliente;
    writeClientes(clientes);
    return res.json(payload);
  } catch (error) {
    return res.status(error?.statusCode || 500).json({
      ok: false,
      code: error?.code || "graphic_material_status_error",
      error: error?.message || "Nao foi possivel consultar o status do material grafico."
    });
  }
});

app.get("/empresa/materiais-graficos/:materialId/download", auth, (req, res) => {
  const whatsapp = req.user.whatsapp;
  const clientes = readClientes();
  const cliente = clientes[whatsapp];

  if (!cliente) {
    return res.status(404).json({ ok: false, error: "Cliente nao encontrado" });
  }

  try {
    const document = graphicMaterialsService.downloadForMaterial({
      baseDir: GRAPHIC_MATERIALS_DIR,
      cliente,
      whatsapp,
      materialId: req.params.materialId
    });

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Content-Disposition", `attachment; filename="${document.filename}"`);
    return res.sendFile(document.filePath);
  } catch (error) {
    return res.status(error?.statusCode || 500).json({
      ok: false,
      code: error?.code || "graphic_material_download_error",
      error: error?.message || "Material grafico nao encontrado"
    });
  }
});

app.get("/bot/empresa/materiais-graficos/novos", botRunnerAuth, (req, res) => {
  if (!isBotAdmin(req)) {
    return res.status(403).json({ ok: false, error: "Acesso negado" });
  }

  const limit = Number(req.query?.limit || 5);
  const materiais = graphicMaterialsService.listBotPending({
    baseDir: GRAPHIC_MATERIALS_DIR,
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 50) : 5
  });

  return res.json({ ok: true, materiais });
});

app.get("/bot/empresa/materiais-graficos/:documentId/zip", botRunnerAuth, (req, res) => {
  if (!isBotAdmin(req)) {
    return res.status(403).json({ ok: false, error: "Acesso negado" });
  }

  const request = graphicMaterialsService.findRequestByDocument({
    baseDir: GRAPHIC_MATERIALS_DIR,
    documentId: req.params.documentId
  });

  if (!request) {
    return res.status(404).json({ ok: false, error: "Solicitacao nao encontrada" });
  }

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${req.params.documentId}.zip"`);

  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.on("error", err => res.status(500).end(String(err)));
  archive.pipe(res);
  archive.directory(request.base_path, false);
  archive.finalize();
});

app.post("/bot/empresa/materiais-graficos/:documentId/status", botRunnerAuth, (req, res) => {
  if (!isBotAdmin(req)) {
    return res.status(403).json({ ok: false, error: "Acesso negado" });
  }

  const request = graphicMaterialsService.findRequestByDocument({
    baseDir: GRAPHIC_MATERIALS_DIR,
    documentId: req.params.documentId
  });

  if (!request) {
    return res.status(404).json({ ok: false, error: "Solicitacao nao encontrada" });
  }

  const updated = graphicMaterialsService.updateRequestStatus(
    request,
    String(req.body?.status || "processando"),
    String(req.body?.message || "")
  );

  return res.json({
    ok: true,
    document_id: updated.document_id || updated.id,
    status: updated.status
  });
});

app.post(
  "/bot/empresa/materiais-graficos/:documentId/upload-resultado",
  botRunnerAuth,
  uploadResultado.fields([
    { name: "resultado", maxCount: 1 },
    { name: "preview", maxCount: 1 }
  ]),
  (req, res) => {
    if (!isBotAdmin(req)) {
      cleanupUploadedFiles(req.files);
      return res.status(403).json({ ok: false, error: "Acesso negado" });
    }

    const resultadoFile = req.files?.resultado?.[0] || null;
    const previewFile = req.files?.preview?.[0] || null;

    if (!resultadoFile) {
      cleanupUploadedFiles(req.files);
      return res.status(400).json({ ok: false, error: "Arquivo resultado nao enviado" });
    }

    try {
      const apiInfo = req.body?.api_info ? JSON.parse(req.body.api_info) : {};
      const request = graphicMaterialsService.saveUploadedResult({
        baseDir: GRAPHIC_MATERIALS_DIR,
        documentId: req.params.documentId,
        resultPath: resultadoFile.path,
        previewPath: previewFile?.path || "",
        apiInfo
      });

      const clientes = readClientes();
      const cliente = clientes[request.whatsapp];
      if (cliente) {
        graphicMaterialsService.markClientCreated(cliente, request);
        clientes[request.whatsapp] = cliente;
        writeClientes(clientes);
      }

      return res.json({
        ok: true,
        document_id: request.document_id || request.id,
        material_id: request.material_id,
        status: "created",
        arquivo: "resultado_final.png",
        preview: previewFile ? "preview_ia4tube.jpg" : ""
      });
    } catch (error) {
      cleanupUploadedFiles(req.files);
      console.error("[materiais-graficos] falha ao salvar resultado", {
        documentId: req.params.documentId,
        message: error?.message,
        stack: error?.stack
      });
      return res.status(error?.statusCode || 500).json({
        ok: false,
        error: error?.message || "Falha ao salvar resultado"
      });
    }
  }
);

// ===== CARROSSEIS IA4TUBE =====
app.post(
  "/empresa/carrosseis/solicitar",
  auth,
  upload.fields([
    { name: "logo", maxCount: 1 },
    { name: "fotos", maxCount: 2 }
  ]),
  (req, res) => {
    const whatsapp = req.user.whatsapp;
    const clientes = readClientes();
    const cliente = clientes[whatsapp];

    if (!cliente) {
      cleanupUploadedFiles(req.files);
      return res.status(404).json({ ok: false, error: "Cliente nao encontrado" });
    }

    try {
      const carrossel = carouselService.createRequest({
        baseDir: CAROUSELS_DIR,
        cliente,
        whatsapp,
        body: req.body || {},
        files: req.files || {}
      });

      clientes[whatsapp] = cliente;
      writeClientes(clientes);

      return res.json({
        ok: true,
        carrossel_id: carrossel.carrossel_id || carrossel.id,
        ciclo: carrossel.ciclo,
        status: "pendente",
        status_label: "Pendente",
        quota: carrossel.quota || null
      });
    } catch (error) {
      cleanupUploadedFiles(req.files);
      console.error("[carrosseis] erro ao solicitar", {
        whatsapp,
        message: error?.message,
        stack: error?.stack
      });
      return res.status(error?.statusCode || 500).json({
        ok: false,
        code: error?.code || "carousel_request_error",
        error: error?.message || "Nao foi possivel solicitar o carrossel agora."
      });
    }
  }
);

app.get("/empresa/carrosseis", auth, (req, res) => {
  const whatsapp = req.user.whatsapp;
  try {
    const limit = Number(req.query?.limit || 50);
    const carrosseis = carouselService.listClientRequests({
      baseDir: CAROUSELS_DIR,
      whatsapp,
      limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 100) : 50
    });

    return res.json({ ok: true, carrosseis });
  } catch (error) {
    return res.status(error?.statusCode || 500).json({
      ok: false,
      code: error?.code || "carousel_list_error",
      error: error?.message || "Nao foi possivel listar os carrosseis."
    });
  }
});

app.get("/empresa/carrosseis/:carrosselId/status", auth, (req, res) => {
  const whatsapp = req.user.whatsapp;
  try {
    return res.json(carouselService.publicStatusPayload({
      baseDir: CAROUSELS_DIR,
      whatsapp,
      carrosselId: req.params.carrosselId
    }));
  } catch (error) {
    return res.status(error?.statusCode || 500).json({
      ok: false,
      code: error?.code || "carousel_status_error",
      error: error?.message || "Nao foi possivel consultar o status do carrossel."
    });
  }
});

app.get("/empresa/carrosseis/:carrosselId/download", auth, (req, res) => {
  const whatsapp = req.user.whatsapp;
  try {
    const result = carouselService.downloadForCarousel({
      baseDir: CAROUSELS_DIR,
      whatsapp,
      carrosselId: req.params.carrosselId
    });

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${result.filename}"`);
    return res.sendFile(result.filePath);
  } catch (error) {
    return res.status(error?.statusCode || 500).json({
      ok: false,
      code: error?.code || "carousel_download_error",
      error: error?.message || "Carrossel nao encontrado"
    });
  }
});

app.get("/bot/empresa/carrosseis/novos", botRunnerAuth, (req, res) => {
  if (!isBotAdmin(req)) {
    return res.status(403).json({ ok: false, error: "Acesso negado" });
  }

  const limit = Number(req.query?.limit || 5);
  const carrosseis = carouselService.listBotPending({
    baseDir: CAROUSELS_DIR,
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 50) : 5
  });

  return res.json({ ok: true, carrosseis });
});

app.get("/bot/empresa/carrosseis/:carrosselId/zip", botRunnerAuth, (req, res) => {
  if (!isBotAdmin(req)) {
    return res.status(403).json({ ok: false, error: "Acesso negado" });
  }

  const request = carouselService.findRequestById({
    baseDir: CAROUSELS_DIR,
    carrosselId: req.params.carrosselId
  });

  if (!request) {
    return res.status(404).json({ ok: false, error: "Solicitacao nao encontrada" });
  }

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${req.params.carrosselId}.zip"`);

  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.on("error", err => res.status(500).end(String(err)));
  archive.pipe(res);
  archive.directory(request.base_path, false);
  archive.finalize();
});

app.post("/bot/empresa/carrosseis/:carrosselId/status", botRunnerAuth, (req, res) => {
  if (!isBotAdmin(req)) {
    return res.status(403).json({ ok: false, error: "Acesso negado" });
  }

  const request = carouselService.findRequestById({
    baseDir: CAROUSELS_DIR,
    carrosselId: req.params.carrosselId
  });

  if (!request) {
    return res.status(404).json({ ok: false, error: "Solicitacao nao encontrada" });
  }

  const updated = carouselService.updateRequestStatus(
    request,
    String(req.body?.status || "processando"),
    String(req.body?.message || "")
  );

  return res.json({
    ok: true,
    carrossel_id: updated.carrossel_id || updated.id,
    status: updated.status
  });
});

app.post(
  "/bot/empresa/carrosseis/:carrosselId/upload-resultado",
  botRunnerAuth,
  uploadResultado.fields([
    { name: "resultado", maxCount: 1 }
  ]),
  (req, res) => {
    if (!isBotAdmin(req)) {
      cleanupUploadedFiles(req.files);
      return res.status(403).json({ ok: false, error: "Acesso negado" });
    }

    const resultadoFile = req.files?.resultado?.[0] || null;

    if (!resultadoFile) {
      cleanupUploadedFiles(req.files);
      return res.status(400).json({ ok: false, error: "Arquivo resultado nao enviado" });
    }

    try {
      const apiInfo = req.body?.api_info ? JSON.parse(req.body.api_info) : {};
      const request = carouselService.saveUploadedResult({
        baseDir: CAROUSELS_DIR,
        carrosselId: req.params.carrosselId,
        resultPath: resultadoFile.path,
        descricaoInstagram: req.body?.descricao_instagram || "",
        apiInfo
      });

      return res.json({
        ok: true,
        carrossel_id: request.carrossel_id || request.id,
        status: "pronto",
        arquivo: "resultado.zip"
      });
    } catch (error) {
      cleanupUploadedFiles(req.files);
      console.error("[carrosseis] falha ao salvar resultado", {
        carrosselId: req.params.carrosselId,
        message: error?.message,
        stack: error?.stack
      });
      return res.status(error?.statusCode || 500).json({
        ok: false,
        error: error?.message || "Falha ao salvar resultado"
      });
    }
  }
);

// ===== PLANEJAMENTO MENSAL =====
app.post(
  "/empresa/planejamento-mensal/solicitar",
  auth,
  upload.fields(PEDIDO_UPLOAD_FIELDS),
  (req, res) => {
    const whatsapp = req.user.whatsapp;
    const clientes = readClientes();
    const cliente = clientes[whatsapp];

    if (!cliente) {
      cleanupUploadedFiles(req.files);
      return res.status(404).json({ ok: false, error: "Cliente nao encontrado" });
    }

    try {
      const clienteBefore = JSON.stringify(cliente);
      const planejamento = monthlyPlanningService.createRequest({
        baseDir: MONTHLY_PLANNINGS_DIR,
        cliente,
        whatsapp,
        body: req.body || {},
        files: req.files || {}
      });

      if (JSON.stringify(cliente) !== clienteBefore) {
        clientes[whatsapp] = cliente;
        writeClientes(clientes);
      }

      return res.json({
        ok: true,
        planejamento_id: planejamento.planejamento_id || planejamento.id,
        ciclo: planejamento.ciclo,
        status: planejamento.status,
        status_label: "Em analise",
        quantidade_reservada: planejamento.quantidade_reservada,
        artes_deste_ciclo: planejamento.artes_deste_ciclo,
        reservadas_no_planejamento: planejamento.reservadas_no_planejamento,
        livres_para_criar_arte: planejamento.livres_para_criar_arte,
        reserva_definitiva: true,
        fase_4_pendente: false
      });
    } catch (error) {
      cleanupUploadedFiles(req.files);
      console.error("[planejamento-mensal] erro ao solicitar", {
        whatsapp,
        message: error?.message,
        stack: error?.stack
      });
      return res.status(error?.statusCode || 500).json({
        ok: false,
        code: error?.code || "monthly_planning_request_error",
        error: error?.message || "Nao foi possivel criar o Planejamento Mensal agora.",
        artes_livres: error?.artes_livres,
        billing: error?.billing
      });
    }
  }
);

app.get("/empresa/planejamento-mensal", auth, (req, res) => {
  const whatsapp = req.user.whatsapp;
  const clientes = readClientes();
  const cliente = clientes[whatsapp];

  if (!cliente) {
    return res.status(404).json({ ok: false, error: "Cliente nao encontrado" });
  }

  try {
    return res.json(monthlyPlanningService.listClientPlannings({
      baseDir: MONTHLY_PLANNINGS_DIR,
      whatsapp,
      pedidosDir: PEDIDOS_DIR
    }));
  } catch (error) {
    console.error("[planejamento-mensal] erro ao listar", {
      whatsapp,
      message: error?.message,
      stack: error?.stack
    });
    return res.status(500).json({
      ok: false,
      code: "monthly_planning_list_error",
      error: "Nao foi possivel listar os Planejamentos Mensais agora."
    });
  }
});

function handleMonthlyPlanningCalendarList(req, res) {
  console.log("[planejamento-mensal][calendario] rota calendario geral", {
    method: req.method,
    path: req.originalUrl || req.path
  });

  const whatsapp = req.user.whatsapp;
  const clientes = readClientes();
  const cliente = clientes[whatsapp];

  if (!cliente) {
    return res.status(404).json({ ok: false, error: "Cliente nao encontrado" });
  }

  try {
    return res.json(monthlyPlanningService.listClientPlanningCalendar({
      baseDir: MONTHLY_PLANNINGS_DIR,
      whatsapp,
      pedidosDir: PEDIDOS_DIR
    }));
  } catch (error) {
    console.error("[planejamento-mensal][calendario] erro ao listar", {
      whatsapp,
      message: error?.message,
      stack: error?.stack
    });
    return res.status(500).json({
      ok: false,
      code: "monthly_planning_calendar_list_error",
      error: "Nao foi possivel carregar o calendario do Planejamento Mensal agora."
    });
  }
}

function handleMonthlyPlanningCalendarHide(req, res) {
  console.log("[planejamento-mensal][calendario] rota ocultar calendario", {
    method: req.method,
    path: req.originalUrl || req.path
  });

  const whatsapp = req.user.whatsapp;
  const clientes = readClientes();
  const cliente = clientes[whatsapp];

  if (!cliente) {
    return res.status(404).json({ ok: false, error: "Cliente nao encontrado" });
  }

  try {
    return res.json(monthlyPlanningService.hideClientPlanningCalendarItem({
      baseDir: MONTHLY_PLANNINGS_DIR,
      whatsapp,
      itemKey: req.body?.item_key || req.body?.calendar_key || req.body?.key || "",
      pedidoId: req.body?.pedido_id || "",
      planningId: req.body?.planning_id || req.body?.planejamento_id || "",
      planejamentoItemId: req.body?.planejamento_item_id || ""
    }));
  } catch (error) {
    console.error("[planejamento-mensal][calendario] erro ao ocultar", {
      whatsapp,
      message: error?.message,
      stack: error?.stack
    });
    return res.status(error?.statusCode || 500).json({
      ok: false,
      code: error?.code || "monthly_planning_calendar_hide_error",
      error: error?.message || "Nao foi possivel remover este item do calendario."
    });
  }
}

function handleMonthlyPlanningCalendarReschedule(req, res) {
  console.log("[planejamento-mensal][calendario] rota reagendar calendario", {
    method: req.method,
    path: req.originalUrl || req.path
  });

  const whatsapp = req.user.whatsapp;
  const clientes = readClientes();
  const cliente = clientes[whatsapp];

  if (!cliente) {
    return res.status(404).json({ ok: false, error: "Cliente nao encontrado" });
  }

  try {
    return res.json(monthlyPlanningService.rescheduleClientPlanningCalendarItem({
      baseDir: MONTHLY_PLANNINGS_DIR,
      whatsapp,
      pedidosDir: PEDIDOS_DIR,
      itemKey: req.body?.item_key || req.body?.calendar_key || req.body?.key || "",
      pedidoId: req.body?.pedido_id || "",
      planningId: req.body?.planning_id || req.body?.planejamento_id || "",
      planejamentoItemId: req.body?.planejamento_item_id || "",
      date: req.body?.data || req.body?.date || req.body?.data_sugerida || "",
      time: req.body?.horario || req.body?.time || req.body?.horario_sugerido || ""
    }));
  } catch (error) {
    console.error("[planejamento-mensal][calendario] erro ao reagendar", {
      whatsapp,
      message: error?.message,
      stack: error?.stack
    });
    return res.status(error?.statusCode || 500).json({
      ok: false,
      code: error?.code || "monthly_planning_calendar_reschedule_error",
      error: error?.message || "Nao foi possivel reagendar este item do calendario."
    });
  }
}

app.get("/empresa/calendario-planejamento-mensal", auth, handleMonthlyPlanningCalendarList);
app.post("/empresa/calendario-planejamento-mensal/ocultar", auth, handleMonthlyPlanningCalendarHide);
app.post("/empresa/calendario-planejamento-mensal/reagendar", auth, handleMonthlyPlanningCalendarReschedule);

app.get("/empresa/planejamento-mensal/calendario", auth, handleMonthlyPlanningCalendarList);

app.post("/empresa/planejamento-mensal/calendario/ocultar", auth, handleMonthlyPlanningCalendarHide);
app.post("/empresa/planejamento-mensal/calendario/reagendar", auth, handleMonthlyPlanningCalendarReschedule);

app.get("/empresa/planejamento-mensal/:planningId", auth, (req, res, next) => {
  console.log("[planejamento-mensal] rota detalhe planejamento", {
    method: req.method,
    path: req.originalUrl || req.path,
    planningId: req.params.planningId
  });

  if (isMonthlyPlanningReservedRouteSegment(req.params.planningId)) {
    return next("route");
  }

  const whatsapp = req.user.whatsapp;
  const clientes = readClientes();
  const cliente = clientes[whatsapp];

  if (!cliente) {
    return res.status(404).json({ ok: false, error: "Cliente nao encontrado" });
  }

  try {
    return res.json(monthlyPlanningService.publicDetailPayload({
      baseDir: MONTHLY_PLANNINGS_DIR,
      whatsapp,
      planningId: req.params.planningId,
      pedidosDir: PEDIDOS_DIR
    }));
  } catch (error) {
    return res.status(error?.statusCode || 500).json({
      ok: false,
      code: error?.code || "monthly_planning_detail_error",
      error: error?.message || "Nao foi possivel consultar o Planejamento Mensal."
    });
  }
});

app.post("/empresa/planejamento-mensal/:planningId/cancelar", auth, (req, res) => {
  if (isMonthlyPlanningReservedRouteSegment(req.params.planningId)) {
    return res.status(404).json({
      ok: false,
      code: "monthly_planning_reserved_route",
      error: "Rota reservada do Planejamento Mensal."
    });
  }

  const whatsapp = req.user.whatsapp;
  const clientes = readClientes();
  const cliente = clientes[whatsapp];

  if (!cliente) {
    return res.status(404).json({ ok: false, error: "Cliente nao encontrado" });
  }

  try {
    const clienteBefore = JSON.stringify(cliente);
    const planejamento = monthlyPlanningService.cancelPlanning({
      baseDir: MONTHLY_PLANNINGS_DIR,
      whatsapp,
      planningId: req.params.planningId,
      cliente
    });

    if (JSON.stringify(cliente) !== clienteBefore) {
      clientes[whatsapp] = cliente;
      writeClientes(clientes);
    }

    return res.json({
      ok: true,
      planejamento_id: planejamento.planejamento_id || planejamento.id,
      status: planejamento.status,
      status_label: planejamento.status_label || "Cancelado",
      billing_alterado: planejamento.cancelamento?.billing_alterado === true,
      reserva_definitiva: true,
      artes_devolvidas: Number(planejamento.cancelamento?.artes_devolvidas || 0),
      livres_para_criar_arte: Number(planejamento.cancelamento?.livres_para_criar_arte || planejamento.livres_para_criar_arte || 0)
    });
  } catch (error) {
    return res.status(error?.statusCode || 500).json({
      ok: false,
      code: error?.code || "monthly_planning_cancel_error",
      error: error?.message || "Nao foi possivel cancelar o Planejamento Mensal."
    });
  }
});

app.get("/bot/empresa/planejamento-mensal/novos", botRunnerAuth, (req, res) => {
  if (!isBotAdmin(req)) {
    return res.status(403).json({ ok: false, error: "Acesso negado" });
  }

  try {
    return res.json(monthlyPlanningService.listBotPending({
      baseDir: MONTHLY_PLANNINGS_DIR,
      limit: req.query.limit,
      claim: req.query.claim !== "false"
    }));
  } catch (error) {
    console.error("[planejamento-mensal][bot] erro ao listar novos", {
      message: error?.message,
      stack: error?.stack
    });
    return res.status(500).json({
      ok: false,
      error: "Nao foi possivel listar Planejamentos Mensais pendentes."
    });
  }
});

app.get("/bot/empresa/planejamento-mensal/:planningId/zip", botRunnerAuth, (req, res) => {
  if (!isBotAdmin(req)) {
    return res.status(403).json({ ok: false, error: "Acesso negado" });
  }

  try {
    const planejamento = monthlyPlanningService.findPlanningByIdAny({
      baseDir: MONTHLY_PLANNINGS_DIR,
      planningId: req.params.planningId
    });

    if (!planejamento) {
      return res.status(404).json({ ok: false, error: "Planejamento Mensal nao encontrado" });
    }

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename=\"${planejamento.planejamento_id || planejamento.id}.zip\"`);

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", (error) => {
      throw error;
    });
    archive.pipe(res);
    archive.directory(planejamento.base_path, false);
    archive.finalize();
  } catch (error) {
    console.error("[planejamento-mensal][bot] erro ao gerar zip", {
      planningId: req.params.planningId,
      message: error?.message,
      stack: error?.stack
    });
    if (!res.headersSent) {
      return res.status(500).json({ ok: false, error: "Falha ao gerar ZIP do Planejamento Mensal" });
    }
  }
});

app.post("/bot/empresa/planejamento-mensal/:planningId/status", botRunnerAuth, (req, res) => {
  if (!isBotAdmin(req)) {
    return res.status(403).json({ ok: false, error: "Acesso negado" });
  }

  try {
    const planejamento = monthlyPlanningService.updatePlanningStatus({
      baseDir: MONTHLY_PLANNINGS_DIR,
      planningId: req.params.planningId,
      status: String(req.body?.status || "").trim(),
      message: req.body?.message || req.body?.erro || ""
    });

    const statusNormalizado = String(planejamento.status || req.body?.status || "").toLowerCase();
    const runnerEvent = statusNormalizado.includes("timeout")
      ? "runner_timeout"
      : statusNormalizado.includes("erro")
        ? "runner_erro"
        : "";
    if (runnerEvent) {
      registrarEventoServidor(runnerEvent, {
        whatsapp: planejamento.whatsapp,
        produto: "planejamento_mensal",
        payload: {
          tipo: "planejamento_mensal",
          planning_id: planejamento.planejamento_id || planejamento.id || req.params.planningId,
          status: planejamento.status || req.body?.status || "",
          motivo: String(req.body?.message || req.body?.erro || "").trim()
        }
      });
    }

    return res.json({
      ok: true,
      planejamento_id: planejamento.planejamento_id || planejamento.id,
      status: planejamento.status
    });
  } catch (error) {
    console.error("[planejamento-mensal][bot] erro ao atualizar status", {
      planningId: req.params.planningId,
      message: error?.message,
      stack: error?.stack
    });
    return res.status(error?.statusCode || 500).json({
      ok: false,
      code: error?.code || "monthly_planning_bot_status_error",
      error: error?.message || "Falha ao atualizar status do Planejamento Mensal"
    });
  }
});

app.post("/bot/empresa/planejamento-mensal/:planningId/upload-plano", botRunnerAuth, (req, res) => {
  if (!isBotAdmin(req)) {
    return res.status(403).json({ ok: false, error: "Acesso negado" });
  }

  try {
    const planejamentoAtual = monthlyPlanningService.findPlanningByIdAny({
      baseDir: MONTHLY_PLANNINGS_DIR,
      planningId: req.params.planningId
    });
    const clientes = readClientes();
    const cliente = planejamentoAtual?.whatsapp ? clientes[planejamentoAtual.whatsapp] : null;
    const clienteBefore = cliente ? JSON.stringify(cliente) : "";

    const planejamento = monthlyPlanningService.savePlanResult({
      baseDir: MONTHLY_PLANNINGS_DIR,
      pedidosDir: PEDIDOS_DIR,
      planningId: req.params.planningId,
      payload: req.body || {},
      cliente
    });

    if (cliente && JSON.stringify(cliente) !== clienteBefore) {
      clientes[planejamentoAtual.whatsapp] = cliente;
      writeClientes(clientes);
    }

    const planoMensal = planejamento.plano_mensal || {};
    const postagens = Array.isArray(planoMensal.postagens)
      ? planoMensal.postagens
      : Array.isArray(planoMensal.itens)
        ? planoMensal.itens
        : [];

    return res.json({
      ok: true,
      planejamento_id: planejamento.planejamento_id || planejamento.id,
      status: planejamento.status,
      postagens: postagens.length,
      pedidos_filhos_criados: Number(planejamento.pedidos_criados?.total || planejamento.pedidos_filhos_criados || 0)
    });
  } catch (error) {
    console.error("[planejamento-mensal][bot] erro ao receber plano", {
      planningId: req.params.planningId,
      message: error?.message,
      stack: error?.stack
    });
    return res.status(error?.statusCode || 500).json({
      ok: false,
      code: error?.code || "monthly_planning_bot_upload_error",
      error: error?.message || "Falha ao salvar plano do Planejamento Mensal"
    });
  }
});

app.get("/bot/empresa/planejamento-mensal/artes/novas", botRunnerAuth, (req, res) => {
  if (!isBotAdmin(req)) {
    return res.status(403).json({ ok: false, error: "Acesso negado" });
  }

  try {
    return res.json(monthlyPlanningService.listPlanningArtPending({
      pedidosDir: PEDIDOS_DIR,
      limit: req.query.limit
    }));
  } catch (error) {
    console.error("[planejamento-mensal][artes] erro ao listar novas", {
      message: error?.message,
      stack: error?.stack
    });
    return res.status(500).json({
      ok: false,
      error: "Nao foi possivel listar artes do Planejamento Mensal."
    });
  }
});

app.get("/bot/empresa/planejamento-mensal/artes/:pedidoId/zip", botRunnerAuth, (req, res) => {
  if (!isBotAdmin(req)) {
    return res.status(403).json({ ok: false, error: "Acesso negado" });
  }

  try {
    const arte = monthlyPlanningService.findPlanningArtOrder({
      pedidosDir: PEDIDOS_DIR,
      pedidoId: req.params.pedidoId
    });

    if (!arte) {
      return res.status(404).json({ ok: false, error: "Arte do Planejamento Mensal nao encontrada" });
    }

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename=\"${arte.pedidoId}.zip\"`);

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", (error) => {
      throw error;
    });
    archive.pipe(res);
    archive.directory(arte.base, false);
    archive.finalize();
  } catch (error) {
    console.error("[planejamento-mensal][artes] erro ao gerar zip", {
      pedidoId: req.params.pedidoId,
      message: error?.message,
      stack: error?.stack
    });
    if (!res.headersSent) {
      return res.status(500).json({ ok: false, error: "Falha ao gerar ZIP da arte do Planejamento Mensal" });
    }
  }
});

app.post("/bot/empresa/planejamento-mensal/artes/:pedidoId/status", botRunnerAuth, (req, res) => {
  if (!isBotAdmin(req)) {
    return res.status(403).json({ ok: false, error: "Acesso negado" });
  }

  try {
    const arte = monthlyPlanningService.updatePlanningArtStatus({
      pedidosDir: PEDIDOS_DIR,
      pedidoId: req.params.pedidoId,
      status: String(req.body?.status || "").trim(),
      message: req.body?.message || req.body?.erro || ""
    });

    const statusNormalizado = String(arte.status || req.body?.status || "").toLowerCase();
    const runnerEvent = statusNormalizado.includes("timeout")
      ? "runner_timeout"
      : statusNormalizado.includes("erro")
        ? "runner_erro"
        : "";
    if (runnerEvent) {
      const basePedido = getPedidoBaseGlobal(req.params.pedidoId);
      const pedidoData = basePedido ? (readPedido(basePedido) || {}) : {};
      registrarEventoServidor(runnerEvent, {
        whatsapp: pedidoData.whatsapp,
        pedidoId: req.params.pedidoId,
        produto: "planejamento_mensal",
        payload: {
          tipo: "planejamento_mensal_arte",
          planning_id: arte.planning_id || arte.planejamento_id || "",
          status: arte.status || req.body?.status || "",
          motivo: String(req.body?.message || req.body?.erro || "").trim()
        }
      });
    }

    return res.json({ ok: true, arte });
  } catch (error) {
    console.error("[planejamento-mensal][artes] erro ao atualizar status", {
      pedidoId: req.params.pedidoId,
      message: error?.message,
      stack: error?.stack
    });
    return res.status(error?.statusCode || 500).json({
      ok: false,
      code: error?.code || "monthly_planning_art_status_error",
      error: error?.message || "Falha ao atualizar status da arte do Planejamento Mensal"
    });
  }
});

app.post(
  "/bot/empresa/planejamento-mensal/artes/:pedidoId/upload-resultado",
  botRunnerAuth,
  uploadResultado.fields([
    { name: "resultado", maxCount: 1 },
    { name: "preview", maxCount: 1 }
  ]),
  (req, res) => {
    if (!isBotAdmin(req)) {
      cleanupUploadedFiles(req.files);
      return res.status(403).json({ ok: false, error: "Acesso negado" });
    }

    const resultado = req.files?.resultado?.[0];
    const preview = req.files?.preview?.[0];
    if (!resultado?.path) {
      cleanupUploadedFiles(req.files);
      return res.status(400).json({ ok: false, error: "Arquivo resultado_final.png obrigatorio" });
    }

    try {
      let apiInfo = null;
      if (req.body?.api_info) {
        try {
          apiInfo = JSON.parse(String(req.body.api_info || "{}"));
        } catch {
          apiInfo = null;
        }
      }

      const arte = monthlyPlanningService.savePlanningArtResult({
        pedidosDir: PEDIDOS_DIR,
        pedidoId: req.params.pedidoId,
        resultadoPath: resultado.path,
        previewPath: preview?.path || "",
        descricaoInstagram: req.body?.descricao_instagram || "",
        apiInfo
      });

      const basePedido = getPedidoBaseGlobal(req.params.pedidoId);
      const pedidoData = basePedido ? (readPedido(basePedido) || {}) : {};
      registrarEventoServidor("pedido_pronto", {
        whatsapp: pedidoData.whatsapp,
        pedidoId: req.params.pedidoId,
        produto: "planejamento_mensal",
        payload: {
          tipo: "planejamento_mensal",
          planning_id: arte.planning_id || arte.planejamento_id || "",
          status: arte.status || "pronto"
        }
      });

      return res.json({ ok: true, arte });
    } catch (error) {
      cleanupUploadedFiles(req.files);
      console.error("[planejamento-mensal][artes] erro ao receber resultado", {
        pedidoId: req.params.pedidoId,
        message: error?.message,
        stack: error?.stack
      });
      return res.status(error?.statusCode || 500).json({
        ok: false,
        code: error?.code || "monthly_planning_art_upload_error",
        error: error?.message || "Falha ao salvar resultado da arte do Planejamento Mensal"
      });
    }
  }
);

let monthlyPlanningNotificationsRunning = false;

function monthlyPlanningNotificationPayload({ planning, post }) {
  const pedidoId = post.pedido_id || "";
  return {
    title: "Hora de postar",
    body: "Sua arte planejada para hoje esta pronta. Toque para ver e copiar a legenda.",
    image_url: pedidoId ? publicApiUrl(`/pedidos/${encodeURIComponent(pedidoId)}/preview`) : "",
    data: {
      tipo: "planejamento_mensal",
      route: "monthly_planning_detail",
      planejamento_id: planning.planejamento_id || planning.id || "",
      planejamento_item_id: post.planejamento_item_id || "",
      pedido_id: pedidoId
    }
  };
}

async function runMonthlyPlanningNotifications() {
  if (monthlyPlanningNotificationsRunning) return;

  monthlyPlanningNotificationsRunning = true;
  try {
    const clientes = readClientes();
    const result = await monthlyPlanningService.processDueNotifications({
      baseDir: MONTHLY_PLANNINGS_DIR,
      pedidosDir: PEDIDOS_DIR,
      clientes,
      now: new Date(),
      sendNotification: async ({ cliente, planning, post }) => {
        return fcmService.sendPlanejamentoMensal(
          cliente,
          {
            ...monthlyPlanningNotificationPayload({ planning, post }),
            planejamento_id: planning.planejamento_id || planning.id || "",
            planejamento_item_id: post.planejamento_item_id || "",
            pedido_id: post.pedido_id || ""
          }
        );
      }
    });

    if (result.sent || result.errors || result.mock) {
      console.log("[planejamento-mensal][notificacoes]", result);
    }
  } catch (error) {
    console.error("[planejamento-mensal][notificacoes] erro no agendador", {
      message: error?.message,
      stack: error?.stack
    });
  } finally {
    monthlyPlanningNotificationsRunning = false;
  }
}

// ===== CRIA PEDIDO =====
function criarPedidoHandler(categoria) {
  return async (req, res) => {
    try {
    const whatsapp = req.user.whatsapp;
    const clientes = readClientes();
    const c = clientes[whatsapp];

    if (!c) {
      return res.status(404).json({ ok: false, error: "Cliente não encontrado" });
    }

    const mesAtual = nowYYYYMM();
    billingService.ensureCurrentBillingCycle(c, mesAtual);

    const temBrindeMascote = billingService.hasMascoteUniformeGift(categoria, c);

    const custoPedido = getCustoPedido(categoria, c);
    const isArteEmpresa = categoria === "arte_empresa";
    const custoEfetivoPedido = isArteEmpresa ? EMPRESA_ARTE_AVULSA_VALOR : custoPedido;

    const temSaldoSuficiente = !isArteEmpresa && billingService.hasEnoughBalance(c, custoEfetivoPedido);

    const fields = orderService.normalizeOrderBody(req.body);

    if (!orderService.hasRequiredOrderFields(fields)) {
      return res.status(400).json({
        ok: false,
        error: "rodada e data são obrigatórios"
      });
    }

    const files = req.files || {};
    if (categoria === "arte_empresa" && !orderService.hasCompanyLogoReference(files)) {
      return res.status(400).json({
        ok: false,
        error: "Envie o logo da empresa para criar a arte."
      });
    }

    const visualStyleNormalization = orderService.normalizeCompanyVisualStyleForUploads({ categoria, fields, files });

    let cobrancaEmpresa = null;
    if (isArteEmpresa) {
      cobrancaEmpresa = billingService.resolveCompanyArtCharge(c, {
        custoPedido: custoEfetivoPedido,
        now: new Date()
      });

      if (visualStyleNormalization.converted) {
        console.info("[pedidos] estilo visual arte_empresa ajustado", {
          whatsapp,
          origem_cobranca: cobrancaEmpresa.source || cobrancaEmpresa.code || "indefinida",
          estilo_original: visualStyleNormalization.from,
          estilo_final: visualStyleNormalization.to,
          reason: visualStyleNormalization.reason
        });
      }

      if (cobrancaEmpresa.allowed !== true) {
        clientes[whatsapp] = c;
        writeClientes(clientes);
        return res.status(402).json({
          ok: false,
          code: "billing_required",
          error: "Compre 1 arte avulsa por R$ 5,99 ou escolha um combo para criar sua arte.",
          required_amount: cobrancaEmpresa.required_amount,
          arte_avulsa_valor: EMPRESA_ARTE_AVULSA_VALOR,
          arte_avulsa_cta: "Comprar 1 arte por R$ 5,99",
          arte_avulsa_endpoint: "/billing/arte-avulsa/pix",
          saldo_extra: cobrancaEmpresa.saldo_extra,
          artes_mensais_restantes: cobrancaEmpresa.artes_mensais_restantes,
          artes_avulsas_restantes: cobrancaEmpresa.artes_avulsas_restantes,
          plano_status: cobrancaEmpresa.plano_status
        });
      }
    }

    const draft = await orderService.createOrderDraft({
      categoria,
      pedidosDir: PEDIDOS_DIR,
      whatsapp,
      mesAtual,
      fields,
      files
    });

    const id = draft.id;

    if (isArteEmpresa) {
      billingService.applyResolvedCompanyArtCharge(c, cobrancaEmpresa, {
        custoPedido: custoEfetivoPedido,
        mesAtual,
        pedidoId: id
      });
      draft.pedido.cobranca_origem = cobrancaEmpresa.source;
      draft.pedido.valor_cobrado = cobrancaEmpresa.source === "saldo_extra" || cobrancaEmpresa.source === "arte_avulsa"
        ? Number(cobrancaEmpresa.amount || custoEfetivoPedido)
        : 0;
      if (cobrancaEmpresa.source === "arte_gratis") {
        draft.pedido.tipo_compra = "arte_gratis";
        draft.pedido.origem_promocional = "primeira_arte_gratis";
        draft.pedido.marketing_context = "primeira_arte_gratis";
        draft.pedido.beneficios_plano_aplicados = false;
      }
      if (cobrancaEmpresa.source === "arte_avulsa") {
        draft.pedido.tipo_compra = "avulsa";
        draft.pedido.beneficios_plano_aplicados = false;
      }
      draft.pedido.plano_id = cobrancaEmpresa.source === "plano" ? cobrancaEmpresa.planId : "";
      draft.pedido.plano_ciclo = cobrancaEmpresa.source === "plano" ? cobrancaEmpresa.planCycle : "";
      draft.pedido.pagamento_pendente = false;
      draft.pedido.valor_pendente = 0;
      draft.pedido.motivo_pagamento_pendente = "";
      orderService.orderStorage.writeOrder(draft.base, draft.pedido);
    } else if (temSaldoSuficiente) {
      billingService.applyOrderCharge(c, { custoPedido: custoEfetivoPedido, mesAtual, temBrindeMascote });
    } else {
      draft.pedido.pagamento_pendente = true;
      draft.pedido.valor_pendente = custoEfetivoPedido;
      draft.pedido.motivo_pagamento_pendente = "saldo_insuficiente";
      orderService.orderStorage.writeOrder(draft.base, draft.pedido);
    }

    clientes[whatsapp] = c;
    writeClientes(clientes);

    removeOldPedidos(whatsapp, 15);

    return res.json({
      ok: true,
      pedido_id: id,
      cobranca_origem: draft.pedido?.cobranca_origem || "",
      tipo_compra: draft.pedido?.tipo_compra || "",
      arte_gratis: draft.pedido?.cobranca_origem === "arte_gratis"
    });
    } catch (error) {
      cleanupUploadedFiles(req.files);
      console.error("[pedidos] erro ao criar pedido", {
        categoria,
        message: error?.message,
        stack: error?.stack
      });

      if (res.headersSent) return;

      return res.status(error?.statusCode || 500).json({
        ok: false,
        error: "Não foi possível criar o pedido agora. Tente novamente em alguns instantes."
      });
    }
  };
}

// ===== CRIAR PEDIDO =====
app.post(
  "/pedidos",
  auth,
  upload.fields(PEDIDO_UPLOAD_FIELDS),
  (req, res) => {
    const flyer_tipo = (req.body?.flyer_tipo || "").toLowerCase();
    const productFromRegistry = productsRegistry.resolveProductFromRequestBody(req.body);

    if (productFromRegistry) return criarPedidoHandler(productFromRegistry.id)(req, res);

    if (flyer_tipo === "escudo3d") return criarPedidoHandler("escudo3d")(req, res);
    if (flyer_tipo === "zz1fs") return criarPedidoHandler("escalacao")(req, res);
    if (flyer_tipo === "zz1fm") return criarPedidoHandler("contratacao")(req, res);
    if (flyer_tipo === "zz1ft") return criarPedidoHandler("proximo_jogo")(req, res);
    if (flyer_tipo === "treino") return criarPedidoHandler("treino")(req, res);
    if (flyer_tipo === "zz1fj") return criarPedidoHandler("patrocinador")(req, res);
    if (flyer_tipo === "jog_proximo") return criarPedidoHandler("proximo_jogo_jogador")(req, res);
    if (flyer_tipo === "jog_resultado") return criarPedidoHandler("resultado_jogo_jogador")(req, res);
    if (flyer_tipo === "jog_escudo") return criarPedidoHandler("jogador_escudo")(req, res);
    if (flyer_tipo === "mascote_uniforme") return criarPedidoHandler("mascote_uniforme")(req, res);

    return criarPedidoHandler("pedido")(req, res);
  }
);

app.post(
  "/mascotes",
  auth,
  upload.fields(PEDIDO_UPLOAD_FIELDS),
  criarPedidoHandler("mascote")
);

app.post(
  "/resultado_do_jogo",
  auth,
  upload.fields(PEDIDO_UPLOAD_FIELDS),
  criarPedidoHandler("resultado")
);

// ===== BOT ADMIN: LISTAR NOVOS DE TODOS OS CLIENTES =====
app.get("/bot/pedidos/novos", botRunnerAuth, (req, res) => {
  if (!isBotAdmin(req)) {
    return res.status(403).json({ ok: false, error: "Acesso negado" });
  }

  const pedidos = [];

  if (!fs.existsSync(PEDIDOS_DIR)) {
    return res.json({ ok: true, pedidos: [] });
  }

  const whatsapps = fs.readdirSync(PEDIDOS_DIR);

  for (const whatsapp of whatsapps) {
    const pastaWhatsapp = path.join(PEDIDOS_DIR, whatsapp);
    if (!fs.existsSync(pastaWhatsapp) || !fs.statSync(pastaWhatsapp).isDirectory()) continue;

    const meses = fs.readdirSync(pastaWhatsapp);

    for (const mes of meses) {
      const pastaMes = path.join(pastaWhatsapp, mes);
      if (!fs.existsSync(pastaMes) || !fs.statSync(pastaMes).isDirectory()) continue;

      const ids = fs.readdirSync(pastaMes);

      for (const id of ids) {
        const base = path.join(pastaMes, id);
        const statusPedido = readOrderStatus(base, "");

        if (statusPedido === "novo" || statusPedido === "ajuste_pendente") {
          const pedido = safeReadJson(path.join(base, "pedido.json")) || {};
          if (monthlyPlanningService.isPlanningOrder(pedido)) continue;
          pedidos.push({ id, whatsapp, mes, status: statusPedido });
        }
      }
    }
  }

  return res.json({ ok: true, pedidos });
});

app.get("/bot/pedidos/:id/zip", botRunnerAuth, (req, res) => {
  if (!isBotAdmin(req)) {
    return res.status(403).json({ ok: false, error: "Acesso negado" });
  }

  const base = getPedidoBaseGlobal(req.params.id);

  if (!base) {
    return res.status(404).json({ ok: false, error: "Pedido não encontrado" });
  }

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${req.params.id}.zip"`);

  const archive = archiver("zip", { zlib: { level: 9 } });

  archive.on("error", err => res.status(500).end(String(err)));

  archive.pipe(res);
  archive.directory(base, false);
  archive.finalize();
});

app.post("/bot/pedidos/:id/status", auth, (req, res) => {
  if (!isBotAdmin(req)) {
    return res.status(403).json({ ok: false, error: "Acesso negado" });
  }

  const base = getPedidoBaseGlobal(req.params.id);

  if (!base) {
    return res.status(404).json({ ok: false, error: "Pedido não encontrado" });
  }

  const { status } = req.body || {};

  if (!orderStatus.isValidPublicStatus(status)) {
    return res.status(400).json({ ok: false, error: "status inválido" });
  }

  writeOrderStatus(base, status);
  try {
    const pedido = readPedido(base) || {};
    const statusNormalizado = String(status || "").toLowerCase();
    const runnerEvent = statusNormalizado.includes("timeout")
      ? "runner_timeout"
      : statusNormalizado.includes("erro")
        ? "runner_erro"
        : "";
    if (runnerEvent) {
      registrarEventoServidor(runnerEvent, {
        whatsapp: pedido.whatsapp,
        pedidoId: req.params.id,
        produto: pedido.product_id || pedido.categoria || "pedido",
        payload: {
          tipo: "pedido",
          status,
          motivo: String(req.body?.message || req.body?.erro || "").trim()
        }
      });
    }
    if (pedido.whatsapp && !monthlyPlanningService.isPlanningOrder(pedido)) {
      sendClientPushAsync(pedido.whatsapp, "pedido_atualizado", {
        pedido_id: req.params.id,
        status,
        body: status === orderStatus.ORDER_STATUS.EM_PRODUCAO
          ? "Sua arte entrou em producao. Toque para acompanhar."
          : "Seu pedido teve uma atualizacao. Toque para acompanhar."
      });
    }
  } catch (error) {
    console.warn("[fcm] nao foi possivel preparar push de status", {
      pedido_id: req.params.id,
      message: error?.message
    });
  }

  return res.json({ ok: true });
});

// ===== LISTAR NOVOS =====
app.get("/pedidos/novos", auth, (req, res) => {
  const whatsapp = req.user.whatsapp;
  const mesAtual = nowYYYYMM();
  const dir = path.join(PEDIDOS_DIR, whatsapp, mesAtual);

  if (!fs.existsSync(dir)) {
    return res.json({ ok: true, pedidos: [] });
  }

  const pedidos = [];

  for (const id of fs.readdirSync(dir)) {
    const pdir = path.join(dir, id);

    if (readOrderStatus(pdir, "") === "novo") {
      pedidos.push({ id });
    }
  }

  return res.json({ ok: true, pedidos });
});

function downloadBloqueadoPorCadastro(cliente) {
  return cliente?.cadastro_automatico === true && cliente?.conta_finalizada !== true;
}

function mensagemDownloadBloqueado(cliente) {
  return downloadBloqueadoPorCadastro(cliente)
    ? "Crie seu login e senha para liberar o download."
    : "";
}

app.get("/meus-pedidos", auth, (req, res) => {
  registrarOnline(req, { ultima_acao: "meus_pedidos" });

  const whatsapp = req.user.whatsapp;
  const clientes = readClientes();
  const cliente = clientes[whatsapp];
  const bloqueioDownload = downloadBloqueadoPorCadastro(cliente);
  const mensagemBloqueioDownload = mensagemDownloadBloqueado(cliente);
  const itens = listPedidoBasesByWhatsapp(whatsapp)
    .filter((item) => {
      const pedido = item.pedido || {};
      return !(
        pedido.origem === "planejamento_mensal" ||
        pedido.planejamento_id ||
        pedido.planejamento_mensal?.planejamento_id
      );
    })
    .slice(0, 15);
  const planejamentos = monthlyPlanningService.listClientPlanningGroups({
    baseDir: MONTHLY_PLANNINGS_DIR,
    pedidosDir: PEDIDOS_DIR,
    whatsapp,
    limit: 15
  });

  const pedidos = itens.map((item) => {
    const resultadoFinalPath = path.join(item.base, "resultado_final.png");
    const status = readOrderStatus(item.base, item.pedido.status || "novo");
    const imagemPronta = fs.existsSync(resultadoFinalPath);
    const aprovadoCliente = item.pedido.aprovado_cliente === true;
    const pagamentoPendente = item.pedido.pagamento_pendente === true;
    const ajusteUsado = item.pedido.ajuste_automatico_usado === true;
    const downloadBloqueado = imagemPronta && !pagamentoPendente && bloqueioDownload;
    const podeBaixar = imagemPronta && !pagamentoPendente && !downloadBloqueado;

    return {
      id: item.id,
      tipo: nomeCategoriaPedido(item.pedido.categoria || ""),
      status,
      data: item.pedido.data || item.criado_em,
      criado_em: item.criado_em,
      imagem_url: imagemPronta
        ? `${req.protocol}://${req.get("host")}/pedidos/${item.id}/preview`
        : null,
      imagem_pronta: imagemPronta,
      descricao_instagram: descricaoPostagemPedido(item.pedido),
      aprovado_cliente: aprovadoCliente,
      pagamento_pendente: pagamentoPendente,
      valor_pendente: Number(item.pedido.valor_pendente || 0),
      motivo_pagamento_pendente: item.pedido.motivo_pagamento_pendente || "",
      ajuste_automatico_usado: ajusteUsado,
      motivo_ajuste: item.pedido.motivo_ajuste || "",
      pode_baixar: podeBaixar,
      download_bloqueado: downloadBloqueado,
      mensagem_download_bloqueado: downloadBloqueado ? mensagemBloqueioDownload : "",
      pode_pedir_ajuste: imagemPronta && !ajusteUsado && status === "pronto"
    };
  });

  return res.json({ ok: true, pedidos, planejamentos });
});

app.post("/pedidos/:id/pagar-com-saldo", auth, (req, res) => {
  const whatsapp = req.user.whatsapp;
  const base = getPedidoBase(whatsapp, req.params.id);

  if (!base) {
    return res.status(404).json({ ok: false, error: "Pedido nao encontrado" });
  }

  const pedidoPath = path.join(base, "pedido.json");
  const pedido = safeReadJson(pedidoPath) || {};
  const isArteEmpresa = pedido.categoria === "arte_empresa" || pedido.product_id === "arte_empresa";

  if (pedido.pagamento_pendente !== true) {
    return res.json({
      ok: true,
      mensagem: "Pedido ja liberado.",
      pagamento_pendente: false
    });
  }

  const valorPendente = Number(pedido.valor_pendente || 0);

  if (!valorPendente || valorPendente <= 0) {
    return res.status(400).json({ ok: false, error: "Valor pendente invalido." });
  }

  const clientes = readClientes();
  const c = clientes[whatsapp];

  if (!c) {
    return res.status(404).json({ ok: false, error: "Cliente nao encontrado" });
  }

  const mesAtual = nowYYYYMM();
  billingService.ensureCurrentBillingCycle(c, mesAtual);

  if (!billingService.hasEnoughBalance(c, valorPendente)) {
    clientes[whatsapp] = c;
    writeClientes(clientes);
    return res.status(403).json({
      ok: false,
      error: "Saldo insuficiente para desbloquear esta imagem."
    });
  }

  billingService.applyOrderCharge(c, {
    custoPedido: valorPendente,
    mesAtual,
    temBrindeMascote: false
  });

  pedido.pagamento_pendente = false;
  pedido.pagamento_metodo = "saldo_ia4tube";
  pedido.pagamento_confirmado_em = new Date().toISOString();

  clientes[whatsapp] = c;
  writeClientes(clientes);
  fs.writeFileSync(pedidoPath, JSON.stringify(pedido, null, 2), "utf8");

  return res.json({
    ok: true,
    pagamento_pendente: false
  });
});

app.post("/pedidos/:id/gerar-pix", auth, async (req, res) => {
  try {
    if (!MP_ACCESS_TOKEN) {
      return res.status(500).json({ ok: false, error: "MP_ACCESS_TOKEN nao configurado" });
    }

    const whatsapp = req.user.whatsapp;
    const id = req.params.id;
    const base = getPedidoBase(whatsapp, id);

    if (!base) {
      return res.status(404).json({ ok: false, error: "Pedido nao encontrado" });
    }

    const pedidoPath = path.join(base, "pedido.json");
    const pedido = safeReadJson(pedidoPath) || {};

    if (pedido.pagamento_pendente !== true) {
      return res.status(400).json({ ok: false, error: "Pedido ja liberado." });
    }

    const valorPendente = Number(pedido.valor_pendente || 0);

    if (!valorPendente || valorPendente <= 0) {
      return res.status(400).json({ ok: false, error: "Valor pendente invalido." });
    }

    if (
      pedido.mp_payment_id &&
      pedido.pix_copia_cola &&
      String(pedido.mp_payment_status || "").toLowerCase() === "pending"
    ) {
      return res.json({
        ok: true,
        pix_copia_cola: pedido.pix_copia_cola,
        qr_code_base64: pedido.pix_qr_code_base64 || "",
        ticket_url: pedido.pix_ticket_url || "",
        payment_id: pedido.mp_payment_id
      });
    }

    const payerEmail = `${String(whatsapp).replace(/\D/g, "") || "cliente"}@ia4tube.com.br`;
    const paymentPayload = {
      transaction_amount: Number(valorPendente.toFixed(2)),
      description: `IA4Tube - Desbloqueio pedido ${id}`,
      payment_method_id: "pix",
      payer: {
        email: payerEmail
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

  pedido.aprovado_cliente = true;
  pedido.baixado_cliente = false;
  pedido.aprovado_em = new Date().toISOString();

  fs.writeFileSync(pedidoPath, JSON.stringify(pedido, null, 2), "utf8");

  const clientes = readClientes();
  const cliente = clientes[whatsapp];
  const imagemPronta = fs.existsSync(path.join(base, "resultado_final.png"));
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

  const arquivo = path.join(base, "resultado_final.png");

  if (!fs.existsSync(arquivo)) {
    return res.status(404).json({ ok: false, error: "Resultado final não encontrado" });
  }

  pedido.baixado_cliente = true;
  pedido.baixado_em = new Date().toISOString();

  try {
    fs.writeFileSync(pedidoPath, JSON.stringify(pedido, null, 2), "utf8");
  } catch {}

  res.setHeader("Content-Type", "image/png");
  res.setHeader("Content-Disposition", `attachment; filename="${req.params.id}_resultado.png"`);

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
  const resultadoFinalPath = path.join(base, "resultado_final.png");

  let pedido = {};
  if (fs.existsSync(pedidoJsonPath)) {
    try {
      pedido = JSON.parse(fs.readFileSync(pedidoJsonPath, "utf8"));
    } catch {}
  }

  const status = readOrderStatus(base, "novo");

  const imagem_pronta = fs.existsSync(resultadoFinalPath);
  const clientes = readClientes();
  const cliente = clientes[whatsapp];
  const pagamentoPendente = pedido.pagamento_pendente === true;
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
    preview_url: imagem_pronta
      ? `${req.protocol}://${req.get("host")}/pedidos/${req.params.id}/preview`
      : null,
    aprovado_cliente: pedido.aprovado_cliente === true,
    pagamento_pendente: pagamentoPendente,
    valor_pendente: Number(pedido.valor_pendente || 0),
    motivo_pagamento_pendente: pedido.motivo_pagamento_pendente || "",
    descricao_instagram: descricaoPostagemPedido(pedido),
    ajuste_automatico_usado: pedido.ajuste_automatico_usado === true,
    motivo_ajuste: pedido.motivo_ajuste || "",
    pode_baixar: imagem_pronta && !pagamentoPendente && !downloadBloqueado,
    download_bloqueado: downloadBloqueado,
    mensagem_download_bloqueado: downloadBloqueado ? mensagemDownloadBloqueado(cliente) : "",
    pode_pedir_ajuste: imagem_pronta && pedido.ajuste_automatico_usado !== true && status === "pronto"
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
  const resultadoFinalPath = path.join(base, "resultado_final.png");
  const pedidoPath = path.join(base, "pedido.json");
  const pedido = safeReadJson(pedidoPath) || {};
  const pagamentoPendente = pedido.pagamento_pendente === true;
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
  const resultadoFinalPath = path.join(base, "resultado_final.png");
  const thumbnailPath = fs.existsSync(previewProtegidaPath)
    ? previewProtegidaPath
    : resultadoFinalPath;

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
app.get("/pedidos/:id/zip", auth, (req, res) => {
  const whatsapp = req.user.whatsapp;
  const base = getPedidoBase(whatsapp, req.params.id);

  if (!base) {
    return res.status(404).json({ ok: false, error: "Pedido não encontrado" });
  }

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${req.params.id}.zip"`);

  const archive = archiver("zip", { zlib: { level: 9 } });

  archive.on("error", err => res.status(500).end(String(err)));

  archive.pipe(res);
  archive.directory(base, false);
  archive.finalize();
});

// ===== ATUALIZAR STATUS =====
app.post("/pedidos/:id/status", auth, (req, res) => {
  const whatsapp = req.user.whatsapp;
  const base = getPedidoBase(whatsapp, req.params.id);

  if (!base) {
    return res.status(404).json({ ok: false, error: "Pedido não encontrado" });
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

    const resultadoFile = req.files?.resultado?.[0] || null;
    const previewFile = req.files?.preview?.[0] || null;

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
          if (pedidoData.whatsapp && !monthlyPlanningService.isPlanningOrder(pedidoData)) {
            sendClientPushAsync(pedidoData.whatsapp, "arte_pronta", {
              pedido_id: req.params.id,
              image_url: publicApiUrl(`/pedidos/${encodeURIComponent(req.params.id)}/preview`)
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
    return res.status(400).json({
      ok: false,
      error: "Não foi possível enviar a imagem. Verifique o arquivo e tente novamente."
    });
  }

  if (String(err?.message || "").includes("Apenas imagens")) {
    return res.status(400).json({
      ok: false,
      error: err.message
    });
  }

  return res.status(err?.statusCode || 500).json({
    ok: false,
    error: "Não foi possível criar o pedido agora. Tente novamente em alguns instantes."
  });
});

cleanupOldTmpUploads();
setInterval(cleanupOldTmpUploads, TMP_UPLOAD_CLEANUP_INTERVAL_MS);
setInterval(finalizarConversasSuporteInativas, 60 * 1000);
setTimeout(runMonthlyPlanningNotifications, 15 * 1000);
setInterval(runMonthlyPlanningNotifications, MONTHLY_PLANNING_NOTIFICATIONS_INTERVAL_MS);

app.listen(PORT, () => {
  console.log("API rodando na porta", PORT);
});
