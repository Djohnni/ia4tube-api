"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const { createGlobalMediaCapacity, freshGlobalCapacityState, validateGlobalCapacityState } = require("../src/social/calendar/imports/global-capacity");
const uuid = () => crypto.randomUUID(), proof = () => crypto.randomBytes(32).toString("hex");
const context = { authenticated: true, role: "calendar_media_capacity_coordinator" };
function memoryStore() {
  let state = freshGlobalCapacityState(), tail = Promise.resolve();
  return { capabilities: { persistence: "volatile", atomicGlobalUpdates: true, testOnly: true },
    update(operation) { const run = tail.then(() => { const candidate = structuredClone(state), result = operation(candidate);
      if (result && typeof result.then === "function") throw new Error("async forbidden");
      validateGlobalCapacityState(candidate); state = candidate; return structuredClone(result); }); tail = run.catch(() => {}); return run; },
    snapshot: () => structuredClone(state) };
}
function fixture(limits = {}) {
  const store = memoryStore(); let time = Date.parse("2026-09-12T00:00:00Z");
  const capacity = createGlobalMediaCapacity({ store, enabled: true, allowVolatileForTests: true, limits, clock: () => time });
  const company = { companyId: uuid(), userId: uuid() };
  const input = (owner = company, extra = {}) => ({ context, jobId: uuid(), ...owner, requestDigest: proof(), storageBytes: 100,
    sourceBytes: 40, runtimeBudgetMs: 1000, ...extra });
  return { store, capacity, input, company, advance: duration => { time += duration; } };
}
async function complete(f, job, actualRuntimeMs = 100) {
  return f.capacity.recordCompletion({ context, jobId: job.jobId, leaseToken: job.leaseToken, outcome: "succeeded", actualRuntimeMs, proofId: proof() });
}
test("disabled by default; volatile state and browser/tenant context never silently become production admission", async () => {
  const f = fixture();
  await assert.rejects(createGlobalMediaCapacity({ store: f.store }).reserve(f.input()), /unavailable/);
  await assert.rejects(createGlobalMediaCapacity({ store: f.store, enabled: true }).reserve(f.input()), /unavailable/);
  await assert.rejects(f.capacity.reserve({ ...f.input(), context: { authenticated: true, role: "calendar_media_worker" } }), /coordinator_required/);
  assert.equal(f.capacity.capabilities.financialHardCap, false);
});
test("20 concurrent identical reservations consume exactly one receipt and quota", async () => {
  const f = fixture(), request = f.input();
  const receipts = await Promise.all(Array.from({ length: 20 }, () => f.capacity.reserve(request)));
  assert.ok(receipts.every(value => value.jobId === request.jobId));
  assert.deepEqual(await f.capacity.summary({ context }), { paused: false, storageBytes: 100, queuedJobs: 1,
    activeJobs: 0, monthlyJobs: 1, runtimeMs: 1000 });
  for (const field of ["companyId", "userId", "requestDigest", "storageBytes", "sourceBytes", "runtimeBudgetMs"]) {
    const value = field.endsWith("Id") ? uuid() : field === "requestDigest" ? proof() : request[field] + 1;
    await assert.rejects(f.capacity.reserve({ ...request, [field]: value }), /reservation_conflict/);
  }
});
test("global and company storage ceilings apply atomically across independent companies", async () => {
  const f = fixture({ globalStorageBytes: 200, companyStorageBytes: 100 });
  await f.capacity.reserve(f.input());
  await assert.rejects(f.capacity.reserve(f.input()), /storage_exceeded/);
  const outcomes = await Promise.allSettled(Array.from({ length: 10 }, () => f.capacity.reserve(f.input({ companyId: uuid(), userId: uuid() }))));
  assert.equal(outcomes.filter(value => value.status === "fulfilled").length, 1);
  assert.equal((await f.capacity.summary({ context })).storageBytes, 200);
});
test("aggregate compute budget is reserved before acquiring any process, not just a job count limit", async () => {
  const f = fixture({ monthlyRuntimeMs: 1500, companyMonthlyRuntimeMs: 5000 });
  await f.capacity.reserve(f.input());
  await assert.rejects(f.capacity.reserve(f.input({ companyId: uuid(), userId: uuid() })), /budget_exceeded/);
  await complete(f, await f.capacity.acquireNext({ context }), 400);
  await f.capacity.reserve(f.input({ companyId: uuid(), userId: uuid() }));
  assert.equal((await f.capacity.summary({ context })).runtimeMs, 1400);
});
test("per-company runtime budget cannot borrow a different company's allowance", async () => {
  const f = fixture({ monthlyRuntimeMs: 5000, companyMonthlyRuntimeMs: 1500 });
  await f.capacity.reserve(f.input());
  await assert.rejects(f.capacity.reserve(f.input()), /budget_exceeded/);
  await f.capacity.reserve(f.input({ companyId: uuid(), userId: uuid() }));
});
test("bounded queue and fair company rotation preserve FIFO within a company", async () => {
  const f = fixture({ companyQueuedJobs: 3, queuedJobs: 5 });
  const owners = [f.company, { companyId: uuid(), userId: uuid() }, { companyId: uuid(), userId: uuid() }];
  const requests = [f.input(owners[0]), f.input(owners[0]), f.input(owners[1]), f.input(owners[1]), f.input(owners[2])];
  for (const request of requests) await f.capacity.reserve(request);
  await assert.rejects(f.capacity.reserve(f.input(owners[2])), /queue_full/);
  const order = [];
  for (let i = 0; i < requests.length; i++) { const job = await f.capacity.acquireNext({ context }); order.push(job.jobId); await complete(f, job); }
  assert.deepEqual(order, [requests[0].jobId, requests[2].jobId, requests[4].jobId, requests[1].jobId, requests[3].jobId]);
});
test("concurrent acquisition yields one active process and never frees unknown job after its deadline", async () => {
  const f = fixture(); await f.capacity.reserve(f.input()); await f.capacity.reserve(f.input());
  const acquisitions = await Promise.all(Array.from({ length: 20 }, () => f.capacity.acquireNext({ context })));
  const running = acquisitions.filter(Boolean); assert.equal(running.length, 1);
  f.advance(10000000);
  assert.equal(await f.capacity.acquireNext({ context }), null);
  await f.capacity.cancel({ context, jobId: running[0].jobId });
  assert.equal(await f.capacity.acquireNext({ context }), null);
  await assert.rejects(f.capacity.recordCleanup({ context, jobId: running[0].jobId, proofId: proof() }), /termination_unconfirmed/);
});

test("a task-bound acquisition never consumes another company's fair queue head", async () => {
  const f = fixture(), first = f.input(), next = f.input({ companyId: uuid(), userId: uuid() });
  await f.capacity.reserve(first); await f.capacity.reserve(next);
  const before = f.store.snapshot();
  assert.equal(await f.capacity.acquireNext({ context, expectedJobId: next.jobId }), null);
  assert.deepEqual(f.store.snapshot(), before);
  const acquired = await f.capacity.acquireNext({ context, expectedJobId: first.jobId });
  assert.equal(acquired.jobId, first.jobId); await complete(f, acquired);
  assert.equal((await f.capacity.acquireNext({ context, expectedJobId: next.jobId })).jobId, next.jobId);
});
test("completion frees execution capacity but never fictitiously frees disk; confirmed cleanup is idempotent", async () => {
  const f = fixture(), request = f.input(); await f.capacity.reserve(request);
  const running = await f.capacity.acquireNext({ context }); await complete(f, running);
  assert.equal((await f.capacity.assertHeld({ ...request, intent: "read" })).storageHeld, true);
  await assert.rejects(f.capacity.assertHeld(request), /writes_not_allowed/);
  assert.equal((await f.capacity.summary({ context })).storageBytes, 100);
  const cleanup = { context, jobId: request.jobId, proofId: proof() };
  await f.capacity.recordCleanup(cleanup); await f.capacity.recordCleanup(cleanup);
  assert.equal((await f.capacity.summary({ context })).storageBytes, 0);
  await assert.rejects(f.capacity.assertHeld(request), /storage_not_held/);
  await assert.rejects(f.capacity.recordCleanup({ ...cleanup, proofId: proof() }), /cleanup_conflict/);
  assert.equal((await f.capacity.reserve(request)).storageHeld, false); // never resurrect a completed reservation
});
test("unstarted cancellation returns compute but holds disk; stale lease cannot settle another process", async () => {
  const f = fixture(), request = f.input(); await f.capacity.reserve(request);
  await f.capacity.cancel({ context, jobId: request.jobId });
  assert.equal((await f.capacity.summary({ context })).runtimeMs, 0);
  assert.equal((await f.capacity.summary({ context })).storageBytes, 100);
  const next = f.input(); await f.capacity.reserve(next); const running = await f.capacity.acquireNext({ context });
  await assert.rejects(f.capacity.recordCompletion({ context, jobId: running.jobId, leaseToken: uuid(), outcome: "failed", actualRuntimeMs: 10, proofId: proof() }), /lease_conflict/);
  assert.equal((await f.capacity.summary({ context })).activeJobs, 1);
});
test("pause blocks new work without pretending to stop running process; overruns are charged fully and pause", async () => {
  const f = fixture(); await f.capacity.reserve(f.input()); const running = await f.capacity.acquireNext({ context });
  await f.capacity.setPaused({ context, paused: true });
  await assert.rejects(f.capacity.reserve(f.input()), /paused/);
  assert.equal((await f.capacity.summary({ context })).activeJobs, 1);
  await f.capacity.setPaused({ context, paused: false }); await complete(f, running, 1200);
  assert.equal((await f.capacity.summary({ context })).paused, true);
  assert.equal((await f.capacity.summary({ context })).runtimeMs, 1200);
});
test("month rollover cannot free old active slots or held storage", async () => {
  const f = fixture(); const request = f.input(); await f.capacity.reserve(request); const running = await f.capacity.acquireNext({ context });
  f.advance(32 * 86400000); await f.capacity.reserve(f.input());
  assert.equal(await f.capacity.acquireNext({ context }), null);
  await complete(f, running, 250);
  assert.equal((await f.capacity.summary({ context })).runtimeMs, 1250);
  assert.equal((await f.capacity.summary({ context })).storageBytes, 200);
});
test("a queued job crossing the month must reserve that month's budget before dispatch", async () => {
  const f = fixture({ monthlyRuntimeMs: 1000, companyMonthlyRuntimeMs: 1000 }), old = f.input();
  await f.capacity.reserve(old); f.advance(32 * 86400000);
  const current = f.input({ companyId: uuid(), userId: uuid() }); await f.capacity.reserve(current);
  const running = await f.capacity.acquireNext({ context });
  assert.equal(running.jobId, current.jobId); // older unreserved work cannot steal this month's reservation
  await complete(f, running, 1);
  assert.equal(await f.capacity.acquireNext({ context }), null); // 1+1000 exceeds the exact ceiling
});
test("unknown running work crossing month reserves the new safety budget before any new admission", async () => {
  const f = fixture({ monthlyRuntimeMs: 1000, companyMonthlyRuntimeMs: 1000 });
  await f.capacity.reserve(f.input()); await f.capacity.acquireNext({ context }); f.advance(32 * 86400000);
  assert.equal((await f.capacity.summary({ context })).runtimeMs, 1000);
  await assert.rejects(f.capacity.reserve(f.input({ companyId: uuid(), userId: uuid() })), /budget_exceeded/);
});
test("cancelled reservations forbid new writes even when disk remains held", async () => {
  const f = fixture(), request = f.input(); await f.capacity.reserve(request); await f.capacity.cancel({ context, jobId: request.jobId });
  await assert.rejects(f.capacity.assertHeld(request), /writes_not_allowed/);
  assert.equal((await f.capacity.assertHeld({ ...request, intent: "read" })).storageHeld, true);
});
test("ownership checks, malformed state and unknown limits fail closed", async () => {
  const f = fixture(), request = f.input(); await f.capacity.reserve(request);
  await assert.rejects(f.capacity.assertHeld({ ...request, companyId: uuid() }), /reservation_conflict/);
  const state = f.store.snapshot(); state.jobs[request.jobId].storageHeld = false;
  assert.throws(() => validateGlobalCapacityState(state), /state_invalid/);
  assert.throws(() => createGlobalMediaCapacity({ limits: { unknownBudget: 100 } }), /configuration_invalid/);
});
test("trusted storage settlement releases only confirmed surplus, remains idempotent and cannot free active process", async () => {
  const f = fixture(), request = f.input(); await f.capacity.reserve(request);
  const running = await f.capacity.acquireNext({ context });
  const settlement = { context, jobId: running.jobId, remainingBytes: 60, proofId: proof() };
  await f.capacity.settleStorage(settlement); await f.capacity.settleStorage(settlement);
  assert.equal((await f.capacity.summary({ context })).storageBytes, 60);
  assert.equal((await f.capacity.summary({ context })).activeJobs, 1);
  assert.equal((await f.capacity.assertHeld(request)).storageBytes, 100);
  assert.equal((await f.capacity.assertHeld(request)).heldBytes, 60);
  await assert.rejects(f.capacity.settleStorage({ ...settlement, remainingBytes: 59 }), /cleanup_conflict/);
  await assert.rejects(f.capacity.settleStorage({ ...settlement, proofId: proof(), remainingBytes: 61 }), /cleanup_conflict/);
  await assert.rejects(f.capacity.settleStorage({ ...settlement, proofId: proof(), remainingBytes: 0 }), /cleanup_invalid/);
  assert.equal((await f.capacity.reserve(request)).heldBytes, 60);
});
test("storage-only reservation never schedules a task or consumes compute/monthly job quota", async () => {
  const f = fixture({ monthlyJobs: 1, companyMonthlyJobs: 1, monthlyRuntimeMs: 1000, companyMonthlyRuntimeMs: 1000 });
  const { runtimeBudgetMs: _, ...storage } = f.input();
  await f.capacity.reserveStorage(storage); await f.capacity.reserveStorage(storage);
  assert.equal(await f.capacity.acquireNext({ context }), null);
  assert.deepEqual(await f.capacity.summary({ context }), { paused: false, storageBytes: 100, queuedJobs: 0, activeJobs: 0, monthlyJobs: 0, runtimeMs: 0 });
  await f.capacity.reserve(f.input()); assert.ok(await f.capacity.acquireNext({ context }));
  await assert.rejects(f.capacity.reserve({ ...storage, runtimeBudgetMs: 1000 }), /reservation_conflict/);
});
test("storage-only seal keeps actual source private and read-only; cancellation cannot fictitiously release disk", async () => {
  const f = fixture(), { runtimeBudgetMs: _, ...storage } = f.input();
  await f.capacity.reserveStorage(storage);
  assert.equal((await f.capacity.assertHeld(storage)).state, "storage_reserved");
  const seal = { context, jobId: storage.jobId, remainingBytes: storage.sourceBytes, proofId: proof() };
  await f.capacity.sealStorage(seal); await f.capacity.sealStorage(seal);
  await assert.rejects(f.capacity.assertHeld(storage), /writes_not_allowed/);
  assert.equal((await f.capacity.assertHeld({ ...storage, intent: "read" })).heldBytes, storage.sourceBytes);
  await f.capacity.cancel({ context, jobId: storage.jobId });
  assert.equal((await f.capacity.summary({ context })).storageBytes, storage.sourceBytes);
  await f.capacity.recordCleanup({ context, jobId: storage.jobId, proofId: proof() });
  assert.equal((await f.capacity.summary({ context })).storageBytes, 0);
  assert.equal((await f.capacity.reserveStorage(storage)).state, "storage_released");
});
