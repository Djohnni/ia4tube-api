"use strict";
const fs = require("node:fs");
const path = require("node:path");
const planning = require("../../company-monthly-planning/planning.service");
const orders = require("../../orders/order.storage");
const { fail, consentPath } = require("./model");
const { MAX_VIDEO_BYTES } = require("../../company-monthly-planning/ready-video");
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
    const video = pedido.resultado_mime === "video/mp4";
    const file = path.join(entry.base, video ? "resultado_final.mp4" : "resultado_final.png");
    const real = fs.realpathSync(file);
    if (!real.startsWith(root + path.sep) || fs.lstatSync(file).isSymbolicLink()) fail("calendar_source_unavailable", 404);
    const stat = fs.statSync(real);
    if (!stat.isFile() || stat.size < 1 || stat.size > (video ? MAX_VIDEO_BYTES : 32 * 1024 * 1024)) fail("calendar_source_unavailable", 404);
    const metadata = video ? pedido.resultado_video : null;
    if (video && (!metadata || metadata.width !== 1080 || metadata.height !== 1920 ||
        !Number.isFinite(metadata.durationSeconds) || metadata.durationSeconds < 3 || metadata.durationSeconds > 60 ||
        typeof metadata.hasAudio !== "boolean")) fail("calendar_source_unavailable", 404);
    return { file: real, size: stat.size, version: `${stat.size}:${stat.mtimeMs}${video ? ":video" : ""}`,
      mediaKind: video ? "video" : "image", metadata, plan };
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
      let ready = item.imagem_pronta === true, version = "pending", mediaKind = "image", videoMetadata = null;
      if (ready) try { const source = result(owner, { planningId: item.planning_id, orderId: item.pedido_id });
        version = source.version; mediaKind = source.mediaKind; videoMetadata = source.metadata; }
      catch { ready = false; }
      return { key: item.calendar_key, planningId: item.planning_id, orderId: item.pedido_id,
        title: item.titulo, date: item.data, time: item.horario, caption: item.legenda || "",
        imageReady: ready, mediaKind, videoMetadata, version, authorizationEnvelope, calendarPayload: item,
        destination: plan.instagram_destination || "feed", layout: plan.instagram_layout || null };
    }).filter(item => item && item.planningId && item.orderId);
  }
  return Object.freeze({ list, describe: result,
    async load(owner, job) { const source = result(owner, job);
      if (source.mediaKind !== "image") fail("calendar_source_unavailable", 404);
      return fs.readFileSync(source.file); } });
}
module.exports = { createCalendarSource };
