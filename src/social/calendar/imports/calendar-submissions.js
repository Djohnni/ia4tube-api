"use strict";
const crypto = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { UUID, idFor, dateTime, caption, sameBinding, TIME_ZONE, MAX_ITEMS } = require("../model");
const { selection } = require("./policy");
const { schedulePreparedImport } = require("./calendar-entry");
const { descriptor } = require("./preview-service");
const { preparedPublicationDescriptor } = require("./publication-descriptor");
const { withLocalPublicationState, isLocalPublicationTransport } = require("./publication-test-transport");
const { isPostgresConnectionFailure } = require("../../../persistence/postgres/errors");
const KEY = /^[A-Za-z0-9_-]{8,128}$/, ID = /^[a-f0-9]{40}$/, HASH = /^[a-f0-9]{64}$/;
const services = new WeakSet(), activeStates = new Set(["accepted", "preparing"]);
// Serialization/deadlock, lock/query timeouts and exhausted connections can all
// occur before or after an idempotent preparation request. None revokes intent.
const RETRYABLE_PG_CODES = new Set(["40001", "40P01", "55P03", "57014", "53300", "postgres_rollback_failed"]);
const DIAGNOSTIC_CODES = new Set([...RETRYABLE_PG_CODES, "25P03", "57P01", "57P02", "57P03",
  "08000", "08001", "08003", "08004", "08006", "08007", "08P01", "ECONNRESET", "ETIMEDOUT", "EPIPE",
  "42501", "23505", "23503", "23514", "media_retention_asset_retired", "media_retention_state_invalid",
  "media_retention_collector_only", "postgres_connection_failure", "temporary_unavailable", "deterministic_refusal", "unknown_failure"]);
const PROGRESS_STAGES = new Set(["authority", "upload_lookup", "preparation_request", "preparing_record",
  "upload_reconcile", "preparation_status", "prepared_snapshot", "connection", "finalize"]);
function progressDiagnostic(error, stage, at) {
  const code = DIAGNOSTIC_CODES.has(error?.code) ? error.code : isPostgresConnectionFailure(error)
    ? "postgres_connection_failure" : error?.statusCode === 503 ? "temporary_unavailable"
      : /^(calendar_import_|import_preparation_)[a-z_]+$/.test(error?.code || "") ? "deterministic_refusal" : "unknown_failure";
  const value = { stage, code, at };
  // Only literal allowlisted codes survive; messages, stack, query and payload
  // never become durable diagnostics, including an uncertain rollback's cause.
  for (let cause = error?.cause, depth = 0; cause && depth < 4; cause = cause.cause, depth++) {
    if (DIAGNOSTIC_CODES.has(cause.code)) { value.causeCode = cause.code; break; }
  }
  return value;
}
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
    if (row.progressDiagnostic !== undefined) {
      const value = row.progressDiagnostic;
      if (!value || Array.isArray(value) || Object.keys(value).some(key => !["stage", "code", "causeCode", "at"].includes(key)) ||
          !PROGRESS_STAGES.has(value.stage) || !DIAGNOSTIC_CODES.has(value.code) ||
          value.causeCode !== undefined && !DIAGNOSTIC_CODES.has(value.causeCode) ||
          !Number.isSafeInteger(value.at) || value.at < row.createdAt) fail("state_invalid", 503);
    }
    if (row.request.schedule !== undefined) {
      let schedule;
      try { schedule = requestedSchedule(row.request.schedule); } catch { fail("state_invalid", 503); }
      if (!schedule || !isDeepStrictEqual(schedule, row.request.schedule) || schedule.date !== row.date || schedule.time !== row.time) fail("state_invalid", 503);
    }
    if (row.request.awaitUpload !== undefined && (row.request.awaitUpload !== true || row.request.selection?.kind !== "video" ||
        row.request.expectedMediaRevision !== 0 || row.request.reuseRevision !== null || !HASH.test(row.request.sourceSha256 || ""))) fail("state_invalid", 503);
    if ((row.uploadNextCheckAt !== undefined || row.uploadCheckCount !== undefined) && (row.request.awaitUpload !== true || !Number.isSafeInteger(row.uploadNextCheckAt) ||
        row.uploadNextCheckAt < row.createdAt || !Number.isSafeInteger(row.uploadCheckCount) || row.uploadCheckCount < 1 ||
        row.uploadCheckCount > 1000000)) fail("state_invalid", 503);
    if (row.uploadCancellationSettledAt !== undefined && (row.state !== "cancelled" || row.request.awaitUpload !== true ||
        !Number.isSafeInteger(row.uploadCancellationSettledAt) || row.uploadCancellationSettledAt < row.createdAt)) fail("state_invalid", 503);
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
  resolveSubmissionConnection, resolveDefaultCaption = null, reconcilePendingUpload = null, cancelPendingUpload = null,
  catalog = null, localTransport = null, clock = Date.now }) {
  const local = isLocalPublicationTransport(localTransport);
  const authorize = context => accessPolicy.resolve(context);
  function receipt(row, state) {
    const job = state.jobs[row.id];
    return { id: row.id, assetId: row.request.assetId, uploadId: row.request.uploadId, idempotencyKey: row.request.idempotencyKey,
      state: job?.phase === "cancelled" ? "cancelled" : row.state, calendarItemId: job ? job.id : null,
      mediaRevision: row.mediaRevision, date: job?.date || row.date, time: job?.time || row.time,
      caption: job?.caption ?? row.request.caption, errorCode: row.errorCode || null,
      ...(row.request.awaitUpload === true ? { uploadPending: row.state === "accepted" && !job } : {}),
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
    if (!input || Array.isArray(input) || Object.keys(input).some(k => !["assetId", "uploadId", "idempotencyKey", "expectedMediaRevision", "selection", "caption", "schedule", "awaitUpload"].includes(k)) ||
        !UUID.test(input.assetId || "") || !UUID.test(input.uploadId || "") || !KEY.test(input.idempotencyKey || "") ||
        !Number.isSafeInteger(input.expectedMediaRevision) || input.expectedMediaRevision < 0 ||
        input.awaitUpload !== undefined && input.awaitUpload !== true) fail("invalid", 400);
    const chosen = selection(input.selection), explicitCaption = input.caption === undefined ? null : caption(input.caption), schedule = requestedSchedule(input.schedule);
    if (input.awaitUpload === true && (chosen.kind !== "video" || input.expectedMediaRevision !== 0)) fail("invalid", 400);
    // A host profile may support fewer transformations than the shared Android
    // contract. Reject those before accepting an irreversible calendar intent.
    if (typeof preparation.validateSelection === "function") await preparation.validateSelection(context, chosen);
    // Keep the exact legacy hash for absent/null schedules, so old durable
    // intentions still recover after this additive contract update.
    const clientHash = hash([input.assetId, input.uploadId, input.idempotencyKey, input.expectedMediaRevision, chosen, explicitCaption,
      ...(schedule ? [schedule] : []), ...(input.awaitUpload === true ? [{ awaitUpload: true }] : [])]);
    const id = idForRequest(context, input.assetId, input.idempotencyKey);
    // Recover first: a retry never needs a live phone session's old preparation
    // revision and never changes a later edit, pause, cancellation or notice.
    const prior = await store.update(context.companyId, state => {
      const row = state.importSubmissions?.[id]; if (!row) return null;
      if (row.userId !== context.userId || row.clientHash !== clientHash) fail("idempotency_conflict");
      return receipt(row, state);
    });
    if (prior) return prior;
    if (input.awaitUpload === true && typeof reconcilePendingUpload !== "function") fail("await_upload_unavailable", 503);
    const upload = await uploadStore.update(context.companyId, state => state.uploads[input.uploadId]);
    if (!upload || upload.companyId !== context.companyId || upload.userId !== context.userId || upload.assetId !== input.assetId ||
        !(input.awaitUpload === true ? ["uploading", "uploaded", "verifying"] : ["uploaded", "verifying"]).includes(upload.state)) fail("source_not_ready");
    if (input.awaitUpload === true && (upload.kind !== "video" || upload.mimeType !== "video/mp4" || upload.storageProvider !== "gcs" ||
        upload.uploadMode !== "single" || !HASH.test(upload.sha256 || ""))) fail("source_not_ready");
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
        sourceSha256: upload.sha256, reuseRevision: reuse ? status.mediaRevision : null, ...(schedule ? { schedule } : {}),
        ...(input.awaitUpload === true ? { awaitUpload: true } : {}) };
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
  async function claimUploadCheck(companyId, row, cancelling = false) {
    return store.update(companyId, state => {
      const current = state.importSubmissions[row.id];
      if (!current || (cancelling ? current.state !== "cancelled" || current.uploadCancellationSettledAt !== undefined
        : !activeStates.has(current.state)) || state.jobs[row.id] || current.uploadNextCheckAt > clock()) return false;
      current.uploadCheckCount = Math.min(1000000, (current.uploadCheckCount || 0) + 1);
      const delay = current.uploadCheckCount <= 30 ? 10000 : current.uploadCheckCount <= 40 ? 30000 : 60000;
      current.uploadNextCheckAt = clock() + delay;
      return true;
    });
  }
  async function progress(companyId, { limit = 4 } = {}) {
    if (!UUID.test(companyId || "") || !Number.isSafeInteger(limit) || limit < 1 || limit > 10) fail("invalid", 400);
    const pending = await store.update(companyId, state => Object.values(state.importSubmissions || {}).filter(row =>
      (activeStates.has(row.state) || row.state === "cancelled" && row.request.awaitUpload === true &&
        row.uploadCancellationSettledAt === undefined && typeof cancelPendingUpload === "function") &&
      !(["accepted", "cancelled"].includes(row.state) && row.request.awaitUpload === true && row.uploadNextCheckAt > clock())).slice(0, limit));
    for (const row of pending) {
      const context = Object.freeze({ authenticated: true, companyId, userId: row.userId });
      let stage = "authority";
      try {
        // Bound even failed cancellation-authority/source lookups. A damaged or
        // expired cancelled row must not monopolize every worker batch.
        if (row.state === "cancelled" && !await claimUploadCheck(companyId, row, true)) continue;
        authorize(context);
        const delegated = grants.verifySubmission(row.envelope, companyId, row.userId);
        if (!delegated || delegated.submissionId !== row.id || delegated.requestHash !== row.requestHash || row.requestHash !== hash(row.request)) fail("authority_changed");
        const input = row.request;
        // A chosen date is user intent, not a suggestion. Do not spend on new
        // preparation or move the publication to another day after it expires.
        if (row.state !== "cancelled" && input.schedule && dateTime(input.schedule.date, input.schedule.time) <= clock()) fail("time_outside_window", 400);
        stage = "upload_lookup";
        let upload = await uploadStore.update(companyId, state => state.uploads[input.uploadId]);
        const matchesUpload = value => value && value.companyId === companyId && value.assetId === input.assetId &&
          value.userId === row.userId && value.sha256 === input.sourceSha256;
        if (!matchesUpload(upload)) fail("source_changed");
        if (input.awaitUpload === true) {
          if (upload.kind !== "video" || upload.mimeType !== "video/mp4" || upload.storageProvider !== "gcs" || upload.uploadMode !== "single") fail("source_changed");
          if (row.state === "cancelled") {
            // Cancel only this new unfinished transfer through its existing
            // provider fence. Never delete an inspected/completed source.
            if (["uploading", "cancel_pending"].includes(upload.state)) {
              try { await cancelPendingUpload(context, { uploadId: input.uploadId }); }
              catch (error) { if (error.code !== "import_upload_not_cancellable") throw error; }
              upload = await uploadStore.update(companyId, state => state.uploads[input.uploadId]);
              if (!matchesUpload(upload)) fail("source_changed");
            }
            if (["cancelled", "uploaded", "verifying", "rejected"].includes(upload.state)) await store.update(companyId, state => {
              const current = state.importSubmissions[row.id];
              if (current?.state === "cancelled") current.uploadCancellationSettledAt = clock();
            });
            continue;
          }
          if (upload.state === "rejected") fail("source_rejected");
          if (upload.state === "uploading") {
            if (typeof reconcilePendingUpload !== "function") continue;
            // Claim the next bounded probe durably, before remote I/O. Restart,
            // concurrent ticks and an absent/partial object cannot cause a spin.
            const claimed = await claimUploadCheck(companyId, row);
            if (!claimed) continue;
            stage = "upload_reconcile";
            await reconcilePendingUpload(context, { uploadId: input.uploadId });
            upload = await uploadStore.update(companyId, state => state.uploads[input.uploadId]);
            if (!matchesUpload(upload)) fail("source_changed");
            if (upload.state === "uploading" || upload.state === "verifying") continue;
            if (upload.state === "rejected") fail("source_rejected");
          }
        }
        if (input.awaitUpload === true && ["cancelled", "cancel_pending"].includes(upload.state)) {
          await store.update(companyId, state => {
            const current = state.importSubmissions[row.id];
            if (current && activeStates.has(current.state) && !state.jobs[row.id]) {
              current.state = "cancelled"; current.updatedAt = clock(); current.cancelledAt = clock(); current.revision++;
            }
          });
          continue;
        }
        if (upload.state === "verifying") continue;
        if (upload.state !== "uploaded") fail("source_changed");
        let mediaRevision = input.reuseRevision;
        if (mediaRevision === null) {
          stage = "preparation_request";
          const prepared = await preparation.request(context, { assetId: input.assetId, uploadId: input.uploadId,
            idempotencyKey: `submission_${row.id}`, expectedMediaRevision: input.expectedMediaRevision, selection: input.selection });
          mediaRevision = prepared.mediaRevision;
        }
        stage = "preparing_record";
        await store.update(companyId, state => {
          const current = state.importSubmissions[row.id];
          if (activeStates.has(current.state)) { current.state = "preparing"; current.mediaRevision = mediaRevision; current.updatedAt = clock(); }
        });
        stage = "preparation_status";
        const status = await preparation.status(context, { assetId: input.assetId });
        if (status.currentRevision !== mediaRevision) fail("revision_conflict");
        if (status.state === "attention") fail("preparation_failed");
        if (!status.ready) continue;
        stage = "prepared_snapshot";
        const snapshot = await preparation.snapshot(context, { assetId: input.assetId, mediaRevision });
        if (!isDeepStrictEqual(selection(snapshot.selection), selection(input.selection)) || snapshot.plan.sourceSha256 !== input.sourceSha256) fail("source_changed");
        stage = "connection";
        const connection = delegated.binding ? await resolveSubmissionConnection(delegated) : null;
        authorize(context);
        stage = "finalize";
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
        const transient = error?.statusCode === 503 || !error?.code || error.code === "import_preparation_not_ready" ||
          RETRYABLE_PG_CODES.has(error.code) || isPostgresConnectionFailure(error);
        const diagnostic = progressDiagnostic(error, stage, clock());
        try {
          await store.update(companyId, state => { const current = state.importSubmissions?.[row.id];
            if (current?.state === "cancelled" && current.request.awaitUpload === true && !state.jobs[row.id]) {
              current.progressDiagnostic = diagnostic;
              // No valid authority/source: stop this cleanup safely, retaining
              // any bytes. This cannot resurrect or authorize the cancelled job.
              if (!transient) current.uploadCancellationSettledAt = diagnostic.at;
            }
            if (current && activeStates.has(current.state) && !state.jobs[row.id]) {
              current.progressDiagnostic = diagnostic;
              if (!transient) {
                current.state = "attention"; current.errorCode = /^(calendar_import_|import_preparation_)[a-z_]+$/.test(error.code) ? error.code : "calendar_import_submission_failed"; current.updatedAt = diagnostic.at;
              }
            }
          });
        } catch (diagnosticError) {
          // A database outage may also prevent recording its diagnostic. Leave
          // the same durable intent untouched for the next tick in that case.
          if (!transient) throw diagnosticError;
        }
      }
    }
    return { observed: pending.length };
  }
  const service = Object.freeze({ request, byKey, progress }); services.add(service); return service;
}
module.exports = { createCalendarSubmissions, isCalendarSubmissions: value => services.has(value), validateCalendarSubmissions, reserveSlot };
