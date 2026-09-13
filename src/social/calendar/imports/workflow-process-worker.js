"use strict";
const { isWorkflowPrivateBridge } = require("./workflow-private-transfer");
const { isRenderWorkflowAdapter } = require("./render-workflow-adapter");
const { fail } = require("./workflow-private-journal");
const workers = new WeakSet();
function createWorkflowProcessWorker({ bridge, adapter, allowControlledForTests = false, validationOnly = false } = {}) {
  if (!isWorkflowPrivateBridge(bridge) || !isRenderWorkflowAdapter(adapter, { allowControlledForTests }) ||
      !allowControlledForTests && validationOnly !== true || allowControlledForTests && !adapter.capabilities.controlled) fail("configuration_invalid");
  async function observe(task, { executionId } = {}) {
    const r = await bridge.journal.get(executionId);
    if (r.dispatchKey !== task.dispatchKey || r.executionDigest !== task.executionDigest) fail("binding_conflict");
    const remote = await adapter.observe(executionId, r.runId);
    if (remote.runId && !r.runId) await bridge.journal.setRun(executionId, remote.runId);
    const delivered = r.delivered || await bridge.recover(executionId).catch(() => null);
    if (remote.terminal && delivered?.termination?.proved && delivered.termination.descendants === 0) return delivered;
    // Task completion/cancel acknowledgement alone is not OS/media proof.
    return { executionId, state: "unknown" };
  }
  async function run(kind, task, ids) {
    await bridge.journal.register(task, ids, kind);
    if (await bridge.journal.attempt(ids.executionId)) {
      try { const id = await adapter.start(ids.executionId); await bridge.journal.setRun(ids.executionId, id); }
      catch (_) { return { executionId: ids.executionId, state: "unknown" }; }
    }
    return observe(task, ids);
  }
  const worker = Object.freeze({ capabilities: Object.freeze({ actualPreparation: true, actualByteDecoding: true, hardTermination: true,
    // hardTermination is the mandatory receipt contract, not a Render-host
    // attestation. No caller boolean may mark this candidate production ready.
    remoteWorkflowVerified: false, terminationProofRequired: true, validationOnly: true,
    controlled: allowControlledForTests, readyForProduction: false }),
    execute: (task, ids) => run("prepare", task, ids), inspect: (task, ids) => run("inspect", task, ids), observe });
  workers.add(worker); return worker;
}
module.exports = { createWorkflowProcessWorker, isWorkflowProcessWorker: v => workers.has(v) };
