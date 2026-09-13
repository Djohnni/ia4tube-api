"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const { createWorkflowOperationalComponents } = require("../src/social/calendar/imports/workflow-operational-components");
const { createVmCoordinator, vmHostProved } = require("../src/social/calendar/imports/vm-coordinator");
const { createVmPullClient } = require("../src/social/calendar/imports/vm-pull-transport");
const { validateWorkflowPrivateState, executionTransport, transportIdentity } = require("../src/social/calendar/imports/workflow-private-journal");
test("VM transport: defaults closed, plain capability booleans cannot certify installed host, TLS never relaxed", async () => {
  let reads = 0; const store = { verify() { reads++; throw Error("unexpected"); } };
  for (const enabled of [undefined, false, "false", "true", 1, null]) {
    assert.equal((await createWorkflowOperationalComponents({ enabled, store })).available, false);
    assert.equal((await createVmCoordinator({ enabled })).available, false);
  }
  assert.equal(reads, 0); assert.equal(vmHostProved({ capabilities: { hardTermination: true, linuxCapabilitiesProved: { readIsolatedRoot: true, distinctCodecUid: true, installedLauncher: true, aggregateScratchQuotaBytes: 3221225472 } } }), false);
  const input = { key: crypto.randomBytes(32), workerId: crypto.randomUUID(), runtimeRevision: "a".repeat(64) };
  for (const origin of ["http://127.0.0.1:1234", "https://user:secret@example.com", "https://example.com/anything", "https://example.com/?secret=yes"]) assert.throws(() => createVmPullClient({ ...input, origin }), /origin_invalid/);
  assert.throws(() => createVmPullClient({ ...input, origin: "http://example.com", allowLoopbackForTests: true }), /origin_invalid/);
});
test("VM transport: historical Render journal remains readable without rewriting; VM cannot carry trn or unbound terminal", () => {
  const executionId = crypto.randomUUID(), companyId = crypto.randomUUID(), userId = crypto.randomUUID(), dispatchKey = "a".repeat(64), executionDigest = "b".repeat(64);
  const previous = { executionId, launchClaimed: true, task: { companyId, userId, executionDigest }, resultRef: null };
  const r = { executionId, kind: "inspect", dispatchKey, executionDigest, resultRef: null, runId: "trn-historical123", agentId: null,
    dispatchAttempted: true, manifest: null, delivered: null, createdAt: 1 };
  const state = { inspectionExecutions: { records: { [dispatchKey]: previous } } }, document = { schema: 1, records: { [executionId]: r } };
  const before = JSON.stringify(document); validateWorkflowPrivateState(document, companyId, state);
  assert.deepEqual(executionTransport(r), { kind: "render" }); assert.equal(JSON.stringify(document), before);
  const vm = transportIdentity({ kind: "vm", workerId: crypto.randomUUID(), runtimeRevision: "c".repeat(64) });
  r.transport = vm; r.vmOffer = null; r.vmTerminal = null;
  assert.throws(() => validateWorkflowPrivateState(document, companyId, state), /state_invalid/);
  r.runId = null; validateWorkflowPrivateState(document, companyId, state);
  r.vmTerminal = { proofId: "d".repeat(64) }; assert.throws(() => validateWorkflowPrivateState(document, companyId, state), /state_invalid/);
  assert.throws(() => transportIdentity({ kind: "vm", workerId: vm.workerId, runtimeRevision: vm.runtimeRevision, ready: true }), /transport_invalid/);
});
test("VM entry: installed immutable runtime revision must match configuration before key read or polling", () => {
  const { validateRuntimeRevision } = require("../workflows/calendar-media-vm.cjs");
  const revision = "a".repeat(64);
  assert.equal(validateRuntimeRevision({ runtimeRevision: revision }, { schema: 1, runtimeRevision: revision }), revision);
  for (const [config, manifest] of [
    [{ runtimeRevision: revision }, { schema: 1, runtimeRevision: "b".repeat(64) }],
    [{}, { schema: 1 }], [{ runtimeRevision: null }, { schema: 1, runtimeRevision: null }],
    [{ runtimeRevision: "short" }, { schema: 1, runtimeRevision: "short" }],
    [{ runtimeRevision: revision }, { schema: 2, runtimeRevision: revision }]
  ]) assert.throws(() => validateRuntimeRevision(config, manifest), /runtime_revision_conflict/);
});
test("VM fixture: readiness receipt binds the separate host PID and requires actual termination/installed proof fields", () => {
  const { assertVmHostReceipt } = require("./helpers/vm-private-pipeline-fixture");
  // Pure receipt-schema contract; the physical suite supplies the actual
  // message from the forked process after native prepareRuntime succeeds.
  const pid = process.pid + 10000, receipt = { type: "ready", pid, isolatedEnvironment: true, hardTermination: true, installedHost: true };
  assert.doesNotThrow(() => assertVmHostReceipt(receipt, pid, true));
  for (const changed of [{ pid: pid + 1 }, { type: "pending" }, { hardTermination: false }, { isolatedEnvironment: false }, { installedHost: false }])
    assert.throws(() => assertVmHostReceipt({ ...receipt, ...changed }, pid, true));
  assert.throws(() => assertVmHostReceipt(receipt, process.pid, true));
  assert.throws(() => assertVmHostReceipt(undefined, pid, false));
});
