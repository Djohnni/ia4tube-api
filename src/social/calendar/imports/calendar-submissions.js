"use strict";
const crypto = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { UUID, idFor, dateTime, caption, sameBinding, TIME_ZONE, MAX_ITEMS } = require("../model");
const { selection } = require("./policy");
const { schedulePreparedImport } = require("./calendar-entry");
const { descriptor } = require("./preview-service");
const { preparedPublicationDescriptor } = require("./publication-descriptor");
const { withLocalPublicationState, isLocalPublicationTransport } = require("./publication-test-transport");
const KEY = /^[A-Za-z0-9_-]{8,128}$/, ID = /^[a-f0-9]{40}$/, HASH = /^[a-f0-9]{64}$/;
const services = new WeakSet(), activeStates = new Set(["accepted", "preparing"]);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const keyHash = value => crypto.createHash("sha256").update(value).digest("hex");
const idForRequest = (context, assetId, key) => idFor(context.companyId, `upload:${assetId}:${keyHash(context.userId + ":" + key)}`);
function fail(code, statusCode = 409) { throw Object.assign(new Error(`calendar_import_submission_${code}`), { code: `calendar_import_submission_${code}`, statusCode }); }
function requestedSchedule(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["date", "time", "timeZone"].includes(key)) ||
      typeof value.date !== "string" || typeof value.time !== "string" || value.timeZone !== undefined && value.timeZone !== TIME_ZONE) fail("schedule_invalid", 400);
  try { dateTime(value.date, value.time); } catch { fail("schedule_invalid", 400); }
  return { date: value.date, time: value.time, timeZone: TIME_ZONE };
}
function requestedSlot(state, schedule, now, exceptId) {
  const scheduledAt = dateTime(schedule.date, schedule.time);
  if (scheduledAt <= now || scheduledAt > now + 180 * 86400000) fail("time_outside_window", 400);
  if (Object.values(state.jobs).some(job => job.id !== exceptId && job.phase !== "cancelled" && job.scheduledAt === scheduledAt) ||
      Object.values(state.importSubmissions || {}).some(row => row.id !== exceptId && activeStates.has(row.state) && row.scheduledAt === scheduledAt)) fail("time_occupied");
  return { date: schedule.date, time: schedule.time, scheduledAt };
}
function validateCalendarSubmissions(state) {
  if (state.importSubmissions === undefined) return;
  if (!state.importSubmissions || Array.isArray(state.importSubmissions) || Object.keys(state.importSubmissions).length > MAX_ITEMS) fail("state_invalid", 503);
  for (const [id, row] of Object.entries(state.importSubmissions)) {
    if (!row || row.id !== id || !ID.test(id) || !UUID.test(row.companyId || "") || !UUID.test(row.userId || "") ||
        !UUID.test(row.request?.assetId || "") || !UUID.test(row.request?.uploadId || "") || !KEY.test(row.request?.idempotencyKey || "") ||
        !HASH.test(row.clientHash || "") || !HASH.test(row.requestHash || "") || row.requestHash !== hash(row.request) ||
        ![...activeStates, "scheduled", "attention", "cancelled"].includes(row.state) ||
        !Number.isSafeInteger(row.mediaRevision) || row.mediaRevision < 0 || typeof row.envelope !== "string" ||
        !Number.isSafeInteger(row.scheduledAt) || row.scheduledAt !== dateTime(row.date, row.time)) fail("state_invalid", 503);
    if (row.request.schedule !== undefined) {
      let schedule;
      try { schedule = requestedSchedule(row.request.schedule); } catch { fail("state_invalid", 503); }
      if (!schedule || !isDeepStrictEqual(schedule, row.request.schedule) || schedule.date !== row.date || schedule.time !== row.time) fail("state_invalid", 503);
    }
  }
}
function reserveSlot(state, now, exceptId, preferred = null) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date(now + 86400000)).filter(p => p.type !== "literal").map(p => [p.type, p.value]));
  let day = `${parts.year}-${parts.month}-${parts.day}`, time = "09:00";
  if (preferred && dateTime(preferred.date, preferred.time) > now) { day = preferred.date; time = preferred.time; }
  for (let offset = 0; offset < 180; offset++) {
    const date = new Date(Date.parse(day + "T12:00:00Z") + offset * 86400000).toISOString().slice(0, 10), at = dateTime(date, time);
    if (at <= now || at > now + 179 * 86400000) continue;
    if (Object.values(state.jobs).some(job => job.id !== exceptId && job.phase !== "cancelled" && job.scheduledAt === at) ||
        Object.values(state.importSubmissions || {}).some(row => row.id !== exceptId && activeStates.has(row.state) && row.scheduledAt === at)) continue;
    return { date, time, scheduledAt: at };
  }
  fail("calendar_full");
}
/** Durable user intent and calendar finalization. No codec, timer, provider send,
 * client principal fabrication or assertion of visual review belongs here. */
function createCalendarSubmissions({ store, uploadStore, preparation, grants, accessPolicy, resolveConnection,
  resolveSubmissionConnection, resolveDefaultCaption = null, catalog = null, localTransport = null, clock = Date.now }) {
  const local = isLocalPublicationTransport(localTransport);
  const authorize = context => accessPolicy.resolve(context);
  function receipt(row, state) {
    const job = state.jobs[row.id];
    return { id: row.id, assetId: row.request.assetId, uploadId: row.request.uploadId, idempotencyKey: row.request.idempotencyKey,
      state: job?.phase === "cancelled" ? "cancelled" : row.state, calendarItemId: job ? job.id : null,
      mediaRevision: row.mediaRevision, date: job?.date || row.date, time: job?.time || row.time,
      caption: job?.caption ?? row.request.caption, errorCode: row.errorCode || null,
      ...(job && job.phase !== "cancelled" ? { notice: { id: `calendar-ready-${job.id}`, kind: "calendar_media_ready",
        title: "Mídia no calendário", body: "Sua mídia está no calendário. Confira a programação; você pode excluir o item antes da publicação.", calendarItemId: job.id } } : {}) };
  }
  function owned(state, context, assetId, key) {
    const id = idForRequest(context, assetId, key), row = state.importSubmissions?.[id];
    if (!row || row.companyId !== context.companyId || row.userId !== context.userId || row.request.assetId !== assetId) fail("not_found", 404);
    return row;
  }
  async function request(context, input) {
    authorize(context);
    if (!input || Array.isArray(input) || Object.keys(input).some(k => !["assetId", "uploadId", "idempotencyKey", "expectedMediaRevision", "selection", "caption", "schedule"].includes(k)) ||
        !UUID.test(input.assetId || "") || !UUID.test(input.uploadId || "") || !KEY.test(input.idempotencyKey || "") ||
        !Number.isSafeInteger(input.expectedMediaRevision) || input.expectedMediaRevision < 0) fail("invalid", 400);
    const chosen = selection(input.selection), explicitCaption = input.caption === undefined ? null : caption(input.caption), schedule = requestedSchedule(input.schedule);
    // Keep the exact legacy hash for absent/null schedules, so old durable
    // intentions still recover after this additive contract update.
    const clientHash = hash([input.assetId, input.uploadId, input.idempotencyKey, input.expectedMediaRevision, chosen, explicitCaption,
      ...(schedule ? [schedule] : [])]);
    const id = idForRequest(context, input.assetId, input.idempotencyKey);
    // Recover first: a retry never needs a live phone session's old preparation
    // revision and never changes a later edit, pause, cancellation or notice.
    const prior = await store.update(context.companyId, state => {
      const row = state.importSubmissions?.[id]; if (!row) return null;
      if (row.userId !== context.userId || row.clientHash !== clientHash) fail("idempotency_conflict");
      return receipt(row, state);
    });
    if (prior) return prior;
    const upload = await uploadStore.update(context.companyId, state => state.uploads[input.uploadId]);
    if (!upload || upload.companyId !== context.companyId || upload.userId !== context.userId || upload.assetId !== input.assetId ||
        !["uploaded", "verifying"].includes(upload.state)) fail("source_not_ready");
    const status = await preparation.status(context, { assetId: input.assetId });
    if ((status.currentRevision || status.mediaRevision || 0) !== input.expectedMediaRevision) fail("revision_conflict");
    const reuse = status.mediaRevision > 0 && status.state !== "attention" && isDeepStrictEqual(selection(status.selection), chosen);
    const connection = await resolveConnection(context); authorize(context);
    return store.update(context.companyId, state => {
      authorize(context); state.importSubmissions ||= {};
      if (state.importSubmissions[id]) {
        const row = state.importSubmissions[id]; if (row.userId !== context.userId || row.clientHash !== clientHash) fail("idempotency_conflict");
        return receipt(row, state);
      }
      if (state.jobs[id]) fail("idempotency_conflict");
      if (Object.keys(state.importSubmissions).length >= MAX_ITEMS || Object.keys(state.jobs).length + Object.values(state.importSubmissions).filter(r => activeStates.has(r.state)).length >= MAX_ITEMS) fail("capacity_reached");
      const origin = state.importedSources?.origins?.[input.assetId], original = origin ? state.jobs[origin.calendarItemId] : null;
      // Resolve only once under the same owner transaction as acceptance. Retries
      // recover above; a later profile change never rewrites a signed intention.
      let submissionCaption = explicitCaption ?? original?.caption;
      if (submissionCaption === undefined || submissionCaption === null) {
        if (typeof resolveDefaultCaption !== "function") fail("caption_owner_unavailable", 503);
        submissionCaption = caption(resolveDefaultCaption(context));
        if (!submissionCaption) fail("caption_owner_unavailable", 503);
      }
      const recordInput = { assetId: input.assetId, uploadId: input.uploadId, idempotencyKey: input.idempotencyKey,
        expectedMediaRevision: input.expectedMediaRevision, selection: chosen, caption: submissionCaption,
        sourceSha256: upload.sha256, reuseRevision: reuse ? status.mediaRevision : null, ...(schedule ? { schedule } : {}) };
      const slot = schedule ? requestedSlot(state, schedule, clock(), id) : reserveSlot(state, clock(), id, original);
      const requestHash = hash(recordInput), preferences = state.preferences;
      const automatic = preferences.enabled && sameBinding(preferences.binding, connection?.binding);
      const envelope = grants.issueSubmission({ ...context, submissionId: id, requestHash,
        ...(automatic ? { binding: connection.binding, revision: preferences.revision } : {}) });
      const row = { id, companyId: context.companyId, userId: context.userId, clientHash, requestHash, request: recordInput, envelope,
        ...slot, state: "accepted", revision: 1, mediaRevision: 0, errorCode: null, createdAt: clock(), updatedAt: clock() };
      state.importSubmissions[id] = row;
      return receipt(row, state);
    });
  }
  async function byKey(context, assetId, key) {
    authorize(context);
    if (!UUID.test(assetId || "") || !KEY.test(key || "")) fail("not_found", 404);
    return store.update(context.companyId, state => receipt(owned(state, context, assetId, key), state));
  }
  async function progress(companyId, { limit = 4 } = {}) {
    if (!UUID.test(companyId || "") || !Number.isSafeInteger(limit) || limit < 1 || limit > 10) fail("invalid", 400);
    const pending = await store.update(companyId, state => Object.values(state.importSubmissions || {}).filter(row => activeStates.has(row.state)).slice(0, limit));
    for (const row of pending) {
      const context = Object.freeze({ authenticated: true, companyId, userId: row.userId });
      try {
        authorize(context);
        const delegated = grants.verifySubmission(row.envelope, companyId, row.userId);
        if (!delegated || delegated.submissionId !== row.id || delegated.requestHash !== row.requestHash || row.requestHash !== hash(row.request)) fail("authority_changed");
        const input = row.request;
        // A chosen date is user intent, not a suggestion. Do not spend on new
        // preparation or move the publication to another day after it expires.
        if (input.schedule && dateTime(input.schedule.date, input.schedule.time) <= clock()) fail("time_outside_window", 400);
        const upload = await uploadStore.update(companyId, state => state.uploads[input.uploadId]);
        if (!upload || upload.assetId !== input.assetId || upload.userId !== row.userId || upload.sha256 !== input.sourceSha256) fail("source_changed");
        if (upload.state === "verifying") continue;
        if (upload.state !== "uploaded") fail("source_changed");
        let mediaRevision = input.reuseRevision;
        if (mediaRevision === null) {
          const prepared = await preparation.request(context, { assetId: input.assetId, uploadId: input.uploadId,
            idempotencyKey: `submission_${row.id}`, expectedMediaRevision: input.expectedMediaRevision, selection: input.selection });
          mediaRevision = prepared.mediaRevision;
        }
        await store.update(companyId, state => {
          const current = state.importSubmissions[row.id];
          if (activeStates.has(current.state)) { current.state = "preparing"; current.mediaRevision = mediaRevision; current.updatedAt = clock(); }
        });
        const status = await preparation.status(context, { assetId: input.assetId });
        if (status.currentRevision !== mediaRevision) fail("revision_conflict");
        if (status.state === "attention") fail("preparation_failed");
        if (!status.ready) continue;
        const snapshot = await preparation.snapshot(context, { assetId: input.assetId, mediaRevision });
        if (!isDeepStrictEqual(selection(snapshot.selection), selection(input.selection)) || snapshot.plan.sourceSha256 !== input.sourceSha256) fail("source_changed");
        const connection = delegated.binding ? await resolveSubmissionConnection(delegated) : null;
        authorize(context);
        await store.update(companyId, state => {
          authorize(context);
          const current = state.importSubmissions[row.id];
          if (!activeStates.has(current.state) || state.jobs[row.id]) return;
          if (current.requestHash !== delegated.requestHash || hash(current.request) !== delegated.requestHash) fail("authority_changed");
          if (input.schedule) Object.assign(current, requestedSlot(state, input.schedule, clock(), row.id));
          else if (current.scheduledAt <= clock() || Object.values(state.jobs).some(job => job.phase !== "cancelled" && job.scheduledAt === current.scheduledAt))
            Object.assign(current, reserveSlot(state, clock(), row.id, current));
          const automatic = Boolean(delegated.binding && state.preferences.enabled && state.preferences.revision === delegated.preferenceRevision &&
            sameBinding(state.preferences.binding, delegated.binding) && sameBinding(connection?.binding, delegated.binding));
          const scheduleInput = { assetId: input.assetId, mediaRevision, previewDigest: snapshot.result.previewDigest, idempotencyKey: input.idempotencyKey,
            date: current.date, time: current.time, caption: input.caption, automatic };
          const envelope = automatic ? grants.issueImport({ ...context, binding: delegated.binding, revision: delegated.preferenceRevision,
            assetId: input.assetId, assetRevision: mediaRevision, previewDigest: snapshot.result.previewDigest, jobId: row.id, validUntil: delegated.validUntil }) : null;
          const save = () => schedulePreparedImport(state, context, scheduleInput, snapshot, { now: clock(), accessPolicy, catalog,
            envelope, authorization: envelope ? grants.verify(envelope, companyId, row.userId) : null,
            connectionBinding: connection?.binding, localTransport, submissionGrant: delegated });
          if (local) withLocalPublicationState(state, localTransport, save); else save();
          const job = state.jobs[row.id], origin = state.importedSources?.origins?.[input.assetId];
          Object.assign(job.import, { idempotencyKey: input.idempotencyKey, localSimulation: local, operational: true,
            submissionId: row.id, originKind: origin ? "generated_art" : "upload", resultRef: snapshot.result.resultRef,
            preview: { assetId: input.assetId, mediaRevision, currentRevision: mediaRevision, previewDigest: snapshot.result.previewDigest,
              testOnly: snapshot.result.testOnly, variants: snapshot.plan.deliveries.map(item => descriptor(item.target, snapshot.result.variants[item.target])),
              thumbnail: snapshot.result.thumbnail ? descriptor("thumbnail", snapshot.result.thumbnail) : null } });
          if (origin) { job.import.originalCalendarItemId = origin.calendarItemId; job.title = "Arte com mídia preparada"; }
          for (const target of job.selectedTargets) preparedPublicationDescriptor(companyId, { ...job, target });
          current.state = "scheduled"; current.errorCode = null; current.mediaRevision = mediaRevision; current.updatedAt = clock();
        });
      } catch (error) {
        // Transient/uncertain writes keep the same durable key for the next tick.
        // A deterministic refusal is visible; it never creates replacement work.
        if (error?.statusCode === 503 || !error?.code || error.code === "import_preparation_not_ready") continue;
        await store.update(companyId, state => { const current = state.importSubmissions?.[row.id];
          if (current && activeStates.has(current.state) && !state.jobs[row.id]) {
            current.state = "attention"; current.errorCode = /^(calendar_import_|import_preparation_)[a-z_]+$/.test(error.code) ? error.code : "calendar_import_submission_failed"; current.updatedAt = clock();
          }
        });
      }
    }
    return { observed: pending.length };
  }
  const service = Object.freeze({ request, byKey, progress }); services.add(service); return service;
}
module.exports = { createCalendarSubmissions, isCalendarSubmissions: value => services.has(value), validateCalendarSubmissions, reserveSlot };
