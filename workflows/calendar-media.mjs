// Candidate Workflow start command: node workflows/calendar-media.mjs
// Registration has no paid side effect locally. Real task dispatch is external.
import { task } from "@renderinc/sdk/workflows";
import fs from "node:fs/promises";
import path from "node:path";
import executorModule from "../src/social/calendar/imports/media-process-executor.js";
import agentModule from "../src/social/calendar/imports/workflow-task-agent.js";
import transferModule from "../src/social/calendar/imports/workflow-private-transfer.js";
let initialized;
async function runtime() {
  const root = process.env.IA4TUBE_WORKFLOW_ROOT;
  const origin = process.env.IA4TUBE_WORKFLOW_PRIVATE_ORIGIN;
  const encoded = process.env.IA4TUBE_WORKFLOW_BRIDGE_KEY_BASE64;
  if (process.platform !== "linux" || !path.isAbsolute(root || "") || !/^[A-Za-z0-9+/]{43}=$/.test(encoded || "")) throw Error("workflow_configuration_invalid");
  const key = Buffer.from(encoded, "base64");
  const work = path.join(root, "work"), executions = path.join(root, "executions");
  for (const p of [root, work, executions]) await fs.mkdir(p, { mode: 0o700 }).catch(e => { if (e.code !== "EEXIST") throw Error("workflow_directory_invalid"); });
  const executor = executorModule.createMediaProcessExecutor({ workingRoot: executions, allowedRoots: [work], ffmpegPath: process.env.IA4TUBE_WORKFLOW_FFMPEG_PATH,
    memoryBytes: 512 * 1024 ** 2, linuxRuntime: { cgroupRoot: process.env.IA4TUBE_WORKFLOW_CGROUP_ROOT, launchMode: "direct", validationOnly: true } });
  await executor.prepareRuntime(); // cgroupv2, tree kill, limits and parent death probe; fail closed if unavailable.
  const agent = agentModule.createWorkflowTaskAgent({ workingRoot: work, executor });
  return { agent, clientForExecution: executionId => transferModule.createWorkflowPrivateClient({ origin, key, executionId }) };
}
task({ name: "prepareCalendarMedia", retry: { maxRetries: 0 }, timeoutSeconds: 180, plan: "flex" }, async (_context, input) => {
  if (!input || Object.keys(input).length !== 1 || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(input.executionId || "")) return { state: "invalid_request" };
  try { const r = await (initialized ||= runtime()); return r.agent.run(r.clientForExecution(input.executionId)); }
  catch (_) { return { executionId: input.executionId, state: "reconciliation_required" }; }
});
