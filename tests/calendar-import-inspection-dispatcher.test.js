"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const { createMemoryImportUploadStore } = require("../src/social/calendar/imports/memory-adapters");
const { createDurableInspectionDispatcher, validateInspectionDispatchState } = require("../src/social/calendar/imports/inspection-dispatcher");
const { createImportAccessPolicy } = require("../src/social/calendar/imports/access-policy");
const uuid = () => crypto.randomUUID();
function fixture({ limit = 60, runnerOverrides = {} } = {}) {
  let time = Date.parse("2026-09-12T15:00:00Z"), mode = "success";
  const owner = { authenticated: true, companyId: uuid(), userId: uuid() };
  const store = createMemoryImportUploadStore(), remote = new Map(), counts = { dispatch: 0, lookup: 0 };
  const runner = { capabilities: { testOnly: true, idempotentDispatch: true, authoritativeLookup: true, isolatedWorker: true, maxRuntimeMs: 180000 },
    async dispatch(task) {
      counts.dispatch++;
      const outcome = { dispatchKey: task.dispatchKey, executionDigest: task.executionDigest, executionId: uuid(), state: mode === "running" ? "running" : "succeeded" };
      outcome.result = { companyId: task.companyId, userId: task.userId, ticketId: task.ticketId,
        objectKey: task.objectKey, objectVersion: task.objectVersion, etag: task.etag, executionDigest: task.executionDigest,
        elapsedMs: 0, finishedAt: time, inspection: { complete: true, decoded: true, signatureVerified: true,
          sha256: task.sha256, sizeBytes: task.sizeBytes, detectedMime: "image/jpeg", width: 1080, height: 1350, frames: 1 } };
      if (mode === "invalid") outcome.result.userId = uuid();
      if (mode === "failed") outcome.state = "failed";
      remote.set(task.dispatchKey, outcome);
      if (mode === "lost") throw new Error("private signed-url credential=secret");
      return outcome;
    },
    async getByKey(request) {
      counts.lookup++;
      return remote.get(request.dispatchKey) || { ...request, state: "not_found", authoritative: true };
    }, ...runnerOverrides };
  const dispatcher = createDurableInspectionDispatcher({ store, runner, enabled: true, allowedOwners: [owner], allowVolatileForTests: true,
    clock: () => time, limits: { monthlyInspections: limit } });
  async function request() {
    const uploadId = uuid(), assetId = uuid(), ticketId = uuid(), objectKey = crypto.randomBytes(32).toString("hex");
    const input = { context: owner, ticketId, objectKey, objectVersion: ticketId, etag: '"opaque-etag"',
      sizeBytes: 100, sha256: "a".repeat(64), kind: "image", deadlineMs: 180000 };
    await store.update(owner.companyId, state => {
      state.uploads[uploadId] = { uploadId, assetId, companyId: owner.companyId, userId: owner.userId,
        objectKey, sizeBytes: input.sizeBytes, sha256: input.sha256, kind: input.kind, mimeType: "image/jpeg", state: "verifying",
        r2: { phase: "sealed", objectVersion: ticketId, etag: input.etag, inspectionTicket: { ticketId, state: "requested", requestedAt: time, deadlineMs: 180000 } } };
    });
    return input;
  }
  function jobs() { return Object.values(store.snapshotForTest(owner.companyId).uploads).map(row => row.r2.inspectionTicket.dispatch).filter(Boolean); }
  return { owner, store, runner, dispatcher, request, remote, counts, jobs, setMode: value => { mode = value; },
    setTime: value => { time = value; }, advance: value => { time += value; } };
}

test("dispatcher fails closed without durable or explicitly opted-in test infrastructure and allowed pilot", async () => {
  const f = fixture();
  const input = await f.request();
  const disabled = createDurableInspectionDispatcher({ store: f.store, runner: f.runner, enabled: true, allowedOwners: [f.owner] });
  assert.equal(disabled.capabilities.isolated, false);
  await assert.rejects(disabled.startInspection(input), /import_inspection_unavailable/);
  const noOwner = createDurableInspectionDispatcher({ store: f.store, runner: f.runner, enabled: true, allowVolatileForTests: true });
  await assert.rejects(noOwner.startInspection(input), /import_inspection_unavailable/);
});

test("inspection eligibility is trusted and revoked access cannot start paid work", async () => {
  const f = fixture(), input = await f.request(); let eligible = true;
  const accessPolicy = createImportAccessPolicy({ allowedOwners: [f.owner], isEligible: () => eligible });
  const dispatcher = createDurableInspectionDispatcher({ store: f.store, runner: f.runner, enabled: true,
    accessPolicy, allowVolatileForTests: true, clock: () => Date.parse("2026-09-12T15:00:00Z") });
  eligible = false;
  await assert.rejects(dispatcher.startInspection({ ...input, context: { ...f.owner, audience: "owner_pilot" } }), /owner_not_allowed/);
  assert.equal(f.counts.dispatch, 0); assert.equal(f.jobs().length, 0);
});

test("inspection rechecks revocation after reservation but before dispatch", async () => {
  const f = fixture(), input = await f.request(); let eligible = true;
  const accessPolicy = createImportAccessPolicy({ allowedOwners: [f.owner], isEligible: () => eligible });
  const store = { ...f.store, async update(...args) { const value = await f.store.update(...args); eligible = false; return value; } };
  const dispatcher = createDurableInspectionDispatcher({ store, runner: f.runner, enabled: true,
    accessPolicy, allowVolatileForTests: true, clock: () => Date.parse("2026-09-12T15:00:00Z") });
  const result = await dispatcher.startInspection(input);
  assert.equal(result.state, "failed"); assert.equal(result.errorCode, "import_inspection_owner_not_allowed");
  assert.equal(f.counts.dispatch, 0);
  assert.equal(f.store.snapshotForTest(f.owner.companyId).inspectionQuota.months["2026-09"].chargedComputeMs, 0);
});

test("inspection cannot expand to customers with only an injected capability flag", async () => {
  const f = fixture(), input = await f.request();
  const accessPolicy = createImportAccessPolicy({ mode: "multi_company", allowedOwners: [{ ...f.owner, audience: "customers" }] });
  const dispatcher = createDurableInspectionDispatcher({ store: f.store, runner: f.runner, enabled: true,
    accessPolicy, allowVolatileForTests: true, globalAdmission: { capabilities: { atomicGlobalAdmission: true } } });
  assert.equal(dispatcher.capabilities.isolated, false);
  await assert.rejects(dispatcher.startInspection(input), /import_inspection_unavailable/);
  assert.throws(() => createDurableInspectionDispatcher({ accessPolicy: { executionAvailable: true, resolve: () => f.owner } }), /configuration_invalid/);
  assert.equal(f.counts.dispatch, 0);
});

test("only the already sealed owned object can reserve an inspection", async () => {
  const f = fixture(), input = await f.request();
  for (const field of ["objectKey", "objectVersion", "etag", "sha256", "sizeBytes", "kind", "deadlineMs"]) {
    await assert.rejects(f.dispatcher.startInspection({ ...input, [field]: "forged" }), /import_inspection_request_conflict/);
  }
  await assert.rejects(f.dispatcher.startInspection({ ...input, url: "https://arbitrary.invalid" }), /import_inspection_request_invalid/);
  await assert.rejects(f.dispatcher.getInspection({ context: { ...f.owner, userId: uuid() }, ticketId: input.ticketId }), /import_inspection_owner_not_allowed/);
  assert.equal(f.counts.dispatch, 0);
});

test("duplicate and concurrent starts persist one ticket and reserve quota only once", async () => {
  const f = fixture(), input = await f.request();
  await Promise.all(Array.from({ length: 20 }, () => f.dispatcher.startInspection(input)));
  const ready = await f.dispatcher.getInspection({ context: f.owner, ticketId: input.ticketId });
  assert.equal(ready.state, "ready"); assert.equal(ready.result.sha256, input.sha256);
  assert.equal(f.counts.dispatch, 1); assert.equal(f.counts.lookup, 0);
  const bucket = f.store.snapshotForTest(f.owner.companyId).inspectionQuota.months["2026-09"];
  assert.deepEqual(bucket, { starts: 1, reservedComputeMs: 0, chargedComputeMs: 0 });
});

test("quota is committed before external dispatch", async () => {
  let f;
  f = fixture({ runnerOverrides: { async dispatch(task) {
    const state = f.store.snapshotForTest(f.owner.companyId);
    assert.equal(state.inspectionQuota.months["2026-09"].starts, 1);
    assert.equal(f.jobs()[0].dispatchKey, task.dispatchKey);
    return { dispatchKey: task.dispatchKey, executionDigest: task.executionDigest, executionId: uuid(), state: "running" };
  } } });
  const result = await f.dispatcher.startInspection(await f.request());
  assert.equal(result.state, "pending");
  assert.equal(f.store.snapshotForTest(f.owner.companyId).inspectionQuota.months["2026-09"].reservedComputeMs, 180000);
});

test("60 inspection starts per UTC month are atomic; 61st cannot dispatch", async () => {
  const f = fixture();
  const requests = await Promise.all(Array.from({ length: 61 }, () => f.request()));
  const outcomes = await Promise.allSettled(requests.map(input => f.dispatcher.startInspection(input)));
  assert.equal(outcomes.filter(result => result.status === "fulfilled").length, 60);
  assert.equal(outcomes.filter(result => result.status === "rejected")[0].reason.code, "import_inspection_quota_exceeded");
  assert.equal(f.counts.dispatch, 60);
  assert.equal(f.store.snapshotForTest(f.owner.companyId).inspectionQuota.months["2026-09"].starts, 60);
});

test("inspection uses its 60-slot namespace without changing preparation's separate 60-slot bucket", async () => {
  const f = fixture();
  await f.store.update(f.owner.companyId, state => { state.preparation = { months: { "2026-09": { preparations: 60, reservedComputeMs: 0, usedComputeMs: 10800000 } } }; });
  const before = f.store.snapshotForTest(f.owner.companyId).preparation;
  await f.dispatcher.startInspection(await f.request());
  assert.deepEqual(f.store.snapshotForTest(f.owner.companyId).preparation, before);
  assert.equal(f.store.snapshotForTest(f.owner.companyId).inspectionQuota.months["2026-09"].starts, 1);
});

test("lost dispatch acknowledgement is reconciled using lookup without a second paid start", async () => {
  const f = fixture(); f.setMode("lost"); const input = await f.request();
  const pending = await f.dispatcher.startInspection(input);
  assert.equal(pending.state, "pending");
  assert.equal(pending.errorCode, "import_inspection_dispatch_unconfirmed");
  assert.equal(JSON.stringify(pending).includes("secret"), false);
  assert.equal((await f.dispatcher.getInspection({ context: f.owner, ticketId: input.ticketId })).state, "ready");
  assert.equal(f.counts.dispatch, 1); assert.equal(f.counts.lookup, 1);
});

test("authoritative not-found after uncertainty does not permit blind redispatch", async () => {
  const f = fixture({ runnerOverrides: { async dispatch() { throw new Error("unknown transport"); } } });
  const input = await f.request();
  await f.dispatcher.startInspection(input);
  const request = { context: f.owner, ticketId: input.ticketId };
  assert.equal((await f.dispatcher.getInspection(request)).errorCode, "import_inspection_execution_not_observed");
  await f.dispatcher.startInspection(input);
  f.advance(180001);
  assert.equal((await f.dispatcher.getInspection(request)).state, "pending");
  assert.equal(f.jobs()[0].state, "attention");
  assert.equal(f.store.snapshotForTest(f.owner.companyId).inspectionQuota.months["2026-09"].chargedComputeMs, 180000);
});

test("bad owner/checksum/runtime receipts do not mark media ready", async () => {
  for (const mode of ["invalid", "failed"]) {
    const f = fixture(); f.setMode(mode); const input = await f.request();
    const result = await f.dispatcher.startInspection(input);
    assert.equal(result.state, "failed");
    assert.equal(result.result, undefined);
    assert.equal(f.store.snapshotForTest(f.owner.companyId).inspectionQuota.months["2026-09"].chargedComputeMs, 180000);
  }
});

test("late observation of a result completed within deadline can succeed without duplicate quota", async () => {
  const f = fixture(); f.setMode("lost"); const input = await f.request();
  await f.dispatcher.startInspection(input);
  f.advance(190000);
  assert.equal((await f.dispatcher.getInspection({ context: f.owner, ticketId: input.ticketId })).state, "ready");
  assert.equal(f.counts.dispatch, 1);
  assert.equal(f.store.snapshotForTest(f.owner.companyId).inspectionQuota.months["2026-09"].starts, 1);
});

test("month rollover creates a new bucket but never reassigns/restarts an existing ticket", async () => {
  const f = fixture({ limit: 1 }); const september = await f.request();
  await f.dispatcher.startInspection(september);
  f.setTime(Date.parse("2026-10-01T00:00:00Z"));
  await f.dispatcher.startInspection(september);
  await f.dispatcher.startInspection(await f.request());
  const months = f.store.snapshotForTest(f.owner.companyId).inspectionQuota.months;
  assert.equal(months["2026-09"].starts, 1); assert.equal(months["2026-10"].starts, 1); assert.equal(f.counts.dispatch, 2);
});

test("rapid status polls share a lease/cooldown and do not repeatedly charge lookup", async () => {
  const f = fixture(); f.setMode("running"); const input = await f.request(); await f.dispatcher.startInspection(input);
  const request = { context: f.owner, ticketId: input.ticketId };
  await Promise.all(Array.from({ length: 20 }, () => f.dispatcher.getInspection(request)));
  assert.equal(f.counts.lookup, 1);
  f.advance(1000); await f.dispatcher.getInspection(request);
  assert.equal(f.counts.lookup, 2); assert.equal(f.counts.dispatch, 1);
});

test("validator rejects malformed quotas and changed identity bindings", async () => {
  const f = fixture(), input = await f.request(); await f.dispatcher.startInspection(input);
  const state = f.store.snapshotForTest(f.owner.companyId);
  state.inspectionQuota.months["2026-09"].starts = 999;
  assert.throws(() => validateInspectionDispatchState(state, f.owner.companyId), /import_inspection_state_invalid/);
});

test("validator rejects an orphan inspection dispatch if its quota namespace is missing", async () => {
  const f = fixture(), input = await f.request(); await f.dispatcher.startInspection(input);
  const state = f.store.snapshotForTest(f.owner.companyId);
  delete state.inspectionQuota;
  assert.throws(() => validateInspectionDispatchState(state, f.owner.companyId), /import_inspection_state_invalid/);
});
