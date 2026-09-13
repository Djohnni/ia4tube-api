"use strict";
// Contract checked against Render's official SDK 1.1.0, 2026-09-13.
// AbortSignal only cancels a request. Never infer remote termination from it.
const { UUID, RUN, fail } = require("./workflow-private-journal");
const real = new WeakSet(), controlled = new WeakSet();
function build(client, taskSlug, testing, requestTimeoutMs = 15000) {
  if (!/^[a-z0-9][a-z0-9-]{0,79}\/prepareCalendarMedia$/.test(taskSlug || "") ||
      !["startTask", "getTaskRun", "listTaskRuns", "cancelTaskRun"].every(k => typeof client?.workflows?.[k] === "function") ||
      !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 15000) fail("sdk_configuration_invalid");
  async function bounded(promise, deadline) { const ms = Math.floor(deadline - performance.now()); if (ms < 1) fail("request_deadline");
    let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error("workflow_request_deadline")), ms); })]); }
    finally { clearTimeout(timer); }
  }
  function matched(run, id) { return RUN.test(run?.id || "") && run.input?.length === 1 && run.input[0]?.executionId === id &&
    Object.keys(run.input[0]).length === 1 && (!run.retries || run.retries === 0); }
  const value = Object.freeze({ capabilities: Object.freeze({ officialSdkContract: "1.1.0", controlled: testing, noStartRetry: true }),
    async start(executionId) { if (!UUID.test(executionId || "")) fail("request_invalid");
      try { const r = await bounded(client.workflows.startTask(taskSlug, [{ executionId }], AbortSignal.timeout(requestTimeoutMs)), performance.now() + requestTimeoutMs); if (!RUN.test(r?.taskRunId || "")) fail("response_invalid"); return r.taskRunId; }
      catch (_) { fail("dispatch_uncertain"); } },
    async observe(executionId, runId) {
      if (!UUID.test(executionId || "") || runId != null && !RUN.test(runId)) fail("request_invalid");
      const deadline = performance.now() + requestTimeoutMs;
      try {
        if (runId) { const r = await bounded(client.workflows.getTaskRun(runId), deadline); if (!matched(r, executionId) || r.id !== runId) fail("run_binding_invalid");
          return { runId, status: r.status, terminal: ["completed", "failed", "canceled"].includes(r.status) }; }
        // Bounded read-only search recovers a lost start acknowledgement. An
        // inconclusive page is NEVER permission to dispatch another run.
        let cursor; const matches = [];
        for (let page = 0; page < 4; page++) {
          if (performance.now() >= deadline) fail("request_deadline");
          const rows = await bounded(client.workflows.listTaskRuns({ taskSlug: [taskSlug], limit: 100, ...(cursor ? { cursor } : {}) }), deadline);
          if (!Array.isArray(rows)) fail("response_invalid");
          for (const row of rows) { if (!RUN.test(row.taskRun?.id || "")) fail("response_invalid");
            if (performance.now() >= deadline) fail("request_deadline");
            const r = await bounded(client.workflows.getTaskRun(row.taskRun.id), deadline); if (matched(r, executionId)) matches.push(r); }
          if (rows.length < 100) break; cursor = rows.at(-1).cursor; if (!cursor) break;
        }
        if (matches.length !== 1) return { status: "unknown", terminal: false };
        const r = matches[0]; return { runId: r.id, status: r.status, terminal: ["completed", "failed", "canceled"].includes(r.status) };
      } catch (_) { return { status: "unknown", terminal: false }; }
    },
    async cancel(runId) { if (!RUN.test(runId || "")) fail("run_invalid"); try { await bounded(client.workflows.cancelTaskRun(runId), performance.now() + requestTimeoutMs); return { requested: true, terminationProved: false }; }
      catch (_) { return { requested: false, terminationProved: false }; } }
  }); (testing ? controlled : real).add(value); return value;
}
async function createRenderWorkflowAdapter({ token, taskSlug }) {
  if (typeof token !== "string" || token.length < 20 || /[\r\n]/.test(token)) fail("configuration_invalid");
  const { Render } = await import("@renderinc/sdk"); return build(new Render({ token }), taskSlug, false);
}
function createControlledRenderWorkflowAdapter({ sdkClient, taskSlug = "synthetic-media/prepareCalendarMedia", requestTimeoutMs = 15000 }) { return build(sdkClient, taskSlug, true, requestTimeoutMs); }
module.exports = { createRenderWorkflowAdapter, createControlledRenderWorkflowAdapter,
  isRenderWorkflowAdapter: (v, { allowControlledForTests = false } = {}) => real.has(v) || allowControlledForTests && controlled.has(v) };
