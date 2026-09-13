"use strict";
// Synthetic fixture host. Configuration crosses private IPC, never argv/logs.
// This process has no PostgreSQL pool, database credential or Instagram secret.
const { createMediaProcessExecutor } = require("../../src/social/calendar/imports/media-process-executor");
const { createWorkflowTaskAgent } = require("../../src/social/calendar/imports/workflow-task-agent");
const { createWorkflowPrivateClient } = require("../../src/social/calendar/imports/workflow-private-transfer");
const fs = require("node:fs/promises");
let agent, executor, options, key, active = false, initializing = false, shutdownRequested = false, shutdownPromise;
function send(value) { if (process.connected) process.send(value); }
function shutdown() {
  shutdownPromise ||= (async () => {
    let proved = true, checked = 0;
    try {
      const names = (await fs.readdir(options.executorRoot)).filter(name => /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(name));
      if (names.length > 512) throw Error("synthetic_execution_count_invalid");
      for (const name of names) { const observed = await executor.observe(name); checked++;
        if (observed.termination?.proved !== true || observed.termination.descendants !== 0) proved = false;
      }
    } catch (_) { proved = false; }
    send({ type: "shutdown_proof", proved, executionsChecked: checked }); key?.fill(0); process.disconnect();
  })(); return shutdownPromise;
}
process.on("message", async message => {
  if (message?.type === "initialize" && !options) {
    initializing = true;
    try {
      options = message.options; key = Buffer.from(options.keyBase64, "base64"); delete options.keyBase64;
      executor = createMediaProcessExecutor({ workingRoot: options.executorRoot, ffmpegPath: options.ffmpegPath, allowedRoots: [options.workingRoot],
        memoryBytes: 512 * 1024 ** 2, ...(options.linuxRuntime ? { linuxRuntime: options.linuxRuntime } : {}) });
      await executor.prepareRuntime();
      agent = createWorkflowTaskAgent({ workingRoot: options.workingRoot, executor, allowSyntheticForTests: options.synthetic === true,
        diagnostic: code => send({ type: "diagnostic", code }) });
      const absent = ["DATABASE_URL", "PGPASSWORD", "INSTAGRAM_APP_SECRET", "RENDER_API_KEY", "NODE_OPTIONS"].every(k => process.env[k] === undefined);
      send({ type: "ready", pid: process.pid, isolatedEnvironment: absent, platform: process.platform, hardTermination: executor.capabilities.hardTermination });
    } catch (_) { send({ type: "initialization_failed" }); process.exitCode = 1; process.disconnect(); }
    finally { initializing = false; if (shutdownRequested && process.connected) await shutdown(); }
  } else if (message?.type === "run" && agent && !active && !initializing && !shutdownRequested) {
    active = true;
    try { const result = await agent.run(createWorkflowPrivateClient({ origin: options.origin, key, executionId: message.executionId, allowLoopbackForTests: true }));
      send({ type: "result", executionId: message.executionId, result }); }
    finally { active = false; if (shutdownRequested) await shutdown(); }
  } else if (message?.type === "shutdown") { shutdownRequested = true; if (!active && !initializing) await shutdown(); }
});
process.on("disconnect", () => { key?.fill(0); process.exitCode = 0; });
