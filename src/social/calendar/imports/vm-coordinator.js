"use strict";
const fs = require("node:fs/promises"), path = require("node:path"), crypto = require("node:crypto"), { isDeepStrictEqual } = require("node:util");
const { isMediaProcessExecutor, safePath, immutableJson, readJson } = require("./media-process-executor");
const { createWorkflowPrivateClient } = require("./workflow-private-transfer");
const { createWorkflowTaskAgent } = require("./workflow-task-agent");
const { createVmPullClient } = require("./vm-pull-transport");
const { UUID, HASH, fail } = require("./workflow-private-journal");
async function syncDirectory(root) { if (process.platform === "win32") return; const handle = await fs.open(root, "r"); try { await handle.sync(); } finally { await handle.close(); } }
async function persist(file, value) { try { await immutableJson(file, value); }
  catch (e) { if (e.code !== "EEXIST" || !isDeepStrictEqual(await readJson(file), value)) throw e; } await syncDirectory(path.dirname(file)); }
function vmHostProved(executor) {
  const c = executor?.capabilities?.linuxCapabilitiesProved;
  return Boolean(isMediaProcessExecutor(executor) && executor.capabilities.hardTermination && c?.readIsolatedRoot === true && c.distinctCodecUid === true &&
    c.aggregateScratchQuotaBytes === 3221225472 && c.installedLauncher === true);
}
async function createVmCoordinator({ enabled = false, stateRoot, workingRoot, executor, workerId, runtimeRevision, bootId, origin, key,
  allowControlledForTests = false, diagnostic = () => {}, clock = Date.now } = {}) {
  if (enabled !== true) return Object.freeze({ available: false, reason: "vm_disabled" });
  if (![workerId, bootId].every(v => UUID.test(v || "")) || !HASH.test(runtimeRevision || "") || !path.isAbsolute(stateRoot || "") ||
    !path.isAbsolute(workingRoot || "") || path.resolve(stateRoot) === path.resolve(workingRoot) || !isMediaProcessExecutor(executor) ||
    !(vmHostProved(executor) || allowControlledForTests === true && executor.capabilities.hardTermination)) fail("vm_host_unproved");
  // Branded native runtime is still mandatory in controlled tests. Production
  // cannot manufacture the installed-host proof through a caller boolean.
  const control = createVmPullClient({ origin, key, workerId, runtimeRevision, allowLoopbackForTests: allowControlledForTests });
  const root = path.resolve(stateRoot), work = path.resolve(workingRoot);
  await safePath(root); await safePath(work);
  if (!path.relative(root, work).startsWith("..") || !path.relative(work, root).startsWith("..")) fail("vm_roots_overlap");
  for (const name of ["requests", "offers", "done"]) { await fs.mkdir(path.join(root, name), { mode: 0o700 }).catch(e => { if (e.code !== "EEXIST") throw e; }); await safePath(path.join(root, name)); }
  await persist(path.join(root, "identity.json"), { schema: 1, workerId, runtimeRevision });
  const agent = createWorkflowTaskAgent({ workingRoot: work, executor, allowSyntheticForTests: allowControlledForTests, diagnostic, clock });
  let active, stopping = false;
  async function optional(file) { try { return await readJson(file); } catch (e) { if (e.code === "ENOENT") return null; throw e; } }
  async function unfinished() {
    const entries = await fs.readdir(path.join(root, "requests")); if (entries.length > 1000) fail("vm_journal_full");
    const pending = [];
    for (const name of entries) {
      if (!UUID.test(name.slice(0, -5)) || !name.endsWith(".json")) fail("vm_journal_invalid");
      const record = await readJson(path.join(root, "requests", name));
      if (!record || Object.keys(record).sort().join() !== "agentId,createdBootId,requestId" || record.requestId + ".json" !== name ||
        !Object.values(record).every(v => UUID.test(v || ""))) fail("vm_journal_invalid");
      const done = await optional(path.join(root, "done", name));
      if (done) { if (done.requestId !== record.requestId || !UUID.test(done.executionId || "")) fail("vm_journal_invalid"); }
      else pending.push(record);
    }
    if (pending.length > 1) fail("vm_journal_conflict");
    if (pending.length) return pending[0];
    if (entries.length >= 1000) fail("vm_journal_full");
    const record = { requestId: crypto.randomUUID(), agentId: crypto.randomUUID(), createdBootId: bootId };
    await persist(path.join(root, "requests", record.requestId + ".json"), record); return record;
  }
  async function operate() {
    if (stopping) return { state: "stopped" };
    const request = await unfinished(), file = request.requestId + ".json";
    let offer;
    try { offer = await control.poll({ requestId: request.requestId, agentId: request.agentId, bootId }); }
    catch (_) { return { state: "unconfirmed", requestId: request.requestId }; }
    if (!offer || offer.blocked) return { state: offer?.blocked ? "blocked" : "idle", requestId: request.requestId };
    const binding = { requestId: request.requestId, executionId: offer.executionId, agentId: request.agentId, offerBootId: offer.offerBootId };
    const old = await optional(path.join(root, "offers", file));
    await persist(path.join(root, "offers", file), binding);
    if (!offer.terminal) {
      const client = createWorkflowPrivateClient({ origin, key, executionId: offer.executionId, agentId: request.agentId, allowLoopbackForTests: allowControlledForTests });
      const result = await agent.run(client, { recoveryOnly: Boolean(old) || offer.recoveryOnly });
      if (result.state !== "delivered") return { state: "reconciliation_required", executionId: offer.executionId };
      try { await control.done({ executionId: offer.executionId, agentId: request.agentId, bootId, offerBootId: offer.offerBootId }); }
      catch (_) { return { state: "unconfirmed", executionId: offer.executionId }; }
    }
    await persist(path.join(root, "done", file), { requestId: request.requestId, executionId: offer.executionId });
    return { state: "delivered", executionId: offer.executionId };
  }
  function tick() { if (active) return active; active = operate().finally(() => { active = undefined; }); return active; }
  return Object.freeze({ available: true, readyForProduction: false, validationOnly: true, workerId, runtimeRevision, bootId, tick,
    async close() {
      stopping = true; if (active) await active;
      const entries = await fs.readdir(path.join(root, "offers")); let checked = 0, proved = true;
      for (const name of entries) { const offer = await readJson(path.join(root, "offers", name));
        if (!UUID.test(offer.executionId || "")) fail("vm_journal_invalid");
        const observation = await executor.observe(offer.executionId); checked++;
        if (observation.termination?.proved !== true || observation.termination.descendants !== 0) proved = false;
        const aggregate = await executor.terminationProof(offer.executionId); if (!aggregate?.proved || aggregate.descendants !== 0) proved = false;
      }
      // This does not remove media or release API reservations. An unknown
      // native receipt preserves both the disk evidence and capacity hold.
      return { stopped: true, nativeTerminationProved: proved, executionsChecked: checked };
    } });
}
module.exports = { createVmCoordinator, vmHostProved, persist };
