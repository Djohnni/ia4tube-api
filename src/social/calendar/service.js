"use strict";
const crypto = require("node:crypto");
const { createConnectorContext } = require("../connectors/contract");
const { fail, idFor, syncSources, changeJob, sameBinding, availability, TIME_ZONE, LOCKED, LATE_MS } = require("./model");
const LABELS = { scheduled: "Programada", paused: "Automação pausada", manual: "Sem publicação automática",
  waiting_media: "Preparando imagem", operations_closed: "Publicação temporariamente indisponível",
  connection_required: "Confira a conexão Instagram", overdue: "Horário vencido — reagende", attention: "Precisa de atenção",
  dispatching: "Publicando", confirming: "Confirmando publicação", published: "Publicada", cancelled: "Cancelada" };
function createCalendarService({ store, source, media, grants, auth, identity, readClients, publisher, clock = Date.now }) {
  let stopped = false, running = false, timer = null;
  function active(owner) {
    const clients = readClients(); const client = Object.hasOwn(clients, owner) ? clients[owner] : null;
    if (!client || client.ativo !== true || (client.cadastro_automatico === true && client.conta_finalizada !== true)) fail("calendar_session_required", 401);
  }
  function context(principal) { return createConnectorContext({ principal, provider: "instagram", environment: "production",
    correlationId: crypto.randomUUID(), auditEventId: crypto.randomUUID() }); }
  function session(claims) {
    const principal = auth.fromVerifiedJwt(claims); active(claims.whatsapp);
    return { owner: claims.whatsapp, context: context(principal) };
  }
  function delegated(owner, envelope) {
    active(owner); const ids = identity(owner, owner);
    const grant = grants.verify(envelope, ids.companyId, ids.userId);
    if (!grant) fail("calendar_consent_invalid");
    return { grant, context: context(auth.fromVerifiedCalendarGrant(grant)) };
  }
  async function sync(owner, companyId, userId) {
    active(owner);
    const counts = new Map();
    const sources = source.list(owner).map(item => {
      const grant = grants.verify(item.authorizationEnvelope, companyId, userId);
      const count = (counts.get(item.planningId) || 0) + 1; counts.set(item.planningId, count);
      return { ...item, authorization: grant && grant.planningId === item.planningId && count <= grant.quantity
        ? { ...grant, envelope: item.authorizationEnvelope } : null };
    });
    await store.update(companyId, state => { syncSources(state, sources, companyId, clock()); return null; });
    // Bounded preparation outside the DB lock; commit only if source/revision still match.
    const pending = await store.update(companyId, state => Object.values(state.jobs).filter(job => !job.asset && job.error !== "calendar_image_preparation_failed" &&
      !LOCKED.has(job.phase) && job.phase !== "cancelled" && sources.some(item => item.key === job.sourceKey && item.imageReady))
      .sort((a, b) => Number(Boolean(b.authorization)) - Number(Boolean(a.authorization)) || a.scheduledAt - b.scheduledAt).slice(0, 2));
    for (const job of pending) {
      try {
        const asset = await media.prepare(owner, companyId, job);
        await store.update(companyId, state => { const current = state.jobs[job.id];
          if (current?.revision === job.revision && current.sourceVersion === job.sourceVersion && !LOCKED.has(current.phase) && current.phase !== "cancelled") {
            current.asset = asset; current.phase = current.error ? "attention" : "ready"; current.revision++;
          }
          return null;
        });
      } catch {
        await store.update(companyId, state => { const current = state.jobs[job.id];
          if (current?.revision === job.revision) { current.error = "calendar_image_preparation_failed"; current.phase = "attention"; current.revision++; }
          return null;
        });
      }
    }
  }
  function view(job, prefs, connection, allowed) {
    const status = availability(job, prefs, connection?.binding, allowed, clock());
    return { id: job.id, key: job.sourceKey, planningId: job.planningId, orderId: job.orderId,
      title: job.title, date: job.date, time: job.time, timeZone: TIME_ZONE, scheduledAt: job.scheduledAt,
      caption: job.caption, revision: job.revision, status, statusLabel: LABELS[status],
      imageUrl: job.asset ? `/v1/social/calendar/items/${job.id}/image` : null,
      editable: !job.intent && !LOCKED.has(job.phase) && job.phase !== "cancelled", automatic: Boolean(job.authorization),
      username: connection?.username || null, error: job.error || null, publication: job.publication || null };
  }
  async function list(claims) {
    const current = session(claims); const { companyId, userId } = current.context;
    await sync(current.owner, companyId, userId);
    const connection = await publisher.connection(current.context);
    const allowed = publisher.allowed(current.context);
    return store.update(companyId, state => {
      const items = Object.values(state.jobs).filter(job => job.phase !== "cancelled")
        .sort((a, b) => a.scheduledAt - b.scheduledAt || a.id.localeCompare(b.id))
        .map(job => view(job, state.preferences, connection, allowed));
      const next = items.find(item => ["dispatching", "confirming"].includes(item.status)) ||
        items.find(item => item.automatic && item.status !== "published" && item.scheduledAt + LATE_MS >= clock()) || null;
      return { ok: true, enabled: true, preferences: state.preferences, connection, operationsAllowed: allowed,
        timeZone: TIME_ZONE, serverTime: clock(), items, next };
    });
  }
  async function preferences(claims, input) {
    const current = session(claims); const connection = await publisher.connection(current.context);
    if (typeof input.enabled !== "boolean" || !Number.isSafeInteger(input.revision) || (input.enabled && input.confirmed !== true)) fail("calendar_consent_required", 400);
    if (input.enabled && !connection) fail("calendar_connection_required");
    await store.update(current.context.companyId, state => {
      if (state.preferences.revision !== input.revision) fail("calendar_revision_conflict");
      state.preferences = { enabled: input.enabled, revision: input.revision + 1,
        binding: connection?.binding || state.preferences.binding, updatedAt: clock() };
      return null;
    });
    return list(claims);
  }
  async function prepareRequest(claims, enabled, revision) {
    if (enabled !== "true" && enabled !== true) return null;
    const current = session(claims); const connection = await publisher.connection(current.context);
    const consent = await store.update(current.context.companyId, state => {
      if (!state.preferences.enabled || state.preferences.revision !== Number(revision) || !sameBinding(state.preferences.binding, connection?.binding)) fail("calendar_consent_changed");
      return { companyId: current.context.companyId, userId: current.context.userId,
        binding: connection.binding, revision: state.preferences.revision };
    });
    return ({ planningId, quantity }) => grants.issue({ ...consent, planningId, quantity });
  }
  async function edit(claims, id, input) {
    const current = session(claims);
    await sync(current.owner, current.context.companyId, current.context.userId);
    await store.update(current.context.companyId, state => { changeJob(state, id, input, clock()); return null; });
    return list(claims);
  }
  async function image(claims, id) {
    const current = session(claims);
    const job = await store.update(current.context.companyId, state => state.jobs[id] || null);
    if (!job?.asset || job.phase === "cancelled") fail("calendar_not_found", 404);
    return media.bytesFor(current.context.companyId, job.asset);
  }
  async function overlay(claims, payload) {
    const current = session(claims); await sync(current.owner, current.context.companyId, current.context.userId);
    const state = await store.update(current.context.companyId, value => value);
    const connection = await publisher.connection(current.context);
    const raw = payload.postagens || payload.itens || [];
    const postagens = raw.flatMap(item => {
      const job = state.jobs[idFor(current.context.companyId, item.calendar_key)];
      if (!job) return [item]; if (job.phase === "cancelled") return [];
      return [{ ...item, data: job.date, data_sugerida: job.date, horario: job.time, horario_sugerido: job.time,
        legenda: job.caption, descricao_instagram: job.caption, calendar_schedule_id: job.id,
        calendar_revision: job.revision, calendar_phase: job.phase,
        calendar_status_label: view(job, state.preferences, connection, publisher.allowed(current.context)).statusLabel,
        sort_key: `${job.date}|${job.time}|${String(item.ordem || 0).padStart(4, "0")}` }];
    }).sort((a, b) => `${a.data}|${a.horario}`.localeCompare(`${b.data}|${b.horario}`));
    return { ...payload, postagens, itens: postagens, total: postagens.length };
  }
  async function legacyEdit(claims, key, input) {
    const current = session(claims); await sync(current.owner, current.context.companyId, current.context.userId);
    const sources = source.list(current.owner);
    return store.update(current.context.companyId, state => {
      const reference = input.reference || {};
      const matches = Object.values(state.jobs).filter(job => job.sourceKey === key || job.orderId === key ||
        (reference.pedido_id && job.orderId === reference.pedido_id) ||
        ((reference.planning_id || reference.planejamento_id) === job.planningId && reference.planejamento_item_id &&
          job.sourceKey === `${job.planningId}:${reference.planejamento_item_id}`));
      if (matches.length > 1) fail("calendar_reference_ambiguous", 400);
      const job = matches[0]; if (!job) return false;
      const id = job.id;
      const original = sources.find(item => item.key === job.sourceKey)?.calendarPayload || {};
      // New UI carries the displayed revision; older clients cannot silently overwrite automatic schedules.
      if (job.authorization && !Number.isSafeInteger(input.revision)) fail("calendar_refresh_required");
      changeJob(state, id, { ...input, revision: input.revision ?? job.revision }, clock());
      return { ok: true, postagem: { ...original, calendar_key: job.sourceKey, item_id: job.sourceKey.split(":").slice(1).join(":"),
        planning_id: job.planningId, planejamento_item_id: job.sourceKey.split(":").slice(1).join(":"), pedido_id: job.orderId,
        data: job.date, horario: job.time, tema: original.tema || job.title, legenda: job.caption,
        imagem_pronta: original.imagem_pronta || Boolean(job.asset),
        calendar_revision: job.revision, calendar_phase: job.phase, calendar_schedule_id: job.id } };
    });
  }
  async function tickOwner(owner) {
    active(owner); const ids = identity(owner, owner);
    // Calendar UI/explicit consent initializes this row after normal tenant readiness.
    // The worker must not create social data for every historical product account.
    if (!await store.exists(ids.companyId)) return;
    await sync(owner, ids.companyId, ids.userId);
    const jobs = await store.update(ids.companyId, state => Object.values(state.jobs).filter(job => job.authorization && !["cancelled", "published", "failed"].includes(job.phase)));
    for (const snapshot of jobs) {
      if (stopped) return;
      let grant, ctx;
      try { ({ grant, context: ctx } = delegated(owner, snapshot.authorization.envelope)); }
      catch { continue; }
      if (snapshot.intent) {
        // Recovery observes the same intent only. It never calls send again, even if there is no provider response.
        const result = publisher.observe ? await publisher.observe(ctx, snapshot) : await publisher.status(ctx, snapshot.intent.publicationId);
        await store.update(ids.companyId, state => { const job = state.jobs[snapshot.id];
          if (job.intent?.publicationId === snapshot.intent.publicationId && result?.published) {
            job.phase = "published"; job.publication = result; job.revision++; job.error = null;
          } else if (result?.state?.startsWith("failed_")) { job.phase = "failed"; job.error = "calendar_provider_failed"; job.revision++; }
          else if (job.phase === "dispatching") { job.phase = "confirming"; job.error = "calendar_result_unconfirmed"; }
          return null;
        });
        continue;
      }
      const connection = await publisher.connection(ctx);
      if (!publisher.allowed(ctx) || !sameBinding(grant.binding, connection?.binding) || !snapshot.asset || snapshot.scheduledAt > clock()) continue;
      let intact = false;
      try { intact = await media.unchanged(owner, snapshot); if (intact) media.bytesFor(ids.companyId, snapshot.asset); } catch { intact = false; }
      if (!intact) {
        await store.update(ids.companyId, state => { const job = state.jobs[snapshot.id];
          if (!LOCKED.has(job.phase)) { job.phase = "attention"; job.error = "calendar_art_changed"; job.authorization = null; job.revision++; }
          return null;
        }); continue;
      }
      const selected = await store.update(ids.companyId, state => {
        const job = state.jobs[snapshot.id];
        if (job.revision !== snapshot.revision || availability(job, state.preferences, connection.binding, publisher.allowed(ctx), clock()) !== "scheduled") return null;
        job.intent = publisher.intent(ctx, job, crypto.randomUUID());
        job.phase = "dispatching"; job.revision++; job.dispatchAt = clock();
        return job;
      });
      if (!selected) continue;
      let result = null;
      try { result = await publisher.send(ctx, selected); }
      catch { try { result = await publisher.status(ctx, selected.intent.publicationId); } catch { /* Remains uncertain. */ } }
      await store.update(ids.companyId, state => {
        const job = state.jobs[selected.id];
        if (job.intent?.publicationId === selected.intent.publicationId) {
          const failed = result?.state?.startsWith("failed_");
          job.phase = result?.published ? "published" : failed ? "failed" : "confirming"; job.publication = result;
          job.error = result?.published ? null : failed ? "calendar_provider_failed" : "calendar_result_unconfirmed"; job.revision++;
        } return null;
      });
      break; // Bound provider traffic per owner per tick.
    }
  }
  async function tick() {
    if (running || stopped) return; running = true;
    try {
      for (const owner of Object.keys(readClients())) {
        if (stopped) break;
        try { await tickOwner(owner); } catch { /* No credentials/customer data in background logs. UI retains persisted state. */ }
      }
    } finally { running = false; }
  }
  return Object.freeze({ list, preferences, prepareRequest, edit, image, overlay, legacyEdit, tick,
    publicBytes: media.publicBytes,
    start() { if (!timer && !stopped) { timer = setInterval(() => { void tick(); }, 15000); timer.unref?.(); } },
    async close() { stopped = true; clearInterval(timer); while (running) await new Promise(resolve => setTimeout(resolve, 25)); media.close(); grants.close(); }
  });
}
module.exports = { createCalendarService, LABELS };
