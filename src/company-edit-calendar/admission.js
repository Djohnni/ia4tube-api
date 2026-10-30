"use strict";

const path = require("node:path"), crypto = require("node:crypto");
const planning = require("../company-monthly-planning/planning.service");
const billing = require("../billing/billing.service");
const { admissionInput, admissionOrderId, statusInput, cancelInput, hash, canonicalJson, fail, UUID, HASH } = require("./admission-contract");
const FREE_FIELDS = ["arte_gratis_disponivel", "arte_gratis_usada", "arte_gratis_usada_em", "arte_gratis_pedido_id", "arte_gratis_criada_em"];
function legacyConsumed(client) {
  return Boolean(client && typeof client === "object" && (client.arte_gratis_usada === true || Boolean(client.arte_gratis_pedido_id) ||
    (Array.isArray(client.arte_gratis_usos) && client.arte_gratis_usos.length > 0)));
}
function confirmedInstagram(value) {
  return Boolean(value && value.provider === "instagram" && value.state === "connected" && value.health === "healthy" &&
    ["business", "creator"].includes(value.accountType) && /^[0-9]{5,64}$/.test(value.externalId || ""));
}
function createEditAdmissionService(ports) {
  const { root, contextFile, claimFile, read, write, directories, acquireLock, ownerClient, ticketContext,
    billingDigest, planningRoot, orderRoot, clock, fault, observeConnection, currentFreeArtBlocked, recordFreeArtUse, canReuseCancelledFreeArt, secret } = ports;
  const enabled = ports.enabled === true;
  const key = crypto.createHmac("sha256", secret).update("edit-free-image-ledger-v1").digest();
  const fingerprint = (purpose, value) => crypto.createHmac("sha256", key).update(`${purpose}\n${value}`).digest("hex");
  const ledgerFile = path.join(root, "free-image-ledger.json");
  function assertEnabled() { if (!enabled) fail("admission_disabled", 503); }
  function ledger() {
    const value = read(ledgerFile, 2 * 1024 * 1024) || { schema: 1, keyId: hash(key), owners: {}, instagram: {} };
    if (value.schema !== 1 || value.keyId !== hash(key) || !value.owners || !value.instagram || typeof value.owners !== "object" || typeof value.instagram !== "object")
      fail("allocation_reconciliation_required", 503);
    return value;
  }
  function wire(row) {
    const value = row.admission;
    if (!value || !UUID.test(value.admissionId || "") || !HASH.test(value.requestHash || "") ||
        !HASH.test(value.contextHash || "") || !Number.isSafeInteger(value.reservedAt)) fail("admission_unavailable", 404);
    if (value.state === "reserved" && !row.binding) {
      const plan = planning.findPlanningById({ baseDir: planningRoot, whatsapp: row.owner, planningId: row.planningId });
      if (!plan || plan.edit_calendar?.contextId !== row.id) fail("allocation_reconciliation_required", 503);
      if (plan.status === "cancelado") fail("admission_conflict");
    }
    return { schemaVersion: 1, admissionId: value.admissionId, editOrderId: value.editOrderId,
      requestHash: value.requestHash, contextHash: value.contextHash, mediaKind: value.mediaKind, quantity: 1,
      // A frozen producer binding is already fenced against cancellation/re-approval, including crash recovery.
      state: value.state === "reserved" && row.binding ? "bound" : value.state,
      reservedAt: value.reservedAt, planningId: row.planningId, pedidoId: row.pedidoId };
  }
  function response(row) { return { ok: true, admission: wire(row) }; }
  function inputIdentity(request) { const { ticket, ...value } = request; return hash(canonicalJson(value)); }
  function ensureClaim(row) {
    const identity = { schema: 2, contextId: row.id, admissionId: row.admission.admissionId, requestHash: row.admission.requestHash };
    const existing = read(claimFile(row.admission.editOrderId));
    if (existing && canonicalJson(existing) !== canonicalJson(identity)) fail("order_conflict");
    if (!existing) write(claimFile(row.admission.editOrderId), identity);
  }
  // Shared observation predicate. It never creates a grant, migrates the ledger, writes or reserves.
  function inspectFreeClaim(owner, client, connection, value, { ipIdentity = null, blocked = false, admissionId = null } = {}) {
    if (!confirmedInstagram(connection) || legacyConsumed(client)) return null;
    const ownerKey = fingerprint("owner", owner), instagramKey = fingerprint("instagram", connection.externalId);
    const existing = value.owners[ownerKey], externalOwner = value.instagram[instagramKey];
    if ((blocked || currentFreeArtBlocked(ipIdentity) === true) &&
        !(existing?.state === "available" && ipIdentity?.ipHash === existing.reusableIpHash &&
          canReuseCancelledFreeArt({ owner, planningId: existing.reusablePlanningId, ipIdentity }) === true)) return null;
    if (externalOwner && externalOwner !== ownerKey || existing && existing.instagramKey !== instagramKey ||
        existing && existing.state !== "available" && (!admissionId || existing.admissionId !== admissionId)) return null;
    return { ownerKey, instagramKey, grandfather: client.arte_gratis_disponivel === true };
  }
  function freeClaim(row, connection, current) {
    if (row.admission.mediaKind !== "image" || !confirmedInstagram(connection) || legacyConsumed(current.client)) return null;
    const value = ledger(); let migrated = false;
    // Conservative, idempotent migration under the same allocation lock. Keep a consumed owner fingerprint
    // even if a later account rewrite drops legacy flags; never reissue or rewrite an existing allocation.
    for (const [owner, client] of Object.entries(current.clients)) {
      const historicalKey = fingerprint("owner", owner);
      if (legacyConsumed(client) && !value.owners[historicalKey]) {
        value.owners[historicalKey] = { instagramKey: null, admissionId: null, planningId: null, state: "legacy_consumed" };
        migrated = true;
      }
    }
    if (migrated) write(ledgerFile, value);
    return inspectFreeClaim(row.owner, current.client, connection, value,
      { ipIdentity: row.ipIdentity, blocked: row.freeArtBlocked, admissionId: row.admission.admissionId });
  }
  function availabilityResponse(canImage, canVideo) {
    const observedAt = clock();
    return { ok: true, availability: { schemaVersion: 1, canImage, canVideo, observedAt, validUntil: observedAt + 30000 } };
  }
  function readPaidAvailability(client) {
    // Billing normalizes/rolls cycles in memory. The observation owns this copy and never persists it.
    const copy = structuredClone(client), now = new Date(clock()), status = billing.getBillingStatus(copy, now);
    const monthly = billing.isPlanActive(copy, now) ? status.artes_mensais_restantes : 0;
    const standalone = status.artes_avulsas_restantes;
    if (![monthly, standalone].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error("availability_billing_invalid");
    return { paid: monthly + standalone >= 1, freeFeature: status.arte_gratis_ativa === true };
  }
  async function availability(claims, policy = {}) {
    let current = ownerClient(claims);
    if (!enabled) return availabilityResponse(null, null);
    let measured;
    try { measured = readPaidAvailability(current.client); }
    catch { return availabilityResponse(null, null); }
    if (measured.paid) return availabilityResponse(true, true);
    if (!measured.freeFeature || legacyConsumed(current.client)) return availabilityResponse(false, false);
    let connection = null, observationFailed = typeof observeConnection !== "function";
    try { if (!observationFailed) connection = await observeConnection(claims); }
    catch { observationFailed = true; }
    // A reservation/credit may have changed during the connection read. Use the fresh client for the final hint.
    try { current = ownerClient(claims); measured = readPaidAvailability(current.client); }
    catch (error) { if (error.statusCode === 401) throw error; return availabilityResponse(null, null); }
    if (measured.paid) return availabilityResponse(true, true);
    if (!measured.freeFeature || legacyConsumed(current.client)) return availabilityResponse(false, false);
    if (observationFailed) return availabilityResponse(null, false);
    try {
      return availabilityResponse(Boolean(inspectFreeClaim(current.owner, current.client, connection, ledger(),
        { ipIdentity: policy.ipIdentity, blocked: policy.freeArtBlocked === true })), false);
    } catch { return availabilityResponse(null, false); }
  }
  function reserveFreeClaim(row) {
    const claim = row.admission.freeClaim;
    if (!claim) return;
    const value = ledger(), prior = value.owners[claim.ownerKey];
    if (value.instagram[claim.instagramKey] && value.instagram[claim.instagramKey] !== claim.ownerKey ||
        prior && prior.instagramKey !== claim.instagramKey ||
        prior && prior.state !== "available" && prior.admissionId !== row.admission.admissionId) fail("allocation_reconciliation_required", 503);
    value.owners[claim.ownerKey] = { instagramKey: claim.instagramKey, admissionId: row.admission.admissionId,
      planningId: row.planningId, state: "reserved",
      ...(prior?.reusableIpHash ? { reusableIpHash: prior.reusableIpHash, reusablePlanningId: prior.reusablePlanningId } : {}) };
    value.instagram[claim.instagramKey] = claim.ownerKey;
    write(ledgerFile, value);
  }
  function finishFreeClaim(row, state) {
    const claim = row.admission?.freeClaim;
    if (!claim) return;
    const value = ledger(), prior = value.owners[claim.ownerKey];
    if (!prior || prior.admissionId !== row.admission.admissionId || prior.instagramKey !== claim.instagramKey)
      fail("allocation_reconciliation_required", 503);
    prior.state = state;
    if (state === "available" && row.admission.cancellation && row.ipIdentity?.ipHash) {
      prior.reusableIpHash = row.ipIdentity.ipHash; prior.reusablePlanningId = row.planningId;
    } else if (state === "consumed") { delete prior.reusableIpHash; delete prior.reusablePlanningId; }
    write(ledgerFile, value);
  }
  function marker(row, inputHash) {
    return { kind: "edit_calendar_v1", contextId: row.id, editOrderId: row.admission.editOrderId,
      inputHash, mediaKind: row.admission.mediaKind };
  }
  function reserve(row, current) {
    const value = row.admission;
    let plan = planning.findPlanningById({ baseDir: planningRoot, whatsapp: row.owner, planningId: row.planningId });
    const prior = current.client.planejamento_mensal_reservas?.[row.planningId];
    if (prior && !plan) fail("allocation_reconciliation_required", 503);
    if (!prior) {
      if (billingDigest(current.client) !== value.beforeBillingDigest) fail("allocation_reconciliation_required", 503);
      if (value.freeClaim) {
        reserveFreeClaim(row);
        current.client.arte_gratis_disponivel = true;
      }
      plan = planning.createRequest({ baseDir: planningRoot, cliente: current.client, whatsapp: row.owner,
        body: { quantidade_reservada: 1, instagram_destination: "feed", orientacoes_fotos: [{
          slot_id: value.mediaKind === "image" ? "edit-image" : "edit-video", ordem: 1, tem_arquivo: false,
          objetivo: value.mediaKind === "image" ? "Imagem escolhida no Edit" : "Vídeo escolhido no Edit" }] }, files: {},
        // The admission marker deliberately has no producer inputHash and cannot create children.
        externalEdit: { kind: "edit_calendar_admission_v1", contextId: row.id, editOrderId: value.editOrderId,
          requestHash: value.requestHash, admissionId: value.admissionId, mediaKind: value.mediaKind }, freeArtBlocked: !value.freeClaim,
        calendarAuthorizationFactory: () => row.envelope });
      fault("admission_after_request");
      writeClients(current.clients);
      fault("admission_after_client_commit");
    }
    const reservation = current.client.planejamento_mensal_reservas?.[row.planningId];
    if (!reservation || reservation.status !== "ativa" || Number(reservation.quantidade_reservada) !== 1 ||
        Number(reservation.artes_produzidas || 0) !== 0) fail("allocation_reconciliation_required", 503);
    value.reservation = { cycle: reservation.ciclo, monthly: Number(reservation.artes_mensais_reservadas || 0),
      standalone: Number(reservation.artes_avulsas_consumidas || 0), free: Number(reservation.artes_gratis_consumidas || 0) };
    if (value.reservation.monthly + value.reservation.standalone + value.reservation.free !== 1) fail("allocation_reconciliation_required", 503);
    if (value.reservation.free && row.ipIdentity && recordFreeArtUse({ owner: row.owner, planningId: row.planningId, ipIdentity: row.ipIdentity }) !== true)
      fail("free_art_receipt_unconfirmed", 503);
    if (!value.reservation.free && value.freeClaim) {
      finishFreeClaim(row, "available"); delete value.freeClaim;
    }
    value.state = "reserved"; row.phase = "admitted"; write(contextFile(row.id), row);
    return response(row);
  }
  const writeClients = ports.writeClients;
  function inspectCapability(request) {
    const row = ticketContext(request.ticket), current = ownerClient({ whatsapp: row.owner });
    const reservation = current.client.planejamento_mensal_reservas?.[row.planningId];
    if (!row.binding && row.expiresAt <= clock() && !reservation) fail("context_expired");
    if (row.admission) {
      if (row.admission.inputIdentity !== inputIdentity(request) || row.admission.contextHash !== hash(request.ticket)) fail("admission_conflict");
    } else if (row.binding) {
      if (row.binding.editOrderId !== request.editOrderId || (row.binding.mediaKind || "video") !== request.mediaKind) fail("order_conflict");
    } else if (reservation) {
      // A pre-existing financial intent may retain its old ID, but never accept a caller-selected replacement.
      const plan = planning.findPlanningById({ baseDir: planningRoot, whatsapp: row.owner, planningId: row.planningId });
      if (!plan || plan.edit_calendar?.contextId !== row.id || plan.edit_calendar.editOrderId !== request.editOrderId) fail("order_conflict");
    } else if (request.editOrderId !== admissionOrderId(request.ticket)) fail("order_conflict");
    return { row, current };
  }
  function verifyCapability(input) {
    assertEnabled(); const request = admissionInput(input); inspectCapability(request);
    return hash(request.ticket);
  }
  async function admit(input) {
    assertEnabled(); const request = admissionInput(input);
    const { row: initial, current: before } = inspectCapability(request);
    let connection = null;
    if ((!initial.admission || initial.admission.state === "allocating") && initial.phase !== "bound" && request.mediaKind === "image" && !legacyConsumed(before.client) &&
        !billing.hasAvailablePlanArt(before.client) && typeof observeConnection === "function") {
      // Observational existing service only. No provider call, OAuth transition or calendar synchronization.
      try { connection = await observeConnection(initial.sessionIdentity); }
      catch { if (!billing.hasAvailableStandaloneArt(before.client)) fail("admission_unavailable", 503); }
    }
    // Recheck after the await, still before directory/lock/journal writes. An expired or deactivated capability cannot write.
    inspectCapability(request); directories(); const release = acquireLock();
    try {
      const row = ticketContext(request.ticket), current = ownerClient({ whatsapp: row.owner });
      if (!row.binding && row.expiresAt <= clock() && !current.client.planejamento_mensal_reservas?.[row.planningId]) fail("context_expired");
      if (row.admission) {
        if (row.admission.inputIdentity !== inputIdentity(request) || row.admission.contextHash !== hash(request.ticket)) fail("admission_conflict");
        if (row.admission.state === "cancelled" || row.admission.state === "cancelling") fail("admission_conflict");
        if (["reserved", "bound"].includes(row.admission.state)) return response(row);
        if (row.admission.freeClaim && !current.client.planejamento_mensal_reservas?.[row.planningId] &&
            (!confirmedInstagram(connection) || fingerprint("instagram", connection.externalId) !== row.admission.freeClaim.instagramKey))
          fail("admission_unavailable", 503);
        if (row.admission.billingRefused) {
          row.admission.beforeBillingDigest = billingDigest(current.client);
          row.admission.freeClaim = freeClaim(row, connection, current);
          delete row.admission.billingRefused; write(contextFile(row.id), row);
        }
        ensureClaim(row);
        try { return reserve(row, current); }
        catch (error) {
          if (error.code === "billing_required" || error.code === "monthly_planning_insufficient_arts") {
            row.admission.beforeBillingDigest = billingDigest(ownerClient({ whatsapp: row.owner }).client);
            row.admission.billingRefused = true; write(contextFile(row.id), row);
          }
          throw error;
        }
      }
      if (row.phase === "bound") {
        if (row.binding.editOrderId !== request.editOrderId || (row.binding.mediaKind || "video") !== request.mediaKind) fail("order_conflict");
        row.admission = { admissionId: crypto.randomUUID(), editOrderId: request.editOrderId, requestHash: request.requestHash,
          contextHash: hash(request.ticket), mediaKind: request.mediaKind, inputIdentity: inputIdentity(request),
          reservedAt: row.boundAt || row.createdAt, state: "bound", legacyBound: true };
        write(contextFile(row.id), row); return response(row);
      }
      if (row.binding || row.phase !== "pending") fail("allocation_reconciliation_required", 503);
      if (row.expiresAt <= clock()) fail("context_expired");
      row.admission = { admissionId: crypto.randomUUID(), editOrderId: request.editOrderId, requestHash: request.requestHash,
        contextHash: hash(request.ticket), mediaKind: request.mediaKind, selection: request.selection,
        inputIdentity: inputIdentity(request), reservedAt: clock(), state: "allocating", beforeBillingDigest: billingDigest(current.client),
        freeBefore: Object.fromEntries(FREE_FIELDS.filter(field => Object.hasOwn(current.client, field)).map(field => [field, current.client[field]])) };
      row.admission.freeClaim = freeClaim(row, connection, current);
      // An emitted legacy eligibility remains one legacy right; a new admission never spends it on video or without confirmed Instagram.
      write(contextFile(row.id), row); ensureClaim(row); fault("admission_after_journal");
      try { return reserve(row, current); }
      catch (error) {
        if (error.code === "billing_required" || error.code === "monthly_planning_insufficient_arts") {
          row.admission.beforeBillingDigest = billingDigest(ownerClient({ whatsapp: row.owner }).client);
          row.admission.billingRefused = true; write(contextFile(row.id), row);
        }
        throw error;
      }
    } finally { release(); }
  }
  function status(editOrderId, input) {
    assertEnabled(); const request = statusInput(editOrderId, input);
    const claim = read(claimFile(request.editOrderId));
    if (!claim || !UUID.test(claim.contextId || "")) fail("admission_unavailable", 404);
    const row = read(contextFile(claim.contextId));
    if (!row?.admission) fail("admission_unavailable", 404);
    ownerClient({ whatsapp: row.owner }); const value = wire(row);
    if (value.editOrderId !== request.editOrderId || value.requestHash !== request.requestHash || value.contextHash !== request.contextHash ||
        value.mediaKind !== request.mediaKind) fail("admission_conflict");
    return { ok: true, admission: value };
  }
  function assertBind(row, request) {
    if (!row.admission) {
      if (row.admissionRequired === true && !row.binding && row.phase === "pending") fail("admission_required", 403);
      return;
    }
    if (!["reserved", "bound"].includes(row.admission.state) || row.admission.editOrderId !== request.editOrderId ||
        row.admission.mediaKind !== (request.mediaKind || "video")) fail("admission_conflict");
  }
  function prepareBind(row, request) {
    assertBind(row, request);
    if (!row.admission || row.admission.legacyBound || row.admission.state === "bound") return;
    const plan = planning.findPlanningById({ baseDir: planningRoot, whatsapp: row.owner, planningId: row.planningId });
    if (!plan || plan.edit_calendar?.contextId !== row.id || plan.edit_calendar?.editOrderId !== request.editOrderId ||
        plan.edit_calendar?.mediaKind !== row.admission.mediaKind) fail("allocation_reconciliation_required", 503);
    // Only the authenticated local bind freezes the producer snapshot. Never equate it with the receiver request hash.
    const stored = read(plan.solicitacao_path);
    if (!stored || stored.edit_calendar?.contextId !== row.id) fail("allocation_reconciliation_required", 503);
    write(plan.solicitacao_path, { ...stored, edit_calendar: marker(row, request.inputHash) });
  }
  function finishBind(row) {
    if (!row.admission || row.admission.legacyBound) return;
    finishFreeClaim(row, "consumed"); row.admission.state = "bound";
  }
  function refundClient(row, current) {
    const value = row.admission, allocation = value.reservation;
    const held = current.client.planejamento_mensal_reservas?.[row.planningId];
    if (!held || held.status !== "ativa" || Number(held.artes_produzidas || 0) !== 0 || !allocation)
      fail("allocation_reconciliation_required", 503);
    if (allocation.monthly) {
      if (current.client.planejamento_mensal_ciclo !== allocation.cycle) fail("allocation_reconciliation_required", 503);
      current.client.artes_mensais_restantes = Number(current.client.artes_mensais_restantes || 0) + 1;
    }
    if (allocation.standalone) {
      current.client.artes_avulsas_restantes = Number(current.client.artes_avulsas_restantes || 0) + 1;
      current.client.artes_avulsas_usadas = Math.max(0, Number(current.client.artes_avulsas_usadas || 0) - 1);
      current.client.artes_avulsas_consumos = (current.client.artes_avulsas_consumos || []).filter(item => item.planejamento_id !== row.planningId);
    }
    if (allocation.free) {
      if (current.client.arte_gratis_pedido_id !== row.planningId) fail("allocation_reconciliation_required", 503);
      for (const field of FREE_FIELDS) {
        if (Object.hasOwn(value.freeBefore, field)) current.client[field] = value.freeBefore[field]; else delete current.client[field];
      }
      current.client.arte_gratis_usos = (current.client.arte_gratis_usos || []).filter(item => item.pedido_id !== row.planningId);
      if (current.client.ciclo_mes === allocation.cycle)
        current.client.usados_no_ciclo = Math.max(0, Number(current.client.usados_no_ciclo || 0) - 1);
    }
    held.status = "cancelada"; held.artes_bloqueadas_ativas = 0; held.artes_devolvidas = Number(held.artes_devolvidas || 0) + 1;
    current.client.planejamento_mensal_artes_reservadas = Object.values(current.client.planejamento_mensal_reservas)
      .filter(item => item.status === "ativa").reduce((sum, item) => sum + Number(item.artes_bloqueadas_ativas || 0), 0);
  }
  function cancel(input) {
    assertEnabled(); const request = cancelInput(input); const release = acquireLock();
    try {
      const row = ticketContext(request.ticket), value = row.admission;
      if (!value || value.editOrderId !== request.editOrderId || value.requestHash !== request.requestHash) fail("admission_conflict");
      if (value.state === "cancelled") return response(row);
      if (row.binding || !["reserved", "cancelling"].includes(value.state)) fail("admission_not_cancellable");
      const current = ownerClient({ whatsapp: row.owner });
      if (!value.cancellation) {
        const beforeDigest = billingDigest(current.client); refundClient(row, current);
        value.cancellation = { reason: request.reason, beforeDigest, afterDigest: billingDigest(current.client), at: clock() };
        value.state = "cancelling"; write(contextFile(row.id), row); fault("admission_cancel_after_journal");
        writeClients(current.clients);
      } else if (billingDigest(current.client) === value.cancellation.beforeDigest) {
        refundClient(row, current);
        if (billingDigest(current.client) !== value.cancellation.afterDigest) fail("allocation_reconciliation_required", 503);
        writeClients(current.clients);
      } else if (billingDigest(current.client) !== value.cancellation.afterDigest) fail("allocation_reconciliation_required", 503);
      fault("admission_cancel_after_client_commit");
      planning.cancelPlanning({ baseDir: planningRoot, whatsapp: row.owner, planningId: row.planningId, cliente: null });
      finishFreeClaim(row, "available"); value.state = "cancelled"; row.phase = "cancelled";
      write(contextFile(row.id), row); return response(row);
    } finally { release(); }
  }
  return Object.freeze({ admit, status, cancel, availability, verifyCapability, assertBind, prepareBind, finishBind,
    claimIdentity(row) { return { schema: 2, contextId: row.id, admissionId: row.admission.admissionId, requestHash: row.admission.requestHash }; },
    close() { key.fill(0); } });
}
module.exports = { createEditAdmissionService, legacyConsumed, confirmedInstagram };
