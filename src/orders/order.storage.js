const fs = require("fs");
const path = require("path");

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function nowYYYYMM() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function newPedidoId() {
  const d = new Date();
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${y}${mo}${da}_${hh}${mm}${ss}`;
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function getPedidoBase(pedidosDir, whatsapp, pedidoId) {
  const pastaWhatsapp = path.join(pedidosDir, whatsapp);

  if (!fs.existsSync(pastaWhatsapp)) return null;

  const meses = fs.readdirSync(pastaWhatsapp);

  for (const mes of meses) {
    const base = path.join(pastaWhatsapp, mes, pedidoId);
    if (fs.existsSync(base)) return base;
  }

  return null;
}

function getPedidoBaseGlobal(pedidosDir, pedidoId) {
  if (!fs.existsSync(pedidosDir)) return null;

  const whatsapps = fs.readdirSync(pedidosDir);

  for (const whatsapp of whatsapps) {
    const pastaWhatsapp = path.join(pedidosDir, whatsapp);
    if (!fs.existsSync(pastaWhatsapp) || !fs.statSync(pastaWhatsapp).isDirectory()) continue;

    const meses = fs.readdirSync(pastaWhatsapp);

    for (const mes of meses) {
      const base = path.join(pastaWhatsapp, mes, pedidoId);
      if (fs.existsSync(base)) return base;
    }
  }

  return null;
}

function listPedidoBasesByWhatsapp(pedidosDir, whatsapp) {
  const pastaWhatsapp = path.join(pedidosDir, whatsapp);

  if (!fs.existsSync(pastaWhatsapp)) return [];

  const meses = fs.readdirSync(pastaWhatsapp);
  const pedidos = [];

  for (const mes of meses) {
    const pastaMes = path.join(pastaWhatsapp, mes);
    if (!fs.existsSync(pastaMes) || !fs.statSync(pastaMes).isDirectory()) continue;

    const ids = fs.readdirSync(pastaMes);

    for (const id of ids) {
      const base = path.join(pastaMes, id);
      if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) continue;

      const pedidoPath = path.join(base, "pedido.json");
      const pedido = safeReadJson(pedidoPath) || {};
      const criadoEm = pedido.criado_em || new Date(fs.statSync(base).mtimeMs).toISOString();

      pedidos.push({
        id,
        base,
        mes,
        pedido,
        criado_em: criadoEm
      });
    }
  }

  pedidos.sort((a, b) => new Date(b.criado_em) - new Date(a.criado_em));
  return pedidos;
}

function removeOldPedidos(pedidosDir, whatsapp, maxKeep = 15) {
  const pedidos = listPedidoBasesByWhatsapp(pedidosDir, whatsapp)
    .filter((item) => {
      const pedido = item.pedido || {};
      return !(
        pedido.origem === "planejamento_mensal" ||
        pedido.planejamento_id ||
        pedido.planejamento_mensal?.planejamento_id
      );
    });

  if (pedidos.length <= maxKeep) return;

  const excedentes = pedidos.slice(maxKeep);

  for (const item of excedentes) {
    try {
      fs.rmSync(item.base, { recursive: true, force: true });
    } catch {}
  }
}

function getOrderJsonPath(base) {
  return path.join(base, "pedido.json");
}

function getStatusPath(base) {
  return path.join(base, "status.txt");
}

function readOrder(base) {
  return safeReadJson(getOrderJsonPath(base));
}

function writeOrder(base, pedido) {
  fs.writeFileSync(getOrderJsonPath(base), JSON.stringify(pedido, null, 2), "utf8");
}

function readStatus(base, fallback = "") {
  const statusPath = getStatusPath(base);

  try {
    if (fs.existsSync(statusPath)) {
      return fs.readFileSync(statusPath, "utf8").trim();
    }
  } catch {}

  return fallback;
}

function writeStatus(base, status) {
  fs.writeFileSync(getStatusPath(base), status, "utf8");
}

module.exports = {
  ensureDir,
  nowYYYYMM,
  newPedidoId,
  safeReadJson,
  getPedidoBase,
  getPedidoBaseGlobal,
  listPedidoBasesByWhatsapp,
  removeOldPedidos,
  getOrderJsonPath,
  getStatusPath,
  readOrder,
  writeOrder,
  readStatus,
  writeStatus
};
