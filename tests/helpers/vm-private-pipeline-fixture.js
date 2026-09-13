"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), crypto = require("node:crypto"), http = require("node:http"), { fork } = require("node:child_process");
const imports = "../../src/social/calendar/imports/";
const { createWorkflowOperationalComponents } = require(imports + "workflow-operational-components");
const { createVmPullClient } = require(imports + "vm-pull-transport");
const { createWorkflowPrivateClient } = require(imports + "workflow-private-transfer");
const { FFMPEG } = require("./operational-private-pipeline-fixture");
async function configureVmPrivatePipeline(t, f, options = {}) {
  const suffix = crypto.randomBytes(5).toString("hex"), remoteRoot = path.join(f.pg.root, "vm-" + suffix);
  const installed = process.env.CALENDAR_VM_INSTALLED_TEST === "1";
  const work = installed ? "/var/lib/ia4tube-media/work/data/test-" + suffix : path.join(remoteRoot, "w");
  const exec = installed ? "/var/lib/ia4tube-media/work/executions" : path.join(remoteRoot, "e");
  const stateRoot = installed ? "/var/lib/ia4tube-media/state/test-" + suffix : path.join(remoteRoot, "s");
  for (const p of [remoteRoot, work, exec, stateRoot]) await fs.mkdir(p, { recursive: true, mode: 0o700 });
  const key = crypto.randomBytes(32), workerId = crypto.randomUUID(), runtimeRevision = crypto.createHash("sha256").update("synthetic-runtime-vm-1").digest("hex");
  let components, host, shutdownProof, hostExited, closeHostPromise, closed = false, loseOffer = false, loseDone = false, corruptPart = false;
  let bootId = crypto.randomUUID(); const events = [], hosts = [];
  const server = http.createServer(async (req, res) => {
    // A real committed response is lost at the socket, after the actual router
    // transaction. No mocked journal or fabricated termination receipt.
    const action = req.url;
    if (corruptPart && /\/part\/[a-f0-9]{64}$/.test(action)) {
      corruptPart = false; const iterator = req[Symbol.asyncIterator].bind(req);
      req[Symbol.asyncIterator] = async function* () { let changed = false; for await (const chunk of { [Symbol.asyncIterator]: iterator }) {
        const bytes = Buffer.from(chunk); if (!changed && bytes.length) { bytes[0] ^= 1; changed = true; } yield bytes;
      } }; events.push({ kind: "synthetic_part_corrupted" });
    }
    if ((loseOffer && action.endsWith("/vm/poll")) || (loseDone && action.endsWith("/vm/done"))) {
      const end = res.end; res.end = function (...args) { const bytes = args[0]?.toString() || "";
        if (action.endsWith("/poll") && bytes.includes("executionId") || action.endsWith("/done") && bytes.includes('"terminal":true')) {
          if (action.endsWith("/poll")) loseOffer = false; else loseDone = false;
          events.push({ kind: "lost_response", action: action.endsWith("/poll") ? "poll" : "done" }); res.destroy(); return res;
        } return end.apply(this, args); };
    }
    if (!components || !(await components.handlePrivateRequest(req, res))) { res.writeHead(404); res.end(); }
  });
  server.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const control = createVmPullClient({ origin, key, workerId, runtimeRevision, allowLoopbackForTests: true });
  async function mount() {
    components = await createWorkflowOperationalComponents({ enabled: true, store: f.store, owner: f.context, capacity: f.capacity,
      sourceAdmission: f.sourceAdmission, preparedAdmission: f.preparedAdmission, accessPolicy: f.accessPolicy, diskSpaceGuard: f.guard,
      privateRoot: f.privateRoot, preparationRoot: f.preparationRoot, publicApiOrigin: "https://ia4tube-api.onrender.com", musicRoot: f.musicRoot,
      resolveMusicTrack: async id => f.catalog.has(id) ? { filePath: path.join(f.musicRoot, "local-tone.wav"), sha256: f.catalog.get(id).sha256, synthetic: true } : null,
      catalog: f.catalog, bridgeKey: key, validationOnly: true, allowControlledForTests: true, clock: f.clock,
      executionTransport: { kind: "vm", workerId, runtimeRevision }, diagnostic: code => t.diagnostic("VM_TRANSFER_CODE=" + code) });
    const { resultStore: preparedStore, preparationRunner, inspectionRunner, inspector, provider, upload, preparation } = components;
    Object.assign(f, { preparedStore, preparationRunner, inspectionRunner, inspector, provider, upload, preparation });
  }
  const pending = new Map();
  async function launchHost() {
    shutdownProof = undefined; closeHostPromise = undefined;
    host = fork(path.join(__dirname, "vm-private-task-host.js"), [], { execArgv: [], windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: process.platform === "win32" ? { SystemRoot: process.env.SystemRoot, TEMP: remoteRoot, TMP: remoteRoot } : { LANG: "C", LC_ALL: "C", TMPDIR: remoteRoot } });
    hosts.push(host.pid); hostExited = new Promise(resolve => host.once("exit", resolve));
    let readyResolve, readyReject; const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    host.on("message", message => {
      if (message.type === "ready") readyResolve(message);
      else if (message.type === "initialization_failed") readyReject(Error("vm_fixture_initialization_failed"));
      else if (message.type === "shutdown_proof") shutdownProof = message;
      else if (message.type === "diagnostic") t.diagnostic("VM_AGENT_CODE=" + message.code);
      else if (message.type === "result") { events.push({ kind: "tick", ...message.result }); pending.get(message.callId)?.resolve(message.result); pending.delete(message.callId); }
    });
    host.once("error", readyReject); host.once("exit", () => { for (const p of pending.values()) p.reject(Error("vm_fixture_host_lost")); pending.clear(); });
    host.send({ type: "initialize", options: { stateRoot, workingRoot: work, executorRoot: exec, origin, workerId, runtimeRevision, bootId, keyBase64: key.toString("base64"),
      ffmpegPath: installed ? "/opt/ia4tube-media/runtime/usr/bin/ffmpeg" : FFMPEG, requireInstalledProof: installed,
      ...(process.platform === "linux" ? { linuxRuntime: { cgroupRoot: installed ? "/sys/fs/cgroup/ia4tube-media-vm" : process.env.CALENDAR_MEDIA_LINUX_CGROUP_ROOT,
        launchMode: installed ? "installed" : process.env.CALENDAR_MEDIA_LINUX_LAUNCH_MODE || "sudo", validationOnly: true } } : {}) } });
    const proof = await ready; assert.notEqual(proof.pid, process.pid); assert.equal(proof.isolatedEnvironment, true); assert.equal(proof.hardTermination, true);
    if (installed) assert.equal(proof.installedHost, true);
  }
  function hostTick() { const callId = crypto.randomUUID(); return new Promise((resolve, reject) => { pending.set(callId, { resolve, reject }); host.send({ type: "tick", callId }); }); }
  async function closeHost() {
    return closeHostPromise ||= (async () => { if (host?.connected) host.send({ type: "shutdown" }); let timer;
      try { await Promise.race([hostExited, new Promise((_, reject) => { timer = setTimeout(() => reject(Error("vm_fixture_termination_unproved")), 190000); })]); }
      finally { clearTimeout(timer); }
      assert.equal(shutdownProof?.nativeTerminationProved, true, "Native proof must exist before deleting the VM fixture");
    })();
  }
  const close = async () => { if (closed) return; await closeHost();
    assert.equal((await f.pg.tenantPool.query("SELECT 1 AS present")).rows[0].present, 1); await fs.stat(f.pg.root);
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); key.fill(0); closed = true;
    t.diagnostic("VM_OS_PROCESS=SEPARATE; DATABASE_ADMIN_INSTAGRAM_ENV=ABSENT; HOST_NATIVE_PROOF_BEFORE_PG_CLEANUP=YES; INSTALLED_HOST=" + (installed ? "PROVED_IN_THIS_RUN" : "NOT_THIS_RUN"));
  };
  f.pg.registerBeforeCleanup(close);
  await mount(); await launchHost();
  const baseReopen = f.reopen;
  f.reopen = async args => { await baseReopen(args); await mount(); };
  async function progress(deadline, read, done) {
    while (f.clock() < deadline) {
      await components.tick(); await hostTick(); await components.tick(); const value = await read(); if (done(value)) return value;
      if (["attention", "rejected"].includes(value.state)) throw Error("vm_fixture_terminal_not_ready");
      await new Promise(resolve => setTimeout(resolve, 100));
    } throw Error("vm_fixture_original_deadline_exhausted");
  }
  f.resolvePendingUpload = async started => { const r = (await components.journal.records()).find(r => r.kind === "inspect" && r.task.uploadId === started.uploadId);
    assert.ok(r); return progress(r.task.deadlineAt, () => f.upload.status(f.context, { uploadId: started.uploadId }), v => v.state === "uploaded"); };
  const finishPrepared = async value => {
    if (!value.status.ready) { const r = (await components.journal.records()).find(r => r.kind === "prepare" && r.task.assetId === value.assetId && r.task.mediaRevision === value.mediaRevision);
      assert.ok(r); value.status = await progress(r.task.deadlineAt, () => f.preparation.status(f.context, { assetId: value.assetId }), v => v.ready === true); }
    value.prepared = (await f.preparation.snapshot(f.context, { assetId: value.assetId, mediaRevision: value.mediaRevision })).result; return value;
  };
  // `workflow` also prevents an unrelated local-executor receipt being logged
  // as the remote host's receipt by the shared diagnostic helper.
  f.workflow = { get journal() { return components.journal; } };
  f.vm = { get journal() { return components.journal; }, get worker() { return components.worker; }, get bridge() { return components.bridge; },
    tick: () => components.tick(), hostTick, finishPrepared, control, events, hosts, stateRoot, work, exec, origin, workerId, runtimeRevision,
    clientFor: (executionId, agentId) => createWorkflowPrivateClient({ origin, key, executionId, agentId, allowLoopbackForTests: true }),
    loseNextOffer() { loseOffer = true; }, loseNextDone() { loseDone = true; }, corruptNextPart() { corruptPart = true; }, close,
    async restartHost({ newBoot = false } = {}) { await closeHost(); if (newBoot) bootId = crypto.randomUUID(); await launchHost(); },
    async requests() { return Promise.all((await fs.readdir(path.join(stateRoot, "requests"))).map(async name => JSON.parse(await fs.readFile(path.join(stateRoot, "requests", name), "utf8")))); }
  };
}
module.exports = { configureVmPrivatePipeline };
