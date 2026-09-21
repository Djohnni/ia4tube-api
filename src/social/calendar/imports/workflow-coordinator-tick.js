"use strict";
// Explicit, finite API-side progress. No timer, HTTP-status mutation, codec or
// retry replacement is started by constructing this function.
const { isWorkflowPrivateJournal, fail } = require("./workflow-private-journal");
const { isOperationalInspectionRunner } = require("./operational-inspection-runner");
const { isOperationalPreparationRunner } = require("./operational-preparation-runner");
const { isImportAccessPolicy } = require("./access-policy");
const { isImportUploadPostgresStore } = require("./postgres-store");
const TICK_STAGES = new Set(["pending_scan", "upload_complete", "preparation_reconcile", "unresolved_before_inspection",
  "inspection_resume", "unresolved_before_preparation", "preparation_resume", "unresolved_before_dispatch",
  "preparation_dispatch", "unresolved_final"]);
const TICK_STAGE_SLOW_MS = 10000;
function createWorkflowStageObserver({ diagnostic = () => {}, monotonicClock = () => performance.now(),
  timers = { setTimeout, clearTimeout }, slowAfterMs = TICK_STAGE_SLOW_MS } = {}) {
  if (typeof diagnostic !== "function" || typeof monotonicClock !== "function" ||
      typeof timers?.setTimeout !== "function" || typeof timers?.clearTimeout !== "function" ||
      !Number.isSafeInteger(slowAfterMs) || slowAfterMs < 1 || slowAfterMs > 60000) fail("tick_configuration_invalid");
  const now = () => {
    try { const value = monotonicClock(); return Number.isFinite(value) ? value : null; }
    catch { return null; }
  };
  const elapsed = started => {
    const finished = now(); if (started === null || finished === null) return 0;
    const value = Math.floor(finished - started);
    return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 60000) : 0;
  };
  const emit = (code, stage, elapsedMs) => {
    try {
      const pending = diagnostic(Object.freeze({ component: "workflow_coordinator_tick", code, stage, elapsedMs }));
      if (pending && typeof pending.then === "function") Promise.resolve(pending).catch(() => {});
    }
    catch { /* Diagnostics must never alter progress or cleanup. */ }
  };
  return async (stage, operation) => {
    if (!TICK_STAGES.has(stage) || typeof operation !== "function") fail("tick_configuration_invalid");
    const started = now(); let slow = false, timer = null;
    try {
      timer = timers.setTimeout(() => {
        slow = true;
        emit("workflow_tick_stage_slow", stage, Math.max(slowAfterMs, elapsed(started)));
      }, slowAfterMs);
      timer?.unref?.();
    } catch { timer = null; }
    try {
      const value = await operation();
      if (slow) emit("workflow_tick_stage_recovered", stage, Math.max(slowAfterMs, elapsed(started)));
      return value;
    } catch (error) {
      emit("workflow_tick_stage_failed", stage, elapsed(started));
      throw error;
    } finally { try { if (timer !== null) timers.clearTimeout(timer); } catch { /* Observation cleanup is fail-open. */ } }
  };
}
function createWorkflowCoordinatorTick({ store, owner, journal, inspectionRunner, preparationRunner, upload, preparation, accessPolicy,
  diagnostic = () => {}, monotonicClock = () => performance.now(), stageTimers, stageSlowMs = TICK_STAGE_SLOW_MS } = {}) {
  if (!isImportUploadPostgresStore(store) || !isWorkflowPrivateJournal(journal) ||
      !isOperationalInspectionRunner(inspectionRunner) || !isOperationalPreparationRunner(preparationRunner) ||
      !isImportAccessPolicy(accessPolicy) || ![upload?.complete, preparation?.reconcile, preparation?.dispatchNext].every(v => typeof v === "function")) fail("tick_configuration_invalid");
  const allowed = accessPolicy.resolve({ authenticated: true, companyId: owner?.companyId, userId: owner?.userId });
  if (journal.owner.companyId !== allowed.companyId || journal.owner.userId !== allowed.userId) fail("tick_owner_invalid");
  const context = Object.freeze({ authenticated: true, companyId: allowed.companyId, userId: allowed.userId });
  const observe = createWorkflowStageObserver({ diagnostic, monotonicClock, ...(stageTimers ? { timers: stageTimers } : {}), slowAfterMs: stageSlowMs });
  let active = null;
  const unresolved = stage => observe(stage, () => store.update(context.companyId, state => ["inspectionExecutions", "preparationExecutions"].some(namespace =>
    Object.values(state[namespace]?.records || {}).some(r => r.task.userId === context.userId && r.launchClaimed && !r.capacitySettled)) ||
    Object.values(state.workflowExecutions?.records || {}).some(r => {
    const prior = state[r.kind === "inspect" ? "inspectionExecutions" : "preparationExecutions"].records[r.dispatchKey];
    return prior.task.userId === context.userId && (!r.delivered || prior.capacitySettled !== true);
  })));
  const check = deadline => { accessPolicy.resolve(context); if (monotonicClock() >= deadline) fail("tick_budget_exhausted"); };
  async function run() {
    const deadline = monotonicClock() + 60000, result = { inspectionsObserved: 0, preparationsObserved: 0, resumedIntents: 0, dispatchAttempted: false, unresolved: true };
    check(deadline);
    const pending = await observe("pending_scan", () => store.update(context.companyId, state => ({
      upload: Object.values(state.uploads).find(r => r.userId === context.userId && r.companyId === context.companyId && r.state === "verifying")?.uploadId || null,
      job: Object.values(state.preparation?.jobs || {}).filter(r => r.userId === context.userId && r.companyId === context.companyId &&
        ["dispatching", "processing", "reconciliation"].includes(r.state)).map(r => ({ assetId: r.assetId, mediaRevision: r.mediaRevision }))[0] || null
    })));
    if (pending.upload) {
      check(deadline); result.inspectionsObserved++;
      try { await observe("upload_complete", () => upload.complete(context, { uploadId: pending.upload })); }
      catch (error) { if (error?.code !== "import_verification_pending") throw error; }
    }
    if (pending.job) { check(deadline); result.preparationsObserved++; await observe("preparation_reconcile", () => preparation.reconcile(context, pending.job)); }
    // Unknown remote work keeps the global reservation and blocks new work.
    // Only already-persisted, never-claimed intents are resumed; their existing
    // journals elect one launcher across concurrent API processes.
    if (!(await unresolved("unresolved_before_inspection"))) {
      check(deadline); result.resumedIntents += (await observe("inspection_resume", () => inspectionRunner.resumePending({ limit: 1 }))).length;
      if (!(await unresolved("unresolved_before_preparation"))) { check(deadline); result.resumedIntents += (await observe("preparation_resume", () => preparationRunner.resumePending({ limit: 1 }))).length; }
      if (!(await unresolved("unresolved_before_dispatch"))) { check(deadline); result.dispatchAttempted = true; await observe("preparation_dispatch", () => preparation.dispatchNext(context)); }
    }
    result.unresolved = await unresolved("unresolved_final"); return Object.freeze(result);
  }
  return function tick() {
    // Do not clear the guard on a timeout race while work continues underneath.
    // Each SDK observation is separately bounded; this bound stops the next op.
    if (!active) active = run().finally(() => { active = null; });
    return active;
  };
}
module.exports = { TICK_STAGES, createWorkflowCoordinatorTick, createWorkflowStageObserver };
