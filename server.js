const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const archiver = require("archiver");
const productsRegistry = require("./src/products");
const orderStorage = require("./src/orders/order.storage");
const orderStatus = require("./src/orders/order.status");
const orderService = require("./src/orders/order.service");
const billingService = require("./src/billing/billing.service");

const app = express();

// ===== CONFIG BÁSICA =====
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "TROQUE_ISSO_AGORA";

// ===== DATA STORAGE (RENDER DISK) =====
const isRender = process.env.RENDER || process.env.NODE_ENV === "production";

const DATA_DIR = isRender
  ? "/var/data"
  : path.join(__dirname, "dados");

const PEDIDOS_DIR = path.join(DATA_DIR, "pedidos");
const CLIENTES_FILE = path.join(DATA_DIR, "clientes.json");
const BOT_ADMIN_WHATSAPP = process.env.BOT_ADMIN_WHATSAPP || "15991120599";
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || "";
const MP_PROCESSADOS_FILE = path.join(DATA_DIR, "mp_processados.json");
const TEMPO_ESTIMADO_FILE = path.join(DATA_DIR, "tempo_estimado.json");
const ONLINE_FILE = path.join(DATA_DIR, "usuarios_online.json");
const SUPORTE_ABERTAS_FILE = path.join(DATA_DIR, "suporte_conversas_abertas.json");
const SUPORTE_FINALIZADAS_FILE = path.join(DATA_DIR, "suporte_conversas_finalizadas.json");
const ANALYTICS_DIR = path.join(DATA_DIR, "analytics");
const EVENTOS_CLIENTES_FILE = path.join(DATA_DIR, "eventos_clientes.json");

const CLIENTES_TESTE = [
  "Los Hermanos",
  "TESTE",
  "admin"
];

// CORS: permite seu site chamar a API
app.use(cors({
  origin: ["https://omascote.com.br", "http://127.0.0.1:8080", "http://localhost:8080"],
  credentials: false
}));

app.use(express.json({ limit: "50mb" }));
app.use(express.static("public"));

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";

// ===== GARANTE PASTAS =====
function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

ensureDir(DATA_DIR);
ensureDir(PEDIDOS_DIR);
ensureDir(path.join(DATA_DIR, "tmp_uploads"));
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
  return JSON.parse(fs.readFileSync(CLIENTES_FILE, "utf8") || "{}");
}

function writeClientes(obj) {
  fs.writeFileSync(CLIENTES_FILE, JSON.stringify(obj, null, 2), "utf8");
}

function readMpProcessados() {
  return JSON.parse(fs.readFileSync(MP_PROCESSADOS_FILE, "utf8") || "{}");
}

function writeMpProcessados(obj) {
  fs.writeFileSync(MP_PROCESSADOS_FILE, JSON.stringify(obj, null, 2), "utf8");
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

// ===== UPLOAD (multer) =====
const storage = multer.diskStorage({
  destination: (req, file, cb) =>
    cb(null, path.join(DATA_DIR, "tmp_uploads")),

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

// ===== ROTAS =====

// Health check
app.get("/", (req, res) => {
  res.json({ ok: true, msg: "omascote-api online" });
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

app.post("/bot/tempo-estimado", auth, (req, res) => {
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
        usados_no_ciclo: 0,
        ciclo_mes: nowYYYYMM(),
        ativo: true
      };

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
      usados_no_ciclo: 0,
      ciclo_mes: nowYYYYMM(),
      ativo: true,
      criado_em: new Date().toISOString()
    };

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
    usados_no_ciclo: 0,
    ciclo_mes: nowYYYYMM(),
    ativo: true
  };

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

  return res.json({
    ok: true,
    nome_time: c.nome_time,
    plano: c.plano,
    saldo_mensal: Number(c.saldo_mensal || 0),
    saldo_extra: Number(c.saldo_extra || 0),
    saldo: Number(c.saldo_mensal || 0) + Number(c.saldo_extra || 0),
    usados_no_ciclo: c.usados_no_ciclo,
    brinde_mascote_disponivel: c.brinde_mascote_disponivel === true,
    ativo: c.ativo
  });
});

// ===== MERCADO PAGO =====
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
        success: "https://omascote.com.br/app.html",
        failure: "https://omascote.com.br/app.html",
        pending: "https://omascote.com.br/app.html"
      },
      notification_url: "https://api.omascote.com.br/webhook/mercadopago",
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
      return res.status(500).json({ ok: false, error: "MP_ACCESS_TOKEN nÃ£o configurado" });
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
      return res.status(400).json({ ok: false, error: "Pacote invÃ¡lido" });
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
      notification_url: "https://api.omascote.com.br/webhook/mercadopago"
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

    if (processados[paymentId]) {
      return res.json({ ok: true, duplicado: true });
    }

    processados[paymentId] = {
      status: "processando",
      criado_em: new Date().toISOString()
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

      const valorBonusPedido = Number(
        pedido.valor_pendente ||
        pagamento.metadata?.valor_pendente ||
        pagamento.transaction_amount ||
        0
      );

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

      return res.json({ ok: true });
    }

    const whatsapp = pagamento.metadata?.whatsapp || external.split("|")[0];
    const credito = Number(pagamento.metadata?.credito || 0);

    if (!whatsapp || !credito) {
      return res.json({ ok: true, error: "sem whatsapp ou credito" });
    }

    const clientes = readClientes();
    const c = clientes[whatsapp];

    if (!c) {
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

    processados[paymentId] = {
      whatsapp,
      credito,
      status: pagamento.status,
      criado_em: new Date().toISOString()
    };

    writeMpProcessados(processados);

    return res.json({ ok: true });

  } catch (e) {
    return res.json({ ok: true });
  }
});

// ===== CRIA PEDIDO =====
function criarPedidoHandler(categoria) {
  return async (req, res) => {
    const whatsapp = req.user.whatsapp;
    const clientes = readClientes();
    const c = clientes[whatsapp];

    if (!c || !c.ativo) {
      return res.status(403).json({ ok: false, error: "Mensalidade inativa" });
    }

    const mesAtual = nowYYYYMM();
    billingService.ensureCurrentBillingCycle(c, mesAtual);

    const temBrindeMascote = billingService.hasMascoteUniformeGift(categoria, c);

    const custoPedido = getCustoPedido(categoria, c);
    const custoEfetivoPedido = custoPedido;

    const temSaldoSuficiente = billingService.hasEnoughBalance(c, custoEfetivoPedido);

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

    const draft = await orderService.createOrderDraft({
      categoria,
      pedidosDir: PEDIDOS_DIR,
      whatsapp,
      mesAtual,
      fields,
      files
    });

    const id = draft.id;

    if (temSaldoSuficiente) {
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

    return res.json({ ok: true, pedido_id: id });
  };
}

// ===== CRIAR PEDIDO =====
app.post(
  "/pedidos",
  auth,
  upload.fields([
    { name: "escudo1", maxCount: 1 },
    { name: "escudo2", maxCount: 1 },
    { name: "mascote", maxCount: 1 },
    { name: "patrocinadores", maxCount: 20 },
    { name: "logo", maxCount: 1 },
    { name: "fotos", maxCount: 20 },
    { name: "referencias", maxCount: 20 }
  ]),
  (req, res) => {
    const flyer_tipo = (req.body?.flyer_tipo || "").toLowerCase();
    const productFromRegistry = productsRegistry.resolveProductFromRequestBody(req.body);

    if (productFromRegistry) return criarPedidoHandler(productFromRegistry.id)(req, res);

    if (flyer_tipo === "escudo3d") return criarPedidoHandler("escudo3d")(req, res);
    if (flyer_tipo === "zz1fs") return criarPedidoHandler("escalacao")(req, res);
    if (flyer_tipo === "zz1fm") return criarPedidoHandler("contratacao")(req, res);
    if (flyer_tipo === "zz1ft") return criarPedidoHandler("proximo_jogo")(req, res);
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
  upload.fields([
    { name: "escudo1", maxCount: 1 },
    { name: "escudo2", maxCount: 1 },
    { name: "mascote", maxCount: 1 },
    { name: "patrocinadores", maxCount: 20 },
    { name: "logo", maxCount: 1 },
    { name: "fotos", maxCount: 20 },
    { name: "referencias", maxCount: 20 }
  ]),
  criarPedidoHandler("mascote")
);

app.post(
  "/resultado_do_jogo",
  auth,
  upload.fields([
    { name: "escudo1", maxCount: 1 },
    { name: "escudo2", maxCount: 1 },
    { name: "mascote", maxCount: 1 },
    { name: "patrocinadores", maxCount: 20 },
    { name: "logo", maxCount: 1 },
    { name: "fotos", maxCount: 20 },
    { name: "referencias", maxCount: 20 }
  ]),
  criarPedidoHandler("resultado")
);

// ===== BOT ADMIN: LISTAR NOVOS DE TODOS OS CLIENTES =====
app.get("/bot/pedidos/novos", auth, (req, res) => {
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
          pedidos.push({ id, whatsapp, mes, status: statusPedido });
        }
      }
    }
  }

  return res.json({ ok: true, pedidos });
});

app.get("/bot/pedidos/:id/zip", auth, (req, res) => {
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

app.get("/meus-pedidos", auth, (req, res) => {
  registrarOnline(req, { ultima_acao: "meus_pedidos" });

  const whatsapp = req.user.whatsapp;
  const itens = listPedidoBasesByWhatsapp(whatsapp).slice(0, 15);

  const pedidos = itens.map((item) => {
    const resultadoFinalPath = path.join(item.base, "resultado_final.png");
    const status = readOrderStatus(item.base, item.pedido.status || "novo");
    const imagemPronta = fs.existsSync(resultadoFinalPath);
    const aprovadoCliente = item.pedido.aprovado_cliente === true;
    const pagamentoPendente = item.pedido.pagamento_pendente === true;
    const ajusteUsado = item.pedido.ajuste_automatico_usado === true;

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
      descricao_instagram: item.pedido.descricao_instagram || "",
      aprovado_cliente: aprovadoCliente,
      pagamento_pendente: pagamentoPendente,
      valor_pendente: Number(item.pedido.valor_pendente || 0),
      motivo_pagamento_pendente: item.pedido.motivo_pagamento_pendente || "",
      ajuste_automatico_usado: ajusteUsado,
      motivo_ajuste: item.pedido.motivo_ajuste || "",
      pode_baixar: imagemPronta && aprovadoCliente && !pagamentoPendente,
      pode_pedir_ajuste: imagemPronta && !aprovadoCliente && !ajusteUsado && status === "pronto"
    };
  });

  return res.json({ ok: true, pedidos });
});

app.post("/pedidos/:id/pagar-com-saldo", auth, (req, res) => {
  const whatsapp = req.user.whatsapp;
  const base = getPedidoBase(whatsapp, req.params.id);

  if (!base) {
    return res.status(404).json({ ok: false, error: "Pedido nao encontrado" });
  }

  const pedidoPath = path.join(base, "pedido.json");
  const pedido = safeReadJson(pedidoPath) || {};

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
      notification_url: "https://api.omascote.com.br/webhook/mercadopago"
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

  return res.json({
    ok: true,
    aprovado_cliente: true,
    pode_baixar: true
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

  if (pedido.aprovado_cliente !== true) {
    return res.status(403).json({
      ok: false,
      error: "Aprove a prévia antes de baixar a imagem em alta qualidade."
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

  return res.json({
    ok: true,
    id: req.params.id,
    status,
    categoria: pedido.categoria || "",
    imagem_pronta,
    preview_url: imagem_pronta
      ? `${req.protocol}://${req.get("host")}/pedidos/${req.params.id}/preview`
      : null,
    aprovado_cliente: pedido.aprovado_cliente === true,
    pagamento_pendente: pedido.pagamento_pendente === true,
    valor_pendente: Number(pedido.valor_pendente || 0),
    motivo_pagamento_pendente: pedido.motivo_pagamento_pendente || "",
    ajuste_automatico_usado: pedido.ajuste_automatico_usado === true,
    motivo_ajuste: pedido.motivo_ajuste || "",
    pode_baixar: imagem_pronta && pedido.aprovado_cliente === true && pedido.pagamento_pendente !== true,
    pode_pedir_ajuste: imagem_pronta && pedido.aprovado_cliente !== true && pedido.ajuste_automatico_usado !== true && status === "pronto"
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
  const previewPath = fs.existsSync(previewProtegidaPath)
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
  auth,
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
      return res.status(404).json({ ok: false, error: "Pedido não encontrado" });
    }

    const resultadoFile = req.files?.resultado?.[0] || null;
    const previewFile = req.files?.preview?.[0] || null;

    if (!resultadoFile) {
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
        }
      } catch (e) {}

      return res.json({
        ok: true,
        arquivo: "resultado_final.png",
        preview: previewFile ? "preview_ia4tube.jpg" : ""
      });
    } catch (e) {
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

app.get("/bot/eventos-clientes", auth, (req, res) => {
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

    const eventos = readJsonArraySafe(analyticsDiaFile).slice(-limite);

    return res.json({
      ok: true,
      total: eventos.length,
      eventos
    });
  } catch {
    return res.status(500).json({ ok:false, error:"erro_eventos_clientes" });
  }
});

app.get("/bot/analytics-dia/:data", auth, (req, res) => {
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

    const eventos = readJsonArraySafe(analyticsDiaFile);

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

app.get("/bot/eventos-pedido/:id", auth, (req, res) => {
  try {
    if (!isBotAdmin(req)) {
      return res.status(403).json({ ok: false, error: "Acesso negado" });
    }

    const basePedido = getPedidoBaseGlobal(req.params.id);

    if (!basePedido) {
      return res.status(404).json({ ok:false, error:"Pedido não encontrado" });
    }

    const eventosPedidoFile = path.join(basePedido, "eventos_cliente.json");
    const eventos = readJsonArraySafe(eventosPedidoFile);

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

app.get("/bot/online", auth, (req, res) => {
  try {
    if (!isBotAdmin(req)) {
      return res.status(403).json({ ok: false, error: "Acesso negado" });
    }

    return res.json({
      ok: true,
      usuarios: listarOnlineRecentes()
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Erro ao listar online" });
  }
});

app.post("/bot/suporte/erro-pedido", auth, (req, res) => {
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

setInterval(finalizarConversasSuporteInativas, 60 * 1000);

app.listen(PORT, () => {
  console.log("API rodando na porta", PORT);
});
