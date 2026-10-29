"use strict";

const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), os = require("node:os");
const planning = require("../company-monthly-planning/planning.service");
const { dateTime, caption: calendarCaption } = require("../social/calendar/model");
const { atomicWriteJson } = require("../notifications/fcm-token-store");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const TICKET = /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/;
const TTL = 7 * 86400000;
function fail(code, statusCode = 409) {
  throw Object.assign(new Error("Não foi possível vincular este pedido ao calendário. Confira a conta e a programação."),
    { code: `edit_calendar_${code}`, statusCode });
}
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
function exact(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) fail("input_invalid", 400);
}
function text(value, max = 200) {
  if (typeof value !== "string" || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail("input_invalid", 400);
  return value.trim();
}
function contextInput(value, now) {
  exact(value, ["requestId", "date", "time", "destination", "caption"]);
  if (!UUID.test(value.requestId || "") || value.destination !== "reel") fail("input_invalid", 400);
  const at = dateTime(value.date, value.time);
  if (at <= now || at > now + 179 * 86400000) fail("time_invalid", 400);
  return { requestId: value.requestId.toLowerCase(), date: value.date, time: value.time,
    destination: "reel", caption: calendarCaption(value.caption ?? "") };
}
function bindInput(value) {
  exact(value, ["ticket", "editOrderId", "title", "caption", "durationSeconds", "inputHash", "mediaKind"]);
  const typed = Object.hasOwn(value, "mediaKind"), image = value.mediaKind === "image";
  if (typed && !["image", "video"].includes(value.mediaKind)) fail("input_invalid", 400);
  if (!TICKET.test(value.ticket || "") || !UUID.test(value.editOrderId || "") || !HASH.test(value.inputHash || "") ||
      (image ? value.durationSeconds !== null :
        !Number.isFinite(value.durationSeconds) || value.durationSeconds < 3 || value.durationSeconds > 60)) fail("input_invalid", 400);
  const title = text(value.title); if (!title) fail("input_invalid", 400);
  return { editOrderId: value.editOrderId.toLowerCase(), title, caption: calendarCaption(value.caption ?? ""),
    durationSeconds: value.durationSeconds, inputHash: value.inputHash,
    ...(typed ? { mediaKind: value.mediaKind } : {}) };
}
function billingDigest(client) {
  // No password, token, contact data or entire client snapshot enters this journal.
  const fields = Object.keys(client).filter(key => /^(plano|artes_|arte_gratis|planejamento_mensal|ciclo_|usados_no_ciclo|saldo|ultimo_pagamento)/.test(key)).sort();
  return hash(JSON.stringify(fields.map(key => [key, client[key]])));
}
function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(directory).isSymbolicLink() || !fs.lstatSync(directory).isDirectory()) fail("storage_invalid", 503);
}
function read(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32768) fail("storage_invalid", 503);
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

/** The existing image allocation and final-result route remain authoritative.
 * Context creation is uncharged. A trusted operator binds exactly one immutable
 * Edit order; no generation or publication is performed by this adapter.
 */
function createEditCalendarService({ dataDir, planningDir, ordersDir, secret, readClients, writeClients,
  prepareCalendarRequest, currentFreeArtBlocked = () => false, recordFreeArtUse = () => true,
  clock = Date.now, fault = () => {} }) {
  if (typeof readClients !== "function" || typeof writeClients !== "function" || typeof prepareCalendarRequest !== "function" ||
      typeof secret !== "string" || secret.length < 32) fail("configuration_invalid", 503);
  const root = path.join(path.resolve(dataDir), "private", "edit-calendar");
  const contexts = path.join(root, "contexts"), orders = path.join(root, "orders");
  const key = crypto.createHmac("sha256", secret).update("edit-calendar-ticket-v1").digest();
  const planningRoot = planningDir || path.join(dataDir, "planejamentos_mensais");
  const orderRoot = ordersDir || path.join(dataDir, "pedidos");
  function directories() { privateDirectory(path.dirname(root)); privateDirectory(root); privateDirectory(contexts); privateDirectory(orders); privateDirectory(orderRoot); }
  const contextFile = id => path.join(contexts, `${id}.json`);
  function ticketFor(id, owner) { return `${id}.${crypto.createHmac("sha256", key).update(`${id}\n${owner}`).digest("base64url")}`; }
  function ownerClient(claims) {
    const owner = claims?.whatsapp;
    if (typeof owner !== "string" || !owner || owner.length > 150) fail("session_required", 401);
    const clients = readClients(), client = Object.hasOwn(clients, owner) ? clients[owner] : null;
    if (!client || client.ativo !== true || client.cadastro_automatico === true && client.conta_finalizada !== true) fail("session_required", 401);
    return { owner, client, clients };
  }
  function response(row) {
    return { ok: true, editOrderId: row.binding.editOrderId, planningId: row.planningId, pedidoId: row.pedidoId };
  }
  function verifyContext(row, id, owner = null) {
    if (!row || row.schema !== 1 || row.id !== id || (owner !== null && row.owner !== owner) ||
        row.planningId !== `pm_edit_${id.replace(/-/g, "")}` || row.pedidoId !== `edit_${id.replace(/-/g, "")}` ||
        !HASH.test(row.ticketHash || "") || !Number.isSafeInteger(row.expiresAt)) fail("context_unavailable", 404);
  }
  function contextResponse(row) {
    const ticket = ticketFor(row.id, row.owner);
    if (hash(ticket.split(".")[1]) !== row.ticketHash) fail("context_unavailable", 404);
    return { ok: true, ticket, expiresAt: new Date(row.expiresAt).toISOString() };
  }
  async function createContext(claims, input, { freeArtBlocked = false, ipIdentity = null } = {}) {
    const current = ownerClient(claims), request = contextInput(input, clock()); directories();
    const id = request.requestId, digest = hash(JSON.stringify(request));
    const prior = read(contextFile(id));
    if (prior) {
      verifyContext(prior, id, current.owner);
      if (prior.requestHash !== digest || prior.phase !== "pending" || prior.expiresAt <= clock()) fail("context_conflict");
      return contextResponse(prior);
    }
    const planningId = `pm_edit_${id.replace(/-/g, "")}`;
    const factory = await prepareCalendarRequest(claims);
    const envelope = factory?.({ planningId, quantity: 1 }) || null;
    // The async preference lookup may race an identical mobile retry.
    const release = acquireLock();
    try {
      const raced = read(contextFile(id));
      if (raced) {
        verifyContext(raced, id, current.owner);
        if (raced.requestHash !== digest || raced.phase !== "pending" || raced.expiresAt <= clock()) fail("context_conflict");
        return contextResponse(raced);
      }
      const ticket = ticketFor(id, current.owner);
      const safeIpIdentity = ipIdentity && HASH.test(ipIdentity.ipHash || "") &&
        typeof ipIdentity.ipMasked === "string" && ipIdentity.ipMasked.length <= 80 && /^[0-9a-fA-F.:]*$/.test(ipIdentity.ipMasked)
        ? { ipHash: ipIdentity.ipHash, ipMasked: ipIdentity.ipMasked } : null;
      const row = { schema: 1, id, owner: current.owner, request, requestHash: digest,
        planningId, pedidoId: `edit_${id.replace(/-/g, "")}`, phase: "pending", createdAt: clock(), expiresAt: clock() + TTL,
        ticketHash: hash(ticket.split(".")[1]), envelope, freeArtBlocked: freeArtBlocked === true, ipIdentity: safeIpIdentity };
      atomicWriteJson(contextFile(id), row);
      return contextResponse(row);
    } finally { release(); }
  }
  function acquireLock() {
    const filename = path.join(root, "allocation.lock");
    let fd;
    try { fd = fs.openSync(filename, "wx", 0o600); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      const previous = read(filename);
      // An ambiguous owner/host is never grounds to duplicate a charge.
      if (!previous || previous.hostname !== os.hostname() || !Number.isSafeInteger(previous.pid)) fail("allocation_busy", 503);
      let alive = true;
      try { process.kill(previous.pid, 0); } catch (e) { if (e.code === "ESRCH") alive = false; }
      if (alive) fail("allocation_busy", 503);
      fs.unlinkSync(filename);
      try { fd = fs.openSync(filename, "wx", 0o600); } catch { fail("allocation_busy", 503); }
    }
    try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, hostname: os.hostname() })); fs.fsyncSync(fd); }
    catch (error) { fs.closeSync(fd); fs.unlinkSync(filename); throw error; }
    return () => { fs.closeSync(fd); fs.unlinkSync(filename); };
  }
  function bind(input) {
    const request = bindInput(input), parsed = input.ticket.match(TICKET), id = parsed[1]; directories();
    const completed = read(contextFile(id)); verifyContext(completed, id);
    if (!crypto.timingSafeEqual(Buffer.from(hash(parsed[2]), "hex"), Buffer.from(completed.ticketHash, "hex"))) fail("context_unavailable", 404);
    if (completed.binding && JSON.stringify(completed.binding) !== JSON.stringify(request)) fail("order_conflict");
    ownerClient({ whatsapp: completed.owner });
    // Reading an immutable completed receipt needs no allocation lock or charge.
    if (completed.phase === "bound") return response(completed);
    const release = acquireLock();
    try {
      const row = read(contextFile(id)); verifyContext(row, id);
      const supplied = Buffer.from(hash(parsed[2]), "hex"), expected = Buffer.from(row.ticketHash, "hex");
      if (!crypto.timingSafeEqual(supplied, expected)) fail("context_unavailable", 404);
      if (row.binding && JSON.stringify(row.binding) !== JSON.stringify(request)) fail("order_conflict");
      if (!row.binding && row.expiresAt <= clock()) fail("context_expired");
      ownerClient({ whatsapp: row.owner });
      if (row.phase === "bound") return response(row);
      const claimFile = path.join(orders, `${request.editOrderId}.json`), claim = read(claimFile);
      const identity = { schema: 1, contextId: id, inputHash: request.inputHash };
      if (claim && JSON.stringify(claim) !== JSON.stringify(identity)) fail("order_conflict");
      if (!claim) atomicWriteJson(claimFile, identity);
      const current = ownerClient({ whatsapp: row.owner });
      if (!row.binding) {
        row.binding = request; row.phase = "allocating"; row.beforeBillingDigest = billingDigest(current.client);
        row.cycle = String(current.client.plano_ciclo || current.client.ciclo_mes || "");
        atomicWriteJson(contextFile(id), row);
      }
      const priorReservation = current.client.planejamento_mensal_reservas?.[row.planningId];
      let plan = planning.findPlanningById({ baseDir: planningRoot, whatsapp: row.owner, planningId: row.planningId });
      const externalEdit = { kind: "edit_calendar_v1", contextId: id, editOrderId: request.editOrderId, inputHash: request.inputHash,
        ...(request.mediaKind ? { mediaKind: request.mediaKind } : {}) };
      const image = request.mediaKind === "image", objective = image ? "Imagem escolhida no Edit" : "Vídeo escolhido no Edit";
      if (plan && (JSON.stringify(plan.edit_calendar) !== JSON.stringify(externalEdit) || plan.whatsapp !== row.owner)) fail("order_conflict");
      if (priorReservation && !plan) fail("allocation_reconciliation_required", 503);
      if (!priorReservation) {
        if (row.billingRefused) {
          row.beforeBillingDigest = billingDigest(current.client); delete row.billingRefused;
          atomicWriteJson(contextFile(id), row);
        }
        if (billingDigest(current.client) !== row.beforeBillingDigest) fail("allocation_reconciliation_required", 503);
        try {
          plan = planning.createRequest({ baseDir: planningRoot, cliente: current.client, whatsapp: row.owner,
            body: { quantidade_reservada: 1, instagram_destination: "feed", orientacoes_fotos: [
              { slot_id: image ? "edit-image" : "edit-video", ordem: 1, tem_arquivo: false, objetivo: objective } ] },
            files: {}, freeArtBlocked: row.freeArtBlocked || currentFreeArtBlocked(row.ipIdentity) === true, externalEdit,
            calendarAuthorizationFactory: () => row.envelope });
        } catch (error) {
          // An insufficient-credit refusal happens before any charge or request is committed.
          if (error.code === "billing_required" || error.code === "monthly_planning_insufficient_arts") {
            row.beforeBillingDigest = billingDigest(ownerClient({ whatsapp: row.owner }).client);
            row.billingRefused = true; atomicWriteJson(contextFile(id), row);
          }
          throw error;
        }
      }
      fault("after_request");
      const caption = row.request.caption || request.caption || "Conheça nosso trabalho e acompanhe nosso conteúdo.";
      planning.savePlanResult({ baseDir: planningRoot, planningId: row.planningId, pedidosDir: orderRoot, cliente: current.client,
        payload: { postagens: [{ planejamento_item_id: `edit-${id}`, ordem: 1, tema: request.title,
          objetivo: objective, data_sugerida: row.request.date, horario_sugerido: row.request.time,
          descricao_instagram: caption, legenda: caption, sem_imagem: true }] } });
      const found = planning.findPlanningArtOrder({ pedidosDir: orderRoot, pedidoId: row.pedidoId });
      if (!found || found.pedido.whatsapp !== row.owner || JSON.stringify(found.pedido.edit_calendar) !== JSON.stringify(externalEdit))
        fail("allocation_reconciliation_required", 503);
      // The normal image result's caption is returned by its producer. Record the
      // selected caption here so an MP4 return without text preserves it too.
      if (!found.pedido.descricao_instagram || row.request.caption) {
        const storage = require("../orders/order.storage");
        storage.writeOrder(found.base, { ...found.pedido, descricao_instagram: caption,
          ...(row.request.caption ? { edit_calendar_caption: row.request.caption } : {}) });
      }
      fault("before_client_commit");
      writeClients(current.clients);
      fault("after_client_commit");
      const consumedFreeArt = Number(current.client.planejamento_mensal_reservas?.[row.planningId]?.artes_gratis_consumidas || 0) > 0;
      if (consumedFreeArt && row.ipIdentity && recordFreeArtUse({ owner: row.owner, planningId: row.planningId, ipIdentity: row.ipIdentity }) !== true)
        fail("free_art_receipt_unconfirmed", 503);
      row.phase = "bound"; row.boundAt = clock(); atomicWriteJson(contextFile(id), row);
      return response(row);
    } finally { release(); }
  }
  return Object.freeze({ createContext, bind, close() { key.fill(0); } });
}
module.exports = { createEditCalendarService, contextInput, bindInput };
