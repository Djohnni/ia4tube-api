"use strict";

// Durable metadata orchestration for iA4tube. No ffmpeg, HTTP, Instagram client,
// scheduling or cloud provisioning is performed by this module. Remote dispatch
// and actual immutable-result inspection are trusted adapters, outside transactions.
const crypto = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { publicationPlan, previewDigest, selection, inspectedMedia } = require("./policy");
const { createImportAccessPolicy, isImportAccessPolicy } = require("./access-policy");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const ACTIVE = new Set(["queued", "dispatching", "processing", "reconciliation"]);
const IN_FLIGHT = new Set(["dispatching", "processing", "reconciliation"]);
const STATES = new Set([...ACTIVE, "ready", "attention"]);
const DEFAULT_LIMITS = Object.freeze({ monthlyPreparations: 60, maxJobRuntimeMs: 180000,
  acknowledgementLeaseMs: 30000, maxPendingJobs: 4, maxRecords: 1000,
  companyOutputBytes: 2 * 1024 * 1024 * 1024, jpegBytes: 8 * 1024 * 1024,
  videoBytes: 100 * 1024 * 1024 });
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const clone = value => structuredClone(value);
const obj = value => Boolean(value && typeof value === "object" && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value)));
function fail(code, statusCode = 400) {
  const error = new Error(`import_preparation_${code}`);
  error.code = error.message; error.statusCode = statusCode; throw error;
}
function fields(value, allowed) {
  if (!obj(value) || Object.keys(value).some(key => !allowed.includes(key))) fail("request_invalid");
}
function identity(context, worker = false) {
  if (!context || context.authenticated !== true || typeof context.companyId !== "string" || !UUID.test(context.companyId) ||
      (worker ? context.role !== "calendar_media_worker" : typeof context.userId !== "string" || !UUID.test(context.userId))) fail("owner_invalid", 403);
  return { companyId: context.companyId.toLowerCase(), ...(worker ? {} : { userId: context.userId.toLowerCase() }) };
}
function freshPreparationState() {
  return { schema: 1, jobs: {}, assets: {}, idempotency: {}, months: {}, reservedOutputBytes: 0, committedOutputBytes: 0 };
}

// Called by the durable store as well as by this consumer. Existing upload/outbox
// entries remain intact; only the additive state.preparation namespace is owned.
function validatePreparationState(preparation, companyId, uploads) {
  if (!obj(preparation) || preparation.schema !== 1 || !obj(preparation.jobs) || !obj(preparation.assets) ||
      !obj(preparation.idempotency) || !obj(preparation.months) ||
      !Number.isSafeInteger(preparation.reservedOutputBytes) || preparation.reservedOutputBytes < 0 ||
      !Number.isSafeInteger(preparation.committedOutputBytes) || preparation.committedOutputBytes < 0 ||
      Object.keys(preparation.jobs).length > DEFAULT_LIMITS.maxRecords ||
      Object.keys(preparation.assets).length > DEFAULT_LIMITS.maxRecords ||
      Object.keys(preparation.idempotency).length > DEFAULT_LIMITS.maxRecords ||
      Object.keys(preparation.months).length > DEFAULT_LIMITS.maxRecords) fail("state_invalid", 503);
  for (const [id, job] of Object.entries(preparation.jobs)) {
    const upload = uploads?.[job?.uploadId];
    if (!UUID.test(id) || !obj(job) || job.jobId !== id || job.companyId !== companyId || !UUID.test(job.userId || "") ||
        !upload || upload.companyId !== companyId || upload.userId !== job.userId || upload.assetId !== job.assetId ||
        !UUID.test(job.assetId || "") || !Number.isSafeInteger(job.mediaRevision) || job.mediaRevision < 1 ||
        !STATES.has(job.state) || !HASH.test(job.requestDigest || "") || !HASH.test(job.dispatchKey || "") ||
        !HASH.test(job.executionDigest || "") || !Number.isSafeInteger(job.fence) || job.fence < 0 ||
        !Number.isSafeInteger(job.runtimeBudgetMs) || job.runtimeBudgetMs < 1 || job.runtimeBudgetMs > DEFAULT_LIMITS.maxJobRuntimeMs ||
        !Number.isSafeInteger(job.reservedBytes) || job.reservedBytes < 1 || !/^\d{4}-\d{2}$/.test(job.quotaMonth || "") ||
        !Object.hasOwn(preparation.months, job.quotaMonth)) fail("state_invalid", 503);
    if (job.lease !== null && (!obj(job.lease) || !UUID.test(job.lease.token || "") ||
        job.lease.fence !== job.fence || !Number.isSafeInteger(job.lease.startedAt) ||
        !Number.isSafeInteger(job.lease.deadlineAt) || job.lease.deadlineAt <= job.lease.startedAt)) fail("state_invalid", 503);
    if (job.state === "ready" && (!obj(job.result) || !HASH.test(job.result.previewDigest || "") ||
        !obj(job.result.variants) || !obj(job.result.objects))) fail("state_invalid", 503);
  }
  for (const [id, asset] of Object.entries(preparation.assets)) {
    const upload = uploads?.[asset?.uploadId];
    if (!UUID.test(id) || !obj(asset) || asset.assetId !== id || asset.companyId !== companyId ||
        !upload || upload.assetId !== id || upload.userId !== asset.userId ||
        !Number.isSafeInteger(asset.currentRevision) || asset.currentRevision < 1 || !obj(asset.revisions) ||
        !Object.hasOwn(asset.revisions, String(asset.currentRevision))) fail("state_invalid", 503);
    for (const [revision, jobId] of Object.entries(asset.revisions)) {
      const job = preparation.jobs[jobId];
      if (!/^[1-9]\d{0,5}$/.test(revision) || !job || job.assetId !== id || job.userId !== asset.userId ||
          job.mediaRevision !== Number(revision)) fail("state_invalid", 503);
    }
  }
  for (const [key, jobId] of Object.entries(preparation.idempotency)) {
    if (!HASH.test(key) || !Object.hasOwn(preparation.jobs, jobId)) fail("state_invalid", 503);
  }
  for (const [month, quota] of Object.entries(preparation.months)) {
    if (!/^\d{4}-\d{2}$/.test(month) || !obj(quota) ||
        ["preparations", "reservedComputeMs", "usedComputeMs"].some(key => !Number.isSafeInteger(quota[key]) || quota[key] < 0)) fail("state_invalid", 503);
  }
  return preparation;
}

function uploadInspection(upload) {
  const verified = upload.verified;
  if (upload.state !== "uploaded" || !verified || !HASH.test(upload.sha256 || "") ||
      verified.sha256 !== upload.sha256 || verified.sizeBytes !== upload.sizeBytes ||
      !HASH.test(upload.objectKey || "") || !UUID.test(upload.objectVersion || "")) fail("upload_not_ready", 409);
  return inspectedMedia({ kind: upload.kind, format: {
    "image/jpeg": "jpeg", "image/png": "png", "image/webp": "webp", "video/mp4": "mp4", "video/quicktime": "mov"
  }[verified.mimeType], sha256: verified.sha256, size: verified.sizeBytes, decoded: true,
  width: verified.width, height: verified.height, frames: verified.frames,
  durationSeconds: verified.durationMs / 1000, hasAudio: verified.hasAudio, colorMode: verified.colorMode }, upload.kind);
}
function safeVariant(value) {
  return { sha256: value.sha256, sourceSha256: value.sourceSha256, mimeType: value.mimeType,
    width: value.width, height: value.height, size: value.size, durationSeconds: value.durationSeconds ?? null,
    audioMode: value.audioMode, hasAudio: value.hasAudio,
    ...(value.musicSha256 ? { musicSha256: value.musicSha256 } : {}) };
}
function publicStatus(asset, job) {
  if (!asset) return { mediaRevision: 0, state: "awaiting_selection", ready: false, previewDigest: null };
  return { assetId: asset.assetId, uploadId: asset.uploadId, mediaRevision: job.mediaRevision,
    currentRevision: asset.currentRevision, previousReadyRevision: asset.lastReadyRevision || null,
    jobId: job.jobId, state: job.state, ready: job.state === "ready", errorCode: job.errorCode || null,
    selection: clone(job.selection), testOnly: job.plan.testOnly === true,
    previewDigest: job.state === "ready" ? job.result.previewDigest : null,
    variants: job.state === "ready" ? clone(job.result.variants) : {},
    createdAt: job.createdAt, updatedAt: job.updatedAt };
}

/**
 * Enabled only with a trusted eligible pilot owner and a serializable durable
 * company store (or opt-in test doubles). request/status never dispatch work.
 * Dispatcher contract: idempotent dispatchKey + authoritative lookup + isolated
 * credential-free worker with a real total runtime bound <=180s, enforced outside
 * this JavaScript service. Retries never invent a new workflow key for a revision.
 * Result inspector must re-read immutable output versions and validate actual
 * bytes; signed URLs/client JSON are not inspection evidence.
 */
function createPreparationQueue(options = {}) {
  const { store, dispatcher, resultStore, catalog, enabled = false, allowVolatileForTests = false,
    allowSyntheticForTests = false, allowedOwners = [], accessPolicy = null, clock = Date.now } = options;
  const limits = Object.freeze({ ...DEFAULT_LIMITS, ...(options.limits || {}) });
  for (const [key, value] of Object.entries(limits)) {
    if (!(key in DEFAULT_LIMITS) || !Number.isSafeInteger(value) || value < 1 || value > DEFAULT_LIMITS[key]) fail("configuration_invalid", 503);
  }
  let access;
  try {
    if (accessPolicy !== null && (!isImportAccessPolicy(accessPolicy) || !Array.isArray(allowedOwners) || allowedOwners.length)) throw new Error();
    access = accessPolicy || createImportAccessPolicy({ allowedOwners });
  } catch (_) { fail("configuration_invalid", 503); }
  const volatile = store?.capabilities?.persistence === "volatile-test" || dispatcher?.capabilities?.testOnly === true || resultStore?.capabilities?.testOnly === true;
  const local = options.allowLocalForTests === true && allowVolatileForTests === true && store?.capabilities?.persistence === "volatile-test" &&
    require("./local-preparation-runner").isLocalPreparationRunner(dispatcher);
  const available = enabled && access.executionAvailable && store?.capabilities?.atomicCompanyUpdates === true &&
    (store?.capabilities?.persistence === "durable" || (volatile && allowVolatileForTests)) &&
    (!volatile || allowVolatileForTests) && typeof store?.update === "function" &&
    dispatcher?.capabilities?.idempotentDispatch === true && dispatcher?.capabilities?.authoritativeLookup === true &&
    (dispatcher?.capabilities?.isolatedWorker === true || local) && Number.isSafeInteger(dispatcher?.capabilities?.maxRuntimeMs) &&
    dispatcher.capabilities.maxRuntimeMs > 0 && dispatcher.capabilities.maxRuntimeMs <= limits.maxJobRuntimeMs &&
    ["dispatch", "getByKey"].every(name => typeof dispatcher[name] === "function") &&
    resultStore?.capabilities?.actualInspection === true && resultStore?.capabilities?.immutableObjects === true &&
    typeof resultStore?.inspectCommitted === "function";
  const localProcessSynthetic = allowSyntheticForTests === true &&
    require("./operational-preparation-runner").isOperationalPreparationRunner(dispatcher) &&
    dispatcher.capabilities.syntheticMediaForLocalTests === true;
  // Real local PostgreSQL/process evidence may use an explicitly synthetic
  // track. The resulting plan stays testOnly; this grants no commercial use.
  const testMode = allowSyntheticForTests && (volatile && allowVolatileForTests || localProcessSynthetic);
  function time() {
    const value = clock();
    if (!Number.isSafeInteger(value) || value < 0) fail("clock_invalid", 503);
    return value;
  }
  function authorize(context, worker = false) {
    if (!available) fail("unavailable", 503);
    const owner = identity(context, worker);
    try { access.resolve(context, { worker }); } catch (_) { fail("not_allowed", 403); }
    return owner;
  }
  function currentAudience(owner) {
    try { return access.resolve({ ...owner, authenticated: true }).audience; }
    catch (_) { fail("not_allowed", 403); }
  }
  async function safe(operation) {
    try { return await operation(); }
    catch (error) {
      if (typeof error.code === "string" && /^(?:import_preparation_|calendar_import_)[a-z_]+$/.test(error.code)) {
        // A provider may accidentally attach secrets or URLs to a familiar code.
        // Preserve only the machine code, not its message, cause or stack.
        const sanitized = new Error(error.code); sanitized.code = error.code;
        sanitized.statusCode = [400, 403, 404, 409, 422, 502, 503].includes(error.statusCode) ? error.statusCode : 503;
        throw sanitized;
      }
      fail("unavailable", 503);
    }
  }
  async function update(owner, operation) {
    return store.update(owner.companyId, state => {
      if (!obj(state) || state.schema !== 1 || !obj(state.uploads) || !obj(state.prepareOutbox)) fail("state_invalid", 503);
      if (!state.preparation) state.preparation = freshPreparationState();
      const prep = validatePreparationState(state.preparation, owner.companyId, state.uploads);
      const result = operation(state, prep);
      validatePreparationState(prep, owner.companyId, state.uploads);
      return result;
    });
  }
  function ownedUpload(state, owner, { assetId, uploadId }) {
    if (!UUID.test(assetId || "") || (uploadId != null && !UUID.test(uploadId))) fail("not_found", 404);
    const upload = uploadId ? state.uploads[uploadId] : Object.values(state.uploads).find(row => row.assetId === assetId);
    if (!upload || upload.assetId !== assetId || upload.companyId !== owner.companyId || upload.userId !== owner.userId) fail("not_found", 404);
    return upload;
  }
  function ownedJob(prep, owner, jobId) {
    const job = prep.jobs[jobId];
    if (!UUID.test(jobId || "") || !job || job.companyId !== owner.companyId || (owner.userId && job.userId !== owner.userId)) fail("not_found", 404);
    return job;
  }
  function monthKey(now) { return new Date(now).toISOString().slice(0, 7); }
  function monthQuota(prep, month) {
    if (!prep.months[month]) prep.months[month] = { preparations: 0, reservedComputeMs: 0, usedComputeMs: 0 };
    return prep.months[month];
  }
  function estimatedOutputBytes(plan) {
    const total = plan.deliveries.reduce((sum, part) => sum + (part.mediaType === "video" ? limits.videoBytes : limits.jpegBytes), 0);
    return total + (plan.deliveries.some(part => part.mediaType === "video") ? limits.jpegBytes : 0);
  }
  function settleCompute(prep, job, actualMs) {
    if (job.computeSettled) return;
    const quota = monthQuota(prep, job.quotaMonth);
    quota.reservedComputeMs -= job.runtimeBudgetMs;
    quota.usedComputeMs += actualMs;
    job.computeSettled = true;
  }
  function attention(prep, job, code) {
    job.state = "attention"; job.errorCode = `import_preparation_${code}`;
    job.updatedAt = time(); job.fence++; job.lease = null;
    // Uncertain/failed output reservations are NOT freed without reference-aware
    // cleanup proving that no retained output exists. Originals are untouched.
    settleCompute(prep, job, job.runtimeBudgetMs);
  }
  function claimJob(job) {
    const now = time();
    job.fence++;
    job.lease = { token: crypto.randomUUID(), fence: job.fence, startedAt: now,
      deadlineAt: now + job.runtimeBudgetMs, acknowledgeBy: now + Math.min(limits.acknowledgementLeaseMs, job.runtimeBudgetMs) };
    job.state = "dispatching"; job.updatedAt = now; job.errorCode = null;
    return clone(job);
  }
  function taskFor(job) {
    return Object.freeze({ schema: 1, jobId: job.jobId, companyId: job.companyId, userId: job.userId,
      assetId: job.assetId, mediaRevision: job.mediaRevision, uploadId: job.uploadId,
      dispatchKey: job.dispatchKey, executionDigest: job.executionDigest,
      fence: job.fence, leaseToken: job.lease.token, deadlineAt: job.lease.deadlineAt,
      maxRuntimeMs: job.runtimeBudgetMs, source: clone(job.source), selection: clone(job.selection),
      plan: clone(job.plan), reservedOutputBytes: job.reservedBytes });
  }
  function matches(job, leased) { return job.fence === leased.fence && job.lease?.token === leased.lease?.token; }
  function remoteValid(remote, job) {
    if (!obj(remote) || remote.dispatchKey !== job.dispatchKey || remote.executionDigest !== job.executionDigest ||
        !["not_found", "running", "succeeded", "failed"].includes(remote.state)) fail("dispatcher_invalid", 502);
    if (remote.state === "not_found") {
      if (remote.authoritative !== true) fail("dispatcher_unconfirmed", 502);
    } else if (!UUID.test(remote.executionId || "")) fail("dispatcher_invalid", 502);
    if (remote.state === "succeeded" && !UUID.test(remote.resultRef || "")) fail("dispatcher_invalid", 502);
    return remote;
  }
  async function rememberRemote(owner, leased, remote) {
    return update(owner, (_state, prep) => {
      const job = ownedJob(prep, owner, leased.jobId);
      if (!matches(job, leased)) return false;
      if (job.executionId && job.executionId !== remote.executionId) fail("execution_conflict", 409);
      job.executionId = remote.executionId; job.state = "processing"; job.errorCode = null; job.updatedAt = time();
      return true;
    });
  }
  async function markUncertain(owner, leased) {
    return update(owner, (_state, prep) => {
      const job = ownedJob(prep, owner, leased.jobId);
      if (matches(job, leased) && IN_FLIGHT.has(job.state)) {
        job.state = "reconciliation"; job.errorCode = "import_preparation_dispatch_unconfirmed"; job.updatedAt = time();
      }
      return publicStatus(prep.assets[job.assetId], job);
    });
  }
  function validateActualResult(actual, job) {
    if (!obj(actual) || actual.complete !== true || actual.immutable !== true || actual.actualInspection !== true ||
        actual.companyId !== job.companyId || actual.userId !== job.userId || actual.assetId !== job.assetId ||
        actual.mediaRevision !== job.mediaRevision || actual.dispatchKey !== job.dispatchKey ||
        actual.executionDigest !== job.executionDigest || !UUID.test(actual.resultRef || "") ||
        !Number.isSafeInteger(actual.finishedAt) || actual.finishedAt < job.lease.startedAt || actual.finishedAt > job.lease.deadlineAt || actual.finishedAt > time() ||
        !Number.isSafeInteger(actual.elapsedMs) || actual.elapsedMs < 0 || actual.elapsedMs > job.runtimeBudgetMs ||
        !obj(actual.prepared) || !obj(actual.objects)) fail("result_invalid", 422);
    const prepared = actual.prepared;
    const inspected = inspectedMedia(prepared.sourceInspection, job.selection.kind);
    if (inspected.sha256 !== job.source.sha256 || inspected.size !== job.source.sizeBytes ||
        inspected.width !== job.source.inspection.width || inspected.height !== job.source.inspection.height ||
        (job.selection.kind === "video" && (inspected.durationSeconds !== job.source.inspection.durationSeconds ||
          inspected.hasAudio !== job.source.inspection.hasAudio)) ||
        (job.plan.testOnly ? prepared.commercialReady !== false : prepared.commercialReady !== true)) fail("source_changed", 422);
    const fingerprint = previewDigest(job.plan, prepared.variants);
    if (Object.keys(actual.objects).length !== job.plan.deliveries.length) fail("result_invalid", 422);
    let size = 0;
    const objects = {}, variants = {};
    for (const delivery of job.plan.deliveries) {
      const part = prepared.variants[delivery.target];
      const ref = actual.objects[delivery.target];
      if (!obj(ref) || !HASH.test(ref.objectKey || "") || !UUID.test(ref.objectVersion || "") || ref.sha256 !== part.sha256 ||
          ref.companyId !== job.companyId || ref.assetId !== job.assetId || ref.mediaRevision !== job.mediaRevision ||
          !Number.isSafeInteger(part.size) || part.size < 1 || part.size > (part.mimeType === "video/mp4" ? limits.videoBytes : limits.jpegBytes) ||
          ref.sizeBytes !== part.size || typeof part.hasAudio !== "boolean" ||
          (delivery.audioMode === "music" && !part.hasAudio) ||
          (["none", "muted"].includes(delivery.audioMode) && part.hasAudio) ||
          (delivery.audioMode === "original" && part.hasAudio !== job.source.inspection.hasAudio)) fail("result_invalid", 422);
      variants[delivery.target] = safeVariant(part);
      objects[delivery.target] = { objectKey: ref.objectKey, objectVersion: ref.objectVersion, sha256: ref.sha256, sizeBytes: ref.sizeBytes };
      size += part.size;
    }
    let thumbnail = null;
    if (job.plan.deliveries.some(part => part.mediaType === "video")) {
      const part = prepared.thumbnail, ref = actual.thumbnailObject;
      if (!obj(part) || !obj(ref) || part.mimeType !== "image/jpeg" || part.sourceSha256 !== job.source.sha256 ||
          !HASH.test(part.sha256 || "") || part.width !== 1080 || part.height !== 1920 ||
          part.hasAudio !== false || part.audioMode !== "none" || part.durationSeconds != null ||
          !Number.isSafeInteger(part.size) || part.size < 1 || part.size > limits.jpegBytes ||
          !HASH.test(ref.objectKey || "") || !UUID.test(ref.objectVersion || "") || ref.sha256 !== part.sha256 ||
          ref.sizeBytes !== part.size || ref.companyId !== job.companyId || ref.assetId !== job.assetId || ref.mediaRevision !== job.mediaRevision) fail("result_invalid", 422);
      thumbnail = { ...safeVariant(part), objectKey: ref.objectKey, objectVersion: ref.objectVersion };
      size += part.size;
    }
    if (size > job.reservedBytes) fail("result_quota_exceeded", 422);
    return { resultRef: actual.resultRef, previewDigest: fingerprint, sourceInspection: { ...inspected, decoded: true,
      ...(job.selection.kind === "image" ? { frames: 1 } : { colorMode: "sdr" }) },
      variants, objects, thumbnail, sizeBytes: size, elapsedMs: actual.elapsedMs, finishedAt: actual.finishedAt,
      testOnly: job.plan.testOnly === true };
  }

  const queue = {
    async request(context, input) { return safe(async () => {
      const owner = authorize(context);
      fields(input, ["assetId", "uploadId", "idempotencyKey", "expectedMediaRevision", "selection"]);
      if (!UUID.test(input.assetId || "") || !UUID.test(input.uploadId || "") ||
          typeof input.idempotencyKey !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(input.idempotencyKey) ||
          !Number.isSafeInteger(input.expectedMediaRevision) || input.expectedMediaRevision < 0) fail("request_invalid");
      const chosen = selection(input.selection);
      const idempotency = sha(`${owner.userId}:${input.idempotencyKey}`);
      const requestDigest = sha(JSON.stringify([input.assetId, input.uploadId, input.expectedMediaRevision, chosen]));
      return update(owner, (state, prep) => {
        const upload = ownedUpload(state, owner, input);
        const existingId = prep.idempotency[idempotency];
        if (existingId) {
          const existing = ownedJob(prep, owner, existingId);
          if (existing.requestDigest !== requestDigest) fail("idempotency_conflict", 409);
          return publicStatus(prep.assets[existing.assetId], existing);
        }
        const prior = prep.assets[input.assetId];
        if ((prior?.currentRevision || 0) !== input.expectedMediaRevision) fail("revision_conflict", 409);
        const inspected = uploadInspection(upload);
        if (chosen.kind !== upload.kind) fail("kind_invalid");
        const outbox = state.prepareOutbox[`${upload.assetId}:1`];
        if (!outbox || outbox.uploadId !== upload.uploadId || outbox.companyId !== owner.companyId || outbox.userId !== owner.userId) fail("outbox_missing", 409);
        const now = time();
        const plan = publicationPlan(chosen, { ...inspected, decoded: true, frames: 1, colorMode: "sdr" },
          { catalog, companyId: owner.companyId, now, publishAt: now, audience: currentAudience(owner), testMode });
        const month = monthKey(now), quota = monthQuota(prep, month), reservedBytes = estimatedOutputBytes(plan);
        if (Object.keys(prep.jobs).length >= limits.maxRecords || quota.preparations >= limits.monthlyPreparations ||
            Object.values(prep.jobs).filter(job => ACTIVE.has(job.state)).length >= limits.maxPendingJobs ||
            prep.reservedOutputBytes + prep.committedOutputBytes + reservedBytes > limits.companyOutputBytes) fail("quota_exceeded", 409);
        const asset = prior || { assetId: upload.assetId, uploadId: upload.uploadId, ...owner,
          currentRevision: 0, lastReadyRevision: null, revisions: {} };
        const revision = asset.currentRevision + 1, jobId = crypto.randomUUID();
        const source = { objectKey: upload.objectKey, objectVersion: upload.objectVersion, sha256: upload.verified.sha256,
          sizeBytes: upload.verified.sizeBytes, inspection: inspected };
        const executionDigest = sha(JSON.stringify([owner, upload.assetId, revision, source, chosen, plan]));
        const job = { jobId, ...owner, assetId: upload.assetId, uploadId: upload.uploadId, mediaRevision: revision,
          selection: chosen, source, plan, executionDigest, requestDigest,
          dispatchKey: sha(`${owner.companyId}:${upload.assetId}:${revision}:${executionDigest}`),
          state: "queued", fence: 0, lease: null, createdAt: now, updatedAt: now, errorCode: null,
          quotaMonth: month, reservedBytes, runtimeBudgetMs: limits.maxJobRuntimeMs, computeSettled: false, result: null };
        prep.jobs[jobId] = job; prep.idempotency[idempotency] = jobId;
        asset.currentRevision = revision; asset.revisions[String(revision)] = jobId; prep.assets[asset.assetId] = asset;
        prep.reservedOutputBytes += reservedBytes; quota.preparations++; quota.reservedComputeMs += limits.maxJobRuntimeMs;
        // A completed upload alone has no implicit formatting or scheduling intent.
        outbox.state = "selection_recorded"; outbox.preparationJobId = jobId; outbox.mediaRevision = revision;
        return publicStatus(asset, job);
      });
    }); },
    async status(context, input) { return safe(async () => {
      const owner = authorize(context); fields(input, ["assetId"]);
      return update(owner, (state, prep) => {
        const upload = ownedUpload(state, owner, input), asset = prep.assets[input.assetId];
        if (!asset) return { ...publicStatus(null), assetId: upload.assetId, uploadId: upload.uploadId };
        return publicStatus(asset, ownedJob(prep, owner, asset.revisions[String(asset.currentRevision)]));
      });
    }); },
    // Trusted server-only snapshot for authenticated preview URL resolution. Never
    // serialize this directly to an HTTP client: it includes private object refs.
    async snapshot(context, input) { return safe(async () => {
      const owner = authorize(context); fields(input, ["assetId", "mediaRevision"]);
      return update(owner, (state, prep) => {
        ownedUpload(state, owner, input);
        const asset = prep.assets[input.assetId];
        if (!asset || !Number.isSafeInteger(input.mediaRevision) || input.mediaRevision < 1) fail("not_found", 404);
        const job = ownedJob(prep, owner, asset.revisions[String(input.mediaRevision)]);
        if (job.state !== "ready") fail("not_ready", 409);
        return { ...owner, assetId: asset.assetId, mediaRevision: job.mediaRevision, currentRevision: asset.currentRevision,
          state: "ready", ready: true, selection: clone(job.selection),
          plan: clone(job.plan), result: clone(job.result) };
      });
    }); },
    async dispatchNext(context) { return safe(async () => {
      const owner = authorize(context);
      const leased = await update(owner, (_state, prep) => {
        if (Object.values(prep.jobs).some(job => IN_FLIGHT.has(job.state))) return null;
        const job = Object.values(prep.jobs).filter(job => job.state === "queued" && job.userId === owner.userId)
          .sort((a, b) => a.createdAt - b.createdAt || a.mediaRevision - b.mediaRevision)[0];
        if (!job) return null;
        const month = monthKey(time());
        if (job.quotaMonth !== month) {
          const next = monthQuota(prep, month);
          if (next.preparations >= limits.monthlyPreparations) return null;
          monthQuota(prep, job.quotaMonth).reservedComputeMs -= job.runtimeBudgetMs;
          next.preparations++; next.reservedComputeMs += job.runtimeBudgetMs; job.quotaMonth = month;
        }
        return claimJob(job);
      });
      if (!leased) return { dispatched: false, reason: "empty_or_in_flight" };
      // Recheck after the asynchronous lease transaction and immediately before
      // dispatch: policy/catalog may have been revoked while waiting for the DB.
      try {
        const now = time();
        const currentPlan = publicationPlan(leased.selection,
          { ...leased.source.inspection, decoded: true, frames: 1, colorMode: "sdr" },
          { catalog, companyId: owner.companyId, now, publishAt: now, audience: currentAudience(owner), testMode });
        if (!isDeepStrictEqual(currentPlan, leased.plan)) fail("plan_changed", 409);
      } catch (_) {
        return update(owner, (_state, prep) => {
          const job = ownedJob(prep, owner, leased.jobId);
          if (matches(job, leased)) {
            settleCompute(prep, job, 0); attention(prep, job, "dispatch_not_allowed");
          }
          return publicStatus(prep.assets[job.assetId], job);
        });
      }
      try {
        const remote = remoteValid(await dispatcher.dispatch(taskFor(leased)), leased);
        if (remote.state === "not_found") fail("dispatcher_invalid", 502);
        await rememberRemote(owner, leased, remote);
        if (remote.state === "succeeded") return await queue.completeWorker({ authenticated: true, role: "calendar_media_worker", companyId: owner.companyId },
          { jobId: leased.jobId, fence: leased.fence, leaseToken: leased.lease.token, resultRef: remote.resultRef });
        if (remote.state === "failed") {
          return update(owner, (_state, prep) => {
            const job = ownedJob(prep, owner, leased.jobId);
            if (matches(job, leased)) attention(prep, job, "worker_failed");
            return publicStatus(prep.assets[job.assetId], job);
          });
        }
        return queue.status(context, { assetId: leased.assetId });
      } catch (_) { return markUncertain(owner, leased); }
    }); },
    async reconcile(context, input) { return safe(async () => {
      const owner = authorize(context); fields(input, ["assetId", "mediaRevision"]);
      const leased = await update(owner, (state, prep) => {
        ownedUpload(state, owner, input);
        const asset = prep.assets[input.assetId];
        if (!asset || !Number.isSafeInteger(input.mediaRevision)) fail("not_found", 404);
        const job = ownedJob(prep, owner, asset.revisions[String(input.mediaRevision)]);
        if (!IN_FLIGHT.has(job.state)) return null;
        if (job.reconcileLease?.expiresAt > time()) return null;
        job.reconcileLease = { token: crypto.randomUUID(), expiresAt: time() + limits.acknowledgementLeaseMs };
        return clone(job);
      });
      if (!leased) return queue.status(context, { assetId: input.assetId });
      try {
        const remote = remoteValid(await dispatcher.getByKey({ dispatchKey: leased.dispatchKey, executionDigest: leased.executionDigest }), leased);
        if (remote.state === "succeeded") {
          await rememberRemote(owner, leased, remote);
          return await queue.completeWorker({ authenticated: true, role: "calendar_media_worker", companyId: owner.companyId },
            { jobId: leased.jobId, fence: leased.fence, leaseToken: leased.lease.token, resultRef: remote.resultRef });
        }
        return await update(owner, (_state, prep) => {
          const job = ownedJob(prep, owner, leased.jobId);
          if (!matches(job, leased)) return publicStatus(prep.assets[job.assetId], job);
          if (remote.state === "not_found") {
            if (job.executionId) attention(prep, job, "execution_disappeared");
            else { job.fence++; job.lease = null; job.state = "queued"; job.errorCode = null; job.updatedAt = time(); }
          } else if (remote.state === "failed") attention(prep, job, "worker_failed");
          else if (job.lease.deadlineAt <= time()) attention(prep, job, "worker_deadline_exceeded");
          else {
            if (job.executionId && job.executionId !== remote.executionId) fail("execution_conflict", 409);
            job.executionId = remote.executionId; job.state = "processing"; job.errorCode = null; job.updatedAt = time();
          }
          return publicStatus(prep.assets[job.assetId], job);
        });
      } catch (_) { return markUncertain(owner, leased); }
      finally {
        await update(owner, (_state, prep) => {
          const job = ownedJob(prep, owner, leased.jobId);
          if (job.reconcileLease?.token === leased.reconcileLease.token) job.reconcileLease = null;
        });
      }
    }); },
    async completeWorker(context, input) { return safe(async () => {
      const worker = authorize(context, true);
      fields(input, ["jobId", "fence", "leaseToken", "resultRef"]);
      if (!UUID.test(input.jobId || "") || !UUID.test(input.leaseToken || "") || !UUID.test(input.resultRef || "") ||
          !Number.isSafeInteger(input.fence) || input.fence < 1) fail("request_invalid");
      const leased = await update(worker, (_state, prep) => {
        const job = ownedJob(prep, worker, input.jobId);
        if (job.state === "ready") {
          if (job.result.resultRef !== input.resultRef || job.completedFence !== input.fence || job.completedToken !== input.leaseToken) fail("stale_worker", 409);
          return { completed: true, status: publicStatus(prep.assets[job.assetId], job) };
        }
        if (!IN_FLIGHT.has(job.state) || job.fence !== input.fence || job.lease?.token !== input.leaseToken) fail("stale_worker", 409);
        return clone(job);
      });
      if (leased.completed) return leased.status;
      const actual = await resultStore.inspectCommitted({ companyId: worker.companyId, userId: leased.userId,
        assetId: leased.assetId, mediaRevision: leased.mediaRevision, resultRef: input.resultRef,
        dispatchKey: leased.dispatchKey, executionDigest: leased.executionDigest });
      if (actual?.resultRef !== input.resultRef) fail("result_invalid", 422);
      let verified;
      try { verified = validateActualResult(actual, leased); }
      catch (error) {
        // An authenticated worker cannot turn an invalid immutable object into
        // ready by resubmitting it. Bad callback fields were rejected above and
        // never reach this state transition. Transient inspector errors remain
        // recoverable because only completed inspection is validated here.
        await update(worker, (_state, prep) => {
          const job = ownedJob(prep, worker, leased.jobId);
          if (matches(job, leased) && IN_FLIGHT.has(job.state)) attention(prep, job, "result_invalid");
        });
        throw error;
      }
      return update(worker, (_state, prep) => {
        const job = ownedJob(prep, worker, leased.jobId);
        if (job.state === "ready" && job.result.resultRef === input.resultRef && job.completedFence === input.fence && job.completedToken === input.leaseToken)
          return publicStatus(prep.assets[job.assetId], job);
        if (!matches(job, leased) || !IN_FLIGHT.has(job.state)) fail("stale_worker", 409);
        job.result = verified; job.state = "ready"; job.errorCode = null; job.updatedAt = time();
        job.completedFence = job.fence; job.completedToken = job.lease.token; job.lease = null;
        prep.reservedOutputBytes -= job.reservedBytes; prep.committedOutputBytes += verified.sizeBytes;
        settleCompute(prep, job, verified.elapsedMs);
        const asset = prep.assets[job.assetId];
        asset.lastReadyRevision = Math.max(asset.lastReadyRevision || 0, job.mediaRevision);
        return publicStatus(asset, job);
      });
    }); }
  };
  return Object.freeze(queue);
}

module.exports = { createPreparationQueue, freshPreparationState, validatePreparationState, DEFAULT_LIMITS };
