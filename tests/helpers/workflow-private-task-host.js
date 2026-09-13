"use strict";
// Synthetic fixture host. Configuration crosses private IPC, never argv/logs.
// This process has no PostgreSQL pool, database credential or Instagram secret.
const { createMediaProcessExecutor } = require("../../src/social/calendar/imports/media-process-executor");
const { createWorkflowTaskAgent } = require("../../src/social/calendar/imports/workflow-task-agent");
const { createWorkflowPrivateClient } = require("../../src/social/calendar/imports/workflow-private-transfer");
let agent, options, key, active = false, shutdownRequested = false;
function send(value) { if (process.connected) process.send(value); }
process.on("message", async message => {
  if (message?.type === "initialize" && !options) {
    try {
      options = message.options; key = Buffer.from(options.keyBase64, "base64"); delete options.keyBase64;
      const executor = createMediaProcessExecutor({ workingRoot: options.executorRoot, ffmpegPath: options.ffmpegPath, allowedRoots: [options.workingRoot],
        memoryBytes: 512 * 1024 ** 2, ...(options.linuxRuntime ? { linuxRuntime: options.linuxRuntime } : {}) });
      await executor.prepareRuntime();
      agent = createWorkflowTaskAgent({ workingRoot: options.workingRoot, executor, allowSyntheticForTests: options.synthetic === true,
        diagnostic: code => send({ type: "diagnostic", code }) });
      const absent = ["DATABASE_URL", "PGPASSWORD", "INSTAGRAM_APP_SECRET", "RENDER_API_KEY", "NODE_OPTIONS"].every(k => process.env[k] === undefined);
      send({ type: "ready", pid: process.pid, isolatedEnvironment: absent, platform: process.platform, hardTermination: executor.capabilities.hardTermination });
    } catch (_) { send({ type: "initialization_failed" }); process.exitCode = 1; process.disconnect(); }
  } else if (message?.type === "run" && agent && !active) {
    active = true;
    try { const result = await agent.run(createWorkflowPrivateClient({ origin: options.origin, key, executionId: message.executionId, allowLoopbackForTests: true }));
      send({ type: "result", executionId: message.executionId, result }); }
    finally { active = false; if (shutdownRequested) { key?.fill(0); process.disconnect(); } }
  } else if (message?.type === "shutdown") { shutdownRequested = true; if (!active) { key?.fill(0); process.disconnect(); } }
});
process.on("disconnect", () => { key?.fill(0); process.exitCode = 0; });
