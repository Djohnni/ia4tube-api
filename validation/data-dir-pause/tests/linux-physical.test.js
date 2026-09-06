"use strict";

// Physical Linux test ONLY. All source files, bundle keys and processes below are
// disposable fixtures. No fileSystem/process/controller substitutes are supplied
// to the unchanged implementation. Parent env and production data are not used.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { performance } = require("node:perf_hooks");
const posix = require("./fixtures/posix-evidence");
const processes = require("./fixtures/process-evidence");
const ciOverlay = path.resolve(__dirname, "../overlay");
const overlay = path.resolve(process.env.PAUSE_OVERLAY_ROOT || (fs.existsSync(ciOverlay) ? ciOverlay : path.resolve(__dirname, "../../data-dir-pause-local/overlay")));
const maintenance = path.join(overlay, "src/maintenance");
const worker = path.join(maintenance, "capture-worker.js");
const cli = path.join(maintenance, "pause-cli.js");
const hostFile = path.join(__dirname, "fixtures/control-host.js");
const { SOURCE_FINGERPRINT, WORKER_SHA256, ENVELOPE_SHA256 } = require(path.join(maintenance, "local-control"));
const { withExtractedEncryptedBundle } = require(path.join(maintenance, "recovery/encrypted-backup-bundle"));
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const report = { format: "ia4tube-pause-linux-physical-v1", syntheticOnly: true, networkNamespaceIsolated: false,
  prior113TestsIncluded: false, cases: [], renderDiskEquivalenceProven: false, powerLossDurabilityProven: false,
  realBackupOrProductionAuthorized: false, allOwnedProcessesClosed: false, syntheticFilesRemoved: false };
const liveChildren = new Set(), liveGroups = new Set(), controlDirectories = new Map();
let tarSha, rootIdentity, tempRoot;
function need(value, code) { if (!value) throw new Error(code); }
function hash(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function bounded(promise, timeoutMs, code) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(code)), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}
async function until(fn, timeoutMs = 10000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) { const value = await fn(); if (value) return value; await delay(10); }
  throw new Error("physical_observation_timeout");
}
function env(extra = {}) {
  return { LANG: "C", LC_ALL: "C", TZ: "UTC", IA4TUBE_LINUX_PHYSICAL: "1", DATA_DIR: "/var/data",
    DATA_DIR_PAUSE_ENABLED: "true", DATA_DIR_CAPTURE_TAR_SHA256: tarSha, PAUSE_OVERLAY_ROOT: overlay, ...extra };
}
function childProcess(file, args = [], options = {}) {
  const child = spawn(file, args, { shell: false, env: env(), stdio: ["pipe", "pipe", "pipe"], ...options });
  liveChildren.add(child);
  const output = [], errors = [];
  let bytes = 0, errorBytes = 0;
  child.stdout?.on("data", chunk => { bytes += chunk.length; if (bytes <= 65536) output.push(Buffer.from(chunk)); else child.kill("SIGTERM"); });
  child.stderr?.on("data", chunk => { errorBytes += chunk.length; if (errorBytes <= 65536) errors.push(Buffer.from(chunk)); else child.kill("SIGTERM"); });
  child.stdin?.on("error", () => {});
  child.closed = new Promise(resolve => {
    child.once("error", () => {});
    child.once("close", (code, signal) => {
      liveChildren.delete(child);
      const stdout = Buffer.concat(output).toString("utf8");
      // Classify the expected startup refusal locally; never publish raw stderr
      // or let missing legacy imports masquerade as proof of the first guard.
      const stderrText = Buffer.concat(errors).toString("utf8");
      const markerRefusal = /Error: pause_marker_refused\r?\n/.test(stderrText) &&
        /code: ['"]pause_marker_refused['"]/.test(stderrText) && !/MODULE_NOT_FOUND|Cannot find module/.test(stderrText);
      for (const buffer of [...output, ...errors]) buffer.fill(0);
      resolve({ code, signal, stdout, stderrBytes: errorBytes, markerRefusal,
        outputWithinLimit: bytes <= 65536 && errorBytes <= 65536 });
    });
  });
  return child;
}
async function command(file, args, options) {
  const child = childProcess(file, args, options);
  child.stdin?.end();
  const result = await bounded(child.closed, 30000, "physical_command_timeout");
  need(result.code === 0 && result.stderrBytes === 0 && result.outputWithinLimit, "physical_command_failed");
  return result.stdout;
}
function startCli(pid, packet) {
  const child = childProcess(process.execPath, [cli, "--pid", String(pid)]);
  const wire = Buffer.from(JSON.stringify(packet) + "\n");
  if (Object.hasOwn(packet, "bundleKeyBase64")) packet.bundleKeyBase64 = undefined;
  child.stdin.end(wire, () => wire.fill(0));
  child.response = child.closed.then(result => {
    need(result.outputWithinLimit && result.stderrBytes === 0 && [0, 2].includes(result.code), "physical_cli_process_failed");
    let value; try { value = JSON.parse(result.stdout); } catch (_) { throw new Error("physical_cli_json_invalid"); }
    need(typeof value?.ok === "boolean" && /^(?:local_|pause_cli_)[a-z_]+$/.test(value.code), "physical_cli_response_invalid");
    return value;
  });
  // Abandonment intentionally closes this child. Handle its expected rejection.
  child.response.catch(() => {});
  return child;
}
const request = (host, packet) => startCli(host.child.pid, packet).response;
async function status(host) { const value = await request(host, { command: "status" }); need(value.ok && value.status, "physical_status_failed"); return value.status; }
async function startHost() {
  const child = childProcess(process.execPath, [hostFile], { stdio: ["pipe", "pipe", "pipe", "ipc"] });
  child.stdin.end();
  let counter = 0;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => {
    child.on("message", value => {
      if (value?.ready === true) resolve(value);
      else if (value?.ready === false) reject(new Error("physical_host_start_failed"));
      else if (pending.has(value?.id)) { const resolveRequest = pending.get(value.id); pending.delete(value.id); resolveRequest(value); }
    });
    child.closed.then(() => reject(new Error("physical_host_closed_before_ready")));
  });
  const metadata = await bounded(ready, 10000, "physical_host_start_timeout");
  need(metadata.pid === child.pid && Number.isInteger(metadata.port) && UUID.test(metadata.epoch), "physical_host_metadata_invalid");
  const controlDirectory = `/tmp/ia4tube-data-dir-pause-${child.pid}`;
  const directoryStat = await fsp.lstat(controlDirectory), socketStat = await fsp.lstat(controlDirectory + "/control.sock");
  need(directoryStat.isDirectory() && directoryStat.uid === 0 && (directoryStat.mode & 0o777) === 0o700 &&
    socketStat.isSocket() && socketStat.uid === 0 && (socketStat.mode & 0o777) === 0o600, "physical_control_identity_invalid");
  controlDirectories.set(controlDirectory, { directoryStat, socketStat });
  return { child, ...metadata, async ipc(commandName) {
    const id = ++counter;
    const response = new Promise(resolve => pending.set(id, resolve));
    child.send({ id, command: commandName });
    const value = await bounded(response, 10000, "physical_ipc_timeout");
    need(value.ok === true, "physical_ipc_refused"); return value;
  } };
}
async function closeHost(host) {
  if (!liveChildren.has(host.child)) return;
  await host.ipc("shutdown");
  const result = await host.child.closed;
  need(result.code === 0 && result.stderrBytes === 0, "physical_host_shutdown_failed");
}
async function post(host) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: host.port, method: "POST", path: "/synthetic-write", timeout: 5000 }, res => {
      const chunks = []; res.on("data", part => chunks.push(part));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", () => reject(new Error("physical_loopback_failed"))); req.on("timeout", () => req.destroy()); req.end();
  });
}
function drain(host, timeoutMs = 5000) {
  // A declaration about this closed synthetic namespace, never a live attestation.
  return request(host, { command: "drain", timeoutMs,
    attestation: { externalWritersAbsent: true, operatorConfirmed: true, limitationAcknowledged: true } });
}
async function frozen(host) { const result = await drain(host); need(result.ok && result.status.state === "frozen" && result.status.inFlight === 0, "physical_drain_failed"); return result; }
async function clearSyntheticSource() {
  need((await processes.assertNoCaptureProcesses(worker)).empty === true, "physical_untracked_capturer_present");
  const current = await fsp.lstat("/var/data");
  need(current.isDirectory() && current.dev === rootIdentity.dev && current.ino === rootIdentity.ino &&
    await fsp.realpath("/var/data") === "/var/data" && liveGroups.size === 0 && liveChildren.size === 0, "physical_cleanup_refused");
  const allowed = new Set(["pedidos", "planejamentos_mensais", "materiais_graficos", "carrosseis", "empty directory", "nested",
    "owned file.txt", "zero bytes.txt", "synthetic-ongoing.txt", ".ia4tube-pause.lock", ".ia4tube-recovery-c"]);
  for (const name of await fsp.readdir("/var/data")) {
    need(allowed.has(name), "physical_cleanup_unknown_entry");
    const target = path.join("/var/data", name);
    need(path.dirname(target) === "/var/data", "physical_cleanup_scope_refused");
    // Exact known synthetic children only; the mount/root itself is never removed.
    await fsp.rm(target, { recursive: true, force: false });
  }
  for (const [directory, witness] of controlDirectories) {
    const stat = await fsp.lstat(directory).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (stat) {
      need(stat.isDirectory() && !stat.isSymbolicLink() && stat.dev === witness.directoryStat.dev && stat.ino === witness.directoryStat.ino &&
        stat.uid === 0 && (stat.mode & 0o777) === 0o700 && await fsp.realpath(directory) === directory,
        "physical_crashed_control_cleanup_refused");
      const entries = await fsp.readdir(directory);
      need(entries.length <= 1 && entries.every(name => name === "control.sock"), "physical_crashed_control_cleanup_refused");
      if (entries.length) {
        const target = directory + "/control.sock", socket = await fsp.lstat(target);
        need(socket.isSocket() && socket.dev === witness.socketStat.dev && socket.ino === witness.socketStat.ino && socket.uid === 0,
          "physical_crashed_control_cleanup_refused");
        await fsp.unlink(target);
      }
      await fsp.rmdir(directory);
    }
    controlDirectories.delete(directory);
  }
}
async function capturePaused(host, ttlMs) {
  const captureId = crypto.randomUUID(), key = crypto.randomBytes(32);
  const observing = processes.waitForWorker(host.pid, worker, { timeoutMs: 10000, phase: "worker" });
  observing.catch(() => {});
  const client = startCli(host.pid, { command: "capture", captureId, epoch: host.epoch, ttlMs, bundleKeyBase64: key.toString("base64") });
  key.fill(0);
  const witness = (await observing).leader;
  liveGroups.add(witness);
  need((await processes.stopOwnedGroup(witness)).sent === true, "physical_group_stop_not_observed");
  await until(async () => (await processes.inspectProcess(witness.pid))?.state === "T");
  need((await status(host)).capture?.captureId === captureId, "physical_capture_not_active");
  return { captureId, client, witness };
}
async function continueAndClose(witness) {
  await processes.continueOwnedGroup(witness);
  need((await processes.waitGroupEmpty(witness, 15000)).empty === true, "physical_group_close_not_observed");
  liveGroups.delete(witness);
}
async function resume(host) { const value = await request(host, { command: "resume" }); need(value.ok && value.status.state === "normal", "physical_resume_failed"); }

test("existing pause control: physical Linux isolation, capture, abort and restart", { timeout: 180000 }, async t => {
  need(process.platform === "linux" && process.getuid() === 0 && process.env.IA4TUBE_LINUX_PHYSICAL === "1", "physical_linux_fixture_required");
  need(await fsp.realpath(overlay) === overlay && await fsp.realpath("/var/data") === "/var/data", "physical_paths_refused");
  report.filesystem = await posix.filesystemEvidence("/var/data");
  need(report.filesystem.mountPoint === "/var/data" && report.filesystem.filesystemType === "tmpfs" &&
    ["rw", "nosuid", "nodev", "noexec"].every(flag => report.filesystem.mountOptions.includes(flag)), "physical_mount_not_isolated");
  const interfaces = await fsp.readdir("/sys/class/net");
  need(interfaces.length === 1 && interfaces[0] === "lo", "physical_network_namespace_not_isolated");
  report.networkNamespaceIsolated = true;
  const rootMount = posix.parseMountInfo(await fsp.readFile("/proc/self/mountinfo", "utf8"), "/");
  const processStatus = await fsp.readFile("/proc/self/status", "utf8");
  const noNewPrivileges = /^NoNewPrivs:\s+1$/m.test(processStatus);
  const capabilities = /^CapEff:\s+([a-f0-9]+)$/m.exec(processStatus)?.[1];
  need(rootMount.mountOptions.includes("ro") && noNewPrivileges && capabilities && BigInt("0x" + capabilities) === 0xc9n,
    "physical_container_privileges_unexpected");
  report.isolation = { rootFilesystemReadOnly: true, noNewPrivileges, effectiveCapabilitiesHex: capabilities,
    capabilities: ["CHOWN", "FOWNER", "SETGID", "SETUID"], realServiceMounted: false };
  rootIdentity = await fsp.lstat("/var/data");
  need(rootIdentity.uid === 0 && (rootIdentity.mode & 0o777) === 0o700 && (await fsp.readdir("/var/data")).length === 0, "physical_source_not_empty_private");
  const tarStat = await fsp.lstat("/usr/bin/tar");
  need(tarStat.isFile() && !tarStat.isSymbolicLink() && tarStat.nlink === 1, "physical_tar_identity_refused");
  tarSha = hash(await fsp.readFile("/usr/bin/tar"));
  if (process.env.DATA_DIR_CAPTURE_TAR_SHA256) need(tarSha === process.env.DATA_DIR_CAPTURE_TAR_SHA256, "physical_tar_pin_mismatch");
  need(hash(await fsp.readFile(worker)) === WORKER_SHA256 && hash(await fsp.readFile(path.join(maintenance, "recovery/encrypted-backup-bundle.js"))) === ENVELOPE_SHA256, "physical_original_pins_mismatch");
  const tarVersion = (await command("/usr/bin/tar", ["--version"])).split("\n")[0];
  need(/^tar \(GNU tar\) [0-9.]+$/.test(tarVersion), "physical_gnu_tar_required");
  report.tools = { node: process.version, platform: process.platform, tarVersion, tarSha256: tarSha, workerSha256: WORKER_SHA256, envelopeSha256: ENVELOPE_SHA256 };
  tempRoot = await fsp.mkdtemp("/tmp/ia4tube-linux-proof-");
  // The evidence helper deliberately permits only an explicit UUID lab root.
  const approvedTempRoot = "/tmp/ia4tube-linux-proof-" + crypto.randomUUID();
  await fsp.rename(tempRoot, approvedTempRoot); tempRoot = approvedTempRoot; await fsp.chmod(tempRoot, 0o700);
  try {
    await t.test("real UDS isolation, in-flight/detached drain, encrypted capture and POSIX restore", async () => {
      await posix.seedData();
      const host = await startHost();
      const socketDir = `/tmp/ia4tube-data-dir-pause-${host.pid}`, socketPath = socketDir + "/control.sock";
      const dir = await fsp.lstat(socketDir), socket = await fsp.lstat(socketPath);
      assert.equal(dir.mode & 0o777, 0o700); assert.equal(socket.mode & 0o777, 0o600); assert.equal(socket.uid, 0);
      const denied = await command(process.execPath, ["-e", 'const n=require("node:net");const s=n.createConnection(process.argv[1]);s.on("connect",()=>process.exit(3));s.on("error",e=>process.exit(e.code==="EACCES"?0:4));', socketPath], { uid: 65534, gid: 65534 });
      assert.equal(denied, "");
      await host.ipc("start-writer");
      const detached = await host.ipc("start-detached"); assert.ok(detached.status.inFlight >= 2);
      const before = await fsp.readFile("/var/data/synthetic-ongoing.txt");
      const draining = drain(host, 10000);
      await until(async () => (await status(host)).state === "draining");
      assert.equal((await post(host)).status, 503);
      assert.deepEqual(await fsp.readFile("/var/data/synthetic-ongoing.txt"), before);
      await host.ipc("release-writer");
      assert.equal((await status(host)).state, "draining");
      await host.ipc("release-detached");
      const drained = await draining; assert.equal(drained.ok, true); assert.equal(drained.status.inFlight, 0);
      assert.equal(await fsp.readFile("/var/data/synthetic-ongoing.txt", "utf8"),
        before.toString("utf8") + "synthetic in-flight write\n" + "synthetic detached write\n");
      const marker = await fsp.lstat("/var/data/.ia4tube-pause.lock"); assert.equal(marker.mode & 0o777, 0o600);
      const captureId = crypto.randomUUID(), key = crypto.randomBytes(32);
      try {
        const captured = await request(host, { command: "capture", captureId, epoch: host.epoch, ttlMs: 30000, bundleKeyBase64: key.toString("base64") });
        need(captured.ok && captured.result?.verified === true && captured.status.state === "frozen", "physical_capture_failed");
        const bundlePath = `/var/data/.ia4tube-recovery-c/${captureId}/data-dir.bundle`;
        const beforeRestore = await posix.snapshotEvidence("/var/data", { ignore: [`.ia4tube-recovery-c/${captureId}`] });
        const restored = path.join(tempRoot, "restored"); await fsp.mkdir(restored, { mode: 0o700 });
        const comparison = await withExtractedEncryptedBundle({ containerPath: bundlePath,
          expectedNames: ["00-data-dir-manifest.json", "01-data-dir-posix.tar"], expectedLabel: `data-dir-c-${captureId}`,
          expectedSourceFingerprint: SOURCE_FINGERPRINT, workDirectory: tempRoot, bundleKey: key, workspacePurpose: "linux-physical-restore",
          operation: async extracted => {
            const manifest = JSON.parse(await fsp.readFile(path.join(extracted.directory, "00-data-dir-manifest.json"), "utf8"));
            need(manifest?.format === "ia4tube-data-dir-posix-capture-v1" && manifest.captureId === captureId &&
              manifest.epoch === host.epoch && manifest.sourceFingerprint === SOURCE_FINGERPRINT && manifest.posixRestoreVerified === false,
              "physical_manifest_invalid");
            need(hash(await fsp.readFile(path.join(extracted.directory, "00-data-dir-manifest.json"))) === captured.result.manifestSha256 &&
              hash(await fsp.readFile(path.join(extracted.directory, "01-data-dir-posix.tar"))) === manifest.archive.sha256,
              "physical_manifest_archive_digest_mismatch");
            await command("/usr/bin/tar", ["--extract", "--file", path.join(extracted.directory, "01-data-dir-posix.tar"),
              "--directory", restored, "--same-owner", "--same-permissions", "--numeric-owner", "--acls", "--xattrs", "--xattrs-include=*"]);
            return posix.compareEvidence(beforeRestore, await posix.snapshotEvidence(restored));
          } });
        need(comparison.passed, "physical_posix_restore_mismatch");
        const sourceAfter = await posix.snapshotEvidence("/var/data", { ignore: [`.ia4tube-recovery-c/${captureId}`] });
        need(posix.compareEvidence(beforeRestore, sourceAfter).passed, "physical_source_changed_during_restore");
        report.restore = comparison;
        report.bundle = { bytes: (await fsp.stat(bundlePath)).size, sha256: hash(await fsp.readFile(bundlePath)), authenticated: true,
          sourceStable: true, realCapturerClosed: true, originalWorkerPosixRestoreVerified: captured.result.posixRestoreVerified === true,
          independentLabPosixRestoreVerified: true, restoredMarkerPreserved: (await fsp.lstat(path.join(restored, ".ia4tube-pause.lock"))).isFile() };
        need(report.bundle.sha256 === captured.result.bundleSha256 && report.bundle.bytes === captured.result.bundleBytes,
          "physical_bundle_result_digest_mismatch");
      } finally { key.fill(0); }
      const beforeResume = await fsp.readFile("/var/data/synthetic-ongoing.txt", "utf8");
      await resume(host);
      assert.equal(await fsp.stat("/var/data/.ia4tube-pause.lock").then(() => true, e => e.code === "ENOENT" ? false : Promise.reject(e)), false);
      assert.equal((await post(host)).status, 200);
      assert.equal(await fsp.readFile("/var/data/synthetic-ongoing.txt", "utf8"), beforeResume + "synthetic admitted HTTP write\n");
      await closeHost(host); await clearSyntheticSource();
      report.cases.push({ name: "capture_restore_and_drain", passed: true, permissionDeniedOtherUid: true,
        pendingWritesCompletedBeforeFreeze: true, detachedAdmittedBeforeSchedule: true, newWriteRefusedWhilePaused: true, resumeOneWrite: true });
    });
    need(report.cases.length === 1, "physical_previous_case_failed");
    await t.test("real TTL invalidation cannot resume a stopped but live process group", async () => {
      await posix.seedData(); const host = await startHost(); await frozen(host);
      const active = await capturePaused(host, 1500);
      await until(async () => (await status(host)).state === "aborting", 10000);
      assert.equal((await request(host, { command: "resume" })).ok, false);
      assert.equal((await status(host)).capture.valid, false);
      assert.equal((await fsp.lstat("/var/data/.ia4tube-pause.lock")).isFile(), true);
      await continueAndClose(active.witness);
      const result = await active.client.response; assert.equal(result.ok, false); assert.equal(result.status.state, "frozen");
      assert.equal(result.result, null); await resume(host); await closeHost(host); await clearSyntheticSource();
      report.cases.push({ name: "ttl_waits_for_real_close", passed: true, stoppedGroupDidNotCountAsClosed: true, invalidBeforeTermination: true });
    });
    need(report.cases.length === 2, "physical_previous_case_failed");
    await t.test("actual client abandonment invalidates and waits for child close", async () => {
      await posix.seedData(); const host = await startHost(); await frozen(host);
      const active = await capturePaused(host, 30000);
      active.client.kill("SIGTERM"); await active.client.closed;
      await until(async () => (await status(host)).state === "aborting");
      assert.equal((await request(host, { command: "resume" })).ok, false);
      await continueAndClose(active.witness);
      await until(async () => (await status(host)).state === "frozen");
      assert.equal((await status(host)).lastCapture.verified, false);
      await resume(host); await closeHost(host); await clearSyntheticSource();
      report.cases.push({ name: "abandoned_socket_waits_for_real_close", passed: true });
    });
    need(report.cases.length === 3, "physical_previous_case_failed");
    await t.test("parent crash retains marker and blocks real server even with feature disabled", async () => {
      await posix.seedData(); const host = await startHost(); await frozen(host);
      const active = await capturePaused(host, 30000);
      // Fault injection into THIS synthetic child only, never a live shutdown policy.
      host.child.kill("SIGKILL"); await host.child.closed; await active.client.closed;
      const originalMarker = await fsp.readFile("/var/data/.ia4tube-pause.lock");
      const before = await posix.snapshotEvidence("/var/data", { ignore: [`.ia4tube-recovery-c/${active.captureId}`] });
      for (const enabled of ["false", "true"]) {
        const restart = childProcess(process.execPath, [path.join(overlay, "server.js")], { env: env({ DATA_DIR_PAUSE_ENABLED: enabled }) });
        restart.stdin.end(); const result = await bounded(restart.closed, 10000, "physical_restart_did_not_refuse");
        need(result.code !== 0 && result.markerRefusal && result.outputWithinLimit, "physical_restart_guard_not_proven");
        need(posix.compareEvidence(before, await posix.snapshotEvidence("/var/data", { ignore: [`.ia4tube-recovery-c/${active.captureId}`] })).passed,
          "physical_restart_wrote_source");
        assert.deepEqual(await fsp.readFile("/var/data/.ia4tube-pause.lock"), originalMarker);
      }
      await processes.terminateOwnedGroup(active.witness);
      need((await processes.waitGroupEmpty(active.witness, 15000)).empty === true, "physical_orphan_close_not_observed");
      liveGroups.delete(active.witness);
      assert.deepEqual(await fsp.readFile("/var/data/.ia4tube-pause.lock"), originalMarker);
      // A test-only teardown, not automatic adoption/recovery of a real stale lock.
      await clearSyntheticSource();
      report.cases.push({ name: "parent_crash_blocks_restart", passed: true, realBusinessServerGuardRanBeforeImports: true,
        featureDisabledStillBlocked: true, staleMarkerNeverAutomaticallyRemoved: true, orphanReapedAfterExplicitLabTermination: true });
    });
    need(report.cases.length === 4, "physical_case_missing");
  } finally {
    // Never delete source while any captured process might still access it.
    for (const witness of [...liveGroups]) {
      try { await processes.terminateOwnedGroup(witness); if ((await processes.waitGroupEmpty(witness, 15000)).empty === true) liveGroups.delete(witness); } catch (_) { /* Container teardown remains required; fail below. */ }
    }
    for (const child of [...liveChildren]) { child.kill("SIGTERM"); }
    try { await bounded(Promise.all([...liveChildren].map(child => child.closed)), 5000, "physical_child_cleanup_timeout"); } catch (_) { /* Fail closed below. */ }
    let noUntrackedCapture = false;
    try { noUntrackedCapture = (await processes.assertNoCaptureProcesses(worker)).empty === true; } catch (_) { /* No cleanup on an unaccounted worker. */ }
    report.allOwnedProcessesClosed = liveChildren.size === 0 && liveGroups.size === 0 && noUntrackedCapture;
    if (report.allOwnedProcessesClosed) {
      await clearSyntheticSource();
      need(/^\/tmp\/ia4tube-linux-proof-[a-f0-9-]{36}$/.test(tempRoot) && await fsp.realpath(tempRoot) === tempRoot, "physical_temp_cleanup_refused");
      await fsp.rm(tempRoot, { recursive: true, force: false });
      report.syntheticFilesRemoved = (await fsp.readdir("/var/data")).length === 0 && controlDirectories.size === 0;
    }
    report.passed = report.cases.length === 4 && report.allOwnedProcessesClosed && report.syntheticFilesRemoved;
    console.log("IA4TUBE_LINUX_PHYSICAL_REPORT " + JSON.stringify(report));
    need(report.allOwnedProcessesClosed, "physical_owned_process_cleanup_unconfirmed");
  }
});
