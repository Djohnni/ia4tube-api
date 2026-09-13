"use strict";
const crypto = require("node:crypto"), { Readable } = require("node:stream");
const { idFor, changeJob, sameBinding, LATE_MS } = require("../model");
const { targets } = require("../destinations");
const { createCalendarGrants } = require("../grants");
const { schedulePreparedImport } = require("./calendar-entry");
const { previewDigest } = require("./policy");
const { descriptor, parsePreviewRange } = require("./preview-service");
const { isImportAccessPolicy } = require("./access-policy");
const { isPreparedDiskResultStore } = require("./prepared-disk-store");
const { isLocalCalendarSimulation, isLocalCalendarState } = require("./local-calendar-simulation");
const { isCalendarStore } = require("../store");
const { isLocalPublicationTransport, withLocalPublicationState } = require("./publication-test-transport");
const { preparedPublicationDescriptor, validatePreparedPublicationPart } = require("./publication-descriptor");
const operationalServices = new WeakSet();
const services = new WeakSet(), ID = /^[a-f0-9]{40}$/, UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const KEY = /^[A-Za-z0-9_-]{8,128}$/, ORIGIN = "https://ia4tube-api.onrender.com/v1/social/calendar/imports";
const hash = (bytes, algorithm = "sha256", encoding = "hex") => crypto.createHash(algorithm).update(bytes).digest(encoding);
function fail(code, statusCode = 409) { throw Object.assign(new Error(`calendar_import_${code}`), { code: `calendar_import_${code}`, statusCode }); }
function scheduleId(context, assetId, key) { return idFor(context.companyId, `upload:${assetId}:${hash(context.userId + ":" + key)}`); }

/** Both compositions use the same calendar mutation engine. The operational
 * wrapper requires its genuine PostgreSQL store; local simulation is a separate
 * explicitly branded opt-in, never the production publisher's fallback.
 */
function createCalendarImportService({ simulation, preparation, resultStore, accessPolicy, resolveConnection,
  catalog = null, upload, provider, uploadStore, resolveGeneratedArt, clock = Date.now, enabled = false,
  store: operationalStore, grants: operationalGrants, localTransport = null } = {}, operational = false) {
  const local = !operational || isLocalPublicationTransport(localTransport);
  if (enabled !== true || (operational ? !isCalendarStore(operationalStore) || !operationalGrants ||
        typeof operationalGrants.issueImport !== "function" || typeof operationalGrants.verify !== "function" : !isLocalCalendarSimulation(simulation)) ||
      !isImportAccessPolicy(accessPolicy) ||
      !isPreparedDiskResultStore(resultStore, { allowVolatileForTests: local }) || typeof preparation?.snapshot !== "function" ||
      typeof resolveConnection !== "function" || typeof clock !== "function") fail("local_configuration_invalid", 503);
  const store = operational ? operationalStore : simulation.store;
  const grants = operational ? operationalGrants : createCalendarGrants(crypto.randomBytes(32), clock);
  const origins = new Map(), sourceRequests = new Map();
  function sourceState(state) { state.importedSources ||= { requests: {}, origins: {} }; return state.importedSources; }
  const readOrigin = (context, assetId) => operational ? store.update(context.companyId, state => sourceState(state).origins[assetId])
    : origins.get(`${context.companyId}:${context.userId}:${assetId}`);
  const readRequest = (context, key, sourceKey) => operational ? store.update(context.companyId, state => sourceState(state).requests[key]) : sourceRequests.get(sourceKey);
  async function saveRequest(context, key, sourceKey, value) {
    if (!operational) { sourceRequests.set(sourceKey, value); return; }
    await store.update(context.companyId, state => {
      const records = sourceState(state).requests, previous = records[key];
      if (previous && (previous.identity !== value.identity || previous.binding && value.binding !== previous.binding)) fail("idempotency_conflict");
      if (!previous && Object.keys(records).length >= 1000) fail("source_capacity_reached");
      records[key] = { ...value, receipt: previous?.receipt || value.receipt }; return null;
    });
  }
  function scheduleMutation(state, action) { return operational && local ? withLocalPublicationState(state, localTransport, action) : action(); }
  function authorize(context) { try { return accessPolicy.resolve(context); } catch (_) { fail("not_found", 404); } }
  function owned(state, context, id) {
    const job = state.jobs[id];
    if (!ID.test(id || "") || !job || job.sourceKind !== "upload" || job.import?.userId !== context.userId ||
        (operational ? job.import?.operational !== true : job.import?.localSimulation !== true)) fail("not_found", 404);
    return job;
  }
  async function read(context, id) { authorize(context); const job = await store.update(context.companyId, state => owned(state, context, id)); authorize(context); return job; }
  function preview(job) {
    const value = job.import.preview;
    if (!value || value.assetId !== job.import.assetId || value.mediaRevision !== job.import.mediaRevision || value.previewDigest !== job.import.previewDigest) fail("preview_changed");
    const url = target => `${ORIGIN}/schedules/${job.id}/preview/${target}`;
    return { ...structuredClone(value), currentRevision: value.mediaRevision, sourceKind: job.import.originKind || "upload",
      shareToFeed: job.import.selection.shareToFeed === true,
      variants: value.variants.map(item => ({ ...item, url: url(item.target) })),
      thumbnail: value.thumbnail ? { ...value.thumbnail, url: url("thumbnail") } : null };
  }
  function status(job, prefs, connection) {
    if (job.phase === "cancelled") return "cancelled";
    if (["published", "partial", "confirming", "dispatching"].includes(job.phase)) return job.phase;
    if (job.phase === "failed") return "attention";
    if (job.automaticEnabled === false) return "item_paused";
    if (!job.authorization) return "manual";
    if (!prefs.enabled) return "paused";
    if (!sameBinding(job.authorization.binding, connection?.binding)) return "connection_required";
    if (job.authorization.validUntil <= clock() || job.scheduledAt + LATE_MS >= job.authorization.validUntil) return "attention";
    if (job.scheduledAt + LATE_MS < clock()) return "overdue";
    if (targets(job).includes("story") && connection?.accountType !== "business") return "attention";
    return job.error ? "attention" : "scheduled";
  }
  function receipt(job) {
    return { id: job.id, assetId: job.import.assetId, mediaRevision: job.import.mediaRevision,
      previewDigest: job.import.previewDigest, idempotencyKey: job.import.idempotencyKey, date: job.date, time: job.time,
      caption: job.caption, revision: job.revision, phase: job.phase, automaticEnabled: job.automaticEnabled,
      localSimulation: local, media: preview(job), selectedTargets: targets(job), destination: job.destination };
  }
  function editState(state, context, id, input, connection) {
    authorize(context);
    if (!operational && !isLocalCalendarState(state, simulation)) fail("local_configuration_invalid", 503);
    const job = owned(state, context, id);
    if (input.action === "automatic" && input.enabled === true) {
      if (!job.authorization || input.confirmed !== true || !state.preferences.enabled ||
          !sameBinding(job.authorization.binding, connection?.binding) || !sameBinding(state.preferences.binding, connection?.binding) ||
          job.authorization.validUntil <= clock()) fail("consent_changed");
    }
    if (input.action === "destination") fail("preview_changed");
    return changeJob(state, id, input, clock());
  }
  async function available(context, assetId) {
    authorize(context); if (!UUID.test(assetId || "")) fail("not_found", 404);
    const state = await preparation.status(context, { assetId });
    const connection = await resolveConnection(context); authorize(context);
    const prefs = await store.update(context.companyId, state => state.preferences);
    authorize(context);
    let ready = state.ready === true;
    if (ready && operational) {
      try {
        const snapshot = await preparation.snapshot(context, { assetId, mediaRevision: state.mediaRevision });
        authorize(context);
        if (!snapshot.ready || snapshot.result.testOnly && !local) fail("prepared_media_unavailable");
        const selected = snapshot.plan.deliveries.map(item => item.target);
        if (!selected.length) fail("prepared_media_unavailable");
        for (const item of snapshot.plan.deliveries) validatePreparedPublicationPart(item.target,
          { ...snapshot.result.variants[item.target], ...snapshot.result.objects[item.target], shareToFeed: item.shareToFeed }, selected);
      } catch { ready = false; }
    }
    const connected = Boolean(connection?.binding);
    const formatsAllowed = !state.selection?.targets?.includes("story") || connection?.accountType === "business";
    const authorized = Boolean(connected && formatsAllowed && prefs.enabled && sameBinding(prefs.binding, connection.binding));
    return { identity: { companyId: context.companyId, userId: context.userId }, assetId,
      mediaRevision: state.mediaRevision, previewDigest: state.previewDigest || null, ready, connected, authorized,
      automaticPreference: prefs.enabled, username: connection?.username || null, localSimulation: local,
      commercialReady: !local,
      blockedReason: !ready ? "calendar_import_prepared_media_unavailable" : !connected ? "calendar_connection_required" :
        !formatsAllowed ? "calendar_story_business_required" : !authorized ? "calendar_import_consent_changed" : null };
  }
  const service = Object.freeze({
    available: true, ready: true, store,
    capabilities: Object.freeze({ enabled: true, localSimulation: local, testOnly: local, networkDelivery: operational && !local, readyForProduction: false }),
    describe(job, context) { authorize(context); if (job.sourceKind !== "upload" || job.import?.userId !== context.userId) return null; return preview(job); },
    editState,
    status(job, prefs, connection) { return (operational ? job.import?.operational === true : job.import?.localSimulation === true) ? status(job, prefs, connection) : null; },
    availability: available,
    async schedule(context, input) {
      authorize(context);
      if (!UUID.test(input?.assetId || "") || !KEY.test(input?.idempotencyKey || "")) fail("schedule_invalid", 400);
      const connection = await resolveConnection(context); authorize(context);
      const snapshot = await preparation.snapshot(context, { assetId: input.assetId, mediaRevision: input.mediaRevision });
      const origin = await readOrigin(context, input.assetId);
      const job = await store.update(context.companyId, state => {
        authorize(context);
        const id = scheduleId(context, input.assetId, input.idempotencyKey), existing = state.jobs[id];
        let envelope = null, authorization = null;
        if (input.automatic && !existing) {
          if (!connection?.binding || !state.preferences.enabled || !sameBinding(state.preferences.binding, connection.binding) ||
              snapshot.plan.deliveries.some(item => item.target === "story") && connection.accountType !== "business") fail("consent_changed");
          envelope = grants.issueImport({ ...context, binding: connection.binding, revision: state.preferences.revision,
            assetId: input.assetId, assetRevision: input.mediaRevision, previewDigest: input.previewDigest, jobId: id });
          authorization = grants.verify(envelope, context.companyId, context.userId);
        }
        const result = scheduleMutation(state, () => schedulePreparedImport(state, context, input, snapshot, { now: clock(), accessPolicy, catalog,
          authorization, envelope, connectionBinding: connection?.binding, localSimulation: simulation, localTransport }));
        if (!existing) {
          const saved = state.jobs[result.id];
          saved.import.idempotencyKey = input.idempotencyKey; saved.import.localSimulation = local;
          if (operational) saved.import.operational = true;
          saved.import.originKind = origin ? "generated_art" : "upload";
          if (origin) { saved.import.originalCalendarItemId = origin.calendarItemId; saved.title = "Arte com mídia preparada"; }
          saved.import.resultRef = snapshot.result.resultRef;
          saved.import.preview = { assetId: input.assetId, mediaRevision: input.mediaRevision, currentRevision: input.mediaRevision,
            previewDigest: input.previewDigest, testOnly: snapshot.result.testOnly,
            variants: snapshot.plan.deliveries.map(item => descriptor(item.target, snapshot.result.variants[item.target])),
            thumbnail: snapshot.result.thumbnail ? descriptor("thumbnail", snapshot.result.thumbnail) : null };
          if (operational) for (const target of targets(saved)) preparedPublicationDescriptor(context.companyId, { ...saved, target });
          return saved;
        }
        return result;
      });
      return receipt(job);
    },
    async get(context, id) { return receipt(await read(context, id)); },
    async byKey(context, assetId, key) {
      if (!UUID.test(assetId || "") || !KEY.test(key || "")) fail("not_found", 404);
      return receipt(await read(context, scheduleId(context, assetId, key)));
    },
    async edit(context, id, input) {
      authorize(context); const connection = await resolveConnection(context); authorize(context);
      const job = await store.update(context.companyId, state => editState(state, context, id, input, connection)); return receipt(job);
    },
    async metadata(context, { id }) { const job = await read(context, id); if (job.phase === "cancelled") fail("not_found", 404); return preview(job); },
    async open(context, { id, target }, { rangeHeader, signal } = {}) {
      const job = await read(context, id), media = preview(job);
      if (job.phase === "cancelled") fail("not_found", 404);
      const expected = target === "thumbnail" ? media.thumbnail : media.variants.find(item => item.target === target);
      if (!expected) fail("not_found", 404);
      const snapshot = await preparation.snapshot(context, { assetId: media.assetId, mediaRevision: media.mediaRevision });
      if (!snapshot.ready || snapshot.result.resultRef !== job.import.resultRef || snapshot.result.previewDigest !== media.previewDigest ||
          previewDigest(snapshot.plan, snapshot.result.variants) !== media.previewDigest) fail("preview_changed");
      const binding = { context, assetId: media.assetId, mediaRevision: media.mediaRevision,
        resultRef: job.import.resultRef, target, sha256: expected.sha256 };
      const actual = await resultStore.inspectPreview({ ...binding, signal, timeoutMs: 60000 });
      authorize(context);
      if (actual.sha256 !== expected.sha256 || actual.mimeType !== expected.mimeType || actual.sizeBytes !== expected.sizeBytes) fail("preview_changed");
      const range = parsePreviewRange(rangeHeader, expected.sizeBytes);
      return { descriptor: expected, range, async stream(consume) {
        let count = 0;
        await resultStore.streamPreview({ ...binding, range: { start: range.start, end: range.end }, signal,
          consume: async bytes => {
            const current = await read(context, id);
            if (signal?.aborted || current.phase === "cancelled" || current.import.previewDigest !== media.previewDigest ||
                bytes.byteLength > 65536 || count + bytes.byteLength > range.length) fail("preview_changed");
            count += bytes.byteLength; await consume(bytes);
          } });
        if (count !== range.length) fail("preview_changed");
        return { sizeBytes: count };
      } };
    },
    async importGenerated(context, input) {
      authorize(context);
      if (!ID.test(input?.calendarItemId || "") || !Number.isSafeInteger(input.revision) || input.revision < 1 || !KEY.test(input.idempotencyKey || "") ||
          Object.keys(input).some(key => !["calendarItemId", "revision", "idempotencyKey"].includes(key))) fail("source_invalid", 400);
      if (typeof resolveGeneratedArt !== "function" || !upload || typeof provider?.acceptPart !== "function" || !uploadStore) fail("source_unavailable", 503);
      const key = `art_${hash([context.userId, input.idempotencyKey].join(":"))}`, sourceKey = `${context.companyId}:${context.userId}:${key}`;
      const identity = hash(JSON.stringify([input.calendarItemId, input.revision]));
      let request = await readRequest(context, key, sourceKey);
      if (request && request.identity !== identity) fail("idempotency_conflict");
      if (request?.receipt) {
        // The uploaded copy is its own immutable source. Losing the response and
        // then editing/cancelling the original must not orphan this receipt.
        const previous = request.receipt;
        const row = await uploadStore.update(context.companyId, state => state.uploads[previous.upload.uploadId]);
        authorize(context);
        if (!row || row.companyId !== context.companyId || row.userId !== context.userId || row.assetId !== previous.upload.assetId ||
            row.state !== "uploaded" || row.verified?.sha256 !== previous.source.sha256) fail("source_not_ready");
        return structuredClone(previous);
      }
      if (!request) {
        if (!operational && sourceRequests.size >= 1000) fail("source_capacity_reached");
        request = { identity, binding: null, receipt: null }; await saveRequest(context, key, sourceKey, request);
      }
      const source = await resolveGeneratedArt(context, input); authorize(context);
      if (!source || !Buffer.isBuffer(source.bytes) || source.bytes.length < 1 || source.bytes.length > 32 * 1024 ** 2 ||
          !["image/jpeg", "image/png", "image/webp"].includes(source.mimeType)) fail("source_invalid");
      const sha256 = hash(source.bytes);
      const sourceBinding = hash(JSON.stringify([input.calendarItemId, input.revision, source.mimeType, sha256]));
      if (request.binding && request.binding !== sourceBinding) fail("idempotency_conflict");
      // Record before any upload side effect. A lost initialization response does
      // not authorize reusing this key for another artwork, even identical bytes.
      request.binding = sourceBinding;
      await saveRequest(context, key, sourceKey, request);
      let value = await upload.start(context, { idempotencyKey: key, kind: "image", mimeType: source.mimeType, sizeBytes: source.bytes.length, sha256 });
      if (value.state !== "uploaded") {
        for (let offset = 0, number = 1; offset < source.bytes.length; offset += value.chunkBytes, number++) {
          authorize(context); const chunk = source.bytes.subarray(offset, offset + value.chunkBytes);
          const part = await upload.authorizePart(context, { uploadId: value.uploadId, partNumber: number, sha256: hash(chunk), md5Base64: hash(chunk, "md5", "base64") });
          const row = await uploadStore.update(context.companyId, state => state.uploads[value.uploadId]);
          if (!row || row.userId !== context.userId) fail("not_found", 404);
          await provider.acceptPart({ context, objectKey: row.objectKey, uploadId: row.disk.uploadId, partNumber: number,
            authorizationId: part.authorizationId, contentLength: chunk.length, stream: Readable.from([chunk]),
            assertWriteEligible: () => { authorize(context); return true; } });
        }
        value = await upload.complete(context, { uploadId: value.uploadId });
      }
      const actual = await uploadStore.update(context.companyId, state => state.uploads[value.uploadId]);
      authorize(context);
      if (value.state !== "uploaded" || actual?.verified?.sha256 !== sha256) fail("source_not_ready");
      const origin = { kind: "generated_art", calendarItemId: input.calendarItemId, revision: input.revision,
        sha256, width: actual.verified.width, height: actual.verified.height };
      if (operational) await store.update(context.companyId, state => { sourceState(state).origins[value.assetId] = origin; return null; });
      else origins.set(`${context.companyId}:${context.userId}:${value.assetId}`, origin);
      request.receipt = { upload: value, source: origin, identity: { companyId: context.companyId, userId: context.userId } };
      await saveRequest(context, key, sourceKey, request);
      return structuredClone(request.receipt);
    },
    close() { if (!operational) grants.close(); }
  });
  (operational ? operationalServices : services).add(service); return service;
}
function createLocalCalendarImportService(options) { return createCalendarImportService(options, false); }
function createOperationalCalendarImportService(options) { return createCalendarImportService(options, true); }
function isLocalCalendarImportService(value) { return Boolean(value && services.has(value)); }
function isOperationalCalendarImportService(value) { return operationalServices.has(value); }
function isCalendarImportService(value) { return services.has(value) || operationalServices.has(value); }
module.exports = { createLocalCalendarImportService, isLocalCalendarImportService, createOperationalCalendarImportService,
  isOperationalCalendarImportService, isCalendarImportService, scheduleId };
