"use strict";

// Durable, metadata-only dispatch. This is NOT a Render API implementation.
// An approved external runner must supply idempotent dispatch and lookup, enforce
// isolation/runtime/concurrency, and store real worker results durably.
const crypto = require("node:crypto");
const { inspectedMedia } = require("./policy");
const { createImportAccessPolicy, isImportAccessPolicy } = require("./access-policy");
const { isLocalDiskInspectionRunner } = require("./local-disk-inspection-runner");
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[0-9a-f]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const STATES = new Set(["dispatching", "processing", "reconciliation", "attention", "ready", "failed"]);
const LIMITS = Object.freeze({ monthlyInspections: 60, runtimeMs: 180000, acknowledgementMs: 10000,
  lookupIntervalMs: 1000, maxMonths: 1000 });
const clone = value => structuredClone(value);
const localDispatchers = new WeakSet();
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
function object(value) { return Boolean(value && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))); }
function fail(code, statusCode = 503) { const error = new Error(`import_inspection_${code}`); error.code = error.message; error.statusCode = statusCode; throw error; }
function identity(context) {
  if (context?.authenticated !== true || typeof context.companyId !== "string" || !UUID.test(context.companyId) ||
      typeof context.userId !== "string" || !UUID.test(context.userId)) fail("owner_invalid", 403);
  return { companyId: context.companyId, userId: context.userId };
}
function source(upload) {
  if (upload.disk && upload.r2) fail("state_invalid");
  return upload.disk ? { type: "render_disk", value: upload.disk } : { type: "r2", value: upload.r2 };
}
function ticketFor(upload, create = false) {
  const storage = source(upload);
  if (create && storage.type === "render_disk" && !storage.value.inspectionTicket) {
    storage.value.inspectionTicket = { ticketId: storage.value.objectVersion };
  }
  return storage.value?.inspectionTicket;
}
function validateInspectionDispatchState(state, companyId) {
  const quota = state.inspectionQuota;
  if (quota === undefined) {
    if (Object.values(state.uploads || {}).some(upload => upload.r2?.inspectionTicket?.dispatch !== undefined || upload.disk?.inspectionTicket?.dispatch !== undefined)) fail("state_invalid");
    return state;
  }
  if (!object(quota) || quota.schema !== 1 || !object(quota.months) || Object.keys(quota.months).length > LIMITS.maxMonths) fail("state_invalid");
  const counts = {};
  for (const upload of Object.values(state.uploads || {})) {
    const storage = source(upload), ticket = ticketFor(upload), job = ticket?.dispatch;
    if (!job) continue;
    if (upload.companyId !== companyId || !UUID.test(ticket.ticketId || "") || ticket.ticketId !== storage.value.objectVersion ||
        !object(job) || !STATES.has(job.state) || !HASH.test(job.requestDigest || "") || !HASH.test(job.dispatchKey || "") ||
        !UUID.test(job.fenceToken || "") || job.runtimeMs !== LIMITS.runtimeMs ||
        !/^\d{4}-\d{2}$/.test(job.quotaMonth || "") || !Object.hasOwn(quota.months, job.quotaMonth) ||
        !Number.isSafeInteger(job.startedAt) || !Number.isSafeInteger(job.deadlineAt) || job.deadlineAt - job.startedAt !== job.runtimeMs ||
        typeof job.computeSettled !== "boolean") fail("state_invalid");
    counts[job.quotaMonth] = (counts[job.quotaMonth] || 0) + 1;
  }
  for (const [month, bucket] of Object.entries(quota.months)) {
    if (!/^\d{4}-\d{2}$/.test(month) || !object(bucket) || ["starts", "reservedComputeMs", "chargedComputeMs"].some(key =>
      !Number.isSafeInteger(bucket[key]) || bucket[key] < 0) || bucket.starts > LIMITS.monthlyInspections ||
      bucket.starts !== (counts[month] || 0) || bucket.reservedComputeMs + bucket.chargedComputeMs > bucket.starts * LIMITS.runtimeMs) fail("state_invalid");
  }
  return state;
}
function createDurableInspectionDispatcher({ store, runner, allowedOwners = [], accessPolicy = null, enabled = false,
  allowVolatileForTests = false, allowLocalForTests = false, clock = Date.now, limits: overrides = {} } = {}) {
  const limits = Object.freeze({ ...LIMITS, ...overrides });
  for (const [key, value] of Object.entries(limits)) if (!(key in LIMITS) || !Number.isSafeInteger(value) || value < 1 || value > LIMITS[key]) fail("configuration_invalid");
  if (limits.runtimeMs !== LIMITS.runtimeMs) fail("configuration_invalid");
  let access;
  try {
    if (accessPolicy !== null && (!isImportAccessPolicy(accessPolicy) || !Array.isArray(allowedOwners) || allowedOwners.length)) throw new Error();
    access = accessPolicy || createImportAccessPolicy({ allowedOwners });
  } catch (_) { fail("configuration_invalid"); }
  const volatile = store?.capabilities?.persistence === "volatile-test" || runner?.capabilities?.testOnly === true;
  const local = allowLocalForTests === true && allowVolatileForTests === true && isLocalDiskInspectionRunner(runner);
  const available = enabled && access.executionAvailable && store?.capabilities?.atomicCompanyUpdates === true &&
    (store?.capabilities?.persistence === "durable" || allowVolatileForTests && volatile) && (!volatile || allowVolatileForTests) &&
    runner?.capabilities?.idempotentDispatch === true && runner?.capabilities?.authoritativeLookup === true &&
    (runner?.capabilities?.isolatedWorker === true || local) && runner?.capabilities?.maxRuntimeMs === limits.runtimeMs &&
    typeof runner.dispatch === "function" && typeof runner.getByKey === "function";
  function authorize(context) {
    if (!available) fail("unavailable");
    const owner = identity(context);
    try { access.resolve(context); } catch (_) { fail("owner_not_allowed", 403); }
    return owner;
  }
  function now() { const value = clock(); if (!Number.isSafeInteger(value) || value < 0) fail("clock_invalid"); return value; }
  function find(state, owner, ticketId) {
    if (typeof ticketId !== "string" || !UUID.test(ticketId)) fail("not_found", 404);
    const matches = Object.values(state.uploads || {}).filter(row => row.r2?.inspectionTicket?.ticketId === ticketId || row.disk?.objectVersion === ticketId);
    const upload = matches[0], storage = upload && source(upload);
    if (matches.length !== 1 || upload.companyId !== owner.companyId || upload.userId !== owner.userId ||
        storage.value.objectVersion !== ticketId || storage.value.phase !== "sealed" ||
        storage.type === "render_disk" && upload.disk.inspectionRequested !== true) fail("not_found", 404);
    return upload;
  }
  async function update(owner, operation) {
    return store.update(owner.companyId, state => {
      validateInspectionDispatchState(state, owner.companyId);
      const result = operation(state);
      validateInspectionDispatchState(state, owner.companyId);
      return result;
    });
  }
  function publicResult(ticket) {
    const job = ticket.dispatch;
    return { ticketId: ticket.ticketId, state: job?.state === "ready" ? "ready" : job?.state === "failed" ? "failed" : "pending",
      ...(job?.errorCode ? { errorCode: job.errorCode } : {}), ...(job?.state === "ready" ? { result: clone(job.result) } : {}) };
  }
  function settle(state, job, actualMs) {
    if (job.computeSettled) return;
    const bucket = state.inspectionQuota.months[job.quotaMonth];
    bucket.reservedComputeMs -= job.runtimeMs; bucket.chargedComputeMs += actualMs; job.computeSettled = true;
  }
  async function bounded(operation) {
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("inspection_acknowledgement_timeout")), limits.acknowledgementMs); timer.unref?.(); });
    try { return await Promise.race([operation(), timeout]); } finally { clearTimeout(timer); }
  }
  async function safe(operation) {
    try { return await operation(); } catch (error) {
      if (typeof error?.code === "string" && /^import_inspection_[a-z_]+$/.test(error.code)) throw error;
      fail("unavailable");
    }
  }
  function task(upload) {
    const storage = source(upload), ticket = ticketFor(upload), job = ticket.dispatch;
    return { schema: 1, kind: "inspect_import", companyId: upload.companyId, userId: upload.userId,
      ticketId: ticket.ticketId, uploadId: upload.uploadId, assetId: upload.assetId,
      dispatchKey: job.dispatchKey, executionDigest: job.requestDigest, fenceToken: job.fenceToken,
      objectKey: upload.objectKey, objectVersion: storage.value.objectVersion,
      ...(storage.type === "render_disk" ? { providerType: "render_disk" } : { etag: storage.value.etag }),
      sizeBytes: upload.sizeBytes, sha256: upload.sha256, mediaKind: upload.kind,
      startedAt: job.startedAt, deadlineAt: job.deadlineAt, maxRuntimeMs: job.runtimeMs };
  }
  function resultInspection(remote, upload, job) {
    const result = remote.result, storage = source(upload);
    if (!object(result) || result.companyId !== upload.companyId || result.userId !== upload.userId ||
        result.ticketId !== storage.value.objectVersion || result.objectKey !== upload.objectKey || result.objectVersion !== storage.value.objectVersion ||
        (storage.type === "render_disk" ? result.providerType !== "render_disk" || result.etag !== undefined : result.etag !== storage.value.etag) || result.executionDigest !== job.requestDigest ||
        !Number.isSafeInteger(result.finishedAt) || result.finishedAt < job.startedAt || result.finishedAt > job.deadlineAt || result.finishedAt > now() ||
        !Number.isSafeInteger(result.elapsedMs) || result.elapsedMs < 0 || result.elapsedMs > job.runtimeMs) fail("result_invalid");
    const actual = result.inspection;
    if (!object(actual) || actual.complete !== true || actual.decoded !== true || actual.signatureVerified !== true ||
        actual.sha256 !== upload.sha256 || actual.sizeBytes !== upload.sizeBytes || actual.detectedMime !== upload.mimeType) fail("result_invalid");
    const inspected = inspectedMedia({ kind: upload.kind, format: { "image/jpeg": "jpeg", "image/png": "png", "image/webp": "webp", "video/mp4": "mp4", "video/quicktime": "mov" }[actual.detectedMime],
      decoded: true, sha256: actual.sha256, size: actual.sizeBytes, width: actual.width, height: actual.height,
      frames: actual.frames, durationSeconds: actual.durationMs / 1000, hasAudio: actual.hasAudio, colorMode: actual.colorMode }, upload.kind);
    return { elapsedMs: result.elapsedMs, result: { complete: true, decoded: true, signatureVerified: true,
      sha256: inspected.sha256, sizeBytes: inspected.size, detectedMime: actual.detectedMime, width: inspected.width, height: inspected.height,
      ...(upload.kind === "image" ? { frames: actual.frames } : { durationMs: actual.durationMs, hasAudio: actual.hasAudio, colorMode: actual.colorMode }) } };
  }
  async function accept(owner, snapshot, remote) {
    const ticketId = ticketFor(snapshot).ticketId, expected = ticketFor(snapshot).dispatch;
    if (!object(remote) || remote.dispatchKey !== expected.dispatchKey || remote.executionDigest !== expected.requestDigest ||
        !["not_found", "running", "succeeded", "failed"].includes(remote.state) ||
        (remote.state === "not_found" ? remote.authoritative !== true : !UUID.test(remote.executionId || ""))) fail("runner_response_invalid");
    let valid = null, invalid = false;
    if (remote.state === "succeeded") {
      try { valid = resultInspection(remote, snapshot, expected); } catch (_) { invalid = true; }
    }
    return update(owner, state => {
      const upload = find(state, owner, ticketId), ticket = ticketFor(upload), job = ticket.dispatch;
      if (job.fenceToken !== expected.fenceToken || ["ready", "failed"].includes(job.state)) return publicResult(ticket);
      if (job.executionId && remote.executionId && job.executionId !== remote.executionId) fail("execution_conflict", 409);
      if (remote.executionId) job.executionId = remote.executionId;
      job.updatedAt = now();
      if (valid) { job.state = "ready"; job.result = valid.result; job.errorCode = null; settle(state, job, valid.elapsedMs); }
      else if (invalid || remote.state === "failed") {
        job.state = "failed"; job.errorCode = invalid ? "import_inspection_result_invalid" : "import_inspection_worker_failed"; settle(state, job, job.runtimeMs);
      } else if (job.deadlineAt <= now()) {
        job.state = "attention"; job.errorCode = "import_inspection_deadline_unconfirmed"; settle(state, job, job.runtimeMs);
      } else {
        job.state = remote.state === "not_found" ? "reconciliation" : "processing";
        job.errorCode = remote.state === "not_found" ? "import_inspection_execution_not_observed" : null;
      }
      return publicResult(ticket);
    });
  }
  async function uncertain(owner, ticketId, fenceToken) {
    return update(owner, state => {
      const ticket = ticketFor(find(state, owner, ticketId)), job = ticket.dispatch;
      if (job.fenceToken === fenceToken && !["ready", "failed"].includes(job.state)) {
        job.state = "reconciliation"; job.errorCode = "import_inspection_dispatch_unconfirmed"; job.updatedAt = now();
        if (job.deadlineAt <= now()) { job.state = "attention"; settle(state, job, job.runtimeMs); }
      }
      return publicResult(ticket);
    });
  }
  const dispatcher = {
    capabilities: Object.freeze({ isolated: Boolean(available && !local), bounded: Boolean(available), remoteObjectInspection: Boolean(available),
      localOnly: Boolean(local), testOnly: Boolean(local), readyForProduction: false }),
    async startInspection(request) { return safe(async () => {
      const owner = authorize(request?.context);
      if (!object(request) || Object.keys(request).some(key => !["context", "ticketId", "objectKey", "objectVersion", "etag", "sizeBytes", "sha256", "kind", "deadlineMs"].includes(key))) fail("request_invalid", 400);
      const claim = await update(owner, state => {
        const upload = find(state, owner, request.ticketId), storage = source(upload), ticket = ticketFor(upload, true);
        if (request.objectKey !== upload.objectKey || request.objectVersion !== storage.value.objectVersion || request.etag !== storage.value.etag ||
            request.sizeBytes !== upload.sizeBytes || request.sha256 !== upload.sha256 || request.kind !== upload.kind || request.deadlineMs !== limits.runtimeMs) fail("request_conflict", 409);
        const values = [owner, request.ticketId, request.objectKey, request.objectVersion, request.etag, request.sizeBytes, request.sha256, request.kind, request.deadlineMs];
        const requestDigest = sha(JSON.stringify(storage.type === "render_disk" ? ["render_disk", ...values] : values));
        if (ticket.dispatch) {
          if (ticket.dispatch.requestDigest !== requestDigest) fail("idempotency_conflict", 409);
          return { first: false, upload: clone(upload) };
        }
        if (!state.inspectionQuota) state.inspectionQuota = { schema: 1, months: {} };
        const time = now(), month = new Date(time).toISOString().slice(0, 7), months = state.inspectionQuota.months;
        if (!months[month] && Object.keys(months).length >= limits.maxMonths) fail("quota_exceeded", 409);
        if (!months[month]) months[month] = { starts: 0, reservedComputeMs: 0, chargedComputeMs: 0 };
        const bucket = months[month];
        if (bucket.starts >= limits.monthlyInspections) fail("quota_exceeded", 409);
        bucket.starts++; bucket.reservedComputeMs += limits.runtimeMs;
        ticket.dispatch = { requestDigest, dispatchKey: sha(`inspection:${owner.companyId}:${request.ticketId}:${requestDigest}`),
          state: "dispatching", fenceToken: crypto.randomUUID(), startedAt: time, updatedAt: time,
          deadlineAt: time + limits.runtimeMs, runtimeMs: limits.runtimeMs, quotaMonth: month,
          computeSettled: false, errorCode: null, lookupLease: null };
        return { first: true, upload: clone(upload) };
      });
      if (!claim.first) return publicResult(ticketFor(claim.upload));
      try { authorize(request.context); }
      catch (_) {
        return update(owner, state => {
          const ticket = ticketFor(find(state, owner, request.ticketId)), job = ticket.dispatch;
          job.state = "failed"; job.errorCode = "import_inspection_owner_not_allowed"; job.updatedAt = now();
          settle(state, job, 0);
          return publicResult(ticket);
        });
      }
      try { return await accept(owner, claim.upload, await bounded(() => runner.dispatch(task(claim.upload)))); }
      catch (_) { return uncertain(owner, request.ticketId, ticketFor(claim.upload).dispatch.fenceToken); }
    }); },
    async getInspection(request) { return safe(async () => {
      const owner = authorize(request?.context);
      if (!object(request) || Object.keys(request).some(key => !["context", "ticketId"].includes(key))) fail("request_invalid", 400);
      const claim = await update(owner, state => {
        const upload = find(state, owner, request.ticketId), ticket = ticketFor(upload), job = ticket?.dispatch;
        if (!job || ["ready", "failed"].includes(job.state) || job.lookupLease?.expiresAt > now() || job.lastLookupAt != null && now() - job.lastLookupAt < limits.lookupIntervalMs) return { lookup: false, upload: clone(upload) };
        job.lookupLease = { token: crypto.randomUUID(), expiresAt: now() + limits.acknowledgementMs };
        job.lastLookupAt = now();
        return { lookup: true, upload: clone(upload) };
      });
      if (!claim.lookup) return publicResult(ticketFor(claim.upload) || { ticketId: request.ticketId });
      const job = ticketFor(claim.upload).dispatch;
      try {
        const remote = await bounded(() => runner.getByKey({ companyId: owner.companyId, userId: owner.userId,
          dispatchKey: job.dispatchKey, executionDigest: job.requestDigest }));
        return await accept(owner, claim.upload, remote);
      } catch (_) { return uncertain(owner, request.ticketId, job.fenceToken); }
      finally {
        await update(owner, state => {
          const current = ticketFor(find(state, owner, request.ticketId)).dispatch;
          if (current.lookupLease?.token === job.lookupLease.token) current.lookupLease = null;
        });
      }
    }); }
  };
  if (local && available) localDispatchers.add(dispatcher);
  return Object.freeze(dispatcher);
}

function isLocalDiskInspectionDispatcher(value) { return Boolean(value && localDispatchers.has(value)); }
module.exports = { createDurableInspectionDispatcher, validateInspectionDispatchState, isLocalDiskInspectionDispatcher, LIMITS };
