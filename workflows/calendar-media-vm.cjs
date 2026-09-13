"use strict";
// Installed operator entry, intentionally not imported by API server startup.
// No provider SDK, DB/Instagram credentials, arbitrary command, or argv path.
const fs = require("node:fs/promises");
const { isDeepStrictEqual } = require("node:util");
const { createMediaProcessExecutor, safePath } = require("../src/social/calendar/imports/media-process-executor");
const { createVmCoordinator, vmHostProved } = require("../src/social/calendar/imports/vm-coordinator");
const CONFIG = "/etc/ia4tube-media/worker.json", KEY = "/etc/ia4tube-media/bridge.key";
async function protectedFile(file, maximum, { publicImmutable = false } = {}) {
  await safePath(file, { file: true }); const st = await fs.stat(file);
  if (st.uid !== 0 || st.mode & 0o022 || (publicImmutable ? st.mode & 0o222 : st.mode & 0o007) || st.size > maximum) throw Error("vm_configuration_unprotected");
  return fs.readFile(file);
}
function validateRuntimeRevision(config, manifest) {
  if (manifest?.schema !== 1 || !/^[a-f0-9]{64}$/.test(config?.runtimeRevision || "") || manifest.runtimeRevision !== config.runtimeRevision) throw Error("vm_runtime_revision_conflict");
  return manifest.runtimeRevision;
}
async function main() {
  if (process.platform !== "linux" || process.getuid() === 0 || process.argv.length !== 2) throw Error("vm_entry_context_invalid");
  const config = JSON.parse((await protectedFile(CONFIG, 8192)).toString("utf8"));
  if (config.schema !== 1 || Object.keys(config).sort().join() !== "apiOrigin,enabled,executorRoot,ffmpegPath,linuxRuntime,pollIntervalMs,runtimeRevision,schema,stateRoot,workRoot,workerId") throw Error("vm_configuration_invalid");
  if (config.enabled !== true) { process.stdout.write("VM_EXECUTOR=DISABLED\n"); return; }
  if (config.workRoot !== "/var/lib/ia4tube-media/work/data" || config.executorRoot !== "/var/lib/ia4tube-media/work/executions" ||
    config.stateRoot !== "/var/lib/ia4tube-media/state" || config.ffmpegPath !== "/opt/ia4tube-media/runtime/usr/bin/ffmpeg" ||
    config.pollIntervalMs !== 5000 || !isDeepStrictEqual(config.linuxRuntime, { cgroupRoot: "/sys/fs/cgroup/ia4tube-media-vm", launchMode: "installed", validationOnly: true })) throw Error("vm_configuration_invalid");
  const manifest = JSON.parse((await protectedFile("/opt/ia4tube-media/installation.json", 4096, { publicImmutable: true })).toString("utf8"));
  validateRuntimeRevision(config, manifest);
  const key = await protectedFile(KEY, 32); if (key.length !== 32) throw Error("vm_key_invalid");
  const bootId = (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  const executor = createMediaProcessExecutor({ workingRoot: config.executorRoot, ffmpegPath: config.ffmpegPath, allowedRoots: [config.workRoot], linuxRuntime: config.linuxRuntime });
  await executor.prepareRuntime(); if (!vmHostProved(executor)) throw Error("vm_installed_host_unproved");
  const coordinator = await createVmCoordinator({ enabled: true, stateRoot: config.stateRoot, workingRoot: config.workRoot, executor,
    workerId: config.workerId, runtimeRevision: config.runtimeRevision, bootId, origin: config.apiOrigin, key });
  let stopping = false, wake; const stop = () => { stopping = true; wake?.(); };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  try {
    while (!stopping) { const result = await coordinator.tick(); process.stdout.write("VM_EXECUTOR=" + result.state.toUpperCase() + "\n");
      if (!stopping) await new Promise(resolve => { const timer = setTimeout(resolve, config.pollIntervalMs); wake = () => { clearTimeout(timer); resolve(); }; }); }
  } finally { const receipt = await coordinator.close(); key.fill(0);
    process.stdout.write("VM_TERMINATION=" + (receipt.nativeTerminationProved ? "PROVED" : "UNCONFIRMED") + "\n");
    if (!receipt.nativeTerminationProved) process.exitCode = 2; }
}
if (require.main === module) main().catch(() => { process.stderr.write("VM_EXECUTOR=UNAVAILABLE\n"); process.exitCode = 1; });
module.exports = { main, protectedFile, validateRuntimeRevision };
