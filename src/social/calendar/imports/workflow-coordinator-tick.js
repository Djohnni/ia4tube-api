"use strict";
// Explicit, finite API-side progress. No timer, HTTP-status mutation, codec or
// retry replacement is started by constructing this function.
const { isWorkflowPrivateJournal, fail } = require("./workflow-private-journal");
const { isOperationalInspectionRunner } = require("./operational-inspection-runner");
const { isOperationalPreparationRunner } = require("./operational-preparation-runner");
const { isImportAccessPolicy } = require("./access-policy");
const { isImportUploadPostgresStore } = require("./postgres-store");
function createWorkflowCoordinatorTick({ store, owner, journal, inspectionRunner, preparationRunner, upload, preparation, accessPolicy } = {}) {
  if (!isImportUploadPostgresStore(store) || !isWorkflowPrivateJournal(journal) ||
      !isOperationalInspectionRunner(inspectionRunner) || !isOperationalPreparationRunner(preparationRunner) ||
      !isImportAccessPolicy(accessPolicy) || ![upload?.complete, preparation?.reconcile, preparation?.dispatchNext].every(v => typeof v === "function")) fail("tick_configuration_invalid");
  const allowed = accessPolicy.resolve({ authenticated: true, companyId: owner?.companyId, userId: owner?.userId });
  if (journal.owner.companyId !== allowed.companyId || journal.owner.userId !== allowed.userId) fail("tick_owner_invalid");
  const context = Object.freeze({ authenticated: true, companyId: allowed.companyId, userId: allowed.userId });
  let active = null;
  const unresolved = () => store.update(context.companyId, state => ["inspectionExecutions", "preparationExecutions"].some(namespace =>
    Object.values(state[namespace]?.records || {}).some(r => r.task.userId === context.userId && r.launchClaimed && !r.capacitySettled)) ||
    Object.values(state.workflowExecutions?.records || {}).some(r => {
    const prior = state[r.kind === "inspect" ? "inspectionExecutions" : "preparationExecutions"].records[r.dispatchKey];
    return prior.task.userId === context.userId && (!r.delivered || prior.capacitySettled !== true);
  }));
  const check = deadline => { accessPolicy.resolve(context); if (performance.now() >= deadline) fail("tick_budget_exhausted"); };
  async function run() {
    const deadline = performance.now() + 60000, result = { inspectionsObserved: 0, preparationsObserved: 0, resumedIntents: 0, dispatchAttempted: false, unresolved: true };
    check(deadline);
    const pending = await store.update(context.companyId, state => ({
      upload: Object.values(state.uploads).find(r => r.userId === context.userId && r.companyId === context.companyId && r.state === "verifying")?.uploadId || null,
      job: Object.values(state.preparation?.jobs || {}).filter(r => r.userId === context.userId && r.companyId === context.companyId &&
        ["dispatching", "processing", "reconciliation"].includes(r.state)).map(r => ({ assetId: r.assetId, mediaRevision: r.mediaRevision }))[0] || null
    }));
    if (pending.upload) {
      check(deadline); result.inspectionsObserved++;
      try { await upload.complete(context, { uploadId: pending.upload }); }
      catch (error) { if (error?.code !== "import_verification_pending") throw error; }
    }
    if (pending.job) { check(deadline); result.preparationsObserved++; await preparation.reconcile(context, pending.job); }
    // Unknown remote work keeps the global reservation and blocks new work.
    // Only already-persisted, never-claimed intents are resumed; their existing
    // journals elect one launcher across concurrent API processes.
    if (!(await unresolved())) {
      check(deadline); result.resumedIntents += (await inspectionRunner.resumePending({ limit: 1 })).length;
      if (!(await unresolved())) { check(deadline); result.resumedIntents += (await preparationRunner.resumePending({ limit: 1 })).length; }
      if (!(await unresolved())) { check(deadline); result.dispatchAttempted = true; await preparation.dispatchNext(context); }
    }
    result.unresolved = await unresolved(); return Object.freeze(result);
  }
  return function tick() {
    // Do not clear the guard on a timeout race while work continues underneath.
    // Each SDK observation is separately bounded; this bound stops the next op.
    if (!active) active = run().finally(() => { active = null; });
    return active;
  };
}
module.exports = { createWorkflowCoordinatorTick };
