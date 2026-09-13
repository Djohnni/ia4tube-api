"use strict";
// Durable task binding lives in the existing forced-RLS import document. No
// provider credentials, URLs or bytes are stored in this journal.
const crypto = require("node:crypto"), { isDeepStrictEqual } = require("node:util");
const { isImportUploadPostgresStore } = require("./postgres-store");
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/, RUN = /^trn-[a-z0-9]{1,80}$/;
const stores = new WeakSet();
function fail(code) { throw Object.assign(new Error("workflow_private_" + code), { code: "workflow_private_" + code }); }
function validateWorkflowPrivateState(value, companyId, state) {
  if (value?.schema !== 1 || !value.records || Object.keys(value.records).length > 1000) fail("state_invalid");
  for (const [id, r] of Object.entries(value.records)) {
    const previous = state[r.kind === "inspect" ? "inspectionExecutions" : "preparationExecutions"]?.records?.[r.dispatchKey];
    if (!UUID.test(id) || r.executionId !== id || !["inspect", "prepare"].includes(r.kind) || !HASH.test(r.dispatchKey || "") ||
        !HASH.test(r.executionDigest || "") || !previous || previous.executionId !== id || !previous.launchClaimed ||
        previous.task.companyId !== companyId || previous.task.executionDigest !== r.executionDigest ||
        r.resultRef !== previous.resultRef || r.runId !== null && !RUN.test(r.runId) || r.agentId !== null && !UUID.test(r.agentId) ||
        typeof r.dispatchAttempted !== "boolean" || !Number.isSafeInteger(r.createdAt) ||
        r.manifest !== null && (Buffer.byteLength(JSON.stringify(r.manifest)) > 65536 || !r.agentId) ||
        r.delivered !== null && (!r.agentId || r.delivered.executionId !== id || !["succeeded", "failed"].includes(r.delivered.state) ||
          r.delivered.termination?.proved !== true || r.delivered.termination.descendants !== 0 || !HASH.test(r.delivered.termination.proofId || ""))) fail("state_invalid");
  }
  return value;
}
function createWorkflowPrivateJournal({ store, owner, clock = Date.now }) {
  if (!isImportUploadPostgresStore(store) || !UUID.test(owner?.companyId || "") || !UUID.test(owner?.userId || "")) fail("configuration_invalid");
  async function update(fn) { return store.update(owner.companyId, state => {
    const value = state.workflowExecutions || { schema: 1, records: {} };
    validateWorkflowPrivateState(value, owner.companyId, state); const result = fn(value, state);
    validateWorkflowPrivateState(value, owner.companyId, state); state.workflowExecutions = value; return result;
  }); }
  function exact(value, id) { if (!UUID.test(id || "") || !value.records[id]) fail("not_found"); return value.records[id]; }
  function source(state, r) { const p = state[r.kind === "inspect" ? "inspectionExecutions" : "preparationExecutions"].records[r.dispatchKey];
    if (p.task.userId !== owner.userId) fail("owner_invalid"); return p; }
  const journal = Object.freeze({
    owner: Object.freeze({ companyId: owner.companyId, userId: owner.userId }),
    async register(task, ids, kind) { return update((value, state) => {
      const old = state[kind === "inspect" ? "inspectionExecutions" : "preparationExecutions"]?.records?.[task.dispatchKey];
      if (!old || !old.launchClaimed || old.completion || old.executionId !== ids.executionId || !isDeepStrictEqual(old.task, task) ||
          task.userId !== owner.userId || task.companyId !== owner.companyId || task.deadlineAt <= clock()) fail("unclaimed");
      let r = value.records[ids.executionId];
      if (r) return { registered: false, record: r };
      r = { executionId: ids.executionId, kind, dispatchKey: task.dispatchKey, executionDigest: task.executionDigest,
        resultRef: old.resultRef, runId: null, agentId: null, dispatchAttempted: false, manifest: null, delivered: null, createdAt: clock() };
      value.records[r.executionId] = r; return { registered: true, record: r };
    }); },
    async get(id) { return update((value, state) => { const r = exact(value, id); return { ...r, task: source(state, r).task }; }); },
    async records() { return update((value, state) => Object.values(value.records).map(r => ({ ...r, task: source(state, r).task }))); },
    async attempt(id) { return update(value => { const r = exact(value, id); if (r.dispatchAttempted) return false; r.dispatchAttempted = true; return true; }); },
    async setRun(id, runId) { if (!RUN.test(runId || "")) fail("run_invalid"); return update(value => { const r = exact(value, id);
      if (!r.dispatchAttempted || r.runId && r.runId !== runId) fail("run_conflict"); r.runId = runId; return r; }); },
    async claim(id, agentId) { if (!UUID.test(agentId || "")) fail("claim_invalid"); return update((value, state) => {
      const r = exact(value, id), prior = source(state, r);
      if (!r.dispatchAttempted || prior.completion || prior.task.deadlineAt <= clock() || r.agentId && r.agentId !== agentId) fail("claim_conflict");
      r.agentId = agentId; return { ...r, task: prior.task };
    }); },
    async manifest(id, agentId, manifest) { return update((value, state) => { const r = exact(value, id);
      if (r.agentId !== agentId || r.delivered || source(state, r).task.deadlineAt <= clock()) fail("stale");
      if (r.manifest && !isDeepStrictEqual(r.manifest, manifest)) fail("manifest_conflict"); r.manifest = manifest; return r;
    }); },
    async deliver(id, agentId, delivered) { return update((value, state) => { const r = exact(value, id);
      if (r.agentId !== agentId) fail("claim_conflict");
      if (r.delivered) { if (!isDeepStrictEqual(r.delivered, delivered)) fail("result_conflict"); return r.delivered; }
      if (source(state, r).task.deadlineAt <= clock() || delivered.executionId !== id || delivered.resultRef && delivered.resultRef !== r.resultRef) fail("stale");
      r.delivered = delivered; return delivered;
    }); }
  }); stores.add(journal); return journal;
}
module.exports = { createWorkflowPrivateJournal, validateWorkflowPrivateState, isWorkflowPrivateJournal: x => stores.has(x), UUID, HASH, RUN, fail };
