"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const { createRenderWorkflowAdapter, createControlledRenderWorkflowAdapter, isRenderWorkflowAdapter } = require("../src/social/calendar/imports/render-workflow-adapter");
const { createWorkflowPrivateClient } = require("../src/social/calendar/imports/workflow-private-transfer");
const { registerWorkflowTask } = require("../src/social/calendar/imports/workflow-task-agent");
const { createWorkflowOperationalComponents } = require("../src/social/calendar/imports/workflow-operational-components");
test("Workflow composition accepts only literal true activation and never probes a disabled store", async () => {
  let touched = 0; const store = { verify() { touched++; throw Error("must_not_call"); } };
  for (const enabled of [undefined, false, "false", "true", 1, {}]) assert.deepEqual(await createWorkflowOperationalComponents({ enabled, store }), { available: false, reason: "workflow_disabled" });
  assert.equal(touched, 0);
});
function fixture(overrides = {}) { const calls = [], executionId = crypto.randomUUID(), runId = "trn-synthetic123", row = { id: runId, input: [{ executionId }], status: "completed", retries: 0 };
  const sdkClient = { workflows: {
    async startTask(...args) { calls.push(args); return { taskRunId: runId }; }, async getTaskRun() { return structuredClone(row); },
    async listTaskRuns() { return [{ taskRun: { id: runId }, cursor: "cursor" }]; }, async cancelTaskRun() {}, ...overrides } };
  return { calls, executionId, runId, row, sdkClient, adapter: createControlledRenderWorkflowAdapter({ sdkClient }) };
}
test("official SDK pinned module exposes actual documented client methods without requests", async () => {
  const adapter = await createRenderWorkflowAdapter({ token: "synthetic-not-a-real-render-token", taskSlug: "synthetic-media/prepareCalendarMedia" });
  assert.equal(isRenderWorkflowAdapter(adapter), true); assert.equal(adapter.capabilities.officialSdkContract, "1.1.0");
});
test("SDK start sends one opaque identity only, no guessed API/body/idempotency parameter", async () => {
  const f = fixture(); assert.equal(await f.adapter.start(f.executionId), f.runId);
  assert.deepEqual(f.calls[0].slice(0, 2), ["synthetic-media/prepareCalendarMedia", [{ executionId: f.executionId }]]);
  assert.ok(f.calls[0][2] instanceof AbortSignal);
  assert.equal(isRenderWorkflowAdapter(f.adapter), false); assert.equal(isRenderWorkflowAdapter(f.adapter, { allowControlledForTests: true }), true);
  assert.equal(isRenderWorkflowAdapter({ ...f.adapter }, { allowControlledForTests: true }), false);
});
test("lost response never retries start and exact read-only observation recovers run", async () => {
  let starts = 0; const f = fixture({ async startTask() { starts++; throw Error("synthetic_lost"); } });
  await assert.rejects(() => f.adapter.start(f.executionId), /dispatch_uncertain/); assert.equal(starts, 1);
  assert.deepEqual(await f.adapter.observe(f.executionId), { runId: f.runId, status: "completed", terminal: true }); assert.equal(starts, 1);
});
test("foreign run, duplicate lookup match and retry attempt never produce terminal proof", async () => {
  const f = fixture(); f.row.input[0].executionId = crypto.randomUUID(); assert.equal((await f.adapter.observe(f.executionId, f.runId)).terminal, false);
  f.row.input[0].executionId = f.executionId; f.row.retries = 1; assert.equal((await f.adapter.observe(f.executionId, f.runId)).terminal, false);
  const doubled = fixture({ async listTaskRuns() { return [{ taskRun: { id: "trn-synthetic123" } }, { taskRun: { id: "trn-synthetic123" } }]; } });
  assert.equal((await doubled.adapter.observe(doubled.executionId)).terminal, false);
});
test("cancel request does not claim task or native tree termination", async () => {
  const f = fixture(); assert.deepEqual(await f.adapter.cancel(f.runId), { requested: true, terminationProved: false });
});
test("hanging SDK reads return uncertain on bounded wait without issuing a replacement", async () => {
  const f = fixture({ async getTaskRun() { return new Promise(() => {}); } });
  const adapter = createControlledRenderWorkflowAdapter({ sdkClient: f.sdkClient, requestTimeoutMs: 25 });
  const started = performance.now(); assert.equal((await adapter.observe(f.executionId, f.runId)).terminal, false);
  assert.ok(performance.now() - started < 500); assert.equal(f.calls.length, 0);
});
test("private client rejects public HTTP, credentials/query redirects and arbitrary destinations", () => {
  const options = { key: crypto.randomBytes(32), executionId: crypto.randomUUID() };
  for (const origin of ["http://service.internal", "http://example.com", "https://user:pass@example.com", "https://example.com/?token=x", "file:///private"]) {
    assert.throws(() => createWorkflowPrivateClient({ ...options, origin }), /origin_invalid/);
  }
  assert.throws(() => createWorkflowPrivateClient({ ...options, origin: "http://127.0.0.1" }), /origin_invalid/);
  assert.ok(createWorkflowPrivateClient({ ...options, origin: "http://127.0.0.1", allowLoopbackForTests: true }));
});
test("registered task uses Flex, fixed180 seconds, zero provider retry and fixed payload", async () => {
  let config, fn, calls = 0;
  registerWorkflowTask({ task: (c, f) => { config = c; fn = f; }, agent: { async run() { calls++; return { state: "delivered" }; } }, clientForExecution: id => ({ id }) });
  assert.deepEqual(config, { name: "prepareCalendarMedia", retry: { maxRetries: 0 }, timeoutSeconds: 180, plan: "flex" });
  assert.deepEqual(await fn({}, { executionId: crypto.randomUUID(), url: "https://example.com" }), { state: "invalid_request" }); assert.equal(calls, 0);
  assert.deepEqual(await fn({}, { executionId: crypto.randomUUID() }), { state: "delivered" }); assert.equal(calls, 1);
});
