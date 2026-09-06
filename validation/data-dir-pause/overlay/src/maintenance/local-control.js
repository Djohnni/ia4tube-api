"use strict";

const fs = require("node:fs/promises");
const net = require("node:net");
const path = require("node:path");
const crypto = require("node:crypto");
const { inspectRemoteWorkFence } = require("./remote-work-fence");
const { createCaptureSupervisor } = require("./capture-supervisor");
const { createPauseMarker } = require("./pause-marker");

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
const MAX_PACKET_BYTES = 4096;
const WORKER_SHA256 = "5da2ebb3f546863804de0ce78a40db8dd3b76e969628cd55a56b703312dc8a52";
const ENVELOPE_SHA256 = "3f6828d2aa08ba65f1dd526396af4564d78f6152628d719130d5a7e9f1f353d7";
// Metadata binding only: this digest does not attest the deployed source/disk.
const SOURCE_FINGERPRINT = crypto.createHash("sha256").update(
  "ia4tube-data-dir-source-v1\nsrv-d8708kd7vvec73ap1p6g\n1bd987f1ecbbd3a64f2ad0e905d30649704f4b3c\n/var/data\n"
).digest("hex");

function refusal(code = "local_control_refused") { const error = new Error(code); error.code = code; return error; }
function need(value, code) { if (!value) throw refusal(code); }
function exact(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}
function validId(value) { return typeof value === "string" && UUID.test(value); }
function validDuration(value, maximum) { return Number.isSafeInteger(value) && value > 0 && value <= maximum; }
function validatePacket(packet) {
  need(packet && typeof packet.command === "string", "local_command_invalid");
  const keys = {
    status: ["command"], drain: ["command", "timeoutMs", "attestation"],
    capture: ["command", "captureId", "epoch", "ttlMs", "bundleKeyBase64"],
    abort: ["command", "captureId", "epoch"], resume: ["command"]
  }[packet.command];
  need(keys && exact(packet, keys), "local_command_invalid");
  if (packet.command === "drain") {
    need(validDuration(packet.timeoutMs, 300000), "local_deadline_invalid");
    need(exact(packet.attestation, ["externalWritersAbsent", "operatorConfirmed", "limitationAcknowledged"]) &&
      Object.values(packet.attestation).every(value => value === true), "local_attestation_required");
  }
  if (packet.command === "capture" || packet.command === "abort") {
    need(validId(packet.captureId) && validId(packet.epoch), "local_capture_identity_invalid");
  }
  if (packet.command === "capture") {
    need(validDuration(packet.ttlMs, 900000), "local_deadline_invalid");
    need(typeof packet.bundleKeyBase64 === "string" && /^[A-Za-z0-9+/]{43}=$/.test(packet.bundleKeyBase64), "local_key_invalid");
    const bytes = Buffer.from(packet.bundleKeyBase64, "base64");
    try { need(bytes.length === 32 && bytes.toString("base64") === packet.bundleKeyBase64, "local_key_invalid"); }
    finally { bytes.fill(0); }
  }
  return packet;
}
function decodePacket(bytes) {
  need(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= MAX_PACKET_BYTES, "local_packet_invalid");
  const text = bytes.toString("utf8");
  need(Buffer.from(text).equals(bytes), "local_packet_invalid");
  try { return validatePacket(JSON.parse(text)); }
  catch (error) { if (error.code?.startsWith("local_")) throw error; throw refusal("local_packet_invalid"); }
}
function publicStatus(runtime) {
  const value = runtime.controller.status();
  const state = ["normal", "draining", "frozen", "capturing", "aborting"].includes(value.state) ? value.state : "unknown";
  need(validId(value.epoch) && Number.isSafeInteger(value.inFlight) && value.inFlight >= 0, "local_runtime_invalid");
  const faults = runtime.faults();
  need(Number.isSafeInteger(faults) && faults >= 0, "local_runtime_invalid");
  return { state, epoch: value.epoch, inFlight: value.inFlight, faults,
    capture: value.capture ? { captureId: value.capture.captureId, valid: value.capture.valid === true,
      abortRequested: value.capture.abortRequested === true } : null,
    lastCapture: value.lastCapture ? { captureId: value.lastCapture.captureId,
      outcome: value.lastCapture.outcome === "completed" ? "completed" : "invalid", verified: value.lastCapture.verified === true } : null };
}

// Dependency injection is for local tests. No injection fields exist on the wire.
function createControlActions({ runtime, dataDir, supervisor, inspectFence = inspectRemoteWorkFence, marker = createPauseMarker({ dataDir }) } = {}) {
  need(runtime?.enabled === true && runtime.controller && typeof runtime.faults === "function" &&
    supervisor && typeof supervisor.start === "function" && typeof inspectFence === "function" &&
    marker && ["acquire", "release", "held"].every(name => typeof marker[name] === "function"), "local_runtime_invalid");
  let busy = false;
  let attestedEpoch = null;
  let activeCapture = null;
  function status() { return publicStatus(runtime); }
  function checkedFence() {
    need(runtime.faults() === 0, "local_accounting_fault");
    const fence = inspectFence({ dataDir });
    need(fence?.ok === true && fence.noActiveRecordedWork === true && fence.remoteWorkersStopped === false &&
      fence.counts?.active === 0 && fence.counts?.unknown === 0, "local_remote_work_refused");
    return { code: "remote_work_no_active_records", counts: { ...fence.counts }, remoteWorkersStopped: false };
  }
  function abandonActive() { if (activeCapture) activeCapture.abandon(); }
  async function execute(packet, { signal } = {}) {
    validatePacket(packet);
    need(!signal?.aborted, "local_request_abandoned");
    if (packet.command === "status") return { ok: true, code: "local_status", status: status() };
    if (packet.command === "abort") {
      const current = status();
      need(activeCapture && current.epoch === packet.epoch && activeCapture.captureId === packet.captureId,
        "local_capture_identity_invalid");
      // The supervisor invalidates the controller BEFORE requesting termination.
      activeCapture.abandon();
      return { ok: true, code: "local_capture_abort_requested", status: status() };
    }
    need(!busy, "local_control_busy");
    busy = true;
    try {
      if (packet.command === "drain") {
        need(status().state === "normal", "local_state_conflict");
        attestedEpoch = null;
        checkedFence();
        // Human declaration is mandatory but is not independently established.
        attestedEpoch = status().epoch;
        try {
          // Close admission synchronously before filesystem I/O; attach a catch
          // immediately in case the drain deadline expires during marker fsync.
          const draining = runtime.controller.beginDrain({ timeoutMs: packet.timeoutMs });
          draining.catch(() => {});
          await marker.acquire(attestedEpoch);
          await draining;
          need(!signal?.aborted, "local_request_abandoned");
          const fence = checkedFence();
          need(status().state === "frozen" && status().inFlight === 0, "local_not_frozen");
          return { ok: true, code: "local_drain_frozen", status: status(), fence,
            externalWriterAttestation: "operator-declared-not-independently-verified" };
        } catch (error) { attestedEpoch = null; throw error; }
      }
      if (packet.command === "resume") {
        need(runtime.faults() === 0 && !activeCapture, "local_resume_refused");
        const current = status();
        // Cancel only a pre-capture drain. Existing business work remains in the
        // ledger and continues normally; cancellation does not mean completion.
        // The controller independently refuses cancelDrain after any capture.
        need(current.state === "draining" || (current.state === "frozen" && current.inFlight === 0), "local_resume_refused");
        // Removal AND directory fsync precede reopening admission. Failure leaves
        // the same controller closed and requires explicit operator recovery.
        await marker.release(current.epoch);
        if (current.state === "draining") runtime.controller.cancelDrain();
        else {
          need(current.inFlight === 0 && current.state === "frozen", "local_resume_refused");
          runtime.controller.resume();
        }
        attestedEpoch = null;
        return { ok: true, code: "local_resumed", status: status() };
      }
      const before = status();
      need(before.state === "frozen" && before.inFlight === 0 && before.epoch === packet.epoch &&
        attestedEpoch === packet.epoch && marker.held() && !activeCapture, "local_not_frozen");
      checkedFence();
      need(!signal?.aborted, "local_request_abandoned");
      const key = Buffer.from(packet.bundleKeyBase64, "base64");
      packet.bundleKeyBase64 = undefined;
      let capture;
      const onAbandoned = () => { if (capture) capture.abandon(); };
      signal?.addEventListener("abort", onAbandoned, { once: true });
      try {
        capture = supervisor.start({ captureId: packet.captureId, epoch: packet.epoch,
          ttlMs: packet.ttlMs, bundleKey: key, sourceFingerprint: SOURCE_FINGERPRINT });
        activeCapture = capture;
        if (signal?.aborted) capture.abandon();
      } catch (error) {
        signal?.removeEventListener("abort", onAbandoned);
        throw error;
      } finally { key.fill(0); }
      try {
        const completion = await capture.completion;
        need(completion.childClosed === true && completion.processGroupEmpty === true, "local_capture_closure_unconfirmed");
        return { ok: completion.passed === true, code: completion.passed ? "local_capture_verified" : "local_capture_invalidated",
          status: status(), result: completion.passed ? completion.result : null,
          externalWriterAttestation: "operator-declared-not-independently-verified" };
      } finally {
        signal?.removeEventListener("abort", onAbandoned);
        // A rejecting/invalid supervisor must not unlock a possibly-live child.
        if (status().state === "frozen" && !status().capture) activeCapture = null;
      }
    } finally { busy = false; }
  }
  async function shutdown() {
    if (activeCapture) { abandonActive(); await activeCapture.completion; }
  }
  return Object.freeze({ execute, status, shutdown });
}

function publicFailure() { return { ok: false, code: "local_control_refused" }; }
function attachConnection(socket, actions) {
  let pieces = [], total = 0, dispatched = false;
  const abort = new AbortController();
  const discard = () => { for (const piece of pieces) piece.fill(0); pieces = []; };
  socket.on("error", () => abort.abort());
  socket.once("close", () => { abort.abort(); discard(); });
  socket.on("data", chunk => {
    if (dispatched) { abort.abort(); socket.destroy(); return; }
    total += chunk.length;
    if (total > MAX_PACKET_BYTES) { dispatched = true; discard(); socket.end(JSON.stringify(publicFailure()) + "\n"); return; }
    pieces.push(Buffer.from(chunk));
    const buffer = Buffer.concat(pieces);
    const newline = buffer.indexOf(10);
    if (newline === -1) { buffer.fill(0); return; }
    dispatched = true;
    let packet;
    try {
      need(newline === buffer.length - 1, "local_packet_invalid");
      packet = decodePacket(buffer.subarray(0, newline));
    } catch (_) { discard(); buffer.fill(0); socket.end(JSON.stringify(publicFailure()) + "\n"); return; }
    discard(); buffer.fill(0);
    Promise.resolve(actions.execute(packet, { signal: abort.signal })).then(
      result => { if (!socket.destroyed) socket.end(JSON.stringify(result) + "\n"); },
      () => { if (!socket.destroyed) socket.end(JSON.stringify(publicFailure()) + "\n"); }
    ).finally(() => { packet.bundleKeyBase64 = undefined; });
  });
}

async function checkPrivate(target, uid, kind, mode, inode) {
  const stat = await fs.lstat(target);
  need(!stat.isSymbolicLink() && stat.uid === uid && (stat.mode & 0o777) === mode &&
    (kind === "directory" ? stat.isDirectory() : stat.isSocket()) &&
    (inode === undefined || stat.ino === inode), "local_socket_permissions_refused");
  if (kind === "directory") need(await fs.realpath(target) === target, "local_socket_path_refused");
  return stat;
}
async function startLocalControl({ runtime, dataDir } = {}) {
  need(process.platform === "linux" && typeof process.getuid === "function", "local_linux_required");
  need(runtime?.enabled === true && dataDir === "/var/data" && process.env.DATA_DIR_PAUSE_ENABLED === "true", "local_configuration_refused");
  const tarSha256 = process.env.DATA_DIR_CAPTURE_TAR_SHA256;
  need(typeof tarSha256 === "string" && SHA.test(tarSha256), "local_tar_pin_required");
  const uid = process.getuid();
  const directory = `/tmp/ia4tube-data-dir-pause-${process.pid}`;
  const socketPath = path.join(directory, "control.sock");
  const tmp = await fs.lstat("/tmp");
  need(await fs.realpath("/tmp") === "/tmp" && tmp.isDirectory() && !tmp.isSymbolicLink() && tmp.uid === 0 &&
    ((tmp.mode & 0o022) === 0 || (tmp.mode & 0o1000) !== 0), "local_tmp_refused");
  // mkdir without recursive/existence recovery: any collision is a refusal.
  await fs.mkdir(directory, { mode: 0o700 });
  const directoryStat = await checkPrivate(directory, uid, "directory", 0o700);
  const supervisor = createCaptureSupervisor({ controller: runtime.controller, sourceRoot: "/var/data",
    workerSha256: WORKER_SHA256, envelopeSha256: ENVELOPE_SHA256, tarSha256 });
  const actions = createControlActions({ runtime, dataDir, supervisor });
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.once("close", () => sockets.delete(socket)); attachConnection(socket, actions);
  });
  let listening = false;
  await new Promise((resolve, reject) => {
    server.on("error", () => {
      if (!listening) reject(refusal("local_bind_refused"));
      else {
        for (const socket of sockets) socket.destroy();
        void actions.shutdown().catch(() => {}); // Fail closed; never log raw errors.
        server.close(() => {});
      }
    });
    server.listen(socketPath, () => { listening = true; resolve(); });
  });
  await fs.chmod(socketPath, 0o600);
  const socketStat = await checkPrivate(socketPath, uid, "socket", 0o600);
  await checkPrivate(directory, uid, "directory", 0o700, directoryStat.ino);
  return Object.freeze({ socketPath, actions, async close() {
    await actions.shutdown();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    // Node may already unlink its socket. Never remove a replacement or recurse.
    try { await checkPrivate(socketPath, uid, "socket", 0o600, socketStat.ino); await fs.unlink(socketPath); }
    catch (error) { if (error.code !== "ENOENT") throw refusal("local_cleanup_refused"); }
    await checkPrivate(directory, uid, "directory", 0o700, directoryStat.ino);
    await fs.rmdir(directory);
  } });
}

module.exports = { createControlActions, startLocalControl, validatePacket, decodePacket, attachConnection,
  MAX_PACKET_BYTES, SOURCE_FINGERPRINT, WORKER_SHA256, ENVELOPE_SHA256 };
