"use strict";

const crypto = require("node:crypto");
const TIME_ZONE = "America/Sao_Paulo";
const MAX_ITEMS = 1000;
const LATE_MS = 10 * 60 * 1000;
const LOCKED = new Set(["dispatching", "confirming", "published", "failed"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function fail(code, status = 409) {
  const error = new Error("Não foi possível atualizar esta programação. Atualize e confira o estado atual.");
  error.code = code; error.statusCode = status; throw error;
}
function digest(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function consentPath(baseDir, owner, planningId) {
  return require("node:path").join(baseDir, "_calendar-consents", digest(owner), `${digest(planningId)}.json`);
}
function idFor(companyId, key) { return digest(`calendar-v1\n${companyId}\n${key}`).slice(0, 40); }
function caption(value) {
  if (typeof value !== "string" || value.length > 2200 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail("calendar_caption_invalid", 400);
  return value.trim();
}
function localParts(now) {
  return Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(now)).filter(p => p.type !== "literal").map(p => [p.type, p.value]));
}
function dateTime(date, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "") || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time || "")) fail("calendar_time_invalid", 400);
  const desired = Date.parse(`${date}T${time}:00Z`);
  if (!Number.isFinite(desired)) fail("calendar_time_invalid", 400);
  let result = desired;
  for (let i = 0; i < 3; i++) {
    const p = localParts(result);
    result += desired - Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00Z`);
  }
  const p = localParts(result);
  if (`${p.year}-${p.month}-${p.day}` !== date || `${p.hour}:${p.minute}` !== time || !Number.isFinite(result)) fail("calendar_time_invalid", 400);
  return result;
}
function freshState() { return { schema: 1, preferences: { enabled: false, revision: 1, binding: null }, jobs: {} }; }
function validBinding(binding) {
  return binding && UUID.test(binding.connectionId) && /^[0-9]{5,64}$/.test(binding.externalId || "") &&
    Number.isSafeInteger(binding.connectionRevision) && binding.connectionRevision > 0;
}
function sameBinding(a, b) { return Boolean(validBinding(a) && validBinding(b) &&
  a.connectionId === b.connectionId && a.externalId === b.externalId && a.connectionRevision === b.connectionRevision); }
function editable(job, revision) {
  if (!job || !Number.isSafeInteger(revision) || job.revision !== revision) fail("calendar_revision_conflict");
  if (LOCKED.has(job.phase) || job.intent) fail("calendar_dispatch_started");
  if (job.phase === "cancelled") fail("calendar_cancelled");
}
function changeJob(state, id, input, now) {
  const job = state.jobs[id];
  if (!job) fail("calendar_not_found", 404);
  editable(job, input.revision);
  if (input.action === "cancel") { job.phase = "cancelled"; job.cancelledAt = now; }
  else if (input.action === "caption") {
    job.caption = caption(input.caption); job.captionEdited = true;
    if (job.caption && job.error === "calendar_caption_invalid") { job.error = null; job.phase = job.asset ? "ready" : "waiting_media"; }
  }
  else if (input.action === "schedule") {
    const at = dateTime(input.date, input.time);
    if (at <= now || at > now + 180 * 86400000) fail("calendar_time_outside_window", 400);
    if (Object.values(state.jobs).some(other => other.id !== id && other.phase !== "cancelled" && other.scheduledAt === at)) fail("calendar_time_occupied");
    if (job.authorization && at + LATE_MS >= job.authorization.validUntil) fail("calendar_consent_expired", 400);
    job.date = input.date; job.time = input.time; job.scheduledAt = at; job.scheduleEdited = true;
    if (job.error === "calendar_overdue") { job.error = null; job.phase = job.asset ? "ready" : "waiting_media"; }
  } else fail("calendar_action_invalid", 400);
  job.revision++; job.updatedAt = now;
  return job;
}
function syncSources(state, sources, companyId, now) {
  const seen = new Set();
  for (const source of sources) {
    if (!source.key || !source.planningId || !source.orderId) continue;
    const id = idFor(companyId, source.key); seen.add(id);
    let job = state.jobs[id];
    if (!job) {
      if (Object.keys(state.jobs).length >= MAX_ITEMS) fail("calendar_capacity_reached");
      let scheduledAt;
      try { scheduledAt = dateTime(source.date, source.time); } catch { continue; }
      const issuedCount = Object.values(state.jobs).filter(other => other.grantNonce && other.grantNonce === source.authorization?.nonce).length;
      const authorization = source.authorization && issuedCount < source.authorization.quantity ? source.authorization : null;
      let initialCaption = "", initialError = null;
      try { initialCaption = caption(source.caption || ""); } catch { initialError = "calendar_caption_invalid"; }
      job = state.jobs[id] = { id, sourceKey: source.key, planningId: source.planningId, orderId: source.orderId,
        title: source.title || "Arte programada", date: source.date, time: source.time, scheduledAt,
        caption: initialCaption, error: initialError, revision: 1, phase: "waiting_media", asset: null,
        authorization, grantNonce: authorization?.nonce || null, sourceVersion: source.version, createdAt: now, updatedAt: now };
    }
    if (LOCKED.has(job.phase) || job.phase === "cancelled") continue;
    if (job.sourceVersion !== source.version) {
      // A replacement of an already prepared image must never publish under the old visual approval.
      if (job.asset) { job.phase = "attention"; job.error = "calendar_art_changed"; job.authorization = null; }
      job.asset = null; job.sourceVersion = source.version; job.revision++;
      if (job.error === "calendar_image_preparation_failed") job.error = null;
      if (!job.captionEdited) {
        try { job.caption = caption(source.caption || ""); if (job.error === "calendar_caption_invalid") job.error = null; }
        catch { job.caption = ""; job.error = job.error || "calendar_caption_invalid"; }
      }
    }
    if (!source.imageReady) { job.asset = null; job.phase = job.error ? "attention" : "waiting_media"; }
  }
  // Legacy hide/cancel operations cannot leave an invisible future dispatch behind.
  for (const job of Object.values(state.jobs)) if (!seen.has(job.id) && !LOCKED.has(job.phase) && job.phase !== "cancelled") {
    job.phase = "cancelled"; job.cancelledAt = now; job.revision++;
  }
}
function availability(job, preferences, binding, gatesOpen, now) {
  if (job.phase === "cancelled") return "cancelled";
  if (job.phase === "published") return "published";
  if (job.phase === "failed") return "attention";
  if (["dispatching", "confirming"].includes(job.phase)) return job.phase;
  if (!job.authorization) return job.error ? "attention" : "manual";
  if (job.authorization.validUntil <= now || job.scheduledAt + LATE_MS >= job.authorization.validUntil) return "attention";
  if (job.scheduledAt + LATE_MS < now) return "overdue";
  if (!preferences.enabled) return "paused";
  if (!sameBinding(job.authorization.binding, binding)) return "connection_required";
  if (!gatesOpen) return "operations_closed";
  if (!job.asset) return "waiting_media";
  if (!job.caption) return "attention";
  if (job.error) return "attention";
  return "scheduled";
}
module.exports = { TIME_ZONE, MAX_ITEMS, LATE_MS, LOCKED, UUID, fail, digest, idFor, caption, dateTime,
  freshState, sameBinding, validBinding, editable, changeJob, syncSources, availability, consentPath };
