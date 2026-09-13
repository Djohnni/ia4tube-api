"use strict";
// Real independent coordinator process; only synthetic configuration is carried
// by IPC. No database/provider/admin key is present in its environment.
const { createMediaProcessExecutor } = require("../../src/social/calendar/imports/media-process-executor");
const { createVmCoordinator, vmHostProved } = require("../../src/social/calendar/imports/vm-coordinator");
let options, executor, coordinator, key, active, stopping = false;
const send = value => { if (process.connected) process.send(value); };
async function shutdown() {
  stopping = true; if (active) await active;
  const proof = coordinator ? await coordinator.close() : { nativeTerminationProved: false };
  send({ type: "shutdown_proof", ...proof }); key?.fill(0); if (process.connected) process.disconnect();
}
process.on("message", async message => {
  if (message.type === "initialize" && !options && !stopping) {
    options = message.options;
    try {
      key = Buffer.from(options.keyBase64, "base64"); delete options.keyBase64;
      executor = createMediaProcessExecutor({ workingRoot: options.executorRoot, ffmpegPath: options.ffmpegPath, allowedRoots: [options.workingRoot],
        ...(options.linuxRuntime ? { linuxRuntime: options.linuxRuntime } : {}) }); await executor.prepareRuntime();
      if (options.requireInstalledProof && !vmHostProved(executor)) throw Error("installed_proof_missing");
      coordinator = await createVmCoordinator({ enabled: true, ...options, executor, key, allowControlledForTests: true,
        diagnostic: code => send({ type: "diagnostic", code }) });
      send({ type: "ready", pid: process.pid, hardTermination: executor.capabilities.hardTermination, installedHost: vmHostProved(executor),
        isolatedEnvironment: ["DATABASE_URL", "PGPASSWORD", "INSTAGRAM_APP_SECRET", "RENDER_API_KEY", "DIGITALOCEAN_TOKEN", "NODE_OPTIONS"].every(k => process.env[k] === undefined) });
    } catch (_) { send({ type: "initialization_failed" }); process.exitCode = 1; process.disconnect(); }
  } else if (message.type === "tick" && coordinator && !stopping) {
    active ||= coordinator.tick().finally(() => { active = undefined; });
    try { send({ type: "result", callId: message.callId, result: await active }); }
    catch (_) { send({ type: "result", callId: message.callId, result: { state: "failed_closed" } }); }
  } else if (message.type === "shutdown" && !stopping) await shutdown();
});
