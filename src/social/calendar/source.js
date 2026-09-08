"use strict";
const fs = require("node:fs");
const path = require("node:path");
const planning = require("../../company-monthly-planning/planning.service");
const orders = require("../../orders/order.storage");
const { fail, consentPath } = require("./model");
function createCalendarSource({ dataDir, planningDir, ordersDir }) {
  const baseDir = planningDir || path.join(dataDir, "planejamentos_mensais");
  const pedidosDir = ordersDir || path.join(dataDir, "pedidos");
  function result(owner, job) {
    const plan = planning.findPlanningById({ baseDir, whatsapp: owner, planningId: job.planningId });
    if (!plan || plan.status === "cancelado") fail("calendar_source_unavailable", 404);
    const candidates = orders.listPedidoBasesByWhatsapp(pedidosDir, owner);
    const entry = candidates.find(entry => entry.id === job.orderId);
    const pedido = entry?.pedido;
    if (!entry || String(pedido?.whatsapp || "") !== owner ||
        String(pedido?.planejamento_id || pedido?.planejamento_mensal?.planejamento_id) !== job.planningId ||
        pedido.pagamento_pendente === true || pedido.pode_baixar === false) fail("calendar_source_unavailable", 404);
    const root = fs.realpathSync(pedidosDir);
    const file = path.join(entry.base, "resultado_final.png");
    const real = fs.realpathSync(file);
    if (!real.startsWith(root + path.sep) || fs.lstatSync(file).isSymbolicLink()) fail("calendar_source_unavailable", 404);
    const stat = fs.statSync(real);
    if (!stat.isFile() || stat.size < 1 || stat.size > 32 * 1024 * 1024) fail("calendar_source_unavailable", 404);
    return { file: real, version: `${stat.size}:${stat.mtimeMs}`, plan };
  }
  function list(owner) {
    const raw = planning.listClientPlanningCalendar({ baseDir, whatsapp: owner, pedidosDir });
    return (raw.postagens || raw.itens || []).map(item => {
      const plan = planning.findPlanningById({ baseDir, whatsapp: owner, planningId: item.planning_id });
      if (!plan || plan.status === "cancelado") return null;
      let authorizationEnvelope = null;
      try {
        const file = consentPath(baseDir, owner, item.planning_id);
        if (fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink() && fs.statSync(file).size < 4096)
          authorizationEnvelope = JSON.parse(fs.readFileSync(file, "utf8")).envelope;
      } catch { /* Existing orders without explicit consent stay manual. */ }
      let ready = item.imagem_pronta === true, version = "pending";
      if (ready) try { version = result(owner, { planningId: item.planning_id, orderId: item.pedido_id }).version; }
      catch { ready = false; }
      return { key: item.calendar_key, planningId: item.planning_id, orderId: item.pedido_id,
        title: item.titulo, date: item.data, time: item.horario, caption: item.legenda || "",
        imageReady: ready, version, authorizationEnvelope, calendarPayload: item };
    }).filter(item => item && item.planningId && item.orderId);
  }
  return Object.freeze({ list, async load(owner, job) { return fs.readFileSync(result(owner, job).file); } });
}
module.exports = { createCalendarSource };
