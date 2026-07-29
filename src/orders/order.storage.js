const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const MAX_PATH_SEGMENT_LENGTH = 160;

function isSafePathSegment(value) {
  const segment = String(value ?? "");
  return Boolean(
    segment &&
    segment.length <= MAX_PATH_SEGMENT_LENGTH &&
    segment !== "." &&
    segment !== ".." &&
    !/[\\/\0-\x1f\x7f]/.test(segment)
  );
}

function isSafeMonthSegment(value) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(value || ""));
}

function resolveContained(baseDir, ...segments) {
  const root = path.resolve(baseDir);
  const resolved = path.resolve(root, ...segments);
  const relative = path.relative(root, resolved);

  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    return resolved;
  }

  return null;
}

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
  const entropy = crypto.randomBytes(16).toString("hex");
  return `${y}${mo}${da}_${hh}${mm}${ss}_${entropy}`;
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function orderMetadataMatchesOwner(base, owner) {
  const pedido = safeReadJson(path.join(base, "pedido.json"));
  return Boolean(
    pedido &&
    typeof pedido === "object" &&
    String(pedido.whatsapp || "").trim() === String(owner || "").trim()
  );
}

function getPedidoBase(pedidosDir, whatsapp, pedidoId) {
  if (!isSafePathSegment(whatsapp) || !isSafePathSegment(pedidoId)) return null;

  const pastaWhatsapp = resolveContained(pedidosDir, String(whatsapp));

  if (!pastaWhatsapp || !fs.existsSync(pastaWhatsapp) || !fs.statSync(pastaWhatsapp).isDirectory()) return null;

  const meses = fs.readdirSync(pastaWhatsapp);

  for (const mes of meses) {
    if (!isSafeMonthSegment(mes)) continue;
    const base = resolveContained(pastaWhatsapp, mes, String(pedidoId));
    if (
      base &&
      fs.existsSync(base) &&
      fs.statSync(base).isDirectory() &&
      orderMetadataMatchesOwner(base, whatsapp)
    ) {
      return base;
    }
  }

  return null;
}

function findPedidoBasesGlobal(pedidosDir, pedidoId) {
  if (!isSafePathSegment(pedidoId) || !fs.existsSync(pedidosDir)) return [];

  const whatsapps = fs.readdirSync(pedidosDir);
  const matches = [];

  for (const whatsapp of whatsapps) {
    if (!isSafePathSegment(whatsapp)) continue;
    const pastaWhatsapp = resolveContained(pedidosDir, whatsapp);
    if (!pastaWhatsapp || !fs.existsSync(pastaWhatsapp) || !fs.statSync(pastaWhatsapp).isDirectory()) continue;

    const meses = fs.readdirSync(pastaWhatsapp);

    for (const mes of meses) {
      if (!isSafeMonthSegment(mes)) continue;
      const base = resolveContained(pastaWhatsapp, mes, String(pedidoId));
      if (
        base &&
        fs.existsSync(base) &&
        fs.statSync(base).isDirectory() &&
        orderMetadataMatchesOwner(base, whatsapp)
      ) {
        matches.push(base);
      }
    }
  }

  return matches;
}

function getPedidoBaseGlobal(pedidosDir, pedidoId) {
  const matches = findPedidoBasesGlobal(pedidosDir, pedidoId);
  return matches.length === 1 ? matches[0] : null;
}

function listPedidoBasesByWhatsapp(pedidosDir, whatsapp) {
  if (!isSafePathSegment(whatsapp)) return [];
  const pastaWhatsapp = resolveContained(pedidosDir, String(whatsapp));

  if (!pastaWhatsapp || !fs.existsSync(pastaWhatsapp) || !fs.statSync(pastaWhatsapp).isDirectory()) return [];

  const meses = fs.readdirSync(pastaWhatsapp);
  const pedidos = [];

  for (const mes of meses) {
    if (!isSafeMonthSegment(mes)) continue;
    const pastaMes = resolveContained(pastaWhatsapp, mes);
    if (!pastaMes || !fs.existsSync(pastaMes) || !fs.statSync(pastaMes).isDirectory()) continue;

    const ids = fs.readdirSync(pastaMes);

    for (const id of ids) {
      if (!isSafePathSegment(id)) continue;
      const base = resolveContained(pastaMes, id);
      if (!base || !fs.existsSync(base) || !fs.statSync(base).isDirectory()) continue;

      const pedidoPath = path.join(base, "pedido.json");
      const pedido = safeReadJson(pedidoPath) || {};
      if (String(pedido.whatsapp || "").trim() !== String(whatsapp)) continue;
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
  isSafePathSegment,
  isSafeMonthSegment,
  resolveContained,
  safeReadJson,
  orderMetadataMatchesOwner,
  getPedidoBase,
  findPedidoBasesGlobal,
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
